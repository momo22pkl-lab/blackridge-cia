# OSD — Official Sector Documents

OSD is a separate document workspace served at `/osd/` with its own API at `/api/osd/`. It keeps its document, approval, verification, audit, and share records in OSD tables, while authenticating people against the active CIA personnel records in the main application.

## Server configuration

OSD uses the PostgreSQL `DATABASE_URL` already used by this application and the existing server-side settings:

- `OSD_SIGNING_SECRET`: the stable signing key for issued documents. Keep its current value so existing signatures continue to verify.
- `OSD_TOTP_ENCRYPTION_KEY`: leave its current value unchanged; existing encrypted authenticator data is retained.
- `OSD_CHIEF_TOTP_ENROLLMENT_CODE`: the existing server-side chief access code, at least 24 characters. The server compares the submitted code to this value; it is never returned to the browser or written to application logs.

No new environment variable is required. `OSD_BOOTSTRAP_CODE`, if already configured, is not used for this login flow and is not changed by it. Do not put secret values in source control, browser code, or support messages.

Chief sign-in requires the military code to resolve to the existing, enabled primary `CIA CHIEF` OSD account linked to the active personnel record, plus the exact `OSD_CHIEF_TOTP_ENROLLMENT_CODE`. The code check is server-side and rate-limited. On success, OSD creates the existing type of expiring `HttpOnly`, `SameSite=Strict` session and derives the account's role and permissions from the server-side personnel record.

The chief access code is a long-lived shared secret, not a rotating TOTP factor. Anyone who obtains it and the chief's military code could sign in as the primary chief; protect it as a credential. The former bootstrap, password-based leader login, TOTP enrollment, and TOTP challenge routes are retired. This change does not create or reset accounts, alter password/MFA fields, change any secret values, or modify OSD documents, signatures, audit rows, or permissions.

Members and other registered leadership accounts sign in with their military code only. OSD will reject codes that are not linked to an active, approved personnel record. Only the provisioned primary `CIA CHIEF` account receives `ADMIN` and user-management permissions; other roles and clearances are derived from the personnel record's rank. An OSD user can enable or disable access, but cannot change a rank, role, clearance, or permission through the browser.

Without PostgreSQL, the OSD API fails closed and does not create documents. Without `OSD_SIGNING_SECRET`, existing records can be read, but signed issue actions are disabled and verification reports that the document cannot be verified.

## Included workflow

- Separate OSD document storage, personnel-linked identities, rank-derived clearance and server-enforced permissions, expiring HttpOnly sessions, same-origin writes, and login throttling.
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

Run `npm test` for the repository's Node test suite. OSD tests cover primary-chief code login, rejection of wrong codes and non-chief accounts, retired authentication routes, session security, preservation of the existing account fields, unchanged personnel login, role-escalation rejection, document/share permissions, privacy redaction, QR generation, document normalization, numbering, version increments, PNG signature validation, and signature-integrity helpers. Authentication routes are exercised against a database test double; production PostgreSQL contents and live browser rendering require separate live-environment checks.