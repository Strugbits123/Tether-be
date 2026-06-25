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
- Railway (hosting)

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
and error semantics are documented in [`API_REFERENCE.md`](./API_REFERENCE.md).

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
GET    /photos
DELETE /photos/:id
```

### Documents (protected)

```
POST   /documents/upload-urls
POST   /documents/batch
GET    /documents
GET    /documents/:id/download-url
DELETE /documents/:id
```

### Messages (protected)

```
POST   /messages
POST   /messages/video/upload-url
POST   /messages/audio/upload-url
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

### Activity (protected)

```
GET /activity
```

### System

```
GET  /health
POST /webhooks/mux   # Mux server-to-server callback (signature-verified)
```

## Database

Supabase PostgreSQL — 25 tables, RLS on all tables.
Schema: `tether_schema_v2.sql`
Run migrations manually in Supabase SQL Editor.
Never use automated migrations against production.

## Sprint Progress

- Sprint 1 ✅ — Auth, Dashboard, Onboarding foundation
- Sprint 2 ✅ — Recipients, Release Managers, Messages (text/video/audio + transcription), Photos, Documents, Activity feed
- Sprint 3 🔄 — Photo/document compression & galleries (upcoming)
- Sprint 4–10 — See sprint execution plan
