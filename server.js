const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cookieSession = require('cookie-session');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'phixo-session',
  secret: process.env.SESSION_SECRET || 'phixo-secret-key',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax'
}));

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

app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents'
    ],
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
    console.error('Auth error:', err);
    res.redirect('/auth/login');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session = null;
  res.redirect('/auth/login');
});

function getDrive(req) {
  oauth2Client.setCredentials(req.session.tokens);
  return google.drive({ version: 'v3', auth: oauth2Client });
}

function getDocs() {
  return google.docs({ version: 'v1', auth: oauth2Client });
}

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

async function getClientFolder(drive, clientsRootId, clientName, clientId) {
  const folderName = clientName + ' [' + clientId + ']';
  const safeId = clientId.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: "name contains '" + safeId + "' and mimeType='application/vnd.google-apps.folder' and '" + clientsRootId + "' in parents and trashed=false",
    fields: 'files(id, name)'
  });
  if (res.data.files.length > 0) return { id: res.data.files[0].id, isNew: false, name: res.data.files[0].name };
  const folder = await drive.files.create({
    requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [clientsRootId] },
    fields: 'id'
  });
  return { id: folder.data.id, isNew: true, name: folderName };
}

async function getClientDoc(drive, folderId) {
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.document' and '" + folderId + "' in parents and trashed=false",
    fields: 'files(id, name)',
    orderBy: 'modifiedTime desc'
  });
  return res.data.files.length > 0 ? res.data.files[0] : null;
}

async function readDocText(docId) {
  const docs = getDocs();
  const docData = await docs.documents.get({ documentId: docId });
  let text = '';
  docData.data.body.content.forEach(el => {
    if (el.paragraph) {
      el.paragraph.elements.forEach(e => {
        if (e.textRun) text += e.textRun.content;
      });
    }
    if (el.table) {
      el.table.tableRows.forEach(row => {
        row.tableCells.forEach(cell => {
          cell.content.forEach(c => {
            if (c.paragraph) {
              c.paragraph.elements.forEach(e => {
                if (e.textRun) text += e.textRun.content + ' ';
              });
            }
          });
          text += '\n';
        });
      });
    }
  });
  return text;
}

async function extractBriefingFromDoc(fullText) {
  const promptText = [
    'You are reading a client file for Ian Green, a portrait photographer at Phixo studio in Montreal.',
    'This document may use table formatting. Extract the key briefing info.',
    'Return ONLY a valid JSON object with these exact fields (null if not found):',
    '',
    '{',
    '  "clientName": "look for Name field or subtitle line",',
    '  "sessionType": "e.g. Professional Headshots",',
    '  "sessionDate": "session date if mentioned",',
    '  "emotionalRead": "look for Emotional Read field",',
    '  "howToOpen": "look for How to open field",',
    '  "keyQuestion": "the key question to unlock the session",',
    '  "thingsToTalkAbout": "look for Things to talk about",',
    '  "whatTheyNeed": "look for What she/he probably needs",',
    '  "thingsToAvoid": "look for What to avoid",',
    '  "momentToWatchFor": "look for Moment to watch for",',
    '  "howToClose": "look for How to close",',
    '  "lightingSetup": "lighting notes if any",',
    '  "posesSuggestions": "pose suggestions if any",',
    '  "conversationStarters": "conversation starters if any",',
    '  "draftReply": "the draft reply text if present",',
    '  "leadTemperature": "warm/hot/cold",',
    '  "questionnaire": {',
    '    "imageUsage": "where images will live",',
    '    "impression": "impression words selected",',
    '    "cameraComfort": "comfort level 1-5",',
    '    "glasses": "yes or no",',
    '    "brandColors": "brand color requirements",',
    '    "additionalNotes": "anything else they shared"',
    '  }',
    '}',
    '',
    'DOCUMENT CONTENT:',
    fullText.slice(0, 8000)
  ].join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: 'You extract structured briefing data from photography client files. Return only valid JSON, no other text.',
    messages: [{ role: 'user', content: promptText }]
  });

  const raw = response.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

