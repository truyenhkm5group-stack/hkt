import http from "node:http";
import { config, assertConfig } from "./config.js";
import { log } from "./logger.js";
import { Bot } from "./bot.js";
import { startPoller } from "./poller.js";
import { startWatchdog } from "./watchdog.js";
import { startSalesAgent } from "./salesagent.js";
import { catalog } from "./catalog.js";
import { createAdminHandler } from "./admin.js";

assertConfig();
const bot = new Bot();
await bot.init();
catalog.start();
const handleAdmin = createAdminHandler(bot);

const MAX_BODY = 5 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body qua lon"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return send(res, 200, {
      ok: true,
      pages: [...bot.clients.keys()].map((id) => ({ id, name: bot.pageNames.get(id) })),
      model: config.ai.model,
      dryRun: config.dryRun,
      poll: config.pollEnabled,
      catalog: { enabled: catalog.enabled, products: catalog.products.length, updatedAt: catalog.updatedAt ? new Date(catalog.updatedAt).toISOString() : null },
    });
  }

  if (await handleAdmin(req, res, url)) return;

  if (url.pathname === config.webhookPath) {
    if (config.webhookSecret) {
      const given = url.searchParams.get("secret") || req.headers["x-webhook-secret"];
      if (given !== config.webhookSecret) {
        log.warn("Webhook sai secret tu", req.socket.remoteAddress);
        return send(res, 401, { error: "unauthorized" });
      }
    }
    // Pancake co the goi GET/POST de "verify endpoint" -> luon tra 200
    if (req.method === "GET") return send(res, 200, "ok");
    if (req.method === "POST") {
      let raw = "";
      try {
        raw = await readBody(req);
      } catch (e) {
        return send(res, 413, { error: e.message });
      }
      // Tra 200 ngay (Pancake yeu cau < 5s), xu ly sau
      send(res, 200, { success: true });
      if (!raw) return;
      try {
        const payload = JSON.parse(raw);
        log.debug("Webhook:", raw.slice(0, 500));
        bot.handleWebhook(payload);
      } catch (e) {
        log.error("Webhook payload loi:", e.message, raw.slice(0, 300));
      }
      return;
    }
  }

  send(res, 404, { error: "not found" });
});

// Ping healthchecks.io (hoac tuong tu) de biet bot con song
function startHealthcheck() {
  if (!config.healthcheckUrl) return;
  const ping = async () => {
    try {
      const res = await fetch(config.healthcheckUrl, { method: "GET", signal: AbortSignal.timeout(10000) });
      log.debug(`Healthcheck ping -> ${res.status}`);
    } catch (e) {
      log.warn("Healthcheck ping loi:", e.message);
    }
  };
  ping();
  const t = setInterval(ping, Math.max(1, config.healthcheckIntervalMin) * 60 * 1000);
  t.unref?.();
  log.info(`Healthcheck: ping moi ${config.healthcheckIntervalMin} phut`);
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log.error(`Cong ${config.port} dang bi chuong trinh khac dung. Doi PORT trong .env (vd PORT=3456) roi chay lai.`);
    process.exit(1);
  }
  throw e;
});
server.listen(config.port, () => {
  log.info(`Server chay tai http://localhost:${config.port}  |  App quan ly: http://127.0.0.1:${config.port}/admin`);
  log.info(`Webhook URL: http://<domain-cong-khai>${config.webhookPath}${config.webhookSecret ? "?secret=" + config.webhookSecret : ""}`);
  log.info(`Pages (${bot.clients.size}): ${[...bot.clients.keys()].map((id) => `${id} ${bot.pageNames.get(id) || ""}`.trim()).join(" | ")}`);
  log.info(`AI: ${config.ai.provider} | Model: ${config.ai.model} | DRY_RUN=${config.dryRun} | POLL=${config.pollEnabled} | POS=${catalog.enabled ? "on" : "off"}`);
  if (config.pollEnabled) startPoller(bot);
  startWatchdog(bot);
  startSalesAgent(bot);
  // Moi 10 phut tra lai tag "BOT OFF" cho page chua co (chu shop tao tag sau khi bot da chay)
  const tagTimer = setInterval(() => bot.refreshPauseTags().catch(() => {}), 10 * 60 * 1000);
  tagTimer.unref?.();
  startHealthcheck();
});

process.on("unhandledRejection", (e) => log.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => log.error("uncaughtException:", e));
