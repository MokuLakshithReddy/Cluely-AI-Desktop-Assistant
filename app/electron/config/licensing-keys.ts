/**
 * Scandium Licensing Cryptographic Keys & Service Configuration
 *
 * The desktop client holds only the asymmetric public verification key (Ed25519 SPKI DER hex).
 * The corresponding private signing key is held strictly by the Scandium licensing backend
 * and is never bundled into the desktop application or exposed to renderers.
 */

// Active production Ed25519 SPKI DER hex public verification key (rotated & uncompromised)
export const SCANDIUM_LICENSING_PUBLIC_KEY =
  '302a300506032b6570032100873716d1254b54554669942cf76bfd30197174b745d035dcd453b641110e4599';

// Permanently revoked / compromised public keys that must NEVER be trusted by any client or backend
export const REVOKED_LICENSING_PUBLIC_KEYS = Object.freeze([
  // Compromised key from earlier test/commit exposure
  '302a300506032b657003210008a1a2f9a9fd2d62d967c05d5ac47e5507876b44043332a18a5bbc14cc8ede31',
]);

export function isPublicKeyRevoked(keyHex: string | undefined | null): boolean {
  if (!keyHex) return false;
  const normalized = keyHex.trim().toLowerCase();
  return REVOKED_LICENSING_PUBLIC_KEYS.some((revoked) => revoked.toLowerCase() === normalized);
}

export const DEFAULT_SCANDIUM_LICENSING_URL =
  'https://scandium-billing-webhook.mokulakshithreddy.workers.dev';

export function getLicensingServiceUrl(): string {
  const envUrl = process.env.SCANDIUM_LICENSING_URL?.trim();
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        return envUrl.replace(/\/+$/, '');
      }
    } catch {}
  }
  return DEFAULT_SCANDIUM_LICENSING_URL;
}

export function getLicensingPublicKey(): string {
  const envKey = process.env.SCANDIUM_LICENSING_PUBLIC_KEY?.trim();
  if (envKey && /^[a-f0-9]{88}$/i.test(envKey)) {
    if (isPublicKeyRevoked(envKey)) {
      console.warn('[LicensingKeys] Refusing to use explicitly revoked licensing public key from environment');
      return SCANDIUM_LICENSING_PUBLIC_KEY;
    }
    return envKey;
  }
  return SCANDIUM_LICENSING_PUBLIC_KEY;
}
