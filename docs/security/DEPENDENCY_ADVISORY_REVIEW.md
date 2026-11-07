# Dependency advisory review

**Review date:** 2026-11-07  
**Next review / exception expiry:** 2026-12-07  
**Scope:** CI, packaging, and release-build dependency tree  
**Status:** Temporary moderate-severity exception proposed; project-owner review is still required.

## Current audit evidence

The latest CI dependency audit for this branch reports:

| Severity | Findings |
|---|---:|
| Critical | 0 |
| High | 0 |
| Moderate | 6 |
| Low | 0 |

The six moderate paths represent one distinct advisory: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) affecting `minimatch` versions `>=7.0.0 <11.0.1`. The committed lockfile produced by the verified CI run resolves `electron-builder@26.18.1` and `app-builder-lib@26.18.1`; it contains `minimatch@10.2.6` at the packaging-toolchain root and `minimatch@9.0.9` under `@electron/universal`. The advisory is fixed in `minimatch@11.0.1`.

The dependency chain is part of the packaging toolchain:

- `electron-builder` is a development dependency used to produce distributables.
- `app-builder-lib` and `@electron/universal` are transitive packaging/build dependencies.
- The affected `minimatch` copies are not part of the React renderer dependency bundle or application runtime API surface.
- The advisory describes resource exhaustion during glob-pattern preprocessing. It is still relevant to CI/build jobs and is not being treated as a false positive.

The earlier high-severity `undici` finding was resolved by pinning `undici` to the patched `7.30.2` line for the Electron downloader. The latest audit has zero high and zero critical findings.

## Temporary mitigation

1. Keep the full dependency audit in CI and fail the build on any new high or critical finding using `npm audit --audit-level=high`.
2. Keep the lockfile committed and install with `npm ci`. CI and release verification must never regenerate dependency resolution during a build.
3. Run package builds on ephemeral GitHub-hosted runners.
4. Do not pass user-supplied glob patterns or untrusted path expressions into Electron Builder or its file-matching configuration.
5. Keep release signing secrets unavailable to ordinary pull-request verification jobs.
6. Review the upstream Electron Builder v26 update that upgrades/accepts `minimatch@11.0.1`; remove this exception once a compatible release is available and the full Windows/macOS/Linux package matrix passes.

## Approval and expiry

This is a proposed, time-limited exception for a moderate **build-tooling** advisory, not a declaration that `npm audit` is clean. The repository owner must review and explicitly accept the residual CI/build risk before issue #60 is closed.

Re-check the advisory and the Electron Builder v26 release line no later than **2026-12-07**. If no compatible upstream release is available by then, renew the exception with a fresh review or replace the affected packaging dependency. Do not extend the exception automatically.
