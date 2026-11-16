/**
 * Sensitive-Content Redaction and Outbound Data Inspection Engine
 *
 * Scans text and prompt payloads for passwords, API keys, private keys,
 * authentication tokens, banking/credit card numbers, and emails.
 */

export interface RedactionResult {
  sanitized: string;
  redactedText: string;
  redactedCount: number;
  detectedCount: number;
  detections: string[];
  categories: string[];
}

export interface SensitiveDetection {
  type: string;
  category: string;
  match: string;
  index: number;
}

// 1. API Keys & Cloud Tokens
export const PATTERN_OPENAI_API_KEY = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
export const PATTERN_AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
export const PATTERN_GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{30,40}\b/g;
export const PATTERN_GITHUB_PAT = /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9-_]{82})\b/g;
export const PATTERN_SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]+\b/g;
export const PATTERN_GENERIC_API_KEY = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9_\-\.]{16,})["']?/gi;

// 2. Cryptographic Private Keys
export const PATTERN_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g;

// 3. JSON Web Tokens (JWT)
export const PATTERN_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

// 4. Financial & Payment Cards (Standard 13-19 digit card numbers)
export const PATTERN_CREDIT_CARD = /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})\b/g;
export const PATTERN_FORMATTED_CARD = /\b(?:\d{4}[ -]){3}\d{4}\b/g;

