/**
 * Cryptographic utilities for Scandium Licensing & Webhook Service.
 * Implements Ed25519 signing/verification and timing-safe equality using Web Crypto API.
 */

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function canonicalJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj = {};
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      sortedObj[k] = obj[k];
    }
  }
  return JSON.stringify(sortedObj);
}

export async function sha256Hex(text) {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Signs a canonical license object using an Ed25519 PKCS8 DER private key.
 * Returns the 64-byte signature as a 128-character lowercase hex string.
 */
export async function signLicensePayload(licenseObj, pkcs8Hex) {
  const canonical = canonicalJson(licenseObj);
  const enc = new TextEncoder();
  const data = enc.encode(canonical);
  const keyBytes = hexToBytes(pkcs8Hex.trim());

  const privKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    'Ed25519',
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('Ed25519', privKey, data);
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Verifies a canonical license object signature using an Ed25519 SPKI DER public key.
 */
export async function verifyLicensePayload(licenseObj, sigHex, spkiHex) {
  try {
    const canonical = canonicalJson(licenseObj);
    const enc = new TextEncoder();
    const data = enc.encode(canonical);
    const pubKeyBytes = hexToBytes(spkiHex.trim());
    const sigBytes = hexToBytes(sigHex.trim());

    const pubKey = await crypto.subtle.importKey(
      'spki',
      pubKeyBytes,
      'Ed25519',
      false,
      ['verify']
    );

    return await crypto.subtle.verify('Ed25519', pubKey, sigBytes, data);
  } catch {
    return false;
  }
}

/**
 * Generates a high-entropy commercial license key with at least 192 bits of
 * cryptographically secure random material (24 bytes = 48 hex characters).
 * Formatted as: SCANDIUM-<TIER>-<8HEX>-<8HEX>-<8HEX>-<8HEX>-<8HEX>-<8HEX>
 */
export function generateStrongLicenseKey(tier) {
  const prefix = tier === 'pro' ? 'SCANDIUM-PRO' : 'SCANDIUM-PLUS';
  const entropy = new Uint8Array(24); // 24 bytes = 192 bits of CSPRNG randomness
  crypto.getRandomValues(entropy);
  const hex = bytesToHex(entropy).toUpperCase();
  const chunks = [
    hex.slice(0, 8),
    hex.slice(8, 16),
    hex.slice(16, 24),
    hex.slice(24, 32),
    hex.slice(32, 40),
    hex.slice(40, 48),
  ];
  return `${prefix}-${chunks.join('-')}`;
}

