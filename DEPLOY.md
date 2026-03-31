# Phixo Admin — Deployment Guide

## What this is
A private web app that lives at admin.phixo.ca. It reads client conversations (text or screenshots), analyzes them with Claude, and files everything to Google Drive automatically.

## Files
- server.js — the backend (Node.js + Express)
- public/index.html — the frontend
- package.json — dependencies

---

## Step 1: Push to GitHub (source of truth)

1. Create or use your private GitHub repository for `phixo-admin`
2. Push your branch to GitHub
3. Use this repo as the deploy source for Cloudflare Pages (frontend)

---

## Local development

You can also run this app locally before deploying:

1. Make sure you have Node.js 20+ installed
2. In your project folder, install dependencies:

   ```bash
   npm install
   ```

   This will also run a small postinstall script that downloads the `yt-dlp` binary via `scripts/install-deps.js`. It’s used for video-related features in the Strategy / Ideation tools.

3. Start the server:

   ```bash
   node server.js
   ```

4. Open the app at `http://localhost:3000` (or whatever port you’ve configured in `server.js`)

Make sure the same environment variables listed above are set in your local shell (or a `.env` file loaded by your process manager) so Google / Anthropic integrations work as expected.

---

## Step 2: Backend environment variables (self-hosted server)

Set these on the self-hosted backend process (systemd/pm2/.env):

```
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_key_here
GOOGLE_REDIRECT_URI=https://admin.phixo.ca/auth/callback
SESSION_SECRET=your_key_here
NODE_ENV=production
DATABASE_URL=postgres://...
OPENAI_API_KEY=your_openai_key_here

# phixo-ai LiteLLM chat bridge
PHIXO_AI_OPENAI_BASE_URL=http://<phixo-ai-host>:4000/v1
PHIXO_AI_CHAT_API_KEY=your_litellm_or_slack_chatbot_key
PHIXO_AI_CHAT_MODEL_ALIAS=slack-bot-chat
# Optional route-specific aliases:
# PHIXO_AI_LIBRARY_MODEL_ALIAS=slack-bot-chat
# PHIXO_AI_DEEP_DIVE_MODEL_ALIAS=sysadmin-orchestrator
```

### Prospect pipeline (Strategy → Prospects)

**Sync order:** manual `records` in request body → **Apollo API** (if enabled) → optional **JSON URL** → **CSV file** (`DATA_PATH/phixo_prospects.csv` or `REGISTRY_PROSPECTS_CSV`) → **Quebec Registre** direct.

**Apollo.io trial (POST `/v1/mixed_companies/search` + people match):**

```
APOLLO_API_KEY=your_key
REGISTRY_SYNC_USE_APOLLO=true
```

Day 15 (trial ends) — one change:

```
REGISTRY_SYNC_USE_APOLLO=false
```

Then sync uses CSV (if you upload `phixo_prospects.csv` to your volume) and/or Quebec Registre.

Optional Apollo tuning: `APOLLO_ORG_KEYWORD_TAGS`, `APOLLO_ORG_LOCATIONS`, `APOLLO_PER_PAGE`, `APOLLO_FETCH_PEOPLE`, `APOLLO_PEOPLE_DELAY_MS`, `APOLLO_PEOPLE_SEARCH_MAX`, `APOLLO_EMPLOYEE_RANGES`.

**Optional JSON feed (not Apollo):** `REGISTRY_SYNC_SOURCE_URL` + `REGISTRY_SYNC_REMOTE_ENABLED=true` (or legacy: URL alone still enables GET fetch).

- **Enrichment:** Serper (`SERPER_API_KEY=...`).
- **Drafts:** Anthropic (`ANTHROPIC_API_KEY`).

Optional:

```
REGISTRY_SYNC_CITIES=Pointe-Claire,Kirkland,Beaconsfield
REGISTRY_SYNC_DEFAULT_DAYS=365
# Quebec city search: keep rows even when postal/city parsing fails on AdressePrimaire (default on)
REGISTRY_SYNC_TRUST_CITY_SEARCH=true
REGISTRY_SYNC_MAX_PAGES=8
REGISTRY_SYNC_DELAY_MS=2200
REGISTRY_POSTAL_PREFIXES=H9,H8
REGISTRY_SYNC_FETCH_DETAIL=false
# CSV sync defaults (when Apollo/remote/Quebec return nothing): include all scores, old dates
REGISTRY_CSV_MIN_DATE=1900-01-01
REGISTRY_CSV_SCORE_FILTER=LOW
SERPER_API_KEY=your_serper_key
PROSPECTS_FILE=/data/prospects.json
DATA_PATH=/data
```

To disable direct Quebec pulls and only use your own webhook URL:

```
REGISTRY_SYNC_DISABLE_QUEBEC_DIRECT=true
REGISTRY_SYNC_SOURCE_URL=https://your-server.example.com/registry-feed.json
```

---

## Step 3: Cloudflare Pages (frontend) + edge routing

1. In Cloudflare Pages, connect the GitHub repo and deploy frontend
2. Use `admin.phixo.ca` (or your chosen frontend domain) on Pages
3. Configure Cloudflare edge routing/proxy so:
   - frontend assets are served by Pages
   - `/api/*` requests proxy to self-hosted backend
   - `/auth/*` requests proxy to self-hosted backend (OAuth + session)

Important: keep API/auth same-origin from the browser to avoid session/CORS breakage.

---

## Step 4: First login

Go to admin.phixo.ca → it redirects to Google auth (`/auth/login`) → approve → you're in.

You only do this once. The session stays active.

---

## Step 5: Share your Clients folder

In Google Drive, find or create a folder called "Clients".
Right-click → Share → add the service account email (even though we're using OAuth, this ensures the app has proper access to that specific folder).

Actually with OAuth you're logged in as yourself so the app accesses Drive as you — no sharing needed. Just make sure the Clients folder exists.

---

## Step 6: Smoke tests + rollback gates

Before switching full traffic, validate:

1. Auth/session flow:
   - `GET /auth/login` redirects correctly
   - callback returns to app and session persists
2. Core chat endpoints:
   - `POST /api/library/ask`
   - `POST /api/knowledge/chat`
   - `POST /api/knowledge/chat/deep-dive`
3. Upload and KB paths:
   - PDF ingest route still writes data and status endpoints respond

Suggested rollback gate:

- Keep old provider env values available and deploy with a quick revert path:
  - restore previous env vars / branch if chat responses fail
  - monitor first production window before removing fallback settings

---

## How it works

**Intake tab**
- Paste a conversation OR drop a screenshot
- Hit "Analyze and file"
- Claude reads it, identifies the client, builds the full analysis + session briefing + draft reply
- Creates or updates a Google Doc in Drive under Clients > [Client Name]

**Clients tab**  
- Lists all client folders from Drive
- Click any client to open their folder in Drive

**Session tab**
- Search for a client by name
- Pulls their briefing for a quick pre-shoot glance on your phone

---

## Costs
- Cloudflare Pages: free tier for frontend hosting
- Self-hosted server: your existing infra cost
- Model/API costs: based on LiteLLM routed providers and usage
- Google Drive API: free at this scale
