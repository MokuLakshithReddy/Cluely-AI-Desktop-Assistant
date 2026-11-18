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

  it('fails closed to Free tier when IDs are missing or only product names match', () => {
    const fn = (manager as any).resolveTierFromMeta.bind(manager);
    expect(fn({ product_name: 'Unknown Random Product' })).toBe('free');
    expect(fn({ product_name: 'Photoshop License' })).toBe('free');
    expect(fn({ product_name: 'Scandium Plus', variant_name: 'Plus Monthly' })).toBe('free');
    expect(fn({ product_name: 'Scandium Pro', variant_name: 'Pro Monthly' })).toBe('free');
    expect(fn(null)).toBe('free');
  });

  it('grants paid tiers only for the exact configured product and variant ID pair', () => {
    vi.stubEnv('LEMON_PLUS_PRODUCT_ID', 'plus-product-123');
    vi.stubEnv('LEMON_PLUS_VARIANT_ID', 'plus-variant-456');
    vi.stubEnv('LEMON_PRO_PRODUCT_ID', 'pro-product-789');
    vi.stubEnv('LEMON_PRO_VARIANT_ID', 'pro-variant-012');

    const fn = (manager as any).resolveTierFromMeta.bind(manager);
    expect(fn({ product_name: 'Renamed Product', product_id: 'plus-product-123', variant_id: 'plus-variant-456' })).toBe('plus');
    expect(fn({ product_name: 'Renamed Product', product_id: 'pro-product-789', variant_id: 'pro-variant-012' })).toBe('pro');
    expect(fn({ product_name: 'Scandium Pro', product_id: 'plus-product-123', variant_id: 'pro-variant-012' })).toBe('free');
    expect(fn({ product_name: 'Scandium Plus', product_id: 'plus-product-123', variant_id: 'wrong-variant' })).toBe('free');
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
    vi.stubEnv('LEMON_PLUS_PRODUCT_ID', 'plus-product-123');
    vi.stubEnv('LEMON_PLUS_VARIANT_ID', 'plus-variant-456');

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
        product_id: 'plus-product-123',
        variant_id: 'plus-variant-456',
        product_name: 'Renamed Product',
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

  it('rejects activation when the license belongs to an unconfigured product', async () => {
    vi.spyOn(manager as any, 'postLemonSqueezy').mockResolvedValue({
      activated: true,
      license_key: { status: 'active', activation_limit: 2, activation_usage: 1 },
      instance: { id: 'inst_unconfigured' },
      meta: { product_name: 'Scandium Plus', variant_name: 'Plus Monthly' },
    });

    await expect(manager.activateLicense('UNCONFIGURED-KEY')).rejects.toThrow(
      'does not match a configured Scandium Plus or Pro product'
    );
    expect(fs.existsSync(testLicenseFile)).toBe(false);
    expect(manager.getCurrentTier()).toBe('free');
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

  it('preserves cached license across restart and reloads via init() without losing Plus/Pro tier', () => {
    const record: LicenseRecord = {
      licenseKey: 'PLUS-RESTART-TEST-KEY',
      instanceId: 'inst_restart',
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

    // Simulate restart: new instance before app.whenReady() where safeStorage was unavailable
    const newManager = new LicenseManager();
    (newManager as any).licenseFile = testLicenseFile;
    (newManager as any).currentLicense = null; // simulate pre-ready null state

    // Call init() after app.whenReady()
    newManager.init();

    expect(newManager.getCurrentTier()).toBe('plus');
    const status = newManager.getLicenseStatus();
    expect(status.hasLicense).toBe(true);
    expect(status.tier).toBe('plus');
    expect(status.status).toBe('active');
  });
});
