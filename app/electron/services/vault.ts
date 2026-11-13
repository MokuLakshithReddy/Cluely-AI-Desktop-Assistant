import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Returns whether Electron selected a genuinely OS-backed credential provider. */
export function isSecureStorageBackendAvailable(
  platform: string,
  encryptionAvailable: boolean,
  selectedBackend?: string | null
): boolean {
  if (!encryptionAvailable) return false;
  if (platform === 'linux') {
    const supportedBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
    return Boolean(selectedBackend && supportedBackends.has(selectedBackend));
  }
  return platform === 'win32' || platform === 'darwin';
}

export interface AsyncSafeStorageLike {
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (plainText: string) => Promise<Buffer>;
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ shouldReEncrypt: boolean; result: string }>;
  getSelectedStorageBackend?: () => string;
}

function assertAsyncStorageShape(storage: AsyncSafeStorageLike): void {
  if (
    typeof storage.isAsyncEncryptionAvailable !== 'function' ||
    typeof storage.encryptStringAsync !== 'function' ||
    typeof storage.decryptStringAsync !== 'function'
  ) {
    throw new Error('[CredentialVault] This Electron runtime does not expose the asynchronous safeStorage API.');
  }
}

async function assertSecureAsyncStorage(storage: AsyncSafeStorageLike, platform: string): Promise<void> {
  assertAsyncStorageShape(storage);
  let available = false;
  let backend: string | undefined;
  try {
    available = await storage.isAsyncEncryptionAvailable!();
    if (platform === 'linux' && typeof storage.getSelectedStorageBackend === 'function') {
      backend = storage.getSelectedStorageBackend();
    }
  } catch {
    available = false;
  }

  if (!isSecureStorageBackendAvailable(platform, available, backend)) {
    throw new Error(
      '[CredentialVault] Secure asynchronous OS-backed credential storage is unavailable. ' +
      'On Linux, configure Secret Service/libsecret or KWallet. The basic_text backend is rejected.'
    );
  }
}

/** Encrypts using only the non-blocking Electron safeStorage API. */
export async function encryptWithAsyncSafeStorage(
  storage: AsyncSafeStorageLike,
  platform: string,
  plainText: string
): Promise<Buffer> {
  await assertSecureAsyncStorage(storage, platform);
  return storage.encryptStringAsync!(plainText);
}

/**
 * Decrypts a safeStorage blob. Older blobs produced by the synchronous Electron
 * APIs are supported by Electron's asynchronous decryptor. If Electron reports
 * key rotation, re-encrypt the returned plaintext and return the replacement
 * ciphertext so the vault can persist it.
 */
export async function decryptWithAsyncSafeStorage(
  storage: AsyncSafeStorageLike,
  platform: string,
  encrypted: Buffer
): Promise<{ result: string; reEncrypted?: Buffer }> {
  await assertSecureAsyncStorage(storage, platform);
  const decrypted = await storage.decryptStringAsync!(encrypted);
  if (!decrypted || typeof decrypted.result !== 'string') {
    throw new Error('[CredentialVault] Electron returned an invalid async decryption result.');
  }

  if (!decrypted.shouldReEncrypt) return { result: decrypted.result };

  const reEncrypted = await storage.encryptStringAsync!(decrypted.result);
  return { result: decrypted.result, reEncrypted };
}

export class CredentialVault {
  private vaultPath: string;
  private testKey?: Buffer;
  private operationQueue: Promise<void> = Promise.resolve();

  /**
   * @param customVaultPath Optional path to vault file (used in tests)
   * @param testKey Optional 32-byte key used exclusively in headless unit tests
   */
  constructor(customVaultPath?: string, testKey?: Buffer) {
    this.vaultPath = customVaultPath ? path.normalize(customVaultPath) : this.resolveVaultPath();
    this.testKey = testKey;
  }

  private resolveVaultPath(): string {
    try {
      if (app && typeof app.getPath === 'function') {
        return path.join(app.getPath('userData'), 'credentials.vault');
      }
    } catch {
      // Electron app paths are unavailable before app initialization.
    }
    return path.join(process.cwd(), 'credentials.vault');
  }

