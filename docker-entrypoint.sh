#!/bin/sh
set -e

if [ "$1" = "npm" ]; then
  echo "[entrypoint] Áp dụng migration cơ sở dữ liệu..."
  # Migration lỗi => thoát khác 0 => container restart (restart: unless-stopped) => lặp vô hạn
  # và ERP sập mà log deploy vẫn báo thành công. In banner rõ ràng để tìm nguyên nhân ngay trong
  # `docker compose logs app`. Mọi migration phải IDEMPOTENT vì lần chạy lại luôn bắt đầu từ đầu.
  if ! npx drizzle-kit migrate; then
    echo "======================================================================"
    echo "[entrypoint] MIGRATION THẤT BẠI — container sẽ thoát và bị restart lặp."
    echo "[entrypoint] ERP sẽ KHÔNG phục vụ được cho tới khi migration chạy xong."
    echo "[entrypoint] Xem đúng câu lệnh SQL lỗi ở ngay phía trên dòng này."
    echo "======================================================================"
    exit 1
  fi
  echo "[entrypoint] Tạo tài khoản quản trị (nếu chưa có)..."
  npx tsx --tsconfig tsconfig.json scripts/seed-admin.ts || echo "[entrypoint] Bỏ qua seed"
fi

exec "$@"
