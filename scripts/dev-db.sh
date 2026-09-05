#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Deimos LLC
# Local Postgres for development and tests. Requires Docker.
set -euo pipefail
NAME=ratchet-pg
PORT=${RATCHET_DB_PORT:-5433}

case "${1:-up}" in
  up)
    if [ -n "$(docker ps -q -f name=^/${NAME}$)" ]; then
      echo "postgres already running on :${PORT}"
    else
      docker rm -f "${NAME}" >/dev/null 2>&1 || true
      docker run -d --name "${NAME}" \
        -e POSTGRES_USER=ratchet -e POSTGRES_PASSWORD=ratchet -e POSTGRES_DB=ratchet \
        -p "${PORT}:5432" postgres:16-alpine >/dev/null
      echo -n "waiting for postgres"
      for _ in $(seq 1 60); do
        if docker exec "${NAME}" pg_isready -U ratchet -q 2>/dev/null; then echo " ready"; exit 0; fi
        echo -n "."; sleep 0.5
      done
      echo " timed out"; exit 1
    fi
    ;;
  down) docker rm -f "${NAME}" >/dev/null 2>&1 || true; echo "stopped" ;;
  *) echo "usage: dev-db.sh [up|down]"; exit 1 ;;
esac
