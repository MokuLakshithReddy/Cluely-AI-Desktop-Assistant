import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';
import { verifyLicensePayload, generateStrongLicenseKey } from '../src/crypto.js';
import { processOutbox } from '../src/notifications.js';
import { finalizeEventProcessed } from '../src/storage.js';

// Ephemeral dynamic Ed25519 keypair generated in memory for unit test execution only.
// Ensures zero hardcoded or shared secrets exist in source code or repositories.
const { publicKey: testPubObj, privateKey: testPrivObj } = crypto.generateKeyPairSync('ed25519');
const TEST_PUBLIC_KEY = testPubObj.export({ format: 'der', type: 'spki' }).toString('hex');
const TEST_PRIVATE_KEY = testPrivObj.export({ format: 'der', type: 'pkcs8' }).toString('hex');
const TEST_PADDLE_SECRET = 'pdl_ntf_set_test_secret_12345';

function createPaddleSignature(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signed = `${timestamp}:${body}`;
  const h1 = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `ts=${timestamp};h1=${h1}`;
}

// In-memory mock Redis store with atomic concurrency primitives
class MockRedisStore {
  constructor() {
    this.store = new Map();
    this.lists = new Map();
    this.sentEmails = [];
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
    if (op === 'LLEN') return (this.lists.get(cmd[1]) || []).length;
    if (op === 'EVAL') {
      const script = cmd[1];
      const keyCount = Number(cmd[2]);
      const keys = cmd.slice(3, 3 + keyCount);
      const args = cmd.slice(3 + keyCount);
      if (script.includes('SCANDIUM_EVENT_LOCK_ACQUIRE_V1')) {
        const [processedKey, lockKey] = keys;
        if (this.store.get(processedKey) === 'processed') return 'already_processed';
        if (this.store.has(lockKey)) return 'in_flight';
        this.store.set(lockKey, args[0]);
        return 'acquired';
      }
      if (script.includes('SCANDIUM_EVENT_LOCK_FINALIZE_V1')) {
        const [lockKey, processedKey] = keys;
        if (this.store.get(lockKey) !== args[0]) return 0;
        this.store.set(processedKey, 'processed');
        this.store.delete(lockKey);
        return 1;
      }
      if (script.includes('SCANDIUM_EVENT_LOCK_RELEASE_V1')) {
        if (this.store.get(keys[0]) !== args[0]) return 0;
        this.store.delete(keys[0]);
        return 1;
      }
      if (script.includes('SCANDIUM_DEVICE_REGISTER_V1')) {
        const raw = this.store.get(keys[0]);
        const devices = raw ? JSON.parse(raw) : [];
        const existing = devices.find(d => d.hardwareFingerprint === args[0]);
        if (existing) return ['reconnected', String(devices.length)];
        if (devices.length >= Number(args[3])) return ['limit_reached', String(devices.length)];
        devices.push({ hardwareFingerprint: args[0], instanceName: args[1], activatedAt: args[2] });
        this.store.set(keys[0], JSON.stringify(devices));
        return ['created', String(devices.length)];
      }
      if (script.includes('SCANDIUM_DEVICE_UNREGISTER_V1')) {
        const raw = this.store.get(keys[0]);
        const devices = raw ? JSON.parse(raw) : [];
        const filtered = devices.filter(d => d.hardwareFingerprint !== args[0]);
        this.store.set(keys[0], JSON.stringify(filtered));
        return filtered.length;
      }
      if (script.includes('SCANDIUM_CLAIM_CODE_VERIFY_V1')) {
        const raw = this.store.get(keys[0]);
        if (!raw) return -1;
        const record = JSON.parse(raw);
        if (Number(record.attempts || 0) >= 3) {
          this.store.delete(keys[0]);
          return -2;
        }
        if (record.codeHash !== args[0]) {
          record.attempts = Number(record.attempts || 0) + 1;
          this.store.set(keys[0], JSON.stringify(record));
          return -3;
        }
        this.store.delete(keys[0]);
        return 1;
      }
      throw new Error('Unsupported EVAL script in test mock');
    }
    if (op === 'LPUSH') {
      const listKey = cmd[1];
      const val = cmd[2];
      if (!this.lists.has(listKey)) this.lists.set(listKey, []);
      this.lists.get(listKey).unshift(val);
      return this.lists.get(listKey).length;
    }
    if (op === 'RPOP') {
      const listKey = cmd[1];
      const list = this.lists.get(listKey);
      if (!list || list.length === 0) return null;
      return list.pop();
    }
    if (op === 'DEL') {
      const had = this.store.has(cmd[1]);
      this.store.delete(cmd[1]);
      return had ? 1 : 0;
    }
    return null;
  }
}

