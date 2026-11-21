/**
 * Customer License Delivery & Transactional Notification Dispatcher.
 * Dispatches license delivery and claim verification emails via configured
 * transactional providers (Resend, Postmark, SendGrid), and provides an outbox
 * retry consumer for reliable delivery.
 */

import { redisCommand, getLicenseByHash } from './storage.js';
import { maskLicenseKey, decryptLicenseKey } from './crypto.js';

/**
 * Dispatches transactional email via Resend, Postmark, or SendGrid.
 */
async function sendEmail(env, { to, subject, html, text }) {
  const cleanEmail = to.toLowerCase().trim();
  const fromEmail = env.EMAIL_FROM || 'Scandium Assistant <licensing@scandium.dev>';

  // 1. Try Resend
  if (env.RESEND_API_KEY?.trim()) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [cleanEmail],
          subject,
          html,
        }),
      });
      if (res.ok) {
        return { sent: true, provider: 'resend' };
      }
      return { sent: false, provider: 'resend', error: await res.text() };
    } catch (err) {
      return { sent: false, provider: 'resend', error: err.message };
    }
  }

  // 2. Try Postmark
  if (env.POSTMARK_SERVER_TOKEN?.trim()) {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN.trim(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          From: fromEmail,
          To: cleanEmail,
          Subject: subject,
          HtmlBody: html,
        }),
      });
      if (res.ok) {
        return { sent: true, provider: 'postmark' };
      }
      return { sent: false, provider: 'postmark', error: await res.text() };
    } catch (err) {
      return { sent: false, provider: 'postmark', error: err.message };
    }
  }

  // 3. Try SendGrid
  if (env.SENDGRID_API_KEY?.trim()) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SENDGRID_API_KEY.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: cleanEmail }] }],
          from: { email: fromEmail.replace(/.*<([^>]+)>/, '$1') || 'licensing@scandium.dev', name: 'Scandium Assistant' },
          subject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
      if (res.ok || res.status === 202) {
        return { sent: true, provider: 'sendgrid' };
      }
      return { sent: false, provider: 'sendgrid', error: await res.text() };
    } catch (err) {
      return { sent: false, provider: 'sendgrid', error: err.message };
    }
  }

  // No provider configured: queued in outbox
  return { sent: false, provider: 'outbox_queued', error: 'No email provider credentials configured' };
}

/**
 * Builds the HTML content for license delivery email.
 */
