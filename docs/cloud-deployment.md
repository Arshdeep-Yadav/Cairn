# Cloud & Container Deployment Guide

Deploy Cairn as a centralized, collaborative memory hub for your agent swarms and engineering teams.

---

## Deployment Options

```
                    ┌────────────────────────┐
                    │ Internet / TLS Reverse │
                    │ Proxy (Caddy/Traefik)  │
                    └───────────┬────────────┘
                                │ HTTPS (:443)
                                ▼
                     ┌──────────────────────┐
                     │ Cairn Container/Node │
                     │   Port :4242         │
                     └──────────┬───────────┘
                                │
                                ▼
                     ┌──────────────────────┐
                     │ Persistent Vault     │
                     │  (/data/.cairn)      │
                     └──────────────────────┘
```

---

## 1. Docker & Docker Compose

### Quickstart with Docker Compose

1. Clone or copy `docker-compose.yml`:

```yaml
services:
  cairn:
    image: ghcr.io/arshdeep-yadav/cairn:latest
    container_name: cairn
    restart: unless-stopped
    ports:
      - "4242:4242"
    environment:
      - CAIRN_ALLOW_REMOTE=1
      - CAIRN_ALLOWED_HOSTS=cairn.example.com,localhost
      - CAIRN_SECURE_COOKIE=1
      - CAIRN_PASSWORD=your-secure-password-here
    volumes:
      - cairn_data:/data

volumes:
  cairn_data:
```

2. Start the container:
```sh
docker compose up -d
```

3. Open `http://localhost:4242` or your configured domain.

---

### Turn-Key Automated HTTPS with Caddy

For public cloud servers, use `docker-compose.caddy.yml` to automatically provision Let's Encrypt TLS certificates:

```sh
DOMAIN=cairn.example.com CAIRN_PASSWORD="your-strong-password" docker compose -f docker-compose.caddy.yml up -d
```

Caddy handles SSL renewal, redirects HTTP to HTTPS, and proxies requests to Cairn on port 4242.

---

## 2. Platform Guides

### Deploying to Railway

1. Click **New Project** > **Deploy from GitHub repo**.
2. Select your `cairn` repository.
3. Add a **Persistent Volume** mounted at `/data`.
4. In **Variables**, set:
   - `PORT`: `4242`
   - `CAIRN_ALLOW_REMOTE`: `1`
   - `CAIRN_ALLOWED_HOSTS`: `${{RAILWAY_PUBLIC_DOMAIN}}`
   - `CAIRN_SECURE_COOKIE`: `1`
   - `CAIRN_PASSWORD`: *(choose a strong password, min 12 chars)*
5. Deploy.

---

### Deploying to Fly.io

1. Initialize Fly configuration:
```sh
fly launch --no-deploy
```

2. Create a persistent volume for memory:
```sh
fly volumes create cairn_data --size 1
```

3. Update `fly.toml`:
```toml
[env]
  CAIRN_ALLOW_REMOTE = "1"
  CAIRN_SECURE_COOKIE = "1"
  CAIRN_ALLOWED_HOSTS = "your-app.fly.dev"

[mounts]
  source = "cairn_data"
  destination = "/data"

[http_service]
  internal_port = 4242
  force_https = true
```

4. Set your workspace password as a secret and deploy:
```sh
fly secrets set CAIRN_PASSWORD="your-strong-password"
fly deploy
```

---

### Linux VPS (Ubuntu / Debian Systemd)

If running directly on a Linux host without Docker:

1. Create a system user and vault folder:
```sh
sudo useradd -r -s /bin/false cairn
sudo mkdir -p /var/lib/cairn
sudo chown -R cairn:cairn /var/lib/cairn
```

2. Create `/etc/systemd/system/cairn.service`:
```ini
[Unit]
Description=Cairn Agent Memory Workspace
After=network.target

[Service]
Type=simple
User=cairn
WorkingDirectory=/var/lib/cairn
Environment=NODE_ENV=production
Environment=CAIRN_ALLOW_REMOTE=1
Environment=CAIRN_ALLOWED_HOSTS=cairn.example.com
Environment=CAIRN_SECURE_COOKIE=1
Environment=CAIRN_PASSWORD=your-strong-password
ExecStart=/usr/bin/npx cairn start --vault /var/lib/cairn/.cairn --host 0.0.0.0 --allow-remote --no-open
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

3. Enable and start:
```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cairn
```

---

## Environment Variables Reference

| Variable | Description | Default | Required in Cloud? |
|---|---|---|---|
| `CAIRN_ALLOW_REMOTE` | Allows binding to non-loopback addresses (`0.0.0.0`) | `0` | **Yes** (`1`) |
| `CAIRN_ALLOWED_HOSTS` | Comma-separated domain names / hostnames allowed in the `Host` header (DNS rebinding defense) | empty | **Yes** |
| `CAIRN_SECURE_COOKIE` | Marks auth cookies with the `Secure` attribute | `0` | **Yes** (when using HTTPS) |
| `CAIRN_PASSWORD` | Sets the workspace password non-interactively (min 12 chars) | generated on first run | Recommended |
| `PORT` | Listening HTTP port | `4242` | No |
| `HOST` | Listening host IP | `127.0.0.1` | Set to `0.0.0.0` in containers |
| `CAIRN_VAULT` | Path to the directory where the `.cairn` vault lives | current working directory | Recommended |

---

## Security Hardening Checklist

- [x] **Non-root Container**: Docker image executes as the unprivileged `node` user (UID 1000).
- [x] **DNS Rebinding Guard**: Requests with unmatched `Host` headers are rejected with HTTP 403 `bad_host`.
- [x] **Origin & CSRF Checks**: Cross-origin state-modifying requests are rejected.
- [x] **Scrypt Password Hashing**: Passwords stored via RFC 7914 scrypt hashes with 64-byte keys.
- [x] **Timing-Safe Authentication**: Token signatures and password hashes compared with `timingSafeEqual`.
- [x] **Session Invalidation**: Rotating or changing the password immediately revokes all prior active sessions.
