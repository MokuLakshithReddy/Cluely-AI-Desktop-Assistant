/**
 * Provider-independent Scandium Licensing Service Handlers.
 * Serves activation, validation, deactivation, and self-service license claim.
 * Generates asymmetric Ed25519 cryptographic signatures on entitlement payloads,
 * and enforces strict IP and hardware rate limiting.
 */

import { sha256Hex, signLicensePayload } from './crypto.js';
import {
  getLicenseByHash,
  getActiveDevices,
  registerDevice,
  unregisterDevice,
  checkRateLimit,
  getSubscription,
  getTransaction,
  getLicenseByCustomer,
} from './storage.js';

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

export async function handleActivate(request, env) {
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await checkRateLimit(env, 'activate', clientIp, 10, 900);
  if (!rl.allowed) {
    return jsonResponse(
      {
        success: false,
        error: 'Too many activation attempts. Please wait 15 minutes before retrying.',
      },
      429,
      { 'Retry-After': String(rl.resetSeconds) }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Malformed JSON payload' }, 400);
  }

  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const hardwareFingerprint = typeof body.hardwareFingerprint === 'string' ? body.hardwareFingerprint.trim() : '';
  const instanceName = typeof body.instanceName === 'string' ? body.instanceName.trim() : '';

  if (!licenseKey) {
    return jsonResponse({ success: false, error: 'Missing licenseKey parameter' }, 400);
  }
  if (!hardwareFingerprint || !instanceName) {
    return jsonResponse({ success: false, error: 'Missing hardwareFingerprint or instanceName parameter' }, 400);
  }

  const signingKey = env.SCANDIUM_LICENSING_PRIVATE_KEY;
  if (!signingKey) {
    return jsonResponse({ success: false, error: 'Server licensing signing key unconfigured' }, 503);
  }

  const keyHash = await sha256Hex(licenseKey);
  const licenseRecord = await getLicenseByHash(env, keyHash);

  if (!licenseRecord) {
    return jsonResponse({ success: false, error: 'License key not found or unrecognized' }, 404);
  }

  // Allow 'active' or 'past_due' (grace retention during Paddle recovery dunning)
  if (licenseRecord.status !== 'active' && licenseRecord.status !== 'past_due') {
    return jsonResponse(
      {
        success: false,
        error: `License key is not active (current status: ${licenseRecord.status})`,
      },
      403
    );
  }

  // Check expiration
  if (licenseRecord.expiresAt) {
    const exp = Date.parse(licenseRecord.expiresAt);
    if (!Number.isNaN(exp) && exp < Date.now()) {
      return jsonResponse({ success: false, error: 'License subscription has expired' }, 403);
    }
  }

  const maxDevices = licenseRecord.tier === 'pro' ? 5 : 2;
  const regResult = await registerDevice(env, keyHash, hardwareFingerprint, instanceName, maxDevices);

  if (!regResult.success) {
    return jsonResponse(
      {
        success: false,
        error: `Device activation limit reached (${regResult.count}/${maxDevices}). Please deactivate an existing device before activating on this machine.`,
      },
      409
    );
  }

  const licensePayload = {
    licenseKey,
    tier: licenseRecord.tier,
    status: licenseRecord.status,
    instanceName,
    hardwareFingerprint,
    customerEmail: licenseRecord.customerEmail || undefined,
    activationLimit: maxDevices,
    activationUsage: regResult.count,
    activatedAt: new Date().toISOString(),
    expiresAt: licenseRecord.expiresAt || null,
    issuedAt: Date.now(),
  };

  const signature = await signLicensePayload(licensePayload, signingKey);

  return jsonResponse({
    success: true,
    license: licensePayload,
    signature,
  });
}

export async function handleValidate(request, env) {
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await checkRateLimit(env, 'validate', clientIp, 60, 900);
  if (!rl.allowed) {
    return jsonResponse(
      { success: false, error: 'Rate limit exceeded. Please wait before retrying.' },
      429,
      { 'Retry-After': String(rl.resetSeconds) }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Malformed JSON payload' }, 400);
  }

  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const hardwareFingerprint = typeof body.hardwareFingerprint === 'string' ? body.hardwareFingerprint.trim() : '';
  const instanceName = typeof body.instanceName === 'string' ? body.instanceName.trim() : '';

  if (!licenseKey || !hardwareFingerprint) {
    return jsonResponse({ success: false, error: 'Missing licenseKey or hardwareFingerprint' }, 400);
  }

  const signingKey = env.SCANDIUM_LICENSING_PRIVATE_KEY;
  if (!signingKey) {
    return jsonResponse({ success: false, error: 'Server licensing signing key unconfigured' }, 503);
  }

  const keyHash = await sha256Hex(licenseKey);
  const licenseRecord = await getLicenseByHash(env, keyHash);

  if (!licenseRecord) {
    return jsonResponse({ success: false, valid: false, error: 'License key not found' }, 404);
  }

  // Verify device is registered
  const devices = await getActiveDevices(env, keyHash);
  const isDeviceRegistered = devices.some(d => d.hardwareFingerprint === hardwareFingerprint);
  if (!isDeviceRegistered) {
    return jsonResponse(
      {
        success: false,
        valid: false,
        error: 'Device hardware fingerprint is not registered for this license. Re-activation required.',
      },
      403
    );
  }

  // Check expiration
  let isExpired = false;
  if (licenseRecord.expiresAt) {
    const exp = Date.parse(licenseRecord.expiresAt);
    if (!Number.isNaN(exp) && exp < Date.now()) {
      isExpired = true;
    }
  }

  const currentStatus = isExpired ? 'expired' : licenseRecord.status;
  const maxDevices = licenseRecord.tier === 'pro' ? 5 : 2;
  const isEntitled = currentStatus === 'active' || currentStatus === 'past_due';

  const licensePayload = {
    licenseKey,
    tier: isEntitled ? licenseRecord.tier : 'free',
    status: currentStatus,
    instanceName: instanceName || `Scandium-device-${hardwareFingerprint.slice(0, 8)}`,
    hardwareFingerprint,
    customerEmail: licenseRecord.customerEmail || undefined,
    activationLimit: maxDevices,
    activationUsage: devices.length,
    activatedAt: licenseRecord.activatedAt || new Date().toISOString(),
    expiresAt: licenseRecord.expiresAt || null,
    issuedAt: Date.now(),
  };

  const signature = await signLicensePayload(licensePayload, signingKey);

  return jsonResponse({
    success: true,
    valid: isEntitled,
    license: licensePayload,
    signature,
  });
}

export async function handleDeactivate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Malformed JSON payload' }, 400);
  }

  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const hardwareFingerprint = typeof body.hardwareFingerprint === 'string' ? body.hardwareFingerprint.trim() : '';

  if (!licenseKey || !hardwareFingerprint) {
    return jsonResponse({ success: false, error: 'Missing licenseKey or hardwareFingerprint' }, 400);
  }

  const keyHash = await sha256Hex(licenseKey);
  await unregisterDevice(env, keyHash, hardwareFingerprint);

  return jsonResponse({ success: true, deactivated: true });
}

