import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../src/index.js';

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('Scandium Billing Webhook Worker', () => {
  const secret = 'test-lemon-webhook-secret-xyz';
  const env = {
    LEMON_SQUEEZY_WEBHOOK_SECRET: secret,
    LEMON_PLUS_PRODUCT_ID: 'prod_plus_100',
    LEMON_PLUS_VARIANT_ID: 'var_plus_101',
    LEMON_PRO_PRODUCT_ID: 'prod_pro_200',
    LEMON_PRO_VARIANT_ID: 'var_pro_201',
  };

  it('serves root service information', async () => {
    const req = new Request('https://scandium.internal/', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.service, 'Scandium Billing Webhook Receiver');
    assert.equal(data.version, '1.0.3');
  });

  it('serves health status', async () => {
    const req = new Request('https://scandium.internal/health', { method: 'GET' });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'healthy');
    assert.equal(data.lemonSqueezyWebhookConfigured, true);
  });

  it('rejects webhooks with missing or invalid HMAC signature (401)', async () => {
    const payload = JSON.stringify({ meta: { event_name: 'subscription_created' } });
    
    // No signature
    const req1 = new Request('https://scandium.internal/api/webhook/lemonsqueezy', {
      method: 'POST',
      body: payload,
    });
    const res1 = await worker.fetch(req1, env);
    assert.equal(res1.status, 401);

    // Invalid signature
    const req2 = new Request('https://scandium.internal/api/webhook/lemonsqueezy', {
      method: 'POST',
      headers: { 'x-signature': '0'.repeat(64) },
      body: payload,
    });
    const res2 = await worker.fetch(req2, env);
    assert.equal(res2.status, 401);
  });

  it('rejects malformed payload (400)', async () => {
    const payload = 'not-valid-json';
    const sig = sign(payload, secret);
    const req = new Request('https://scandium.internal/api/webhook/lemonsqueezy', {
      method: 'POST',
      headers: { 'x-signature': sig },
      body: payload,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 400);
  });

  it('correctly maps Plus active subscription and resolves tier', async () => {
    const payload = JSON.stringify({
      meta: {
        event_name: 'subscription_created',
        custom_data: { event_id: 'evt_test_1' },
      },
      data: {
        id: 'sub_123',
        attributes: {
          product_id: 'prod_plus_100',
          variant_id: 'var_plus_101',
          status: 'active',
          user_email: 'buyer@example.com',
          key: 'SCANDIUM-PLUS-KEY-001',
          created_at: '2026-11-20T00:00:00Z',
        },
      },
    });
    const sig = sign(payload, secret);
    const req = new Request('https://scandium.internal/api/webhook/lemonsqueezy', {
      method: 'POST',
      headers: { 'x-signature': sig },
      body: payload,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.transition.tier, 'plus');
    assert.equal(body.transition.entitlementState, 'active');
    assert.equal(body.transition.licenseKey, 'SCANDIUM-PLUS-KEY-001');
    assert.equal(body.transition.userEmail, 'buyer@example.com');
  });

  it('correctly maps Pro past_due and fails closed to free tier', async () => {
    const payload = JSON.stringify({
      meta: {
        event_name: 'subscription_payment_failed',
        custom_data: { event_id: 'evt_test_2' },
      },
      data: {
        id: 'sub_456',
        attributes: {
          product_id: 'prod_pro_200',
          variant_id: 'var_pro_201',
          status: 'past_due',
          user_email: 'pro@example.com',
          created_at: '2026-11-20T00:00:00Z',
        },
      },
    });
    const sig = sign(payload, secret);
    const req = new Request('https://scandium.internal/api/webhook/lemonsqueezy', {
      method: 'POST',
      headers: { 'x-signature': sig },
      body: payload,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.transition.tier, 'free');
    assert.equal(body.transition.entitlementState, 'past_due');
  });

  it('fails closed to free tier for unrecognized product/variant IDs', async () => {
    const payload = JSON.stringify({
      meta: {
        event_name: 'subscription_created',
        custom_data: { event_id: 'evt_test_3' },
      },
      data: {
        id: 'sub_789',
        attributes: {
          product_id: 'unknown_prod',
          variant_id: 'unknown_var',
          status: 'active',
          user_email: 'attacker@example.com',
          created_at: '2026-11-20T00:00:00Z',
        },
      },
    });
    const sig = sign(payload, secret);
    const req = new Request('https://scandium.internal/api/webhook/lemonsqueezy', {
      method: 'POST',
      headers: { 'x-signature': sig },
      body: payload,
    });
    const res = await worker.fetch(req, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.transition.tier, 'free');
    assert.equal(body.transition.entitlementState, 'disabled');
  });
});
