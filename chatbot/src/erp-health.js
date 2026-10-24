import { config } from "./config.js";
import { log } from "./logger.js";
import { BEAT_EVERY_MS, createHealthTracker } from "./health-tracker.js";

/**
 * Day suc khoe bot nha len ERP (POST /api/internal/bot-health, khoa x-chatbot-token = CHATBOT_ADMIN_TOKEN). Them vao healthchecks.io,
 * KHONG thay. Loi gui khong lam hong luot tra loi; canh bao log toi da mot lan / 10 phut.
 */
const tracker = createHealthTracker();
const base = () => (process.env.ERP_INTERNAL_URL || "http://app:3000").replace(/\/+$/, "");
let warnedAt = 0;

async function send(body) {
  if (!body || !config.adminToken) return;
  try {
    const res = await fetch(`${base()}/api/internal/bot-health`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chatbot-token": config.adminToken },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok && Date.now() - warnedAt > 600_000) {
      warnedAt = Date.now();
      log.warn(`Bao suc khoe bot len ERP loi HTTP ${res.status}`);
    }
  } catch (e) {
    if (Date.now() - warnedAt > 600_000) {
      warnedAt = Date.now();
      log.warn(`Bao suc khoe bot len ERP loi: ${e instanceof Error ? e.message : e}`);
    }
  }
}

export const botHealth = {
  providerError: (status, message) => void send(tracker.providerError(status, message)),
  providerOk: () => void send(tracker.providerOk()),
  customerTurn: () => tracker.customerTurn(),
  reply: () => tracker.reply(),
};

export function startHealthBeat() {
  const t = setInterval(() => void send(tracker.beat()), BEAT_EVERY_MS);
  t.unref?.();
  log.info(`Suc khoe bot -> ERP: nhip moi ${BEAT_EVERY_MS / 60_000} phut`);
}
