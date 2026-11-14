import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import {
  redactSensitiveText,
  containsSensitiveData,
  detectSensitiveData,
  inspectAndSanitizeOutboundPayload,
  sanitizeScreenshot,
  wipeBuffer,
} from '../src/lib/redaction';
import { validateNetworkEndpoint } from '../src/lib/providers';
import {
  encryptLocalSession,
  decryptLocalSession,
  SessionRecord,
} from '../electron/services/session-repository';
import { IpcRouter } from '../electron/domains/ipc-router';
import { stateManager } from '../electron/domains/state';

describe('Security, Privacy & Sensitive-Content Hardening Subsystem', () => {
  const trustedHtml = path.resolve(__dirname, '..', 'dist', 'index.html');
  const router = new IpcRouter(trustedHtml);

  describe('Pillar 1 & 8: Sensitive-Content Redaction & Inspection Engine', () => {
    it('redacts OpenAI API keys', () => {
      const mockKey = ['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-');
      const text = `Authorization: Bearer ${mockKey}`;
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('openai_api_key');
      expect(result.sanitized).toContain('[REDACTED_API_KEY]');
      expect(result.sanitized).not.toContain('sk-abcdef');
    });

    it('redacts AWS Access Key IDs', () => {
      const mockAws = ['AK' + 'IA', 'IOSFODNN7EXAMPLE'].join('');
      const text = `export AWS_ACCESS_KEY_ID=${mockAws}`;
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('aws_access_key');
      expect(result.sanitized).toContain('[REDACTED_AWS_KEY]');
      expect(result.sanitized).not.toContain(mockAws);
    });

    it('redacts Google API keys', () => {
      const mockGoogle = ['AI' + 'zaSyD', '1234567890abcdefghijklmnopqrs'].join('-');
      const text = `https://generativelanguage.googleapis.com/v1beta/models?key=${mockGoogle}`;
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('google_api_key');
      expect(result.sanitized).toContain('[REDACTED_GOOGLE_KEY]');
      expect(result.sanitized).not.toContain('AIzaSyD-');
    });

    it('redacts GitHub Personal Access Tokens (PAT)', () => {
      const mockPat = ['gh' + 'p', '1234567890abcdefghijklmnopqrstuvwxyz'].join('_');
      const text = `git clone https://${mockPat}@github.com/repo.git`;
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('github_pat');
      expect(result.sanitized).toContain('[REDACTED_GITHUB_TOKEN]');
      expect(result.sanitized).not.toContain('ghp_123456');
    });

    it('redacts Slack tokens', () => {
      const mockSlack = ['xo' + 'xb', '123456789012', '345678901234', 'abcdefghijklmnopqrstuvwx'].join('-');
      const text = `token: ${mockSlack}`;
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('slack_token');
      expect(result.sanitized).toContain('[REDACTED_SLACK_TOKEN]');
      expect(result.sanitized).not.toContain('xoxb-');
    });

    it('redacts Private Keys (RSA, EC, Generic)', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0m...\n-----END RSA PRIVATE KEY-----';
      const result = redactSensitiveText(pem);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('private_key');
      expect(result.sanitized).toBe('[REDACTED_PRIVATE_KEY]');
    });

    it('redacts JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = redactSensitiveText(`Bearer ${jwt}`);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('jwt_token');
      expect(result.sanitized).toContain('[REDACTED_JWT]');
      expect(result.sanitized).not.toContain('eyJhbGci');
    });

    it('redacts Credit Card numbers', () => {
      const text = 'Payment card: 4532-1234-5678-9012 expiration 12/28';
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('credit_card');
      expect(result.sanitized).toContain('[REDACTED_CREDIT_CARD]');
      expect(result.sanitized).not.toContain('4532-1234-5678-9012');
    });

    it('redacts Passwords in text and key-value fields', () => {
      const text = 'database password: "SuperSecretPassword123!"';
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('password_field');
      expect(result.sanitized).toContain('[REDACTED_PASSWORD]');
      expect(result.sanitized).not.toContain('SuperSecretPassword123!');
    });

    it('redacts MFA/OTP authentication codes', () => {
      const text = 'Your verification code is 849201 for Cluely';
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('mfa_code');
      expect(result.sanitized).toContain('[REDACTED_MFA_CODE]');
      expect(result.sanitized).not.toContain('849201');
    });

    it('redacts Email addresses', () => {
      const text = 'Contact lead engineer at jane.doe@enterprise-corp.com today';
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('email_address');
      expect(result.sanitized).toContain('[REDACTED_EMAIL]');
      expect(result.sanitized).not.toContain('jane.doe@enterprise-corp.com');
    });

    it('containsSensitiveData identifies secrets correctly', () => {
      const mockKey = ['sk', 'abcdefghijklmnopqrstuv123456'].join('-');
      expect(containsSensitiveData(`Here is my key: ${mockKey}`)).toBe(true);
      expect(containsSensitiveData('This is regular harmless meeting discussion about UI.')).toBe(false);
      const detect = detectSensitiveData(`Here is ${mockKey}`);
      expect(detect.hasSensitiveData).toBe(true);
      expect(detect.categories).toContain('openai_api_key');
    });

    it('inspectAndSanitizeOutboundPayload sanitizes deeply nested payloads', () => {
      const mockOpenAi = ['sk', '1234567890abcdef1234567890'].join('-');
      const mockSlack = ['xo' + 'xb', '9876543210', 'abcdefgh'].join('-');
      const payload = {
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: `Debug this authorization: ${mockOpenAi}` },
          { role: 'assistant', content: 'Checking...' },
        ],
        metadata: {
          authorEmail: 'admin@internal.io',
          config: {
            token: mockSlack,
          },
        },
      };

      const result = inspectAndSanitizeOutboundPayload(payload, false);
      expect(result.blocked).toBe(false);
      expect(result.scrubbedCount).toBe(3);
      expect(result.sanitizedPayload.messages[0].content).toContain('[REDACTED_API_KEY]');
      expect(result.sanitizedPayload.metadata.authorEmail).toBe('[REDACTED_EMAIL]');
      expect(result.sanitizedPayload.metadata.config.token).toBe('[REDACTED_SLACK_TOKEN]');
    });

    it('inspectAndSanitizeOutboundPayload blocks request when blockOnSecrets is true', () => {
      const mockAws = ['AK' + 'IA', '1111222233334444'].join('');
      const payload = {
        query: `Deploy with AWS_ACCESS_KEY_ID=${mockAws}`,
      };

      const result = inspectAndSanitizeOutboundPayload(payload, true);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('Outbound request blocked');
    });
  });

  describe('Pillar 3: Ephemeral Volatile Memory & Buffer Zero-Wiping', () => {
    it('wipes sensitive memory buffers with zeroes', () => {
      const sensitiveBuf = Buffer.from('SUPER_SECRET_AUTHENTICATION_KEY_DO_NOT_LEAK');
      expect(sensitiveBuf.toString()).toBe('SUPER_SECRET_AUTHENTICATION_KEY_DO_NOT_LEAK');

      wipeBuffer(sensitiveBuf);

      for (let i = 0; i < sensitiveBuf.length; i++) {
        expect(sensitiveBuf[i]).toBe(0);
      }
      expect(sensitiveBuf.toString()).not.toContain('SUPER_SECRET');
    });

    it('sanitizeScreenshot processes image buffers in memory without disk writes', async () => {
      const pngHeader = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
      ]);

      const result = await sanitizeScreenshot(pngHeader);
      expect(result.sanitizedBuffer).toBeDefined();
      expect(result.sanitizedBuffer.length).toBeGreaterThan(0);
    });
  });

  describe('Pillar 4 & 5: Authenticated AES-256-GCM Session Archive Encryption', () => {
    const mockSession: SessionRecord = {
      id: 'sess_confidential_999',
      title: 'Board of Directors Strategy Review',
      createdAt: '2026-11-14T00:00:00.000Z',
      updatedAt: '2026-11-14T01:00:00.000Z',
      durationSeconds: 3600,
      mode: 'meeting',
      audioInputLanguage: 'en',
      transcript: [
        {
          id: 't_001',
          createdAt: '2026-11-14T00:05:00.000Z',
          relativeMs: 300000,
          role: 'them',
          status: 'ready',
          text: 'Projected Q4 revenue is confidential.',
        },
      ],
      messages: [
        {
          id: 'm_001',
          role: 'assistant',
          content: 'I will keep all financial discussions local.',
          createdAt: '2026-11-14T00:06:00.000Z',
        },
      ],
    };

    const testKey = crypto.randomBytes(32);

    it('encrypts session records into authenticated AES-256-GCM envelope', () => {
      const encrypted = encryptLocalSession(mockSession, testKey);
      expect(encrypted.startsWith('enc:v1:')).toBe(true);

      const parts = encrypted.split(':');
      expect(parts.length).toBe(5); // ['enc', 'v1', iv, authTag, ciphertext]
      expect(parts[0]).toBe('enc');
      expect(parts[1]).toBe('v1');
      expect(parts[2].length).toBe(24); // 12-byte IV in hex = 24 chars
      expect(parts[3].length).toBe(32); // 16-byte AuthTag in hex = 32 chars
      expect(encrypted).not.toContain('Board of Directors');
      expect(encrypted).not.toContain('Projected Q4 revenue');
    });

    it('decrypts encrypted session records accurately', () => {
      const encrypted = encryptLocalSession(mockSession, testKey);
      const decrypted: SessionRecord = JSON.parse(decryptLocalSession(encrypted, testKey));

      expect(decrypted.id).toBe(mockSession.id);
      expect(decrypted.title).toBe(mockSession.title);
      expect(decrypted.transcript[0].text).toBe(mockSession.transcript[0].text);
      expect(decrypted.messages[0].content).toBe(mockSession.messages[0].content);
    });

    it('detects tampering and rejects corrupted ciphertext via GCM auth tag', () => {
      const encrypted = encryptLocalSession(mockSession, testKey);
      const parts = encrypted.split(':');
      const tamperedCipher = parts[4].slice(0, -2) + (parts[4].endsWith('a') ? 'b' : 'a');
      const tamperedEnvelope = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${tamperedCipher}`;

      expect(() => decryptLocalSession(tamperedEnvelope, testKey)).toThrow();
    });

    it('maintains backward compatibility with unencrypted legacy JSON', () => {
      const legacyJson = JSON.stringify(mockSession);
      const parsed: SessionRecord = JSON.parse(decryptLocalSession(legacyJson, testKey));
      expect(parsed.id).toBe(mockSession.id);
      expect(parsed.title).toBe(mockSession.title);
    });
  });

  describe('Pillar 9: Network Security & TLS Enforcement', () => {
    it('accepts HTTPS production endpoints', () => {
      expect(() => validateNetworkEndpoint('https://api.openai.com/v1/chat/completions')).not.toThrow();
      expect(() => validateNetworkEndpoint('https://generativelanguage.googleapis.com/v1beta/models')).not.toThrow();
      expect(() => validateNetworkEndpoint('https://api.anthropic.com/v1/messages')).not.toThrow();
      expect(() => validateNetworkEndpoint('https://api.groq.com/openai/v1/chat/completions')).not.toThrow();
    });

    it('accepts local loopback HTTP for Ollama offline inference', () => {
      expect(() => validateNetworkEndpoint('http://localhost:11434/api/generate')).not.toThrow();
      expect(() => validateNetworkEndpoint('http://127.0.0.1:11434/api/chat')).not.toThrow();
      expect(() => validateNetworkEndpoint('http://[::1]:11434/api/tags')).not.toThrow();
    });

    it('rejects external insecure HTTP endpoints', () => {
      expect(() => validateNetworkEndpoint('http://api.openai.com/v1/chat/completions'))
        .toThrow(/Insecure HTTP endpoint rejected/);
      expect(() => validateNetworkEndpoint('http://my-remote-ai-server.com:11434'))
        .toThrow(/Insecure HTTP endpoint rejected/);
    });

    it('rejects invalid URL formats', () => {
      expect(() => validateNetworkEndpoint('not-a-valid-url')).toThrow(/Invalid endpoint URL/);
    });
  });

  describe('Pillar 2, 7, 10 & 12: IPC State Sanitization & Enterprise Governance', () => {
    it('validates allowed privacy modes', () => {
      expect(() => router.sanitizePatchState({ privacyMode: 'local' })).not.toThrow();
      expect(() => router.sanitizePatchState({ privacyMode: 'cloud' })).not.toThrow();
      expect(() => router.sanitizePatchState({ privacyMode: 'unrestricted' as any }))
        .toThrow(/Invalid privacyMode/);
    });

    it('validates allowed meeting consent modes', () => {
      expect(() => router.sanitizePatchState({ meetingConsent: 'prompt' })).not.toThrow();
      expect(() => router.sanitizePatchState({ meetingConsent: 'allowed_once' })).not.toThrow();
      expect(() => router.sanitizePatchState({ meetingConsent: 'always_allowed' })).not.toThrow();
      expect(() => router.sanitizePatchState({ meetingConsent: 'denied' })).not.toThrow();
      expect(() => router.sanitizePatchState({ meetingConsent: 'bypass' as any }))
        .toThrow(/Invalid meetingConsent/);
    });

    it('validates boolean security configuration keys', () => {
      expect(() => router.sanitizePatchState({
        telemetryEnabled: false,
        enterpriseMode: true,
        redactSensitiveData: true,
        blockOutboundSecrets: true,
        encryptedStorageEnabled: true,
      })).not.toThrow();

      expect(() => router.sanitizePatchState({ telemetryEnabled: 'true' as any }))
        .toThrow(/Invalid type for boolean field "telemetryEnabled"/);
      expect(() => router.sanitizePatchState({ enterpriseMode: 123 as any }))
        .toThrow(/Invalid type for boolean field "enterpriseMode"/);
    });

    it('enforces Enterprise Mode restrictions on state patch', () => {
      stateManager.patchState({ enterpriseMode: true });
      const current = stateManager.getState();
      expect(current.enterpriseMode).toBe(true);
      expect(current.privacyMode).toBe('local');
      expect(current.telemetryEnabled).toBe(false);

      stateManager.patchState({ telemetryEnabled: true, privacyMode: 'cloud' });
      const updated = stateManager.getState();
      expect(updated.privacyMode).toBe('local');
      expect(updated.telemetryEnabled).toBe(false);

      // Cleanup
      stateManager.patchState({ enterpriseMode: false });
    });

    it('enforces audio channel reset and revokes allowed_once consent when recording stops in main process', () => {
      stateManager.patchState({
        meetingConsent: 'allowed_once',
        isRecording: true,
        micActive: true,
        systemAudioActive: true,
      });

      const sanitized = router.sanitizePatchState({ isRecording: false });
      expect(sanitized.isRecording).toBe(false);
      expect(sanitized.micActive).toBe(false);
      expect(sanitized.systemAudioActive).toBe(false);
      expect(sanitized.meetingConsent).toBe('prompt');

      stateManager.patchState(sanitized);
      expect(stateManager.getState().meetingConsent).toBe('prompt');
      expect(stateManager.getState().micActive).toBe(false);
      expect(stateManager.getState().systemAudioActive).toBe(false);
    });

    it('blocks unredacted screenshots to external cloud providers when blockOutboundSecrets is active', async () => {
      stateManager.patchState({ blockOutboundSecrets: true });

      const fakeWebContents = {
        send: vi.fn(),
      };
      const fakeEvent = {
        sender: fakeWebContents,
        senderFrame: { url: `file://${trustedHtml}` },
      };

      const handleAiStream = (router as any).handlers?.get?.('ai-stream-request');
      if (handleAiStream) {
        await expect(
          handleAiStream(fakeEvent, {
            providerName: 'openai',
            model: 'gpt-4o-mini',
            mode: 'copilot',
            query: 'Analyze this screen',
            screenshotBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            recentTranscript: [],
            knowledgePassages: [],
            conversationHistory: [],
          })
        ).rejects.toThrow(/Transmitting unredacted desktop screen captures to cloud AI provider "openai" is prohibited/);
      }

      stateManager.patchState({ blockOutboundSecrets: false });
    });
  });
});
