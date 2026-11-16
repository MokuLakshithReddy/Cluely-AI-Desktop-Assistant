import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import { app } from 'electron';
import { SubscriptionTier, TierEntitlements, getEntitlements } from '../domains/entitlements';
import { encryptStoragePayload, decryptStoragePayload } from './storage-encryption';
import { BILLING_PRODUCTS } from '../config/billing-products';

export interface LicenseRecord {
  licenseKey: string;
  instanceId: string;
  instanceName: string;
  status: 'active' | 'inactive' | 'expired' | 'disabled' | 'grace_period';
  tier: SubscriptionTier;
  customerName?: string;
  customerEmail?: string;
  activationLimit: number;
  activationUsage: number;
  expiresAt: string | null;
  lastValidatedAt: number;
  graceRemainingDays?: number;
}

export class LicenseManager {
  private licenseFile: string;
  private currentLicense: LicenseRecord | null = null;
  private readonly GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private readonly LEMON_API_BASE = 'https://api.lemonsqueezy.com/v1/licenses';

  constructor() {
    const baseDir = app?.getPath ? app.getPath('userData') : path.join(process.cwd(), '.scandium');
    this.licenseFile = path.join(baseDir, 'scandium-license.enc');
    this.loadCachedLicense();
  }

  public getHardwareFingerprint(): string {
    const parts = [
      os.hostname(),
      os.platform(),
      os.arch(),
      os.cpus().length.toString(),
      os.totalmem().toString(),
    ];
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
  }

  public getInstanceName(): string {
    const fp = this.getHardwareFingerprint();
    return `Scandium-${os.platform()}-${fp.slice(0, 8)}`;
  }

