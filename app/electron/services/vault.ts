import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class CredentialVault {
  private vaultPath: string;

  constructor() {
    this.vaultPath = this.resolveVaultPath();
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

  private getFallbackKey(): Buffer {
    // Machine-local key derivation for environments without OS keyring
    const seed = `${process.env.USER || process.env.USERNAME || 'cluely'}_${process.platform}_salt_2026`;
    return crypto.scryptSync(seed, 'cluely_secure_salt_8921', 32);
  }

  private encrypt(plainText: string): string {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(plainText);
      return `safe:${encrypted.toString('base64')}`;
    }

    // AES-256-GCM fallback
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.getFallbackKey(), iv);
    let ciphertext = cipher.update(plainText, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `aes:${iv.toString('hex')}:${authTag}:${ciphertext}`;
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
        const parts = encoded.split(':');
        if (parts.length !== 4) return null;
        const [, ivHex, tagHex, cipherHex] = parts;
        const decipher = crypto.createDecipheriv(
          'aes-256-gcm',
          this.getFallbackKey(),
          Buffer.from(ivHex, 'hex')
        );
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
      return null;
    } catch (e) {
      console.error('[CredentialVault] Decryption failed:', e);
      return null;
    }
  }

  private readVault(): Record<string, string> {
    try {
      if (fs.existsSync(this.vaultPath)) {
        const raw = fs.readFileSync(this.vaultPath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('[CredentialVault] Failed to read vault file:', e);
    }
    return {};
  }

  private writeVault(data: Record<string, string>): void {
    try {
      const dir = path.dirname(this.vaultPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.vaultPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      console.error('[CredentialVault] Failed to write vault file:', e);
    }
  }

  public async setKey(provider: string, apiKey: string): Promise<void> {
    if (!provider || typeof provider !== 'string') throw new Error('Invalid provider');
    if (!apiKey || typeof apiKey !== 'string') throw new Error('Invalid API key');

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
