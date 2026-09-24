import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// Doc file .env (khong ghi de bien moi truong da co)
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
// Tren VPS (container erp-chatbot): .env nam trong o du lieu (BOT_ENV_FILE=/data/bot.env), khong nam
// trong ma nguon — ma nguon la kho public. Doc truoc de bien cua may chu thang bien trong .env cuc bo.
if (process.env.BOT_ENV_FILE) loadDotEnv(process.env.BOT_ENV_FILE);
loadDotEnv(path.join(ROOT, ".env"));

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const bool = (k, d = false) => {
  const v = env(k, "").toLowerCase();
  if (!v) return d;
  return ["1", "true", "yes", "on"].includes(v);
};
const num = (k, d) => {
  const v = Number(env(k, ""));
  return Number.isFinite(v) && env(k, "") !== "" ? v : d;
};

const DATA_DIR = path.resolve(ROOT, env("DATA_DIR", "data"));
// Page them tu app quan ly (dan token Pancake trong "Them page"): { "<page_id>": { token, name, addedAt } }
export const APP_PAGES_FILE = path.join(DATA_DIR, "pages_tokens.json");

/** Doc danh sach page da them tu app (data/pages_tokens.json) */
export function readAppPages() {
  try {
    if (!fs.existsSync(APP_PAGES_FILE)) return {};
    const obj = JSON.parse(fs.readFileSync(APP_PAGES_FILE, "utf8")) || {};
    const out = {};
    for (const [id, v] of Object.entries(obj)) {
      const token = typeof v === "string" ? v : v?.token;
      if (token) out[String(id)] = { token, name: (typeof v === "string" ? "" : v?.name) || "", addedAt: v?.addedAt || 0 };
    }
    return out;
  } catch (e) {
    console.warn("Khong doc duoc " + APP_PAGES_FILE + ": " + e.message);
    return {};
  }
}

function writeAppPages(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(APP_PAGES_FILE, JSON.stringify(all, null, 2));
}

/** Luu page them tu app (ghi de token cu neu da co) va cap nhat config.pages ngay */
export function saveAppPage(pageId, { token, name = "" }) {
  const id = String(pageId);
  const all = readAppPages();
  all[id] = { token, name: String(name || "").trim(), addedAt: all[id]?.addedAt || Date.now() };
  writeAppPages(all);
  config.pages[id] = { token, name: all[id].name, source: "app" };
  return config.pages[id];
}

/** Go page da them tu app. Neu page do cung co trong .env thi quay ve dung token trong .env */
export function removeAppPage(pageId) {
  const id = String(pageId);
  const all = readAppPages();
  if (!all[id]) return false;
  delete all[id];
  writeAppPages(all);
  const envPages = loadEnvPages();
  if (envPages[id]) config.pages[id] = envPages[id];
  else delete config.pages[id];
  return true;
}

/**
 * Danh sach page: { page_id: { token, name, source } }
 * - PANCAKE_PAGES_JSON: {"page_id": "token"} hoac {"page_id": {"token": "...", "name": "Ten shop"}}
 *   (cung chap nhan dang {"page_id": {"page_token": "...", "brand_name": "..."}})
 * - hoac PANCAKE_PAGE_ID + PANCAKE_PAGE_ACCESS_TOKEN (+ SHOP_NAME)
 * - cong them page dan token trong app (data/pages_tokens.json, source = "app"; ghi de .env neu trung id)
 */
function loadEnvPages() {
  const pages = {};
  const json = env("PANCAKE_PAGES_JSON");
  if (json) {
    let obj;
    try {
      obj = JSON.parse(json);
    } catch (e) {
      throw new Error("PANCAKE_PAGES_JSON khong phai JSON hop le: " + e.message);
    }
    for (const [id, v] of Object.entries(obj)) {
      const token = typeof v === "string" ? v : v?.token || v?.page_token || v?.page_access_token;
      const name = typeof v === "string" ? "" : v?.name || v?.brand_name || "";
      if (token) pages[String(id)] = { token, name, source: "env" };
    }
  }
  const id = env("PANCAKE_PAGE_ID");
  const token = env("PANCAKE_PAGE_ACCESS_TOKEN");
  if (id && token) pages[id] = { token, name: env("SHOP_NAME"), source: "env" };
  return pages;
}

