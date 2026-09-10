#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

command -v docker >/dev/null 2>&1 || {
	echo "docker is required" >&2
	exit 1
}
docker compose version >/dev/null 2>&1 || {
	echo "docker compose is required" >&2
	exit 1
}
command -v git >/dev/null 2>&1 || {
	echo "git is required" >&2
	exit 1
}
[[ -f .env.production ]] || {
	echo ".env.production is required" >&2
	exit 1
}

MAGTRANSDB_VERSION="$(tr -d '[:space:]' <VERSION)"
MAGTRANSDB_REVISION="$(git rev-parse HEAD)"
export MAGTRANSDB_REVISION MAGTRANSDB_VERSION

SERVER_IMAGE="magtransdb-server:${MAGTRANSDB_VERSION}"

echo "==> Version:  ${MAGTRANSDB_VERSION}"
echo "==> Revision: ${MAGTRANSDB_REVISION}"
echo "==> Build server image: ${SERVER_IMAGE}"

echo "==> Build and deploy on local host"
docker compose --env-file .env.production build --pull
docker compose --env-file .env.production pull --policy always --ignore-buildable

docker compose --env-file .env.production up -d --remove-orphans

echo "==> Done. Released ${MAGTRANSDB_VERSION} (${MAGTRANSDB_REVISION}) on the local host."
