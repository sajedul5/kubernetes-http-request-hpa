import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    traffic: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5m',
    },
  },
};

export default function () {
  const res = http.get('http://app.34.55.132.38.nip.io');

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}