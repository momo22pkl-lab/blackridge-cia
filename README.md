# Black Ridge City CIA

## Render PostgreSQL setup

1. Create a Render PostgreSQL database. In the web service settings, link its Internal Database URL as the DATABASE_URL environment variable. Keep the database and web service in the same region.
2. Set the build command to npm install and the start command to npm start.
3. On first startup, the server creates the blackridge_app_state table. If the database has no state row, it imports an accessible legacy cia-data.json file once; otherwise it starts from the configured empty state.
4. Keep one web-service instance and one Node process (WEB_CONCURRENCY=1). Application state is stored as a JSONB snapshot; notifications use a separate PostgreSQL table. Socket.IO sessions are in memory, so multiple instances are not supported safely.

Never put DATABASE_URL in source control or paste it into chat. Configure it as an environment variable in Render. When migrating an existing service, restore or attach any old JSON state file before the first database startup; files already lost from an ephemeral filesystem cannot be recovered by the migration.

## First CIA CHIEF setup

Before claiming the first CIA CHIEF, set `CIA_CHIEF_REGISTRATION_CODE` and `CIA_CHIEF_SAVE_CODE` as server-side environment variables in Render. Use different random values of at least 24 characters. Do not commit them to the repository or store them in browser storage. The server removes these fields from legacy persisted state when loading it, and new snapshots do not contain them. Existing chief accounts can continue to log in without these bootstrap variables.

## Local development

Run npm install and npm start. Without DATABASE_URL, local development uses .blackridge-data/cia-data.json.
Run npm test to check the PostgreSQL state-store adapter.

## Intelligence notification center

On startup, the server creates the `notifications` table and its indexes in the configured PostgreSQL database. This is an automatic, additive schema migration; no manual SQL or new environment variables are required. Keep `DATABASE_URL` configured for durable notifications on Render. Without it, local development falls back to the existing JSON state file.

Notifications are scoped to the authenticated server-side user ID. The Socket.IO API supports counts, paged/searchable lists, missed-event summaries, mark-read, and acknowledgement of critical alerts. Reading a critical alert does not acknowledge it. The client adds a responsive notification center, critical unread banner, live toasts, and a welcome-back brief. `npm test` also exercises per-user isolation and notification state transitions.

## Security and moderation

Message checks run on the server before persistence or broadcast for global/private chat, radio text/codes, Morse translation, and support messages/replies. The starter English and Arabic blocklist is intentionally small; add project-specific terms with the `CIA_SECURITY_BLOCKED_TERMS` environment variable, one term or phrase per line or separated by semicolons. Entries default to level 1; prefix one with `LEVEL 2:`, `LEVEL 3:`, or `LEVEL 4:` to set its severity. These terms are configuration, not credentials.

Threat patterns are level 3 and suspicious script/HTML payload patterns are level 4. Obfuscation bypass attempts are level 3; repeated level-1 violations are raised to level 2. Level 2 restricts the account and ends its active session; levels 3–4 suspend it. Only CIA CHIEF can restore a restricted account, and restoration leaves it off duty. Security incidents and notification actions are persisted without storing the blocked message text; alert delivery reuses the durable notification center, including offline delivery.
