Zero-downtime migration tooling
================================

This folder adds a lightweight orchestration layer to run migrations with progress tracking, pre-flight checks, and basic shadow testing.

Usage
-----

Set `DATABASE_URL` in the environment, then run from the `backend/` folder:

```
npm run migrate:zt -- preflight
npm run migrate:zt -- status
npm run migrate:zt -- apply
npm run migrate:zt -- rollback
npm run migrate:zt -- shadow-test
```

What it does
-----------
- Creates/uses `migration_audit` table to record runs and progress.
- Performs preflight checks (DB connectivity, pending migrations list).
- Orchestrates `node-pg-migrate` for schema changes and executes any scripts in `migration-transforms/` for data transformations.
- Records progress and metadata so operators can inspect the run state.

Notes & next steps
-----------------
- Application-level dual-write needs to be implemented in service code: the runner sets `dual_write` metadata flag so services can switch to dual-write behavior during the migration window.
- For complex data transforms add idempotent scripts under `backend/migration-transforms/` exporting an async `run({ dbPool })` function.
- This runner is intentionally conservative and focuses on coordination; adapt it further to integrate with CI/CD and deployment orchestration.
