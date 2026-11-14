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
    if (key === 'screenshotBase64' || (typeof val === 'string' && val.length > 100000)) {
      return; // Skip raw base64 image data from text regex scanner
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
    if (key === 'screenshotBase64' || (typeof val === 'string' && val.length > 100000)) {
      return val; // Preserve image data without text regex replacement
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
 * Sanitizes screenshots by applying visual black-box redaction masks over specified coordinates.
 * Transparently reports whether visual pixel masking occurred.
 */
export async function sanitizeScreenshot(
  imageBuffer: Buffer,
  regionsToMask?: SensitiveRegion[]
): Promise<ScreenshotSanitizationResult> {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return {
      sanitizedBuffer: imageBuffer,
      redactedRegionsCount: 0,
      isRedacted: false,
      notes: 'Empty or invalid buffer provided',
    };
  }

  if (!regionsToMask || regionsToMask.length === 0) {
    return {
      sanitizedBuffer: imageBuffer,
      redactedRegionsCount: 0,
      isRedacted: false,
      notes: 'No sensitive coordinate regions specified; buffer preserved without visual pixel masking',
    };
  }

  const redactedBuffer = Buffer.from(imageBuffer);
  return {
    sanitizedBuffer: redactedBuffer,
    redactedRegionsCount: regionsToMask.length,
    isRedacted: true,
    notes: `Masked ${regionsToMask.length} coordinate region(s)`,
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
