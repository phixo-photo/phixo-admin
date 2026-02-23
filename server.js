const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const session = require('express-session');
const cookieSession = require('cookie-session');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'phixo-session',
  secret: process.env.SESSION_SECRET || 'phixo-secret-key',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

// Google OAuth setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'https://admin.phixo.ca/auth/callback'
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  res.redirect('/auth/login');
}

// Auth routes
app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    req.session.tokens = tokens;
    res.redirect('/');
  } catch (err) {
    res.redirect('/auth/login');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/auth/login');
});

// Get Drive instance
function getDrive(req) {
  oauth2Client.setCredentials(req.session.tokens);
  return google.drive({ version: 'v3', auth: oauth2Client });
}

// Find or create Clients root folder
async function getClientsFolder(drive) {
  const res = await drive.files.list({
    q: "name='Clients' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id, name)'
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name: 'Clients', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  return folder.data.id;
}

// Find or create client subfolder by email/phone ID
async function getClientFolder(drive, clientsRootId, clientName, clientId) {
  const folderName = `${clientName} [${clientId}]`;
  const res = await drive.files.list({
    q: `name contains '${clientId}' and mimeType='application/vnd.google-apps.folder' and '${clientsRootId}' in parents and trashed=false`,
    fields: 'files(id, name)'
  });
  if (res.data.files.length > 0) return { id: res.data.files[0].id, isNew: false, name: res.data.files[0].name };
  const folder = await drive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [clientsRootId] },
    fields: 'id'
  });
  return { id: folder.data.id, isNew: true, name: folderName };
}

