# Tether API

NestJS backend for Tether — Digital Legacy Platform

## Tech Stack

- NestJS 11 + TypeScript (strict mode)
- Supabase (PostgreSQL + Auth + Realtime) — accessed via the **service-role key**
  (bypasses RLS; see Security & Reliability)
- Cloudflare R2 (file storage)
- Mux (video processing)
- Deepgram Nova-2 (transcription)
- Puppeteer / headless Chromium (memoir PDF export, release-plan activity reports)
- Stripe (payments)
- Resend (transactional email) + Svix (verifies Resend's webhook signatures)
- Twilio 10DLC (SMS)
- `archiver` (streamed ZIP generation for RM content downloads)
- `sanitize-html` (escaping dynamic values in generated HTML/PDF — transcripts,
  activity reports)
- PostHog (`posthog-node`, server-side product analytics)
- Sentry (error tracking)
- Railway (hosting) (separate environments for production and test)

## Prerequisites

- Node.js 20+
- npm
- Access to 1Password Teams vault (Tether)

## Local Setup

### 1. Clone the repo

```bash
git clone https://github.com/Strugbits123/Tether-be.git
cd tether-api
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in values from 1Password:

```bash
cp .env.example .env
```

### 4. Run in development

```bash
npm run start:dev
```

- API runs at: http://localhost:3001/api/v1
- Health check: http://localhost:3001/api/v1/health

## Environment Variables

See `.env.example` for all required variables with descriptions.
Never commit `.env` to git. All secrets live in 1Password Teams.

`RESEND_WEBHOOK_SECRET` is required for `/webhooks/resend` to work (the endpoint
503s without it) — get the signing secret from the Resend dashboard's webhook
settings for whichever endpoint URL you're testing against (dev/staging/prod
each have their own).

## Branch Strategy

- `feature/*` → `develop` (via PR)
- `develop` → pushed to `Tether-Inc/Tether-Back-End` develop (staging)
- `main` → pushed to `Tether-Inc/Tether-Back-End` main (production)

All PRs require CodeRabbit review before merge.

## Deployment

- **Staging:** auto-deploys to Railway when `Tether-Inc/develop` is updated
- **Production:** auto-deploys to Railway when `Tether-Inc/main` is updated
- GitHub Action handles sync from this repo to Tether-Inc repo

## Two Portals, One Backend

The frontend serves two experiences off the same API: an **owner portal**
(vault content — messages, photos, documents, memoir) and a **Release Manager
portal** (`/rm/*` routes) for whoever a given account owner has designated to
carry out their digital legacy release. A single person can hold both kinds of
membership (their own owner account, plus RM duty on someone else's).

Which "account" a request acts on is resolved by `AccountContextGuard` from
either:
- an `X-Account-Context: <membershipId>` header the frontend sends once it
  knows which membership is active, or
- (if absent) a fallback lookup for the caller's own `owner`
  `account_memberships` row — so a genuine account owner works with zero
  frontend setup.

`req.accountContext` then carries `{ membershipId, role, accountOwnerId, userId }`
for every guarded route. `RoleGuard` + `@Roles(...)` gate endpoints by
`role` (`owner` | `release_manager` | `guardian` | `recipient`).

## API Structure

All routes are prefixed with `/api/v1`. Full request/response shapes, validation rules,
and error semantics are defined by the DTOs and global interceptor/exception filter in `src/`.

### Response format

Every response uses one uniform envelope, so the frontend implements a single handler:

```jsonc
// Success (HTTP 2xx)
{ "success": true, "data": <payload>, "timestamp": "..." }

// Error (any non-2xx)
{ "success": false, "statusCode": 400, "message": "...", "timestamp": "...", "path": "..." }
```

`message` is always a string (validation failures are joined into one sentence).
Binary responses (`/rm/downloads/prepare`, `/rm/release-plan/activity-report`,
`/memoir/download/pdf`) bypass this envelope entirely via `@Res()` and stream
their content type directly.

Global request handling is wired in `src/main.ts`:

- **`ValidationPipe`** with `whitelist` + `forbidNonWhitelisted` + `transform` — unknown
  properties are rejected, and payloads are transformed into their DTO classes.
- **`TransformInterceptor`** wraps every success in the envelope above;
  **`SanitizeUserInterceptor`** strips sensitive user fields from responses.
- **`GlobalExceptionFilter`** wraps every error in the failure envelope.
- **CORS** is allow-listed to `FRONTEND_URL` plus the staging/production origins,
  with credentials enabled. Sentry's Nest error handler and
  `enableShutdownHooks()` (which flushes buffered PostHog events) are also set up here.

### Auth (public)

```
POST /auth/signup             # invite_token optional — see Invitations & Memberships
POST /auth/login
POST /auth/magic-link
POST /auth/reset-password
POST /auth/refresh
GET  /auth/google
```

### Auth (protected)

```
POST /auth/logout
POST /auth/update-password
```

### Memberships (protected)

A user can belong to more than one account (their own, plus any they've been
designated RM/guardian/recipient on). These endpoints resolve and switch
between them.

```
GET  /auth/memberships             # accepted/active memberships only
POST /auth/switch-context          # sets the caller's active membership
GET  /auth/active-context          # resolves from X-Account-Context
GET  /auth/pending-invite-check    # any non-owner membership by user_id or invite email —
                                    # used right after email confirmation to route an invite
                                    # signup straight to the account picker instead of the
                                    # owner onboarding wizard. Must go through this endpoint
                                    # (service-role access) rather than a direct Supabase
                                    # query — account_memberships has no RLS read policy.
```

### Invitations (protected, owner-only unless noted)

```
POST   /invitations/release-manager
POST   /invitations/guardian
POST   /invitations/recipient
POST   /invitations/accept/:token   # public — no auth required; mutating, so not a GET
POST   /invitations/resend/:id
DELETE /invitations/:id             # revokes the membership + cascades to the
                                     # release_managers/guardians/recipients row
```

`acceptInvitation` verifies (when the caller is logged in) that the
authenticated user's email matches the invite's `invite_email` before
honoring it — a signed-in user can't claim someone else's pending invite by
following their link.

### Access (protected, owner-only — `req.user.id` is the owner)

Owner-side recipient/guardian/release-manager management. Distinct from
`Invitations` above — see the note on dual invite paths in **Known
Inconsistencies**.

```
GET    /access/overview
POST   /access/recipients
PATCH  /access/recipients/:id
DELETE /access/recipients/:id
POST   /access/recipients/:id/guardian
DELETE /access/recipients/:id/guardian
POST   /access/release-manager          # designate/replace — revokes any existing
                                         # active RM (release_managers + membership row)
                                         # before inserting the new one
POST   /access/release-manager/remind   # rate-limited (24h) via notification_log
```

### Users (protected)

```
GET   /users/me
PATCH /users/profile
POST  /users/avatar-upload-url
POST  /users/onboarding/complete
POST  /users/onboarding/purposes
GET   /users/onboarding/state
```

### Recipients (protected)

```
POST /recipients
GET  /recipients
```

### Release Managers (protected)

```
POST /release-managers
GET  /release-managers
```

### Photos (protected)

```
POST   /photos/upload-urls
POST   /photos/batch
POST   /photos/folders
GET    /photos/folders
PATCH  /photos/folders/:id
DELETE /photos/folders/:id
GET    /photos
GET    /photos/:id
GET    /photos/:id/download-url
PATCH  /photos/:id
PATCH  /photos/:id/move
DELETE /photos/:id
```

### Documents (protected)

```
POST   /documents/upload-urls
POST   /documents/batch
GET    /documents/stats
GET    /documents
GET    /documents/:id
GET    /documents/:id/download-url
PATCH  /documents/:id
DELETE /documents/:id
```

`file_type` on a document row is the full MIME type captured at upload
(`application/pdf`, `image/jpeg`, ...), not a bare extension — clients
deriving an icon/kind from it should match on MIME prefix.

### Messages (protected)

```
POST   /messages
GET    /messages
PATCH  /messages/reorder
GET    /messages/:id
GET    /messages/:id/status
POST   /messages/:id/confirm-upload
POST   /messages/:id/playback-token
POST   /messages/:id/audio-url
PATCH  /messages/:id
DELETE /messages/:id
```

### Content (protected)

Read-only/bulk operations that span all content types (`message` |
`document` | `photo` | `chapter`). Chapters are surfaced in the UI as
"Memoir", but the wire value on `contentType` / `counts` is `chapter`.

```
GET  /content/unassigned        # items with no assignment (or only assign_later)
POST /content/bulk-assign       # replace assignments across many items (ownership-checked)
POST /content/bulk-delete       # delete many items across types
```

Group assignments use `groupValue` from the recipient relationship taxonomy:
`family` | `friend` | `partner` | `colleague` | `other`.

### Chapters (protected)

Memoir chapters — written (`text`) or `voice` (uploaded audio, transcribed via
Deepgram). Exhibits are per-chapter image/file attachments. `display_order` is
assigned atomically server-side (see Database).

```
POST   /chapters                        # create a text chapter
GET    /chapters                        # list + memoir stats
PATCH  /chapters/reorder
POST   /chapters/voice/upload-url       # signed upload URL for voice audio
POST   /chapters/voice                  # create voice chapter (kicks off transcription)
GET    /chapters/:id
GET    /chapters/:id/transcription      # transcription status poll
PATCH  /chapters/:id
PATCH  /chapters/:id/autosave
DELETE /chapters/:id
POST   /chapters/:id/exhibits/upload-url
POST   /chapters/:id/exhibits
GET    /chapters/:id/exhibits
DELETE /chapters/:id/exhibits/:exhibitId
POST   /chapters/:id/assignments        # replace chapter assignments (atomic)
GET    /chapters/:id/assignments
```

### Memoir (protected)

Assembles chapters into a memoir (title/dedication), exports, and per-chapter
text-to-speech narration.

```
GET    /memoir                          # memoir + aggregate stats (auto-creates on first read)
PATCH  /memoir                          # update title / dedication
DELETE /memoir                          # permanent delete of the whole story (confirmation-gated)
GET    /memoir/preview                  # full assembled preview (chapters, exhibits, TTS URLs)
GET    /memoir/download/pdf             # rendered PDF (Puppeteer)
GET    /memoir/download/text            # plain-text export
GET    /memoir/tts/status               # batch TTS status across chapters
POST   /memoir/chapters/:id/tts         # start narration for a chapter
GET    /memoir/chapters/:id/tts         # narration status / playback URL
DELETE /memoir/chapters/:id/tts
```

### RM Portal (protected — `@Roles('release_manager', 'guardian')` unless noted)

Everything a Release Manager (or a Guardian standing in) sees and does on the
account they've been designated for.

```
GET  /rm/overview                            # content stats + recent activity for the owner
GET  /rm/recipients                          # delivery/access status per recipient
GET  /rm/recipients/:id
PATCH /rm/recipients/:id/retry-email         # resend a bounced delivery email

GET  /rm/release-plan                        # 'none' | active-plan state (current_step 1-5+)
POST /rm/release-plan/initiate
POST /rm/release-plan/cancel
POST /rm/release-plan/continue-delivery      # atomic: only the call that flips
                                              # delivered_at from null actually sends
GET  /rm/release-plan/notification-status
GET  /rm/release-plan/delivery-status
GET  /rm/release-plan/activity-log
GET  /rm/release-plan/activity-report        # PDF (Puppeteer) — binary response
POST /rm/release-plan/guardian-request       # escalate to the next Guardian
GET  /release/cancel/:token                  # PUBLIC — read-only status check
POST /release/cancel/:token                  # PUBLIC — the actual cancellation. Kept as a
                                              # separate POST so the public GET can never
                                              # cancel a release as a side effect (link
                                              # previews, crawlers, accidental prefetch)

GET  /rm/downloads/summary                   # what's available to download, by category
POST /rm/downloads/prepare                   # streams a ZIP directly to the response
                                              # (archiver, not buffered in memory).
                                              # Gated on the release actually being
                                              # initiated; excludes assign_later content

GET    /rm/notifications                     # announcements + a curated activity_log slice
PATCH  /rm/notifications/:id/read
PATCH  /rm/notifications/:id/unread          # notifications are never deleted, only
                                              # toggled — read state lives in
                                              # rm_notification_reads, keyed by a bare
                                              # notification id (no FK — some ids are
                                              # activity_log rows, not announcements)
GET    /rm/notifications/unread-count
```

### Feedback (protected)

```
POST /feedback/screenshot-upload-url    # signed upload URL under the caller's prefix
POST /feedback                          # submit bug report / feature request / general feedback
```

### Activity (protected)

```
GET /activity
```

### Webhooks

```
POST /webhooks/mux            # Mux server-to-server callback (signature-verified)
POST /webhooks/supabase-auth  # Supabase auth DB webhook (shared-secret verified)
POST /webhooks/resend         # Resend email events (Svix-signature verified). Handles
                               # email.delivered / .bounced / .opened, updates
                               # notification_log, and marks the corresponding RM/guardian
                               # record `bounced`. Idempotent against replayed events
                               # (checks the log row isn't already `bounced` first).
```

### System

```
GET /health
```

## Known Inconsistencies (flagged, not yet unified)

- **Two RM-invitation code paths exist**: `POST /access/release-manager`
  (writes `release_managers` directly, then upserts the membership — this is
  what the frontend actually calls, and the one with correct revoke-then-replace
  semantics) and `POST /invitations/release-manager` (writes the membership
  first, then syncs to `release_managers` via a best-effort side call, and
  simply 409s instead of replacing if an RM already exists). If both are ever
  used interchangeably, the two tables can drift out of sync.
- **`DELETE /invitations/:id`** cascades to the `guardians` table on revoke but
  not to `release_managers`/`recipients` for those roles — a bug, not a design
  choice; worth fixing before that endpoint sees real traffic.

## Database

Supabase PostgreSQL. The database is provisioned for the **full product** (~31+
tables incl. release plans, recipient delivery, guardians, payments, gift
cards, notifications, and admin/announcements); this backend implements the
content-creation subset plus the full Release Manager portal (users, messages,
chapters, exhibits, TTS, memoirs, photos & folders, documents, recipients,
release managers, content assignments, feedback, activity log,
account_memberships, guardians, release_plans, recipient_delivery_status,
release_plan_activity_log, guardian_escalations, notification_log,
announcements, rm_notification_reads).

Run migrations manually in the Supabase SQL Editor — never use automated
migrations against production. The SQL the app depends on lives in [`db/`](./db):

| File | Purpose |
|---|---|
| `rls-policies.sql` | RLS backstop (safe under the service-role key; enforcing if an anon path is added) |
| `atomic-functions.sql` | RPCs called via `supabase.rpc(...)`: `replace_content_assignments` (transactional assignment replace, advisory-locked per item), `insert_chapter_ordered` / `insert_exhibit_ordered` (race-free `display_order` under a per-owner advisory lock, with a DB-side chapter-ownership check on exhibits) |
| `constraints.sql` | `unique (user_id)` on `memoirs`, backing the atomic upsert in `MemoirService` |
| `storage-limits.sql` | Storage quota schema/config |
| `analytics.sql` | Analytics-related schema |
| `announcements.sql` | `announcements` + `announcement_dismissals` tables backing the RM notification bell's system-announcement side. Written idempotently (`alter table ... add column if not exists`) because the live `announcements` table predated this feature with a narrower schema — re-run safely, it only adds what's missing |
| `rm-notification-reads.sql` | `rm_notification_reads` — read/unread tracking for the RM notification bell. Deliberately has **no FK** to `announcements`, since the merged notification feed also includes `activity_log` rows under the same id space |

Apply `atomic-functions.sql` and `constraints.sql` **before** deploying code that
calls them — the RPCs and the memoir upsert fail without them. Apply
`announcements.sql` and `rm-notification-reads.sql` before deploying the RM
notifications feature, or `/rm/notifications` 500s.

**Storage buckets** (all private and served via short-lived signed URLs, except
`avatars`):

| Bucket | Access | Path convention |
|---|---|---|
| `avatars` | public | `${userId}/avatar.${ext}` |
| `photos` | private | `${userId}/${uuid}.${ext}` |
| `documents` | private | `${userId}/${uuid}.${ext}` |
| `audio` | private | `${userId}/…` and `voice-chapters/${userId}/…` |
| `chapter-exhibits` | private | `${userId}/${chapterId}/…` |
| `chapter-audio` | private | `${userId}/${chapterId}/narration.mp3` |
| `feedback-screenshots` | private | `${userId}/…` |

**RLS:** the API accesses Postgres with the Supabase **service-role key**, which
**bypasses RLS** — tenant isolation is enforced in the service layer via explicit
`user_id` scoping (see Security & Reliability). An RLS backstop migration lives
in [`db/rls-policies.sql`](./db/rls-policies.sql); applying it is safe under the
service-role key and becomes enforcing if an anon/publishable-key path is added.

⚠️ **`account_memberships` currently has RLS enabled with no read policy at
all.** This is invisible from the backend (service-role bypasses it), but it
means the **frontend can never query this table directly**, even for a user's
own rows — a direct Supabase query from Next.js against it silently returns an
empty array. This is exactly why `GET /auth/pending-invite-check` exists: it's
the sanctioned way for the frontend to get an answer that depends on this
table, via the backend's service-role access. Don't add a frontend code path
that queries `account_memberships` directly — it will silently do nothing.

## Security & Reliability

Hardening enforced in code (since RLS is bypassed by the service-role key):

- **Object ownership** — every id-scoped read/write is filtered by `user_id`.
  Assignment paths validate that `recipient_id` and `folder_id` belong to the
  caller before any destructive delete, and `content/bulk-assign` verifies
  ownership of each `contentId`. Ownership queries surface real DB errors as
  500s rather than masking them as "not owned".
- **Upload safety** — client-supplied `storage_path` is rejected unless prefixed
  for the caller (`${userId}/…`) — including the feedback screenshot path used in
  support emails; file names are reduced to a safe basename (no path traversal)
  before building storage keys.
- **Atomic writes** — assignment replacement and `display_order` assignment run
  in single Postgres RPCs (transactional, advisory-locked) so a partial failure
  or concurrent request can't leave orphaned/duplicate state; the irreversible
  memoir delete checks every step and aborts on critical failure instead of
  reporting false success. `continueDelivery` conditionally updates
  `release_plans` only when `delivered_at is null` and checks whether the
  update actually returned a row, so two near-simultaneous calls can't both
  "win" and send duplicate delivery emails.
- **Invitation integrity** — `acceptInvitation` requires the authenticated
  user's email to match the invite's `invite_email`; a mismatch is rejected
  rather than silently letting a logged-in user claim a stranger's pending
  membership. A logged-out visitor whose invite email already belongs to an
  existing account is redirected to sign in rather than sign up (which would
  always 409).
- **Content-release gating** — `/rm/downloads/*` refuses to reveal anything
  until a `release_plans` row for the owner is `active`/`paused`/`delivered`,
  and only serves content actually assigned for delivery (excludes
  `assign_later` drafts) — matches the invitation-email promise that an RM has
  no content access before a release is initiated.
- **Generated-HTML escaping** — every dynamic value interpolated into
  server-rendered HTML destined for a PDF (release-plan activity reports,
  message transcripts) is passed through `sanitize-html` first — plan reason,
  names, timestamps, recipient statuses. This closed a real HTML/script
  injection path in the activity report.
- **Streamed downloads** — `/rm/downloads/prepare` pipes the ZIP archive
  (`archiver`) directly to the HTTP response as entries are compressed,
  rather than buffering the whole package in memory before the client sees a
  byte. Per-file fetches (audio/documents/photos/transcripts) run with bounded
  concurrency (5 at a time) instead of one-at-a-time.
- **Webhook idempotency** — `ResendWebhookService.handleBounced` checks the
  `notification_log` row isn't already `bounced` before re-running its
  side effects, so a replayed webhook event can't double-process.
- **External-call timeouts** — Deepgram transcription/TTS calls and outbound
  Resend sends are bounded (15s), so a hung provider marks the row `failed` /
  throws promptly instead of hanging the request indefinitely.
- **PDF generation** — a single Chromium instance is reused across requests with
  a render timeout and closed on shutdown, rather than launched per request.
- **Response hygiene** — `ValidationPipe` rejects unknown fields;
  `SanitizeUserInterceptor` strips sensitive user fields from every response.
- **Graceful shutdown** — `enableShutdownHooks()` ensures `onModuleDestroy`
  cleanup runs (close the browser, flush buffered PostHog events).
- **Webhooks** — `/webhooks/mux` (signature), `/webhooks/supabase-auth`
  (shared secret), and `/webhooks/resend` (Svix signature) are verified and
  fail closed.

## Sprint Progress

- Sprint 1 ✅ — Auth, Dashboard, Onboarding foundation
- Sprint 2 ✅ — Recipients, Release Managers, Messages (text/video/audio + transcription), Photos, Documents, Activity feed
- Sprint 3 ✅ — Photo folders, content assignments, cross-type Content module (unassigned listing, bulk assign/delete)
- Sprint 4 ✅ — Memoir: text & voice chapters (Deepgram transcription), exhibits, per-chapter TTS narration, PDF/text export, feedback module
- Sprint 5 ✅ — Release Manager portal: multi-membership auth (`/auth/memberships`, switch-context, invitations with email-match verification), Access module (owner-side RM/guardian/recipient management), RM overview/recipients/release-plan/downloads/notifications, Resend webhook + notification_log, security hardening (HTML escaping, atomic delivery, streamed downloads, RLS-aware invite check)
- Sprint 6–10 — See sprint execution plan
