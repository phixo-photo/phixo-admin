const express = require('express');
const multer = require('multer');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cookieSession = require('cookie-session');
const path = require('path');
const { Pool } = require('pg');
const { Readable } = require('stream');
const fs = require('fs');
const { spawn } = require('child_process');

const apolloRegistry = require('./lib/apolloRegistry');

// Optional dependencies for document reading
let pdfParse, mammoth;
try {
  pdfParse = require('pdf-parse');
  mammoth = require('mammoth');
  console.log('Document parsing enabled (pdf-parse + mammoth)');
} catch (err) {
  console.log('Document parsing disabled (install pdf-parse + mammoth to enable)');
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Shared data paths (for RAG pipeline, uploads, ChromaDB, etc.)
// When deployed on Railway, mount a volume and set DATA_PATH to that mount point (e.g. /data).
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '..', 'phixo-intelligence', 'data');

// Algonquin ingest can handle much larger video/audio uploads than the regular single-book flow.
// We use diskStorage so we can safely downsample for Whisper without loading the full payload into memory.
const uploadAlgonquin = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const dir = path.join(DATA_PATH, 'algonquin_uploads');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      const safeOriginal = String(file.originalname || 'file').replace(/[^a-zA-Z0-9_.-]+/g, '_');
      cb(null, `${Date.now()}-${safeOriginal}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 50 }, // 1 GB hard cap per file, up to 50 files per batch
});
// Location of the Python RAG pipeline (phixo-intelligence repo or copied folder)
const INTELLIGENCE_DIR = process.env.INTELLIGENCE_DIR || path.join(__dirname, '..', 'phixo-intelligence');
// Simple JSONL log for ingestion jobs (PDF → chunks → ChromaDB)
const INGEST_LOG_PATH = path.join(DATA_PATH, 'ingest-log.jsonl');
const KB_DEFAULT_COLLECTION = 'phixo_kb';
const KB_QUESTION_MODEL = 'claude-haiku-4-5-20251001';
const PROSPECTS_FILE = process.env.PROSPECTS_FILE || path.join(DATA_PATH, 'prospects.json');
const PIPELINE_STATUS_ALLOWED = new Set(['raw', 'enriching', 'enriched', 'contacted', 'booked', 'skipped']);

function defaultPipelineOwner() {
  return {
    name: null,
    linkedin_url: null,
    linkedin_headline: null,
    oaciq_license: null,
    amf_license: null,
    facebook_url: null,
    email: null,
    phone: null,
    headshot_status: 'unknown',
  };
}

function defaultPipelineOutreach() {
  return {
    draft: null,
    sent_at: null,
    channel: null,
    notes: null,
  };
}

function normalizePipelineStatus(status, fallback = 'raw') {
  if (!status) return fallback;
  const normalized = String(status).trim().toLowerCase();
  if (PIPELINE_STATUS_ALLOWED.has(normalized)) return normalized;
  return fallback;
}

function ensurePipelineProspectsFile() {
  const dir = path.dirname(PROSPECTS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PROSPECTS_FILE)) {
    fs.writeFileSync(PROSPECTS_FILE, '[]\n', 'utf8');
  }
}

function readPipelineProspects() {
  try {
    ensurePipelineProspectsFile();
    const raw = fs.readFileSync(PROSPECTS_FILE, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((record) => normalizePipelineProspectRecord(record));
  } catch (err) {
    console.error('Failed reading prospects store:', err.message);
    return [];
  }
}

function writePipelineProspects(records) {
  ensurePipelineProspectsFile();
  const normalized = Array.isArray(records)
    ? records.map((record) => normalizePipelineProspectRecord(record))
    : [];
  const tmpPath = `${PROSPECTS_FILE}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, PROSPECTS_FILE);
}

function normalizePipelineProspectRecord(input) {
  const owner = (input && typeof input.owner === 'object' && input.owner) ? input.owner : {};
  const outreach = (input && typeof input.outreach === 'object' && input.outreach) ? input.outreach : {};
  const registeredDate = input?.registered_date ? String(input.registered_date).slice(0, 10) : null;
  const id = input?.id ?? input?.business_id ?? null;
  if (id === null || id === undefined || String(id).trim() === '') return null;
  return {
    id: String(id).trim(),
    business_type: input?.business_type ? String(input.business_type).trim() : null,
    address: input?.address ? String(input.address).trim() : null,
    city: input?.city ? String(input.city).trim() : null,
    postal_code: input?.postal_code ? String(input.postal_code).trim() : null,
    registered_date: registeredDate,
    employee_range: input?.employee_range ? String(input.employee_range).trim() : null,
    prospect_score: input?.prospect_score ? String(input.prospect_score).trim().toUpperCase() : 'LOW',
    status: normalizePipelineStatus(input?.status, 'raw'),
    enriched_at: input?.enriched_at || null,
    owner: {
      ...defaultPipelineOwner(),
      ...owner,
      headshot_status: owner?.headshot_status ? String(owner.headshot_status).toLowerCase() : (owner?.headshot_status ?? 'unknown'),
    },
    outreach: {
      ...defaultPipelineOutreach(),
      ...outreach,
    },
  };
}

function upsertPipelineProspects(records) {
  const incoming = Array.isArray(records) ? records : [];
  const existing = readPipelineProspects();
  const byId = new Map(existing.map((item) => [String(item.id), item]));
  let created = 0;
  let updated = 0;

  for (const rawRecord of incoming) {
    const normalized = normalizePipelineProspectRecord(rawRecord);
    if (!normalized) continue;
    const existingRecord = byId.get(normalized.id);
    if (!existingRecord) {
      byId.set(normalized.id, normalized);
      created++;
      continue;
    }
    byId.set(normalized.id, {
      ...existingRecord,
      business_type: normalized.business_type,
      address: normalized.address,
      city: normalized.city,
      postal_code: normalized.postal_code,
      registered_date: normalized.registered_date,
      employee_range: normalized.employee_range,
      prospect_score: normalized.prospect_score,
    });
    updated++;
  }

  const out = Array.from(byId.values()).sort((a, b) => {
    const ad = a.registered_date || '';
    const bd = b.registered_date || '';
    if (ad && bd && ad !== bd) return ad > bd ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
  writePipelineProspects(out);
  return { created, updated, total: out.length };
}

function extractSyncRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.prospects)) return payload.prospects;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

/** Apollo.io API (trial): REGISTRY_SYNC_USE_APOLLO=true + APOLLO_API_KEY */
function shouldUseApolloApi() {
  return (
    ['true', '1', 'yes', 'on'].includes(String(process.env.REGISTRY_SYNC_USE_APOLLO || '').toLowerCase().trim()) &&
    !!process.env.APOLLO_API_KEY
  );
}

/**
 * Optional JSON feed URL (GET). Not Apollo — use shouldUseApolloApi for Apollo.
 * REGISTRY_SYNC_REMOTE_ENABLED=true or legacy: URL set without explicit false.
 */
function shouldUseRegistryRemoteSource() {
  const remote = process.env.REGISTRY_SYNC_REMOTE_ENABLED;
  if (remote !== undefined && String(remote).trim() !== '') {
    return ['true', '1', 'yes', 'on'].includes(String(remote).toLowerCase().trim());
  }
  return !!process.env.REGISTRY_SYNC_SOURCE_URL;
}

async function pullRegistrySyncRecords({ since }) {
  const sourceUrl = process.env.REGISTRY_SYNC_SOURCE_URL;
  if (!sourceUrl) return [];
  const url = new URL(sourceUrl);
  if (since) url.searchParams.set('since', since);
  const headers = {};
  if (process.env.REGISTRY_SYNC_SOURCE_TOKEN) {
    headers.authorization = `Bearer ${process.env.REGISTRY_SYNC_SOURCE_TOKEN}`;
  }
  const response = await fetch(url.toString(), { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`Registry source request failed (${response.status})`);
  }
  const payload = await response.json();
  return extractSyncRecords(payload);
}

// ── Quebec Registre des entreprises (official JSON API, same as github.com/quebec/req) ──
const QUEBEC_REGISTRY_BASE = process.env.QUEBEC_REGISTRY_BASE || 'https://www.registreentreprises.gouv.qc.ca';
const QUEBEC_REGISTRY_SEARCH_PATH =
  '/RQAnonymeGR/GR/GR03/GR03A2_20A_PIU_RechEntMob_PC/ServiceCommunicationInterne.asmx/ObtenirListeEntreprises';
const QUEBEC_REGISTRY_DETAIL_PATH =
  '/RQAnonymeGR/GR/GR03/GR03A2_20A_PIU_RechEntMob_PC/ServiceCommunicationInterne.asmx/ObtenirEtatsRensEntreprise';
const QUEBEC_REGISTRY_REFERER =
  'https://www.registreentreprises.gouv.qc.ca/RQAnonymeGR/GR/GR03/GR03A2_20A_PIU_RechEntMob_PC/index.html';

const REGISTRY_DOMAIN_REQ = 1;
const REGISTRY_TYPE_MOTS = 2;
const REGISTRY_ETENDUE_TOUS = 4;

function parseQuebecRegistryDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const msMatch = s.match(/\/Date\((\d+)\)\//);
  if (msMatch) {
    const d = new Date(parseInt(msMatch[1], 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function formatDateYmd(d) {
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDefaultRegistrySinceDate(since) {
  if (since) {
    const d = new Date(String(since).slice(0, 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const days = Math.max(1, Math.min(365, parseInt(process.env.REGISTRY_SYNC_DEFAULT_DAYS || '90', 10) || 90));
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getRegistrySearchCities() {
  const raw = process.env.REGISTRY_SYNC_CITIES;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [
    'Pointe-Claire',
    'Kirkland',
    'Beaconsfield',
    'Baie-D\'Urfé',
    'Sainte-Anne-de-Bellevue',
    'Senneville',
    'Dollard-des-Ormeaux',
    'Dorval',
    'Pierrefonds',
    'Roxboro',
    'L\'Île-Bizard',
  ];
}

function postalMatchesWestIsland(postal) {
  if (!postal) return false;
  const compact = String(postal).replace(/\s/g, '').toUpperCase();
  const prefixes = (process.env.REGISTRY_POSTAL_PREFIXES || 'H9,H8')
    .split(',')
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
  return prefixes.some((pre) => compact.startsWith(pre));
}

function extractPostalFromAddress(text) {
  const m = String(text || '').match(/\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/i);
  return m ? `${m[1]}${m[2]}`.toUpperCase() : null;
}

function inferCityFromAddress(adresse, searchCity) {
  const a = String(adresse || '');
  if (searchCity && a.toLowerCase().includes(searchCity.toLowerCase())) return searchCity;
  const lower = a.toLowerCase();
  for (const c of getRegistrySearchCities()) {
    if (lower.includes(c.toLowerCase())) return c;
  }
  return null;
}

function mapNombreEmployesToRange(n) {
  const s = String(n || '').trim().toUpperCase();
  if (!s) return null;
  if (/^[A-Z]$/.test(s)) return s;
  return null;
}

function scoreFromBusinessType(text) {
  const t = String(text || '').toLowerCase();
  if (/(courtier|immobilier|realtor|real estate|avocat|notaire|comptable)/.test(t)) return 'HIGH';
  if (/(assurance|financier|conseiller|consultant)/.test(t)) return 'MEDIUM';
  return 'LOW';
}

async function quebecRegistryFetchJson(path, bodyObj) {
  const url = `${QUEBEC_REGISTRY_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'User-Agent':
        'Mozilla/5.0 (compatible; phixo-admin/1.0; +https://admin.phixo.ca) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: QUEBEC_REGISTRY_REFERER,
      Origin: QUEBEC_REGISTRY_BASE,
      'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.8',
    },
    body: JSON.stringify(bodyObj),
  });
  const ct = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Quebec registry HTTP ${res.status}: ${raw.slice(0, 200)}`);
  }
  if (!ct.includes('json') && raw.trim().startsWith('<!')) {
    throw new Error(
      'Quebec registry returned HTML instead of JSON (often a bot check / Cloudflare). Try again later, run sync from a different network, or use REGISTRY_SYNC_SOURCE_URL to push records.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Quebec registry response is not valid JSON: ${raw.slice(0, 160)}`);
  }
}

async function quebecRegistrySearchPage(texte, pageCourante) {
  const payload = await quebecRegistryFetchJson(QUEBEC_REGISTRY_SEARCH_PATH, {
    critere: {
      Domaine: REGISTRY_DOMAIN_REQ,
      Type: REGISTRY_TYPE_MOTS,
      Etendue: REGISTRY_ETENDUE_TOUS,
      Texte: texte,
      PageCourante: pageCourante,
      UtilisateurAccepteConditionsUtilisation: true,
    },
  });
  return payload.d || payload.D || {};
}

async function quebecRegistryGetDetail(neq) {
  const payload = await quebecRegistryFetchJson(QUEBEC_REGISTRY_DETAIL_PATH, {
    critere: {
      Id: String(neq),
      UtilisateurAccepteConditionsUtilisation: true,
    },
  });
  return payload.d || payload.D || null;
}

function mapQuebecDetailToProspectExtras(detail) {
  if (!detail || typeof detail !== 'object') return {};
  const out = {};
  try {
    const ig = detail.SectionInformationsGenerales || {};
    const imm = ig.SousSecImmatriculation || {};
    const act = ig.SousSecActiviteNbrEmploye || {};
    const emp = mapNombreEmployesToRange(act.NombreEmployes);
    const sectors = Array.isArray(act.ListeSecteursActivite) ? act.ListeSecteursActivite : [];
    const firstAct = sectors[0] || {};
    const businessType = firstAct.Titre || firstAct.Description || null;
    const dateImmat = parseQuebecRegistryDate(imm.DateImmatriculation);
    out.business_type = businessType;
    out.employee_range = emp;
    if (dateImmat) out.registered_date = formatDateYmd(dateImmat);
    const etab = detail.SectionEtablissement || {};
    const principal = etab.SousSecEtablissementPrincipal || {};
    const liste = Array.isArray(principal.ListeEtablissement) ? principal.ListeEtablissement : [];
    const est = liste[0];
    if (est && est.Adresse) {
      out.address = String(est.Adresse).trim();
      out.postal_code = extractPostalFromAddress(est.Adresse);
    }
  } catch (e) {
    console.warn('mapQuebecDetailToProspectExtras:', e.message);
  }
  return out;
}

function searchRowToProspect(row, searchCity, sinceDate) {
  const neq = String(row.NumeroDossier || '').trim();
  if (!neq) return null;
  const dateInit = parseQuebecRegistryDate(row.DateInitiale);
  if (sinceDate && dateInit && dateInit < sinceDate) return null;
  const adresse = String(row.AdressePrimaire || '').trim();
  const postal = extractPostalFromAddress(adresse);
  const city = inferCityFromAddress(adresse, searchCity);
  const inCityList = city && getRegistrySearchCities().some((c) => c.toLowerCase() === String(city).toLowerCase());
  const west = postalMatchesWestIsland(postal) || inCityList;
  if (!west) return null;
  const registered = dateInit ? formatDateYmd(dateInit) : (row.DateInitiale ? String(row.DateInitiale).slice(0, 10) : null);
  const name = String(row.Nom || '').trim();
  return {
    id: neq,
    business_type: name || null,
    address: adresse || null,
    city: city || null,
    postal_code: postal,
    registered_date: registered,
    employee_range: null,
    prospect_score: scoreFromBusinessType(name),
  };
}

async function fetchQuebecRegistryDirectSync({ since }) {
  const sinceDate = getDefaultRegistrySinceDate(since);
  const cities = getRegistrySearchCities();
  const maxPages = Math.max(1, Math.min(50, parseInt(process.env.REGISTRY_SYNC_MAX_PAGES || '8', 10) || 8));
  const fetchDetail = String(process.env.REGISTRY_SYNC_FETCH_DETAIL || '').toLowerCase() === 'true';
  const delayMs = Math.max(500, parseInt(process.env.REGISTRY_SYNC_DELAY_MS || '2200', 10) || 2200);

  const byNeq = new Map();

  for (const city of cities) {
    let page = 0;
    let nombrePages = 1;
    while (page < nombrePages && page < maxPages) {
      let data;
      try {
        data = await quebecRegistrySearchPage(city, page);
      } catch (err) {
        console.warn(`[registry sync] search "${city}" page ${page}:`, err.message);
        break;
      }
      nombrePages = typeof data.NombrePages === 'number' ? data.NombrePages : parseInt(data.NombrePages, 10) || 1;
      const liste = Array.isArray(data.ListeEntreprises) ? data.ListeEntreprises : [];
      for (const row of liste) {
        const prospect = searchRowToProspect(row, city, sinceDate);
        if (!prospect) continue;
        if (!byNeq.has(prospect.id)) {
          byNeq.set(prospect.id, prospect);
        }
      }
      page += 1;
      if (page < nombrePages && page < maxPages) {
        await pipelineSleep(delayMs);
      }
    }
    await pipelineSleep(delayMs);
  }

  const records = Array.from(byNeq.values());

  if (fetchDetail) {
    const out = [];
    for (const rec of records) {
      await pipelineSleep(delayMs);
      try {
        const detail = await quebecRegistryGetDetail(rec.id);
        const extras = mapQuebecDetailToProspectExtras(detail);
        out.push({
          ...rec,
          ...extras,
          business_type: extras.business_type || rec.business_type,
          prospect_score: scoreFromBusinessType(extras.business_type || rec.business_type),
        });
      } catch (err) {
        console.warn(`[registry sync] detail ${rec.id}:`, err.message);
        out.push(rec);
      }
    }
    return out;
  }

  return records;
}

function applyPipelineProspectPatch(current, patch) {
  const next = { ...current };
  const topLevelAllowed = [
    'business_type',
    'address',
    'city',
    'postal_code',
    'registered_date',
    'employee_range',
    'prospect_score',
    'status',
    'enriched_at',
  ];
  for (const key of topLevelAllowed) {
    if (patch[key] === undefined) continue;
    if (key === 'status') {
      next.status = normalizePipelineStatus(patch.status, current.status);
    } else if (key === 'prospect_score') {
      next.prospect_score = patch.prospect_score ? String(patch.prospect_score).trim().toUpperCase() : null;
    } else if (key === 'registered_date') {
      next.registered_date = patch.registered_date ? String(patch.registered_date).slice(0, 10) : null;
    } else {
      next[key] = patch[key];
    }
  }
  if (patch.owner && typeof patch.owner === 'object') {
    const ownerAllowed = ['name', 'linkedin_url', 'linkedin_headline', 'oaciq_license', 'amf_license', 'facebook_url', 'email', 'phone', 'headshot_status'];
    const ownerPatch = {};
    for (const key of ownerAllowed) {
      if (patch.owner[key] !== undefined) ownerPatch[key] = patch.owner[key];
    }
    next.owner = { ...defaultPipelineOwner(), ...current.owner, ...ownerPatch };
  }
  if (patch.outreach && typeof patch.outreach === 'object') {
    const outreachAllowed = ['draft', 'sent_at', 'channel', 'notes'];
    const outreachPatch = {};
    for (const key of outreachAllowed) {
      if (patch.outreach[key] !== undefined) outreachPatch[key] = patch.outreach[key];
    }
    next.outreach = { ...defaultPipelineOutreach(), ...current.outreach, ...outreachPatch };
  }
  return normalizePipelineProspectRecord(next);
}

const PIPELINE_ENRICH_QUEUE = [];
let PIPELINE_ENRICH_RUNNING = false;
const PIPELINE_ENRICH_IN_FLIGHT = new Set();

function pipelineSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOwnerNameFromLinkedinTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return null;
  const candidate = raw.split(' - ')[0].split(' | ')[0].trim();
  if (!candidate) return null;
  if (candidate.length < 3 || candidate.length > 80) return null;
  return candidate;
}

function runEmailRegex(text) {
  const m = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : null;
}

function runPhoneRegex(text) {
  const m = String(text || '').match(/(?:\+?1[\s.-]?)?(?:\(?[2-9]\d{2}\)?[\s.-]?)?[2-9]\d{2}[\s.-]?\d{4}/);
  return m ? m[0] : null;
}

async function serperSearch(query, num = 5) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error('SERPER_API_KEY is not set');
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num }),
  });
  if (!response.ok) {
    throw new Error(`Serper request failed (${response.status})`);
  }
  return response.json();
}

function computeHeadshotStatus(record, foundSignals) {
  const current = String(record?.owner?.headshot_status || '').toLowerCase();
  if (current === 'present' || current === 'none') return current;
  const headline = String(record?.owner?.linkedin_headline || '').toLowerCase();
  if (headline.includes('new broker') || headline.includes('launched')) return 'likely none';
  const reg = record?.registered_date ? new Date(record.registered_date) : null;
  if (reg && !Number.isNaN(reg.getTime())) {
    const ageMs = Date.now() - reg.getTime();
    const sixMonthsMs = 1000 * 60 * 60 * 24 * 30 * 6;
    if (ageMs <= sixMonthsMs && !foundSignals.photoFound) return 'none';
  }
  if (!foundSignals.anyData) return 'unknown';
  return 'unknown';
}

async function runPipelineEnrichment(id) {
  const rows = readPipelineProspects();
  const idx = rows.findIndex((item) => String(item.id) === String(id));
  if (idx === -1) return;
  let record = rows[idx];
  rows[idx] = applyPipelineProspectPatch(record, { status: 'enriching' });
  writePipelineProspects(rows);
  record = rows[idx];

  const foundSignals = { anyData: false, photoFound: false };
  const ownerName = record.owner?.name || null;
  const businessType = record.business_type || '';
  const city = record.city || 'Montreal';

  // Step 2 (first implementation): LinkedIn via Serper.
  try {
    const query = ownerName
      ? `"${ownerName}" site:linkedin.com/in Montreal`
      : `"${businessType}" "${city}" site:linkedin.com/in`;
    const data = await serperSearch(query, 3);
    const organic = Array.isArray(data?.organic) ? data.organic : [];
    const linkedinResult = organic.find((r) => String(r?.link || '').includes('linkedin.com/in'));
    if (linkedinResult) {
      const patch = { owner: {} };
      if (linkedinResult.link) patch.owner.linkedin_url = String(linkedinResult.link).trim();
      patch.owner.linkedin_headline = (linkedinResult.snippet || linkedinResult.title || null);
      if (!record.owner?.name) {
        const inferredName = parseOwnerNameFromLinkedinTitle(linkedinResult.title);
        if (inferredName) patch.owner.name = inferredName;
      }
      record = applyPipelineProspectPatch(record, patch);
      foundSignals.anyData = true;
    }
  } catch (err) {
    console.warn(`[pipeline enrich ${id}] step2-linkedin failed:`, err.message);
  }

  await pipelineSleep(2200);

  // Step 5 (early fallback): broad web search for Facebook/email/phone.
  try {
    const seedName = record.owner?.name || businessType;
    const queries = [
      `"${seedName}" "${city}" Facebook`,
      `"${seedName}" "${businessType}" Montreal`,
      `"${seedName}" site:facebook.com`,
    ];
    let mergedText = '';
    let facebookUrl = null;
    for (const q of queries) {
      const data = await serperSearch(q, 5);
      const organic = Array.isArray(data?.organic) ? data.organic : [];
      for (const item of organic) {
        const link = String(item?.link || '');
        const snippet = String(item?.snippet || '');
        const title = String(item?.title || '');
        mergedText += ` ${title} ${snippet}`;
        if (!facebookUrl && link.includes('facebook.com')) facebookUrl = link;
      }
      if (facebookUrl) break;
      await pipelineSleep(2200);
    }
    const email = runEmailRegex(mergedText);
    const phone = runPhoneRegex(mergedText);
    if (facebookUrl || email || phone) {
      record = applyPipelineProspectPatch(record, {
        owner: {
          facebook_url: facebookUrl || undefined,
          email: email || undefined,
          phone: phone || undefined,
        },
      });
      foundSignals.anyData = true;
    }
  } catch (err) {
    console.warn(`[pipeline enrich ${id}] step5-broad failed:`, err.message);
  }

  const outRows = readPipelineProspects();
  const outIdx = outRows.findIndex((item) => String(item.id) === String(id));
  if (outIdx === -1) return;
  const latest = outRows[outIdx];
  const merged = applyPipelineProspectPatch(latest, {
    owner: {
      ...record.owner,
      headshot_status: computeHeadshotStatus(record, foundSignals),
    },
    enriched_at: new Date().toISOString(),
    status: foundSignals.anyData ? 'enriched' : 'skipped',
  });
  outRows[outIdx] = merged;
  writePipelineProspects(outRows);
}

async function processPipelineEnrichmentQueue() {
  if (PIPELINE_ENRICH_RUNNING) return;
  PIPELINE_ENRICH_RUNNING = true;
  try {
    while (PIPELINE_ENRICH_QUEUE.length) {
      const id = PIPELINE_ENRICH_QUEUE.shift();
      try {
        await runPipelineEnrichment(id);
      } catch (err) {
        console.error(`[pipeline enrich ${id}] fatal:`, err.message);
        const rows = readPipelineProspects();
        const idx = rows.findIndex((item) => String(item.id) === String(id));
        if (idx !== -1) {
          rows[idx] = applyPipelineProspectPatch(rows[idx], { status: 'skipped' });
          writePipelineProspects(rows);
        }
      } finally {
        PIPELINE_ENRICH_IN_FLIGHT.delete(String(id));
      }
      await pipelineSleep(2300);
    }
  } finally {
    PIPELINE_ENRICH_RUNNING = false;
  }
}

function enqueuePipelineEnrichment(id) {
  const key = String(id);
  if (PIPELINE_ENRICH_IN_FLIGHT.has(key)) return false;
  PIPELINE_ENRICH_IN_FLIGHT.add(key);
  PIPELINE_ENRICH_QUEUE.push(key);
  processPipelineEnrichmentQueue().catch((err) => {
    console.error('Pipeline enrichment queue crashed:', err.message);
  });
  return true;
}

function appendIngestLog(entry) {
  try {
    fs.mkdirSync(path.dirname(INGEST_LOG_PATH), { recursive: true });
    const payload = {
      time: new Date().toISOString(),
      ...entry,
    };
    fs.appendFileSync(INGEST_LOG_PATH, JSON.stringify(payload) + '\n');
  } catch (err) {
    console.error('Failed to append ingest log:', err.message);
  }
}

function normalizeQuestionList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    const q = String(item ?? '').trim();
    if (!q) continue;
    out.push(q.slice(0, 400));
  }
  return Array.from(new Set(out)).slice(0, 50);
}

function readIngestLogEvents() {
  try {
    if (!fs.existsSync(INGEST_LOG_PATH)) return [];
    const raw = fs.readFileSync(INGEST_LOG_PATH, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

app.set('trust proxy', 1);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Public static serving for extracted knowledge-base images:
// /api/knowledge/images/<book_slug>/<filename>
app.use('/api/knowledge/images', express.static(path.join(DATA_PATH, 'images')));
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

      -- Photography knowledge books + suggested questions
      CREATE TABLE IF NOT EXISTS kb_books (
        id SERIAL PRIMARY KEY,
        source TEXT NOT NULL UNIQUE,
        author TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT 'general',
        suggested_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
        questions_generated_at TIMESTAMPTZ,
        questions_generation_status TEXT NOT NULL DEFAULT 'pending',
        questions_generation_error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    // Migrations for existing DBs
    await pool.query(`ALTER TABLE blocks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`);
    await pool.query(`ALTER TABLE blocks ADD COLUMN IF NOT EXISTS source_type VARCHAR(50)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocks_source_type ON blocks(source_type)`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS suggested_questions JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS questions_generated_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS questions_generation_status TEXT NOT NULL DEFAULT 'pending'`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS questions_generation_error TEXT`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS title TEXT`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS file_count INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE kb_books ADD COLUMN IF NOT EXISTS last_updated TIMESTAMPTZ`);
    // Backfill title for existing rows so chat/query uses a stable display name.
    await pool.query(`UPDATE kb_books SET title = source WHERE title IS NULL OR title = ''`);

    // Ensure Algonquin College persistent KB row exists (never deleted by normal delete).
    await pool.query(`
      INSERT INTO kb_books (source, title, author, topic, file_count, last_updated)
      VALUES ('algonquin-college', 'Algonquin College Photography Program', 'Algonquin College', 'algonquin-college', 0, NULL)
      ON CONFLICT (source)
      DO UPDATE SET
        title = EXCLUDED.title,
        author = EXCLUDED.author,
        topic = EXCLUDED.topic
    `);
    
    // v3.40: Drive sync and discovery enhancements
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS drive_folder_id TEXT`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS screenshots JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS mission TEXT`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS vision TEXT`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ideas TEXT`);
    await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS posing_notes TEXT`);
    
    await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS drive_folder_id TEXT`);
    await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS screenshots JSONB DEFAULT '[]'`);
    await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS mission TEXT`);
    await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS vision TEXT`);
    await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS ideas TEXT`);
    await pool.query(`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS posing_notes TEXT`);
    
    // v3.44: Post builder redesign
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_goal TEXT`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_type VARCHAR(50) DEFAULT 'photo'`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS content_structure JSONB DEFAULT '{}'`);
    
    // v3.46: Research Library - Video generation
    await pool.query(`ALTER TABLE blocks ADD COLUMN IF NOT EXISTS is_reference BOOLEAN DEFAULT false`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_blocks_reference ON blocks(is_reference) WHERE is_reference = true`);
    
    console.log('DB v3.46 ready (Research video generation)');
  } catch (err) {
    console.error('DB init error:', err.message);
  } finally { c.release(); }
}

// ═══════════════════════════════════════════════════
// VIRAL HOOKS - Load CSV on startup
// ═══════════════════════════════════════════════════
const VIRAL_HOOKS_DATA = [{"id": "EDU_0001", "category": "EDUCATIONAL", "template": "This represents your X before, during, and after X", "exampleUrl": "https://www.instagram.com/p/C-ta_pvhfvK/"}, {"id": "EDU_0002", "category": "EDUCATIONAL", "template": "Here\u2019s exactly how much (insert action/item) you need to (insert result)", "exampleUrl": "https://www.instagram.com/reel/C9vqgHxuz1E/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=="}, {"id": "EDU_0003", "category": "EDUCATIONAL", "template": "Can you tell us how to (insert result) in 60 seconds?", "exampleUrl": "https://www.instagram.com/p/C8dJXv1PjzF/"}, {"id": "EDU_0004", "category": "EDUCATIONAL", "template": "This is what (insert thing) looks like when you\u2019re (insert action). And this is what they look like when you\u2019re not (insert action).", "exampleUrl": "https://www.instagram.com/reel/C4tAzeYL8yA/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=="}, {"id": "EDU_0005", "category": "EDUCATIONAL", "template": "I\u2019m going to tell you how to get (Insert result), (insert mind blowing method).", "exampleUrl": "https://www.instagram.com/p/C7WV9_TI5dT/"}, {"id": "EDU_0006", "category": "EDUCATIONAL", "template": "It took me 10 years to learn this but I\u2019ll teach it to you in less than 1 minute.", "exampleUrl": "https://www.instagram.com/p/C-sSyDpoyMX/"}, {"id": "EDU_0007", "category": "EDUCATIONAL", "template": "When you get (insert item/result) here are the # things you got to do right away.", "exampleUrl": "https://www.instagram.com/p/C9bUq2CtvUv/"}, {"id": "EDU_0008", "category": "EDUCATIONAL", "template": "If you don\u2019t have (insert item/action), do (insert item/action).", "exampleUrl": "https://www.instagram.com/p/C8rJipAy8I8/"}, {"id": "EDU_0009", "category": "EDUCATIONAL", "template": "My money rules as a (insert description) working towards financial independence.", "exampleUrl": "https://www.instagram.com/p/C_-u411xe4m/"}, {"id": "EDU_0010", "category": "EDUCATIONAL", "template": "Money can buy you (insert item) but it can not buy you (insert result).", "exampleUrl": "https://www.instagram.com/p/DBkvHncxD2t/"}, {"id": "EDU_0011", "category": "EDUCATIONAL", "template": "Here's how to develop a (insert skill) so strong that you physically can't stop (doing skill).", "exampleUrl": "https://www.instagram.com/reel/C-CPzwMReyb/?igsh=MXBiYmdmc3dudm5vcg%3D%3D"}, {"id": "EDU_0012", "category": "EDUCATIONAL", "template": "This is what (insert #) of (insert item) looks like.", "exampleUrl": "https://www.instagram.com/alexgamblecoach/reel/C60q1FPPrLW/"}, {"id": "EDU_0013", "category": "EDUCATIONAL", "template": "If I woke up (insert pain point) tomorrow, and wanted to (insert dream result) by (insert time) here\u2019s exactly what I would do.", "exampleUrl": "https://www.instagram.com/p/DGOZZYhS1cj/"}, {"id": "EDU_0014", "category": "EDUCATIONAL", "template": "If you're a (insert target audience) and you want (insert", "exampleUrl": "https://www.instagram.com/reel/DE9tW4dyxlJ/?igs"}, {"id": "EDU_0015", "category": "EDUCATIONAL", "template": "If you are (insert age group or range) do not do (insert action).", "exampleUrl": "https://www.instagram.com/reel/DEsW49SM6z3/?igsh=MXc4eXFleDU0cDB4OA=="}, {"id": "EDU_0016", "category": "EDUCATIONAL", "template": "As an (insert trait) responsible (insert age) year old with a goal to (insert goal) here are 3 things I will never regret doing.", "exampleUrl": "https://www.instagram.com/reel/DBZT2Q5RJ2W/?igsh=MTBtc3gwNXVyM2ppdg%3D%3D"}, {"id": "EDU_0017", "category": "EDUCATIONAL", "template": "Not to flex, but I'm fretty f*cking good at (insert skill/niche).", "exampleUrl": "https://www.instagram.com/p/C-SR22KOEDY/"}, {"id": "EDU_0018", "category": "EDUCATIONAL", "template": "This is what (insert object/item) looks like when you are using/doing (insert product/service).", "exampleUrl": "https://www.instagram.com/sethwickstrom_fitness/reel/DAtNQtAxUNQ/"}, {"id": "EDU_0019", "category": "EDUCATIONAL", "template": "Are you still (insert action)? I\u2019ve got (insert result) in (insert time frame) and I have never (insert action).", "exampleUrl": "https://www.instagram.com/reel/C4YY12SxuRo/"}, {"id": "EDU_0020", "category": "EDUCATIONAL", "template": "3 Youtube channels that will teach you more than any (insert industry/niche) degree.", "exampleUrl": "https://www.instagram.com/p/DBfqo-0zxTb/"}, {"id": "EDU_0021", "category": "EDUCATIONAL", "template": "I think I just found the biggest (insert niche/industry) cheat code.", "exampleUrl": "https://www.instagram.com/p/DB6kCMQR0oX/"}, {"id": "EDU_0022", "category": "EDUCATIONAL", "template": "Here are 3 people who will make you a better (insert title).", "exampleUrl": "https://www.instagram.com/p/C9uwXS_uJJ6/"}, {"id": "EDU_0023", "category": "EDUCATIONAL", "template": "(insert trait) Guy vs (insert trait) Guy.", "exampleUrl": "https://www.instagram.com/share/_9R_a4MER"}, {"id": "EDU_0024", "category": "EDUCATIONAL", "template": "I see you doing nothing but (insert action) after (insert event) so follow this agenda to avoid that.", "exampleUrl": "https://www.instagram.com/share/BADjOvZhzs"}, {"id": "EDU_0025", "category": "EDUCATIONAL", "template": "Want to be the first (insert dream result) in your family?", "exampleUrl": "https://www.instagram.com/reel/DEVCeefOF08/?igsh=MThxZXZyMnFkZXNj"}, {"id": "EDU_0026", "category": "EDUCATIONAL", "template": "This is how many (insert item) you need to (insert result).", "exampleUrl": "https://www.instagram.com/reel/C83vXP6NqXU/"}, {"id": "EDU_0027", "category": "EDUCATIONAL", "template": "Everyone tells you to (insert action) but nobody actually tells you how to do it. Here is a # second step by step tutorial that you can save.", "exampleUrl": "https://www.instagram.com/reel/DC2pqKUpy7C/?igsh=ZzBjeG93cDh6aWoy"}, {"id": "EDU_0028", "category": "EDUCATIONAL", "template": "If you're (insert age range) these are the # things you need to do so you don't end up (insert pain point) by (insert age).", "exampleUrl": "https://www.instagram.com/reel/C9atuV6s3J0/?igsh=aDhtdm5wNXNzOTk5"}, {"id": "EDU_0029", "category": "EDUCATIONAL", "template": "If I were starting over in my (insert age range) with no (insert item) here are the top # things I would do to (insert dream result).", "exampleUrl": "https://www.tiktok.com/t/ZT2MLqDUQ/"}, {"id": "EDU_0030", "category": "EDUCATIONAL", "template": "Here are some slightly unethical (insert industry/niche) hacks that you should know if you're (insert target audience).", "exampleUrl": "https://www.instagram.com/reel/C-8RO71JxRv/?igsh=MTdrZzdrZWdnbTdzZA=="}, {"id": "EDU_0031", "category": "EDUCATIONAL", "template": "Here's exactly how you're gonna lock in if you want to (insert dream result).", "exampleUrl": "https://www.instagram.com/reel/DC5P-_EMzFm/?igsh=MTZyajlweWk5ZGI1cQ=="}, {"id": "EDU_0032", "category": "EDUCATIONAL", "template": "This is the same exact (insert thing) but the first is/got (insert result and the second is/got X", "exampleUrl": "https://www.instagram.com/p/DIBDSW9Maq7/"}, {"id": "EDU_0033", "category": "EDUCATIONAL", "template": "If you want to end up (insert pain point) then skip this video.", "exampleUrl": "https://www.instagram.com/p/DDfZ4qZPTN8/"}, {"id": "EDU_0034", "category": "EDUCATIONAL", "template": "We have never used (insert noun) in our home because we have found it to be generally (insert trait/traits).", "exampleUrl": "https://www.instagram.com/p/DGF_p8lORgI/"}, {"id": "EDU_0035", "category": "EDUCATIONAL", "template": "(insert action) for (insert period of time) and you will get (insert dream result).", "exampleUrl": "https://www.instagram.com/georgiaheins/reel/C8Z9DfdMgZ_/"}, {"id": "EDU_0036", "category": "EDUCATIONAL", "template": "If you\u2019re between the ages of (insert age) to (insert age) and you feel like (insert pain point).", "exampleUrl": "https://www.instagram.com/p/DH2KovNtk8l/"}, {"id": "EDU_0037", "category": "EDUCATIONAL", "template": "(insert before state) to (insert after state) in # simple steps in under # of seconds.", "exampleUrl": "https://www.instagram.com/p/DHD4frVya7Z/"}, {"id": "EDU_0038", "category": "EDUCATIONAL", "template": "If you're trying to (insert dream results) then here is the one (insert thing) you should do.", "exampleUrl": "https://www.instagram.com/p/DFCyBHfNnlZ/"}, {"id": "EDU_0039", "category": "EDUCATIONAL", "template": "How long do you think you have to (insert action) to (insert result).", "exampleUrl": "https://www.instagram.com/reel/C50_VCluWFe/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=="}, {"id": "EDU_0040", "category": "EDUCATIONAL", "template": "If you want to do this, first do this.", "exampleUrl": "https://www.instagram.com/p/C5AmorRpUqF/"}, {"id": "EDU_0041", "category": "EDUCATIONAL", "template": "If you\u2019re trying to (insert dream result) and you haven't got a clue what to (insert action) on a daily basis I am going to show you an example.", "exampleUrl": "https://www.instagram.com/p/C5yjeP-REZx/"}, {"id": "EDU_0042", "category": "EDUCATIONAL", "template": "This is how many (insert item) you need to (insert result).", "exampleUrl": "https://www.instagram.com/p/C-M1nkcNPAV/"}, {"id": "EDU_0043", "category": "EDUCATIONAL", "template": "I\u2019m gonna save you # of minutes off your next workout with # of simple tips.", "exampleUrl": "https://www.instagram.com/jeffnippard/reel/C9zuGtYJ8ck/"}, {"id": "EDU_0044", "category": "EDUCATIONAL", "template": "If I only had (insert time frame) in the (insert location/place) this is exactly what I would do to get (insert dream result).", "exampleUrl": "https://www.instagram.com/p/C-9slRRoYAA/"}, {"id": "EDU_0045", "category": "EDUCATIONAL", "template": "How long can you skip (insert action) before losing (insert result).", "exampleUrl": "https://www.instagram.com/sethwickstrom_fitness/reel/DB1WXxVx6B4/"}, {"id": "EDU_0046", "category": "EDUCATIONAL", "template": "If you want to (insert dream result) a week for the next (insert weeks) without (insert pain point) then listen up.", "exampleUrl": "https://www.instagram.com/reform.nutrition.training/reel/C6SEO0svXyy/"}, {"id": "EDU_0047", "category": "EDUCATIONAL", "template": "If you just turned (insert age) and you don\u2019t want to (insert pain point) then you should do the following # things immediately.", "exampleUrl": "https://www.instagram.com/share/BAKR4pqxlZ"}, {"id": "EDU_0048", "category": "EDUCATIONAL", "template": "You can have a perfect (insert dream result) by simply dumbing it down.", "exampleUrl": "https://www.instagram.com/share/BAOoa4qroW"}, {"id": "EDU_0049", "category": "EDUCATIONAL", "template": "Did you know that this, this, this, and this get (insert dream result).", "exampleUrl": "https://www.instagram.com/share/BAExbVPhak"}, {"id": "EDU_0050", "category": "EDUCATIONAL", "template": "Don\u2019t start doing (insert action) until you learn how to do this.", "exampleUrl": "https://www.instagram.com/share/BA7hIj8Es8"}, {"id": "EDU_0051", "category": "EDUCATIONAL", "template": "(insert industry) tier list for (insert year).", "exampleUrl": "https://www.instagram.com/p/DEirLE_s0QS/"}, {"id": "EDU_0052", "category": "EDUCATIONAL", "template": "In 60 seconds i\u2019m going to teach you more about (insert thing) than you have ever learned in your entire life.", "exampleUrl": "https://www.instagram.com/p/DEqFNhryVXt/"}, {"id": "EDU_0053", "category": "EDUCATIONAL", "template": "Everyone tells you to (insert action) but no one actually shows you how to do it. Here is a # second step by step tutorial that you can save for later.", "exampleUrl": "https://www.instagram.com/calltoleap/reel/C2tER1GvhOc/"}, {"id": "EDU_0054", "category": "EDUCATIONAL", "template": "If you\u2019re in your (insert 20\u2019s, 30\u2019s, 40\u2019s, 50\u2019s, 60\u2019, etc) then these are the # of things you need to do to make sure you don;t end up (insert pain point) by (insert age).", "exampleUrl": "https://www.instagram.com/calltoleap/reel/C9atuV6s3J0/"}, {"id": "EDU_0055", "category": "EDUCATIONAL", "template": "(Insert noun) loses (Insert noun) on this, so they can make (insert noun) on this.", "exampleUrl": "https://www.instagram.com/marktilbury/reel/DEkDrvSojnz/"}, {"id": "EDU_0056", "category": "EDUCATIONAL", "template": "You have (insert noun) tomorrow but you have no time to (insert action). Here\u2019s how you save your (insert noun).", "exampleUrl": "https://www.instagram.com/ultimateivyleagueguide/reel/CoNHORnOLUt/"}, {"id": "EDU_0057", "category": "EDUCATIONAL", "template": "(Insert scenario) and (Insert dream result), here are the # of steps to get (insert dream result).", "exampleUrl": "https://www.instagram.com/ultimateivyleagueguide/reel/Co5Kp8QLhRZ/"}, {"id": "EDU_0058", "category": "EDUCATIONAL", "template": "Everyone tells you to do (insert action) but you think it\u2019s too late because you are (Insert age). I am a (insert occupation) and these are # of things you need to know in your (Insert age).", "exampleUrl": "https://www.instagram.com/calltoleap/reel/C4wQD6DPqTe/"}, {"id": "EDU_0059", "category": "EDUCATIONAL", "template": "(Insert target audience) if you're serious about playing at the next level.", "exampleUrl": "https://www.instagram.com/kelseypoulter/reel/DDp"}, {"id": "EDU_0060", "category": "EDUCATIONAL", "template": "You only have to be dialed in on # of things to be an elite (insert title).", "exampleUrl": "https://www.instagram.com/kelseypoulter/reel/DAK0EOTRweE/"}, {"id": "EDU_0061", "category": "EDUCATIONAL", "template": "(Insert noun) for dummies.", "exampleUrl": "https://www.instagram.com/share/BA6XRL1fXU"}, {"id": "EDU_0062", "category": "EDUCATIONAL", "template": "Don\u2019t hate me but I don\u2019t really mind (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFydpeiy6GJ/"}, {"id": "EDU_0063", "category": "EDUCATIONAL", "template": "If you want to do this, first do this.", "exampleUrl": "https://www.instagram.com/p/C5nXYgsy6RR/andhttps://www.instagram.com/alexandramilne_/reel/C"}, {"id": "EDU_0064", "category": "EDUCATIONAL", "template": "Best ways to save money while (insert action).", "exampleUrl": "https://www.instagram.com/p/DCkE_cUo3mq/"}, {"id": "EDU_0065", "category": "EDUCATIONAL", "template": "This is every way to (insert action).", "exampleUrl": "https://www.instagram.com/p/DHtlJGYN5wB/"}, {"id": "EDU_0066", "category": "EDUCATIONAL", "template": "What if I told you this (insert item) could (insert result).", "exampleUrl": "https://www.instagram.com/p/DChgwnJyE3b/"}, {"id": "EDU_0067", "category": "EDUCATIONAL", "template": "Did you know that if you (insert action, (Insert action), (insert action), etc.", "exampleUrl": "https://www.instagram.com/p/C-Alb5KsBwA/"}, {"id": "EDU_0068", "category": "EDUCATIONAL", "template": "The (insert thing) you have now in you (insert age group) is so (insert noun).", "exampleUrl": "https://www.instagram.com/p/DBhHzSeJ_L6/"}, {"id": "EDU_0069", "category": "EDUCATIONAL", "template": "At age (insert age) the age that many (insert target audience) is when (insert pain point).", "exampleUrl": "https://www.instagram.com/p/DGkzdT8Mc21/"}, {"id": "EDU_0070", "category": "EDUCATIONAL", "template": "Listen if you\u2019re not forcing your (insert person/persons) to (insert action) in their (insert current state) don\u2019t expect them to be (insert trait) in their (insert after state).", "exampleUrl": "https://www.instagram.com/p/DHQ-medJYC2/"}, {"id": "EDU_0071", "category": "EDUCATIONAL", "template": "Would you rather watch your (insert person/persons) (insert pain point) or join them in their (insert niche) journey to save their lives?", "exampleUrl": "https://www.instagram.com/p/DGDkKWdPN7W/"}, {"id": "EDU_0072", "category": "EDUCATIONAL", "template": "This is the amount of (insert noun) you would lose per day in a (insert state).", "exampleUrl": "https://www.instagram.com/p/DGN4d45NAga/"}, {"id": "EDU_0073", "category": "EDUCATIONAL", "template": "If your in a (insert dream result) journey, this is exactly what you need to do to (insert dream goal) in # simple steps.", "exampleUrl": "https://www.instagram.com/p/DFGXCydPPOM/"}, {"id": "EDU_0074", "category": "EDUCATIONAL", "template": "If you told me # of years ago I\u2019d be (insert dream result) I wouldn't have believed you.", "exampleUrl": "https://www.instagram.com/p/DGs6ZD6NMaE/"}, {"id": "EDU_0075", "category": "EDUCATIONAL", "template": "If your getting (insert adjective) or know someone (insert adjective) there are # of incredulity important things you need to make sure you can do physically in order to (dream result).", "exampleUrl": "https://www.instagram.com/p/DEgJY7yOUYp/"}, {"id": "EDU_0076", "category": "EDUCATIONAL", "template": "If you don\u2019t want to fail (insert life event).", "exampleUrl": "https://www.instagram.com/p/C-TyArttuFT/"}, {"id": "EDU_0077", "category": "EDUCATIONAL", "template": "I crammed the hardest (insert noun) and (insert dream result).", "exampleUrl": "https://www.instagram.com/p/CzjQfxOLpKO/"}, {"id": "EDU_0078", "category": "EDUCATIONAL", "template": "If you\u2019re cooked for your (insert life event) but still can\u2019t find the motivation to do (insert action) you\u2019re gonna want to see this.", "exampleUrl": "https://www.instagram.com/p/DC3Zn1Vx7O9/"}, {"id": "EDU_0079", "category": "EDUCATIONAL", "template": "Here\u2019s the difference between (insert title), (insert title) , and (insert title).", "exampleUrl": "https://www.instagram.com/p/DFKZBcFRisK/"}, {"id": "EDU_0080", "category": "EDUCATIONAL", "template": "If I were in my (insert age range) here is exactly how I would avoid (insert bad result).", "exampleUrl": "https://www.instagram.com/p/DEICudmOqeQ/"}, {"id": "EDU_0081", "category": "EDUCATIONAL", "template": "Here\u2019s every (insert noun) that you actually need to know.", "exampleUrl": "https://www.instagram.com/p/DBhdAc3RY-X/"}, {"id": "EDU_0082", "category": "EDUCATIONAL", "template": "The most important things I will teach my kids as a (insert job title).", "exampleUrl": "https://www.instagram.com/p/DDce9wDuc8j/"}, {"id": "EDU_0083", "category": "EDUCATIONAL", "template": "If you can\u2019t solve this (insert problem) in under 5 seconds go back to (insert pre-qualifying stage).", "exampleUrl": "https://www.instagram.com/p/C0g-j3EJuM6/"}, {"id": "EDU_0084", "category": "EDUCATIONAL", "template": "30 seconds of (insert industry) advice I give my best friend if he/she were starting from scratch.", "exampleUrl": "https://www.instagram.com/p/DDyGbH-xMoc/"}, {"id": "EDU_0085", "category": "EDUCATIONAL", "template": "I would do this before quitting your job.", "exampleUrl": "https://www.instagram.com/p/C_D27RuxXHn/"}, {"id": "EDU_0086", "category": "EDUCATIONAL", "template": "If you do this you\u2019ll (insert result).", "exampleUrl": "https://www.instagram.com/p/DEP_swuolhm/"}, {"id": "EDU_0087", "category": "EDUCATIONAL", "template": "If your a (insert target audience) who (insert pain point) and you want to (insert dream result) let's go over a very simple # step plan you can follow to quickly (insert dream result).", "exampleUrl": "https://www.instagram.com/p/Cpf3cfujvTd/"}, {"id": "EDU_0088", "category": "EDUCATIONAL", "template": "Here are 5 books to (insert dream result) better than 99% of other people.", "exampleUrl": "https://www.instagram.com/p/DG3T4N9xdXD/"}, {"id": "EDU_0089", "category": "EDUCATIONAL", "template": "If you're somebody who (insert action) and your goal is to (insert dream result) and (insert dream result) at the same time. Then here are my # best tips.", "exampleUrl": "https://www.instagram.com/p/DGn7kKyu_5G/"}, {"id": "EDU_0090", "category": "EDUCATIONAL", "template": "If you can't do (insert action).", "exampleUrl": "https://www.instagram.com/p/DC7SzidSNOX/"}, {"id": "EDU_0091", "category": "EDUCATIONAL", "template": "If you can do # of (insert action), than you can do # of (insert action).", "exampleUrl": "https://www.instagram.com/p/DDKZbeoo1gF/"}, {"id": "EDU_0092", "category": "EDUCATIONAL", "template": "If your mom didn\u2019t teach you how to make (insert", "exampleUrl": "https://www.instagram.com/p/DBEeZ2MvZ16/"}, {"id": "EDU_0093", "category": "EDUCATIONAL", "template": "Never lose a game of (insert game) for the rest of your life.", "exampleUrl": "https://www.instagram.com/p/DCoC6YHJ_k1/"}, {"id": "EDU_0094", "category": "EDUCATIONAL", "template": "3 levels of (insert noun).", "exampleUrl": "https://www.instagram.com/p/DBt0hSaNxqH/"}, {"id": "EDU_0095", "category": "EDUCATIONAL", "template": "Did you know that if you\u2026 (Insert action), (insert action), (insert action), etc", "exampleUrl": "https://www.instagram.com/p/DIGJHsKPfj2/"}, {"id": "EDU_0096", "category": "EDUCATIONAL", "template": "I am a professional (insert industry) hacker, and here's every hack at (insert store/location/event/etc).", "exampleUrl": "https://www.instagram.com/p/DG3-nRhyvRq/"}, {"id": "EDU_0097", "category": "EDUCATIONAL", "template": "I have a very long list of (insert noun) that I (insert action) that I gate keep from other people. But today I feel like giving back so I am going to tell you.", "exampleUrl": "https://www.instagram.com/p/DCpBTqzpGdp/"}, {"id": "EDU_0098", "category": "EDUCATIONAL", "template": "I am going to teach you how to identify a good (insert noun) to a bad (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHWUyptyp9B/"}, {"id": "EDU_0099", "category": "EDUCATIONAL", "template": "I went to (insert school type) so you don't have to.", "exampleUrl": "https://www.instagram.com/p/DCrxn_5RFDS/"}, {"id": "EDU_0100", "category": "EDUCATIONAL", "template": "Ranking all the most popular (insert noun), so I can rank them from worst to best.", "exampleUrl": "https://www.instagram.com/p/DIPGBRQR0Sb/"}, {"id": "EDU_0101", "category": "EDUCATIONAL", "template": "Here is how I (insert action) as a (insert label) (insert age).", "exampleUrl": "https://www.instagram.com/p/C6Hkr_QRQ60/"}, {"id": "EDU_0102", "category": "EDUCATIONAL", "template": "You wouldn't get (insert bad result) when you (insert action) if you (insert action).", "exampleUrl": "https://www.instagram.com/p/DHlNHSfuHoh/"}, {"id": "EDU_0103", "category": "EDUCATIONAL", "template": "This is harder than getting into Harvard.", "exampleUrl": "https://www.instagram.com/p/DFNdSUruSOQ/"}, {"id": "EDU_0104", "category": "EDUCATIONAL", "template": "Now how much does it really cost to (insert action).", "exampleUrl": "https://www.instagram.com/p/DE75-Fhyg_T/"}, {"id": "EDU_0105", "category": "EDUCATIONAL", "template": "This is why no one remembers you.", "exampleUrl": "https://www.instagram.com/p/DFaQuJYueF1/"}, {"id": "EDU_0106", "category": "EDUCATIONAL", "template": "I'm 20 which means my teenage years are officially over, so here;s everything I learned from the 7 most weirdest years of my life.", "exampleUrl": "https://www.instagram.com/p/Cuq324pIiKY/"}, {"id": "EDU_0107", "category": "EDUCATIONAL", "template": "If you're a (target audience) and you want to become (insert dream result) by (insert action) then listen to this video because you have such a big advantage and I will tell you how to conquer it.", "exampleUrl": "https://www.instagram.com/p/DE9tW4dyxlJ/"}, {"id": "EDU_0108", "category": "EDUCATIONAL", "template": "If you take (insert noun) it will (insert result).", "exampleUrl": "https://www.instagram.com/p/DIMBlJ4MgHH/"}, {"id": "EDU_0109", "category": "EDUCATIONAL", "template": "I just made a website called (insert the longest but", "exampleUrl": "https://www.instagram.com/p/DIWeFGhRT9u/"}, {"id": "EDU_0110", "category": "EDUCATIONAL", "template": "How to turn just one (insert noun) into a lifetime of free (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIEbK1dSZJ2/"}, {"id": "EDU_0111", "category": "EDUCATIONAL", "template": "Things that are damaging your (insert noun) without you even realizing it.", "exampleUrl": "https://www.instagram.com/p/DDxIde3vWO7/"}, {"id": "EDU_0112", "category": "EDUCATIONAL", "template": "If you have when you see a girl and she just has (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DFNwwbpvxzi/"}, {"id": "EDU_0113", "category": "EDUCATIONAL", "template": "I've (insert dream result) despite having (insert pain point) and this is the routine that did it.", "exampleUrl": "https://www.instagram.com/p/DHbXdlkIoZh/"}, {"id": "EDU_0114", "category": "EDUCATIONAL", "template": "Swap these (insert noun) for better (insert result).", "exampleUrl": "https://www.instagram.com/p/DE5r6TspMQA/"}, {"id": "EDU_0115", "category": "EDUCATIONAL", "template": "Did you know that this, this, and this target (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DFk6dhNykvl/"}, {"id": "EDU_0116", "category": "EDUCATIONAL", "template": "Your (insert noun) looks like this and you want them to look like this.", "exampleUrl": "https://www.instagram.com/p/DD0PRBppkqQ/"}, {"id": "EDU_0117", "category": "EDUCATIONAL", "template": "(Insert last year) (insert noun), (insert current year) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DEDdSAESaFJ/"}, {"id": "EDU_0118", "category": "EDUCATIONAL", "template": "Okay (insert pain point), how about we don't f up (insert current year)", "exampleUrl": "https://www.instagram.com/p/DDiWd5eSlPC/"}, {"id": "EDU_0119", "category": "EDUCATIONAL", "template": "This is the program/steps I would follow if I was trying to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DB4om1CIUoZ/"}, {"id": "EDU_0120", "category": "EDUCATIONAL", "template": "If your (insert noun) looks anything like this, these are not (insert noun) these are (insert noun) and here is how you can get (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DDGYmIHxlhH/"}, {"id": "EDU_0121", "category": "EDUCATIONAL", "template": "Here are some (insert action) you can do without (insert noun).", "exampleUrl": "https://www.instagram.com/p/DB-HjvtP1A9/"}, {"id": "EDU_0122", "category": "EDUCATIONAL", "template": "Let's find out what (insert noun) you are in # steps.", "exampleUrl": "https://www.instagram.com/p/DHXLZyrSP0w/"}, {"id": "EDU_0123", "category": "EDUCATIONAL", "template": "Most people can only do (insert action) when trying to (insert action) but as an (insert title) you should be able to (insert action).", "exampleUrl": "https://www.instagram.com/p/C_3kQAkIuKn/"}, {"id": "EDU_0124", "category": "EDUCATIONAL", "template": "As an (insert title) you should be able to do this, if you can't (insert diagnosis).", "exampleUrl": "https://www.instagram.com/reel/DF_Cn86o0Ki/"}, {"id": "EDU_0125", "category": "EDUCATIONAL", "template": "If you're an (insert title) you should be able to do this, this, and this. If you can't I got you, just do this # step/routine/program to (insert dream result).", "exampleUrl": "https://www.instagram.com/reel/DDo0rP9o4Yl/"}, {"id": "EDU_0126", "category": "EDUCATIONAL", "template": "If you have (insert pain point), (insert pain point), and (insert pain point) you might be (insert action) wrong.", "exampleUrl": "https://www.instagram.com/p/DDCdiwNO6cO/"}, {"id": "EDU_0127", "category": "EDUCATIONAL", "template": "If you feel like your never (insert point) here is everything you need for a (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DCkDGtppM_u/"}, {"id": "EDU_0128", "category": "EDUCATIONAL", "template": "Do you have a (insert pain point) don\u2019t waste your money trying to (insert solution) it's just going to come back.", "exampleUrl": "https://www.instagram.com/p/DEu0CsYu3Qa/"}, {"id": "EDU_0129", "category": "EDUCATIONAL", "template": "If giving yourself (insert result) causes (insert pain point), (insert pain point), and (insert pain point) here is how I cheat it.", "exampleUrl": "https://www.instagram.com/p/DCh2GnEzezF/"}, {"id": "EDU_0130", "category": "EDUCATIONAL", "template": "You don't have (insert pain point), your not (insert adjective), your not (insert adjective) you just need to (insert solution) and I am going to tell you how to do it.", "exampleUrl": "https://www.instagram.com/p/DHSIRSHJuWc/"}, {"id": "EDU_0131", "category": "EDUCATIONAL", "template": "Worst thing you can do for your (insert thing) is to ignore your (insert noun) when (insert scenario).", "exampleUrl": "https://www.instagram.com/p/DFGZHpOpv9E/"}, {"id": "EDU_0132", "category": "EDUCATIONAL", "template": "Ladies, you can do all the (insert action) but that's not going to do sh*t for your (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFLUAphSOE0/"}, {"id": "EDU_0133", "category": "EDUCATIONAL", "template": "Never (insert action) first and then (insert action).", "exampleUrl": "https://www.instagram.com/p/DF58v36zILq/"}, {"id": "EDU_0134", "category": "EDUCATIONAL", "template": "What happens when you go X hours/days/weeks/years without (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHQcFEpuMHI/"}, {"id": "EDU_0135", "category": "EDUCATIONAL", "template": "There is no doubt in my mind that (insert action) are the best (insert noun) for your (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFnjpQ1x5mZ/"}, {"id": "EDU_0136", "category": "EDUCATIONAL", "template": "Don't touch this.", "exampleUrl": "https://www.instagram.com/p/DAMZdJhRaKj/"}, {"id": "EDU_0137", "category": "EDUCATIONAL", "template": "What I wish I knew at (insert age) instead of (insert age).", "exampleUrl": "https://www.instagram.com/p/C3-e4acrDdB/"}, {"id": "EDU_0138", "category": "EDUCATIONAL", "template": "You're damaging your (insert noun) if you (insert noun) looks like this or like this.", "exampleUrl": "https://www.instagram.com/p/C-AwpFRxDcg/"}, {"id": "EDU_0139", "category": "EDUCATIONAL", "template": "My most complemented (insert noun) of (insert year).", "exampleUrl": "https://www.instagram.com/p/DDhpuYgRmps/"}, {"id": "EDU_0140", "category": "EDUCATIONAL", "template": "I have been dating my girlfriend/boyfriend for # years here are # basics I learned that every guy/girl should do for a partner in (insert scenario).", "exampleUrl": "https://www.instagram.com/p/DEbs2tsxl8_/"}, {"id": "EDU_0141", "category": "EDUCATIONAL", "template": "When I say I (insert action) everyday and I don't (insert action) everyday people always ask me\u2026", "exampleUrl": "https://www.instagram.com/p/DGDy2KMJfQH/"}, {"id": "EDU_0142", "category": "EDUCATIONAL", "template": "# of ways to raise (insert adjective) children.", "exampleUrl": "https://www.instagram.com/p/DDP0DJDvdAL/"}, {"id": "EDU_0143", "category": "EDUCATIONAL", "template": "It's okay f you mom didn't talk to you about", "exampleUrl": "https://www.instagram.com/p/DCJwFyKvi03/"}, {"id": "EDU_0144", "category": "EDUCATIONAL", "template": "The reason you can't (insert dream result) to get that (insert dream result) you keep talking about is because\u2026", "exampleUrl": "https://www.instagram.com/p/DDKbMBDPz-R/"}, {"id": "EDU_0145", "category": "EDUCATIONAL", "template": "This is your (insert noun) on a regular day, this is you (insert noun) on (insert scenario).", "exampleUrl": "https://www.instagram.com/p/DFGFur-uB7M/"}, {"id": "EDU_0146", "category": "EDUCATIONAL", "template": "You guys know this look, when someone perfectly (insert action) and (insert action) I am obsessed with this (insert noun).", "exampleUrl": "https://www.instagram.com/p/DDpulHmx30Z/"}, {"id": "EDU_0147", "category": "EDUCATIONAL", "template": "You crave (insert noun) on your (insert scenario) here's why.", "exampleUrl": "https://www.instagram.com/p/DFYO1KMxUoy/"}, {"id": "EDU_0148", "category": "EDUCATIONAL", "template": "This is you (insert noun) when you (insert action), and this is your (insert noun) when you (insert action).", "exampleUrl": "https://www.instagram.com/p/DHI7KYmOgHL/"}, {"id": "EDU_0149", "category": "EDUCATIONAL", "template": "I have (insert noun) commercial (insert noun).", "exampleUrl": "https://www.instagram.com/p/DH6Nb_7JpIT/"}, {"id": "EDU_0150", "category": "EDUCATIONAL", "template": "Stop (insert action) if you actually want to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DGaYM9PIO9b/"}, {"id": "EDU_0151", "category": "EDUCATIONAL", "template": "This is how much (insert dream result) you achieve if you (insert action), and this is how much (insert dream result) if you (insert action) and these # of hacks.", "exampleUrl": "https://www.instagram.com/p/DE8lZdOOLDa/"}, {"id": "EDU_0152", "category": "EDUCATIONAL", "template": "If you want to (insert # of dream result) per week this is how you are going to do it.", "exampleUrl": "https://www.instagram.com/p/DBumWY_tbj-/"}, {"id": "EDU_0153", "category": "EDUCATIONAL", "template": "This is for the homies who promised (insert person/persons) and nice and fancy (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHZJfckxUnr/"}, {"id": "EDU_0154", "category": "EDUCATIONAL", "template": "What if I told you, you could (insert action) for only (insert low cost).", "exampleUrl": "https://www.instagram.com/p/DGjhMiPO7bd/"}, {"id": "EDU_0155", "category": "EDUCATIONAL", "template": "Why did it take me over # years to realize you can make (insert result) in # minutes.", "exampleUrl": "https://www.instagram.com/p/DHGjH0Gioy2/"}, {"id": "EDU_0156", "category": "EDUCATIONAL", "template": "Don't hate me but I don\u2019t really mind (insert basic niche thing) but don;t worry I am going to show you how to make it way better.", "exampleUrl": "https://www.instagram.com/p/DIKPqy-TeZ9/andhttps://www.instagram.com/p/DFydpeiy6GJ/"}, {"id": "EDU_0157", "category": "EDUCATIONAL", "template": "(insert dream result) and (insert dream result) with these # of tips. For reference I have (insert personal result).", "exampleUrl": "https://www.instagram.com/p/DA35oVOpAAe/"}, {"id": "EDU_0158", "category": "EDUCATIONAL", "template": "If you have a (insert dream result) keep scrolling. Today we are going to talk about a (insert routine, method", "exampleUrl": "https://www.instagram.com/p/DDmm7ygxvVp/"}, {"id": "EDU_0159", "category": "EDUCATIONAL", "template": "Did you know that if you (insert action), (insert action), (insert action), etc.", "exampleUrl": "https://www.instagram.com/p/DFvcBZRp0kh/"}, {"id": "EDU_0160", "category": "EDUCATIONAL", "template": "Here's exactly how much (insert noun) you can make with under (insert dollar amount).", "exampleUrl": "https://www.instagram.com/p/DG8MN0rAwpR/"}, {"id": "EDU_0161", "category": "EDUCATIONAL", "template": "The lack of clinical studies on (insert noun) isn't because it doesn't work, it's because\u2026", "exampleUrl": "https://www.instagram.com/p/DHjYM2oukHZ/"}, {"id": "EDU_0162", "category": "EDUCATIONAL", "template": "You'll never get (insert dream result) in your (insert age range) if you don;t do these 3 things when you turn (insert age).", "exampleUrl": "https://www.instagram.com/p/DHeJtx9IAFv/"}, {"id": "EDU_0163", "category": "EDUCATIONAL", "template": "# lessons, # of (insert person/persons), in # of days/weeks/months.", "exampleUrl": "https://www.instagram.com/p/DH64SMas1b1/"}, {"id": "EDU_0164", "category": "EDUCATIONAL", "template": "I make more money than doctors, engineers, and lawyers and no I didn't go to college for more than 6 years to get a degree.", "exampleUrl": "https://www.instagram.com/p/DIW3NDOORrg/"}, {"id": "EDU_0165", "category": "EDUCATIONAL", "template": "I worked at (insert company) for X months/years and now I am exposing everything they keep from customers.", "exampleUrl": "https://www.instagram.com/p/DINXKt8pBaq/"}, {"id": "EDU_0166", "category": "EDUCATIONAL", "template": "This is what (insert money amount) will get you in (insert location).", "exampleUrl": "https://www.instagram.com/p/DHQ7CG0xxmr/"}, {"id": "EDU_0167", "category": "EDUCATIONAL", "template": "How much do I need to make or buy a (insert price) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DCQFABDNVWG/"}, {"id": "EDU_0168", "category": "EDUCATIONAL", "template": "I make (insert hourly rate) can I qualify/buy (insert loan/noun).", "exampleUrl": "https://www.instagram.com/p/C8k9RkJtXv5/"}, {"id": "EDU_0169", "category": "EDUCATIONAL", "template": "Let's see what your monthly payment would look like if you owned (insert noun).", "exampleUrl": "https://www.instagram.com/p/C5w9HV9Axfe/"}, {"id": "EDU_0170", "category": "EDUCATIONAL", "template": "Lets see what $1,800 a month gets you in (insert location).", "exampleUrl": "https://www.instagram.com/p/DAUl55ypr-C/"}, {"id": "EDU_0171", "category": "EDUCATIONAL", "template": "If you are paying over (insert price amount) for a (insert noun), you might as well buy a (insert noun).", "exampleUrl": "https://www.instagram.com/p/C55wTztrNF0/"}, {"id": "EDU_0172", "category": "EDUCATIONAL", "template": "I have made a spreadsheet with over (insert large number) of (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIb7EjNxtK4/"}, {"id": "EDU_0173", "category": "EDUCATIONAL", "template": "This is (insert large number) of (insert noun).", "exampleUrl": "https://www.instagram.com/georgiaheins/reel/C9uzMCJMrEL/"}, {"id": "EDU_0174", "category": "EDUCATIONAL", "template": "There is one thing above all that sets the top (insert title) apart from the rest.", "exampleUrl": "https://www.instagram.com/p/DGESNTBT_3p/"}, {"id": "EDU_0175", "category": "EDUCATIONAL", "template": "This is how I would (insert action) if I were starting from scratch).", "exampleUrl": "https://www.instagram.com/share/BBMxvJRjNv"}, {"id": "EDU_0176", "category": "EDUCATIONAL", "template": "If you're spending a lot of money on (insert noun) then you need to try this (insert recipe/method/strategy) because it's super easy and (insert dream outcome).", "exampleUrl": "https://www.instagram.com/p/DGmf0uKMWyK/"}, {"id": "EDU_0177", "category": "EDUCATIONAL", "template": "If you have a (insert noun) you have probably experienced this.", "exampleUrl": "https://www.instagram.com/p/DIpVvJUSKam/"}, {"id": "EDU_0178", "category": "EDUCATIONAL", "template": "(insert noun) (insert trait) (insert similar noun) (insert trait).", "exampleUrl": "https://www.instagram.com/p/DE_9DHKoM-8/"}, {"id": "EDU_0179", "category": "EDUCATIONAL", "template": "It looks like you haven't done (insert noun) since (insert time frame).", "exampleUrl": "https://www.instagram.com/p/DETjcTPN0Zh/"}, {"id": "EDU_0180", "category": "EDUCATIONAL", "template": "I don\u2019t know who needs to see this but if you have a (insert symptom) this is how I literally (insert dream result) every single time.", "exampleUrl": "https://www.instagram.com/p/DFt1sIdSaJU/"}, {"id": "EDU_0181", "category": "EDUCATIONAL", "template": "Oh look I found (insert $), that means I am going to (insert verb) I only need this.", "exampleUrl": "https://www.instagram.com/p/DDD1Dk7OjTQ/"}, {"id": "EDU_0182", "category": "EDUCATIONAL", "template": "One (insert noun), one (insert noun), and you have (insert time frame).", "exampleUrl": "https://www.instagram.com/p/DIkf9ExCbNb/"}, {"id": "EDU_0183", "category": "EDUCATIONAL", "template": "The reason your (insert noun) sucks, is because you have no freaking (insert adjective).", "exampleUrl": "https://www.instagram.com/p/DIwiSA7zyyd/"}, {"id": "EDU_0184", "category": "EDUCATIONAL", "template": "You\u2019ve heard of the viral (insert method/strategy/noun name) right? Well I invested that!", "exampleUrl": "https://www.instagram.com/p/DI9QVVaRbur/"}, {"id": "EDU_0185", "category": "EDUCATIONAL", "template": "(insert noun) I would make for you based on your favorite (insert noun).", "exampleUrl": "https://www.instagram.com/p/DF-hWdEu9Pr/"}, {"id": "EDU_0186", "category": "EDUCATIONAL", "template": "Here are (insert #) of (insert noun) from (insert noun) that I am going to (insert verb) in (insert time frame).", "exampleUrl": "https://www.instagram.com/p/DGwvVNDMQBA/"}, {"id": "EDU_0187", "category": "EDUCATIONAL", "template": "How we saved (insert $) on our (insert noun), and one thing we wish we did differently.", "exampleUrl": "https://www.instagram.com/p/DD2B1rIRisK/"}, {"id": "EDU_0188", "category": "EDUCATIONAL", "template": "This is everything I bought at (insert store) today to stay (insert adjective) at (insert age).", "exampleUrl": "https://www.instagram.com/p/DDaqJN4P--I/"}, {"id": "EDU_0189", "category": "EDUCATIONAL", "template": "(insert verb) is expensive. Here is how to (insert noun) for (insert time frame) for only (insert $).", "exampleUrl": "https://www.instagram.com/p/DGsWskqTaQj/"}, {"id": "EDU_0190", "category": "EDUCATIONAL", "template": "How to (insert verb) you (insert noun) from a (insert title).", "exampleUrl": "https://www.instagram.com/p/C2zqnBULDa1/"}, {"id": "EDU_0191", "category": "EDUCATIONAL", "template": "How many (insert nouns) can you make with only (insert $).", "exampleUrl": "https://www.instagram.com/p/DFbJ-1QPOc0/"}, {"id": "EDU_0192", "category": "EDUCATIONAL", "template": "I present a challenge (insert noun) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGoS2GHSMy1/"}, {"id": "EDU_0193", "category": "EDUCATIONAL", "template": "This is every way to make (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIxgLtupDzP/"}, {"id": "EDU_0194", "category": "EDUCATIONAL", "template": "If I have to learn (insert noun) again here\u2019s 5 tips of everything I would do in # seconds.", "exampleUrl": "https://www.instagram.com/p/DEGMBBOo_XH/"}, {"id": "EDU_0195", "category": "EDUCATIONAL", "template": "(insert company/individual) if I (insert verb) (insert noun) for you this is what I would do.", "exampleUrl": "https://www.instagram.com/p/DIfQ_5cvLv-/"}, {"id": "EDU_0196", "category": "EDUCATIONAL", "template": "This is what it would (insert adjective) like if (insert number) of (insert noun) were in one (insert noun).", "exampleUrl": "https://www.instagram.com/p/DICZf5jBuNh/"}, {"id": "EDU_0197", "category": "EDUCATIONAL", "template": "This (insert adjective) (insert noun) gets (insert verb) by this (insert adjective) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHXK02AS5gs/"}, {"id": "EDU_0198", "category": "EDUCATIONAL", "template": "In this video see if you can tell what\u2019s real and what\u2019s (inset noun).", "exampleUrl": "https://www.instagram.com/p/DIeIvIfJVq1/"}, {"id": "EDU_0199", "category": "EDUCATIONAL", "template": "I have no idea why I have no (insert adjective/noun).", "exampleUrl": "https://www.instagram.com/p/DE7egL7M38Z/"}, {"id": "EDU_0200", "category": "EDUCATIONAL", "template": "I avoid all toxic (insert noun), here is how to clean up your (insert noun).", "exampleUrl": "https://www.instagram.com/p/C-AvGm9M0UA/"}, {"id": "EDU_0201", "category": "EDUCATIONAL", "template": "Here are # of questions I ask before (insert verb).", "exampleUrl": "https://www.instagram.com/p/DFnkbJcPxqc/"}, {"id": "EDU_0202", "category": "EDUCATIONAL", "template": "Since (insert noun) from (insert prace/location) are basically (insert fact), you might as well learn how to make them from home.", "exampleUrl": "https://www.instagram.com/p/DFGc51Ly8v3/"}, {"id": "EDU_0203", "category": "EDUCATIONAL", "template": "Every wonder how the same (insert noun) can result in drastically different (insert noun).", "exampleUrl": "https://www.instagram.com/p/DDXkZs6vFMb/"}, {"id": "EDU_0204", "category": "EDUCATIONAL", "template": "Here\u2019s what to look for when buying (insert noun) in (insert location).", "exampleUrl": "https://www.instagram.com/p/DGgSRpFuIjD/"}, {"id": "EDU_0205", "category": "EDUCATIONAL", "template": "If your (insert noun) look like this, and this pay attention.", "exampleUrl": "https://www.instagram.com/p/DIaTxoIJvRL/"}, {"id": "EDU_0206", "category": "EDUCATIONAL", "template": "Today I am going to show you have to make the perfect (insert noun) because I went to (insert school) so you don\u2019t have to.", "exampleUrl": "https://www.instagram.com/p/DFMzB5sO4TF/"}, {"id": "EDU_0207", "category": "EDUCATIONAL", "template": "It took me # full hours to (insert verb) this (insert noun) and I originally allotted myself # minutes.", "exampleUrl": "https://www.instagram.com/p/C_s9bBHxACz/"}, {"id": "EDU_0208", "category": "EDUCATIONAL", "template": "(Insert noun) (insert noun) (insert noun) where the 3 themes for this (insert noun). And you guys I delivered.", "exampleUrl": "https://www.instagram.com/p/DFQmtK9x_w_/"}, {"id": "EDU_0209", "category": "EDUCATIONAL", "template": "Take your (insert noun) from this to this.", "exampleUrl": "https://www.instagram.com/p/DHl84zXOnWK/"}, {"id": "EDU_0210", "category": "EDUCATIONAL", "template": "I have to ask, girl, how do you (insert adjective) so good?", "exampleUrl": "https://www.instagram.com/p/DEnNQCEv0S6/"}, {"id": "EDU_0211", "category": "EDUCATIONAL", "template": "I got to (insert verb) for (insert noun) (insert time), but let me just (insert verb) for a bit.", "exampleUrl": "https://www.instagram.com/p/DEgLL4XOMGi/"}, {"id": "EDU_0212", "category": "EDUCATIONAL", "template": "Give me 10 seconds and I will let you know what one suits you best.", "exampleUrl": "https://www.instagram.com/p/DGsHot9xC6R/"}, {"id": "EDU_0213", "category": "EDUCATIONAL", "template": "Give me 10 seconds and I will let you know if you have a (insert noun) or a (insert noun).", "exampleUrl": "https://www.instagram.com/p/DH-d8R2xUkT/"}, {"id": "EDU_0214", "category": "EDUCATIONAL", "template": "Anyone even notice how some people look naturally (insert adjective) without doing anything crazy.", "exampleUrl": "https://www.instagram.com/p/DDKn9iXPSOS/"}, {"id": "EDU_0215", "category": "EDUCATIONAL", "template": "If you\u2019ve ever secretly (insert action) and hope no one noticed this is for you.", "exampleUrl": "https://www.instagram.com/p/DIUEhBYOica/"}, {"id": "EDU_0216", "category": "EDUCATIONAL", "template": "Today we are going to play did you know (insert noun) edition.", "exampleUrl": "https://www.instagram.com/p/DDsm8Cny941/"}, {"id": "EDU_0217", "category": "EDUCATIONAL", "template": "If this is your first time being (insert adjective) I am (insert name) and I am trying to make it (insert adjective) to (insert verb) by using (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIFlyqrtHSg/"}, {"id": "EDU_0218", "category": "EDUCATIONAL", "template": "My (insert noun) never (insert pain point) no matter what I do.", "exampleUrl": "https://www.instagram.com/p/DBeJWwWOtMw/"}, {"id": "EDU_0219", "category": "EDUCATIONAL", "template": "(insert noun) level 1.", "exampleUrl": "https://www.instagram.com/p/DFvT9fMIoE6/"}, {"id": "EDU_0220", "category": "EDUCATIONAL", "template": "Here are # of ways to make (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGg2PpYpPsD/"}, {"id": "EDU_0221", "category": "EDUCATIONAL", "template": "Those little (insert nouns) are called (insert name) I am a (insert title) and I am going to show you how (insert result).", "exampleUrl": "https://www.instagram.com/p/DGrS_7YRUo7/"}, {"id": "EDU_0222", "category": "EDUCATIONAL", "template": "You want to know why it takes (insert noun) to get (insert result) again.", "exampleUrl": "https://www.instagram.com/p/DHLps0HiJ2L/"}, {"id": "EDU_0223", "category": "EDUCATIONAL", "template": "If your (insert noun) goes (insert result) when you (insert verb) while (insert noun) and (insert adjective) really (insert result) by now you know you have (insert noun) so why aren't you doing a (insert noun) routine.", "exampleUrl": "https://www.instagram.com/p/DHGaZL2uwW0/"}, {"id": "EDU_0224", "category": "EDUCATIONAL", "template": "If your (insert noun) is (insert adjective) like this, you are likely (insert diagnosis).", "exampleUrl": "https://www.instagram.com/p/DAbxF7ZSHq0/"}, {"id": "EDU_0225", "category": "EDUCATIONAL", "template": "Stop buying your (insert noun) like this, and start buying them like this.", "exampleUrl": "https://www.instagram.com/p/DE5ONXRsxs3/"}, {"id": "EDU_0226", "category": "EDUCATIONAL", "template": "Did you know this tip, it\u2019s going to blow your mind.", "exampleUrl": "https://www.instagram.com/p/DHRrPveSTcg/"}, {"id": "EDU_0227", "category": "EDUCATIONAL", "template": "If I (insert action) right now would you believe me if I told you (insert truth).", "exampleUrl": "https://www.instagram.com/p/DCcIsddvdu-/"}, {"id": "EDU_0228", "category": "EDUCATIONAL", "template": "This is what (insert noun) looks like. I am a pro (insert title) and this is the proper way to (insert action).", "exampleUrl": "https://www.instagram.com/p/DEnW3Mmvswc/"}, {"id": "EDU_0229", "category": "EDUCATIONAL", "template": "Does it actually matter what type of (insert noun) you use.", "exampleUrl": "https://www.instagram.com/p/DHMtL1GSsy-/"}, {"id": "EDU_0230", "category": "EDUCATIONAL", "template": "You would need to (insert verb) (insert number) (insert noun) today to get the same (insert result) you grandparents obtained from just (insert verb) (insert number).", "exampleUrl": "https://www.instagram.com/p/DC4dQVdPuUS/"}, {"id": "EDU_0231", "category": "EDUCATIONAL", "template": "Let\u2019s (insert verb) our (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHvgHMqRVWI/"}, {"id": "EDU_0232", "category": "EDUCATIONAL", "template": "This is what you would (insert verb) for (insert person) if you weren't terrified to talk to them.", "exampleUrl": "https://www.instagram.com/p/C8FTNDKualt/"}, {"id": "EDU_0233", "category": "EDUCATIONAL", "template": "When making (insert noun) the (insert noun) is just as important as the (insert noun).", "exampleUrl": "https://www.instagram.com/p/DDz9y_yyCkz/"}, {"id": "EDU_0234", "category": "EDUCATIONAL", "template": "Today I am going to show you the # most common ways to order your (insert noun) at a (insert place/location).", "exampleUrl": "https://www.instagram.com/p/DD9tTgdCq_N/"}, {"id": "EDU_0235", "category": "EDUCATIONAL", "template": "Guys this is so nerdy but it\u2019s the coolest thing I have ever done with my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFpcFScJxjW/"}, {"id": "EDU_0236", "category": "EDUCATIONAL", "template": "(insert noun), (insert noun), (insert noun), makes a (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGB30hXBY7K/"}, {"id": "EDU_0237", "category": "EDUCATIONAL", "template": "Here are # of (insert noun) from across the world, let\u2019s break them down to their core components.", "exampleUrl": "https://www.instagram.com/p/DG39EdnJxuK/"}, {"id": "EDU_0238", "category": "EDUCATIONAL", "template": "There are way too many (insert noun) in the world that sort of all look that same, but are they?", "exampleUrl": "https://www.instagram.com/p/DGojr4HBH4d/"}, {"id": "EDU_0239", "category": "EDUCATIONAL", "template": "(insert noun), (insert noun), (insert noun), are the basic components of a (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFJYlNVIzSa/"}, {"id": "EDU_0240", "category": "EDUCATIONAL", "template": "Here's a little (insert noun) 101 for you.", "exampleUrl": "https://www.instagram.com/p/DIloBsPuj-B/"}, {"id": "EDU_0241", "category": "EDUCATIONAL", "template": "These are the 3 most common mistakes I see when people are making (insert noun).", "exampleUrl": "https://www.instagram.com/p/DF9FMnIJpNJ/"}, {"id": "EDU_0242", "category": "EDUCATIONAL", "template": "A quick guide to (insert verb) (insert noun) some basic and some unusual.", "exampleUrl": "https://www.instagram.com/p/DCPkRMtodQd/"}, {"id": "EDU_0243", "category": "EDUCATIONAL", "template": "I see so many people using their (insert noun) just like this or maybe like this even when you (insert action). So let me show you the trick to perfectly (insert action).", "exampleUrl": "https://www.instagram.com/p/DETUL1KR3U_/"}, {"id": "EDU_0244", "category": "EDUCATIONAL", "template": "Here\u2019s how the form of (insert noun) you add into (insert noun) affects them.", "exampleUrl": "https://www.instagram.com/p/DD-sH_PPLJ4/"}, {"id": "EDU_0245", "category": "EDUCATIONAL", "template": "Why (insert action) like a normal person, when you can be a psycho instead.", "exampleUrl": "https://www.instagram.com/p/DGRrGUKPoZb/"}, {"id": "EDU_0246", "category": "EDUCATIONAL", "template": "This is everything I got for free on my (insert event).", "exampleUrl": "https://www.instagram.com/p/DGTqgBAxh3d/"}, {"id": "EDU_0247", "category": "EDUCATIONAL", "template": "(insert noun) is my second (insert noun) so here are # of (insert noun) that I used to do a lot and I recommend my students as well.", "exampleUrl": "https://www.instagram.com/p/DFfX1XQTzfP/"}, {"id": "EDU_0248", "category": "EDUCATIONAL", "template": "If you gave me (insert time frame) to get a job as a (insert title) this is what I would do.", "exampleUrl": "https://www.instagram.com/p/DHAewSpJVWu/"}, {"id": "EDU_0249", "category": "EDUCATIONAL", "template": "Did you know if you have a (insert noun), (insert noun), (insert noun), (insert noun), (insert noun) then you can (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DGiv5Q0M1-Q/"}, {"id": "EDU_0250", "category": "EDUCATIONAL", "template": "If you're the person who told me this I could kiss you right now because it literally saved my life.", "exampleUrl": "https://www.instagram.com/p/DIhOAUAPRMo/"}, {"id": "EDU_0251", "category": "EDUCATIONAL", "template": "I bought all the (insert noun) so you could find out which are the best in each category and which is not worth your money.", "exampleUrl": "https://www.instagram.com/p/DFtu2nnyrTW/"}, {"id": "EDU_0252", "category": "EDUCATIONAL", "template": "Here\u2019s how I get people the best (insert noun) on (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIhq7P8PguS/"}, {"id": "EDU_0253", "category": "EDUCATIONAL", "template": "Did you know that there are # types of (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIANQRkyYLb/"}, {"id": "EDU_0254", "category": "EDUCATIONAL", "template": "Here\u2019s how you can guess an almost perfect number every single time.", "exampleUrl": "https://www.instagram.com/p/DEDbAV7tpX5/"}, {"id": "EDU_0255", "category": "EDUCATIONAL", "template": "Here is how I make (insert noun) that lasts up to (insert time frame) and only costs (insert $).", "exampleUrl": "https://www.instagram.com/p/DG_4uqYOrJ_/"}, {"id": "EDU_0256", "category": "EDUCATIONAL", "template": "I teach (insert noun) to people like they are in kindergarten, and it's time for class.", "exampleUrl": "https://www.instagram.com/p/C-k_-Yev6DU/"}, {"id": "EDU_0257", "category": "EDUCATIONAL", "template": "(insert noun) can be reversed so let\u2019s talk about # things you can do to improve your (insert noun).", "exampleUrl": "https://www.instagram.com/p/DG9UDAUShLs/"}, {"id": "EDU_0258", "category": "EDUCATIONAL", "template": "This is how much (insert noun) you would lose at the end of the day with a (insert metric) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFFuLlcK9j4/"}, {"id": "EDU_0259", "category": "EDUCATIONAL", "template": "Did you know your (insert noun) are programmed to make your (insert result).", "exampleUrl": "https://www.instagram.com/p/DGcvCDdvEZ2/"}, {"id": "EDU_0260", "category": "EDUCATIONAL", "template": "This might be the ultimate (insert person) hack.", "exampleUrl": "https://www.instagram.com/p/DGYjc0dxhU-/"}, {"id": "EDU_0261", "category": "EDUCATIONAL", "template": "To (insert verb) the (insert metric) in this (insert noun) the average would have to (insert action) for (insert time frame).", "exampleUrl": "https://www.instagram.com/p/DFTappzSSBa/"}, {"id": "EDU_0262", "category": "EDUCATIONAL", "template": "If you (insert verb) this (insert noun) this is the amount of (insert noun) your body would (insert result).", "exampleUrl": "https://www.instagram.com/p/DFGDnHYg6hf/"}, {"id": "EDU_0263", "category": "EDUCATIONAL", "template": "The worst (insert noun) that you will regret buying for your (insert noun) is right here.", "exampleUrl": "https://www.instagram.com/p/DGPLBgRtX_g/"}, {"id": "EDU_0264", "category": "EDUCATIONAL", "template": "(insert noun) how to (insert action) and still (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DIwSdSiIr2d/"}, {"id": "EDU_0265", "category": "EDUCATIONAL", "template": "Use this, to pay for this.", "exampleUrl": "https://www.instagram.com/p/ChGIhcPPogC/"}, {"id": "EDU_0266", "category": "EDUCATIONAL", "template": "I paid (insert $) to build this (insert noun) from scratch).", "exampleUrl": "https://www.instagram.com/p/DFqGUjORxG4/"}, {"id": "EDU_0267", "category": "EDUCATIONAL", "template": "If I told you, you would (insert result) form (insert action) you would probably believe me right? Well here\u2019s the thing\u2026", "exampleUrl": "https://www.instagram.com/p/DDfdDshTsXK/"}, {"id": "EDU_0268", "category": "EDUCATIONAL", "template": "How to budget with a (insert $) salary using this special (insert name) technique.", "exampleUrl": "https://www.instagram.com/p/DDU0jMMN-gr/"}, {"id": "EDU_0269", "category": "EDUCATIONAL", "template": "I spent (insert $) on new (insert noun) for my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGN72MwpsAB/"}, {"id": "EDU_0270", "category": "EDUCATIONAL", "template": "Here\u2019s a quick what to (insert result) (insert metric) of you (insert noun) legally.", "exampleUrl": "https://www.instagram.com/p/DDmhkgqO1FN/"}, {"id": "EDU_0271", "category": "EDUCATIONAL", "template": "(insert adjective) won\u2019t get this but hopefully you will.", "exampleUrl": "https://www.instagram.com/p/DGOENqwSVC6/"}, {"id": "EDU_0272", "category": "EDUCATIONAL", "template": "This is the exact order in which you should be (insert verb) for all of your (insert noun).", "exampleUrl": "https://www.instagram.com/p/DB4lAAPPbYZ/"}, {"id": "EDU_0273", "category": "EDUCATIONAL", "template": "Why is it we are all so stressed about (insert noun) but we also all have a (insert noun) in (insert location).", "exampleUrl": "https://www.instagram.com/p/DFtSk25uUH_/"}, {"id": "EDU_0274", "category": "EDUCATIONAL", "template": "Today my kids (insert noun) is due. So let\u2019s (insert action).", "exampleUrl": "https://www.instagram.com/p/DEEFWvqttJd/"}, {"id": "EDU_0275", "category": "EDUCATIONAL", "template": "There are # things I like to do when I buy a new (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGMg-VPtL98/"}, {"id": "EDU_0276", "category": "EDUCATIONAL", "template": "Here are # of things you have been putting off around", "exampleUrl": "https://www.instagram.com/p/DEd9agVJsuO/"}, {"id": "EDU_0277", "category": "EDUCATIONAL", "template": "Show me the method of the best way to (insert result).", "exampleUrl": "https://www.instagram.com/p/DHxc_kEuDBo/"}, {"id": "EDU_0278", "category": "EDUCATIONAL", "template": "# things everyone needs to know how to fix in an (insert location).", "exampleUrl": "https://www.instagram.com/p/DFbZEG2yJ1k/"}, {"id": "EDU_0279", "category": "EDUCATIONAL", "template": "Why does nobody talk about the cost of (insert action).", "exampleUrl": "https://www.instagram.com/p/DIbM_TgS5se/"}, {"id": "EDU_0280", "category": "EDUCATIONAL", "template": "Top # ways not to (insert action) to the (insert person) you (insert noun).", "exampleUrl": "https://www.instagram.com/p/DDqCq5hpH56/"}, {"id": "EDU_0281", "category": "EDUCATIONAL", "template": "Top # deadliest (insert noun) that can kill (insert living thing) in one (insert verb).", "exampleUrl": "https://www.instagram.com/reel/CyB9bKLOoyp/?igsh=YWJ2cm11Znl4cGZs"}, {"id": "EDU_0282", "category": "EDUCATIONAL", "template": "So this is (insert weight) of (insert noun) if I (insert verb) that to a (insert noun) what is that equivalent to for humans.", "exampleUrl": "https://www.instagram.com/reel/DFhtYRTynQA/?igsh=dHlkZ29zdXNmODM1"}, {"id": "EDU_0283", "category": "EDUCATIONAL", "template": "What is this? This is your (insert description of visual) and this is this #1 reason that (insert noun) die.", "exampleUrl": "https://www.instagram.com/p/DDm0s8rsNV0/"}, {"id": "EDU_0284", "category": "EDUCATIONAL", "template": "The easiest way to keep you (insert noun) (insert adjective) is to pretend\u2026", "exampleUrl": "https://www.instagram.com/p/DDP6BaYxh8v/"}, {"id": "EDU_0285", "category": "EDUCATIONAL", "template": "If you're wanting to transfer your (insert noun) from this into (insert noun).", "exampleUrl": "https://www.instagram.com/p/DEAzDZxS0EH/"}, {"id": "EDU_0286", "category": "EDUCATIONAL", "template": "Let\u2019s see how many (insert noun) we can get out of this.", "exampleUrl": "https://www.instagram.com/p/DGZSeEvvepa/"}, {"id": "EDU_0287", "category": "EDUCATIONAL", "template": "This was the most popular (insert noun) in all of (insert year).", "exampleUrl": "https://www.instagram.com/p/DFT4wGoPISG/"}, {"id": "EDU_0288", "category": "EDUCATIONAL", "template": "Did you know that you could (insert verb) a year's worth of (insert noun) in (insert time frame).", "exampleUrl": "https://www.instagram.com/p/DDQwKwgx4iX/"}, {"id": "EDU_0289", "category": "EDUCATIONAL", "template": "That is crazy.", "exampleUrl": "https://www.instagram.com/reel/DEluu94R-dc/?igsh=ZHF4MXBod2pnODMx"}, {"id": "EDU_0290", "category": "EDUCATIONAL", "template": "Give me 60 seconds to show you how to (insert action) for the first time after (insert life event).", "exampleUrl": "https://www.instagram.com/reel/DC8EmdBPqWT/?igsh=MTAyNTFobmFzenY1eg=="}, {"id": "EDU_0291", "category": "EDUCATIONAL", "template": "Want a (insert noun) that (insert dream result) even when you (insert action).", "exampleUrl": "https://www.instagram.com/reel/DGMiUGoPLmU/?igsh=ZDR4czk2ZzNnMHYy"}, {"id": "EDU_0292", "category": "EDUCATIONAL", "template": "Mom/Dad of # of kids, here is how I treat being a mom/dad as a job.", "exampleUrl": "https://www.instagram.com/reel/Cx568_TA6DP/?igsh=aXhrb3phdmV6bDk3"}, {"id": "EDU_0293", "category": "EDUCATIONAL", "template": "# minutes ago (insert pain point) and had (insert pain", "exampleUrl": "https://www.instagram.com/reel/DFp0aJjuEq"}, {"id": "EDU_0294", "category": "EDUCATIONAL", "template": "If you have a (insert noun) in your house and a (insert noun) I am going to show you guys the # of the best things we did to (insert dream outcome).", "exampleUrl": "https://www.instagram.com/reel/DHe4tCOyyJP/?igsh=am9scXViZGtwcjBp"}, {"id": "EDU_0295", "category": "EDUCATIONAL", "template": "If I could suggest any tip to any (insert person) out these it would be this.", "exampleUrl": "https://www.instagram.com/reel/DFBFcSLSgHL/?igsh=OXY0b2d2YjRlaTJt"}, {"id": "EDU_0296", "category": "EDUCATIONAL", "template": "If you want to do this in (insert year). If you want (insert dream result) you have 3 main options to make it happen. I am going to go over them right now.", "exampleUrl": "https://www.instagram.com/reel/DEX6xCiPIqQ/?igsh=ZnR4cXQyeXdzeTl5"}, {"id": "EDU_0297", "category": "EDUCATIONAL", "template": "Your (insert noun) is to (insert adjective) and (insert adjective). Here are # of (insert noun) to (insert result).", "exampleUrl": "https://www.instagram.com/reel/DEKxvNauJNa/?igsh=dGQzaW41MGVva3p5"}, {"id": "EDU_0298", "category": "EDUCATIONAL", "template": "If you (insert verb) and (insert action) and it doesn't (insert result) it\u2019s time to (insert action).", "exampleUrl": "https://www.instagram.com/reel/DDxwEtsyLDo/?igsh=MTA0cTFrN3gzbHU0eQ=="}, {"id": "EDU_0299", "category": "EDUCATIONAL", "template": "I just made over # of (insert noun) in under (insert time) and I will show you how I did it.", "exampleUrl": "https://www.instagram.com/reel/DFhLiCCRCxz/?igsh=emhjdHVhdHFwM3lo"}, {"id": "EDU_0300", "category": "EDUCATIONAL", "template": "If you want to add (insert noun) to you (insert noun) in (insert year) and you don\u2019t know what (insert noun) to get I got you.", "exampleUrl": "https://www.instagram.com/reel/DF82wujO17l/?igsh=MWd3ZGR4NWRtN3F2eg=="}, {"id": "EDU_0301", "category": "EDUCATIONAL", "template": "If you storing your (insert noun) in (insert noun) stop what you're doing and watch this video.", "exampleUrl": "https://www.instagram.com/reel/DE0ZdAMpZpp/?igsh=MWlubWdoMTZidGxyZA=="}, {"id": "EDU_0302", "category": "EDUCATIONAL", "template": "We spent $ of (insert noun) for our family of #, and this will last us (insert time frame).", "exampleUrl": "https://www.instagram.com/reel/DGPAOVtgP2p/?igsh=cW1sYXI2ajh3b24="}, {"id": "EDU_0303", "category": "EDUCATIONAL", "template": "People always ask me (insert name) (insert fact) (insert question) well, let\u2019s find out.", "exampleUrl": "https://www.instagram.com/reel/DDkR4liv0sV/?igsh=MWNqZGcycDk4Z2c1Zw=="}, {"id": "EDU_0304", "category": "EDUCATIONAL", "template": "If you\u2019re wondering why when you (insert action) and don\u2019t (insert result). Then proceed to (insert action) and (insert result). It\u2019s because you are not doing this.", "exampleUrl": "https://www.instagram.com/reel/DEbPfOAs0Jj/?igsh=ZXcwZGlzamxiY3J3"}, {"id": "EDU_0305", "category": "EDUCATIONAL", "template": "Whatever you do, do not let you (insert person) (insert action).", "exampleUrl": "https://www.instagram.com/reel/DFvEpXyMsWi/?igsh=cjJtZ20zenNhdTh2"}, {"id": "EDU_0306", "category": "EDUCATIONAL", "template": "I am sick of hearing this word (insert word).", "exampleUrl": "https://www.instagram.com/reel/DGyTRjPs-tM/?igsh=MW02MDcwNXppdDJ6OQ=="}, {"id": "EDU_0307", "category": "EDUCATIONAL", "template": "It starts off like this\u2026", "exampleUrl": "https://www.instagram.com/reel/DC8xcCbJVSw/?igsh=MWx1YzNobWpud3Qydw=="}, {"id": "EDU_0308", "category": "EDUCATIONAL", "template": "After (insert time frame) of research here is why I choose (insert noun) and started (insert action).", "exampleUrl": "https://www.instagram.com/reel/DDcNdiARaeE/?igsh=MWdtaTluNHhhemxvbA=="}, {"id": "EDU_0309", "category": "EDUCATIONAL", "template": "Does your (insert person) (insert action) like this?", "exampleUrl": "https://www.instagram.com/reel/DEKcWm2Ipy-/?igsh=Ym5hcno0NXM2Ymwz"}, {"id": "EDU_0310", "category": "EDUCATIONAL", "template": "If you have a (insert person) at home, then (insert action) will dramatically change their (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGqD6D4hoJq/?igsh=MXJkbG92Mjl1andzbg=="}, {"id": "EDU_0311", "category": "EDUCATIONAL", "template": "I built this (insert noun) for (insert $).", "exampleUrl": "https://www.instagram.com/reel/DDANx1BxN_O/?igsh=ZzdwODhsdHV4Ymp2"}, {"id": "EDU_0312", "category": "EDUCATIONAL", "template": "I bought this (insert noun) for (insert $) and let me show you what I did next.", "exampleUrl": "https://www.instagram.com/reel/DIABtwhxH-X/?igsh=MXBjOWx1N2VjbDAzaQ=="}, {"id": "EDU_0313", "category": "EDUCATIONAL", "template": "In (insert year) the (insert company/person) introduced the (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DIqAW_ARP4Y/?igsh=cXNqaDM5Mjd1eTQw"}, {"id": "EDU_0314", "category": "EDUCATIONAL", "template": "Here\u2019s the only way I will ever (insert action).", "exampleUrl": "https://www.instagram.com/reel/DIrAzqmhy1k/?igsh=MWIxb2syY2N2Y2dobA=="}, {"id": "EDU_0315", "category": "EDUCATIONAL", "template": "So I spent (insert $) at (insert store) on my last trip.", "exampleUrl": "https://www.instagram.com/reel/DElNzz_u22g/?igsh=MTFhNXAyNmJucGJq"}, {"id": "EDU_0316", "category": "EDUCATIONAL", "template": "I turned one (insert noun) into # different (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DFD6TSypE2P/?igsh=NXJ1am00cG94ZnE1"}, {"id": "EDU_0317", "category": "EDUCATIONAL", "template": "(insert company) did not sponsor me this year, so here is how to make their (insert noun) at home.", "exampleUrl": "https://www.instagram.com/reel/DCkHvJ1z-al/?igsh=MWs4MHBvdHdvMnFpeA=="}, {"id": "EDU_0318", "category": "EDUCATIONAL", "template": "Want a (insert person) who (insert dream result) every time, even when you don\u2019t (insert noun/action).", "exampleUrl": "https://www.instagram.com/reel/DGhCeDQPmKV/?igsh=MWpxNHViZHFkaXVobA=="}, {"id": "EDU_0319", "category": "EDUCATIONAL", "template": "It\u2019s (insert noun) season, so let\u2019s make a (insert noun) for your (insert person).", "exampleUrl": "https://www.instagram.com/reel/DISbkqXJ5SD/?igsh=NTRvbzNtYnNtNnN5"}, {"id": "EDU_0320", "category": "EDUCATIONAL", "template": "Your favorite (insert noun) hacks from (insert year).", "exampleUrl": "https://www.instagram.com/reel/DDprbmqSyib/?igsh=MWFxeTBvbDltN3EyNw=="}, {"id": "EDU_0321", "category": "EDUCATIONAL", "template": "# years as a (insert occupation) you guys still don\u2019t believe me when I say these things.", "exampleUrl": "https://www.instagram.com/reel/DIAPFYlsfuX/?igsh=MWd4d3ZpaWpodXRpbQ=="}, {"id": "EDU_0322", "category": "EDUCATIONAL", "template": "It\u2019s wild to think (insert type of stores) still sell (insert noun) for (insert result). But not everyone knows they actually (insert result).", "exampleUrl": "https://www.instagram.com/reel/DFV58iERvGm/?igsh=bmw0eXNhamZzZm54"}, {"id": "EDU_0323", "category": "EDUCATIONAL", "template": "I am not a DIY guy/girl but I am going to show you how I spent (insert $) to transform my (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DG8vTC4pie4/?igsh=cDI2aWtlc3ljMHZr"}, {"id": "EDU_0324", "category": "EDUCATIONAL", "template": "3 (insert noun) we do not recommend for the first time (insert noun) owners/users.", "exampleUrl": "https://www.instagram.com/reel/DB34v2osmcT/?igsh=MWdhOGJ6MzZ0aXVmcQ=="}, {"id": "EDU_0325", "category": "EDUCATIONAL", "template": "How to stop (insert verb).", "exampleUrl": "https://www.instagram.com/reel/C15ByRUp1Rv/?igsh=ZTR6ejYwdWY0YjUx"}, {"id": "EDU_0326", "category": "EDUCATIONAL", "template": "People keep asking me what to do with (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DHTamvwsQu8/?igsh=MXd6OXU5NDJ4enJxZg=="}, {"id": "EDU_0327", "category": "EDUCATIONAL", "template": "Does (insert noun) really kill (insert live thing).", "exampleUrl": "https://www.instagram.com/reel/DCvxgmazwDW/?igsh=Y2pjMm1jeWI2MXZz"}, {"id": "EDU_0328", "category": "EDUCATIONAL", "template": "I am going to show you how to (insert verb) your (insert noun) so they don\u2019t (insert pain point).", "exampleUrl": "https://www.instagram.com/reel/DGWHu_rSbku/?igsh=MWxoMjl1azExZ29qZQ=="}, {"id": "EDU_0329", "category": "EDUCATIONAL", "template": "# things you should never put in the (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DDxoAs_TciE/?igsh=MWc4anZoZXl0ZTM3ZA=="}, {"id": "EDU_0330", "category": "EDUCATIONAL", "template": "Almost everyone thinks they know how to (insert action).", "exampleUrl": "https://www.instagram.com/reel/DA9e_qHyahV/?igsh=MW05NGd1bHJ0YnBycw=="}, {"id": "EDU_0331", "category": "EDUCATIONAL", "template": "Let\u2019s start by mixing (insert noun) and (insert noun) and I am going to give it a good shake. What happens?", "exampleUrl": "https://www.instagram.com/reel/DBU47L9SRQ4/?igsh=MTNyMjBuNDVzc3Z2dA=="}, {"id": "EDU_0332", "category": "EDUCATIONAL", "template": "Apparently if you\u2026", "exampleUrl": "https://www.instagram.com/reel/DFViUxyuruw/?igsh=MXhldXVhOWk2YmozZw=="}, {"id": "EDU_0333", "category": "EDUCATIONAL", "template": "Let\u2019s get this brand new (insert noun) (insert action) so we can put it to good use.", "exampleUrl": "https://www.instagram.com/reel/DH3cSc0Rs3X/?igsh=MW4xdnJrNTFoZHh5Zw=="}, {"id": "EDU_0334", "category": "EDUCATIONAL", "template": "Throw out you (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DCVGFh9yqMK/?igsh=MXIzM3dmMGp6bXk0Ng=="}, {"id": "EDU_0335", "category": "EDUCATIONAL", "template": "This one mistake can actually kill your (insert living thing).", "exampleUrl": "https://www.instagram.com/reel/DGrhiv8zOQQ/?igsh=aTA5aWNpbGExb21n"}, {"id": "EDU_0336", "category": "EDUCATIONAL", "template": "This is kind of gross but I had to share.", "exampleUrl": "https://www.instagram.com/reel/DG1lPtBS_Lh/?igsh=Z29oYzkzNXoyamMy"}, {"id": "EDU_0337", "category": "EDUCATIONAL", "template": "(insert name), how do you (insert result)?", "exampleUrl": "https://www.instagram.com/reel/DIZzqD9u-cJ/?igsh=NDF2aGFoemQyY2F3"}, {"id": "EDU_0338", "category": "EDUCATIONAL", "template": "We are going to text (insert noun), today on how (insert adjective) is it.", "exampleUrl": "https://www.instagram.com/reel/DIRbQ9PvbTm/?igsh=MTB2ZWE5dzRtYjB2Mg=="}, {"id": "EDU_0339", "category": "EDUCATIONAL", "template": "All you need is a (insert amount) of (insert noun) and you can turn (insert amount) of (insert noun) into", "exampleUrl": "https://www.instagram.com/reel/DH3Kn86stmI/?igsh=MjN5MWZwb3B1dGc3"}, {"id": "EDU_0340", "category": "EDUCATIONAL", "template": "Here are # (insert noun) that you should never (insert action).", "exampleUrl": "https://www.instagram.com/reel/DG2_ufDxNQJ/?igsh=dHdyNHh6bDducTMw"}, {"id": "EDU_0341", "category": "EDUCATIONAL", "template": "If I can\u2019t do it in one step, I am not doing it. This is the #1 most efficient way to (insert verb) (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DCK537Ry9-c/?igsh=MTZndGo0NzBhbDd5ZQ=="}, {"id": "EDU_0342", "category": "EDUCATIONAL", "template": "When (insert occurrence) you will probably need a better (insert noun) than this.", "exampleUrl": "https://www.instagram.com/reel/DHzjcH2t5Rh/?igsh=NTRjNmo5NGFvczJ6"}, {"id": "EDU_0343", "category": "EDUCATIONAL", "template": "I found out why (insert noun) wasn\u2019t (insert result). So I am going to tell you what you\u2019re doing wrong.", "exampleUrl": "https://www.instagram.com/reel/DH_Y1jnsjde/?igsh=MnZhZDJqM3BtMDFl"}, {"id": "EDU_0344", "category": "EDUCATIONAL", "template": "This is the ultimate master trick to (insert result) in just # minutes.", "exampleUrl": "https://www.instagram.com/reel/DHB1amjNDLk/?igsh=NWkxemthMXo5MWU1"}, {"id": "EDU_0345", "category": "EDUCATIONAL", "template": "Did you know you only need # of ingredients to make (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DEYRmDGRTaU/?igsh=dXc4ZnVjcm5pbWpn"}, {"id": "EDU_0346", "category": "EDUCATIONAL", "template": "I am willing to bet, this (insert noun) is older than you.", "exampleUrl": "https://www.instagram.com/reel/DEkn1RAxZur/?igsh=YXhvc3l1aGxiYmIw"}, {"id": "EDU_0347", "category": "EDUCATIONAL", "template": "Did you know our chicken is dunked in chlorine?", "exampleUrl": "https://www.instagram.com/reel/DGGSGPGOKMa/?igsh=cXFta2FoOGRkMDRz"}, {"id": "EDU_0348", "category": "EDUCATIONAL", "template": "The viral (insert noun) hack that landed me in (insert news/magazine outlet).", "exampleUrl": "https://www.instagram.com/reel/CzohD-xx_17/?igsh=MTJocjlmaW5vcWEzZg=="}, {"id": "EDU_0349", "category": "EDUCATIONAL", "template": "I am a # generation (insert title) and I hope this shows you why you should (insert action) when (insert task).", "exampleUrl": "https://www.instagram.com/reel/DFOOvvaxdnT/?igsh=MTM5Z3JyMmU1MWJkcA=="}, {"id": "EDU_0350", "category": "EDUCATIONAL", "template": "Here are the # (insert noun) items you need to throw in the garbage right now.", "exampleUrl": "https://www.instagram.com/reel/DDgfQ8CqiQA/?igsh=cGw3YXVrYXFhbXpx"}, {"id": "EDU_0351", "category": "EDUCATIONAL", "template": "We\u2019re going to see if it\u2019s true, that (insert noun) are so filled with toxins that they don\u2019t burn when you hit them with a blow torch.", "exampleUrl": "https://www.instagram.com/reel/DEn8q3Av5Qw/?igsh=ZjhrcmIxMXhpcGJ0"}, {"id": "EDU_0352", "category": "EDUCATIONAL", "template": "Believe it or not, this simple device can prevent (insert pain point), (insert pain point), and (insert pain point).", "exampleUrl": "https://www.instagram.com/reel/C9QruINS4JX/?igsh=MXF2MWd2OWVnZXFqMw=="}, {"id": "EDU_0353", "category": "EDUCATIONAL", "template": "Here\u2019s why I never use a (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DDK76uDzcV2/?igsh=aWV1cXd1NHp6c2U3"}, {"id": "EDU_0354", "category": "EDUCATIONAL", "template": "Did you know you could take a (insert noun) like this, and quick (insert action).", "exampleUrl": "https://www.instagram.com/reel/DHV1A68Rl1I/?igsh=aWl3bml2a2dnenF5"}, {"id": "EDU_0355", "category": "EDUCATIONAL", "template": "Here are # (insert noun) as a (insert title) I would never own.", "exampleUrl": "https://www.instagram.com/reel/DGOAQp_xX5D/?igsh=dHM1a3NrYXlsMXM1"}, {"id": "EDU_0356", "category": "EDUCATIONAL", "template": "Want to find out what\u2019s hiding inside one of these (insert noun) when they are not properly maintenanced?", "exampleUrl": "https://www.instagram.com/reel/DD3L0x_yzh5/?igsh=MXV6bWI2bngyeGF5cw=="}, {"id": "EDU_0357", "category": "EDUCATIONAL", "template": "What I eat in a day on the (insert noun) diet.", "exampleUrl": "https://www.instagram.com/reel/DELePTnSGAD/?igsh=MWVwaHR5dmwwdG9qOQ=="}, {"id": "EDU_0358", "category": "EDUCATIONAL", "template": "These are # of (insert noun) I would not own as a (insert title).", "exampleUrl": "https://www.instagram.com/reel/DFF6w_INWWc/?igsh=ZXJ3OHp4c3VsbGVy"}, {"id": "EDU_0359", "category": "EDUCATIONAL", "template": "You should be able to look at her/his (insert noun) and see if come up to her/his (insert noun) here.", "exampleUrl": "https://www.instagram.com/reel/DIj99kYuTk0/?igsh=dGpkamZyMmhvYnF1"}, {"id": "EDU_0360", "category": "EDUCATIONAL", "template": "If you see (insert symptom), (insert symptom) especially on a (insert type of noun) you better worry about what\u2019s called (insert name).", "exampleUrl": "https://www.instagram.com/reel/DCkmbAcx2zN/?igsh=MTZkcmIyMHV4bDR4cQ=="}, {"id": "EDU_0361", "category": "EDUCATIONAL", "template": "If you have a (insert noun) and you see that the (insert noun) is (insert observation) that's a dead giveaway that they are (insert action).", "exampleUrl": "https://www.instagram.com/reel/DBZtE6ERLOK/?igsh=MWQ4cG84NmE1YTZncw=="}, {"id": "EDU_0362", "category": "EDUCATIONAL", "template": "(insert name), overused (insert noun)?", "exampleUrl": "https://www.instagram.com/reel/DDw2899RsgM/?igsh=a3VqZ3pyaDRkN3E5"}, {"id": "EDU_0363", "category": "EDUCATIONAL", "template": "Here are # human foods that can kill your (insert living thing).", "exampleUrl": "https://www.instagram.com/reel/DDZ30LXs9oL/?igsh=MXg3Y3N1dDZzZW5lMg=="}, {"id": "EDU_0364", "category": "EDUCATIONAL", "template": "Before you ever take you (insert living thing) on a (insert action) for the first time you need to watch this.", "exampleUrl": "https://www.instagram.com/reel/DFq5P8VSzVD/?igsh=ZXFoN3VsOHV0dmRr"}, {"id": "EDU_0365", "category": "EDUCATIONAL", "template": "Strange (insert noun) behaviors explained.", "exampleUrl": "https://www.instagram.com/reel/DF3E-zSuGCe/?igsh=YWJjdmVtOWt6YnVu"}, {"id": "EDU_0366", "category": "EDUCATIONAL", "template": "(insert name) what is your (insert title) trigger?", "exampleUrl": "https://www.instagram.com/reel/DHyUjujMh6O/?igsh=MWtjNWVyZmF0NGRsaA=="}, {"id": "EDU_0367", "category": "EDUCATIONAL", "template": "What\u2019s the most overrated (insert noun)?", "exampleUrl": "https://www.instagram.com/reel/DDPtPtwMZ9h/?igsh=ampodmR0ZHhvbGJr"}, {"id": "EDU_0368", "category": "EDUCATIONAL", "template": "The top # (insert noun) for (insert target audience).", "exampleUrl": "https://www.instagram.com/reel/DGlwOhMRkyG/?igsh=a293bmEydGlhNXFy"}, {"id": "EDU_0369", "category": "EDUCATIONAL", "template": "Here are the # (insert noun) that are the least likely to (insert result).", "exampleUrl": "https://www.instagram.com/reel/C6Zculqy94L/?igsh=Mzkyb2RoMW9kcWg0"}, {"id": "EDU_0370", "category": "EDUCATIONAL", "template": "If you (insert action) for (insert timeframe) what would happen?", "exampleUrl": "https://www.instagram.com/reel/DF-vR6fJuoY/?igsh=aHY0d3lyaTBiaTNy"}, {"id": "EDU_0371", "category": "EDUCATIONAL", "template": "This (insert noun) has something in it called (insert", "exampleUrl": "https://www.instagram.com/reel/DI6uLtcJhqi/"}, {"id": "EDU_0372", "category": "EDUCATIONAL", "template": "Here are # of things, every (insert person) should keep in their (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DIKsKR_PkNr/?igsh=MTJ1MjZyeXk1MmFreQ=="}, {"id": "EDU_0373", "category": "EDUCATIONAL", "template": "Man this, (insert noun) in (insert location) is trash. Maybe I should just get this cheap (insert noun). Yeah I wouldn't do that if I were you.", "exampleUrl": "https://www.instagram.com/reel/DE0C6tWPrdA/?igsh=bHJ5ZGpoYTBkZ2hs"}, {"id": "EDU_0374", "category": "EDUCATIONAL", "template": "This (insert noun) isn't bad for you. Yeah it has some (insert noun) but what does that even mean?", "exampleUrl": "https://www.instagram.com/reel/DIShYdlpxE_/?igsh=MXBnNDE0bGhwZGNsdQ=="}, {"id": "EDU_0375", "category": "EDUCATIONAL", "template": "So most people don\u2019t know that on a (insert noun) there is one (insert noun) every (insert noun) owner always (insert action).", "exampleUrl": "https://www.instagram.com/reel/DB7bgr7yH6v/?igsh=OGZwM2g0YjFzdjJ2"}, {"id": "EDU_0376", "category": "EDUCATIONAL", "template": "0 calorie (insert noun) I am not joking these are literally 0 calories.", "exampleUrl": "https://www.instagram.com/reel/DDvfNslO9bO/?igsh=MW51anowazI1OTByaw=="}, {"id": "EDU_0377", "category": "EDUCATIONAL", "template": "This guy bought a failing (insert type) company for (insert noun). Now it\u2019s worth over (insert $).", "exampleUrl": "https://www.instagram.com/reel/DEz3aett57y/?igsh=cjI1ZTZkaGxuanNh"}, {"id": "EDU_0378", "category": "EDUCATIONAL", "template": "Stop wearing (insert noun), it really is just like wearing (insert analogy to represent damage).", "exampleUrl": "https://www.instagram.com/reel/DGD75qfOv40/?igsh=MTBwcXdhdTExazBmaA=="}, {"id": "EDU_0379", "category": "EDUCATIONAL", "template": "We all have that one (insert label) in our life.", "exampleUrl": "https://www.instagram.com/reel/DG_UiWgyUgO/?igsh=eTdqYm42czV1OGM0"}, {"id": "EDU_0380", "category": "EDUCATIONAL", "template": "But it\u2019s just an (insert noun) and it\u2019s (insert positive) how bad could it be? Well this (insert noun) has the same amount of (insert metric) as # (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DD1SdWGv8WW/?igsh=cG4wcXBwNjR4Mzk="}, {"id": "EDU_0381", "category": "EDUCATIONAL", "template": "What if I told you that you could eat this entire jar of (insert noun) for less calories than 2 servings of their (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DG4GxNOuDk2/?igsh=YzI3ODhlaTRkbTk0"}, {"id": "EDU_0382", "category": "EDUCATIONAL", "template": "A # calorie deficit per day, for a month should be around (insert pounds/kilos) of weight loss.", "exampleUrl": "https://www.instagram.com/reel/DIjYAm5IQ_R/?igsh=MXNrOTA4NDJzNjFiYQ=="}, {"id": "EDU_0383", "category": "EDUCATIONAL", "template": "Welcome back to \u201cI can\u2019t (insert dream result)\u201d a series where I show you (insert routine/tutorial/steps to insert result) that take less than (insert time) to do/make.", "exampleUrl": "https://www.instagram.com/reel/DGD3gXtJSNH/?igsh=MW5tajcycHl3OXY4MQ=="}, {"id": "EDU_0384", "category": "EDUCATIONAL", "template": "What I am (insert verb) on my (insert goal) journey, (insert result) last month.", "exampleUrl": "https://www.instagram.com/reel/DEikNFLuFP2/?igsh=MXJrNHo5NThqNjZ4Mg=="}, {"id": "EDU_0385", "category": "EDUCATIONAL", "template": "If your (insert current state) you can\u2019t just (insert result) like everyone else.", "exampleUrl": "https://www.instagram.com/reel/C5B64cPIrhi/?igsh=MXZpYmlzc3RpNWFobA=="}, {"id": "EDU_0386", "category": "EDUCATIONAL", "template": "After over a decade of (insert action) here is what I wish someone would have told me from the start.", "exampleUrl": "https://www.instagram.com/reel/DImQ3laRb30/?igsh=MW9idTU1aWI2dTN4aw=="}, {"id": "EDU_0387", "category": "EDUCATIONAL", "template": "To everyone just doing (insert #) (insert action). Stop that.", "exampleUrl": "https://www.instagram.com/reel/DDSXasqCf_S/?igsh=MWtneXdyaHk4YnM0cg=="}, {"id": "EDU_0388", "category": "EDUCATIONAL", "template": "If you want to (insert dream result), (insert action) is the worst thing you can do.", "exampleUrl": "https://www.instagram.com/reel/DFGOcEtIjFv/?igsh=cGRsbjl6NzkwdA=="}, {"id": "EDU_0389", "category": "EDUCATIONAL", "template": "This is (insert metric) the exact same amount of (insert noun) you build everyday. If you (insert action) hard (insert #) times per week.", "exampleUrl": "https://www.instagram.com/reel/DCXFyoBobxU/?igsh=M3NtNzY2OHp2d3My"}, {"id": "EDU_0390", "category": "EDUCATIONAL", "template": "You want you (insert noun) to look like these? So did this guy.", "exampleUrl": "https://www.instagram.com/reel/DIJkuM_OW8I/?igsh=dWJiYTUwNWc5dXlp"}, {"id": "EDU_0391", "category": "EDUCATIONAL", "template": "If I had 90 days to go from being (insert current state) to (insert dream result) here\u2019s exactly how I would do it!", "exampleUrl": "https://www.instagram.com/reel/DE_2hH-M11D/?igsh=bGN4M2MzNjltaGln"}, {"id": "EDU_0392", "category": "EDUCATIONAL", "template": "You are (insert adjective) than you think.", "exampleUrl": "https://www.instagram.com/reel/DCmTJe5NpZ5/?igsh=c3poZmcycDZ4dWZn"}, {"id": "EDU_0393", "category": "EDUCATIONAL", "template": "You can put on/take off (insert metric) on your (insert mile/exercise/vertical/etc) in one workout with these simple tips.", "exampleUrl": "https://www.instagram.com/reel/DDxVEiCRlG8/?igsh=MW1zemVyMWh0MWZ4dQ=="}, {"id": "EDU_0394", "category": "EDUCATIONAL", "template": "If you have (insert symptom) you probably have (insert condition).", "exampleUrl": "https://www.instagram.com/reel/C8ht9iwpUk6/?igsh=dzVwbWRsaHdrYmp4"}, {"id": "EDU_0395", "category": "EDUCATIONAL", "template": "If you (insert action) but don't when to (insert action). You could be losing up to (insert metric) of you (insert dream result) without even realizing it.", "exampleUrl": "https://www.instagram.com/reel/DGLVKBUR6W0/?igsh=dm9tdTd6cGt4bDZj"}, {"id": "EDU_0396", "category": "EDUCATIONAL", "template": "If your (insert verb) (insert noun) and then (insert noun) and then (insert noun) that is literally the worst thing you could be doing.", "exampleUrl": "https://www.instagram.com/reel/DCCjwkbC7Oi/?igsh=MXNpZGJvdGRmdjU0aA=="}, {"id": "EDU_0397", "category": "EDUCATIONAL", "template": "The worst possible thing that can happen to a man/woman is developing (insert result).", "exampleUrl": "https://www.instagram.com/reel/DDfxpOkAk5a/?igsh=MTZkMDNjMWpuOGF1cg=="}, {"id": "EDU_0398", "category": "EDUCATIONAL", "template": "I grew about # (insert metric) in the past year at (insert age) by fixing my (insert condition) and (insert condition).", "exampleUrl": "https://www.instagram.com/reel/DEjBuqtxzZU/?igsh=MWxreTIycmhydjZzcQ=="}, {"id": "EDU_0399", "category": "EDUCATIONAL", "template": "Person #1: (insert large number) Person #2: What are you doing? Person #1: (insert action) I want to get a (insert dream result) before (insert time).", "exampleUrl": "https://www.instagram.com/reel/DI1viVSN5N9/?igsh=bDd2eG9iczRwZ3I1"}, {"id": "EDU_0400", "category": "EDUCATIONAL", "template": "So you want to impress you (insert person) when you (insert action) this (insert upcoming time).", "exampleUrl": "https://www.instagram.com/reel/DI2FmNmK-AN/?igsh=M284Y3o5ZXlxamg1"}, {"id": "EDU_0401", "category": "EDUCATIONAL", "template": "Person #1: What aren't my (insert noun) (insert adjective)? Person #2: It\u2019s because your (insert common mistake)", "exampleUrl": "https://www.instagram.com/reel/DCUaqmTzGkG/?igsh=MWlna2gyeXhvYmdrdA=="}, {"id": "EDU_0402", "category": "EDUCATIONAL", "template": "If you want to be the (insert adjective) person in the room, it all starts when you (insert action).", "exampleUrl": "https://www.instagram.com/reel/DDxd-jpvwNz/?igsh=b3I4ODBzdG5tMGIw"}, {"id": "EDU_0403", "category": "EDUCATIONAL", "template": "If you have (insert pain point) but not much time to (insert action) and you want to (insert result) then save these (insert noun) and (insert noun) steps/routines/tips.", "exampleUrl": "https://www.instagram.com/reel/DGbQ6H0t1Mv/?igsh=eW5yaWtyeTJzdzUx"}, {"id": "EDU_0404", "category": "EDUCATIONAL", "template": "I\u2019ve had a (insert drea result) since I was (insert age).", "exampleUrl": "https://www.instagram.com/reel/DHmabeBSFJT/?igsh=ZWUxbWJkNjBhaGV2"}, {"id": "EDU_0405", "category": "EDUCATIONAL", "template": "The reason I can (insert result) and be comfortable, not have any (insert pain point) is this right here.", "exampleUrl": "https://www.instagram.com/reel/DF0vHL3Pahk/?igsh=MTg1OGRxOWN0dDJ2bA=="}, {"id": "EDU_0406", "category": "EDUCATIONAL", "template": "I spent (insert #) whole years with (insert condition) so you don\u2019t have too.", "exampleUrl": "https://www.instagram.com/reel/C8fU6cyP3Hc/?igsh=MXF0aGVjNnZtMzJkaw=="}, {"id": "EDU_0407", "category": "EDUCATIONAL", "template": "I have a (insert metric) (insert noun) because this is one of my workouts/routines/steps/tips/strategies/methods.", "exampleUrl": "https://www.instagram.com/reel/DAB359mSW5F/?igsh=MTlleXp4Yms4Mm80Mw=="}, {"id": "EDU_0408", "category": "EDUCATIONAL", "template": "If you can\u2019t (insert skill), then follow this one minute routine/progressional/tutorial and you will have (insert skill) by the end of this video.", "exampleUrl": "https://www.instagram.com/reel/DEd6_6yJOi3/?igsh=MXN0bW9lb3QwcHVuaQ=="}, {"id": "EDU_0409", "category": "EDUCATIONAL", "template": "If your (insert current state) then the easiest way to have (insert dream state) is to have (insert result).", "exampleUrl": "https://www.instagram.com/reel/DGefW1ANb0D/?igsh=bXZreWliZ2thb2Vz"}, {"id": "EDU_0410", "category": "EDUCATIONAL", "template": "What would happen to you (insert noun) if you only (insert action) for an entire week.", "exampleUrl": "https://www.instagram.com/reel/DFyxVP4xBm6/?igsh=MXdmM2xhdTBlMDRjNA=="}, {"id": "EDU_0411", "category": "EDUCATIONAL", "template": "Taking a (insert noun) can increase your (insert result) but only with one strategy.", "exampleUrl": "https://www.instagram.com/reel/C_z-Hy2S4j7/?igsh=d3diN3lldGZ6cWZz"}, {"id": "EDU_0412", "category": "EDUCATIONAL", "template": "If you\u2019re serious about getting (insert result) then this is the only video you will ever need so save it for later and watch till the end.", "exampleUrl": "https://www.instagram.com/reel/CsVU4YTuQlg/?igsh=MWE3a2R0NWxqNXJrdQ=="}, {"id": "EDU_0413", "category": "EDUCATIONAL", "template": "If I had to start over and (insert verb) my (insert noun) from scratch, these are the only (insert noun) I would do for someone that is new to (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGR8OoSsssd/?igsh=MTBmOG9nbjhrZ24zcg=="}, {"id": "EDU_0414", "category": "EDUCATIONAL", "template": "Let\u2019s see what\u2019s inside (insert noun).", "exampleUrl": "https://www.instagram.com/reel/C9z8e7aO6Z4/?igsh=MXdrZmdjaTZ3ZHI5cA=="}, {"id": "EDU_0415", "category": "EDUCATIONAL", "template": "This is the reason (insert noun) is the size they are.", "exampleUrl": "https://www.instagram.com/reel/DFUrWD3P_uA/?igsh=YzI4NmZveTc3ZDQy"}, {"id": "EDU_0416", "category": "EDUCATIONAL", "template": "Here is a tier list of the best (insert noun) sources based off of how good they are for you (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DCuVL0VPLjU/?igsh=MXgzZDd5NXNvaG02aA=="}, {"id": "EDU_0417", "category": "EDUCATIONAL", "template": "I don\u2019t really show the (insert noun) a lot of love because I don\u2019t like (insert action) but today I am going to show you (insert action).", "exampleUrl": "https://www.instagram.com/reel/DExHLTotGlt/?igsh=MTRxN3c4bm13MzF4Mw=="}, {"id": "EDU_0418", "category": "EDUCATIONAL", "template": "What if I told you to (insert verb) # (insert noun) everyday?", "exampleUrl": "https://www.instagram.com/reel/DFKru9CSKpb/?utm_source=ig_web_copy_link"}, {"id": "EDU_0419", "category": "EDUCATIONAL", "template": "What would happen if you (insert dangerous action).", "exampleUrl": "https://www.instagram.com/reel/DHgpcAXJMT8/?igsh=cmVoZ3VvOGM0bDJo"}, {"id": "EDU_0420", "category": "EDUCATIONAL", "template": "F*ck it, I am going to role # of (insert noun) in 60 seconds.", "exampleUrl": "https://www.instagram.com/reel/DEnKwgGJi9p/?igsh=MWV0eTU3YjhuYndsbA=="}, {"id": "EDU_0421", "category": "EDUCATIONAL", "template": "This is what a full (insert time) (insert action) looks like at top # (insert school) in (insert location).", "exampleUrl": "https://www.instagram.com/reel/DFbEwDjTJh-/?igsh=anFpdWFkM2ExajZo"}, {"id": "EDU_0422", "category": "EDUCATIONAL", "template": "What\u2019s hommies, I am going to give you a cash course of what (insert noun) to ask for, based on what you want that (insert noun) to do for you.", "exampleUrl": "https://www.instagram.com/reel/DFD3FqAvSh9/?igsh=MW11eGZhNmF5bDBuZQ=="}, {"id": "EDU_0423", "category": "EDUCATIONAL", "template": "If your between the heights (insert height) to (insert height).", "exampleUrl": "https://www.instagram.com/reel/DEaf5GfpUy7/?igsh=MXNsaDJtNHlnd21jMA=="}, {"id": "EDU_0424", "category": "EDUCATIONAL", "template": "This is a great trick.", "exampleUrl": "https://www.instagram.com/reel/DJC1PslvU1Z/?igsh=a2QzbGZyMm92Y241"}, {"id": "EDU_0425", "category": "EDUCATIONAL", "template": "(insert $) in (insert time) and people still think you need a 9-5.", "exampleUrl": "https://www.instagram.com/reel/DIXVEpRSrDR/?igsh=MXA3a3FodmNwenNl"}, {"id": "EDU_0426", "category": "EDUCATIONAL", "template": "They say you can\u2019t (insert result) with (insert noun) but they're wrong.", "exampleUrl": "https://www.instagram.com/reel/C17LtU2Ltov/?igsh=bmkzMm1saG04cTdh"}, {"id": "EDU_0427", "category": "EDUCATIONAL", "template": "Here are # of pricing mistakes we made when starting our (insert business).", "exampleUrl": "https://www.instagram.com/reel/DGmFoxiSikU/?igsh=ZTdzenI5aDdhbDVq"}, {"id": "EDU_0428", "category": "EDUCATIONAL", "template": "# things I'd do if I were to re-start (insert industry/niche/occupation/hobby).", "exampleUrl": "https://www.instagram.com/reel/DGVJ3n3SGhc/?igsh=MXQwbWJwcGg2cjc1eA=="}, {"id": "EDU_0429", "category": "EDUCATIONAL", "template": "The (insert noun) of a (insert noun) will tell you a lot about the (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGT9NI2pbX5/?igsh=MWhnaDh3NTZhdHA1eg=="}, {"id": "EDU_0430", "category": "EDUCATIONAL", "template": "Here are some space saving (insert noun) hacks that saved our small space.", "exampleUrl": "https://www.instagram.com/reel/DHWAfqwv5Xf/?igsh=cm93YWIwemxvZDYy"}, {"id": "EDU_0431", "category": "EDUCATIONAL", "template": "Do you feel (insert pain point) by your (insert noun) consistent (insert pain point).", "exampleUrl": "https://www.instagram.com/reel/DCXqEOfya7M/?igsh=MXRmZjR6M2VqbjdycA=="}, {"id": "EDU_0432", "category": "EDUCATIONAL", "template": "My friends and I turned this (insert adjective) (insert noun) into this (insert adjective) (insert noun) in just (insert time).", "exampleUrl": "https://www.instagram.com/reel/DG8YeQTs9XW/?igsh=MmFvMDh6MHV1cG53"}, {"id": "EDU_0433", "category": "EDUCATIONAL", "template": "What happened to (insert adjective) (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DA_7YdHo3S2/?igsh=MWwzZWxuOTdrODU5eA=="}, {"id": "EDU_0434", "category": "EDUCATIONAL", "template": "(insert noun) used to have (insert trait), now they don\u2019t.", "exampleUrl": "https://www.instagram.com/reel/C5rJryFoZZH/?igsh=MWFwcW94aDVzcTNkMg=="}, {"id": "EDU_0435", "category": "EDUCATIONAL", "template": "Here is a complete cost breakdown to build my (insert sqft) home.", "exampleUrl": "https://www.instagram.com/reel/DFBxNBuuKZw/?igsh=MTRoZHZhcDF6cG1k"}, {"id": "EDU_0436", "category": "EDUCATIONAL", "template": "It cost (insert $) to build my own (insert noun), acting as my own general contractor. Here is the complete coast breakdown.", "exampleUrl": "https://www.instagram.com/reel/C_oT5Ibpvlf/?igsh=cjI2cjI2dzRidTQ0"}, {"id": "EDU_0437", "category": "EDUCATIONAL", "template": "I paid (insert $) to build my own dream home and pool as an (insert title). Here is the complete cost breakdown.", "exampleUrl": "https://www.instagram.com/reel/C_J2pr9uWut/?igsh=MW8zaHN4bHB0OTFxdQ=="}, {"id": "EDU_0438", "category": "EDUCATIONAL", "template": "I\u2019ve (insert verb) over (insert #) of (insert noun) here are # things I would never do.", "exampleUrl": "https://www.instagram.com/reel/DGgLtQEIgKH/?igsh=emgydmY5NzEyYnBv"}, {"id": "EDU_0439", "category": "EDUCATIONAL", "template": "If you want to (insert verb) in an exceptional (insert noun) you have got to stop half-assing things.", "exampleUrl": "https://www.instagram.com/reel/DDAJK6STXlR/?igsh=MWI4c2xpY3p1OXl1cw=="}, {"id": "EDU_0440", "category": "EDUCATIONAL", "template": "It\u2019s also super hard to get (insert result) especially with the (insert condition).", "exampleUrl": "https://www.instagram.com/reel/DENwo4Fvh6f/?igsh=dWVyMGZud3dteWs0"}, {"id": "EDU_0441", "category": "EDUCATIONAL", "template": "It has taken me # years if (insert occupation/skill/hobby) to realize I have been (insert action) wrong this entire time.", "exampleUrl": "https://www.instagram.com/reel/DFBJYnGyr_a/?igsh=b2NrM2o5MGw4OHhl"}, {"id": "EDU_0442", "category": "EDUCATIONAL", "template": "Remember (insert method/strategy name) for you next (insert noun).", "exampleUrl": "https://www.instagram.com/reel/C6a9V7vuein/?igsh=ZTNsd2QzZHBhbTJ2"}, {"id": "EDU_0443", "category": "EDUCATIONAL", "template": "Remember (insert #) (insert noun) combo for you next (insert noun).", "exampleUrl": "https://www.instagram.com/reel/C3nW4P4L_xf/?igsh=cXF5eno1eHVzMWY0"}, {"id": "EDU_0444", "category": "EDUCATIONAL", "template": "(insert industry/niche) tips for if you're broke.", "exampleUrl": "https://www.instagram.com/reel/DDkbXWpucvG/?igsh=dmI2NmgzbjExZzh0"}, {"id": "EDU_0445", "category": "EDUCATIONAL", "template": "What (insert noun) and (insert noun) do I really need?", "exampleUrl": "https://www.instagram.com/reel/DGoOJxMyffy/?igsh=OHF5NHJkbzB3dXow"}, {"id": "EDU_0446", "category": "EDUCATIONAL", "template": "Every time you (insert action) your passing you (insert adjective) (insert noun) just because you don\u2019t know what they are.", "exampleUrl": "https://www.instagram.com/reel/DEiHlooJM-L/?igsh=MWZ3dnl6anI3cTh4bA=="}, {"id": "EDU_0447", "category": "EDUCATIONAL", "template": "Alright you little DIY freaks here's how to build the sauciest (insert noun) of all time.", "exampleUrl": "https://www.instagram.com/reel/DGCUWxRJ0A4/?igsh=MWo2MzNvejQ5ZW5hNQ=="}, {"id": "EDU_0448", "category": "EDUCATIONAL", "template": "Normally I would never say this but please stop (insert action) until you're ready to (insert action).", "exampleUrl": "https://www.instagram.com/reel/DFVrVTFx1Cu/?igsh=cm56Zm11andjc2sx"}, {"id": "EDU_0449", "category": "EDUCATIONAL", "template": "(insert noun) for all the (insert condition) guys/girls out there.", "exampleUrl": "https://www.instagram.com/reel/DIj9O4Az5GC/?igsh=MWRpeGRrcGphb3o1eQ=="}, {"id": "EDU_0450", "category": "EDUCATIONAL", "template": "How to take better (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DFLP70LKvi1/?igsh=cXo1MWhodnNrYzg="}, {"id": "EDU_0451", "category": "EDUCATIONAL", "template": "This is every single (insert noun) in my collection.", "exampleUrl": "https://www.instagram.com/reel/DEaUlTYI47b/?igsh=MXhvcHVxZjZvZzd0bg=="}, {"id": "EDU_0452", "category": "EDUCATIONAL", "template": "Invest in (insert adjective) (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGllDnGP4GS/?igsh=MXA2ZDE3NThvc2xjdg=="}, {"id": "EDU_0453", "category": "EDUCATIONAL", "template": "For people who (insert action) and are also into (insert noun) what the hell are we doing.", "exampleUrl": "https://www.instagram.com/reel/DAGWXZ5OnJ_/?igsh=a2NjMTRrMjl0dzk4"}, {"id": "EDU_0454", "category": "EDUCATIONAL", "template": "Here's how to build a good (insert noun) rotation.", "exampleUrl": "https://www.instagram.com/reel/DDkarIGP6Da"}, {"id": "EDU_0455", "category": "EDUCATIONAL", "template": "This guy has made (insert $) profit in one day using the technique he is about to use.", "exampleUrl": "https://www.instagram.com/reel/DFgTirDB5xe/?igsh=OG5pa2lnNTYwYzhw"}, {"id": "EDU_0456", "category": "EDUCATIONAL", "template": "This book will teach you more about the (insert niche/industry/topic) than all of these books here.", "exampleUrl": "https://www.instagram.com/reel/DE2qZvqoDAO/?igsh=MWUzanZ4ajNiemZxdA=="}, {"id": "EDU_0457", "category": "EDUCATIONAL", "template": "If you wear a (insert noun) or (insert noun) with (insert noun) and a different (insert trait) (insert noun) then you have (insert result).", "exampleUrl": "https://www.instagram.com/reel/DG1XhISy7_f/?"}, {"id": "EDU_0458", "category": "EDUCATIONAL", "template": "Every (insert noun) explained in one sentence.", "exampleUrl": "https://www.instagram.com/reel/DD7Z0GWJrMB/?igsh=MXBlNjF0YzF5c2tobg=="}, {"id": "EDU_0459", "category": "EDUCATIONAL", "template": "If you keep failing your (insert noun), just figure out where you're failing it.", "exampleUrl": "https://www.instagram.com/reel/DCUAbdBB_k_/?igsh=MTh5bWNwcjMyaTkyeA=="}, {"id": "EDU_0460", "category": "EDUCATIONAL", "template": "How long does it take to complete the impossible mile.", "exampleUrl": "https://www.instagram.com/reel/DEtSZ28PQi1/?igsh=MWxvcmN6cHl0bWpoMg=="}, {"id": "EDU_0461", "category": "EDUCATIONAL", "template": "(insert noun) is believed to be super bad for us. Causing (insert symptom), (insert symptom), (insert symptom), and even (insert symptom).", "exampleUrl": "https://www.instagram.com/reel/DIMbDQhsNyG/?igsh=MTl5dmVrbmV1OWgzdg=="}, {"id": "EDU_0462", "category": "EDUCATIONAL", "template": "(insert noun) can make you go bald!", "exampleUrl": "https://www.instagram.com/reel/DFnnhxyvDzC/?igsh=YXUxOGhoazRnc28w"}, {"id": "EDU_0463", "category": "EDUCATIONAL", "template": "I\u2019ll tell you a story, We have # (insert noun) that were invented to solve 3 different problems.", "exampleUrl": "https://www.instagram.com/reel/DF9D6aCT4R2/?igsh=NnVucjM3OWhkNnFj"}, {"id": "EDU_0464", "category": "EDUCATIONAL", "template": "(insert industry) tier list for 2025.", "exampleUrl": "https://www.instagram.com/reel/DG1WCj0PIML/?igsh=MWlwZzcydTdpc2V2aQ=="}, {"id": "EDU_0465", "category": "EDUCATIONAL", "template": "How to start your (insert noun) from scratch.", "exampleUrl": "https://www.instagram.com/reel/DG1VtMUSQ9h/?igsh=dzE3b3FlbXZjc3R6"}, {"id": "EDU_0466", "category": "EDUCATIONAL", "template": "Exposing the only (insert noun) you will ever need.", "exampleUrl": "https://www.instagram.com/reel/DBXc7jiofht/?igsh=MTIzMGllaHVhcW5xNg=="}, {"id": "EDU_0467", "category": "EDUCATIONAL", "template": "How to dress like a (insert person).", "exampleUrl": "https://www.instagram.com/reel/DCRJoGbo3oa/?igsh=d3Mzc3E4MWF2d3M="}, {"id": "EDU_0468", "category": "EDUCATIONAL", "template": "Every (insert store type) has a million (insert noun) with different (insert noun). But some of them are more special than others.", "exampleUrl": "https://www.instagram.com/reel/DEabsX3pRsJ/?igsh=ZmlkZ3draG16OXJq"}, {"id": "EDU_0469", "category": "EDUCATIONAL", "template": "This is exactly how you and your friends are going to get (insert result) before this (insert time).", "exampleUrl": "https://www.instagram.com/reel/DId6_M-AwGL/?igsh=bW8zc212eTR0Y3V5"}, {"id": "EDU_0470", "category": "EDUCATIONAL", "template": "If you\u2019re afraid to (insert action), then (insert action).", "exampleUrl": "https://www.instagram.com/reel/DHEL0_cRwNA/?igsh=MTRsY2phZ3d0MzFmag=="}, {"id": "EDU_0471", "category": "EDUCATIONAL", "template": "If you want to start a (insert noun) in (insert year) here are some things you are going to need.", "exampleUrl": "https://www.instagram.com/reel/DEdSzXhzTEH/?igsh=cXI2MDcyd2ZobHVy"}, {"id": "EDU_0472", "category": "EDUCATIONAL", "template": "Putting you on brands you may have never heard of.", "exampleUrl": "https://www.instagram.com/reel/DIOvPayMKgS/?igsh=bGlzMGJ2YXJkdG50"}, {"id": "COM_0001", "category": "COMPARISON", "template": "This is an (insert noun), and this is an (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHiMzqvR_MQ/"}, {"id": "COM_0002", "category": "COMPARISON", "template": "This (insert noun) and this (insert noun) have the same amount of (insert noun).", "exampleUrl": "https://www.instagram.com/fitfoodieliving/reel/DBHpSdgRdvh/"}, {"id": "COM_0003", "category": "COMPARISON", "template": "A lot of people ask me what's better (insert option #1) or (insert option #2) for (insert dream result) I achieved (insert dream result) doing one of these and it's not even close.", "exampleUrl": "https://www.instagram.com/p/DHGn-H-xNeV/"}, {"id": "COM_0004", "category": "COMPARISON", "template": "For this (insert item) you could have all of these (insert item).", "exampleUrl": "https://www.instagram.com/reel/C27sCLIxGIu/"}, {"id": "COM_0005", "category": "COMPARISON", "template": "He/she always (insert action), and he/she does (insert action).", "exampleUrl": "https://www.instagram.com/reel/C9FQ-W1OJtc/"}, {"id": "COM_0006", "category": "COMPARISON", "template": "For this (insert noun), you could have all of (insert noun).", "exampleUrl": "https://www.instagram.com/alexgamblecoach/reel/C3r2FM5vhAH/"}, {"id": "COM_0007", "category": "COMPARISON", "template": "This (option #1) has (insert noun) in it, and (option #2) has (insert noun) in it.", "exampleUrl": "https://www.instagram.com/reel/DBTo-UctI9R/"}, {"id": "COM_0008", "category": "COMPARISON", "template": "This group didn't (insert action) and this group did.", "exampleUrl": "https://www.instagram.com/reel/C9wOIgSJZG1/?utm_source=ig_web_copy_link"}, {"id": "COM_0009", "category": "COMPARISON", "template": "For this (insert noun), you could have this whole (insert noun).", "exampleUrl": "https://www.instagram.com/noahperlofit/reel/C3dwIEGxeB0/"}, {"id": "COM_0010", "category": "COMPARISON", "template": "This is (insert metric) of (insert noun) for (insert price), and this is also (insert metric) of (insert noun) for (insert price).", "exampleUrl": "https://www.instagram.com/p/DCj8U4WJPmj/"}, {"id": "COM_0011", "category": "COMPARISON", "template": "How long would it take you to go from (insert before state) like this (with pain point) to (insert dream result) with (insert desire).", "exampleUrl": "https://www.instagram.com/share/BAFmRk0wS1"}, {"id": "COM_0012", "category": "COMPARISON", "template": "If you're between the ages # - # and you want to become (insert dream result) and I mean really (insert dream result). Then you have to do these # things.", "exampleUrl": "https://www.instagram.com/share/_o1hsHAQW"}, {"id": "COM_0013", "category": "COMPARISON", "template": "This (insert noun) has (insert metric) and will get you (insert dream result), and this (insert noun) has (insert metric) and will get you (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DC2OpMNJMG2/"}, {"id": "COM_0014", "category": "COMPARISON", "template": "One (insert noun), and # of my (insert noun) have the same (insert metric).", "exampleUrl": "https://www.instagram.com/p/DHCafPPxo3w/"}, {"id": "COM_0015", "category": "COMPARISON", "template": "This is a (insert noun) from (insert restaurant/store/place) for (insert metric), and this is the same (insert noun) from (insert restaurant/store/place) for (insert metric).", "exampleUrl": "https://www.instagram.com/p/DDP3euvJPC4/"}, {"id": "COM_0016", "category": "COMPARISON", "template": "This is a (insert noun), this is also a (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIYZKjtxK7Z/"}, {"id": "COM_0017", "category": "COMPARISON", "template": "This is (insert noun) before you (insert action), this is (insert noun) after you (insert action).", "exampleUrl": "https://www.instagram.com/p/DDfEcIyTncw/"}, {"id": "COM_0018", "category": "COMPARISON", "template": "These two groups (insert similar result) but this group (insert result).", "exampleUrl": "https://www.instagram.com/tombaileypt/reel/C9bg-usp89W/"}, {"id": "COM_0019", "category": "COMPARISON", "template": "The (insert noun) offers you a (option #1) and a (option #2) what do you choose?", "exampleUrl": "https://www.instagram.com/share/_-96Kqts3"}, {"id": "COM_0020", "category": "COMPARISON", "template": "(insert #) (insert noun) I would have this one if I was (insert verb), and I would have this one if I was (insert verb).", "exampleUrl": "https://www.instagram.com/p/DEyUjeIyn-w/"}, {"id": "COM_0021", "category": "COMPARISON", "template": "This is (insert noun) at (insert metric), and it's perfect for (insert verb). This is (insert noun) at (insert metric).", "exampleUrl": "https://www.instagram.com/p/DFckqW0T8cM/"}, {"id": "COM_0022", "category": "COMPARISON", "template": "This is (insert metric) of (insert noun), this is also (insert metric).", "exampleUrl": "https://www.instagram.com/p/DHGElSpPqeu/"}, {"id": "COM_0023", "category": "COMPARISON", "template": "(insert metric) and (insert metric) both sides are (insert adjective) and look the same. Let\u2019s see why.", "exampleUrl": "https://www.instagram.com/p/DIO0xJypZvT/"}, {"id": "COM_0024", "category": "COMPARISON", "template": "(insert result) (insert noun) vs. (insert result) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFOBiz0ptWc/"}, {"id": "COM_0025", "category": "COMPARISON", "template": "Both these (insert noun) are exactly the same. I have not changed a single (insert noun). But this one is (insert metic) and this one is (insert metric).", "exampleUrl": "https://www.instagram.com/p/DB67qDIih-2/"}, {"id": "COM_0026", "category": "COMPARISON", "template": "Would you feel more (insert trait) in this (insert noun) or this one?", "exampleUrl": "https://www.instagram.com/p/DGYr4vMKo3T/"}, {"id": "COM_0027", "category": "COMPARISON", "template": "Both groups gained the same amount of (insert noun). Expect this grouped (insert action) # days a week, and this group (insert action) #.", "exampleUrl": "https://www.instagram.com/reel/DCRDDUuC1YL/?igsh=eTA3eTV6OGt3dG5x"}, {"id": "COM_0028", "category": "COMPARISON", "template": "Cheap vs. Expensive (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DFXKXBaPyn0/?igsh=NDVuNG90bHNhOXY="}, {"id": "COM_0029", "category": "COMPARISON", "template": "You will (insert result) a week if you (insert action) on a (insert journey). But you will only (insert result) this much a week if you (insert action) on a (insert journey).", "exampleUrl": "https://www.instagram.com/reel/DG0qjQ7S-GD/?igsh=cndidHU3NXZwd282"}, {"id": "COM_0030", "category": "COMPARISON", "template": "This is what your (insert noun) looks like when you don\u2019t take (insert noun). And this is what your (insert noun) looks like when you take (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DIn291GI4Fa/?igsh=b294b3ZyMmx5bDJk"}, {"id": "COM_0031", "category": "COMPARISON", "template": "This is me after (insert action) in the (insert location) with (insert condition). And this is me just (insert action) in the middle of (insert location).", "exampleUrl": "https://www.instagram.com/reel/DDNgWJliAUR/?igsh=MW03ZndyNWo4bXlodA=="}, {"id": "MYT_0001", "category": "MYTH BUSTING", "template": "(insert item) (insert fact), (insert complete opposite item) (insert similar fact).", "exampleUrl": "https://www.instagram.com/reel/C_bBILMsNzh/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=="}, {"id": "MYT_0002", "category": "MYTH BUSTING", "template": "This is why doing (insert action) makes you (insert pain point).", "exampleUrl": "https://www.instagram.com/p/C8BpxhQNKCj/"}, {"id": "MYT_0003", "category": "MYTH BUSTING", "template": "This is how you (insert dream result) while (insert guilty pleasure).", "exampleUrl": "https://www.instagram.com/p/C3spnM9IOKG/"}, {"id": "MYT_0004", "category": "MYTH BUSTING", "template": "(insert item) (insert fact), (insert item) (insert similar fact), (insert complete opposite item) (insert similar fact).", "exampleUrl": "https://www.instagram.com/p/DDmz346s6x2/"}, {"id": "MYT_0005", "category": "MYTH BUSTING", "template": "If you're really a (insert dream result), why aren\u2019t you doing (insert common belief)?", "exampleUrl": "https://www.instagram.com/reel/DEPpiQkobO7/"}, {"id": "MYT_0006", "category": "MYTH BUSTING", "template": "Just because you do (insert action) doesn't make you a good (insert label).", "exampleUrl": "https://www.instagram.com/reel/DHrRQ2uv22F/"}, {"id": "MYT_0007", "category": "MYTH BUSTING", "template": "This is what (insert number) of (insert item) looks like.", "exampleUrl": "https://www.instagram.com/p/C60q1FPPrLW/"}, {"id": "MYT_0008", "category": "MYTH BUSTING", "template": "If you are (insert action) just once per (month/day/year) than you are f*ucked.", "exampleUrl": "https://www.instagram.com/reel/DAvjqruooP3/?igsh=cXcwcnAyMmo1ZTFv"}, {"id": "MYT_0009", "category": "MYTH BUSTING", "template": "This is me when I (insert action) (insert frequency), and this is me still (insert action) (insert frequency).", "exampleUrl": "https://www.instagram.com/p/DAmA1Wnqh4X/"}, {"id": "MYT_0010", "category": "MYTH BUSTING", "template": "No your (insert noun) is not cause (insert result).", "exampleUrl": "https://www.instagram.com/p/DCeVnXro9Xd/"}, {"id": "MYT_0011", "category": "MYTH BUSTING", "template": "Let me de-influence you from (insert action).", "exampleUrl": "https://www.instagram.com/reel/DEXaRPkOSjV/?igsh=MXYxZm05YzRzdXVyMg%3D%3D"}, {"id": "MYT_0012", "category": "MYTH BUSTING", "template": "More (insert target audience) need to hear this, (insert common belief) will not (insert result).", "exampleUrl": "https://www.instagram.com/reel/C_oaRbkuJaG/"}, {"id": "MYT_0013", "category": "MYTH BUSTING", "template": "It's time to throw away your (insert item), you don\u2019t need it anymore.", "exampleUrl": "https://www.instagram.com/reel/C6qt2B4NKA1/"}, {"id": "MYT_0014", "category": "MYTH BUSTING", "template": "They said, \u201c(insert famous clich\u00e9 or quote)\u201d That's a lie.", "exampleUrl": "https://www.instagram.com/reel/DDmm7AXxKLa/"}, {"id": "MYT_0015", "category": "MYTH BUSTING", "template": "Don't (insert action) until you've done this one thing.", "exampleUrl": "https://www.instagram.com/p/DA0kc0DCM0h/"}, {"id": "MYT_0016", "category": "MYTH BUSTING", "template": "Stop using (insert item) for (insert result).", "exampleUrl": "https://www.instagram.com/p/DBe3QaNyQEi/"}, {"id": "MYT_0017", "category": "MYTH BUSTING", "template": "You cannot be (insert dream result) before you enter (insert age group).", "exampleUrl": "https://www.instagram.com/p/DBROBQTK9De/"}, {"id": "MYT_0018", "category": "MYTH BUSTING", "template": "I stopped acting like the (insert person/title) in my life and you shouldn't be the (insert person/title) either.", "exampleUrl": "https://www.instagram.com/p/C9pwV7rPMVo//www.instagram.com/p/C-3m2q5pkLq/"}, {"id": "MYT_0019", "category": "MYTH BUSTING", "template": "Your life is boring because you don\u2019t (insert action).", "exampleUrl": "https://www.instagram.com/reel/DFAr9dPA4F4/?igsh=eWVxamg2eDF2cTBt"}, {"id": "MYT_0020", "category": "MYTH BUSTING", "template": "This is (insert large number) worth of (insert noun).", "exampleUrl": "https://www.instagram.com/georgiaheins/reel/C-QS"}, {"id": "MYT_0021", "category": "MYTH BUSTING", "template": "Just because you have never (insert action) before, doesn't make you a (insert label) person.", "exampleUrl": "https://www.instagram.com/p/DGb8XGgtwN5/"}, {"id": "MYT_0022", "category": "MYTH BUSTING", "template": "This is how we think we (insert pain point), but you would have to (insert action) on top of (insert action) # of times for that to happen.", "exampleUrl": "https://www.instagram.com/alexgamblecoach/reel/C9Zb1ZOP-Tl/"}, {"id": "MYT_0023", "category": "MYTH BUSTING", "template": "(Insert noun) is actually a really good (Insert noun) for (insert result).", "exampleUrl": "https://www.instagram.com/reel/C5yQUs6LQMM/?utm_source=ig_web_copy_link"}, {"id": "MYT_0024", "category": "MYTH BUSTING", "template": "# things I would never (insert action) in my (insert age range) if I wanted to (insert dream result) by (insert age range).", "exampleUrl": "https://www.instagram.com/share/BAGNNxOLAP"}, {"id": "MYT_0025", "category": "MYTH BUSTING", "template": "If you look in the mirror and notice (insert observation) here's what you do to (insert dream result).", "exampleUrl": "https://www.instagram.com/share/BAPOeL5mmh"}, {"id": "MYT_0026", "category": "MYTH BUSTING", "template": "I haven't done (insert common action) in over # years, and it's healed (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGTiPPMygzM/"}, {"id": "MYT_0027", "category": "MYTH BUSTING", "template": "(insert dream outcome) that don't taste/look like pure bootyhole.", "exampleUrl": "https://www.instagram.com/p/DG8lDUFoouT/"}, {"id": "MYT_0028", "category": "MYTH BUSTING", "template": "You are not (insert bad label), you are not (insert bad label), you just can't (insert adjective) .", "exampleUrl": "https://www.instagram.com/p/DBWFRQqO3Nt/"}, {"id": "MYT_0029", "category": "MYTH BUSTING", "template": "My biggest regret in (insert life event) was (insert accomplishment).", "exampleUrl": "https://www.instagram.com/p/C22y9caxGf6/"}, {"id": "MYT_0030", "category": "MYTH BUSTING", "template": "(insert action) I have never (insert action) before, to prove (insert action) is easy.", "exampleUrl": "https://www.instagram.com/p/DDh_Y0PzPi9/"}, {"id": "MYT_0031", "category": "MYTH BUSTING", "template": "For the price of this many (insert noun) at the (insert place/store/restaurant) you could make this many at home.", "exampleUrl": "https://www.instagram.com/p/DCKUo2tSsBe/"}, {"id": "MYT_0032", "category": "MYTH BUSTING", "template": "If you (insert action) this (insert noun) then yes i'm judging you.", "exampleUrl": "https://www.instagram.com/p/DIKYWrVpgp4/"}, {"id": "MYT_0033", "category": "MYTH BUSTING", "template": "You are (insert action) too many (insert noun) that you didn't know.", "exampleUrl": "https://www.instagram.com/p/DHzxZ28x4KX/"}, {"id": "MYT_0034", "category": "MYTH BUSTING", "template": "I have never met a single person that (insert action), (insert action), (insert action), (insert action), and still has time to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/C84rOEixNKS/"}, {"id": "MYT_0035", "category": "MYTH BUSTING", "template": "(insert well known person or brand) is trying to get this video removed from the internet because he/she exposes their product for being (insert negative result). Watch this now before it's gone.", "exampleUrl": "https://www.instagram.com/p/DB7OnuqSYBr/"}, {"id": "MYT_0036", "category": "MYTH BUSTING", "template": "What if I told you making your own (insert noun) is actually super easy and only costs (insert price).", "exampleUrl": "https://www.instagram.com/p/DH1SDq_qBny/"}, {"id": "MYT_0037", "category": "MYTH BUSTING", "template": "I said it before and I am going to say it again (insert mind blowing fact).", "exampleUrl": "https://www.instagram.com/p/DDFJKmqozH6/"}, {"id": "MYT_0038", "category": "MYTH BUSTING", "template": "There is absolutely no reason for you to be (insert pain point) every single day just because you are trying to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DHaw56FzsOe/"}, {"id": "MYT_0039", "category": "MYTH BUSTING", "template": "Don\u2019t make the mistake of (insert action), (insert action), (insert action).", "exampleUrl": "https://www.instagram.com/p/DIFEWODyeM0/"}, {"id": "MYT_0040", "category": "MYTH BUSTING", "template": "You are not bad at (insert action), you probably were just never taught how to (insert action).", "exampleUrl": "https://www.instagram.com/p/DHYuMQYp0Kv/"}, {"id": "MYT_0041", "category": "MYTH BUSTING", "template": "If you\u2019re a young (insert person) and you are a (insert result) (insert title), let me tell you something you got a bright future buddy.", "exampleUrl": "https://www.instagram.com/p/DIfDhHqTlkW/"}, {"id": "MYT_0042", "category": "MYTH BUSTING", "template": "I can\u2019t (insert verb) (insert noun) anymore.", "exampleUrl": "https://www.instagram.com/p/DIyeda6xw9w/"}, {"id": "MYT_0043", "category": "MYTH BUSTING", "template": "Believe it or not this (insert noun) was not (insert verb) with a (insert noun).", "exampleUrl": "https://www.instagram.com/p/C2SNZy0gL-x/"}, {"id": "MYT_0044", "category": "MYTH BUSTING", "template": "(insert noun) are not (insert adjective) and they are not a cop-out. I think they can actually be made into something really really (insert adjective).", "exampleUrl": "https://www.instagram.com/p/DHRsoELBphP/"}, {"id": "MYT_0045", "category": "MYTH BUSTING", "template": "If your (insert noun) are not lasting you at least (insert time frame) you are probably doing them wrong.", "exampleUrl": "https://www.instagram.com/p/DETLyaexWaQ/"}, {"id": "MYT_0046", "category": "MYTH BUSTING", "template": "This is why you should always (insert verb) your (insert noun) before (insert verb).", "exampleUrl": "https://www.instagram.com/p/DHU2-6vxXxm/"}, {"id": "MYT_0047", "category": "MYTH BUSTING", "template": "You're using your (insert noun) wrong and I am going to show you how to use it the right way.", "exampleUrl": "https://www.instagram.com/p/DIOwnaJJ976/"}, {"id": "MYT_0048", "category": "MYTH BUSTING", "template": "Everyone on the internet is going to tell you making (insert noun) is impossible. But I am going to show you how to make them from home.", "exampleUrl": "https://www.instagram.com/p/DF6K0b0Rt9b/"}, {"id": "MYT_0049", "category": "MYTH BUSTING", "template": "I will let you in on a secret (insert verb) is the easiest thing in the world.", "exampleUrl": "https://www.instagram.com/p/DDHW7loz2jm/"}, {"id": "MYT_0050", "category": "MYTH BUSTING", "template": "Are you still (insert verb) (insert noun) like this? While I worked at (insert noun) and let me show you how to do it like a pro.", "exampleUrl": "https://www.instagram.com/p/DGdz4nPSXvz/"}, {"id": "MYT_0051", "category": "MYTH BUSTING", "template": "Instead of (insert verb) (insert noun) like this, try this method instead.", "exampleUrl": "https://www.instagram.com/p/DH9gry2heFS/"}, {"id": "MYT_0052", "category": "MYTH BUSTING", "template": "(insert verb) does not mean your (insert adjective), it means your just (insert adjective).", "exampleUrl": "https://www.instagram.com/p/DAw01riSVei/"}, {"id": "MYT_0053", "category": "MYTH BUSTING", "template": "If you (insert action) like this, then you're doing it wrong.", "exampleUrl": "https://www.instagram.com/p/DHcv_7uBv1p/"}, {"id": "MYT_0054", "category": "MYTH BUSTING", "template": "I am going to hold you hand while I tell you this. If you only have # of (insert noun) you are not doing it the right way.", "exampleUrl": "https://www.instagram.com/p/DCZ9dK9Jjlw/"}, {"id": "MYT_0055", "category": "MYTH BUSTING", "template": "# things you should never put in your (insert noun).", "exampleUrl": "https://www.instagram.com/p/DDxoAs_TciE/"}, {"id": "MYT_0056", "category": "MYTH BUSTING", "template": "(insert noun) are not as disgusting as you think.", "exampleUrl": "https://www.instagram.com/reel/DHBslKRvZ7_/?igsh=MW83azY5b2s2YTEzag=="}, {"id": "MYT_0057", "category": "MYTH BUSTING", "template": "(insert noun) is better for (insert result) than (insert noun). And yes I am going to back up my claim with studies.", "exampleUrl": "https://www.instagram.com/reel/DFYHUihoaFK/?igsh=MXF3ZDZ2dmRwZmZpeA=="}, {"id": "MYT_0058", "category": "MYTH BUSTING", "template": "Being (insert result) is not just based on (insert noun). You may not believe this but I could have been (insert adjective) then this guy/girl if I had just changed a few things.", "exampleUrl": "https://www.instagram.com/reel/DH2VMvQNFXc/?igsh=MTNrejltdnZ3YW94eg%3D%3D"}, {"id": "STO_0001", "category": "STORYTELLING", "template": "I started my (insert business) when I was (insert age) with (insert $).", "exampleUrl": "https://www.instagram.com/p/C9GHw6MO48j/"}, {"id": "STO_0002", "category": "STORYTELLING", "template": "X years ago my (insert person) told me (insert quote).", "exampleUrl": "https://www.instagram.com/p/C84meBcM9NB/"}, {"id": "STO_0003", "category": "STORYTELLING", "template": "I have (insert time) to get my sh*t together.", "exampleUrl": "https://www.instagram.com/reel/C79z4euRhlV/"}, {"id": "STO_0004", "category": "STORYTELLING", "template": "I don\u2019t have a backup plan so this kind of needs to work.", "exampleUrl": "https://www.instagram.com/p/C7XpT7tPwCP/"}, {"id": "STO_0005", "category": "STORYTELLING", "template": "This is how my (insert event/item/result) changed my life.", "exampleUrl": "https://www.instagram.com/p/C9t1s7myhI7/"}, {"id": "STO_0006", "category": "STORYTELLING", "template": "So about a month ago my (insert person) and I did (insert action).", "exampleUrl": "https://www.instagram.com/p/DImqKRqy4xr/"}, {"id": "STO_0007", "category": "STORYTELLING", "template": "I have (insert action) over (insert #) in my life.", "exampleUrl": "https://www.instagram.com/p/C9GM_SJpJ3k/"}, {"id": "STO_0008", "category": "STORYTELLING", "template": "This is a picture of my (insert what picture is).", "exampleUrl": "https://www.instagram.com/reel/C_njKwBOuLi/"}, {"id": "STO_0009", "category": "STORYTELLING", "template": "X years ago I decided to (insert decision).", "exampleUrl": "https://www.instagram.com/p/C-IOTqUtbth/"}, {"id": "STO_0010", "category": "STORYTELLING", "template": "Yesterday I was at (insert location) when I noticed something (insert adjective).", "exampleUrl": "https://www.instagram.com/reel/DFLw3SmSNti/"}, {"id": "STO_0011", "category": "STORYTELLING", "template": "X years ago I was (insert action) because I (insert pain", "exampleUrl": "https://www.instagram.com/reel/DEq8rUQyR92/"}, {"id": "STO_0012", "category": "STORYTELLING", "template": "Is it possible to (insert action) while (insert action) in X days.", "exampleUrl": "https://www.instagram.com/reel/DEgmPM_yqsz/"}, {"id": "STO_0013", "category": "STORYTELLING", "template": "When is it time to do (insert action).", "exampleUrl": "https://www.instagram.com/reel/DDrwl5ix3a0/?igsh=MW14dGUybG5rYnhxdQ=="}, {"id": "STO_0014", "category": "STORYTELLING", "template": "So I did (insert action) last week.", "exampleUrl": "https://www.instagram.com/share/BAIu4m7QIH"}, {"id": "STO_0015", "category": "STORYTELLING", "template": "When I was (insert description) I was always (insert bad habit).", "exampleUrl": "https://www.instagram.com/p/CzevtHvyxxX/"}, {"id": "STO_0016", "category": "STORYTELLING", "template": "If you are anything like me, you take your (insert event/item) very seriously.", "exampleUrl": "https://www.instagram.com/p/DBnbVTMSaJb/"}, {"id": "STO_0017", "category": "STORYTELLING", "template": "In (insert time), I went from (insert before state) to (insert after state).", "exampleUrl": "https://www.instagram.com/reel/DFfnKFWusVf/?igsh=MXE1d3ZybnJ6eXIwZg=="}, {"id": "STO_0018", "category": "STORYTELLING", "template": "X years ago we (insert action) to (insert result).", "exampleUrl": "https://www.instagram.com/p/C_ZVKRfSMm_/"}, {"id": "STO_0019", "category": "STORYTELLING", "template": "Hi I am (insert first name) and I am starting (insert business) from scratch.", "exampleUrl": "https://www.instagram.com/reel/DDEBm2jOYMG/?igsh=cXl6cjNwc3pnajF4"}, {"id": "STO_0020", "category": "STORYTELLING", "template": "This is the story of how I managed to do (insert achievement).", "exampleUrl": "https://www.instagram.com/reel/DCg1__Wsy7F/?igsh=ZGhrM3B5eTVrZzht"}, {"id": "STO_0021", "category": "STORYTELLING", "template": "I am (insert age) having an identity crisis.", "exampleUrl": "https://www.instagram.com/reel/DDJM-ivP9-v/?igsh=ZDh0bG51azdpMDc0"}, {"id": "STO_0022", "category": "STORYTELLING", "template": "(# days/months/years) ago I quit (insert thing).", "exampleUrl": "https://www.instagram.com/reel/C-5yJQmoPsM/?igsh=ejRheHR1ODg4NW83"}, {"id": "STO_0023", "category": "STORYTELLING", "template": "This is probably the scariest thing I have ever done.", "exampleUrl": "https://www.instagram.com/reel/DAYtnokvm-J/?igsh=dmN0ZTNudGtodGpr"}, {"id": "STO_0024", "category": "STORYTELLING", "template": "This girl/boy was in her/his flop era.", "exampleUrl": "https://www.instagram.com/reel/DAOowDot7OB/?igsh=MW9ibGhiNHhsZjRweg%3D%3D"}, {"id": "STO_0025", "category": "STORYTELLING", "template": "Is it possible for (insert description) to make (insert $) a month?", "exampleUrl": "https://www.instagram.com/reel/DFkNykWxPoe/?igsh=OXQ0ODJkcmlpeml0"}, {"id": "STO_0026", "category": "STORYTELLING", "template": "I did everything right.", "exampleUrl": "https://www.instagram.com/p/DDohj4MI-7U/"}, {"id": "STO_0027", "category": "STORYTELLING", "template": "So I recently started feeling \"the pressure\" everyone talks about.", "exampleUrl": "https://www.instagram.com/reel/C9KNzOkIk6m/?igsh=MTAzOGQ1Zm53OXNjaw%3D%3D"}, {"id": "STO_0028", "category": "STORYTELLING", "template": "Can you (insert dream result) after (insert shortcut).", "exampleUrl": "https://www.instagram.com/reel/C6uGU4xxKV_/"}, {"id": "STO_0029", "category": "STORYTELLING", "template": "After X years of I (insert action) because I realized one thing: (insert statement).", "exampleUrl": "https://www.instagram.com/reel/DEJiasASTVx/"}, {"id": "STO_0030", "category": "STORYTELLING", "template": "It all started when (insert person) (insert action).", "exampleUrl": "https://www.instagram.com/p/DC5ioSRMrnS/"}, {"id": "STO_0031", "category": "STORYTELLING", "template": "X years ago (insert people) (insert action).", "exampleUrl": "https://www.instagram.com/p/C_50kObxUwc/"}, {"id": "STO_0032", "category": "STORYTELLING", "template": "I'm (insert action) in (insert time) and I just (insert action).", "exampleUrl": "https://www.instagram.com/p/DFf7WpdREbp/"}, {"id": "STO_0033", "category": "STORYTELLING", "template": "1 Year Ago today, I ___.", "exampleUrl": "https://www.instagram.com/reel/DDvdqxIJcbe/?igsh=MWZxZDI1Z25vcnlibw%3D%3D"}, {"id": "STO_0034", "category": "STORYTELLING", "template": "I'm (insert age) and I'm not ashamed to admit that >>", "exampleUrl": "https://www.instagram.com/reel/DFOqo61NrJu/?igsh=MnIyNnFrczB0aDBx"}, {"id": "STO_0035", "category": "STORYTELLING", "template": "When I (insert action), people said (insert feedback).", "exampleUrl": "https://www.instagram.com/reel/DEj-ntbyxb_/?igsh=MW8xdjFpYWRtc2hmdQ=="}, {"id": "STO_0036", "category": "STORYTELLING", "template": "X days/weeks/months/years into my (insert action), my worst nightmare became my reality.", "exampleUrl": "https://www.instagram.com/p/DETO9Z0u5cN/"}, {"id": "STO_0037", "category": "STORYTELLING", "template": "It all started when this boy/girl, (insert action).", "exampleUrl": "https://www.instagram.com/p/DC5ioSRMrnS/"}, {"id": "STO_0038", "category": "STORYTELLING", "template": "X days/weeks/months ago my (insert person) and I (insert action), (insert action), and (insert action) this is how it's going.", "exampleUrl": "https://www.instagram.com/p/C_50kObxUwc/"}, {"id": "STO_0039", "category": "STORYTELLING", "template": "I started my (insert business) when I was (insert age) with (insert $)", "exampleUrl": "https://www.instagram.com/p/C9GHw6MO48j/"}, {"id": "STO_0040", "category": "STORYTELLING", "template": "X days/months/years ago my (insert person) told me (insert statement)", "exampleUrl": "https://www.instagram.com/p/C84meBcM9NB/"}, {"id": "STO_0041", "category": "STORYTELLING", "template": "When I (insert action), people said (insert feedback)", "exampleUrl": "https://www.instagram.com/reel/DEj-ntbyxb_/?igsh=MW8xdjFpYWRtc2hmdQ=="}, {"id": "STO_0042", "category": "STORYTELLING", "template": "I woke up this morning thinking about (insert thought)", "exampleUrl": "https://www.instagram.com/reel/DEtoEgJSVhy/"}, {"id": "STO_0043", "category": "STORYTELLING", "template": "X days/months/years I (insert life event) and decided to quit (insert bad habit)", "exampleUrl": "https://www.instagram.com/reel/DEd9AFGydqg/"}, {"id": "STO_0044", "category": "STORYTELLING", "template": "X days/months/years I started (insert action) again after being stuck at (insert pain point)", "exampleUrl": "https://www.instagram.com/reel/DEUEvFzyL_o/"}, {"id": "STO_0045", "category": "STORYTELLING", "template": "X days/months/years I started (insert action) thinking it would magically solve (insert pain point) but here is what ended up happening", "exampleUrl": "https://www.instagram.com/reel/DDY83YuSJ-9/"}, {"id": "STO_0046", "category": "STORYTELLING", "template": "I am an X year old (insert occupation) from (insert location) and I just (insert action)", "exampleUrl": "https://www.instagram.com/reel/DDWIHZESamL/"}, {"id": "STO_0047", "category": "STORYTELLING", "template": "I don\u2019t have a backup plan so this kind of needs to work\u2026", "exampleUrl": "https://www.instagram.com/p/C7XpT7tPwCP/"}, {"id": "STO_0048", "category": "STORYTELLING", "template": "This is how my X changed my life", "exampleUrl": "https://www.instagram.com/p/C9t1s7myhI7/"}, {"id": "STO_0049", "category": "STORYTELLING", "template": "I have (insert action) over (insert #) in my life", "exampleUrl": "https://www.instagram.com/p/C9GM_SJpJ3k/"}, {"id": "STO_0050", "category": "STORYTELLING", "template": "This is a picture of my (insert what picture is of)", "exampleUrl": "https://www.instagram.com/reel/C_njKwBOuLi/"}, {"id": "STO_0051", "category": "STORYTELLING", "template": "X days/months/years ago I decided to (insert decision)", "exampleUrl": "https://www.instagram.com/p/C-IOTqUtbth/"}, {"id": "STO_0052", "category": "STORYTELLING", "template": "Yesterday I was at (insert location) when I noticed something (insert adjective)", "exampleUrl": "https://www.instagram.com/reel/DFLw3SmSNti/"}, {"id": "STO_0053", "category": "STORYTELLING", "template": "X days/months/years ago I was (insert action) because I (insert pain point)", "exampleUrl": "https://www.instagram.com/reel/DEq8rUQyR92/"}, {"id": "STO_0054", "category": "STORYTELLING", "template": "Is it possible to (insert dream result) while (insert action) in X days", "exampleUrl": "https://www.instagram.com/reel/DEgmPM_yqsz/"}, {"id": "STO_0055", "category": "STORYTELLING", "template": "When is it time to do (insert action)", "exampleUrl": "https://www.instagram.com/reel/DDrwl5ix3a0/?igsh=MW14dGUybG5rYnhxdQ=="}, {"id": "STO_0056", "category": "STORYTELLING", "template": "So I did (insert action) last week", "exampleUrl": "https://www.instagram.com/share/BAIu4m7QIH"}, {"id": "STO_0057", "category": "STORYTELLING", "template": "When I was (insert description) I was always (insert bad habit)", "exampleUrl": "https://www.instagram.com/p/CzevtHvyxxX/"}, {"id": "STO_0058", "category": "STORYTELLING", "template": "If you are anything like me, you take your (insert action) very seriously", "exampleUrl": "https://www.instagram.com/p/DBnbVTMSaJb/"}, {"id": "STO_0059", "category": "STORYTELLING", "template": "In (insert time frame), I went from (insert before) to (insert dream result)", "exampleUrl": "https://www.instagram.com/reel/DFfnKFWusVf/?igsh=MXE1d3ZybnJ6eXIwZg=="}, {"id": "STO_0060", "category": "STORYTELLING", "template": "X days/months/years I (insert big risk)", "exampleUrl": "https://www.instagram.com/p/C_ZVKRfSMm_/"}, {"id": "STO_0061", "category": "STORYTELLING", "template": "I am starting/started a (insert business) from scratch", "exampleUrl": "https://www.instagram.com/reel/DDEBm2jOYMG/?igsh=cXl6cjNwc3pnajF4"}, {"id": "STO_0062", "category": "STORYTELLING", "template": "This is the story of how I managed to do (insert achievement)", "exampleUrl": "https://www.instagram.com/reel/DCg1__Wsy7F/?igsh=ZGhrM3B5eTVrZzht"}, {"id": "STO_0063", "category": "STORYTELLING", "template": "I am (insert age) having an identity crisis", "exampleUrl": "https://www.instagram.com/reel/DDJM-ivP9-v/?igsh=ZDh0bG51azdpMDc0"}, {"id": "STO_0064", "category": "STORYTELLING", "template": "X days/months/years ago I quit (insert habit)", "exampleUrl": "https://www.instagram.com/reel/C-5yJQmoPsM/?igsh=ejRheHR1ODg4NW83"}, {"id": "STO_0065", "category": "STORYTELLING", "template": "X days/months/years ago I stopped (insert action/or habit) and started (insert action/or habit)", "exampleUrl": "https://www.instagram.com/reel/DDvdqxIJcbe/"}, {"id": "STO_0066", "category": "STORYTELLING", "template": "This is probably the scariest thing I have ever done", "exampleUrl": "https://www.instagram.com/reel/DAYtnokvm-J/?igsh=dmN0ZTNudGtodGpr"}, {"id": "STO_0067", "category": "STORYTELLING", "template": "This girl/boy was in her/his flop era", "exampleUrl": "https://www.instagram.com/reel/DAOowDot7OB/?igsh=MW9ibGhiNHhsZjRweg%3D%3D"}, {"id": "STO_0068", "category": "STORYTELLING", "template": "Is it possible for (insert avatar) to (insert dream result)?", "exampleUrl": "https://www.instagram.com/reel/DFkNykWxPoe/?igsh=OXQ0ODJkcmlpeml0"}, {"id": "STO_0069", "category": "STORYTELLING", "template": "I did everything right/wrong", "exampleUrl": "https://www.instagram.com/p/DDohj4MI-7U/"}, {"id": "STO_0070", "category": "STORYTELLING", "template": "So I recently started feeling (insert feeling) everyone talks about", "exampleUrl": "https://www.instagram.com/reel/C9KNzOkIk6m/?igsh=MTAzOGQ1Zm53OXNjaw%3D%3D"}, {"id": "STO_0071", "category": "STORYTELLING", "template": "Can you (insert dream result) after (insert shortcut)", "exampleUrl": "https://www.instagram.com/reel/C6uGU4xxKV_/"}, {"id": "STO_0072", "category": "STORYTELLING", "template": "After X years of (insert action/or habit) I stopped/started (insert action/or habit)", "exampleUrl": "https://www.instagram.com/reel/DEJiasASTVx/"}, {"id": "STO_0073", "category": "STORYTELLING", "template": "It all started when (insert person) (insert action)", "exampleUrl": "https://www.instagram.com/p/DC5ioSRMrnS/"}, {"id": "STO_0074", "category": "STORYTELLING", "template": "X days/months/years ago (insert people) (insert action)", "exampleUrl": "https://www.instagram.com/p/C_50kObxUwc/"}, {"id": "STO_0075", "category": "STORYTELLING", "template": "X days/months/years, I ___", "exampleUrl": "https://www.instagram.com/reel/DDvdqxIJcbe/"}, {"id": "STO_0076", "category": "STORYTELLING", "template": "I'm (insert age) and I'm not ashamed to admit that", "exampleUrl": "https://www.instagram.com/reel/DFOqo61NrJu/?igsh=MnIyNnFrczB0aDBx"}, {"id": "STO_0077", "category": "STORYTELLING", "template": "The secret is out I am (insert action)", "exampleUrl": "https://www.instagram.com/p/C97orJ_J8vW/"}, {"id": "STO_0078", "category": "STORYTELLING", "template": "I got (insert dream result) without (pain point/points) here\u2019s how", "exampleUrl": "https://www.instagram.com/p/C6G56RQrf9N/"}, {"id": "STO_0079", "category": "STORYTELLING", "template": "So I (insert shocking action) for over (insert time frame)", "exampleUrl": "https://www.instagram.com/reel/C94_dh1JEeE/"}, {"id": "STO_0080", "category": "STORYTELLING", "template": "So I messed up", "exampleUrl": "https://www.instagram.com/reel/DD9yJvGRdoO/"}, {"id": "STO_0081", "category": "STORYTELLING", "template": "I developed an X addiction so strong I physically can not stop (insert action)", "exampleUrl": "https://www.instagram.com/reel/C-CPzwMReyb/?igsh=MXBiYmdmc3dudm5vcg%3D%3D"}, {"id": "STO_0082", "category": "STORYTELLING", "template": "X years it took me from (insert bad situation/result) to (insert good situation/result)", "exampleUrl": "https://www.instagram.com/p/C8Cpii4PB1u/"}, {"id": "STO_0083", "category": "STORYTELLING", "template": "X Months/Years ago I (insert action) to (insert action)", "exampleUrl": "https://www.instagram.com/reel/DFJCpPYTtxw"}, {"id": "STO_0084", "category": "STORYTELLING", "template": "I (insert action)", "exampleUrl": "https://www.instagram.com/reel/DEVd9n0SEG"}, {"id": "STO_0085", "category": "STORYTELLING", "template": "There is nothing more embarrassing than X", "exampleUrl": "https://www.instagram.com/reel/C_s9nCBvHTE"}, {"id": "STO_0086", "category": "STORYTELLING", "template": "I am a (insert title) by day and a (insert title) by night", "exampleUrl": "https://www.instagram.com/reel/DDxlpp3yLup/?igsh=MXZzNThxN2F2ZTUzcQ=="}, {"id": "STO_0087", "category": "STORYTELLING", "template": "Come with me to make (insert object)", "exampleUrl": "https://www.instagram.com/p/DA8icSZuuX7/"}, {"id": "STO_0088", "category": "STORYTELLING", "template": "Come with me to break up with (insert object/company/etc)", "exampleUrl": "https://www.instagram.com/reel/DGDiMQMvslT/?igsh=MXc0aTdxMXc2bjVmaA=="}, {"id": "STO_0089", "category": "STORYTELLING", "template": "I started (insert business) at (age/life event) and I had no idea I would (insert result/outcome)", "exampleUrl": "https://www.instagram.com/reel/C_oKE1BJZnw/?igsh=MTk4ZWJ0dnVycmNrbw%3D%3D"}, {"id": "STO_0090", "category": "STORYTELLING", "template": "You know the feminine urge to open (insert business)", "exampleUrl": "https://www.instagram.com/p/DChR0akynLv/"}, {"id": "STO_0091", "category": "STORYTELLING", "template": "It\u2019s been (insert time) since we (insert experience)", "exampleUrl": "https://www.instagram.com/reel/DFbFikLNj5c/?igsh=MTBjbnRla2Fsc25zcQ%3D%3D"}, {"id": "STO_0092", "category": "STORYTELLING", "template": "I think (insert belief/opinion) so I have been taking matters into my own hands", "exampleUrl": "https://www.instagram.com/reel/DFq4B3uSYSh/?igsh=ejd2bXM1bTFpZ2ll"}, {"id": "STO_0093", "category": "STORYTELLING", "template": "I was shocked when I found out (insert fact)", "exampleUrl": "https://www.instagram.com/reel/DCz5caZymCk/?igsh=MXVzeGkxc2U1YWl2dQ%3D%3D"}, {"id": "STO_0094", "category": "STORYTELLING", "template": "So I just turned (insert age)", "exampleUrl": "https://www.instagram.com/reel/DAfc0ZsRA_f/?igsh=MWFuZDRremIxN2VnOA=="}, {"id": "STO_0095", "category": "STORYTELLING", "template": "This is how I got to (insert cool opportunity) in my X week/month/year of doing/starting (insert business or job)", "exampleUrl": "https://www.instagram.com/reel/DD36juzzvlO/?igsh=MWt0a2FsdWdlbTNwcA%3D%3D"}, {"id": "STO_0096", "category": "STORYTELLING", "template": "What happens when you (insert action) then you end up (insert result) but you (insert challenge)", "exampleUrl": "https://www.instagram.com/reel/DEIty1ju6EF/?igsh=MWdqemN4bHFxeXFzcg%3D%3D"}, {"id": "STO_0097", "category": "STORYTELLING", "template": "What if I told you that (insert dream result) without (insert pain point)", "exampleUrl": "https://www.instagram.com/reel/DDpTqOovShl/?igsh=MjlxanprY2Z1NWsw"}, {"id": "STO_0098", "category": "STORYTELLING", "template": "I went on # of (insert noun) this year, and here is the one trait I learned that you need to have to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DG7b8SAMjNJ/"}, {"id": "STO_0099", "category": "STORYTELLING", "template": "X days/months/years ago I was (insert action), every waking hour because I was (insert trait) and I wanted (insert result).", "exampleUrl": "https://www.instagram.com/reel/DFUgKb4RGlI/"}, {"id": "STO_0100", "category": "STORYTELLING", "template": "X days/months/years ago I was (insert life event), because I was (insert action) instead of (insert action).", "exampleUrl": "https://www.instagram.com/reel/DFuMWtZSSEx/"}, {"id": "STO_0101", "category": "STORYTELLING", "template": "This is (insert person) we have known each other from X years, X days, X hours, X minutes.", "exampleUrl": "https://www.instagram.com/p/DHyp6wPiRgc/"}, {"id": "STO_0102", "category": "STORYTELLING", "template": "Put a finger down if you told the entire internet you were going to create a (insert noun) without having any idea how to (insert action) or any idea how to start?", "exampleUrl": "https://www.instagram.com/p/DGixMnEJ5l3/"}, {"id": "STO_0103", "category": "STORYTELLING", "template": "I think (insert noun) should be better than this, so i;ve been taking matters into my own hands.", "exampleUrl": "https://www.instagram.com/reel/DFq4B3uSYSh/"}, {"id": "STO_0104", "category": "STORYTELLING", "template": "This is me (insert life state), yes my (insert observation) all my (insert persons) were (insert action) but I couldn't because I had to (insert scenario)", "exampleUrl": "https://www.instagram.com/p/DAjykz5uqk3/"}, {"id": "STO_0105", "category": "STORYTELLING", "template": "I used to be in a super toxic relationship back in (insert time frame) so let me tell you about it.", "exampleUrl": "https://www.instagram.com/p/DDsiifAu14W/"}, {"id": "STO_0106", "category": "STORYTELLING", "template": "How I married my middle school/highschool/college girlfriend/boyfriend.", "exampleUrl": "https://www.instagram.com/p/DCcFOykRggl/"}, {"id": "STO_0107", "category": "STORYTELLING", "template": "(insert person) always expects you to have (insert result) but the problem is\u2026.", "exampleUrl": "https://www.instagram.com/p/C_0whsRP2Op/"}, {"id": "STO_0108", "category": "STORYTELLING", "template": "My (insert label) (insert name) and I, started (insert business) in (insert year).", "exampleUrl": "https://www.instagram.com/p/DFtp0PRuorw/"}, {"id": "STO_0109", "category": "STORYTELLING", "template": "X days/months/years ago my (insert label) (insert name) and I (insert action) to (insert result).", "exampleUrl": "https://www.instagram.com/p/DBkmeBPvd7b/"}, {"id": "STO_0110", "category": "STORYTELLING", "template": "You are not (insert label) is something I wish I could have told my younger self.", "exampleUrl": "https://www.instagram.com/p/DGQrQ7LvWlV/"}, {"id": "STO_0111", "category": "STORYTELLING", "template": "Is it possible to get (insert dream result) with only (insert action) for only 1 day.", "exampleUrl": "https://www.instagram.com/p/DDTjr8rxAjO/"}, {"id": "STO_0112", "category": "STORYTELLING", "template": "I have no idea what I am doing at (insert place).", "exampleUrl": "https://www.instagram.com/p/DF-ubrfxnVV/"}, {"id": "STO_0113", "category": "STORYTELLING", "template": "I got (insert result) at (insert age) and (insert result) by (insert age) if you are scared about (insert result) this is for you.", "exampleUrl": "https://www.instagram.com/p/DF9aqV_JPlA/"}, {"id": "STO_0114", "category": "STORYTELLING", "template": "Is it possible to (insert action) successful (insert noun) for (insert noun) in just 1 hour?", "exampleUrl": "https://www.instagram.com/p/C9ARkyWMR8C/"}, {"id": "STO_0115", "category": "STORYTELLING", "template": "(insert year) - I think I am going to (insert goal).", "exampleUrl": "https://www.instagram.com/p/DDP5UpoR9Sl/"}, {"id": "STO_0116", "category": "STORYTELLING", "template": "So I bought this (insert noun) last week and quickly realized I have no idea how to (insert action).", "exampleUrl": "https://www.instagram.com/share/BAE6C2ZZ78"}, {"id": "STO_0117", "category": "STORYTELLING", "template": "X days/months/years ago I bought a (insert noun) as a (insert age) with a full-time (insert job).", "exampleUrl": "https://www.instagram.com/share/_tH1dbAEq"}, {"id": "STO_0118", "category": "STORYTELLING", "template": "We (insert action) over # of the most (insert adjective) (insert profession) and # responded.", "exampleUrl": "https://www.instagram.com/reel/DEOUKcLPUZe/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWF"}, {"id": "STO_0119", "category": "STORYTELLING", "template": "I hate to say this but my wake up call wasn't as (insert scenario) no my first wake up call was (insert scenario).", "exampleUrl": "https://www.instagram.com/share/BAJjwss1-k"}, {"id": "STO_0120", "category": "STORYTELLING", "template": "Is it possible to get (insert dream result) without your daddy being the CEO of apple.", "exampleUrl": "https://www.instagram.com/share/_58N3lM2x"}, {"id": "STO_0121", "category": "STORYTELLING", "template": "If you're new to this channel let me catch you up.", "exampleUrl": "https://www.instagram.com/p/DFsxrUWI7EY/"}, {"id": "STO_0122", "category": "STORYTELLING", "template": "The worst part about being a (insert title) is I literally do not\u2026", "exampleUrl": "https://www.instagram.com/p/DDV2GYxpnmu/"}, {"id": "STO_0123", "category": "STORYTELLING", "template": "Living in a (insert adjective) household has led me to literally having (insert bad result).", "exampleUrl": "https://www.instagram.com/p/DFqJbiIqCCH/"}, {"id": "STO_0124", "category": "STORYTELLING", "template": "Nothing could have prepared me for how it feels being in your (insert age group) and (insert situation).", "exampleUrl": "https://www.instagram.com/p/DCPdQiGoOoz/"}, {"id": "STO_0125", "category": "STORYTELLING", "template": "So apparently your frontal lobe does not develop fully until your age 25, so here are some things I have realized since it came in.", "exampleUrl": "https://www.instagram.com/p/DGllUMjIMY3/"}, {"id": "STO_0126", "category": "STORYTELLING", "template": "I tried a # hour (insert noun) routine, which is much harder than you think.", "exampleUrl": "https://www.instagram.com/p/DH8wOG0Ke0a/"}, {"id": "STO_0127", "category": "STORYTELLING", "template": "You think you're a (insert label)? Well let me introduce you to my life.", "exampleUrl": "https://www.instagram.com/p/DHoAC5HtwCn/"}, {"id": "STO_0128", "category": "STORYTELLING", "template": "My (insert person) and I tried a whole (insert time frame) without (insert action).", "exampleUrl": "https://www.instagram.com/p/DBwOrvcoKvI/"}, {"id": "STO_0129", "category": "STORYTELLING", "template": "(insert quote) the first time I heard this I was (insert action), and my (insert person) just dropped that line out of nowhere.", "exampleUrl": "https://www.instagram.com/p/DDAcNRXy2KD/"}, {"id": "STO_0130", "category": "STORYTELLING", "template": "Build a (insert noun) with me while I (insert action).", "exampleUrl": "https://www.instagram.com/p/DFESQ5bMLUy/"}, {"id": "STO_0131", "category": "STORYTELLING", "template": "I have had 0 (insert noun) in (insert time frame).", "exampleUrl": "https://www.instagram.com/p/DBuQULzybXD/"}, {"id": "STO_0132", "category": "STORYTELLING", "template": "It was until I build # of (insert noun) and completed over # of (insert noun) that I realized (insert action) is not really that complicated.", "exampleUrl": "https://www.instagram.com/p/DEd-dLWvcem/"}, {"id": "STO_0133", "category": "STORYTELLING", "template": "X days/months/years ago me and my (insert person)", "exampleUrl": "https://www.instagram.com/p/DICw6TgsuSk/"}, {"id": "STO_0134", "category": "STORYTELLING", "template": "I am (insert life event) in (insert time frame) and I just wrote a letter that I wish my (insert age) self would have read.", "exampleUrl": "https://www.instagram.com/p/DFf7WpdREbp/"}, {"id": "STO_0135", "category": "STORYTELLING", "template": "I am leaving my (insert salary) dream job at (insert company) to (insert action).", "exampleUrl": "https://www.instagram.com/p/DH542doMca8/"}, {"id": "STO_0136", "category": "STORYTELLING", "template": "This is day # of making fake (insert noun) for our dream clients until one of them starts working with us.", "exampleUrl": "https://www.instagram.com/p/DB587F_NYOD/"}, {"id": "STO_0137", "category": "STORYTELLING", "template": "X days/months/years ago I went extremely viral for (insert action).", "exampleUrl": "https://www.instagram.com/p/DDYV5gNJ9iq/"}, {"id": "STO_0138", "category": "STORYTELLING", "template": "Have you ever wondered why (insert noun) (insert adjective) is much better than (insert noun).", "exampleUrl": "https://www.instagram.com/p/DH2JoeSRvJq/"}, {"id": "STO_0139", "category": "STORYTELLING", "template": "For those of you who don't know I have been bootstrapping a (insert business type) to see how big I can scale it.", "exampleUrl": "https://www.instagram.com/p/C40yJ7BpdJD/"}, {"id": "STO_0140", "category": "STORYTELLING", "template": "When I told my (insert person) I was going to start doing this he/she thought it was the worst idea ever.", "exampleUrl": "https://www.instagram.com/p/DGhD18oBVds/"}, {"id": "STO_0141", "category": "STORYTELLING", "template": "These are dumb things I have done in (insert stage) of (insert action) for my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGwUdIEy0u_/"}, {"id": "STO_0142", "category": "STORYTELLING", "template": "This (insert noun) single handedly changed my career.", "exampleUrl": "https://www.instagram.com/p/DC9zT1dx5yT/"}, {"id": "STO_0143", "category": "STORYTELLING", "template": "Have you ever tried to (insert action) something that was supposed to look like this but ended up looking like this.", "exampleUrl": "https://www.instagram.com/p/DHo4Lj7sXlc/"}, {"id": "STO_0144", "category": "STORYTELLING", "template": "Hi my name is (insert name) and this was me (insert time frame) ago a (insert label) in (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIO1bNruotJ/"}, {"id": "STO_0145", "category": "STORYTELLING", "template": "Day # of (insert action) until I (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DG3uAhCPeDB/"}, {"id": "STO_0146", "category": "STORYTELLING", "template": "I just (insert action) to make (insert noun).", "exampleUrl": "https://www.instagram.com/p/DHrtql8y1Mv/"}, {"id": "STO_0147", "category": "STORYTELLING", "template": "I (insert action) to every (insert person) in the world. Here is how many people responded.", "exampleUrl": "https://www.instagram.com/p/DCC-6Y7CZVm/"}, {"id": "STO_0148", "category": "STORYTELLING", "template": "What happens when you (insert action), (insert action), (insert action), etc.", "exampleUrl": "https://www.instagram.com/p/DCo8e3Xi-di/"}, {"id": "STO_0149", "category": "STORYTELLING", "template": "Ever since I was (insert adjective) my (insert person) made it very clear to me that he/she was (insert adjective) about certain aspects of (insert noun).", "exampleUrl": "https://www.instagram.com/p/CRZU6CDBcuY/"}, {"id": "STO_0150", "category": "STORYTELLING", "template": "One day you're gonna get dumped. Not by your girlfriend, not by your boyfriend, not by your fiance, not by your spouse. But by your (insert noun).", "exampleUrl": "https://www.instagram.com/p/DD3BkA3vaI9/"}, {"id": "STO_0151", "category": "STORYTELLING", "template": "I am (insert name) (insert age) you might know me from my (insert accomplishment), (insert accomplishment), or (insert accomplishment).", "exampleUrl": "https://www.instagram.com/p/DCN08rLTux3/"}, {"id": "STO_0152", "category": "STORYTELLING", "template": "I was today years old when I found out that if you have (insert trait), (insert noun) will look really (insert adjective) on you.", "exampleUrl": "https://www.instagram.com/p/DDu_J9ZytmA/"}, {"id": "STO_0153", "category": "STORYTELLING", "template": "People are shocked to hear that these are my natural (insert noun).", "exampleUrl": "https://www.instagram.com/p/DEvMF5Kzqz7/"}, {"id": "STO_0154", "category": "STORYTELLING", "template": "Have you ever noticed that some (insert noun) feel (insert description) while others feel (insert description).", "exampleUrl": "https://www.instagram.com/p/DIOy5C2A8sb/"}, {"id": "STO_0155", "category": "STORYTELLING", "template": "This video got # of views, with a lot of (insert adjective) feedback. Let's try it out and see if it makes a difference to my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFDQ99NuwNF/"}, {"id": "STO_0156", "category": "STORYTELLING", "template": "If you've ever come across one of my reels and thought (insert adjective) that woman/man has (insert adjective) (insert noun). But here's a little secret: my (insert noun) was not always like this.", "exampleUrl": "https://www.instagram.com/p/DFYqX_gz5iD/"}, {"id": "STO_0157", "category": "STORYTELLING", "template": "Welcome back to my (insert noun) series where I will be teaching you everything I know, no gatekeeping here.", "exampleUrl": "https://www.instagram.com/p/DGTx0R1zU1v/"}, {"id": "STO_0158", "category": "STORYTELLING", "template": "After (insert time period) of having (insert bad result) come get my (insert noun) done with me.", "exampleUrl": "https://www.instagram.com/p/DDf3qgvP54t/"}, {"id": "STO_0159", "category": "STORYTELLING", "template": "Hi I am (insert name) and I am a (insert negative label).", "exampleUrl": "https://www.instagram.com/p/DGCMTIdpcvQ/"}, {"id": "STO_0160", "category": "STORYTELLING", "template": "Here is how I lost a (insert time frame) of my life.", "exampleUrl": "https://www.instagram.com/p/DAQog1uPOrX/"}, {"id": "STO_0161", "category": "STORYTELLING", "template": "I feel really bad for saying this but sometimes you just need to (insert harsh truth).", "exampleUrl": "https://www.instagram.com/p/DE-3lwtPE1v/"}, {"id": "STO_0162", "category": "STORYTELLING", "template": "As you may know I have been (insert action) to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DF-_e2MNx8u/"}, {"id": "STO_0163", "category": "STORYTELLING", "template": "I (insert action) almost everyday for a week and here is what happened.", "exampleUrl": "https://www.instagram.com/p/DCAJiSMPRyj/"}, {"id": "STO_0164", "category": "STORYTELLING", "template": "(insert action) everyday has literally changed my life. In", "exampleUrl": "https://www.instagram.com/p/DBuHW1Io1H2/"}, {"id": "STO_0165", "category": "STORYTELLING", "template": "I had this weird idea that if I added some (insert action), (insert action), (insert action), etc\u2026", "exampleUrl": "https://www.instagram.com/p/C-lMnQ4pCIs/"}, {"id": "STO_0166", "category": "STORYTELLING", "template": "Did you know that if you combined (insert noun), (insert noun), (insert noun), etc\u2026", "exampleUrl": "https://www.instagram.com/p/C_tMbf_p4-Q/"}, {"id": "STO_0167", "category": "STORYTELLING", "template": "When you're sad but then you remember you have (insert noun).", "exampleUrl": "https://www.instagram.com/p/DA1P8ANJxjv/"}, {"id": "STO_0168", "category": "STORYTELLING", "template": "I spent (insert price) on a (insert noun) here's all the (insert noun) I got.", "exampleUrl": "https://www.instagram.com/p/DHHHlXnpG-a/"}, {"id": "STO_0169", "category": "STORYTELLING", "template": "You know those days where it feels like (insert scenario) well today was that day for me.", "exampleUrl": "https://www.instagram.com/p/DHgZAkCRzQ7/"}, {"id": "STO_0170", "category": "STORYTELLING", "template": "I have (inset amount of thing), (insert amount of time), and a pipe dream to get ready for (insert event).", "exampleUrl": "https://www.instagram.com/p/DGLxdjvR3Se/"}, {"id": "STO_0171", "category": "STORYTELLING", "template": "So I was just (insert action) to do my (insert action) of the day when I saw that\u2026", "exampleUrl": "https://www.instagram.com/p/DIbTyiMyVek/"}, {"id": "STO_0172", "category": "STORYTELLING", "template": "Welcome back to another episode of (insert series name) where I (insert action).", "exampleUrl": "https://www.instagram.com/p/DHrfrLyyevs/"}, {"id": "STO_0173", "category": "STORYTELLING", "template": "We are not even (insert time frame) into (insert year) and have gone from being a (insert before state) to (insert after state).", "exampleUrl": "https://www.instagram.com/p/DFzAPKqsRip/"}, {"id": "STO_0174", "category": "STORYTELLING", "template": "I (insert action) but I don't have (insert noun).", "exampleUrl": "https://www.instagram.com/p/DG3qeUpv--T/"}, {"id": "STO_0175", "category": "STORYTELLING", "template": "I worked (insert hours) in just (insert days) making all of this (insert noun) for my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DGMTIk2s5Bq/"}, {"id": "STO_0176", "category": "STORYTELLING", "template": "If you told (insert age) me that I wouldn't be a (insert title) I would probably tell you to go screw yourself.", "exampleUrl": "https://www.instagram.com/p/DGPLfdUv5Zd/"}, {"id": "STO_0177", "category": "STORYTELLING", "template": "I (insert action) all of the (insert noun) you want with all the (insert adjective) that you need.", "exampleUrl": "https://www.instagram.com/p/DGd_iXpxGxe/"}, {"id": "STO_0178", "category": "STORYTELLING", "template": "Someone just (insert negative result) my business.", "exampleUrl": "https://www.instagram.com/p/DG3EbrsReCj/"}, {"id": "STO_0179", "category": "STORYTELLING", "template": "Can you please pack my (insert price) (insert noun) with me? Of course!", "exampleUrl": "https://www.instagram.com/p/DFM4apJSCnJ/"}, {"id": "STO_0180", "category": "STORYTELLING", "template": "The ultimate assembly video of my (insert huge metric) (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DG6zBv9xjKN/?igsh=MWJ3YW04aG5idDc3NQ=="}, {"id": "STO_0181", "category": "STORYTELLING", "template": "I am on a journey to find the best (insert noun) for (insert target audience) and today we went to (insert", "exampleUrl": "https://www.instagram.com/reel/DF0gUSRPywO/?igsh=dzYxc2I0amw2OHhr"}, {"id": "STO_0182", "category": "STORYTELLING", "template": "Here's how I made a wireless (insert noun) that is valued at (insert price).", "exampleUrl": "https://www.instagram.com/p/DHgznKnCq0U/"}, {"id": "STO_0183", "category": "STORYTELLING", "template": "We pretty much (insert action) our entire (insert noun) into (insert noun).", "exampleUrl": "https://www.instagram.com/p/DC-CO9QTF3R/"}, {"id": "STO_0184", "category": "STORYTELLING", "template": "X days/weeks/months/years ago I purchased (insert price) (insert noun) as a (insert label) with only a (insert price) deposit.", "exampleUrl": "https://www.instagram.com/p/DHatudoNK8S/"}, {"id": "STO_0185", "category": "STORYTELLING", "template": "For our entire # year relationship my (insert person) has been hiding something pretty important from me.", "exampleUrl": "https://www.instagram.com/p/DHsfGj6TGeA/"}, {"id": "STO_0186", "category": "STORYTELLING", "template": "I always had the biggest dream of (insert dream).", "exampleUrl": "https://www.instagram.com/kelseypoulter/reel/DHoe6OgRf6-/"}, {"id": "STO_0187", "category": "STORYTELLING", "template": "(Insert noun) is cringe right now but let me tell you what a game changer it was for me.", "exampleUrl": "https://www.instagram.com/p/DCmBEffyaPC/"}, {"id": "STO_0188", "category": "STORYTELLING", "template": "Hey everyone I am (insert name) I am (insert age) and I am starting a (insert business) from scratch.", "exampleUrl": "https://www.instagram.com/p/DDEBm2jOYMG/"}, {"id": "STO_0189", "category": "STORYTELLING", "template": "I didn't realize how bad I lost myself.", "exampleUrl": "https://www.instagram.com/p/DIU81u_pdBM/"}, {"id": "STO_0190", "category": "STORYTELLING", "template": "I just left my (insert salary) a year new grad job, and now I am just a disappointment.", "exampleUrl": "https://www.instagram.com/p/DIWt7j-O40r/"}, {"id": "STO_0191", "category": "STORYTELLING", "template": "Me and my (insert person) are supposed to be (insert action), but instead we (insert action).", "exampleUrl": "https://www.instagram.com/p/DHjhY8Vx2bw/"}, {"id": "STO_0192", "category": "STORYTELLING", "template": "(insert year) (insert occurrence).", "exampleUrl": "https://www.instagram.com/ultimateivyleagueguide/reel/DBv1NuKOF7u/"}, {"id": "STO_0193", "category": "STORYTELLING", "template": "I think I got (insert verb).", "exampleUrl": "https://www.instagram.com/p/DGN51kGIU51/"}, {"id": "STO_0194", "category": "STORYTELLING", "template": "My (insert person) wanted a (insert noun) for (insert event) so I said thanks for the suggestion but that\u2019s not my vibe and made them (insert noun) instead.", "exampleUrl": "https://www.instagram.com/p/DCmRfypJw93/"}, {"id": "STO_0195", "category": "STORYTELLING", "template": "I\u2019ve (insert verb) this almost every single day of my entire life.", "exampleUrl": "https://www.instagram.com/p/DGygqjJSIXS/"}, {"id": "STO_0196", "category": "STORYTELLING", "template": "Buying things I don\u2019t need because I have adult money.", "exampleUrl": "https://www.instagram.com/p/DFJZaQsS7f6/"}, {"id": "STO_0197", "category": "STORYTELLING", "template": "A fun fact about my (insert person) (insert name) is.", "exampleUrl": "https://www.instagram.com/p/DIXslTXRPiZ/"}, {"id": "STO_0198", "category": "STORYTELLING", "template": "My entire life I grew up (insert adjective) and (insert adjective) it was just my (insert person) raising the # of", "exampleUrl": "https://www.instagram.com/p/DI68Z2axGjl/"}, {"id": "STO_0199", "category": "STORYTELLING", "template": "I spent an entire (insert time) (insert verb) but was it a waste of time?", "exampleUrl": "https://www.instagram.com/p/DExfsiBu1mI/"}, {"id": "STO_0200", "category": "STORYTELLING", "template": "I am about to go on the biggest bender of my entire life!", "exampleUrl": "https://www.instagram.com/p/DI4JR8TOMdS/"}, {"id": "STO_0201", "category": "STORYTELLING", "template": "I think I am getting (insert verb) today.", "exampleUrl": "https://www.instagram.com/p/DIyy31iILqd/"}, {"id": "STO_0202", "category": "STORYTELLING", "template": "Welcome back to me (insert verb) my (insert person) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIwpRgJJQPs/"}, {"id": "STO_0203", "category": "STORYTELLING", "template": "I always wondered what it was like to (insert action).", "exampleUrl": "https://www.instagram.com/p/DI1FPNwOoAk/"}, {"id": "STO_0204", "category": "STORYTELLING", "template": "So (insert time frame) ago me and my (insert person) had a little too much fun.", "exampleUrl": "https://www.instagram.com/p/DGg5Lz2SN0T/"}, {"id": "STO_0205", "category": "STORYTELLING", "template": "Selling (insert noun) at (insert location) has made me more money than my (insert person/title) and today I am going to be investing that money into (insert noun).", "exampleUrl": "https://www.instagram.com/p/DINf-krxetg/"}, {"id": "STO_0206", "category": "STORYTELLING", "template": "Welcome back to day #, where I (insert verb) a (insert noun) everyday until I am (insert adjective)", "exampleUrl": "https://www.instagram.com/p/DFGbEQTziGB/"}, {"id": "STO_0207", "category": "STORYTELLING", "template": "(Insert person), (Insert person), or that one (Insert person) we just don\u2019t have (insert title) like we did back then.", "exampleUrl": "https://www.instagram.com/p/DG24V2LOxBj/"}, {"id": "STO_0208", "category": "STORYTELLING", "template": "Day # of trying to (insert action) all year.", "exampleUrl": "https://www.instagram.com/p/DEOoZX_xFLz/"}, {"id": "STO_0209", "category": "STORYTELLING", "template": "This was the (insert noun) that changed my life forever.", "exampleUrl": "https://www.instagram.com/p/DHm-oK2sa90/"}, {"id": "STO_0210", "category": "STORYTELLING", "template": "Over # of you saw this video.", "exampleUrl": "https://www.instagram.com/p/DF8rBLCP4SG/"}, {"id": "STO_0211", "category": "STORYTELLING", "template": "Today I woke up and realized (insert realization).", "exampleUrl": "https://www.instagram.com/p/DH-K4dER2wd/"}, {"id": "STO_0212", "category": "STORYTELLING", "template": "I am (insert verb) a (insert noun), on my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIz0whmxWk5/"}, {"id": "STO_0213", "category": "STORYTELLING", "template": "Remember that time you were (insert adjective) so you (insert action) but the moment (insert person) (insert verb) you (insert action).", "exampleUrl": "https://www.instagram.com/p/DImOQx6TGCo/"}, {"id": "STO_0214", "category": "STORYTELLING", "template": "Okay real talk, I wasn't always this (insert adjective).", "exampleUrl": "https://www.instagram.com/p/DIgzMCWuK1l/"}, {"id": "STO_0215", "category": "STORYTELLING", "template": "Is it possible to stop (insert pain point) and (insert dream result) in (insert time frame) even if you\u2019re in", "exampleUrl": "https://www.instagram.com/p/DIH7JjItEK0/"}, {"id": "STO_0216", "category": "STORYTELLING", "template": "(insert question) I hate this question.", "exampleUrl": "https://www.instagram.com/p/DIwy5TCT0SN/"}, {"id": "STO_0217", "category": "STORYTELLING", "template": "Last year I (insert verb) (insert noun) for (insert $).", "exampleUrl": "https://www.instagram.com/p/DICMQXWOize/"}, {"id": "STO_0218", "category": "STORYTELLING", "template": "Let\u2019s make (insert #) (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFRdOhxMQ9H/"}, {"id": "STO_0219", "category": "STORYTELLING", "template": "I had just (insert time) to (insert verb) (insert #) of (insert noun) for a (insert person). And you have until the end of the video to guess who they are for.", "exampleUrl": "https://www.instagram.com/p/C6O91GDLbUc/"}, {"id": "STO_0220", "category": "STORYTELLING", "template": "I only have (insert time) to finish over (insert number) of (insert noun) orders, including (insert number) of (insert noun), (insert number) of (insert noun), (insert number) of (insert noun), and (insert noun).", "exampleUrl": "https://www.instagram.com/p/C7CMet3rNJG/"}, {"id": "STO_0221", "category": "STORYTELLING", "template": "I (insert verb) (insert number) (insert noun) and I had to throw (insert number) of them away.", "exampleUrl": "https://www.instagram.com/p/DGGicrYRhyi/"}, {"id": "STO_0222", "category": "STORYTELLING", "template": "Have you ever seen (insert #) (insert noun) in one place?", "exampleUrl": "https://www.instagram.com/p/DH2RXm7RTGT/"}, {"id": "STO_0223", "category": "STORYTELLING", "template": "I have a confession. I have no problem (insert verb) for my (insert noun) but it\u2019s the process of actually (insert noun) that feels so (insert adjective).", "exampleUrl": "https://www.instagram.com/p/DBrEouTxlUk/"}, {"id": "STO_0224", "category": "STORYTELLING", "template": "I am (insert age) and I have an identity crisis.", "exampleUrl": "https://www.instagram.com/p/DBtZYwby3Nx/"}, {"id": "STO_0225", "category": "STORYTELLING", "template": "I have been a (insert title) for # years of my life I started when I was # years old working at (insert location/place) in (insert location).", "exampleUrl": "https://www.instagram.com/p/DIo_nLOz7p1/"}, {"id": "STO_0226", "category": "STORYTELLING", "template": "When I was growing up one (insert noun) I always (insert verb) with my (insert person) was (insert noun).", "exampleUrl": "https://www.instagram.com/p/DIv7DnJRg42/"}, {"id": "STO_0227", "category": "STORYTELLING", "template": "Once upon a time we bought a (insert noun) on (insert noun)", "exampleUrl": "https://www.instagram.com/p/DIgryegxxsB/"}, {"id": "STO_0228", "category": "STORYTELLING", "template": "If I want my (insert person) to be (insert dream result one day) that means I got to (insert action) now.", "exampleUrl": "https://www.instagram.com/p/DIW2ZlcvlaG/"}, {"id": "STO_0229", "category": "STORYTELLING", "template": "Hi I am (insert name) and I have been secretly (insert action) for # years.", "exampleUrl": "https://www.instagram.com/p/DIz_U_1NY5J/"}, {"id": "STO_0230", "category": "STORYTELLING", "template": "Can you name something more terrifying than a (insert person) with a (insert noun).", "exampleUrl": "https://www.instagram.com/p/DH8UvF7NWHN/"}, {"id": "STO_0231", "category": "STORYTELLING", "template": "# months/years ago my friends and I started a (insert business). And it turned out to be the biggest (insert result).", "exampleUrl": "https://www.instagram.com/p/DHHB_GOy09_/"}, {"id": "STO_0232", "category": "STORYTELLING", "template": "This is the ultimate assembly video of my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DG6zBv9xjKN/"}, {"id": "STO_0233", "category": "STORYTELLING", "template": "So (insert time) ago my (insert person) and I bought a (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DImqKRqy4xr/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA=="}, {"id": "STO_0234", "category": "STORYTELLING", "template": "I am on a journey to find the best (insert noun) for (insert person) and today we (insert action).", "exampleUrl": "https://www.instagram.com/p/DF0gUSRPywO/"}, {"id": "STO_0235", "category": "STORYTELLING", "template": "This week I tried to see if I could (insert result) for all of my (insert noun) just by (insert action) the night before.", "exampleUrl": "https://www.instagram.com/reel/DEIFRU_vg3e/?igsh=MXh6amc4enR3NGY3MA=="}, {"id": "STO_0236", "category": "STORYTELLING", "template": "In (insert year) I started (insert action) and I gave my life to (insert person).", "exampleUrl": "https://www.instagram.com/reel/DEgeFb_Oj9J/?igsh=bjRnZWxjcTVzcm84"}, {"id": "STO_0237", "category": "STORYTELLING", "template": "I lied to the (insert person) who (insert action).", "exampleUrl": "https://www.instagram.com/p/DExR-xeiVfp/"}, {"id": "STO_0238", "category": "STORYTELLING", "template": "Something I never thought I would have on my bingo card as a (insert title) was\u2026", "exampleUrl": "https://www.instagram.com/p/DIaBg2ySrJP/"}, {"id": "STO_0239", "category": "STORYTELLING", "template": "I had to spend (insert &) on this free (insert noun) before it even started.", "exampleUrl": "https://www.instagram.com/p/DI_btRGiv_A/"}, {"id": "STO_0240", "category": "STORYTELLING", "template": "I just left my 9-5 corporate job to start my (insert business.", "exampleUrl": "https://www.instagram.com/p/DFVkgfAPimi/"}, {"id": "STO_0241", "category": "STORYTELLING", "template": "I feel like # years ago I had my life together as a (insert title) but just slowly over time things have shifted.", "exampleUrl": "https://www.instagram.com/p/DF8XdbERfjy/"}, {"id": "STO_0242", "category": "STORYTELLING", "template": "(insert year) I met my (insert person) when working at (insert job).", "exampleUrl": "https://www.instagram.com/p/DHrK16iM1-B/"}, {"id": "STO_0243", "category": "STORYTELLING", "template": "My house has this weird (insert trait) and it\u2019s haunted me ever since I first toured.", "exampleUrl": "https://www.instagram.com/p/DI38P5ANOa1/"}, {"id": "STO_0244", "category": "STORYTELLING", "template": "My (insert person) and I moved in together and ended up losing (insert $).", "exampleUrl": "https://www.instagram.com/reel/DG-uLBeuoQR/?igsh=MWwzNjBxbjJyNmthbg=="}, {"id": "STO_0245", "category": "STORYTELLING", "template": "X years ago we decided we wanted to know exactly where our (insert noun) was coming from.", "exampleUrl": "https://www.instagram.com/reel/DGly7tKRY0I/?igsh=MXF0NWp1Y3Rhbnk3NQ=="}, {"id": "STO_0246", "category": "STORYTELLING", "template": "I made (insert $) doing (insert side hustle) as a side hustle.", "exampleUrl": "https://www.instagram.com/reel/DI1s4r7pwHv/?igsh=MXN6dGU0aTRnNTZt"}, {"id": "STO_0247", "category": "STORYTELLING", "template": "I have no intention of\u2026", "exampleUrl": "https://www.instagram.com/reel/DImh0cbigz"}, {"id": "STO_0248", "category": "STORYTELLING", "template": "Growing up my parents used to get upset when I (insert action), (insert action), or (insert action) they would get frustrated.", "exampleUrl": "https://www.instagram.com/reel/DD25g3ayYbg/?igsh=MWV1NTZ5YnplZDRtcw=="}, {"id": "STO_0249", "category": "STORYTELLING", "template": "Hi my name is (insert name) and this is my home.", "exampleUrl": "https://www.instagram.com/reel/DDDvhNoOKLU/?igsh=OHVvMjFxeXM0eTQy"}, {"id": "STO_0250", "category": "STORYTELLING", "template": "This is how much (insert adjective) (insert noun) cost me in (insert location) and a (insert age) (insert occupation).", "exampleUrl": "https://www.instagram.com/reel/DHYDpXxzF1U/?igsh=MTVkMTdiNDA4ZTZ5ZA=="}, {"id": "STO_0251", "category": "STORYTELLING", "template": "Nearly # years/months ago today I packed my bags and left for (insert location), thinking I would only be gone for (insert time).", "exampleUrl": "https://www.instagram.com/reel/DEadcffulgR/?igsh=NmxmNGdteWZ1M3Fz"}, {"id": "STO_0252", "category": "STORYTELLING", "template": "I am attempting to be the first person to (insert goal), day #.", "exampleUrl": "https://www.instagram.com/reel/DB0ogikvRjL/?igsh=MW16d2lyOWd6OXNjeg=="}, {"id": "STO_0253", "category": "STORYTELLING", "template": "When we first moved to the (insert location), my (insert person) bought a (insert noun) in (insert location).", "exampleUrl": "https://www.instagram.com/reel/DINcg69x3zC/?igsh=NzdpZzI0eW02YTNq"}, {"id": "STO_0254", "category": "STORYTELLING", "template": "My (insert person) told me he/she wanted a (insert noun) and instead of waiting around I decided to build it right now.", "exampleUrl": "https://www.instagram.com/reel/DD5GjKvx7d_/?igsh=dHh2bjJiczJ5b3pp"}, {"id": "STO_0255", "category": "STORYTELLING", "template": "My parents had # sons/daughters/kids thiers me, my (insert person), and (insert person).", "exampleUrl": "https://www.instagram.com/reel/DHIm7I7TAOU/?igsh=cnZlaGtkZWI3MXRk"}, {"id": "STO_0256", "category": "STORYTELLING", "template": "(insert time) I bought a (insert adjective) (insert noun) because it\u2019s cheaper than a (insert adjective) (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DFA-_6rSp7Q/?igsh=OTFmZWR0N3pxeW8w"}, {"id": "STO_0257", "category": "STORYTELLING", "template": "Did you know that if you wake up at (insert time), and (insert action)...", "exampleUrl": "https://www.instagram.com/reel/DHCAe7lTiGn/?igsh=c2Z0ZXJxN2w0emFt"}, {"id": "STO_0258", "category": "STORYTELLING", "template": "I already know I am going to get a bunch of hate for this but the (insert noun) is getting taken out today.", "exampleUrl": "https://www.instagram.com/reel/DGErAlDujW_/?igsh=ejJkNzY3Z3hxaTl4"}, {"id": "STO_0259", "category": "STORYTELLING", "template": "People know me for nearly losing (insert noun) and dying in (insert location).", "exampleUrl": "https://www.instagram.com/reel/DCvyp8lqoSU/?igsh=a3psNnJvcWtrcnly"}, {"id": "STO_0260", "category": "STORYTELLING", "template": "I am going to do it, i\u2019m going to flip this\u2026 house.", "exampleUrl": "https://www.instagram.com/reel/DGidAKiuEpN/?igsh=dWVkeDZkZmJ6dGEz"}, {"id": "STO_0261", "category": "STORYTELLING", "template": "Dude, it\u2019s day #. And I almost went (insert result).", "exampleUrl": "https://www.instagram.com/reel/DDfST-vi3Vj/?igsh=N2V1ZmdpeDVpZ3Fl"}, {"id": "STO_0262", "category": "STORYTELLING", "template": "My (insert person) lives (insert exact number of miles) away from my house.", "exampleUrl": "https://www.instagram.com/reel/DJAO6ULRkvZ/?igsh=MTN6eW1naTRyOGppbQ=="}, {"id": "STO_0263", "category": "STORYTELLING", "template": "Why am I (insert action) at # months pregnant?", "exampleUrl": "https://www.instagram.com/reel/DCU89MNOr9z/?igsh=MThnZ2dhdTNpYXBmcw=="}, {"id": "STO_0264", "category": "STORYTELLING", "template": "Last year for (insert holiday) we (insert action).", "exampleUrl": "https://www.instagram.com/reel/DDN6gx5NDIH/?igsh=MXJ1b2ZmMzhnd3R0aw=="}, {"id": "STO_0265", "category": "STORYTELLING", "template": "We spent all day (insert action), burning through (insert metric) of (insert noun), and now I am having a fully blown (insert noun) choice crisis.", "exampleUrl": "https://www.instagram.com/reel/DIN67zVzrrX/?igsh=MWpzYnluMmNranJhMQ=="}, {"id": "STO_0266", "category": "STORYTELLING", "template": "Day # of my (insert persons) room makeover. Which I kind of took to the extreme but let\u2019s start from the beginning.", "exampleUrl": "https://www.instagram.com/reel/DCuMERyPVD4/?igsh=Ynk1NndwZXA4aDdy"}, {"id": "STO_0267", "category": "STORYTELLING", "template": "Every year we make the questionable decision of (insert decision).", "exampleUrl": "https://www.instagram.com/reel/DD1w5dTqaWa/?igsh=MWMyc3huc21kaHR3bg=="}, {"id": "STO_0268", "category": "STORYTELLING", "template": "This is what I (insert action) in a day as someone who is trying to (insert action) less and (insert action) more.", "exampleUrl": "https://www.instagram.com/reel/DEqcQsap3cm/?igsh=OXRkcHN3Y3p5dGVx"}, {"id": "STO_0269", "category": "STORYTELLING", "template": "I have been (insert title) for (insert time) now, and I have gained (insert #) of followers just by sharing (insert content type).", "exampleUrl": "https://www.instagram.com/reel/DESlFyRSaeC/?igsh=MWxyNHowa2R2OTY0Mg=="}, {"id": "STO_0270", "category": "STORYTELLING", "template": "My (insert person) hasn't (insert action) in over # years.", "exampleUrl": "https://www.instagram.com/reel/DItpYikupRg/?igsh=b2tnenZid2pnN21j"}, {"id": "STO_0271", "category": "STORYTELLING", "template": "# years ago my (insert person) and I started (insert action).", "exampleUrl": "https://www.instagram.com/reel/DI5lkjpPfMn/?igsh=eXNzaWZmb3VjcGFw"}, {"id": "STO_0272", "category": "STORYTELLING", "template": "I have a problem. Which is that my (insert noun) it (insert pain point) and (insert pain point). So i\u2019m going to build my own (insert noun) that has (insert benefit).", "exampleUrl": "https://www.instagram.com/reel/DI6qlyqJ9WP/?igsh=N2szbnhja2o0ZWtu"}, {"id": "STO_0273", "category": "STORYTELLING", "template": "This week in fatherhood/motherhood I am please to report that I (insert result).", "exampleUrl": "https://www.instagram.com/reel/DF3nqffSL7r/?igsh=MXdzMTk3bnQxOWwyeA=="}, {"id": "STO_0274", "category": "STORYTELLING", "template": "Some say the strongest bond is between (insert person) and his/her (insert person).", "exampleUrl": "https://www.instagram.com/reel/DF9uy9DzyJW/?igsh=MTMwc2EzeWk2YmdudQ=="}, {"id": "STO_0275", "category": "STORYTELLING", "template": "Hi i\u2019m (insert name) and I am a (insert title), this is my (insert person) and he/she loves (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGO2HGtOu-C/?igsh=MXAyZ2tzbWJyMW12Mw=="}, {"id": "STO_0276", "category": "STORYTELLING", "template": "What is this massive stack of (insert noun) that I am holding in my hand, well it is the (insert noun) for the (insert number) of (insert noun) I have done this year.", "exampleUrl": "https://www.instagram.com/reel/DDiXCKmurWf/?igsh=MTJiN2N1MGtvbnd0NQ=="}, {"id": "STO_0277", "category": "STORYTELLING", "template": "I (insert traumatic event) at (insert age) but it\u2019s what happened after that, that actually changed my life.", "exampleUrl": "https://www.instagram.com/reel/DFGfX6NP6Pn/?igsh=bGlrYTZmNXhqenAy"}, {"id": "STO_0278", "category": "STORYTELLING", "template": "I was walking past this (insert store) when I say they had (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGwAia_yWQT/?igsh=MWZjaXcxcXFlczZ3aA=="}, {"id": "STO_0279", "category": "STORYTELLING", "template": "Fourtnely my (insert person) and I have a tendency to be a little bit impulsive.", "exampleUrl": "https://www.instagram.com/reel/DGNL0Buyid_/?igsh=ZGl5YmZ4bTJjdXNy"}, {"id": "STO_0280", "category": "STORYTELLING", "template": "Yesterday I (insert action) in (insert hours) and (insert minutes).", "exampleUrl": "https://www.instagram.com/p/DJAIpU1N7b0/"}, {"id": "STO_0281", "category": "STORYTELLING", "template": "Would you buy a house with no (insert noun), well my (insert person) did!", "exampleUrl": "https://www.instagram.com/p/DDxL49LJwSV/"}, {"id": "STO_0282", "category": "STORYTELLING", "template": "How long does it take to catch (insert high number) of (insert noun)?", "exampleUrl": "https://www.instagram.com/p/DIIU8EuRq_H/"}, {"id": "STO_0283", "category": "STORYTELLING", "template": "We got an insane deal on our (insert noun) a year ago because it needed to be (insert action).", "exampleUrl": "https://www.instagram.com/reel/DHO0BEavIkr/?igsh=MWRhem4yYzA1Y2ExNw=="}, {"id": "STO_0284", "category": "STORYTELLING", "template": "There is a man/woman that comments on every single video I upload.", "exampleUrl": "https://www.instagram.com/reel/DGc_8U7i-yF/?igsh=eDhpcG9rbGtrbzg4"}, {"id": "STO_0285", "category": "STORYTELLING", "template": "Buying (insert noun) that need a lot of work, can work out in your favor.", "exampleUrl": "https://www.instagram.com/reel/DCtwyViukxT/?igsh=emQxcTF1NGx5b2Zi"}, {"id": "STO_0286", "category": "STORYTELLING", "template": "In # days I am selling my (insert noun) and moving out of the country.", "exampleUrl": "https://www.instagram.com/reel/DCimp5XxA7o/?igsh=MW9qc2hjZHRnMmZyZQ=="}, {"id": "STO_0287", "category": "STORYTELLING", "template": "I think of my (insert noun) as my own personal (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DHWAUjrROF4/?igsh=MWthZzBuMnVsZ3FzbA=="}, {"id": "STO_0288", "category": "STORYTELLING", "template": "It\u2019s been (insert time) since I bought my dream (insert noun), and I want to take you through what the last (insert time) has been like.", "exampleUrl": "https://www.instagram.com/reel/DFlD6AYyyHm/?igsh=em1hbXI2enF1MTBm"}, {"id": "STO_0289", "category": "STORYTELLING", "template": "(insert $) home (insert bad result) in just # time/months.", "exampleUrl": "https://www.instagram.com/reel/DGKGa06O7a_/?igsh=bHdsa2lobXNxMmth"}, {"id": "STO_0290", "category": "STORYTELLING", "template": "Come with me to (insert action) the (insert title) didn't (insert action).", "exampleUrl": "https://www.instagram.com/reel/DEydm_GP0B8/?igsh=MWY1OTBpMmd0MXk2dg=="}, {"id": "STO_0291", "category": "STORYTELLING", "template": "I am revmong all my (insert noun) friendly upgrades before we (insert action). Today we are removing (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DAXBKELOkLP/?igsh=MmloOHc1bXM5cHhh"}, {"id": "STO_0292", "category": "STORYTELLING", "template": "Let\u2019s try to unclog a (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DGUOKrcRFKT/?igsh=MXBjZWFrZGs3Mzl6dA=="}, {"id": "STO_0293", "category": "STORYTELLING", "template": "This is what my morning looks like while (insert situation).", "exampleUrl": "https://www.instagram.com/reel/DExrL91JUcS/?igsh=MWN6anA2dnhhamoyZg=="}, {"id": "STO_0294", "category": "STORYTELLING", "template": "Last night at around (insert time) (insert person) began textbook stage one (insert scenario).", "exampleUrl": "https://www.instagram.com/reel/DGludzMRqVt/?igsh=MWRpMmNqY21xYmtpOA=="}, {"id": "STO_0295", "category": "STORYTELLING", "template": "After many years of total neglect my basement is finally getting much needed TLC.", "exampleUrl": "https://www.instagram.com/reel/DFTWF7opT4B/?igsh=MTc1eG54cHkzdzhlNw=="}, {"id": "STO_0296", "category": "STORYTELLING", "template": "How (insert action) ended with a (insert person) at my house telling me how lucky we are that (insert accident) didn't happen.", "exampleUrl": "https://www.instagram.com/reel/DG6_U-JxKtt/?igsh=am9wbnJ4b2JjMjcx"}, {"id": "STO_0297", "category": "STORYTELLING", "template": "Customer called me up because they had (insert situation) and wanted it (insert result) immediately.", "exampleUrl": "https://www.instagram.com/reel/DEOTavZx5TX/?igsh=MTRkN3AyaDNlaTB0eg=="}, {"id": "STO_0298", "category": "STORYTELLING", "template": "While my kids were taking a nap I went to (insert action) when I realized (insert realization).", "exampleUrl": "https://www.instagram.com/reel/DE3A6-up1Nd/?igsh=cHRuZWs4eW9qbmw0"}, {"id": "STO_0299", "category": "STORYTELLING", "template": "My one goal this year was to showcase just how interesting (insert noun) is.", "exampleUrl": "https://www.instagram.com/reel/DEDVhdrSfbP/?igsh=NDVha25oZ2V2M2c2"}, {"id": "STO_0300", "category": "STORYTELLING", "template": "I don\u2019t usually cry, but yesterday I did. And it wasn\u2019t because of (insert reason).", "exampleUrl": "https://www.instagram.com/reel/DBWgXXAvUh3/?igsh=MXdpcHgxdGlodXVrZw=="}, {"id": "STO_0301", "category": "STORYTELLING", "template": "You know when I started making (insert noun) I should have known this day would come.", "exampleUrl": "https://www.instagram.com/reel/DJANvPCTbH_/?igsh=MTJrYnFsZWVuY2w4eg=="}, {"id": "STO_0302", "category": "STORYTELLING", "template": "I got a (insert noun) and it did not turn out to be what I expected.", "exampleUrl": "https://www.instagram.com/reel/DHCVNTcy1NM/?igsh=ajFvdjNodHhwNDZ5"}, {"id": "STO_0303", "category": "STORYTELLING", "template": "About a (insert time) ago I got in trouble for having too many (insert nouns).", "exampleUrl": "https://www.instagram.com/reel/DB9kycqyic8/?igsh=b3EyYWY3bHFnenp2"}, {"id": "STO_0304", "category": "STORYTELLING", "template": "I baited this (insert google rating) (insert title) with this (insert noun) in excellent condition to see if they would rip me off.", "exampleUrl": "https://www.instagram.com/reel/DDLA77-SKTM/?igsh=NGg4aGJmZmU5ODJ2"}, {"id": "STO_0305", "category": "STORYTELLING", "template": "I took my (insert person) to (insert location) to try this (insert noun) and it actually caught something.", "exampleUrl": "https://www.instagram.com/reel/DFG8vSONo9f/?igsh=MWUxdWx5eXJpeThmbA=="}, {"id": "STO_0306", "category": "STORYTELLING", "template": "I opened up a (insert business/store) in the middle of (insert location) and I can\u2019t believe how much money I made.", "exampleUrl": "https://www.instagram.com/reel/DDr63MGOLsK/?igsh=MTZxanR2MjdobzJvNw=="}, {"id": "STO_0307", "category": "STORYTELLING", "template": "I took a (insert hour) and (insert minute) (insert noun) to (insert location) and here\u2019s how it went.", "exampleUrl": "https://www.instagram.com/reel/DCke9dGx-7G/?igsh=MXZqMmZkMTJ4dG1ydQ=="}, {"id": "STO_0308", "category": "STORYTELLING", "template": "(insert verb) (insert noun), (insert action), and don\u2019t", "exampleUrl": "https://www.instagram.com/reel/DGOH0THO"}, {"id": "STO_0309", "category": "STORYTELLING", "template": "This is life as a (insert noun) addict part (insert #).", "exampleUrl": "https://www.instagram.com/reel/DCno0FUObFN/?igsh=Mm1seHZxMWpnMm5o"}, {"id": "STO_0310", "category": "STORYTELLING", "template": "Welcome back to the journey of how I got (insert result).", "exampleUrl": "https://www.instagram.com/reel/DFvWgldxb80/?igsh=enZpOWhjaWpicjRm"}, {"id": "STO_0311", "category": "STORYTELLING", "template": "Come take a (insert noun) with me that I did not (insert action) for at all.", "exampleUrl": "https://www.instagram.com/reel/DEArdkWRoI3/?igsh=MThiaXZ2dnBhdjR0cQ=="}, {"id": "STO_0312", "category": "STORYTELLING", "template": "It\u2019s been (insert time) since I have seen myself with (insert feature) and that\u2019s all about to change.", "exampleUrl": "https://www.instagram.com/reel/C48sQQpI5aS/?igsh=MTIzNGduZmEzYzRudA=="}, {"id": "STO_0313", "category": "STORYTELLING", "template": "This was me when I was (insert pain point), (insert pain point), and (insert pain point).", "exampleUrl": "https://www.instagram.com/reel/C5TmBcrrTxF/?igsh=MTlveW5uOWU5aW9wbg=="}, {"id": "STO_0314", "category": "STORYTELLING", "template": "From being (insert state), to (insert state), back to (insert state), to (insert state), to now being (insert current state) in (insert time) I have built tons of knowledge when it comes to (insert result).", "exampleUrl": "https://www.instagram.com/reel/C8Zs6wqx2bi/?igsh=ZzU5MHI2NGFzeGxj"}, {"id": "STO_0315", "category": "STORYTELLING", "template": "I have (insert event) in (insert time) and I have not started (insert action). And if I don\u2019t do well I have to (insert consequence).", "exampleUrl": "https://www.instagram.com/reel/DDubxvxpHc1/?igsh=OWc0cXpuZmx6NG1h"}, {"id": "STO_0316", "category": "STORYTELLING", "template": "Today I am eating like (insert person) for the full day and I am going to see how much weight I gain by the end of the day.", "exampleUrl": "https://www.instagram.com/reel/DIohXabuCQd/?igsh=MTlsNWhhcjhrZzl4cg=="}, {"id": "STO_0317", "category": "STORYTELLING", "template": "(insert time ago) my (insert person) (insert action) when my (insert person) passed away.", "exampleUrl": "https://www.instagram.com/reel/DEpFrpHRKBN/?igsh=eDhxa2hibWllMGE4"}, {"id": "STO_0318", "category": "STORYTELLING", "template": "(insert time) I started accepting the choice to (insert drastic change).", "exampleUrl": "https://www.instagram.com/reel/DHrVRsRyA1t/?igsh=MXU0MTF6dXRpNndsbA=="}, {"id": "STO_0319", "category": "STORYTELLING", "template": "2 years, no (insert noun), and today\u2019s the first time I get to use (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DHlvQJEpYK1/?igsh=MTgxcXRpNWlrc2Qzcg=="}, {"id": "STO_0320", "category": "STORYTELLING", "template": "Does this stuff actually work?", "exampleUrl": "https://www.instagram.com/reel/DHrP6IqyOPT/?igsh=MW5iMWQ1NWRjN3lvbA=="}, {"id": "STO_0321", "category": "STORYTELLING", "template": "I gained (insert pounds/kilos) during (insert life event).", "exampleUrl": "https://www.instagram.com/reel/DG1ZicxMEJo/?igsh=aHZpN2kzamxibXI1"}, {"id": "STO_0322", "category": "STORYTELLING", "template": "I am letting (insert business type) companies, control my (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DBUGNe5Pn5g/?igsh=aWNqYnEzYnphcHBx"}, {"id": "STO_0323", "category": "STORYTELLING", "template": "So I am (insert age) and I work nights at (insert store)", "exampleUrl": "https://www.instagram.com/reel/DIW6N1gto6"}, {"id": "STO_0324", "category": "STORYTELLING", "template": "So it\u2019s been a week and I am already on (insert number) of followers.", "exampleUrl": "https://www.instagram.com/reel/DI6pGLUN66W/?igsh=eWJmMTU4eW9jZ21j"}, {"id": "STO_0325", "category": "STORYTELLING", "template": "So when I was (insert age) I started taking (insert noun) and at (insert age) I had to (insert action).", "exampleUrl": "https://www.instagram.com/reel/DC2Mg4ON1m0/?igsh=N2R6aW10MHo5NTA4"}, {"id": "STO_0326", "category": "STORYTELLING", "template": "I used to always be the guy that had a (insert condition), (insert condition), and always struggled with (insert condition).", "exampleUrl": "https://www.instagram.com/reel/DHtlcflN9uQ/?igsh=MXRweTBia2tnZG1vMg=="}, {"id": "STO_0327", "category": "STORYTELLING", "template": "My (insert person) takes me to the doctor, because I am (insert age) and already (insert action).", "exampleUrl": "https://www.instagram.com/reel/DF-i8pixfba/?igsh=MWtpcTh4eXBwc2Z1Nw=="}, {"id": "STO_0328", "category": "STORYTELLING", "template": "It has come to my attention that some of you guys think I am actually (insert result) when I do (insert content type).", "exampleUrl": "https://www.instagram.com/reel/DGrDjgDuxt0/?igsh=Yzkxb3U5ODBjaWM3"}, {"id": "STO_0329", "category": "STORYTELLING", "template": "A little over (insert time) ago I posted a video about the benefits of (insert action).", "exampleUrl": "https://www.instagram.com/reel/DG8iDwOuA6R/?igsh=MXhiM3IyYXRycHZyYw=="}, {"id": "STO_0330", "category": "STORYTELLING", "template": "I did (insert action) everyday for one year, and here\u2019s what's different.", "exampleUrl": "https://www.instagram.com/reel/DAMm_LMsAxL/?igsh=MTgyZWpwNG05ZHV1dA=="}, {"id": "STO_0331", "category": "STORYTELLING", "template": "I can confidently say the only reason I can (insert verb) (insert metric) is simply because of the way I choose to (insert verb).", "exampleUrl": "https://www.instagram.com/reel/C_rB-Ntuhe8/?igsh=MWhsazBneHVldG1hcA=="}, {"id": "STO_0332", "category": "STORYTELLING", "template": "# days ago I quit (insert noun) as a (insert age) (insert title), and started (insert noun) for literally one reason.", "exampleUrl": "https://www.instagram.com/reel/DIfR8HKN1S-/?igsh=MXpnd2llaDN3aGE2"}, {"id": "STO_0333", "category": "STORYTELLING", "template": "A competitor showed up at my job trying to get me fired.", "exampleUrl": "https://www.instagram.com/reel/DCAp43wtIxP/?igsh=MWZpYzJiaGxnNTFodw=="}, {"id": "STO_0334", "category": "STORYTELLING", "template": "I damaged a customer's property and here\u2019s how I handled it.", "exampleUrl": "https://www.instagram.com/reel/DI8xeTdOCGp/?igsh=d3NoMjRtcmxndmh2"}, {"id": "STO_0335", "category": "STORYTELLING", "template": "A customer (insert result) and tried to avoid paying.", "exampleUrl": "https://www.instagram.com/reel/DHorGhlyi3x/?igsh=MXRjbnhxODgxcmF6aw=="}, {"id": "STO_0336", "category": "STORYTELLING", "template": "I was harassed by (insert noun) so I had to do this.", "exampleUrl": "https://www.instagram.com/reel/DHZvMput7H8/?igsh=OXlxMmZmcmZzZnc3"}, {"id": "STO_0337", "category": "STORYTELLING", "template": "Alright this is officially day #1, trying to make (insert $) a month with (insert business).", "exampleUrl": "https://www.instagram.com/reel/DGYg6fDxohE/?igsh=ajIyZzE1ZnBmZWJn"}, {"id": "STO_0338", "category": "STORYTELLING", "template": "I am a retired (insert title) who now owns a (insert business). So come with me to collect the quarters.", "exampleUrl": "https://www.instagram.com/reel/DEz4JQYvuSr/?igsh=M2Z1c3Jpd3lrMjJz"}, {"id": "STO_0339", "category": "STORYTELLING", "template": "Did you know you can start your own (insert business ) from home without (insert pain point), (insert pain point), and (insert pain point).", "exampleUrl": "https://www.instagram.com/reel/DGv9SwVysky/?igsh=emp3bnJ6c3c2aWQx"}, {"id": "STO_0340", "category": "STORYTELLING", "template": "I would like to welcome you to my (insert location).", "exampleUrl": "https://www.instagram.com/reel/DDqPDWny-9a/?igsh=aDczYzE0M200NGRx"}, {"id": "STO_0341", "category": "STORYTELLING", "template": "Let me show yall how to make (insert $) per day, but installing a simple (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DCZnnxFx-IX/?igsh=MWdxdml5MXQxb3FzYw=="}, {"id": "STO_0342", "category": "STORYTELLING", "template": "Have you ever thought about starting your own (insert business)?", "exampleUrl": "https://www.instagram.com/reel/DG4fj2xxD5n/?igsh=OGR0ajlhNnBhbnF6"}, {"id": "STO_0343", "category": "STORYTELLING", "template": "Day # of trying a new hobby to recover from burnout.", "exampleUrl": "https://www.instagram.com/p/DJDLxItzPJV/"}, {"id": "STO_0344", "category": "STORYTELLING", "template": "My (insert noun) made me (insert $) last month, and what's crazy about this is I used no money to start this business.", "exampleUrl": "https://www.instagram.com/reel/DIotrpKRU6x/?igsh=MTJxaHp1c3lzcjEzMA=="}, {"id": "STO_0345", "category": "STORYTELLING", "template": "Make (insert noun) and (insert noun) with me from my online (insert business) and a (insert label).", "exampleUrl": "https://www.instagram.com/reel/DGW779fM0nD/?igsh=OTJxZnA0dXBobW4="}, {"id": "STO_0346", "category": "STORYTELLING", "template": "Hi i'm (insert name) a (insert #) generation (insert title) who shares tips about (insert niche) and (insert result).", "exampleUrl": "https://www.instagram.com/reel/DFdu6ZHxg5i/?igsh=MWU2dmJ2OWw1MHppNw=="}, {"id": "STO_0347", "category": "STORYTELLING", "template": "Starting a (insert business) at (insert age).", "exampleUrl": "https://www.instagram.com/reel/DEBDyQLTOyO/?igsh=Mmd3NG1wbHVneDdz"}, {"id": "STO_0348", "category": "STORYTELLING", "template": "Welcome to day # of starting my life over at (insert age).", "exampleUrl": "https://www.instagram.com/reel/DHOxtt0NE6o/?igsh=MWxjMXJpZW8wazl5dA=="}, {"id": "STO_0349", "category": "STORYTELLING", "template": "I have something to address, over the last week I have gained (insert #) of followers.", "exampleUrl": "https://www.instagram.com/reel/DEz23JVpGgE/?igsh=MXdtdzVwa216cTZicA=="}, {"id": "STO_0350", "category": "STORYTELLING", "template": "This is how I ended up taking the biggest risk of my life.", "exampleUrl": "https://www.instagram.com/reel/DHdesfVCuKx/?igsh=MTVqZ2ZubWQyZmdkMA=="}, {"id": "STO_0351", "category": "STORYTELLING", "template": "In 1 year I (insert verb) over (insert pounds) of (insert noun) in my extremely small (insert location).", "exampleUrl": "https://www.instagram.com/reel/DFX2ud_OwT4/?igsh=MW1ldmtqMmh6Yjd2cA=="}, {"id": "STO_0352", "category": "STORYTELLING", "template": "I f*cked up. I bought literally a (insert metric) of (insert noun). And for the last (insert time) I have been turning them into (insert results).", "exampleUrl": "https://www.instagram.com/reel/DIhivhvtN3q/?igsh=ZmRuOGthenpjN2I="}, {"id": "STO_0353", "category": "STORYTELLING", "template": "I finally built it. For the last # years I've been turning (insert noun) into (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DIxSSv5KcRv/?igsh=MXRxYTRrc240Mm1wbA=="}, {"id": "STO_0354", "category": "STORYTELLING", "template": "Is it possible to go from (insert before state) to (insert after state) just by (insert action).", "exampleUrl": "https://www.instagram.com/reel/DIoMIenNube/?igsh=MWZ0NG90Z2hubTJ5dw=="}, {"id": "STO_0355", "category": "STORYTELLING", "template": "We are now at day #, since starting my (insert project).", "exampleUrl": "https://www.instagram.com/reel/DCpBtQ8uz1R/?igsh=NXBqM3gwams3dWQw"}, {"id": "STO_0356", "category": "STORYTELLING", "template": "Proof that a (insert noun) can totally transform a space.", "exampleUrl": "https://www.instagram.com/reel/DIRVPZNpr9M/?igsh=MWtmaXh6eWk5cHNnaw=="}, {"id": "STO_0357", "category": "STORYTELLING", "template": "Alright today we are building this (insert $) (insert adjective) (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DEsqSd9SFfS/?igsh=ZXhlcDVnemUwcm9m"}, {"id": "STO_0358", "category": "STORYTELLING", "template": "Here is how we transformed my (insert persons) (insert location) from this to this using (insert noun).", "exampleUrl": "https://www.instagram.com/reel/DCufP51puBN/?igsh=cjdreHNxeTlwbXE2"}, {"id": "STO_0359", "category": "STORYTELLING", "template": "There;s probably a reason why most people don't (insert action).", "exampleUrl": "https://www.instagram.com/reel/DHbjAxavLKw/?igsh=MWoyb3kzd2UwN2JpYw=="}, {"id": "STO_0360", "category": "STORYTELLING", "template": "I bought this (insert noun) for (insert $). And today my (insert person) and I will find out if it (insert result).", "exampleUrl": "https://www.instagram.com/reel/DGgxdZ4SRgm/?igsh=cDRtaW03bDNwNGhy"}, {"id": "STO_0361", "category": "STORYTELLING", "template": "I can't stand this (insert noun), let's transform it.", "exampleUrl": "https://www.instagram.com/reel/DEDx84Zy4Fi/?igsh=cHdmNnFxbnNvd2xk"}, {"id": "STO_0362", "category": "STORYTELLING", "template": "Over the past # days I (insert action) on # of (insert nouns). In doing that I have gained over (insert #) of followers. So here's the thing.", "exampleUrl": "https://www.instagram.com/reel/DH64QI0uzgl/?igsh=MTNzamdyMHY1bzhqMw=="}, {"id": "STO_0363", "category": "STORYTELLING", "template": "Over the last (insert time) I have been finding a lot of cool things over (insert location). And today I am finally finishing my (insert project).", "exampleUrl": "https://www.instagram.com/reel/DDc9OJlvOMl/?igsh=czZyZ2picXR6eWlw"}, {"id": "STO_0364", "category": "STORYTELLING", "template": "Do you ever (insert situation), yeah well that's my job.", "exampleUrl": "https://www.instagram.com/reel/DDVHvRjsz9k/?igsh=cThzb3VrNHp3ZWh3"}, {"id": "STO_0365", "category": "STORYTELLING", "template": "I bought this (insert noun) for (insert $), and I am going to make it worth over (insert $) without changing the product in any way.", "exampleUrl": "https://www.instagram.com/reel/DHtn8PPo5_r/?igsh=MTZtNGc0aXFxaG9mMA=="}, {"id": "STO_0366", "category": "STORYTELLING", "template": "This might be the coolest DIY I have ever made.", "exampleUrl": "https://www.instagram.com/reel/DGJDrxePydv/?igsh=Mml6dXljeWF5dGZp"}, {"id": "STO_0367", "category": "STORYTELLING", "template": "Some people call it a problem but I call it (insert noun) genius.", "exampleUrl": "https://www.instagram.com/reel/DGQvN_dJ5cK/?igsh=MThiN2V2eGRqenJ4cA=="}, {"id": "STO_0368", "category": "STORYTELLING", "template": "With the (insert life event) coming, it\u2019s time to (insert action).", "exampleUrl": "https://www.instagram.com/reel/DC2fx6XOD5c/?igsh=MXVyY2lsajhqcDJyYw=="}, {"id": "RAN_0001", "category": "RANDOM", "template": "This is (insert large number) of (insert item).", "exampleUrl": "https://www.instagram.com/p/C84vUYRMEtm/"}, {"id": "RAN_0002", "category": "RANDOM", "template": "This is my (insert item) and this is (insert random action) if I were (insert random action).", "exampleUrl": "https://www.instagram.com/p/DCswF7jx5e8/"}, {"id": "RAN_0003", "category": "RANDOM", "template": "You're losing your boyfriend/girlfriend this week to (insert event/hobby).", "exampleUrl": "https://www.instagram.com/p/C_d78KaSl4e/"}, {"id": "RAN_0004", "category": "RANDOM", "template": "What (insert title) says vs what they mean.", "exampleUrl": "https://www.instagram.com/p/C9pwV7rPMVo/"}, {"id": "RAN_0005", "category": "RANDOM", "template": "(insert trend) is the most disgusting trend on social media.", "exampleUrl": "https://www.instagram.com/p/DAdgNiLSGrC/"}, {"id": "RAN_0006", "category": "RANDOM", "template": "I do not believe in (insert common belief), I believe in (insert your belief).", "exampleUrl": "https://www.instagram.com/reel/DFAu11XxvX-/"}, {"id": "RAN_0007", "category": "RANDOM", "template": "If you like these (insert job title), you'll probably like my (insert work).", "exampleUrl": "https://www.instagram.com/p/C-S-AL0tIoy/"}, {"id": "RAN_0008", "category": "RANDOM", "template": "(insert big brand) didn't want to sponsor this video, let me show you what they're missing out on.", "exampleUrl": "https://www.instagram.com/p/DAlofevvKBf/"}, {"id": "RAN_0009", "category": "RANDOM", "template": "I am trying a different (insert noun) for each letter of the alphabet.", "exampleUrl": "https://www.instagram.com/p/DFdgmSDx5h7/"}, {"id": "RAN_0010", "category": "RANDOM", "template": "My (insert person) has never been in the (insert place) before let's see if she can tell who is (insert adjective) or not.", "exampleUrl": "https://www.instagram.com/p/DHwLIKmuE9a/"}, {"id": "RAN_0011", "category": "RANDOM", "template": "If I get this in, then I have to (insert verb).", "exampleUrl": "https://www.instagram.com/p/DIIB3xdThFN/"}, {"id": "AUT_0001", "category": "AUTHORITY", "template": "My (insert before state) used to look like this and now they look like this.", "exampleUrl": "https://www.instagram.com/reel/DE7cjKBNcY4/?igsh=MTNyY2l3bzM5b2Q3"}, {"id": "AUT_0002", "category": "AUTHORITY", "template": "10 YEARS it took me from (insert before state) to (insert after state).", "exampleUrl": "https://www.instagram.com/p/C8Cpii4PB1u/"}, {"id": "AUT_0003", "category": "AUTHORITY", "template": "How to turn this into this in X simple steps.", "exampleUrl": "https://www.instagram.com/p/DDDbVpExlO7/"}, {"id": "AUT_0004", "category": "AUTHORITY", "template": "(insert big result) from (insert item/thing). Here's how you can do it in X steps.", "exampleUrl": "https://www.instagram.com/p/DBZtLTpv91b/"}, {"id": "AUT_0005", "category": "AUTHORITY", "template": "Over the past (insert time) I've grown my (insert thing) from (insert before) to (insert after).", "exampleUrl": "https://www.instagram.com/p/DCopsVERQ_N/"}, {"id": "AUT_0006", "category": "AUTHORITY", "template": "Just # (insert item/action) took my client from (insert before) to (insert after).", "exampleUrl": "https://www.instagram.com/p/C9XVmDQS2z-/"}, {"id": "AUT_0007", "category": "AUTHORITY", "template": "My customer/client got (insert dream result) without (insert pain point).", "exampleUrl": "https://www.instagram.com/reel/C4VceenL2Wq/"}, {"id": "AUT_0008", "category": "AUTHORITY", "template": "If I were to create a collab campaign for (insert big", "exampleUrl": "https://www.instagram.com/reel/DDWwZtZi4Jt/"}, {"id": "AUT_0009", "category": "AUTHORITY", "template": "How I got my (insert item/thing) from this to this.", "exampleUrl": "https://www.instagram.com/p/C89iASFu7GA/"}, {"id": "AUT_0010", "category": "AUTHORITY", "template": "I became a (insert achievement) at (insert age) and if I could give you X pieces of advice it would be\u2026", "exampleUrl": "https://www.tiktok.com/t/ZT2MLXA1Y/"}, {"id": "AUT_0011", "category": "AUTHORITY", "template": "Everyone is complimenting on my (insert noun) because of one (insert noun) routine that I do.", "exampleUrl": "https://www.instagram.com/p/C-NrgKvR4KS/"}, {"id": "AUT_0012", "category": "AUTHORITY", "template": "I lost over (insert metric) in (insert time frame) and here are the # of things I would do if I was to start all over.", "exampleUrl": "https://www.instagram.com/p/DGgs20kvL2r/"}, {"id": "AUT_0013", "category": "AUTHORITY", "template": "My customer/client got (insert dream result) with out (insert pain point) and here's how.", "exampleUrl": "https://www.instagram.com/reel/C4VceenL2Wq/"}, {"id": "AUT_0014", "category": "AUTHORITY", "template": "I am in a (insert noun) and these # habits dramatically transformed my (insert noun).", "exampleUrl": "https://www.instagram.com/reel/C79a1LjPGYa/"}, {"id": "AUT_0015", "category": "AUTHORITY", "template": "I got (insert dream result) on all of my (insert noun) with minimal (insert action) and here's how.", "exampleUrl": "https://www.instagram.com/p/C6G56RQrf9N/"}, {"id": "AUT_0016", "category": "AUTHORITY", "template": "If I were to create a (insert noun) today this is how I would do it.", "exampleUrl": "https://www.instagram.com/p/DCephvLiQuW/"}, {"id": "AUT_0017", "category": "AUTHORITY", "template": "If I ever made it to the news I thought it would at least be for something illegal, turns out it's for (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DF2GJJ3vAQq/"}, {"id": "AUT_0018", "category": "AUTHORITY", "template": "(insert well known brand) commented that I am their new favorite (insert title).", "exampleUrl": "https://www.instagram.com/reel/DH4GEtKBzbo/"}, {"id": "AUT_0019", "category": "AUTHORITY", "template": "What I (insert action) in a day as someone who has achieved (insert dream result).", "exampleUrl": "https://www.instagram.com/p/C66_WyUvgha/"}, {"id": "AUT_0020", "category": "AUTHORITY", "template": "I literally used to have a (insert before state).", "exampleUrl": "https://www.instagram.com/share/_grFmUWDX"}, {"id": "AUT_0021", "category": "AUTHORITY", "template": "My (insert noun) went from this to this in the last (insert time frame) and this is what I done.", "exampleUrl": "https://www.instagram.com/share/BANskzjs_f"}, {"id": "AUT_0022", "category": "AUTHORITY", "template": "I have been pretty much doing the same (insert noun) for the past (insert time frame) and they have legit (insert dream result).", "exampleUrl": "https://www.instagram.com/share/BAdIQWMjhm"}, {"id": "AUT_0023", "category": "AUTHORITY", "template": "When I was (insert before state) I was constantly (insert pain point).", "exampleUrl": "https://www.instagram.com/p/CzevtHvyxxX/"}, {"id": "AUT_0024", "category": "AUTHORITY", "template": "In (insert year) my business made (insert dollar amount).", "exampleUrl": "https://www.instagram.com/p/DEhk6r4ydum/"}, {"id": "AUT_0025", "category": "AUTHORITY", "template": "As a (insert title) for several years whose (insert action) I often get asked (insert name) (insert question).", "exampleUrl": "https://www.instagram.com/reel/DGRSq17OLPV/"}, {"id": "AUT_0026", "category": "AUTHORITY", "template": "I have never ended (insert noun) with a (insert result) or below.", "exampleUrl": "https://www.instagram.com/reel/DFfNiKHOzpr/"}, {"id": "AUT_0027", "category": "AUTHORITY", "template": "He/she (insert action) for one day and got (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DFp2byfojFu/"}, {"id": "AUT_0028", "category": "AUTHORITY", "template": "I jumped my (insert noun) from (insert before state) to (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DFsVpDVOAGf/"}, {"id": "AUT_0029", "category": "AUTHORITY", "template": "This used to be my (insert noun) this is my (insert noun) now.", "exampleUrl": "https://www.instagram.com/p/DDV4VwitJPo/"}, {"id": "AUT_0030", "category": "AUTHORITY", "template": "I have been able to go from this, to this.", "exampleUrl": "https://www.instagram.com/p/DGekQ-6NXjQ/"}, {"id": "AUT_0031", "category": "AUTHORITY", "template": "Things I wish I knew before my (insert noun) that took me from this to this.", "exampleUrl": "https://www.instagram.com/p/DGsXCTeS69Z/"}, {"id": "AUT_0032", "category": "AUTHORITY", "template": "The (insert noun) I (insert action) everyday that took me from this, to this.", "exampleUrl": "https://www.instagram.com/p/DGxOv7Rp2UE/"}, {"id": "AUT_0033", "category": "AUTHORITY", "template": "I went from this to this.", "exampleUrl": "https://www.instagram.com/p/DFIU9b7OS2h/"}, {"id": "AUT_0034", "category": "AUTHORITY", "template": "No because my transformation from (insert age) to (insert age) ought to be studied.", "exampleUrl": "https://www.instagram.com/p/DEOVBs8ygXs/"}, {"id": "AUT_0035", "category": "AUTHORITY", "template": "After (insert dream result) here is one thing I learned the hard way so you don't have to.", "exampleUrl": "https://www.instagram.com/p/DFdP6ttxN-a/"}, {"id": "AUT_0036", "category": "AUTHORITY", "template": "Okay bish you don't need to (insert action) to (insert dream result) coming from someone who (insert dream result).", "exampleUrl": "https://www.instagram.com/p/C6uiWv3p4FC/"}, {"id": "AUT_0037", "category": "AUTHORITY", "template": "I (insert dream result) in the past (insert time frame), here's proof.", "exampleUrl": "https://www.instagram.com/p/DHtmwvQRSUX/"}, {"id": "AUT_0038", "category": "AUTHORITY", "template": "Here's how my student/client/customer went from (insert before result) to (insert after result) and (insert symptom due to result).", "exampleUrl": "https://www.instagram.com/p/DGA-YAxJXIs/"}, {"id": "AUT_0039", "category": "AUTHORITY", "template": "% of the time when I am in (insert situation) I get (insert result), and today I will be showing you my (insert noun) routine so I can help you achieve (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DGg0dN5vAX1/"}, {"id": "AUT_0040", "category": "AUTHORITY", "template": "I (insert verb) for (insert time frame) and I got a (insert dream result).", "exampleUrl": "https://www.instagram.com/p/DFEFOlTRacT/"}, {"id": "AUT_0041", "category": "AUTHORITY", "template": "This is how I got my (insert noun) from this to this completely natural.", "exampleUrl": "https://www.instagram.com/p/DFJJImVx2VW/"}, {"id": "AUT_0042", "category": "AUTHORITY", "template": "Nobody believes me if I say I went from this to this.", "exampleUrl": "https://www.instagram.com/p/DIL_hAYIF-z/"}, {"id": "AUT_0043", "category": "AUTHORITY", "template": "These are the products I use to keep (insert noun) (insert noun) and (insert adjective) as a (insert title).", "exampleUrl": "https://www.instagram.com/p/DFZHR-Tvumy/"}, {"id": "AUT_0044", "category": "AUTHORITY", "template": "Same recipe but different (insert noun). For this (insert noun) I used my # tips to make (insert dream result) at home and you can really tell it makes a big difference.", "exampleUrl": "https://www.instagram.com/p/DHdWHu2sHJi/"}, {"id": "AUT_0045", "category": "AUTHORITY", "template": "(insert noun) is my second (insert noun) and here are the # (insert noun) I did over, and over, and over again to improve my (insert noun).", "exampleUrl": "https://www.instagram.com/p/DFSbi04zM8c/"}, {"id": "AUT_0046", "category": "AUTHORITY", "template": "How I took this (insert title) from 0 to (insert #) of (insert noun) in 1 week.", "exampleUrl": "https://www.instagram.com/p/DIMxxBuP23X/"}, {"id": "AUT_0047", "category": "AUTHORITY", "template": "I am only (insert metric) but I have became one of the best (insert title) in the world.", "exampleUrl": "https://www.instagram.com/reel/DGd3qJxS7el/?igsh=MXRuOHIydjVtOTUwZQ=="}, {"id": "DAY_0001", "category": "DAY IN THE LIFE", "template": "We all have the same 24 hours in a day so here I am putting my 24 hours to work.", "exampleUrl": "https://www.instagram.com/reel/DAq-UDcITU5/?igs"}, {"id": "DAY_0002", "category": "DAY IN THE LIFE", "template": "Day 1 of starting over my whole entire life.", "exampleUrl": "https://www.instagram.com/reel/DEc3jW6p1Ws/?igsh=M3draTd2OW11Ym80"}, {"id": "DAY_0003", "category": "DAY IN THE LIFE", "template": "So okay being an (insert target audience), my days vary quite a lot from one another.", "exampleUrl": "https://www.instagram.com/reel/DBiVM_Xxpwf/?igsh=MWc3ZTl1aGR1d250aQ%3D%3D"}, {"id": "DAY_0004", "category": "DAY IN THE LIFE", "template": "Day in the life of a (insert adjective) person.", "exampleUrl": "https://www.instagram.com/reel/DEiIMQxx8q3/?igsh=MXJwMW05cW5qYTVsbA=="}, {"id": "DAY_0005", "category": "DAY IN THE LIFE", "template": "Welcome back to the day in the life of two (insert label) trying to build the next (insert business).", "exampleUrl": "https://www.instagram.com/p/DEnSkHQJwIx/"}, {"id": "DAY_0006", "category": "DAY IN THE LIFE", "template": "(insert noun) day # (insert event about that day).", "exampleUrl": "https://www.instagram.com/reel/DICaRJ6BF2C/?igsh=eTZxamxwMTlsbjdx"}, {"id": "DAY_0007", "category": "DAY IN THE LIFE", "template": "I am a # year old (insert title), and I am heading to (insert event/location).", "exampleUrl": "https://www.instagram.com/p/DHmdSxESXUy/"}, {"id": "DAY_0008", "category": "DAY IN THE LIFE", "template": "This is a day in the life of a (insert title) (insert noun) edition.", "exampleUrl": "https://www.instagram.com/p/DFn2OKuzc7i/"}, {"id": "DAY_0009", "category": "DAY IN THE LIFE", "template": "Come to work with me as a (insert title).", "exampleUrl": "https://www.instagram.com/p/DEtaTDvsV6J/"}, {"id": "DAY_0010", "category": "DAY IN THE LIFE", "template": "(insert school) day #, my last (insert noun).", "exampleUrl": "https://www.instagram.com/p/DICaRJ6BF2C/"}, {"id": "DAY_0011", "category": "DAY IN THE LIFE", "template": "Day # of turning from (insert before state) to (insert after state) and suddenly I don't want to be (insert after state) anymore.", "exampleUrl": "https://www.instagram.com/p/DIfVFI6P_3Z/"}, {"id": "DAY_0012", "category": "DAY IN THE LIFE", "template": "Come with me to earn $ per day, with (insert avenue).", "exampleUrl": "https://www.instagram.com/reel/DHXVJGsRKa1/?igsh=MXd2Y2MyN2cybW1pcg=="}, {"id": "DAY_0013", "category": "DAY IN THE LIFE", "template": "Day # trying to make (insert $) by the end of the year, by (insert method).", "exampleUrl": "https://www.instagram.com/reel/DHSNzUypHDa/?igsh=MXZ6aTA1a283bHp0dw=="}, {"id": "DAY_0014", "category": "DAY IN THE LIFE", "template": "Day in the life of a future millionaire.", "exampleUrl": "https://www.instagram.com/reel/DF1Kq5CuULS/?igsh=YnBrcnpqbTVwcmsx"}, {"id": "DAY_0015", "category": "DAY IN THE LIFE", "template": "Day in the life as a (insert title) (insert noun) edition.", "exampleUrl": "https://www.instagram.com/reel/DGV-cE4v6Jy/?igsh=YWU2Zjk3MXpweGkw"}, {"id": "DAY_0016", "category": "DAY IN THE LIFE", "template": "This is what an average day of a (insert title) looks like a week out from (insert event).", "exampleUrl": "https://www.instagram.com/reel/DFdienFJMGK/?igsh=amZrMWdiZGxhd2g0"}];
let VIRAL_HOOKS = VIRAL_HOOKS_DATA;
const USED_HOOK_IDS = new Set();
const MAX_USED_HISTORY = 100;
function loadViralHooks() { console.log(`Hooks: ${VIRAL_HOOKS.length} embedded`); }

function getRelevantHooks(funnelStage, count = 25) {
  if (VIRAL_HOOKS.length === 0) return [];
  
  // Map funnel stages to hook categories
  const categoryMap = {
    'tof': ['EDUCATIONAL', 'MYTH BUSTING', 'DAY IN THE LIFE'],
    'mof': ['EDUCATIONAL', 'AUTHORITY', 'COMPARISON'],
    'bof': ['STORYTELLING', 'AUTHORITY', 'COMPARISON']
  };
  
  const categories = categoryMap[funnelStage] || ['EDUCATIONAL', 'STORYTELLING'];
  
  // Filter hooks by categories
  const filtered = VIRAL_HOOKS.filter(hook => 
    categories.includes(hook.category)
  );
  
  // Shuffle and return count
  const shuffled = filtered.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

// Returns a formatted block of REAL hooks for Claude to choose from.
// Claude picks from these — it does not invent hooks.
// ── TWO-CALL HOOK SYSTEM ────────────────────────────────────────────────────
// Call 1 (Haiku): reads all 1003 hooks + context.
//   Returns JSON array of objects: [{id, filledHook}]
//   Haiku selects the best IDs AND fills the template placeholders.
//   Node validates every ID — if it's not in VIRAL_HOOKS it's rejected.
//   Locks {id, template, filledHook} before Call 2 ever runs.
//
// Call 2 (Sonnet): receives pre-locked hook objects.
//   Writes ONLY: script, caption, filmIt, cta, overlay, title, platform, length.
//   Never asked to return hookId or hook text — those come from Node.
//   Node merges at the end: hookId/hook from Node, content from Sonnet.
//   EDU_004730 is structurally impossible.

async function selectAndFillHooksViaHaiku(count, context) {
  if (VIRAL_HOOKS.length === 0) return [];
  const categories = ['EDUCATIONAL','STORYTELLING','MYTH BUSTING','AUTHORITY','COMPARISON','DAY IN THE LIFE','RANDOM'];
  const usedIds = new Set(USED_HOOK_IDS);
  let slice = [];
  for (const cat of categories) {
    const pool = VIRAL_HOOKS.filter(h => h.category === cat && !usedIds.has(h.id)).sort(() => Math.random() - 0.5).slice(0, 20);
    slice.push(...pool);
  }
  slice = slice.sort(() => Math.random() - 0.5);
  const csvText = slice.map(h => `${h.id}|${h.category}|${h.template}`).join('\n');
  const prompt = `You are selecting hooks for Ian Green, portrait photographer Montreal.
ABOUT IAN: ${context}
TASK: Select exactly ${count} hooks, each from a DIFFERENT category. Fill all placeholders with portrait photography context.
RULES: Return ONLY a JSON array. IDs must exist exactly in database. No invented IDs.
FORMAT: [{"id":"EDU_0047","filledHook":"If you just booked your first headshot session and don't want to look stiff, here are 3 things to do immediately."}]
HOOK DATABASE (ID|Category|Template):
${csvText}`;
  let msg;
  try {
    msg = await anthropicCreate({ model:'claude-haiku-4-5-20251001', max_tokens:1500, temperature:1.0, messages:[{role:'user',content:prompt}] }, { label: 'selectAndFillHooksViaHaiku' });
  } catch(e) { console.error('Haiku error:',e.message); return []; }
  const text = msg.content[0].text.trim();
  let returned = [];
  try { const m = text.match(/\[.*\]/s); if(m) returned = JSON.parse(m[0]); } catch(e) { return []; }
  const hookMap = Object.fromEntries(VIRAL_HOOKS.map(h=>[h.id,h]));
  const validSet = new Set(VIRAL_HOOKS.map(h=>h.id));
  return returned.filter(item=>item&&typeof item.id==='string'&&validSet.has(item.id.trim())).map(item=>({
    id:item.id.trim(), category:hookMap[item.id.trim()].category, template:hookMap[item.id.trim()].template,
    exampleUrl:hookMap[item.id.trim()].exampleUrl, filledHook:item.filledHook||hookMap[item.id.trim()].template
  }));
}

// Fallback: random sample when Haiku fails completely
function randomHooks(count, funnelStage, pillar) {
  const categoryMap = {
    'Educate':   ['EDUCATIONAL', 'MYTH BUSTING', 'AUTHORITY'],
    'Entertain': ['STORYTELLING', 'DAY IN THE LIFE', 'RANDOM', 'COMPARISON'],
    'Tell':      ['STORYTELLING', 'DAY IN THE LIFE', 'AUTHORITY'],
    'Promote':   ['STORYTELLING', 'AUTHORITY', 'COMPARISON'],
  };
  const stageFallback = {
    'ToFu': ['EDUCATIONAL', 'MYTH BUSTING', 'DAY IN THE LIFE', 'STORYTELLING'],
    'MoFu': ['EDUCATIONAL', 'AUTHORITY', 'COMPARISON', 'STORYTELLING'],
    'BoFu': ['STORYTELLING', 'AUTHORITY', 'COMPARISON'],
  };
  const categories = categoryMap[pillar] || stageFallback[funnelStage] || ['EDUCATIONAL', 'STORYTELLING'];
  const filtered = VIRAL_HOOKS.filter(h => categories.includes(h.category));
  const sample = [...filtered].sort(() => Math.random() - 0.5).slice(0, count);
  // For fallback hooks, filledHook = raw template (no fill — Sonnet will handle it)
  return sample.map(h => ({ ...h, filledHook: h.template }));
}

// Format locked hook objects for the Sonnet prompt.
// Sonnet sees the pre-filled hook text and is told NOT to change it or return hookId.
function formatLockedHooks(hooks) {
  return hooks.map((h, i) => [
    `--- IDEA ${i + 1} HOOK (LOCKED — do not change this) ---`,
    `Hook text: "${h.filledHook}"`,
    `Hook ID: ${h.id} (do not include this in your JSON — Node will attach it)`,
  ].join('\n')).join('\n\n');
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
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const AI_LOG_PATH = process.env.AI_LOG_PATH || '';

function logAi(event, payload) {
  const line = `[AI ${event}] ${JSON.stringify(payload)}`;
  console.log(line);
  if (AI_LOG_PATH) {
    try {
      fs.appendFileSync(AI_LOG_PATH, line + '\n');
    } catch (e) {
      console.error('[AI LOG WRITE ERROR]', e.message);
    }
  }
}

function summarizeAnthropicResponse(resp) {
  const text = (resp?.content || [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text || '')
    .join('\n')
    .slice(0, 800);
  return {
    id: resp?.id,
    model: resp?.model,
    stop_reason: resp?.stop_reason,
    usage: resp?.usage || null,
    text_preview: text,
  };
}

async function anthropicCreate(payload, { label = 'anthropic.messages.create' } = {}) {
  const req = { ...payload, model: AI_MODEL };
  logAi('REQUEST', { label, model: req.model, max_tokens: req.max_tokens, system: req.system ? '[present]' : '[none]', messages: req.messages });
  const resp = await anthropic.messages.create(req);
  logAi('RESPONSE', { label, ...summarizeAnthropicResponse(resp) });
  return resp;
}

// ── PHIXO STRATEGY SYSTEM PROMPT ─────────────────────────────────────────────
const PHIXO_STRATEGY_SYSTEM = `
You are a content ideation assistant for Phixo, a portrait photography studio in West Island Montreal run by Ian Green. You generate content ideas EXCLUSIVELY based on the strategy rules below. Nothing invented outside these rules.

━━━ WHO IAN IS ━━━
- Portrait photographer, West Island Montreal, basement studio
- Full-time IT job, Phixo capped at 10-12 sessions/month side hustle
- Studied digital photography at Algonquin College 10+ years ago, returned after a decade in IT
- Ian is always the subject in all content. No clients can be filmed without consent.
- New to Montreal — nobody knows his name yet. Content builds familiarity from scratch.

━━━ THE ONE TRUE THING ━━━
People want a photo that actually looks like them. Some need help getting there. Some just show up ready. Either way, the job is the same — create the conditions where that can happen. Every piece of content either connects back to that or it doesn't.

━━━ THE VOICE — READ THIS CAREFULLY ━━━
The voice is not a style. It is how Ian actually thinks out loud. Sentences move forward. Nothing stops to reflect on itself. The point arrives without being announced. Personal admissions land in one clause and are gone — they don't become a moment.

Here is what WRONG looks like, followed by RIGHT. Study the difference. Write RIGHT every time.

---
EDUCATE — WRONG:
"Most people don't realize that the background in a portrait does more work than the subject. It's actually one of the most overlooked elements of a strong image — and understanding it can completely change how your photos feel."
Why it's wrong: stops to admire its own insight. "It's actually one of the most overlooked" is performing. The ending explains the value instead of demonstrating it.

EDUCATE — RIGHT:
"The background in a portrait is doing more work than the subject. Cluttered background, cluttered photo. Doesn't matter how good the light is. Clean it up first, then worry about everything else."
Why it works: moves forward the whole time. Makes the point and goes. No sentence wraps up the one before it.

---
TELL — WRONG:
"I had a client recently who came in really nervous — she almost cancelled three times. By the end of the session she was laughing and couldn't believe how the photos turned out. That's the moment I remember why I do this."
Why it's wrong: "That's the moment I remember why I do this" is the ending performing emotion. It tells you how to feel about the story.

TELL — RIGHT:
"Had someone come in last week who almost cancelled twice. First ten minutes she wouldn't look directly at the camera. By the end she's turning to the screen saying 'wait, that's me?' That's the whole job right there."
Why it works: ends at the real thing that happened. "That's the whole job right there" is observation, not emotion cue.

---
ENTERTAIN — WRONG:
"There's a certain irony in the fact that the people who are most nervous about having their photo taken are often the ones who end up with the best portraits. The camera has a way of catching something real when you stop performing for it."
Why it's wrong: over-written. "A certain irony" and "when you stop performing for it" are trying to sound good.

ENTERTAIN — RIGHT:
"The people who tell me they're unphotogenic always end up with the best shots. Every time. I don't know what to tell you, that's just what happens."
Why it works: short, landed, slightly absurd. Doesn't explain itself.

---
PROMOTE — WRONG:
"If you've been thinking about booking a session, I'd love to chat about what that could look like for you. My studio is a relaxed, comfortable space where we work together to create something you'll actually be proud of."
Why it's wrong: selling sideways. "I'd love to chat" and "something you'll actually be proud of" are hedging and flattering at the same time.

PROMOTE — RIGHT:
"Session is 30 minutes. You see the photos on a screen as we go so you're not waiting a week wondering if they're any good. Pricing's on the site. If you've got questions just DM me."
Why it works: direct. Answers the actual questions someone has before booking. No charm offensive.

---
STRUCTURAL RULES that come from these examples:
- Sentences move forward. Never use a sentence to recap what the previous sentence just said.
- The point shows up without being announced. No "that's why," no "that's the thing," no "and that matters because."
- Personal admissions are one clause, then the script moves on. Not a vulnerability moment.
- End at the last real thing. Not a wrap-up, not a callback, not a lesson stated out loud.
- "Now for the fun part" is fine. Conversational interjections that sound like Ian talking are fine.
- Specific beats plain every time. "Crunchy, over-processed look" beats "artificial appearance."
- Never use: stunning, perfect, gorgeous, transformative, journey, authentic, or any AI hype language.
- "I" = Ian personally. "We" = studio experience with a client. Never reversed.
- No emojis.

━━━ CONTENT FORMAT ━━━
Default: talking-head vertical video. Ian in a car, a chair, edge of a desk. No production. Window light works. 30-60 seconds. Start mid-thought — no "hey guys." One idea per video. Get in, get out.

━━━ CONTENT PILLARS + FUNNEL MAPPING ━━━
EDUCATE (ToFu + MoFu): Teach something useful. Moves forward, demonstrates knowledge, no padding.
ENTERTAIN (ToFu): Stop the scroll. Short, landed, slightly unexpected. Doesn't over-explain.
TELL (MoFu): A real moment, told simply. First person, specific. Ends at the thing that happened.
PROMOTE (BoFu): Direct info — pricing, process, how to book. Answers the real question. No charm.

━━━ FUNNEL STAGES ━━━
ToFu — Strangers scrolling. Best: Educate, Entertain.
MoFu — Warm audience looking around. Best: Educate, Tell.
BoFu — Someone basically decided. Best: Promote.

━━━ CLIENT LANES (ALL EQUAL) ━━━
Lane 1 Career & Professional: Professionals, job seekers, leaders, founders. Want a photo that matches where they are headed. Efficient. Show up for: new job, promotion, rebrand.
Lane 2 Personal & Milestone: Graduates, young women, creatives. Want a portrait that feels like them. Some camera-shy, some confident. Show up for: graduation, birthday, milestone, feeling good.
Lane 3 Family & Legacy: Families, couples, multi-generational. Want to preserve a connection. Show up for: birthdays, anniversaries, reunions, holidays.

━━━ PROOF PHRASES (evidence only, never taglines) ━━━
Tethered Shooting — always followed by: "images appear on screen in real time so you can see and adjust as we go"
Natural Retouching — cleans things up without replacing you
`.trim();



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

function getDocs(req) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials(req.session.tokens);
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token) req.session.tokens.refresh_token = tokens.refresh_token;
    req.session.tokens.access_token = tokens.access_token;
    req.session.tokens.expiry_date = tokens.expiry_date;
  });
  return google.docs({ version: 'v1', auth });
}
app.get('/auth/login', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/userinfo.email'],
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
  res.json({
    ok: true,
    db: dbOk,
    DATABASE_URL: hasDb ? 'set' : 'MISSING',
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? 'set' : 'MISSING',
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING',
    SERPER_API_KEY: process.env.SERPER_API_KEY ? 'set' : 'MISSING',
  });
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
                     'content_payload','thumbnail_url','drive_file_id','is_reference'];
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
  try {
    // Get block first to find Drive file
    const b = await pool.query('SELECT drive_file_id, type FROM blocks WHERE id=$1', [req.params.id]);
    if (b.rows.length && b.rows[0].drive_file_id) {
      const fileId = b.rows[0].drive_file_id;
      // Don't delete Drive thumbnails saved separately — only the actual block file
      try {
        const drive = getDrive(req);
        await drive.files.delete({ fileId });
        console.log(`Deleted Drive file: ${fileId}`);
      } catch(e) {
        console.warn(`Drive delete failed for ${fileId}: ${e.message}`);
        // Continue — still delete from DB even if Drive fails
      }
    }
    await pool.query('DELETE FROM blocks WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// RESEARCH LIBRARY - Generate ideas from reference videos
// ═══════════════════════════════════════════════════

app.post('/api/research/generate-ideas', requireAuth, async (req, res) => {
  try {
    const { funnel_stage, tags, count = 3 } = req.body;
    
    // Build query to find reference videos
    let query = `
      SELECT id, title, content_payload, metadata, tags, source_url, funnel_stage
      FROM blocks
      WHERE type = 'video'
        AND is_reference = true
    `;
    const params = [];
    
    // Add funnel stage filter
    if (funnel_stage) {
      params.push(funnel_stage);
      query += ` AND funnel_stage = $${params.length}`;
    }
    
    // Add tags filter if provided
    if (tags && tags.length > 0) {
      const tagArray = Array.isArray(tags) ? tags : tags.split(',').map(t => t.trim());
      params.push(tagArray);
      query += ` AND tags && $${params.length}::text[]`;
    }
    
    query += ` ORDER BY created_at DESC LIMIT 7`;
    
    const videosResult = await pool.query(query, params);
    
    if (videosResult.rows.length === 0) {
      return res.status(404).json({
        error: 'No reference videos found',
        message: 'Mark some videos as "reference" first by checking the box in video block details',
        suggestion: 'Open a video block and check "Use as reference for idea generation"'
      });
    }
    
    // Build smart summaries from video blocks
    const videoSummaries = videosResult.rows.map((v, idx) => {
      const transcript = v.content_payload || '';
      const metadata = v.metadata || {};
      const keyPoints = metadata.key_points || [];
      const hook = transcript.split('\n')[0] || metadata.hook || '';
      
      return `
VIDEO #${v.id}: ${v.title}
Hook: "${hook}"
Format: ${metadata.format || 'Standard video'}
Key Points: ${keyPoints.slice(0, 3).join(' • ') || 'N/A'}
Source: ${v.source_url || 'N/A'}
`.trim();
    });
    
    // Call 1: Haiku selects IDs from all 1003 hooks AND fills template placeholders
    const hookContext = `Ian Green, portrait photographer, West Island Montreal. Side hustle, 10-12 sessions/month. Warm direct voice, no hype. Funnel stage: ${funnel_stage || 'ToFu'}. Content type: reference video adaptation.`;
    let selectedHooks = [];
    try {
      selectedHooks = await selectAndFillHooksViaHaiku(count, hookContext);
    } catch (e) {
      console.error('Hook selection failed, using random fallback:', e.message);
    }
    if (selectedHooks.length < count) {
      const fallback = randomHooks(count - selectedHooks.length, funnel_stage || 'ToFu', '');
      selectedHooks = [...selectedHooks, ...fallback].slice(0, count);
    }
    const lockedHooks = formatLockedHooks(selectedHooks);

    // Call 2: Sonnet writes content only — hook text already locked by Node
    const claudePrompt = `
REFERENCE VIDEOS (proven ${funnel_stage || 'content'} performers from Research Library):

${videoSummaries.join('\n\n')}

${lockedHooks}

TASK:
Generate ${count} content ideas for Phixo adapted from these reference videos.
Timestamp: ${Date.now()}

CRITICAL: Each idea's hook text is already written above and LOCKED. 
Do NOT include hookId or hookTemplate in your JSON — Node will attach those.
Do NOT rewrite or change the hook text.
Your job: write everything else.

For each idea return (JSON array, in order matching the IDEA numbers above):
1. title — short, what the video is about
2. script — what Ian says. 4-8 sentences. Write like the RIGHT examples. Moves forward, no wrap-up.
3. overlay — text on screen, empty string if none
5. caption — in Ian's voice, no emojis
6. filmIt — numbered steps: where to sit, what to do, how long
7. cta — call to action if any
8. platform — TikTok, Instagram, etc.
9. length — estimated seconds
10. sourceInspiration — which video block inspired this

Format as JSON array only. No preamble, no markdown fences.`;

    const message = await anthropicCreate({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 1.0,
      system: PHIXO_STRATEGY_SYSTEM,
      messages: [{ role: 'user', content: claudePrompt }]
    });
    
    // Parse Claude's response
    let ideas = [];
    const responseText = message.content[0].text;
    
    // Try to extract JSON from response
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        ideas = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error('JSON parse error:', parseErr);
        return res.json({
          raw: responseText,
          error: 'Failed to parse JSON, returning raw response'
        });
      }
    } else {
      return res.json({
        raw: responseText,
        error: 'No JSON found in response'
      });
    }
    
    // Node merge: attach real hookId/hookTemplate from validated CSV
    ideas = ideas.map((idea, i) => {
      const hook = selectedHooks[i];
      if (!hook) return idea;
      return {
        ...idea,
        hook: hook.filledHook,
        hookId: hook.id,
        hookTemplate: hook.template,
        exampleUrl: hook.exampleUrl
      };
    });

    res.json({
      ideas,
      sourcesUsed: videosResult.rows.length,
      funnelStage: funnel_stage || 'all',
      tags: tags || []
    });
    
  } catch (err) {
    console.error('Generate ideas error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CONTENT IDEATION — Strategy Hub as the only data source ─────────────────
// Three modes: scratch (pillar+funnel), riff (variations on seed), research (from block)
app.post('/api/content/ideate', requireAuth, async (req, res) => {
  try {
    const { mode = 'scratch', funnel_stage, pillar, lane, seed_idea, block_ids, count = 3 } = req.body;
    let userPrompt = '';

    // ── CALL 1: Haiku selects IDs + fills template placeholders ─────────────────
    // Node validates every ID. lockedHooks = [{id, template, filledHook}] from real CSV.
    // Sonnet never touches hookId or hook text — those are set here and merged after Call 2.
    const hookContext = `Ian Green, portrait photographer, West Island Montreal. Side hustle 10-12 sessions/month. Warm direct voice, no hype. Mode: ${mode}. Pillar: ${pillar || 'mixed'}. Funnel: ${funnel_stage || 'mixed'}. Lane: ${lane || 'any'}.`;
    let selectedHooks = [];
    try {
      selectedHooks = await selectAndFillHooksViaHaiku(count, hookContext);
    } catch (e) {
      console.error('Hook selection failed, using random fallback:', e.message);
    }
    if (selectedHooks.length < count) {
      const fallback = randomHooks(count - selectedHooks.length, funnel_stage || 'ToFu', pillar || '');
      selectedHooks = [...selectedHooks, ...fallback].slice(0, count);
    }
    const lockedHooks = formatLockedHooks(selectedHooks);

    // ── BUILD PROMPT per mode ─────────────────────────────────────────────────
    if (mode === 'scratch') {
      if (!funnel_stage || !pillar) return res.status(400).json({ error: 'funnel_stage and pillar required' });
      userPrompt = `Generate ${count} original Phixo content ideas.

PARAMETERS:
- Funnel Stage: ${funnel_stage}
- Content Pillar: ${pillar}
- Client Lane Focus: ${lane || 'any - mix across all three lanes'}
- Timestamp: ${Date.now()}

${lockedHooks}

CRITICAL: Each idea's hook text is already written above and LOCKED.
Do NOT include hookId or hookTemplate in your JSON — Node attaches those automatically.
Do NOT rewrite or modify the hook text. Copy it exactly as written for that idea number.

For each idea return (in order matching IDEA numbers above):
1. title
2. pillar
3. funnelStage
4. lane
5. script — what Ian actually says. 4-8 sentences. Write like the RIGHT examples. Moves forward, no wrap-up.
6. overlay — optional on-screen text, empty string if none
8. caption — in Ian's voice, no emojis
9. filmIt — numbered steps: where to sit, what to do, how long
10. cta — none for ToFu, soft trail for MoFu, direct for BoFu
11. length — estimated seconds

Return as a JSON array only. No preamble, no markdown fences.`;

    } else if (mode === 'riff') {
      if (!seed_idea) return res.status(400).json({ error: 'seed_idea required' });
      userPrompt = `Build ${count} variations from this existing Phixo content idea. Each must be meaningfully different — different angle, different lane, different funnel stage.

SEED IDEA:
${seed_idea}

${lockedHooks}

Rules:
- At least one variation must shift the funnel stage from the seed
- At least one variation must target a different client lane
- Each variation's hook is already locked above. Do not change it.

CRITICAL: Do NOT include hookId or hookTemplate in your JSON — Node attaches those.

For each variation return (in order matching IDEA numbers above):
1. title
2. pillar
3. funnelStage
4. lane
5. script — write like the RIGHT examples
6. overlay
8. caption
9. filmIt
10. cta
11. length
12. variationNote — one sentence: what is different about this angle

Return as a JSON array only. No preamble, no markdown fences.`;

    } else if (mode === 'research') {
      const ids = Array.isArray(block_ids) ? block_ids : [block_ids];
      if (!ids.length || !ids[0]) return res.status(400).json({ error: 'block_ids required' });

      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const blockResult = await pool.query(
        `SELECT id, title, content_payload, metadata, tags, source_url, type FROM blocks WHERE id IN (${placeholders})`,
        ids
      );
      if (blockResult.rows.length === 0) return res.status(404).json({ error: 'No blocks found' });

      const blockSummaries = blockResult.rows.map(block => {
        const meta = block.metadata || {};
        const transcript = block.content_payload || '';
        const keyPoints = (meta.key_points || []).slice(0, 5).join('\n- ');
        const opening = transcript.split('\n')[0] || meta.hook || '';
        return `BLOCK #${block.id}: ${block.title} (${block.type})
Source: ${block.source_url || 'N/A'}
Opening: "${opening}"
Key points:\n- ${keyPoints || 'See transcript'}
Transcript excerpt: ${transcript.slice(0, 600)}`;
      }).join('\n\n---\n\n');

      userPrompt = `Generate ${count} Phixo content ideas inspired by these research blocks. Ian is always the subject. The block inspires format or structure — the voice and content are Ian's.

RESEARCH BLOCKS:
${blockSummaries}

${lockedHooks}

CRITICAL: Each idea's hook is already locked above. Do NOT include hookId or hookTemplate in your JSON — Node attaches those.

For each idea return (in order matching IDEA numbers above):
1. title
2. pillar
3. funnelStage
4. lane
5. script — write like the RIGHT examples
6. overlay
8. caption
9. filmIt
10. cta
11. length
12. sourceAdaptation — one sentence: what format or concept came from the block

Return as a JSON array only. No preamble, no markdown fences.`;

    } else {
      return res.status(400).json({ error: 'mode must be scratch, riff, or research' });
    }

    // ── CALL 2: Sonnet ideates with pre-assigned real hooks ───────────────────
    const message = await anthropicCreate({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      temperature: 1.0,
      system: PHIXO_STRATEGY_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.status(500).json({ error: 'No JSON in response', raw: responseText });

    let ideas;
    try { ideas = JSON.parse(jsonMatch[0]); }
    catch (e) { return res.status(500).json({ error: 'Failed to parse ideas JSON', raw: responseText }); }

    // ── NODE MERGE: attach real hookId, hookTemplate, exampleUrl from validated CSV ──
    // Sonnet was never asked to return these — we set them here from selectedHooks.
    // This is the structural guarantee that hookId is always real and always correct.
    ideas = ideas.map((idea, i) => {
      const hook = selectedHooks[i];
      if (!hook) return idea;
      return {
        ...idea,
        hook: hook.filledHook,
        hookId: hook.id,                       // always from real CSV — never from Sonnet
        hookTemplate: hook.template,           // always from real CSV — never from Sonnet
        exampleUrl: hook.exampleUrl            // always from real CSV
      };
    });

    selectedHooks.forEach(h => {
      USED_HOOK_IDS.add(h.id);
      if (USED_HOOK_IDS.size > MAX_USED_HISTORY) USED_HOOK_IDS.delete(USED_HOOK_IDS.values().next().value);
    });
    res.json({ ideas, mode, count: ideas.length });

  } catch (err) {
    console.error('Ideation error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Upload file → Drive → create block
app.post('/api/blocks/upload', requireAuth, upload.single('file'), async (req, res) => {
  const os = require('os');
  const tmpFile = require('path').join(os.tmpdir(), `phixo-up-${Date.now()}-${req.file ? req.file.originalname : 'file'}`);
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const { type, title, category, tags, funnel_stage } = req.body;
    const drive = getDrive(req);
    const isVideo = req.file.mimetype.startsWith('video/');

    console.log(`Upload: ${req.file.originalname} (${req.file.mimetype}, ${Math.round(req.file.size/1024)}KB)`);

    // Write buffer to temp file (more reliable than Readable.from for large files)
    require('fs').writeFileSync(tmpFile, req.file.buffer);

    // Get/create folder based on type
    const folderName = {
      pose: 'Pose', meme: 'Meme', sfx: 'SFX', pdf: 'Phixo Knowledge', video: 'Videos'
    }[type] || 'Phixo Research';

    let folderId;
    const fsRes = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)'
    });
    if (fsRes.data.files.length) {
      folderId = fsRes.data.files[0].id;
    } else {
      const f = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      folderId = f.data.id;
      console.log(`Created Drive folder: ${folderName}`);
    }

    // Upload to Drive using file stream
    const { createReadStream } = require('fs');
    const uploaded = await drive.files.create({
      requestBody: { name: req.file.originalname, parents: [folderId] },
      media: { mimeType: req.file.mimetype, body: createReadStream(tmpFile) },
      fields: 'id, thumbnailLink, webViewLink'
    });
    console.log(`Uploaded to Drive: ${uploaded.data.id} in folder ${folderName}`);

    // Generate PDF thumbnail using ffmpeg (render first page)
    const isPdf = req.file.mimetype === 'application/pdf';
    if (isPdf && global.FFMPEG_PATH) {
      try {
        const pdfThumbPath = tmpFile + '_thumb.jpg';
        await require('util').promisify(require('child_process').exec)(
          `"${global.FFMPEG_PATH}" -i "${tmpFile}" -vframes 1 -vf "scale=480:-2" "${pdfThumbPath}" -y`,
          { timeout: 30000 }
        );
        if (require('fs').existsSync(pdfThumbPath)) {
          const thumbBuf = require('fs').readFileSync(pdfThumbPath);
          thumbnailUrl = 'data:image/jpeg;base64,' + thumbBuf.toString('base64');
          require('fs').unlinkSync(pdfThumbPath);
          console.log('PDF thumbnail generated');
        }
      } catch(e) {
        console.warn('PDF thumbnail failed (ffmpeg may not support PDF):', e.message.substring(0,80));
      }
    }

    // Extract video thumbnail frame using ffmpeg
    let thumbnailUrl = null; // set below based on type
    let thumbDriveId = null;
    if (isVideo && global.FFMPEG_PATH) {
      try {
        const thumbPath = tmpFile + '_thumb.jpg';
        await require('util').promisify(require('child_process').exec)(
          `"${global.FFMPEG_PATH}" -i "${tmpFile}" -ss 00:00:02 -vframes 1 -vf "scale=480:-2" "${thumbPath}" -y`,
          { timeout: 30000 }
        );
        if (require('fs').existsSync(thumbPath)) {
          const isMeme = (type === 'meme');
          if (isMeme) {
            // Store as base64 data URL — no Drive upload needed
            const thumbBuf = require('fs').readFileSync(thumbPath);
            thumbnailUrl = 'data:image/jpeg;base64,' + thumbBuf.toString('base64');
            console.log('Meme thumbnail stored as data URL (' + Math.round(thumbBuf.length/1024) + 'KB)');
          } else {
            const thumbUp = await drive.files.create({
              requestBody: { name: req.file.originalname + '_thumb.jpg', parents: [folderId] },
              media: { mimeType: 'image/jpeg', body: createReadStream(thumbPath) },
              fields: 'id'
            });
            thumbDriveId = thumbUp.data.id;
            thumbnailUrl = `/api/drive/file/${thumbDriveId}`;
            console.log('Video thumbnail extracted and uploaded');
          }
          require('fs').unlinkSync(thumbPath);
        }
      } catch(e) {
        console.warn('Video thumbnail extraction failed:', e.message);
      }
    }

    const tagArr = tags ? tags.split(',').map(t=>t.trim()).filter(Boolean) : [];
    const blockType = type || (isVideo ? 'video' : 'image');
    const r = await pool.query(
      `INSERT INTO blocks (type,title,category,tags,funnel_stage,source,drive_file_id,
        file_name,file_mime,thumbnail_url) VALUES ($1,$2,$3,$4,$5,'upload',$6,$7,$8,$9) RETURNING *`,
      [blockType, title||req.file.originalname, category, tagArr, funnel_stage,
       uploaded.data.id, req.file.originalname, req.file.mimetype, thumbnailUrl]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Upload error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  } finally {
    try { if (require('fs').existsSync(tmpFile)) require('fs').unlinkSync(tmpFile); } catch(e) {}
  }
});

// ═══════════════════════════════════════════════════
// PHOTOGRAPHY KNOWLEDGE BASE — RAG ingest (PDF → Python pipeline)
// ═══════════════════════════════════════════════════

async function runQuestionGenerationPy({ source, topic, subTopic = '', collection = KB_DEFAULT_COLLECTION }) {
  const dbPath = path.join(DATA_PATH, 'chromadb');
  const pyArgs = [
    path.join(INTELLIGENCE_DIR, 'scripts', 'generate_suggested_questions.py'),
    '--source', source,
    '--topic', topic || 'general',
    '--db-path', dbPath,
    '--collection', collection,
  ];
  if (subTopic && subTopic.trim()) pyArgs.push('--sub-topic', subTopic.trim());
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', pyArgs, {
      cwd: INTELLIGENCE_DIR,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || 'question generation failed'));
      try {
        const parsed = JSON.parse(stdout);
        return resolve(normalizeQuestionList(parsed));
      } catch (e) {
        return reject(new Error('Invalid JSON from question generator'));
      }
    });
  });
}

async function runAllBooksQuestionGenerationPy({ topicFocus, subTopic = '' }) {
  const dbPath = path.join(DATA_PATH, 'chromadb');
  const pyArgs = [
    path.join(INTELLIGENCE_DIR, 'scripts', 'generate_suggested_questions.py'),
    '--topic-focus', topicFocus || 'all',
    '--db-path', dbPath,
    '--collection', KB_DEFAULT_COLLECTION,
  ];
  if (subTopic && subTopic.trim()) pyArgs.push('--sub-topic', subTopic.trim());
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', pyArgs, {
      cwd: INTELLIGENCE_DIR,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || 'question generation failed'));
      try {
        const parsed = JSON.parse(stdout);
        return resolve(normalizeQuestionList(parsed));
      } catch (e) {
        return reject(new Error('Invalid JSON from question generator'));
      }
    });
  });
}

async function deleteBookChunksPy({ sourceDocument }) {
  const dbPath = path.join(DATA_PATH, 'chromadb');
  const pyArgs = [
    path.join(INTELLIGENCE_DIR, 'scripts', 'delete_book_chunks.py'),
    '--source-document', sourceDocument,
    '--db-path', dbPath,
    '--collection', KB_DEFAULT_COLLECTION,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', pyArgs, {
      cwd: INTELLIGENCE_DIR,
      env: {
        ...process.env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || 'delete book chunks failed'));
      try {
        const parsed = JSON.parse(stdout);
        return resolve(parsed);
      } catch (e) {
        return resolve({ ok: true });
      }
    });
  });
}

async function listAlgonquinDocumentsPy() {
  const dbPath = path.join(DATA_PATH, 'chromadb');
  const pyArgs = [
    path.join(INTELLIGENCE_DIR, 'scripts', 'list_algonquin_documents.py'),
    '--source-document',
    KB_ALGONQUIN_SOURCE_DOCUMENT,
    '--db-path',
    dbPath,
    '--collection',
    KB_ALGONQUIN_COLLECTION,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', pyArgs, {
      cwd: INTELLIGENCE_DIR,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || 'list algonquin documents failed'));
      try {
        return resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        return reject(new Error('Invalid JSON from list_algonquin_documents.py'));
      }
    });
  });
}

async function deleteAlgonquinDocumentPy({ bookSlug }) {
  const dbPath = path.join(DATA_PATH, 'chromadb');
  const pyArgs = [
    path.join(INTELLIGENCE_DIR, 'scripts', 'delete_algonquin_document.py'),
    '--book-slug',
    bookSlug,
    '--db-path',
    dbPath,
    '--collection',
    KB_ALGONQUIN_COLLECTION,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', pyArgs, {
      cwd: INTELLIGENCE_DIR,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || 'delete algonquin document failed'));
      try {
        return resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        return reject(new Error('Invalid JSON from delete_algonquin_document.py'));
      }
    });
  });
}

const kbQuestionJobsInFlight = new Set();

async function generateAndStoreQuestions({ bookId, sourceDocument, topic, collection, subTopic = '', markAsInitial = false }) {
  const key = String(bookId);
  if (kbQuestionJobsInFlight.has(key)) return;
  kbQuestionJobsInFlight.add(key);
  try {
    const questions = await runQuestionGenerationPy({ source: sourceDocument, topic, subTopic, collection });
    await pool.query(
      `UPDATE kb_books
       SET suggested_questions = $2::jsonb,
           questions_generated_at = NOW(),
           questions_generation_status = 'ready',
           questions_generation_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [bookId, JSON.stringify(questions)]
    );
    if (markAsInitial) {
      appendIngestLog({
        status: 'QUESTIONS_GENERATED',
        source: sourceDocument,
        model: KB_QUESTION_MODEL,
        sampleSize: 10,
        generatedCount: questions.length,
      });
    }
  } catch (err) {
    await pool.query(
      `UPDATE kb_books
       SET questions_generation_status = 'error',
           questions_generation_error = LEFT($2, 1500),
           updated_at = NOW()
       WHERE id = $1`,
      [bookId, String(err?.message || err || 'unknown error')]
    );
    if (markAsInitial) {
      appendIngestLog({
        status: 'QUESTIONS_ERROR',
        source: sourceDocument,
        model: KB_QUESTION_MODEL,
        sampleSize: 10,
        message: String(err?.message || err || 'unknown error'),
      });
    }
  } finally {
    kbQuestionJobsInFlight.delete(key);
  }
}

async function processCompletedIngestsForQuestionGeneration() {
  try {
    const events = readIngestLogEvents();
    const completedSources = new Set(
      events
        .filter((ev) => String(ev.status || '').toUpperCase() === 'INGEST_COMPLETE' && ev.source)
        .map((ev) => String(ev.source))
    );
    if (!completedSources.size) return;
    const rows = (await pool.query(
      `SELECT id, source, title, topic, questions_generated_at
       FROM kb_books
       WHERE source = ANY($1::text[])`,
      [Array.from(completedSources)]
    )).rows || [];
    for (const row of rows) {
      if (row.questions_generated_at) continue;
      const isAlgonquin = String(row.topic || '').trim() === 'algonquin-college';
      const sourceDocument = isAlgonquin ? String(row.title || '').trim() : String(row.source || '').trim();
      if (!sourceDocument) continue;
      await generateAndStoreQuestions({
        bookId: row.id,
        sourceDocument,
        topic: row.topic || 'general',
        collection: isAlgonquin ? 'algonquin-college' : KB_DEFAULT_COLLECTION,
        subTopic: '',
        markAsInitial: true,
      });
    }
  } catch (err) {
    console.warn('processCompletedIngestsForQuestionGeneration skipped:', err.message);
  }
}

app.post('/api/knowledge/ingest-pdf', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported right now' });
    }
    const { source, author, topic } = req.body;
    if (!source || !author) {
      return res.status(400).json({ error: 'Source and author are required' });
    }

    // Ensure data directories exist
    try {
      fs.mkdirSync(DATA_PATH, { recursive: true });
      fs.mkdirSync(path.join(DATA_PATH, 'uploads'), { recursive: true });
      fs.mkdirSync(path.join(DATA_PATH, 'chunks'), { recursive: true });
      fs.mkdirSync(path.join(DATA_PATH, 'chromadb'), { recursive: true });
      fs.mkdirSync(path.join(DATA_PATH, 'images'), { recursive: true });
    } catch (e) {
      console.error('Failed to ensure DATA_PATH directories:', e.message);
    }

    const topicValue = topic || 'general';
    if (String(topicValue || '').trim() === 'algonquin-college') {
      return res.status(400).json({ error: 'Algonquin College files must be ingested via "Add to Algonquin College" (persistent KB).' });
    }
    let bookId = null;
    try {
      const up = await pool.query(
        `INSERT INTO kb_books (source, author, topic, questions_generation_status, questions_generated_at, questions_generation_error, updated_at)
         VALUES ($1, $2, $3, 'pending', NULL, NULL, NOW())
         ON CONFLICT (source)
         DO UPDATE SET
           author = EXCLUDED.author,
           topic = EXCLUDED.topic,
           questions_generation_status = 'pending',
           questions_generated_at = NULL,
           questions_generation_error = NULL,
           updated_at = NOW()
         RETURNING id`,
        [source, author, topicValue]
      );
      bookId = up.rows[0]?.id || null;
    } catch (e) {
      console.error('Failed to upsert kb_books row:', e.message);
      return res.status(500).json({ error: 'Failed to store book metadata' });
    }
    // Save the PDF to a temporary uploads folder under DATA_PATH
    const safeName = (req.file.originalname || 'book.pdf').replace(/[^a-zA-Z0-9_.-]+/g, '_');
    const shortId = Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    const uploadPath = path.join(DATA_PATH, 'uploads', `${shortId}-${safeName}`);
    fs.writeFileSync(uploadPath, req.file.buffer);

    // Log that this ingest job has been queued
    appendIngestLog({
      jobId: shortId,
      status: 'queued',
      bookId,
      source,
      author,
      topic: topicValue,
      filename: safeName,
      queuedAt: new Date().toISOString(),
    });

    // Spawn the Python pipeline in the background: add_book.py
    const pyArgs = [
      path.join(INTELLIGENCE_DIR, 'scripts', 'add_book.py'),
      uploadPath,
      '--source', source,
      '--author', author,
      '--topic', topicValue,
      '--out-dir', path.join(DATA_PATH, 'chunks'),
      '--db-path', path.join(DATA_PATH, 'chromadb'),
      '--job-id', shortId,
      '--log-path', INGEST_LOG_PATH,
    ];

    try {
      const child = spawn('python3', pyArgs, {
        cwd: INTELLIGENCE_DIR,
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        },
      });
      child.unref();
    } catch (e) {
      console.error('Failed to spawn add_book.py:', e.message);
      return res.status(500).json({ error: 'Failed to start background ingest job' });
    }

    return res.status(202).json({
      message: 'Book queued for processing. This may take a few minutes.',
      jobId: shortId,
      bookId,
    });
  } catch (err) {
    console.error('Knowledge ingest error:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Algonquin College persistent KB ingest (multi-file, accumulates forever)
// Chroma collection: `algonquin-college`
// DB row (kb_books): source='algonquin-college', title='Algonquin College Photography Program'
// ════════════════════════════════════════════════════════════════════════════

const KB_ALGONQUIN_COLLECTION = 'algonquin-college';
const KB_ALGONQUIN_ROW_SOURCE = 'algonquin-college';
const KB_ALGONQUIN_SOURCE_DOCUMENT = 'Algonquin College Photography Program';
const KB_ALGONQUIN_TOPIC = 'algonquin-college';

const algonquinIngestJobs = new Map(); // jobId -> { files: [...], state: 'running'|'done' }

function newAlgonquinJobId() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

function parseLastJsonLine(stdout) {
  if (!stdout) return null;
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith('{') && l.endsWith('}')) {
      try { return JSON.parse(l); } catch (_) { /* keep searching */ }
    }
  }
  return null;
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function pruneAlgonquinTempArtifacts({ olderThanMs = 6 * 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  const roots = [
    path.join(DATA_PATH, 'algonquin'),
    path.join(DATA_PATH, 'algonquin_chunks'),
    path.join(DATA_PATH, 'algonquin_uploads'),
    path.join(DATA_PATH, 'tmp', 'algonquin-whisper'),
  ];
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(root, e.name);
        try {
          const st = fs.statSync(p);
          if ((now - st.mtimeMs) < olderThanMs) continue;
          fs.rmSync(p, { recursive: true, force: true });
        } catch (_) {}
      }
    } catch (_) {}
  }
}

function algonquinDetectFileType(file) {
  const original = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  if (original.endsWith('.pdf') || mime === 'application/pdf') return { fileType: 'pdf', badge: 'PDF' };
  if (original.endsWith('.docx') || original.endsWith('.txt')) return { fileType: 'doc', badge: 'Doc' };
  if (original.endsWith('.mp4') || original.endsWith('.mov')) return { fileType: 'video', badge: 'Video' };
  if (original.endsWith('.mp3')) return { fileType: 'audio', badge: 'Video' };
  return { fileType: null, badge: '' };
}

async function whisperTranscribeBuffer({ filePath, fileSizeBytes, mimeType, filename }) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set — required for Whisper');

  // Memory-safety + payload limits.
  const hardMaxBytes = 1024 * 1024 * 1024; // 1 GB hard reject
  const maxWhisperBytes = 24 * 1024 * 1024;

  if (!filePath) throw new Error('Missing filePath for Whisper');
  const sizeBytes = Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? Number(fileSizeBytes) : fs.statSync(filePath).size;
  if (!sizeBytes) throw new Error('Empty file');
  if (sizeBytes > hardMaxBytes) {
    throw new Error('File too large for transcription — max 1 GB');
  }

  const safeName = sanitizeFileName(filename || 'audio');
  const whisperForm = new FormData();

  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  const ffmpegPath = global.FFMPEG_PATH || 'ffmpeg';

  let audioBuffer = null;
  let blobType = mimeType || 'application/octet-stream';
  let uploadName = safeName;

  // If the uploaded file is small enough, send it directly.
  if (sizeBytes <= maxWhisperBytes) {
    audioBuffer = fs.readFileSync(filePath);
  } else {
    // Otherwise, downsample until the payload is small enough for Whisper.
    const tmpDir = path.join(DATA_PATH, 'tmp', 'algonquin-whisper', `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    let lastOutBytes = 0;
    const bitrates = ['64k', '32k', '16k'];
    try {
      for (const bitrate of bitrates) {
        const outPath = path.join(tmpDir, `audio_${bitrate}.m4a`);
        const cmd = `"${ffmpegPath}" -i "${filePath}" -vn -acodec aac -b:a ${bitrate} -ar 16000 "${outPath}" -y -loglevel error`;
        await execAsync(cmd);
        const buf = fs.readFileSync(outPath);
        lastOutBytes = buf.length || 0;
        if (lastOutBytes > 0 && lastOutBytes <= maxWhisperBytes) {
          audioBuffer = buf;
          blobType = 'audio/aac';
          uploadName = `${safeName.replace(/\.[^.]+$/, '')}.m4a`;
          break;
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!audioBuffer) {
      throw new Error(`File too large for Whisper after compression (${Math.round(lastOutBytes / (1024 * 1024))}MB). Please use a smaller file.`);
    }
  }

  if (!audioBuffer || audioBuffer.length === 0) throw new Error('Whisper input buffer empty');

  const blob = new Blob([audioBuffer], { type: blobType });
  whisperForm.append('file', blob, uploadName);
  whisperForm.append('model', 'whisper-1');
  whisperForm.append('response_format', 'text');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: whisperForm,
  });
  if (!whisperRes.ok) throw new Error('Whisper API error: ' + await whisperRes.text());
  return (await whisperRes.text()).trim();
}

async function runPython(scriptRelPath, argsArr, { env } = {}) {
  const child = spawn('python3', [scriptRelPath, ...argsArr], {
    cwd: INTELLIGENCE_DIR,
    env: {
      ...process.env,
      ...(env || {}),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return await new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `Python failed: ${scriptRelPath}`));
      resolve({ stdout, stderr, code });
    });
  });
}

async function runAlgonquinChunkToJson({ inputPath, mode, outDir, subSource, fileType, originalFilename }) {
  const sourceDocument = KB_ALGONQUIN_SOURCE_DOCUMENT;
  const topic = KB_ALGONQUIN_TOPIC;
  const author = 'Algonquin College';
  if (mode === 'pdf') {
    const r = await runPython(
      path.join(INTELLIGENCE_DIR, 'scripts', 'algonquin_chunk_pdf_to_json.py'),
      [
        '--pdf-path', inputPath,
        '--data-path', DATA_PATH,
        '--out-dir', outDir,
        '--source-document', sourceDocument,
        '--sub-source', subSource,
        '--topic', topic,
        '--file-type', fileType, // 'pdf'
        '--original-filename', originalFilename,
        '--author', author,
      ],
    );
    const payload = parseLastJsonLine(r.stdout);
    if (!payload?.chunk_path) throw new Error('Algonquin PDF chunking did not output chunk_path');
    return payload.chunk_path;
  }
  // text mode: doc/txt/transcript
  const r = await runPython(
    path.join(INTELLIGENCE_DIR, 'scripts', 'algonquin_chunk_text_to_json.py'),
    [
      '--text-path', inputPath,
      '--out-dir', outDir,
      '--source-document', sourceDocument,
      '--sub-source', subSource,
      '--topic', topic,
      '--file-type', fileType, // 'doc'/'video'/'audio'
      '--original-filename', originalFilename,
      '--author', author,
    ],
  );
  const payload = parseLastJsonLine(r.stdout);
  if (!payload?.chunk_path) throw new Error('Algonquin text chunking did not output chunk_path');
  return payload.chunk_path;
}

async function embedAlgonquinChunkJson({ chunkJsonPath }) {
  const embedPy = path.join(INTELLIGENCE_DIR, 'scripts', 'embed_and_store.py');
  // Embed+store in the persistent Algonquin collection (never replace).
  const r = await runPython(embedPy, [
    chunkJsonPath,
    '--collection', KB_ALGONQUIN_COLLECTION,
    '--db-path', path.join(DATA_PATH, 'chromadb'),
  ]);
  return r.stdout;
}

async function checkAlgonquinDuplicate({ dbPath, collection, originalFilename, fileType }) {
  const dupPy = path.join(INTELLIGENCE_DIR, 'scripts', 'algonquin_check_duplicate.py');
  const r = await runPython(dupPy, [
    '--db-path', dbPath,
    '--collection', collection,
    '--original-filename', originalFilename,
    '--file-type', fileType,
  ]);
  const payload = parseLastJsonLine(r.stdout);
  return !!payload?.duplicate;
}

async function ensureAlgonquinDriveFolderIds(drive) {
  // Helper that creates nested folders under Drive if missing.
  async function ensureFolder(name, parentId = null) {
    const q = [
      `name='${String(name).replace(/'/g, "\\'")}'`,
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false',
      parentId ? `'${parentId}' in parents` : undefined,
    ].filter(Boolean).join(' and ');
    const found = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 10 });
    const existing = found.data.files?.[0];
    if (existing?.id) return existing.id;
    const created = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined },
      fields: 'id',
    });
    return created.data.id;
  }

  const phixoKbId = await ensureFolder('Phixo KB', null);
  const algId = await ensureFolder('Algonquin College', phixoKbId);
  const sourceFilesId = await ensureFolder('Source Files', algId);
  const videosId = await ensureFolder('Videos', algId);
  const transcriptsId = await ensureFolder('Transcripts', algId);
  return { sourceFilesId, videosId, transcriptsId };
}

async function backupAlgonquinFileToDrive({ drive, file, subSource, transcriptText, folderIds }) {
  const Readable = require('stream').Readable;

  const uploadPath = file?.path;
  try {
    // 1) Upload original file.
    const isPdfOrDoc = file.fileType === 'pdf' || file.fileType === 'doc';
    const targetFolderId = isPdfOrDoc ? folderIds.sourceFilesId : folderIds.videosId;
    const originalName = String(file.originalname || file.filename || 'file');

    const mediaBody = uploadPath
      ? fs.createReadStream(uploadPath)
      : Readable.from([file.buffer]);

    await drive.files.create({
      requestBody: { name: originalName, parents: [targetFolderId] },
      media: { mimeType: file.mimetype || 'application/octet-stream', body: mediaBody },
      fields: 'id',
    });

    // 2) If video/audio, upload transcript text file.
    if (transcriptText && (file.fileType === 'video' || file.fileType === 'audio')) {
      const safeSub = sanitizeFileName(subSource || 'Algonquin');
      const safeOriginal = sanitizeFileName(originalName.replace(/\.[^.]+$/, ''));
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const transcriptName = `${safeSub}_${safeOriginal}_transcript_${ts}.txt`;
      await drive.files.create({
        requestBody: { name: transcriptName, parents: [folderIds.transcriptsId] },
        media: { mimeType: 'text/plain; charset=utf-8', body: Readable.from([Buffer.from(transcriptText, 'utf-8')]) },
        fields: 'id',
      });
    }
  } finally {
    // Free temporary upload space after backup completes.
    if (uploadPath) {
      try { fs.unlinkSync(uploadPath); } catch (_) { /* ignore */ }
    }
  }
}

app.post('/api/knowledge/algonquin/ingest', requireAuth, uploadAlgonquin.array('files', 50), async (req, res) => {
  try {
    // Best-effort temp cleanup so old failed jobs don't fill Railway volume.
    pruneAlgonquinTempArtifacts();

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    let subSources = [];
    try {
      subSources = JSON.parse(String(req.body?.sub_sources || '[]'));
    } catch (_) {}
    if (!Array.isArray(subSources)) subSources = [];

    // Validate sub_source count; if missing, fall back to filename base.
    const jobId = newAlgonquinJobId();
    const dbPath = path.join(DATA_PATH, 'chromadb');
    const jobTmpDir = path.join(DATA_PATH, 'algonquin', jobId);
    const chunkOutBase = path.join(DATA_PATH, 'algonquin_chunks', jobId);
    fs.mkdirSync(jobTmpDir, { recursive: true });
    fs.mkdirSync(chunkOutBase, { recursive: true });

    const job = {
      jobId,
      state: 'running',
      startedAt: new Date().toISOString(),
      files: files.map((f, idx) => {
        const det = algonquinDetectFileType(f);
        const sourceTitle = String(subSources[idx] || '').trim();
        const baseName = String(f.originalname || f.filename || 'file').replace(/\.[^.]+$/, '');
        return {
          idx,
          originalFilename: String(f.originalname || f.filename || ''),
          filename: String(f.originalname || f.filename || ''),
          subSource: sourceTitle || baseName,
          fileType: det.fileType, // 'pdf'|'doc'|'video'|'audio'
          badge: det.badge,
          status: 'Queued',
          message: '',
          embeddedAt: null,
          completedAt: null,
        };
      }),
    };

    // Fail fast on unknown file types (these shouldn't make it into the queue).
    const invalid = job.files.find((x) => !x.fileType);
    if (invalid) return res.status(400).json({ error: `Unsupported file type for: ${invalid.filename}` });

    algonquinIngestJobs.set(jobId, job);

    // Kick off sequential processing in background.
    (async () => {
      const drive = getDrive(req);
      const folderIdsPromise = ensureAlgonquinDriveFolderIds(drive).catch(() => null);

      // Serialize embedding writes so Chroma persistent storage doesn't see concurrent writes.
      let embedQueue = Promise.resolve();
      async function withEmbedLock(fn) {
        const prev = embedQueue;
        let unlock;
        embedQueue = new Promise((r) => { unlock = r; });
        await prev;
        try {
          return await fn();
        } finally {
          unlock();
        }
      }

      const isVideo = (fileType) => fileType === 'video' || fileType === 'audio';
      const docFiles = job.files.filter((f) => !isVideo(f.fileType));
      const videoFiles = job.files.filter((f) => isVideo(f.fileType));

      async function processOneFile(f) {
        if (f.status !== 'Queued') return; // duplicates/skips may have changed it

        let chunkOutDir = null;
        let chunkJsonPath = null;
        let textPath = null;

        try {
          const originalFilename = f.originalFilename;
          const subSource = f.subSource;
          const uploadedFile = files[f.idx];

          // Duplicate check (warn+skip).
          const isDup = await checkAlgonquinDuplicate({
            dbPath,
            collection: KB_ALGONQUIN_COLLECTION,
            originalFilename,
            fileType: f.fileType,
          });
          if (isDup) {
            f.status = 'Skipped (already ingested)';
            f.message = `Duplicate filename in Chroma: ${originalFilename}`;
            return;
          }

          const textDir = path.join(jobTmpDir, 'text');
          chunkOutDir = path.join(chunkOutBase, String(f.idx));
          fs.mkdirSync(textDir, { recursive: true });
          fs.mkdirSync(chunkOutDir, { recursive: true });

          const safeOriginalName = sanitizeFileName(uploadedFile.originalname || 'file');
          const fileSizeBytes = uploadedFile.size || fs.statSync(uploadedFile.path).size;
          // Avoid duplicate disk writes: PDFs can be chunked directly from upload path.
          const inputPath = f.fileType === 'pdf' ? uploadedFile.path : null;

          let transcriptText = null;
          if (f.fileType === 'video') {
            // NOTE: Whisper stays serialized because we only call this from the single-threaded video loop.
            f.status = 'Transcribing';
            f.message = 'Whisper transcription in progress...';
            transcriptText = await whisperTranscribeBuffer({
              filePath: uploadedFile.path,
              fileSizeBytes,
              mimeType: uploadedFile.mimetype,
              filename: safeOriginalName,
            });
          } else if (f.fileType === 'audio') {
            f.status = 'Chunking';
            f.message = 'Whisper transcription (audio) + chunking...';
            transcriptText = await whisperTranscribeBuffer({
              filePath: uploadedFile.path,
              fileSizeBytes,
              mimeType: uploadedFile.mimetype,
              filename: safeOriginalName,
            });
          }

          // Chunking
          f.status = 'Chunking';
          f.message = 'Extracting text and creating chunks...';
          if (f.fileType === 'pdf') {
            chunkJsonPath = await runAlgonquinChunkToJson({
              inputPath,
              mode: 'pdf',
              outDir: chunkOutDir,
              subSource,
              fileType: 'pdf',
              originalFilename,
            });
          } else if (f.fileType === 'doc') {
            const lowerName = String(uploadedFile.originalname || '').toLowerCase();
            const fileBuffer = fs.readFileSync(uploadedFile.path);
            let extractedText = '';
            if (lowerName.endsWith('.docx')) {
              if (!mammoth) throw new Error('mammoth dependency missing — DOCX ingestion cannot run');
              const r = await mammoth.extractRawText({ buffer: fileBuffer });
              extractedText = r.value || '';
            } else {
              // TXT
              extractedText = fileBuffer.toString('utf-8');
            }
            textPath = path.join(textDir, `${f.idx}.txt`);
            fs.writeFileSync(textPath, extractedText, 'utf-8');
            chunkJsonPath = await runAlgonquinChunkToJson({
              inputPath: textPath,
              mode: 'text',
              outDir: chunkOutDir,
              subSource,
              fileType: 'doc',
              originalFilename,
            });
          } else if (f.fileType === 'video' || f.fileType === 'audio') {
            if (!transcriptText) throw new Error('Missing transcript text after Whisper');
            textPath = path.join(textDir, `${f.idx}_transcript.txt`);
            fs.writeFileSync(textPath, transcriptText, 'utf-8');
            chunkJsonPath = await runAlgonquinChunkToJson({
              inputPath: textPath,
              mode: 'text',
              outDir: chunkOutDir,
              subSource,
              fileType: f.fileType, // video|audio
              originalFilename,
            });
          } else {
            throw new Error(`Unsupported fileType: ${f.fileType}`);
          }

          // Embedding (serialized)
          f.status = 'Embedding';
          f.message = 'Embedding chunks into Chroma...';
          await withEmbedLock(() => embedAlgonquinChunkJson({ chunkJsonPath }));

          // Trigger initial suggested-questions generation (same mechanism as regular book ingest).
          appendIngestLog({
            jobId: `${job.jobId}:${f.idx}`,
            status: 'INGEST_COMPLETE',
            source: KB_ALGONQUIN_ROW_SOURCE,
            topic: KB_ALGONQUIN_TOPIC,
            filename: originalFilename,
          });

          // DB row update (increment file_count, update last_updated).
          await pool.query(
            `UPDATE kb_books
             SET file_count = COALESCE(file_count,0) + 1,
                 last_updated = NOW(),
                 updated_at = NOW()
             WHERE source = $1`,
            [KB_ALGONQUIN_ROW_SOURCE]
          );

          // Drive backup should never block ingest queue.
          f.status = 'Backing up to Drive';
          f.message = 'Copying files + uploading transcripts...';
          const transcriptForBackup = transcriptText; // may be null
          (async () => {
            try {
              const folderIds = await folderIdsPromise;
              if (!folderIds) throw new Error('Failed to resolve Drive folder IDs');
              await backupAlgonquinFileToDrive({
                drive,
                file: { ...f, path: uploadedFile.path, originalname: uploadedFile.originalname, mimetype: uploadedFile.mimetype, fileType: f.fileType },
                subSource,
                transcriptText: transcriptForBackup,
                folderIds,
              });
              f.status = 'Complete';
              f.completedAt = new Date().toISOString();
              f.message = '';
            } catch (driveErr) {
              console.error('Algonquin drive backup error:', driveErr);
              f.status = 'Complete (backup error)';
              f.completedAt = new Date().toISOString();
              f.message = String(driveErr?.message || driveErr || 'Drive backup failed');
            }
          })();
        } catch (err) {
          console.error('Algonquin ingest file error:', err);
          f.status = 'Error';
          const msg = String(err?.message || err || 'Ingest failed');
          f.message = /ENOSPC|no space left on device/i.test(msg)
            ? 'Storage full on server volume (ENOSPC). Free space or increase Railway volume.'
            : msg;
        } finally {
          // Always clean per-file temp artifacts, even on failures.
          try { if (textPath && fs.existsSync(textPath)) fs.rmSync(textPath, { force: true }); } catch (_) {}
          try { if (chunkJsonPath && fs.existsSync(chunkJsonPath)) fs.rmSync(chunkJsonPath, { force: true }); } catch (_) {}
          try { if (chunkOutDir && fs.existsSync(chunkOutDir)) fs.rmSync(chunkOutDir, { recursive: true, force: true }); } catch (_) {}
        }
      }

      // Process doc/pdf in parallel (limited). Video/audio (Whisper) stays sequential.
      const maxDocConcurrency = Math.max(1, Math.min(4, Number(process.env.KB_ALG_DOC_CONCURRENCY || 2)));
      let docCursor = 0;
      const docWorkers = Array.from({ length: Math.min(maxDocConcurrency, docFiles.length || 1) }).map(async () => {
        while (true) {
          if (docCursor >= docFiles.length) return;
          const idx = docCursor++;
          const f = docFiles[idx];
          if (!f) return;
          await processOneFile(f);
        }
      });

      // Only one Whisper at a time:
      for (const f of videoFiles) {
        await processOneFile(f);
      }

      await Promise.all(docWorkers);
      job.state = 'done';
      // Best-effort cleanup of this job's temp directories.
      try { fs.rmSync(jobTmpDir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(chunkOutBase, { recursive: true, force: true }); } catch (_) {}
    })();

    return res.json({ jobId });
  } catch (err) {
    console.error('Algonquin ingest endpoint error:', err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/knowledge/algonquin/ingest-status', requireAuth, async (req, res) => {
  try {
    const jobId = String(req.query.jobId || '').trim();
    if (!jobId) return res.status(400).json({ error: 'jobId required' });
    const job = algonquinIngestJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json({
      jobId,
      state: job.state,
      files: job.files.map((f) => ({
        idx: f.idx,
        filename: f.filename,
        subSource: f.subSource,
        fileType: f.fileType,
        badge: f.badge,
        status: f.status,
        message: f.message,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// Ensure multer upload errors (file count/size) return JSON for the UI.
// Without this, the client often falls back to a generic error message.
app.use((err, req, res, next) => {
  try {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: err?.message || String(err) });
  } catch (e) {
    return res.status(500).json({ error: 'Unknown server error' });
  }
});

// Chat with the photography knowledge base (Python ask.py → Claude)
app.post('/api/knowledge/chat', requireAuth, async (req, res) => {
  try {
    const { question, bookId, topicFocus } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ error: 'Question required' });
    }
    if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY and ANTHROPIC_API_KEY must be set' });
    }

    // Ensure DB path exists
    const dbPath = path.join(DATA_PATH, 'chromadb');
    if (!fs.existsSync(dbPath)) {
      return res.status(400).json({ error: 'Knowledge base is empty. Ingest at least one book first.' });
    }

    let selectedSource = '';
    let selectedTopic = '';
    let selectedCollection = KB_DEFAULT_COLLECTION;
    if (bookId !== undefined && bookId !== null && String(bookId).trim() !== '') {
      const row = (await pool.query(`SELECT source, title, topic FROM kb_books WHERE id = $1`, [bookId])).rows[0];
      if (!row) return res.status(400).json({ error: 'Selected book not found' });
      // Chroma's metadata.source_document is the human title (stored in kb_books.title).
      selectedSource = String(row.title || row.source || '').trim();
      selectedTopic = String(row.topic || '').trim();
      if (!selectedSource) return res.status(400).json({ error: 'Selected book has no source' });
      if (selectedTopic === 'algonquin-college') selectedCollection = 'algonquin-college';
    }

    const normalizeAllBooksTopicFocus = (v) => {
      const s = String(v || '').trim().toLowerCase();
      if (s === 'photography') return 'photography';
      if (s === 'business') return 'business';
      return 'all';
    };

    const pyArgs = [
      path.join(INTELLIGENCE_DIR, 'scripts', 'ask.py'),
      question,
      '--db-path', dbPath,
      '--collection', selectedCollection,
    ];
    if (selectedSource) pyArgs.push('--source', selectedSource);
    if (selectedTopic) pyArgs.push('--topic', selectedTopic);
    if (!selectedSource) {
      const focus = normalizeAllBooksTopicFocus(topicFocus);
      // `ask.py` uses topic-focus for Chroma filtering and `--topic` for system-prompt selection.
      pyArgs.push('--topic', focus === 'business' ? 'business' : 'general');
      pyArgs.push('--topic-focus', focus);
    }

    if (String(selectedTopic || '').trim() === KB_ALGONQUIN_TOPIC) {
      pyArgs.push('--top', '12', '--diversify-by-book-slug');
    }

    const child = spawn('python3', pyArgs, {
      cwd: INTELLIGENCE_DIR,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('ask.py error:', stderr || stdout);
        const errText = String(stderr || stdout || '');
        if (/collection/i.test(errText) && /does not exist|not found|no such/i.test(errText)) {
          return res.status(400).json({ error: 'Knowledge base is empty. Ingest at least one book first.' });
        }
        return res.status(500).json({ error: 'Knowledge chat failed', detail: stderr || stdout });
      }

      let payload;
      const extractJson = (s) => {
        if (typeof s !== 'string') return null;
        const firstBrace = s.indexOf('{');
        const lastBrace = s.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
        return s.slice(firstBrace, lastBrace + 1);
      };
      try {
        payload = JSON.parse(stdout);
      } catch (e) {
        // Back-compat: fall back to plain text + regex parsing if Claude returned non-JSON.
        const jsonMaybe = extractJson(stdout);
        if (jsonMaybe) {
          try {
            payload = JSON.parse(jsonMaybe);
          } catch (e2) {
            payload = null;
          }
        }
      }

      if (!payload || typeof payload !== 'object') {
        payload = { answerText: stdout, sources: [], pageImages: [] };
        const sourcesMatch = stdout.match(/Sources:\s*(.+)/);
        if (sourcesMatch && sourcesMatch[1]) {
          payload.sources = sourcesMatch[1].split(',').map(s => s.trim()).filter(Boolean);
        }
      }

      let answer = payload.answerText || '';
      let sources = Array.isArray(payload.sources) ? payload.sources : [];
      const referenceImage = payload.referenceImage ?? null;
      const pageImages = Array.isArray(payload.pageImages) ? payload.pageImages : [];
      const retrievedChunks = Array.isArray(payload.retrievedChunks) ? payload.retrievedChunks : [];

      // Convert common Markdown-ish output into plain text
      const toPlain = (s) => {
        if (typeof s !== 'string') return '';
        return s
          .replace(/^#{1,6}\s+/gm, '') // remove markdown headings
          .replace(/\*\*(.*?)\*\*/g, '$1') // bold -> plain
          .replace(/^\s*[-*]\s+/gm, '') // flatten bullet markers
          .replace(/^\s*\d+\.\s+/gm, '') // flatten numbered markers
          .replace(/[`>]/g, '') // strip code/quote markers
          .trim();
      };
      const stripSlideTitleLines = (s) => {
        if (typeof s !== 'string' || !s.trim()) return s;
        const linePat = /^[A-Z][A-Z0-9 .\-–—',&/]{2,100}$/;
        return s
          .split('\n')
          .filter((line) => {
            const t = line.trim();
            if (!t) return true;
            if (linePat.test(t) && t.split(/\s+/).length <= 10) return false;
            return true;
          })
          .join('\n')
          .trim();
      };
      answer = stripSlideTitleLines(toPlain(answer));

      res.json({ answer, sources, referenceImage, pageImages, retrievedChunks, raw: stdout });
    });
  } catch (err) {
    console.error('Knowledge chat error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// Premium "deep dive" follow-up (Tell me more)
app.post('/api/knowledge/chat/deep-dive', requireAuth, async (req, res) => {
  try {
    const { question, originalAnswer, retrievedChunks, mode, topicFocus, bookTopicTag } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'Question required' });
    if (!originalAnswer || !String(originalAnswer).trim()) return res.status(400).json({ error: 'Original answer required' });

    const chunks = Array.isArray(retrievedChunks) ? retrievedChunks : [];

    const deepDiveSystemAddition = `
The user has already received a standard answer to their question and wants to go significantly deeper. Do not repeat what was already said. Build on it substantially. Go further into the principles, the edge cases, the nuances, the practical application specifically for Ian's basement studio and Phixo's situation. Give the kind of answer a senior photographer mentor would give after already covering the basics — assume the basics are understood and push further. Be thorough. This response should feel worth the extra cost and time.
`.trim();

    const SYSTEM_PROMPT = `You are a portrait photography expert. Answer the question using only the excerpts from photography books provided below.

Return ONLY valid JSON with this schema (no markdown, no extra text):
{
  "answerText": string,
  "referenceImage": null,
  "pageImages": array of objects,
  "sources": array of strings
}

Rules:
1) Do not use markdown. answerText must be plain text with short paragraphs.
2) Use clean flowing paragraphs, never bullets or numbered lists.
3) Never include diagrams, SVG instructions, or generated visuals.
4) referenceImage must be null and pageImages must be an empty array (the system attaches real page images after retrieval).
5) Write as a practicing photographer giving direct guidance. Do not discuss excerpts, retrieval, or whether something is missing or not covered.
6) Put book titles only in the "sources" array — do not narrate sourcing in answerText.`;

    const BUSINESS_SYSTEM_PROMPT = `You are helping Ian, a portrait photographer running a boutique studio called Phixo in Montreal's West Island. He shoots 10-12 sessions per month as a side hustle alongside a full-time IT career. His signature session is $175 with a target average order value of $220-250. He has three client lanes: professionals needing career portraits, individuals wanting confidence or milestone portraits, and families. His studio is in his basement and he is in early-stage client acquisition with no established local network yet.

When answering questions, use the business principles from the excerpts provided and apply them specifically and practically to Ian's portrait photography business. Even if the book does not mention photography directly, translate every principle into concrete actionable advice for his specific context. Never say the book does not cover photography — instead bridge the gap yourself using the principles provided.`;

    const ALL_BOOKS_SYSTEM_PROMPT = `You are helping Ian, a portrait photographer running a boutique studio called Phixo in Montreal's West Island. He shoots 10-12 sessions per month as a side hustle alongside a full-time IT career. His signature session is $175 with a target average order value of $220-250. He has three client lanes: professionals needing career portraits, individuals wanting confidence or milestone portraits, and families. His studio is in his basement and he is in early-stage client acquisition with no established local network yet.

Use the principles and information from the excerpts provided and apply them specifically and practically to Ian's portrait photography business and situation. Never say the excerpts don't cover Phixo — bridge the gap yourself using the principles provided.`;

    // Mirror ask.py's system prompt selection so the "Tell me more" prompt builds on the same context.
    const m = String(mode || '').toLowerCase();
    const focus = String(topicFocus || '').toLowerCase();
    const tag = String(bookTopicTag || '').toLowerCase();

    const allBooksMode = m === 'all_books' || ['photography', 'business', 'all'].includes(focus);
    const baseSystemPrompt = allBooksMode ? ALL_BOOKS_SYSTEM_PROMPT : (tag === 'business' ? BUSINESS_SYSTEM_PROMPT : SYSTEM_PROMPT);

    const excerptParts = chunks.map((c, i) => {
      const docText = String(c?.doc_text || '').trim();
      const title = String(c?.source_document || 'Unknown').trim();
      return `[Excerpt ${i + 1} — ${title}]\n${docText}`;
    }).filter(s => s && !/^\[Excerpt .*?\]\s*$/.test(s));

    const excerpts = excerptParts.join('\n\n---\n\n');

    const userContent = `Here are excerpts from photography books:

${excerpts}

---

Question: ${question}

Original standard answer (already shown to the user):
${originalAnswer}

---

Write a significantly deeper answer. Do not repeat what was already said. Build on it substantially. Go further into the principles, the edge cases, the nuances, and practical application.`;

    const systemPrompt = `${deepDiveSystemAddition}\n\n${baseSystemPrompt}`.trim();

    // IMPORTANT: This endpoint must use sonnet (premium) and must not rely on AI_MODEL.
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      temperature: 1.0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });

    const rawText = (message?.content || []).find((c) => c?.type === 'text')?.text || '';

    // Be defensive: if Claude returned JSON, extract answerText; otherwise use raw text.
    const tryExtractJson = (s) => {
      if (typeof s !== 'string') return null;
      const firstBrace = s.indexOf('{');
      const lastBrace = s.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
      try {
        return JSON.parse(s.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    };

    const jsonMaybe = tryExtractJson(rawText);
    const deepAnswer = (jsonMaybe?.answerText && typeof jsonMaybe.answerText === 'string')
      ? jsonMaybe.answerText
      : rawText;

    res.json({ deepAnswer });
  } catch (err) {
    console.error('Knowledge deep-dive error:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/knowledge/books', requireAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT id, source, title, author, topic, file_count, last_updated,
              suggested_questions, questions_generated_at, questions_generation_status, questions_generation_error, created_at, updated_at
       FROM kb_books
       ORDER BY updated_at DESC, id DESC`
    )).rows || [];
    const books = rows.map((r) => ({
      id: r.id,
      source: r.source,
      title: r.title,
      author: r.author,
      topic: r.topic,
      fileCount: typeof r.file_count === 'number' ? r.file_count : 0,
      lastUpdated: r.last_updated,
      suggestedQuestions: Array.isArray(r.suggested_questions) ? r.suggested_questions : [],
      questionsGeneratedAt: r.questions_generated_at,
      questionsGenerationStatus: r.questions_generation_status,
      questionsGenerationError: r.questions_generation_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    return res.json({ books });
  } catch (err) {
    console.error('knowledge books list error:', err.message);
    return res.status(500).json({ error: 'Failed to load books' });
  }
});

app.put('/api/knowledge/books/:bookId/questions', requireAuth, async (req, res) => {
  try {
    const bookId = Number(req.params.bookId);
    if (!Number.isFinite(bookId) || bookId <= 0) return res.status(400).json({ error: 'Invalid book id' });
    const questions = normalizeQuestionList(req.body?.questions || []);
    const row = (await pool.query(
      `UPDATE kb_books
       SET suggested_questions = $2::jsonb,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, source, title, author, topic, suggested_questions, questions_generated_at, questions_generation_status, questions_generation_error, created_at, updated_at`,
      [bookId, JSON.stringify(questions)]
    )).rows[0];
    if (!row) return res.status(404).json({ error: 'Book not found' });
    return res.json({
      book: {
        id: row.id,
        source: row.source,
        title: row.title,
        author: row.author,
        topic: row.topic,
        suggestedQuestions: Array.isArray(row.suggested_questions) ? row.suggested_questions : [],
        questionsGeneratedAt: row.questions_generated_at,
        questionsGenerationStatus: row.questions_generation_status,
        questionsGenerationError: row.questions_generation_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    });
  } catch (err) {
    console.error('save knowledge questions error:', err.message);
    return res.status(500).json({ error: 'Failed to save questions' });
  }
});

app.post('/api/knowledge/books/:bookId/questions/generate', requireAuth, async (req, res) => {
  try {
    const bookId = Number(req.params.bookId);
    if (!Number.isFinite(bookId) || bookId <= 0) return res.status(400).json({ error: 'Invalid book id' });
    const mode = String(req.body?.mode || 'random').toLowerCase();
    const subTopic = String(req.body?.subTopic || '').trim();
    if (mode === 'topic' && !subTopic) {
      return res.status(400).json({ error: 'subTopic is required for topic mode' });
    }
    const row = (await pool.query(`SELECT id, source, title, topic FROM kb_books WHERE id = $1`, [bookId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Book not found' });
    const isAlgonquin = String(row.topic || '').trim() === 'algonquin-college';
    const sourceDocument = isAlgonquin ? String(row.title || '').trim() : String(row.source || '').trim();
    if (!sourceDocument) return res.status(400).json({ error: 'Selected book has no source_document' });
    const questions = await runQuestionGenerationPy({
      source: sourceDocument,
      topic: row.topic || 'general',
      subTopic: mode === 'topic' ? subTopic : '',
      collection: isAlgonquin ? 'algonquin-college' : KB_DEFAULT_COLLECTION,
    });
    const updated = (await pool.query(
      `UPDATE kb_books
       SET suggested_questions = $2::jsonb,
           questions_generated_at = NOW(),
           questions_generation_status = 'ready',
           questions_generation_error = NULL,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, source, title, author, topic, suggested_questions, questions_generated_at, questions_generation_status, questions_generation_error, created_at, updated_at`,
      [bookId, JSON.stringify(questions)]
    )).rows[0];
    return res.json({
      book: {
        id: updated.id,
        source: updated.source,
        title: updated.title,
        author: updated.author,
        topic: updated.topic,
        suggestedQuestions: Array.isArray(updated.suggested_questions) ? updated.suggested_questions : [],
        questionsGeneratedAt: updated.questions_generated_at,
        questionsGenerationStatus: updated.questions_generation_status,
        questionsGenerationError: updated.questions_generation_error,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      }
    });
  } catch (err) {
    console.error('generate knowledge questions error:', err.message);
    return res.status(500).json({ error: 'Failed to generate questions', detail: err.message });
  }
});

app.post('/api/knowledge/all-books/questions/generate', requireAuth, async (req, res) => {
  try {
    const mode = String(req.body?.mode || 'random').toLowerCase();
    const subTopic = String(req.body?.subTopic || '').trim();
    const topicFocusRaw = String(req.body?.topicFocus || 'all').trim().toLowerCase();
    const topicFocus = (topicFocusRaw === 'photography' || topicFocusRaw === 'business') ? topicFocusRaw : 'all';

    if (mode === 'topic' && !subTopic) {
      return res.status(400).json({ error: 'subTopic is required for topic mode' });
    }

    const questions = await runAllBooksQuestionGenerationPy({
      topicFocus,
      subTopic: mode === 'topic' ? subTopic : '',
    });

    return res.json({ questions });
  } catch (err) {
    console.error('generate all-books knowledge questions error:', err.message);
    return res.status(500).json({ error: 'Failed to generate questions', detail: err.message });
  }
});

// Recent ingestion status (simple view over the JSONL log)
app.get('/api/knowledge/ingest-status', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(INGEST_LOG_PATH)) {
      return res.json({ jobs: [] });
    }
    const raw = fs.readFileSync(INGEST_LOG_PATH, 'utf8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const byJob = {};
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (!ev.jobId) continue;
        const existing = byJob[ev.jobId] || {};
        // Merge, but keep any previously known fields if the new event omits them
        byJob[ev.jobId] = { ...existing, ...ev };
      } catch (e) {
        // ignore malformed log lines
      }
    }
    const jobs = Object.values(byJob)
      .sort((a, b) => (b.queuedAt || b.time || '').localeCompare(a.queuedAt || a.time || ''))
      .slice(0, 20);
    return res.json({ jobs });
  } catch (err) {
    console.error('ingest-status error:', err.message);
    return res.status(500).json({ error: 'Failed to read ingest status' });
  }
});

// Wipe the local knowledge base artifacts (uploads, chunks, images, chromadb, and ingest log)
app.post('/api/knowledge/clean-kb', requireAuth, async (req, res) => {
  try {
    const dirs = ['uploads', 'chunks', 'images', 'chromadb'];
    for (const d of dirs) {
      const full = path.join(DATA_PATH, d);
      if (fs.existsSync(full)) {
        fs.rmSync(full, { recursive: true, force: true });
      }
      fs.mkdirSync(full, { recursive: true });
    }

    if (fs.existsSync(INGEST_LOG_PATH)) fs.rmSync(INGEST_LOG_PATH, { force: true });

    return res.json({ ok: true, cleaned: true });
  } catch (err) {
    console.error('clean-kb error:', err.message);
    return res.status(500).json({ error: 'Failed to clean knowledge base', detail: err.message });
  }
});

// Delete a single book (and only that book) from ChromaDB + kb_books row.
app.delete('/api/knowledge/books/:bookId', requireAuth, async (req, res) => {
  try {
    const bookId = Number(req.params.bookId);
    if (!Number.isFinite(bookId) || bookId <= 0) return res.status(400).json({ error: 'Invalid book id' });

    const row = (await pool.query(`SELECT id, source, title, topic FROM kb_books WHERE id = $1`, [bookId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Book not found' });

    if (String(row.topic || '').trim() === 'algonquin-college') {
      return res.status(403).json({ error: 'Algonquin College KB row cannot be deleted' });
    }

    const sourceDocument = String(row.title || row.source || '').trim();
    if (!sourceDocument) return res.status(400).json({ error: 'Selected book has no source' });

    const dbPath = path.join(DATA_PATH, 'chromadb');
    if (fs.existsSync(dbPath)) {
      await deleteBookChunksPy({ sourceDocument });
    }

    await pool.query(`DELETE FROM kb_books WHERE id = $1`, [bookId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('delete knowledge book error:', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to delete book', detail: err.message });
  }
});

app.get('/api/knowledge/algonquin/documents', requireAuth, async (req, res) => {
  try {
    const dbPath = path.join(DATA_PATH, 'chromadb');
    if (!fs.existsSync(dbPath)) {
      return res.json({ documents: [] });
    }
    const payload = await listAlgonquinDocumentsPy();
    const docs = Array.isArray(payload.documents) ? payload.documents : [];
    return res.json({ documents: docs });
  } catch (err) {
    console.error('list algonquin documents error:', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to list Algonquin documents', detail: err.message });
  }
});

app.delete('/api/knowledge/algonquin/documents/:bookSlug', requireAuth, async (req, res) => {
  try {
    let bookSlug = String(req.params.bookSlug || '').trim();
    try {
      bookSlug = decodeURIComponent(bookSlug);
    } catch (_) { /* keep raw */ }
    if (!bookSlug) return res.status(400).json({ error: 'bookSlug required' });
    if (bookSlug.includes('..') || bookSlug.includes('/') || bookSlug.includes('\\')) {
      return res.status(400).json({ error: 'Invalid book slug' });
    }
    const dbPath = path.join(DATA_PATH, 'chromadb');
    if (!fs.existsSync(dbPath)) {
      return res.status(400).json({ error: 'Knowledge base is empty' });
    }
    const payload = await deleteAlgonquinDocumentPy({ bookSlug });
    const deletedChunks = Number(payload.deletedChunks) || 0;
    if (deletedChunks > 0) {
      await pool.query(
        `UPDATE kb_books
         SET file_count = GREATEST(COALESCE(file_count, 0) - 1, 0),
             updated_at = NOW()
         WHERE source = $1`,
        [KB_ALGONQUIN_ROW_SOURCE],
      );
    }
    return res.json({
      ok: !!payload.ok,
      deletedChunks,
      imagesRemoved: !!payload.imagesRemoved,
      reason: payload.reason || null,
    });
  } catch (err) {
    console.error('delete algonquin document error:', err.message, err.stack);
    return res.status(500).json({ error: 'Failed to delete document', detail: err.message });
  }
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
        const resp = await anthropicCreate({
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
  out.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ? 'set' : 'MISSING (needed for Whisper)';
  out.cwd = process.cwd();
  out.ytdlp = global.YTDLP_PATH ? { found: true, path: global.YTDLP_PATH } : { found: false };
  out.ffmpeg = global.FFMPEG_PATH ? { found: true, path: global.FFMPEG_PATH } : { found: false };
  const fs3 = require('fs'), path3 = require('path');
  const binDir3 = path3.join(process.cwd(), 'bin');
  out.binContents = fs3.existsSync(binDir3) ? fs3.readdirSync(binDir3) : 'no bin dir';
  try {
    await pool.query('SELECT 1');
    out.db.connected = true;
    const tables = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    out.db.tables = tables.rows.map(r => r.table_name);
    if (out.db.tables.includes('blocks')) {
      const count = await pool.query('SELECT COUNT(*) as n FROM blocks');
      out.db.block_count = parseInt(count.rows[0].n);
      const sample = await pool.query('SELECT id,type,title,drive_file_id,file_mime,thumbnail_url FROM blocks ORDER BY id DESC LIMIT 10');
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

    const response = await anthropicCreate({
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
    const response = await anthropicCreate({
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
// PROSPECT PIPELINE (JSON-backed)
// ═══════════════════════════════════════════════════
app.get('/api/pipeline/prospects', requireAuth, async (req, res) => {
  try {
    const { score, status, since, category } = req.query;
    const rows = readPipelineProspects();
    const normalizedScore = score ? String(score).toUpperCase() : null;
    const normalizedStatus = status ? String(status).toLowerCase() : null;
    const normalizedCategory = category ? String(category).toLowerCase() : null;
    const filtered = rows.filter((row) => {
      if (normalizedScore && row.prospect_score !== normalizedScore) return false;
      if (normalizedStatus && row.status !== normalizedStatus) return false;
      if (since && row.registered_date && row.registered_date < String(since)) return false;
      if (normalizedCategory) {
        const bt = String(row.business_type || '').toLowerCase();
        const inferredCategory =
          /(courtier|immobilier|courtage)/.test(bt) ? 'broker' :
          /(assurance|placement|financier|patrimoine)/.test(bt) ? 'insurance' :
          /(conseiller|consultant)/.test(bt) ? 'consultant' :
          /(legal|juridique|avocat|notaire)/.test(bt) ? 'legal' :
          'other';
        if (inferredCategory !== normalizedCategory) return false;
      }
      return true;
    });
    res.json(filtered);
  } catch (err) {
    console.error('Pipeline prospects list error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pipeline/prospects/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const rows = readPipelineProspects();
    const row = rows.find((item) => String(item.id) === id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error('Pipeline prospect get error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/pipeline/prospects/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const rows = readPipelineProspects();
    const idx = rows.findIndex((item) => String(item.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const updated = applyPipelineProspectPatch(rows[idx], req.body || {});
    rows[idx] = updated;
    writePipelineProspects(rows);
    res.json(updated);
  } catch (err) {
    console.error('Pipeline prospect patch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/prospects/sync', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const recordsFromBody = extractSyncRecords(body);
    const since = body.since ? String(body.since).slice(0, 10) : undefined;
    let records = recordsFromBody;
    let source = 'payload';
    if (!records.length && shouldUseApolloApi()) {
      records = await apolloRegistry.fetchFromApollo({
        keywords: body.keywords,
        limit: body.limit,
        min_date: body.min_date || since,
        since,
        page: body.page || 1,
      });
      if (records.length) source = 'apollo';
    }
    if (!records.length && shouldUseRegistryRemoteSource()) {
      records = await pullRegistrySyncRecords({ since });
      if (records.length) source = 'registry-remote';
    }
    if (!records.length) {
      const csvPath =
        process.env.REGISTRY_PROSPECTS_CSV ||
        process.env.PHIXO_PROSPECTS_CSV ||
        path.join(DATA_PATH, 'phixo_prospects.csv');
      records = apolloRegistry.readProspectsFromCSV(csvPath);
      if (records.length) {
        records = apolloRegistry.searchCsvLikeMcp(records, {
          keywords: body.keywords || '',
          minDate: body.min_date || since || '2024-01-01',
          scoreFilter: body.score_filter || 'HIGH',
          limit: body.limit || 500,
        });
        if (records.length) source = 'csv';
      }
    }
    if (!records.length && String(process.env.REGISTRY_SYNC_DISABLE_QUEBEC_DIRECT || '').toLowerCase() !== 'true') {
      records = await fetchQuebecRegistryDirectSync({ since });
      source = 'quebec-registry-direct';
    }
    if (!records.length) {
      return res.status(400).json({
        error:
          'No records found. Options: send records in body, enable Apollo (REGISTRY_SYNC_USE_APOLLO + APOLLO_API_KEY), add phixo_prospects.csv to DATA_PATH, set REGISTRY_SYNC_SOURCE_URL, or use Quebec Registre direct.',
      });
    }
    const result = upsertPipelineProspects(records);
    res.json({ ok: true, source, ...result });
  } catch (err) {
    console.error('Pipeline prospects sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/prospects/:id/draft', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const rows = readPipelineProspects();
    const idx = rows.findIndex((item) => String(item.id) === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const prospect = rows[idx];
    const owner = prospect.owner || defaultPipelineOwner();

    const systemPrompt = `You are writing outreach messages for Ian Green, a portrait photographer in West Island Montreal who runs a studio called Phixo.

Ian's voice: warm, real, like a knowledgeable friend - not salesy, not corporate.
Short messages only. No "I hope this message finds you well." No emojis. No hype words
like "stunning" or "perfect." Write like a real person who noticed something and reached out.

The goal is a brief, direct message that acknowledges their recent launch and offers a
headshot session. It should feel like a neighbour reaching out, not a cold sales email.`;

    const userPrompt = `Write a short outreach message for this prospect:

Name: ${owner.name || 'not found'}
Business type: ${prospect.business_type || 'not found'}
City: ${prospect.city || 'not found'}
Registered: ${prospect.registered_date || 'not found'}
LinkedIn headline: ${owner.linkedin_headline || 'not found'}
OACIQ/AMF status: ${owner.oaciq_license || owner.amf_license || 'not found'}

Keep it under 5 sentences. Write it for LinkedIn DM or email (they're interchangeable).
Do not include a subject line. Just the message body.`;

    const response = await anthropicCreate({
      max_tokens: 220,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }, { label: 'pipeline.prospect.draft' });

    const draft = String((response?.content || [])
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text || '')
      .join('\n')
      .trim());

    if (!draft) {
      return res.status(502).json({ error: 'AI returned an empty draft' });
    }

    rows[idx] = applyPipelineProspectPatch(rows[idx], { outreach: { draft } });
    writePipelineProspects(rows);
    res.json({ ok: true, id, draft, prospect: rows[idx] });
  } catch (err) {
    console.error('Pipeline prospect draft error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/prospects/:id/enrich', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id);
    const rows = readPipelineProspects();
    const row = rows.find((item) => String(item.id) === id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const queued = enqueuePipelineEnrichment(id);
    res.json({
      ok: true,
      id,
      queued,
      message: queued ? 'Enrichment queued' : 'Already queued or running',
    });
  } catch (err) {
    console.error('Pipeline prospect enrich error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pipeline/prospects/enrich-batch', requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v) => String(v)) : [];
    if (!ids.length) return res.status(400).json({ error: 'Body must include ids: string[]' });
    const rows = readPipelineProspects();
    const validIds = ids.filter((id) => rows.some((r) => String(r.id) === String(id)));
    let queued = 0;
    let alreadyQueued = 0;
    for (const id of validIds) {
      if (enqueuePipelineEnrichment(id)) queued++;
      else alreadyQueued++;
    }
    res.json({
      ok: true,
      requested: ids.length,
      valid: validIds.length,
      queued,
      alreadyQueued,
    });
  } catch (err) {
    console.error('Pipeline prospect enrich batch error:', err);
    res.status(500).json({ error: err.message });
  }
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
    const { platform, funnel_stage, post_goal, status, post_date, notes, post_type, content_structure } = req.body;
    const r = await pool.query(
      `INSERT INTO posts (platform,funnel_stage,post_goal,status,post_date,notes,post_type,content_structure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        platform, 
        funnel_stage, 
        post_goal, 
        status||'idea', 
        post_date, 
        notes,
        post_type || 'photo',
        content_structure ? JSON.stringify(content_structure) : '{}'
      ]
    );
    r.rows[0].modules = [];
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/posts/:id', requireAuth, async (req, res) => {
  try {
    const allowed = ['platform','funnel_stage','post_goal','status','post_date','notes','post_type','content_structure'];
    const sets=[]; const vals=[];
    for (const k of allowed) { 
      if (req.body[k]!==undefined) { 
        // Handle JSONB for content_structure
        if (k === 'content_structure') {
          vals.push(JSON.stringify(req.body[k]));
        } else {
          vals.push(req.body[k]);
        }
        sets.push(`${k}=$${vals.length}`); 
      } 
    }
    if (!sets.length) return res.json({ ok:true });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE posts SET ${sets.join(',')},updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export post to Google Doc (Ready to Shoot package)
app.post('/api/posts/:id/export-to-docs', requireAuth, async (req, res) => {
  try {
    const postRes = await pool.query('SELECT * FROM posts WHERE id=$1', [req.params.id]);
    if (!postRes.rows.length) return res.status(404).json({ error: 'Post not found' });
    const post = postRes.rows[0];
    const cs = post.content_structure || {};

    const drive = getDrive(req);
    const docs = getDocs(req);

    // 1. Find or create the "Phixo / Shoot Docs" folder
    const folderName = 'Social Media script';
    let folderId;
    const folderSearch = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)'
    });
    if (folderSearch.data.files.length) {
      folderId = folderSearch.data.files[0].id;
    } else {
      const newFolder = await drive.files.create({
        requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      folderId = newFolder.data.id;
    }

    // 2. Create a blank Google Doc inside that folder
    const docTitle = `${post.post_goal || 'Untitled Post'} — ${new Date().toLocaleDateString('en-CA')}`;
    const createRes = await docs.documents.create({
      requestBody: { title: docTitle }
    });
    const docId = createRes.data.documentId;
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

    // Move doc to the folder
    const fileData = await drive.files.get({ fileId: docId, fields: 'parents' });
    const prevParents = (fileData.data.parents || []).join(',');
    await drive.files.update({
      fileId: docId,
      addParents: folderId,
      removeParents: prevParents,
      fields: 'id, parents'
    });

    // 3. Build batchUpdate requests to insert formatted content
    const requests = [];
    let cursor = 1; // tracks insert index (doc starts at index 1)

    // Helper: insert text at cursor, advance cursor
    function insertText(text, style) {
      requests.push({
        insertText: { location: { index: cursor }, text }
      });
      const end = cursor + text.length;
      if (style) {
        if (style === 'HEADING_1' || style === 'HEADING_2' || style === 'HEADING_3') {
          requests.push({
            updateParagraphStyle: {
              range: { startIndex: cursor, endIndex: end },
              paragraphStyle: { namedStyleType: style },
              fields: 'namedStyleType'
            }
          });
        }
        if (style === 'bold') {
          requests.push({
            updateTextStyle: {
              range: { startIndex: cursor, endIndex: end - 1 },
              textStyle: { bold: true },
              fields: 'bold'
            }
          });
        }
        if (style === 'mono') {
          requests.push({
            updateTextStyle: {
              range: { startIndex: cursor, endIndex: end - 1 },
              textStyle: { weightedFontFamily: { fontFamily: 'Courier New' }, fontSize: { magnitude: 10, unit: 'PT' } },
              fields: 'weightedFontFamily,fontSize'
            }
          });
        }
        if (style === 'muted') {
          requests.push({
            updateTextStyle: {
              range: { startIndex: cursor, endIndex: end - 1 },
              textStyle: { foregroundColor: { color: { rgbColor: { red: 0.5, green: 0.5, blue: 0.5 } } }, fontSize: { magnitude: 10, unit: 'PT' } },
              fields: 'foregroundColor,fontSize'
            }
          });
        }
      }
      cursor = end;
    }

    // Meta header line
    const metaParts = [
      post.platform || '',
      post.funnel_stage ? post.funnel_stage.toUpperCase() : '',
      post.post_date || ''
    ].filter(Boolean);
    if (metaParts.length) {
      insertText(metaParts.join('  ·  ') + '\n', 'muted');
      insertText('\n', null);
    }

    // Sections
    const sections = [
      { heading: 'HOOK', value: cs.hook, style: 'HEADING_1' },
      { heading: 'Hook Template', value: cs.hookTemplate, style: null, italic: true },
      { heading: 'SCRIPT', value: cs.script, style: 'HEADING_2' },
      { heading: 'ON-SCREEN TEXT', value: cs.overlay, style: 'HEADING_2' },
      { heading: 'FILM IT', value: cs.filmIt, style: 'HEADING_2', mono: true },
      { heading: 'CAPTION DRAFT', value: cs.caption, style: 'HEADING_2' },
      { heading: 'CTA', value: cs.cta, style: 'HEADING_2' },
    ];

    for (const sec of sections) {
      if (!sec.value || String(sec.value).trim() === '') continue;
      if (sec.style) {
        insertText(sec.heading + '\n', sec.style);
      } else {
        // sub-label, no heading style
        insertText(sec.heading + '\n', 'bold');
      }
      insertText(String(sec.value).trim() + '\n', sec.mono ? 'mono' : null);
      insertText('\n', null);
    }

    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests }
    });

    // 4. Save doc URL back to the post
    await pool.query(`UPDATE posts SET content_structure = content_structure || $1::jsonb, updated_at=NOW() WHERE id=$2`,
      [JSON.stringify({ shootDocUrl: docUrl, shootDocId: docId }), post.id]
    );

    res.json({ ok: true, docUrl, docId });
  } catch (err) {
    console.error('Export to docs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cleanup untitled/empty posts (MUST come before /api/posts/:id route)
app.delete('/api/posts/cleanup-untitled', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM posts 
      WHERE (post_goal IS NULL OR post_goal = '' OR post_goal = 'Untitled post')
        AND (content_structure IS NULL OR content_structure = '{}' OR content_structure::text = '{}')
      RETURNING id
    `);
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { search, category, limit, offset } = req.query;
    let q = 'SELECT * FROM hooks';
    const p=[]; const w=[];
    if (search) { p.push('%'+search+'%'); w.push(`text ILIKE $${p.length}`); }
    if (category) { p.push(category); w.push(`category=$${p.length}`); }
    if (w.length) q += ' WHERE '+w.join(' AND ');
    q += ' ORDER BY category, created_at DESC';
    if (limit) q += ` LIMIT ${parseInt(limit)}`;
    if (offset) q += ` OFFSET ${parseInt(offset)}`;
    const r = await pool.query(q, p);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get hooks count
app.get('/api/hooks/count', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT COUNT(*) as count FROM hooks');
    res.json({ count: parseInt(r.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ingest hooks from viral_hooks.csv
app.post('/api/hooks/ingest', requireAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const csvFile = path.join(__dirname, 'viral_hooks.csv');
    
    if (!fs.existsSync(csvFile)) {
      return res.status(404).json({ error: 'viral_hooks.csv not found' });
    }
    
    const content = fs.readFileSync(csvFile, 'utf-8');
    const lines = content.split('\n');
    
    // Skip header row
    const hooks = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Parse CSV (handle quoted fields)
      const fields = [];
      let currentField = '';
      let inQuotes = false;
      
      for (let j = 0; j < line.length; j++) {
        const char = line[j];
        
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          fields.push(currentField.trim());
          currentField = '';
        } else {
          currentField += char;
        }
      }
      fields.push(currentField.trim()); // Push last field
      
      if (fields.length >= 3) {
        const hookId = fields[0];
        const category = fields[1].toLowerCase().replace('_', '-');
        const hookText = fields[2];
        
        if (hookText && hookText.length > 10) {
          hooks.push({
            id: hookId,
            text: hookText,
            category: category
          });
        }
      }
    }
    
    console.log(`Extracted ${hooks.length} hooks from CSV`);
    
    // DELETE ALL HOOKS - start completely fresh
    await pool.query("DELETE FROM hooks");
    console.log('Cleared all existing hooks');
    
    let inserted = 0;
    
    for (const h of hooks) {
      try {
        await pool.query(
          'INSERT INTO hooks (text,category,source) VALUES ($1,$2,$3)',
          [h.text, h.category, 'csv']
        );
        inserted++;
      } catch(e) {
        console.error('Insert error:', e.message);
      }
    }
    
    console.log(`Imported ${inserted} hooks from viral_hooks.csv`);
    res.json({ ok: true, count: inserted });
  } catch (err) { 
    console.error(err); 
    res.status(500).json({ error: err.message }); 
  }
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
    const response = await anthropicCreate({
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
    const resp = await anthropicCreate({
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



// ─── Video Ingest ─────────────────────────────────────────────────────────────
// Downloads video via yt-dlp, extracts audio + screenshots, transcribes + summarizes
app.post('/api/blocks/ingest-video', requireAuth, async (req, res) => {
  const { url, funnel_stage, category, tags } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const fs = require('fs');
  const { execSync, exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);
  const path = require('path');
  const os = require('os');

  // Detect platform
  const platform = url.includes('tiktok.com') ? 'TikTok'
    : url.includes('instagram.com') ? 'Instagram'
    : url.includes('youtube.com') || url.includes('youtu.be') ? 'YouTube'
    : url.includes('twitter.com') || url.includes('x.com') ? 'Twitter/X'
    : 'Video';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phixo-'));
  const videoPath = path.join(tmpDir, 'video.mp4');
  let audioPath = path.join(tmpDir, 'audio.mp3');
  const screenshotsDir = path.join(tmpDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  let title = platform + ' Video';
  let transcript = '';
  let summary = '';
  let summaryPoints = [];
  let screenshotDriveIds = [];
  let thumbnailUrl = '';
  let duration = 0;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const send = (step, msg) => {
      res.write(`data: ${JSON.stringify({ step, msg })}\n\n`);
    };

    // ── Step 1: Download video ──────────────────────────────────────────────
    send('download', 'Downloading video from ' + platform + '...');
    // Find yt-dlp binary (may be in various locations depending on install method)
    // Wait for yt-dlp to be ready (downloads on first boot)
    await _toolSetup;
    if (!global.YTDLP_PATH) throw new Error('yt-dlp is still downloading or failed to install. Wait 30 seconds and try again.');
    const ytdlpCmd = `"${global.YTDLP_PATH}"`;
    console.log('Using yt-dlp:', ytdlpCmd);

    // Write Instagram cookies file if env var is set
    let cookiesArg = '';
    const isInstagram = url.includes('instagram.com');
    if (isInstagram && process.env.INSTAGRAM_COOKIES) {
      const cookiePath = path.join(tmpDir, 'ig_cookies.txt');
      fs.writeFileSync(cookiePath, process.env.INSTAGRAM_COOKIES);
      cookiesArg = `--cookies "${cookiePath}"`;
    }

    const buildCmd = (fmt) => `${ytdlpCmd} ${cookiesArg} -f "${fmt}" --no-playlist --no-check-certificate -o "${videoPath}" "${url}"`;

    const checkIgError = (msg) => {
      if (!isInstagram) return;
      if (msg.includes('login required') || msg.includes('login page') || msg.includes('not available') || msg.includes('rate-limit')) {
        if (!process.env.INSTAGRAM_COOKIES) {
          throw new Error('Instagram requires authentication. Add your INSTAGRAM_COOKIES to Railway Variables — see the setup instructions in the app.');
        } else {
          throw new Error('Instagram cookies have expired. Re-export your cookies from Chrome and update the INSTAGRAM_COOKIES variable in Railway.');
        }
      }
    };

    try {
      await execAsync(buildCmd('best[height<=720]/best'), { timeout: 180000 });
    } catch(dlErr) {
      const errMsg = (dlErr.stderr || '') + (dlErr.message || '');
      checkIgError(errMsg);
      try {
        await execAsync(buildCmd('b'), { timeout: 180000 });
      } catch(e2) {
        const msg2 = (e2.stderr || '') + (e2.message || '');
        checkIgError(msg2);
        throw e2;
      }
    }

    if (!fs.existsSync(videoPath)) throw new Error('Video download failed — yt-dlp could not retrieve this URL');

    // Get title and duration from yt-dlp metadata
    try {
      const meta = await execAsync(`yt-dlp --get-title --get-duration "${url}" 2>/dev/null || true`);
      const lines = meta.stdout.trim().split('\n').filter(Boolean);
      if (lines[0]) title = lines[0].substring(0, 100);
      if (lines[1]) {
        const parts = lines[1].split(':').map(Number);
        duration = parts.length === 2 ? parts[0]*60+parts[1] : parts.length === 3 ? parts[0]*3600+parts[1]*60+parts[2] : parseInt(parts[0])||0;
      }
    } catch(e) {}

    // ── Step 2: Extract audio ────────────────────────────────────────────────
    send('audio', 'Extracting audio...');
    const ffBin = global.FFMPEG_PATH || 'ffmpeg';
    // Try aac first, then copy stream, then fall back to using video directly
    let audioExtracted = false;
    for (const attempt of [
      `"${ffBin}" -i "${videoPath}" -vn -acodec aac -b:a 128k "${audioPath.replace('.mp3','.m4a')}" -y`,
      `"${ffBin}" -i "${videoPath}" -vn -acodec copy "${audioPath.replace('.mp3','.m4a')}" -y`,
      `"${ffBin}" -i "${videoPath}" -vn -f adts "${audioPath.replace('.mp3','.aac')}" -y`,
    ]) {
      try {
        await execAsync(attempt, { timeout: 60000 });
        if (attempt.includes('.m4a')) audioPath = audioPath.replace('.mp3','.m4a');
        if (attempt.includes('.aac')) audioPath = audioPath.replace('.mp3','.aac');
        audioExtracted = true;
        console.log('Audio extracted with:', attempt.split(' ').slice(0,3).join(' '));
        break;
      } catch(e) {
        console.warn('Audio attempt failed:', e.message?.substring(0,100));
      }
    }
    // Last resort: use the video file itself (Whisper accepts mp4)
    if (!audioExtracted) {
      console.warn('Audio extraction failed — sending video directly to Whisper');
      audioPath = videoPath;
    }

    // ── Step 3: Screenshots ──────────────────────────────────────────────────
    send('screenshots', 'Capturing frames...');
    let frames = [];
    const interval = Math.max(Math.floor((duration || 60) / 7), 3);
    const ffmpegBin = global.FFMPEG_PATH || 'ffmpeg';
    try {
      await execAsync(
        `"${ffmpegBin}" -i "${videoPath}" -vf "fps=1/${interval},scale=640:-2" -frames:v 8 "${screenshotsDir}/frame_%03d.jpg" -y 2>/dev/null`,
        { timeout: 60000 }
      );
      frames = fs.readdirSync(screenshotsDir).filter(f => f.endsWith('.jpg')).sort();
    } catch(ffErr) {
      console.warn('ffmpeg screenshots failed, continuing without frames:', ffErr.message);
    }

    // ── Step 4: Upload screenshots to Drive ──────────────────────────────────
    send('uploading', `Uploading ${frames.length} screenshots to Drive...`);
    const drive = getDrive(req);

    // Find/create "Video Screenshots" folder in Drive
    let shotFolderId;
    const folderSearch = await drive.files.list({
      q: `name='Video Screenshots' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)'
    });
    if (folderSearch.data.files.length) {
      shotFolderId = folderSearch.data.files[0].id;
    } else {
      const created = await drive.files.create({
        requestBody: { name: 'Video Screenshots', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      shotFolderId = created.data.id;
    }

    // Upload each frame
    const { Readable } = require('stream');
    for (let i = 0; i < frames.length; i++) {
      const framePath = path.join(screenshotsDir, frames[i]);
      const frameData = fs.readFileSync(framePath);
      const uploaded = await drive.files.create({
        requestBody: {
          name: `${title.substring(0,40)}_frame_${i+1}.jpg`,
          parents: [shotFolderId],
          mimeType: 'image/jpeg'
        },
        media: { mimeType: 'image/jpeg', body: Readable.from(frameData) },
        fields: 'id,thumbnailLink'
      });
      screenshotDriveIds.push({
        id: uploaded.data.id,
        thumb: `/api/drive/file/${uploaded.data.id}`,
        label: `Frame ${i+1} (~${(i * interval)}s)`
      });
      if (i === 0) thumbnailUrl = `/api/drive/file/${uploaded.data.id}`;
    }

    // ── Step 5: Transcribe with Whisper ──────────────────────────────────────
    send('transcribe', 'Transcribing audio with Whisper...');
    const audioStat = fs.statSync(audioPath);
    const maxWhisperBytes = 24 * 1024 * 1024; // 24MB limit

    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set — add it in Railway Variables');

    let audioBuffer = fs.readFileSync(audioPath);
    if (audioBuffer.length > maxWhisperBytes) {
      // Re-encode at lower quality to fit
      let smallAudio = path.join(tmpDir, 'audio_small.mp3');
      await execAsync(`"${global.FFMPEG_PATH || 'ffmpeg'}" -i "${audioPath}" -acodec aac -b:a 64k -ar 16000 "${smallAudio.replace('.mp3','.m4a')}" -y 2>/dev/null`); smallAudio = smallAudio.replace('.mp3','.m4a');
      audioBuffer = fs.readFileSync(smallAudio);
    }

    const whisperForm = new FormData();
    const audioMime = audioPath.endsWith('.mp4') ? 'video/mp4' : audioPath.endsWith('.aac') ? 'audio/aac' : 'audio/mp4';
    const audioExt = audioPath.split('.').pop();
    const audioBlob = new Blob([audioBuffer], { type: audioMime });
    const audioFileName = 'audio.' + audioExt;
    whisperForm.append('file', audioBlob, audioFileName);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('response_format', 'text');

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: whisperForm
    });
    if (!whisperRes.ok) throw new Error('Whisper API error: ' + await whisperRes.text());
    transcript = (await whisperRes.text()).trim();

    // ── Step 6: Summarize with Claude ────────────────────────────────────────
    send('summarize', 'Extracting key points with Claude...');
    const claudeRes = await anthropicCreate({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You're analyzing a ${platform} video transcript for a portrait photographer named Ian. Extract the key content.

TRANSCRIPT:
${transcript.substring(0, 6000)}

Return ONLY a JSON object with these fields (no markdown, no extra text):
{
  "title": "short descriptive title for this content (max 60 chars)",
  "platform_category": "educational/behind-the-scenes/marketing/posing/lighting/client-work/gear/motivation",
  "key_points": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "one_liner": "one sentence summary of what this video is actually about",
  "relevance": "why this is useful for Ian's photography business (1-2 sentences)"
}`
      }]
    });

    try {
      const rawText = claudeRes.content[0].text.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
      const parsed = JSON.parse(rawText);
      title = parsed.title || title;
      summaryPoints = parsed.key_points || [];
      summary = parsed.one_liner || '';
      // Store full structured metadata
      summary = JSON.stringify({
        one_liner: parsed.one_liner || '',
        platform_category: parsed.platform_category || '',
        key_points: parsed.key_points || [],
        relevance: parsed.relevance || ''
      });
    } catch(e) {
      summary = claudeRes.content[0].text;
    }

    // ── Step 7: Save block to DB ──────────────────────────────────────────────
    send('saving', 'Saving to library...');
    const metadata = {
      platform,
      platform_category: JSON.parse(summary).platform_category || '',
      duration,
      screenshot_frames: screenshotDriveIds,
      one_liner: JSON.parse(summary).one_liner || '',
      key_points: JSON.parse(summary).key_points || [],
      relevance: JSON.parse(summary).relevance || ''
    };

    const result = await pool.query(
      `INSERT INTO blocks (type, title, category, tags, funnel_stage, source, source_url, thumbnail_url, content_payload, metadata)
       VALUES ($1, $2, $3, $4, $5, 'url', $6, $7, $8, $9) RETURNING *`,
      [
        'video',
        title,
        category || metadata.platform_category || platform.toLowerCase(),
        tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        funnel_stage || '',
        url,
        thumbnailUrl,
        transcript,
        JSON.stringify(metadata)
      ]
    );

    send('done', 'Block created');
    res.write(`data: ${JSON.stringify({ done: true, block: result.rows[0] })}\n\n`);
    res.end();

  } catch (err) {
    console.error('Video ingest error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  } finally {
    // Cleanup temp files
    try {
      const { execSync } = require('child_process');
      execSync(`rm -rf "${tmpDir}"`);
    } catch(e) {}
  }
});

// ─── Sync Drive folders → auto-import new blocks ─────
// ── Repair thumbnail URLs ─────────────────────────────────────────────────────
app.post('/api/blocks/repair-thumbnails', requireAuth, async (req, res) => {
  try {
    // 1. Image blocks with drive_file_id → always proxy
    const imgFix = await pool.query(`
      UPDATE blocks 
      SET thumbnail_url = '/api/drive/file/' || drive_file_id
      WHERE drive_file_id IS NOT NULL AND drive_file_id != ''
        AND file_mime IS NOT NULL AND file_mime LIKE 'image/%'
      RETURNING id
    `);

    // 2. Video ingest blocks — pull first frame from metadata
    const videoBlocks = await pool.query(
      "SELECT id, metadata FROM blocks WHERE type='video' AND metadata IS NOT NULL AND metadata::text LIKE '%screenshot_frames%'"
    );
    let videoFixed = 0;
    for (const b of videoBlocks.rows) {
      const frames = (b.metadata || {}).screenshot_frames || [];
      if (frames.length && frames[0].id) {
        await pool.query('UPDATE blocks SET thumbnail_url=$1 WHERE id=$2',
          ['/api/drive/file/' + frames[0].id, b.id]);
        videoFixed++;
      }
    }

    // 3. Fix missing file_mime from file_name extension
    const noMime = await pool.query(
      "SELECT id, file_name FROM blocks WHERE drive_file_id IS NOT NULL AND (file_mime IS NULL OR file_mime = '')"
    );
    let mimeFixed = 0;
    const extMap = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',
      webp:'image/webp',mp4:'video/mp4',mov:'video/quicktime',pdf:'application/pdf'};
    for (const b of noMime.rows) {
      const ext = (b.file_name||'').split('.').pop().toLowerCase();
      if (extMap[ext]) {
        await pool.query('UPDATE blocks SET file_mime=$1 WHERE id=$2', [extMap[ext], b.id]);
        mimeFixed++;
      }
    }

    // 4. Fix all blocks with expired CDN URLs or missing thumbnails
    // For image types: use file proxy. For everything else with drive_file_id: use thumbnail proxy
    const forceAll = await pool.query(`
      UPDATE blocks 
      SET thumbnail_url = CASE
            WHEN type IN ('pose','image') AND drive_file_id IS NOT NULL 
              THEN '/api/drive/file/' || drive_file_id
            WHEN drive_file_id IS NOT NULL AND drive_file_id NOT LIKE '%vnd.google%'
              THEN '/api/drive/thumbnail/' || drive_file_id
            ELSE NULL
          END
      WHERE drive_file_id IS NOT NULL
        AND drive_file_id != ''
        AND (
          thumbnail_url IS NULL 
          OR thumbnail_url = ''
          OR thumbnail_url LIKE 'https://lh3.google%'
          OR thumbnail_url LIKE 'https://drive.google%'
        )
      RETURNING id, type, thumbnail_url
    `);

    res.json({ ok:true, images_fixed:imgFix.rows.length, videos_fixed:videoFixed, mime_fixed:mimeFixed, fixed:forceAll.rows.length, details:forceAll.rows });
  } catch(err) {
    console.error('Repair error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── Drive Thumbnail Proxy ─────────────────────────────────────────────────────
// Fetches a fresh thumbnail from Drive API for any file type (video, PDF, doc, etc.)
// Drive generates previews for all types — we just can't store the links (they expire)
app.get('/api/drive/thumbnail/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const meta = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'thumbnailLink,mimeType'
    });
    const link = meta.data.thumbnailLink;
    if (!link) return res.status(404).send('No thumbnail');
    // Use larger size
    const bigLink = link.replace(/=s\d+$/, '=s400').replace(/=s\d+&/, '=s400&');
    // Fetch and proxy so auth isn't needed client-side
    const https = require('https');
    const imgRes = await new Promise((resolve, reject) => {
      https.get(bigLink, resolve).on('error', reject);
    });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=1800');
    imgRes.pipe(res);
  } catch(err) {
    console.error('Thumbnail proxy error:', req.params.fileId, err.message);
    res.status(404).send('No thumbnail');
  }
});

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
          [folder.type, f.name, folder.category, [], f.id, f.name, f.mimeType||'', f.mimeType&&f.mimeType.startsWith('image/')?`/api/drive/file/${f.id}`:'']
        );
        imported++;
      }
      skipped += existingIds.size;
      results.push({ folder: folder.name, new: newFiles.length, existing: existingIds.size });
    }

    res.json({ ok: true, imported, skipped, results });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Clean up deleted files from research library
app.post('/api/drive/cleanup', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const blocks = await pool.query('SELECT id, drive_file_id, title FROM blocks WHERE drive_file_id IS NOT NULL AND drive_file_id != \'\'');
    
    let deleted = 0;
    const deletedBlocks = [];
    
    console.log(`Checking ${blocks.rows.length} blocks for deleted Drive files...`);
    
    for (const block of blocks.rows) {
      let shouldDelete = false;
      
      try {
        // Try to get file metadata from Drive
        const fileRes = await drive.files.get({
          fileId: block.drive_file_id,
          fields: 'id,trashed,name'
        });
        
        // If file is trashed, delete from DB
        if (fileRes.data.trashed) {
          shouldDelete = true;
          console.log(`File is trashed: ${block.title} (${block.drive_file_id})`);
        }
      } catch (err) {
        // File doesn't exist (404) or other error - delete from DB
        shouldDelete = true;
        console.log(`File not found or error: ${block.title} (${block.drive_file_id}) - ${err.message}`);
      }
      
      if (shouldDelete) {
        await pool.query('DELETE FROM blocks WHERE id = $1', [block.id]);
        deletedBlocks.push({ id: block.id, title: block.title });
        deleted++;
      }
    }
    
    console.log(`Cleanup complete: ${deleted} blocks deleted from database`);
    res.json({ ok: true, deleted, deletedBlocks });
  } catch (err) { 
    console.error('Cleanup error:', err); 
    res.status(500).json({ error: err.message }); 
  }
});

// Sync clients from Drive "Clients" folder with full document analysis
app.post('/api/drive/sync-clients', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    
    // Helper: Download and extract text from a file
    const extractFileText = async (fileId, mimeType) => {
      // Skip if dependencies not available
      if (!pdfParse || !mammoth) {
        return null;
      }
      
      try {
        const fileRes = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const buffer = Buffer.from(fileRes.data);
        
        if (mimeType === 'application/pdf' && pdfParse) {
          const pdfData = await pdfParse(buffer);
          return pdfData.text;
        } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' && mammoth) {
          const result = await mammoth.extractRawText({ buffer });
          return result.value;
        } else if (mimeType === 'text/plain') {
          return buffer.toString('utf-8');
        }
        return null;
      } catch (err) {
        console.error(`Error extracting text from ${fileId}:`, err.message);
        return null;
      }
    };
    
    // Find "Clients" folder
    const clientsFolderRes = await drive.files.list({
      q: "name='Clients' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id,name)',
      pageSize: 5
    });
    
    if (!clientsFolderRes.data.files.length) {
      return res.json({ ok: false, message: 'No "Clients" folder found in Drive' });
    }
    
    const clientsFolderId = clientsFolderRes.data.files[0].id;
    
    // Get all folders inside Clients
    const topLevelFoldersRes = await drive.files.list({
      q: `'${clientsFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)',
      pageSize: 200
    });
    
    const clientFolders = [];
    
    // Process each top-level folder
    for (const folder of topLevelFoldersRes.data.files || []) {
      if (folder.name === 'Brand' || folder.name === 'Influencer') {
        const subFoldersRes = await drive.files.list({
          q: `'${folder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
          fields: 'files(id,name)',
          pageSize: 200
        });
        
        for (const subFolder of subFoldersRes.data.files || []) {
          clientFolders.push({
            id: subFolder.id,
            name: subFolder.name,
            category: folder.name.toLowerCase()
          });
        }
      } else {
        clientFolders.push({
          id: folder.id,
          name: folder.name,
          category: 'individual'
        });
      }
    }
    
    let created = 0;
    let updated = 0;
    let analyzed = 0;
    
    // Process each client folder
    for (const folder of clientFolders) {
      console.log(`Processing client folder: ${folder.name}`);
      
      // Check if client already exists
      const existing = await pool.query('SELECT id FROM clients WHERE drive_folder_id = $1', [folder.id]);
      
      // Get files inside this client folder
      const filesRes = await drive.files.list({
        q: `'${folder.id}' in parents and trashed=false`,
        fields: 'files(id,name,mimeType)',
        pageSize: 50
      });
      
      const files = filesRes.data.files || [];
      
      // Extract text from all readable files
      const fileContents = [];
      for (const file of files) {
        if (file.mimeType === 'application/pdf' || 
            file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            file.mimeType === 'text/plain') {
          const text = await extractFileText(file.id, file.mimeType);
          if (text) {
            fileContents.push(`=== ${file.name} ===\n${text}`);
          }
        }
      }
      
      let clientData = {
        name: folder.name,
        drive_folder_id: folder.id
      };
      
      // Use Claude to analyze if we have file contents
      if (fileContents.length > 0 && process.env.ANTHROPIC_API_KEY) {
        try {
          const fullText = fileContents.join('\n\n').substring(0, 30000); // Limit to 30k chars
          
          const analysis = await anthropicCreate({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: `You are analyzing client documents for a photography business. Extract ALL relevant information and map it to these exact fields.

Client Folder: ${folder.name}

Document Contents:
${fullText}

Extract and return JSON with these exact fields (use null if not found):
{
  "platform": "Instagram/LinkedIn/etc",
  "thread_id": "message thread ID",
  "session_type": "Professional Headshots/Personal Branding/etc",
  "session_date": "session date",
  "offer": "what was offered",
  "first_contact": "first contact date",
  "status": "lead/booked/shot/delivered",
  "lead_temperature": "hot/warm/cold",
  "what_they_want": "what client wants",
  "emotional_read": "how they're feeling",
  "red_flags": "any red flags",
  "opportunity": "opportunity notes",
  "how_to_open": "how to open the session",
  "things_to_avoid": "things to avoid",
  "key_question": "key question to ask",
  "things_to_talk_about": "conversation topics",
  "what_they_need": "what they need from session",
  "moment_to_watch": "key moment to watch for",
  "how_to_close": "how to close session",
  "lighting_setup": "lighting notes",
  "conversation_log": "message history if present",
  "draft_reply": "any draft reply",
  "notes": "general notes"
}

Return ONLY valid JSON, no markdown, no explanations.`
            }]
          });
          
          const responseText = analysis.content[0].text.trim();
          const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          const aiData = JSON.parse(cleanJson);
          
          // Map all fields
          Object.assign(clientData, aiData);
          analyzed++;
          
          console.log(`Analyzed ${folder.name}: Found ${Object.keys(aiData).filter(k => aiData[k]).length} populated fields`);
        } catch (err) {
          console.error(`Failed to analyze ${folder.name}:`, err.message);
        }
      }
      
      if (existing.rows.length === 0) {
        // Create new client with all fields
        await pool.query(
          `INSERT INTO clients (
            name, drive_folder_id, platform, thread_id, session_type, session_date, offer,
            first_contact, status, lead_temperature, what_they_want, emotional_read, 
            red_flags, opportunity, how_to_open, things_to_avoid, key_question,
            things_to_talk_about, what_they_need, moment_to_watch, how_to_close,
            lighting_setup, conversation_log, draft_reply, notes, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 
            $18, $19, $20, $21, $22, $23, $24, $25, NOW()
          )`,
          [
            clientData.name, clientData.drive_folder_id,
            clientData.platform || null, clientData.thread_id || null,
            clientData.session_type || null, clientData.session_date || null,
            clientData.offer || null, clientData.first_contact || null,
            clientData.status || 'lead', clientData.lead_temperature || null,
            clientData.what_they_want || null, clientData.emotional_read || null,
            clientData.red_flags || null, clientData.opportunity || null,
            clientData.how_to_open || null, clientData.things_to_avoid || null,
            clientData.key_question || null, clientData.things_to_talk_about || null,
            clientData.what_they_need || null, clientData.moment_to_watch || null,
            clientData.how_to_close || null, clientData.lighting_setup || null,
            clientData.conversation_log || null, clientData.draft_reply || null,
            clientData.notes || null
          ]
        );
        created++;
      } else {
        // Update existing client
        await pool.query(
          `UPDATE clients SET 
            name = $1, platform = COALESCE($2, platform), thread_id = COALESCE($3, thread_id),
            session_type = COALESCE($4, session_type), session_date = COALESCE($5, session_date),
            offer = COALESCE($6, offer), first_contact = COALESCE($7, first_contact),
            status = COALESCE($8, status), lead_temperature = COALESCE($9, lead_temperature),
            what_they_want = COALESCE($10, what_they_want), emotional_read = COALESCE($11, emotional_read),
            red_flags = COALESCE($12, red_flags), opportunity = COALESCE($13, opportunity),
            how_to_open = COALESCE($14, how_to_open), things_to_avoid = COALESCE($15, things_to_avoid),
            key_question = COALESCE($16, key_question), things_to_talk_about = COALESCE($17, things_to_talk_about),
            what_they_need = COALESCE($18, what_they_need), moment_to_watch = COALESCE($19, moment_to_watch),
            how_to_close = COALESCE($20, how_to_close), lighting_setup = COALESCE($21, lighting_setup),
            conversation_log = COALESCE($22, conversation_log), draft_reply = COALESCE($23, draft_reply),
            notes = COALESCE($24, notes)
          WHERE drive_folder_id = $25`,
          [
            clientData.name, clientData.platform, clientData.thread_id,
            clientData.session_type, clientData.session_date, clientData.offer,
            clientData.first_contact, clientData.status, clientData.lead_temperature,
            clientData.what_they_want, clientData.emotional_read, clientData.red_flags,
            clientData.opportunity, clientData.how_to_open, clientData.things_to_avoid,
            clientData.key_question, clientData.things_to_talk_about, clientData.what_they_need,
            clientData.moment_to_watch, clientData.how_to_close, clientData.lighting_setup,
            clientData.conversation_log, clientData.draft_reply, clientData.notes,
            clientData.drive_folder_id
          ]
        );
        updated++;
      }
    }
    
    res.json({ ok: true, created, updated, analyzed, total: clientFolders.length });
  } catch (err) {
    console.error('Client sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Sync discovery from Drive folders (excluding Clients)
app.post('/api/drive/sync-discovery', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    
    // Get all top-level folders except specific ones
    const excludeFolders = ['Clients', 'Pose', 'Meme', 'SFX', 'Music', 'Phixo Knowledge', 'Tik Tok Scripts', 'Videos'];
    
    const allFoldersRes = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false",
      fields: 'files(id,name)',
      pageSize: 200
    });
    
    const discoveryFolders = (allFoldersRes.data.files || []).filter(f => !excludeFolders.includes(f.name));
    
    let created = 0;
    let updated = 0;
    
    for (const folder of discoveryFolders) {
      // Check if prospect already exists
      const existing = await pool.query('SELECT id FROM prospects WHERE drive_folder_id = $1', [folder.id]);
      
      if (existing.rows.length === 0) {
        // Create new prospect
        await pool.query(
          `INSERT INTO prospects (name, drive_folder_id, status, category, created_at) 
           VALUES ($1, $2, 'watching', 'business', NOW())`,
          [folder.name, folder.id]
        );
        created++;
      } else {
        // Update name if changed
        await pool.query(
          'UPDATE prospects SET name = $1 WHERE drive_folder_id = $2',
          [folder.name, folder.id]
        );
        updated++;
      }
    }
    
    res.json({ ok: true, created, updated, total: discoveryFolders.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/file/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDrive(req);
    const meta = await drive.files.get({
      fileId: req.params.fileId,
      fields: 'mimeType,name,size'
    });
    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const fileSize = parseInt(meta.data.size || '0');
    const isVideo = mimeType.startsWith('video/');

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (isVideo) {
      // For video: buffer entirely then serve with proper range support
      // This enables seeking in the <video> element
      const chunks = [];
      const fileRes = await drive.files.get(
        { fileId: req.params.fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      await new Promise((resolve, reject) => {
        fileRes.data.on('data', chunk => chunks.push(chunk));
        fileRes.data.on('end', resolve);
        fileRes.data.on('error', reject);
      });
      const buffer = Buffer.concat(chunks);
      const total = buffer.length;
      res.setHeader('Accept-Ranges', 'bytes');

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? Math.min(parseInt(parts[1], 10), total - 1) : total - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', end - start + 1);
        res.end(buffer.slice(start, end + 1));
      } else {
        res.setHeader('Content-Length', total);
        res.end(buffer);
      }
    } else {
      // Images/PDFs: pipe directly
      if (fileSize) res.setHeader('Content-Length', fileSize);
      const fileRes = await drive.files.get(
        { fileId: req.params.fileId, alt: 'media' },
        { responseType: 'stream' }
      );
      fileRes.data.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      fileRes.data.pipe(res);
    }
  } catch (err) {
    console.error('Drive file error for', req.params.fileId, ':', err.message);
    if (!res.headersSent) res.status(404).send('File not found');
  }
});



// ── Library Knowledge Base Q&A ───────────────────────────────────────────────
app.post('/api/library/ask', requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    // Fetch ALL blocks with content
    const result = await pool.query(`
      SELECT id, type, title, category, tags, content_payload, metadata, source_url
      FROM blocks ORDER BY created_at DESC
    `);
    const blocks = result.rows;

    if (!blocks.length) return res.json({ answer: "Your library is empty. Add some blocks first.", sources: [] });

    // Build context — every block contributes what it has
    const contextParts = blocks.map(b => {
      const m = b.metadata || {};
      const lines = [`[Block #${b.id}] ${b.type.toUpperCase()}: "${b.title}"`];
      if (b.category) lines.push(`Category: ${b.category}`);
      if (m.platform) lines.push(`Platform: ${m.platform}`);
      if (m.one_liner) lines.push(`Summary: ${m.one_liner}`);
      if (m.key_points && m.key_points.length) lines.push(`Key points: ${m.key_points.join(' | ')}`);
      if (m.relevance) lines.push(`Relevance: ${m.relevance}`);
      if (b.content_payload) {
        // Include full content for notes/scripts, truncated for long transcripts
        const maxLen = ['note','conversation','pdf'].includes(b.type) ? 4000 : 1500;
        const text = b.content_payload.substring(0, maxLen);
        lines.push(`Content: ${text}${b.content_payload.length > maxLen ? '...[truncated]' : ''}`);
      }
      return lines.join('\n');
    });

    const context = contextParts.join('\n\n---\n\n');

    const msg = await anthropicCreate({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `You are a research assistant for Ian, a portrait photographer. You have access to Ian's full research library below.

CRITICAL RULES:
1. Only answer based on what is explicitly in the provided library content
2. Cite block titles when making claims — e.g. "According to [Block Title]..."
3. If the answer isn't clearly in the library, say "I don't see that in your library" — never make things up
4. Be specific and practical. Ian is a working photographer, not a student.
5. If multiple blocks are relevant, synthesize them and cite each one

LIBRARY CONTENT:
${context}`,
      messages: [{ role: 'user', content: question }]
    });

    const answer = msg.content[0].text;

    // Extract which block IDs were referenced
    const citedIds = blocks
      .filter(b => answer.includes(b.title) || answer.includes(`Block #${b.id}`))
      .map(b => ({ id: b.id, title: b.title, type: b.type }));

    res.json({ answer, sources: citedIds, block_count: blocks.length });
  } catch (err) {
    console.error('Library ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Restyle Script (inline SSE) ───────────────────────────────────────────────
app.post('/api/ideate/restyle-script', requireAuth, async (req, res) => {
  const { exampleUrl, hook, script, pillar, funnelStage, lane } = req.body;
  if (!exampleUrl || !script) return res.status(400).json({ error: 'exampleUrl and script required' });

  const fs2   = require('fs');
  const path2 = require('path');
  const os2   = require('os');
  const { promisify } = require('util');
  const { exec } = require('child_process');
  const execAsync = promisify(exec);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (step, msg, extra) => res.write('data: ' + JSON.stringify({step, msg, ...(extra||{})}) + '\n\n');

  const tmpDir    = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'phixo-rs-'));
  const videoPath = path2.join(tmpDir, 'video.mp4');
  const audioPath = path2.join(tmpDir, 'audio.mp3');

  try {
    send('download', 'Downloading example video...');
    if (!global.YTDLP_PATH) throw new Error('yt-dlp not ready — wait 30s and retry');
    const ytdlp = '"' + global.YTDLP_PATH + '"';
    let cookiesArg = '';
    if (exampleUrl.includes('instagram.com') && process.env.INSTAGRAM_COOKIES) {
      const cookiePath2 = path2.join(tmpDir, 'ig_cookies.txt');
      fs2.writeFileSync(cookiePath2, process.env.INSTAGRAM_COOKIES);
      cookiesArg = '--cookies "' + cookiePath2 + '"';
    }
    let downloaded = false;
    for (const fmt of ['bestaudio[ext=m4a]','bestaudio[ext=mp3]','bestaudio','worstvideo']) {
      try {
        await execAsync(`${ytdlp} ${cookiesArg} -f "${fmt}" --no-playlist --no-check-certificate -o "${videoPath}" "${exampleUrl}"`, {timeout:60000});
        if (fs2.existsSync(videoPath) && fs2.statSync(videoPath).size > 1000) { downloaded = true; break; }
      } catch(e) {}
    }
    if (!downloaded) throw new Error('Could not download video — Instagram may need cookie setup');

    send('audio', 'Extracting audio...');
    try { await execAsync(`ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 -y "${audioPath}"`, {timeout:30000}); } catch(e) {}
    const audioFile = fs2.existsSync(audioPath) ? audioPath : videoPath;
    const audioBuffer = fs2.readFileSync(audioFile);

    send('transcribe', 'Transcribing with Whisper...');
    const audioExt2 = audioFile.endsWith('.mp3') ? 'mp3' : 'mp4';
    const audioMime2 = audioFile.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
    const audioBlob2 = new Blob([audioBuffer], { type: audioMime2 });
    const wForm = new FormData();
    wForm.append('file', audioBlob2, 'audio.' + audioExt2);
    wForm.append('model', 'whisper-1');
    wForm.append('response_format', 'text');
    const wres = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: wForm
    });
    if (!wres.ok) throw new Error('Whisper error: ' + await wres.text());
    const transcript = (await wres.text()).trim();
    send('transcribed', 'Transcribed — rewriting script...');

    send('restyle', 'Applying delivery style...');
    const restylePrompt = `You are helping Ian Green (Phixo), portrait photographer, West Island Montreal, write a TikTok/Reel script.

A real creator already used this hook in the wild and made it work. Your job is to figure out WHY it worked — what did they understand about this hook — and then write Ian's version from that understanding.

HOOK (locked — Ian is using this exact hook):
"${hook}"

IAN'S CONTENT (the subject matter, points, and details to work with):
${script}

REAL EXAMPLE TRANSCRIPT (someone who already made this hook land):
${transcript}

STEP 1 — ANALYZE THE EXAMPLE:
Read the transcript and figure out what this creator understood about the hook. Ask yourself:
- What promise does this hook make to a viewer? What are they now expecting?
- Did the creator deliver a list, a story, a single building argument, or something else — and why did that choice fit this hook?
- Where did the energy go? Did it build, stay flat, or land all at once at the end?
- Was it personal or instructional — and what did the hook demand?
- What would have broken this hook? What would have felt like a bait-and-switch?

Write one sentence summarizing what made this hook work. Be specific — not 'it was engaging' but 'this hook works when the script stays in confession-of-practice mode rather than tutorial mode' or 'this hook demands a concrete numbered payoff delivered fast.'

STEP 2 — WRITE IAN'S SCRIPT:
Using that understanding, write Ian's script. Use Ian's content above as your subject matter. Apply the structural insight from Step 1 — not the words, not the topic, but the shape of how the hook gets earned.

PHIXO VOICE (always applies):
- Warm and direct — knowledgeable friend, not a brand
- Sentences move forward, never recap the previous one
- Point lands without being announced
- Ends at the last real thing — no wrap-up, no lesson stated out loud
- Specific over vague. Never: stunning, perfect, gorgeous, transformative
- No emojis

Write only what comes after the hook. 4-8 sentences.

Return your response as JSON in this exact format, nothing else:
{"analysis":"one sentence about what makes this hook work","script":"the script text"}
`;

    const msg = await anthropicCreate({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{role:'user', content: restylePrompt}]
    });
    let restyled = '', analysis = '';
    try {
      const raw = msg.content[0].text.trim();
      const clean = raw.replace(/^```json\s*/,'').replace(/```\s*$/,'');
      const parsed = JSON.parse(clean);
      restyled = parsed.script || '';
      analysis = parsed.analysis || '';
    } catch(e) {
      // fallback: treat whole response as script
      restyled = msg.content[0].text.trim();
    }
    send('done', 'Done', { restyled, analysis, transcriptPreview: transcript.slice(0, 250) });
    res.end();

  } catch(err) {
    send('error', err.message);
    res.end();
  } finally {
    try { [videoPath, audioPath].forEach(p => { try { require('fs').unlinkSync(p); } catch(e){} }); } catch(e) {}
    try { require('fs').rmdirSync(tmpDir, {recursive:true}); } catch(e) {}
  }
});

// ── Block AI Summarize ────────────────────────────────────────────────────────
app.post('/api/blocks/:id/summarize', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const block = await pool.query('SELECT * FROM blocks WHERE id=$1', [id]);
    if (!block.rows.length) return res.status(404).json({ error: 'Not found' });
    const b = block.rows[0];

    // Get content from DB or Drive
    let content = b.content_payload || '';
    if (!content && b.drive_file_id) {
      try {
        const drive = getDrive(req);
        const fileRes = await drive.files.get(
          { fileId: b.drive_file_id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        content = Buffer.from(fileRes.data).toString('utf8').substring(0, 8000);
      } catch(e) { content = b.title; }
    }
    if (!content) return res.status(400).json({ error: 'No content to summarize' });

    const resp = await anthropicCreate({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You're summarizing research material for portrait photographer Ian Green.

Title: "${b.title}"
Type: ${b.type}

Content:
${content.substring(0, 6000)}

Extract the most useful information. Return ONLY valid JSON, no markdown:
{
  "key_points": ["5-7 specific, actionable points that are most useful"],
  "one_liner": "one sentence summary",
  "relevance": "why this matters for portrait photography sessions"
}`
      }]
    });

    let parsed;
    try {
      const raw = resp.content[0].text.replace(/^\`\`\`json\s*/,'').replace(/^\`\`\`\s*/,'').replace(/\s*\`\`\`$/,'').trim();
      parsed = JSON.parse(raw);
    } catch(e) {
      return res.status(500).json({ error: 'AI parse error: ' + e.message });
    }

    // Merge into existing metadata
    const existing = b.metadata || {};
    const newMeta = { ...existing, ...parsed, summarized_at: new Date().toISOString() };
    await pool.query('UPDATE blocks SET metadata=$1 WHERE id=$2', [JSON.stringify(newMeta), id]);

    res.json({ success: true, metadata: newMeta });
  } catch(err) {
    console.error('Summarize error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Get random hooks for inspiration
app.get('/api/hooks/random', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const result = await pool.query(`
      SELECT * FROM hooks 
      ORDER BY RANDOM() 
      LIMIT $1
    `, [limit]);
    res.json(result.rows);
  } catch (err) {
    console.error('Random hooks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/hooks/reset-used', requireAuth, async (req, res) => {
  const before = USED_HOOK_IDS.size;
  USED_HOOK_IDS.clear();
  res.json({ ok: true, cleared: before });
});

app.get('/api/hooks/used-count', requireAuth, async (req, res) => {
  res.json({ used: USED_HOOK_IDS.size, max: MAX_USED_HISTORY });
});

// One-time import of hooks from hooks_data.txt
app.post('/api/hooks/import', requireAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const hooksFile = path.join(__dirname, 'hooks_data.txt');
    
    if (!fs.existsSync(hooksFile)) {
      return res.status(404).json({ error: 'hooks_data.txt not found' });
    }
    
    // Check if hooks already imported
    const existing = await pool.query('SELECT COUNT(*) FROM hooks');
    if (parseInt(existing.rows[0].count) > 0) {
      return res.json({ message: 'Hooks already imported', count: existing.rows[0].count });
    }
    
    const content = fs.readFileSync(hooksFile, 'utf-8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    
    let currentCategory = 'general';
    let imported = 0;
    
    for (const line of lines) {
      // Skip title line
      if (line.includes('1000 VIRAL HOOKS')) continue;
      
      // Check if it's a category header (ends with :)
      if (line.endsWith(':') && line.length < 50) {
        currentCategory = line.replace(':', '').trim();
        continue;
      }
      
      // Skip Instagram URLs
      if (line.startsWith('http')) continue;
      
      // Skip URL fragments
      if (line.includes('instagram.com') || line.includes('igsh=') || line.includes('utm_')) continue;
      
      // Skip lines that are too short
      if (line.length < 20) continue;
      
      // This is a hook template
      await pool.query(
        'INSERT INTO hooks (text, category, source) VALUES ($1, $2, $3)',
        [line, currentCategory, 'PDF Import']
      );
      imported++;
    }
    
    res.json({ success: true, imported, message: `Imported ${imported} hooks` });
  } catch (err) {
    console.error('Hooks import error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Library Knowledge Base Q&A ───────────────────────────────────────────────
app.post('/api/library/ask', requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });

    // Fetch ALL blocks with content
    const result = await pool.query(`
      SELECT id, type, title, category, tags, content_payload, metadata, source_url
      FROM blocks ORDER BY created_at DESC
    `);
    const blocks = result.rows;

    if (!blocks.length) return res.json({ answer: "Your library is empty. Add some blocks first.", sources: [] });

    // Build context — every block contributes what it has
    const contextParts = blocks.map(b => {
      const m = b.metadata || {};
      const lines = [`[Block #${b.id}] ${b.type.toUpperCase()}: "${b.title}"`];
      if (b.category) lines.push(`Category: ${b.category}`);
      if (m.platform) lines.push(`Platform: ${m.platform}`);
      if (m.one_liner) lines.push(`Summary: ${m.one_liner}`);
      if (m.key_points && m.key_points.length) lines.push(`Key points: ${m.key_points.join(' | ')}`);
      if (m.relevance) lines.push(`Relevance: ${m.relevance}`);
      if (b.content_payload) {
        // Include full content for notes/scripts, truncated for long transcripts
        const maxLen = ['note','conversation','pdf'].includes(b.type) ? 4000 : 1500;
        const text = b.content_payload.substring(0, maxLen);
        lines.push(`Content: ${text}${b.content_payload.length > maxLen ? '...[truncated]' : ''}`);
      }
      return lines.join('\n');
    });

    const context = contextParts.join('\n\n---\n\n');

    const msg = await anthropicCreate({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `You are a research assistant for Ian, a portrait photographer. You have access to Ian's full research library below.

CRITICAL RULES:
1. Only answer based on what is explicitly in the provided library content
2. Cite block titles when making claims — e.g. "According to [Block Title]..."
3. If the answer isn't clearly in the library, say "I don't see that in your library" — never make things up
4. Be specific and practical. Ian is a working photographer, not a student.
5. If multiple blocks are relevant, synthesize them and cite each one

LIBRARY CONTENT:
${context}`,
      messages: [{ role: 'user', content: question }]
    });

    const answer = msg.content[0].text;

    // Extract which block IDs were referenced
    const citedIds = blocks
      .filter(b => answer.includes(b.title) || answer.includes(`Block #${b.id}`))
      .map(b => ({ id: b.id, title: b.title, type: b.type }));

    res.json({ answer, sources: citedIds, block_count: blocks.length });
  } catch (err) {
    console.error('Library ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── Restyle Script (inline SSE) ───────────────────────────────────────────────
app.post('/api/ideate/restyle-script', requireAuth, async (req, res) => {
  const { exampleUrl, hook, script, pillar, funnelStage, lane } = req.body;
  if (!exampleUrl || !script) return res.status(400).json({ error: 'exampleUrl and script required' });

  const fs2   = require('fs');
  const path2 = require('path');
  const os2   = require('os');
  const { promisify } = require('util');
  const { exec } = require('child_process');
  const execAsync = promisify(exec);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (step, msg, extra) => res.write('data: ' + JSON.stringify({step, msg, ...(extra||{})}) + '\n\n');

  const tmpDir    = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'phixo-rs-'));
  const videoPath = path2.join(tmpDir, 'video.mp4');
  const audioPath = path2.join(tmpDir, 'audio.mp3');

  try {
    send('download', 'Downloading example video...');
    if (!global.YTDLP_PATH) throw new Error('yt-dlp not ready — wait 30s and retry');
    const ytdlp = '"' + global.YTDLP_PATH + '"';
    let cookiesArg = '';
    if (exampleUrl.includes('instagram.com') && process.env.INSTAGRAM_COOKIES) {
      const cookiePath2 = path2.join(tmpDir, 'ig_cookies.txt');
      fs2.writeFileSync(cookiePath2, process.env.INSTAGRAM_COOKIES);
      cookiesArg = '--cookies "' + cookiePath2 + '"';
    }
    let downloaded = false;
    for (const fmt of ['bestaudio[ext=m4a]','bestaudio[ext=mp3]','bestaudio','worstvideo']) {
      try {
        await execAsync(`${ytdlp} ${cookiesArg} -f "${fmt}" --no-playlist --no-check-certificate -o "${videoPath}" "${exampleUrl}"`, {timeout:60000});
        if (fs2.existsSync(videoPath) && fs2.statSync(videoPath).size > 1000) { downloaded = true; break; }
      } catch(e) {}
    }
    if (!downloaded) throw new Error('Could not download video — Instagram may need cookie setup');

    send('audio', 'Extracting audio...');
    try { await execAsync(`ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 4 -y "${audioPath}"`, {timeout:30000}); } catch(e) {}
    const audioFile = fs2.existsSync(audioPath) ? audioPath : videoPath;
    const audioBuffer = fs2.readFileSync(audioFile);

    send('transcribe', 'Transcribing with Whisper...');
    const audioExt2 = audioFile.endsWith('.mp3') ? 'mp3' : 'mp4';
    const audioMime2 = audioFile.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
    const audioBlob2 = new Blob([audioBuffer], { type: audioMime2 });
    const wForm = new FormData();
    wForm.append('file', audioBlob2, 'audio.' + audioExt2);
    wForm.append('model', 'whisper-1');
    wForm.append('response_format', 'text');
    const wres = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: wForm
    });
    if (!wres.ok) throw new Error('Whisper error: ' + await wres.text());
    const transcript = (await wres.text()).trim();
    send('transcribed', 'Transcribed — rewriting script...');

    send('restyle', 'Applying delivery style...');
    const restylePrompt = `You are helping Ian Green (Phixo), portrait photographer, West Island Montreal, write a TikTok/Reel script.

A real creator already used this hook in the wild and made it work. Your job is to figure out WHY it worked — what did they understand about this hook — and then write Ian's version from that understanding.

HOOK (locked — Ian is using this exact hook):
"${hook}"

IAN'S CONTENT (the subject matter, points, and details to work with):
${script}

REAL EXAMPLE TRANSCRIPT (someone who already made this hook land):
${transcript}

STEP 1 — ANALYZE THE EXAMPLE:
Read the transcript and figure out what this creator understood about the hook. Ask yourself:
- What promise does this hook make to a viewer? What are they now expecting?
- Did the creator deliver a list, a story, a single building argument, or something else — and why did that choice fit this hook?
- Where did the energy go? Did it build, stay flat, or land all at once at the end?
- Was it personal or instructional — and what did the hook demand?
- What would have broken this hook? What would have felt like a bait-and-switch?

Write one sentence summarizing what made this hook work. Be specific — not 'it was engaging' but 'this hook works when the script stays in confession-of-practice mode rather than tutorial mode' or 'this hook demands a concrete numbered payoff delivered fast.'

STEP 2 — WRITE IAN'S SCRIPT:
Using that understanding, write Ian's script. Use Ian's content above as your subject matter. Apply the structural insight from Step 1 — not the words, not the topic, but the shape of how the hook gets earned.

PHIXO VOICE (always applies):
- Warm and direct — knowledgeable friend, not a brand
- Sentences move forward, never recap the previous one
- Point lands without being announced
- Ends at the last real thing — no wrap-up, no lesson stated out loud
- Specific over vague. Never: stunning, perfect, gorgeous, transformative
- No emojis

Write only what comes after the hook. 4-8 sentences.

Return your response as JSON in this exact format, nothing else:
{"analysis":"one sentence about what makes this hook work","script":"the script text"}
`;

    const msg = await anthropicCreate({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{role:'user', content: restylePrompt}]
    });
    let restyled = '', analysis = '';
    try {
      const raw = msg.content[0].text.trim();
      const clean = raw.replace(/^```json\s*/,'').replace(/```\s*$/,'');
      const parsed = JSON.parse(clean);
      restyled = parsed.script || '';
      analysis = parsed.analysis || '';
    } catch(e) {
      // fallback: treat whole response as script
      restyled = msg.content[0].text.trim();
    }
    send('done', 'Done', { restyled, analysis, transcriptPreview: transcript.slice(0, 250) });
    res.end();

  } catch(err) {
    send('error', err.message);
    res.end();
  } finally {
    try { [videoPath, audioPath].forEach(p => { try { require('fs').unlinkSync(p); } catch(e){} }); } catch(e) {}
    try { require('fs').rmdirSync(tmpDir, {recursive:true}); } catch(e) {}
  }
});

// ── Block AI Summarize ────────────────────────────────────────────────────────

app.post('/api/knowledge/ask', requireAuth, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });

    // Step 1: Search blocks by keyword relevance
    const words = question.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(' ').filter(w => w.length > 2);
    const likeTerms = words.map(w => `%${w}%`);

    // Get all blocks that have content, scored by keyword hits
    const allBlocks = await pool.query(`
      SELECT id, type, title, category, tags, content_payload, metadata, source_url
      FROM blocks
      WHERE content_payload IS NOT NULL AND content_payload != ''
         OR metadata IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 100
    `);

    // Score each block
    const scored = allBlocks.rows.map(b => {
      const haystack = [
        b.title || '',
        b.content_payload || '',
        JSON.stringify(b.metadata || {}),
        (b.tags || []).join(' '),
        b.category || ''
      ].join(' ').toLowerCase();
      const score = words.reduce((s, w) => s + (haystack.split(w).length - 1), 0);
      return { ...b, score };
    }).filter(b => b.score > 0).sort((a,b) => b.score - a.score).slice(0, 6);

    if (scored.length === 0) {
      return res.json({ answer: "I couldn't find relevant content in your research library for that question. Try adding more blocks first.", sources: [] });
    }

    // Build context
    const context = scored.map((b, i) => {
      const meta = b.metadata || {};
      const keyPoints = (meta.key_points || []).join('\n- ');
      const payload = (b.content_payload || '').substring(0, 1200);
      return [
        `[Source ${i+1}: ${b.title} (${b.type})]`,
        meta.one_liner ? `Summary: ${meta.one_liner}` : '',
        keyPoints ? `Key points:\n- ${keyPoints}` : '',
        payload ? `Content: ${payload}` : ''
      ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    const resp = await anthropicCreate({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `You are an AI assistant for Ian Green, a portrait photographer. Answer his question using ONLY the research material provided below. If the answer isn't in the material, say so clearly. Cite sources by their [Source N] labels.

RESEARCH MATERIAL:
${context}

QUESTION: ${question}

Answer specifically and practically. Reference the actual content from the sources. If multiple sources are relevant, synthesize them.`
      }]
    });

    const sources = scored.map(b => ({ id: b.id, title: b.title, type: b.type }));
    res.json({ answer: resp.content[0].text, sources });
  } catch(err) {
    console.error('Knowledge ask error:', err.message);
    res.status(500).json({ error: err.message });
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
    const response = await anthropicCreate({
      model: 'claude-sonnet-4-6', max_tokens: 500,
      system, messages
    });
    res.json({ reply: response.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
// ── Tool Setup ──────────────────────────────────────────────────────────────
const _toolSetup = (async () => {
  const fs2 = require('fs');
  const path2 = require('path');
  const https2 = require('https');
  const { promisify } = require('util');
  const { exec } = require('child_process');
  const execAsync = promisify(exec);

  // ffmpeg via ffmpeg-static npm package
  let FFMPEG_PATH = null;
  try {
    FFMPEG_PATH = require('ffmpeg-static');
    await execAsync(`"${FFMPEG_PATH}" -version 2>/dev/null`);
    console.log('ffmpeg: available via ffmpeg-static at', FFMPEG_PATH);
  } catch(e) {
    console.warn('ffmpeg-static not available:', e.message);
    FFMPEG_PATH = null;
  }
  global.FFMPEG_PATH = FFMPEG_PATH;

  // yt-dlp: download binary on first boot if not present
  const binDir = path2.join(process.cwd(), 'bin');
  const ytdlpPath = path2.join(binDir, 'yt-dlp');
  if (!fs2.existsSync(binDir)) fs2.mkdirSync(binDir, { recursive: true });

  const checkYtdlp = async (p) => {
    try { const r = await execAsync(`"${p}" --version 2>/dev/null`); return r.stdout.trim(); }
    catch(e) { return null; }
  };

  // Check if already downloaded
  let ytdlpVer = await checkYtdlp(ytdlpPath);
  if (ytdlpVer) {
    console.log('yt-dlp: ready at', ytdlpPath, '(' + ytdlpVer + ')');
    global.YTDLP_PATH = ytdlpPath;
    return;
  }

  // Download from GitHub releases
  console.log('yt-dlp: downloading binary...');
  const downloadBinary = (url, dest) => new Promise((resolve, reject) => {
    const follow = (u) => {
      https2.get(u, { headers: { 'User-Agent': 'phixo-admin' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return follow(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const f = fs2.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(resolve));
        f.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });

  try {
    await downloadBinary(
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
      ytdlpPath
    );
    fs2.chmodSync(ytdlpPath, '755');
    ytdlpVer = await checkYtdlp(ytdlpPath);
    if (ytdlpVer) {
      console.log('yt-dlp: downloaded and ready (' + ytdlpVer + ')');
      global.YTDLP_PATH = ytdlpPath;
    } else {
      console.warn('yt-dlp: downloaded but failed to execute');
    }
  } catch(e) {
    console.warn('yt-dlp: download failed:', e.message);
  }
})();

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Phixo Admin v3 — port ${PORT}`);
  if (process.env.DATABASE_URL) {
    await initDb();
    // Ingest-complete trigger for initial suggested questions generation.
    setInterval(() => {
      processCompletedIngestsForQuestionGeneration();
    }, 15000);
    processCompletedIngestsForQuestionGeneration();
    loadViralHooks(); // Load proven viral hooks from CSV
    // Auto-repair thumbnail URLs on every startup
    try {
      // Fix image/pose blocks
      await pool.query(`
        UPDATE blocks SET thumbnail_url = '/api/drive/file/' || drive_file_id
        WHERE drive_file_id IS NOT NULL AND drive_file_id != ''
          AND type IN ('pose','image') AND file_mime LIKE 'image/%'
          AND (thumbnail_url IS NULL OR thumbnail_url = '' OR thumbnail_url LIKE 'https://%')
      `);
      // Fix all other drive blocks (video, pdf, note, meme) with expired/missing thumbnails
      await pool.query(`
        UPDATE blocks SET thumbnail_url = '/api/drive/thumbnail/' || drive_file_id
        WHERE drive_file_id IS NOT NULL AND drive_file_id != ''
          AND type NOT IN ('pose','image')
          AND (thumbnail_url IS NULL OR thumbnail_url = '' OR thumbnail_url LIKE 'https://lh3%' OR thumbnail_url LIKE 'https://drive%')
      `);
      console.log('Thumbnail URLs auto-repaired');
    } catch(e) { console.warn('Auto-repair skipped:', e.message); }
  }
  else console.log('WARNING: No DATABASE_URL');
});
