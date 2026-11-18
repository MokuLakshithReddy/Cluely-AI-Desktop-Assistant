# Scandium Billing, Licensing & Commercial Launch Setup

## Free Distribution vs. Paid Commercial Readiness

| Release Track | Status | Notes |
|---|---|---|
| **Free Distribution (`Scandium Free`)** | **Code-ready** (pending physical-device campaign `#49` and signed release `#50`) | Local AI (Ollama) and core Copilot operate without any billing backend; empty billing product IDs safely keep all users on Free tier |
| **Paid Commercial Launch (`Scandium Plus` / `Scandium Pro`)** | **NOT READY (Owner Configuration Required)** | `BILLING_PRODUCTS` IDs in `app/electron/config/billing-products.ts` and `checkoutUrls` in `website/index.html` are intentionally empty until real Lemon Squeezy products are created |

Do **not** treat paid subscriptions or checkout as operational until every owner configuration step below has been completed and verified against Lemon Squeezy.

## Pricing page

The first-party pricing page lives in `website/index.html` and is deployed using `.github/workflows/deploy-website.yml`.

Expected public URL:
`https://mokulakshithreddy.github.io/Scandium-Assistant/`

The desktop app opens that URL with `?plan=plus` or `?plan=pro` via an explicitly allowlisted `shell.openExternal()` bridge to highlight the selected plan. Purchase buttons remain explicitly disabled (`Checkout not open yet`) whenever `checkoutUrls.plus` / `checkoutUrls.pro` are empty.

## Security & Entitlement Guarantees Implemented

- **Exact product + variant ID allowlist**: `LicenseManager` requires an exact configured `product_id` + `variant_id` pair (`app/electron/config/billing-products.ts`). Display names alone can never grant Plus or Pro entitlements; unknown, incomplete, or mismatched pairs fail closed to `free`.
- **Machine binding & restricted cache permissions**: Cached encrypted licenses (`scandium-license.enc`) are written with `0o600` permissions and bound to the local machine's non-PII hardware fingerprint (`Scandium-<platform>-<hash>`). A license file copied from another machine fails closed to `free`.
- **Transient outage tolerance (7-day offline grace)**: Network errors and transient HTTP `429`/`5xx` responses during revalidation engage the 7-day offline grace period rather than prematurely revoking a paying customer's license. Clock rollbacks, expired dates, and disabled/cancelled remote statuses fail closed to `free`.
- **No frontend entitlement trust**: Web Mode (`web-bridge.ts`) fails closed on `activateLicense()` and cannot grant paid tiers from browser state.
- **Webhook verification helper (NOT yet a deployed receiver)**: `app/electron/services/billing-webhook.ts` provides a reusable constant-time HMAC-SHA256 `X-Signature` verifier (`crypto.timingSafeEqual`), an **in-memory** single-process `WebhookEventDeduplicator` helper, and canonical lifecycle state mapping (`active`, `past_due`, `cancelled`, `expired`, `disabled`). **No HTTP webhook endpoint or durable deduplication store is deployed yet** — enabling production server-side webhook processing requires deploying a hosted receiver backed by durable persistent event deduplication (e.g., database unique constraint or Redis).

## Enabling Paid Checkout (Owner Action Required)

Checkout is intentionally disabled until genuine Scandium products exist in Lemon Squeezy:

1. Create the actual **Scandium Plus** and **Scandium Pro** monthly subscription products/variants in your Lemon Squeezy account.
2. Copy the exact `productId` and `variantId` for each plan into `app/electron/config/billing-products.ts` before building the desktop release. (`LEMON_PLUS_PRODUCT_ID`, `LEMON_PLUS_VARIANT_ID`, `LEMON_PRO_PRODUCT_ID`, and `LEMON_PRO_VARIANT_ID` environment overrides exist for local testing/CI.)
3. Copy the official HTTPS checkout URLs from those products into `checkoutUrls.plus` and `checkoutUrls.pro` in `website/index.html`. Never guess a store slug or construct a `/buy/` URL.
4. Deploy a hosted HTTP webhook receiver (outside the desktop app) configured with your Lemon Squeezy webhook signing secret (never commit secrets into the desktop app or repository). Use `verifyLemonSqueezyWebhookSignature()` from `app/electron/services/billing-webhook.ts` together with a **durable persistent deduplication store** (e.g., database unique event-ID table or Redis) rather than the single-process in-memory `WebhookEventDeduplicator`.
5. Execute end-to-end tests in Lemon Squeezy test mode covering checkout, license activation, renewal/revalidation, failed payment (`past_due`), cancellation, expiration, and device activation limits before enabling live checkout.
