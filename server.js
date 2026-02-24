const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cookieSession = require('cookie-session');
const path = require('path');
const { Pool } = require('pg');
const { Readable } = require('stream');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'phixo-session',
  secret: process.env.SESSION_SECRET || 'phixo-secret-v3',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

// ═══════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════
if (!process.env.DATABASE_URL) {
  console.error('⚠️  DATABASE_URL not set — database features will fail');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Postgres pool error:', err.message);
});

async function initDb() {
  const c = await pool.connect();
  try {
    await c.query(`
      -- Universal content unit
      CREATE TABLE IF NOT EXISTS blocks (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        tags TEXT[],
        funnel_stage TEXT,
        source TEXT DEFAULT 'manual',
        source_url TEXT,
        drive_file_id TEXT,
        file_name TEXT,
        file_mime TEXT,
        content_payload TEXT,
        thumbnail_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Polymorphic attachment: blocks to clients/prospects/posts
      CREATE TABLE IF NOT EXISTS block_attachments (
        id SERIAL PRIMARY KEY,
        block_id INTEGER REFERENCES blocks(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(block_id, entity_type, entity_id)
      );

      -- Pipeline clients
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT,
        thread_id TEXT,
        session_type TEXT,
        session_date TEXT,
        offer TEXT,
        first_contact TEXT,
        status TEXT DEFAULT 'lead',
        lead_temperature TEXT,
        what_they_want TEXT,
        emotional_read TEXT,
        red_flags TEXT,
        opportunity TEXT,
        how_to_open TEXT,
        things_to_avoid TEXT,
        key_question TEXT,
        things_to_talk_about TEXT,
        what_they_need TEXT,
        moment_to_watch TEXT,
        how_to_close TEXT,
        lighting_setup TEXT,
        conversation_log TEXT,
        draft_reply TEXT,
        final_reply TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Discovery prospects
      CREATE TABLE IF NOT EXISTS prospects (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        handle TEXT,
        platform TEXT,
        category TEXT,
        status TEXT DEFAULT 'watching',
        why_them TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Content calendar posts
      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        platform TEXT,
        funnel_stage TEXT,
        post_goal TEXT,
        status TEXT DEFAULT 'idea',
        post_date TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Ordered module stack inside a post
      CREATE TABLE IF NOT EXISTS post_modules (
        id SERIAL PRIMARY KEY,
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        module_type TEXT NOT NULL,
        block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
        content TEXT,
        position INTEGER DEFAULT 0,
        collapsed BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Hook library (extracted from PDF or manual)
      CREATE TABLE IF NOT EXISTS hooks (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT,
        source TEXT DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('DB v3 ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally { c.release(); }
}

// ═══════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://admin.phixo.ca/auth/callback'
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function requireAuth(req, res, next) {
  if (req.session?.tokens) { oauth2Client.setCredentials(req.session.tokens); return next(); }
  res.redirect('/auth/login');
}

function getDrive(req) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials(req.session.tokens);
  // Auto-save refreshed tokens back to session
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) req.session.tokens.refresh_token = tokens.refresh_token;
    req.session.tokens.access_token = tokens.access_token;
    req.session.tokens.expiry_date = tokens.expiry_date;
  });
  return google.drive({ version: 'v3', auth });
}

app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { tokens } = await oauth2Client.getToken(req.query.code);
  req.session.tokens = tokens;
  res.redirect('/');
});

app.get('/auth/logout', (req, res) => { req.session = null; res.redirect('/auth/login'); });
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Health check
app.get('/health', async (req, res) => {
  const hasDb = !!process.env.DATABASE_URL;
  let dbOk = false;
  if (hasDb) { try { await pool.query('SELECT 1'); dbOk = true; } catch(e) {} }
  res.json({ ok:true, db:dbOk, DATABASE_URL:hasDb?'set':'MISSING', GOOGLE_CLIENT_ID:process.env.GOOGLE_CLIENT_ID?'set':'MISSING', ANTHROPIC_API_KEY:process.env.ANTHROPIC_API_KEY?'set':'MISSING' });
});

// ═══════════════════════════════════════════════════
// BLOCKS — Universal content unit
// ═══════════════════════════════════════════════════
app.get('/api/blocks', requireAuth, async (req, res) => {
  try {
    const { search, type, category, funnel_stage, tag } = req.query;
    let q = 'SELECT * FROM blocks';
    const p = []; const w = [];
    if (search) { p.push('%'+search+'%'); w.push(`(title ILIKE $${p.length} OR content_payload ILIKE $${p.length})`); }
    if (type) { p.push(type); w.push(`type = $${p.length}`); }
    if (category) { p.push(category); w.push(`category = $${p.length}`); }
    if (funnel_stage) { p.push(funnel_stage); w.push(`funnel_stage = $${p.length}`); }
    if (tag) { p.push(tag); w.push(`$${p.length} = ANY(tags)`); }
    if (w.length) q += ' WHERE ' + w.join(' AND ');
    q += ' ORDER BY created_at DESC';
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/blocks/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM blocks WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/blocks', requireAuth, async (req, res) => {
  try {
    const { type, title, category, tags, funnel_stage, source, source_url, drive_file_id,
            file_name, file_mime, content_payload, thumbnail_url } = req.body;
    const r = await pool.query(
      `INSERT INTO blocks (type,title,category,tags,funnel_stage,source,source_url,
        drive_file_id,file_name,file_mime,content_payload,thumbnail_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [type, title, category, tags||[], funnel_stage, source||'manual', source_url,
       drive_file_id, file_name, file_mime, content_payload, thumbnail_url]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/blocks/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['title','type','category','tags','funnel_stage','source_url',
                     'content_payload','thumbnail_url','drive_file_id'];
    const sets = []; const vals = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE blocks SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/blocks/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM blocks WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload file → Drive → create block
app.post('/api/blocks/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { type, title, category, tags, funnel_stage } = req.body;
    const drive = getDrive(req);

    // Get/create "Phixo Research" folder
    let folderId;
    const fs = await drive.files.list({
      q: "name='Phixo Research' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id)'
    });
    if (fs.data.files.length) folderId = fs.data.files[0].id;
    else {
      const f = await drive.files.create({
        requestBody: { name: 'Phixo Research', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      folderId = f.data.id;
    }

    const uploaded = await drive.files.create({
      requestBody: { name: req.file.originalname, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: Readable.from(req.file.buffer) },
      fields: 'id, thumbnailLink'
    });

    const tagArr = tags ? tags.split(',').map(t=>t.trim()).filter(Boolean) : [];
    const r = await pool.query(
      `INSERT INTO blocks (type,title,category,tags,funnel_stage,source,drive_file_id,
        file_name,file_mime,thumbnail_url) VALUES ($1,$2,$3,$4,$5,'upload',$6,$7,$8,$9) RETURNING *`,
      [type||'image', title||req.file.originalname, category, tagArr, funnel_stage,
       uploaded.data.id, req.file.originalname, req.file.mimetype, uploaded.data.thumbnailLink]
    );
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Ingest URL — fetch content, AI summary, create block
app.post('/api/blocks/ingest-url', requireAuth, async (req, res) => {
  try {
    const { url, type, category, funnel_stage, tags } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    // Fetch page content
    let pageText = '';
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const html = await response.text();
      pageText = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ').trim().substring(0, 4000);
    } catch(e) { pageText = ''; }

    // AI classify + summarize
    let title = url; let summary = ''; let suggestedTags = [];
    if (pageText.length > 100) {
      try {
        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: `Extract from this webpage: title (short), 2-sentence summary, and 3-5 relevant tags for a portrait photography business. Return JSON: {"title":"...","summary":"...","tags":["..."]}. Page content: ${pageText.substring(0,2000)}` }]
        });
        const parsed = JSON.parse(resp.content[0].text.replace(/```json|```/g,'').trim());
        title = parsed.title || url; summary = parsed.summary || ''; suggestedTags = parsed.tags || [];
      } catch(e) { title = url; }
    }

    const tagArr = tags ? tags.split(',').map(t=>t.trim()).filter(Boolean) : suggestedTags;
    const r = await pool.query(
      `INSERT INTO blocks (type,title,category,tags,funnel_stage,source,source_url,content_payload)
       VALUES ($1,$2,$3,$4,$5,'url',$6,$7) RETURNING *`,
      [type||'url', title, category, tagArr, funnel_stage, url, summary]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pick from Drive folder → create block
app.post('/api/blocks/from-drive', requireAuth, async (req, res) => {
  try {
    const { drive_file_id, file_name, file_mime, thumbnail_url, type, title, category, tags, funnel_stage } = req.body;
    const tagArr = tags ? (Array.isArray(tags) ? tags : tags.split(',').map(t=>t.trim()).filter(Boolean)) : [];
    const r = await pool.query(
      `INSERT INTO blocks (type,title,category,tags,funnel_stage,source,drive_file_id,file_name,file_mime,thumbnail_url)
       VALUES ($1,$2,$3,$4,$5,'drive',$6,$7,$8,$9) RETURNING *`,
      [type||'image', title||file_name, category, tagArr, funnel_stage,
       drive_file_id, file_name, file_mime, thumbnail_url]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Debug endpoint ───────────────────────────────
app.get('/api/debug', async (req, res) => {
  const out = { env: {}, db: {}, blocks: null };
  out.env.DATABASE_URL = process.env.DATABASE_URL ? 'set' : 'MISSING';
  out.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ? 'set' : 'MISSING';
  out.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING';
  try {
    await pool.query('SELECT 1');
    out.db.connected = true;
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    out.db.tables = tables.rows.map(r => r.table_name);
    if (out.db.tables.includes('blocks')) {
      const count = await pool.query('SELECT COUNT(*) as n FROM blocks');
      out.db.block_count = parseInt(count.rows[0].n);
      const sample = await pool.query('SELECT id,type,title,drive_file_id FROM blocks LIMIT 5');
      out.blocks = sample.rows;
    } else {
      out.db.note = 'blocks table does not exist yet - initDb may not have run';
    }
  } catch(e) {
    out.db.connected = false;
    out.db.error = e.message;
  }
  res.json(out);
});

// ─── Block Attachments ────────────────────────────
app.get('/api/attachments/:entity_type/:entity_id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.*, ba.id as attachment_id, ba.position, ba.created_at as attached_at
       FROM blocks b JOIN block_attachments ba ON ba.block_id = b.id
       WHERE ba.entity_type=$1 AND ba.entity_id=$2
       ORDER BY ba.position ASC, ba.created_at ASC`,
      [req.params.entity_type, req.params.entity_id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/attachments', requireAuth, async (req, res) => {
  try {
    const { block_id, entity_type, entity_id } = req.body;
    await pool.query(
      'INSERT INTO block_attachments (block_id,entity_type,entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [block_id, entity_type, entity_id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/attachments/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM block_attachments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// CLIENTS — Pipeline
// ═══════════════════════════════════════════════════
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const { search, status } = req.query;
    let q = 'SELECT id,name,platform,session_type,session_date,status,lead_temperature,updated_at FROM clients';
    const p = []; const w = [];
    if (search) { p.push('%'+search+'%'); w.push(`name ILIKE $${p.length}`); }
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (w.length) q += ' WHERE '+w.join(' AND ');
    q += ' ORDER BY updated_at DESC';
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    // Attach blocks
    const blocks = await pool.query(
      `SELECT b.*, ba.id as attachment_id, ba.position FROM blocks b
       JOIN block_attachments ba ON ba.block_id=b.id
       WHERE ba.entity_type='client' AND ba.entity_id=$1 ORDER BY ba.position, ba.created_at`,
      [req.params.id]
    );
    const c = r.rows[0];
    c.blocks = blocks.rows;
    res.json(c);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const { name, platform, thread_id, session_type, session_date, offer, first_contact, status } = req.body;
    const r = await pool.query(
      `INSERT INTO clients (name,platform,thread_id,session_type,session_date,offer,first_contact,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, platform, thread_id, session_type, session_date, offer, first_contact, status||'lead']
    );
    r.rows[0].blocks = [];
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['name','platform','thread_id','session_type','session_date','offer',
      'first_contact','status','lead_temperature','what_they_want','emotional_read','red_flags',
      'opportunity','how_to_open','things_to_avoid','key_question','things_to_talk_about',
      'what_they_need','moment_to_watch','how_to_close','lighting_setup',
      'conversation_log','draft_reply','final_reply','notes'];
    const sets=[]; const vals=[];
    for (const k of allowed) {
      if (req.body[k]!==undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE clients SET ${sets.join(',')},updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals
    );
    const blocks = await pool.query(
      `SELECT b.*,ba.id as attachment_id FROM blocks b JOIN block_attachments ba ON ba.block_id=b.id
       WHERE ba.entity_type='client' AND ba.entity_id=$1`, [req.params.id]
    );
    r.rows[0].blocks = blocks.rows;
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Analyze conversation with Claude
app.post('/api/clients/:id/analyze', requireAuth, async (req, res) => {
  try {
    const { conversation } = req.body;
    const cr = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Not found' });
    const client = cr.rows[0];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: `Analyze this DM conversation for Ian Green, portrait photographer at Phixo in Montreal.
Ian's style: collaborative sessions, tethered screen, reads nervous clients, warm and direct.
CLIENT: ${client.name} | ${client.platform||'unknown'} | ${client.session_type||'unknown'}
CONVERSATION:
${conversation}
Return ONLY valid JSON:
{
  "lead_temperature": "hot/warm/cold — one sentence why",
  "what_they_want": "what they're actually asking for",
  "emotional_read": "their tone and what's underneath the words",
  "red_flags": "specific concerns to watch for, or null",
  "opportunity": "the real opening here",
  "how_to_open": "exact first move when they walk in — specific",
  "things_to_avoid": "what NOT to do or say with this person",
  "key_question": "one question that unlocks them",
  "things_to_talk_about": "comfortable conversation topics",
  "what_they_need": "what they need beyond the photos",
  "moment_to_watch": "the signal to look for during the shoot",
  "how_to_close": "how to end the session so they leave feeling great",
  "lighting_setup": "suggested lighting for this client and session type",
  "draft_reply": "a reply Ian can send right now — warm, direct, moves things forward"
}` }]
    });

    const analysis = JSON.parse(response.content[0].text.replace(/```json|```/g,'').trim());
    analysis.conversation_log = conversation;

    const keys = Object.keys(analysis).filter(k =>
      ['lead_temperature','what_they_want','emotional_read','red_flags','opportunity',
       'how_to_open','things_to_avoid','key_question','things_to_talk_about','what_they_need',
       'moment_to_watch','how_to_close','lighting_setup','draft_reply','conversation_log'].includes(k)
    );
    const setClause = keys.map((k,i) => `${k}=$${i+1}`).join(',');
    const vals = keys.map(k => analysis[k]);
    vals.push(req.params.id);
    await pool.query(`UPDATE clients SET ${setClause},updated_at=NOW() WHERE id=$${vals.length}`, vals);

    // Also save conversation as a Block attached to this client
    const blockR = await pool.query(
      `INSERT INTO blocks (type,title,content_payload,source,category)
       VALUES ('conversation',$1,$2,'manual','clients') RETURNING *`,
      [`Conversation — ${client.name}`, conversation]
    );
    await pool.query(
      'INSERT INTO block_attachments (block_id,entity_type,entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [blockR.rows[0].id, 'client', req.params.id]
    );

    const updated = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    const blocks = await pool.query(
      `SELECT b.*,ba.id as attachment_id FROM blocks b JOIN block_attachments ba ON ba.block_id=b.id
       WHERE ba.entity_type='client' AND ba.entity_id=$1`, [req.params.id]
    );
    updated.rows[0].blocks = blocks.rows;
    res.json({ client: updated.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Analyze screenshot
app.post('/api/clients/:id/analyze-image', requireAuth, upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const base64 = req.file.buffer.toString('base64');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: base64 } },
        { type: 'text', text: `This is a DM screenshot for Ian Green, portrait photographer at Phixo in Montreal.
Extract the conversation and analyze it. Return ONLY valid JSON:
{"conversation_log":"full conversation as plain text","lead_temperature":"hot/warm/cold — why",
"what_they_want":"...","emotional_read":"...","red_flags":"... or null","opportunity":"...",
"how_to_open":"...","things_to_avoid":"...","key_question":"...","things_to_talk_about":"...",
"what_they_need":"...","moment_to_watch":"...","how_to_close":"...","lighting_setup":"...","draft_reply":"..."}` }
      ]}]
    });
    const analysis = JSON.parse(response.content[0].text.replace(/```json|```/g,'').trim());
    const keys = Object.keys(analysis).filter(k =>
      ['conversation_log','lead_temperature','what_they_want','emotional_read','red_flags','opportunity',
       'how_to_open','things_to_avoid','key_question','things_to_talk_about','what_they_need',
       'moment_to_watch','how_to_close','lighting_setup','draft_reply'].includes(k)
    );
    const setClause = keys.map((k,i) => `${k}=$${i+1}`).join(',');
    const vals = keys.map(k => analysis[k]);
    vals.push(req.params.id);
    await pool.query(`UPDATE clients SET ${setClause},updated_at=NOW() WHERE id=$${vals.length}`, vals);
    const updated = await pool.query('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    const blocks = await pool.query(
      `SELECT b.*,ba.id as attachment_id FROM blocks b JOIN block_attachments ba ON ba.block_id=b.id
       WHERE ba.entity_type='client' AND ba.entity_id=$1`, [req.params.id]
    );
    updated.rows[0].blocks = blocks.rows;
    res.json({ client: updated.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// PROSPECTS — Discovery
// ═══════════════════════════════════════════════════
app.get('/api/prospects', requireAuth, async (req, res) => {
  try {
    const { search, status, category } = req.query;
    let q = 'SELECT * FROM prospects';
    const p=[]; const w=[];
    if (search) { p.push('%'+search+'%'); w.push(`(name ILIKE $${p.length} OR handle ILIKE $${p.length})`); }
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (category) { p.push(category); w.push(`category=$${p.length}`); }
    if (w.length) q += ' WHERE '+w.join(' AND ');
    q += ' ORDER BY created_at DESC';
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/prospects/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM prospects WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const blocks = await pool.query(
      `SELECT b.*,ba.id as attachment_id FROM blocks b JOIN block_attachments ba ON ba.block_id=b.id
       WHERE ba.entity_type='prospect' AND ba.entity_id=$1`, [req.params.id]
    );
    r.rows[0].blocks = blocks.rows;
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prospects', requireAuth, async (req, res) => {
  try {
    const { name, handle, platform, category, status, why_them, notes } = req.body;
    const r = await pool.query(
      `INSERT INTO prospects (name,handle,platform,category,status,why_them,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, handle, platform, category, status||'watching', why_them, notes]
    );
    r.rows[0].blocks = [];
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/prospects/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['name','handle','platform','category','status','why_them','notes'];
    const sets=[]; const vals=[];
    for (const k of allowed) { if (req.body[k]!==undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); } }
    if (!sets.length) return res.json({ ok:true });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE prospects SET ${sets.join(',')},updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    const blocks = await pool.query(
      `SELECT b.*,ba.id as attachment_id FROM blocks b JOIN block_attachments ba ON ba.block_id=b.id
       WHERE ba.entity_type='prospect' AND ba.entity_id=$1`, [req.params.id]
    );
    r.rows[0].blocks = blocks.rows;
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/prospects/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM prospects WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Convert prospect → client
app.post('/api/prospects/:id/convert', requireAuth, async (req, res) => {
  try {
    const pr = await pool.query('SELECT * FROM prospects WHERE id=$1', [req.params.id]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Not found' });
    const p = pr.rows[0];
    const cr = await pool.query(
      `INSERT INTO clients (name,platform,notes,status) VALUES ($1,$2,$3,'lead') RETURNING *`,
      [p.name, p.platform, p.why_them || p.notes]
    );
    const client = cr.rows[0];
    // Move attached blocks
    await pool.query(
      `UPDATE block_attachments SET entity_type='client', entity_id=$1
       WHERE entity_type='prospect' AND entity_id=$2`,
      [client.id, p.id]
    );
    await pool.query('DELETE FROM prospects WHERE id=$1', [p.id]);
    client.blocks = [];
    res.json({ client });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// POSTS + MODULES
// ═══════════════════════════════════════════════════
app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const { status, platform } = req.query;
    let q = 'SELECT * FROM posts';
    const p=[]; const w=[];
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (platform) { p.push(platform); w.push(`platform=$${p.length}`); }
    if (w.length) q += ' WHERE '+w.join(' AND ');
    q += ` ORDER BY CASE status WHEN 'idea' THEN 1 WHEN 'draft' THEN 2 WHEN 'ready' THEN 3 WHEN 'posted' THEN 4 ELSE 5 END, created_at DESC`;
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const modules = await pool.query(
      `SELECT pm.*, b.type as block_type, b.title as block_title,
        b.content_payload, b.drive_file_id, b.file_mime, b.thumbnail_url, b.source_url
       FROM post_modules pm LEFT JOIN blocks b ON b.id=pm.block_id
       WHERE pm.post_id=$1 ORDER BY pm.position ASC`, [req.params.id]
    );
    r.rows[0].modules = modules.rows;
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const { platform, funnel_stage, post_goal, status, post_date, notes } = req.body;
    const r = await pool.query(
      `INSERT INTO posts (platform,funnel_stage,post_goal,status,post_date,notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [platform, funnel_stage, post_goal, status||'idea', post_date, notes]
    );
    r.rows[0].modules = [];
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['platform','funnel_stage','post_goal','status','post_date','notes'];
    const sets=[]; const vals=[];
    for (const k of allowed) { if (req.body[k]!==undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); } }
    if (!sets.length) return res.json({ ok:true });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE posts SET ${sets.join(',')},updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Post modules
app.post('/api/posts/:id/modules', requireAuth, async (req, res) => {
  try {
    const { module_type, block_id, content, position } = req.body;
    const maxPos = await pool.query(
      'SELECT COALESCE(MAX(position),0)+1 as next FROM post_modules WHERE post_id=$1', [req.params.id]
    );
    const r = await pool.query(
      `INSERT INTO post_modules (post_id,module_type,block_id,content,position)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, module_type, block_id||null, content||'', position ?? maxPos.rows[0].next]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/posts/:postId/modules/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['content','position','collapsed','block_id','module_type'];
    const sets=[]; const vals=[];
    for (const k of allowed) { if (req.body[k]!==undefined) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); } }
    if (!sets.length) return res.json({ ok:true });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE post_modules SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/posts/:postId/modules/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM post_modules WHERE id=$1', [req.params.id]); res.json({ ok:true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Reorder modules
app.post('/api/posts/:id/modules/reorder', requireAuth, async (req, res) => {
  try {
    const { order } = req.body; // array of { id, position }
    for (const item of order) {
      await pool.query('UPDATE post_modules SET position=$1 WHERE id=$2', [item.position, item.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════
app.get('/api/hooks', requireAuth, async (req, res) => {
  try {
    const { search, category } = req.query;
    let q = 'SELECT * FROM hooks';
    const p=[]; const w=[];
    if (search) { p.push('%'+search+'%'); w.push(`text ILIKE $${p.length}`); }
    if (category) { p.push(category); w.push(`category=$${p.length}`); }
    if (w.length) q += ' WHERE '+w.join(' AND ');
    q += ' ORDER BY category, created_at DESC';
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ingest hooks PDF from Drive
app.post('/api/hooks/ingest-pdf', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    // Find the hooks PDF
    const search = await drive.files.list({
      q: "name contains 'Hook' and mimeType='application/pdf' and trashed=false",
      fields: 'files(id, name)',
      pageSize: 10
    });
    if (!search.data.files.length) {
      return res.status(404).json({ error: 'No PDF with "Hook" in name found in Drive' });
    }
    const file = search.data.files[0];

    // Export/download as bytes
    const dlResp = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(dlResp.data);

    // Extract text - use basic PDF text extraction
    let pdfText = buffer.toString('latin1')
      .replace(/[^\x20-\x7E\n]/g, ' ')
      .replace(/\s+/g, ' ');

    // Send to Claude to extract individual hooks
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: `This is raw text from a "1000 Viral Hooks" PDF. Extract as many individual hook templates as you can find. Each hook is a short sentence or phrase (usually under 15 words) designed to start a social media post.

Classify each into one of: story, contrarian, mistake, educational, curiosity, if-then, before-after, question, number-list.

Return ONLY a JSON array: [{"text":"hook text here","category":"category"},...]

Extract at least 50 hooks if possible. Raw PDF text:
${pdfText.substring(0, 8000)}` }]
    });

    const hooks = JSON.parse(response.content[0].text.replace(/```json|```/g,'').trim());
    
    // Clear existing PDF hooks and reinsert
    await pool.query("DELETE FROM hooks WHERE source='pdf'");
    let inserted = 0;
    for (const h of hooks) {
      if (h.text && h.text.length > 5) {
        await pool.query(
          'INSERT INTO hooks (text,category,source) VALUES ($1,$2,$3)',
          [h.text.trim(), h.category||'general', 'pdf']
        );
        inserted++;
      }
    }
    res.json({ ok: true, count: inserted, file: file.name });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// AI-generate hook variations
app.post('/api/hooks/:id/variations', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM hooks WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const hook = r.rows[0];
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: `Generate 3 variations of this social media hook for a portrait photographer named Ian in Montreal. Keep the same structure/pattern but make each variation distinct. Hook: "${hook.text}"
Return ONLY a JSON array of 3 strings: ["variation 1","variation 2","variation 3"]` }]
    });
    const variations = JSON.parse(resp.content[0].text.replace(/```json|```/g,'').trim());
    res.json({ variations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// DRIVE
// ═══════════════════════════════════════════════════
app.get('/api/drive/browse', requireAuth, async (req, res) => {
  try {
    const { folder } = req.query;
    if (!folder) return res.status(400).json({ error: 'folder required' });
    const drive = getDrive(req);
    const fr = await drive.files.list({
      q: `name='${folder.replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)'
    });
    if (!fr.data.files.length) return res.json({ files: [], message: `Folder "${folder}" not found in Drive. Create a folder called "${folder}" in My Drive.` });
    const folderId = fr.data.files[0].id;
    const files = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,thumbnailLink,mimeType,size)',
      pageSize: 200, orderBy: 'name'
    });
    const driveFiles = files.data.files || [];
    // Mark which ones are already imported as blocks
    let alreadyImported = new Set();
    try {
      const ids = driveFiles.map(f => f.id);
      if (ids.length) {
        const r = await pool.query(
          'SELECT drive_file_id FROM blocks WHERE drive_file_id = ANY($1)',
          [ids]
        );
        r.rows.forEach(row => alreadyImported.add(row.drive_file_id));
      }
    } catch(e) { /* if DB not ready, skip */ }
    const enriched = driveFiles.map(f => ({
      ...f,
      already_imported: alreadyImported.has(f.id)
    }));
    res.json({ files: enriched, folderId, folder });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Sync Drive folders → auto-import new blocks ─────
app.post('/api/drive/sync', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const folderMap = [
      { name: 'Pose',             type: 'pose',  category: 'posing'    },
      { name: 'Meme',             type: 'meme',  category: 'memes'     },
      { name: 'SFX',              type: 'sfx',   category: 'audio'     },
      { name: 'Music',            type: 'sfx',   category: 'music'     },
      { name: 'Phixo Knowledge',  type: 'pdf',   category: 'knowledge' },
      { name: 'Tik Tok Scripts',  type: 'note',  category: 'scripts'   },
    ];

    let imported = 0;
    let skipped = 0;
    const results = [];

    for (const folder of folderMap) {
      // Find folder in Drive
      const fr = await drive.files.list({
        q: `name='${folder.name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id,name)', pageSize: 5
      });
      if (!fr.data.files.length) {
        results.push({ folder: folder.name, status: 'not found in Drive' });
        continue;
      }
      const folderId = fr.data.files[0].id;

      // List files in folder
      const files = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id,name,thumbnailLink,mimeType,size)',
        pageSize: 200, orderBy: 'name'
      });
      const driveFiles = files.data.files || [];

      // Find which are already imported
      const ids = driveFiles.map(f => f.id);
      let existingIds = new Set();
      if (ids.length) {
        const r = await pool.query(
          'SELECT drive_file_id FROM blocks WHERE drive_file_id = ANY($1)', [ids]
        );
        r.rows.forEach(row => existingIds.add(row.drive_file_id));
      }

      // Import new ones
      const newFiles = driveFiles.filter(f => !existingIds.has(f.id));
      for (const f of newFiles) {
        await pool.query(
          `INSERT INTO blocks (type,title,category,tags,source,drive_file_id,file_name,file_mime,thumbnail_url)
           VALUES ($1,$2,$3,$4,'drive',$5,$6,$7,$8)`,
          [folder.type, f.name, folder.category, [], f.id, f.name, f.mimeType||'', f.thumbnailLink||'']
        );
        imported++;
      }
      skipped += existingIds.size;
      results.push({ folder: folder.name, new: newFiles.length, existing: existingIds.size });
    }

    res.json({ ok: true, imported, skipped, results });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/drive/file/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    // Single call: get meta + stream together
    const meta = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'mimeType,name,size,thumbnailLink'
    });
    const mimeType = meta.data.mimeType || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=7200');
    res.setHeader('X-File-Name', encodeURIComponent(meta.data.name || 'file'));

    const fileRes = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    fileRes.data.on('error', (err) => {
      console.error('Drive stream error:', err.message);
      if (!res.headersSent) res.status(500).end();
    });

    fileRes.data.pipe(res);
  } catch (err) {
    console.error('Drive file error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════
// AI ASSISTANT — Grounded in Drive+DB only
// ═══════════════════════════════════════════════════
app.post('/api/assist/post', requireAuth, async (req, res) => {
  try {
    const { message, history, post_context } = req.body;

    // Gather context from DB: recent blocks, hooks matching post context
    const recentBlocks = await pool.query(
      'SELECT type,title,content_payload,tags,category FROM blocks ORDER BY created_at DESC LIMIT 20'
    );
    const hooks = await pool.query('SELECT text,category FROM hooks ORDER BY RANDOM() LIMIT 15');

    const system = `You are Ian's post-building assistant for Phixo, his portrait photography studio in Montreal.

CONTEXT FROM IAN'S LIBRARY:
Blocks in research library:
${recentBlocks.rows.map(b=>`- [${b.type}] ${b.title}${b.content_payload?' — '+b.content_payload.substring(0,80):''}`).join('\n')}

Sample hooks from Ian's library:
${hooks.rows.map(h=>`- [${h.category}] ${h.text}`).join('\n')}

CURRENT POST BEING BUILT:
${JSON.stringify(post_context||{}, null, 2)}

RULES:
- Use ONLY content from Ian's library above. No external examples.
- Ask ONE focused question at a time.
- When suggesting hooks, give 2-3 SHORT options pulled from or inspired by his hook library.
- Never write a full caption — help him find the angle, he writes it.
- Ian's voice: warm, direct, no hype words, no emojis.
- Keep replies under 5 sentences unless listing hook options.`;

    const messages = [...(history||[]), { role: 'user', content: message }];
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 500,
      system, messages
    });
    res.json({ reply: response.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Phixo Admin v3 — port ${PORT}`);
  if (process.env.DATABASE_URL) await initDb();
  else console.log('WARNING: No DATABASE_URL');
});
