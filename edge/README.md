# Edge proxy for custom domains (optional)

Morline checks and routes custom domains on its own. What it cannot do is serve **HTTPS** for a
customer's domain, because there is no certificate for it. This folder adds that with Caddy, which
obtains a certificate the first time a verified domain is visited. It is separate from the main
project: delete `edge/` and nothing else changes.

## How a custom domain goes live

1. The user adds `app.example.com` to a service. Morline shows two DNS records:
   - `TXT  _morline-challenge.app.example.com  =  morline-verify=<token>` (proves ownership)
   - `CNAME app.example.com -> edge.<BASE_DOMAIN>` (or an `A` record for a root domain)
2. Morline re-checks every minute (and when the user presses Verify). When both records exist the
   domain becomes `active` and starts serving traffic.
3. The first HTTPS visit makes Caddy ask Morline `/v1/internal/tls-allow?domain=...`. Morline
   answers yes only for active domains, so nobody can make the server request certificates for
   arbitrary names. Caddy then gets a Let's Encrypt certificate and Morline shows it as valid.

## What you need on AWS

- An **Elastic IP** on the EC2 instance, and a DNS `A` record `edge.<BASE_DOMAIN>` pointing to it.
  (Customers' root domains use that IP too. Set `EDGE_IPS=<that ip>` in `/etc/morline/morline.env`
  if you want it shown to them without a DNS lookup.)
- Docker Compose v2.24 or newer (the compose file uses `!override`).
- Security group: allow inbound **80 and 443** from anywhere.
- In `/etc/morline/morline.env`: `EDGE_SECRET=<long random string>`. Use the same value for the edge.
- `ACME_EMAIL=you@yourdomain.com` when starting the edge.

## Important: this changes how the API is exposed

The current compose file publishes `80:3001`. Caddy needs 80 and 443, so the edge compose file turns
that mapping off and Caddy forwards to `morline-api:3001` over the Docker network. If something else
(an ALB, CloudFront) currently sends traffic to port 80 of the instance, point it at the edge instead,
or leave this folder unused and put certificates on that layer.

Wildcard `*.<BASE_DOMAIN>` service addresses also work through the edge (one certificate per
subdomain, on demand). Let's Encrypt limits new certificates to 50 per week per registered domain, so if you
expect hundreds of new services a week, terminate `*.<BASE_DOMAIN>` with a wildcard certificate
(for example ACM on a load balancer) and use the edge only for customers' domains.

## Not tested

The Caddyfile and compose file were written but not run here. Try them first on a spare instance.