function loadPages() {
  const pages = loadEnvPages();
  for (const [id, p] of Object.entries(readAppPages())) pages[id] = { token: p.token, name: p.name, source: "app" };
  return pages;
}

export const config = {
  port: num("PORT", 3000),
  webhookPath: env("WEBHOOK_PATH", "/webhook/pancake"),
  webhookSecret: env("WEBHOOK_SECRET"),

  pages: loadPages(),
  shopName: env("SHOP_NAME"),

  gemini: {
    apiKey: env("GEMINI_API_KEY"),
    model: env("GEMINI_MODEL", "gemini-2.5-flash"),
    temperature: num("GEMINI_TEMPERATURE", 0.4),
    maxOutputTokens: num("GEMINI_MAX_OUTPUT_TOKENS", 1024),
    // So request Gemini chay song song toi da (free tier nen de 3-4; tra phi co the 10-20)
    maxConcurrent: Math.max(1, num("GEMINI_MAX_CONCURRENT", 4)),
    // Ngan sach "suy nghi" cua Gemini cho bot ban hang: 0 = tat (nhanh nhat), -1 = tu dong. Tro ly AI khong bi anh huong.
    thinkingBudget: num("GEMINI_THINKING_BUDGET", 0),
  },

  // Nha cung cap AI: "gemini" (mac dinh) | "openai" (ChatGPT). Doi trong .env, khoi dong lai app.
  ai: {
    provider: /^openai$/i.test(env("AI_PROVIDER", "gemini")) ? "openai" : "gemini",
    get model() {
      return config.ai.provider === "openai" ? config.openai.model : config.gemini.model;
    },
  },
  openai: {
    apiKey: env("OPENAI_API_KEY"),
    model: env("OPENAI_MODEL", "gpt-4.1-mini"),
    baseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    maxConcurrent: Math.max(1, num("OPENAI_MAX_CONCURRENT", 6)),
    // Muc "suy nghi" cho model gpt-5*/o*: none (mac dinh, nhanh + bam kich ban) | low | medium | high
    reasoning: (env("OPENAI_REASONING", "none") || "none").toLowerCase(),
  },

  // Model cho tro ly quan tri (function calling); trong = dung model mac dinh cua nha cung cap
  assistantModel: env("ASSISTANT_MODEL"),

  pos: {
    shopId: env("POS_SHOP_ID"),
    apiKey: env("POS_API_KEY"),
    syncMinutes: num("POS_SYNC_MINUTES", 10),
    // "order" = tat ca bien the deu ban duoc (shop ban theo don, cho phep ton am)
    // "strict" = chi bao con hang khi remain_quantity > 0
    stockMode: env("POS_STOCK_MODE", "order"),
    cacheFile: env("POS_CACHE_FILE", "catalog.json"),
    // Kho mac dinh khi tao don (trong = de POS tu chon)
    warehouseId: env("POS_WAREHOUSE_ID"),
  },
  // Khi bot chot don xong: tu ghi vao don nhap trong POS (mau, so luong, ten, SDT, dia chi chuan hoa)
  orderSync: bool("ORDER_SYNC", true),
  sendProductImages: bool("SEND_PRODUCT_IMAGES", true),
  maxProductImages: num("MAX_PRODUCT_IMAGES", 12),
  // Moi tin nhan gui toi da N anh; nhieu hon thi chia thanh nhieu tin lien tiep
  imagesPerMessage: num("IMAGES_PER_MESSAGE", 6),

  systemPromptFile: path.resolve(ROOT, env("SYSTEM_PROMPT_FILE", "prompts/system.md")),
  historyLimit: num("HISTORY_LIMIT", 20),
  // Khi khach bao "da nhan/gui roi": doc lai toi da N tin (tai them tu Pancake)
  historyLimitRecheck: Math.max(30, num("HISTORY_LIMIT_RECHECK", 60)),
  debounceMs: num("DEBOUNCE_MS", 4000),
  replyToComments: bool("REPLY_TO_COMMENTS", false),
  // Binh luan duoi bai viet: off = khong tra loi | public = tra loi cong khai | inbox = nhan rieng vao inbox + 1 cau cong khai ngan
  commentMode: ["off", "public", "inbox"].includes(env("COMMENT_MODE")) ? env("COMMENT_MODE") : bool("REPLY_TO_COMMENTS", false) ? "public" : "off",
  commentPublicText: env("COMMENT_PUBLIC_TEXT", "Dạ em chào chị{name} ❤️ Shop đã gửi báo giá và ảnh mẫu vào tin nhắn cho chị rồi ạ, chị kiểm tra Messenger giúp em nhé!"),
  botPauseTagId: env("BOT_PAUSE_TAG_ID"),
  botPauseTagName: env("BOT_PAUSE_TAG_NAME"),
  // 0 = bot luon tra loi (tru khi tin cuoi da la cua nhan vien); N > 0 = im lang N phut sau khi nhan vien that tra loi
  humanTakeoverMinutes: Math.max(0, num("HUMAN_TAKEOVER_MINUTES", 0)),
  // Bot bat dau tra loi tu tin thu may cua khach. 1 = ngay tin dau; 2 = de Pancake tu dong tra loi tin dau (gui anh/bao gia), bot vao tu tin thu 2
  minCustomerMessages: Math.max(1, num("MIN_CUSTOMER_MESSAGES", 1)),
  botSenderId: env("BOT_SENDER_ID"),

  vision: {
    enabled: bool("VISION_ENABLED", true),
    // Khi khach gui anh, kem toi da N anh tham chieu (1 anh/mau/san pham) tu POS de AI so sanh
    referenceImages: num("VISION_REFERENCE_IMAGES", 12),
    // Model dung rieng cho buoc NHAN DIEN anh khach gui (so voi anh POS). flash-lite hay nham -> mac dinh dung 2.5-flash, cho "suy nghi"
    model: env("VISION_MODEL", "gemini-2.5-flash"),
    maxImages: num("VISION_MAX_IMAGES", 4),
    maxBytes: num("VISION_MAX_IMAGE_MB", 5) * 1024 * 1024,
  },

  pollEnabled: bool("POLL_ENABLED", false),
  pollIntervalSec: num("POLL_INTERVAL_SEC", 15),
  // Che do poll: chi tra loi hoi thoai co tin moi trong vong N phut (tranh tra loi hang loat tin cu khi vua bat bot / bat binh luan)
  pollMaxAgeMin: num("POLL_MAX_AGE_MIN", 10),
  // Luoi an toan: khach cho qua N phut ma chua ai tra loi thi bot tra loi bu (0 = tat)
  autoCatchupMinutes: num("AUTO_CATCHUP_MINUTES", 2),
  // Bam khach chua chot (sales agent): quet lai moi N phut (0 = tat hoan toan, chi bam tay tu app).
  // Van con cong tac o tung page: phai bat "Tu dong bam khach" thi page do moi chay.
  followupIntervalMin: num("FOLLOWUP_INTERVAL_MIN", 0),

  adminToken: env("ADMIN_TOKEN"),
  healthcheckUrl: env("HEALTHCHECK_URL"),
  healthcheckIntervalMin: num("HEALTHCHECK_INTERVAL_MIN", 5),

  dryRun: bool("DRY_RUN", false),
  dataDir: DATA_DIR,
  logLevel: env("LOG_LEVEL", "info"),
};

