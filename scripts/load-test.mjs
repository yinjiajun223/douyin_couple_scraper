import { performance } from 'node:perf_hooks';

function numberArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

const baseUrl = process.env.LOAD_TEST_BASE_URL ?? 'http://127.0.0.1:18080';
const path = process.env.LOAD_TEST_PATH ?? '/health/ready';
const durationSeconds = numberArgument('--duration', 60);
const concurrency = numberArgument('--concurrency', 4);
if (!Number.isFinite(durationSeconds) || durationSeconds < 1) throw new Error('Invalid duration');
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20)
  throw new Error('Invalid concurrency');

const latencies = [];
let requests = 0;
let failures = 0;
const deadline = performance.now() + durationSeconds * 1_000;
const headers = {};
if (process.env.LOAD_TEST_COOKIE) headers.cookie = process.env.LOAD_TEST_COOKIE;
if (process.env.LOAD_TEST_CSRF) headers['x-csrf-token'] = process.env.LOAD_TEST_CSRF;

async function client() {
  while (performance.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(new URL(path, baseUrl), { headers });
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    } finally {
      requests += 1;
      latencies.push(performance.now() - startedAt);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => client()));
latencies.sort((left, right) => left - right);
const percentile = (value) =>
  latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))] ?? 0;
const summary = {
  baseUrl,
  concurrency,
  durationSeconds,
  errorRate: requests === 0 ? 1 : failures / requests,
  failures,
  latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
  path,
  requests,
  requestsPerSecond: requests / durationSeconds,
};
console.log(JSON.stringify(summary, null, 2));
if (summary.errorRate >= 0.01 || summary.latencyMs.p95 >= 800) process.exitCode = 1;
