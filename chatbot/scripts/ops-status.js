#!/usr/bin/env node
/**
 * Trang thai bot chat theo TUNG PAGE — cho thao tac "chatbot-status" cua workflow Van hanh ERP tren VPS.
 * Chu shop 09/10/2026: "bot page linh tay khong chay a" — container khoe (Up, healthy) nhung khong ai
 * doc duoc page nao dang tat / chay thu / loi token tu GitHub, vi log cua bot khong co thao tac nao in ra.
 *
 * CHI DOC: goi /api/state + /api/logs cua chinh bot qua localhost (bot cho phep localhost, khong can khoa).
 * Log kho PUBLIC nen KHONG in: noi dung tin nhan, ten khach, huong dan rieng cua page, duong dan webhook.
 * Chi in: ten page (ten fanpage cong khai), cong tac, so dem, va dong loi da CHE moi day so >= 5 chu so
 * (SDT, ma hoi thoai) va moi chuoi trong ngoac kep (cau chu khach / ten).
 */
const PORT = process.env.PORT || 3456;
const base = `http://127.0.0.1:${PORT}`;

async function get(path) {
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

/** Che du lieu ca nhan khoi mot dong log: day so dai, chuoi trong ngoac, email; cat ngan. */
export function sanitize(msg) {
  return String(msg || "")
    .replace(/"[^"\n]*"/g, '"…"')
    .replace(/“[^”\n]*”/g, "“…”")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/\d{5,}/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

const on = (v) => (v ? "BẬT" : "tắt");
const gio = (t) => (t ? new Date(t).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "chưa có");

async function main() {
  const st = await get("/api/state");
  const { logs = [] } = await get("/api/logs").catch(() => ({ logs: [] }));
  const g = st.global || {};
  console.log(`== BOT CHAT · model ${g.model || "?"} · chạy thử toàn cục: ${on(g.dryRun)} · quét tin: ${on(g.poll)} mỗi ${g.pollIntervalSec ?? "?"}s · webhook: ${g.webhookPath ? "có" : "không"}`);
  console.log(`   Bot lên đơn: ${JSON.stringify(st.orderBotCounts || {})}`);
  const tu = logs[0]?.ts;
  console.log(`   Log trong bộ nhớ: ${logs.length} dòng${tu ? ` (từ ${gio(tu)})` : ""}`);
  for (const p of st.pages || []) {
    const e = p.effective || {};
    const today = p.stats?.today || {};
    const l7 = p.stats?.last7 || {};
    const cuaPage = logs.filter((x) => String(x.msg || "").includes(`[${p.id}]`));
    const loi = cuaPage.filter((x) => x.level === "warn" || x.level === "error");
    console.log("");
    console.log(`-- ${p.name || "(chưa có tên)"}${p.pancakeName && p.pancakeName !== p.name ? ` / ${p.pancakeName}` : ""} · id …${String(p.id).slice(-4)} · nguồn ${p.source}`);
    console.log(`   Bot: ${on(e.enabled)} · chạy thử (không gửi): ${on(e.dryRun)} · trả lời từ tin thứ ${e.minCustomerMessages ?? "?"} · nhường nhân viên ${e.humanTakeoverMinutes ?? "?"} phút · thẻ tắt bot: ${p.pauseTagId ? "có" : "không"} · mẫu chủ lực: ${e.defaultProduct || "—"}`);
    console.log(`   Hoạt động gần nhất: ${gio(p.stats?.lastActivity)}`);
    console.log(`   Hôm nay: ${Object.entries(today).map(([k, v]) => `${k}=${v}`).join(" ") || "(chưa có số)"}`);
    console.log(`   7 ngày: trả lời=${l7.replies ?? 0} nhường NV=${l7.skippedStaff ?? 0} bỏ tin đầu=${l7.skippedFirst ?? 0} chuyển người=${l7.handoffs ?? 0} đơn=${l7.orders ?? 0}`);
    console.log(`   Log trong bộ nhớ: ${cuaPage.length} dòng, ${loi.length} cảnh báo/lỗi`);
    const mau = [...new Set(loi.map((x) => sanitize(x.msg)))].slice(-6);
    for (const m of mau) console.log(`     ! ${m}`);
  }
  // Loi khong gan page (token Pancake, AI het han muc...) — chi mau da che
  const chung = [...new Set(logs.filter((x) => (x.level === "warn" || x.level === "error") && !/\[\d{5,}\]/.test(String(x.msg || ""))).map((x) => sanitize(x.msg)))].slice(-8);
  if (chung.length) {
    console.log("");
    console.log("-- Cảnh báo/lỗi chung (không gắn page):");
    for (const m of chung) console.log(`     ! ${m}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`Không đọc được trạng thái bot chat: ${sanitize(e.message)}`);
    process.exit(1);
  });
}
