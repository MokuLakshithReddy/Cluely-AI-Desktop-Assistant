import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';
import { verifyLicensePayload, generateStrongLicenseKey } from '../src/crypto.js';

const TEST_PUBLIC_KEY = '302a300506032b657003210008a1a2f9a9fd2d62d967c05d5ac47e5507876b44043332a18a5bbc14cc8ede31';
const TEST_PRIVATE_KEY = '302e020100300506032b657004220420c1825d15e4a70d9b8c730702ce385c9f80ec3e6cb610d79390a6a9cd550c2070';
const TEST_PADDLE_SECRET = 'pdl_ntf_set_test_secret_12345';

function createPaddleSignature(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signed = `${timestamp}:${body}`;
  const h1 = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `ts=${timestamp};h1=${h1}`;
}

// In-memory mock Redis database for isolated unit tests
class MockRedisStore {
  constructor() {
    this.store = new Map();
  }

  handleCommand(cmd) {
    const op = cmd[0].toUpperCase();
    if (op === 'PING') return 'PONG';
    if (op === 'GET') {
      return this.store.get(cmd[1]) || null;
    }
    if (op === 'SET') {
      const key = cmd[1];
      const val = cmd[2];
      // Check for NX
      if (cmd.includes('NX')) {
        if (this.store.has(key)) return null;
      }
      this.store.set(key, val);
      return 'OK';
    }
    if (op === 'INCR') {
      const key = cmd[1];
      const current = parseInt(this.store.get(key) || '0', 10);
      const next = current + 1;
      this.store.set(key, String(next));
      return next;
    }
    if (op === 'EXPIRE') return 1;
    if (op === 'TTL') return 900;
    if (op === 'LPUSH') return 1;
    if (op === 'DEL') {
      this.store.delete(cmd[1]);
      return 1;
    }
    return null;
  }
}

