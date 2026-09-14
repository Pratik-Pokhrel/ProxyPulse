# METRICS.md

All numbers below come from `k6` load test runs against the stack, using `load-tests/k6-basic.js` (a ramp to 500 VUs over 2 minutes) unless otherwise noted. Every metric is the **median of three consecutive runs**, not a single sample, following the project's benchmarking methodology: a median resists a single fluke run (cold start, background CPU contention on the Docker Desktop VM) skewing the reported number.

Latency figures use the `{ expected_response:true }` subset of `http_req_duration`, i.e. successful requests only, not blended with fast-failing rejections. Error rate is `http_req_failed`.

---

## A note on the rate limiter before any of this data is meaningful

Before any baseline could be trusted, the rate limiter itself had to be corrected. The default configuration (`limit_req_zone ... rate=50r/s`) rejected roughly 97% of requests under this test's load profile (500 VUs, ~0.1s sleep between iterations, which generates approximately 5,000 req/s at peak). Latency on both accepted and rejected requests was near-identical and under 10ms, which is the signature of an instant edge-level rejection, not backend or network overload.

The limit was progressively raised (50 → 2,000 → 6,000 → 20,000 r/s) until the error rate settled under 1%. **20,000 r/s is the value used for every baseline and tuning test below**, unless a table explicitly says otherwise. This is a deliberate testing configuration, not a production recommendation, it exists purely so tuning comparisons reflect actual nginx/backend capacity rather than the limiter's ceiling.

---

## Phase 2: Baseline (no tuning applied)

| Metric           | Run 1   | Run 2   | Run 3   | Median      |
| ---------------- | ------- | ------- | ------- | ----------- |
| Requests/sec     | 2206.48 | 2179.70 | 2208.32 | **2206.48** |
| p95 latency (ms) | 3.84    | 8.06    | 3.3     | **3.84**    |
| p99 latency (ms) | 7.11    | 24.24   | 7.31    | **7.31**    |
| Error rate (%)   | 0.46    | 1.42    | 0.53    | **0.53**    |

**Note on Run 2:** all three metrics spiked together in this single run, latency more than doubled and error rate nearly tripled versus Runs 1 and 3. This pattern (simultaneous, correlated spikes across otherwise-independent metrics) points to transient resource contention on the host/VM rather than an application-level issue. It's a useful illustration of why this methodology uses a median across three runs instead of a single run.

This baseline is the reference point every table below is compared against.

---

## Phase 3: Load balancing and connection reuse tuning

Each variant below isolates exactly one change from the baseline config (`least_conn` + `keepalive 64`). All other settings, including the rate limit, are held constant across variants.

### 3a. `keepalive` removed

| Metric           | Run 1   | Run 2   | Run 3   | Median      |
| ---------------- | ------- | ------- | ------- | ----------- |
| Requests/sec     | 2207.13 | 2199.98 | 2184.57 | **2199.98** |
| p95 latency (ms) | 3.26    | 4.24    | 5.85    | **4.24**    |
| p99 latency (ms) | 7.12    | 10.53   | 17.68   | **10.53**   |
| Error rate (%)   | 0.26    | 0.57    | 1.01    | **0.57**    |

### 3b. `keepalive 64` restored (default)

| Metric           | Run 1   | Run 2   | Run 3   | Median      |
| ---------------- | ------- | ------- | ------- | ----------- |
| Requests/sec     | 2208.69 | 2208.39 | 2193.49 | **2208.39** |
| p95 latency (ms) | 3.14    | 3.26    | 5.86    | **3.26**    |
| p99 latency (ms) | 6.77    | 6.76    | 13.28   | **6.76**    |
| Error rate (%)   | 0.44    | 0.49    | 1.21    | **0.49**    |

**Finding:** removing keepalive cost roughly 23% at p95 and 36% at p99, while throughput barely moved. Reusing TCP connections to the backend pool avoids a fresh handshake per proxied request; that cost shows up disproportionately in the tail, since not every request pays the reconnection penalty, but enough do to drag p99 noticeably. Note that 3b was re-measured immediately after 3a specifically to control for session-to-session environmental drift (see the Run 2 anomaly in Phase 2), rather than reusing the Phase 2 baseline numbers directly for this comparison.

### 3c. Round robin (default load balancing)

| Metric           | Run 1   | Run 2   | Run 3   | Median      |
| ---------------- | ------- | ------- | ------- | ----------- |
| Requests/sec     | 2164.16 | 2153.53 | 2183.53 | **2164.16** |
| p95 latency (ms) | 12.44   | 13.54   | 7.91    | **12.44**   |
| p99 latency (ms) | 29.05   | 29.69   | 17.87   | **29.05**   |
| Error rate (%)   | 1.80    | 2.45    | 1.29    | **1.80**    |

**Finding:** compared to 3b (`least_conn`), round robin showed roughly 280% worse p95 and 330% worse p99, despite all three backends being identical in capacity. `least_conn` actively routes new requests away from whichever backend currently has the most outstanding connections; round robin has no such awareness and keeps cycling evenly even when one backend is momentarily lagging (GC pause, scheduling jitter from the Docker Desktop VM), letting that backlog compound at the tail.

### 3d. `ip_hash`

| Metric           | Run 1   | Run 2   | Run 3   | Median      |
| ---------------- | ------- | ------- | ------- | ----------- |
| Requests/sec     | 2174.69 | 2043.69 | 2117.00 | **2117.00** |
| p95 latency (ms) | 10.76   | 29.5    | 21.16   | **21.16**   |
| p99 latency (ms) | 22.5    | 141.45  | 87.18   | **87.18**   |
| Error rate (%)   | 0.26    | 0.27    | 0.32    | **0.27**    |

