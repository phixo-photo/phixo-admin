/**
 * Apollo.io company search + people match; CSV loader for Quebec registry export.
 */

const fs = require('fs');
const path = require('path');

const APOLLO_BASE = 'https://api.apollo.io/v1';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseKeywordTags(input) {
  if (Array.isArray(input)) return input.map((s) => String(s).trim()).filter(Boolean);
  if (typeof input === 'string' && input.trim()) {
    return input.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return (process.env.APOLLO_ORG_KEYWORD_TAGS || 'real estate,courtier immobilier,consultant')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseOrgLocations() {
  const raw = process.env.APOLLO_ORG_LOCATIONS || 'Montreal, Quebec, Canada';
  return raw.split('|').map((s) => s.trim()).filter(Boolean);
}

function isWestIslandOrg(org) {
  const postal = String(org.postal_code || '').replace(/\s/g, '').toUpperCase();
  if (/^H[89]/.test(postal)) return true;
  const city = String(org.city || '').toLowerCase();
  const subs = ['pointe-claire', 'kirkland', 'beaconsfield', 'dollard', 'dorval', 'pierrefonds', 'senneville', 'baie', 'sainte-anne', 'roxboro', 'île-bizard', 'ile-bizard'];
  return subs.some((s) => city.includes(s));
}

function mapApolloOrgToProspect(org, contact) {
  const id = String(org.id || org.organization_id || '').trim();
  const founded = org.founded_year ? `${org.founded_year}-01-01` : null;
  const first = contact?.first_name || '';
  const last = contact?.last_name || '';
  const ownerName = `${first} ${last}`.trim() || null;
  return {
    id: id || `apollo-${String(org.name || 'x').slice(0, 30)}`,
    business_type: org.industry || (Array.isArray(org.keywords) ? org.keywords.join(', ') : '') || org.name || '',
    address: org.street_address || org.raw_address || '',
    city: org.city || '',
    postal_code: String(org.postal_code || '').replace(/\s/g, '').toUpperCase() || null,
    registered_date: founded,
    employee_range: org.num_employees_enum || org.employees || 'A',
    prospect_score: 'HIGH',
    status: 'raw',
    owner: {
      name: ownerName,
      linkedin_url: contact?.linkedin_url || org.linkedin_url || null,
      linkedin_headline: contact?.title || null,
      oaciq_license: null,
      amf_license: null,
      facebook_url: null,
      email: contact?.email || null,
      phone: org.phone || (contact?.phone_numbers && contact.phone_numbers[0]?.raw_number) || null,
      headshot_status: 'unknown',
    },
    outreach: { draft: null, sent_at: null, channel: null, notes: null },
  };
}

async function apolloFetch(apiPath, body, apiKey) {
  const res = await fetch(`${APOLLO_BASE}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Apollo non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Apollo ${res.status}: ${data.error || data.message || text.slice(0, 200)}`);
  }
  return data;
}

async function fetchPeopleForOrg(apiKey, orgId) {
  try {
    const data = await apolloFetch(
      '/people/search',
      {
        organization_ids: [orgId],
        person_titles: ['owner', 'founder', 'president', 'ceo', 'broker', 'agent', 'director', 'managing'],
        per_page: 1,
        page: 1,
      },
      apiKey,
    );
    return (data.people || [])[0] || null;
  } catch (e) {
    console.warn('[Apollo] people/search:', e.message);
    return null;
  }
}

async function fetchFromApollo(opts = {}) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) throw new Error('APOLLO_API_KEY is not set');

  const limit = Math.min(100, Math.max(1, parseInt(opts.limit || process.env.APOLLO_PER_PAGE || '25', 10) || 25));
  const minDate = opts.min_date || opts.since || '2024-01-01';
  const minYear = Math.max(1900, parseInt(String(minDate).slice(0, 4), 10) || 2024);
  const keywords = parseKeywordTags(opts.keywords);
  const fetchPeople = opts.fetchPeople !== false && String(process.env.APOLLO_FETCH_PEOPLE || 'true').toLowerCase() !== 'false';
  const peopleDelay = Math.max(100, parseInt(process.env.APOLLO_PEOPLE_DELAY_MS || '350', 10) || 350);
  const maxPeople = Math.max(0, parseInt(process.env.APOLLO_PEOPLE_SEARCH_MAX || '40', 10) || 40);

  const data = await apolloFetch(
    '/mixed_companies/search',
    {
      q_organization_keyword_tags: keywords,
      organization_locations: parseOrgLocations(),
      organization_num_employees_ranges: (process.env.APOLLO_EMPLOYEE_RANGES || '1,10').split(',').map((s) => s.trim()),
      founded_year_range: { min: minYear },
      per_page: limit,
      page: opts.page || 1,
    },
    apiKey,
  );

  const orgs = data.organizations || data.accounts || [];
  const filtered = orgs.filter((o) => isWestIslandOrg(o));
  const out = [];
  let peopleCount = 0;
  for (const org of filtered) {
    let contact = null;
    if (fetchPeople && org.id && peopleCount < maxPeople) {
      contact = await fetchPeopleForOrg(apiKey, org.id);
      peopleCount += 1;
      await sleep(peopleDelay);
    }
    out.push(mapApolloOrgToProspect(org, contact));
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let i = 0;
  let inQ = false;
  while (i < line.length) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQ = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out;
}

