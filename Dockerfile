FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

# Cài dependencies (bao gồm devDependencies để build & chạy drizzle-kit/tsx)
COPY package.json package-lock.json ./
COPY drizzle ./drizzle
RUN npm ci --no-audit --no-fund

# Build ứng dụng
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# ═══ GIỚI HẠN BỘ NHỚ CHỈ CHO BƯỚC DỰNG ═══
#
# Deploy #208 chết vì `next build` bị SIGKILL trên VPS ~1,9 GB đang chạy Postgres + ứng dụng + bộ
# lập lịch + Caddy. Không giới hạn thì Node cứ phình ra tới lúc nhân hệ điều hành giết nó.
#
# Đặt trên chính dòng `RUN` chứ KHÔNG dùng `ENV`: `ENV` sẽ theo image sang lúc chạy và bóp luôn
# vùng nhớ của ứng dụng đang phục vụ người dùng — một tác dụng phụ hoàn toàn không mong muốn.
#
# ─── VÌ SAO LÀ THAM SỐ, KHÔNG PHẢI MỘT CON SỐ CỨNG ───
#
# Deploy #239 (12/09/2026) chết ở đúng dòng này: `✓ Compiled successfully` rồi hết heap ở bước
# "Linting and checking validity of types". 1024 MB đã SÁT MÉP từ trước — đo lại trên bản đang chạy
# `2a51d89` cũng tràn ở mức đó — và bản thêm một bảng vào `db/schema.ts` (lược đồ drizzle là đồ thị
# kiểu lớn nhất kho này) đẩy nó qua mép. Đo được: 2048 MB đủ cho bản 12/09.
#
# Nhưng KHÔNG được nâng mặc định: 1024 sinh ra để bảo vệ đường DỰNG TRÊN VPS
# (`docker compose up -d --build` khi cài tay — `scripts/install-vps.sh`), máy ~1,9 GB đang chạy
# Postgres + ứng dụng + scheduler + Caddy. Đó chính là #208/#227/#228. Nâng mặc định là mời lại
# đúng sự cố đó cho người cài tay.
#
# Nên: mặc định giữ nguyên 1024 cho VPS; CI (máy 7 GB, chỉ dựng một image) truyền
# `--build-arg BUILD_HEAP_MB=4096`.
ARG BUILD_HEAP_MB=1024
RUN NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB} npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

RUN chmod +x ./docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