/**
 * Customer Self-Service License Claim & Lookup Handler.
 * Allows purchasing customers to securely retrieve their license key
 * by supplying their purchase email and associated order/transaction/subscription ID.
 */
export async function handleClaim(request, env) {
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await checkRateLimit(env, 'claim', clientIp, 5, 900);
  if (!rl.allowed) {
    return jsonResponse(
      {
        success: false,
        error: 'Too many license claim requests. Please wait 15 minutes before retrying.',
      },
      429,
      { 'Retry-After': String(rl.resetSeconds) }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'Malformed JSON payload' }, 400);
  }

  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : '';
  const orderId = typeof body.orderId === 'string'
    ? body.orderId.trim()
    : typeof body.transactionId === 'string'
    ? body.transactionId.trim()
    : typeof body.subscriptionId === 'string'
    ? body.subscriptionId.trim()
    : '';

  if (!email || !orderId) {
    return jsonResponse(
      { success: false, error: 'Both email and orderId (transaction or subscription ID) are required.' },
      400
    );
  }

  // 1. Check direct transaction record
  let resolvedKey;
  const txnRecord = await getTransaction(env, orderId);
  if (txnRecord?.licenseKey) {
    resolvedKey = txnRecord.licenseKey;
  }

  // 2. Check subscription record
  if (!resolvedKey) {
    const subRecord = await getSubscription(env, orderId);
    if (subRecord?.licenseKey) {
      resolvedKey = subRecord.licenseKey;
    }
  }

  // 3. Check customer email index as fallback
  if (!resolvedKey) {
    const custKey = await getLicenseByCustomer(env, email);
    if (custKey) {
      resolvedKey = custKey;
    }
  }

  if (!resolvedKey) {
    return jsonResponse(
      {
        success: false,
        error: 'No active license found matching the provided email and order reference. Please check your order ID or contact support.',
      },
      404
    );
  }

  // Retrieve license and verify email match for data protection
  const keyHash = await sha256Hex(resolvedKey);
  const licenseRecord = await getLicenseByHash(env, keyHash);

  if (!licenseRecord) {
    return jsonResponse({ success: false, error: 'License record not found' }, 404);
  }

  if (licenseRecord.customerEmail && licenseRecord.customerEmail.toLowerCase().trim() !== email) {
    return jsonResponse(
      { success: false, error: 'Order reference does not match the provided email address.' },
      403
    );
  }

  return jsonResponse({
    success: true,
    licenseKey: resolvedKey,
    tier: licenseRecord.tier,
    status: licenseRecord.status,
    customerEmail: licenseRecord.customerEmail,
    activationLimit: licenseRecord.tier === 'pro' ? 5 : 2,
    expiresAt: licenseRecord.expiresAt || null,
    activationInstructions: [
      '1. Open Scandium Assistant on your computer.',
      '2. Navigate to Dashboard -> Subscription & License.',
      '3. Enter your license key and click Activate.',
    ],
  });
}
