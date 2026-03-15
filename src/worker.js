// Status Page Monitor - Cloudflare Worker
// Checks service health every 3 minutes, stores to R2, serves status API

const SERVICES = [
  {
    id: 'etymology',
    name: 'Etymology Explorer',
    url: 'https://etymology.luischav.es',
    healthPath: '/health',
    timeoutMs: 15000,
  },
  {
    id: 'tfl',
    name: 'TfL Status',
    url: 'https://tfl.luischav.es',
    healthPath: '/',
    timeoutMs: 10000,
  },
];

// Parse CSV data into array of objects
function parseCsv(csvText) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',');
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = [];
    let current = '';
    let inQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return rows;
}

// Get list of month keys needed to cover the date range
function getMonthKeys(startDate, endDate) {
  const months = [];
  const current = new Date(startDate);
  current.setUTCDate(1);

  while (current <= endDate) {
    const year = current.getUTCFullYear();
    const month = String(current.getUTCMonth() + 1).padStart(2, '0');
    months.push(`${year}-${month}`);
    current.setUTCMonth(current.getUTCMonth() + 1);
  }

  return months;
}

// Check health of a single service
async function checkService(service) {
  const url = service.url + (service.healthPath || '/');
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), service.timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'StatusPage/1.0' },
      redirect: 'follow',
    });

    clearTimeout(timeout);
    const responseTimeMs = Date.now() - start;
    const isUp = response.status >= 200 && response.status < 400;

    return {
      serviceId: service.id,
      statusCode: response.status,
      responseTimeMs,
      isUp,
    };
  } catch (e) {
    return {
      serviceId: service.id,
      statusCode: 0,
      responseTimeMs: Date.now() - start,
      isUp: false,
    };
  }
}

// Run health checks on all services
async function checkAllServices() {
  const timestamp = new Date().toISOString();
  const results = await Promise.allSettled(
    SERVICES.map(service => checkService(service))
  );

  const checks = results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return { timestamp, ...result.value };
    }
    return {
      timestamp,
      serviceId: SERVICES[i].id,
      statusCode: 0,
      responseTimeMs: 0,
      isUp: false,
    };
  });

  return { timestamp, checks };
}

// Append check results to monthly CSV
async function appendToCsv(env, checks) {
  const date = new Date(checks[0].timestamp);
  const monthKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const csvKey = `data/${monthKey}.csv`;
  const header = 'timestamp,service_id,status_code,response_time_ms,is_up\n';

  let existingCsv = '';
  try {
    const existing = await env.STATUS_BUCKET.get(csvKey);
    if (existing) {
      existingCsv = await existing.text();
    }
  } catch (e) {
    console.error(`Failed to read existing CSV ${csvKey}:`, e.message);
    // Fall through — we'll start fresh rather than lose the new data
  }

  // Validate existing CSV has the expected header; if corrupted, start fresh
  // but preserve any salvageable rows
  if (existingCsv && !existingCsv.startsWith('timestamp,')) {
    console.error(`CSV ${csvKey} appears corrupted (bad header), starting fresh`);
    existingCsv = '';
  }

  if (!existingCsv) {
    existingCsv = header;
  }

  const newRows = checks
    .map(c => `${c.timestamp},${c.serviceId},${c.statusCode},${c.responseTimeMs},${c.isUp}`)
    .join('\n');

  await env.STATUS_BUCKET.put(csvKey, existingCsv + newRows + '\n', {
    httpMetadata: { contentType: 'text/csv' },
  });
}

