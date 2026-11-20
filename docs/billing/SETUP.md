# Scandium Billing, Licensing & Commercial Launch Setup

## Architecture Overview: Paddle Billing & Provider-Independent Licensing

Scandium Assistant separates payment processing from entitlement management:
1. **Paddle Billing (Merchant of Record)**: Handles checkout, international sales tax (VAT/GST), multi-currency payments, renewals, invoicing, and webhook events.
2. **Scandium Licensing Service (`services/billing-webhook/`)**: A provider-independent Cloudflare Worker backed by Upstash Redis that translates Paddle subscription, transaction, and adjustment events into cryptographically signed, high-entropy Scandium licenses.
3. **Desktop Application Client**: Embeds only the Ed25519 SPKI public key (`app/electron/config/licensing-keys.ts`). It never connects directly to payment gateways or stores secret keys. All entitlement payloads are signed by the backend and verified on the client with asymmetric Ed25519 cryptography.

---

## Free Distribution vs. Paid Commercial Readiness

| Release Track | Status | Notes |
|---|---|---|
| **Free Distribution (`Scandium Free`)** | **Code-ready** | Local AI (Ollama) and core Copilot operate without any billing backend; empty billing product IDs safely keep all users on Free tier |
| **Paid Commercial Launch (`Scandium Plus` / `Scandium Pro`)** | **Code-ready (Owner Configuration Required)** | `PADDLE_PRODUCTS` IDs in `app/electron/config/billing-products.ts` and `paddleConfig.priceIds` in `website/index.html` are intentionally empty until real Paddle products/prices are created |

Do **not** treat paid subscriptions or checkout as operational until every owner configuration step below has been completed and verified against Paddle.

---

## Pricing Page & Paddle Checkout

The first-party pricing page lives in `website/index.html` and is deployed using `.github/workflows/deploy-website.yml`.

Expected public URL:
`https://mokulakshithreddy.github.io/Scandium-Assistant/`

The desktop app opens that URL with `?plan=plus` or `?plan=pro` via an allowlisted `shell.openExternal()` bridge to highlight the selected plan. Purchase buttons remain explicitly disabled (`Checkout not open yet`) whenever `priceIds` are empty.

---

## Security & Entitlement Guarantees Implemented

- **Ed25519 Asymmetric Signature Verification**: All license payloads from `/api/v1/license/activate`, `/validate`, and `/deactivate` are signed with the backend's Ed25519 private key (DER PKCS8). The desktop app verifies the signature using the embedded public key (`app/electron/config/licensing-keys.ts`). Forged or tampered responses fail closed to `free`.
- **192-bit CSPRNG High-Entropy License Keys**: Generated using 24 bytes of cryptographically secure random material (`crypto.getRandomValues`), formatted as `SCANDIUM-<TIER>-<8HEX>-<8HEX>-<8HEX>-<8HEX>-<8HEX>-<8HEX>` (48 hex characters = 192 bits of entropy), eliminating brute-force and credential-guessing risks.
- **Exact Price ID Allowlist**: `LicenseManager` and the backend require an exact configured `price_id` (`app/electron/config/billing-products.ts`). Display names alone can never grant Plus or Pro entitlements; unknown, incomplete, or mismatched IDs fail closed to `free`.
- **Machine Binding & Restricted Cache Permissions**: Cached encrypted licenses (`scandium-license.enc`) are written with `0o600` permissions and bound to the local machine's non-PII hardware fingerprint (`Scandium-<platform>-<hash>`). A license file copied to another machine fails closed to `free`.
- **Transient Outage Tolerance (7-day offline grace)**: Network errors and transient HTTP `429`/`5xx` responses during revalidation engage the 7-day offline grace period rather than prematurely revoking a paying customer's license. Clock rollbacks, expired dates, and disabled/cancelled remote statuses fail closed to `free`.
- **Durable & Atomic Webhook Processing with Upstash Redis**:
  - **Strict Signature Verification**: Paddle webhook requests require `Paddle-Signature: ts=...;h1=...`. HMAC-SHA256 signature is verified in constant time over `${ts}:${rawBody}`.
  - **Dual Secret Name Support**: The worker accepts either `PADDLE_WEBHOOK_SECRET_KEY` or `PADDLE_WEBHOOK_SECRET` interchangeably.
  - **Replay Protection**: Timestamps older than 300 seconds (5 minutes) are rejected with HTTP 401.
  - **Atomic Distributed Deduplication**: Uses Redis `SET scandium:webhook:event:<eventId> processing EX 120 NX` to eliminate concurrent processing races between simultaneous deliveries. Finalizes to `processed` (7-day TTL) on success and releases on unexpected failure.
  - **Domain Model Separation**:
    - **Subscriptions (`sub_...`)**: Handled from `subscription.*` events.
    - **Transactions (`txn_...`)**: Handled from `transaction.*` events, linking `data.id` (transaction ID) with `data.subscription_id`.
    - **Adjustments (`adj_...`)**: Handled from `adjustment.*` events.
  - **Refund & Chargeback Approval Lifecycle**:
    - `adjustment.*` events with `status === 'pending_approval'` or `'rejected'` do **not** revoke customer access.
    - Only `status === 'approved'` refunds revoke access (`refunded`).
    - `action === 'chargeback_reverse'` restores active access.
  - **Dunning & Past-Due Grace**: Subscriptions in `past_due` status retain customer tier access during Paddle dunning/recovery periods, allowing the desktop app to display an actionable payment update warning without abruptly terminating service.
  - **Out-of-Order Event Protection**: Events check `occurred_at` against the stored subscription state timestamp. Older events arriving late are acknowledged but ignored to prevent overwriting newer states.
