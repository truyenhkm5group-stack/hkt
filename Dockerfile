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
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

RUN chmod +x ./docker-entrypoint.sh
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
