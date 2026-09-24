/**
 * Diem vao cua container erp-chatbot tren VPS (docker-compose.prod.yml).
 *
 * May Windows chay `node src/server.js` truc tiep. Tren VPS, lan dau container len thi CHUA co .env
 * (khoa Gemini, token page) — khoa khong nam trong kho ma nguon. Neu goi thang server.js, bot dung
 * vi thieu GEMINI_API_KEY, Docker dung lai, dung tiep... vong lap vo tan va trang ERP khong co cho
 * nao de nap .env.
 *
 * Nen: chua du cau hinh => chay CHE DO CHO NAP (chi /health + /api/erp/*, khong doc tin khach, khong
 * goi AI). Nap xong, bot tu thoat va Docker dung lai o che do chay that.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Prompt chung nam trong o du lieu de sua duoc tu app (ma nguon gan chi-doc). Lan dau: chep ban trong kho.
const promptFile = process.env.SYSTEM_PROMPT_FILE;
if (promptFile && path.isAbsolute(promptFile) && !fs.existsSync(promptFile)) {
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "prompts", "system.md"), promptFile);
}

const { config } = await import("./src/config.js");
const { isConfigured, handleErpRoutes, dataStatus } = await import("./src/erp-import.js");

if (isConfigured()) {
  await import("./src/server.js");
} else {
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        return send(res, 200, { ok: true, configured: false, mode: "setup" });
      }
      const tok = req.headers["x-admin-token"] || url.searchParams.get("token");
      if (!config.adminToken || tok !== config.adminToken) return send(res, 403, { error: "Can ADMIN_TOKEN" });
      if (url.pathname.startsWith("/api/erp/") && (await handleErpRoutes(req, res, url))) return;
      send(res, 503, { error: "Bot chua duoc nap cau hinh (.env). Nap tu trang Bot chat trong ERP.", status: dataStatus() });
    })
    .listen(config.port, () => {
      console.log(`[erp-chatbot] CHE DO CHO NAP tai cong ${config.port}: chua co .env / khoa AI. Nap tu trang Bot chat trong ERP.`);
    });
}
