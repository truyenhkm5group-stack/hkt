/**
 * ═══════════ TRANG CHI TIẾT ĐƠN / KHÁCH / HỘI THOẠI KHÔNG NÓI PANCAKE VỚI KHÁCH KHÔNG DÙNG PANCAKE (Commercial Sweep P0 động) ═══════════
 *
 * Kiểm 09/10/2026 trên sáu trang chi tiết (đọc mã, mọi lượt đọc qua getDb() của phiên — 0 rò tổ chức). Ở tổ chức không đồng bộ
 * Pancake (khách Chốt Đơn, HSLC), trang đơn của một đơn bot / đơn tay in:
 *  · «Khách đã trả trước 0 ₫ · Phí sàn 0 ₫ · Thu hộ (COD) 0 ₫» — ba ô của Pancake mà đơn tay KHÔNG BAO GIỜ ghi, trái với khung
 *    «Thanh toán» ngay bên dưới (ORDER_OUTCOME mục 11.1: tiền đơn tay đi theo chứng từ thanh toán);
 *  · «Gắn thẻ “SĐT mới” cho đơn trên Pancake…», «điền vào đơn trên Pancake» — chỉ dẫn tới phần mềm khách không có;
 *  · bộ đếm Pancake «0 Đơn · 0 Thành công · 0 Hoàn» cho chính khách vừa mua.
 * Trang khách in «Số liệu Pancake: 0 đơn · 0 ₫», «Điểm thưởng 0», «Tỷ lệ 0%» khi chưa có đơn; trang xem lại hội thoại in mã
 * sự kiện thô (`ai.replied`, `handoff.requested`…). Đây là CHỈ HIỂN THỊ: không đổi công thức tiền / kết quả đơn nào.
 *
 * Khoá ở mức mã nguồn (trang server cần phiên + thành phần async — không dựng được bằng renderToStaticMarkup):
 *  1. Mỗi chữ / ô của Pancake nằm SAU đúng điều kiện của nó (`copy.isHome` hoặc `manual ? null :`).
 *  2. Tỷ lệ của khách đi qua pctOrNull + formatPercent («—» khi chưa có đơn — AGENTS mục 42).
 *  3. Mọi loại sự kiện có tên tiếng Việt, và trang không in mã thô.
 *  4. Ghi chú cuối form đơn tay không còn chỉ tới lối «phiếu xuất kho» đã bỏ (ORDER_OUTCOME mục 11).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SALES_EVENT_LABEL, SALES_EVENT_TYPES } from "@/lib/sales-chatbot/events-shared";

const doc = (f: string) =>
  readFileSync(f, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** `needle` xuất hiện đúng một lần và đứng NGAY sau `guard` (cách tối đa `gap` ký tự). */
function guarded(src: string, guard: string, needle: string, gap: number, what: string) {
  const i = src.indexOf(needle);
  assert.ok(i >= 0, `${what}: không còn thấy «${needle.slice(0, 50)}» — bài kiểm lệch mã`);
  assert.equal(src.indexOf(needle, i + 1), -1, `${what}: «${needle.slice(0, 50)}» xuất hiện hơn một lần`);
  const g = src.lastIndexOf(guard, i);
  assert.ok(g >= 0 && i - g <= gap, `${what}: phải đứng sau điều kiện «${guard}»`);
}

