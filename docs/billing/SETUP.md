# Scandium billing and first-party pricing page

## Pricing page

The first-party pricing page lives in `website/index.html` and is deployed using `.github/workflows/deploy-website.yml`.

Expected public URL:

`https://mokulakshithreddy.github.io/Scandium-Assistant/`

The desktop app opens that URL with `?plan=plus` or `?plan=pro` to highlight the selected plan.

To publish it, open this repository's **Settings → Pages** and set the deployment source to **GitHub Actions**. The workflow deploys the `website/` directory whenever it changes on `main`.

## Enabling checkout later

Checkout is intentionally disabled until the genuine Scandium products exist. The page does not collect payments and the application does not use a guessed Lemon Squeezy URL.

1. Create the actual Scandium Plus and Scandium Pro monthly subscription products/variants in your Lemon Squeezy account.
2. Copy the exact product ID and variant ID for each plan.
3. Put those ID pairs in `app/electron/config/billing-products.ts` before building the desktop release. The exact `LEMON_PLUS_PRODUCT_ID`, `LEMON_PLUS_VARIANT_ID`, `LEMON_PRO_PRODUCT_ID`, and `LEMON_PRO_VARIANT_ID` environment variables are available as local test/CI overrides.
4. Copy the official checkout URLs from those products into `checkoutUrls.plus` and `checkoutUrls.pro` in `website/index.html`. Never guess a store slug or construct a `/buy/` URL.
5. Test purchase, license activation, renewal/validation, cancellation, expiration and device activation limits in Lemon Squeezy test mode before enabling live checkout.

The license manager now requires an exact product **and** variant ID pair. Product or variant names alone cannot grant Plus or Pro. Unknown, incomplete or mismatched pairs fail closed to Free. Revalidation also rechecks the current product IDs, preventing cached name-only paid tiers from remaining entitled.

The root `.env.example` documents process environment overrides for local tests and CI; Electron does not automatically load it. Production builds should include the real public product/variant IDs in `billing-products.ts`. Never embed a Lemon Squeezy API secret in the desktop app or website.

## Current status

- First-party pricing page: implemented.
- Dashboard navigation to the page: implemented.
- Real checkout: not configured until your actual products, variant IDs and official checkout links exist.
