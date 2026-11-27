#!/usr/bin/env bash
# Собирает все веб-клиенты и раскладывает их в deploy/www/<путь> для Caddy (deploy/Caddyfile).
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @dark/contracts build
pnpm --filter "@dark/storefront" --filter "@dark/backoffice" --filter "@dark/kds" --filter "@dark/picker" --filter "@dark/courier" build
rm -rf deploy/www && mkdir -p deploy/www
cp -r apps/storefront/dist deploy/www/store
cp -r apps/backoffice/dist deploy/www/office
cp -r apps/kds/dist deploy/www/kds
cp -r apps/picker/dist deploy/www/picker
cp -r apps/courier/dist deploy/www/courier
echo "Фронты собраны в deploy/www: $(du -sh deploy/www | cut -f1)"
