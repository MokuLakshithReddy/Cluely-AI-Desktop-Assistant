import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';
import { verifyLicensePayload } from '../src/crypto.js';

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
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    env = {
      UPSTASH_REDIS_REST_URL: 'https://mock-upstash.internal',
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
      PADDLE_WEBHOOK_SECRET_KEY: TEST_PADDLE_SECRET,
      PADDLE_PLUS_PRICE_ID: 'pri_plus_100',
      PADDLE_PRO_PRICE_ID: 'pri_pro_200',
      SCANDIUM_LICENSING_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SCANDIUM_LICENSING_PUBLIC_KEY: TEST_PUBLIC_KEY,
    };
  });

  it('serves root service information identifying Paddle and provider-independent architecture', async () => {
    const req = new Request('https://scandium.internal/', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.service, 'Scandium Licensing & Paddle Webhook Backend');
    assert.equal(data.version, '1.0.3');
    assert.equal(data.architecture, 'provider-independent');
  });

  it('reports healthy (200) only when all subsystems (Redis, Paddle secret, Signing key) are configured and connected', async () => {
    const req = new Request('https://scandium.internal/health', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'healthy');
    assert.equal(data.productionReady, true);
    assert.equal(data.subsystems.redis, 'connected');
    assert.equal(data.subsystems.paddleWebhook, 'configured');
    assert.equal(data.subsystems.licensingSigningKey, 'configured');
  });

  it('reports degraded (503) when Redis or signing key is missing or failing', async () => {
    const brokenEnv = { ...env, SCANDIUM_LICENSING_PRIVATE_KEY: '' };
    const req = new Request('https://scandium.internal/health', { method: 'GET' });
    const res = await worker.fetch(req, brokenEnv);
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.status, 'degraded');
    assert.equal(data.productionReady, false);
    assert.equal(data.subsystems.licensingSigningKey, 'unconfigured');
  });

  it('rejects Paddle webhooks with missing, altered, or invalid signatures (401)', async () => {
    const body = JSON.stringify({ event_id: 'evt_test_1', event_type: 'subscription.created' });

    // Missing signature
    const req1 = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      body,
    });
    assert.equal((await worker.fetch(req1, env)).status, 401);

    // Invalid signature hex
    const req2 = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': `ts=${Math.floor(Date.now() / 1000)};h1=${'0'.repeat(64)}` },
      body,
    });
    assert.equal((await worker.fetch(req2, env)).status, 401);

    // Altered body
    const validSig = createPaddleSignature(body, TEST_PADDLE_SECRET);
    const req3 = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': validSig },
      body: body + ' ',
    });
    assert.equal((await worker.fetch(req3, env)).status, 401);
  });

  it('enforces timestamp tolerance to prevent replay attacks (401 for expired timestamps)', async () => {
    const body = JSON.stringify({ event_id: 'evt_test_replay', event_type: 'subscription.created' });
    const expiredTs = Math.floor(Date.now() / 1000) - 3600; // 1 hour old
    const expiredSig = createPaddleSignature(body, TEST_PADDLE_SECRET, expiredTs);

    const req = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': expiredSig },
      body,
    });
    assert.equal((await worker.fetch(req, env)).status, 401);
  });

  it('processes Paddle subscription.created for Plus plan and generates a Scandium license', async () => {
    const event = {
      event_id: 'evt_sub_plus_1',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T10:00:00Z',
      data: {
        id: 'sub_paddle_plus_001',
        status: 'active',
        customer: { email: 'subscriber@example.com' },
        items: [{ price: { id: 'pri_plus_100' }, quantity: 1 }],
        current_billing_period: {
          ends_at: '2026-12-20T10:00:00Z',
        },
      },
    };

    const raw = JSON.stringify(event);
    const sig = createPaddleSignature(raw, TEST_PADDLE_SECRET);
    const req = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': sig },
      body: raw,
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'success');
    assert.equal(data.transition.tier, 'plus');
    assert.equal(data.transition.entitlementState, 'active');
    assert.ok(data.licenseKey.startsWith('SCANDIUM-PLUS-'));

    // Test deduplication on immediate replay
    const replayReq = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': sig },
      body: raw,
    });
    const replayRes = await worker.fetch(replayReq, env);
    assert.equal(replayRes.status, 200);
    const replayData = await replayRes.json();
    assert.equal(replayData.status, 'duplicate_ignored');
  });

  it('processes Paddle subscription.canceled and updates entitlement to cancelled', async () => {
    const event = {
      event_id: 'evt_sub_cancel_1',
      event_type: 'subscription.canceled',
      occurred_at: '2026-11-20T12:00:00Z',
      data: {
        id: 'sub_paddle_plus_001',
        status: 'canceled',
        items: [{ price: { id: 'pri_plus_100' }, quantity: 1 }],
      },
    };

    const raw = JSON.stringify(event);
    const sig = createPaddleSignature(raw, TEST_PADDLE_SECRET);
    const req = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': sig },
      body: raw,
    });

    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'success');
    assert.equal(data.transition.tier, 'free');
    assert.equal(data.transition.entitlementState, 'cancelled');
  });

  it('protects against out-of-order events arriving late', async () => {
    // 1. Initial active subscription
    const event1 = {
      event_id: 'evt_order_1',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T14:00:00Z',
      data: {
        id: 'sub_order_test',
        status: 'active',
        items: [{ price: { id: 'pri_pro_200' }, quantity: 1 }],
      },
    };
    const req1 = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': createPaddleSignature(JSON.stringify(event1), TEST_PADDLE_SECRET) },
      body: JSON.stringify(event1),
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);

    // 2. Incoming older event with earlier occurred_at
    const eventOlder = {
      event_id: 'evt_order_0_older',
      event_type: 'subscription.past_due',
      occurred_at: '2026-11-20T10:00:00Z', // 4 hours earlier
      data: {
        id: 'sub_order_test',
        status: 'past_due',
        items: [{ price: { id: 'pri_pro_200' }, quantity: 1 }],
      },
    };
    const req2 = new Request('https://scandium.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'paddle-signature': createPaddleSignature(JSON.stringify(eventOlder), TEST_PADDLE_SECRET) },
      body: JSON.stringify(eventOlder),
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.status, 'out_of_order_ignored');
  });

  it('activates, validates, and deactivates licenses with cryptographic Ed25519 signatures', async () => {
    // First, create a license via Paddle webhook
    const event = {
      event_id: 'evt_license_e2e_1',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T16:00:00Z',
      data: {
        id: 'sub_e2e_001',
        status: 'active',
        customer: { email: 'poweruser@example.com' },
        items: [{ price: { id: 'pri_pro_200' }, quantity: 1 }],
        current_billing_period: { ends_at: '2027-01-01T00:00:00Z' },
      },
    };
    const hookRes = await worker.fetch(
      new Request('https://scandium.internal/api/webhook/paddle', {
        method: 'POST',
        headers: { 'paddle-signature': createPaddleSignature(JSON.stringify(event), TEST_PADDLE_SECRET) },
        body: JSON.stringify(event),
      }),
      env
    );
    const { licenseKey } = await hookRes.json();
    assert.ok(licenseKey.startsWith('SCANDIUM-PRO-'));

    // Step 1: Activate device 1
    const actReq1 = new Request('https://scandium.internal/api/v1/license/activate', {
      method: 'POST',
      body: JSON.stringify({
        licenseKey,
        instanceName: 'Scandium-win32-alpha1',
        hardwareFingerprint: 'hw_fingerprint_001',
      }),
    });
    const actRes1 = await worker.fetch(actReq1, env);
    assert.equal(actRes1.status, 200);
    const actData1 = await actRes1.json();
    assert.equal(actData1.success, true);
    assert.equal(actData1.license.tier, 'pro');
    assert.equal(actData1.license.status, 'active');
    assert.equal(actData1.license.activationUsage, 1);
    assert.equal(actData1.license.activationLimit, 5);

    // Verify cryptographic signature with public key
    const sigValid = await verifyLicensePayload(actData1.license, actData1.signature, TEST_PUBLIC_KEY);
    assert.equal(sigValid, true);

    // Step 2: Re-activation from same device should not increment usage count
    const actReqRe = new Request('https://scandium.internal/api/v1/license/activate', {
      method: 'POST',
      body: JSON.stringify({
        licenseKey,
        instanceName: 'Scandium-win32-alpha1',
        hardwareFingerprint: 'hw_fingerprint_001',
      }),
    });
    const actResRe = await worker.fetch(actReqRe, env);
    assert.equal(actResRe.status, 200);
    const actDataRe = await actResRe.json();
    assert.equal(actDataRe.license.activationUsage, 1);

    // Step 3: Validate license
    const valReq = new Request('https://scandium.internal/api/v1/license/validate', {
      method: 'POST',
      body: JSON.stringify({
        licenseKey,
        instanceName: 'Scandium-win32-alpha1',
        hardwareFingerprint: 'hw_fingerprint_001',
      }),
    });
    const valRes = await worker.fetch(valReq, env);
    assert.equal(valRes.status, 200);
    const valData = await valRes.json();
    assert.equal(valData.valid, true);
    assert.equal(valData.license.tier, 'pro');

    // Validation from unregistered device fails closed
    const valUnregistered = await worker.fetch(
      new Request('https://scandium.internal/api/v1/license/validate', {
        method: 'POST',
        body: JSON.stringify({
          licenseKey,
          instanceName: 'Scandium-alien-pc',
          hardwareFingerprint: 'hw_alien_999',
        }),
      }),
      env
    );
    assert.equal(valUnregistered.status, 403);

    // Step 4: Deactivate device
    const deactReq = new Request('https://scandium.internal/api/v1/license/deactivate', {
      method: 'POST',
      body: JSON.stringify({
        licenseKey,
        instanceName: 'Scandium-win32-alpha1',
        hardwareFingerprint: 'hw_fingerprint_001',
      }),
    });
    const deactRes = await worker.fetch(deactReq, env);
    assert.equal(deactRes.status, 200);
    const deactData = await deactRes.json();
    assert.equal(deactData.deactivated, true);
  });
});
