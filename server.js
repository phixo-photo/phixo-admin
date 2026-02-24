const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cookieSession = require('cookie-session');
const path = require('path');
const { Pool } = require('pg');
const { Readable } = require('stream');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'phixo-session',
  secret: process.env.SESSION_SECRET || 'phixo-secret-key',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

// ─── Database ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT,
        session_type TEXT,
        session_date TEXT,
        offer TEXT,
        first_contact TEXT,
        status TEXT DEFAULT 'lead',
        thread_id TEXT,
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

      CREATE TABLE IF NOT EXISTS client_poses (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
        drive_file_id TEXT NOT NULL,
        file_name TEXT,
        thumbnail_url TEXT,
        note TEXT,
        added_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS research_items (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        type TEXT NOT NULL,
        tags TEXT[],
        source_url TEXT,
        drive_file_id TEXT,
        summary TEXT,
        why_it_matters TEXT,
        recommended_use TEXT,
        platform TEXT,
        file_name TEXT,
        file_mime TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        platform TEXT,
        hook TEXT,
        caption TEXT,
        shot_list TEXT,
        cta TEXT,
        status TEXT DEFAULT 'idea',
        post_date TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS post_research (
        post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
        research_id INTEGER REFERENCES research_items(id) ON DELETE CASCADE,
        PRIMARY KEY (post_id, research_id)
      );
    `);
    console.log('Database ready');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally {
    client.release();
  }
}

// ─── Google OAuth ─────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://admin.phixo.ca/auth/callback'
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function requireAuth(req, res, next) {
  if (req.session && req.session.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  res.redirect('/auth/login');
}

function getDrive(req) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials(req.session.tokens);
  return google.drive({ version: 'v3', auth });
}

// ─── Auth routes ──────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  req.session.tokens = tokens;
  res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/auth/login');
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const { search, status } = req.query;
    let q = 'SELECT id, name, platform, session_type, session_date, status, lead_temperature, updated_at FROM clients';
    const params = [];
    const conditions = [];
    if (search) {
      params.push('%' + search + '%');
      conditions.push(`(name ILIKE $${params.length} OR session_type ILIKE $${params.length})`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
    q += ' ORDER BY updated_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    // Also get poses
    const poses = await pool.query('SELECT * FROM client_poses WHERE client_id = $1 ORDER BY added_at ASC', [req.params.id]);
    const client = result.rows[0];
    client.poses = poses.rows;
    res.json(client);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  try {
    const f = req.body;
    const result = await pool.query(
      `INSERT INTO clients (name, platform, session_type, session_date, offer, first_contact, status, thread_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [f.name, f.platform, f.session_type, f.session_date, f.offer, f.first_contact, f.status || 'lead', f.thread_id]
    );
    result.rows[0].poses = [];
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const allowed = [
      'name','platform','session_type','session_date','offer','first_contact','status','thread_id',
      'lead_temperature','what_they_want','emotional_read','red_flags','opportunity',
      'how_to_open','things_to_avoid','key_question','things_to_talk_about','what_they_need',
      'moment_to_watch','how_to_close','lighting_setup',
      'conversation_log','draft_reply','final_reply','notes'
    ];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key]);
        updates.push(`${key} = $${values.length}`);
      }
    }
    if (!updates.length) return res.json({ ok: true });
    values.push(new Date());
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE clients SET ${updates.join(', ')}, updated_at = $${values.length - 1} WHERE id = $${values.length} RETURNING *`,
      values
    );
    const poses = await pool.query('SELECT * FROM client_poses WHERE client_id = $1 ORDER BY added_at ASC', [req.params.id]);
    result.rows[0].poses = poses.rows;
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Analyze conversation with Claude ─────────────────────
app.post('/api/clients/:id/analyze', requireAuth, async (req, res) => {
  try {
    const { conversation } = req.body;
    const clientRes = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!clientRes.rows.length) return res.status(404).json({ error: 'Client not found' });
    const client = clientRes.rows[0];

    const prompt = `You are analyzing a DM conversation for Ian Green, portrait photographer at Phixo studio in Montreal.
Ian's approach: collaborative sessions, clients see photos in real time on tethered screen, he reads nervous clients and helps them open up, keeps confident clients' energy flowing.

CLIENT: ${client.name} | Platform: ${client.platform || 'unknown'} | Session type: ${client.session_type || 'unknown'}

CONVERSATION:
${conversation}

