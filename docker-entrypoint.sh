#!/bin/sh
set -e

if [ "$1" = "npm" ]; then
  echo "[entrypoint] Áp dụng migration cơ sở dữ liệu..."
  # Dùng scripts/migrate.ts (migrator của drizzle-orm) thay cho `drizzle-kit migrate`:
  # drizzle-kit chỉ in spinner rồi thoát khác 0, KHÔNG in câu SQL hỏng — ERP từng sập
  # crash-loop mà log không cho biết nguyên nhân. Script này in đủ trường lỗi PostgreSQL.
  # Vẫn fail-fast: schema sai thì app không được phục vụ.
  npx tsx --tsconfig tsconfig.json scripts/migrate.ts
  echo "[entrypoint] Tạo tài khoản quản trị (nếu chưa có)..."
  npx tsx --tsconfig tsconfig.json scripts/seed-admin.ts || echo "[entrypoint] Bỏ qua seed"
fi

exec "$@"