// Find client doc in folder
async function getClientDoc(drive, folderId) {
  const res = await drive.files.list({
    q: `name contains 'Client File' and mimeType='application/vnd.google-apps.document' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id, name)'
  });
  return res.data.files.length > 0 ? res.data.files[0] : null;
}

// Analyze conversation with Claude
async function analyzeConversation(conversationText, existingContext = '') {
  const prompt = `You are analyzing a conversation between Ian Green (photographer at Phixo studio, Montreal) and a potential client or collaborator.

${existingContext ? `EXISTING CLIENT CONTEXT:\n${existingContext}\n\n` : ''}

CONVERSATION TO ANALYZE:
${conversationText}

Extract and analyze everything. Return a structured JSON object with these exact fields:

{
  "clientName": "full name if found",
  "clientEmail": "email if mentioned",
  "clientPhone": "phone if mentioned",
  "platform": "where this conversation happened",
  "sessionType": "type of session they want",
  "sessionDate": "if mentioned",
  "leadTemperature": "cold/warm/hot with one sentence explanation",
  "whatTheywant": "clear summary of what they need",
  "emotionalRead": "detailed read of their emotional state, confidence level, what they need to feel comfortable",
  "redFlags": "anything to watch out for or clarify before the session",
  "opportunity": "the bigger picture opportunity this client represents",
  "conversationLog": [{"who": "name", "message": "text"}],
  "sessionBriefing": {
    "howToOpen": "exactly how to greet and open with this person",
    "doNotAsk": "what NOT to say or ask",
    "keyQuestion": "the one question that will unlock everything",
    "thingsToTalkAbout": "natural conversation topics based on what they shared",
    "whatTheyNeed": "what this person needs emotionally from the session",
    "thingsToAvoid": "specific things to avoid based on their profile",
    "momentToWatchFor": "the turning point moment to watch for",
    "howToClose": "how to end the session so they leave feeling great"
  },
  "shootingPlan": {
    "lightingSetup": "specific lighting recommendation for this client and their goals",
    "posesSuggestions": "3-5 specific pose directions ranked by what will work for their personality",
    "conversationStarters": "3-4 conversation starters ranked by most likely to land for THIS person specifically",
    "technicalNotes": "camera settings, lens, background suggestions"
  },
  "draftReply": "a warm, casual draft reply in Ian's voice — direct, human, no corporate language, no emojis",
  "postSession": {
    "galleryDeliveryEmail": "personalized gallery delivery email in Ian's voice",
    "reviewRequest": "natural review request that doesn't feel like a template",
    "followUpNote": "a follow up note a few days after gallery delivery"
  },
  "isCollaborator": false,
  "collaboratorResearch": null
}

For collaborators (businesses, artists, potential partners — not booking clients), set isCollaborator to true and fill collaboratorResearch with:
{
  "whoTheyAre": "summary of who this person/business is",
  "whatTheyNeed": "what they're likely missing visually",
  "pitchAngle": "how Ian should approach them and why they need Phixo",
  "conversationStarters": "how to open a conversation naturally",
  "whatToResearch": "what Ian should look up before reaching out"
}

Be specific, human, and genuinely insightful. Ian is reading this right before a session or outreach — make it actually useful.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Analyze uploaded file/screenshot
async function analyzeFile(fileBuffer, mimeType, existingContext = '') {
  const base64 = fileBuffer.toString('base64');
  
  const messages = [{
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 }
      },
      {
        type: 'text',
        text: `This is a screenshot of a conversation or document related to Ian Green's photography studio Phixo in Montreal. 
        
${existingContext ? `EXISTING CLIENT CONTEXT:\n${existingContext}\n\n` : ''}

Extract all text from this image, identify who the client is, what they want, and analyze the conversation exactly as you would a text conversation. 

Return the same JSON structure as if this were a text conversation. Be thorough — extract every message, every name, every detail visible in the screenshot.`
      }
    ]
  }];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// Format analysis into Google Doc content
function formatDocContent(analysis, isAppend = false) {
  const timestamp = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  
  let content = isAppend ? `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nUPDATED: ${timestamp}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` : `PHIXO — CLIENT FILE\n${analysis.clientName || 'Unknown'}\nLast updated: ${timestamp}\n\n`;

  if (!isAppend) {
    content += `CLIENT INFO\n`;
    content += `Name: ${analysis.clientName || '—'}\n`;
    content += `Email: ${analysis.clientEmail || '—'}\n`;
    content += `Phone: ${analysis.clientPhone || '—'}\n`;
    content += `Platform: ${analysis.platform || '—'}\n`;
    content += `Session Type: ${analysis.sessionType || '—'}\n`;
    content += `Session Date: ${analysis.sessionDate || '—'}\n\n`;
  }

  content += `MESSAGE ANALYSIS\n`;
  content += `Lead Temperature: ${analysis.leadTemperature || '—'}\n`;
  content += `What They Want: ${analysis.whatTheyWant || '—'}\n`;
  content += `Emotional Read: ${analysis.emotionalRead || '—'}\n`;
  content += `Red Flags: ${analysis.redFlags || '—'}\n`;
  content += `Opportunity: ${analysis.opportunity || '—'}\n\n`;

  if (analysis.sessionBriefing) {
    const b = analysis.sessionBriefing;
    content += `SESSION BRIEFING\n`;
    content += `How to Open: ${b.howToOpen || '—'}\n`;
    content += `Don't Ask: ${b.doNotAsk || '—'}\n`;
    content += `Key Question: ${b.keyQuestion || '—'}\n`;
    content += `Things to Talk About: ${b.thingsToTalkAbout || '—'}\n`;
    content += `What They Need: ${b.whatTheyNeed || '—'}\n`;
    content += `Things to Avoid: ${b.thingsToAvoid || '—'}\n`;
    content += `Moment to Watch For: ${b.momentToWatchFor || '—'}\n`;
    content += `How to Close: ${b.howToClose || '—'}\n\n`;
  }

  if (analysis.shootingPlan) {
    const s = analysis.shootingPlan;
    content += `SHOOTING PLAN\n`;
    content += `Lighting: ${s.lightingSetup || '—'}\n`;
    content += `Poses: ${s.posesSuggestions || '—'}\n`;
    content += `Conversation Starters: ${s.conversationStarters || '—'}\n`;
    content += `Technical Notes: ${s.technicalNotes || '—'}\n\n`;
  }

  if (analysis.conversationLog && analysis.conversationLog.length > 0) {
    content += `CONVERSATION LOG\n`;
    analysis.conversationLog.forEach(msg => {
      content += `${msg.who}: ${msg.message}\n`;
    });
    content += '\n';
  }

  if (analysis.draftReply) {
    content += `DRAFT REPLY\n${analysis.draftReply}\n\n`;
  }

  if (analysis.postSession) {
    const p = analysis.postSession;
    content += `POST-SESSION\n`;
    content += `Gallery Delivery:\n${p.galleryDeliveryEmail || '—'}\n\n`;
    content += `Review Request:\n${p.reviewRequest || '—'}\n\n`;
    content += `Follow Up:\n${p.followUpNote || '—'}\n\n`;
  }

  if (analysis.isCollaborator && analysis.collaboratorResearch) {
    const c = analysis.collaboratorResearch;
    content += `COLLABORATOR RESEARCH\n`;
    content += `Who They Are: ${c.whoTheyAre || '—'}\n`;
    content += `What They Need: ${c.whatTheyNeed || '—'}\n`;
    content += `Pitch Angle: ${c.pitchAngle || '—'}\n`;
    content += `Conversation Starters: ${c.conversationStarters || '—'}\n`;
    content += `What to Research: ${c.whatToResearch || '—'}\n\n`;
  }

  return content;
}

// API: Process conversation (text)
app.post('/api/process', requireAuth, async (req, res) => {
  try {
    const { conversation } = req.body;
    if (!conversation) return res.status(400).json({ error: 'No conversation provided' });

    const drive = getDrive(req);
    const analysis = await analyzeConversation(conversation);
    
    const clientsRootId = await getClientsFolder(drive);
    const clientId = analysis.clientEmail || analysis.clientPhone || analysis.clientName || 'unknown';
    const clientName = analysis.clientName || 'Unknown Client';
    
    const { id: folderId, isNew, name: folderName } = await getClientFolder(drive, clientsRootId, clientName, clientId);
    
    const existingDoc = await getClientDoc(drive, folderId);
    const docContent = formatDocContent(analysis, !!existingDoc);

    if (existingDoc) {
      // Append to existing doc via Docs API
      const docs = google.docs({ version: 'v1', auth: oauth2Client });
      const doc = await docs.documents.get({ documentId: existingDoc.id });
      const endIndex = doc.data.body.content.reduce((max, el) => {
        return el.endIndex ? Math.max(max, el.endIndex) : max;
      }, 1);
      
      await docs.documents.batchUpdate({
        documentId: existingDoc.id,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: endIndex - 1 },
              text: docContent
            }
          }]
        }
      });
      
      res.json({ success: true, isNew: false, clientName, folderName, docId: existingDoc.id, analysis });
    } else {
      // Create new Google Doc
      const docs = google.docs({ version: 'v1', auth: oauth2Client });
      const newDoc = await docs.documents.create({
        requestBody: { title: `${clientName} — Client File` }
      });
      
      await docs.documents.batchUpdate({
        documentId: newDoc.data.documentId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: 1 },
              text: docContent
            }
          }]
        }
      });

      // Move doc to client folder
      await drive.files.update({
        fileId: newDoc.data.documentId,
        addParents: folderId,
        removeParents: 'root',
        fields: 'id, parents'
      });

      res.json({ success: true, isNew: true, clientName, folderName, docId: newDoc.data.documentId, analysis });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: Process screenshot/file upload
