/**
 * Provider-independent Scandium Licensing Service Handlers.
 * Serves activation, validation, and deactivation for desktop clients.
 * Generates asymmetric Ed25519 cryptographic signatures on entitlement payloads.
 */

import { sha256Hex, signLicensePayload } from './crypto.js';
import {
  getLicenseByHash,
  getActiveDevices,
  registerDevice,
  unregisterDevice,
} from './storage.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleActivate(request, env) {
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

  if (licenseRecord.status !== 'active') {
    return jsonResponse({
      success: false,
      error: `License key is not active (current status: ${licenseRecord.status})`,
    }, 403);
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
    return jsonResponse({
      success: false,
      error: `Device activation limit reached (${regResult.count}/${maxDevices}). Please deactivate an existing device before activating on this machine.`,
    }, 409);
  }

  const licensePayload = {
    licenseKey,
    tier: licenseRecord.tier,
    status: 'active',
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
    return jsonResponse({
      success: false,
      valid: false,
      error: 'Device hardware fingerprint is not registered for this license. Re-activation required.',
    }, 403);
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

  const licensePayload = {
    licenseKey,
    tier: currentStatus === 'active' ? licenseRecord.tier : 'free',
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
    valid: currentStatus === 'active',
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
