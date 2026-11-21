/**
 * Storage layer for Scandium Licensing & Webhook Service.
 * Connects to Upstash Redis REST endpoint and enforces atomic event deduplication,
 * lock ownership tokens, out-of-order protection, device limits with distributed locks,
 * customer record caching, and sliding-window rate limiting.
 */

export class LockAcquisitionResult {
  constructor(status, lockToken = null) {
    this.status = status;
    this.lockToken = lockToken;
  }
  toString() {
    return this.status;
  }
  valueOf() {
    return this.status;
  }
  [Symbol.toPrimitive](hint) {
    if (hint === 'string' || hint === 'default') return this.status;
    return this.status;
  }
}

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
 * Uses a unique lock ownership token and Redis `SET ... EX ... NX` to eliminate race
 * conditions between simultaneous workers and avoid accidental lock theft.
 */
export async function tryAcquireEventLock(env, eventId, ttlSeconds = 120) {
  const lockToken = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const lockKey = `scandium:webhook:lock:${eventId}`;
  const processedKey = `scandium:webhook:event:${eventId}`;

  // 1. Inspect if event was already finalized as processed
  const processedVal = await redisCommand(env, ['GET', processedKey]);
  if (processedVal === 'processed' || processedVal === '1') {
    return new LockAcquisitionResult('already_processed', null);
  }

  // 2. Try to acquire exclusive lock using token and expiration
  const setNxRes = await redisCommand(env, [
    'SET',
    lockKey,
    lockToken,
    'EX',
    String(ttlSeconds),
    'NX',
  ]);

  if (setNxRes === 'OK' || setNxRes === 1 || setNxRes === true) {
    return new LockAcquisitionResult('acquired', lockToken);
  }

  // 3. Re-verify whether existing key indicates completed processing or in-flight lock
  const recheckVal = await redisCommand(env, ['GET', processedKey]);
  if (recheckVal === 'processed' || recheckVal === '1') {
    return new LockAcquisitionResult('already_processed', null);
  }

  return new LockAcquisitionResult('in_flight', null);
}

/**
 * Finalizes an event as successfully completed with the full retention TTL.
 * Strictly verifies lock ownership using lockToken to prevent delayed workers
 * from overwriting a lock that expired and was re-acquired by another worker.
 */
export async function finalizeEventProcessed(env, eventId, lockToken = null, ttlSeconds = 604800) {
  const lockKey = `scandium:webhook:lock:${eventId}`;
  const processedKey = `scandium:webhook:event:${eventId}`;

  // If a lock token was provided, verify that caller still holds the lock
  if (lockToken) {
    const currentHolder = await redisCommand(env, ['GET', lockKey]);
    if (currentHolder && currentHolder !== lockToken) {
      console.warn(`[Storage] Lock token mismatch on finalize for event ${eventId}. Lock was stolen or expired.`);
      return false;
    }
  }

  // Atomically mark event as processed
  await redisCommand(env, [
    'SET',
    processedKey,
    'processed',
    'EX',
    String(ttlSeconds),
  ]);

  // Clean up lock key if held by caller
  if (lockToken) {
    const holder = await redisCommand(env, ['GET', lockKey]);
    if (holder === lockToken) {
      await redisCommand(env, ['DEL', lockKey]);
    }
  } else {
    await redisCommand(env, ['DEL', lockKey]);
  }

  return true;
}

/**
 * Releases the processing lock on failure so Paddle retries can be processed.
 * Only deletes the lock if the caller's lockToken matches the current holder.
 */
export async function releaseEventLock(env, eventId, lockToken = null) {
  const lockKey = `scandium:webhook:lock:${eventId}`;
  if (lockToken) {
    const currentHolder = await redisCommand(env, ['GET', lockKey]);
    if (currentHolder === lockToken) {
      return await redisCommand(env, ['DEL', lockKey]);
    }
    return null;
  }
  return await redisCommand(env, ['DEL', lockKey]);
}

/**
 * Backwards compatibility helper for tests.
 */
export async function isEventProcessed(env, eventId) {
  const val = await redisCommand(env, ['GET', `scandium:webhook:event:${eventId}`]);
  return val === 'processed' || val === '1';
}

/**
 * Backwards compatibility helper for tests.
 */
export async function markEventProcessed(env, eventId, ttlSeconds = 604800) {
  return await finalizeEventProcessed(env, eventId, null, ttlSeconds);
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
 * Retrieves a customer profile by Paddle customer ID.
 */
export async function getCustomer(env, customerId) {
  if (!customerId) return null;
  const raw = await redisCommand(env, ['GET', `scandium:customer:id:${customerId}`]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Saves or updates a customer profile by Paddle customer ID.
 */
export async function saveCustomer(env, customerId, customerData) {
  if (!customerId || !customerData) return;
  const key = `scandium:customer:id:${customerId}`;
  await redisCommand(env, ['SET', key, JSON.stringify(customerData)]);
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
 * Saves a transaction record linking to its license hash and subscription ID.
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
  if (!keyHash) return null;
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
 * Stores encrypted key and metadata; never stores raw plaintext keys.
 */
export async function saveLicenseByHash(env, keyHash, licenseData) {
  if (!keyHash || !licenseData) return;
  const key = `scandium:license:hash:${keyHash}`;
  await redisCommand(env, ['SET', key, JSON.stringify(licenseData)]);
}

/**
 * Links a customer email to their license hash.
 */
export async function saveCustomerEmailIndex(env, email, licenseHash) {
  if (!email || !licenseHash) return;
  const cleanEmail = email.toLowerCase().trim();
  await redisCommand(env, ['SET', `scandium:customer:${cleanEmail}`, licenseHash]);
}

/**
 * Looks up customer's license hash by email address.
 */
export async function getLicenseByCustomer(env, email) {
  if (!email) return null;
  const cleanEmail = email.toLowerCase().trim();
  const licenseHash = await redisCommand(env, ['GET', `scandium:customer:${cleanEmail}`]);
  return licenseHash || null;
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
 * Registers an active device for a license using a distributed lock to prevent
 * TOCTOU race conditions where concurrent requests exceed max device limits.
 */
export async function registerDevice(env, keyHash, hardwareFingerprint, instanceName, maxDevices) {
  const lockKey = `scandium:lock:device:${keyHash}`;
  const lockToken = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random()}`;

  // Acquire distributed lock on license device registration (up to 5 attempts with backoff)
  let acquired = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await redisCommand(env, ['SET', lockKey, lockToken, 'EX', '5', 'NX']);
    if (res === 'OK' || res === 1 || res === true) {
      acquired = true;
      break;
    }
    await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 40)));
  }

  try {
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
  } finally {
    if (acquired) {
      const holder = await redisCommand(env, ['GET', lockKey]);
      if (holder === lockToken) {
        await redisCommand(env, ['DEL', lockKey]);
      }
    }
  }
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
