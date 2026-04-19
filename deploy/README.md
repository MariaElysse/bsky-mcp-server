# Deploying the remote OAuth server

These instructions assume a Debian/Ubuntu host that already runs Caddy in
front of other services (as the existing PDS host does). Adjust paths to
your own layout if they don't match.

## 1. System user + data dir

```sh
sudo useradd --system --home /var/lib/bsky-mcp --shell /usr/sbin/nologin bsky-mcp
sudo install -d -o bsky-mcp -g bsky-mcp -m 0750 /var/lib/bsky-mcp
sudo install -d -o root     -g bsky-mcp -m 0750 /etc/bsky-mcp
```

## 2. Install the build

Clone and build somewhere root-owned; the service only needs read access.

```sh
sudo install -d -o root -g root -m 0755 /opt/bsky-mcp-server
sudo git clone https://github.com/lizthegrey/bsky-mcp-server /opt/bsky-mcp-server
cd /opt/bsky-mcp-server
sudo git checkout <deployment-branch>   # e.g. lizf.deploy
sudo corepack enable
sudo corepack prepare pnpm@9.15.4 --activate
sudo pnpm install --frozen-lockfile
sudo pnpm run build
```

## 3. Generate the signing key

Run as the service user so the file lands with the right owner.

```sh
sudo -u bsky-mcp node /opt/bsky-mcp-server/build/src/scripts/generate-signing-key.js \
    /var/lib/bsky-mcp/signing-keys.json
```

The file is written with mode `0600`. Back it up somewhere safe — rotating
this key invalidates every live OAuth session.

## 4. Environment file

```sh
sudo tee /etc/bsky-mcp/env <<'EOF'
PUBLIC_URL=https://bsky-mcp.lizthegrey.com
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/bsky-mcp
EOF
sudo chown root:bsky-mcp /etc/bsky-mcp/env
sudo chmod 0640 /etc/bsky-mcp/env
```

## 5. systemd unit

```sh
sudo install -m 0644 deploy/bsky-mcp.service /etc/systemd/system/bsky-mcp.service
sudo systemctl daemon-reload
sudo systemctl enable --now bsky-mcp.service
sudo systemctl status bsky-mcp.service
```

## 6. Caddy

Either add the snippet inline to your `Caddyfile` or include it:

```caddy
import /opt/bsky-mcp-server/deploy/Caddyfile.snippet
```

Then `sudo caddy reload` (or `sudo systemctl reload caddy`).

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
sudo pnpm install --frozen-lockfile
sudo pnpm run build
sudo systemctl restart bsky-mcp.service
```

Storage schema is `IF NOT EXISTS`-safe, so rolling forward is just a
restart. There's no migration framework; if a future change needs one,
it'll be obvious from the CHANGELOG.

## Operational notes

- Logs: `journalctl -u bsky-mcp.service -f`.
- Data: `/var/lib/bsky-mcp/data.db` (SQLite) + `signing-keys.json`. Back
  both up together; the DB holds live refresh tokens.
- `data.db-wal` and `data.db-shm` are normal — SQLite is in WAL mode.
- GC runs every 10 minutes and at startup; expired auth codes / tokens /
  pending authorizations are deleted automatically.
- To force re-authentication of every user (e.g. after a suspected
  compromise): stop the service, delete `data.db`, regenerate the
  signing key with `--force`, start the service. All MCP tokens and
  ATProto sessions are invalidated; users will be prompted to sign in
  again on next connector use.
