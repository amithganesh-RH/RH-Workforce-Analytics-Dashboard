const BASE = 'https://api.letsdeel.com/rest/v2';

async function fetchPaginated(endpoint, token) {
  const results = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${BASE}${endpoint}?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Deel API ${endpoint} failed: ${res.status} — ${text.slice(0, 300)}`);
    }

    const json = await res.json();
    const rows = json.data || [];
    results.push(...rows);

    const total = json.page?.total ?? json.total ?? rows.length;
    offset += rows.length;
    if (rows.length < limit || offset >= total) break;
  }

  return results;
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = process.env.DEEL_API_TOKEN;
  if (!token) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'DEEL_API_TOKEN environment variable not set' })
    };
  }

  try {
    const [rawPeople, rawContracts] = await Promise.all([
      fetchPaginated('/people', token),
      fetchPaginated('/contracts', token)
    ]);

    // Normalize people — id = first 8 hex chars of UUID (no dashes)
    const people = rawPeople
      .filter(p => p.hiring_type !== 'hris_direct_employee')
      .map(p => ({
        id: (p.id || '').replace(/-/g, '').slice(0, 8),
        full_name: p.full_name || p.name || '',
        hiring_status: p.hiring_status || 'unknown',
        hiring_type: p.hiring_type || 'unknown',
        start_date: p.start_date || null,
        country: p.country || null
      }));

    // Normalize contracts
    const contracts = rawContracts
      .filter(c => c.type !== 'hris_direct_employee')
      .map(c => {
        const workerId = c.worker?.id || c.worker_id || c.worker_pid || null;
        const workerPid = workerId
          ? workerId.toString().replace(/-/g, '').slice(0, 8)
          : null;
        return {
          id: c.id || '',
          title: c.title || c.name || '',
          type: c.type || '',
          status: c.status || '',
          worker_name: c.worker?.name || c.worker_name || null,
          worker_pid: workerPid
        };
      });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ people, contracts, synced_at: new Date().toISOString() })
    };
  } catch (err) {
    console.error('Deel sync error:', err.message);
    const isAuth = err.message.includes('401') || err.message.includes('Not Authorized');
    return {
      statusCode: isAuth ? 401 : 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: err.message,
        hint: isAuth
          ? 'The stored DEEL_API_TOKEN is an MCP integration token and cannot be used for direct REST API calls. Generate a REST API key in Deel → Settings → API and update the Netlify env var.'
          : 'Unexpected error fetching from Deel API.'
      })
    };
  }
};
