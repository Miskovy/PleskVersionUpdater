# Plesk Version Updater

A NestJS microservice that synchronizes file changes from the base Systego installation to client subdomain directories on Plesk.

## Setup

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your actual Plesk paths and API key

# Development
npm run start:dev

# Production build
npm run build
npm run start:prod
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3500` | Service port |
| `PLESK_VHOSTS_DIR` | `/var/www/vhosts/systego.net/subdomains` | Vhost subdomains root |
| `BASE_FRONTEND_DIR` | `/var/www/vhosts/systego.net/httpdocs` | Base frontend directory |
| `BASE_BACKEND_DIR` | `/var/www/vhosts/systego.net/subdomains/bcknd` | Base backend directory |
| `API_KEY` | — | API key for authentication |
| `EXCLUDED_PATHS` | `node_modules,.env,.git,...` | Comma-separated exclusions |

## API Endpoints

All endpoints (except `/health`) require `x-api-key` header.

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | — | Health check (public) |
| `POST` | `/api/update/check` | `{ "clientName": "..." }` | Dry-run diff report |
| `POST` | `/api/update/sync` | `{ "clientName": "..." }` | Full sync (FE + BE) |
| `POST` | `/api/update/sync-frontend` | `{ "clientName": "..." }` | Frontend only |
| `POST` | `/api/update/sync-backend` | `{ "clientName": "..." }` | Backend only + redeploy |

## How It Works

1. **Check**: Compares files via SHA-256 hashing between base and client directories
2. **Sync**: Copies only changed/new files to the client directory
3. **Redeploy** (backend): Runs `npm install --production`, fixes ownership, restarts via Passenger
