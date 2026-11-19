# Dependency Advisory Review

**Review date:** 2026-11-18  
**Audited baseline:** `333d3de` (`main`)  
**Status:** Production runtime audit (`npm audit --omit=dev`) reports **0 vulnerabilities**; full development/build tree retains 18 high-severity upstream `picomatch` findings with no patched npm release available yet.  
**Scope:** JavaScript workspace dependencies used for CI, packaging, and runtime

## Current finding — `picomatch` ReDoS (development/build tooling only)

Running `npm audit` across the full workspace reports **18 high-severity findings**, all rooted in `picomatch` through version `4.0.7` under [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / **CVE-2026-112366** (ReDoS via single-branch repeated extglob patterns).

### Verified dependency paths (devDependencies / build tooling only)
- `vitest` / `vite` -> `tinyglobby` -> `fdir` / `picomatch`
- `tailwindcss` -> `chokidar` / `anymatch` / `micromatch` / `readdirp` / `fast-glob` / `sucrase` -> `picomatch`
- `electron-builder` -> `app-builder-lib` / `dmg-builder` / `electron-builder-squirrel-windows` / `@electron/rebuild` / `node-gyp` -> `fast-glob` / `micromatch` -> `picomatch`

### Runtime exposure assessment
- The application's declared production dependencies in `app/package.json` are `clsx`, `lucide-react`, `react`, `react-dom`, `tailwind-merge`, and `pdfjs-dist`.
- `npm audit --omit=dev` reports **0 vulnerabilities** (0 critical, 0 high, 0 moderate, 0 low).
- `picomatch` is **not** shipped in the production application bundle and never parses untrusted user glob input at runtime.

### Upstream remediation status (verified against npm registry on 2026-11-18)
- `npm view picomatch dist-tags` confirms `latest` is **`4.0.7`** (`4.0.8`, `4.0.9`, and `4.1.0` do not exist on npm).
- Upstream fix proposal [micromatch/picomatch PR #237](https://github.com/micromatch/picomatch/pull/237) remains unmerged/unreleased.
- Per security engineering policy, we do **not** suppress `npm audit`, force incompatible major downgrades (`vitest` / `electron-builder` / `tailwindcss`), or override `picomatch` to an unreviewed fork. Re-evaluate and remove this documented dev-only exception as soon as a patched upstream `picomatch` release is published.

## Audit policy

| Check | Policy | Current Result (2026-11-18) |
|---|---|---|
| Production dependency graph (`npm audit --omit=dev`) | **Blocking** in both `ci.yml` and `release.yml` | **0 vulnerabilities** (PASS) |
| Complete development/build dependency graph (`npm audit`) | Always captured and uploaded as JSON artifact (`npm-audit-full.json`); never silently suppressed | **18 high (`picomatch <=4.0.7`, dev-only, no upstream patch)** |
| Critical/high production findings | Blocking; do not suppress or relabel | **0** |
| Python/native runtime | Separately validated via pinned checksum Python runtime (`scripts/provision-python-runtime.cjs`), `test_sidecar.py`, and `test_realtime_inference.py` | **PASS** |

## Previous dependency fixes

- The earlier 6 moderate paths for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (`minimatch <11.0.1`) were resolved via workspace override `minimatch@^11.0.8` with `@isaacs/nonrecursive-glob-match@^1.1.0`.
- The earlier `undici` finding was resolved by pinning `undici@^7.30.2`.
