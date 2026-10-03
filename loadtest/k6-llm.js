import http from 'k6/http';
import { check, sleep } from 'k6';

// Runs in-cluster via kubernetes/gpu/loadtest-job.yaml.
// Each VU = one user waiting for a completion, so VUs ≈ concurrent requests.
// With threshold 12 per replica: 40 VUs -> ~4 replicas, 80 VUs -> 6 (max).
const BASE_URL = __ENV.BASE_URL || 'http://vllm.llm.svc.cluster.local:8000';
const MODEL = __ENV.MODEL || 'qwen';

export const options = {
  stages: [
    { duration: '2m', target: 10 },  // Warm up
    { duration: '3m', target: 40 },  // Medium load
    { duration: '3m', target: 80 },  // High load
    { duration: '2m', target: 0 },   // Scale down
  ],

  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<30000'],
  },
};

export default function () {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'Explain Kubernetes autoscaling in one sentence.' }],
    max_tokens: 64,
  });

  const res = http.post(`${BASE_URL}/v1/chat/completions`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '120s',
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
