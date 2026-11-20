/**
 * Scandium Assistant - Provider-Independent Licensing & Paddle Webhook Service
 *
 * Edge Cloudflare Worker architecture:
 * 1. Paddle Billing Webhook Ingestion with HMAC-SHA256 & replay timestamp protection.
 * 2. Atomic event deduplication and out-of-order event protection on Upstash Redis.
 * 3. 192-bit CSPRNG high-entropy commercial license keys.
 * 4. Provider-independent licensing service (activation, validation, deactivation, self-service claim).
 * 5. Customer license delivery via transactional email and self-service claim portal.
 * 6. Asymmetric Ed25519 cryptographic signing of client entitlement responses.
 * 7. Strict fail-closed health reporting.
 */

import { sha256Hex, generateStrongLicenseKey } from './crypto.js';
import { verifyPaddleSignature, parsePaddleEvent } from './paddle.js';
import {
  redisCommand,
  tryAcquireEventLock,
  finalizeEventProcessed,
  releaseEventLock,
  isEventNewer,
  getSubscription,
  saveSubscription,
  getTransaction,
  saveTransaction,
  saveLicenseByHash,
  getLicenseByHash,
} from './storage.js';
import {
  handleActivate,
  handleValidate,
  handleDeactivate,
  handleClaim,
} from './licensing.js';
import { dispatchLicenseDelivery } from './notifications.js';

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function getPaddleWebhookSecret(env) {
  return (env.PADDLE_WEBHOOK_SECRET_KEY || env.PADDLE_WEBHOOK_SECRET || '').trim();
}

function renderClaimHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scandium &mdash; License Claim</title>
<style>
:root{color-scheme:dark;--line:rgba(153,177,207,.2);--muted:#9aaac0;--text:#edf4ff;--cyan:#64e6e1;--green:#79e2b3}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);background:radial-gradient(ellipse at 12% 0%,rgba(31,183,194,.15),transparent 34rem),linear-gradient(180deg,#080d16,#0b1320 65%,#080d16);font-family:Inter,system-ui,-apple-system,sans-serif;line-height:1.5;display:grid;place-items:center;padding:20px}
.card{width:min(520px,100%);padding:36px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(155deg,#142033f5,#0e1725f2);box-shadow:0 24px 60px rgba(0,0,0,.4)}
h1{margin:0 0 8px;font-size:24px;letter-spacing:-.03em}
p{margin:0 0 24px;color:var(--muted);font-size:13px;line-height:1.6}
label{display:block;margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#c1d0e4}
input{width:100%;padding:12px;margin:0 0 16px;border:1px solid var(--line);border-radius:8px;background:#080d16;color:var(--text);font-size:14px;outline:none}
input:focus{border-color:var(--cyan)}
button{width:100%;padding:13px;border:0;border-radius:8px;background:linear-gradient(100deg,var(--cyan),#8db4ff);color:#071319;font-size:13px;font-weight:800;cursor:pointer}
button:hover{opacity:.95}
.result{display:none;margin-top:24px;padding:18px;border:1px solid var(--cyan);border-radius:10px;background:#101a29}
.key{font-family:monospace;font-size:13px;word-break:break-all;color:var(--cyan);font-weight:700;margin:8px 0}
.err{display:none;margin-top:16px;padding:12px;border:1px solid #ff6b6b;border-radius:8px;background:#ff6b6b15;color:#ff8787;font-size:12px}
</style>
</head>
<body>
<div class="card">
  <h1>Claim Your Scandium License</h1>
  <p>Retrieve your license key after completing checkout via Paddle.</p>
  <form id="claimForm">
    <label for="email">Purchasing Email</label>
    <input id="email" type="email" placeholder="you@example.com" required>
    <label for="orderId">Paddle Order or Transaction ID</label>
    <input id="orderId" type="text" placeholder="e.g. txn_... or sub_..." required>
    <button type="submit" id="btn">Find License Key</button>
  </form>
  <div id="err" class="err"></div>
  <div id="result" class="result">
    <div style="font-size:12px;color:var(--muted)">Your License Key:</div>
    <div id="keyText" class="key"></div>
    <p style="margin:12px 0 0;font-size:12px">Open Scandium &rarr; Dashboard &rarr; Subscription &amp; License &rarr; Activate.</p>
  </div>
</div>
<script>
document.getElementById('claimForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  const res = document.getElementById('result');
  err.style.display = 'none'; res.style.display = 'none';
  btn.disabled = true; btn.textContent = 'Searching...';
  try {
    const r = await fetch('/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        orderId: document.getElementById('orderId').value.trim()
      })
    });
    const d = await r.json();
    if (d.success && d.licenseKey) {
      document.getElementById('keyText').textContent = d.licenseKey;
      res.style.display = 'block';
    } else {
      err.textContent = d.error || 'No matching license found.';
      err.style.display = 'block';
    }
  } catch (ex) {
    err.textContent = 'Failed to connect: ' + ex.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Find License Key';
  }
});
</script>
</body>
</html>`;
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
        entropy: '192-bit CSPRNG',
        repository: 'https://github.com/MokuLakshithReddy/Scandium-Assistant',
        docs: 'https://github.com/MokuLakshithReddy/Scandium-Assistant/blob/main/docs/billing/SETUP.md',
      });
    }

    // Customer self-service claim web UI
    if (url.pathname === '/claim' && request.method === 'GET') {
      return new Response(renderClaimHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
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

      const paddleSecret = getPaddleWebhookSecret(env);
      const paddleConfigured = Boolean(paddleSecret);
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
      const webhookSecret = getPaddleWebhookSecret(env);

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

      const eventId = transition.eventId;

      // 3. Atomic distributed deduplication lock via Redis
      const lockStatus = await tryAcquireEventLock(env, eventId);
      if (lockStatus === 'already_processed') {
        return jsonResponse({
          status: 'duplicate_ignored',
          eventId,
          message: 'Event was already processed',
        });
      }
      if (lockStatus === 'in_flight') {
        return jsonResponse({
          status: 'concurrent_in_flight',
          eventId,
          message: 'Event is currently being processed by another worker',
        });
      }

      // 4. Process event within lock boundary
      try {
        // If event indicates an ignored state (e.g., refund pending approval or rejected)
        if (transition.isIgnored) {
          await finalizeEventProcessed(env, eventId);
          return jsonResponse({
            status: 'ignored',
            reason: transition.ignoreReason,
            eventId,
          });
        }

        // Out-of-order check for subscriptions
        let activeKey = transition.licenseKey;
        if (transition.subscriptionId) {
          const existing = await getSubscription(env, transition.subscriptionId);
          if (existing) {
            if (!isEventNewer(existing.occurredAt, transition.occurredAt)) {
              await finalizeEventProcessed(env, eventId);
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

        // Check transaction link if subscription is not yet resolved
        if (!activeKey && transition.transactionId) {
          const existingTxn = await getTransaction(env, transition.transactionId);
          if (existingTxn?.licenseKey) {
            activeKey = existingTxn.licenseKey;
          }
        }

        // Handle adjustments (e.g., approved refunds)
        if (transition.adjustmentId && transition.entitlementState === 'refunded') {
          // If transactionId or subscriptionId is known, revoke the associated license
          if (activeKey) {
            const keyHash = await sha256Hex(activeKey);
            const lic = await getLicenseByHash(env, keyHash);
            if (lic) {
              lic.status = 'refunded';
              lic.tier = 'free';
              lic.updatedAt = new Date().toISOString();
              await saveLicenseByHash(env, keyHash, lic);
            }
          }
          if (transition.subscriptionId) {
            const sub = await getSubscription(env, transition.subscriptionId);
            if (sub) {
              sub.status = 'refunded';
              sub.tier = 'free';
              sub.updatedAt = new Date().toISOString();
              await saveSubscription(env, transition.subscriptionId, sub);
            }
          }
          await finalizeEventProcessed(env, eventId);
          return jsonResponse({
            status: 'success',
            action: 'refund_processed',
            eventId,
          });
        }

        // 5. Generate high-entropy 192-bit CSPRNG license key if not yet created
        if (!activeKey) {
          activeKey = generateStrongLicenseKey(transition.tier);
        }

        // 6. Build and persist canonical license record
        const licenseRecord = {
          licenseKey: activeKey,
          subscriptionId: transition.subscriptionId || null,
          transactionId: transition.transactionId || null,
          tier: transition.tier,
          status: transition.entitlementState,
          customerEmail: transition.customerEmail || null,
          customerName: transition.customerName || null,
          priceId: transition.priceId || null,
          expiresAt: transition.expiresAt || null,
          occurredAt: transition.occurredAt,
          updatedAt: new Date().toISOString(),
        };

        if (transition.subscriptionId) {
          await saveSubscription(env, transition.subscriptionId, licenseRecord);
        }

        if (transition.transactionId) {
          await saveTransaction(env, transition.transactionId, licenseRecord);
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

        // 7. Dispatch customer license delivery notification
        if (
          transition.customerEmail &&
          (transition.entitlementState === 'active' || transition.entitlementState === 'past_due')
        ) {
          ctx?.waitUntil
            ? ctx.waitUntil(
                dispatchLicenseDelivery(env, {
                  email: transition.customerEmail,
                  customerName: transition.customerName,
                  tier: transition.tier,
                  licenseKey: activeKey,
                  subscriptionId: transition.subscriptionId,
                  transactionId: transition.transactionId,
                })
              )
            : await dispatchLicenseDelivery(env, {
                email: transition.customerEmail,
                customerName: transition.customerName,
                tier: transition.tier,
                licenseKey: activeKey,
                subscriptionId: transition.subscriptionId,
                transactionId: transition.transactionId,
              });
        }

        // 8. Atomically mark event as successfully processed
        await finalizeEventProcessed(env, eventId);

        return jsonResponse({
          status: 'success',
          transition,
          licenseKey: activeKey,
        });
      } catch (err) {
        // Release distributed lock on unexpected failure so Paddle can retry
        await releaseEventLock(env, eventId);
        throw err;
      }
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

    if (url.pathname === '/api/v1/license/claim' && request.method === 'POST') {
      return await handleClaim(request, env);
    }

    return jsonResponse({ error: 'Endpoint not found' }, 404);
  },
};
