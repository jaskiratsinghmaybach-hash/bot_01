# VPS Deployment

Local execution (`npm run dev`) is fine for development and testing, but
is not meant to run continuously on a laptop that sleeps, loses network,
or reboots. For continuous operation, deploy to a normal Linux VPS.

## Requirements

- Ubuntu 22.04 or 24.04 LTS (or any recent Debian-based distro)
- Node.js 20 or later
- PostgreSQL 14+ (can run on the same VPS or a managed instance)
- Outbound HTTPS/WSS access to `api.binance.com` and
  `stream.binance.com:9443` — confirm your VPS provider or firewall
  doesn't block this before deploying (this was a real constraint
  encountered during this project's own development sandbox, which had no
  outbound access to Binance at all — verify your target environment
  before assuming connectivity)

## Installation

```bash
# On the VPS
sudo apt update
sudo apt install -y nodejs npm postgresql

git clone <your-repo-url> bot_01
cd bot_01
npm install
npm run build
```

## Database setup

```bash
sudo -u postgres psql -c "CREATE USER bot01 WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE bot_01 OWNER bot01;"
```

The application creates its own tables idempotently at boot
(`CREATE TABLE IF NOT EXISTS`) — no manual migration step is required.
`config/schema.sql` is a human-readable reference for the same schema.

## Configuration

```bash
cp .env.example .env
nano .env   # fill in DATABASE_URL, SYMBOL, TRADING_MODE, risk parameters
```

Start in `dry-run` or `paper` mode. Do not set `TRADING_MODE=live` — it
is not yet implemented in this build (see `docs/execution.md`) and the
application will refuse to boot if you try.

## Running as a service (systemd)

Create `/etc/systemd/system/bot01.service`:

```ini
[Unit]
Description=BOT_01 Trading Core
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/home/youruser/bot_01
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/home/youruser/bot_01/.env
User=youruser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable bot01
sudo systemctl start bot01
sudo systemctl status bot01
journalctl -u bot01 -f          # follow logs
```

`Restart=on-failure` gives you a basic restart policy without masking
real configuration errors — the app still exits with a clear fatal
message (and non-zero exit code) on missing/invalid config, so repeated
rapid restarts in the logs is a real signal something is wrong, not
something to silence.

## Graceful shutdown

The application handles `SIGINT` and `SIGTERM` — `systemctl stop bot01`
(which sends `SIGTERM`) will close the WebSocket market-data connection
and the Postgres pool cleanly before exiting, rather than being killed
mid-write.

## Updates

```bash
sudo systemctl stop bot01
cd /home/youruser/bot_01
git pull
npm install
npm run build
sudo systemctl start bot01
```

## Health checking

There is no built-in HTTP health-check endpoint in this build. The
simplest checks available today:

- `systemctl status bot01` — is the process running
- `journalctl -u bot01 -n 50` — recent log output, including boot-time
  database/exchange-rule confirmation messages
- A query against `market_candles` for the most recent `open_time` — if
  it's stale relative to the current time, the market feed may have
  disconnected without reconnecting (check logs for repeated
  `[DATA] ... feed disconnected` messages)

Adding a proper `/health` endpoint (e.g. a minimal HTTP server reporting
last-candle age and DB connectivity) is a reasonable next step for a
buyer who wants automated monitoring — it is not built in this version.
