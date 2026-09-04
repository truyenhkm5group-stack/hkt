#!/bin/sh
set -e

if [ "$1" = "npm" ]; then
  echo "[entrypoint] Áp dụng migration cơ sở dữ liệu..."
  npx drizzle-kit migrate
  echo "[entrypoint] Tạo tài khoản quản trị (nếu chưa có)..."
  npx tsx --tsconfig tsconfig.json scripts/seed-admin.ts || echo "[entrypoint] Bỏ qua seed"
fi

exec "$@"
