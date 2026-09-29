const base = process.env.BASE_URL ?? 'http://localhost:3001';
const total = Number(process.env.REQUESTS ?? 500);
const concurrency = Number(process.env.CONCURRENCY ?? 25);
const path = process.env.PATH_TO_TEST ?? '/api/health';
if (!Number.isInteger(total) || total < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error('REQUESTS and CONCURRENCY must be positive integers');
}

let next = 0;
let failures = 0;
const latencies = [];
const started = performance.now();
async function worker() {
  while (next < total) {
    next++;
    const begin = performance.now();
    try {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) failures++;
      await response.arrayBuffer();
    } catch { failures++; }
    latencies.push(performance.now() - begin);
  }
}
await Promise.all(Array.from({ length: Math.min(total, concurrency) }, () => worker()));
latencies.sort((a, b) => a - b);
const percentile = (p) => latencies[Math.ceil(p * latencies.length) - 1]?.toFixed(1);
const seconds = (performance.now() - started) / 1_000;
console.log(JSON.stringify({ total, concurrency, path, failures, requestsPerSecond: +(total / seconds).toFixed(1), p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) }, null, 2));
