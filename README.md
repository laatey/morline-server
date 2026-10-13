# Morline Server

Backend for Morline, a Railway-style platform for deploying apps and databases from a GitHub repo or Docker image. It implements the contract in [`openapi/openapi.yaml`](./openapi/openapi.yaml): 109 paths, 146 operations, 20 tags.

Morline clones your code, builds an OCI image (your Dockerfile, or Railpack when there isn't one), runs it as a container, health-checks it, and routes traffic to it. State lives in SQLite, so the whole platform runs from one box.

## How a deploy works

1. **Clone** the repo using a GitHub App installation token, the user's OAuth token, or `GITHUB_TOKEN`.
2. **Detect** the project type, package manager, runtime version and start command (`project-detector`, `runtime-resolver`). Overrides come from service settings or `morline.json`.
3. **Build** an image with `docker build` when a Dockerfile exists, otherwise with Railpack through BuildKit (`container-supervisor`).
4. **Run** the image as a container on the environment's private Docker network, with the service's variables, volumes and resource limits.
5. **Health-check** the configured path, then mark the deployment active. Logs and status stream over SSE the whole time.
6. **Route** traffic by host (`<service>.<BASE_DOMAIN>` or a verified custom domain) through the built-in reverse proxy.

Customer containers keep running when Morline restarts; on boot Morline adopts the ones still running and starts any that are missing.

## The assistant can build and change apps

Ask in the dashboard's assistant and it routes the request: a plain answer, **build an app**, or **change the code of a service**. Nothing is applied until you approve it.

- **Build an app.** It writes a complete project (Dockerfile, code, README), shows every file, and on approval creates a private GitHub repository, commits the files, creates the service (secrets such as a JWT key are generated and stored as secret variables) and deploys it. Undo removes the service and keeps the repository.
- **Change an app.** For services that deploy from GitHub it reads the repository, proposes edits as a diff against the real files, and on approval commits to the service's branch and redeploys, or opens a pull request instead. If the branch moved after the proposal, the action goes stale rather than overwriting anything. Undo commits a revert.
- **Safety.** File paths are validated (no traversal, no secrets files, size caps); model output is never executed by Morline; apply is limited to owners, admins and members; every apply is claimed atomically so a double click can't run it twice; failed applies resume instead of repeating finished steps.

It needs an AI provider key (see `.env.example`) and the team's GitHub connection. Creating repositories uses the connected user's OAuth token for personal accounts. The implementation is in `src/services/builder/` (generation, diffs, validation), `src/services/github-repo.js` and `src/services/assistant-actions.js`.

## Deleting

Deleting a service removes everything that belongs to it: the container and its images, domains, variables, port allocations, deployments and logs, its source checkout and env file, volume data and database backups. Deleting an environment, project or team does the same for every service inside it, and also releases the environments' private networks. Activity history and billing usage are kept. On startup Morline clears domains and variables that older versions orphaned; folders left by deleted services are only reported, and `MORLINE_SWEEP_ORPHAN_FILES=1` removes them.

## Live updates

`GET /v1/environments/:id/events` is a server-sent event stream (service, deployment, domain, connection and canvas events, plus a `log` ping when new log lines arrive). Browsers can't set headers on `EventSource`, so this endpoint, and the other `.../stream` and `.../events` GETs, also accept `?token=`. The dashboard uses it instead of polling and falls back to polling if it drops.

## Resources

CPU and memory sliders draw on what the host has left. Only services that hold a container count (online, deploying, building); stopped, sleeping, crashed and never-deployed services give their share back. Starting one of them again (restart, wake or a deploy) has to fit in what is free at that moment, otherwise the API answers `409 insufficient_capacity` and a deployment fails early with the same message, before any clone or build. The pool is: its CPUs and RAM, minus a reserve for the OS and Morline, minus every running service's allocation (`GET /v1/infrastructure/capacity`). Services with no limit of their own get a lean default (0.2 vCPU, 256 MB), so a 2 GB / 2 vCPU host fits four or five at once. Raising a limit past what's free is rejected by the API, and changes are applied to the running container without a redeploy. Tune the reserve with `MORLINE_RESERVED_*` or cap the pool with `MORLINE_CAPACITY_*`.

**Docker image services** skip clone and build: Morline pulls the image (public registries), uses the port you gave or the one the image exposes, and runs it with the same variables, volumes, limits and health checks. Image references are validated before they reach the Docker CLI.

## Requirements

- Node.js 22 or newer
- Docker with BuildKit (`docker-buildx-plugin`) and the Railpack CLI for building and running services. Without Docker the API still starts, but deploys fail. The provided `Dockerfile` installs both.

## Run it

```bash
cp .env.example .env     # set JWT_SECRET at minimum
npm ci
npm run dev              # watch mode; use `npm start` for a plain run
```

The server listens on `http://0.0.0.0:3001`, with the API under `/v1` and a health check at `/health`.

```bash
npm test                 # resolver, volumes, UDP, auth, tenancy, hardening, builder and more
```

Configuration is documented in [`.env.example`](./.env.example).

## Code layout

```text
src/
  index.js                 server entry, router assembly, graceful shutdown
  config.js                environment-driven configuration
  db/                      node:sqlite (WAL), schema.sql, seeds, row-to-API mappers
  middleware/              auth (JWT + sessions), errors, request ids, cursor pagination
  routes/                  one router per API domain (auth, teams, projects, environments,
                           services, deployments, domains, assistant, github, ...)
  services/                email, GitHub App and repo access, LLM, assistant actions, notifications, staged changes
    builder/               AI app/change generation, file validation, diffs
  templates/               starter and database template catalog
  engine/
    build-manager.js       clone, detect, build, deploy coordinator
    container-supervisor.js  image builds, container lifecycle, watchdog, restore
    project-detector.js    framework and start-command detection
    runtime-resolver.js    runtime version resolution
    database-manager.js    managed databases, backups, restores
    diagnosis-manager.js   AI analysis of failed deployments
    domain-manager.js      custom domain verification and TLS status
    reverse-proxy.js       host-based HTTP routing to containers
    capacity.js            host capacity accounting for the resource sliders
    container-hardening.js isolation flags and default limits for customer containers
    private-network.js     per-environment Docker networks (<name>.morline.internal)
    public-tcp.js / public-udp.js   public port allocation
    tunnel-manager.js      optional Cloudflare Tunnel
    metrics-collector.js, usage-meter.js, log-manager.js, event-bus.js
test/                      node:test suites
openapi/openapi.yaml       API contract
edge/                      optional Caddy edge proxy for custom-domain HTTPS
deploy-wizard/             optional one-command deploy to AWS (S3 + SSM)
docs/DEPLOYMENT.md         production setup notes
```

## API domains

| Domain | Base path |
|---|---|
| Auth | `/v1/auth` (signup, login, refresh, OAuth, password reset, sessions) |
| Users | `/v1/me` (profile, avatar, preferences, onboarding) |
| Teams | `/v1/teams`, `/v1/invites` |
| Projects | `/v1/projects` |
| Environments | `/v1/environments` (canvas graph, layout, staged changes, SSE events) |
| Services | `/v1/services`, `/v1/volumes` (lifecycle, variables, networking) |
| Connections | `/v1/connections` |
| Deployments | `/v1/deployments` (build, redeploy, rollback, cancel, logs) |
| Domains | `/v1/domains` |
| Notifications | `/v1/notifications` (including an SSE stream) |
| Activity, Search | `/v1/projects/:id/activity`, `/v1/search` |
| Assistant | `/v1/assistant` (threads, streaming replies, action proposals) |
| GitHub | `/v1/integrations/github` |
| Templates | `/v1/templates`, `/v1/regions` |

## Networking

**Private names.** Services reach each other as `<service-name>.morline.internal`. Each environment gets its own Docker network (`morline-env-<id>`, a /26 from `PRIVATE_NET_POOL`, default `10.200.0.0/16`), so the same name in two projects never collides. If two services in one environment share a name, the older keeps the plain name and the newer gets `name-<4 chars of its id>`. Containers also join `morline-runtime` so the reverse proxy can reach them.

**Public TCP** (databases, Redis, anything non-HTTP). A service can be given a public port from `TCP_PROXY_PORTS` (default `30000-30999`), published by Docker and reachable at `edge.<BASE_DOMAIN>:<port>`. It is plain TCP with no TLS, so rely on the service's own authentication.

**Public UDP** (RADIUS, WireGuard, DNS, game servers). Declare the container's UDP ports with `PATCH /v1/services/:id/networking` (`udpPorts: [1812, 1813]`) or from the Network tab. Each gets a public port from `UDP_PROXY_PORTS` (default `31000-31999`), tracked in `service_udp_ports`. The container receives `MORLINE_PUBLIC_UDP_HOST` and `MORLINE_PUBLIC_UDP_PORT_<containerPort>` so it can report its own public endpoint. Changing mappings recreates the running container.

Open both port ranges in your firewall. UDP must reach the host directly, so keep it off any load balancer or CDN.

## Production

See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md). The short version: one Docker host, `docker-compose.production.yml` for the API, optionally `edge/` for HTTPS on custom domains, and `deploy-wizard/` to ship new versions.

## Security

- **Tenant isolation** is enforced in one place, `src/middleware/tenancy.js`: any resource a request references (path, query or body) must belong to a team the caller is in. `test/tenancy.test.js` covers it.
- **Rate limiting**: 30 requests/minute per IP on `/v1/auth`, 1200 on the rest of the API (tune with `RATE_LIMIT_*`).
- **Customer containers** get default memory/CPU limits, a pids limit, `no-new-privileges` and a trimmed capability set (`MORLINE_HARDEN=0` turns this off).
- **GitHub**: push webhooks must carry a valid `X-Hub-Signature-256`, and install/OAuth redirects carry a signed, 15-minute `state`, so a team can't be hijacked by guessing its id.
- Bearer tokens are only accepted in the query string on streaming GET endpoints (`.../stream`, `.../events`).
- The API container mounts `/var/run/docker.sock` so it can build and run workloads, and customer containers share that host. Treat the Docker host as dedicated to Morline, and run builds on a separate machine before taking untrusted code at scale.
- Never commit `.env`, GitHub private keys, or `deploy-wizard/config.json`; all three are git-ignored.
