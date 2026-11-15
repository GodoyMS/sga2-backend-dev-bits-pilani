# Fleet Management System — Backend

Backend for a fleet management website: fleet admins track vehicle locations, find vehicles near a
point, get **SMS alerts** for critical vehicle events and status changes, and developers get
**Swagger/OpenAPI** documentation. Everything is reached through an **Express API Gateway** that
checks API keys, rate-limits per key and forwards requests to five backend services.

- **Stack:** Node.js 22 · TypeScript · Express · PostgreSQL · JWT (role-based) · Zod validation
- **Third-party integrations:** Google Maps Geocoding API / OpenStreetMap Nominatim · Twilio SMS · Leaflet + OpenStreetMap tiles
- **Tests:** Mocha + Chai + Supertest + Sinon — 63 tests across all 7 required flows

| | URL |
|---|---|
| Live gateway | https://fleet-api-production-1def0230.up.railway.app |
| Swagger UI | [`/docs`](https://fleet-api-production-1def0230.up.railway.app/docs) |
| OpenAPI JSON | [`/openapi.json`](https://fleet-api-production-1def0230.up.railway.app/openapi.json) |
| Map console (geolocation + nearby + SMS demo) | [`/map`](https://fleet-api-production-1def0230.up.railway.app/map) |
| Service health | [`/health/services`](https://fleet-api-production-1def0230.up.railway.app/health/services) |

API key for the live demo: `demo-fleet-key` (demo users are listed under “Demo credentials”).

---

## Architecture

```
                        ┌────────────────────────── API Gateway (Express, public :PORT) ──────────────────────────┐
  client ── x-api-key ─▶│ request-id → API key check → rate limit (per key) → JSON validation → reverse proxy       │
  + Bearer JWT          │ 401/403 bad key · 429 too many · 400 bad JSON · 404 unknown route · 503/504 service down │
                        └───────┬───────────────┬────────────────┬─────────────────┬────────────────┬─────────────┘
                     /api/users/*      /api/vehicles/*   /api/telemetry/*     /api/maps/*    /api/notifications/*
                                ▼               ▼                ▼                 ▼                ▼
                        ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────────────┐
                        │ User svc   │  │ Vehicle svc  │  │ Telemetry svc│  │ Geo svc     │  │ Notification svc │
                        │ login, JWT │  │ CRUD, status │  │ GPS/sensors  │  │ geocode,    │  │ SMS + delivery   │
                        │ roles      │  │ history      │  │ critical evts│  │ nearby (km) │  │ log (sent/failed)│
                        └────────────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘  └────────┬─────────┘
                                               │ geocode address  │ alert            │                  │
                                               ├─────────────────────────────────────▶ Google Maps / OSM │
                                               └── status change ─┴─────────────────────────────────────▶ Twilio
                                                        (service-to-service calls use an internal service token)
                                                 PostgreSQL: users · vehicles · vehicle_status_history · telemetry · notifications
```

Each service is its own Express app (`src/services/*/app.ts`). In production they run in one
container on internal loopback ports (4001–4005) behind the gateway, so only the gateway is
reachable from the internet. Any service can also run by itself with `SERVICE=<name>` and the
`*_SERVICE_URL` variables, if you prefer one deployment per service.

### Roles (JWT `role` claim)

| Role | Permissions |
|---|---|
| `admin` | Everything: delete vehicles, manage users, send SMS, read the notification log |
| `operator` | Register/update vehicles, change status, submit telemetry, read notifications |
| `viewer` | Read-only: vehicles, telemetry, maps |

### Critical events → SMS

| Trigger | Event |
|---|---|
| Telemetry `eventType: ENGINE_FAULT` | `ENGINE_FAULT` |
| Telemetry `eventType: EMERGENCY_STOP` | `EMERGENCY_STOP` |
| `eventType: LOW_BATTERY` or `batteryLevel` < 20 | `LOW_BATTERY` |
| `engineTempC` ≥ 115 | `ENGINE_OVERHEAT` |
| `PATCH /api/vehicles/:id/status` with a new status | `STATUS_CHANGED` |

Alerts go to every admin with a phone number, the user assigned to the vehicle, and any numbers
in `ALERT_PHONE_NUMBERS`. Every message is saved in `notifications` with status `sent` or `failed`,
the provider message id (Twilio SID) and the error, if any. Failed messages can be retried.

---

## Run it locally

Requirements: Node.js 20+ (22 recommended). PostgreSQL is optional (see option A).

```bash
git clone https://github.com/GodoyMS/sga2-backend-dev-bits-pilani.git
cd sga2-backend-dev-bits-pilani
npm install
cp .env.example .env          # optional: add Google Maps / Twilio credentials
```

**A. No database needed (in-memory Postgres):**
```bash
npm run dev:memory
```

**B. With PostgreSQL (Docker):**
```bash
docker compose up --build
```

**C. With your own PostgreSQL:** set `DATABASE_URL` in `.env`, then `npm run build && npm start`.

Open http://localhost:8080/docs (Swagger) or http://localhost:8080/map (map console).
Tables are created and demo data is seeded automatically on first start.

**Demo credentials**

| | |
|---|---|
| API key | `demo-fleet-key` |
| Admin | `admin@fleet.local` / `Admin@123` |
| Operator | `operator@fleet.local` / `Operator@123` |
| Viewer | `viewer@fleet.local` / `Viewer@123` |

---

## Run the tests

```bash
npm install
npm test
```

The suite boots the gateway and all five services in-process on random ports, backed by an
in-memory PostgreSQL ([pg-mem](https://github.com/oguimbal/pg-mem)). Google Maps / OSM is stubbed
with Sinon and SMS goes to a stub provider, so **no database, network or credentials are required**.

| File | Flow |
|---|---|
| `test/01-auth.test.ts` | 1. Login and JWT verification (valid, wrong password, missing/forged/expired token) |
| `test/02-vehicles.test.ts` | 2. Vehicle registration (coordinates, geocoded address, geocoder failure) and retrieval |
| `test/03-telemetry.test.ts` | 3. Telemetry submission, storage, history, position update, critical-event SMS |
| `test/04-status-notifications.test.ts` | 4. Status change → SMS to admin + assigned operator, `sent`/`failed` log |
| `test/05-rbac.test.ts` | 5. RBAC — viewer/operator cannot delete a vehicle (403), admin can (204) |
| `test/06-nearby.test.ts` | 6. Nearby search within X km with a mocked geocoder |
| `test/07-gateway.test.ts` | 7. API key check, routing to each service, 429 rate limiting, 400/404/503 handling |

---

## Example requests

```bash
BASE=http://localhost:8080
KEY=demo-fleet-key
TOKEN=$(curl -s -X POST $BASE/api/users/login -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"email":"admin@fleet.local","password":"Admin@123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# Register a vehicle from an address (geocoded by Google Maps / OSM)
curl -s -X POST $BASE/api/vehicles -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"plateNumber":"KA01MN4455","make":"Tata","address":"Brigade Road, Bengaluru"}'

# Vehicles within 6 km of MG Road, Bengaluru
curl -s "$BASE/api/maps/nearby?lat=12.9716&lng=77.5946&radiusKm=6" -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN"

# Telemetry with an engine fault → SMS to admins
curl -s -X POST $BASE/api/telemetry -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"vehicleId":"<id>","latitude":12.97,"longitude":77.59,"batteryLevel":9,"eventType":"ENGINE_FAULT"}'

# Status change → SMS
curl -s -X PATCH $BASE/api/vehicles/<id>/status -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"status":"maintenance","reason":"Brake inspection"}'

# Notification log
curl -s "$BASE/api/notifications?limit=10" -H "x-api-key: $KEY" -H "authorization: Bearer $TOKEN"

# Gateway errors
curl -i $BASE/api/vehicles                                  # 401 API_KEY_MISSING
curl -i $BASE/api/vehicles -H "x-api-key: wrong"            # 403 API_KEY_INVALID
curl -i $BASE/api/spaceships -H "x-api-key: $KEY"           # 404 ROUTE_NOT_FOUND
```

---

## Configuration

See [`.env.example`](.env.example). The most important variables:

| Variable | Purpose |
|---|---|
| `API_KEYS` | Comma-separated gateway API keys |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Requests allowed per API key per window (default 100 / 60 s) |
| `JWT_SECRET`, `SERVICE_TOKEN` | Signing secret for user tokens; secret for internal service calls |
| `DATABASE_URL` | PostgreSQL connection string |
| `GOOGLE_MAPS_API_KEY` | Enables the Google Maps Geocoding API (otherwise OpenStreetMap Nominatim) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Enables real SMS via Twilio (otherwise the stub provider) |
| `SEED_ADMIN_PHONE`, `ALERT_PHONE_NUMBERS` | Who receives alerts (Twilio trial: verified numbers only) |

---

## Project structure

```
src/
  index.ts                      # boots services on internal ports + gateway on PORT
  config.ts
  gateway/app.ts                # routing table, API keys, rate limit, proxy, Swagger UI, /map
  services/
    user/app.ts                 # register, login, verify, users (JWT + bcrypt)
    vehicle/app.ts              # vehicles, status + history, geocoding on registration
    telemetry/app.ts            # telemetry ingest, critical-event detection
    geo/{app,geocoder,distance}.ts   # Google/OSM geocoding, Haversine nearby search, GeoJSON
    notification/{app,sms}.ts   # Twilio + stub SMS providers, delivery log, retry
  shared/                       # auth/RBAC, db, migrations, errors, service client
docs/openapi.yaml               # OpenAPI 3 spec served at /docs
public/map.html                 # Leaflet map console
test/                           # Mocha/Chai suites (7 flows)
```

---

## Deployment

Live on Railway: **https://fleet-api-production-1def0230.up.railway.app**

- One Railway service built from the `Dockerfile` (gateway + the five services in one container;
  services listen on loopback ports, only the gateway is public), plus a Railway PostgreSQL database.
- Every push to `main` redeploys automatically.
- Variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `API_KEYS`, `JWT_SECRET`, `SERVICE_TOKEN`,
  `RATE_LIMIT_MAX`, plus `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` /
  `ALERT_PHONE_NUMBERS` for SMS and optionally `GOOGLE_MAPS_API_KEY`.

---

## Screenshots

All in [`docs/screenshots`](docs/screenshots).

| What | Screenshot |
|---|---|
| Fleet console: map, nearby results, SMS log, gateway checks | [00-fleet-console-overview.jpg](docs/screenshots/00-fleet-console-overview.jpg) |
| Vehicle geolocation and nearby vehicles within 6 km | [01-nearby-vehicles-map.jpg](docs/screenshots/01-nearby-vehicles-map.jpg) |
| SMS notifications for a vehicle event and a status change | [02-sms-notifications.jpg](docs/screenshots/02-sms-notifications.jpg) |
| API Gateway: API key verification and routing to each service | [03-gateway-api-key-and-routing.png](docs/screenshots/03-gateway-api-key-and-routing.png) |
| API Gateway: forwarded request headers (`x-served-by`, `x-request-id`, rate limit) | [04-gateway-inspector.png](docs/screenshots/04-gateway-inspector.png) |
| Swagger UI | [05-swagger-ui-overview.jpg](docs/screenshots/05-swagger-ui-overview.jpg), [06-swagger-ui-endpoints.jpg](docs/screenshots/06-swagger-ui-endpoints.jpg) |
| Swagger: RBAC and error responses | [07-swagger-rbac-delete-vehicle.png](docs/screenshots/07-swagger-rbac-delete-vehicle.png) |
| Swagger: nearby search endpoint | [08-swagger-nearby-search.png](docs/screenshots/08-swagger-nearby-search.png) |
