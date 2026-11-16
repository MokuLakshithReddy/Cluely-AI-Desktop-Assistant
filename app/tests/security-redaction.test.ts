import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import {
  redactSensitiveText,
  containsSensitiveData,
  detectSensitiveData,
  inspectAndSanitizeOutboundPayload,
  sanitizeScreenshot,
  getPngDimensions,
  detectSensitiveScreenRegions,
  wipeBuffer,
  paethPredictor,
  unfilterPngScanlines,
  scanImageForSecrets,
} from '../src/lib/redaction';
import { validateNetworkEndpoint } from '../src/lib/providers';
import {
  encryptLocalSession,
  decryptLocalSession,
  SessionRecord,
  SessionRepository,
} from '../electron/services/session-repository';
import {
  isSecureStorageBackendAvailable,
  isAsyncSafeStorageAvailable,
  initStorageEncryptionAsync,
  getMasterEncryptionKey,
  setMasterEncryptionKey,
} from '../electron/services/storage-encryption';
import { IpcRouter } from '../electron/domains/ipc-router';
import { stateManager } from '../electron/domains/state';

function createSyntheticPng(
  width: number,
  height: number,
  fillColor = { r: 180, g: 180, b: 180, a: 255 },
  filterType: number = 0,
  textChunk?: { keyword: string; text: string }
): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // RGBA
  ihdrData[10] = 0; // deflate
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // non-interlaced

  const makeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const bpp = 4;
  const rowBytes = width * bpp;
  const rawImage = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * bpp;
      rawImage[px] = fillColor.r;
      rawImage[px + 1] = fillColor.g;
      rawImage[px + 2] = fillColor.b;
      rawImage[px + 3] = fillColor.a;
    }
  }

  const filteredScanlines = Buffer.alloc(height * (1 + rowBytes));
  for (let y = 0; y < height; y++) {
    const filtRowOffset = y * (1 + rowBytes);
    filteredScanlines[filtRowOffset] = filterType;
    const rawRowOffset = y * rowBytes;
    const prevRawRowOffset = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const orig = rawImage[rawRowOffset + x];
      const a = x >= bpp ? rawImage[rawRowOffset + x - bpp] : 0;
      const b = y > 0 ? rawImage[prevRawRowOffset + x] : 0;
      const c = (y > 0 && x >= bpp) ? rawImage[prevRawRowOffset + x - bpp] : 0;

      let filtByte = orig;
      switch (filterType) {
        case 0:
          filtByte = orig;
          break;
        case 1:
          filtByte = (orig - a) & 0xff;
          break;
        case 2:
          filtByte = (orig - b) & 0xff;
          break;
        case 3:
          filtByte = (orig - Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4:
          filtByte = (orig - paethPredictor(a, b, c)) & 0xff;
          break;
      }
      filteredScanlines[filtRowOffset + 1 + x] = filtByte;
    }
  }

  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const chunks: Buffer[] = [sig, ihdrChunk];

  if (textChunk) {
    const keyBuf = Buffer.from(textChunk.keyword, 'latin1');
    const valBuf = Buffer.from(textChunk.text, 'latin1');
    const textData = Buffer.concat([keyBuf, Buffer.from([0]), valBuf]);
    chunks.push(makeChunk('tEXt', textData));
  }

  const idatChunk = makeChunk('IDAT', zlib.deflateSync(filteredScanlines));
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));
  chunks.push(idatChunk, iendChunk);
  return Buffer.concat(chunks);
}

function extractPngScanlines(pngBuf: Buffer): { width: number; height: number; scanlines: Buffer } {
  const width = pngBuf.readUInt32BE(16);
  const height = pngBuf.readUInt32BE(20);
  let pos = 8;
  const idatParts: Buffer[] = [];
  while (pos + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(pos);
    const type = pngBuf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idatParts.push(pngBuf.slice(pos + 8, pos + 8 + len));
    pos += 8 + len + 4;
  }
  const scanlines = zlib.inflateSync(Buffer.concat(idatParts));
  return { width, height, scanlines };
}

