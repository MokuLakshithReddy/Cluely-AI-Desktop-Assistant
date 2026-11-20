import { timingSafeEqual, hmacSha256Hex } from './crypto.js';

/**
 * Verifies Paddle Billing webhook signature header.
 * Paddle format: `ts=1671552777;h1=0b968798083896593a8d672...`
 * Signed string is `${ts}:${rawBody}`.
 */
export async function verifyPaddleSignature(
  rawBody,
  signatureHeader,
  secretKey,
  toleranceSeconds = 300
) {
  if (!secretKey || typeof secretKey !== 'string' || !secretKey.trim()) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (rawBody === undefined || rawBody === null || rawBody.length === 0) return false;

  const parts = signatureHeader.split(';').reduce((acc, part) => {
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
    return false;
  }

  const signedPayload = `${tsStr}:${rawBody}`;
  const expectedHex = await hmacSha256Hex(secretKey.trim(), signedPayload);

  return timingSafeEqual(expectedHex, h1);
}

export function resolvePaddleTier(priceId, env) {
  const plusPrice = (env.PADDLE_PLUS_PRICE_ID || '').trim();
  const proPrice = (env.PADDLE_PRO_PRICE_ID || '').trim();

  if (proPrice && priceId === proPrice) return 'pro';
  if (plusPrice && priceId === plusPrice) return 'plus';
  return 'free';
}

/**
 * Normalizes a verified Paddle webhook event into a canonical subscription transition.
 */
export function parsePaddleEvent(parsed, env) {
  const eventName = String(parsed?.event_type || '').trim();
  const eventId = String(parsed?.event_id || '').trim();
  const occurredAt = String(parsed?.occurred_at || '').trim();

  if (!eventName || !eventId) {
    throw new Error('Missing event_type or event_id in Paddle webhook payload');
  }

  const data = parsed?.data || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const primaryItem = items[0] || {};
  const priceId = String(primaryItem.price?.id || primaryItem.price_id || data.price_id || '').trim();
  const resolvedTier = resolvePaddleTier(priceId, env);
  const status = String(data.status || '').trim().toLowerCase();

  let entitlementState = 'disabled';
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

  const effectiveTier = entitlementState === 'active' ? resolvedTier : 'free';
  const customData = data.custom_data || {};
  const licenseKey = typeof customData.scandium_license_key === 'string'
    ? customData.scandium_license_key.trim()
    : undefined;

  const currentPeriod = data.current_billing_period || {};
  const expiresAt = currentPeriod.ends_at || data.next_billed_at || null;
  const customerEmail = data.customer?.email || customData.email || undefined;
  const subscriptionId = String(data.id || '').trim() || undefined;

  return {
    eventId,
    eventName,
    tier: effectiveTier,
    entitlementState,
    priceId: priceId || undefined,
    subscriptionId,
    licenseKey,
    customerEmail,
    expiresAt,
    occurredAt: occurredAt || new Date().toISOString(),
  };
}