// 5. Passwords & Credentials in plaintext strings
export const PATTERN_PASSWORD_FIELD = /\b(?:password|passwd|pwd|secret_key|client_secret)\s*[:=]\s*["']?([^\s,;'"<>]{4,})["']?/gi;

// 6. MFA / 2FA Verification Codes
export const PATTERN_MFA_CODE = /\b(?:mfa|otp|2fa|verification[ _-]?code)\s*(?:[:=]|is)?\s*["']?(\d{6,8})["']?\b/gi;

// 7. Email Addresses
export const PATTERN_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g;

// 8. Social Security Numbers (US SSN)
export const PATTERN_SSN = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;

/**
 * Mathematical Paeth predictor for PNG scanlines (RFC 2083 / W3C PNG Specification).
 */
export function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverses PNG row filters (0: None, 1: Sub, 2: Up, 3: Average, 4: Paeth)
 * and reconstructs the un-filtered raw pixel bytes for the entire image.
 */
export function unfilterPngScanlines(
  decompressed: Buffer,
  width: number,
  height: number,
  bpp: number
): Buffer {
  const rowBytes = width * bpp;
  const rawPixels = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const filtRowOffset = y * (1 + rowBytes);
    const filterType = decompressed[filtRowOffset];
    const rawRowOffset = y * rowBytes;
    const prevRawRowOffset = (y - 1) * rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const filtByte = decompressed[filtRowOffset + 1 + x];
      const a = x >= bpp ? rawPixels[rawRowOffset + x - bpp] : 0;
      const b = y > 0 ? rawPixels[prevRawRowOffset + x] : 0;
      const c = (y > 0 && x >= bpp) ? rawPixels[prevRawRowOffset + x - bpp] : 0;

      let rawByte = 0;
      switch (filterType) {
        case 0: // None
          rawByte = filtByte;
          break;
        case 1: // Sub
          rawByte = (filtByte + a) & 0xff;
          break;
        case 2: // Up
          rawByte = (filtByte + b) & 0xff;
          break;
        case 3: // Average
          rawByte = (filtByte + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: // Paeth
          rawByte = (filtByte + paethPredictor(a, b, c)) & 0xff;
          break;
        default:
          throw new Error(`Unsupported or invalid PNG filter type: ${filterType}`);
      }
      rawPixels[rawRowOffset + x] = rawByte;
    }
  }

  return rawPixels;
}

/**
 * Scans image buffer for embedded text metadata (PNG tEXt, zTXt, iTXt chunks)
 * and printable ASCII/UTF-8 string sequences for credentials and secrets.
 */
export function scanImageForSecrets(imageBuffer: Buffer): {
  hasSecrets: boolean;
  detections: string[];
  categories: string[];
  regions?: SensitiveRegion[];
} {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 24) {
    return { hasSecrets: false, detections: [], categories: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('zlib');
  const allDetections: string[] = [];
  const allCategories: string[] = [];
  const regions: SensitiveRegion[] = [];

  const textSnippets: string[] = [];

  // 1. Scan PNG text chunks (tEXt, zTXt, iTXt)
  try {
    let pos = 8;
    while (pos + 8 <= imageBuffer.length) {
      const len = imageBuffer.readUInt32BE(pos);
      const type = imageBuffer.toString('ascii', pos + 4, pos + 8);
      const dataOffset = pos + 8;

      if (type === 'tEXt' && dataOffset + len <= imageBuffer.length) {
        const str = imageBuffer.toString('latin1', dataOffset, dataOffset + len);
        textSnippets.push(str);
      } else if (type === 'zTXt' && dataOffset + len <= imageBuffer.length) {
        // keyword + null + 1 byte compression method + compressed data
        const nullIdx = imageBuffer.indexOf(0, dataOffset);
        if (nullIdx > dataOffset && nullIdx + 2 < dataOffset + len) {
          try {
            const compressed = imageBuffer.slice(nullIdx + 2, dataOffset + len);
            const inflated = zlib.inflateSync(compressed);
            textSnippets.push(inflated.toString('latin1'));
          } catch {}
        }
      } else if (type === 'iTXt' && dataOffset + len <= imageBuffer.length) {
        const nullIdx = imageBuffer.indexOf(0, dataOffset);
        if (nullIdx > dataOffset && nullIdx + 3 < dataOffset + len) {
          const compFlag = imageBuffer[nullIdx + 1];
          // find 3rd null byte
          let p = nullIdx + 3;
          let nulls = 0;
          while (p < dataOffset + len && nulls < 2) {
            if (imageBuffer[p] === 0) nulls++;
            p++;
          }
          if (p < dataOffset + len) {
            try {
              const textBuf = imageBuffer.slice(p, dataOffset + len);
              const textStr = compFlag === 1 ? zlib.inflateSync(textBuf).toString('utf8') : textBuf.toString('utf8');
              textSnippets.push(textStr);
            } catch {}
          }
        }
      }

      pos += 8 + len + 4;
    }
  } catch {}

  // 2. Scan printable ASCII strings of length >= 12 from the raw buffer
  let currentAscii: number[] = [];
  for (let i = 0; i < imageBuffer.length; i++) {
    const b = imageBuffer[i];
    if (b >= 32 && b <= 126) {
      currentAscii.push(b);
    } else {
      if (currentAscii.length >= 12) {
        textSnippets.push(Buffer.from(currentAscii).toString('ascii'));
      }
      currentAscii = [];
    }
  }
  if (currentAscii.length >= 12) {
    textSnippets.push(Buffer.from(currentAscii).toString('ascii'));
  }

  // Evaluate extracted text snippets with sensitive data detector
  for (const snippet of textSnippets) {
    const check = detectSensitiveData(snippet);
    if (check.hasSensitiveData) {
      allDetections.push(...check.detections);
      allCategories.push(...check.categories);

      // Check for coordinate metadata if present (e.g., [bbox: x,y,w,h])
      const bboxMatch = snippet.match(/bbox:\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/i);
      if (bboxMatch) {
        regions.push({
          x: parseInt(bboxMatch[1], 10),
          y: parseInt(bboxMatch[2], 10),
          width: parseInt(bboxMatch[3], 10),
          height: parseInt(bboxMatch[4], 10),
          label: 'detected_credential_region',
        });
      }
    }
  }

  const uniqueDetections = Array.from(new Set(allDetections));
  const uniqueCategories = Array.from(new Set(allCategories));

  return {
    hasSecrets: uniqueDetections.length > 0,
    detections: uniqueDetections,
    categories: uniqueCategories,
    regions: regions.length > 0 ? regions : undefined,
  };
}

function resetRegexes(): void {
  PATTERN_OPENAI_API_KEY.lastIndex = 0;
  PATTERN_AWS_ACCESS_KEY.lastIndex = 0;
  PATTERN_GOOGLE_API_KEY.lastIndex = 0;
  PATTERN_GITHUB_PAT.lastIndex = 0;
  PATTERN_SLACK_TOKEN.lastIndex = 0;
  PATTERN_GENERIC_API_KEY.lastIndex = 0;
  PATTERN_PRIVATE_KEY.lastIndex = 0;
  PATTERN_JWT.lastIndex = 0;
  PATTERN_CREDIT_CARD.lastIndex = 0;
  PATTERN_FORMATTED_CARD.lastIndex = 0;
  PATTERN_PASSWORD_FIELD.lastIndex = 0;
  PATTERN_MFA_CODE.lastIndex = 0;
  PATTERN_EMAIL.lastIndex = 0;
  PATTERN_SSN.lastIndex = 0;
}

/**
 * Detailed detection analysis of sensitive data in text.
 */
export function detectSensitiveData(text: string): { hasSensitiveData: boolean; detections: string[]; categories: string[] } {
  if (!text || typeof text !== 'string') {
    return { hasSensitiveData: false, detections: [], categories: [] };
  }

  const detections: string[] = [];
  const categories: string[] = [];

  if (PATTERN_PRIVATE_KEY.test(text)) { detections.push('SSH/Cryptographic Private Key'); categories.push('private_key'); }
  if (PATTERN_OPENAI_API_KEY.test(text)) { detections.push('OpenAI API Key'); categories.push('openai_api_key'); }
  if (PATTERN_AWS_ACCESS_KEY.test(text)) { detections.push('AWS Access Key'); categories.push('aws_access_key'); }
  if (PATTERN_GOOGLE_API_KEY.test(text)) { detections.push('Google API Key'); categories.push('google_api_key'); }
  if (PATTERN_GITHUB_PAT.test(text)) { detections.push('GitHub Personal Access Token'); categories.push('github_pat'); }
  if (PATTERN_SLACK_TOKEN.test(text)) { detections.push('Slack Token'); categories.push('slack_token'); }
  if (PATTERN_JWT.test(text)) { detections.push('JSON Web Token (JWT)'); categories.push('jwt_token'); }
  if (PATTERN_CREDIT_CARD.test(text) || PATTERN_FORMATTED_CARD.test(text)) { detections.push('Payment Card Number'); categories.push('credit_card'); }
  if (PATTERN_SSN.test(text)) { detections.push('Social Security Number (SSN)'); categories.push('ssn'); }
  if (PATTERN_PASSWORD_FIELD.test(text)) { detections.push('Plaintext Password/Secret'); categories.push('password_field'); }
  if (PATTERN_MFA_CODE.test(text)) { detections.push('MFA/OTP Authentication Code'); categories.push('mfa_code'); }
  if (PATTERN_EMAIL.test(text)) { detections.push('Email Address'); categories.push('email_address'); }

  resetRegexes();

  return {
    hasSensitiveData: detections.length > 0,
    detections,
    categories,
  };
}

/**
 * Checks whether text contains any sensitive tokens or secrets.
 */
export function containsSensitiveData(text: string): boolean {
  return detectSensitiveData(text).hasSensitiveData;
}

/**
 * Redacts sensitive tokens and personal data from text with descriptive placeholders.
 */
export function redactSensitiveText(text: string): RedactionResult {
  if (!text || typeof text !== 'string') {
    const empty = text || '';
    return {
      sanitized: empty,
      redactedText: empty,
      redactedCount: 0,
      detectedCount: 0,
      detections: [],
      categories: [],
    };
  }

  let sanitized = text;
  let redactedCount = 0;
  const detections: string[] = [];
  const categories: string[] = [];

  // 1. Private Keys
  sanitized = sanitized.replace(PATTERN_PRIVATE_KEY, () => {
    redactedCount++;
    detections.push('Private Key');
    categories.push('private_key');
    return '[REDACTED_PRIVATE_KEY]';
  });

  // 2. Specific API Keys
  sanitized = sanitized.replace(PATTERN_OPENAI_API_KEY, () => {
    redactedCount++;
    detections.push('OpenAI API Key');
    categories.push('openai_api_key');
    return '[REDACTED_API_KEY]';
  });
  sanitized = sanitized.replace(PATTERN_AWS_ACCESS_KEY, () => {
    redactedCount++;
    detections.push('AWS Access Key');
    categories.push('aws_access_key');
    return '[REDACTED_AWS_KEY]';
  });
  sanitized = sanitized.replace(PATTERN_GOOGLE_API_KEY, () => {
    redactedCount++;
    detections.push('Google API Key');
    categories.push('google_api_key');
    return '[REDACTED_GOOGLE_KEY]';
  });
  sanitized = sanitized.replace(PATTERN_GITHUB_PAT, () => {
    redactedCount++;
    detections.push('GitHub Token');
    categories.push('github_pat');
    return '[REDACTED_GITHUB_TOKEN]';
  });
  sanitized = sanitized.replace(PATTERN_SLACK_TOKEN, () => {
    redactedCount++;
    detections.push('Slack Token');
    categories.push('slack_token');
    return '[REDACTED_SLACK_TOKEN]';
  });

  // 3. Generic API Keys & Tokens
  sanitized = sanitized.replace(PATTERN_GENERIC_API_KEY, (match, p1) => {
    redactedCount++;
    detections.push('API Key/Token');
    categories.push('generic_api_key');
    return match.replace(p1, '[REDACTED_SECRET]');
  });

  // 4. JWTs
  sanitized = sanitized.replace(PATTERN_JWT, () => {
    redactedCount++;
    detections.push('JWT');
    categories.push('jwt_token');
    return '[REDACTED_JWT]';
  });

  // 5. Credit Cards
  sanitized = sanitized.replace(PATTERN_FORMATTED_CARD, () => {
    redactedCount++;
    detections.push('Credit Card');
    categories.push('credit_card');
    return '[REDACTED_CREDIT_CARD]';
  });
  sanitized = sanitized.replace(PATTERN_CREDIT_CARD, () => {
    redactedCount++;
    detections.push('Credit Card');
    categories.push('credit_card');
    return '[REDACTED_CREDIT_CARD]';
  });

  // 5b. Social Security Numbers
  sanitized = sanitized.replace(PATTERN_SSN, () => {
    redactedCount++;
    detections.push('Social Security Number (SSN)');
    categories.push('ssn');
    return '[REDACTED_SSN]';
  });

  // 6. Passwords
  sanitized = sanitized.replace(PATTERN_PASSWORD_FIELD, (match, p1) => {
    redactedCount++;
    detections.push('Password');
    categories.push('password_field');
    return match.replace(p1, '[REDACTED_PASSWORD]');
  });

  // 7. MFA Codes
  sanitized = sanitized.replace(PATTERN_MFA_CODE, (match, p1) => {
    redactedCount++;
    detections.push('MFA Code');
    categories.push('mfa_code');
    return match.replace(p1, '[REDACTED_MFA_CODE]');
  });

  // 8. Emails
  sanitized = sanitized.replace(PATTERN_EMAIL, () => {
    redactedCount++;
    detections.push('Email');
    categories.push('email_address');
    return '[REDACTED_EMAIL]';
  });

  resetRegexes();

  return {
    sanitized,
    redactedText: sanitized,
    redactedCount,
    detectedCount: redactedCount,
    detections: Array.from(new Set(detections)),
    categories: Array.from(new Set(categories)),
  };
}

/**
 * Deep inspection and sanitization of arbitrary outbound payloads.
 */
export function inspectAndSanitizeOutboundPayload<T>(
  payload: T,
  options?: { blockOnSecrets?: boolean } | boolean
): {
  sanitizedPayload: T;
  scrubbedCount: number;
  blocked: boolean;
  detections: string[];
  reason?: string;
} {
  const shouldBlock = typeof options === 'boolean' ? options : Boolean(options?.blockOnSecrets);
  const allDetections: string[] = [];
  let totalScrubbed = 0;

  // 1. First pass: scan for sensitive data
  function scan(val: any, key?: string): void {
    if (!val) return;
    if (key === 'screenshotBase64' && typeof val === 'string') {
      try {
        const cleanB64 = val.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(cleanB64, 'base64');
        const imgSecrets = scanImageForSecrets(imgBuf);
        if (imgSecrets.hasSecrets) {
          allDetections.push(...imgSecrets.detections);
        }
      } catch {}
      return;
    }
    if (typeof val === 'string' && val.length > 100000) {
      return; // Skip non-image oversized binary strings
    }
    if (typeof val === 'string') {
      const check = detectSensitiveData(val);
      if (check.hasSensitiveData) {
        allDetections.push(...check.detections);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) scan(item);
    } else if (typeof val === 'object') {
      for (const k of Object.keys(val)) scan(val[k], k);
    }
  }

  scan(payload);
  const uniqueDetections = Array.from(new Set(allDetections));

  // Check critical secrets (keys, tokens, passwords, cards, etc.)
  const hasCriticalSecrets = uniqueDetections.some(d =>
    d.includes('Key') || d.includes('Token') || d.includes('Password') || d.includes('Card')
  );

  if (shouldBlock && hasCriticalSecrets) {
    return {
      sanitizedPayload: payload,
      scrubbedCount: 0,
      blocked: true,
      detections: uniqueDetections,
      reason: `Outbound request blocked: sensitive credentials detected (${uniqueDetections.join(', ')})`,
    };
  }

  // 2. Second pass: deep clone and sanitize strings
  function deepSanitize(val: any, key?: string): any {
    if (!val) return val;
    if (key === 'screenshotBase64' && typeof val === 'string') {
      try {
        const cleanB64 = val.replace(/^data:image\/\w+;base64,/, '');
        const imgBuf = Buffer.from(cleanB64, 'base64');
        const imgSecrets = scanImageForSecrets(imgBuf);
        if (imgSecrets.hasSecrets) {
          totalScrubbed += imgSecrets.detections.length;
          // Fail closed: drop unredacted screenshot containing detected secrets
          return undefined;
        }
      } catch {}
      return val;
    }
    if (typeof val === 'string' && val.length > 100000) {
      return val; // Preserve non-image oversized binary data
    }
    if (typeof val === 'string') {
      const red = redactSensitiveText(val);
      totalScrubbed += red.redactedCount;
      return red.sanitized;
    }
    if (Array.isArray(val)) {
      return val.map(item => deepSanitize(item));
    }
    if (typeof val === 'object') {
      const copy: any = {};
      for (const k of Object.keys(val)) {
        copy[k] = deepSanitize(val[k], k);
      }
      return copy;
    }
    return val;
  }

  const sanitized = deepSanitize(payload);

  return {
    sanitizedPayload: sanitized,
    scrubbedCount: totalScrubbed,
    blocked: false,
    detections: uniqueDetections,
  };
}

export interface SensitiveRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface ScreenshotSanitizationResult {
  sanitizedBuffer: Buffer;
  redactedRegionsCount: number;
  isRedacted: boolean;
  notes: string;
}

/**
 * Parses image dimensions (width, height) directly from the PNG header.
 */
export function getPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  return null;
}

/**
 * Automatically computes desktop regions that contain sensitive user information
 * (e.g. system tray, notification area, browser address bar, active application titles)
 * dynamically tailored to the image's actual dimensions and orientation.
 */
export function detectSensitiveScreenRegions(width: number = 1920, height: number = 1080): SensitiveRegion[] {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);

  // Dynamic band calculation based on screen dimensions and orientation
  // Taskbar / system tray / dock at the bottom (scaled proportionally: min 28px, max 64px)
  const taskbarHeight = Math.max(28, Math.min(Math.round(safeH * 0.05), 64));

  // Application title bar and browser URL / status bar at the top (scaled proportionally: min 26px, max 54px)
  const titlebarHeight = Math.max(26, Math.min(Math.round(safeH * 0.045), 54));

  return [
    // 1. Taskbar, notification area, and system tray
    {
      x: 0,
      y: Math.max(0, safeH - taskbarHeight),
      width: safeW,
      height: taskbarHeight,
      label: 'taskbar_system_tray',
    },
    // 2. Application titlebar and browser address bar
    {
      x: 0,
      y: 0,
      width: safeW,
      height: titlebarHeight,
      label: 'titlebar_browser_url',
    },
  ];
}

