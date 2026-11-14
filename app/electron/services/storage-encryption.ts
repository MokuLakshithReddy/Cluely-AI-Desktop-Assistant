import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

let activeMasterKey: Buffer | null = null;

/**
 * Returns whether Electron selected a genuinely OS-backed credential/key provider.
 * Enforces the Linux backend allowlist (rejects insecure basic_text backend).
 */
export function isSecureStorageBackendAvailable(
  platform: string = process.platform,
  encryptionAvailable: boolean = typeof safeStorage !== 'undefined' && typeof safeStorage.isEncryptionAvailable === 'function' ? safeStorage.isEncryptionAvailable() : false,
  selectedBackend?: string | null
): boolean {
  if (!encryptionAvailable) return false;
  if (platform === 'linux') {
    const supportedBackends = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);
    return Boolean(selectedBackend && supportedBackends.has(selectedBackend));
  }
  return platform === 'win32' || platform === 'darwin';
}

/**
 * Sets an explicit 32-byte master encryption key (primarily for unit tests).
 */
export function setMasterEncryptionKey(key: Buffer | null): void {
  activeMasterKey = key;
}

/**
 * Returns whether hardware/OS-backed safeStorage encryption is currently available.
 */
export function isSafeStorageAvailable(): boolean {
  try {
    if (typeof safeStorage === 'undefined' || typeof safeStorage.isEncryptionAvailable !== 'function') {
      return false;
    }
    const available = safeStorage.isEncryptionAvailable();
    let backend: string | undefined;
    if (process.platform === 'linux' && typeof (safeStorage as any).getSelectedStorageBackend === 'function') {
      backend = (safeStorage as any).getSelectedStorageBackend();
    }
    return isSecureStorageBackendAvailable(process.platform, available, backend);
  } catch {
    return false;
  }
}

/**
 * Retrieves or initializes the 256-bit AES master key protected at rest by OS safeStorage.
 * Fails closed in production environments if secure OS-backed storage is unavailable.
 */
export function getMasterEncryptionKey(): Buffer {
  if (activeMasterKey && activeMasterKey.length === 32) {
    return activeMasterKey;
  }

  // 1. Try OS-backed safeStorage if inside Electron main process
  if (isSafeStorageAvailable()) {
    try {
      const keyFile = path.join(app.getPath('userData'), 'storage-master.key');
      if (fs.existsSync(keyFile)) {
        const encryptedKey = fs.readFileSync(keyFile);
        const keyHex = safeStorage.decryptString(encryptedKey);
        const keyBuf = Buffer.from(keyHex, 'hex');
        if (keyBuf.length === 32) {
          activeMasterKey = keyBuf;
          return activeMasterKey;
        }
      }

      // Generate a new 256-bit cryptographically secure key and seal it with safeStorage
      const newKey = crypto.randomBytes(32);
      const encryptedKey = safeStorage.encryptString(newKey.toString('hex'));
      fs.writeFileSync(keyFile, encryptedKey, { mode: 0o600 });
      if (process.platform !== 'win32') {
        fs.chmodSync(keyFile, 0o600);
      }
      activeMasterKey = newKey;
      return activeMasterKey;
    } catch (err) {
      console.error('[StorageEncryption] Failed to initialize safeStorage master key:', err);
    }
  }

  // 2. Headless unit test runner fallback: strictly restricted to test environments
  const isTestEnvironment =
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    Boolean(process.env.TEST) ||
    Boolean(process.env.SESSION_ENCRYPTION_KEY);

  if (isTestEnvironment) {
    if (process.env.SESSION_ENCRYPTION_KEY) {
      activeMasterKey = crypto.createHash('sha256').update(process.env.SESSION_ENCRYPTION_KEY).digest();
      return activeMasterKey;
    }
    activeMasterKey = crypto.createHash('sha256').update('cluely-local-storage-test-key').digest();
    return activeMasterKey;
  }

  // 3. FAIL CLOSED: In production, never fallback to a predictable static key
  throw new Error(
    '[StorageEncryption] Secure OS-backed storage is unavailable. ' +
    'Production persistence requires a supported hardware/OS key store (DPAPI on Windows, Keychain on macOS, or Secret Service/libsecret/KWallet on Linux). Fail-closed policy active.'
  );
}

/**
 * Encrypts arbitrary session records or state payloads using authenticated AES-256-GCM.
 */
export function encryptStoragePayload(data: string | any, customKey?: Buffer): string {
  const plainText = typeof data === 'string' ? data : JSON.stringify(data);
  const key = customKey || getMasterEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ciphertext = cipher.update(plainText, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:v1:${iv.toString('hex')}:${authTag}:${ciphertext}`;
}

/**
 * Decrypts AES-256-GCM storage envelopes. Gracefully parses legacy unencrypted plaintext.
 */
export function decryptStoragePayload(payloadStr: string, customKey?: Buffer): string {
  if (!payloadStr || typeof payloadStr !== 'string') {
    return payloadStr || '';
  }

  if (!payloadStr.startsWith('enc:v1:')) {
    return payloadStr; // Unencrypted backward compatibility
  }

  const parts = payloadStr.split(':');
  if (parts.length !== 5) {
    throw new Error('[StorageEncryption] Malformed encrypted storage envelope');
  }

  const key = customKey || getMasterEncryptionKey();
  const iv = Buffer.from(parts[2], 'hex');
  const authTag = Buffer.from(parts[3], 'hex');
  const ciphertext = parts[4];

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
