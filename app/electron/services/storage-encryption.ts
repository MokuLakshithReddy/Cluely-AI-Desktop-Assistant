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
 * Sets an explicit 32-byte master encryption key (strictly for unit test environments).
 * Fails closed if called inside a packaged production application.
 */
export function setMasterEncryptionKey(key: Buffer | null): void {
  const isPackaged = typeof app !== 'undefined' && typeof app.isPackaged === 'boolean' ? app.isPackaged : false;
  if (isPackaged && key !== null) {
    throw new Error('[StorageEncryption] Cannot inject arbitrary master keys in a packaged production application');
  }
  activeMasterKey = key;
}

/**
 * Returns whether hardware/OS-backed safeStorage encryption is currently available
 * supporting asynchronous encryption (with synchronous fallback).
 */
export async function isAsyncSafeStorageAvailable(): Promise<boolean> {
  try {
    if (typeof safeStorage === 'undefined') {
      return false;
    }
    let available = false;
    if (typeof (safeStorage as any).isAsyncEncryptionAvailable === 'function') {
      available = await (safeStorage as any).isAsyncEncryptionAvailable();
    } else if (typeof safeStorage.isEncryptionAvailable === 'function') {
      available = safeStorage.isEncryptionAvailable();
    }
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
 * Asynchronously initializes or retrieves the 256-bit AES master key protected at rest by OS safeStorage.
 * Prefers non-blocking safeStorage.encryptStringAsync and safeStorage.decryptStringAsync to prevent main-thread
 * stalls and ensure full compatibility with Electron v45/v46+ where synchronous safeStorage is deprecated/removed.
 * Automatically performs re-encryption when Electron flags key rotation (shouldReEncrypt).
 */
export async function initStorageEncryptionAsync(): Promise<Buffer> {
  if (activeMasterKey && activeMasterKey.length === 32) {
    return activeMasterKey;
  }

  const isPackaged = typeof app !== 'undefined' && typeof app.isPackaged === 'boolean' ? app.isPackaged : false;
  const isExplicitUnitTestRunner =
    !isPackaged &&
    (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');

  const available = await isAsyncSafeStorageAvailable();
  if (available && typeof app !== 'undefined' && typeof app.getPath === 'function') {
    try {
      const keyFile = path.join(app.getPath('userData'), 'storage-master.key');
      if (fs.existsSync(keyFile)) {
        const encryptedKey = fs.readFileSync(keyFile);
        let keyHex: string;

        if (typeof (safeStorage as any).decryptStringAsync === 'function') {
          const decryptRes = await (safeStorage as any).decryptStringAsync(encryptedKey);
          if (typeof decryptRes === 'object' && decryptRes !== null && 'result' in decryptRes) {
            keyHex = decryptRes.result;
            if (decryptRes.shouldReEncrypt && typeof (safeStorage as any).encryptStringAsync === 'function') {
              const reEncrypted = await (safeStorage as any).encryptStringAsync(keyHex);
              fs.writeFileSync(keyFile, reEncrypted, { mode: 0o600 });
            }
          } else {
            keyHex = String(decryptRes);
          }
        } else if (typeof safeStorage.decryptString === 'function') {
          keyHex = safeStorage.decryptString(encryptedKey);
        } else {
          throw new Error('No safeStorage decryption method available on this runtime');
        }

        const keyBuf = Buffer.from(keyHex, 'hex');
        if (keyBuf.length === 32) {
          activeMasterKey = keyBuf;
          return activeMasterKey;
        }
      }

      // Generate a new 256-bit cryptographically secure key and seal it with async safeStorage
      const newKey = crypto.randomBytes(32);
      let encryptedKey: Buffer;
      if (typeof (safeStorage as any).encryptStringAsync === 'function') {
        encryptedKey = await (safeStorage as any).encryptStringAsync(newKey.toString('hex'));
      } else if (typeof safeStorage.encryptString === 'function') {
        encryptedKey = safeStorage.encryptString(newKey.toString('hex'));
      } else {
        throw new Error('No safeStorage encryption method available on this runtime');
      }

      fs.writeFileSync(keyFile, encryptedKey, { mode: 0o600 });
      if (process.platform !== 'win32') {
        fs.chmodSync(keyFile, 0o600);
      }
      activeMasterKey = newKey;
      return activeMasterKey;
    } catch (err) {
      console.error('[StorageEncryption] Failed to initialize safeStorage master key asynchronously:', err);
    }
  }

  // 2. Headless unit test runner fallback
  if (isExplicitUnitTestRunner) {
    activeMasterKey = crypto.createHash('sha256').update('scandium-local-storage-test-key').digest();
    return activeMasterKey;
  }

  // 3. FAIL CLOSED
  throw new Error(
    '[StorageEncryption] Secure OS-backed storage is unavailable. ' +
    (isPackaged
      ? 'Packaged application persistence requires a supported hardware/OS key store (DPAPI on Windows, Keychain on macOS, or Secret Service/libsecret/KWallet on Linux). Fail-closed policy active.'
      : 'Production persistence requires a supported hardware/OS key store (DPAPI on Windows, Keychain on macOS, or Secret Service/libsecret/KWallet on Linux). Fail-closed policy active.')
  );
}

/**
 * Retrieves or initializes the 256-bit AES master key protected at rest by OS safeStorage.
 * Fails closed in production environments if secure OS-backed storage is unavailable.
 */
export function getMasterEncryptionKey(): Buffer {
  if (activeMasterKey && activeMasterKey.length === 32) {
    return activeMasterKey;
  }

  // 1. Try OS-backed safeStorage if inside Electron main process (fallback for synchronous callers)
  if (isSafeStorageAvailable()) {
    try {
      const keyFile = path.join(app.getPath('userData'), 'storage-master.key');
      if (fs.existsSync(keyFile)) {
        const encryptedKey = fs.readFileSync(keyFile);
        if (typeof safeStorage.decryptString === 'function') {
          const keyHex = safeStorage.decryptString(encryptedKey);
          const keyBuf = Buffer.from(keyHex, 'hex');
          if (keyBuf.length === 32) {
            activeMasterKey = keyBuf;
            return activeMasterKey;
          }
        }
      }

      if (typeof safeStorage.encryptString === 'function') {
        const newKey = crypto.randomBytes(32);
        const encryptedKey = safeStorage.encryptString(newKey.toString('hex'));
        fs.writeFileSync(keyFile, encryptedKey, { mode: 0o600 });
        if (process.platform !== 'win32') {
          fs.chmodSync(keyFile, 0o600);
        }
        activeMasterKey = newKey;
        return activeMasterKey;
      }
    } catch (err) {
      console.error('[StorageEncryption] Failed to initialize safeStorage master key synchronously:', err);
    }
  }

  // 2. Headless unit test runner fallback: strictly restricted to unpackaged automated test environments
  // A packaged production app or production process setting TEST=1 must NEVER use the deterministic test key
  const isPackaged = typeof app !== 'undefined' && typeof app.isPackaged === 'boolean' ? app.isPackaged : false;
  const isExplicitUnitTestRunner =
    !isPackaged &&
    (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');

  if (isExplicitUnitTestRunner) {
    activeMasterKey = crypto.createHash('sha256').update('scandium-local-storage-test-key').digest();
    return activeMasterKey;
  }

  // 3. FAIL CLOSED: In packaged applications and standard production environments,
  // never fallback to a predictable static key even if TEST or SESSION_ENCRYPTION_KEY environment variables are present.
  throw new Error(
    '[StorageEncryption] Secure OS-backed storage is unavailable. ' +
    (isPackaged
      ? 'Packaged application persistence requires a supported hardware/OS key store (DPAPI on Windows, Keychain on macOS, or Secret Service/libsecret/KWallet on Linux). Fail-closed policy active.'
      : 'Production persistence requires a supported hardware/OS key store (DPAPI on Windows, Keychain on macOS, or Secret Service/libsecret/KWallet on Linux). Fail-closed policy active.')
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
