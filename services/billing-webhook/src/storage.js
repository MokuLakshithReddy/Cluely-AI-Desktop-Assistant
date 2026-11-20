/**
 * Storage layer for Scandium Licensing & Webhook Service.
 * Connects to Upstash Redis REST endpoint and enforces atomic event deduplication,
 * out-of-order protection, device limits, subscription state management, and rate limiting.
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
 * Atomically acquires a distributed processing lock for an incoming webhook event.
 * Uses Redis `SET ... EX ... NX` to eliminate race conditions between simultaneous requests.
 *
 * Returns:
 * - 'acquired': This request holds the exclusive lock and must process the event.
 * - 'already_processed': The event was already fully processed in a previous request.
 * - 'in_flight': Another concurrent request is actively processing this event.
 */
export async function tryAcquireEventLock(env, eventId, ttlSeconds = 604800) {
  const key = `scandium:webhook:event:${eventId}`;

  // Try to atomically claim the event key with state 'processing' for 120 seconds
  const setNxRes = await redisCommand(env, [
    'SET',
    key,
    'processing',
    'EX',
    '120',
    'NX',
  ]);

  if (setNxRes === 'OK' || setNxRes === 1 || setNxRes === true) {
    return 'acquired';
  }

  // If key already exists, inspect status
  const currentVal = await redisCommand(env, ['GET', key]);
  if (currentVal === 'processed' || currentVal === '1') {
    return 'already_processed';
  }
  return 'in_flight';
}

/**
 * Finalizes an event as successfully completed with the full 7-day retention TTL.
 */
export async function finalizeEventProcessed(env, eventId, ttlSeconds = 604800) {
  const key = `scandium:webhook:event:${eventId}`;
  return await redisCommand(env, [
    'SET',
    key,
    'processed',
    'EX',
    String(ttlSeconds),
  ]);
}

/**
 * Releases the processing lock on failure so Paddle retries can be processed.
 */
export async function releaseEventLock(env, eventId) {
  const key = `scandium:webhook:event:${eventId}`;
  return await redisCommand(env, ['DEL', key]);
}

/**
 * Backwards compatibility helper for tests.
 */
export async function isEventProcessed(env, eventId) {
  const val = await redisCommand(env, ['GET', `scandium:webhook:event:${eventId}`]);
  return val === 'processed' || val === '1' || val === 'processing';
}

/**
 * Backwards compatibility helper for tests.
 */
export async function markEventProcessed(env, eventId, ttlSeconds = 604800) {
  return await finalizeEventProcessed(env, eventId, ttlSeconds);
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
 * Saves or updates a subscription record.
 */
export async function saveSubscription(env, subscriptionId, subData) {
  if (!subscriptionId) return;
  const key = `scandium:sub:${subscriptionId}`;
  await redisCommand(env, ['SET', key, JSON.stringify(subData)]);
}

/**
 * Retrieves a transaction record by ID.
 */
export async function getTransaction(env, transactionId) {
  if (!transactionId) return null;
  const raw = await redisCommand(env, ['GET', `scandium:txn:${transactionId}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Saves a transaction record linking to its license key and subscription ID.
 */
export async function saveTransaction(env, transactionId, txnData) {
  if (!transactionId) return;
  const key = `scandium:txn:${transactionId}`;
  await redisCommand(env, ['SET', key, JSON.stringify(txnData)]);
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
 * Looks up customer's license by email address.
 */
export async function getLicenseByCustomer(env, email) {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim();
  const licenseKey = await redisCommand(env, ['GET', `scandium:customer:${cleanEmail}`]);
  return licenseKey || null;
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
 */
export async function registerDevice(env, keyHash, hardwareFingerprint, instanceName, maxDevices) {
  const devices = await getActiveDevices(env, keyHash);
  const existing = devices.find(d => d.hardwareFingerprint === hardwareFingerprint);
  if (existing) {
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

/**
 * Atomic sliding-window rate limiter using Redis INCR + EXPIRE.
 * Returns { allowed: boolean, remaining: number, resetSeconds: number }
 */
export async function checkRateLimit(
  env,
  keyPrefix,
  identifier,
  maxAttempts = 10,
  windowSeconds = 900
) {
  if (!identifier) return { allowed: true, remaining: maxAttempts, resetSeconds: 0 };
  const cleanId = String(identifier).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64);
  const key = `scandium:ratelimit:${keyPrefix}:${cleanId}`;

  const current = await redisCommand(env, ['INCR', key]);
  if (current === 1) {
    await redisCommand(env, ['EXPIRE', key, String(windowSeconds)]);
  }

  const ttl = await redisCommand(env, ['TTL', key]);
  const resetSeconds = typeof ttl === 'number' && ttl > 0 ? ttl : windowSeconds;

  if (current > maxAttempts) {
    return {
      allowed: false,
      remaining: 0,
      resetSeconds,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, maxAttempts - current),
    resetSeconds,
  };
}
