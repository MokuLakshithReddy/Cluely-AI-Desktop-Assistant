import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LicenseManager, LicenseRecord } from '../electron/services/license-manager';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Lemon Squeezy Licensing & Offline Grace Subsystem', () => {
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
    vi.restoreAllMocks();
  });

  it('generates a stable deterministic hardware fingerprint and anonymous instance name without hostname', () => {
    const fp1 = manager.getHardwareFingerprint();
    const fp2 = manager.getHardwareFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(16);

    const instanceName = manager.getInstanceName();
    expect(instanceName.startsWith(`Scandium-${os.platform()}-`)).toBe(true);
    expect(instanceName).toContain(fp1.slice(0, 8));
  });

  it('defaults to Free tier when no license is configured', () => {
    expect(manager.getCurrentTier()).toBe('free');
    const status = manager.getLicenseStatus();
    expect(status.hasLicense).toBe(false);
    expect(status.tier).toBe('free');
    expect(status.status).toBe('none');
  });

  it('fails closed to Free tier for unknown or malicious products', () => {
    const fn = (manager as any).resolveTierFromMeta.bind(manager);
    expect(fn({ product_name: 'Unknown Random Product' })).toBe('free');
    expect(fn({ product_name: 'Photoshop License' })).toBe('free');
    expect(fn(null)).toBe('free');
    expect(fn({ product_name: 'Scandium Plus' })).toBe('plus');
    expect(fn({ product_name: 'Scandium Pro' })).toBe('pro');
  });

  it('expires license immediately if expiresAt date is in the past', () => {
    const record: LicenseRecord = {
      licenseKey: 'PLUS-EXPIRED-KEY',
      instanceId: 'inst_exp',
      instanceName: manager.getInstanceName(),
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

  it('activates a license and saves encrypted cache to disk', async () => {
    const mockApiResponse = {
      activated: true,
      license_key: {
        status: 'active',
        activation_limit: 2,
        activation_usage: 1,
        expires_at: '2028-12-31T23:59:59Z',
      },
      instance: {
        id: 'inst_12345',
        name: manager.getInstanceName(),
      },
      meta: {
        product_name: 'Scandium Plus Monthly',
        customer_name: 'Jane Doe',
        customer_email: 'jane@example.com',
      },
    };

    vi.spyOn(manager as any, 'postLemonSqueezy').mockResolvedValue(mockApiResponse);

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

  it('engages 7-day offline grace period on network validation failure', async () => {
    const record: LicenseRecord = {
      licenseKey: 'PRO-9999-XXXX-YYYY',
      instanceId: 'inst_99',
      instanceName: manager.getInstanceName(),
      status: 'active',
      tier: 'pro',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now() - (2 * 24 * 60 * 60 * 1000), // 2 days ago
    };
    (manager as any).currentLicense = record;
    (manager as any).saveCachedLicense();

    vi.spyOn(manager as any, 'postLemonSqueezy').mockRejectedValue(new Error('ENOTFOUND api.lemonsqueezy.com'));

    const validated = await manager.validateLicense();
    expect(validated.status).toBe('grace_period');
    expect(validated.graceRemainingDays).toBeGreaterThanOrEqual(4);
    expect(validated.graceRemainingDays).toBeLessThanOrEqual(5);

    expect(manager.getCurrentTier()).toBe('pro');
  });

  it('expires license when offline grace period exceeds 7 days', async () => {
    const record: LicenseRecord = {
      licenseKey: 'PRO-9999-XXXX-YYYY',
      instanceId: 'inst_99',
      instanceName: manager.getInstanceName(),
      status: 'active',
      tier: 'pro',
      activationLimit: 5,
      activationUsage: 1,
      expiresAt: null,
      lastValidatedAt: Date.now() - (8 * 24 * 60 * 60 * 1000), // 8 days ago
    };
    (manager as any).currentLicense = record;

    vi.spyOn(manager as any, 'postLemonSqueezy').mockRejectedValue(new Error('ENOTFOUND api.lemonsqueezy.com'));

    const validated = await manager.validateLicense();
    expect(validated.status).toBe('expired');
    expect(manager.getCurrentTier()).toBe('free');
  });

  it('deactivates license and purges local license cache file', async () => {
    const record: LicenseRecord = {
      licenseKey: 'ABCD-1234-EFGH-5678',
      instanceId: 'inst_12345',
      instanceName: manager.getInstanceName(),
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

    vi.spyOn(manager as any, 'postLemonSqueezy').mockResolvedValue({ deactivated: true });

    await manager.deactivateLicense();
    expect(manager.getCurrentTier()).toBe('free');
    expect(fs.existsSync(testLicenseFile)).toBe(false);
  });
});