  public getCurrentTier(): SubscriptionTier {
    if (!this.currentLicense) return 'free';

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

  public getLicenseStatus(): {
    hasLicense: boolean;
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
    const instanceName = this.getInstanceName();
    if (!this.currentLicense) {
      return {
        hasLicense: false,
        tier: 'free',
        status: 'none',
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
      licenseKeyMasked: masked,
      expiresAt: this.currentLicense.expiresAt,
      customerEmail: this.currentLicense.customerEmail,
      activationLimit: this.currentLicense.activationLimit,
      activationUsage: this.currentLicense.activationUsage,
      graceRemainingDays: this.currentLicense.status === 'grace_period' ? graceRemainingDays : undefined,
      instanceName,
    };
  }

  public async activateLicense(licenseKey: string): Promise<LicenseRecord> {
    const trimmed = licenseKey.trim();
    if (!trimmed) throw new Error('License key cannot be empty');

    const instanceName = this.getInstanceName();
    const payload = new URLSearchParams({
      license_key: trimmed,
      instance_name: instanceName,
    });

    const res = await this.postLemonSqueezy('/activate', payload);
    if (!res.activated) {
      throw new Error(res.error || 'Failed to activate license key');
    }

    const lk = res.license_key || {};
    const instance = res.instance || {};
    const meta = res.meta || {};

    const tier = this.resolveTierFromMeta(meta);
    if (tier === 'free') {
      throw new Error('This license does not match a configured Scandium Plus or Pro product. Verify the exact product and variant IDs before activating it.');
    }

    const record: LicenseRecord = {
      licenseKey: trimmed,
      instanceId: instance.id || '',
      instanceName,
      status: lk.status === 'active' ? 'active' : 'inactive',
      tier,
      customerName: meta.customer_name,
      customerEmail: meta.customer_email,
      activationLimit: lk.activation_limit || 1,
      activationUsage: lk.activation_usage || 1,
      expiresAt: lk.expires_at || null,
      lastValidatedAt: Date.now(),
    };

    this.currentLicense = record;
    this.saveCachedLicense();
    return record;
  }

  public async validateLicense(): Promise<LicenseRecord | null> {
    if (!this.currentLicense) return null;

    // Check anti-tamper on system clock
    if (Date.now() < this.currentLicense.lastValidatedAt - 60000) {
      console.warn('[LicenseManager] Detected system clock rollback. Failing validation.');
      this.currentLicense.status = 'expired';
      this.saveCachedLicense();
      return this.currentLicense;
    }

    const payload = new URLSearchParams({
      license_key: this.currentLicense.licenseKey,
      instance_id: this.currentLicense.instanceId,
    });

    try {
      const res = await this.postLemonSqueezy('/validate', payload);
      const lk = res.license_key || {};
      const isValid = res.valid === true && lk.status === 'active';

      if (isValid) {
        const verifiedTier = this.resolveTierFromMeta(res.meta || {});
        if (verifiedTier === 'free') {
          this.currentLicense.tier = 'free';
          this.currentLicense.status = 'disabled';
          this.saveCachedLicense();
          return this.currentLicense;
        }
        this.currentLicense.tier = verifiedTier;
        this.currentLicense.status = 'active';
        this.currentLicense.expiresAt = lk.expires_at || null;
        this.currentLicense.activationLimit = lk.activation_limit || this.currentLicense.activationLimit;
        this.currentLicense.activationUsage = lk.activation_usage || this.currentLicense.activationUsage;
        this.currentLicense.lastValidatedAt = Date.now();
      } else {
        this.currentLicense.status = lk.status || 'expired';
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

  public async deactivateLicense(): Promise<void> {
    if (!this.currentLicense) return;

    try {
      const payload = new URLSearchParams({
        license_key: this.currentLicense.licenseKey,
        instance_id: this.currentLicense.instanceId,
      });
      await this.postLemonSqueezy('/deactivate', payload);
    } catch (e) {
      console.warn('[LicenseManager] Deactivation remote notice failed:', e);
    } finally {
      this.currentLicense = null;
      if (fs.existsSync(this.licenseFile)) {
        try { fs.unlinkSync(this.licenseFile); } catch {}
      }
    }
  }

  private resolveTierFromMeta(meta: any): SubscriptionTier {
    const productId = String(meta?.product_id ?? '').trim();
    const variantId = String(meta?.variant_id ?? '').trim();

    // Exact product + variant pairs are required. Display names can be changed
    // by the store owner and must never be used to grant paid entitlements.
    const plusProductId = String(process.env.LEMON_PLUS_PRODUCT_ID || BILLING_PRODUCTS.plus.productId || '').trim();
    const plusVariantId = String(process.env.LEMON_PLUS_VARIANT_ID || BILLING_PRODUCTS.plus.variantId || '').trim();
    const proProductId = String(process.env.LEMON_PRO_PRODUCT_ID || BILLING_PRODUCTS.pro.productId || '').trim();
    const proVariantId = String(process.env.LEMON_PRO_VARIANT_ID || BILLING_PRODUCTS.pro.variantId || '').trim();

    const plusConfigured = Boolean(plusProductId && plusVariantId);
    const proConfigured = Boolean(proProductId && proVariantId);

    if (proConfigured && productId === proProductId && variantId === proVariantId) return 'pro';
    if (plusConfigured && productId === plusProductId && variantId === plusVariantId) return 'plus';

    // Unknown, unconfigured or mismatched pairs always fail closed to Free.
    console.warn('[LicenseManager] Unrecognized or unconfigured product/variant pair. Failing closed to Free tier:', {
      productId, variantId, plusConfigured, proConfigured,
    });
    return 'free';
  }

  private saveCachedLicense() {
    if (!this.currentLicense) return;
    try {
      const json = JSON.stringify(this.currentLicense);
      const encrypted = encryptStoragePayload(json);
      fs.writeFileSync(this.licenseFile, encrypted, 'utf8');
    } catch (e) {
      console.warn('[LicenseManager] Failed to save encrypted license cache:', e);
    }
  }

  private loadCachedLicense() {
    if (!fs.existsSync(this.licenseFile)) return;
    try {
      const encrypted = fs.readFileSync(this.licenseFile, 'utf8');
      const decrypted = decryptStoragePayload(encrypted);
      this.currentLicense = JSON.parse(decrypted);
    } catch (e) {
      console.warn('[LicenseManager] Failed to load cached license (may be corrupted or unmigrated):', e);
      this.currentLicense = null;
    }
  }

  private postLemonSqueezy(endpoint: string, params: URLSearchParams): Promise<any> {
    return new Promise((resolve, reject) => {
      const postData = params.toString();
      const parsed = new URL(`${this.LEMON_API_BASE}${endpoint}`);

      const req = https.request(
        {
          hostname: parsed.hostname,
          path: parsed.pathname,
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'User-Agent': 'Scandium-Desktop-Assistant/1.0.2',
          },
          timeout: 10000,
        },
        res => {
          let data = '';
          res.on('data', chunk => (data += chunk));
          res.on('end', () => {
            try {
              const parsedJson = JSON.parse(data);
              resolve(parsedJson);
            } catch (e) {
              reject(new Error(`Lemon Squeezy response parse error: ${data.slice(0, 100)}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Lemon Squeezy API request timed out'));
      });

      req.write(postData);
      req.end();
    });
  }
}

export const licenseManager = new LicenseManager();
