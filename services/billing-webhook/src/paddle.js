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
 * Normalizes a verified Paddle webhook event into a canonical transition,
 * strictly distinguishing between Subscriptions, Transactions, and Adjustments.
 */
export function parsePaddleEvent(parsed, env) {
  const eventName = String(parsed?.event_type || '').trim();
  const eventId = String(parsed?.event_id || '').trim();
  const occurredAt = String(parsed?.occurred_at || '').trim();

  if (!eventName || !eventId) {
    throw new Error('Missing event_type or event_id in Paddle webhook payload');
  }

  const data = parsed?.data || {};
  const status = String(data.status || '').trim().toLowerCase();

  // Distinguish entity IDs according to Paddle Billing domain models:
  // - Subscriptions (sub_...): data.id is subscription ID.
  // - Transactions (txn_...): data.id is transaction ID; data.subscription_id is subscription ID (if recurring).
  // - Adjustments (adj_...): data.id is adjustment ID; data.transaction_id & data.subscription_id relate to target.
  let subscriptionId;
  let transactionId;
  let adjustmentId;
  let customerId;

  if (eventName.startsWith('subscription.')) {
    subscriptionId = String(data.id || '').trim() || undefined;
    customerId = String(data.customer_id || '').trim() || undefined;
  } else if (eventName.startsWith('transaction.')) {
    transactionId = String(data.id || '').trim() || undefined;
    customerId = String(data.customer_id || '').trim() || undefined;
    if (data.subscription_id) {
      subscriptionId = String(data.subscription_id).trim() || undefined;
    }
  } else if (eventName.startsWith('adjustment.')) {
    adjustmentId = String(data.id || '').trim() || undefined;
    customerId = String(data.customer_id || '').trim() || undefined;
    if (data.transaction_id) {
      transactionId = String(data.transaction_id).trim() || undefined;
    }
    if (data.subscription_id) {
      subscriptionId = String(data.subscription_id).trim() || undefined;
    }
  } else if (eventName.startsWith('customer.')) {
    customerId = String(data.id || '').trim() || undefined;
  } else {
    // Generic fallback: check prefix
    const id = String(data.id || '').trim();
    if (id.startsWith('sub_')) subscriptionId = id;
    else if (id.startsWith('txn_')) transactionId = id;
    else if (id.startsWith('adj_')) adjustmentId = id;
    else if (id.startsWith('ctm_')) customerId = id;
    else subscriptionId = id || undefined;
    if (data.customer_id) {
      customerId = String(data.customer_id).trim() || customerId;
    }
  }

  // Extract price ID from line items or direct field
  const items = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.details?.line_items)
    ? data.details.line_items
    : [];
  const primaryItem = items[0] || {};
  const priceId = String(
    primaryItem.price?.id || primaryItem.price_id || data.price_id || ''
  ).trim();
  const resolvedTier = resolvePaddleTier(priceId, env);

  // Transition & Entitlement State determination
  let entitlementState = 'disabled';
  let effectiveTier = 'free';
  let isIgnored = false;
  let ignoreReason;

  if (eventName.startsWith('adjustment.')) {
    const action = String(data.action || '').trim().toLowerCase();
    const adjStatus = status; // 'pending_approval', 'approved', 'rejected', 'reversed'

    if (adjStatus === 'pending_approval') {
      // Per Paddle docs, refund requests require approval before money is returned.
      // Do not revoke customer access while adjustment is pending review.
      isIgnored = true;
      ignoreReason = 'adjustment_pending_approval';
      entitlementState = 'active'; // preserve state
      effectiveTier = resolvedTier;
    } else if (adjStatus === 'rejected') {
      // Refund was rejected; access remains intact.
      isIgnored = true;
      ignoreReason = 'adjustment_rejected';
      entitlementState = 'active';
      effectiveTier = resolvedTier;
    } else if (adjStatus === 'reversed' || action === 'chargeback_reverse' || action === 'chargeback_reversed') {
      // Per Paddle docs, chargeback reversals carry status: 'reversed' (or action: 'chargeback_reverse')
      // Dispute was resolved in merchant's favor; restore customer access
      entitlementState = 'active';
      effectiveTier = resolvedTier;
    } else if (adjStatus === 'approved') {
      if (action === 'refund' || action === 'credit' || action === 'chargeback') {
        entitlementState = 'refunded';
        effectiveTier = 'free';
      }
    }
  } else if (eventName.startsWith('customer.')) {
    isIgnored = false;
    entitlementState = 'customer_sync';
    effectiveTier = 'free';
  } else if (
    eventName === 'subscription.past_due' ||
    eventName === 'transaction.payment_failed' ||
    eventName === 'transaction.past_due' ||
    status === 'past_due'
  ) {
    // Per Paddle provisioning guidance: retain customer access during dunning/recovery period
    // while notifying client of past_due state rather than abruptly downgrading to free.
    entitlementState = 'past_due';
    effectiveTier = resolvedTier !== 'free' ? resolvedTier : 'plus'; // retain access during recovery
  } else if (
    eventName === 'subscription.canceled' ||
    status === 'canceled'
  ) {
    entitlementState = 'cancelled';
    effectiveTier = 'free';
  } else if (
    eventName === 'subscription.paused' ||
    status === 'paused'
  ) {
    entitlementState = 'disabled';
    effectiveTier = 'free';
  } else if (
    (eventName.startsWith('subscription.') || eventName.startsWith('transaction.')) &&
    (status === 'active' || status === 'trialing' || status === 'completed' || status === 'paid') &&
    resolvedTier !== 'free'
  ) {
    entitlementState = 'active';
    effectiveTier = resolvedTier;
  }

  const customData = data.custom_data || {};
  const licenseKey = typeof customData.scandium_license_key === 'string'
    ? customData.scandium_license_key.trim()
    : undefined;

  const currentPeriod = data.current_billing_period || {};
  const expiresAt = currentPeriod.ends_at || data.next_billed_at || null;
  const customerEmail = data.email || data.customer?.email || customData.email || undefined;
  const customerName = data.name || data.customer?.name || customData.name || undefined;

  return {
    eventId,
    eventName,
    tier: effectiveTier,
    entitlementState,
    priceId: priceId || undefined,
    subscriptionId,
    transactionId,
    adjustmentId,
    customerId,
    licenseKey,
    customerEmail,
    customerName,
    expiresAt,
    occurredAt: occurredAt || new Date().toISOString(),
    isIgnored,
    ignoreReason,
  };
}
