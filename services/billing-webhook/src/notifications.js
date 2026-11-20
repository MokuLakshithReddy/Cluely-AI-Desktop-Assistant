/**
 * Customer License Delivery & Transactional Notification Dispatcher.
 * Dispatches license delivery emails to purchasing customers via configured
 * transactional providers (Resend, Postmark, SendGrid), and records delivery
 * audit logs in Upstash Redis.
 */

import { redisCommand } from './storage.js';

export async function dispatchLicenseDelivery(env, {
  email,
  customerName = 'Valued Customer',
  tier = 'pro',
  licenseKey,
  subscriptionId,
  transactionId,
}) {
  if (!email || !licenseKey) return { sent: false, error: 'Missing email or licenseKey' };

  const cleanEmail = email.toLowerCase().trim();
  const planName = tier === 'pro' ? 'Scandium Pro' : 'Scandium Plus';

  const htmlContent = `
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

  let providerUsed = 'outbox_queued';
  let sendError;

  // 1. Try Resend API
  if (env.RESEND_API_KEY?.trim()) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'Scandium Assistant <licensing@scandium.dev>',
          to: [cleanEmail],
          subject: `Your ${planName} License Key`,
          html: htmlContent,
        }),
      });
      if (res.ok) {
        providerUsed = 'resend';
      } else {
        sendError = await res.text();
      }
    } catch (err) {
      sendError = err.message;
    }
  }
  // 2. Try Postmark API
  else if (env.POSTMARK_SERVER_TOKEN?.trim()) {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN.trim(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          From: env.EMAIL_FROM || 'licensing@scandium.dev',
          To: cleanEmail,
          Subject: `Your ${planName} License Key`,
          HtmlBody: htmlContent,
        }),
      });
      if (res.ok) {
        providerUsed = 'postmark';
      } else {
        sendError = await res.text();
      }
    } catch (err) {
      sendError = err.message;
    }
  }

  // Record delivery status or queue into Redis outbox
  const deliveryRecord = {
    email: cleanEmail,
    customerName,
    tier,
    licenseKeyMasked: `${licenseKey.slice(0, 16)}...${licenseKey.slice(-8)}`,
    subscriptionId: subscriptionId || null,
    transactionId: transactionId || null,
    provider: providerUsed,
    error: sendError || null,
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

  return {
    sent: providerUsed !== 'outbox_queued',
    provider: providerUsed,
    error: sendError,
  };
}
