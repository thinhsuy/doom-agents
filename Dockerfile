# Single image: builds the React console, then runs the FastAPI app that serves the API +
# WebSocket + the built FE from one process. Build context = repo root.
#
#   docker build -t agency-agents .
#
# The app resolves ROOT = repo root and reads persona .md files + divisions.json at runtime,
# so the whole repo layout ships in the image (heavy/secret paths trimmed via .dockerignore).
#
# DB: company/api/db.py is dual-transport. Locally it uses `docker exec psql`; in a
# container/ECS (no PGCONTAINER set) it connects to RDS over TCP with psycopg, using
# PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. The infra/ ECS task injects exactly those
# (PGPASSWORD from SSM) and never sets PGCONTAINER, so this image serves real traffic.
# libpq5 is pre-installed for psycopg. See infra/README.md.

# ---- Stage 1: build the frontend -------------------------------------------
FROM node:20-alpine AS ui
WORKDIR /ui
COPY company/ui/package*.json ./
RUN npm ci
COPY company/ui/ ./
# Static SPA (HashRouter) — plain vite build, no DB-backed data export step.
RUN npx vite build

# ---- Stage 2: python runtime ------------------------------------------------
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# libpq5 for psycopg; ca-certificates so the /api/fx endpoint's outbound HTTPS (FX APIs) verifies.
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY company/api/requirements.txt company/api/requirements.txt
RUN pip install -r company/api/requirements.txt

# The repo (personas, divisions.json, roster.json, company/…). .dockerignore trims
# node_modules/.venv/.git/secrets/tf-state so this stays lean.
COPY . /app
# Overlay the freshly built FE (local dist is gitignored / dockerignored).
COPY --from=ui /ui/dist /app/company/ui/dist

# main.py resolves ROOT via parents[2]; run from company/api so ROOT == /app.
WORKDIR /app/company/api
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
