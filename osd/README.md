# OSD — Official Sector Documents

OSD is a standalone document workspace served at `/osd/` with its own API at `/api/osd/`. It does not read or write IBP documents, maps, or application-state JSON.

## Server configuration

OSD requires the PostgreSQL `DATABASE_URL` already used by this application, plus two server-side secrets:

- `OSD_BOOTSTRAP_CODE`: a one-time first-account setup code, at least 24 random characters.
- `OSD_SIGNING_SECRET`: a stable signing key with at least 32 random bytes. Keep the same value to verify previously issued documents.

Generate the values locally (do not commit them):

```sh
openssl rand -hex 24
openssl rand -hex 32
```

Add the generated values as deployment secrets/environment variables. Do not put them in source control, browser code, or a support message. Visit `/osd/` and use **Initial Setup** once to create the first OSD commander. The bootstrap code is not stored in the database; after the first account is created, the bootstrap endpoint is permanently closed.

Without PostgreSQL, the OSD API fails closed and does not create documents. Without `OSD_SIGNING_SECRET`, existing records can be read, but signed issue actions are disabled and verification reports that the document cannot be verified.

## Included workflow

- Separate OSD accounts, role-based clearance, individual server-enforced permissions, password hashing, expiring HttpOnly sessions, same-origin writes, and login throttling.
- Ten document templates, bilingual responsive center, archive/search filters, draft editor, preview, approval, signing/issue, revocation, archive, secure bearer links, and public verification.
- Atomic sector/year document numbering, immutable version rows, amendment drafts linked to their predecessor, server-generated timestamps, HMAC-signed issued snapshots, and append-only hash-chained audit events.
- Browser print layout for A4; use **Print / Save PDF** and choose **Save as PDF** in the browser print dialog.

An issued snapshot is never edited in place. An amendment creates a new draft record linked to the source document and starts a new major version. The verification page displays only limited metadata and never reveals the real signer name or document body.

## Current boundaries

- The verification code and secure verification URL are implemented; a scannable QR image and binary attachment upload are not part of this first implementation.
- PDF output uses the browser's print-to-PDF pipeline, not a server-side PDF renderer.
- Hash chaining and database triggers make version/audit mutation detectable within the application. A database owner can still alter database structure or secrets; this is not a compliance certification or protection against a fully compromised host.
- Document numbers use the initials of the sector's first words (for example, Los Santos Sector → `LSS`) and a database counter per sector/year.

## Checks

Run `npm test` for the repository's Node test suite. The OSD tests cover authorization rules, privacy redaction, normalization, numbering, version increments, and signature integrity helpers.