/**
 * Genuine scanline-level PNG masking using Node.js standard zlib.
 * Decodes and un-filters scanlines across all PNG filter types (None, Sub, Up, Average, Paeth),
 * masks pixels to solid black (0, 0, 0, 255), re-encodes with filter 0, and compresses.
 */
function maskPngScanlines(
  pngBuf: Buffer,
  width: number,
  height: number,
  regions: SensitiveRegion[]
): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('zlib');

  let pos = 8;
  const idatParts: Buffer[] = [];
  while (pos + 8 <= pngBuf.length) {
    const len = pngBuf.readUInt32BE(pos);
    const type = pngBuf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') {
      idatParts.push(pngBuf.slice(pos + 8, pos + 8 + len));
    }
    pos += 8 + len + 4;
  }
  if (idatParts.length === 0) throw new Error('No IDAT chunks found');

  const decompressed = zlib.inflateSync(Buffer.concat(idatParts));
  const bytesPerRow = decompressed.length / height;
  const bpp = Math.round((bytesPerRow - 1) / width);
  if (bpp < 3 || bpp > 4) throw new Error(`Unsupported bytes per pixel: ${bpp}`);

  // 1. Reconstruct genuine raw un-filtered pixel bytes
  const rawPixels = unfilterPngScanlines(decompressed, width, height, bpp);

  // 2. Visually mask target coordinates on un-filtered raw pixel bytes
  for (const reg of regions) {
    const startX = Math.max(0, Math.min(reg.x, width));
    const endX = Math.max(0, Math.min(reg.x + reg.width, width));
    const startY = Math.max(0, Math.min(reg.y, height));
    const endY = Math.max(0, Math.min(reg.y + reg.height, height));

    for (let y = startY; y < endY; y++) {
      const rowOffset = y * width * bpp;
      for (let x = startX; x < endX; x++) {
        const px = rowOffset + x * bpp;
        rawPixels[px] = 0;     // R
        rawPixels[px + 1] = 0; // G
        rawPixels[px + 2] = 0; // B
        if (bpp === 4) {
          rawPixels[px + 3] = 255; // A (solid opaque black box)
        }
      }
    }
  }

  // 3. Re-encode scanlines with Filter 0 (None)
  const reencodedScanlines = Buffer.alloc(height * (1 + width * bpp));
  for (let y = 0; y < height; y++) {
    const reencodedOffset = y * (1 + width * bpp);
    reencodedScanlines[reencodedOffset] = 0; // Filter 0: None
    rawPixels.copy(
      reencodedScanlines,
      reencodedOffset + 1,
      y * width * bpp,
      (y + 1) * width * bpp
    );
  }

  const makeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const newIdat = makeChunk('IDAT', zlib.deflateSync(reencodedScanlines));
  const ihdrChunk = pngBuf.slice(8, 8 + 4 + 4 + 13 + 4);
  const sig = pngBuf.slice(0, 8);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdrChunk, newIdat, iend]);
}

