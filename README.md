# ProxyPulse: NGINX High-Throughput API Gateway

A local testbed built to demonstrate production-relevant edge infrastructure skills: load balancing, connection reuse, micro-caching, rate limiting, active health checking, and live observability, all measured with real load testing data rather than assumed.

## What this demonstrates

- Load balancing across multiple backend instances, with a measured comparison of `least_conn`, round robin, and `ip_hash`
- Connection reuse (`keepalive`) between the edge and backend pool, with a quantified latency cost when removed
- Active health checking via OpenResty/Lua, benchmarked against passive-only detection during a live backend failure
- Micro-caching on an expensive route, with before/after CPU and latency numbers
- Rate limiting under real burst load, including diagnosing and correcting a rate-limit ceiling that was masking real performance data
- Live observability via Prometheus and Grafana, combining server-side metrics (nginx `stub_status`) with client-side load test metrics (k6 remote write)

## Architecture

```
                 ┌─────────────┐
   clients ───▶ │   OpenResty  │  (edge: LB, cache, rate limit, health checks)
                 │   :8080     │
                 └──────┬──────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
     ┌─────────┐  ┌─────────┐   ┌─────────┐
     │backend1 │  │backend2 │   │backend3 │   (Express, :3000 each)
     └─────────┘  └─────────┘   └─────────┘

     ┌─────────────┐       ┌──────────┐
     │  Prometheus │◀────▶│ Grafana  │
     │   :9090     │       │  :3001   │
     └──────┬──────┘       └──────────┘
            ▲
            │ remote write
        k6 load tests
```

## Tech stack

| Layer                   | Tool                                        |
| ----------------------- | ------------------------------------------- |
| Edge / reverse proxy    | OpenResty (nginx + LuaJIT)                  |
| Backend services        | Node.js + Express                           |
| Container orchestration | Docker Compose                              |
| Load testing            | k6                                          |
| Metrics collection      | Prometheus (scrape + remote-write receiver) |
| Dashboards              | Grafana                                     |
| Secondary benchmarking  | Autocannon (optional)                       |

OpenResty is used instead of stock nginx specifically because active health checking (probing backend health independently of real traffic) requires either NGINX Plus or a Lua-based library. This project uses OpenResty's bundled `lua-resty-upstream-healthcheck`, which needs no custom compilation.

## Prerequisites

- Docker Desktop (Docker Engine + Compose)
- [k6](https://k6.io/docs/get-started/installation/) v0.47 or newer, installed on the host
- Node.js is **not** required on the host, backends run entirely in containers

## Getting started

Clone the repo and start the stack:

```powershell
git clone <repo-url>
cd ProxyPulse
docker compose up --build
```

Confirm the edge and load balancing are working:

**Windows (PowerShell):**

```powershell
Invoke-RestMethod http://localhost:8080/api/
```

**OR, if you have curl installed**

```
curl http://localhost:8080/api/
```

Run it several times in a row, the `instance` field in the response should rotate between `backend1`, `backend2`, and `backend3`.

> **Note:** on WSL2, `localhost` can occasionally resolve to `::1` (IPv6) and fail to connect. If a command hangs unexpectedly, retry against `127.0.0.1` instead.

## Wiring up live metrics

Prometheus is already configured with `--web.enable-remote-write-receiver`, so k6 can push live latency data straight into it during a test run.

Set these once per terminal session before running any load test:

**Windows (PowerShell):**

```powershell
$env:K6_PROMETHEUS_RW_SERVER_URL = "http://localhost:9090/api/v1/write"
$env:K6_PROMETHEUS_RW_TREND_STATS = "p(90),p(95),p(99)"
```

**Mac/Linux:**

```bash
export K6_PROMETHEUS_RW_SERVER_URL=http://localhost:9090/api/v1/write
export K6_PROMETHEUS_RW_TREND_STATS="p(90),p(95),p(99)"
```

The trend stats variable matters: without it, k6's Prometheus output only exports `p(99)` by default, and `p(95)` silently never shows up in Prometheus even though it's visible in the terminal summary.

## Running load tests

**Basic throughput / latency test:**

```bash
k6 run --out experimental-prometheus-rw load-tests/k6-basic.js
```

**Cache hit/miss test (targets the `/api/hot` route):**

```bash
k6 run --out experimental-prometheus-rw load-tests/k6-hot-cache.js
```

Both scripts export `summaryTrendStats` so p90/p95/p99 show up in the terminal summary directly. Every result in `docs/METRICS.md` was produced by running each of these three times and taking the median, not a single run, to resist single-run noise (cold starts, background CPU contention on the Docker Desktop VM, etc).

## Verifying caching

```bash
curl -i http://localhost:8080/api/hot
```

First request should show `X-Cache-Status: MISS`. Requests within the next 30 seconds should show `HIT`.

## Verifying rate limiting

The rate limiter (`limit_req_zone`) is tuned for demonstration and testing purposes; see `/METRICS.md` for the reasoning behind the specific value in use. Firing requests faster than the configured limit will return `503` once the burst allowance is exceeded.

## Verifying active health checks

Open `http://localhost:8080/healthcheck_status` in a browser and leave it open. While a load test is running, stop a backend container:

```bash
docker stop backend2
```

The status page should flip `backend2` to `DOWN` within a couple of seconds, well before nginx's passive detection (`max_fails`/`fail_timeout`) would have noticed on its own. Restore it with:

```bash
docker start backend2
```

## Observability

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (default login `admin` / `admin`)

Grafana's Prometheus data source is auto-provisioned on first boot. Two panels are maintained: live p95/p99 latency (via k6's remote write) and live requests-per-second (via nginx's `stub_status`, scraped through `nginx-prometheus-exporter`).

## Project structure

```
nginx-scaling-project/
├── docker-compose.yml
├── nginx/
│   ├── nginx.conf
│   └── conf.d/
│       └── default.conf
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js
├── monitoring/
│   ├── prometheus.yml
│   └── grafana-provisioning/
├── load-tests/
│   ├── k6-basic.js
│   └── k6-hot-cache.js
└── METRICS.md
```

## Results summary

Full data, methodology, and reasoning for every test live in [`METRICS.md`](./METRICS.md). Headline findings:

- Connection reuse (`keepalive`) reduced p99 latency by roughly 36% with no meaningful throughput cost.
- `least_conn` outperformed round robin and `ip_hash` under this test's conditions, though the `ip_hash` result specifically reflects a single-client-IP test limitation rather than a general flaw in the algorithm (confirmed via per-container CPU inspection).
- Micro-caching cut backend CPU usage from full saturation (97-99%) to near idle (0.5-1%) and reduced p99 latency by roughly 97% on the cached route.
- Active health checks reduced outage recovery time from roughly 60-90 seconds (passive detection) to roughly 15 seconds.

## Shutting down

```bash
docker compose down
```

```bash
docker compose down -v  ## for clearing out the volumes as well
```