function readProspectsFromCSV(csvPath) {
  const resolved = path.resolve(csvPath);
  if (!fs.existsSync(resolved)) return [];
  const raw = fs.readFileSync(resolved, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const records = [];
  for (let li = 1; li < lines.length; li++) {
    const vals = parseCsvLine(lines[li]);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (vals[i] ?? '').trim();
    });
    const id = row.business_id || row.id;
    if (!id) continue;
    records.push({
      id: String(id).trim(),
      business_type: row.business_type || null,
      business_type_2: row.business_type_2 || null,
      address: row.address || null,
      city: row.city || null,
      postal_code: row.postal_code || null,
      registered_date: row.registered_date ? String(row.registered_date).slice(0, 10) : null,
      employee_range: row.employee_range || null,
      prospect_score: (row.prospect_score || 'LOW').toUpperCase(),
      status: 'raw',
      owner: {
        name: null,
        linkedin_url: null,
        linkedin_headline: null,
        oaciq_license: null,
        amf_license: null,
        facebook_url: null,
        email: null,
        phone: null,
        headshot_status: 'unknown',
      },
      outreach: { draft: null, sent_at: null, channel: null, notes: null },
    });
  }
  return records;
}

function searchCsvLikeMcp(rows, { keywords, minDate, scoreFilter, limit }) {
  const scoreRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const sf = (scoreFilter || 'HIGH').toUpperCase();
  let minRank = scoreRank[sf] ?? 3;
  if (sf === 'ALL') minRank = 1;
  const kw = (keywords || '').toUpperCase();
  const minD = minDate || '2024-01-01';
  let results = rows.filter((row) => {
    const rd = row.registered_date ? String(row.registered_date).slice(0, 10) : '';
    if (rd && rd < minD) return false;
    if ((scoreRank[row.prospect_score] || 0) < minRank) return false;
    if (kw) {
      const hay = `${row.business_type || ''} ${row.business_type_2 || ''}`.toUpperCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  return results.slice(0, limit || 50);
}

async function searchApolloCompaniesForMcp(args) {
  const prospects = await fetchFromApollo({
    keywords: args.keywords,
    limit: args.limit || 50,
    min_date: args.min_date || '2024-01-01',
    fetchPeople: true,
  });
  const scoreRank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const minRank = scoreRank[(args.score_filter || 'HIGH').toUpperCase()] || 3;
  let list = prospects.filter((p) => (scoreRank[p.prospect_score] || 0) >= minRank);
  if (args.keywords) {
    const k = args.keywords.toUpperCase();
    list = list.filter((p) => (p.business_type || '').toUpperCase().includes(k) || (p.city || '').toUpperCase().includes(k));
  }
  return list.slice(0, args.limit || 50).map((p) => ({
    business_id: p.id,
    registered_date: p.registered_date || '',
    business_type: p.business_type,
    business_type_2: '',
    address: p.address,
    city: p.city,
    postal_code: p.postal_code || '',
    employee_range: p.employee_range || '',
    prospect_score: p.prospect_score,
    owner_name: p.owner?.name || '',
    owner_email: p.owner?.email || '',
    owner_linkedin: p.owner?.linkedin_url || '',
  }));
}

module.exports = {
  fetchFromApollo,
  mapApolloOrgToProspect,
  readProspectsFromCSV,
  searchCsvLikeMcp,
  searchApolloCompaniesForMcp,
};