- **Device Limits**:
  - `free`: 1 device.
  - `plus`: Up to 2 devices.
  - `pro`: Up to 5 devices.
- **Activation & Claim Rate Limiting**:
  - `/api/v1/license/activate`: Maximum 10 activation attempts per 15 minutes per IP. Exceeding attempts returns HTTP 429 with `Retry-After`.
  - `/api/v1/license/claim`: Maximum 5 claim attempts per 15 minutes per IP.
- **Customer License Delivery & Self-Service Claim**:
  - **Transactional Email Dispatch**: Automatically dispatches a branded license delivery email to the customer's purchase email upon `subscription.created` or `transaction.completed` if Resend (`RESEND_API_KEY`), Postmark (`POSTMARK_SERVER_TOKEN`), or SendGrid (`SENDGRID_API_KEY`) is configured. Outbox records are preserved in Redis.
  - **Self-Service Claim Portal**: Dedicated customer web portal at `/claim` and API at `POST /api/v1/license/claim` allowing paying customers to look up and copy their license key using their purchase email and Paddle order/transaction/subscription ID.
- **Fail-Closed Health Monitoring**: `/health` endpoint on the Cloudflare Worker validates Redis connectivity, Paddle webhook secret presence (`PADDLE_WEBHOOK_SECRET_KEY` or `PADDLE_WEBHOOK_SECRET`), and Ed25519 signing key availability. If any component is unconfigured or failing, it returns HTTP 503 degraded.

---

## Enabling Paid Checkout & Subscriptions (Owner Action Required)

Checkout is intentionally disabled until genuine Scandium products and prices exist in Paddle:

1. **Create Paddle Products & Prices**:
   - In your Paddle Dashboard (Sandbox first, then Production), create products:
     - **Scandium Plus**: Recurring monthly billing, e.g., $19/mo. Note the Price ID (`pri_...`).
     - **Scandium Pro**: Recurring monthly billing, e.g., $49/mo. Note the Price ID (`pri_...`).
2. **Configure Client Price IDs**:
   - Set the Price IDs in `app/electron/config/billing-products.ts` (or via environment variables `PADDLE_PLUS_PRICE_ID` and `PADDLE_PRO_PRICE_ID`).
   - Add the Price IDs and your Paddle Client Token to `paddleConfig` in `website/index.html`.
3. **Configure Paddle Webhook Destination**:
   - In Paddle Dashboard → Notifications, add a webhook destination:
     - URL: `https://scandium-billing-webhook.mokulakshithreddy.workers.dev/api/webhook/paddle`
     - Events to subscribe:
       - `subscription.created`
       - `subscription.updated`
       - `subscription.canceled`
       - `subscription.paused`
       - `subscription.resumed`
       - `subscription.past_due`
       - `transaction.completed`
       - `transaction.paid`
       - `transaction.past_due`
       - `transaction.payment_failed`
       - `adjustment.created`
       - `adjustment.updated`
   - Copy the webhook secret key (`pdl_ntf_set_...`).
4. **Deploy Backend Worker Environment Variables**:
   Configure the following secrets on the Cloudflare Worker (`scandium-billing-webhook`):
   - `PADDLE_WEBHOOK_SECRET_KEY` (or `PADDLE_WEBHOOK_SECRET`): The webhook secret key from Paddle.
   - `UPSTASH_REDIS_REST_URL`: Upstash Redis REST endpoint.
   - `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis REST token.
   - `SCANDIUM_LICENSING_PRIVATE_KEY`: Hex-encoded PKCS8 DER Ed25519 private key matching the public key embedded in the desktop application.
   - *(Optional for Automated Email Delivery)*: `RESEND_API_KEY` or `POSTMARK_SERVER_TOKEN` or `SENDGRID_API_KEY`.
5. **Verify Health Endpoint**:
   Check `https://scandium-billing-webhook.mokulakshithreddy.workers.dev/health` returns `{"status":"healthy","productionReady":true}`.
6. **Execute End-to-End Sandbox Testing**:
   - Perform test checkout via Paddle Sandbox.
   - Verify webhook arrival, atomic event deduplication, and 192-bit license generation in Redis.
   - Verify customer self-service license claim at `https://scandium-billing-webhook.mokulakshithreddy.workers.dev/claim`.
   - Activate the resulting license key in the Scandium desktop app.
   - Test device limits, validation, and deactivation.
   - Trigger a cancellation or refund webhook in Paddle Sandbox and confirm license status transitions appropriately.
