import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Returns whether Electron has selected a genuinely OS-backed credential store. */
export function isSecureStorageBackendAvailable(
  platform: string,
  encryptionAvailable: boolean,
  selectedBackend?: string | null
): boolean {
  if (!encryptionAvailable) return false;
  // Electron's Linux basic_text backend uses a hard-coded password and is not a
  // secure secret store. Unknown Linux backends fail closed as well.
  if (platform === 'linux') {
    const supportedBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
    return Boolean(selectedBackend && supportedBackends.has(selectedBackend));
  }
  return true;
}

export interface AsyncSafeStorageLike {
  isAsyncEncryptionAvailable?: () => Promise<boolean>;
  encryptStringAsync?: (plainText: string) => Promise<Buffer>;
  decryptStringAsync?: (encrypted: Buffer) => Promise<{ shouldReEncrypt: boolean; result: string }>;
  getSelectedStorageBackend?: () => string;
}

/**
 * Encrypts with Electron's non-blocking safeStorage API when available.
 * The Linux backend check deliberately reuses the fail-closed backend policy.
 */
export async function encryptWithAsyncSafeStorage(
  storage: AsyncSafeStorageLike,
  platform: string,
  plainText: string
): Promise<Buffer> {
  if (
    typeof storage.isAsyncEncryptionAvailable !== 'function' ||
    typeof storage.encryptStringAsync !== 'function'
  ) {
    throw new Error('[CredentialVault] Async safeStorage is not available in this Electron runtime.');
  }

  const available = await storage.isAsyncEncryptionAvailable();
  const backend = platform === 'linux' && typeof storage.getSelectedStorageBackend === 'function'
    ? storage.getSelectedStorageBackend()
    : undefined;
  if (!isSecureStorageBackendAvailable(platform, available, backend)) {
    throw new Error('[CredentialVault] Secure asynchronous OS-backed credential storage is unavailable.');
  }

  return storage.encryptStringAsync(plainText);
}

/**
 * Electron's async decryptor can open existing synchronous safeStorage blobs.
 * When it reports a key rotation, a second call returns the refreshed result.
 */
export async function decryptWithAsyncSafeStorage(
  storage: AsyncSafeStorageLike,
  platform: string,
  encrypted: Buffer
): Promise<string> {
  if (
    typeof storage.isAsyncEncryptionAvailable !== 'function' ||
    typeof storage.decryptStringAsync !== 'function'
  ) {
    throw new Error('[CredentialVault] Async safeStorage is not available in this Electron runtime.');
  }

  const available = await storage.isAsyncEncryptionAvailable();
  const backend = platform === 'linux' && typeof storage.getSelectedStorageBackend === 'function'
    ? storage.getSelectedStorageBackend()
    : undefined;
  if (!isSecureStorageBackendAvailable(platform, available, backend)) {
    throw new Error('[CredentialVault] Secure asynchronous OS-backed credential storage is unavailable.');
  }

  const first = await storage.decryptStringAsync(encrypted);
  if (!first.shouldReEncrypt) return first.result;

  const refreshed = await storage.decryptStringAsync(encrypted);
  if (refreshed.shouldReEncrypt) {
    throw new Error('[CredentialVault] Credential key rotation did not settle after retry.');
  }
  return refreshed.result;
}

export class CredentialVault {
  private vaultPath: string;
  private testKey?: Buffer;

