import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LicenseManager, LicenseRecord } from '../electron/services/license-manager';
import {
  verifyPaddleWebhookSignature,
  parseVerifiedPaddleWebhook,
  verifyLemonSqueezyWebhookSignature,
  parseVerifiedLemonSqueezyWebhook,
  WebhookEventDeduplicator,
} from '../electron/services/billing-webhook';
import { canonicalLicenseString } from '../electron/services/licensing-signature';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_PRIVATE_KEY = '302e020100300506032b657004220420c1825d15e4a70d9b8c730702ce385c9f80ec3e6cb610d79390a6a9cd550c2070';
const privKeyObj = crypto.createPrivateKey({
  key: Buffer.from(TEST_PRIVATE_KEY, 'hex'),
  format: 'der',
  type: 'pkcs8',
});

function signTestLicense(lic: Record<string, any>): string {
  const canonical = canonicalLicenseString(lic);
  return crypto.sign(null, Buffer.from(canonical, 'utf8'), privKeyObj).toString('hex');
}

describe('Scandium Provider-Independent Licensing & Offline Grace Subsystem', () => {
  let manager: LicenseManager;
  const testLicenseDir = path.join(process.cwd(), '.test-scandium-license');
  const testLicenseFile = path.join(testLicenseDir, 'scandium-license.enc');

  beforeEach(() => {
    if (!fs.existsSync(testLicenseDir)) {
      fs.mkdirSync(testLicenseDir, { recursive: true });
    }
    if (fs.existsSync(testLicenseFile)) {
      fs.unlinkSync(testLicenseFile);
    }
    manager = new LicenseManager();
    (manager as any).licenseFile = testLicenseFile;
    (manager as any).currentLicense = null;
  });

  afterEach(() => {
    if (fs.existsSync(testLicenseFile)) {
      try { fs.unlinkSync(testLicenseFile); } catch {}
    }
    if (fs.existsSync(testLicenseDir)) {
      try { fs.rmdirSync(testLicenseDir); } catch {}
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('generates a stable deterministic hardware fingerprint and anonymous instance name without hostname', () => {
    const hostnameSpy = vi.spyOn(os, 'hostname');
    hostnameSpy.mockReturnValue('Workstation-Alpha-Private');
    const fp1 = manager.getHardwareFingerprint();
    const inst1 = manager.getInstanceName();

    hostnameSpy.mockReturnValue('Workstation-Beta-Different');
    const fp2 = manager.getHardwareFingerprint();
    const inst2 = manager.getInstanceName();
    hostnameSpy.mockRestore();

    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);
    expect(inst1).toBe(inst2);
    expect(inst1.startsWith(`Scandium-${os.platform()}-`)).toBe(true);
    expect(inst1).toContain(fp1.slice(0, 8));
    expect(inst1).not.toContain('Workstation-Alpha-Private');
    expect(inst1).not.toContain('Workstation-Beta-Different');
  });

  it('defaults to Free tier when no license is configured', () => {
    expect(manager.getCurrentTier()).toBe('free');
    const status = manager.getLicenseStatus();
    expect(status.hasLicense).toBe(false);
    expect(status.tier).toBe('free');
    expect(status.status).toBe('none');
  });

  it('expires license immediately if expiresAt date is in the past', () => {
    const record: LicenseRecord = {
      licenseKey: 'PLUS-EXPIRED-KEY',
      instanceId: 'inst_exp',
      instanceName: manager.getInstanceName(),
      hardwareFingerprint: manager.getHardwareFingerprint(),
      status: 'active',
      tier: 'plus',
      activationLimit: 2,
      activationUsage: 1,
      expiresAt: '2020-01-01T00:00:00Z',
      lastValidatedAt: Date.now(),
    };
    (manager as any).currentLicense = record;
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('activates a license, verifies Ed25519 signature, and saves encrypted cache to disk', async () => {
    const hwFp = manager.getHardwareFingerprint();
    const instName = manager.getInstanceName();

    const mockLicensePayload = {
      licenseKey: 'ABCD-1234-EFGH-5678',
      tier: 'plus',
      status: 'active',
      instanceName: instName,
      hardwareFingerprint: hwFp,
      customerEmail: 'jane@example.com',
      activationLimit: 2,
      activationUsage: 1,
      activatedAt: new Date().toISOString(),
      expiresAt: '2028-12-31T23:59:59Z',
      issuedAt: Date.now(),
    };

    const signature = signTestLicense(mockLicensePayload);

    vi.spyOn(manager as any, 'postLicensingService').mockResolvedValue({
      success: true,
      license: mockLicensePayload,
      signature,
    });

    const activated = await manager.activateLicense('ABCD-1234-EFGH-5678');
    expect(activated.status).toBe('active');
    expect(activated.tier).toBe('plus');
    expect(activated.customerEmail).toBe('jane@example.com');
    expect(manager.getCurrentTier()).toBe('plus');
    expect(fs.existsSync(testLicenseFile)).toBe(true);

    const status = manager.getLicenseStatus();
    expect(status.hasLicense).toBe(true);
    expect(status.tier).toBe('plus');
    expect(status.licenseKeyMasked).toBe('ABCD...5678');
  });

  it('rejects activation when Ed25519 cryptographic signature is forged or invalid', async () => {
    const hwFp = manager.getHardwareFingerprint();
    const instName = manager.getInstanceName();

    const forgedPayload = {
      licenseKey: 'FORGED-PRO-KEY',
      tier: 'pro',
      status: 'active',
      instanceName: instName,
      hardwareFingerprint: hwFp,
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      issuedAt: Date.now(),
    };

    vi.spyOn(manager as any, 'postLicensingService').mockResolvedValue({
      success: true,
      license: forgedPayload,
      signature: '0'.repeat(128), // Invalid forged signature
    });

    await expect(manager.activateLicense('FORGED-PRO-KEY')).rejects.toThrow(
      /Ed25519 signature verification failed/i
    );
    expect(fs.existsSync(testLicenseFile)).toBe(false);
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('rejects activation if response hardware fingerprint does not match local machine', async () => {
    const instName = manager.getInstanceName();

    const mismatchedPayload = {
      licenseKey: 'PRO-FOREIGN-MACHINE-KEY',
      tier: 'pro',
      status: 'active',
      instanceName: instName,
      hardwareFingerprint: 'different_alien_fingerprint',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      issuedAt: Date.now(),
    };

    const signature = signTestLicense(mismatchedPayload);

    vi.spyOn(manager as any, 'postLicensingService').mockResolvedValue({
      success: true,
      license: mismatchedPayload,
      signature,
    });

    await expect(manager.activateLicense('PRO-FOREIGN-MACHINE-KEY')).rejects.toThrow(
      /does not match this machine hardware fingerprint/i
    );
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('engages 7-day offline grace period on network validation failure', async () => {
    const record: LicenseRecord = {
      licenseKey: 'PRO-9999-XXXX-YYYY',
      instanceId: 'inst_99',
      instanceName: manager.getInstanceName(),
      hardwareFingerprint: manager.getHardwareFingerprint(),
      status: 'active',
      tier: 'pro',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now() - (2 * 24 * 60 * 60 * 1000), // 2 days ago
    };
    (manager as any).currentLicense = record;
    (manager as any).saveCachedLicense();

    vi.spyOn(manager as any, 'postLicensingService').mockRejectedValue(new Error('ENOTFOUND licensing.scandium.internal'));

    const validated = await manager.validateLicense();
    expect(validated?.status).toBe('grace_period');
    expect(validated?.graceRemainingDays).toBeGreaterThanOrEqual(4);
    expect(validated?.graceRemainingDays).toBeLessThanOrEqual(5);

    expect(manager.getCurrentTier()).toBe('pro');
  });

  it('expires license when offline grace period exceeds 7 days', async () => {
    const record: LicenseRecord = {
      licenseKey: 'PRO-9999-XXXX-YYYY',
      instanceId: 'inst_99',
      instanceName: manager.getInstanceName(),
      hardwareFingerprint: manager.getHardwareFingerprint(),
      status: 'active',
      tier: 'pro',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
    };
    (manager as any).currentLicense = record;

    vi.spyOn(manager as any, 'postLicensingService').mockRejectedValue(new Error('ENOTFOUND licensing.scandium.internal'));

    const validated = await manager.validateLicense();
    expect(validated?.status).toBe('expired');
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('deactivates license and purges local license cache file', async () => {
    const record: LicenseRecord = {
      licenseKey: 'ABCD-1234-EFGH-5678',
      instanceId: 'inst_12345',
      instanceName: manager.getInstanceName(),
      hardwareFingerprint: manager.getHardwareFingerprint(),
      status: 'active',
      tier: 'plus',
      activationLimit: 2,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now(),
    };
    (manager as any).currentLicense = record;
    (manager as any).saveCachedLicense();
    expect(fs.existsSync(testLicenseFile)).toBe(true);

    vi.spyOn(manager as any, 'postLicensingService').mockResolvedValue({ success: true, deactivated: true });

    await manager.deactivateLicense();
    expect(manager.getCurrentTier()).toBe('free');
    expect(fs.existsSync(testLicenseFile)).toBe(false);
  });

  it('preserves cached license across restart and reloads via init() without losing Plus/Pro tier', () => {
    const record: LicenseRecord = {
      licenseKey: 'PLUS-RESTART-TEST-KEY',
      instanceId: 'inst_restart',
      instanceName: manager.getInstanceName(),
      hardwareFingerprint: manager.getHardwareFingerprint(),
      status: 'active',
      tier: 'plus',
      activationLimit: 2,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now(),
    };
    (manager as any).currentLicense = record;
    (manager as any).saveCachedLicense();
    expect(fs.existsSync(testLicenseFile)).toBe(true);

    const newManager = new LicenseManager();
    (newManager as any).licenseFile = testLicenseFile;
    (newManager as any).currentLicense = null;

    newManager.init();

    expect(newManager.getCurrentTier()).toBe('plus');
    const status = newManager.getLicenseStatus();
    expect(status.hasLicense).toBe(true);
    expect(status.tier).toBe('plus');
    expect(status.status).toBe('active');
  });

  it('rejects a cached license record copied from a different machine instance', () => {
    const record: LicenseRecord = {
      licenseKey: 'PRO-FOREIGN-MACHINE',
      instanceId: 'inst_other',
      instanceName: 'Scandium-darwin-00000000',
      hardwareFingerprint: 'different_alien_hw_fingerprint',
      status: 'active',
      tier: 'pro',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now(),
    };
    (manager as any).currentLicense = record;
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('fails closed on clock rollback and on disabled/expired remote license responses', async () => {
    const record: LicenseRecord = {
      licenseKey: 'PRO-ROLLBACK-KEY',
      instanceId: 'inst_rb',
      instanceName: manager.getInstanceName(),
      hardwareFingerprint: manager.getHardwareFingerprint(),
      status: 'active',
      tier: 'pro',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now() + (60 * 60 * 1000), // 1 hour in future -> clock rolled back
    };
    (manager as any).currentLicense = record;
    const rbResult = await manager.validateLicense();
    expect(rbResult?.status).toBe('expired');
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('verifies Paddle Billing HMAC-SHA256 webhook signatures, timestamp tolerance, and maps subscription events', () => {
    vi.stubEnv('PADDLE_PLUS_PRICE_ID', 'pri_plus_abc123');
    vi.stubEnv('PADDLE_PRO_PRICE_ID', 'pri_pro_xyz789');

    const secret = 'pdl_ntf_set_test_secret_key_2026';
    const now = Math.floor(Date.now() / 1000);

    const activePayload = JSON.stringify({
      event_id: 'evt_paddle_test_1',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T12:00:00Z',
      data: {
        id: 'sub_paddle_123',
        status: 'active',
        items: [{ price: { id: 'pri_pro_xyz789' }, quantity: 1 }],
        customer: { email: 'subscriber@example.com' },
        current_billing_period: { ends_at: '2026-12-20T12:00:00Z' },
      },
    });

    const signPaddle = (body: string, ts: number) => {
      const signed = `${ts}:${body}`;
      const h1 = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
      return `ts=${ts};h1=${h1}`;
    };

    const validHeader = signPaddle(activePayload, now);

    expect(verifyPaddleWebhookSignature(activePayload, validHeader, secret)).toBe(true);
    expect(verifyPaddleWebhookSignature(activePayload, 'ts=123;h1=' + '0'.repeat(64), secret)).toBe(false);
    expect(verifyPaddleWebhookSignature(activePayload + ' ', validHeader, secret)).toBe(false);
    expect(verifyPaddleWebhookSignature(activePayload, validHeader, '')).toBe(false);

    // Expired timestamp (>300s old)
    const expiredHeader = signPaddle(activePayload, now - 600);
    expect(verifyPaddleWebhookSignature(activePayload, expiredHeader, secret)).toBe(false);

    const dedup = new WebhookEventDeduplicator();
    const transition = parseVerifiedPaddleWebhook(activePayload, validHeader, secret, dedup);
    expect(transition.tier).toBe('pro');
    expect(transition.entitlementState).toBe('active');
    expect(transition.subscriptionId).toBe('sub_paddle_123');

    // Duplicate replay must be rejected
    expect(() => parseVerifiedPaddleWebhook(activePayload, validHeader, secret, dedup)).toThrow(/Duplicate webhook/i);

    // Payment failed -> past_due, tier revoked to free
    const failedPayload = JSON.stringify({
      event_id: 'evt_paddle_fail_1',
      event_type: 'subscription.past_due',
      occurred_at: '2026-11-20T14:00:00Z',
      data: {
        id: 'sub_paddle_123',
        status: 'past_due',
        items: [{ price: { id: 'pri_pro_xyz789' }, quantity: 1 }],
      },
    });
    const failedTransition = parseVerifiedPaddleWebhook(
      failedPayload,
      signPaddle(failedPayload, now),
      secret,
      dedup
    );
    expect(failedTransition.tier).toBe('free');
    expect(failedTransition.entitlementState).toBe('past_due');

    // Canceled -> cancelled, tier revoked to free
    const cancelPayload = JSON.stringify({
      event_id: 'evt_paddle_cancel_1',
      event_type: 'subscription.canceled',
      occurred_at: '2026-11-20T16:00:00Z',
      data: {
        id: 'sub_paddle_123',
        status: 'canceled',
        items: [{ price: { id: 'pri_pro_xyz789' }, quantity: 1 }],
      },
    });
    const cancelTransition = parseVerifiedPaddleWebhook(
      cancelPayload,
      signPaddle(cancelPayload, now),
      secret,
      dedup
    );
    expect(cancelTransition.tier).toBe('free');
    expect(cancelTransition.entitlementState).toBe('cancelled');
  });

  it('retains backward compatibility for legacy Lemon Squeezy webhook signature verification', () => {
    const secret = 'whsec_legacy_lemon_secret';
    const body = JSON.stringify({ meta: { event_name: 'subscription_created' } });
    const sig = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

    expect(verifyLemonSqueezyWebhookSignature(body, sig, secret)).toBe(true);
    expect(verifyLemonSqueezyWebhookSignature(body, '0'.repeat(64), secret)).toBe(false);
  });
});
