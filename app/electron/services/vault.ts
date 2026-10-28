import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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

  /**
   * Encrypts plaintext using OS-backed safeStorage.
   * Fails safely without insecure fallbacks if OS keyring is unavailable and no explicit test key was provided.
   */
  private encrypt(plainText: string): string {
    // 1. Prefer OS-backed encryption (Windows DPAPI, macOS Keychain, Linux Secret Service)
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
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
      '[CredentialVault] OS-backed secure storage (safeStorage) is unavailable on this system. Refusing to persist credentials with insecure fallback.'
    );
  }

  private decrypt(encoded: string): string | null {
    try {
      if (encoded.startsWith('safe:')) {
        if (!safeStorage || typeof safeStorage.decryptString !== 'function') {
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
    vault[provider.toLowerCase().trim()] = this.encrypt(apiKey.trim());
    this.writeVault(vault);
  }

  public async getKey(provider: string): Promise<string | null> {
    if (!provider) return null;
    const vault = this.readVault();
    const encrypted = vault[provider.toLowerCase().trim()];
    if (!encrypted) return null;
    return this.decrypt(encrypted);
  }

  public async deleteKey(provider: string): Promise<void> {
    if (!provider) return;
    const vault = this.readVault();
    delete vault[provider.toLowerCase().trim()];
    this.writeVault(vault);
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
