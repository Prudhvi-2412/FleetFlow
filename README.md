# FleetFlow

FleetFlow is a delivery and fleet operations project built with Next.js, Express, PostgreSQL, Redis, and WebSockets. The local application is runnable without an AWS account. AWS infrastructure and managed service integration are the next stage.

## What works locally

- Customers can register, create or cancel deliveries with an idempotency key, view history, follow status changes, and see a driver's latest location on a map.
- Drivers can go online, share browser GPS or simulated coordinates, accept or reject assignments, and progress deliveries through pickup, transit, arrival, and completion.
- Admins can create driver accounts, inspect the fleet and operational metrics, assign or reassign deliveries, mark failed deliveries with a reason, and retry dead assignment jobs.
- A separate worker assigns the nearest eligible driver within 25 km. PostgreSQL row locks and unique indexes prevent one driver from receiving two active deliveries.
- Redis holds recent driver presence and location, broadcasts events across API instances, and coalesces location updates to at most one broadcast per driver per second.
- PostgreSQL stores durable delivery state, assignment history, jobs, notifications, idempotency results, and an event outbox. The worker retries jobs and retains failed jobs for admin review.

## Local architecture

```text
Browser (Next.js :3000)
  ├── /api/* → Express :3001 → PostgreSQL :5433
  │                       └── Redis :6380
  └── WebSocket /ws → Express :3001 → Redis Pub/Sub → connected customers

PostgreSQL jobs + outbox → separate worker → assignment + notifications
```

The local PostgreSQL job table is the durable queue. The outbox is the local domain event mechanism. **SQS and EventBridge are not yet running**; they will be connected during the AWS stage. The WebSocket server is hosted by Express locally. The AWS stage will decide whether to retain that path behind a load balancer or move connection management to API Gateway WebSocket API.

## Requirements

- Node.js 22.12+ and npm
- Docker Desktop for PostgreSQL and Redis
- A browser with WebSocket support; browser GPS requires localhost or HTTPS

## Run locally

1. `npm install`
2. Copy `apps/api/.env.example` to `apps/api/.env` and replace `JWT_SECRET` with a random secret of at least 32 characters.
3. Add `ADMIN_EMAIL` and `ADMIN_PASSWORD` (at least 12 characters) to `apps/api/.env`.
4. `docker compose up -d postgres redis`
5. `npm run db:migrate -w @fleetflow/api`
6. `npm run seed:admin -w @fleetflow/api` (once per fresh database)
7. In separate terminals, run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web`.
8. Open `http://localhost:3000`.

PostgreSQL uses host port **5433** and Redis uses **6380** to avoid conflicts with other local projects. Docker volumes preserve PostgreSQL data between restarts. Do not commit `.env`.

To try the workflow: sign in as the admin, create a driver, sign in as the driver in another browser, go online and send a location near the pickup, then register a customer and create a delivery. The driver can accept and progress the delivery. Customer and admin views update through WebSockets, with periodic refresh as a fallback.

The map uses the OpenFreeMap Liberty style by default. Set `NEXT_PUBLIC_MAP_STYLE_URL` at build time to use another MapLibre-compatible style. Set `NEXT_PUBLIC_WS_URL` for a WebSocket endpoint other than `ws://localhost:3001/ws`. Set `API_INTERNAL_URL` for a backend other than `http://localhost:3001`; Next.js uses it in its `/api` rewrite.

## Key API routes

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /api/auth/register`, `/login` | Public | Customer signup and login |
| `GET /api/auth/me` | Signed in | Verify a JWT and load current role |
| `GET /api/health`, `/api/ready` | Public | Process liveness and PostgreSQL readiness |
| `POST /api/deliveries` | Customer | Create delivery; requires `Idempotency-Key` header |
| `GET /api/deliveries`, `/:id` | Relevant user | List and inspect deliveries and history |
| `POST /api/deliveries/:id/accept`, `/reject`, `/status`, `/complete` | Assigned driver | Change delivery state |
| `POST /api/deliveries/:id/cancel` | Customer or admin | Cancel a delivery before pickup |
| `POST /api/drivers/me/online`, `/offline` | Driver | Manage availability |
| `PUT /api/drivers/me/location` | Driver | HTTP location fallback |
| `GET /api/notifications` | Signed in | In-app notifications |
| `/api/admin/*` | Admin | Drivers, metrics, manual assignment, dead jobs |

WebSocket clients connect to `/ws`, send `{ "type": "auth", "token": "..." }`, then `{ "type": "subscribe", "deliveryId": "..." }`. Drivers send `{ "type": "location.update", "lat": 12.975, "lng": 77.606 }`. The server authorizes each subscription and sends `delivery.snapshot`, `delivery.event`, and `location.update` messages.

## Verify and load test

```powershell
npm run typecheck
npm run build
npm run test:smoke
node load/http.mjs
npm run test:load
```

Run `test:smoke` while PostgreSQL, Redis, the API, and the worker are running and an admin has been seeded. It creates test accounts and deliveries in the local database. The HTTP load script defaults to 500 health requests at 25 concurrent requests; set `REQUESTS`, `CONCURRENCY`, `BASE_URL`, and `PATH_TO_TEST` to change it. These are local measurements and should not be presented as AWS production results.

`test:load` also requires the API and worker. It provisions disposable test users and deliveries, then measures authenticated delivery reads, delivery creates, and GPS fan-out to subscribed WebSocket clients. Its defaults are 500 reads, 50 writes, 100 WebSocket clients, and 10 GPS updates per second for 5 seconds. Set `LOAD_READS`, `LOAD_WRITES`, `LOAD_CONCURRENCY`, `LOAD_WS_CLIENTS`, `LOAD_GPS_PER_SECOND`, or `LOAD_GPS_SECONDS` to change the workload. It leaves test rows in the local database. The API currently rate limits each WebSocket client to 20 messages per second, so a single-driver test above that rate measures dropped inputs rather than sustained GPS processing.

On 2026-09-29, a local run using the development API and worker with Docker-hosted PostgreSQL and Redis recorded zero failures across 500 authenticated reads and 50 delivery creates. The read p95 was 48.2 ms and create p95 was 84.8 ms. All 100 subscribed WebSocket clients received location updates. A separate run reached 1,000 subscribed clients, all of which received updates, with a 37 ms p95 fan-out delay calculated from server timestamps. A bounded 10,000-client run took 17.3 seconds to establish the subscriptions; all clients received one coalesced GPS update, with 445 ms p95 delivery delay. That run sent five GPS inputs over one second and did not test sustained traffic. These are single-machine observations, not capacity guarantees or AWS results. Multi-instance load has not been tested.

GitHub Actions is configured to run type checks, application and container builds, migrations, and the integration smoke test with temporary PostgreSQL and Redis services. The workflow has not yet run on GitHub. Dockerfiles for the web and API applications are included for the later deployment stage.

## Design limits before AWS

- Auth tokens expire after 15 minutes and live only in browser memory. Refreshing the page requires signing in again. Password reset, email verification, and refresh tokens are future account features.
- The auth rate limiter is per API process. A shared rate limit store is needed when running many instances.
- Assignment uses last sampled driver location in PostgreSQL for durable eligibility and Redis for live tracking. It uses a simple 25 km radius and straight-line distance; road routing and ETA are not included.
- Location is hot state. Redis keeps the latest location for 60 seconds; PostgreSQL samples it at most every 10 seconds. Some intermediate GPS points can be lost by design.
- The local worker polls PostgreSQL. AWS SQS and EventBridge integration, managed networking, secrets, observability dashboards, autoscaling, and deployment are still pending.
