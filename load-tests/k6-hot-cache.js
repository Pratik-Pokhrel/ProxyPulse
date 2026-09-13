import http from "k6/http";
import { sleep, check } from "k6";

// Runs 200 constant virtual users for 1 minute against /api/hot, and checks that every response has an X-Cache-Status header. This one is built specifically to test caching behavior, since you need repeated hits on the same route to see MISS turn into HIT.

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  vus: 200,
  duration: "1m",
};

export default function () {
  const res = http.get("http://localhost:8080/api/hot");
  check(res, {
    "status is 200": (r) => r.status === 200,
    "was cache hit or miss recorded": (r) =>
      r.headers["X-Cache-Status"] !== undefined,
  });
  sleep(0.1);
}
