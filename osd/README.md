# OSD — Official Sector Documents

OSD is a separate document workspace served at `/osd/` with its own API at `/api/osd/`. It keeps its document, approval, verification, audit, and share records in OSD tables, while authenticating people against the active CIA personnel records in the main application.

## Server configuration

OSD requires the PostgreSQL `DATABASE_URL` already used by this application, plus two server-side secrets:

- `OSD_BOOTSTRAP_CODE`: a one-time first-account setup code, at least 24 random characters.
- `OSD_SIGNING_SECRET`: a stable signing key with at least 32 random bytes. Keep the same value to verify previously issued documents.

Generate the values locally (do not commit them):

```sh
openssl rand -hex 24
openssl rand -hex 32
```

Add the generated values as deployment secrets/environment variables. Do not put them in source control, browser code, or a support message. Visit `/osd/` and use **First-time Leader Setup** once with the military code of the registered, active `CIA CHIEF` and a new master password (12–200 characters). The setup code is not stored in the database. The password is stored as a salted scrypt hash; the setup endpoint cannot be used again after a primary chief account is established, and there is no in-app password reset or replacement route.

Members and other registered leadership accounts sign in with their military code only. OSD will reject codes that are not linked to an active, approved personnel record. Only the provisioned primary `CIA CHIEF` account receives `ADMIN` and user-management permissions; other roles and clearances are derived from the personnel record's rank. An OSD user can enable or disable access, but cannot change a rank, role, clearance, or permission through the browser.

Without PostgreSQL, the OSD API fails closed and does not create documents. Without `OSD_SIGNING_SECRET`, existing records can be read, but signed issue actions are disabled and verification reports that the document cannot be verified.

## Included workflow

- Separate OSD document storage, personnel-linked identities, rank-derived clearance and server-enforced permissions, a hashed primary-chief password, expiring HttpOnly sessions, same-origin writes, and login throttling.
- Fourteen document templates, bilingual responsive center, separate drafts, archive/search filters, preview, approval, signing/issue, revocation, archive, expiring and revocable share links, and public verification.
- Dedicated share viewer links that open the document directly. Anonymous links are restricted to `PUBLIC` documents; internal links require an active OSD session, `VIEW_DOCUMENTS`, and sufficient server-checked clearance.
- Protected viewing hides print/download controls, suppresses ordinary copy/selection actions, and can display a recipient watermark. These browser-side measures reduce casual copying but cannot prevent screenshots, photographs, or browser-level access.
- Issued-document print layouts retain the existing browser print-to-PDF flow, signature, official layout, verification code, clickable verification URL, and a locally generated QR code.
- Atomic sector/year document numbering, immutable version rows, amendment drafts linked to their predecessor, server-generated UTC timestamps, HMAC-signed issued snapshots, and append-only hash-chained audit events.
- Commanders draw their own signature in a pointer-enabled canvas using a mouse, stylus, or touch. The server rejects absent, oversized, malformed, or checksum-invalid PNGs; the approved drawing is stored with the issued snapshot and covered by its HMAC.
- Browser print layout for A4 includes the issued signature image and metadata; use **Print / Save PDF** and choose **Save as PDF** in the browser print dialog.

An issued snapshot is never edited in place. An amendment creates a new draft record linked to the source document and starts a new major version. The verification page displays only limited metadata and never reveals the real signer name or document body. Signature images are returned only to users with download or signer-identity permission; secure share links include them only when download access was explicitly granted.

## Current boundaries

- A scannable QR code is generated locally from the public verification URL. Public verification reveals only status and document number for classified records; public records may additionally reveal type, classification, version, and issue time. Verification never returns the document body, recipient, or real signer identity.
- OSD identity columns and indexes are added through idempotent schema initialization. These changes preserve existing document, approval, verification, audit, and share rows; startup after deployment applies the additive identity migration.
- PDF output uses the browser's print-to-PDF pipeline, not a server-side PDF renderer.
- The handwritten image records the signer's drawn mark; the server HMAC proves that the stored issued snapshot has not changed, but neither mechanism is a government digital signature or a legal-identity verification service.
- Hash chaining and database triggers make version/audit mutation detectable within the application. A database owner can still alter database structure or secrets; this is not a compliance certification or protection against a fully compromised host.
- Document numbers use the initials of the sector's first words (for example, Los Santos Sector → `LSS`) and a database counter per sector/year.

## Checks

Run `npm test` for the repository's Node test suite. The OSD tests cover authorization rules, one-time chief setup, hashed master-password storage, leader and military-code login, invalid and inactive codes, role escalation rejection, public/internal share policy, expiry and revocation decisions, privacy redaction, QR generation, document normalization, numbering, version increments, PNG signature validation, and signature-integrity helpers. Authentication routes are exercised against a database test double; production PostgreSQL contents and live browser rendering require separate live-environment checks.