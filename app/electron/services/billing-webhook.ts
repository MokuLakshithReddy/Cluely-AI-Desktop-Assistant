import crypto from 'crypto';
import { SubscriptionTier } from '../domains/entitlements';
import { BILLING_PRODUCTS } from '../config/billing-products';

export type BillingEntitlementState =
  | 'active'
  | 'cancelled'
  | 'expired'
  | 'past_due'
  | 'disabled';

export interface VerifiedWebhookTransition {
  eventId: string;
  eventName: string;
  tier: SubscriptionTier;
  entitlementState: BillingEntitlementState;
  licenseKey?: string;
  expiresAt?: string | null;
}

/**
 * Verifies a Lemon Squeezy `X-Signature` HMAC-SHA256 webhook header using constant-time comparison.
 * Fails closed when secret, raw body, or signature is missing or malformed.
 */
export function verifyLemonSqueezyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  webhookSecret: string | undefined | null
): boolean {
  if (!webhookSecret || typeof webhookSecret !== 'string' || !webhookSecret.trim()) {
    return false;
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }
  const cleanSig = signatureHeader.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanSig)) {
    return false;
  }
  if (rawBody === undefined || rawBody === null) {
    return false;
  }
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  if (payload.byteLength === 0) {
    return false;
  }

  const expectedHex = crypto
    .createHmac('sha256', webhookSecret.trim())
    .update(payload)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(cleanSig, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Bounded idempotency / replay protection store for processed webhook event IDs.
 */
export class WebhookEventDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries: number = 10_000,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000
  ) {}

  /**
   * Returns true if the event ID has NOT been processed yet (and records it),
   * or false if it is a duplicate/replay.
   */
  public claimEvent(eventId: string, now: number = Date.now()): boolean {
    const cleanId = typeof eventId === 'string' ? eventId.trim() : '';
    if (!cleanId) return false;

    this.prune(now);
    if (this.seen.has(cleanId)) {
      return false;
    }

    if (this.seen.size >= this.maxEntries) {
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) {
        this.seen.delete(oldestKey);
      }
    }

    this.seen.set(cleanId, now);
    return true;
  }

  private prune(now: number): void {
    for (const [id, ts] of this.seen.entries()) {
      if (now - ts > this.ttlMs) {
        this.seen.delete(id);
      }
    }
  }
}

function resolveConfiguredTier(productId: string, variantId: string): SubscriptionTier {
  const plusProductId = String(process.env.LEMON_PLUS_PRODUCT_ID || BILLING_PRODUCTS.plus.productId || '').trim();
  const plusVariantId = String(process.env.LEMON_PLUS_VARIANT_ID || BILLING_PRODUCTS.plus.variantId || '').trim();
  const proProductId = String(process.env.LEMON_PRO_PRODUCT_ID || BILLING_PRODUCTS.pro.productId || '').trim();
  const proVariantId = String(process.env.LEMON_PRO_VARIANT_ID || BILLING_PRODUCTS.pro.variantId || '').trim();

  if (proProductId && proVariantId && productId === proProductId && variantId === proVariantId) return 'pro';
  if (plusProductId && plusVariantId && productId === plusProductId && variantId === plusVariantId) return 'plus';
  return 'free';
}

/**
 * Parses and validates a verified Lemon Squeezy webhook payload into a canonical entitlement transition.
 * Never trusts display names; requires exact configured product+variant ID pairs.
 */
export function parseVerifiedLemonSqueezyWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  webhookSecret: string | undefined | null,
  deduplicator?: WebhookEventDeduplicator
): VerifiedWebhookTransition {
  if (!verifyLemonSqueezyWebhookSignature(rawBody, signatureHeader, webhookSecret)) {
    throw new Error('[BillingWebhook] Invalid or missing webhook HMAC-SHA256 signature');
  }

  let parsed: any;
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    parsed = JSON.parse(text);
  } catch {
    throw new Error('[BillingWebhook] Malformed webhook JSON payload');
  }

  const eventName = String(parsed?.meta?.event_name || '').trim();
  const rawEventId = String(parsed?.meta?.custom_data?.event_id || parsed?.data?.id || '').trim();
  const eventTimestamp = String(parsed?.data?.attributes?.updated_at || parsed?.data?.attributes?.created_at || '').trim();
  const eventId = rawEventId ? `${eventName}:${rawEventId}:${eventTimestamp}` : '';

  if (!eventName || !eventId) {
    throw new Error('[BillingWebhook] Missing required webhook event metadata');
  }

  if (deduplicator && !deduplicator.claimEvent(eventId)) {
    throw new Error(`[BillingWebhook] Duplicate webhook event rejected: ${eventId}`);
  }

  const attrs = parsed?.data?.attributes || {};
  const productId = String(attrs.product_id ?? '').trim();
  const variantId = String(attrs.variant_id ?? '').trim();
  const resolvedTier = resolveConfiguredTier(productId, variantId);
  const status = String(attrs.status || '').trim().toLowerCase();

  let entitlementState: BillingEntitlementState = 'disabled';
  if (
    eventName === 'subscription_payment_failed' ||
    status === 'past_due' ||
    status === 'unpaid'
  ) {
    entitlementState = 'past_due';
  } else if (eventName === 'subscription_expired' || status === 'expired') {
    entitlementState = 'expired';
  } else if (eventName === 'subscription_cancelled' || status === 'cancelled') {
    entitlementState = 'cancelled';
  } else if (
    (eventName === 'subscription_created' ||
      eventName === 'subscription_updated' ||
      eventName === 'subscription_payment_success' ||
      eventName === 'license_key_updated') &&
    (status === 'active' || status === 'on_trial') &&
    resolvedTier !== 'free'
  ) {
    entitlementState = 'active';
  }

  const effectiveTier: SubscriptionTier = entitlementState === 'active' ? resolvedTier : 'free';

  return {
    eventId,
    eventName,
    tier: effectiveTier,
    entitlementState,
    licenseKey: typeof attrs.key === 'string' ? attrs.key : undefined,
    expiresAt: attrs.ends_at ?? attrs.renews_at ?? attrs.expires_at ?? null,
  };
}
