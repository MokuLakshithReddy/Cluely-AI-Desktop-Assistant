# Dependency advisory review

**Review date:** 2026-11-17  
**Status:** Production-dependency audit gate required; full development tree has an unresolved high-severity advisory.  
**Scope:** JavaScript workspace dependencies used for CI, packaging, and runtime

## Current finding — picomatch ReDoS

The full workspace audit in CI run #244 and the rerun #245 reports **18 high-severity findings** involving `picomatch`, associated with [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366. The advisory describes regular-expression denial of service from single-branch repeated extglobs. The audit reports affected `picomatch` through 4.0.7 and transitive paths through development/build tooling such as `anymatch`, `chokidar`, `tailwindcss`, `fdir`, and `tinyglobby`.

The app's declared production dependencies in `app/package.json` are `clsx`, `lucide-react`, `react`, `react-dom`, `tailwind-merge`, and `pdfjs-dist`; `picomatch` is not a direct production dependency. The CI pipeline now enforces a separate, strict `npm audit --omit=dev` check for the production dependency graph while retaining the full audit JSON as an artifact. The production-only audit must pass before merge. Do not describe the entire development/build dependency tree as audit-clean.

Upstream remediation is not yet available as a released version at this review: the upstream fix proposal [micromatch/picomatch PR #237](https://github.com/micromatch/picomatch/pull/237) remains open. Do not silently override picomatch to an unreviewed fork or downgrade the advisory severity. Revisit the full dependency audit and remove this exception once a patched upstream release is available and validated.

## Audit policy for this branch

| Check | Policy |
|---|---|
| Production dependency graph | Blocking: `npm audit --omit=dev` must pass with no reported production vulnerabilities |
| Complete development/build dependency graph | Always captured as JSON artifact; current picomatch advisory is explicitly recorded and must be rechecked after an upstream fix |
| Critical/high production findings | Blocking; do not suppress or relabel |
| Python/native runtime | Separately validated through pinned interpreter checks, runtime package inventory, native library packaging, and real RealtimeSTT integration tests |

## Previous dependency fixes

The earlier six moderate paths corresponding to [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) affecting `minimatch <11.0.1` were addressed by overriding `minimatch` to `^11.0.8` across the workspace, with `@isaacs/nonrecursive-glob-match@^1.1.0` included for compatibility.

The earlier `undici` finding was addressed by pinning `undici` to `^7.30.2`.

These earlier fixes do not resolve the newly reported picomatch advisory.
