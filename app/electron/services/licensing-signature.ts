import crypto from 'crypto';
import { getLicensingPublicKey, isPublicKeyRevoked } from '../config/licensing-keys';

/**
 * Returns a deterministic canonical JSON string with sorted keys.
 * Omits undefined values and normalizes formatting across backend and client.
 */
export function canonicalLicenseString(obj: Record<string, any>): string {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return '';
  }
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: Record<string, any> = {};
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      sortedObj[k] = obj[k];
    }
  }
  return JSON.stringify(sortedObj);
}

/**
 * Verifies an Ed25519 signature over a canonical license object using the embedded public key.
 * Fails closed on any parse error, key mismatch, or malformed signature.
 */
export function verifySignedLicense(
  license: Record<string, any> | undefined | null,
  signatureHex: string | undefined | null,
  publicKeyHex: string = getLicensingPublicKey()
): boolean {
  if (!license || typeof license !== 'object' || !signatureHex || typeof signatureHex !== 'string') {
    return false;
  }
  const cleanSig = signatureHex.trim().toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(cleanSig)) {
    return false;
  }
  if (!publicKeyHex || !/^[a-f0-9]{88}$/i.test(publicKeyHex.trim())) {
    return false;
  }
  if (isPublicKeyRevoked(publicKeyHex)) {
    console.warn('[LicensingSignature] Signature verification failed: key is explicitly revoked');
    return false;
  }

  try {
    const canonical = canonicalLicenseString(license);
    if (!canonical) return false;

    const pubKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyHex.trim(), 'hex'),
      format: 'der',
      type: 'spki',
    });

    return crypto.verify(
      null,
      Buffer.from(canonical, 'utf8'),
      pubKey,
      Buffer.from(cleanSig, 'hex')
    );
  } catch (err) {
    console.warn('[LicensingSignature] Cryptographic verification failed:', err);
    return false;
  }
}
