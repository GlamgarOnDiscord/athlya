# rimraf — Framework Audit

## Version Status

| | Value |
|---|---|
| **Used** | ^6.0.1 |
| **Purpose** | Cross-platform `rm -rf` for clean scripts |

## Usage

Every package `clean` script:
```json
"clean": "rimraf dist .turbo *.tsbuildinfo"
```

Root clean:
```json
"clean": "turbo run clean && rimraf node_modules .turbo"
```

## Assessment

rimraf 6.x is current. Used only in development scripts (not production code). No issues.

## Source

- https://github.com/isaacs/rimraf
