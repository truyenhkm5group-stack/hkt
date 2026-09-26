import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ROOT, saveAppPage, removeAppPage } from "./config.js";
import { listPages, generatePageAccessToken } from "./pancake.js";
import { log, logRing, logEvents } from "./logger.js";
import { settings } from "./settings.js";
import { store } from "./store.js";
import { catalog } from "./catalog.js";
import { generateReply, listModels } from "./ai.js";
import { renderSystemPrompt } from "./prompt.js";
import { HANDOFF, missingOrderFields, isOrderSummaryReply, PAYMENT_GUARD_REPLY } from "./bot.js";
import { stripHtml, stripMarkdown, sortChrono } from "./util.js";
import { createAssistant } from "./assistant.js";
import { broadcast } from "./broadcast.js";
import { salesAgent, followupConfig, STAGES } from "./salesagent.js";
import { orderAudit, STATUS_NAMES } from "./audit.js";
import { handleErpRoutes } from "./erp-import.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = path.join(ROOT, "admin", "index.html");

/**
 * API cho app quan ly (Electron / trinh duyet). Chi cho phep tu localhost,
 * hoac co header x-admin-token = ADMIN_TOKEN neu dat.
 */
function isLocal(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("Du lieu qua lon (>25MB)"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function pageSummary(bot, pageId) {
  const st = store.getStats(pageId);
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const days = Object.keys(st).filter((k) => k !== "lastActivity").sort().slice(-7);
  const sum = (key) => days.reduce((n, d) => n + (st[d]?.[key] || 0), 0);
  return {
    id: pageId,
    name: bot.pageNames.get(pageId) || "",
    pancakeName: bot.pancakeNames?.get(pageId) || "",
    settings: settings.get(pageId),
    effective: settings.effective(pageId),
    pauseTagId: bot.pauseTagId(pageId) || null,
    source: config.pages[pageId]?.source || "env", // "app" = them bang cach dan token trong app; "env" = khai bao trong .env
    stats: {
      today: st[today] || {},
      last7: { replies: sum("replies"), handoffs: sum("handoffs"), skippedStaff: sum("skippedStaff"), skippedFirst: sum("skippedFirst"), orders: sum("orders") },
      followupToday: store.countFollowupToday(pageId),
      lastActivity: st.lastActivity || null,
    },
  };
}

const ADJUST_SYSTEM = `Bạn là chuyên gia viết prompt cho chatbot bán hàng tiếng Việt.
Nhiệm vụ: sửa "văn bản hiện tại" theo "yêu cầu" của chủ shop, giữ nguyên cấu trúc, các mục và placeholder như {{SHOP_NAME}}, {{CATALOG}}, [[HANDOFF]], [[IMG:...]] nếu có.
Chỉ thay đổi những gì yêu cầu đề cập; không bịa thêm chính sách, giá, sản phẩm. Nếu yêu cầu mơ hồ, chọn cách diễn giải an toàn nhất.
Trả về DUY NHẤT văn bản mới hoàn chỉnh (markdown như văn bản gốc), không giải thích, không bọc trong code block.`;

const ANALYZE_SYSTEM = `Bạn là chuyên gia tối ưu chatbot bán hàng. Dưới đây là hướng dẫn hiện tại của bot cho một page và các hội thoại gần đây (tin của khách và tin trả lời của page/bot).
Hãy phân tích và trả lời bằng tiếng Việt, ngắn gọn, dạng danh sách:
1. Những câu hỏi khách hay hỏi mà hướng dẫn hiện tại chưa trả lời được hoặc trả lời chưa tốt.
2. Lỗi/điểm yếu trong cách bot đang trả lời (nếu thấy).
3. Đề xuất cụ thể 3–6 dòng nên THÊM vào "Hướng dẫn riêng cho page" (viết sẵn để copy vào), ví dụ câu trả lời mẫu, chính sách còn thiếu, cách xưng hô.
Không bịa thông tin shop; chỗ nào cần chủ shop điền thì ghi [cần điền].`;

export function createAdminHandler(bot) {
  const assistant = createAssistant(bot);
  return async function handleAdmin(req, res, url) {
    if (!url.pathname.startsWith("/admin") && !url.pathname.startsWith("/api/")) return false;

    if (!isLocal(req)) {
      const tok = req.headers["x-admin-token"] || url.searchParams.get("token");
      if (!config.adminToken || tok !== config.adminToken) {
        json(res, 403, { error: "Chi truy cap tu may chay bot (localhost) hoac can ADMIN_TOKEN" });
        return true;
      }
    }

    // ---- Chuyen du lieu tu may Windows len VPS (qua ERP) — xem src/erp-import.js
    if (url.pathname.startsWith("/api/erp/") && (await handleErpRoutes(req, res, url))) return true;

    // ---- Giao dien
    if (req.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      try {
        const html = fs.readFileSync(ADMIN_HTML);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
      } catch (e) {
        json(res, 500, { error: "Khong tim thay admin/index.html: " + e.message });
      }
      return true;
    }

    try {
      const m = (method, pattern) => {
        if (req.method !== method) return null;
        const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
        const r = url.pathname.match(re);
        return r ? Object.fromEntries(Object.entries(r.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])) : null;
      };
      let p;

      // ---- Tong quan
      if (m("GET", "/api/state")) {
        return json(res, 200, {
          ok: true,
          version: 2,
          global: {
            model: config.ai.model,
            dryRun: settings.globalDryRun(),
            dryRunSource: settings.global.dryRun === null ? ".env" : "app",
            poll: config.pollEnabled,
            pollIntervalSec: config.pollIntervalSec,
            webhookPath: config.webhookPath,
            humanTakeoverMinutes: config.humanTakeoverMinutes,
            minCustomerMessages: config.minCustomerMessages,
            commentMode: config.commentMode,
            orderSync: config.orderSync,
            commentPublicText: config.commentPublicText,
            pauseTagName: config.botPauseTagName,
            sendProductImages: config.sendProductImages,
            vision: config.vision.enabled,
          },
          catalog: { enabled: catalog.enabled, products: catalog.products.length, updatedAt: catalog.updatedAt || null },
          pages: [...bot.clients.keys()].map((id) => pageSummary(bot, id)),
        }), true;
      }

      if (m("POST", "/api/global")) {
        const body = await readJson(req);
        if ("dryRun" in body) settings.setGlobalDryRun(body.dryRun === null ? null : !!body.dryRun);
        return json(res, 200, { ok: true, dryRun: settings.globalDryRun() }), true;
      }

      if (m("POST", "/api/refresh")) {
        const r = await bot.refresh();
        return json(res, 200, { ok: true, ...r }), true;
      }

      if (m("GET", "/api/models")) {
        const models = await listModels();
        const names = models
          .map((x) => x.name.replace("models/", ""))
          .filter((n) => config.ai.provider === "openai" || (/^gemini/.test(n) && !/tts|image|transcribe|omni|robotics|computer-use|deep-research|antigravity|banana|customtools/.test(n)));
        return json(res, 200, { models: names }), true;
      }

      // ---- Tro ly AI (chat dieu khien bot)
      if (m("POST", "/api/assistant/chat")) {
        const body = await readJson(req);
        const history = Array.isArray(body.contents) && body.contents.length ? body.contents : Array.isArray(body.history) ? body.history : [];
        if (!history.length) return json(res, 400, { error: "Thieu noi dung" }), true;
        const out = await assistant.chat(history, { pageId: body.pageId ? String(body.pageId) : undefined });
        return json(res, 200, out), true;
      }

      // ---- Prompt chung
      if (m("GET", "/api/prompt")) return json(res, 200, { text: settings.readGlobalPrompt() }), true;
      if (m("PUT", "/api/prompt")) {
        const body = await readJson(req);
        if (typeof body.text !== "string" || body.text.trim().length < 50) return json(res, 400, { error: "Prompt qua ngan" }), true;
        settings.writeGlobalPrompt(body.text);
        return json(res, 200, { ok: true }), true;
      }

      // ---- Catalog
      if (m("GET", "/api/catalog")) return json(res, 200, { enabled: catalog.enabled, updatedAt: catalog.updatedAt, products: catalog.products, text: catalog.toPromptText() }), true;
      if (m("POST", "/api/catalog/refresh")) {
        const products = await catalog.refresh();
        return json(res, 200, { ok: true, products: products.length, updatedAt: catalog.updatedAt }), true;
      }

      // ---- Log
      if (m("GET", "/api/logs")) return json(res, 200, { logs: logRing.slice(-300) }), true;
      if (m("GET", "/api/events")) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        logEvents.on("log", send);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => {
          logEvents.off("log", send);
          clearInterval(ping);
        });
        return true;
      }

      // ---- Them / go page bang token Pancake (khong can sua .env, khong can khoi dong lai)
      const checkPageToken = (token) => {
        token = String(token || "").trim();
        if (!token) throw new Error("Chua dan token");
        if (/^EAA/i.test(token)) throw new Error("Day la token Facebook (EAA...), khong phai Page Access Token cua Pancake (dang eyJ...). Lay trong Pancake: mo page -> Cai dat -> Cong cu -> Page Access Token");
        return token;
      };
      if (m("POST", "/api/pages")) {
        const body = await readJson(req);
        const token = checkPageToken(body.token);
        const pageId = String(body.pageId || body.page_id || "").trim();
        if (!/^\d{5,}$/.test(pageId)) throw new Error("Page ID phai la day so (lay o dia chi page trong Pancake, vi du 1115433011652980)");
        let r;
        try {
          r = await bot.addPage(pageId, token, body.name || ""); // nem loi neu token sai -> khong luu
        } catch (e) {
          throw new Error(`Pancake khong chap nhan token nay cho page ${pageId} (token sai, het han, hoac khong phai token cua page nay). Chi tiet: ${e.message}`);
        }
        saveAppPage(pageId, { token, name: body.name || "" });
        return json(res, 200, { ok: true, ...r, page: pageSummary(bot, pageId) }), true;
      }
      // Liet ke page cua tai khoan bang User Access Token (Pancake -> Cai dat ca nhan -> Access token)
      if (m("POST", "/api/pages/lookup")) {
        const body = await readJson(req);
        const userToken = String(body.userToken || "").trim();
        if (!userToken) throw new Error("Chua dan User Access Token");
        const data = await listPages(userToken);
        const raw = data?.categorized?.activated || data?.pages || data?.data || [];
        const pages = raw
          .filter((x) => x?.id)
          .map((x) => ({ id: String(x.id), name: String(x.name || x.page_name || "").trim(), platform: x.platform || "", added: bot.clients.has(String(x.id)) }));
        return json(res, 200, { pages }), true;
      }
      // Sinh Page Access Token cho cac page da chon bang User Access Token roi them vao bot
      if (m("POST", "/api/pages/from-user")) {
        const body = await readJson(req);
        const userToken = String(body.userToken || "").trim();
        const ids = (Array.isArray(body.pageIds) ? body.pageIds : []).map(String).filter(Boolean);
        if (!userToken || !ids.length) throw new Error("Thieu User Access Token hoac chua chon page");
        const results = [];
        for (const id of ids) {
          try {
            const t = await generatePageAccessToken(userToken, id);
            const token = t?.page_access_token || t?.access_token || t?.token;
            if (!token) throw new Error("Pancake khong tra ve page_access_token: " + JSON.stringify(t).slice(0, 200));
            const name = (body.names && body.names[id]) || "";
            const r = await bot.addPage(id, token, name);
            saveAppPage(id, { token, name });
            results.push({ id, ok: true, name: r.name, conversations: r.conversations });
          } catch (e) {
            results.push({ id, ok: false, error: e.message });
          }
        }
        return json(res, 200, { ok: results.every((r) => r.ok), results }), true;
      }
      if ((p = m("DELETE", "/api/pages/:id"))) {
        if (!bot.clients.has(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        if (config.pages[p.id]?.source !== "app") return json(res, 400, { error: "Page nay khai bao trong .env (PANCAKE_PAGES_JSON); muon go thi sua .env roi khoi dong lai bot" }), true;
        removeAppPage(p.id);
        if (config.pages[p.id]) {
          // van con trong .env -> quay ve dung token .env
          await bot.addPage(p.id, config.pages[p.id].token, config.pages[p.id].name).catch((e) => log.warn(`[${p.id}] Token trong .env khong dung: ${e.message}`));
        } else bot.removePage(p.id);
        return json(res, 200, { ok: true, stillInEnv: !!config.pages[p.id] }), true;
      }

      // ---- Tung page
      if ((p = m("GET", "/api/pages/:id"))) {
        if (!bot.clients.has(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        return json(res, 200, { ...pageSummary(bot, p.id), recent: store.getRecent(p.id) }), true;
      }
      if ((p = m("PUT", "/api/pages/:id/settings"))) {
        if (!bot.clients.has(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        const saved = settings.update(p.id, body);
        if ("displayName" in body) bot.applyPageName(p.id);
        return json(res, 200, { ok: true, settings: saved, effective: settings.effective(p.id), name: bot.pageNames.get(p.id) }), true;
      }
      if ((p = m("GET", "/api/pages/:id/prompt"))) {
        const full = bot.buildSystemPrompt(p.id, { customerName: "Khách", type: "INBOX" });
        return json(res, 200, { text: full }), true;
      }
      if ((p = m("GET", "/api/pages/:id/conversations"))) {
        const client = bot.getClient(p.id);
        if (!client) return json(res, 404, { error: "page khong ton tai" }), true;
        const r = await client.getConversations({ type: "INBOX", order_by: "updated_at" });
        const list = (r.conversations || []).slice(0, 30).map((cv) => ({
          id: cv.id,
          customer: cv.from?.name || "",
          snippet: stripHtml(cv.snippet || "").slice(0, 120),
          updatedAt: cv.updated_at,
          lastBy: String(cv.last_sent_by?.id) === p.id ? "page" : "customer",
          lastByName: cv.last_sent_by?.admin_name || cv.last_sent_by?.name || "",
          tags: (cv.tags || []).filter(Boolean).map((t) => t.text || t.id),
          paused: bot.isPaused(cv.tags, p.id),
        }));
        return json(res, 200, { conversations: list }), true;
      }
      if ((p = m("GET", "/api/pages/:id/conversations/:cid/messages"))) {
        const client = bot.getClient(p.id);
        if (!client) return json(res, 404, { error: "page khong ton tai" }), true;
        const r = await client.getMessages(p.cid);
        const msgs = sortChrono(r.messages)
          .map((x) => ({
            id: x.id,
            at: x.inserted_at,
            from: bot.isFromPage(x, p.id) ? "page" : "customer",
            by: x.from?.admin_name || x.from?.name || "",
            bot: store.isBotMessage(x.id),
            automated: !!(x.from?.is_automated || x.from?.ai_generated),
            text: stripHtml(x.original_message || x.message),
            images: (x.attachments || []).filter((a) => a?.url && /photo|image/i.test(a.type || "")).map((a) => a.url),
          }));
        return json(res, 200, { customer: r.conv_from?.name || "", canInbox: r.can_inbox, messages: msgs }), true;
      }

      // ---- Chat thu voi bot cua page (khong dung Pancake)
      if ((p = m("POST", "/api/pages/:id/test-chat"))) {
        if (!bot.clients.has(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        const history = Array.isArray(body.history) ? body.history : [];
        const eff = settings.effective(p.id);
        // Chat thu cung phai theo dung luat: chi ap bang gia khuyen mai khi trong hoi thoai da co tin shop nhac toi khuyen mai
        const saleKeys = String(eff.saleTrigger || "").split("|").map((k) => k.trim().toLowerCase()).filter(Boolean);
        const saleActive = !!eff.saleEnabled && saleKeys.length > 0 && history.some((h) => h.role === "model" && saleKeys.some((k) => String(h.text || "").toLowerCase().includes(k)));
        let sys = bot.buildSystemPrompt(p.id, { customerName: body.customerName || "Khách test", type: "INBOX", saleActive });
        // Chat thu cung tra bang size bang code nhu khi chat that
        const msTest = history.map((h) => ({ from: { id: h.role === "model" ? p.id : "KHACH" }, message: String(h.text || "") }));
        sys += bot.sizeHintFor(p.id, msTest);
        if (bot.orderClosedIn(p.id, msTest)) {
          sys += `\n\n## ĐƠN CỦA KHÁCH NÀY ĐÃ CHỐT XONG\n- TUYỆT ĐỐI KHÔNG hỏi lại chiều cao, cân nặng, size, số điện thoại hay địa chỉ nữa. Chỉ xác nhận ngắn gọn và cảm ơn; khách xin đổi ngày giao/địa chỉ/size thì xác nhận rồi thêm [[HANDOFF]]. Khách chê phí ship / đòi bớt sau khi chốt: miễn phí ship ngay, nêu tổng mới, KHÔNG hỏi "giữ đơn hay lên combo", KHÔNG đề nghị hủy.
- Khách chỉ cảm ơn, nói ok, chào xã giao: đáp lại ĐÚNG MỘT câu ngắn rồi dừng. TUYỆT ĐỐI KHÔNG hỏi \"cần em hỗ trợ thêm gì không\" nữa, không mời chào thêm, không kéo dài hội thoại.`;
        }
        // Khach che phi ship sau khi chot -> cau chuan mien ship (giong luong chat that)
        const mienShip = bot.freeShipReplyIfComplaint(p.id, msTest);
        const r = mienShip ? { text: mienShip, usage: {}, finishReason: "GUARD" } : await generateReply(sys, history, { model: eff.model, temperature: eff.temperature });
        let text = r.text;
        // Chan chot don khi con thieu SDT/dia chi, giong het luong chat that
        const thieu = missingOrderFields(text);
        if (thieu.length) {
          const r2 = await generateReply(
            sys + `

## CẢNH BÁO TỪ HỆ THỐNG
Câu trả lời trước là bản tóm tắt chốt đơn nhưng còn TRỐNG: ${thieu.join(", ")}. Khách chưa cung cấp. TUYỆT ĐỐI không gửi bản tóm tắt chốt đơn khi còn thiếu; hãy hỏi xin ${thieu.join(" và ")} một cách ngắn gọn, không bịa.`,
            history,
            { model: eff.model, temperature: 0.2 }
          );
          text = missingOrderFields(r2.text).length ? `Dạ mình cho em xin ${thieu.join(" và ")} để em lên đơn gửi hàng cho mình nha ❤️` : r2.text;
        }
        // Chan chot don voi mau khach chua chon, giong het luong chat that
        const mauChuaChon = bot.unconfirmedColorInSummary(text, p.id, msTest);
        if (mauChuaChon) {
          const r4 = await generateReply(
            sys + `\n\n## CẢNH BÁO TỪ HỆ THỐNG\nCâu trả lời trước là bản tóm tắt chốt đơn ghi màu "${mauChuaChon.color}", nhưng khách CHƯA HỀ chọn màu. Mẫu ${mauChuaChon.code} có các màu: ${mauChuaChon.colors.join(", ")}. TUYỆT ĐỐI không tự chọn màu thay khách và KHÔNG gửi bản tóm tắt chốt đơn; hãy hỏi khách lấy màu nào.`,
            history,
            { model: eff.model, temperature: 0.2 }
          );
          text = r4.text && !bot.unconfirmedColorInSummary(r4.text, p.id, msTest) && !isOrderSummaryReply(r4.text, false) ? r4.text : bot.askColorReply(p.id, mauChuaChon.colors);
        }
        // Chot chan gia giong luong chat that (ke ca mau khong thuoc dot xa kho)
        const ctxGia = { customerName: body.customerName || "Khách test", type: "INBOX" };
        const ref = bot.priceReferenceFor(p.id, text, sys, saleActive, ctxGia);
        const badPrices = bot.findDisallowedPrices(text, ref.prompt);
        if (badPrices.length) {
          const r3 = await generateReply(
            sys + `\n\n## CẢNH BÁO TỪ HỆ THỐNG\n${ref.nonSaleModels.length ? `Mẫu ${ref.nonSaleModels.join(", ")} KHÔNG nằm trong đợt xả kho. ` : ""}Câu trả lời trước nêu mức tiền ${badPrices.map((n) => n.toLocaleString("vi-VN") + "đ").join(", ")} KHÔNG có trong bảng giá áp dụng cho mẫu này. Viết lại với đúng giá thường của mẫu đó, không giảm thêm.`,
            history,
            { model: eff.model, temperature: 0.2 }
          );
          text = r3.text;
          if (bot.findDisallowedPrices(text, bot.priceReferenceFor(p.id, text, sys, saleActive, ctxGia).prompt).length) {
            text = "Dạ giá này là ưu đãi tốt nhất bên em rồi ạ, em không có quyền giảm thêm. Để em chuyển nhân viên hỗ trợ chị ngay nhé ❤️ [[HANDOFF]]";
          }
        }
        const handoff = text.includes(HANDOFF);
        text = text.replaceAll(HANDOFF, "");
        text = bot.fixSizeReply(text, p.id, msTest);
        text = bot.stripAskWhenClosed(text, p.id, msTest);
        if (bot.isPaymentInfoReply(text)) text = PAYMENT_GUARD_REPLY + " [[HANDOFF]]";
        // Chot don xong thi noi them tin cam on nhu luong chat that
        let daChaoChotDon = false;
        if (eff.afterOrderText && isOrderSummaryReply(text, handoff)) {
          text = `${text.trim()}

${eff.afterOrderText.trim()}`;
          daChaoChotDon = true;
        }
        if (!daChaoChotDon) text = bot.ensureEndsWithQuestion(text, p.id, msTest);
        text = bot.ensureQuoteImage(text, p.id, msTest);
        const ex = bot.extractImageRequests(text);
        return json(res, 200, { text: stripMarkdown(ex.text), handoff, imageRefs: ex.refs, imageUrls: ex.imageUrls, usage: r.usage, finishReason: r.finishReason }), true;
      }

      // ---- AI dieu chinh: sua huong dan rieng cua page (hoac prompt chung) theo yeu cau
      if ((p = m("POST", "/api/pages/:id/ai-adjust"))) {
        if (!bot.clients.has(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        const instruction = String(body.instruction || "").trim();
        if (!instruction) return json(res, 400, { error: "Thieu yeu cau" }), true;
        const target = body.target === "global" ? "global" : "page";
        const current = target === "global" ? settings.readGlobalPrompt() : settings.get(p.id).extraPrompt || "";
        const pageName = bot.pageNames.get(p.id) || p.id;
        const user =
          `Page: ${pageName}\n\n### Văn bản hiện tại (${target === "global" ? "prompt chung cho mọi page" : "hướng dẫn riêng cho page này; nếu đang trống hãy viết mới, ngắn gọn, chỉ gồm những gì yêu cầu"})\n` +
          (current.trim() || "(trống)") +
          `\n\n### Yêu cầu của chủ shop\n${instruction}`;
        const r = await generateReply(ADJUST_SYSTEM, [{ role: "user", text: user }], { temperature: 0.3, maxOutputTokens: 4096 });
        let proposed = r.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
        if (!proposed) return json(res, 500, { error: "AI khong tra ve noi dung" }), true;
        return json(res, 200, { target, current, proposed, usage: r.usage }), true;
      }

      // ---- AI phan tich hoi thoai gan day cua page -> goi y chinh sua
      if ((p = m("POST", "/api/pages/:id/ai-analyze"))) {
        const client = bot.getClient(p.id);
        if (!client) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        const limit = Math.min(Number(body.limit) || 8, 15);
        const r = await client.getConversations({ type: "INBOX", order_by: "updated_at" });
        const convs = (r.conversations || []).slice(0, limit);
        const transcripts = [];
        for (const cv of convs) {
          const mm = await client.getMessages(cv.id);
          const lines = sortChrono(mm.messages)
            .slice(-12)
            .map((x) => `${bot.isFromPage(x, p.id) ? "PAGE" : "KHÁCH"}: ${stripHtml(x.original_message || x.message).slice(0, 200) || "[đính kèm]"}`);
          transcripts.push(`--- Hội thoại với ${cv.from?.name || "khách"} ---\n${lines.join("\n")}`);
        }
        const eff = settings.effective(p.id);
        const user =
          `### Hướng dẫn hiện tại của bot (rút gọn)\nPage: ${bot.pageNames.get(p.id)}\nHướng dẫn riêng page: ${eff.extraPrompt || "(trống)"}\n\nPrompt chung (phần đầu):\n${settings.readGlobalPrompt().slice(0, 2500)}\n\n### ${transcripts.length} hội thoại gần đây\n${transcripts.join("\n\n")}`;
        const a = await generateReply(ANALYZE_SYSTEM, [{ role: "user", text: user }], { temperature: 0.3, maxOutputTokens: 2048 });
        return json(res, 200, { analysis: a.text, conversations: transcripts.length, usage: a.usage }), true;
      }

      // ---- Gui tin thu cong (nhan vien tra loi tu app)
      if ((p = m("POST", "/api/pages/:id/conversations/:cid/send"))) {
        const client = bot.getClient(p.id);
        if (!client) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        const text = String(body.text || "").trim();
        if (!text) return json(res, 400, { error: "Thieu noi dung" }), true;
        const r = await bot.sendComposed(p.id, p.cid, text);
        return json(res, 200, { ok: true, ...r }), true;
      }
      // ---- Cham soc khach chua mua (gui hang loat)
      // Tra loi ngay 1 hoi thoai cu the (tu man hinh "Khach dang cho")
      if ((p = m("POST", "/api/pages/:id/conversations/:cid/reply-now"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        bot.queue.push(`${p.id}:${p.cid}`, { pageId: p.id, conversationId: p.cid, type: "INBOX", force: true });
        log.info(`[${p.id}] ${p.cid}: nguoi dung bam "Tra loi ngay" trong app`);
        return json(res, 200, { ok: true }), true;
      }

      // ----- Quet lai tin khach chua duoc tra loi -----
      if (m("POST", "/api/catchup")) {
        const b = await readJson(req);
        const r = await bot.catchUp({ pageId: b.pageId || "", hours: Math.max(1, Math.min(72, Number(b.hours) || 6)), max: Math.max(1, Math.min(500, Number(b.max) || 200)), dryScan: !!b.dryScan, deep: b.deep !== false });
        return json(res, 200, r), true;
      }

      // ----- Doi chieu don POS voi tin nhan khach -----
      if (m("GET", "/api/audit/status")) return json(res, 200, { ...orderAudit.status(), statusNames: STATUS_NAMES }), true;
      if (m("POST", "/api/audit/start")) {
        const b = await readJson(req);
        return json(res, 200, orderAudit.start(bot, { days: Number(b.days) || 7, status: Number(b.status ?? 1), pageId: b.pageId || "", maxOrders: Math.max(1, Math.min(500, Number(b.maxOrders) || 100)), useAI: b.useAI !== false })), true;
      }
      if (m("POST", "/api/audit/stop")) return json(res, 200, orderAudit.stop()), true;
      if (m("POST", "/api/audit/fix")) {
        const b = await readJson(req);
        const r = await orderAudit.fix(b.orderId);
        return json(res, 200, r), true;
      }

      if ((p = m("GET", "/api/pages/:id/broadcast/scan"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const q = url.searchParams;
        const days = Math.max(1, Math.min(60, Number(q.get("days")) || 7));
        const r = await broadcast.scan(bot, p.id, {
          days,
          from: q.get("from") ? Number(q.get("from")) : undefined,
          to: q.get("to") ? Number(q.get("to")) : undefined,
          hourFrom: q.get("hourFrom") || "",
          hourTo: q.get("hourTo") || "",
          keyword: q.get("keyword") || "",
          noPhoneOnly: q.get("noPhone") !== "0",
          customerLastOnly: q.get("customerLast") === "1",
        });
        return json(res, 200, r), true;
      }
      if ((p = m("GET", "/api/pages/:id/broadcast/status"))) return json(res, 200, broadcast.status(p.id)), true;
      if ((p = m("POST", "/api/pages/:id/broadcast/start"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        return json(res, 200, broadcast.start(bot, p.id, { ids: body.ids, text: body.text, perMinute: body.perMinute, skipRecentDays: body.skipRecentDays })), true;
      }
      if ((p = m("POST", "/api/pages/:id/broadcast/stop"))) return json(res, 200, broadcast.stop(p.id)), true;

      // ---- Bam khach chua chot (sales agent)
      if ((p = m("GET", "/api/pages/:id/followup/scan"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const q = url.searchParams;
        const r = await salesAgent.scan(bot, p.id, {
          days: Math.max(1, Math.min(90, Number(q.get("days")) || 30)),
          max: Math.max(10, Math.min(300, Number(q.get("max")) || 150)),
          onlyEligible: q.get("onlyEligible") === "1",
        });
        return json(res, 200, { ...r, config: followupConfig(p.id), sentToday: store.countFollowupToday(p.id), stages: STAGES }), true;
      }
      if ((p = m("POST", "/api/pages/:id/followup/preview"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        if (!body.conversationId) return json(res, 400, { error: "Thieu conversationId" }), true;
        const r = await salesAgent.compose(bot, p.id, String(body.conversationId), { force: !!body.force });
        return json(res, 200, r), true;
      }
      if ((p = m("GET", "/api/pages/:id/followup/status"))) return json(res, 200, salesAgent.status(p.id)), true;
      if ((p = m("POST", "/api/pages/:id/followup/start"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const body = await readJson(req);
        return json(res, 200, salesAgent.start(bot, p.id, { ids: body.ids, perMinute: body.perMinute })), true;
      }
      if ((p = m("POST", "/api/pages/:id/followup/stop"))) return json(res, 200, salesAgent.stop(p.id)), true;
      if ((p = m("POST", "/api/pages/:id/followup/exclude"))) {
        const body = await readJson(req);
        if (!body.conversationId) return json(res, 400, { error: "Thieu conversationId" }), true;
        return json(res, 200, { ok: true, state: store.stopFollowup(String(body.conversationId), body.stopped !== false) }), true;
      }

      if ((p = m("POST", "/api/pages/:id/conversations/:cid/sync-order"))) {
        if (!bot.getClient(p.id)) return json(res, 404, { error: "page khong ton tai" }), true;
        const r = await bot.syncOrderForConversation(p.id, p.cid);
        return json(res, 200, r), true;
      }
      if ((p = m("POST", "/api/pages/:id/conversations/:cid/pause"))) {
        const client = bot.getClient(p.id);
        const tag = bot.pauseTagId(p.id);
        if (!client || !tag) return json(res, 400, { error: "Page chua co tag tat bot" }), true;
        const body = await readJson(req);
        if (body.paused === false) await client.removeTag(p.cid, tag);
        else await client.addTag(p.cid, tag);
        return json(res, 200, { ok: true }), true;
      }

      return json(res, 404, { error: "not found" }), true;
    } catch (e) {
      log.error("Admin API loi:", e.message);
      json(res, 500, { error: e.message });
      return true;
    }
  };
}
