# Scandium Billing, Licensing & Commercial Launch Setup

## Architecture Overview: Paddle Billing & Provider-Independent Licensing

Scandium Assistant separates payment processing from entitlement management:
1. **Paddle Billing (Merchant of Record)**: Handles checkout, international sales tax (VAT/GST), multi-currency payments, renewals, invoicing, and webhook events.
2. **Scandium Licensing Service (`services/billing-webhook/`)**: A provider-independent Cloudflare Worker backed by Upstash Redis that translates Paddle subscription, transaction, customer, and adjustment events into cryptographically signed, high-entropy Scandium licenses.
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

- **Rotated Ed25519 Signing Key & Permanent Revocation List**:
  - The production Ed25519 keypair has been rotated. The active public key is embedded in `app/electron/config/licensing-keys.ts`.
  - The previously exposed test signing key (`302a300506032b657003210008a1a2f9a9fd2d62d967c05d5ac47e5507876b44043332a18a5bbc14cc8ede31`) is recorded in `REVOKED_LICENSING_PUBLIC_KEYS`. Both client and backend reject signatures created by revoked keys.
  - Zero private keys are bundled or committed to the repository. Automated test suites generate dynamic, ephemeral in-memory keys during execution.
- **192-bit CSPRNG High-Entropy License Keys**: Generated using 24 bytes of cryptographically secure random material (`crypto.getRandomValues`), formatted as `SCANDIUM-<TIER>-<8HEX>-<8HEX>-<8HEX>-<8HEX>-<8HEX>-<8HEX>` (48 hex characters = 192 bits of entropy), eliminating brute-force and credential-guessing risks.
- **AES-256-GCM License Encryption at Rest**:
  - Raw license keys are **never** stored in plaintext within Redis.
  - Redis records index licenses exclusively by SHA-256 hash (`scandium:license:hash:<hash>`), storing masked representations (`SCANDIUM-PRO-4C17...-9339`) and AES-256-GCM ciphertexts encrypted with a secret derived from the Worker's private key.
  - Webhook receipts acknowledge processing without returning raw customer license keys.
- **Two-Factor Customer Self-Service Claim Verification**:
  - Eliminates email-only lookup bypasses; strictly associates the order/transaction ID (`txn_...` or `sub_...`) with the purchaser's verified email.
  - Step 1: Customer requests a claim (`POST /api/v1/license/claim`, `action: 'request'`). Generates a 6-digit CSPRNG verification code valid for 15 minutes, dispatched to the purchaser's email address.
  - Step 2: Customer enters the 6-digit verification code (`action: 'verify'`). Rate-limited to max 3 attempts before code invalidation. Once verified, the backend decrypts and displays the license key.
- **Paddle Webhook Customer Schema & ID Resolution**:
  - Handles `customer.created` and `customer.updated` events to cache customer profile data under `scandium:customer:id:<customerId>`.
  - Automatically resolves customer email and name for subscription events that reference `customer_id` without inline email payloads.
- **Chargeback Reversal & Dunning Lifecycle**:
  - Adjustment events with `action === 'chargeback_reverse'` and `status === 'reversed'` restore customer entitlements to `active`.
  - Subscriptions in `past_due` status retain customer tier access during Paddle dunning/recovery periods, allowing the desktop app to display an actionable payment update warning without abruptly terminating service.
- **Distributed Concurrency & TOCTOU Mutexes**:
  - Webhook processing locks (`scandium:webhook:lock:<eventId>`) use unique ownership tokens. Finalization and release verify ownership before modifying state, preventing delayed workers from overwriting active locks.
  - Device registrations (`registerDevice`) use a distributed license lock (`scandium:lock:device:<keyHash>`), ensuring simultaneous activations cannot exceed device limits (Free: 1, Plus: 2, Pro: 5).
- **Multi-Provider Transactional Outbox**:
  - Supports Resend (`RESEND_API_KEY`), Postmark (`POSTMARK_SERVER_TOKEN`), and SendGrid (`SENDGRID_API_KEY`).
  - Dispatches license delivery emails and claim verification codes. Outbox records store `licenseHash` to allow reliable background delivery retries via `POST /api/v1/internal/outbox/process`.
- **Fail-Closed Health Monitoring**: `/health` endpoint on the Cloudflare Worker validates Redis connectivity, Paddle webhook secret presence (`PADDLE_WEBHOOK_SECRET_KEY` or `PADDLE_WEBHOOK_SECRET`), and Ed25519 signing key availability.

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
       - `customer.created`
       - `customer.updated`
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
   - `SCANDIUM_LICENSING_PRIVATE_KEY`: Active rotated Ed25519 PKCS8 DER private signing key. Never reuse the old compromised key.
   - `SCANDIUM_LICENSE_ENCRYPTION_KEY`: A separately generated, high-entropy secret (at least 32 random bytes) used only for AES-256-GCM encryption and claim-code HMACs. Do not reuse the Ed25519 signing key.
   - `CRON_SECRET`: A separate high-entropy secret used as `Authorization: Bearer <secret>` for the internal outbox retry endpoint. Do not reuse either cryptographic key.
   - `UPSTASH_REDIS_REST_URL`: Upstash Redis REST URL.
   - `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis REST Token.
   - `PADDLE_PLUS_PRICE_ID`: Plus tier price ID.
   - `PADDLE_PRO_PRICE_ID`: Pro tier price ID.
   - One of `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, or `SENDGRID_API_KEY`: A verified transactional email provider for licenses and claim codes.
   - Optional `SCANDIUM_LEGACY_LICENSE_ENCRYPTION_KEY`: Only when migrating records encrypted by the previous key derivation. Keep it only until migration is verified.
5. **Configure Outbox Retries**:
   - Schedule authenticated POST requests to `/api/v1/internal/outbox/process`.
   - Send exactly `Authorization: Bearer <CRON_SECRET>`. The endpoint fails closed when `CRON_SECRET` is absent.
   - Monitor pending and dead-letter counts; verify claim-code and license-delivery retries independently.
6. **Migrate Existing License Records Before Switching Traffic**:
   - The prior webhook version stored recoverable license keys in Redis subscription, transaction, license, and customer-index records.
   - Back up Redis first. Run the repository's legacy-license migration utility in dry-run mode, review the record counts, then run apply mode with `SCANDIUM_LICENSE_ENCRYPTION_KEY`.
   - Do not delete legacy records or the legacy decrypt key until every migrated record has been verified and activation/claim tests pass.
7. **Verify Health Endpoint**:
   Check `https://scandium-billing-webhook.mokulakshithreddy.workers.dev/health` returns `{"status":"healthy","productionReady":true}` only after Redis, Paddle, signing key, encryption key, CRON secret, and email provider are configured.
