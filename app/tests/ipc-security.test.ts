import { describe, it, expect } from 'vitest';
import { IpcRouter } from '../electron/domains/ipc-router';

describe('IPC Security & Origin Validation Subsystem', () => {
  const router = new IpcRouter();

  it('rejects IPC invocation when senderFrame is null or undefined', () => {
    const fakeEvent: any = { senderFrame: null };
    expect(() => router.validateOrigin(fakeEvent)).toThrow(
      /Missing sender frame context/
    );
  });

  it('rejects IPC invocation when senderFrame.url is empty or invalid', () => {
    const fakeEvent: any = { senderFrame: { url: '' } };
    expect(() => router.validateOrigin(fakeEvent)).toThrow(
      /Missing sender frame context/
    );
  });

  it('rejects untrusted external website origins (e.g. https://evil-site.com)', () => {
    const fakeEvent: any = { senderFrame: { url: 'https://evil-site.com/exploit.html' } };
    expect(() => router.validateOrigin(fakeEvent)).toThrow(
      /Rejected unauthorized origin/
    );
  });

  it('sanitizes patch-shared-state payloads to only allow whitelisted keys', () => {
    const validPatch = {
      showChat: true,
      activeMode: 'interview',
      isStealthMode: true,
    };
    const sanitized = router.sanitizePatchState(validPatch);
    expect(sanitized.showChat).toBe(true);
    expect(sanitized.activeMode).toBe('interview');
    expect(sanitized.isStealthMode).toBe(true);
  });

  it('rejects patch-shared-state payloads containing unwhitelisted or sensitive fields', () => {
    const maliciousPatch = {
      appVersion: '999.0.0', // Read-only protected system field
      arbitraryInjectedProp: 'malicious_code',
    };
    expect(() => router.sanitizePatchState(maliciousPatch)).toThrow(
      /Unauthorized state field in patch/
    );
  });

  it('rejects non-object patch payloads (e.g. strings, arrays, null)', () => {
    expect(() => router.sanitizePatchState(null)).toThrow(/Invalid patch/);
    expect(() => router.sanitizePatchState('malicious')).toThrow(/Invalid patch/);
    expect(() => router.sanitizePatchState([1, 2, 3])).toThrow(/Invalid patch/);
  });
});