async function analyzeConversation(conversationText) {
  const promptLines = [
    'Analyze this conversation between Ian Green (photographer at Phixo studio, Montreal) and a potential client.',
    '',
    'CONVERSATION:',
    conversationText,
    '',
    'Return ONLY a valid JSON object:',
    '{',
    '  "clientName": "full name if found",',
    '  "clientEmail": "email if mentioned",',
    '  "clientPhone": "phone if mentioned",',
    '  "platform": "where this conversation happened",',
    '  "sessionType": "type of session they want",',
    '  "sessionDate": "if mentioned",',
    '  "leadTemperature": "cold/warm/hot — one sentence why",',
    '  "whatTheyWant": "clear summary",',
    '  "emotionalRead": "detailed read of their emotional state",',
    '  "redFlags": "anything to watch out for",',
    '  "opportunity": "bigger picture opportunity",',
    '  "conversationLog": [{"who": "name", "message": "text"}],',
    '  "sessionBriefing": {',
    '    "howToOpen": "exactly how to greet and open",',
    '    "doNotAsk": "what NOT to say",',
    '    "keyQuestion": "the one question that unlocks everything",',
    '    "thingsToTalkAbout": "natural conversation topics",',
    '    "whatTheyNeed": "what this person needs emotionally",',
    '    "thingsToAvoid": "specific things to avoid",',
    '    "momentToWatchFor": "the turning point moment",',
    '    "howToClose": "how to end the session well"',
    '  },',
    '  "shootingPlan": {',
    '    "lightingSetup": "specific lighting recommendation",',
    '    "posesSuggestions": "3-5 specific pose directions",',
    '    "conversationStarters": "3-4 conversation starters for THIS person",',
    '    "technicalNotes": "camera settings, lens, background"',
    '  },',
    '  "draftReply": "warm casual reply in Ian\'s voice — direct, human, no corporate language",',
    '  "postSession": {',
    '    "galleryDeliveryEmail": "personalized gallery delivery email",',
    '    "reviewRequest": "natural review request",',
    '    "followUpNote": "follow up a few days after gallery"',
    '  },',
    '  "isCollaborator": false,',
    '  "collaboratorResearch": null',
    '}'
  ];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: 'You analyze client conversations for Ian Green, a portrait photographer in Montreal. Be specific and genuinely insightful. Return only valid JSON.',
    messages: [{ role: 'user', content: promptLines.join('\n') }]
  });

  const raw = response.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

async function analyzeFile(fileBuffer, mimeType) {
  const base64 = fileBuffer.toString('base64');
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: 'You analyze client conversations for Ian Green, a portrait photographer in Montreal. Extract all text from the image then analyze. Return only valid JSON.',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Extract all text from this screenshot and analyze the conversation. Return a JSON object with: clientName, clientEmail, clientPhone, platform, sessionType, sessionDate, leadTemperature, whatTheyWant, emotionalRead, redFlags, opportunity, conversationLog (array of {who, message}), sessionBriefing (howToOpen, doNotAsk, keyQuestion, thingsToTalkAbout, whatTheyNeed, thingsToAvoid, momentToWatchFor, howToClose), shootingPlan (lightingSetup, posesSuggestions, conversationStarters, technicalNotes), draftReply, postSession (galleryDeliveryEmail, reviewRequest, followUpNote), isCollaborator (false), collaboratorResearch (null).' }
      ]
    }]
  });
  const raw = response.content[0].text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

function formatDocContent(analysis, isAppend) {
  const timestamp = new Date().toLocaleDateString('en-CA', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  let c = isAppend
    ? '\n\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nUPDATED: ' + timestamp + '\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\n'
    : 'PHIXO \u2014 CLIENT FILE\n' + (analysis.clientName || 'Unknown') + '\nLast updated: ' + timestamp + '\n\n';

  if (!isAppend) {
    c += 'CLIENT INFO\nName: ' + (analysis.clientName || '\u2014') + '\nEmail: ' + (analysis.clientEmail || '\u2014') + '\nPhone: ' + (analysis.clientPhone || '\u2014') + '\nPlatform: ' + (analysis.platform || '\u2014') + '\nSession Type: ' + (analysis.sessionType || '\u2014') + '\nSession Date: ' + (analysis.sessionDate || '\u2014') + '\n\n';
  }

  c += 'MESSAGE ANALYSIS\nLead Temperature: ' + (analysis.leadTemperature || '\u2014') + '\nWhat They Want: ' + (analysis.whatTheyWant || '\u2014') + '\nEmotional Read: ' + (analysis.emotionalRead || '\u2014') + '\nRed Flags: ' + (analysis.redFlags || '\u2014') + '\nOpportunity: ' + (analysis.opportunity || '\u2014') + '\n\n';

  if (analysis.sessionBriefing) {
    const b = analysis.sessionBriefing;
    c += 'SESSION BRIEFING\nHow to Open: ' + (b.howToOpen || '\u2014') + '\nDon\'t Ask: ' + (b.doNotAsk || '\u2014') + '\nKey Question: ' + (b.keyQuestion || '\u2014') + '\nThings to Talk About: ' + (b.thingsToTalkAbout || '\u2014') + '\nWhat They Need: ' + (b.whatTheyNeed || '\u2014') + '\nThings to Avoid: ' + (b.thingsToAvoid || '\u2014') + '\nMoment to Watch For: ' + (b.momentToWatchFor || '\u2014') + '\nHow to Close: ' + (b.howToClose || '\u2014') + '\n\n';
  }

  if (analysis.shootingPlan) {
    const s = analysis.shootingPlan;
    c += 'SHOOTING PLAN\nLighting: ' + (s.lightingSetup || '\u2014') + '\nPoses: ' + (s.posesSuggestions || '\u2014') + '\nConversation Starters: ' + (s.conversationStarters || '\u2014') + '\nTechnical Notes: ' + (s.technicalNotes || '\u2014') + '\n\n';
  }

  if (analysis.conversationLog && analysis.conversationLog.length) {
    c += 'CONVERSATION LOG\n';
    analysis.conversationLog.forEach(msg => { c += (msg.who || '?') + ': ' + (msg.message || '') + '\n'; });
    c += '\n';
  }

  if (analysis.draftReply) c += 'DRAFT REPLY\n' + analysis.draftReply + '\n\n';

  if (analysis.postSession) {
    const p = analysis.postSession;
    c += 'POST-SESSION\nGallery Delivery:\n' + (p.galleryDeliveryEmail || '\u2014') + '\n\nReview Request:\n' + (p.reviewRequest || '\u2014') + '\n\nFollow Up:\n' + (p.followUpNote || '\u2014') + '\n\n';
  }

  return c;
}

async function saveToGoogleDoc(drive, analysis, folderId, existingDoc) {
  const docs = getDocs();
  const docContent = formatDocContent(analysis, !!existingDoc);

  if (existingDoc) {
    const doc = await docs.documents.get({ documentId: existingDoc.id });
    const endIndex = doc.data.body.content.reduce((max, el) => el.endIndex ? Math.max(max, el.endIndex) : max, 1);
    await docs.documents.batchUpdate({
      documentId: existingDoc.id,
      requestBody: { requests: [{ insertText: { location: { index: endIndex - 1 }, text: docContent } }] }
    });
    return existingDoc.id;
  } else {
    const newDoc = await docs.documents.create({ requestBody: { title: (analysis.clientName || 'Unknown') + ' \u2014 Client File' } });
    await docs.documents.batchUpdate({
      documentId: newDoc.data.documentId,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: docContent } }] }
    });
    await drive.files.update({ fileId: newDoc.data.documentId, addParents: folderId, removeParents: 'root', fields: 'id, parents' });
    return newDoc.data.documentId;
  }
}

