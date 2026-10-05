# Black Ridge City CIA

## Render PostgreSQL setup

1. Create a Render PostgreSQL database. In the web service settings, link its Internal Database URL as the DATABASE_URL environment variable. Keep the database and web service in the same region.
2. Set the build command to npm install and the start command to npm start.
3. On first startup, the server creates the blackridge_app_state table. If the database has no state row, it imports an accessible legacy cia-data.json file once; otherwise it starts from the configured empty state.
4. Keep one web-service instance and one Node process (WEB_CONCURRENCY=1). Application state is stored as a JSONB snapshot; notifications use a separate PostgreSQL table. Socket.IO sessions are in memory, so multiple instances are not supported safely.

Never put DATABASE_URL in source control or paste it into chat. Configure it as an environment variable in Render. When migrating an existing service, restore or attach any old JSON state file before the first database startup; files already lost from an ephemeral filesystem cannot be recovered by the migration.

## Local development

Run npm install and npm start. Without DATABASE_URL, local development uses .blackridge-data/cia-data.json.
Run npm test to check the PostgreSQL state-store adapter.

## Intelligence notification center

On startup, the server creates the `notifications` table and its indexes in the configured PostgreSQL database. This is an automatic, additive schema migration; no manual SQL or new environment variables are required. Keep `DATABASE_URL` configured for durable notifications on Render. Without it, local development falls back to the existing JSON state file.

Notifications are scoped to the authenticated server-side user ID. The Socket.IO API supports counts, paged/searchable lists, missed-event summaries, mark-read, and acknowledgement of critical alerts. Reading a critical alert does not acknowledge it. The client adds a responsive notification center, critical unread banner, live toasts, and a welcome-back brief. `npm test` also exercises per-user isolation and notification state transitions.
