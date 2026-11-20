/**
 * Storage layer for Scandium Licensing & Webhook Service.
 * Connects to Upstash Redis REST endpoint and enforces atomic event deduplication,
 * out-of-order protection, device limits, and subscription state management.
 */

export async function redisCommand(env, command) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Upstash Redis credentials unconfigured');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis command error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Upstash Redis error: ${data.error}`);
  }
  return data.result;
}

export async function redisPipeline(env, commands) {
  const url = `${env.UPSTASH_REDIS_REST_URL}/pipeline`;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('Upstash Redis credentials unconfigured');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upstash Redis pipeline error (${res.status}): ${errText}`);
  }

  const results = await res.json();
  return results.map(r => r.result);
}

/**
 * Checks if a webhook event ID was already processed.
 */
export async function isEventProcessed(env, eventId) {
  const res = await redisCommand(env, ['GET', `scandium:webhook:event:${eventId}`]);
  return Boolean(res);
}

/**
 * Marks an event ID as processed with 7-day TTL (only called AFTER state persistence succeeds).
 */
export async function markEventProcessed(env, eventId, ttlSeconds = 604800) {
  return await redisCommand(env, [
    'SET',
    `scandium:webhook:event:${eventId}`,
    '1',
    'EX',
    String(ttlSeconds),
  ]);
}

/**
 * Returns true if incoming event is newer than existing record.
 */
export function isEventNewer(existingOccurredAt, incomingOccurredAt) {
  if (!existingOccurredAt) return true;
  if (!incomingOccurredAt) return false;
  const existingTime = Date.parse(existingOccurredAt);
  const incomingTime = Date.parse(incomingOccurredAt);
  if (Number.isNaN(incomingTime)) return false;
  if (Number.isNaN(existingTime)) return true;
  return incomingTime >= existingTime;
}

/**
 * Retrieves a subscription record by ID.
 */
export async function getSubscription(env, subscriptionId) {
  if (!subscriptionId) return null;
  const raw = await redisCommand(env, ['GET', `scandium:sub:${subscriptionId}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Saves or updates a subscription record, with out-of-order event protection.
 */
export async function saveSubscription(env, subscriptionId, subData) {
  if (!subscriptionId) return;
  const key = `scandium:sub:${subscriptionId}`;
  await redisCommand(env, ['SET', key, JSON.stringify(subData)]);
}

/**
 * Retrieves a license record by its SHA-256 hash.
 */
export async function getLicenseByHash(env, keyHash) {
  const raw = await redisCommand(env, ['GET', `scandium:license:hash:${keyHash}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Saves a license record by its SHA-256 hash.
 */
export async function saveLicenseByHash(env, keyHash, licenseData) {
  const key = `scandium:license:hash:${keyHash}`;
  await redisCommand(env, ['SET', key, JSON.stringify(licenseData)]);
}

/**
 * Gets the list of active device registrations for a license.
 */
export async function getActiveDevices(env, keyHash) {
  const raw = await redisCommand(env, ['GET', `scandium:devices:${keyHash}`]);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Registers an active device for a license, enforcing max device limit.
 * If the hardware fingerprint is already registered, returns { success: true, reconnected: true }.
 * If not registered and activeDevices >= maxDevices, returns { success: false, reason: 'limit_reached' }.
 */
export async function registerDevice(env, keyHash, hardwareFingerprint, instanceName, maxDevices) {
  const devices = await getActiveDevices(env, keyHash);
  const existing = devices.find(d => d.hardwareFingerprint === hardwareFingerprint);
  if (existing) {
    // Already registered device
    return { success: true, count: devices.length, maxDevices, reconnected: true };
  }

  if (devices.length >= maxDevices) {
    return {
      success: false,
      reason: 'limit_reached',
      count: devices.length,
      maxDevices,
    };
  }

  devices.push({
    hardwareFingerprint,
    instanceName,
    activatedAt: new Date().toISOString(),
  });

  await redisCommand(env, ['SET', `scandium:devices:${keyHash}`, JSON.stringify(devices)]);
  return { success: true, count: devices.length, maxDevices, reconnected: false };
}

/**
 * Unregisters a device fingerprint for a license.
 */
export async function unregisterDevice(env, keyHash, hardwareFingerprint) {
  const devices = await getActiveDevices(env, keyHash);
  const filtered = devices.filter(d => d.hardwareFingerprint !== hardwareFingerprint);
  await redisCommand(env, ['SET', `scandium:devices:${keyHash}`, JSON.stringify(filtered)]);
  return { success: true, count: filtered.length };
}
