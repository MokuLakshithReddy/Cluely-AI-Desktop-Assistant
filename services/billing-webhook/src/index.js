/**
 * Scandium Assistant - Production Lemon Squeezy Webhook Receiver
 *
 * Edge-deployed Cloudflare Worker backed by Upstash Redis for durable,
 * persistent event deduplication and entitlement state synchronization.
 *
 * Enforces:
 * 1. Constant-time HMAC-SHA256 signature verification (X-Signature).
 * 2. Strict replay rejection via Upstash Redis SET NX (7-day TTL).
 * 3. Exact product/variant ID validation (never trusts display names).
 * 4. Canonical state transitions matching Scandium desktop client.
 */

// Constant-time string/hex comparison
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Compute HMAC-SHA256 hex digest using Web Crypto API
async function computeHmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret.trim()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Verify Lemon Squeezy signature
async function verifySignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof secret !== 'string' || !secret.trim()) return false;
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const cleanSig = signatureHeader.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(cleanSig)) return false;
  if (rawBody === undefined || rawBody === null || rawBody.length === 0) return false;

  const expectedHex = await computeHmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expectedHex, cleanSig);
}

// Upstash Redis command runner
async function redisCommand(url, token, command) {
  const res = await fetch(`${url}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash Redis error (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.result;
}

// Resolve tier based on configured product + variant ID pairs
function resolveConfiguredTier(productId, variantId, env) {
  const plusProduct = (env.LEMON_PLUS_PRODUCT_ID || '').trim();
  const plusVariant = (env.LEMON_PLUS_VARIANT_ID || '').trim();
  const proProduct = (env.LEMON_PRO_PRODUCT_ID || '').trim();
  const proVariant = (env.LEMON_PRO_VARIANT_ID || '').trim();

  if (proProduct && proVariant && productId === proProduct && variantId === proVariant) return 'pro';
  if (plusProduct && plusVariant && productId === plusProduct && variantId === plusVariant) return 'plus';
  return 'free';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Root Info
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          service: 'Scandium Billing Webhook Receiver',
          version: '1.0.3',
          status: 'online',
          repository: 'https://github.com/MokuLakshithReddy/Scandium-Assistant',
          docs: 'https://github.com/MokuLakshithReddy/Scandium-Assistant/blob/main/docs/billing/SETUP.md',
        }, null, 2),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Health check with Upstash Redis ping
    if (url.pathname === '/health' && request.method === 'GET') {
      let redisStatus = 'unconfigured';
      if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
        try {
          const pong = await redisCommand(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN, ['PING']);
          redisStatus = pong === 'PONG' ? 'connected' : 'error';
        } catch (err) {
          redisStatus = `failed: ${err.message}`;
        }
      }

      const healthy = redisStatus === 'connected' || redisStatus === 'unconfigured';
      return new Response(
        JSON.stringify({
          status: healthy ? 'healthy' : 'degraded',
          timestamp: new Date().toISOString(),
          edgeRegion: request.cf?.colo || 'local',
          redis: redisStatus,
          lemonSqueezyWebhookConfigured: Boolean(env.LEMON_SQUEEZY_WEBHOOK_SECRET),
        }, null, 2),
        {
          status: healthy ? 200 : 503,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Lemon Squeezy Webhook Ingestion Endpoint
    if (url.pathname === '/api/webhook/lemonsqueezy' && request.method === 'POST') {
      const signatureHeader = request.headers.get('x-signature');
      const webhookSecret = env.LEMON_SQUEEZY_WEBHOOK_SECRET || '';

      const rawBody = await request.text();

      // 1. Verify HMAC-SHA256 signature
      const isValidSig = await verifySignature(rawBody, signatureHeader, webhookSecret);
      if (!isValidSig) {
        return new Response(
          JSON.stringify({ error: 'Invalid or missing Lemon Squeezy webhook signature' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 2. Parse payload
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return new Response(
          JSON.stringify({ error: 'Malformed JSON payload' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const eventName = String(parsed?.meta?.event_name || '').trim();
      const rawEventId = String(parsed?.meta?.custom_data?.event_id || parsed?.data?.id || '').trim();
      const eventTimestamp = String(parsed?.data?.attributes?.updated_at || parsed?.data?.attributes?.created_at || '').trim();
      const eventId = rawEventId ? `${eventName}:${rawEventId}:${eventTimestamp}` : '';

      if (!eventName || !eventId) {
        return new Response(
          JSON.stringify({ error: 'Missing required webhook event metadata (event_name or event_id)' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // 3. Durable Event Deduplication via Upstash Redis SET NX (7-day TTL)
      const redisUrl = env.UPSTASH_REDIS_REST_URL;
      const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

      if (redisUrl && redisToken) {
        const dedupKey = `scandium:webhook:event:${eventId}`;
        // SET key 1 EX 604800 NX (returns 'OK' if newly set, null if key already existed)
        const claim = await redisCommand(redisUrl, redisToken, ['SET', dedupKey, '1', 'EX', '604800', 'NX']);
        if (!claim) {
          return new Response(
            JSON.stringify({
              status: 'duplicate_ignored',
              message: `Event ID ${eventId} was already processed and stored in Upstash Redis deduplication cache.`,
              eventId,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
      }

      // 4. Map entitlement transition
      const attrs = parsed?.data?.attributes || {};
      const productId = String(attrs.product_id ?? '').trim();
      const variantId = String(attrs.variant_id ?? '').trim();
      const resolvedTier = resolveConfiguredTier(productId, variantId, env);
      const status = String(attrs.status || '').trim().toLowerCase();

      let entitlementState = 'disabled';
      if (eventName === 'subscription_payment_failed' || status === 'past_due' || status === 'unpaid') {
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

      const effectiveTier = entitlementState === 'active' ? resolvedTier : 'free';
      const licenseKey = typeof attrs.key === 'string' ? attrs.key.trim() : undefined;
      const userEmail = typeof attrs.user_email === 'string' ? attrs.user_email.trim().toLowerCase() : undefined;
      const subscriptionId = String(attrs.subscription_id || parsed?.data?.id || '').trim();

      const transition = {
        eventId,
        eventName,
        tier: effectiveTier,
        entitlementState,
        productId,
        variantId,
        subscriptionId: subscriptionId || undefined,
        licenseKey: licenseKey || undefined,
        userEmail: userEmail || undefined,
        renewsAt: attrs.renews_at || null,
        endsAt: attrs.ends_at || null,
        processedAt: new Date().toISOString(),
      };

      // 5. Persist synchronized entitlement record to Upstash Redis
      if (redisUrl && redisToken) {
        const payloadJson = JSON.stringify(transition);
        const persistTasks = [];

        if (subscriptionId) {
          persistTasks.push(redisCommand(redisUrl, redisToken, ['SET', `scandium:entitlement:sub:${subscriptionId}`, payloadJson]));
        }
        if (userEmail) {
          persistTasks.push(redisCommand(redisUrl, redisToken, ['SET', `scandium:entitlement:email:${userEmail}`, payloadJson]));
        }
        if (licenseKey) {
          persistTasks.push(redisCommand(redisUrl, redisToken, ['SET', `scandium:entitlement:key:${licenseKey}`, payloadJson]));
        }

        await Promise.all(persistTasks);
      }

      return new Response(
        JSON.stringify({
          status: 'success',
          transition,
        }, null, 2),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },
};