export function testDetailPagesShell() {
  // 1a. Trang đơn.
  const don = doc("app/(dashboard)/orders/[id]/page.tsx");
  assert.match(don, /getBrandCopy\(user\)/, "trang đơn đọc copy.isHome từ máy chủ");
  guarded(don, "manual ? null :", 'label="Khách đã trả trước"', 40, "đơn tay không in «Khách đã trả trước 0 ₫»");
  guarded(don, "manual ? null :", 'label="Phí sàn"', 40, "đơn tay không in «Phí sàn 0 ₫»");
  guarded(don, "manual ? null :", "Thu hộ (COD)", 80, "đơn tay không in «Thu hộ (COD) 0 ₫»");
  guarded(don, "copy.isHome && !manual ?", "Gắn thẻ “SĐT mới” cho đơn trên Pancake", 400, "chỉ dẫn Pancake cho khách mới");
  guarded(don, "copy.isHome ?", " (cùng khách Pancake)", 20, "đơn cũ cùng khách");
  guarded(don, "manual ?", "điền vào đơn trên Pancake", 120, "lời nhắc điền địa chỉ");
  guarded(don, "order.customer && copy.isHome ?", "succeedOrderCount}</p>", 400, "bộ đếm Pancake của khách");
  guarded(don, "copy.isHome ?", "<JsonViewer value={order.raw} />", 20, "dữ liệu gốc Pancake của đơn");

  // 1b + 2. Trang khách.
  const khach = doc("app/(dashboard)/customers/[id]/page.tsx");
  guarded(khach, "copy.isHome ?", "Pancake ghi nhận (tham khảo", 250, "dòng «Pancake ghi nhận»");
  guarded(khach, "copy.isHome", '{ label: "Điểm thưởng"', 120, "ô «Điểm thưởng» của Pancake");
  guarded(khach, "ch.pageId && copy.isHome", "· page {ch.pageId}", 80, "mã page thô của hội thoại");
  // Tỷ lệ + trung bình là của truy vấn (đơn ĐÃ KẾT THÚC theo ORDER_OUTCOME, null khi chưa có); trang chỉ in, không tự chia.
  assert.ok(!/\bpct\(/.test(khach), "trang khách không tự chia tỷ lệ — pct() in «0%» khi chưa có đơn");
  assert.match(khach, /formatPercent\(stats\.successRate, 0\)/);
  assert.match(khach, /formatPercent\(stats\.returnRate, 0\)/);
  assert.ok(!khach.includes("trong ERP."), "trang khách: không nói «ERP» với khách");

  // 3. Hội thoại.
  for (const t of SALES_EVENT_TYPES) {
    assert.ok(SALES_EVENT_LABEL[t] && !SALES_EVENT_LABEL[t].includes("."), `sự kiện ${t} phải có tên tiếng Việt`);
  }
  const hoiThoai = doc("app/(dashboard)/ai/sales-chatbot/conversations/[id]/page.tsx");
  assert.ok(!/\{e\.type\}/.test(hoiThoai) && hoiThoai.includes("SALES_EVENT_LABEL[e.type"), "trang hội thoại không in mã sự kiện thô");
  assert.ok(!/\?\? e\.actor\}/.test(hoiThoai) && !/\?\? v\.channel\}/.test(hoiThoai), "không rơi về mã enum thô");
  guarded(hoiThoai, "v.arm && !khach", "nhánh thử nghiệm", 30, "nhánh thử nghiệm AI / người là việc đo của nền tảng");

  // 4. Trang sản phẩm mở bằng MÃ: ma trận + ghi chú tra theo product.id (getProductDetail khớp cả customId).
  const sp = doc("app/(dashboard)/products/[id]/page.tsx");
  assert.match(sp, /getProductMatrix\(product\.id,/, "ma trận màu × size tra theo product.id");
  assert.match(sp, /listProductNotes\(product\.id\)/, "ghi chú tra theo product.id");

  // 5. Form đơn tay.
  const form = doc("app/(dashboard)/orders/manual-order-form.tsx");
  assert.ok(!form.includes("phiếu xuất kho ở trang đơn"), "form đơn tay: lối «phiếu xuất kho» đã bỏ (ORDER_OUTCOME mục 11)");
  assert.ok(form.includes("phiếu giao") && form.includes("chứng từ thanh toán"));

  console.log(
    "  ✓ trang chi tiết: đơn tay không in trả trước / phí sàn / COD «0 ₫», chỉ dẫn + bộ đếm + dữ liệu gốc Pancake chỉ ở tổ chức Pancake · khách chưa có đơn ⇒ tỷ lệ «—» · diễn biến hội thoại bằng tiếng Việt · form đơn tay theo phiếu giao + chứng từ",
  );
}
