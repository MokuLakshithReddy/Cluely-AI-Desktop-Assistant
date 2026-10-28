import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialVault } from '../electron/services/vault';
import fs from 'fs';
import path from 'path';

describe('Credential Vault & Secret Protection Subsystem', () => {
  let vault: CredentialVault;
  const testVaultFile = path.join(process.cwd(), 'test-credentials.vault');

  beforeEach(() => {
    vault = new CredentialVault();
    // Point to test file
    (vault as any).vaultPath = testVaultFile;
    if (fs.existsSync(testVaultFile)) fs.unlinkSync(testVaultFile);
  });

  afterEach(() => {
    if (fs.existsSync(testVaultFile)) fs.unlinkSync(testVaultFile);
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

  it('rejects empty or non-string key and provider inputs', async () => {
    await expect(vault.setKey('', 'valid_key')).rejects.toThrow(/Invalid provider/);
    await expect(vault.setKey('gemini', '')).rejects.toThrow(/Invalid API key/);
  });
});
