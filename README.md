# Morline API Backend Server

A production-ready, open-source Railway-style application deployment platform backend server built in Node.js.

The backend strictly conforms to [`openapi/openapi.yaml`](./openapi/openapi.yaml), implementing all **92 API endpoints (125 operations across 19 tags)** with real process execution, persistent SQLite database storage (WAL mode), port management, health checking, reverse proxying, and real-time Server-Sent Events (SSE).

---

## 🚀 Key Architectural Features

1. **Strict OpenAPI 3.0 Contract Compliance**
   - Full support for all schemas, cursor pagination, standard error format (`{ code, message, fields, details, requestId }`), and exact enum definitions.
2. **Native Process Supervisor (No Mandatory Docker Required)**
   - Applications run natively on host processes with isolated working directories in `data/apps/<serviceId>/`.
   - Manages process lifecycle (spawn, monitor, healthcheck, graceful stop, SIGTERM/SIGKILL, auto-restart on crash).
   - Injects environment variables (`PORT`, `DATABASE_URL`, custom environment & service variables).
3. **Dynamic Port Manager**
   - Allocates conflict-free host ports in the 4100–4999 range.
   - Verifies OS port availability before assigning to child processes.
4. **Built-in Reverse Proxy**
   - Proxies incoming HTTP traffic on `/proxy/:serviceId/*` or `<subdomain>.localhost` directly to internal service ports.
5. **Real-time SSE Streaming**
   - `/v1/deployments/:deploymentId/logs/stream`: Live build & runtime logs.
   - `/v1/environments/:environmentId/logs/stream`: Multi-service log tailing.
   - `/v1/environments/:environmentId/events`: Live canvas & service status updates.
   - `/v1/notifications/stream`: Real-time notification events.
   - `/v1/assistant/threads/:threadId/messages`: Streaming AI assistant responses.
6. **Robust SQLite Persistence**
   - Uses Node.js native `node:sqlite` (`DatabaseSync`) with Write-Ahead Logging (WAL) and foreign keys enabled.
   - Zero compilation or external dependencies; survives server restarts.

---

## 📁 Directory Structure

```text
morline-server/
├── data/                    # Persistent storage (DB, apps, avatars)
│   ├── apps/                # Isolated application workspaces
│   └── morline.db           # SQLite WAL database
├── openapi/
│   └── openapi.yaml         # Morline OpenAPI 3.0 specification contract
├── src/
│   ├── config.js            # Ports, JWT secret, storage paths
│   ├── index.js             # Main server entry point & router assembly
│   ├── db/
│   │   ├── index.js         # SQLite connection & query helpers
│   │   ├── schema.sql       # DDL table definitions & indexes
│   │   ├── seed.js          # Default catalog seeds (templates & regions)
│   │   └── mappers.js       # Database row ➡️ OpenAPI camelCase mappers
│   ├── engine/
│   │   ├── event-bus.js     # Pub/sub event bus for SSE streams
│   │   ├── port-manager.js  # Dynamic port allocation pool (4100–4999)
│   │   ├── log-manager.js   # Log ring-buffer & SQLite persistence
│   │   ├── process-supervisor.js # Child process spawning & monitoring
│   │   ├── build-manager.js # Workspace build & deploy coordinator
│   │   ├── reverse-proxy.js # HTTP reverse proxy to internal ports
│   │   └── metrics-collector.js # Time-series CPU & memory metrics
│   ├── middleware/
│   │   ├── auth.js          # JWT verification & session tracking
│   │   ├── error-handler.js # Standard OpenAPI error format handler
│   │   ├── request-id.js    # X-Request-Id header & req.id assignment
│   │   └── cursor.js        # Base64 cursor pagination helpers
│   └── routes/              # All 19 OpenAPI domain routers
│       ├── auth.js          # /v1/auth/*
│       ├── users.js         # /v1/me/*
│       ├── teams.js         # /v1/teams/*, /v1/invites/*
│       ├── projects.js      # /v1/projects/*
│       ├── environments.js  # /v1/environments/*
│       ├── connections.js   # /v1/connections/*
│       ├── services.js      # /v1/services/*, /v1/volumes/*
│       ├── deployments.js   # /v1/deployments/*
│       ├── domains.js       # /v1/domains/*
│       ├── notifications.js # /v1/notifications/*
│       ├── activity.js      # /v1/projects/:id/activity
│       ├── search.js        # /v1/search
│       ├── assistant.js     # /v1/assistant/*
│       ├── github.js        # /v1/integrations/github/*
│       └── templates.js     # /v1/templates, /v1/regions
├── test-api.js              # Comprehensive 15-stage E2E test suite
├── test-sse.js              # SSE streaming verification test
└── package.json
```

---

