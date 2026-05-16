# pnpm — Framework Audit

## Version Status

| | Value |
|---|---|
| **Used** | 9.15.9 (pinned in packageManager field) |
| **Workspace** | pnpm-workspace.yaml (apps/* + packages/*) |
| **Engine constraint** | >=9 |

## Configuration

### Workspace Layout

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

12 workspace packages total:
- 1 app: `@athlya/web`
- 11 packages: api, auth, billing, db, eslint-config, members, notifications, prettier-config, ratelimit, reservations, shared, tsconfig

### Internal Dependencies

All workspace references use `workspace:*` protocol:
```json
"@athlya/shared": "workspace:*"
```

This is correct — resolved to the local version at install time, replaced with the actual version on publish (not applicable for private packages).

## Patterns Applied Correctly

1. **`packageManager` field**: `"pnpm@9.15.9"` in root package.json enables Corepack enforcement
2. **Strict engine policy**: `"engines": { "node": ">=20 <21", "pnpm": ">=9" }`
3. **Lockfile**: `pnpm-lock.yaml` present (deterministic installs)
4. **`--frozen-lockfile`**: Referenced in CI pipeline (CI cannot modify lockfile)

## Recommendations

- No issues detected. pnpm 9.x is current and stable.
- `workspace:*` is the correct protocol for private monorepo packages.
- Consider `pnpm.overrides` if conflicting transitive dependency versions emerge.

## Checklist

- [x] packageManager field pinned
- [x] workspace:* for internal deps
- [x] Engine constraints enforced
- [x] Lockfile committed

## Source

- https://pnpm.io/workspaces
- https://pnpm.io/package_json#packagemanager