Write a complete session briefing in Ian's voice — direct, warm, specific. Not generic advice.
Return ONLY valid JSON with these exact keys:
{
  "lead_temperature": "hot/warm/cold — one sentence explaining why",
  "what_they_want": "what they're actually asking for, in plain terms",
  "emotional_read": "how they're coming across — their tone, confidence level, what's underneath the words",
  "red_flags": "specific concerns or friction points to watch for — or null if none",
  "opportunity": "the real opening here — what this could become if the session goes well",
  "how_to_open": "the exact first thing Ian should do or say when they walk in — specific, not generic",
  "things_to_avoid": "what NOT to do or say with this specific person",
  "key_question": "the one question that will unlock them during the session",
  "things_to_talk_about": "conversation topics that will make them comfortable and talkative",
  "what_they_need": "what they actually need from this experience beyond the photos",
  "moment_to_watch": "the specific moment or signal to look for during the shoot",
  "how_to_close": "how to end the session so they leave feeling great",
  "lighting_setup": "suggested lighting approach for this type of client and session",
  "draft_reply": "a reply Ian can send right now — warm, direct, moves things forward"
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(text);
    analysis.conversation_log = conversation;

    const keys = Object.keys(analysis).filter(k =>
      ['lead_temperature','what_they_want','emotional_read','red_flags','opportunity',
       'how_to_open','things_to_avoid','key_question','things_to_talk_about','what_they_need',
       'moment_to_watch','how_to_close','lighting_setup','draft_reply','conversation_log'].includes(k)
    );
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = keys.map(k => analysis[k]);
    vals.push(req.params.id);
    await pool.query(`UPDATE clients SET ${setClause}, updated_at = NOW() WHERE id = $${vals.length}`, vals);

    const updated = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const poses = await pool.query('SELECT * FROM client_poses WHERE client_id = $1', [req.params.id]);
    updated.rows[0].poses = poses.rows;
    res.json({ client: updated.rows[0] });
  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Analyze screenshot ───────────────────────────────────
app.post('/api/clients/:id/analyze-image', requireAuth, upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const base64 = req.file.buffer.toString('base64');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: req.file.mimetype, data: base64 } },
          { type: 'text', text: `This is a DM screenshot for Ian Green, portrait photographer at Phixo in Montreal.
Extract the full conversation and analyze it. Return ONLY valid JSON:
{
  "conversation_log": "full conversation as plain text, formatted clearly",
  "lead_temperature": "hot/warm/cold — why",
  "what_they_want": "what they want",
  "emotional_read": "how they come across",
  "red_flags": "concerns or null",
  "opportunity": "real opening here",
  "how_to_open": "how to start the session",
  "things_to_avoid": "what not to do",
  "key_question": "one question that unlocks them",
  "things_to_talk_about": "comfortable topics",
  "what_they_need": "what they need beyond photos",
  "moment_to_watch": "signal to look for",
  "how_to_close": "how to end the session",
  "draft_reply": "reply Ian can send now"
}` }
        ]
      }]
    });

    const text = response.content[0].text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(text);

    const keys = Object.keys(analysis).filter(k =>
      ['conversation_log','lead_temperature','what_they_want','emotional_read','red_flags','opportunity',
       'how_to_open','things_to_avoid','key_question','things_to_talk_about','what_they_need',
       'moment_to_watch','how_to_close','draft_reply'].includes(k)
    );
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const vals = keys.map(k => analysis[k]);
    vals.push(req.params.id);
    await pool.query(`UPDATE clients SET ${setClause}, updated_at = NOW() WHERE id = $${vals.length}`, vals);

    const updated = await pool.query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    const poses = await pool.query('SELECT * FROM client_poses WHERE client_id = $1', [req.params.id]);
    updated.rows[0].poses = poses.rows;
    res.json({ client: updated.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// POSES — Browse Drive folder & attach to clients
// ═══════════════════════════════════════════════════════════

// List files from "Phixo Poses" Drive folder
app.get('/api/drive/poses', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const { search } = req.query;

    // Find or surface the Phixo Poses folder
    const folderRes = await drive.files.list({
      q: "name='Phixo Poses' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name)'
    });

    if (!folderRes.data.files.length) {
      return res.json({ files: [], message: 'No "Phixo Poses" folder found in your Drive. Create a folder named exactly "Phixo Poses" and add your pose images.' });
    }

    const folderId = folderRes.data.files[0].id;
    let q = `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`;
    if (search) q += ` and name contains '${search.replace(/'/g, "\\'")}'`;

    const filesRes = await drive.files.list({
      q,
      fields: 'files(id, name, thumbnailLink, mimeType, size)',
      pageSize: 100,
      orderBy: 'name'
    });

    res.json({ files: filesRes.data.files || [], folderId });
  } catch (err) {
    console.error('Drive poses error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get poses attached to a client
app.get('/api/clients/:id/poses', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM client_poses WHERE client_id = $1 ORDER BY added_at ASC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attach a pose to a client
app.post('/api/clients/:id/poses', requireAuth, async (req, res) => {
  try {
    const { drive_file_id, file_name, thumbnail_url, note } = req.body;
    // Check not already attached
    const existing = await pool.query(
      'SELECT id FROM client_poses WHERE client_id = $1 AND drive_file_id = $2',
      [req.params.id, drive_file_id]
    );
    if (existing.rows.length) return res.json({ ok: true, message: 'Already attached' });

    const result = await pool.query(
      'INSERT INTO client_poses (client_id, drive_file_id, file_name, thumbnail_url, note) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.params.id, drive_file_id, file_name, thumbnail_url, note]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove a pose from a client
app.delete('/api/clients/:id/poses/:poseId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM client_poses WHERE id = $1 AND client_id = $2', [req.params.poseId, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// RESEARCH LIBRARY
// ═══════════════════════════════════════════════════════════

app.get('/api/research', requireAuth, async (req, res) => {
  try {
    const { search, type, tag } = req.query;
    let q = 'SELECT * FROM research_items';
    const params = [];
    const conditions = [];
    if (search) {
      params.push('%' + search + '%');
      conditions.push(`(title ILIKE $${params.length} OR summary ILIKE $${params.length} OR why_it_matters ILIKE $${params.length})`);
    }
    if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
    if (tag) { params.push(tag); conditions.push(`$${params.length} = ANY(tags)`); }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
    q += ' ORDER BY created_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/research/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM research_items WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/research', requireAuth, async (req, res) => {
  try {
    const { title, type, tags, source_url, summary, why_it_matters, recommended_use, platform } = req.body;
    const result = await pool.query(
      `INSERT INTO research_items (title, type, tags, source_url, summary, why_it_matters, recommended_use, platform)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [title, type, tags || [], source_url, summary, why_it_matters, recommended_use, platform]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/research/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['title','type','tags','source_url','summary','why_it_matters','recommended_use','platform'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { values.push(req.body[key]); updates.push(`${key} = $${values.length}`); }
    }
    if (!updates.length) return res.json({ ok: true });
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE research_items SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/research/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM research_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload file to Drive + save research item
app.post('/api/research/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { title, type, tags, summary, why_it_matters, recommended_use, platform } = req.body;
    const drive = getDrive(req);

    // Get or create Phixo Research folder
    let folderId;
    const folderSearch = await drive.files.list({
      q: "name='Phixo Research' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id)'
    });
    if (folderSearch.data.files.length) {
      folderId = folderSearch.data.files[0].id;
    } else {
      const folder = await drive.files.create({
        requestBody: { name: 'Phixo Research', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      folderId = folder.data.id;
    }

    const stream = Readable.from(req.file.buffer);
    const uploaded = await drive.files.create({
      requestBody: { name: req.file.originalname, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: stream },
      fields: 'id, webViewLink'
    });

    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const result = await pool.query(
      `INSERT INTO research_items (title, type, tags, summary, why_it_matters, recommended_use, platform, drive_file_id, file_name, file_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [title || req.file.originalname, type || 'image', tagArray, summary, why_it_matters,
       recommended_use, platform, uploaded.data.id, req.file.originalname, req.file.mimetype]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// POSTS / CONTENT SCHEDULE
// ═══════════════════════════════════════════════════════════

app.get('/api/posts', requireAuth, async (req, res) => {
  try {
    const { status, platform } = req.query;
    let q = 'SELECT * FROM posts';
    const params = [];
    const conditions = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (platform) { params.push(platform); conditions.push(`platform = $${params.length}`); }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
    q += ` ORDER BY CASE status
      WHEN 'idea' THEN 1 WHEN 'draft' THEN 2 WHEN 'ready' THEN 3 WHEN 'posted' THEN 4 ELSE 5
    END, created_at DESC`;
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM posts WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const post = result.rows[0];
    // Attach linked research
    const research = await pool.query(
      `SELECT r.* FROM research_items r
       JOIN post_research pr ON pr.research_id = r.id
       WHERE pr.post_id = $1 ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    post.research_items = research.rows;
    res.json(post);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/posts', requireAuth, async (req, res) => {
  try {
    const { platform, hook, caption, shot_list, cta, status, post_date, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO posts (platform, hook, caption, shot_list, cta, status, post_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [platform, hook, caption, shot_list, cta, status || 'idea', post_date, notes]
    );
    result.rows[0].research_items = [];
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['platform','hook','caption','shot_list','cta','status','post_date','notes'];
    const updates = [];
    const values = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) { values.push(req.body[key]); updates.push(`${key} = $${values.length}`); }
    }
    if (!updates.length) return res.json({ ok: true });
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE posts SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attach / detach research from post
app.post('/api/posts/:id/research/:researchId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO post_research (post_id, research_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.params.id, req.params.researchId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/posts/:id/research/:researchId', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM post_research WHERE post_id = $1 AND research_id = $2',
      [req.params.id, req.params.researchId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════
// DRIVE FILE PROXY (serve Drive images through app auth)
// ═══════════════════════════════════════════════════════════

app.get('/api/drive/file/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType, name' });
    const file = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', meta.data.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    file.data.pipe(res);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Phixo Admin v2.1 on port ' + PORT);
  if (process.env.DATABASE_URL) {
    await initDb();
  } else {
    console.log('WARNING: No DATABASE_URL — database disabled');
  }
});
