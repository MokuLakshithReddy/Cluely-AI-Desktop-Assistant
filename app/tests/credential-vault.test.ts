import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialVault, isSecureStorageBackendAvailable } from '../electron/services/vault';
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
    expect(isSecureStorageBackendAvailable('linux', true, 'basic_text')).toBe(false);
    expect(isSecureStorageBackendAvailable('win32', true, undefined)).toBe(true);
    expect(isSecureStorageBackendAvailable('darwin', true, undefined)).toBe(true);
  });

  it('encrypts and successfully decrypts an API key', async () => {
    const rawKey = 'sk-proj-test_secret_key_1234567890';
    await vault.setKey('openai', rawKey);

    const decrypted = await vault.getKey('openai');
    expect(decrypted).toBe(rawKey);

    // Verify vault file contains ciphertext, NOT plaintext!
    const fileContent = fs.readFileSync(testVaultFile, 'utf8');
    expect(fileContent).not.toContain(rawKey);
    expect(fileContent).toMatch(/(aes:|safe:)/);
  });

  it('fails safely and refuses to persist credentials when OS keyring is unavailable and no test key is supplied', async () => {
    // Vault initialized without testKey under headless node test runner where safeStorage is unavailable
    const unkeyedVault = new CredentialVault(testVaultFile);
    await expect(unkeyedVault.setKey('openai', 'sk-proj-secret')).rejects.toThrow(
      /Secure OS-backed credential storage is unavailable/
    );
    expect(fs.existsSync(testVaultFile)).toBe(false);
  });

  it('propagates filesystem write errors to caller when persistence fails', async () => {
    // Unwritable path / invalid directory structure
    const unwritablePath = path.join(process.cwd(), 'test-credentials.vault', 'forbidden', 'vault.json');
    // Create file where folder is expected
    fs.writeFileSync(testVaultFile, 'dummy');
    const failingVault = new CredentialVault(unwritablePath, testKey);

    await expect(failingVault.setKey('openai', 'sk-proj-test')).rejects.toThrow();
  });

  it('returns null when querying a provider that has not been configured', async () => {
    const key = await vault.getKey('nonexistent_provider');
    expect(key).toBeNull();
  });

  it('correctly maps hasKeys() boolean presence without exposing secrets', async () => {
    await vault.setKey('gemini', 'AIzaSy_fake_gemini_key');
    await vault.setKey('groq', 'gsk_fake_groq_key');

    const status = await vault.hasKeys();
    expect(status.gemini).toBe(true);
    expect(status.groq).toBe(true);
    expect(status.openai).toBe(false);
    expect(status.anthropic).toBe(false);

    // Verify status object does not contain any key values
    expect((status as any).gemini).not.toBe('AIzaSy_fake_gemini_key');
  });

  it('deletes an API key cleanly from vault storage', async () => {
    await vault.setKey('anthropic', 'sk-ant-test_key');
    expect(await vault.getKey('anthropic')).toBe('sk-ant-test_key');

    await vault.deleteKey('anthropic');
    expect(await vault.getKey('anthropic')).toBeNull();

    const status = await vault.hasKeys();
    expect(status.anthropic).toBe(false);
  });

  it('removes the complete encrypted vault and all provider credentials', async () => {
    await vault.setKey('gemini', 'e2e-gemini-test-key');
    await vault.setKey('openai', 'e2e-openai-test-key');
    await vault.setKey('groq', 'e2e-groq-test-key');

    expect(fs.existsSync(testVaultFile)).toBe(true);
    expect((await vault.hasKeys()).gemini).toBe(true);
    expect((await vault.hasKeys()).openai).toBe(true);

    await vault.deleteAllKeys();

    expect(fs.existsSync(testVaultFile)).toBe(false);
    expect(await vault.getKey('gemini')).toBeNull();
    expect(await vault.getKey('openai')).toBeNull();
    expect(await vault.getKey('groq')).toBeNull();
    expect(await vault.hasKeys()).toEqual({
      gemini: false,
      openai: false,
      anthropic: false,
      groq: false,
      ollama: false,
    });

    // Deleting an already absent vault is intentionally idempotent.
    await expect(vault.deleteAllKeys()).resolves.toBeUndefined();
  });

  it('rejects empty or non-string key and provider inputs', async () => {
    await expect(vault.setKey('', 'valid_key')).rejects.toThrow(/Invalid provider/);
    await expect(vault.setKey('gemini', '')).rejects.toThrow(/Invalid API key/);
  });
});