## 🛠️ Getting Started

### 1. Requirements
- Node.js `v20.0.0` or higher (tested on Node.js `v24.19.0`)
- Windows, macOS, or Linux

### 2. Start the Server
```bash
# Start server in production mode
npm start

# Or with automatic reload on changes
npm run dev
```

The server starts on `http://0.0.0.0:3001` with API routes mounted under `http://127.0.0.1:3001/v1`.

### 3. Run Automated Verification Tests
```bash
# Run the 15-stage end-to-end integration test
node test-api.js

# Run the real-time SSE streaming test
node test-sse.js
```

---

## 🔌 API Domains & Endpoints

| Domain | Base Path | Endpoints Summary |
|---|---|---|
| **Auth** | `/v1/auth` | Signup, login, refresh, logout, OAuth start/callback, email/password reset, session management |
| **Users** | `/v1/me` | Current user profile, avatar upload, password change, preferences, onboarding checklist |
| **Teams** | `/v1/teams` | Team CRUD, member roles, invite creation & acceptance, team projects |
| **Projects** | `/v1/projects` | Project CRUD, environment listing & creation, duplication, transfer, favorites, spend metrics |
| **Environments**| `/v1/environments`| Environment CRUD, status, live SSE event stream, canvas graph, canvas layout & viewport |
| **Services** | `/v1/services` | Service CRUD, duplicate, restart, sleep, wake, service variables, volumes, networking |
| **Connections** | `/v1/connections` | Draw and configure service connections with automatic environment variable injection |
| **Deployments** | `/v1/deployments` | List deployments, trigger build, redeploy, rollback, cancel, view & stream logs |
| **Domains** | `/v1/domains` | Custom domains, automated DNS verification, TLS status |
| **Notifications**| `/v1/notifications`| User notifications, mark as read, real-time SSE notification stream |
| **Activity** | `/v1/projects/:id/activity` | Audit log feed with cursor pagination |
| **Search** | `/v1/search` | Global command-palette search across projects, services, deployments, domains, and variables |
| **Assistant** | `/v1/assistant` | AI assistant conversation threads, streaming SSE message generation, action proposal & apply/revert |
| **GitHub** | `/v1/integrations/github` | Team GitHub connection status, repo listing, branch detection, framework auto-detection |
| **Templates** | `/v1/templates`, `/v1/regions` | Catalogues for starters (Next.js, Vite, Python FastAPI, Go, Rust, Express) and databases (Postgres, Redis, MySQL, MongoDB, SQLite) |

## Networking: private names and public TCP

**Private names.** Every service is reachable from the other services of its environment as
`<service-name>.morline.internal`. Each environment gets its own Docker network (`morline-env-<id>`, a /26 taken from
`PRIVATE_NET_POOL`, default `10.200.0.0/16`), so the same name in two projects never mixes them up. If two services in one
environment share a name, the older keeps `name.morline.internal` and the newer gets `name-<4 chars of its id>`.
Containers also stay on the shared `morline-runtime` network so the reverse proxy can reach them.

**Public TCP (databases etc.).** A service can be given a public port from `TCP_PROXY_PORTS` (default `30000-30999`),
published by Docker straight from its container. For this to work on AWS:

- allow inbound TCP `30000-30999` in the instance's security group;
- `PUBLIC_TCP_HOST` (default `edge.<BASE_DOMAIN>`) must resolve to the instance's public IP;
- the connection is plain TCP (no TLS), so rely on the generated password.

**Public UDP (RADIUS, WireGuard, DNS...).** A service can list the UDP ports it listens on (`PATCH /services/:id/networking`
with `udpPorts: [1812, 1813]`, or the Network tab in the dashboard). Each gets a port from `UDP_PROXY_PORTS` (default
`31000-31999`), published by Docker (`--publish 31000:1812/udp`). On AWS:

- allow inbound **UDP** `31000-31999` in the instance's security group (a separate rule from the TCP one);
- `PUBLIC_UDP_HOST` (default: `PUBLIC_TCP_HOST`, then `edge.<BASE_DOMAIN>`) must resolve to the instance's public IP, so use an Elastic IP;
- UDP cannot go through an Application Load Balancer, CloudFront or a Cloudflare tunnel or proxy; use the instance's own address;
- the app gets `MORLINE_PUBLIC_UDP_HOST` and `MORLINE_PUBLIC_UDP_PORT_<container port>` so it can tell its clients the public address;
- changing the list recreates a running container (a few seconds of downtime), and UDP has no encryption or password of its own.

**Restarts.** Customer containers are no longer stopped when Morline stops. After Morline starts it adopts the containers
that are still running and starts any that are missing. Set `STOP_SERVICES_ON_EXIT=1` to get the old behaviour on a dev machine.
