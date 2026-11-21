#!/usr/bin/env node
/**
 * One-time migration for license records created before AES-256-GCM key storage.
 *
 * Safe by default: dry-run only. Pass --apply after taking a Redis backup and
 * reviewing the planned counts. Never prints license keys, emails, or secrets.
 *
 * Required:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   SCANDIUM_LICENSE_ENCRYPTION_KEY
 *
 * Optional, only for records encrypted by the former signing-key derivation:
 *   SCANDIUM_LEGACY_LICENSE_ENCRYPTION_KEY
 *   SCANDIUM_LICENSING_PRIVATE_KEY (legacy fallback)
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const encryptionSecret = process.env.SCANDIUM_LICENSE_ENCRYPTION_KEY;
const legacySecret = process.env.SCANDIUM_LEGACY_LICENSE_ENCRYPTION_KEY ||
  process.env.SCANDIUM_LICENSING_PRIVATE_KEY;
const apply = process.argv.includes('--apply');

if (!redisUrl || !redisToken || !encryptionSecret || encryptionSecret.length < 32) {
  console.error('Missing Redis credentials or SCANDIUM_LICENSE_ENCRYPTION_KEY (minimum 32 characters).');
  process.exit(1);
}

async function redis(command) {
  const response = await fetch(redisUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + redisToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) {
    throw new Error('Upstash Redis request failed with HTTP ' + response.status);
  }
  const payload = await response.json();
  if (payload.error) throw new Error('Upstash Redis command failed: ' + payload.error);
  return payload.result;
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function maskLicenseKey(value) {
  const clean = String(value || '').trim();
  return clean.length <= 16 ? clean : clean.slice(0, 16) + '...' + clean.slice(-8);
}

function deriveAesKey(secret) {
  return createHash('sha256').update(String(secret).trim(), 'utf8').digest();
}

function encryptLicenseKey(plainText) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveAesKey(encryptionSecret), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { iv: iv.toString('hex'), ciphertext: encrypted.toString('hex') };
}

function decryptLicenseKey(encrypted, secret) {
  if (!secret || !encrypted || !encrypted.iv || !encrypted.ciphertext) return null;
  try {
    const iv = Buffer.from(encrypted.iv, 'hex');
    const payload = Buffer.from(encrypted.ciphertext, 'hex');
    if (iv.length !== 12 || payload.length < 17) return null;
    const tag = payload.subarray(payload.length - 16);
    const ciphertext = payload.subarray(0, payload.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', deriveAesKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

async function scanKeys(pattern) {
  let cursor = '0';
  const keys = [];
  do {
    const result = await redis(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '100']);
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw new Error('Unexpected Redis SCAN response');
    }
    cursor = String(result[0]);
    keys.push(...result[1]);
  } while (cursor !== '0');
  return [...new Set(keys)];
}

async function getJson(key) {
  const raw = await redis(['GET', key]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJson(key, value) {
  if (apply) await redis(['SET', key, JSON.stringify(value)]);
}

const counters = {
  scannedLicenseRecords: 0,
  migratedLicenseRecords: 0,
  scannedOrderRecords: 0,
  migratedOrderRecords: 0,
  migratedCustomerIndexes: 0,
  skipped: 0,
};
const migratedHashes = new Set();

async function ensureEncryptedLicense(plainKey, metadata = {}) {
  const cleanKey = typeof plainKey === 'string' ? plainKey.trim() : '';
  if (!cleanKey) return null;

  const licenseHash = sha256Hex(cleanKey);
  const storageKey = 'scandium:license:hash:' + licenseHash;
  const current = await getJson(storageKey) || {};
  if (current.encryptionKeyVersion === 2 && current.encryptedKey) {
    migratedHashes.add(licenseHash);
    return licenseHash;
  }

  let recoveredKey = cleanKey;
  if (!recoveredKey && current.encryptedKey) {
    recoveredKey = decryptLicenseKey(current.encryptedKey, legacySecret);
  }
  if (!recoveredKey) return null;

  const encryptedKey = encryptLicenseKey(recoveredKey);
  const nextRecord = {
    ...current,
    ...metadata,
    licenseHash,
    licenseKeyMasked: maskLicenseKey(recoveredKey),
    encryptedKey,
    encryptionKeyVersion: 2,
  };
  delete nextRecord.licenseKey;

  await setJson(storageKey, nextRecord);
  migratedHashes.add(licenseHash);
  counters.migratedLicenseRecords++;
  return licenseHash;
}

async function migrateDirectLicenseRecords() {
  const keys = await scanKeys('scandium:license:hash:*');
  for (const key of keys) {
    counters.scannedLicenseRecords++;
    const record = await getJson(key);
    if (!record) {
      counters.skipped++;
      continue;
    }
    if (record.encryptionKeyVersion === 2 && record.encryptedKey && !record.licenseKey) continue;

    const suffixHash = key.slice('scandium:license:hash:'.length);
    const licenseKey = record.licenseKey ||
      decryptLicenseKey(record.encryptedKey, legacySecret);
    if (!licenseKey || sha256Hex(licenseKey) !== suffixHash) {
      counters.skipped++;
      console.warn('Skipped a license record that could not be authenticated against its Redis hash key.');
      continue;
    }
    await ensureEncryptedLicense(licenseKey, record);
  }
}

async function migrateOrderRecords(pattern, prefix) {
  const keys = await scanKeys(pattern);
  for (const key of keys) {
    counters.scannedOrderRecords++;
    const record = await getJson(key);
    if (!record || typeof record !== 'object') {
      counters.skipped++;
      continue;
    }

    let licenseHash = record.licenseHash;
    if (record.licenseKey) {
      licenseHash = await ensureEncryptedLicense(record.licenseKey, record);
    } else if (licenseHash) {
      migratedHashes.add(licenseHash);
    }

    if (!licenseHash) continue;

    if (record.licenseKey || record.licenseKeyMasked === undefined) {
      const updated = { ...record, licenseHash };
      if (record.licenseKey) updated.licenseKeyMasked = maskLicenseKey(record.licenseKey);
      delete updated.licenseKey;
      delete updated.encryptedKey;
      delete updated.encryptionKeyVersion;
      await setJson(key, updated);
      counters.migratedOrderRecords++;
    }
    if (record.customerEmail) {
      const emailKey = 'scandium:customer:' + String(record.customerEmail).toLowerCase().trim();
      if (apply) await redis(['SET', emailKey, licenseHash]);
    }
  }
}

async function migrateCustomerIndexes() {
  const keys = await scanKeys('scandium:customer:*');
  for (const key of keys) {
    if (key.startsWith('scandium:customer:id:')) continue;
    const raw = await redis(['GET', key]);
    if (!raw || /^[a-f0-9]{64}$/i.test(String(raw))) continue;

    let value;
    try { value = JSON.parse(raw); } catch { value = null; }
    if (value && typeof value === 'object') continue;

    const licenseHash = sha256Hex(String(raw));
    const licenseRecord = await getJson('scandium:license:hash:' + licenseHash);
    if (!licenseRecord || !licenseRecord.encryptedKey || licenseRecord.encryptionKeyVersion !== 2) {
      counters.skipped++;
      console.warn('A customer email index has no migrated license record; it was left unchanged.');
      continue;
    }
    if (apply) await redis(['SET', key, licenseHash]);
    counters.migratedCustomerIndexes++;
  }
}

try {
  console.log(apply ? 'Applying legacy license migration...' : 'DRY RUN: no Redis writes will be made.');
  await migrateDirectLicenseRecords();
  await migrateOrderRecords('scandium:sub:*', 'scandium:sub:');
  await migrateOrderRecords('scandium:txn:*', 'scandium:txn:');
  await migrateCustomerIndexes();

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    ...counters,
    uniqueMigratedLicenseHashes: migratedHashes.size,
  }, null, 2));

  if (!apply) {
    console.log('Review the counts, back up Redis, then rerun with --apply to write changes.');
  } else {
    console.log('Migration completed. Verify claim, activation, validation, subscription and refund flows before removing any legacy secrets.');
  }
} catch (error) {
  console.error('Migration aborted:', error.message);
  process.exitCode = 1;
}
