#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
//  Redesign Health — Daily Deel Data Sync
//  Fetches people + contracts from Deel API → writes deel-cache.json
//
//  Usage:
//    node sync.js               # run sync
//    node sync.js --force       # always re-fetch even if cache is fresh
//
//  Scheduled automatically via macOS LaunchAgent (see README or
//  com.redesignhealth.deel-sync.plist).
//
//  Requires DEEL_API_TOKEN in .env or environment.
//  Get your API token: Deel → Settings → API → Generate REST Key
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// ── Load .env ──────────────────────────────────────────────────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

const TOKEN     = process.env.DEEL_API_TOKEN;
const BASE      = 'https://api.letsdeel.com/rest/v2';
const CACHE     = path.join(__dirname, 'deel-cache.json');
const MAX_AGE   = 20 * 60 * 60 * 1000; // 20 hours — re-sync if cache older than this
const FORCE     = process.argv.includes('--force');

if (!TOKEN) {
  console.error('❌  DEEL_API_TOKEN not set.');
  console.error('    1. Go to Deel → Settings → API → Generate REST API Key');
  console.error('    2. Add  DEEL_API_TOKEN=your_token_here  to .env');
  process.exit(1);
}

// ── Skip if cache is still fresh ──────────────────────────────
if (!FORCE && fs.existsSync(CACHE)) {
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    const age = Date.now() - new Date(cached.synced_at).getTime();
    if (age < MAX_AGE) {
      const hours = Math.round(age / 36e5 * 10) / 10;
      console.log(`✅  Cache is still fresh (${hours}h old) — skipping sync. Use --force to override.`);
      process.exit(0);
    }
  } catch (_) { /* corrupt cache — re-fetch */ }
}

// ── Fetch with pagination ──────────────────────────────────────
async function fetchPaginated(endpoint) {
  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${BASE}${endpoint}?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/json' }
    });

    if (!res.ok) {
      const text = await res.text();
      const isAuth = res.status === 401 || res.status === 403;
      if (isAuth) {
        console.error(`❌  Auth failed (${res.status}). Your DEEL_API_TOKEN may be expired or invalid.`);
        console.error('    Generate a new one: Deel → Settings → API → REST Key');
      } else {
        console.error(`❌  Deel API ${endpoint} failed: ${res.status} — ${text.slice(0, 200)}`);
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const rows = json.data || [];
    results.push(...rows);

    const total = json.page?.total ?? json.total ?? rows.length;
    offset += rows.length;
    if (rows.length < limit || offset >= total) break;

    process.stdout.write(`  ${endpoint}: fetched ${offset}/${total}\r`);
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  console.log(`\n🔄  Redesign Health — Deel sync started at ${new Date().toLocaleTimeString()}`);
  console.log('─'.repeat(55));

  const [rawPeople, rawContracts] = await Promise.all([
    fetchPaginated('/people').then(r => { console.log(`  ✓ people: ${r.length} records`); return r; }),
    fetchPaginated('/contracts').then(r => { console.log(`  ✓ contracts: ${r.length} records`); return r; }),
  ]);

  // Normalize people — keep peo/eor/contractor only
  const people = rawPeople
    .filter(p => ['peo', 'eor', 'contractor'].includes(p.hiring_type))
    .map(p => ({
      id:             (p.id || '').replace(/-/g, '').slice(0, 8),
      full_name:      p.full_name || p.name || '',
      hiring_status:  p.hiring_status || 'unknown',
      hiring_type:    p.hiring_type || 'unknown',
      start_date:     p.start_date || null,
      country:        p.country || null,
      work_email:     p.work_email || null,
    }));

  // Normalize contracts — exclude hris_direct_employee
  const contracts = rawContracts
    .filter(c => c.type !== 'hris_direct_employee')
    .map(c => {
      const workerId = c.worker?.id || c.worker_id || c.worker_pid || null;
      const workerPid = workerId
        ? workerId.toString().replace(/-/g, '').slice(0, 8)
        : null;
      return {
        id:          c.id || '',
        title:       c.title || c.name || '',
        type:        c.type || '',
        status:      c.status || '',
        worker_name: c.worker?.name || c.worker_name || null,
        worker_pid:  workerPid,
      };
    });

  const data = {
    people,
    contracts,
    synced_at: new Date().toISOString(),
  };

  fs.writeFileSync(CACHE, JSON.stringify(data, null, 2));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log('─'.repeat(55));
  console.log(`  People written:    ${people.length}`);
  console.log(`  Contracts written: ${contracts.length}`);
  console.log(`  Cache file:        ${CACHE}`);
  console.log(`  Elapsed:           ${elapsed}s`);
  console.log(`\n✅  Sync complete — ${new Date().toLocaleString()}\n`);
}

main().catch(err => {
  console.error('\n❌  Sync failed:', err.message);
  process.exit(1);
});
