# Deploying Morline

Production is a single Docker host (tested on AWS EC2) running the API container and, optionally, a Caddy edge proxy.

## Host setup

1. Docker Engine with Compose v2.24+ (the edge compose file uses `!override`).
2. An Elastic IP on the instance, and a DNS `A` record `edge.<BASE_DOMAIN>` pointing at it. Also point `api.<BASE_DOMAIN>` and `*.<BASE_DOMAIN>` at the host.
3. Security group inbound rules:

   | Port | Protocol | Purpose |
   |---|---|---|
   | 80, 443 | TCP | HTTP and HTTPS (Caddy edge) |
   | 30000-30999 | TCP | Public TCP proxy (`TCP_PROXY_PORTS`) |
   | 31000-31999 | UDP | Public UDP proxy (`UDP_PROXY_PORTS`) |

   Route the TCP and UDP ranges straight to the instance. Do not put them behind a load balancer or CDN.
4. Create `/etc/morline/morline.env` from [`.env.example`](../.env.example). Set at least `JWT_SECRET`, `BASE_DOMAIN`, and your GitHub App and AI provider keys. For the edge also set `EDGE_SECRET` and `ACME_EMAIL`.
5. Create the data directory: `sudo mkdir -p /opt/morline/data`.

## Start

```bash
export DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f docker-compose.production.yml -f edge/docker-compose.edge.yml up -d --build
```

Leave out the edge file if something else terminates TLS. The edge replaces the API's `80:3001` mapping, so read [`edge/README.md`](../edge/README.md) first.

Check it: `curl https://api.<BASE_DOMAIN>/health`.

## Shipping updates

[`deploy-wizard/`](../deploy-wizard/README.md) packages `HEAD`, uploads it to S3, runs the rebuild over SSM, and waits for the health check. Copy `deploy-wizard/config.example.json` to `config.json` and fill in your profile, bucket and instance id first. `--rollback` restores the previous version.

## Data and backups

Everything stateful lives under the host's `/opt/morline/data`: the SQLite database (`morline.db`), cloned sources, service volumes, and avatars. Back that directory up. Customer containers survive API restarts and are re-adopted on boot.
