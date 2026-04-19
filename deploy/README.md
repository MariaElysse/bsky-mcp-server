# Deploying the remote OAuth server

Instructions for a Docker-based deployment on a host that already runs
Caddy (as a container) in front of other services — for example, the same
machine the upstream `getting-started-pds` scripts provision. If you're
not using Docker, the systemd unit + Caddyfile snippet in this directory
are left in place as a reference for a bare-metal install.

## 1. Data directory

The node user inside the container is uid 1000. Match that on the host so
the bind-mounted SQLite DB and signing key are writable without nsswitch
tricks.

```sh
sudo install -d -o 1000 -g 1000 -m 0750 /var/lib/bsky-mcp
sudo install -d -o root -g 1000 -m 0750 /etc/bsky-mcp
```

## 2. Clone the repo

```sh
sudo install -d -o root -g root -m 0755 /opt/bsky-mcp-server
sudo git clone https://github.com/lizthegrey/bsky-mcp-server /opt/bsky-mcp-server
cd /opt/bsky-mcp-server
sudo git checkout <deployment-branch>   # e.g. lizf.remote-all-fixes
```

## 3. Environment file

```sh
sudo tee /etc/bsky-mcp/env <<'EOF'
PUBLIC_URL=https://bsky-mcp.lizthegrey.com
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/bsky-mcp
EOF
sudo chown root:1000 /etc/bsky-mcp/env
sudo chmod 0640 /etc/bsky-mcp/env
```

## 4. Generate the signing key

Run in a throwaway container so we use the same node image the service
will run under. The key lands in the bind-mounted data dir with uid 1000
ownership.

```sh
sudo docker run --rm -v /var/lib/bsky-mcp:/var/lib/bsky-mcp --user 1000:1000 \
  node:24-slim node -e "
    const { generateKeyPair, exportJWK } = require('jose');
    const fs = require('fs');
    const { randomUUID } = require('crypto');
    (async () => {
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      const jwk = await exportJWK(privateKey);
      jwk.kid = randomUUID();
      jwk.alg = 'ES256';
      fs.writeFileSync('/var/lib/bsky-mcp/signing-keys.json',
        JSON.stringify({ keys: [jwk] }, null, 2) + '\n', { mode: 0o600 });
      console.log('wrote signing key, kid=' + jwk.kid);
    })();
  " 2>/dev/null || echo "note: jose isn't in node:24-slim; use step 5a instead"
```

If the one-liner above fails (because `jose` isn't pre-installed in the
image), use this alternative: build the image first, then run the bundled
generator.

### 4a. Alternative, using the built image

```sh
cd /opt/bsky-mcp-server
sudo docker compose -f deploy/compose.yaml build
sudo docker run --rm -v /var/lib/bsky-mcp:/var/lib/bsky-mcp --user 1000:1000 \
  --entrypoint node bsky-mcp-server:local \
  build/src/scripts/generate-signing-key.js /var/lib/bsky-mcp/signing-keys.json
```

The file is written with mode `0600`. Back it up — rotating invalidates
every live OAuth session.

## 5. Bring up the service

```sh
cd /opt/bsky-mcp-server
sudo docker compose -f deploy/compose.yaml up -d --build
sudo docker compose -f deploy/compose.yaml logs --tail 50
```

## 6. Caddy

Append the snippet to your Caddyfile (or `import` it). On the reference
deployment the Caddyfile lives at `/pds/caddy/etc/caddy/Caddyfile` and
is mounted into the `caddy` container.

```sh
sudo tee -a /pds/caddy/etc/caddy/Caddyfile < deploy/Caddyfile.snippet
sudo docker exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 7. Smoke test

```sh
curl -s https://bsky-mcp.lizthegrey.com/oauth/client-metadata.json | jq .
curl -s https://bsky-mcp.lizthegrey.com/.well-known/oauth-authorization-server | jq .
```

Both should return JSON. The first is what any PDS will fetch on an auth
attempt; the second is what Claude reads to discover the endpoints.

## Adding a Claude connector

In Claude (desktop or mobile), add a custom MCP connector pointing at
`https://bsky-mcp.lizthegrey.com/mcp`. Claude will discover the auth
server, register itself via DCR, and walk you through the Bluesky sign-in
flow on first connect.

## Upgrading

```sh
cd /opt/bsky-mcp-server
sudo git pull
sudo docker compose -f deploy/compose.yaml up -d --build
```

Storage schema is `IF NOT EXISTS`-safe, so rolling forward is just a
rebuild + restart.

## Operational notes

- Logs: `sudo docker logs -f bsky-mcp`.
- Data: `/var/lib/bsky-mcp/data.db` (SQLite, WAL mode) + `signing-keys.json`.
  Back both up together; the DB holds live refresh tokens.
- GC runs every 10 minutes and at startup.
- Watchtower is instructed to leave this image alone
  (`com.centurylinklabs.watchtower.enable=false`) since the image is built
  locally from the checkout, not pulled from a registry.
- To force re-authentication of every user (e.g. after a suspected
  compromise): `docker compose down`, delete `data.db*` and
  `signing-keys.json`, regenerate the key, bring the service back up.

## Bare-metal alternative

`deploy/bsky-mcp.service` + `deploy/Caddyfile.snippet` work without
Docker. Install Node 24 via nvm or your distro, create a `bsky-mcp`
system user, run `pnpm install --frozen-lockfile && pnpm run build`
against `/opt/bsky-mcp-server`, then enable the systemd unit.
