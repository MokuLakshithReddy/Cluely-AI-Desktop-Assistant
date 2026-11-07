import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CredentialVault, isSecureStorageBackendAvailable, encryptWithAsyncSafeStorage, decryptWithAsyncSafeStorage } from '../electron/services/vault';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

describe('Credential Vault & Secret Protection Subsystem', () => {
  let vault: CredentialVault;
  const testKey = crypto.randomBytes(32);
  const testVaultFile = path.join(process.cwd(), 'test-credentials.vault');

  beforeEach(() => {
    if (fs.existsSync(testVaultFile)) fs.unlinkSync(testVaultFile);
    vault = new CredentialVault(testVaultFile, testKey);
  });

  afterEach(() => {
    if (fs.existsSync(testVaultFile)) fs.unlinkSync(testVaultFile);
  });

  it('rejects Linux basic_text and unknown backends while accepting OS secret stores', () => {
    expect(isSecureStorageBackendAvailable('linux', true, 'basic_text')).toBe(false);
    expect(isSecureStorageBackendAvailable('linux', true, undefined)).toBe(false);
    expect(isSecureStorageBackendAvailable('linux', false, 'gnome_libsecret')).toBe(false);
    expect(isSecureStorageBackendAvailable('linux', true, 'gnome_libsecret')).toBe(true);
    expect(isSecureStorageBackendAvailable('linux', true, 'kwallet')).toBe(true);
    expect(isSecureStorageBackendAvailable('linux', true, 'kwallet5')).toBe(true);
    expect(isSecureStorageBackendAvailable('linux', true, 'kwallet6')).toBe(true);
    expect(isSecureStorageBackendAvailable('linux', true, 'some_future_unknown_backend')).toBe(false);
    expect(isSecureStorageBackendAvailable('win32', true, undefined)).toBe(true);
    expect(isSecureStorageBackendAvailable('darwin', true, undefined)).toBe(true);
    expect(isSecureStorageBackendAvailable('freebsd', true, undefined)).toBe(false);
  });

  it('uses asynchronous safeStorage and never calls synchronous encryption methods', async () => {
    const storage = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
      getSelectedStorageBackend: vi.fn().mockReturnValue('gnome_libsecret'),
      encryptStringAsync: vi.fn().mockResolvedValue(Buffer.from('async-ciphertext')),
      decryptStringAsync: vi.fn(),
      encryptString: vi.fn(() => { throw new Error('synchronous encryption must not run'); }),
    };
    const encrypted = await encryptWithAsyncSafeStorage(storage, 'linux', 'secret');
    expect(encrypted.toString()).toBe('async-ciphertext');
    expect(storage.encryptStringAsync).toHaveBeenCalledWith('secret');
    expect(storage.encryptString).not.toHaveBeenCalled();
  });

  it('fails closed when async safeStorage is temporarily unavailable', async () => {
    const storage = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false),
      getSelectedStorageBackend: vi.fn().mockReturnValue('gnome_libsecret'),
      encryptStringAsync: vi.fn().mockResolvedValue(Buffer.from('ciphertext')),
      decryptStringAsync: vi.fn(),
    };
    await expect(encryptWithAsyncSafeStorage(storage, 'linux', 'secret'))
      .rejects.toThrow(/Secure asynchronous OS-backed credential storage is unavailable/);
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it('re-encrypts decrypted plaintext when Electron reports key rotation', async () => {
    const replacement = Buffer.from('ciphertext-under-current-key');
    const storage = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
      getSelectedStorageBackend: vi.fn().mockReturnValue('gnome_libsecret'),
      decryptStringAsync: vi.fn().mockResolvedValue({ shouldReEncrypt: true, result: 'rotated-secret' }),
      encryptStringAsync: vi.fn().mockResolvedValue(replacement),
    };
    const result = await decryptWithAsyncSafeStorage(storage, 'linux', Buffer.from('legacy-ciphertext'));
    expect(result.result).toBe('rotated-secret');
    expect(result.reEncrypted).toEqual(replacement);
    expect(storage.decryptStringAsync).toHaveBeenCalledTimes(1);
    expect(storage.encryptStringAsync).toHaveBeenCalledWith('rotated-secret');
  });

  it('reads existing synchronous safeStorage ciphertext through the async decrypt API', async () => {
    const storage = {
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
      getSelectedStorageBackend: vi.fn().mockReturnValue('gnome_libsecret'),
      decryptStringAsync: vi.fn().mockResolvedValue({ shouldReEncrypt: false, result: 'previously-saved-key' }),
      encryptStringAsync: vi.fn(),
    };
    const result = await decryptWithAsyncSafeStorage(storage, 'linux', Buffer.from('legacy-sync-ciphertext'));
    expect(result.result).toBe('previously-saved-key');
    expect(result.reEncrypted).toBeUndefined();
  });

  it('encrypts and successfully decrypts an API key using an explicit test key', async () => {
    const rawKey = 'sk-proj-test_secret_key_1234567890';
    await vault.setKey('openai', rawKey);
    expect(await vault.getKey('openai')).toBe(rawKey);
    const fileContent = fs.readFileSync(testVaultFile, 'utf8');
    expect(fileContent).not.toContain(rawKey);
    expect(fileContent).toMatch(/aes:/);
  });

  it('fails safely and refuses to persist credentials when async OS keyring is unavailable without a test key', async () => {
    const unkeyedVault = new CredentialVault(testVaultFile);
    await expect(unkeyedVault.setKey('openai', 'sk-proj-secret')).rejects.toThrow(
      /asynchronous safeStorage|Secure asynchronous OS-backed credential storage/i
    );
    expect(fs.existsSync(testVaultFile)).toBe(false);
  });

  it('serializes concurrent updates so credentials are not lost', async () => {
    await Promise.all([
      vault.setKey('openai', 'openai-test-key'),
      vault.setKey('gemini', 'gemini-test-key'),
      vault.setKey('groq', 'groq-test-key'),
    ]);
    expect(await vault.getKey('openai')).toBe('openai-test-key');
    expect(await vault.getKey('gemini')).toBe('gemini-test-key');
    expect(await vault.getKey('groq')).toBe('groq-test-key');
  });

  it('propagates filesystem write errors to caller when persistence fails', async () => {
    const unwritablePath = path.join(process.cwd(), 'test-credentials.vault', 'forbidden', 'vault.json');
    fs.writeFileSync(testVaultFile, 'dummy');
    const failingVault = new CredentialVault(unwritablePath, testKey);
    await expect(failingVault.setKey('openai', 'sk-proj-test')).rejects.toThrow();
  });

  it('returns null when querying a provider that has not been configured', async () => {
    expect(await vault.getKey('nonexistent_provider')).toBeNull();
  });

  it('correctly maps hasKeys() boolean presence without exposing secrets', async () => {
    await vault.setKey('gemini', 'AIzaSy_fake_gemini_key');
    await vault.setKey('groq', 'gsk_fake_groq_key');
    const status = await vault.hasKeys();
    expect(status.gemini).toBe(true);
    expect(status.groq).toBe(true);
    expect(status.openai).toBe(false);
    expect(status.anthropic).toBe(false);
    expect((status as any).gemini).not.toBe('AIzaSy_fake_gemini_key');
  });

  it('deletes an API key cleanly from vault storage', async () => {
    await vault.setKey('anthropic', 'sk-ant-test_key');
    expect(await vault.getKey('anthropic')).toBe('sk-ant-test_key');
    await vault.deleteKey('anthropic');
    expect(await vault.getKey('anthropic')).toBeNull();
    expect((await vault.hasKeys()).anthropic).toBe(false);
  });

  it('removes the complete encrypted vault and all provider credentials', async () => {
    await vault.setKey('gemini', 'e2e-gemini-test-key');
    await vault.setKey('openai', 'e2e-openai-test-key');
    await vault.setKey('groq', 'e2e-groq-test-key');
    expect(fs.existsSync(testVaultFile)).toBe(true);
    await vault.deleteAllKeys();
    expect(fs.existsSync(testVaultFile)).toBe(false);
    expect(await vault.getKey('gemini')).toBeNull();
    expect(await vault.getKey('openai')).toBeNull();
    expect(await vault.getKey('groq')).toBeNull();
    expect(await vault.hasKeys()).toEqual({
      gemini: false, openai: false, anthropic: false, groq: false, ollama: false
    });
    await expect(vault.deleteAllKeys()).resolves.toBeUndefined();
  });

  it('rejects empty or non-string key and provider inputs', async () => {
    await expect(vault.setKey('', 'valid_key')).rejects.toThrow(/Invalid provider/);
    await expect(vault.setKey('gemini', '')).rejects.toThrow(/Invalid API key/);
  });
});
