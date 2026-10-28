import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'url';
import { IpcRouter } from '../electron/domains/ipc-router';

describe('IPC Security & Origin Validation Subsystem', () => {
  const trustedHtml = path.normalize('C:/Users/nsrfl/OneDrive/Desktop/Cluely_Reverse_Engineering/app/dist/index.html');
  const router = new IpcRouter(trustedHtml);

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

  it('rejects lookalike development hostnames attempting prefix or domain spoofing', () => {
    const lookalikes = [
      'http://localhost-evil.com:5173/',
      'http://localhost.evil.com:5173/',
      'http://localhost5173.com/',
      'http://127.0.0.1.attacker.com:5173/',
      'http://localhost:51730/',
      'http://localhost:8080/',
      'https://localhost:5173/',
    ];

    for (const url of lookalikes) {
      const fakeEvent: any = { senderFrame: { url } };
      expect(() => router.validateOrigin(fakeEvent), `Expected ${url} to be rejected`).toThrow(
        /Rejected unauthorized origin/
      );
    }
  });

  it('rejects external URLs attempting to bypass validation via dist/index.html substring', () => {
    const bypassAttempts = [
      'https://evil-site.com/dist/index.html',
      'https://evil-site.com/dist/index.html?param=value',
      'http://attacker.com/app/dist/index.html',
      'http://localhost-fake.com:5173/dist/index.html',
      'http://evil.org:5173/dist/index.html#control',
    ];

    for (const url of bypassAttempts) {
      const fakeEvent: any = { senderFrame: { url } };
      expect(() => router.validateOrigin(fakeEvent), `Expected ${url} to be rejected`).toThrow(
        /Rejected unauthorized origin/
      );
    }
  });

  it('rejects rogue file:// URLs attempting to load dist/index.html from outside the trusted app directory', () => {
    const rogueFileUrls = [
      'file:///C:/attacker/fake/dist/index.html',
      'file:///tmp/rogue/dist/index.html',
      'file:///home/user/other-project/dist/index.html',
      'file:///C:/evil/dist/index.html#chat',
    ];

    for (const url of rogueFileUrls) {
      const fakeEvent: any = { senderFrame: { url } };
      expect(() => router.validateOrigin(fakeEvent), `Expected rogue file URL ${url} to be rejected`).toThrow(
        /Rejected unauthorized origin/
      );
    }
  });

  it('accepts valid production file:// URL matching the exact trusted app bundle', () => {
    const validFileUrl = pathToFileURL(trustedHtml).href;
    expect(() => router.validateOrigin({ senderFrame: { url: validFileUrl } })).not.toThrow();

    // With route hash parameters
    expect(() => router.validateOrigin({ senderFrame: { url: `${validFileUrl}#chat` } })).not.toThrow();
    expect(() => router.validateOrigin({ senderFrame: { url: `${validFileUrl}#dashboard?tab=models` } })).not.toThrow();
  });

  it('accepts exact legitimate development server origins (localhost:5173 and 127.0.0.1:5173)', () => {
    const validDevUrls = [
      'http://localhost:5173/',
      'http://localhost:5173/index.html',
      'http://localhost:5173/#control',
      'http://127.0.0.1:5173/',
      'http://127.0.0.1:5173/index.html#chat',
    ];

    for (const url of validDevUrls) {
      expect(() => router.validateOrigin({ senderFrame: { url } }), `Expected ${url} to be accepted`).not.toThrow();
    }
  });

  it('respects exact origin when VITE_DEV_SERVER_URL is configured', () => {
    const originalEnv = process.env.VITE_DEV_SERVER_URL;
    process.env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:3000';

    try {
      // Valid custom dev server
      expect(() => router.validateOrigin({ senderFrame: { url: 'http://127.0.0.1:3000/' } })).not.toThrow();
      expect(() => router.validateOrigin({ senderFrame: { url: 'http://127.0.0.1:3000/#chat' } })).not.toThrow();

      // Lookalikes / wrong port on custom dev server must still be rejected
      expect(() => router.validateOrigin({ senderFrame: { url: 'http://127.0.0.1:3001/' } })).toThrow(/Rejected unauthorized origin/);
      expect(() => router.validateOrigin({ senderFrame: { url: 'http://127.0.0.1.evil.com:3000/' } })).toThrow(/Rejected unauthorized origin/);
    } finally {
      process.env.VITE_DEV_SERVER_URL = originalEnv;
    }
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

  it('enforces strict boolean types on flags and rejects falsy/truthy non-booleans', () => {
    const invalidTypes = [
      { showChat: 'true' },
      { isStealthMode: 1 },
      { isRecording: null },
      { chatWindowIsExpanded: 'yes' },
      { meHasVoiceActivity: 0 },
    ];

    for (const invalidPatch of invalidTypes) {
      expect(() => router.sanitizePatchState(invalidPatch)).toThrow(
        /Invalid type for boolean field/
      );
    }
  });

  it('validates activeMode against allowed enum variants', () => {
    // Valid modes
    for (const mode of ['copilot', 'interview', 'coding', 'sales', 'executive']) {
      expect(router.sanitizePatchState({ activeMode: mode }).activeMode).toBe(mode);
    }

    // Invalid modes
    expect(() => router.sanitizePatchState({ activeMode: 'unauthorized_mode' })).toThrow(
      /Invalid activeMode/
    );
    expect(() => router.sanitizePatchState({ activeMode: 123 })).toThrow(
      /Invalid activeMode/
    );
  });

  it('validates shortcuts map structure and accelerator strings', () => {
    // Valid shortcuts
    const valid = router.sanitizePatchState({
      shortcuts: { ask: 'CommandOrControl+Enter', clear: 'Escape' },
    });
    expect(valid.shortcuts?.ask).toBe('CommandOrControl+Enter');

    // Invalid shortcut action
    expect(() =>
      router.sanitizePatchState({
        shortcuts: { maliciousAction: 'Ctrl+Alt+Del' },
      })
    ).toThrow(/Unknown shortcut action/);

    // Invalid accelerator type
    expect(() =>
      router.sanitizePatchState({
        shortcuts: { ask: '' },
      })
    ).toThrow(/Invalid accelerator for shortcut/);
  });

  it('validates session structure and rejects invalid session IDs', () => {
    // Can be null
    expect(router.sanitizePatchState({ session: null }).session).toBeNull();

    // Valid session object
    const validSession = {
      id: 'sess_valid_123',
      createdAt: new Date().toISOString(),
      messages: [],
      transcript: [],
    };
    expect(router.sanitizePatchState({ session: validSession }).session).toEqual(validSession);

    // Invalid session ID with path traversal
    expect(() =>
      router.sanitizePatchState({
        session: { ...validSession, id: '../../traversal' },
      })
    ).toThrow(/Session ID must match/);

    // Missing messages array
    expect(() =>
      router.sanitizePatchState({
        session: { id: 'sess_1', createdAt: '2026', transcript: [] },
      })
    ).toThrow(/messages must be an array/);
  });

  it('validates knowledgeDocs structure and document schemas', () => {
    // Valid knowledgeDocs array
    const validDocs = [
      { id: 'doc1', title: 'Resume', content: 'Bio content', sourceType: 'file' },
    ];
    expect(router.sanitizePatchState({ knowledgeDocs: validDocs }).knowledgeDocs).toEqual(validDocs);

    // Not an array
    expect(() => router.sanitizePatchState({ knowledgeDocs: 'not-array' })).toThrow(
      /Expected an array of documents/
    );

    // Item missing content
    expect(() =>
      router.sanitizePatchState({
        knowledgeDocs: [{ id: 'doc1', title: 'Missing content' }],
      })
    ).toThrow(/Missing id, title, or content/);
  });
});