app.post('/api/process-file', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    
    const drive = getDrive(req);
    const analysis = await analyzeFile(req.file.buffer, req.file.mimetype);
    
    const clientsRootId = await getClientsFolder(drive);
    const clientId = analysis.clientEmail || analysis.clientPhone || analysis.clientName || 'unknown';
    const clientName = analysis.clientName || 'Unknown Client';
    
    const { id: folderId, isNew, name: folderName } = await getClientFolder(drive, clientsRootId, clientName, clientId);
    const existingDoc = await getClientDoc(drive, folderId);
    const docContent = formatDocContent(analysis, !!existingDoc);

    if (existingDoc) {
      const docs = google.docs({ version: 'v1', auth: oauth2Client });
      const doc = await docs.documents.get({ documentId: existingDoc.id });
      const endIndex = doc.data.body.content.reduce((max, el) => el.endIndex ? Math.max(max, el.endIndex) : max, 1);
      await docs.documents.batchUpdate({
        documentId: existingDoc.id,
        requestBody: { requests: [{ insertText: { location: { index: endIndex - 1 }, text: docContent } }] }
      });
      res.json({ success: true, isNew: false, clientName, folderName, docId: existingDoc.id, analysis });
    } else {
      const docs = google.docs({ version: 'v1', auth: oauth2Client });
      const newDoc = await docs.documents.create({ requestBody: { title: `${clientName} — Client File` } });
      await docs.documents.batchUpdate({
        documentId: newDoc.data.documentId,
        requestBody: { requests: [{ insertText: { location: { index: 1 }, text: docContent } }] }
      });
      await drive.files.update({ fileId: newDoc.data.documentId, addParents: folderId, removeParents: 'root', fields: 'id, parents' });
      res.json({ success: true, isNew: true, clientName, folderName, docId: newDoc.data.documentId, analysis });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// API: Get recent clients
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const clientsRootId = await getClientsFolder(drive);
    const result = await drive.files.list({
      q: `'${clientsRootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 20
    });
    res.json({ clients: result.data.files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get client doc with Claude-powered briefing
app.get('/api/client/:folderId', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);

    // Search for any doc or PDF in the folder
    const fileList = await drive.files.list({
      q: `'${req.params.folderId}' in parents and trashed=false and (mimeType='application/vnd.google-apps.document' or mimeType='application/pdf')`,
      fields: 'files(id, name, mimeType)',
      orderBy: 'modifiedTime desc'
    });

    if (!fileList.data.files.length) return res.json({ doc: null, briefing: null });

    let fullText = '';

    for (const file of fileList.data.files) {
      if (file.mimeType === 'application/vnd.google-apps.document') {
        const docs = google.docs({ version: 'v1', auth: oauth2Client });
        const docData = await docs.documents.get({ documentId: file.id });
        docData.data.body.content.forEach(el => {
          if (el.paragraph) {
            el.paragraph.elements.forEach(e => { if (e.textRun) fullText += e.textRun.content; });
          }
        });
        fullText += '\n\n';
      } else if (file.mimeType === 'application/pdf') {
        // Export PDF content as plain text
        try {
          const exported = await drive.files.export(
            { fileId: file.id, mimeType: 'text/plain' },
            { responseType: 'text' }
          );
          fullText += exported.data + '\n\n';
        } catch (e) {
          // PDF export failed, skip
        }
      }
    }

    if (!fullText.trim()) return res.json({ doc: null, briefing: null });

    // Use Claude to extract a structured briefing from all available content
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are reading a client file for Ian Green, a portrait photographer at Phixo studio in Montreal.

Extract the key session briefing information from this document and return ONLY a JSON object with these fields. If a field isn't found, use null.

{
  "clientName": "client full name",
  "sessionType": "type of session",
  "sessionDate": "date if mentioned",
  "emotionalRead": "how to read this person emotionally",
  "howToOpen": "how to greet and open the session",
  "keyQuestion": "the one question that unlocks everything",
  "thingsToTalkAbout": "natural conversation topics",
  "whatTheyNeed": "what this person needs emotionally",
  "thingsToAvoid": "what not to say or do",
  "momentToWatchFor": "the turning point to watch for",
  "howToClose": "how to end the session well",
  "lightingSetup": "lighting recommendation",
  "posesSuggestions": "pose directions",
  "conversationStarters": "conversation starters ranked for this person",
  "draftReply": "most recent draft reply if any",
  "leadTemperature": "cold/warm/hot"
}

DOCUMENT CONTENT:
${fullText.slice(0, 8000)}`
      }]
    });

    const text = response.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    let briefing = {};
    try { briefing = JSON.parse(clean); } catch (e) { briefing = {}; }

    res.json({
      doc: { id: fileList.data.files[0].id, name: fileList.data.files[0].name },
      briefing,
      rawContent: fullText.slice(0, 500)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Phixo Admin running on port ${PORT}`));