  /** Serialize vault operations so concurrent read/modify/write calls cannot lose credentials. */
  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async encrypt(plainText: string): Promise<string> {
    const storage = (safeStorage ?? {}) as unknown as AsyncSafeStorageLike;
    try {
      const encrypted = await encryptWithAsyncSafeStorage(storage, process.platform, plainText);
      return `safe:${encrypted.toString('base64')}`;
    } catch (error) {
      // A test key is an explicit opt-in for headless unit tests only. Production
      // vault instances never fall back to application-managed encryption keys.
      if (!this.testKey || !Buffer.isBuffer(this.testKey) || this.testKey.length !== 32) {
        throw error;
      }

      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.testKey, iv);
      let ciphertext = cipher.update(plainText, 'utf8', 'hex');
      ciphertext += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      return `aes:${iv.toString('hex')}:${authTag}:${ciphertext}`;
    }
  }

  private async decrypt(
    encoded: string,
    vault: Record<string, string>,
    providerKey: string
  ): Promise<string | null> {
    if (encoded.startsWith('safe:')) {
      const encrypted = Buffer.from(encoded.slice(5), 'base64');
      const storage = safeStorage as unknown as AsyncSafeStorageLike;
      const decrypted = await decryptWithAsyncSafeStorage(storage, process.platform, encrypted);
      if (decrypted.reEncrypted) {
        vault[providerKey] = `safe:${decrypted.reEncrypted.toString('base64')}`;
        this.writeVault(vault);
      }
      return decrypted.result;
    }

    if (encoded.startsWith('aes:')) {
      if (!this.testKey || !Buffer.isBuffer(this.testKey) || this.testKey.length !== 32) {
        throw new Error('[CredentialVault] AES test ciphertext cannot be opened without its explicit test key.');
      }
      const parts = encoded.split(':');
      if (parts.length !== 4) throw new Error('[CredentialVault] Malformed AES test ciphertext.');
      const [, ivHex, tagHex, cipherHex] = parts;
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.testKey,
        Buffer.from(ivHex, 'hex')
      );
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    }

    return null;
  }

  private readVault(): Record<string, string> {
    if (!fs.existsSync(this.vaultPath)) return {};
    const raw = fs.readFileSync(this.vaultPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('[CredentialVault] Vault file must contain an object of encrypted credentials.');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || typeof value !== 'string') {
        throw new Error('[CredentialVault] Vault file contains an invalid credential entry.');
      }
    }
    return parsed as Record<string, string>;
  }

  /** Atomically replaces the encrypted vault file; never writes plaintext credentials. */
  private writeVault(data: Record<string, string>): void {
    const dir = path.dirname(this.vaultPath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${this.vaultPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      let renamed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tempPath, this.vaultPath);
          renamed = true;
          break;
        } catch (renameErr: any) {
          if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') && attempt < 4) {
            const start = Date.now();
            while (Date.now() - start < 15) {}
            continue;
          }
          throw renameErr;
        }
      }
      if (!renamed) {
        fs.renameSync(tempPath, this.vaultPath);
      }
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }

  public setKey(provider: string, apiKey: string): Promise<void> {
    return this.withLock(async () => {
      if (!provider || typeof provider !== 'string') {
        throw new Error('[CredentialVault] Invalid provider: Must be a non-empty string');
      }
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
        throw new Error('[CredentialVault] Invalid API key: Key cannot be empty');
      }

      const vault = this.readVault();
      const providerKey = provider.toLowerCase().trim();
      vault[providerKey] = await this.encrypt(apiKey.trim());
      this.writeVault(vault);
    });
  }

  public getKey(provider: string): Promise<string | null> {
    return this.withLock(async () => {
      if (!provider || typeof provider !== 'string') return null;
      const vault = this.readVault();
      const providerKey = provider.toLowerCase().trim();
      const encrypted = vault[providerKey];
      if (!encrypted) return null;
      return this.decrypt(encrypted, vault, providerKey);
    });
  }

  public deleteKey(provider: string): Promise<void> {
    return this.withLock(async () => {
      if (!provider || typeof provider !== 'string') return;
      const vault = this.readVault();
      delete vault[provider.toLowerCase().trim()];
      this.writeVault(vault);
    });
  }

  /** Logical application-level deletion; it is not forensic or physical erasure. */
  public deleteAllKeys(): Promise<void> {
    return this.withLock(async () => {
      try {
        fs.unlinkSync(this.vaultPath);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    });
  }

  public hasKeys(): Promise<Record<string, boolean>> {
    return this.withLock(async () => {
      const vault = this.readVault();
      const providers = ['gemini', 'openai', 'anthropic', 'groq', 'ollama'];
      const result: Record<string, boolean> = {};
      for (const provider of providers) result[provider] = Boolean(vault[provider]);
      return result;
    });
  }
}
export const credentialVault = new CredentialVault();