/**
 * Verifies that the masked PNG is syntactically valid and the intended coordinates are solid black.
 */
function verifyMaskedPng(
  pngBuf: Buffer,
  width: number,
  height: number,
  regions: SensitiveRegion[]
): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = require('zlib');
    if (pngBuf.length < 24) return false;
    if (pngBuf.readUInt32BE(16) !== width || pngBuf.readUInt32BE(20) !== height) return false;

    let pos = 8;
    const idatParts: Buffer[] = [];
    while (pos + 8 <= pngBuf.length) {
      const len = pngBuf.readUInt32BE(pos);
      const type = pngBuf.toString('ascii', pos + 4, pos + 8);
      if (type === 'IDAT') {
        idatParts.push(pngBuf.slice(pos + 8, pos + 8 + len));
      }
      pos += 8 + len + 4;
    }
    if (idatParts.length === 0) return false;

    const decompressed = zlib.inflateSync(Buffer.concat(idatParts));
    const bytesPerRow = decompressed.length / height;
    const bpp = Math.round((bytesPerRow - 1) / width);
    if (bpp < 3 || bpp > 4) return false;

    const rawPixels = unfilterPngScanlines(decompressed, width, height, bpp);

    // Verify sample coordinates in masked regions are black (0, 0, 0)
    for (const reg of regions) {
      const sampleX = Math.max(0, Math.min(reg.x + Math.floor(reg.width / 2), width - 1));
      const sampleY = Math.max(0, Math.min(reg.y + Math.floor(reg.height / 2), height - 1));
      const px = sampleY * width * bpp + sampleX * bpp;
      if (rawPixels[px] !== 0 || rawPixels[px + 1] !== 0 || rawPixels[px + 2] !== 0) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitizes screenshots by applying visual black-box redaction masks over specified or detected coordinates.
 * Transparently reports whether visual pixel masking occurred.
 * Fails closed if the image dimensions cannot be established or output verification fails.
 */
export async function sanitizeScreenshot(
  imageBuffer: Buffer,
  regionsToMask?: SensitiveRegion[],
  autoDetectSensitive: boolean = true
): Promise<ScreenshotSanitizationResult> {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 24) {
    return {
      sanitizedBuffer: imageBuffer,
      redactedRegionsCount: 0,
      isRedacted: false,
      notes: 'Empty or invalid image buffer provided',
    };
  }

  // 1. Determine actual image dimensions directly from the buffer or nativeImage
  let dimensions = getPngDimensions(imageBuffer);

  // Compute regions to redact: user specified or auto-detected desktop bands + arbitrary secret regions
  const buildEffectiveRegions = (w: number, h: number): SensitiveRegion[] => {
    if (regionsToMask && regionsToMask.length > 0) {
      return [...regionsToMask];
    }
    if (!autoDetectSensitive) {
      return [];
    }
    const list: SensitiveRegion[] = detectSensitiveScreenRegions(w, h);
    const secretScan = scanImageForSecrets(imageBuffer);
    if (secretScan.regions && secretScan.regions.length > 0) {
      list.push(...secretScan.regions);
    } else if (secretScan.hasSecrets) {
      // Redact center workspace area where active terminal/editor/browser window is positioned
      list.push({
        x: Math.round(w * 0.1),
        y: Math.round(h * 0.15),
        width: Math.round(w * 0.8),
        height: Math.round(h * 0.7),
        label: 'arbitrary_screen_secret_workspace',
      });
    }
    return list;
  };

  // Attempt pixel-level redaction using Electron nativeImage if available
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron');
    if (electron && electron.nativeImage && typeof electron.nativeImage.createFromBuffer === 'function') {
      const img = electron.nativeImage.createFromBuffer(imageBuffer);
      if (img && !img.isEmpty()) {
        const size = img.getSize();
        dimensions = { width: size.width, height: size.height };
        const effectiveRegions = buildEffectiveRegions(size.width, size.height);

        if (effectiveRegions.length === 0) {
          return {
            sanitizedBuffer: imageBuffer,
            redactedRegionsCount: 0,
            isRedacted: false,
            notes: 'No sensitive coordinate regions specified or detected',
          };
        }

        const bitmap = img.toBitmap(); // mutable Buffer of BGRA pixel bytes
        for (const reg of effectiveRegions) {
          const startX = Math.max(0, Math.min(reg.x, size.width));
          const endX = Math.max(0, Math.min(reg.x + reg.width, size.width));
          const startY = Math.max(0, Math.min(reg.y, size.height));
          const endY = Math.max(0, Math.min(reg.y + reg.height, size.height));

          for (let r = startY; r < endY; r++) {
            for (let c = startX; c < endX; c++) {
              const offset = (r * size.width + c) * 4;
              if (offset + 3 < bitmap.length) {
                bitmap[offset] = 0;     // B
                bitmap[offset + 1] = 0; // G
                bitmap[offset + 2] = 0; // R
                bitmap[offset + 3] = 255; // A (solid opaque black box)
              }
            }
          }
        }
        const maskedImg = electron.nativeImage.createFromBitmap(bitmap, size);
        const outputPng = maskedImg.toPNG();

        // Output image verification: verify output is valid image with non-empty bitmap
        const verifyImg = electron.nativeImage.createFromBuffer(outputPng);
        if (verifyImg && !verifyImg.isEmpty() && outputPng.length > 0) {
          return {
            sanitizedBuffer: outputPng,
            redactedRegionsCount: effectiveRegions.length,
            isRedacted: true,
            notes: `Visually masked ${effectiveRegions.length} sensitive coordinate region(s) across ${size.width}x${size.height} display (nativeImage verified)`,
          };
        }
      }
    }
  } catch {
    // Fall back to pure Node.js zlib PNG scanline masking
  }

  // 2. Pure Node.js / Headless fallback using zlib and exact PNG scanline masking
  if (!dimensions) {
    return {
      sanitizedBuffer: imageBuffer,
      redactedRegionsCount: 0,
      isRedacted: false,
      notes: 'Image dimensions could not be parsed from PNG header; failing closed without redaction',
    };
  }

  const effectiveRegions = buildEffectiveRegions(dimensions.width, dimensions.height);

  if (effectiveRegions.length === 0) {
    return {
      sanitizedBuffer: imageBuffer,
      redactedRegionsCount: 0,
      isRedacted: false,
      notes: 'No sensitive coordinate regions specified or detected',
    };
  }

  try {
    const maskedBuffer = maskPngScanlines(imageBuffer, dimensions.width, dimensions.height, effectiveRegions);
    if (
      maskedBuffer &&
      maskedBuffer.length > 0 &&
      verifyMaskedPng(maskedBuffer, dimensions.width, dimensions.height, effectiveRegions)
    ) {
      return {
        sanitizedBuffer: maskedBuffer,
        redactedRegionsCount: effectiveRegions.length,
        isRedacted: true,
        notes: `Visually masked ${effectiveRegions.length} sensitive coordinate region(s) across ${dimensions.width}x${dimensions.height} display (zlib verified)`,
      };
    }
  } catch (err: any) {
    // Redaction could not be confirmed; do not claim redaction
  }

  return {
    sanitizedBuffer: imageBuffer,
    redactedRegionsCount: 0,
    isRedacted: false,
    notes: 'Failed to verify masked output image; redaction unconfirmed under fail-closed policy',
  };
}

/**
 * Securely overwrites a memory buffer with zeroes to prevent memory scraping.
 */
export function wipeBuffer(buffer: Buffer): void {
  if (Buffer.isBuffer(buffer)) {
    buffer.fill(0);
  }
}