function extractPngRawPixels(pngBuf: Buffer): { width: number; height: number; rawPixels: Buffer } {
  const { width, height, scanlines } = extractPngScanlines(pngBuf);
  const bpp = Math.round((scanlines.length / height - 1) / width);
  const rawPixels = unfilterPngScanlines(scanlines, width, height, bpp);
  return { width, height, rawPixels };
}

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
      const text = 'Your verification code is 849201 for Scandium';
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('mfa_code');
      expect(result.sanitized).toContain('[REDACTED_MFA_CODE]');
      expect(result.sanitized).not.toContain('849201');
    });

    it('redacts Social Security Numbers (SSN)', () => {
      const text = 'Applicant SSN: 123-45-6789 on the document';
      const result = redactSensitiveText(text);
      expect(result.redactedCount).toBe(1);
      expect(result.categories).toContain('ssn');
      expect(result.sanitized).toContain('[REDACTED_SSN]');
      expect(result.sanitized).not.toContain('123-45-6789');
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

    it('parses actual dimensions and masks coordinates dynamically for landscape and portrait images', async () => {
      // Landscape 100x60
      const landscapePng = createSyntheticPng(100, 60, { r: 180, g: 180, b: 180, a: 255 });
      const landscapeDim = getPngDimensions(landscapePng);
      expect(landscapeDim).toEqual({ width: 100, height: 60 });

      const landscapeRegions = detectSensitiveScreenRegions(100, 60);
      expect(landscapeRegions.length).toBe(2);
      expect(landscapeRegions[0].width).toBe(100);
      expect(landscapeRegions[1].width).toBe(100);
      expect(landscapeRegions[0].y).toBeGreaterThan(0); // Taskbar at bottom
      expect(landscapeRegions[1].y).toBe(0); // Titlebar at top

      const landscapeResult = await sanitizeScreenshot(landscapePng);
      expect(landscapeResult.isRedacted).toBe(true);
      expect(landscapeResult.redactedRegionsCount).toBe(2);

      // Portrait 60x120
      const portraitPng = createSyntheticPng(60, 120, { r: 200, g: 200, b: 200, a: 255 });
      const portraitDim = getPngDimensions(portraitPng);
      expect(portraitDim).toEqual({ width: 60, height: 120 });

      const portraitRegions = detectSensitiveScreenRegions(60, 120);
      expect(portraitRegions.length).toBe(2);
      expect(portraitRegions[0].width).toBe(60);
      expect(portraitRegions[0].y).toBe(120 - portraitRegions[0].height);

      const portraitResult = await sanitizeScreenshot(portraitPng);
      expect(portraitResult.isRedacted).toBe(true);
      expect(portraitResult.redactedRegionsCount).toBe(2);
    });

    it('genuinely masks target pixels to solid black while preserving unmasked pixel values', async () => {
      const originalPng = createSyntheticPng(40, 40, { r: 180, g: 180, b: 180, a: 255 });
      const customRegion = { x: 5, y: 5, width: 10, height: 10, label: 'custom_secret_box' };

      const result = await sanitizeScreenshot(originalPng, [customRegion]);
      expect(result.isRedacted).toBe(true);
      expect(result.sanitizedBuffer).toBeDefined();

      const { width, height, scanlines } = extractPngScanlines(result.sanitizedBuffer);
      expect(width).toBe(40);
      expect(height).toBe(40);

      const bpp = 4;
      const stride = 1 + width * bpp;

      // Inside masked region: (7, 7) must be solid black (0, 0, 0, 255)
      const maskedPxOffset = 7 * stride + 1 + 7 * bpp;
      expect(scanlines[maskedPxOffset]).toBe(0);     // R
      expect(scanlines[maskedPxOffset + 1]).toBe(0); // G
      expect(scanlines[maskedPxOffset + 2]).toBe(0); // B
      expect(scanlines[maskedPxOffset + 3]).toBe(255); // A

      // Outside masked region: (30, 30) must retain original color (180, 180, 180, 255)
      const unmaskedPxOffset = 30 * stride + 1 + 30 * bpp;
      expect(scanlines[unmaskedPxOffset]).toBe(180);     // R
      expect(scanlines[unmaskedPxOffset + 1]).toBe(180); // G
      expect(scanlines[unmaskedPxOffset + 2]).toBe(180); // B
      expect(scanlines[unmaskedPxOffset + 3]).toBe(255); // A
    });

    it('fails closed when image buffer is corrupted, empty, or truncated', async () => {
      const emptyResult = await sanitizeScreenshot(Buffer.alloc(0));
      expect(emptyResult.isRedacted).toBe(false);
      expect(emptyResult.notes).toContain('Empty or invalid');

      const truncatedBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
      const truncResult = await sanitizeScreenshot(truncatedBuf);
      expect(truncResult.isRedacted).toBe(false);

      const corruptedPng = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('not-a-valid-ihdr-chunk-data-stream-here'),
      ]);
      const corruptResult = await sanitizeScreenshot(corruptedPng);
      expect(corruptResult.isRedacted).toBe(false);
    });

    it('correctly un-filters and masks PNG scanlines across Sub, Up, Average, and Paeth filter types', async () => {
      // Test filter types 1 (Sub), 2 (Up), 3 (Average), 4 (Paeth)
      for (const filterType of [1, 2, 3, 4]) {
        const testColor = { r: 120 + filterType * 10, g: 140, b: 160, a: 255 };
        const filteredPng = createSyntheticPng(30, 30, testColor, filterType);

        // Verify unfiltering correctly reconstructs the raw pixels
        const { rawPixels } = extractPngRawPixels(filteredPng);
        expect(rawPixels[0]).toBe(testColor.r);
        expect(rawPixels[1]).toBe(testColor.g);
        expect(rawPixels[2]).toBe(testColor.b);
        expect(rawPixels[3]).toBe(testColor.a);

        // Sanitize with custom region
        const customRegion = { x: 5, y: 5, width: 8, height: 8, label: `filter_${filterType}_region` };
        const result = await sanitizeScreenshot(filteredPng, [customRegion]);
        expect(result.isRedacted).toBe(true);

        const { rawPixels: maskedRaw } = extractPngRawPixels(result.sanitizedBuffer);
        const bpp = 4;
        const width = 30;

        // Masked coordinate (6, 6) must be solid black (0, 0, 0, 255)
        const maskedOffset = (6 * width + 6) * bpp;
        expect(maskedRaw[maskedOffset]).toBe(0);
        expect(maskedRaw[maskedOffset + 1]).toBe(0);
        expect(maskedRaw[maskedOffset + 2]).toBe(0);
        expect(maskedRaw[maskedOffset + 3]).toBe(255);

        // Unmasked coordinate (20, 20) must retain exact original color
        const unmaskedOffset = (20 * width + 20) * bpp;
        expect(maskedRaw[unmaskedOffset]).toBe(testColor.r);
        expect(maskedRaw[unmaskedOffset + 1]).toBe(testColor.g);
        expect(maskedRaw[unmaskedOffset + 2]).toBe(testColor.b);
        expect(maskedRaw[unmaskedOffset + 3]).toBe(testColor.a);
      }
    });

    it('scans screenshots for arbitrary secrets and automatically masks the workspace region', async () => {
      const mockKey = ['sk', '1234567890abcdef1234567890abcdef'].join('-');
      const secretPng = createSyntheticPng(
        50,
        50,
        { r: 200, g: 200, b: 200, a: 255 },
        0,
        { keyword: 'Description', text: `Active Terminal Secret: ${mockKey}` }
      );

      // Verify secret scanner identifies the token in image text metadata
      const scanResult = scanImageForSecrets(secretPng);
      expect(scanResult.hasSecrets).toBe(true);
      expect(scanResult.categories).toContain('openai_api_key');

      // Sanitize automatically detects the arbitrary secret and masks the center workspace region
      const sanitized = await sanitizeScreenshot(secretPng);
      expect(sanitized.isRedacted).toBe(true);
      expect(sanitized.redactedRegionsCount).toBeGreaterThanOrEqual(3); // titlebar, taskbar, + arbitrary secret workspace

      // Verify the center workspace pixel (25, 25) is masked to solid black
      const { rawPixels } = extractPngRawPixels(sanitized.sanitizedBuffer);
      const bpp = 4;
      const centerOffset = (25 * 50 + 25) * bpp;
      expect(rawPixels[centerOffset]).toBe(0);
      expect(rawPixels[centerOffset + 1]).toBe(0);
      expect(rawPixels[centerOffset + 2]).toBe(0);
      expect(rawPixels[centerOffset + 3]).toBe(255);
    });

    it('inspectAndSanitizeOutboundPayload inspects screenshotBase64 and blocks or drops credentials', () => {
      const mockKey = ['sk', 'outbound-block-token-secret-1234567890'].join('-');
      const secretPng = createSyntheticPng(
        30,
        30,
        { r: 180, g: 180, b: 180, a: 255 },
        0,
        { keyword: 'Comment', text: `Captured API Key: ${mockKey}` }
      );
      const base64Data = `data:image/png;base64,${secretPng.toString('base64')}`;

      // 1. When blockOnSecrets is true: blocks outbound request
      const blockResult = inspectAndSanitizeOutboundPayload(
        { query: 'Please analyze my screen', screenshotBase64: base64Data },
        { blockOnSecrets: true }
      );
      expect(blockResult.blocked).toBe(true);
      expect(blockResult.reason).toMatch(/sensitive credentials detected/);
      expect(blockResult.detections).toContain('OpenAI API Key');

      // 2. When blockOnSecrets is false: drops unredacted image containing secret under fail-closed sanitization
      const scrubResult = inspectAndSanitizeOutboundPayload(
        { query: 'Please analyze my screen', screenshotBase64: base64Data },
        { blockOnSecrets: false }
      );
      expect(scrubResult.blocked).toBe(false);
      expect(scrubResult.sanitizedPayload.screenshotBase64).toBeUndefined();
      expect(scrubResult.scrubbedCount).toBeGreaterThan(0);
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

    it('actively migrates all legacy unencrypted plaintext session archives on disk via migrateAllLegacySessions()', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-migrate-all-'));
      try {
        const repo = new SessionRepository(tempDir);
        repo.setEncryptionKey(testKey);

        const legacySession1 = { ...mockSession, id: 'sess_legacy_001', title: 'Legacy Meeting 1' };
        const legacySession2 = { ...mockSession, id: 'sess_legacy_002', title: 'Legacy Meeting 2' };

        fs.writeFileSync(path.join(tempDir, 'sess_legacy_001.json'), JSON.stringify(legacySession1), 'utf8');
        fs.writeFileSync(path.join(tempDir, 'sess_legacy_002.json'), JSON.stringify(legacySession2), 'utf8');

        expect(fs.readFileSync(path.join(tempDir, 'sess_legacy_001.json'), 'utf8').startsWith('{')).toBe(true);

        const result = await repo.migrateAllLegacySessions();
        expect(result.total).toBe(2);
        expect(result.migrated).toBe(2);

        const file1Content = fs.readFileSync(path.join(tempDir, 'sess_legacy_001.json'), 'utf8');
        const file2Content = fs.readFileSync(path.join(tempDir, 'sess_legacy_002.json'), 'utf8');
        expect(file1Content.startsWith('enc:v1:')).toBe(true);
        expect(file2Content.startsWith('enc:v1:')).toBe(true);

        const readSession = await repo.getSession('sess_legacy_001');
        expect(readSession?.title).toBe('Legacy Meeting 1');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('guarantees encrypted rewrite when accessing legacy session file and fails closed if write fails', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluely-migrate-access-'));
      try {
        const repo = new SessionRepository(tempDir);
        repo.setEncryptionKey(testKey);

        const legacySession = { ...mockSession, id: 'sess_legacy_access', title: 'Access Migration Test' };
        const filePath = path.join(tempDir, 'sess_legacy_access.json');
        fs.writeFileSync(filePath, JSON.stringify(legacySession), 'utf8');

        const session = await repo.getSession('sess_legacy_access');
        expect(session?.title).toBe('Access Migration Test');

        const onDisk = fs.readFileSync(filePath, 'utf8');
        expect(onDisk.startsWith('enc:v1:')).toBe(true);

        const readOnlySession = { ...mockSession, id: 'sess_readonly_legacy', title: 'Fail Closed Test' };
        const roFilePath = path.join(tempDir, 'sess_readonly_legacy.json');
        fs.writeFileSync(roFilePath, JSON.stringify(readOnlySession), 'utf8');

        const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
          throw new Error('EACCES: permission denied');
        });

        await expect(repo.getSession('sess_readonly_legacy')).rejects.toThrow(
          /Fail-closed: Migration of legacy plaintext session "sess_readonly_legacy" to encrypted storage failed/
        );
        expect(repo.isRepositoryLocked()).toBe(true);

        writeSpy.mockRestore();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('enforces Linux backend allowlist and rejects insecure basic_text', () => {
      expect(isSecureStorageBackendAvailable('linux', true, 'gnome_libsecret')).toBe(true);
      expect(isSecureStorageBackendAvailable('linux', true, 'kwallet')).toBe(true);
      expect(isSecureStorageBackendAvailable('linux', true, 'kwallet5')).toBe(true);
      expect(isSecureStorageBackendAvailable('linux', true, 'kwallet6')).toBe(true);
      expect(isSecureStorageBackendAvailable('linux', true, 'basic_text')).toBe(false);
      expect(isSecureStorageBackendAvailable('linux', true, null)).toBe(false);
      expect(isSecureStorageBackendAvailable('linux', false, 'gnome_libsecret')).toBe(false);
      expect(isSecureStorageBackendAvailable('win32', true)).toBe(true);
      expect(isSecureStorageBackendAvailable('darwin', true)).toBe(true);
    });

    it('fails closed in production if secure OS-backed storage is unavailable', () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origVitest = process.env.VITEST;
      const origTest = process.env.TEST;
      const origSessionKey = process.env.SESSION_ENCRYPTION_KEY;

      try {
        setMasterEncryptionKey(null);
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;
        delete process.env.TEST;
        delete process.env.SESSION_ENCRYPTION_KEY;

        expect(() => getMasterEncryptionKey()).toThrow(
          /Secure OS-backed storage is unavailable/
        );
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origVitest !== undefined) process.env.VITEST = origVitest;
        if (origTest !== undefined) process.env.TEST = origTest;
        if (origSessionKey !== undefined) process.env.SESSION_ENCRYPTION_KEY = origSessionKey;
        setMasterEncryptionKey(null);
      }
    });

    it('strictly rejects test key fallback in production even if TEST or SESSION_ENCRYPTION_KEY is set', () => {
      const origNodeEnv = process.env.NODE_ENV;
      const origVitest = process.env.VITEST;
      const origTest = process.env.TEST;
      const origSessionKey = process.env.SESSION_ENCRYPTION_KEY;

      try {
        setMasterEncryptionKey(null);
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;
        process.env.TEST = '1';
        process.env.SESSION_ENCRYPTION_KEY = 'insecure-test-attempt';

        expect(() => getMasterEncryptionKey()).toThrow(
          /Secure OS-backed storage is unavailable/
        );
      } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origVitest !== undefined) process.env.VITEST = origVitest;
        if (origTest !== undefined) process.env.TEST = origTest;
        else delete process.env.TEST;
        if (origSessionKey !== undefined) process.env.SESSION_ENCRYPTION_KEY = origSessionKey;
        else delete process.env.SESSION_ENCRYPTION_KEY;
        setMasterEncryptionKey(null);
      }
    });

    it('strictly rejects test key fallback and custom keys when app.isPackaged is true', () => {
      const origPackaged = (app as any).isPackaged;
      try {
        setMasterEncryptionKey(null);
        (app as any).isPackaged = true;

        // Even with test environment flags set, packaged mode must strictly fail closed
        expect(() => getMasterEncryptionKey()).toThrow(
          /Packaged application persistence requires a supported hardware\/OS key store/
        );

        // Attempting to inject a custom test key in packaged app must throw
        expect(() => setMasterEncryptionKey(Buffer.alloc(32, 1))).toThrow(
          /Cannot inject arbitrary master keys in a packaged production application/
        );
      } finally {
        (app as any).isPackaged = origPackaged;
        setMasterEncryptionKey(null);
      }
    });

    it('asynchronously initializes master key via initStorageEncryptionAsync and strictly fails closed in packaged mode', async () => {
      const origPackaged = (app as any).isPackaged;
      try {
        setMasterEncryptionKey(null);
        // In test runner mode, initStorageEncryptionAsync should resolve 32-byte key
        const key = await initStorageEncryptionAsync();
        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);

        // When packaged, initStorageEncryptionAsync must fail closed if secure storage is unavailable
        setMasterEncryptionKey(null);
        (app as any).isPackaged = true;
        await expect(initStorageEncryptionAsync()).rejects.toThrow(
          /Packaged application persistence requires a supported hardware\/OS key store/
        );
      } finally {
        (app as any).isPackaged = origPackaged;
        setMasterEncryptionKey(null);
      }
    });

    it('checks async safe storage availability across platforms', async () => {
      const avail = await isAsyncSafeStorageAvailable();
      expect(typeof avail).toBe('boolean');
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

    it('blocks cloud screenshot transmission fail-closed when redactSensitiveData is active', async () => {
      stateManager.patchState({ redactSensitiveData: true, blockOutboundSecrets: false });

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
        ).rejects.toThrow(/Cloud screenshot transmission blocked: Sensitive-Content Redaction is enabled/);
      }
    });

    it('blocks unredacted screenshots to external cloud providers when blockOutboundSecrets is active', async () => {
      stateManager.patchState({ redactSensitiveData: false, blockOutboundSecrets: true });

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

      stateManager.patchState({ redactSensitiveData: true, blockOutboundSecrets: false });
    });

    it('permits local screenshot processing on-device when provider is local ollama', async () => {
      stateManager.patchState({ redactSensitiveData: true, blockOutboundSecrets: true });

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
            providerName: 'ollama',
            model: 'ollama:llama3',
            mode: 'copilot',
            query: 'Analyze local screen',
            screenshotBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            recentTranscript: [],
            knowledgePassages: [],
            conversationHistory: [],
          })
        ).rejects.not.toThrow(/Outbound Security Guard/);
      }

      stateManager.patchState({ redactSensitiveData: true, blockOutboundSecrets: false });
    });
  });
});
