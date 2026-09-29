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
import { summarizeAiCost, meteredUsage, perSdt } from "./aicost.js";

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
  const { prices, usdVnd } = settings.aiPricing();
  // Chi phi AI cua page: chi tu moc do (cung khung voi SDT), chia cho SDT moi cua page trong cung ngay.
  const meter = store.getMeter();
  const mUsage = meteredUsage(store.getAiUsage(pageId), meter, meter?.baseline?.[pageId]);
  const mDays = lastDays(7).filter((d) => !meter?.day || d >= meter.day);
  const ai7 = summarizeAiCost(mUsage, mDays, { prices, usdVnd, orders: mDays.reduce((n, d) => n + (st[d]?.orders || 0), 0) });
  const sdt7 = store.countPhones(mDays, pageId);
  const uo7 = store.countOrders(mDays, pageId);
  const sdtToday = store.countPhones([today], pageId);
  const aiToday = summarizeAiCost(mUsage, [today], { prices, usdVnd, orders: st[today]?.orders || 0 });
  return {
    id: pageId,
    ai: { last7: { ...ai7, sdt: sdt7, perSdtVnd: perSdt(ai7.costVnd, sdt7), uniqueOrders: uo7, perUniqueOrderVnd: perSdt(ai7.costVnd, uo7) }, today: { ...aiToday, sdt: sdtToday, perSdtVnd: perSdt(aiToday.costVnd, sdtToday) } },
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

/**
 * TONG CHI PHI AI ca shop theo ky (hom nay / 7 / 30 ngay lich, gio VN), CHIA CHO SO SDT khach de lai trong CUNG khung
 * gio: ca tu so va mau so chi tinh tu MOC DO (store.getMeter()). Truoc moc chi co tien ma khong co SDT; chia tien it
 * ngay cho don nhieu ngay tung ra "1d/don" — mot con so trong co ve dung nhung sai.
 *
 * Ben canh uoc tinh theo token, chu shop nhap TIEN THUC TRA (hoa don Google) cho mot khoang ngay; ERP chia cho so SDT
 * cua dung khoang do. Khoang bat dau truoc moc do => SDT khong du => khong chia (null), noi ro ly do.
 */
function lastDays(n) {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  return [...Array(n)].map((_, i) => new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10));
}
function daysBetween(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to) && out.length < 400; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function meteredAll() {
  const meter = store.getMeter();
  const out = {};
  for (const [id, byDay] of Object.entries(store.getAllAiUsage())) out[id] = meteredUsage(byDay, meter, meter?.baseline?.[id]);
  return out;
}
function mergeUsage(usage, days) {
  const gop = {};
  for (const byDay of Object.values(usage)) {
    for (const d of days) {
      for (const [model, t] of Object.entries(byDay[d] || {})) {
        const x = ((gop[d] ||= {})[model] ||= { calls: 0, input: 0, cached: 0, output: 0 });
        x.calls += t.calls || 0; x.input += t.input || 0; x.cached += t.cached || 0; x.output += t.output || 0;
      }
    }
  }
  return gop;
}
function withSdt(a, sdt, uniqueOrders) {
  return { ...a, sdt, perSdtVnd: perSdt(a.costVnd, sdt), uniqueOrders, perUniqueOrderVnd: perSdt(a.costVnd, uniqueOrders) };
}
/**
 * Tien AI cua CHINH hoi thoai ra tung don (don bot ghi POS gan nhat). Hoi thoai bat dau truoc moc do (bot chi tra
 * loi hoi thoai trong 48 gio) co the da ton tien truoc moc => in "≥" (partial), khong gia vo la du.
 */
