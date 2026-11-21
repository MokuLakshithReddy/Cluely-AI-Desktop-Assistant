/**
 * Scandium Assistant - Provider-Independent Licensing & Paddle Webhook Service
 *
 * Edge Cloudflare Worker architecture:
 * 1. Paddle Billing Webhook Ingestion with HMAC-SHA256 & replay timestamp protection.
 * 2. Distributed atomic event lock with ownership token and out-of-order protection on Upstash Redis.
 * 3. 192-bit CSPRNG high-entropy commercial license keys.
 * 4. AES-256-GCM encryption of license keys at rest; no plaintext keys stored in Redis.
 * 5. Sanitized webhook receipts: acknowledges webhook receipt without leaking license keys.
 * 6. Provider-independent licensing service (activation, validation, deactivation).
 * 7. Two-factor self-service customer claim portal with verified email code authorization.
 * 8. Asymmetric Ed25519 cryptographic signing of client entitlement responses.
 * 9. Multi-provider transactional email dispatcher (Resend, Postmark, SendGrid) with outbox retry.
 * 10. Strict fail-closed health reporting.
 */

import {
  sha256Hex,
  generateStrongLicenseKey,
  encryptLicenseKey,
  maskLicenseKey,
} from './crypto.js';
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
  saveCustomer,
  getCustomer,
  saveCustomerEmailIndex,
} from './storage.js';
import {
  handleActivate,
  handleValidate,
  handleDeactivate,
  handleClaim,
} from './licensing.js';
import { dispatchLicenseDelivery, processOutbox } from './notifications.js';

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
.info{display:none;margin-top:16px;padding:12px;border:1px solid var(--cyan);border-radius:8px;background:#64e6e115;color:var(--cyan);font-size:12px}
.code-step{display:none}
</style>
</head>
<body>
<div class="card">
  <h1>Claim Your Scandium License</h1>
  <p>Two-factor verification protects your purchase. Enter your details to receive an authorization code.</p>
  
  <form id="step1Form">
    <label for="email">Purchasing Email</label>
    <input id="email" type="email" placeholder="you@example.com" required>
    <label for="orderId">Paddle Order or Transaction ID</label>
    <input id="orderId" type="text" placeholder="e.g. txn_... or sub_..." required>
    <button type="submit" id="btn1">Send Verification Code</button>
  </form>

  <form id="step2Form" class="code-step">
    <div id="step2Notice" class="info" style="display:block;margin-bottom:16px"></div>
    <label for="verificationCode">6-Digit Email Verification Code</label>
    <input id="verificationCode" type="text" maxlength="6" pattern="[0-9]{6}" placeholder="123456" required autocomplete="one-time-code">
    <button type="submit" id="btn2">Verify &amp; Reveal License Key</button>
  </form>

  <div id="err" class="err"></div>

  <div id="result" class="result">
    <div style="font-size:12px;color:var(--muted)">Your Active Scandium License Key:</div>
    <div id="keyText" class="key"></div>
    <p style="margin:12px 0 0;font-size:12px">Open Scandium &rarr; Dashboard &rarr; Subscription &amp; License &rarr; Activate.</p>
  </div>
</div>
<script>
const step1 = document.getElementById('step1Form');
const step2 = document.getElementById('step2Form');
const err = document.getElementById('err');
const res = document.getElementById('result');
const notice = document.getElementById('step2Notice');

step1.addEventListener('submit', async function(e) {
  e.preventDefault();
  err.style.display = 'none'; res.style.display = 'none';
  const btn = document.getElementById('btn1');
  btn.disabled = true; btn.textContent = 'Verifying Order...';
  try {
    const r = await fetch('/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'request',
        email: document.getElementById('email').value.trim(),
        orderId: document.getElementById('orderId').value.trim()
      })
    });
    const d = await r.json();
    if (d.success && d.verificationRequired) {
      step1.style.display = 'none';
      step2.style.display = 'block';
      notice.textContent = d.message || 'Verification code sent to your email.';
    } else {
      err.textContent = d.error || 'Failed to request verification code.';
      err.style.display = 'block';
    }
  } catch (ex) {
    err.textContent = 'Connection error: ' + ex.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Send Verification Code';
  }
});

