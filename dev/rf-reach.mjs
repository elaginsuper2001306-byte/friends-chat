// Measures HTTP reachability from Moscow probes via the public Globalping API.
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('usage: node dev/rf-reach.mjs <url> [url...]');
  process.exit(2);
}

async function measure(target) {
  const url = new URL(target.includes('://') ? target : `https://${target}`);
  const response = await fetch('https://api.globalping.io/v1/measurements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'http',
      target: url.hostname,
      locations: [{ magic: 'Moscow' }],
      limit: 2,
      measurementOptions: { request: { method: 'HEAD', path: url.pathname || '/' } },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`globalping ${response.status}: ${text.slice(0, 200)}`);
  }
  const { id } = await response.json();
  for (let i = 0; i < 60; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await fetch(`https://api.globalping.io/v1/measurements/${id}`);
    const data = await status.json();
    if (data.status !== 'in-progress') return { id, data };
  }
  return { id, data: { status: 'timeout' } };
}

for (const target of targets) {
  try {
    const { data } = await measure(target);
    const probes = data.results ?? [];
    console.log(`\n${target}`);
    for (const probe of probes) {
      const result = probe.result ?? {};
      const tls = result.tls ?? {};
      const bits = [
        probe.probe?.city ?? probe.probe?.country ?? '?',
        probe.probe?.network ?? '',
        result.status ?? data.status,
        result.statusCode ? `HTTP ${result.statusCode}` : '',
        result.timings?.total ? `${Math.round(result.timings.total)}ms` : '',
        tls.authorized === false ? 'TLS not trusted' : '',
        result.rawOutput ? String(result.rawOutput).slice(0, 120) : '',
      ].filter(Boolean);
      console.log('  ' + bits.join(' | '));
    }
  } catch (error) {
    console.log(`\n${target}\n  FAIL ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
}
