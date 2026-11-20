import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { app } from 'electron';
import { SubscriptionTier, TierEntitlements, getEntitlements, isDeveloperEntitlementOverrideEnabled } from '../domains/entitlements';
import { encryptStoragePayload, decryptStoragePayload } from './storage-encryption';
import { PADDLE_PRODUCTS } from '../config/billing-products';
import { getLicensingServiceUrl } from '../config/licensing-keys';
import { verifySignedLicense } from './licensing-signature';

export interface LicenseRecord {
  licenseKey: string;
  instanceId: string;
  instanceName: string;
  hardwareFingerprint: string;
  status: 'active' | 'inactive' | 'expired' | 'disabled' | 'grace_period';
  tier: SubscriptionTier;
  customerName?: string;
  customerEmail?: string;
  activationLimit: number;
  activationUsage: number;
  expiresAt: string | null;
  lastValidatedAt: number;
  graceRemainingDays?: number;
  signature?: string;
}

export class LicenseManager {
  private licenseFile: string;
  private currentLicense: LicenseRecord | null = null;
  private readonly GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor() {
    const baseDir = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.scandium');
    this.licenseFile = path.join(baseDir, 'scandium-license.enc');
    try {
      this.loadCachedLicense();
    } catch {}
  }

  public init(): void {
    this.loadCachedLicense();
  }

