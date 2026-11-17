# What was fixed

## Bugs that stopped things from working correctly
| Area | Problem | Fix |
| --- | --- | --- |
| Transactions | `BEGIN`/`COMMIT` were sent through a connection *pool*, so statements of one "transaction" ran on different connections (not atomic, and requests could interleave) | `withTransaction()` in `lib/db.ts` uses one dedicated client |
| IDs | `BIGINT` ids came back from `pg` as strings, so every MongoDB `$in` lookup missed and upvote counts never displayed; `uId !== reporterId` checks were always true | type parsers in `lib/db.ts` |
| Login | Seeded users had unsalted SHA-256 hashes (bcrypt can never match), hidden by hardcoded "demo password" bypasses and a no-password login | seeds use bcrypt; bypasses removed |
| Registration | `INSERT ... is_active = 1` into a BOOLEAN column fails on PostgreSQL | removed (column default is used) |
| PostgreSQL SSL | SSL was forced, which breaks local PostgreSQL | automatic: off for localhost, on for remote; `PGSSL` override |
| Audit trail | trigger **and** app both wrote history rows; the API hid duplicates with a fragile `LIKE` query; the live DB had been patched by a script that never touched `postgres_schema.sql` | trigger is the single writer (user + remarks via `app.user_id`/`app.remarks`); schema file is now the source of truth; obsolete patch scripts deleted |
| MongoDB script | `const db = db.getSiblingDB()` throws; validator required `long` (driver stores `int`) so writes were silently rejected; sample docs contradicted PostgreSQL data | rewritten |
| MongoDB sync | re-sync reset upvotes to 1; errors swallowed; failed connections leaked clients and stalled each request | fixed in `lib/mongo.ts` |
| Upvotes | unlimited upvotes per user, own complaint upvotable, resolved complaints upvotable, escalation skipped `HIGH` and re-escalated on every upvote, fake counts (`\|\| 2`) when Mongo missed | idempotent atomic upvote; one level up at 3 and 6 upvotes |
| Duplicate radar | suggested RESOLVED complaints | only active complaints |
| Embeddings | Python used randomised `hash()` and a different keyword list than the TypeScript code (vectors never comparable); row labelled `all-MiniLM-L6-v2` though not that model | one implementation (`lib/vector.ts`), honest model name |
| Analytics | "SLA compliance" was resolved ÷ total | resolved *within `target_hours`* ÷ resolved |
| Login UI | role-mismatch was checked after the session cookie had been set | server enforces `expected_role` first |
| Staff UI | `currentUser.role` (undefined) instead of `role_name` | fixed |

## Security
* Session cookie was plain JSON anyone could forge (`{"role_name":"ADMIN"}`) -> HMAC-signed with `SESSION_SECRET`, with expiry.
* Anyone could self-register as ADMIN -> public registration creates REPORTER only.
* Assign endpoint accepted anonymous calls (defaulting to admin id 8); status endpoint let any user (incl. students) resolve any complaint; delete/analytics/eval-queries/feedback had no or weak role/ownership checks -> proper role guards.
* Reporter e-mails were public -> only staff/admin see them. Account list only with `DEMO_MODE=true`.
* Workflow transitions validated in the database trigger (requirement 12: validation at DB level).

## Added
`scripts/setup-db.ts` (`npm run db:setup`), `tests/api.e2e.mjs` (`npm test`, 72 checks), `docker-compose.yml`, `.env.example`, rewritten README.

## Removed
SQLite silent fallback (it fabricated numbers, e.g. replaced resolution hours with a constant 4.0, and could not run vector search); `deploy_postgres.py`, `update_embeddings.py`, `sync_mongo.py`, `test_search.py`; stale `.mjs` tests and patch scripts.

## Not touched
The Python terminal prototype (`cli_app.py`, `campusfix_db.py`, ...). `verify_db.py` was already broken (`ImportError: DB_FILE`) and the CLI may still expect the old password hashes.
