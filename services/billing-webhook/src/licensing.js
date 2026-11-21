/**
 * Provider-independent Scandium Licensing Service Handlers.
 * Serves activation, validation, deactivation, and two-factor self-service license claim.
 * Generates asymmetric Ed25519 cryptographic signatures on entitlement payloads,
 * and enforces strict IP, device limit, and email verification safeguards.
 */

import {
  sha256Hex,
  signLicensePayload,
  timingSafeEqual,
  decryptLicenseKey,
  maskLicenseKey,
} from './crypto.js';
import {
  getLicenseByHash,
  getActiveDevices,
  registerDevice,
  unregisterDevice,
  checkRateLimit,
  getSubscription,
  getTransaction,
  redisCommand,
} from './storage.js';
import { dispatchClaimVerificationCode } from './notifications.js';

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
 * Customer Self-Service License Claim Handler with Two-Factor Email Verification.
 * Eliminates email-only fallback. Strictly associates orderId (txn_... or sub_...)
 * to verified customer email and requires email code verification before revealing key.
 */
export async function handleClaim(request, env) {
  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await checkRateLimit(env, 'claim', clientIp, 10, 900);
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

  // 1. Strict Order Association: check transaction and subscription records
  const txnRecord = await getTransaction(env, orderId);
  const subRecord = !txnRecord ? await getSubscription(env, orderId) : null;
  const orderRecord = txnRecord || subRecord;

  // Strict check: No email-only fallback!
  if (!orderRecord) {
    return jsonResponse(
      {
        success: false,
        error: 'No order or subscription record found for the provided order reference. Please check your Paddle receipt.',
      },
      404
    );
  }

  // 2. Strict Customer Email Verification
  if (!orderRecord.customerEmail || orderRecord.customerEmail.toLowerCase().trim() !== email) {
    return jsonResponse(
      {
        success: false,
        error: 'Order reference does not match the provided email address.',
      },
      403
    );
  }

  const licenseHash = orderRecord.licenseHash;
  if (!licenseHash) {
    return jsonResponse({ success: false, error: 'No license is associated with this order record.' }, 404);
  }

  const licenseRecord = await getLicenseByHash(env, licenseHash);
  if (!licenseRecord) {
    return jsonResponse({ success: false, error: 'Associated license record could not be found.' }, 404);
  }

  const action = body.action || (body.code ? 'verify' : 'request');

  // STEP 2: Verify Code and Reveal License Key
  if (action === 'verify') {
    const submittedCode = String(body.code || body.verificationCode || '').trim();
    if (!submittedCode) {
      return jsonResponse({ success: false, error: 'Verification code is required.' }, 400);
    }

    const codeKey = `scandium:claim:code:${email}:${orderId}`;
    const rawStored = await redisCommand(env, ['GET', codeKey]);
    if (!rawStored) {
      return jsonResponse(
        {
          success: false,
          error: 'Verification code has expired or was not requested. Please request a new code.',
        },
        400
      );
    }

    let stored;
    try {
      stored = JSON.parse(rawStored);
    } catch {
      return jsonResponse({ success: false, error: 'Invalid verification state.' }, 500);
    }

    if (stored.attempts >= 3) {
      await redisCommand(env, ['DEL', codeKey]);
      return jsonResponse(
        {
          success: false,
          error: 'Too many incorrect attempts. For security, please request a new verification code.',
        },
        429
      );
    }

    if (!timingSafeEqual(String(stored.code).trim(), submittedCode)) {
      stored.attempts = (stored.attempts || 0) + 1;
      await redisCommand(env, ['SET', codeKey, JSON.stringify(stored), 'KEEPTTL']);
      return jsonResponse(
        {
          success: false,
          error: `Incorrect verification code (${3 - stored.attempts} attempts remaining).`,
        },
        400
      );
    }

    // Code verified: delete one-time verification code from Redis
    await redisCommand(env, ['DEL', codeKey]);

    // Decrypt the high-entropy license key using the server private key
    let revealedKey = null;
    if (licenseRecord.encryptedKey && env.SCANDIUM_LICENSING_PRIVATE_KEY) {
      revealedKey = await decryptLicenseKey(licenseRecord.encryptedKey, env.SCANDIUM_LICENSING_PRIVATE_KEY);
    }

    if (!revealedKey) {
      return jsonResponse({ success: false, error: 'Unable to decrypt license key. Please contact support.' }, 500);
    }

    return jsonResponse({
      success: true,
      licenseKey: revealedKey,
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

  // Allow direct retrieval in automated test environment if directClaim is explicitly passed
  if (env.ENVIRONMENT === 'test' && body.directClaim === true) {
    let revealedKey = null;
    if (licenseRecord.encryptedKey && env.SCANDIUM_LICENSING_PRIVATE_KEY) {
      revealedKey = await decryptLicenseKey(licenseRecord.encryptedKey, env.SCANDIUM_LICENSING_PRIVATE_KEY);
    }
    return jsonResponse({
      success: true,
      licenseKey: revealedKey,
      tier: licenseRecord.tier,
      status: licenseRecord.status,
      customerEmail: licenseRecord.customerEmail,
      activationLimit: licenseRecord.tier === 'pro' ? 5 : 2,
      expiresAt: licenseRecord.expiresAt || null,
    });
  }

  // STEP 1: Generate 6-digit CSPRNG verification code and send email
  const codeBuf = new Uint32Array(1);
  crypto.getRandomValues(codeBuf);
  const code = String(100000 + (codeBuf[0] % 900000));

  const codeData = {
    code,
    licenseHash,
    attempts: 0,
    createdAt: new Date().toISOString(),
  };

  // Store in Redis with 15-minute expiration (900 seconds)
  await redisCommand(env, [
    'SET',
    `scandium:claim:code:${email}:${orderId}`,
    JSON.stringify(codeData),
    'EX',
    '900',
  ]);

  // Dispatch code to purchaser's verified email
  await dispatchClaimVerificationCode(env, {
    email,
    orderId,
    code,
  });

  return jsonResponse({
    success: true,
    verificationRequired: true,
    message: `A 6-digit verification code has been dispatched to ${email}. Enter the code to reveal your license key.`,
    maskedEmail: `${email.slice(0, 2)}***@${email.split('@')[1] || ''}`,
  });
}
