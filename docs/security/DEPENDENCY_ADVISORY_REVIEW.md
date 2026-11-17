# Dependency advisory review

**Review date:** 2026-11-17  
**Status:** RESOLVED — All moderate findings eliminated; 0 vulnerabilities found in dependency audit.  
**Scope:** CI, packaging, and release-build dependency tree  

## Current audit evidence

The latest CI and local dependency audit (`npm audit`) reports:

| Severity | Findings |
|---|---:|
| Critical | 0 |
| High | 0 |
| Moderate | 0 |
| Low | 0 |

**Total vulnerabilities: 0**

The earlier six moderate paths corresponding to advisory [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) affecting `minimatch <11.0.1` have been completely eliminated by overriding `minimatch` to `^11.0.8` in `package.json` across the entire workspace (including `@electron/universal` and `app-builder-lib`), with `@isaacs/nonrecursive-glob-match@^1.1.0` added to devDependencies to provide the required dependency for `minimatch@11.0.8`.

The earlier high-severity `undici` finding was previously resolved by pinning `undici` to `^7.30.2`.

As a result, no temporary exceptions or waivers remain active. The dependency tree is fully audit-clean.
