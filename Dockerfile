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
RUN NODE_OPTIONS=--max-old-space-size=1024 npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

RUN chmod +x ./docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