export function assertConfig({ needPancake = true, needGemini = true, needPos = false } = {}) {
  const missing = [];
  if (needGemini && config.ai.provider === "openai" && !config.openai.apiKey) missing.push("OPENAI_API_KEY (AI_PROVIDER=openai)");
  if (needGemini && config.ai.provider === "gemini" && !config.gemini.apiKey) missing.push("GEMINI_API_KEY");
  if (needPancake && Object.keys(config.pages).length === 0) {
    // Khong chan khoi dong: chu shop co the dan token page trong app quan ly (nut "Them page")
    console.warn("Chua co page nao (PANCAKE_PAGES_JSON trong .env trong). Mo app quan ly -> \"Them page\" de dan Page Access Token cua Pancake.");
  }
  if (needPos && !(config.pos.shopId && config.pos.apiKey)) missing.push("POS_SHOP_ID + POS_API_KEY");
  if (missing.length) {
    throw new Error(
      "Thieu cau hinh: " + missing.join(", ") + ". Hay copy .env.example -> .env va dien vao."
    );
  }
}

export function loadSystemPrompt() {
  if (!fs.existsSync(config.systemPromptFile)) {
    throw new Error("Khong tim thay file system prompt: " + config.systemPromptFile);
  }
  return fs.readFileSync(config.systemPromptFile, "utf8");
}
