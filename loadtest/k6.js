import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 20 },   // Warm up
    { duration: '2m', target: 100 },  // Medium load
    { duration: '2m', target: 200 },  // High load
    { duration: '2m', target: 0 },    // Scale down
  ],

  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const res = http.get('http://app.34.55.132.38.nip.io');

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  // Optional: pause briefly between requests
  sleep(0.1);
}