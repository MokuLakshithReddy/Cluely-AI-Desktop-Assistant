/**
 * Scandium Licensing Cryptographic Keys & Service Configuration
 *
 * The desktop client holds only the asymmetric public verification key (Ed25519 SPKI DER hex).
 * The corresponding private signing key is held strictly by the Scandium licensing backend
 * and is never bundled into the desktop application or exposed to renderers.
 */

export const SCANDIUM_LICENSING_PUBLIC_KEY =
  '302a300506032b657003210008a1a2f9a9fd2d62d967c05d5ac47e5507876b44043332a18a5bbc14cc8ede31';

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
    return envKey;
  }
  return SCANDIUM_LICENSING_PUBLIC_KEY;
}
