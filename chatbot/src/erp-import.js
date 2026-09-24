import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Chuyen bot tu may Windows len VPS (container erp-chatbot) ma KHONG dua khoa nao vao kho ma nguon.
 *
 * Kho ma nguon la PUBLIC, nen .env (khoa Gemini, token page, khoa POS) va thu muc data/ (cai dat
 * 10 page, token page them tu app, trang thai tin da tra loi) di theo duong: trinh duyet chu shop
 * -> ERP (kiem tra dang nhap + quyen) -> bot (kiem tra ADMIN_TOKEN) -> o du lieu /data tren VPS.
 *
 * Hai luat:
 *  1. CHI nhan dung cac ten tep duoi day. Ten la khoa tra cuu, khong phai duong dan — khong co cach
 *     nao ghi ra ngoai thu muc du lieu.
 *  2. Nhap xong LUON bat "chi log, khong gui" (global.json dryRun = true), ke ca khi tep tai len noi
 *     nguoc lai. Bot tren may Windows con dang chay: hai bot cung gui thi khach nhan hai cau tra loi.
 *     Chu shop tat bot tren may Windows roi moi bam "Gui that" trong app.
 */
export const IMPORTABLE_FILES = {
  "bot.env": "text",
  "pages.json": "json",
  "pages_tokens.json": "json",
  "global.json": "json",
  "state.json": "json",
  "system.md": "text",
};

const MAX_IMPORT_BYTES = 60 * 1024 * 1024;

export function envFilePath() {
  return process.env.BOT_ENV_FILE || path.join(config.dataDir, "bot.env");
}

/** Dich thu muc du lieu cho tung ten tep duoc phep. */
function targetOf(name) {
  if (name === "bot.env") return envFilePath();
  if (name === "system.md") return config.systemPromptFile;
  return path.join(config.dataDir, name);
}

/** Da du cau hinh de chay bot that chua (co tep .env va co khoa AI). */
export function isConfigured() {
  const provider = (process.env.AI_PROVIDER || "gemini").trim().toLowerCase();
  const key = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
  return fs.existsSync(envFilePath()) && !!(key && key.trim());
}

export function dataStatus() {
  const files = Object.keys(IMPORTABLE_FILES).map((name) => {
    const file = targetOf(name);
    try {
      const st = fs.statSync(file);
      return { name, present: true, bytes: st.size, updatedAt: st.mtime.toISOString() };
    } catch {
      return { name, present: false, bytes: 0, updatedAt: null };
    }
  });
  return { configured: isConfigured(), files };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_IMPORT_BYTES) {
        reject(new Error("Du lieu qua lon (>60MB)"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Kiem tra + ghi. Tra ve danh sach tep da ghi, hoac nem loi — khong ghi tep nao neu co tep hong. */
export function importFiles(files) {
  if (!files || typeof files !== "object") throw new Error("Thieu truong files");
  const plan = [];
  for (const [name, content] of Object.entries(files)) {
    if (!(name in IMPORTABLE_FILES)) throw new Error(`Khong nhan tep ${name}. Chi nhan: ${Object.keys(IMPORTABLE_FILES).join(", ")}`);
    if (typeof content !== "string" || !content.trim()) throw new Error(`Tep ${name} rong`);
    if (IMPORTABLE_FILES[name] === "json") {
      try {
        JSON.parse(content);
      } catch (e) {
        throw new Error(`Tep ${name} khong phai JSON hop le: ${e.message}`);
      }
    }
    if (name === "bot.env" && !/^\s*(GEMINI_API_KEY|OPENAI_API_KEY)\s*=\s*\S+/m.test(content)) {
      throw new Error("Tep .env khong co GEMINI_API_KEY (hoac OPENAI_API_KEY)");
    }
    if (name === "system.md" && content.trim().length < 50) throw new Error("Tep system.md qua ngan");
    plan.push([name, content]);
  }
  if (!plan.length) throw new Error("Chua chon tep nao");
  for (const [name, content] of plan) writeAtomic(targetOf(name), content);
  // Luat 2: nhap xong luon ve "chi log" — xem chu thich dau tep.
  let global = {};
  try {
    global = JSON.parse(fs.readFileSync(targetOf("global.json"), "utf8")) || {};
  } catch {}
  writeAtomic(targetOf("global.json"), JSON.stringify({ ...global, dryRun: true }, null, 2));
  return plan.map(([name]) => name);
}

/**
 * Hai duong /api/erp/*. Nguoi goi da kiem tra ADMIN_TOKEN. Tra ve true neu da xu ly.
 * Nhap xong thi thoat tien trinh: Docker (restart: unless-stopped) dung lai bot voi .env moi.
 */
export async function handleErpRoutes(req, res, url) {
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/api/erp/status") {
    send(200, dataStatus());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/erp/import") {
    let written;
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      written = importFiles(body.files);
    } catch (e) {
      send(400, { error: e.message });
      return true;
    }
    send(200, { ok: true, written, dryRun: true, restarting: true });
    setTimeout(() => process.exit(0), 300).unref?.();
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/erp/restart") {
    send(200, { ok: true, restarting: true });
    setTimeout(() => process.exit(0), 300).unref?.();
    return true;
  }
  return false;
}
