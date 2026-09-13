import http from 'k6/http';
import { sleep, check } from 'k6';

export const options = {
  // p90 and p95 are shown by default, adding p99 explicitly since that's
  // usually the number that tells the real story
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 500 },
    { duration: '30s', target: 0 },
  ],
};

export default function () {
  const res = http.get('http://localhost:8080/api/');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(0.1);
}
