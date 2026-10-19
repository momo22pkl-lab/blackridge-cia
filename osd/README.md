# OSD — Official Sector Documents

OSD is a separate document workspace served at `/osd/` with its own API at `/api/osd/`. It keeps its document, approval, verification, audit, and share records in OSD tables, while authenticating people against the active CIA personnel records in the main application.

## Server configuration

OSD requires the PostgreSQL `DATABASE_URL` already used by this application, plus server-side secrets:

- `OSD_BOOTSTRAP_CODE`: a one-time first-account setup code, at least 24 random characters.
- `OSD_SIGNING_SECRET`: a stable signing key with at least 32 random bytes. Keep the same value to verify previously issued documents.
- `OSD_TOTP_ENCRYPTION_KEY`: a stable, independent key with at least 32 random bytes. OSD uses it to encrypt the leader's authenticator seed at rest; keep it unchanged while MFA is enabled.
- `OSD_CHIEF_TOTP_ENROLLMENT_CODE`: a separate code, at least 24 random characters and distinct from `OSD_BOOTSTRAP_CODE`, used to start or restart enrollment for a chief account that has not yet enabled MFA. Configure it before the initial bootstrap as well, in case setup is interrupted.

Generate the values locally (do not commit them):

```sh
openssl rand -hex 24
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 24
```

Add the generated values as deployment secrets/environment variables. Do not put them in source control, browser code, or a support message. Configure all four secrets before bootstrap; the bootstrap page remains unavailable unless the bootstrap code, separate enrollment code, and encryption key are valid. Visit `/osd/` and use **First-time Leader Setup** once with the military code of the registered, active `CIA CHIEF` and a new master password (12–200 characters). The bootstrap code is not stored in the database. The password is stored as a salted scrypt hash. The first-time setup then requires the chief to enroll a TOTP authenticator and confirm a live code before any leader session can be created. The provisioning secret and ten recovery codes are shown once; store the recovery codes securely.

For an existing primary chief account that has not enrolled MFA, or to restart an interrupted first-time enrollment, a valid password alone is deliberately insufficient. The enrollment screen also requires the separate `OSD_CHIEF_TOTP_ENROLLMENT_CODE` server code. The account must confirm a live authenticator code before sign-in is allowed. OSD clears existing primary-chief sessions during schema initialization and again on successful MFA enrollment, so sessions issued before MFA enforcement cannot bypass it. There is no browser route to disable or reset MFA, and the enrollment route refuses an account that is already enrolled. TOTP seeds are encrypted using `OSD_TOTP_ENCRYPTION_KEY`; recovery codes are stored only as hashes and each can be used once. A successful leader sign-in requires the password plus a current TOTP or unused recovery code. Password-only sign-in never creates a session.

Members and other registered leadership accounts sign in with their military code only. OSD will reject codes that are not linked to an active, approved personnel record. Only the provisioned primary `CIA CHIEF` account receives `ADMIN` and user-management permissions; other roles and clearances are derived from the personnel record's rank. An OSD user can enable or disable access, but cannot change a rank, role, clearance, or permission through the browser.

Without PostgreSQL, the OSD API fails closed and does not create documents. Without `OSD_SIGNING_SECRET`, existing records can be read, but signed issue actions are disabled and verification reports that the document cannot be verified.

## Included workflow

- Separate OSD document storage, personnel-linked identities, rank-derived clearance and server-enforced permissions, a hashed primary-chief password, encrypted TOTP secret, one-time recovery codes, expiring HttpOnly sessions and MFA challenges, same-origin writes, and login throttling.
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

Run `npm test` for the repository's Node test suite. The OSD tests cover authorization rules, one-time chief setup, hashed master-password storage, leader password-plus-TOTP login, rejection before MFA, encrypted authenticator storage, invalid/expired codes, one-time recovery codes, protected setup and no-reset behavior, unchanged personnel login, role escalation rejection, public/internal share policy, expiry and revocation decisions, privacy redaction, QR generation, document normalization, numbering, version increments, PNG signature validation, and signature-integrity helpers. Authentication routes are exercised against a database test double; production PostgreSQL contents and live browser rendering require separate live-environment checks.