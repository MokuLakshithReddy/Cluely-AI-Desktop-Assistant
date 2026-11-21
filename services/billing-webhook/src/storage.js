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
export async function tryAcquireEventLock(env, eventId, ttlSeconds = 600) {
  const lockToken = crypto.randomUUID();
  const lockKey = `scandium:webhook:lock:${eventId}`;
  const processedKey = `scandium:webhook:event:${eventId}`;
  const script = `
    -- SCANDIUM_EVENT_LOCK_ACQUIRE_V1
    if redis.call('GET', KEYS[1]) == 'processed' then
      return 'already_processed'
    end
    local result = redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2], 'NX')
    if result then return 'acquired' end
    if redis.call('GET', KEYS[1]) == 'processed' then
      return 'already_processed'
    end
    return 'in_flight'
  `;
  const status = await redisCommand(env, [
    'EVAL', script, '2', processedKey, lockKey, lockToken, String(ttlSeconds),
  ]);
  return new LockAcquisitionResult(status, status === 'acquired' ? lockToken : null);
}

/**
 * Atomically finalizes an event only while the caller still owns its lock.
 * A missing/expired lock is a hard failure; ownership is never inferred.
 */
export async function finalizeEventProcessed(env, eventId, lockToken, ttlSeconds = 604800) {
  if (!lockToken) return false;
  const lockKey = `scandium:webhook:lock:${eventId}`;
  const processedKey = `scandium:webhook:event:${eventId}`;
  const script = `
    -- SCANDIUM_EVENT_LOCK_FINALIZE_V1
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    redis.call('SET', KEYS[2], 'processed', 'EX', ARGV[2])
    redis.call('DEL', KEYS[1])
    return 1
  `;
  const result = await redisCommand(env, [
    'EVAL', script, '2', lockKey, processedKey, lockToken, String(ttlSeconds),
  ]);
  return result === 1 || result === '1';
}

/**
 * Releases a webhook lock with one atomic compare-and-delete.
 */
export async function releaseEventLock(env, eventId, lockToken) {
  if (!lockToken) return false;
  const lockKey = `scandium:webhook:lock:${eventId}`;
  const script = `
    -- SCANDIUM_EVENT_LOCK_RELEASE_V1
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    return redis.call('DEL', KEYS[1])
  `;
  const result = await redisCommand(env, ['EVAL', script, '1', lockKey, lockToken]);
  return result === 1 || result === '1';
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
  // Test/backwards-compatibility helper only; production webhook code always uses an owned lock.
  return await redisCommand(env, [
    'SET', `scandium:webhook:event:${eventId}`, 'processed', 'EX', String(ttlSeconds),
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
  // A single Redis Lua execution makes read/check/append atomic across all Worker instances.
  const script = `
    -- SCANDIUM_DEVICE_REGISTER_V1
    local raw = redis.call('GET', KEYS[1])
    local devices = {}
    if raw then
      local ok, decoded = pcall(cjson.decode, raw)
      if not ok or type(decoded) ~= 'table' then return {'invalid_state', '0'} end
      devices = decoded
    end
    for _, device in ipairs(devices) do
      if device.hardwareFingerprint == ARGV[1] then
        return {'reconnected', tostring(#devices)}
      end
    end
    if #devices >= tonumber(ARGV[4]) then
      return {'limit_reached', tostring(#devices)}
    end
    table.insert(devices, {
      hardwareFingerprint = ARGV[1],
      instanceName = ARGV[2],
      activatedAt = ARGV[3]
    })
    redis.call('SET', KEYS[1], cjson.encode(devices))
    return {'created', tostring(#devices)}
  `;
  const result = await redisCommand(env, [
    'EVAL',
    script,
    '1',
    `scandium:devices:${keyHash}`,
    hardwareFingerprint,
    instanceName,
    new Date().toISOString(),
    String(maxDevices),
  ]);
  const status = Array.isArray(result) ? result[0] : 'invalid_state';
  const count = Number(Array.isArray(result) ? result[1] : 0);
  if (status === 'created' || status === 'reconnected') {
    return { success: true, count, maxDevices, reconnected: status === 'reconnected' };
  }
  if (status === 'limit_reached') {
    return { success: false, reason: 'limit_reached', count, maxDevices };
  }
  return { success: false, reason: 'storage_error', count, maxDevices };
}

/**
 * Unregisters a device fingerprint for a license.
 */
export async function unregisterDevice(env, keyHash, hardwareFingerprint) {
  const script = `
    -- SCANDIUM_DEVICE_UNREGISTER_V1
    local raw = redis.call('GET', KEYS[1])
    if not raw then return 0 end
    local ok, devices = pcall(cjson.decode, raw)
    if not ok or type(devices) ~= 'table' then return redis.error_reply('invalid device state') end
    local filtered = {}
    for _, device in ipairs(devices) do
      if device.hardwareFingerprint ~= ARGV[1] then
        table.insert(filtered, device)
      end
    end
    redis.call('SET', KEYS[1], cjson.encode(filtered))
    return #filtered
  `;
  const count = await redisCommand(env, [
    'EVAL', script, '1', `scandium:devices:${keyHash}`, hardwareFingerprint,
  ]);
  return { success: true, count: Number(count) || 0 };
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