step2.addEventListener('submit', async function(e) {
  e.preventDefault();
  err.style.display = 'none';
  const btn = document.getElementById('btn2');
  btn.disabled = true; btn.textContent = 'Verifying Code...';
  try {
    const r = await fetch('/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verify',
        email: document.getElementById('email').value.trim(),
        orderId: document.getElementById('orderId').value.trim(),
        code: document.getElementById('verificationCode').value.trim()
      })
    });
    const d = await r.json();
    if (d.success && d.licenseKey) {
      step2.style.display = 'none';
      document.getElementById('keyText').textContent = d.licenseKey;
      res.style.display = 'block';
    } else {
      err.textContent = d.error || 'Invalid verification code.';
      err.style.display = 'block';
    }
  } catch (ex) {
    err.textContent = 'Connection error: ' + ex.message;
    err.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Verify & Reveal License Key';
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
        keyStorage: 'AES-256-GCM encrypted',
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

    // Outbox processing endpoint
    if (url.pathname === '/api/v1/internal/outbox/process' && request.method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const cronSecret = env.CRON_SECRET || env.SCANDIUM_LICENSING_PRIVATE_KEY;
      if (cronSecret && !authHeader.includes(cronSecret.slice(0, 32))) {
        return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
      }
      const outboxRes = await processOutbox(env, 20);
      return jsonResponse({ success: true, ...outboxRes });
    }

    // -------------------------------------------------------------
    // Paddle Billing Webhook Endpoint
    // -------------------------------------------------------------
    if (url.pathname === '/' || url.pathname === '/webhook/paddle' || url.pathname === '/api/webhook/paddle') {
      if (request.method !== 'POST') {
        return jsonResponse({ success: false, error: 'Method Not Allowed' }, 405);
      }

      const secret = getPaddleWebhookSecret(env);
      if (!secret) {
        return jsonResponse(
          {
            success: false,
            error: 'Webhook secret unconfigured. Set PADDLE_WEBHOOK_SECRET_KEY or PADDLE_WEBHOOK_SECRET.',
          },
          503
        );
      }

      const signatureHeader = request.headers.get('paddle-signature') || '';
      if (!signatureHeader) {
        return jsonResponse({ success: false, error: 'Missing Paddle-Signature header' }, 401);
      }

      const rawBody = await request.text();
      const isValid = await verifyPaddleSignature(rawBody, signatureHeader, secret);
      if (!isValid) {
        return jsonResponse({ success: false, error: 'Invalid HMAC signature or timestamp replay' }, 401);
      }

      let parsedPayload;
      try {
        parsedPayload = JSON.parse(rawBody);
      } catch {
        return jsonResponse({ success: false, error: 'Malformed JSON payload' }, 400);
      }

      const transition = parsePaddleEvent(parsedPayload, env);
      const eventId = transition.eventId;

      // 1. Acquire distributed atomic lock with ownership token
      const lockAcquisition = await tryAcquireEventLock(env, eventId);
      const lockToken = lockAcquisition.lockToken;

      if (lockAcquisition.status === 'already_processed') {
        return jsonResponse({
          status: 'already_processed',
          eventId,
          message: 'Event was already successfully processed',
        });
      }

      if (lockAcquisition.status === 'in_flight') {
        return jsonResponse({
          status: 'in_flight',
          eventId,
          message: 'Event is currently being processed by another worker',
        });
      }

      // 2. Process event within lock boundary
      try {
        // Handle customer sync events
        if (transition.eventName.startsWith('customer.') || transition.entitlementState === 'customer_sync') {
          if (transition.customerId && transition.customerEmail) {
            await saveCustomer(env, transition.customerId, {
              customerId: transition.customerId,
              email: transition.customerEmail,
              name: transition.customerName || null,
              updatedAt: transition.occurredAt,
            });
          }
          await finalizeEventProcessed(env, eventId, lockToken);
          return jsonResponse({
            status: 'success',
            eventId,
            processed: true,
          });
        }

        // Resolve customer details from cached customer record if missing in subscription/transaction payload
        if (!transition.customerEmail && transition.customerId) {
          const cachedCustomer = await getCustomer(env, transition.customerId);
          if (cachedCustomer?.email) {
            transition.customerEmail = cachedCustomer.email;
            transition.customerName = cachedCustomer.name || transition.customerName;
          }
        } else if (transition.customerId && transition.customerEmail) {
          // Cache customer details for future event lookups
          await saveCustomer(env, transition.customerId, {
            customerId: transition.customerId,
            email: transition.customerEmail,
            name: transition.customerName || null,
            updatedAt: transition.occurredAt,
          });
        }

        // If event indicates an ignored state (e.g., refund pending approval or rejected)
        if (transition.isIgnored) {
          await finalizeEventProcessed(env, eventId, lockToken);
          return jsonResponse({
            status: 'ignored',
            reason: transition.ignoreReason,
            eventId,
          });
        }

        // Out-of-order check for subscriptions
        let activeKeyHash = null;
        if (transition.subscriptionId) {
          const existing = await getSubscription(env, transition.subscriptionId);
          if (existing) {
            if (!isEventNewer(existing.occurredAt, transition.occurredAt)) {
              await finalizeEventProcessed(env, eventId, lockToken);
              return jsonResponse({
                status: 'out_of_order_ignored',
                eventId,
                message: 'Existing subscription state is newer than incoming event',
              });
            }
            if (existing.licenseHash) {
              activeKeyHash = existing.licenseHash;
            }
            if (!transition.customerEmail && existing.customerEmail) {
              transition.customerEmail = existing.customerEmail;
            }
          }
        }

        // Check transaction link if not yet resolved
        if (!activeKeyHash && transition.transactionId) {
          const existingTxn = await getTransaction(env, transition.transactionId);
          if (existingTxn?.licenseHash) {
            activeKeyHash = existingTxn.licenseHash;
          }
          if (!transition.customerEmail && existingTxn?.customerEmail) {
            transition.customerEmail = existingTxn.customerEmail;
          }
        }

        // Handle adjustments (e.g. approved refunds or chargeback reversals)
        if (transition.adjustmentId) {
          if (activeKeyHash) {
            const lic = await getLicenseByHash(env, activeKeyHash);
            if (lic) {
              lic.status = transition.entitlementState;
              lic.tier = transition.tier;
              lic.updatedAt = new Date().toISOString();
              await saveLicenseByHash(env, activeKeyHash, lic);
            }
          }
          if (transition.subscriptionId) {
            const sub = await getSubscription(env, transition.subscriptionId);
            if (sub) {
              sub.status = transition.entitlementState;
              sub.tier = transition.tier;
              sub.updatedAt = new Date().toISOString();
              await saveSubscription(env, transition.subscriptionId, sub);
            }
          }
          await finalizeEventProcessed(env, eventId, lockToken);
          return jsonResponse({
            status: 'success',
            eventId,
            processed: true,
          });
        }

        // 3. Resolve or generate high-entropy 192-bit CSPRNG license key
        let plainKey = transition.licenseKey;
        let encryptedKey = null;

        if (activeKeyHash) {
          const existingLic = await getLicenseByHash(env, activeKeyHash);
          if (existingLic) {
            encryptedKey = existingLic.encryptedKey;
            // Existing license being updated
            existingLic.tier = transition.tier;
            existingLic.status = transition.entitlementState;
            existingLic.expiresAt = transition.expiresAt || existingLic.expiresAt;
            existingLic.customerEmail = transition.customerEmail || existingLic.customerEmail;
            existingLic.updatedAt = new Date().toISOString();
            await saveLicenseByHash(env, activeKeyHash, existingLic);
          }
        } else {
          // Generate brand new 192-bit CSPRNG key
          plainKey = plainKey || generateStrongLicenseKey(transition.tier);
          activeKeyHash = await sha256Hex(plainKey);

          // Encrypt key at rest with AES-256-GCM using server private key
          encryptedKey = await encryptLicenseKey(plainKey, env.SCANDIUM_LICENSING_PRIVATE_KEY);

          const licenseRecord = {
            licenseHash: activeKeyHash,
            licenseKeyMasked: maskLicenseKey(plainKey),
            encryptedKey,
            subscriptionId: transition.subscriptionId || null,
            transactionId: transition.transactionId || null,
            customerId: transition.customerId || null,
            tier: transition.tier,
            status: transition.entitlementState,
            customerEmail: transition.customerEmail || null,
            customerName: transition.customerName || null,
            priceId: transition.priceId || null,
            expiresAt: transition.expiresAt || null,
            occurredAt: transition.occurredAt,
            updatedAt: new Date().toISOString(),
          };

          await saveLicenseByHash(env, activeKeyHash, licenseRecord);
        }

        // 4. Save metadata records (linking transaction, subscription, and email index without plaintext keys)
        const summaryData = {
          licenseHash: activeKeyHash,
          licenseKeyMasked: encryptedKey ? maskLicenseKey(plainKey) : undefined,
          subscriptionId: transition.subscriptionId || null,
          transactionId: transition.transactionId || null,
          customerId: transition.customerId || null,
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
          await saveSubscription(env, transition.subscriptionId, summaryData);
        }

        if (transition.transactionId) {
          await saveTransaction(env, transition.transactionId, summaryData);
        }

        if (transition.customerEmail) {
          await saveCustomerEmailIndex(env, transition.customerEmail, activeKeyHash);
        }

        // 5. Dispatch customer license delivery notification
        if (
          plainKey &&
          transition.customerEmail &&
          (transition.entitlementState === 'active' || transition.entitlementState === 'past_due')
        ) {
          const deliveryPayload = {
            email: transition.customerEmail,
            customerName: transition.customerName,
            tier: transition.tier,
            licenseKey: plainKey,
            licenseHash: activeKeyHash,
            subscriptionId: transition.subscriptionId,
            transactionId: transition.transactionId,
          };

          ctx?.waitUntil
            ? ctx.waitUntil(dispatchLicenseDelivery(env, deliveryPayload))
            : await dispatchLicenseDelivery(env, deliveryPayload);
        }

        // 6. Finalize processing with lock ownership check
        await finalizeEventProcessed(env, eventId, lockToken);

        // 7. Return sanitized receipt without exposing customer license key
        return jsonResponse({
          status: 'success',
          eventId,
          processed: true,
        });
      } catch (err) {
        // Release distributed lock on unexpected failure so Paddle can retry
        await releaseEventLock(env, eventId, lockToken);
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

    return jsonResponse({ success: false, error: 'Not Found' }, 404);
  },
};
