# Deploy

Files for running the gateway on one Linux VM. The VM bootstrap, CI/CD, backups and rollback scripts arrive in M2 ([PLAN.md](../docs/gateway/PLAN.md) §8).

| File | On the VM | What |
|---|---|---|
| `docker-compose.yml` | `/srv/gateway/docker-compose.yml` | gateway + Caddy. Only Caddy is public; admin is on `127.0.0.1:3002` |
| `Caddyfile` | `/srv/gateway/Caddyfile` | TLS, exact path allowlist, app-key check, body limits, streaming, deploy retries |
| `.env.example` | `/srv/gateway/.env` (0600) | Secrets and hostnames |
| `gateway.config.example.json` | `/srv/gateway/gateway.config.json` (0600) | Lanes and per-app policies |

Data lives in `/srv/gateway/data` (bind mount → `/app/server/data`, DB file `freeapi.db`).

The gateway process runs as the image's `node` user (uid 1000), so `gateway.config.json` must be readable by it: `chown 1000:1000 gateway.config.json && chmod 600 gateway.config.json`. `.env` is read by Docker itself and can stay `root:root 0600`.

Not yet validated with real `docker compose` / `caddy validate` runs (no Docker on the dev machine); that happens on the VM in M2.

## Running it

```sh
cd /srv/gateway
docker compose up -d
docker compose logs -f gateway     # first boot prints the one-time dashboard setup code
tailscale serve --bg --https=8443 http://127.0.0.1:3002
```

Then open `https://<vm>.<tailnet>.ts.net:8443` from a device on your tailnet, claim the dashboard with the setup code, add provider keys, create the `gw-*` fallback chains, and create one client-profile key per app (its name must match an entry in `gateway.config.json` → `apps`).

## Trying it locally (needs Docker Desktop)

```sh
docker build -t ghcr.io/smokenova/ai-gateway:local ..
cp .env.example .env                       # fill in keys; GATEWAY_DOMAIN=localhost
cp gateway.config.example.json gateway.config.json
GATEWAY_IMAGE=ghcr.io/smokenova/ai-gateway:local docker compose up
```

With `GATEWAY_DOMAIN=localhost`, Caddy serves `https://localhost` with its own local CA.
