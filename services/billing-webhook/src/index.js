/**
 * Scandium Assistant - Provider-Independent Licensing & Paddle Webhook Service
 *
 * Edge Cloudflare Worker architecture:
 * 1. Paddle Billing Webhook Ingestion with HMAC-SHA256 & replay timestamp protection.
 * 2. Atomic event deduplication and out-of-order event protection on Upstash Redis.
 * 3. Provider-independent licensing service (activation, validation, deactivation).
 * 4. Asymmetric Ed25519 cryptographic signing of client entitlement responses.
 * 5. Strict fail-closed health reporting.
 */

import { sha256Hex } from './crypto.js';
import { verifyPaddleSignature, parsePaddleEvent } from './paddle.js';
import {
  redisCommand,
  isEventProcessed,
  markEventProcessed,
  isEventNewer,
  getSubscription,
  saveSubscription,
  saveLicenseByHash,
} from './storage.js';
import {
  handleActivate,
  handleValidate,
  handleDeactivate,
} from './licensing.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function generateLicenseKey(tier) {
  const prefix = tier === 'pro' ? 'SCANDIUM-PRO' : 'SCANDIUM-PLUS';
  const randA = crypto.randomUUID().slice(0, 8).toUpperCase();
  const randB = crypto.randomUUID().slice(9, 13).toUpperCase();
  return `${prefix}-${randA}-${randB}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Root info
    if (url.pathname === '/' && request.method === 'GET') {
      return jsonResponse({
        service: 'Scandium Licensing & Paddle Webhook Backend',
        version: '1.0.3',
        status: 'online',
        provider: 'Paddle Billing (Merchant of Record)',
        architecture: 'provider-independent',
        repository: 'https://github.com/MokuLakshithReddy/Scandium-Assistant',
        docs: 'https://github.com/MokuLakshithReddy/Scandium-Assistant/blob/main/docs/billing/SETUP.md',
      });
    }

    // Health check distinguishing all subsystem dependencies
    if (url.pathname === '/health' && request.method === 'GET') {
      let redisStatus = 'unconfigured';
      if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
        try {
          const pong = await redisCommand(env, ['PING']);
          redisStatus = pong === 'PONG' ? 'connected' : 'error';
        } catch (err) {
          redisStatus = `failed: ${err.message}`;
        }
      }

      const paddleConfigured = Boolean(env.PADDLE_WEBHOOK_SECRET_KEY?.trim());
      const signingKeyConfigured = Boolean(env.SCANDIUM_LICENSING_PRIVATE_KEY?.trim());
      const isHealthy = redisStatus === 'connected' && paddleConfigured && signingKeyConfigured;

      return jsonResponse(
        {
          status: isHealthy ? 'healthy' : 'degraded',
          timestamp: new Date().toISOString(),
          edgeRegion: request.cf?.colo || 'local',
          subsystems: {
            redis: redisStatus,
            paddleWebhook: paddleConfigured ? 'configured' : 'unconfigured',
            licensingSigningKey: signingKeyConfigured ? 'configured' : 'unconfigured',
          },
          productionReady: isHealthy,
        },
        isHealthy ? 200 : 503
      );
    }

    // Official Paddle Billing Webhook Ingestion Endpoint
    if (url.pathname === '/api/webhook/paddle' && request.method === 'POST') {
      const signatureHeader = request.headers.get('paddle-signature');
      const webhookSecret = env.PADDLE_WEBHOOK_SECRET_KEY || '';

      const rawBody = await request.text();

      // 1. Signature & replay protection check
      const isValidSig = await verifyPaddleSignature(rawBody, signatureHeader, webhookSecret);
      if (!isValidSig) {
        return jsonResponse({ error: 'Invalid or missing Paddle webhook signature' }, 401);
      }

      // 2. Parse payload
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ error: 'Malformed JSON payload' }, 400);
      }

      let transition;
      try {
        transition = parsePaddleEvent(parsed, env);
      } catch (err) {
        return jsonResponse({ error: err.message }, 400);
      }

      // 3. Deduplication check
      const eventId = transition.eventId;
      const alreadyProcessed = await isEventProcessed(env, eventId);
      if (alreadyProcessed) {
        return jsonResponse({
          status: 'duplicate_ignored',
          eventId,
          message: 'Event was already processed',
        });
      }

      // 4. Out-of-order check
      let activeKey = transition.licenseKey;
      if (transition.subscriptionId) {
        const existing = await getSubscription(env, transition.subscriptionId);
        if (existing) {
          // If the incoming event is older than our existing record, do not overwrite newer state
          if (!isEventNewer(existing.occurredAt, transition.occurredAt)) {
            // Acknowledge delivery to Paddle so it doesn't retry
            await markEventProcessed(env, eventId);
            return jsonResponse({
              status: 'out_of_order_ignored',
              eventId,
              message: 'Existing subscription state is newer than incoming event',
            });
          }
          if (!activeKey && existing.licenseKey) {
            activeKey = existing.licenseKey;
          }
        }
      }

      // 5. Generate secure license key if not present
      if (!activeKey) {
        activeKey = generateLicenseKey(transition.tier);
      }

      // 6. Persist subscription and license records
      const licenseRecord = {
        licenseKey: activeKey,
        subscriptionId: transition.subscriptionId,
        tier: transition.tier,
        status: transition.entitlementState,
        customerEmail: transition.customerEmail,
        priceId: transition.priceId,
        expiresAt: transition.expiresAt,
        occurredAt: transition.occurredAt,
        updatedAt: new Date().toISOString(),
      };

      if (transition.subscriptionId) {
        await saveSubscription(env, transition.subscriptionId, licenseRecord);
      }

      const keyHash = await sha256Hex(activeKey);
      await saveLicenseByHash(env, keyHash, licenseRecord);

      if (transition.customerEmail) {
        await redisCommand(env, [
          'SET',
          `scandium:customer:${transition.customerEmail.toLowerCase().trim()}`,
          activeKey,
        ]);
      }

      // 7. Mark event as processed (only AFTER successful persistence)
      await markEventProcessed(env, eventId);

      return jsonResponse({
        status: 'success',
        transition,
        licenseKey: activeKey,
      });
    }

    // Provider-Independent Desktop Client Licensing Endpoints
    if (url.pathname === '/api/v1/license/activate' && request.method === 'POST') {
      return await handleActivate(request, env);
    }

    if (url.pathname === '/api/v1/license/validate' && request.method === 'POST') {
      return await handleValidate(request, env);
    }

    if (url.pathname === '/api/v1/license/deactivate' && request.method === 'POST') {
      return await handleDeactivate(request, env);
    }

    return jsonResponse({ error: 'Endpoint not found' }, 404);
  },
};
