import crypto from 'crypto';
import { SubscriptionTier } from '../domains/entitlements';
import { PADDLE_PRODUCTS, BILLING_PRODUCTS } from '../config/billing-products';

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
  customerEmail?: string;
  subscriptionId?: string;
  priceId?: string;
  expiresAt?: string | null;
  occurredAt?: string;
}

/**
 * Verifies a Paddle Billing `Paddle-Signature` webhook header.
 * Paddle format: `ts=1671552777;h1=0b968798083896593a8d672...`
 * Signed data is `${ts}:${rawBody}` using HMAC-SHA256 with the notification secret key.
 * Enforces constant-time comparison and timestamp tolerance (default: 300s).
 */
export function verifyPaddleWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secretKey: string | undefined | null,
  toleranceSeconds: number = 300
): boolean {
  if (!secretKey || typeof secretKey !== 'string' || !secretKey.trim()) {
    return false;
  }
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }
  if (rawBody === undefined || rawBody === null) {
    return false;
  }

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  if (payload.length === 0) {
    return false;
  }

  // Parse `ts=...;h1=...`
  const parts = signatureHeader.split(';').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > 0) {
      acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return acc;
  }, {});

  const tsStr = parts.ts;
  const h1 = parts.h1?.toLowerCase();

  if (!tsStr || !h1 || !/^\d+$/.test(tsStr) || !/^[a-f0-9]{64}$/.test(h1)) {
    return false;
  }

  const timestamp = parseInt(tsStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    // Expired or clock-skewed webhook timestamp
    return false;
  }

  const signedPayload = `${tsStr}:${payload}`;
  const expectedHex = crypto
    .createHmac('sha256', secretKey.trim())
    .update(signedPayload, 'utf8')
    .digest('hex');

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(h1, 'hex');

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Reusable webhook verification and event-mapping deduplicator.
 */
export class WebhookEventDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly maxEntries: number = 10_000,
    private readonly ttlMs: number = 24 * 60 * 60 * 1000
  ) {}

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

function resolveConfiguredPaddleTier(priceId: string): SubscriptionTier {
  const plusPrice = String(process.env.PADDLE_PLUS_PRICE_ID || PADDLE_PRODUCTS.plus.priceId || '').trim();
  const proPrice = String(process.env.PADDLE_PRO_PRICE_ID || PADDLE_PRODUCTS.pro.priceId || '').trim();

  if (proPrice && priceId === proPrice) return 'pro';
  if (plusPrice && priceId === plusPrice) return 'plus';
  return 'free';
}

/**
 * Parses and validates a verified Paddle Billing webhook payload into a canonical entitlement transition.
 * Supports subscription lifecycle events and transaction events.
 */
export function parseVerifiedPaddleWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secretKey: string | undefined | null,
  deduplicator?: WebhookEventDeduplicator
): VerifiedWebhookTransition {
  if (!verifyPaddleWebhookSignature(rawBody, signatureHeader, secretKey)) {
    throw new Error('[BillingWebhook] Invalid or missing Paddle webhook signature');
  }

  let parsed: any;
  try {
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    parsed = JSON.parse(text);
  } catch {
    throw new Error('[BillingWebhook] Malformed webhook JSON payload');
  }

  const eventName = String(parsed?.event_type || '').trim();
  const eventId = String(parsed?.event_id || '').trim();
  const occurredAt = String(parsed?.occurred_at || '').trim();

  if (!eventName || !eventId) {
    throw new Error('[BillingWebhook] Missing required Paddle event metadata (event_type or event_id)');
  }

  if (deduplicator && !deduplicator.claimEvent(eventId)) {
    throw new Error(`[BillingWebhook] Duplicate webhook event rejected: ${eventId}`);
  }

  const data = parsed?.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const primaryItem = items[0] || {};
  const priceId = String(primaryItem.price?.id || primaryItem.price_id || data.price_id || '').trim();
  const resolvedTier = resolveConfiguredPaddleTier(priceId);
  const status = String(data.status || '').trim().toLowerCase();

  let entitlementState: BillingEntitlementState = 'disabled';
  if (
    eventName === 'subscription.past_due' ||
    eventName === 'transaction.payment_failed' ||
    status === 'past_due'
  ) {
    entitlementState = 'past_due';
  } else if (
    eventName === 'subscription.canceled' ||
    status === 'canceled'
  ) {
    entitlementState = 'cancelled';
  } else if (
    eventName === 'adjustment.created' ||
    eventName === 'adjustment.updated'
  ) {
    const action = String(data.action || '').toLowerCase();
    if (action === 'refund' || action === 'chargeback') {
      entitlementState = 'cancelled';
    }
  } else if (
    (eventName === 'subscription.created' ||
      eventName === 'subscription.activated' ||
      eventName === 'subscription.updated' ||
      eventName === 'subscription.resumed' ||
      eventName === 'transaction.completed' ||
      eventName === 'transaction.paid') &&
    (status === 'active' || status === 'trialing' || status === 'completed' || status === 'paid') &&
    resolvedTier !== 'free'
  ) {
    entitlementState = 'active';
  }

  const effectiveTier: SubscriptionTier = entitlementState === 'active' ? resolvedTier : 'free';
  const customData = data.custom_data || {};
  const licenseKey = typeof customData.scandium_license_key === 'string'
    ? customData.scandium_license_key.trim()
    : undefined;

  const currentPeriod = data.current_billing_period || {};
  const expiresAt = currentPeriod.ends_at || data.next_billed_at || null;

  return {
    eventId,
    eventName,
    tier: effectiveTier,
    entitlementState,
    priceId: priceId || undefined,
    subscriptionId: String(data.id || '').trim() || undefined,
    licenseKey,
    customerEmail: data.customer?.email || customData.email || undefined,
    expiresAt,
    occurredAt: occurredAt || undefined,
  };
}

/**
 * Backward-compatibility: Verifies a Lemon Squeezy `X-Signature` HMAC-SHA256 webhook header.
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
 * Backward-compatibility: Parses and validates a legacy Lemon Squeezy webhook payload.
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

  const plusProductId = String(process.env.LEMON_PLUS_PRODUCT_ID || BILLING_PRODUCTS.plus.productId || '').trim();
  const plusVariantId = String(process.env.LEMON_PLUS_VARIANT_ID || BILLING_PRODUCTS.plus.variantId || '').trim();
  const proProductId = String(process.env.LEMON_PRO_PRODUCT_ID || BILLING_PRODUCTS.pro.productId || '').trim();
  const proVariantId = String(process.env.LEMON_PRO_VARIANT_ID || BILLING_PRODUCTS.pro.variantId || '').trim();

  let resolvedTier: SubscriptionTier = 'free';
  if (proProductId && proVariantId && productId === proProductId && variantId === proVariantId) resolvedTier = 'pro';
  else if (plusProductId && plusVariantId && productId === plusProductId && variantId === plusVariantId) resolvedTier = 'plus';

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
    customerEmail: typeof attrs.user_email === 'string' ? attrs.user_email : undefined,
    expiresAt: attrs.ends_at ?? attrs.renews_at ?? attrs.expires_at ?? null,
  };
}