  public getHardwareFingerprint(): string {
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 && cpus[0]?.model ? cpus[0].model.trim() : 'unknown-cpu';
    // Strictly non-PII coarse hardware traits; personal computer hostname is never included.
    const parts = [
      os.platform(),
      os.arch(),
      cpuModel,
      cpus.length.toString(),
      os.totalmem().toString(),
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  }

  public getInstanceName(): string {
    const fp = this.getHardwareFingerprint();
    return `Scandium-${os.platform()}-${fp.slice(0, 8)}`;
  }

  public getCurrentTier(): SubscriptionTier {
    if (!this.currentLicense && fs.existsSync(this.licenseFile)) {
      this.loadCachedLicense();
    }
    if (!this.currentLicense) return 'free';

    // Machine-binding guard: reject a cached license record copied from another machine.
    const expectedFp = this.getHardwareFingerprint();
    if (this.currentLicense.hardwareFingerprint && this.currentLicense.hardwareFingerprint !== expectedFp) {
      console.warn('[LicenseManager] Cached license hardware fingerprint does not match this machine. Failing closed to Free tier.');
      return 'free';
    }
    if (this.currentLicense.instanceName && this.currentLicense.instanceName !== this.getInstanceName()) {
      console.warn('[LicenseManager] Cached license instance does not match this machine. Failing closed to Free tier.');
      return 'free';
    }

    // Verify expiration timestamp independently against wall clock
    if (this.currentLicense.expiresAt) {
      const expTime = new Date(this.currentLicense.expiresAt).getTime();
      if (!isNaN(expTime) && expTime < Date.now()) {
        this.currentLicense.status = 'expired';
        return 'free';
      }
    }

    const status = this.currentLicense.status;
    if (status === 'active') return this.currentLicense.tier;

    if (status === 'grace_period') {
      const elapsed = Date.now() - (this.currentLicense.lastValidatedAt || 0);
      if (elapsed <= this.GRACE_PERIOD_MS) {
        return this.currentLicense.tier;
      }
    }

    return 'free';
  }

  public getEntitlements(): TierEntitlements {
    return getEntitlements(this.getCurrentTier());
  }

  public isDeveloperModeEnabled(): boolean {
    return isDeveloperEntitlementOverrideEnabled(
      process.env.SCANDIUM_DEVELOPER_MODE,
      app?.isPackaged ?? false,
      process.env.NODE_ENV
    );
  }

  public getLicenseStatus(): {
    hasLicense: boolean;
    developerMode: boolean;
    tier: SubscriptionTier;
    status: LicenseRecord['status'] | 'none';
    licenseKeyMasked?: string;
    expiresAt?: string | null;
    customerEmail?: string;
    activationLimit?: number;
    activationUsage?: number;
    graceRemainingDays?: number;
    instanceName: string;
  } {
    if (!this.currentLicense && fs.existsSync(this.licenseFile)) {
      this.loadCachedLicense();
    }
    const instanceName = this.getInstanceName();
    if (!this.currentLicense) {
      return {
        hasLicense: false,
        tier: 'free',
        status: 'none',
        developerMode: this.isDeveloperModeEnabled(),
        instanceName,
      };
    }

    const elapsed = Date.now() - (this.currentLicense.lastValidatedAt || 0);
    const graceRemainingDays = Math.max(0, Math.ceil((this.GRACE_PERIOD_MS - elapsed) / (24 * 60 * 60 * 1000)));

    const masked = this.currentLicense.licenseKey
      ? `${this.currentLicense.licenseKey.slice(0, 4)}...${this.currentLicense.licenseKey.slice(-4)}`
      : undefined;

    return {
      hasLicense: true,
      tier: this.getCurrentTier(),
      status: this.currentLicense.status,
      developerMode: this.isDeveloperModeEnabled(),
      licenseKeyMasked: masked,
      expiresAt: this.currentLicense.expiresAt,
      customerEmail: this.currentLicense.customerEmail,
      activationLimit: this.currentLicense.activationLimit,
      activationUsage: this.currentLicense.activationUsage,
      graceRemainingDays: this.currentLicense.status === 'grace_period' ? graceRemainingDays : undefined,
      instanceName,
    };
  }

  /**
   * Activates a license key with the provider-independent Scandium Licensing Service.
   * Enforces cryptographic Ed25519 signature verification on the received entitlement response.
   */
  public async activateLicense(licenseKey: string): Promise<LicenseRecord> {
    const trimmed = licenseKey.trim();
    if (!trimmed) throw new Error('License key cannot be empty');

    const hardwareFingerprint = this.getHardwareFingerprint();
    const instanceName = this.getInstanceName();
    let appVersion = '1.0.3';
    try {
      const v = app?.getVersion?.();
      if (typeof v === 'string' && v.trim()) appVersion = v.trim();
    } catch {}

    const payload = {
      licenseKey: trimmed,
      instanceName,
      hardwareFingerprint,
      appVersion,
      platform: process.platform,
    };

    const res = await this.postLicensingService('/api/v1/license/activate', payload);
    if (!res.success) {
      throw new Error(res.error || 'Failed to activate license key');
    }

    const lic = res.license || {};
    const signature = res.signature;

    // Cryptographic signature verification: verify Ed25519 signature over canonical license object
    if (!verifySignedLicense(lic, signature)) {
      throw new Error('[LicenseManager] Untrusted license response: cryptographic Ed25519 signature verification failed.');
    }

    // Machine-binding verification: response must be bound to this hardware fingerprint
    if (lic.hardwareFingerprint && lic.hardwareFingerprint !== hardwareFingerprint) {
      throw new Error('[LicenseManager] License activation instance does not match this machine hardware fingerprint.');
    }

    const tier: SubscriptionTier = lic.tier === 'pro' ? 'pro' : lic.tier === 'plus' ? 'plus' : 'free';
    if (tier === 'free') {
      throw new Error('This license does not match a configured Scandium Plus or Pro plan.');
    }

    const record: LicenseRecord = {
      licenseKey: trimmed,
      instanceId: lic.instanceId || instanceName,
      instanceName,
      hardwareFingerprint,
      status: lic.status === 'active' ? 'active' : 'inactive',
      tier,
      customerName: lic.customerName,
      customerEmail: lic.customerEmail,
      activationLimit: lic.activationLimit || (tier === 'pro' ? 5 : 2),
      activationUsage: lic.activationUsage || 1,
      expiresAt: lic.expiresAt || null,
      lastValidatedAt: Date.now(),
      signature,
    };

    this.currentLicense = record;
    this.saveCachedLicense();
    return record;
  }

  /**
   * Validates the active license with the Scandium Licensing Service.
   * If the service is unreachable (network failure / 429 / 5xx), engages the 7-day offline grace period.
   */
  public async validateLicense(): Promise<LicenseRecord | null> {
    if (!this.currentLicense) return null;

    // Check anti-tamper on system clock
    if (Date.now() < this.currentLicense.lastValidatedAt - 60000) {
      console.warn('[LicenseManager] Detected system clock rollback. Failing validation.');
      this.currentLicense.status = 'expired';
      this.saveCachedLicense();
      return this.currentLicense;
    }

    const hardwareFingerprint = this.getHardwareFingerprint();
    const payload = {
      licenseKey: this.currentLicense.licenseKey,
      instanceName: this.currentLicense.instanceName,
      hardwareFingerprint,
    };

    try {
      const res = await this.postLicensingService('/api/v1/license/validate', payload);
      const lic = res.license || {};
      const isValid = res.valid === true && lic.status === 'active';

      if (isValid) {
        if (!verifySignedLicense(lic, res.signature)) {
          console.warn('[LicenseManager] Validation signature verification failed. Failing closed.');
          this.currentLicense.status = 'disabled';
          this.saveCachedLicense();
          return this.currentLicense;
        }

        const verifiedTier: SubscriptionTier = lic.tier === 'pro' ? 'pro' : lic.tier === 'plus' ? 'plus' : 'free';
        if (verifiedTier === 'free') {
          this.currentLicense.tier = 'free';
          this.currentLicense.status = 'disabled';
          this.saveCachedLicense();
          return this.currentLicense;
        }

        this.currentLicense.tier = verifiedTier;
        this.currentLicense.status = 'active';
        this.currentLicense.expiresAt = lic.expiresAt || null;
        this.currentLicense.activationLimit = lic.activationLimit || this.currentLicense.activationLimit;
        this.currentLicense.activationUsage = lic.activationUsage || this.currentLicense.activationUsage;
        this.currentLicense.lastValidatedAt = Date.now();
        this.currentLicense.signature = res.signature;
      } else {
        this.currentLicense.status = lic.status || 'expired';
      }

      this.saveCachedLicense();
      return this.currentLicense;
    } catch (netErr) {
      // Network unreachable: trigger Offline Grace Period check
      console.warn('[LicenseManager] Validation network failure. Engaging offline grace check:', netErr);
      const elapsed = Date.now() - (this.currentLicense.lastValidatedAt || 0);

      if (elapsed <= this.GRACE_PERIOD_MS) {
        this.currentLicense.status = 'grace_period';
        const remainingDays = Math.max(0, Math.ceil((this.GRACE_PERIOD_MS - elapsed) / (24 * 60 * 60 * 1000)));
        this.currentLicense.graceRemainingDays = remainingDays;
        this.saveCachedLicense();
        return this.currentLicense;
      }

      // Grace period exhausted
      this.currentLicense.status = 'expired';
      this.saveCachedLicense();
      return this.currentLicense;
    }
  }

  /**
   * Deactivates the active license from this device.
   */
  public async deactivateLicense(): Promise<void> {
    if (!this.currentLicense) return;

    try {
      const payload = {
        licenseKey: this.currentLicense.licenseKey,
        instanceName: this.currentLicense.instanceName,
        hardwareFingerprint: this.getHardwareFingerprint(),
      };
      await this.postLicensingService('/api/v1/license/deactivate', payload);
    } catch (e) {
      console.warn('[LicenseManager] Deactivation remote notice failed:', e);
    } finally {
      this.currentLicense = null;
      if (fs.existsSync(this.licenseFile)) {
        try { fs.unlinkSync(this.licenseFile); } catch {}
      }
    }
  }

  public isPaidBillingConfigured(): { plus: boolean; pro: boolean } {
    const plusPriceId = String(
      process.env.PADDLE_PLUS_PRICE_ID ||
      PADDLE_PRODUCTS.plus.priceId ||
      process.env.LEMON_PLUS_PRODUCT_ID ||
      ''
    ).trim();
    const proPriceId = String(
      process.env.PADDLE_PRO_PRICE_ID ||
      PADDLE_PRODUCTS.pro.priceId ||
      process.env.LEMON_PRO_PRODUCT_ID ||
      ''
    ).trim();
    return {
      plus: Boolean(plusPriceId),
      pro: Boolean(proPriceId),
    };
  }

  private saveCachedLicense() {
    if (!this.currentLicense) return;
    try {
      const dir = path.dirname(this.licenseFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const json = JSON.stringify(this.currentLicense);
      const encrypted = encryptStoragePayload(json);
      fs.writeFileSync(this.licenseFile, encrypted, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') {
        fs.chmodSync(this.licenseFile, 0o600);
      }
    } catch (e) {
      console.warn('[LicenseManager] Failed to save encrypted license cache:', e);
    }
  }

  public loadCachedLicense(): LicenseRecord | null {
    if (!fs.existsSync(this.licenseFile)) {
      this.currentLicense = null;
      return null;
    }
    try {
      const encrypted = fs.readFileSync(this.licenseFile, 'utf8');
      const decrypted = decryptStoragePayload(encrypted);
      this.currentLicense = JSON.parse(decrypted);
      return this.currentLicense;
    } catch (e) {
      console.warn('[LicenseManager] Failed to load cached license (may be encrypted by unavailable safeStorage or unmigrated):', e);
      return null;
    }
  }

  private postLicensingService(endpoint: string, jsonPayload: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(jsonPayload);
      const baseUrl = getLicensingServiceUrl();
      const parsed = new URL(`${baseUrl}${endpoint}`);
      let version = '1.0.3';
      try {
        const v = app?.getVersion?.();
        if (typeof v === 'string' && v.trim()) version = v.trim();
      } catch {}

      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': `Scandium-Desktop-Assistant/${version}`,
          },
          timeout: 10000,
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            const statusCode = res.statusCode || 0;
            // Transient rate-limits / upstream outages trigger offline grace in validateLicense()
            if (statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
              return reject(new Error(`Scandium Licensing Service transient HTTP ${statusCode}`));
            }
            try {
              const parsedJson = JSON.parse(data);
              resolve(parsedJson);
            } catch (e) {
              reject(new Error(`Licensing service response parse error (HTTP ${statusCode}): ${data.slice(0, 100)}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Scandium Licensing Service request timed out'));
      });

      req.write(postData);
      req.end();
    });
  }
}

export const licenseManager = new LicenseManager();