  /**
   * @param customVaultPath Optional path to vault file (used in tests)
   * @param testKey Optional cryptographically secure test key (used exclusively in headless unit tests where OS keyring is unavailable)
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
      // fallback
    }
    return path.join(process.cwd(), 'credentials.vault');
  }

  private hasSecureOsStorage(): boolean {
    try {
      if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false;
      const available = safeStorage.isEncryptionAvailable();
      const backend =
        process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
          ? safeStorage.getSelectedStorageBackend()
          : undefined;
      return isSecureStorageBackendAvailable(process.platform, available, backend);
    } catch {
      return false;
    }
  }

  /**
   * Encrypts plaintext using OS-backed safeStorage.
   * Fails safely without insecure fallbacks if OS keyring is unavailable and no explicit test key was provided.
   */
  private async encrypt(plainText: string): Promise<string> {
    const asyncStorage = safeStorage as unknown as AsyncSafeStorageLike;
    if (typeof asyncStorage.isAsyncEncryptionAvailable === 'function' && typeof asyncStorage.encryptStringAsync === 'function') {
      const encrypted = await encryptWithAsyncSafeStorage(asyncStorage, process.platform, plainText);
      return `safe:${encrypted.toString('base64')}`;
    }

    // Electron 34 does not expose the async safeStorage methods. Keep this
    // guarded legacy path until the minimum Electron runtime is upgraded to 42+.
    // Newer runtimes always take the asynchronous branch above.
    if (this.hasSecureOsStorage()) {
      const encrypted = safeStorage.encryptString(plainText);
      return `safe:${encrypted.toString('base64')}`;
    }

    // 2. In headless test environments, only allow explicit cryptographically secure test key
    if (this.testKey && Buffer.isBuffer(this.testKey) && this.testKey.length === 32) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.testKey, iv);
      let ciphertext = cipher.update(plainText, 'utf8', 'hex');
      ciphertext += cipher.final('hex');
      const authTag = cipher.getAuthTag().toString('hex');
      return `aes:${iv.toString('hex')}:${authTag}:${ciphertext}`;
    }

    // 3. Fail safely: Never silently fall back to predictable keys
    throw new Error(
      '[CredentialVault] Secure OS-backed credential storage is unavailable. On Linux, configure Secret Service/libsecret or KWallet; the basic_text backend is intentionally rejected. Refusing to persist credentials with an insecure fallback.'
    );
  }

  private async decrypt(encoded: string): Promise<string | null> {
    try {
      if (encoded.startsWith('safe:')) {
        const asyncStorage = safeStorage as unknown as AsyncSafeStorageLike;
        if (typeof asyncStorage.isAsyncEncryptionAvailable === 'function' && typeof asyncStorage.decryptStringAsync === 'function') {
          const b64 = encoded.slice(5);
          const buf = Buffer.from(b64, 'base64');
          return await decryptWithAsyncSafeStorage(asyncStorage, process.platform, buf);
        }
        if (!this.hasSecureOsStorage() || typeof safeStorage.decryptString !== 'function') {
          console.warn('[CredentialVault] safeStorage unavailable to decrypt string');
          return null;
        }
        const b64 = encoded.slice(5);
        const buf = Buffer.from(b64, 'base64');
        return safeStorage.decryptString(buf);
      } else if (encoded.startsWith('aes:')) {
        if (!this.testKey) {
          throw new Error('[CredentialVault] Cannot decrypt AES test ciphertext without configured test key');
        }
        const parts = encoded.split(':');
        if (parts.length !== 4) return null;
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
    } catch (e: any) {
      console.error('[CredentialVault] Decryption failed:', e);
      return null;
    }
  }

  private readVault(): Record<string, string> {
    if (!fs.existsSync(this.vaultPath)) {
      return {};
    }
    const raw = fs.readFileSync(this.vaultPath, 'utf8');
    return JSON.parse(raw);
  }

  /**
   * Writes data to vault file. Throws on error so persistence failures propagate to callers.
   */
  private writeVault(data: Record<string, string>): void {
    const dir = path.dirname(this.vaultPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.vaultPath, JSON.stringify(data, null, 2), 'utf8');
  }

  public async setKey(provider: string, apiKey: string): Promise<void> {
    if (!provider || typeof provider !== 'string') {
      throw new Error('[CredentialVault] Invalid provider: Must be a non-empty string');
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      throw new Error('[CredentialVault] Invalid API key: Key cannot be empty');
    }

    const vault = this.readVault();
    vault[provider.toLowerCase().trim()] = await this.encrypt(apiKey.trim());
    this.writeVault(vault);
  }

  public async getKey(provider: string): Promise<string | null> {
    if (!provider) return null;
    const vault = this.readVault();
    const encrypted = vault[provider.toLowerCase().trim()];
    if (!encrypted) return null;
    return await this.decrypt(encrypted);
  }

  public async deleteKey(provider: string): Promise<void> {
    if (!provider) return;
    const vault = this.readVault();
    delete vault[provider.toLowerCase().trim()];
    this.writeVault(vault);
  }

  /**
   * Removes the complete encrypted credential vault from this application profile.
   * This is logical application-level deletion; the filesystem may retain recoverable
   * storage blocks, so it is not described as forensic or physical secure erasure.
   */
  public async deleteAllKeys(): Promise<void> {
    try {
      fs.unlinkSync(this.vaultPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  public async hasKeys(): Promise<Record<string, boolean>> {
    const vault = this.readVault();
    const providers = ['gemini', 'openai', 'anthropic', 'groq', 'ollama'];
    const result: Record<string, boolean> = {};
    for (const p of providers) {
      result[p] = !!vault[p];
    }
    return result;
  }
}

export const credentialVault = new CredentialVault();
