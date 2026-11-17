# Scandium Developer Mode

Developer Mode lets the application owner test premium model integrations with their own provider API keys without purchasing a Scandium subscription.

## What it does

When enabled, the Electron **main process** grants the local unpackaged build the Pro feature-entitlement matrix. This covers cloud BYOK access for Gemini, OpenAI, Anthropic and Groq, plus premium operating modes, local Whisper, local Vision and knowledge-base limits.

It does **not** create or alter a Lemon Squeezy license. The Dashboard continues to show the real subscription/license status and displays a separate Developer Mode notice.

## Enable on Windows (PowerShell)

Open two terminals in the repository's `app` directory.

Terminal 1 — start the Vite renderer:

```powershell
cd app
npm run dev:vite
```

Terminal 2 — launch the unpackaged Electron app with the override:

```powershell
cd app
$env:SCANDIUM_DEVELOPER_MODE = "true"
npx electron .
```

Keep the environment variable set in the terminal that launches Electron. Restart Electron after changing it.

## macOS / Linux

```bash
cd app
SCANDIUM_DEVELOPER_MODE=true npx electron .
```

Start the Vite server separately with `npm run dev:vite`.

## Test a cloud model

1. Enable Developer Mode using the commands above.
2. Open **Dashboard → API Keys** and save your own provider API key in the OS-backed credential vault.
3. Change **Privacy Mode** to **Cloud**. Local privacy mode intentionally blocks cloud providers even in Developer Mode.
4. Select a supported provider/model and send a simple text-only prompt first.
5. Add screenshot context only after text generation works; the application's outbound redaction policy may intentionally block sensitive screenshots from cloud providers.
6. Check the provider's response and its own API usage/quota dashboard.

## Important boundaries

- **Packaged apps always ignore the override.** The main-process policy requires `app.isPackaged === false`; an environment variable cannot activate Developer Mode in the distributed Windows, macOS or Linux packages.
- `NODE_ENV=production` also disables the override.
- The flag must be the exact string `true`; it is read by the Electron main process and is not loaded automatically from `.env.example`.
- Provider API keys, network access, provider-side billing, rate limits, model availability, redaction, privacy mode, request validation and IPC origin checks remain enforced.
- Never ship a build with the developer flag embedded or launch a customer package with this mode enabled. This is a local development/testing convenience, not a license-generation or licensing bypass feature.

## Disable

Close Scandium and launch it without setting `SCANDIUM_DEVELOPER_MODE`, or run:

```powershell
Remove-Item Env:SCANDIUM_DEVELOPER_MODE -ErrorAction SilentlyContinue
```
