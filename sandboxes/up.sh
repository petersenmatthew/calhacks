#!/usr/bin/env bash
# Start Odoo and Lago locally. Generates sandboxes/.env (keys and local logins) on first run.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  rsa=$(openssl genrsa 2048 2>/dev/null | base64 | tr -d '\n')
  {
    echo "LAGO_RSA_PRIVATE_KEY=$rsa"
    echo "LAGO_SECRET_KEY_BASE=$(openssl rand -hex 64)"
    echo "LAGO_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 16)"
    echo "LAGO_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 16)"
    echo "LAGO_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 16)"
    echo "LAGO_ORG_USER_PASSWORD=atlas-$(openssl rand -hex 4)"
    echo "LAGO_API_KEY=$(openssl rand -hex 24)"
  } > .env
  echo "Wrote sandboxes/.env"
fi

docker compose up -d

printf "Waiting for Lago and Odoo"
for _ in $(seq 1 120); do
  lago=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/health || true)
  odoo=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8069/web/login || true)
  if [ "$lago" = "200" ] && [ "$odoo" = "200" ]; then echo " ready"; break; fi
  printf "."; sleep 3
done

key=$(grep '^LAGO_API_KEY=' .env | cut -d= -f2)
pass=$(grep '^LAGO_ORG_USER_PASSWORD=' .env | cut -d= -f2)
cat <<EOF

Add to .env.local:
  LAGO_API_URL=http://localhost:3100
  LAGO_API_KEY=$key
  ODOO_URL=http://localhost:8069
  ODOO_DB=atlas
  ODOO_USER=admin
  ODOO_PASSWORD=admin

Odoo (Atlas Research ERP): http://localhost:8069   admin / admin
Lago (Lambda billing):     http://localhost:8090   billing@lambda.example / $pass
EOF
