# Turborepo — Framework Audit

_Last updated: 2026-05-14_

## Version Status

|                   | Value                                        |
| ----------------- | -------------------------------------------- |
| **Used**          | ^2.11.7 (root `package.json`)                |
| **Latest stable** | 2.11.9 (npm `latest`, 2026-10-17)            |
| **v3.0 RC**       | Snapshot 2026-05-14 — not on npm `latest`    |
| **Purpose**       | Build orchestration, caching, task pipelines |
| **UI**            | tui (terminal UI)                            |

---

## DEPRECATED — `turbo-ignore`

`turbo-ignore` (the standalone package/CLI used for CI skip detection) is deprecated as of Turborepo 2.9.

**Replacement**: `turbo query affected`

```bash
# Old (deprecated)
npx turbo-ignore --task=build

# New (Turborepo 2.9+)
turbo query affected --task=build
```

If your CI pipeline uses `turbo-ignore`, migrate to `turbo query affected` before the 3.0 upgrade drops it entirely.

---

## Turborepo 3.0 RC — Future Flags (Adopt Now)

Turborepo 3.0 introduces breaking changes behind opt-in Future Flags. Adopting them now in `turbo.json` prepares for the eventual upgrade with zero migration effort:

```json
{
  "experimentalFeatureFlags": {
    "groupLogs": true
  }
}
```

Available flags for 2.9.x:

| Flag             | What it does                                            | Status      |
| ---------------- | ------------------------------------------------------- | ----------- |
| `groupLogs`      | Groups terminal output per package, cleaner CI logs     | Recommended |
| `allowUnrelated` | Permits tasks in unrelated packages to run concurrently | Evaluate    |

Enable `groupLogs` — safe with no behavioral changes, just better output.

---

## Configuration (turbo.json)

```json
{
    "ui": "tui",
    "globalDependencies": ["**/.env", "**/.env.*", "tsconfig.json", ".nvmrc"],
    "globalEnv": ["NODE_ENV", "CI"],
    "tasks": { ... }
}
```

### Task Pipeline

| Task        | Dependencies           | Outputs                           | Notes                           |
| ----------- | ---------------------- | --------------------------------- | ------------------------------- |
| `build`     | `^build` (topological) | `dist/**`, `build/**`, `.next/**` | Excludes test files from inputs |
| `lint`      | `^lint`                | none                              | Not cacheable                   |
| `test`      | `^build`               | `coverage/**`                     | Depends on built packages       |
| `typecheck` | `^build`               | `*.tsbuildinfo`                   | Incremental TS info             |
| `clean`     | (no cache)             | —                                 | Uncacheable                     |
| `dev`       | (no cache, persistent) | —                                 | Long-running dev servers        |

### Input Filtering

```json
"inputs": ["$TURBO_DEFAULT$", ".env*", "!**/*.test.ts", "!**/*.test.tsx", "!**/*.spec.ts"]
```

Build cache ignores test file changes — correct optimization.

---

## Assessment

### Strengths

1. **Topological ordering**: `"dependsOn": ["^build"]` ensures packages build in dependency order
2. **Input exclusion**: Test files excluded from build inputs
3. **Global deps**: `.env` and `tsconfig.json` changes invalidate all caches
4. **CI env**: `NODE_ENV` and `CI` tracked as global env vars
5. **Persistent tasks**: `dev` correctly marked persistent/uncacheable

### No Remote Caching

No `remoteCache` configured. For solo developer this is fine. For team/CI use, consider:

- Vercel Remote Cache (free for Vercel-hosted projects)
- Self-hosted via `turbo-remote-cache` (Cloudflare Workers-compatible)

---

## Scripts

```json
"build": "turbo run build",
"lint": "turbo run lint",
"test": "turbo run test",
"typecheck": "turbo run typecheck",
"clean": "turbo run clean && rimraf node_modules .turbo"
```

---

## Known Issues (Turborepo 2.x)

- **Windows SIGINT handling**: Graceful shutdown sometimes broken on Windows
- **Next.js Skew Protection**: Occasional cache misses when deployed on Vercel with skew protection
- Both issues addressed in 3.0 RC

---

## Checklist

- [x] Topological task dependencies
- [x] Test files excluded from build inputs
- [x] Global env/deps tracking
- [x] Dev tasks marked persistent/uncacheable
- [x] Clean task uncacheable
- [x] Latest stable 2.x line (2.11.x)
- [ ] **Migrate from `turbo-ignore` to `turbo query affected`** (if used in CI)
- [ ] Enable `groupLogs` Future Flag for cleaner CI output
- [ ] Consider remote caching for team/CI scenarios
- [ ] Consider `turbo prune` for Docker image optimization

## Sources

- https://turborepo.dev/docs
- https://turborepo.dev/docs/reference/query
- https://github.com/vercel/turborepo/releases
- https://www.npmjs.com/package/turbo
