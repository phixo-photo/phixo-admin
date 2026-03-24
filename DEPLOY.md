# Phixo Admin — Deployment Guide

## What this is
A private web app that lives at admin.phixo.ca. It reads client conversations (text or screenshots), analyzes them with Claude, and files everything to Google Drive automatically.

## Files
- server.js — the backend (Node.js + Express)
- public/index.html — the frontend
- package.json — dependencies

---

## Step 1: Deploy to Railway

1. Go to railway.app and sign up with your GitHub account
2. Click "New Project" → "Deploy from GitHub repo"
3. Push these files to a new private GitHub repo first, then connect it
   OR use Railway CLI: `npm install -g @railway/cli` then `railway login` and `railway up`

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

## Step 2: Set environment variables in Railway

In your Railway project → Variables tab, add these:

```
ANTHROPIC_API_KEY=your_key_here
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_key_here
GOOGLE_REDIRECT_URI=https://admin.phixo.ca/auth/callback
SESSION_SECRET=your_key_here
NODE_ENV=production
```

### Prospect pipeline (Strategy → Prospects)

- **Sync** uses the official Quebec **Registre des entreprises** JSON API by default (no paid tools). It searches a West Island city list and upserts by NEQ.
- **Enrichment** uses Serper (`SERPER_API_KEY=...`).
- **Drafts** use Anthropic (`ANTHROPIC_API_KEY`).

**Apollo / remote JSON feed (optional, e.g. free trial):**

```
REGISTRY_SYNC_SOURCE_URL=https://your-apollo-or-feed-url/...
REGISTRY_SYNC_SOURCE_TOKEN=...   # if the feed requires Bearer auth
REGISTRY_SYNC_USE_APOLLO=true
```

When the trial ends, turn off the remote feed (Quebec direct still runs):

```
REGISTRY_SYNC_USE_APOLLO=false
```

You can leave `REGISTRY_SYNC_SOURCE_URL` in Railway for later; it is ignored while `REGISTRY_SYNC_USE_APOLLO` is `false`.

Same idea with generic naming: `REGISTRY_SYNC_REMOTE_ENABLED=true|false` (if both are set, `REGISTRY_SYNC_USE_APOLLO` wins).

If you **only** set `REGISTRY_SYNC_SOURCE_URL` and neither flag, the app still calls that URL (backward compatible).

Optional:

```
REGISTRY_SYNC_CITIES=Pointe-Claire,Kirkland,Beaconsfield
REGISTRY_SYNC_DEFAULT_DAYS=90
REGISTRY_SYNC_MAX_PAGES=8
REGISTRY_SYNC_DELAY_MS=2200
REGISTRY_POSTAL_PREFIXES=H9,H8
REGISTRY_SYNC_FETCH_DETAIL=false
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

## Step 3: Point your domain

In Railway → Settings → Domains → Add custom domain → type: admin.phixo.ca

Railway will give you a CNAME target. Then:
1. Log into Namecheap
2. Go to your phixo.ca domain → Advanced DNS
3. Add a CNAME record:
   - Host: admin
   - Value: the Railway CNAME they gave you
   - TTL: Automatic

Wait 5-10 minutes for DNS to propagate.

---

## Step 4: First login

Go to admin.phixo.ca → it'll redirect you to Google to authorize → approve it → you're in.

You only do this once. The session stays active.

---

## Step 5: Share your Clients folder

In Google Drive, find or create a folder called "Clients".
Right-click → Share → add the service account email (even though we're using OAuth, this ensures the app has proper access to that specific folder).

Actually with OAuth you're logged in as yourself so the app accesses Drive as you — no sharing needed. Just make sure the Clients folder exists.

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
- Railway: Free tier covers your volume (10-12 sessions/month)
- Anthropic API: ~$0.01-0.03 per analysis. At your volume, a few dollars/month max
- Google Drive API: Free at this scale
- Total: essentially free