function orderCosts(bot, pricing, meter) {
  const rows = store.recentBotOrders(40).map((o) => {
    const conv = o.c ? store.getConvAi(o.c) : null;
    const a = conv ? summarizeAiCost({ d: conv.m }, ["d"], { ...pricing, orders: 0 }) : null;
    const early = !!(conv && meter?.since && conv.first - meter.since < 48 * 3600e3);
    return { id: o.id, page: bot.pageNames.get(o.p) || o.p, at: o.t, calls: a?.calls ?? 0, costVnd: a ? a.costVnd : null, partial: !!(a?.partial || early) };
  });
  const known = rows.filter((r) => r.costVnd !== null && r.calls > 0).map((r) => r.costVnd).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor((known.length - 1) / 2)] : null;
  const avg = known.length ? Math.round(known.reduce((n, x) => n + x, 0) / known.length) : null;
  return { rows, median, avg, sample: known.length, partial: rows.some((r) => r.partial) };
}
function shopAiCost(bot) {
  const pricing = settings.aiPricing();
  const meter = store.getMeter();
  const usage = meteredAll();
  const orderOf = (id, days) => {
    const st = store.getStats(id);
    return days.reduce((n, d) => n + (st[d]?.orders || 0), 0);
  };
  const inMeter = (days) => days.filter((d) => !meter?.day || d >= meter.day);
  const periods = {};
  for (const [key, n] of [["today", 1], ["d7", 7], ["d30", 30]]) {
    const days = inMeter(lastDays(n));
    let orders = 0;
    for (const id of bot.clients.keys()) orders += orderOf(id, days);
    periods[key] = { ...withSdt(summarizeAiCost(mergeUsage(usage, days), days, { ...pricing, orders }), store.countPhones(days), store.countOrders(days)), fullWindow: days.length === n };
  }
  const d30 = inMeter(lastDays(30));
  const ids = new Set([...bot.clients.keys(), ...Object.keys(usage)]);
  const byPage = [...ids].map((id) => {
    const a = summarizeAiCost(usage[id] || {}, d30, { ...pricing, orders: id === "_khac" ? 0 : orderOf(id, d30) });
    const sdt = id === "_khac" ? 0 : store.countPhones(d30, id);
    const uo = id === "_khac" ? 0 : store.countOrders(d30, id);
    return { id, name: id === "_khac" ? "Ngoài hội thoại (trợ lý AI, đối chiếu đơn…)" : bot.pageNames.get(id) || id, calls: a.calls, costVnd: a.costVnd, partial: a.partial, orders: uo, perOrderVnd: perSdt(a.costVnd, uo), sdt, perSdtVnd: perSdt(a.costVnd, sdt) };
  }).filter((r) => r.calls > 0 || r.sdt > 0).sort((a, b) => (b.costVnd ?? -1) - (a.costVnd ?? -1));
  const bills = settings.aiBills().map((b) => {
    const days = daysBetween(b.from, b.to);
    const du = !meter?.day || b.from >= meter.day;
    const sdt = store.countPhones(days);
    const uo = store.countOrders(days);
    const est = summarizeAiCost(mergeUsage(usage, days), days, { ...pricing, orders: 0 });
    return { ...b, sdt: du ? sdt : null, perSdtVnd: du ? perSdt(b.amountVnd, sdt) : null, orders: du ? uo : null, perOrderVnd: du ? perSdt(b.amountVnd, uo) : null, estimateVnd: du ? est.costVnd : null, reason: du ? (sdt ? (meter?.day && b.from === meter.day ? "ngày đầu chỉ đếm SĐT từ lúc bắt đầu đo — số / SĐT có thể cao hơn thực tế" : "") : "chưa có SĐT nào trong khoảng này") : `SĐT chỉ đếm từ ${meter.day} — khoảng bắt đầu trước đó thì không chia được` };
  });
  return { ...periods.d7, periods, byPage, bills, orderCosts: orderCosts(bot, pricing, meter), meterSince: meter?.since || null };
}

/**
 * TRANG TONG QUAN: so tin bot tra loi + chi phi AI theo NGAY (30 ngay) va theo GIO (hom nay, cap nhat truc tiep).
 * Ba luat in so:
 *  - Ngay chua co bo dem token => chi phi CHUA BIET (null), khong phai 0d; ngay dau dem giua chung => "≥".
 *  - Don / SDT chi co tu moc do; ngay truoc moc => null.
 *  - Gio truoc luc bat dau dem theo gio => null (bieu do de trong), khong ve cot 0.
 */