describe('Scandium Licensing & Paddle Webhook Backend', () => {
  let mockRedis;
  let env;

  beforeEach(() => {
    mockRedis = new MockRedisStore();

    // Stub global fetch for Upstash Redis calls in test
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('mock-upstash.internal')) {
        const cmd = JSON.parse(options.body);
        const result = mockRedis.handleCommand(cmd);
        return new Response(JSON.stringify({ result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unhandled mock fetch' }), { status: 500 });
    };

    env = {
      UPSTASH_REDIS_REST_URL: 'https://mock-upstash.internal',
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
      SCANDIUM_LICENSING_PRIVATE_KEY: TEST_PRIVATE_KEY,
      PADDLE_WEBHOOK_SECRET_KEY: TEST_PADDLE_SECRET,
      PADDLE_PLUS_PRICE_ID: 'pri_test_plus_100',
      PADDLE_PRO_PRICE_ID: 'pri_test_pro_200',
    };
  });

  it('serves root service information identifying Paddle and 192-bit CSPRNG entropy', async () => {
    const req = new Request('https://worker.internal/', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.provider, 'Paddle Billing (Merchant of Record)');
    assert.equal(data.architecture, 'provider-independent');
    assert.equal(data.entropy, '192-bit CSPRNG');
  });

  it('reports healthy (200) with both PADDLE_WEBHOOK_SECRET_KEY and PADDLE_WEBHOOK_SECRET alias', async () => {
    // 1. With primary PADDLE_WEBHOOK_SECRET_KEY
    const req1 = new Request('https://worker.internal/health', { method: 'GET' });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.status, 'healthy');
    assert.equal(data1.productionReady, true);

    // 2. With alias PADDLE_WEBHOOK_SECRET
    const aliasEnv = { ...env, PADDLE_WEBHOOK_SECRET_KEY: undefined, PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET };
    const req2 = new Request('https://worker.internal/health', { method: 'GET' });
    const res2 = await worker.fetch(req2, aliasEnv);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.subsystems.paddleWebhook, 'configured');
  });

  it('reports degraded (503) when Redis or signing key is missing or failing', async () => {
    const brokenEnv = { ...env, UPSTASH_REDIS_REST_URL: undefined };
    const req = new Request('https://worker.internal/health', { method: 'GET' });
    const res = await worker.fetch(req, brokenEnv);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.status, 'degraded');
    assert.equal(data.subsystems.redis, 'unconfigured');
  });

  it('rejects Paddle webhooks with missing, altered, or invalid signatures (401)', async () => {
    const payload = JSON.stringify({ event_id: 'evt_01', event_type: 'subscription.created' });
    const sig = createPaddleSignature(payload, TEST_PADDLE_SECRET);

    // Missing signature
    const req1 = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      body: payload,
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 401);

    // Altered payload
    const req2 = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: payload + 'tampered',
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 401);

    // Wrong secret key
    const badSig = createPaddleSignature(payload, 'wrong_secret_key');
    const req3 = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': badSig },
      body: payload,
    });
    const res3 = await worker.fetch(req3, env);
    assert.equal(res3.status, 401);
  });

  it('enforces timestamp tolerance to prevent replay attacks (401 for expired timestamps)', async () => {
    const payload = JSON.stringify({ event_id: 'evt_02', event_type: 'subscription.created' });
    // Timestamp 400 seconds in the past (> 300s tolerance)
    const expiredTs = Math.floor(Date.now() / 1000) - 400;
    const expiredSig = createPaddleSignature(payload, TEST_PADDLE_SECRET, expiredTs);

    const req = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': expiredSig },
      body: payload,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 401);
  });

  it('generates 192-bit CSPRNG high-entropy license keys', () => {
    const keyPro = generateStrongLicenseKey('pro');
    const keyPlus = generateStrongLicenseKey('plus');

    assert.ok(keyPro.startsWith('SCANDIUM-PRO-'));
    assert.ok(keyPlus.startsWith('SCANDIUM-PLUS-'));

    // Check entropy: 6 blocks of 8 hex digits = 48 hex chars = 24 bytes = 192 bits
    const partsPro = keyPro.replace('SCANDIUM-PRO-', '').split('-');
    assert.equal(partsPro.length, 6);
    partsPro.forEach(block => {
      assert.equal(block.length, 8);
      assert.match(block, /^[0-9A-F]{8}$/);
    });
  });

  it('processes Paddle subscription.created and distinguishes subscription ID entity', async () => {
    const eventPayload = {
      event_id: 'evt_sub_01',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_alpha_123',
        status: 'active',
        customer: { email: 'buyer@example.com' },
        items: [{ price: { id: 'pri_test_plus_100' } }],
      },
    };
    const bodyStr = JSON.stringify(eventPayload);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);

    const req = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'success');
    assert.equal(data.transition.subscriptionId, 'sub_alpha_123');
    assert.equal(data.transition.tier, 'plus');
    assert.ok(data.licenseKey.startsWith('SCANDIUM-PLUS-'));
  });

  it('processes Paddle transaction.completed and links transaction ID to subscription ID', async () => {
    const eventPayload = {
      event_id: 'evt_txn_01',
      event_type: 'transaction.completed',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'txn_order_999',
        subscription_id: 'sub_alpha_123',
        status: 'completed',
        customer: { email: 'buyer@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const bodyStr = JSON.stringify(eventPayload);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);

    const req = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'success');
    assert.equal(data.transition.transactionId, 'txn_order_999');
    assert.equal(data.transition.subscriptionId, 'sub_alpha_123');
    assert.equal(data.transition.tier, 'pro');
  });

  it('enforces atomic event acquisition and prevents concurrent race conditions', async () => {
    const eventPayload = {
      event_id: 'evt_concurrent_01',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_concurrent_123',
        status: 'active',
        customer: { email: 'race@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const bodyStr = JSON.stringify(eventPayload);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);

    // First call acquires and completes event
    const req1 = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.status, 'success');

    // Duplicate call immediately detects already_processed
    const req2 = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.status, 'duplicate_ignored');
  });

  it('handles adjustment pending_approval vs approved refund correctly', async () => {
    // 1. Create active subscription first
    const subEvent = {
      event_id: 'evt_refund_setup',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T10:00:00Z',
      data: {
        id: 'sub_refund_test',
        status: 'active',
        customer: { email: 'refund@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const subBody = JSON.stringify(subEvent);
    const subSig = createPaddleSignature(subBody, TEST_PADDLE_SECRET);
    const subReq = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': subSig },
      body: subBody,
    });
    await worker.fetch(subReq, env);

    // 2. Adjustment pending_approval: MUST NOT revoke customer access!
    const pendingAdj = {
      event_id: 'evt_adj_pending',
      event_type: 'adjustment.created',
      occurred_at: '2026-11-20T11:00:00Z',
      data: {
        id: 'adj_001',
        action: 'refund',
        status: 'pending_approval',
        subscription_id: 'sub_refund_test',
      },
    };
    const pendingBody = JSON.stringify(pendingAdj);
    const pendingSig = createPaddleSignature(pendingBody, TEST_PADDLE_SECRET);
    const pendingReq = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': pendingSig },
      body: pendingBody,
    });
    const pendingRes = await worker.fetch(pendingReq, env);
    assert.equal(pendingRes.status, 200);
    const pendingData = await pendingRes.json();
    assert.equal(pendingData.status, 'ignored');
    assert.equal(pendingData.reason, 'adjustment_pending_approval');

    // 3. Adjustment approved refund: MUST revoke customer access
    const approvedAdj = {
      event_id: 'evt_adj_approved',
      event_type: 'adjustment.updated',
      occurred_at: '2026-11-20T12:00:00Z',
      data: {
        id: 'adj_001',
        action: 'refund',
        status: 'approved',
        subscription_id: 'sub_refund_test',
      },
    };
    const approvedBody = JSON.stringify(approvedAdj);
    const approvedSig = createPaddleSignature(approvedBody, TEST_PADDLE_SECRET);
    const approvedReq = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': approvedSig },
      body: approvedBody,
    });
    const approvedRes = await worker.fetch(approvedReq, env);
    assert.equal(approvedRes.status, 200);
    const approvedData = await approvedRes.json();
    assert.equal(approvedData.status, 'success');
    assert.equal(approvedData.action, 'refund_processed');
  });

  it('retains customer tier access during past_due recovery dunning', async () => {
    const pastDueEvent = {
      event_id: 'evt_past_due_01',
      event_type: 'subscription.past_due',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_dunning_123',
        status: 'past_due',
        customer: { email: 'dunning@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const bodyStr = JSON.stringify(pastDueEvent);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);

    const req = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'success');
    assert.equal(data.transition.entitlementState, 'past_due');
    // Tier is retained during dunning per Paddle provisioning recommendations!
    assert.equal(data.transition.tier, 'pro');
  });

  it('allows customer self-service license claim by email and order ID', async () => {
    // 1. Ingest a transaction
    const txnEvent = {
      event_id: 'evt_claim_test',
      event_type: 'transaction.completed',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'txn_claim_target_123',
        status: 'completed',
        customer: { email: 'buyer-claim@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const bodyStr = JSON.stringify(txnEvent);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);
    const webhookReq = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const webhookRes = await worker.fetch(webhookReq, env);
    const webhookData = await webhookRes.json();
    const generatedKey = webhookData.licenseKey;

    // 2. Customer claims license using email and transaction ID
    const claimReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'buyer-claim@example.com',
        orderId: 'txn_claim_target_123',
      }),
    });
    const claimRes = await worker.fetch(claimReq, env);
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.equal(claimData.success, true);
    assert.equal(claimData.licenseKey, generatedKey);
    assert.equal(claimData.tier, 'pro');
    assert.ok(Array.isArray(claimData.activationInstructions));

    // 3. Mismatched email is rejected for data protection
    const badClaimReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'attacker@example.com',
        orderId: 'txn_claim_target_123',
      }),
    });
    const badClaimRes = await worker.fetch(badClaimReq, env);
    assert.equal(badClaimRes.status, 403);
  });

  it('activates and validates with Ed25519 signatures and enforces activation limits', async () => {
    // 1. Create license via webhook
    const subEvent = {
      event_id: 'evt_act_01',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_act_456',
        status: 'active',
        customer: { email: 'client@example.com' },
        items: [{ price: { id: 'pri_test_plus_100' } }], // Plus tier = limit 2
      },
    };
    const bodyStr = JSON.stringify(subEvent);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);
    const subReq = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    });
    const subRes = await worker.fetch(subReq, env);
    const subData = await subRes.json();
    const licenseKey = subData.licenseKey;

    // 2. Activate on Device 1
    const actReq1 = new Request('https://worker.internal/api/v1/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey,
        hardwareFingerprint: 'hw_fingerprint_01',
        instanceName: 'Laptop-1',
      }),
    });
    const actRes1 = await worker.fetch(actReq1, env);
    assert.equal(actRes1.status, 200);
    const actData1 = await actRes1.json();
    assert.equal(actData1.success, true);
    assert.equal(actData1.license.activationUsage, 1);
    assert.equal(actData1.license.activationLimit, 2);

    // Verify Ed25519 signature
    const isSigValid = await verifyLicensePayload(actData1.license, actData1.signature, TEST_PUBLIC_KEY);
    assert.equal(isSigValid, true);

    // 3. Activate on Device 2
    const actReq2 = new Request('https://worker.internal/api/v1/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey,
        hardwareFingerprint: 'hw_fingerprint_02',
        instanceName: 'Workstation-2',
      }),
    });
    const actRes2 = await worker.fetch(actReq2, env);
    assert.equal(actRes2.status, 200);
    const actData2 = await actRes2.json();
    assert.equal(actData2.license.activationUsage, 2);

    // 4. Activate on Device 3 (Exceeds limit 2 for Plus plan -> 409)
    const actReq3 = new Request('https://worker.internal/api/v1/license/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey,
        hardwareFingerprint: 'hw_fingerprint_03',
        instanceName: 'Phone-3',
      }),
    });
    const actRes3 = await worker.fetch(actReq3, env);
    assert.equal(actRes3.status, 409);
  });
});