describe('Scandium Licensing & Paddle Webhook Backend', () => {
  let mockRedis;
  let env;

  beforeEach(() => {
    mockRedis = new MockRedisStore();

    // Stub global fetch for Upstash Redis and transactional email mock
    globalThis.fetch = async (url, options = {}) => {
      const urlStr = String(url);
      if (urlStr.includes('mock-upstash.internal')) {
        const cmd = JSON.parse(options.body);
        const result = mockRedis.handleCommand(cmd);
        return new Response(JSON.stringify({ result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('api.sendgrid.com') || urlStr.includes('api.resend.com') || urlStr.includes('postmarkapp.com')) {
        mockRedis.sentEmails.push({ url: urlStr, body: JSON.parse(options.body || '{}') });
        return new Response(JSON.stringify({ id: 'mock_msg_123' }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unhandled mock fetch' }), { status: 500 });
    };

    env = {
      ENVIRONMENT: 'test',
      UPSTASH_REDIS_REST_URL: 'https://mock-upstash.internal',
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
      SCANDIUM_LICENSING_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SCANDIUM_LICENSE_ENCRYPTION_KEY: 'unit-test-encryption-key-32-bytes-minimum-0001',
      CRON_SECRET: 'unit-test-outbox-cron-secret-0001',
      RESEND_API_KEY: 're_test_mock_key',
      PADDLE_WEBHOOK_SECRET_KEY: TEST_PADDLE_SECRET,
      PADDLE_PLUS_PRICE_ID: 'pri_test_plus_100',
      PADDLE_PRO_PRICE_ID: 'pri_test_pro_200',
    };
  });

  it('serves root service information identifying Paddle and AES-256-GCM encrypted key storage', async () => {
    const req = new Request('https://worker.internal/', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.provider, 'Paddle Billing (Merchant of Record)');
    assert.equal(data.architecture, 'provider-independent');
    assert.equal(data.entropy, '192-bit CSPRNG');
    assert.equal(data.keyStorage, 'AES-256-GCM encrypted');
  });

  it('reports healthy (200) with both PADDLE_WEBHOOK_SECRET_KEY and PADDLE_WEBHOOK_SECRET alias', async () => {
    // 1. With primary PADDLE_WEBHOOK_SECRET_KEY
    const req1 = new Request('https://worker.internal/health', { method: 'GET' });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.status, 'healthy');
    assert.equal(data1.subsystems.paddleWebhook, 'configured');
    assert.equal(data1.subsystems.licenseEncryptionKey, 'configured');
    assert.equal(data1.subsystems.outboxCronSecret, 'configured');
    assert.equal(data1.subsystems.emailProvider, 'configured');

    // 2. With alias PADDLE_WEBHOOK_SECRET
    const aliasEnv = {
      ...env,
      PADDLE_WEBHOOK_SECRET_KEY: undefined,
      PADDLE_WEBHOOK_SECRET: TEST_PADDLE_SECRET,
    };
    const req2 = new Request('https://worker.internal/health', { method: 'GET' });
    const res2 = await worker.fetch(req2, aliasEnv);
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.status, 'healthy');
    assert.equal(data2.subsystems.paddleWebhook, 'configured');
  });

  it('fails closed on the internal outbox endpoint unless a dedicated Bearer secret is configured', async () => {
    const url = 'https://worker.internal/api/v1/internal/outbox/process';
    const noAuth = await worker.fetch(new Request(url, { method: 'POST' }), env);
    assert.equal(noAuth.status, 401);

    const badAuth = await worker.fetch(new Request(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret' },
    }), env);
    assert.equal(badAuth.status, 401);

    const missingSecretEnv = { ...env, CRON_SECRET: undefined };
    const noSecret = await worker.fetch(new Request(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer anything' },
    }), missingSecretEnv);
    assert.equal(noSecret.status, 503);

    const authorized = await worker.fetch(new Request(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.CRON_SECRET },
    }), env);
    assert.equal(authorized.status, 200);
  });

  it('does not finalize a webhook event after lock ownership has expired or changed', async () => {
    const eventId = 'evt_lock_owner_test';
    mockRedis.store.set('scandium:webhook:lock:' + eventId, 'current-owner');
    await assert.rejects(
      () => finalizeEventProcessed(env, eventId, 'stale-owner'),
      /Lost webhook lock ownership/
    );
    assert.notEqual(mockRedis.store.get('scandium:webhook:event:' + eventId), 'processed');
    assert.equal(mockRedis.store.get('scandium:webhook:lock:' + eventId), 'current-owner');
  });

  it('rejects unauthenticated webhook requests with invalid or missing Paddle-Signature', async () => {
    const bodyStr = JSON.stringify({ event_type: 'subscription.created', event_id: 'evt_001' });

    // Missing signature header -> 401
    const reqNoSig = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      body: bodyStr,
    });
    const resNoSig = await worker.fetch(reqNoSig, env);
    assert.equal(resNoSig.status, 401);

    // Invalid signature header -> 401
    const reqBadSig = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': 'ts=1234567890;h1=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad' },
      body: bodyStr,
    });
    const resBadSig = await worker.fetch(reqBadSig, env);
    assert.equal(resBadSig.status, 401);
  });

  it('processes Paddle customer.created and resolves customer_id on subscriptions without customer.email in payload', async () => {
    // 1. Paddle customer.created event
    const custEvent = {
      event_id: 'evt_cust_01',
      event_type: 'customer.created',
      occurred_at: '2026-11-20T08:00:00Z',
      data: {
        id: 'ctm_real_paddle_100',
        email: 'paddle_buyer@example.com',
        name: 'Paddle Buyer',
      },
    };
    const custBody = JSON.stringify(custEvent);
    const custSig = createPaddleSignature(custBody, TEST_PADDLE_SECRET);
    const custReq = new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': custSig },
      body: custBody,
    });
    const custRes = await worker.fetch(custReq, env);
    assert.equal(custRes.status, 200);
    const custData = await custRes.json();
    assert.equal(custData.status, 'success');

    // 2. Subscription event that only provides customer_id (no inline customer.email)
    const subEvent = {
      event_id: 'evt_sub_lookup_cust',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T08:05:00Z',
      data: {
        id: 'sub_lookup_001',
        customer_id: 'ctm_real_paddle_100',
        status: 'active',
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
    const subRes = await worker.fetch(subReq, env);
    assert.equal(subRes.status, 200);
    const subData = await subRes.json();
    assert.equal(subData.status, 'success');
    assert.equal(subData.processed, true);
    // Crucial: webhook response NEVER exposes customer license key
    assert.equal(subData.licenseKey, undefined);

    // Verify customer record can claim using resolved email
    const claimReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'paddle_buyer@example.com',
        orderId: 'sub_lookup_001',
        directClaim: true,
      }),
    });
    const claimRes = await worker.fetch(claimReq, env);
    assert.equal(claimRes.status, 200);
    const claimData = await claimRes.json();
    assert.equal(claimData.success, true);
    assert.ok(claimData.licenseKey.startsWith('SCANDIUM-PRO-'));
  });

  it('handles chargeback reversal with status: reversed and restores active entitlement', async () => {
    // 1. Initial active subscription
    const subEvent = {
      event_id: 'evt_cb_sub',
      event_type: 'subscription.created',
      occurred_at: '2026-11-20T09:00:00Z',
      data: {
        id: 'sub_cb_test',
        status: 'active',
        customer: { email: 'dispute@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const subBody = JSON.stringify(subEvent);
    const subSig = createPaddleSignature(subBody, TEST_PADDLE_SECRET);
    await worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': subSig },
      body: subBody,
    }), env);

    // 2. Approved chargeback adjustment -> revokes entitlement
    const cbAdj = {
      event_id: 'evt_adj_cb',
      event_type: 'adjustment.created',
      occurred_at: '2026-11-20T10:00:00Z',
      data: {
        id: 'adj_cb_01',
        action: 'chargeback',
        status: 'approved',
        subscription_id: 'sub_cb_test',
      },
    };
    const cbBody = JSON.stringify(cbAdj);
    const cbSig = createPaddleSignature(cbBody, TEST_PADDLE_SECRET);
    const cbRes = await worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': cbSig },
      body: cbBody,
    }), env);
    assert.equal(cbRes.status, 200);

    // 3. Documented Paddle chargeback reversal carries status: 'reversed'
    const revAdj = {
      event_id: 'evt_adj_rev',
      event_type: 'adjustment.updated',
      occurred_at: '2026-11-20T11:00:00Z',
      data: {
        id: 'adj_cb_01',
        action: 'chargeback_reverse',
        status: 'reversed', // Per official Paddle documentation
        subscription_id: 'sub_cb_test',
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const revBody = JSON.stringify(revAdj);
    const revSig = createPaddleSignature(revBody, TEST_PADDLE_SECRET);
    const revRes = await worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': revSig },
      body: revBody,
    }), env);
    assert.equal(revRes.status, 200);
    const revData = await revRes.json();
    assert.equal(revData.status, 'success');

    // Verify license status is restored to active
    const checkClaimReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dispute@example.com',
        orderId: 'sub_cb_test',
        directClaim: true,
      }),
    });
    const checkRes = await worker.fetch(checkClaimReq, env);
    const checkData = await checkRes.json();
    assert.equal(checkData.status, 'active');
    assert.equal(checkData.tier, 'pro');
  });

  it('truly tests simultaneous concurrent requests using Promise.all', async () => {
    const eventPayload = {
      event_id: 'evt_simultaneous_race',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_race_456',
        status: 'active',
        customer: { email: 'race_test@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const bodyStr = JSON.stringify(eventPayload);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);

    // Launch simultaneous requests at the exact same instant using Promise.all
    const [res1, res2] = await Promise.all([
      worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
        method: 'POST',
        headers: { 'Paddle-Signature': sig },
        body: bodyStr,
      }), env),
      worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
        method: 'POST',
        headers: { 'Paddle-Signature': sig },
        body: bodyStr,
      }), env),
    ]);

    const data1 = await res1.json();
    const data2 = await res2.json();

    const statuses = [data1.status, data2.status];
    // Exactly one must acquire the lock and succeed
    assert.ok(statuses.includes('success'));
    // The other must be blocked by the lock (already_processed or in_flight)
    assert.ok(statuses.includes('already_processed') || statuses.includes('in_flight'));
  });

  it('strictly rejects license claims with invalid order ID and requires two-factor email verification', async () => {
    // 1. Ingest transaction
    const txnEvent = {
      event_id: 'evt_claim_sec_01',
      event_type: 'transaction.completed',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'txn_sec_777',
        status: 'completed',
        customer: { email: 'alice.sec@example.com' },
        items: [{ price: { id: 'pri_test_plus_100' } }],
      },
    };
    const bodyStr = JSON.stringify(txnEvent);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);
    await worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    }), env);

    // 2. Bogus order ID with known email MUST NOT fallback to email lookup!
    const bogusReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice.sec@example.com',
        orderId: 'txn_bogus_fake_id',
      }),
    });
    const bogusRes = await worker.fetch(bogusReq, env);
    assert.equal(bogusRes.status, 404);

    // 3. Mismatched email with valid order ID -> 403 Forbidden
    const mismatchReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'attacker@evil.corp',
        orderId: 'txn_sec_777',
      }),
    });
    const mismatchRes = await worker.fetch(mismatchReq, env);
    assert.equal(mismatchRes.status, 403);

    // 4. Step 1: Request 6-digit claim verification code
    const step1Req = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'request',
        email: 'alice.sec@example.com',
        orderId: 'txn_sec_777',
      }),
    });
    const step1Res = await worker.fetch(step1Req, env);
    assert.equal(step1Res.status, 200);
    const step1Data = await step1Res.json();
    assert.equal(step1Data.verificationRequired, true);

    const otpKey = 'scandium:claim:code:alice.sec@example.com:txn_sec_777';
    const storedOtp = JSON.parse(mockRedis.store.get(otpKey));
    assert.ok(storedOtp.codeHash);
    assert.equal(storedOtp.code, undefined);

    // Read the code from the mocked email delivery, never from Redis.
    const sentEmail = mockRedis.sentEmails.find(item =>
      String(item.body.html || item.body.HtmlBody || '').includes('Your License Claim Verification Code')
    );
    assert.ok(sentEmail);
    const emailHtml = sentEmail.body.html || sentEmail.body.HtmlBody;
    const sentCode = emailHtml.match(/>(\d{6})<\/span>/)?.[1];
    assert.ok(/^\d{6}$/.test(sentCode));
    const queuedClaimCode = (mockRedis.lists.get('scandium:notifications:outbox') || [])
      .map(raw => JSON.parse(raw))
      .find(item => item.type === 'claim_code');
    assert.ok(!queuedClaimCode || !Object.hasOwn(queuedClaimCode, 'code'));

    // 5. Bad code rejected
    const badCodeReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verify',
        email: 'alice.sec@example.com',
        orderId: 'txn_sec_777',
        code: '999999',
      }),
    });
    const badCodeRes = await worker.fetch(badCodeReq, env);
    assert.equal(badCodeRes.status, 400);

    // 6. Good code reveals decrypted license key
    const goodCodeReq = new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'verify',
        email: 'alice.sec@example.com',
        orderId: 'txn_sec_777',
        code: sentCode,
      }),
    });
    const goodCodeRes = await worker.fetch(goodCodeReq, env);
    assert.equal(goodCodeRes.status, 200);
    const goodCodeData = await goodCodeRes.json();
    assert.equal(goodCodeData.success, true);
    assert.ok(goodCodeData.licenseKey.startsWith('SCANDIUM-PLUS-'));
    assert.equal(goodCodeData.tier, 'plus');
  });

  it('activates and validates with Ed25519 signatures and serializes concurrent device activations', async () => {
    // 1. Create license via webhook
    const subEvent = {
      event_id: 'evt_act_dev_01',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_dev_test',
        status: 'active',
        customer: { email: 'devices@example.com' },
        items: [{ price: { id: 'pri_test_plus_100' } }], // Plus tier = limit 2
      },
    };
    const bodyStr = JSON.stringify(subEvent);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);
    await worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    }), env);

    // Retrieve license key
    const claimRes = await worker.fetch(new Request('https://worker.internal/api/v1/license/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'devices@example.com',
        orderId: 'sub_dev_test',
        directClaim: true,
      }),
    }), env);
    const { licenseKey } = await claimRes.json();

    // 2. Launch 4 simultaneous device registrations on a license with limit 2
    const results = await Promise.all([
      worker.fetch(new Request('https://worker.internal/api/v1/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, hardwareFingerprint: 'dev_01', instanceName: 'Node-1' }),
      }), env),
      worker.fetch(new Request('https://worker.internal/api/v1/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, hardwareFingerprint: 'dev_02', instanceName: 'Node-2' }),
      }), env),
      worker.fetch(new Request('https://worker.internal/api/v1/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, hardwareFingerprint: 'dev_03', instanceName: 'Node-3' }),
      }), env),
      worker.fetch(new Request('https://worker.internal/api/v1/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey, hardwareFingerprint: 'dev_04', instanceName: 'Node-4' }),
      }), env),
    ]);

    const statusCodes = results.map(r => r.status);
    const successCount = statusCodes.filter(s => s === 200).length;
    const rejectedCount = statusCodes.filter(s => s === 409).length;

    // Strict limit enforcement: exactly 2 devices succeeded, and 2 rejected
    assert.equal(successCount, 2);
    assert.equal(rejectedCount, 2);

    // Verify valid signature on one of the successful activations
    const successfulRes = results.find(r => r.status === 200);
    const successfulData = await successfulRes.json();
    const isSigValid = await verifyLicensePayload(successfulData.license, successfulData.signature, TEST_PUBLIC_KEY);
    assert.equal(isSigValid, true);
  });

  it('retries outbox delivery with SendGrid configuration', async () => {
    const sendGridEnv = {
      ...env,
      SENDGRID_API_KEY: 'SG.test_mock_token_12345',
      EMAIL_FROM: 'Scandium Assistant <licensing@scandium.dev>',
    };

    // 1. Create a subscription and queue delivery
    const subEvent = {
      event_id: 'evt_outbox_test',
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_outbox_123',
        status: 'active',
        customer: { email: 'retry@example.com' },
        items: [{ price: { id: 'pri_test_pro_200' } }],
      },
    };
    const bodyStr = JSON.stringify(subEvent);
    const sig = createPaddleSignature(bodyStr, TEST_PADDLE_SECRET);
    await worker.fetch(new Request('https://worker.internal/api/webhook/paddle', {
      method: 'POST',
      headers: { 'Paddle-Signature': sig },
      body: bodyStr,
    }), env);

    // 2. Trigger outbox processor with SendGrid credentials configured
    const outboxResult = await processOutbox(sendGridEnv, 10);
    assert.ok(outboxResult.processed >= 1);
  });
});
