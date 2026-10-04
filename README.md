# Black Ridge City CIA

## Render PostgreSQL setup

1. Create a Render PostgreSQL database. In the web service settings, link its Internal Database URL as the DATABASE_URL environment variable. Keep the database and web service in the same region.
2. Set the build command to npm install and the start command to npm start.
3. On first startup, the server creates the blackridge_app_state table. If the database has no state row, it imports an accessible legacy cia-data.json file once; otherwise it starts from the configured empty state.
4. Keep one web-service instance and one Node process (WEB_CONCURRENCY=1). The application currently stores the complete state as one JSONB snapshot and keeps Socket.IO sessions in memory; multiple instances are not supported safely.

Never put DATABASE_URL in source control or paste it into chat. Configure it as an environment variable in Render. When migrating an existing service, restore or attach any old JSON state file before the first database startup; files already lost from an ephemeral filesystem cannot be recovered by the migration.

## Local development

Run npm install and npm start. Without DATABASE_URL, local development uses .blackridge-data/cia-data.json.
Run npm test to check the PostgreSQL state-store adapter.


## Official Sector Documents (OSD)

OSD is a separate document system at `/osd/`, with independent tables and accounts; it does not combine records with the CIA dashboard or map. It requires the PostgreSQL `DATABASE_URL` and server-side `OSD_BOOTSTRAP_CODE` (at least 24 random characters) and `OSD_SIGNING_SECRET` (at least 32 random bytes). See [the OSD setup and scope notes](osd/README.md). Never commit either secret.
