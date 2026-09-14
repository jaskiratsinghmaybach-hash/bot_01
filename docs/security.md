# Security

## Credentials

- **Never commit `.env`.** It is gitignored (see `.gitignore`). Only
  `.env.example` (with empty/placeholder values) is committed.
- `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` are only required when
  `TRADING_MODE=live` — which is not yet implemented in this build (see
  `docs/execution.md`). `dry-run` and `paper` modes need no Binance
  credentials at all.
- `BINANCE_SECRET_KEY` is never logged anywhere in this codebase — grep
  the source for `SECRET_KEY` in any `console.log`/`console.error` call
  before adding new logging near credential handling, and keep it that
  way.

## Binance API key permissions (for when Phase B / live trading is built)

When live execution is eventually implemented and you create a Binance
API key for it:

- Enable **Spot & Margin Trading** only.
- **Disable withdrawal permission.** A trading bot never needs to
  withdraw funds, and disabling this permission means a compromised key
  cannot drain the account, only trade within it.
- Use **IP restriction** if your VPS has a static IP — this limits the
  key to only be usable from your deployment server.
- Use a **separate key for development/testnet** and a separate key for
  any live account. Never reuse a live key for local development or
  testing.

## Secret rotation

If a key is ever suspected compromised (committed to git by accident,
leaked in a log, VPS compromised), rotate it immediately from the Binance
API management dashboard — this revokes the old key instantly. Update
`.env` on the VPS and restart the service.

## Database credentials

- Use a dedicated Postgres user (not `postgres` superuser) scoped to the
  `bot_01` database only.
- If the database is on a separate host from the application, restrict
  `pg_hba.conf` to the application server's IP rather than allowing
  connections from anywhere.

## VPS firewall

- Only expose SSH (restrict to your IP if possible) and any monitoring
  port you explicitly add. This application makes only outbound
  connections (to Binance and to its own local/private Postgres) — it
  does not need to accept any inbound connections to function, so there
  is no reason to open additional inbound ports for the bot process
  itself.

## Log redaction

- `BINANCE_SECRET_KEY` is never printed to logs (see above).
- Database connection strings can contain a password
  (`postgres://user:password@host/db`) — avoid logging the raw
  `DATABASE_URL` value; `database.ts` does not log it, and no other file
  in this codebase should either.

## Dependency security

Run `npm audit` periodically. As of this codebase's last dependency
review, all direct dependencies (`dotenv`, `pg`, `ws`) resolved with zero
known vulnerabilities via `npm audit` — re-check this yourself before
each deployment, since it can change as new CVEs are disclosed.
