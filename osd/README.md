# OSD — Official Sector Documents

OSD is a separate document workspace served at `/osd/` with its own API at `/api/osd/`. It keeps its document, approval, verification, audit, and share records in OSD tables, while authenticating people against the active CIA personnel records in the main application. CIA CHIEF access uses a short-lived, one-time handoff from the authenticated CIA session; OSD never trusts a role supplied by the browser.

## Server configuration

OSD requires the PostgreSQL `DATABASE_URL` already used by this application. The document signing key remains a server-side secret:

- `OSD_SIGNING_SECRET`: a stable signing key with at least 32 random bytes. Keep the same value to verify previously issued documents.

Generate the signing key locally (do not commit it):

```sh
openssl rand -hex 32
```

Add the signing key as a deployment secret. The CIA chief must first sign in through the main CIA portal; OSD issues an opaque handoff ticket valid for 60 seconds and accepts it once. OSD then rechecks the active CIA personnel record on the server. When no primary OSD chief exists and exactly one active CIA CHIEF is present, that identity is provisioned as the primary OSD administrator automatically. Otherwise, an existing primary account keeps its role and other chiefs receive only the rank-derived role. Disabled OSD accounts are never re-enabled by SSO.

The former OSD chief password/bootstrap/MFA endpoints return `410 Gone`; their database columns and existing records are left untouched. Members continue to sign in with their military code, and OSD rejects codes that are not linked to an active, approved personnel record. Only the primary `CIA CHIEF` account receives `ADMIN` and user-management permissions; other roles and clearances are derived from the personnel record's rank. An OSD user can enable or disable access, but cannot change a rank, role, clearance, or permission through the browser.

Without PostgreSQL, the OSD API fails closed and does not create documents. Without `OSD_SIGNING_SECRET`, existing records can be read, but creator signing, signed issue actions, and signature verification are disabled.

## Included workflow

- Separate OSD document storage, CIA-session SSO for the chief, personnel-linked identities, rank-derived clearance and server-enforced permissions, one-time SSO handoff tickets, expiring HttpOnly sessions, same-origin writes, and login throttling.
- Fourteen document templates, bilingual responsive center, separate drafts, archive/search filters, preview, approval, signing/issue, revocation, archive, expiring and revocable share links, and public verification.
- Mandatory creator sign-off before submission. The server binds the active personnel identity, rank, military code, UTC signing time, and current document contents to an HMAC signature; creator sign-off does not approve or issue the document.
- Rank-aware review assignment selects the nearest higher-ranked, active approver with sufficient clearance and the existing `APPROVE_DOCUMENTS` permission. A same-rank peer is used only when no higher approver is available; the system never sends a document down the rank hierarchy. Submission is blocked if no eligible reviewer exists.
- The assigned reviewer alone can approve or reject. Rejections require a reason. Reviewer and creator receive persistent in-site notifications, and the assigned-reviewer inbox is scoped to the authenticated reviewer.
- Workflow statuses are `DRAFT`, `PENDING SIGNATURE`, `SIGNED`, `PENDING APPROVAL`, `APPROVED`, `REJECTED`, `ISSUED`, `REVOKED`, `EXPIRED`, and `ARCHIVED`. Status, reviewer assignment, decision snapshots, notifications, and the existing hash-chained audit events are stored in PostgreSQL; workflow writes are transactional.
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

Run `npm test` for the repository's Node test suite. OSD workflow tests exercise document creation, the unsigned-submit guard, creator signatures, rank-based assignment for agent/high commander/supreme commander/chief, assigned inbox isolation, approval and reason-required rejection, notification delivery and read state, and persistence across a fresh session using a PostgreSQL test double. The rest of the OSD tests cover CIA SSO, role and clearance rules, shares, privacy, QR generation, versioning, and signature integrity. These automated tests do not connect to production PostgreSQL or verify a live browser session.