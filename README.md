# Black Ridge City CIA

## Render PostgreSQL setup

1. Create a Render PostgreSQL database. In the web service settings, link its Internal Database URL as the DATABASE_URL environment variable. Keep the database and web service in the same region.
2. Set the build command to npm install and the start command to npm start.
3. On first startup, the server creates the blackridge_app_state table. If the database has no state row, it imports an accessible legacy cia-data.json file once; otherwise it starts from the configured empty state.
4. Keep one web-service instance and one Node process (WEB_CONCURRENCY=1). The application currently stores the complete state as one JSONB snapshot and keeps Socket.IO sessions in memory; multiple instances are not supported safely.

Never put DATABASE_URL in source control or paste it into chat. Configure it as an environment variable in Render. When migrating an existing service, restore or attach any old JSON state file before the first database startup; files already lost from an ephemeral filesystem cannot be recovered by the migration.

## Leadership bootstrap security

The first CIA CHIEF setup requires two separate Render environment variables: CIA_CHIEF_REGISTRATION_CODE and CIA_CHIEF_SAVE_CODE. Set both to different, randomly generated values of at least 24 characters before claiming the first chief. For example, generate each locally with `openssl rand -hex 24` and enter the results directly in Render; do not commit them. There are no source-code defaults. Existing deployments with a saved chief do not need these values for normal logins.

For a separate trusted web origin, add its full HTTPS origin to CIA_ALLOWED_ORIGINS as a comma-separated environment variable. Same-origin access works without this setting.

## Local development

Run npm install and npm start. Without DATABASE_URL, local development uses .blackridge-data/cia-data.json. First-time leadership setup also requires the two bootstrap variables described above.
Run npm test to check the PostgreSQL state-store adapter.