app.post('/api/process', requireAuth, async (req, res) => {
  try {
    const { conversation } = req.body;
    if (!conversation) return res.status(400).json({ error: 'No conversation provided' });
    const drive = getDrive(req);
    const analysis = await analyzeConversation(conversation);
    const clientsRootId = await getClientsFolder(drive);
    const clientId = analysis.clientEmail || analysis.clientPhone || analysis.clientName || 'unknown';
    const clientName = analysis.clientName || 'Unknown Client';
    const { id: folderId, name: folderName } = await getClientFolder(drive, clientsRootId, clientName, clientId);
    const existingDoc = await getClientDoc(drive, folderId);
    const docId = await saveToGoogleDoc(drive, analysis, folderId, existingDoc);
    res.json({ success: true, isNew: !existingDoc, clientName, folderName, docId, analysis });
  } catch (err) {
    console.error('Process error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/process-file', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const drive = getDrive(req);
    const analysis = await analyzeFile(req.file.buffer, req.file.mimetype);
    const clientsRootId = await getClientsFolder(drive);
    const clientId = analysis.clientEmail || analysis.clientPhone || analysis.clientName || 'unknown';
    const clientName = analysis.clientName || 'Unknown Client';
    const { id: folderId, name: folderName } = await getClientFolder(drive, clientsRootId, clientName, clientId);
    const existingDoc = await getClientDoc(drive, folderId);
    const docId = await saveToGoogleDoc(drive, analysis, folderId, existingDoc);
    res.json({ success: true, isNew: !existingDoc, clientName, folderName, docId, analysis });
  } catch (err) {
    console.error('Process file error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const clientsRootId = await getClientsFolder(drive);
    const result = await drive.files.list({
      q: "'" + clientsRootId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 20
    });
    res.json({ clients: result.data.files });
  } catch (err) {
    console.error('Clients error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/client/:folderId', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const fileList = await drive.files.list({
      q: "(mimeType='application/vnd.google-apps.document' or mimeType='application/pdf') and '" + req.params.folderId + "' in parents and trashed=false",
      fields: 'files(id, name, mimeType)',
      orderBy: 'modifiedTime desc'
    });

    if (!fileList.data.files.length) return res.json({ doc: null, briefing: null });

    let fullText = '';
    for (const file of fileList.data.files) {
      try {
        if (file.mimeType === 'application/vnd.google-apps.document') {
          fullText += await readDocText(file.id) + '\n\n';
        } else if (file.mimeType === 'application/pdf') {
          const exported = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' });
          fullText += exported.data + '\n\n';
        }
      } catch (fileErr) {
        console.error('Error reading file:', fileErr.message);
      }
    }

    if (!fullText.trim()) return res.json({ doc: null, briefing: null });

    const briefing = await extractBriefingFromDoc(fullText);
    res.json({ doc: { id: fileList.data.files[0].id, name: fileList.data.files[0].name }, briefing });
  } catch (err) {
    console.error('Client briefing error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Phixo Admin running on port ' + PORT));