function buildLicenseEmailHtml({ planName, licenseKey, transactionId, subscriptionId }) {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #080d16; color: #edf4ff; padding: 32px 16px;">
      <div style="max-width: 560px; margin: 0 auto; background: #0e1725; border: 1px solid rgba(153, 177, 207, 0.2); border-radius: 16px; padding: 32px;">
        <h1 style="margin: 0 0 16px; font-size: 24px; color: #64e6e1;">Welcome to ${planName}!</h1>
        <p style="color: #aab9cd; font-size: 14px; line-height: 1.6;">Thank you for your purchase. Your payment was successfully processed via Paddle. Below is your cryptographically signed Scandium license key:</p>
        
        <div style="margin: 24px 0; padding: 16px; background: #142033; border: 1px solid #64e6e1; border-radius: 8px; text-align: center;">
          <span style="font-family: monospace; font-size: 16px; font-weight: bold; color: #64e6e1; letter-spacing: 0.05em; word-break: break-all;">${licenseKey}</span>
        </div>

        <h3 style="font-size: 16px; margin: 24px 0 12px; color: #edf4ff;">How to Activate in Scandium:</h3>
        <ol style="color: #aab9cd; font-size: 14px; line-height: 1.8; padding-left: 20px;">
          <li>Open the Scandium Assistant desktop app on your computer.</li>
          <li>Navigate to <strong>Dashboard &rarr; Subscription &amp; License</strong>.</li>
          <li>Paste your license key above into the <strong>Activate License Key</strong> box and click <strong>Activate</strong>.</li>
        </ol>

        <p style="color: #728197; font-size: 12px; margin-top: 32px; border-top: 1px solid rgba(153, 177, 207, 0.15); padding-top: 16px;">
          Order Reference: ${transactionId || subscriptionId || 'N/A'}<br>
          Need help? You can also look up or claim your license at any time on our website.
        </p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Dispatches license delivery email to customer.
 */
export async function dispatchLicenseDelivery(env, {
  email,
  customerName = 'Valued Customer',
  tier = 'pro',
  licenseKey,
  licenseHash,
  subscriptionId,
  transactionId,
}) {
  if (!email || !licenseKey) return { sent: false, error: 'Missing email or licenseKey' };

  const cleanEmail = email.toLowerCase().trim();
  const planName = tier === 'pro' ? 'Scandium Pro' : 'Scandium Plus';
  const html = buildLicenseEmailHtml({ planName, licenseKey, transactionId, subscriptionId });

  const result = await sendEmail(env, {
    to: cleanEmail,
    subject: `Your ${planName} License Key`,
    html,
  });

  // Record delivery status and retain licenseHash so retry worker can recover key and deliver
  const deliveryRecord = {
    type: 'license_delivery',
    email: cleanEmail,
    customerName,
    tier,
    licenseHash: licenseHash || null,
    licenseKeyMasked: maskLicenseKey(licenseKey),
    subscriptionId: subscriptionId || null,
    transactionId: transactionId || null,
    provider: result.provider,
    status: result.sent ? 'delivered' : 'pending',
    error: result.error || null,
    retries: 0,
    dispatchedAt: new Date().toISOString(),
  };

  try {
    await redisCommand(env, [
      'LPUSH',
      'scandium:notifications:outbox',
      JSON.stringify(deliveryRecord),
    ]);
  } catch (e) {
    console.warn('[Notification] Failed to record in Redis outbox:', e.message);
  }

  return result;
}

/**
 * Dispatches 6-digit claim verification code to customer email.
 */
export async function dispatchClaimVerificationCode(env, { email, orderId, code }) {
  if (!email || !code) return { sent: false, error: 'Missing email or verification code' };
  const cleanEmail = email.toLowerCase().trim();

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #080d16; color: #edf4ff; padding: 32px 16px;">
      <div style="max-width: 560px; margin: 0 auto; background: #0e1725; border: 1px solid rgba(153, 177, 207, 0.2); border-radius: 16px; padding: 32px;">
        <h1 style="margin: 0 0 16px; font-size: 22px; color: #64e6e1;">Your License Claim Verification Code</h1>
        <p style="color: #aab9cd; font-size: 14px; line-height: 1.6;">You requested to claim your Scandium Assistant license key for order reference <strong>${orderId}</strong>. Enter the verification code below on the claim portal:</p>
        
        <div style="margin: 24px 0; padding: 20px; background: #142033; border: 2px dashed #64e6e1; border-radius: 8px; text-align: center;">
          <span style="font-family: monospace; font-size: 32px; font-weight: bold; color: #64e6e1; letter-spacing: 0.25em;">${code}</span>
        </div>

        <p style="color: #aab9cd; font-size: 13px; line-height: 1.6;">This code is valid for 15 minutes. If you did not request this claim, please ignore this email.</p>
      </div>
    </body>
    </html>
  `;

  const result = await sendEmail(env, {
    to: cleanEmail,
    subject: `Scandium Verification Code: ${code}`,
    html,
  });

  const record = {
    type: 'claim_code',
    email: cleanEmail,
    orderId,
    code,
    provider: result.provider,
    status: result.sent ? 'delivered' : 'pending',
    error: result.error || null,
    dispatchedAt: new Date().toISOString(),
  };

  try {
    await redisCommand(env, [
      'LPUSH',
      'scandium:notifications:outbox',
      JSON.stringify(record),
    ]);
  } catch (e) {
    console.warn('[Notification] Failed to record code in Redis outbox:', e.message);
  }

  return result;
}

/**
 * Outbox retry worker consumer.
 * Inspects pending outbox records, decrypts license key using the server private key,
 * attempts delivery via configured providers, and updates status.
 */
export async function processOutbox(env, batchLimit = 10) {
  const secretKey = env.SCANDIUM_LICENSING_PRIVATE_KEY;
  let processed = 0;
  let delivered = 0;
  let failed = 0;

  for (let i = 0; i < batchLimit; i++) {
    const raw = await redisCommand(env, ['RPOP', 'scandium:notifications:outbox']);
    if (!raw) break;

    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      continue;
    }

    processed++;

    // If item is already marked delivered, archive it
    if (item.status === 'delivered') {
      delivered++;
      continue;
    }

    // Attempt delivery for pending license deliveries
    if (item.type === 'license_delivery' && item.licenseHash && secretKey) {
      const licenseRecord = await getLicenseByHash(env, item.licenseHash);
      if (licenseRecord?.encryptedKey) {
        const decryptedKey = await decryptLicenseKey(licenseRecord.encryptedKey, secretKey);
        if (decryptedKey) {
          const planName = item.tier === 'pro' ? 'Scandium Pro' : 'Scandium Plus';
          const html = buildLicenseEmailHtml({
            planName,
            licenseKey: decryptedKey,
            transactionId: item.transactionId,
            subscriptionId: item.subscriptionId,
          });

          const sendResult = await sendEmail(env, {
            to: item.email,
            subject: `Your ${planName} License Key`,
            html,
          });

          if (sendResult.sent) {
            item.status = 'delivered';
            item.provider = sendResult.provider;
            item.deliveredAt = new Date().toISOString();
            delivered++;
            await redisCommand(env, [
              'LPUSH',
              'scandium:notifications:delivered',
              JSON.stringify(item),
            ]);
            continue;
          }
        }
      }
    }

    // If delivery failed or could not be retried, requeue with incremented retry count (up to 5 retries)
    failed++;
    item.retries = (item.retries || 0) + 1;
    if (item.retries < 5) {
      await redisCommand(env, [
        'LPUSH',
        'scandium:notifications:outbox',
        JSON.stringify(item),
      ]);
    } else {
      item.status = 'dead_letter';
      await redisCommand(env, [
        'LPUSH',
        'scandium:notifications:dead_letter',
        JSON.stringify(item),
      ]);
    }
  }

  return { processed, delivered, failed };
}