**One pitfall was detected here:** this result looks dramatically worse than every other variant, and it is, but not because `ip_hash` is a poor algorithm. `ip_hash` routes by client source IP, and since every request in this test originates from a single k6 host, all traffic was pinned to a single backend rather than distributed across the pool. This was confirmed directly:

```
docker stats backend1 backend2 backend3
```

```
backend1   107.54%   CPU
backend2     0.01%   CPU
backend3     0.01%   CPU
```

This result specifically demonstrates a limitation of testing `ip_hash` with a single-origin load generator, not a flaw in the algorithm itself.

---

## Phase 4: Caching and rate limiting

The original Config was restored to baseline (`least_conn` + `keepalive 64`) before this phase. The load was generated with `load-tests/k6-hot-cache.js` against `/api/hot`, a route that deliberately performs an expensive CPU-bound computation per request.

### 4a. Cache enabled (default config)

| Metric                     | Run 1   | Run 2   | Run 3   | Median      |
| -------------------------- | ------- | ------- | ------- | ----------- |
| Requests/sec               | 1957.31 | 1954.02 | 1955.12 | **1955.12** |
| p95 latency (ms)           | 3.31    | 3.79    | 3.50    | **3.50**    |
| p99 latency (ms)           | 7.41    | 6.66    | 6.90    | **6.90**    |
| Backend CPU (rough avg, %) | 0.5-1   | 0.5-1   | 0.5-1   | **0.5-1**   |

### 4b. Cache disabled (`proxy_cache` lines commented out)

| Metric                     | Run 1   | Run 2   | Run 3   | Median      |
| -------------------------- | ------- | ------- | ------- | ----------- |
| Requests/sec               | 1042.14 | 1090.85 | 1044.41 | **1044.41** |
| p95 latency (ms)           | 159.21  | 139.95  | 160.49  | **159.21**  |
| p99 latency (ms)           | 248.28  | 171.17  | 238.32  | **238.32**  |
| Backend CPU (rough avg, %) | 97-99   | 97-99   | 97-99   | **97-99**   |

**Finding:** caching reduced p99 latency by roughly 97% (238.32ms → 6.90ms) and cut backend CPU usage from full saturation to near idle, by serving repeated requests from nginx's memory cache instead of re-running the expensive computation every time. Throughput nearly doubled as a direct consequence of the backends no longer being the bottleneck.

### 4c. Rate limiting demonstration

The rate limit was intentionally lowered from the 20,000 r/s testing value back to the original default (`rate=50r/s`) specifically to demonstrate the limiter under load, since 20,000 r/s is far above what this test's peak throughput would ever trigger. At 500 VUs, this reproduced the same ~97% rejection behavior seen during initial baseline diagnosis (see the rate limiter note at the top of this document), confirming `limit_req_zone` correctly enforces its configured ceiling. Exact per-run figures for this demonstration were not logged numerically, as the purpose was behavioral confirmation (503s appearing as expected) rather than a performance measurement to compare against other variants. The rate limit was restored to 20,000 r/s immediately afterward.

---

## Phase 5: Chaos testing, passive vs. active health checks

For both runs, a load test was started, allowed to reach steady state (past the initial VU ramp), then `backend2` was stopped and, after roughly 15-20 seconds, restarted. The `503` error rate was tracked live via Prometheus/Grafana using:

```
rate(k6_http_reqs_total{status="503"}[10s])
```

### 5a. Passive detection only (`init_worker_by_lua_block` disabled)

| Event                                   | Time (approx.)     |
| --------------------------------------- | ------------------ |
| `docker stop backend2`                  | ~12:20:05          |
| `docker start backend2`                 | ~12:20:27          |
| Error rate began rising                 | ~12:19:30          |
| Error rate peaked (~100 failed req/10s) | ~12:20:30          |
| Error rate returned to near-zero        | ~12:21:00          |
| **Approx. recovery time after restart** | **~30-60 seconds** |

Passive detection relies entirely on real client requests failing against the dead backend (`max_fails=3`, `fail_timeout=10s`) before nginx routes around it, so recovery is gated by real traffic volume and timing rather than a fixed, fast interval.

### 5b. Active health checks enabled (default config)

| Event                                   | Time (approx.)  |
| --------------------------------------- | --------------- |
| `docker stop backend2`                  | ~12:33:55       |
| `docker start backend2`                 | ~12:34:15       |
| Error rate rose sharply                 | ~12:34:00       |
| Error rate returned to near-zero        | ~12:34:15       |
| **Approx. recovery time after restart** | **~15 seconds** |

Active health checks (2-second probe interval, `fall=3`, `rise=2`) detect a dead backend independently of real traffic and pull it out of rotation without waiting for client-facing failures to accumulate.

### Comparison

|                       | 5a: Passive                                | 5b: Active                                         |
| --------------------- | ------------------------------------------ | -------------------------------------------------- |
| Error window duration | ~60-90 seconds                             | ~15 seconds                                        |
| Detection mechanism   | Real client requests failing (`max_fails`) | Independent background probing (`interval=2000ms`) |

**Finding:** enabling active health checks reduced the outage-facing error window by a factor of roughly 4-6x. This is the strongest single result in the project and the clearest illustration of why OpenResty's Lua-based health checking was chosen over stock nginx's passive-only detection.

---