// Update latest.json with current status
async function updateLatestJson(env, checks) {
  const serviceMap = Object.fromEntries(SERVICES.map(s => [s.id, s]));

  const services = checks.map(c => ({
    id: c.serviceId,
    name: serviceMap[c.serviceId]?.name || c.serviceId,
    url: serviceMap[c.serviceId]?.url || '',
    statusCode: c.statusCode,
    responseTimeMs: c.responseTimeMs,
    isUp: c.isUp,
  }));

  const latest = {
    updated: checks[0].timestamp,
    services,
  };

  await env.STATUS_BUCKET.put('latest.json', JSON.stringify(latest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// Update daily aggregate
async function updateDailyAggregate(env, checks) {
  const today = new Date().toISOString().split('T')[0];
  const key = `aggregates/${today}.json`;

  let aggregate = { date: today, samples: 0, services: {} };
  try {
    const existing = await env.STATUS_BUCKET.get(key);
    if (existing) {
      const parsed = await existing.json();
      // Validate the parsed aggregate has expected shape
      if (parsed && typeof parsed === 'object' && parsed.date) {
        aggregate = parsed;
        // Ensure services object exists even if file was partially written
        if (!aggregate.services || typeof aggregate.services !== 'object') {
          aggregate.services = {};
        }
        if (typeof aggregate.samples !== 'number') {
          aggregate.samples = 0;
        }
      }
    }
  } catch (e) {
    console.error(`Failed to read/parse aggregate for ${today}, starting fresh:`, e.message);
  }

  for (const check of checks) {
    if (!aggregate.services[check.serviceId]) {
      aggregate.services[check.serviceId] = {
        checks: 0,
        upCount: 0,
        totalResponseMs: 0,
        incidents: [],
      };
    }

    const svc = aggregate.services[check.serviceId];
    svc.checks += 1;
    if (check.isUp) svc.upCount += 1;
    svc.totalResponseMs += check.responseTimeMs;

    // Track downtime incidents (dedupe by status code)
    if (!check.isUp) {
      const existingIncident = svc.incidents.find(
        i => i.statusCode === check.statusCode
      );
      if (!existingIncident) {
        svc.incidents.push({
          statusCode: check.statusCode,
          firstSeen: check.timestamp,
        });
      }
    }
  }
  aggregate.samples += 1;

  await env.STATUS_BUCKET.put(key, JSON.stringify(aggregate), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// Pre-compute uptime.json from daily aggregates
async function updateUptimeJson(env) {
  const days = 90;
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const promises = dates.map(date =>
    env.STATUS_BUCKET.get(`aggregates/${date}.json`)
      .then(r => r ? r.json() : null)
      .catch(() => null)
  );
  const aggregates = (await Promise.all(promises)).filter(Boolean);

  const serviceMap = Object.fromEntries(SERVICES.map(s => [s.id, s]));
  const lines = [];

  for (const service of SERVICES) {
    const daysData = dates.map(date => {
      const agg = aggregates.find(a => a.date === date);
      const svcAgg = agg?.services?.[service.id];

      const uptimePct = svcAgg?.checks > 0
        ? Math.round((svcAgg.upCount / svcAgg.checks) * 10000) / 100
        : null;
      const avgResponseMs = svcAgg?.checks > 0
        ? Math.round(svcAgg.totalResponseMs / svcAgg.checks)
        : null;

      return {
        date,
        uptimePct,
        avgResponseMs,
        incidents: svcAgg?.incidents || [],
      };
    });

    const validDays = daysData.filter(d => d.uptimePct !== null);
    const overallUptime = validDays.length > 0
      ? Math.round((validDays.reduce((sum, d) => sum + d.uptimePct, 0) / validDays.length) * 100) / 100
      : null;

    lines.push({
      id: service.id,
      name: service.name,
      url: service.url,
      overallUptime,
      days: daysData.reverse(), // Oldest first
    });
  }

  await env.STATUS_BUCKET.put('uptime.json', JSON.stringify({ days, lines }, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// Pre-compute incidents.json from daily aggregates
async function updateIncidentsJson(env) {
  const days = 90;
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const promises = dates.map(date =>
    env.STATUS_BUCKET.get(`aggregates/${date}.json`)
      .then(r => r ? r.json() : null)
      .catch(() => null)
  );
  const aggregates = (await Promise.all(promises)).filter(Boolean);

  const serviceMap = Object.fromEntries(SERVICES.map(s => [s.id, s]));
  const incidentsByDate = [];

  for (const agg of aggregates) {
    const dateIncidents = [];
    for (const [serviceId, svcData] of Object.entries(agg.services || {})) {
      for (const incident of svcData.incidents || []) {
        dateIncidents.push({
          serviceId,
          serviceName: serviceMap[serviceId]?.name || serviceId,
          statusCode: incident.statusCode,
          firstSeen: incident.firstSeen,
        });
      }
    }
    if (dateIncidents.length > 0) {
      incidentsByDate.push({
        date: agg.date,
        incidents: dateIncidents,
      });
    }
  }

  incidentsByDate.sort((a, b) => b.date.localeCompare(a.date));

  await env.STATUS_BUCKET.put('incidents.json', JSON.stringify({ days, incidents: incidentsByDate }, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

// Update alert state tracking (for future email alerts)
async function updateAlertState(env, checks) {
  let alertState = {};
  try {
    const existing = await env.STATUS_BUCKET.get('alert-state.json');
    if (existing) {
      const parsed = await existing.json();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        alertState = parsed;
      }
    }
  } catch (e) {
    console.error('Failed to read/parse alert-state.json, starting fresh:', e.message);
  }

  let stateChanged = false;

  for (const check of checks) {
    const prev = alertState[check.serviceId] || {
      isUp: true,
      since: check.timestamp,
      consecutiveFailures: 0,
    };

    if (check.isUp) {
      if (!prev.isUp) {
        // Service recovered
        console.log(`[RECOVERED] ${check.serviceId} is back up`);
        stateChanged = true;
      }
      alertState[check.serviceId] = {
        isUp: true,
        since: prev.isUp ? prev.since : check.timestamp,
        consecutiveFailures: 0,
      };
    } else {
      const failures = prev.consecutiveFailures + 1;
      if (failures >= 2 && prev.isUp) {
        // Service is confirmed down (2 consecutive failures)
        console.log(`[DOWN] ${check.serviceId} is unreachable (status: ${check.statusCode})`);
        stateChanged = true;
        alertState[check.serviceId] = {
          isUp: false,
          since: check.timestamp,
          consecutiveFailures: failures,
        };
      } else {
        alertState[check.serviceId] = {
          ...prev,
          consecutiveFailures: failures,
        };
      }
    }
  }

  if (stateChanged || Object.keys(alertState).length !== Object.keys(alertState).length) {
    await env.STATUS_BUCKET.put('alert-state.json', JSON.stringify(alertState, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
  }
}

// Scheduled handler - runs every 3 minutes
export default {
  async scheduled(event, env, ctx) {
    console.log('Status check starting...');

    let checks;
    try {
      const result = await checkAllServices();
      checks = result.checks;
    } catch (e) {
      console.error('Health checks failed entirely:', e.message);
      // Nothing to store — bail out but don't throw (cron stays healthy)
      return;
    }

    // Each storage step is independent — one failure must not block the others
    try {
      await appendToCsv(env, checks);
    } catch (e) {
      console.error('Failed to append CSV:', e.message);
    }

    try {
      await updateLatestJson(env, checks);
    } catch (e) {
      console.error('Failed to update latest.json:', e.message);
    }

    try {
      await updateDailyAggregate(env, checks);
    } catch (e) {
      console.error('Failed to update daily aggregate:', e.message);
    }

    // Background: pre-compute JSON, update alert state, cleanup old aggregates
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 91);
    const oldAggregateKey = `aggregates/${oldDate.toISOString().split('T')[0]}.json`;

    ctx.waitUntil(Promise.all([
      updateUptimeJson(env)
        .then(() => console.log('Updated uptime.json'))
        .catch(e => console.error('Failed to update uptime.json:', e.message)),
      updateIncidentsJson(env)
        .then(() => console.log('Updated incidents.json'))
        .catch(e => console.error('Failed to update incidents.json:', e.message)),
      updateAlertState(env, checks)
        .catch(e => console.error('Failed to update alert state:', e.message)),
      env.STATUS_BUCKET.delete(oldAggregateKey).catch(() => {}),
    ]));

    const upCount = checks.filter(c => c.isUp).length;
    console.log(`Status check complete. ${upCount}/${checks.length} services up.`);
  },

  // HTTP handler - serve status data
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (path === '/robots.txt') {
      return new Response('User-agent: *\nDisallow: /', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Current status
    if (path === '/' || path === '/latest' || path === '/latest.json') {
      try {
        const obj = await env.STATUS_BUCKET.get('latest.json');
        if (!obj) {
          return new Response(JSON.stringify({ error: 'No data yet' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(obj.body, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
          },
        });
      } catch (e) {
        console.error('Error reading latest.json:', e.message);
        return new Response(JSON.stringify({ error: 'Failed to read status data' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Uptime data
    if (path === '/uptime') {
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90'), 1), 365);

      if (days === 90) {
        try {
          const obj = await env.STATUS_BUCKET.get('uptime.json');
          if (obj) {
            return new Response(obj.body, {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
              },
            });
          }
        } catch (e) {
          console.error('Error reading uptime.json:', e.message);
          // Fall through to on-demand computation
        }
      }

      // On-demand computation for custom ranges
      try {
        const now = new Date();
        const startDate = new Date(now);
        startDate.setUTCDate(startDate.getUTCDate() - days + 1);
        startDate.setUTCHours(0, 0, 0, 0);

        const monthKeys = getMonthKeys(startDate, now);
        const allRows = [];

        for (const monthKey of monthKeys) {
          try {
            const obj = await env.STATUS_BUCKET.get(`data/${monthKey}.csv`);
            if (obj) {
              const rows = parseCsv(await obj.text());
              allRows.push(...rows);
            }
          } catch (e) {
            console.error(`Error fetching data/${monthKey}.csv:`, e);
          }
        }

        // Build uptime from raw CSV
        const serviceMap = Object.fromEntries(SERVICES.map(s => [s.id, s]));
        const lines = [];

        for (const service of SERVICES) {
          const serviceRows = allRows.filter(r => r.service_id === service.id);
          const byDate = {};

          for (const row of serviceRows) {
            const dateKey = new Date(row.timestamp).toISOString().split('T')[0];
            if (!byDate[dateKey]) byDate[dateKey] = { up: 0, total: 0 };
            byDate[dateKey].total++;
            if (row.is_up === 'true') byDate[dateKey].up++;
          }

          const daysData = [];
          for (let i = 0; i < days; i++) {
            const d = new Date(startDate);
            d.setUTCDate(d.getUTCDate() + i);
            const dateKey = d.toISOString().split('T')[0];
            const dayData = byDate[dateKey];

            daysData.push({
              date: dateKey,
              uptimePct: dayData ? Math.round((dayData.up / dayData.total) * 10000) / 100 : null,
              avgResponseMs: null,
              incidents: [],
            });
          }

          const validDays = daysData.filter(d => d.uptimePct !== null);
          const overallUptime = validDays.length > 0
            ? Math.round((validDays.reduce((sum, d) => sum + d.uptimePct, 0) / validDays.length) * 100) / 100
            : null;

          lines.push({
            id: service.id,
            name: service.name,
            url: service.url,
            overallUptime,
            days: daysData,
          });
        }

        return new Response(JSON.stringify({ days, lines }, null, 2), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
          },
        });
      } catch (e) {
        console.error('Error computing uptime:', e);
        return new Response(JSON.stringify({ error: 'Failed to compute uptime' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Incidents data
    if (path === '/incidents') {
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '90'), 1), 365);

      try {
        if (days === 90) {
          const obj = await env.STATUS_BUCKET.get('incidents.json');
          if (obj) {
            return new Response(obj.body, {
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
              },
            });
          }
        }
      } catch (e) {
        console.error('Error reading incidents.json:', e.message);
      }

      return new Response(JSON.stringify({ days, incidents: [] }), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        },
      });
    }

    // Historical CSV by month
    if (path.startsWith('/data/')) {
      try {
        const key = path.slice(1);
        const obj = await env.STATUS_BUCKET.get(key);
        if (!obj) {
          return new Response(JSON.stringify({ error: 'Not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        return new Response(obj.body, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv',
            'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
          },
        });
      } catch (e) {
        console.error('Error reading CSV data:', e.message);
        return new Response(JSON.stringify({ error: 'Failed to read data' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // List available months
    if (path === '/data') {
      try {
        const list = await env.STATUS_BUCKET.list({ prefix: 'data/' });
        const months = list.objects.map(o => o.key.replace('data/', '').replace('.csv', ''));
        return new Response(JSON.stringify({ months }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
          },
        });
      } catch (e) {
        console.error('Error listing data:', e.message);
        return new Response(JSON.stringify({ error: 'Failed to list data' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