function overview(bot) {
  const pricing = settings.aiPricing();
  const meter = store.getMeter();
  const raw = store.getAllAiUsage();
  const metered = meteredAll();
  const ids = [...bot.clients.keys()];
  const d30 = lastDays(30).reverse();
  const today = d30[d30.length - 1];
  const usageDays = Object.values(raw).flatMap((byDay) => Object.keys(byDay)).sort();
  const firstUsageDay = usageDays[0] || null;
  // Tin tra loi cong MOI page co thong ke (ke ca page da go: tin do van da gui that)
  const statIds = [...new Set([...ids, ...Object.keys(store.state.stats || {})])];
  const statSum = (d, key) => statIds.reduce((n, id) => n + (store.getStats(id)[d]?.[key] || 0), 0);
  const costOf = (d) => {
    if (meter?.day && d >= meter.day) return summarizeAiCost(mergeUsage(metered, [d]), [d], { ...pricing, orders: 0 });
    if (!firstUsageDay || d < firstUsageDay) return null;
    const a = summarizeAiCost(mergeUsage(raw, [d]), [d], { ...pricing, orders: 0 });
    return { ...a, partial: a.partial || d === firstUsageDay };
  };
  const days = d30.map((d) => {
    const a = costOf(d);
    const inMeter = !!(meter?.day && d >= meter.day);
    const orders = inMeter ? store.countOrders([d]) : null;
    const sdt = inMeter ? store.countPhones([d]) : null;
    const costVnd = a ? a.costVnd : null;
    return { day: d, replies: statSum(d, "replies"), handoffs: statSum(d, "handoffs"), calls: a?.calls ?? null, costVnd, partial: !!a?.partial, orders, sdt, perOrderVnd: perSdt(costVnd, orders || 0), perSdtVnd: perSdt(costVnd, sdt || 0) };
  });
  const { since: hourlySince, hours } = store.getHourly();
  const nowKey = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 13);
  const sinceKey = hourlySince ? new Date(hourlySince + 7 * 3600 * 1000).toISOString().slice(0, 13) : null;
  const hourly = [...Array(24)].map((_, h) => {
    const key = `${today}T${String(h).padStart(2, "0")}`;
    const known = !!sinceKey && key >= sinceKey && key <= nowKey;
    const b = hours[key] || {};
    const a = b.ai ? summarizeAiCost({ x: b.ai }, ["x"], { ...pricing, orders: 0 }) : null;
    return { hour: h, known, partial: known && key === sinceKey, replies: known ? b.replies || 0 : null, handoffs: known ? b.handoffs || 0 : null, costVnd: known ? (a ? a.costVnd : 0) : null, costPartial: !!a?.partial };
  });
  const pages = statIds.map((id) => {
    const a = summarizeAiCost(metered[id] || {}, [today], { ...pricing, orders: 0 });
    const st = store.getStats(id)[today] || {};
    const orders = store.countOrders([today], id);
    return { id, name: bot.pageNames.get(id) || id, replies: st.replies || 0, handoffs: st.handoffs || 0, costVnd: a.costVnd, partial: a.partial, orders, perOrderVnd: perSdt(a.costVnd, orders) };
  }).filter((p) => ids.includes(p.id) || p.replies || p.costVnd).sort((x, y) => y.replies - x.replies);
  const recent = ids.flatMap((id) => store.getRecent(id).slice(0, 12).map((r) => ({ page: bot.pageNames.get(id) || id, at: r.at, customer: r.customerName || "", question: r.question || "", reply: (r.reply || "").slice(0, 160), handoff: !!r.handoff, dryRun: !!r.dryRun })))
    .sort((a, b) => b.at - a.at).slice(0, 12);
  return { today: days[days.length - 1], days, hourly, hourlySince, meterSince: meter?.since || null, firstUsageDay, pages, recent, generatedAt: Date.now() };
}

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
      if (m("GET", "/api/overview")) {
        return json(res, 200, overview(bot)), true;
      }

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
          aiPricing: settings.aiPricing(),
          aiShop: shopAiCost(bot),
          pages: [...bot.clients.keys()].map((id) => pageSummary(bot, id)),
        }), true;
      }

      if (m("POST", "/api/global")) {
        const body = await readJson(req);
        if ("dryRun" in body) settings.setGlobalDryRun(body.dryRun === null ? null : !!body.dryRun);
        if ("aiPrices" in body || "usdVnd" in body) {
          try {
            settings.setAiPricing({ aiPrices: body.aiPrices, usdVnd: body.usdVnd });
          } catch (e) {
            return json(res, 400, { error: e.message }), true;
          }
        }
        if ("aiBills" in body) {
          try {
            settings.setAiBills(body.aiBills);
          } catch (e) {
            return json(res, 400, { error: e.message }), true;
          }
        }
        return json(res, 200, { ok: true, dryRun: settings.globalDryRun(), aiPricing: settings.aiPricing() }), true;
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
