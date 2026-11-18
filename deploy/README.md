# QueuePilot hosted server — deployment runbook

Target: the owner's Ubuntu box (`107.172.193.23`), **shared with other live
services** (taskpilot, codes-bot, sol-auto-trader, linktrack). Every step
below touches only QueuePilot's own files, container, volume, and vhost.

What runs where:

```
family PCs ──HTTPS──> nginx (shared, TLS via Let's Encrypt)
                          │  queuepilot.taskpilot.tech
                          ├── /engines.manifest.json, /updates/*  (static files)
                          └── everything else ──> 127.0.0.1:3010 (queuepilot-server container)
                                                        │
                                              /opt/queuepilot-server/data  (SQLite + updates)
```

## 0. Prereqs (one-time, on the server)

- DNS: `queuepilot.taskpilot.tech` A record → `107.172.193.23` (owner, at the
  registrar; verify with `getent hosts queuepilot.taskpilot.tech`).
- Docker + docker compose plugin (already installed on this box).
- `/opt/queuepilot-server/data` exists (`mkdir -p`).

## 1. Ship the server (repo → server)

```bash
# on your PC, from the repo root:
scp -r deploy root@107.172.193.23:/root/queuepilot-server/deploy
ssh root@107.172.193.23 "mkdir -p /opt/queuepilot-server/app"
# ship the build context the Dockerfile needs (root manifests + tsconfig
# base + the server workspace + deploy):
tar --exclude=node_modules --exclude=.git -czf - \
  package.json package-lock.json tsconfig.base.json apps/server deploy \
  | ssh root@107.172.193.23 "tar -xzf - -C /opt/queuepilot-server/app"
```

## 2. Build + start

```bash
ssh root@107.172.193.23
cd /opt/queuepilot-server/app
export QUEUEPILOT_SERVER_BOOTSTRAP_CODE='<pick-a-long-random-code>'
docker compose -f deploy/docker-compose.yml up -d --build
curl -s http://127.0.0.1:3010/health        # → {"ok":true}
```

Keep the bootstrap code in a password manager — it only works until the
owner account exists, but treat it like a password anyway. Remove the env
line from your shell history afterwards.

## 3. TLS via certbot (needs the DNS record live)

```bash
cp /opt/queuepilot-server/app/deploy/nginx-queuepilot.conf /etc/nginx/sites-enabled/queuepilot.conf
nginx -t && systemctl reload nginx          # reload, NOT restart (shared box)
certbot --nginx -d queuepilot.taskpilot.tech
curl -s https://queuepilot.taskpilot.tech/health   # → {"ok":true}
```

certbot edits the vhost to add the certificate lines and renews them itself
(renewal hooks reload nginx; the other vhosts are unaffected).

## 4. Create the owner account (one-time)

```bash
curl -X POST https://queuepilot.taskpilot.tech/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"code":"<bootstrap-code>","email":"you@example.com","password":"<min-10-chars>","displayName":"Owner"}'
```

Save the returned `qps_…` token. From here on the bootstrap endpoint is dead
(returns 409) and the code can be unset.

## 5. Invite team members (max 10)

Owner-only calls, bearer token required:

```bash
TOKEN=qps_...
curl -X POST https://queuepilot.taskpilot.tech/team/invites \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"role":"L1"}'          # L1 run-only · L2 edit · L3 add/delete
# → {"code":"qpi_..."} — hand it to the teammate out of band; shown once.

# teammate redeems:
curl -X POST https://queuepilot.taskpilot.tech/auth/redeem \
  -H 'content-type: application/json' \
  -d '{"code":"qpi_...","email":"sam@example.com","password":"...","displayName":"Sam"}'
```

Tier matrix (enforced server-side): **L1** runs tasks/warmups only ·
**L2** + edit · **L3** + add/delete · **owner** invites + admin. Team
management: `GET /team/members`, `PATCH /team/members/:id`
(`{"role":"L2"}` / `{"active":false}`), `DELETE /team/members/:id`,
`GET|DELETE /team/invites`.

## 6. Publish an engine update (from your PC, after an engine build)

```bash
node deploy/publish-engine.mjs --version 0.5.5-qp.4
```

Uploads the tarball, verifies sha256, rewrites the manifest URLs to
`https://queuepilot.taskpilot.tech/updates/...`, publishes the manifest.
Family PCs pick it up when their Settings → Engine → Update server URL
points at `https://queuepilot.taskpilot.tech/` (Settings → Engine in the
app, or `QP_UPDATE_SERVER_URL`).

## 7. Updates, backups, trouble

- **App update:** repeat steps 1–2 (`up -d --build` rebuilds; the SQLite
  volume survives).
- **Backup:** `tar -czf qp-backup-$(date +%F).tgz -C /root queuepilot-server/data`
- **Logs:** `docker logs queuepilot-server`
- **The other services on this box:** never edit their files in
  `/etc/nginx/sites-enabled/`; always `nginx -t` before `reload`.

## Security notes (honest limits)

- Profiles travel as client-sealed bundles (AES-256-GCM); the server never
  holds a decrypt path. What the server protects: your credentials,
  membership, leases, and the update channel.
- The desktop client is distributed as JS; minification deters casual
  copying but a determined user can read it. The engine binary and your
  profiles/proxies are the parts that genuinely stay server-side.
- Passwords are Argon2id; sessions and invite codes are stored as SHA-256
  hashes, shown once, and expire.
