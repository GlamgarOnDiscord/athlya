# Testcontainers — Framework Audit

## Version Status

|                       | Value                                          |
| --------------------- | ---------------------------------------------- |
| **Used**              | ^10.13.0                                       |
| **PostgreSQL module** | @testcontainers/postgresql ^10.13.0            |
| **Purpose**           | Real PostgreSQL for integration/property tests |

## Usage in Project

| Package                 | Usage                                               |
| ----------------------- | --------------------------------------------------- |
| `packages/db`           | RLS property tests (real Postgres with policies)    |
| `packages/reservations` | Booking property tests (concurrency, state machine) |
| `packages/members`      | Cascade integration tests (RGPD deletion)           |

## Pattern

Each test suite:

1. Starts a PostgreSQL container via testcontainers
2. Runs migrations against it
3. Seeds data per test run
4. Executes assertions against real SQL (RLS policies, unique constraints, etc.)
5. Truncates between runs
6. Stops container on suite teardown

## Why This Matters

- **RLS policies cannot be tested in-memory**: They require a real PostgreSQL engine
- **Concurrency tests**: Real transaction isolation levels matter for double-booking prevention
- **Migration verification**: Ensures schema + policies actually apply

## No Issues Detected

testcontainers 10.x is current. The patterns (container-per-suite, truncate-between-runs) are standard.

## Requirement

Docker must be available in the CI environment and on developer machines for these tests to run.

## Checklist

- [x] Real PostgreSQL for security-critical tests
- [x] Container lifecycle managed per suite
- [x] Used for RLS, concurrency, and RGPD cascade

## Source

- https://testcontainers.com/guides/getting-started-with-testcontainers-for-node/
