# Tether API

NestJS backend for Tether — Digital Legacy Platform

## Tech Stack

- NestJS 11 + TypeScript (strict mode)
- Supabase (PostgreSQL + Auth + Realtime)
- Cloudflare R2 (file storage)
- Mux (video processing)
- Deepgram Nova-2 (transcription)
- Stripe (payments)
- Resend (transactional email)
- Twilio 10DLC (SMS)
- Sentry (error tracking)
- Railway (hosting) (seperate environments for production and test)

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

## Branch Strategy

- `feature/*` → `develop` (via PR)
- `develop` → pushed to `Tether-Inc/Tether-Back-End` develop (staging)
- `main` → pushed to `Tether-Inc/Tether-Back-End` main (production)

All PRs require CodeRabbit review before merge.

## Deployment

- **Staging:** auto-deploys to Railway when `Tether-Inc/develop` is updated
- **Production:** auto-deploys to Railway when `Tether-Inc/main` is updated
- GitHub Action handles sync from this repo to Tether-Inc repo

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

`message` is always a string (validation failures are joined into one sentence). A global
interceptor wraps successes; a global exception filter wraps errors.

### Auth (public)

```
POST /auth/signup
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

### Activity (protected)

```
GET /activity
```

### System

```
GET  /health
POST /webhooks/mux            # Mux server-to-server callback (signature-verified)
POST /webhooks/supabase-auth  # Supabase auth DB webhook (shared-secret verified)
```

## Database

Supabase PostgreSQL. The database is provisioned for the **full product** (~31
tables incl. release plans, recipient delivery, guardians, payments, gift
cards, notifications, and admin/announcements); this backend implements the
content-creation subset (users, messages, chapters, exhibits, TTS, memoirs,
photos & folders, documents, recipients, release managers, content
assignments, feedback, activity log).

Run migrations manually in the Supabase SQL Editor — never use automated
migrations against production.

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

## Security & Reliability

Hardening enforced in code (since RLS is bypassed by the service-role key):

- **Object ownership** — every id-scoped read/write is filtered by `user_id`.
  Assignment paths validate that `recipient_id` and `folder_id` belong to the
  caller, and `content/bulk-assign` verifies ownership of each `contentId`.
- **Upload safety** — client-supplied `storage_path` is rejected unless prefixed
  for the caller (`${userId}/…`); file names are reduced to a safe basename
  (no path traversal) before building storage keys.
- **External-call timeouts** — Deepgram transcription and TTS calls are bounded,
  so a hung provider marks the row `failed` instead of stuck `processing`.
- **PDF generation** — a single Chromium instance is reused across requests with
  a render timeout and closed on shutdown, rather than launched per request.
- **Batched writes** — content assignments insert in one round trip.
- **Graceful shutdown** — `enableShutdownHooks()` ensures `onModuleDestroy`
  cleanup runs (close the browser, flush buffered work).
- **Webhooks** — `/webhooks/mux` (signature) and `/webhooks/supabase-auth`
  (shared secret) are verified and fail closed.

## Sprint Progress

- Sprint 1 ✅ — Auth, Dashboard, Onboarding foundation
- Sprint 2 ✅ — Recipients, Release Managers, Messages (text/video/audio + transcription), Photos, Documents, Activity feed
- Sprint 3 ✅ — Photo folders, content assignments, cross-type Content module (unassigned listing, bulk assign/delete)
- Sprint 4 🔄 — Memoirs (long-form written content) — tables exist; services in progress
- Sprint 5–10 — See sprint execution plan
