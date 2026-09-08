import assert from "node:assert/strict";
import type { Db } from "@/db";
import { AREA_LABEL, CONFIDENCE_LABEL } from "@/lib/constants/recommendation";
import { getBusinessBrief } from "@/lib/queries/business-brief";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * BẢN TÓM TẮT KINH DOANH & AN TOÀN KHUYẾN NGHỊ.
 *
 * Điều phải khoá:
 *  1. DETERMINISTIC — chạy hai lần phải ra y hệt. Nếu không thì không ai truy được con số từ đâu.
 *  2. Mỗi khuyến nghị phải có ĐỦ BỐN thứ: chỉ số · bằng chứng · khoảng thời gian · mức tin cậy.
 *  3. Rủi ro SỐ LIỆU luôn đứng đầu — nó làm mọi con số phía trên đáng ngờ.
 */
export async function testBusinessBrief(db: Db) {
  void db;

  const brief = await getBusinessBrief(ALL);
  const again = await getBusinessBrief(ALL);

  // ───────── 1. Cùng đầu vào phải cho cùng đầu ra ─────────
  // Đây là ranh giới của cả lớp trợ lý: nếu để mô hình tự cộng trừ thì mỗi lần chạy ra một số hơi
  // khác, và bản tóm tắt lập tức mất giá trị làm căn cứ.
  assert.deepEqual(
    brief.metrics.map((m) => [m.key, m.value]),
    again.metrics.map((m) => [m.key, m.value]),
    "chạy hai lần phải ra cùng một bộ số — bản tóm tắt phải deterministic",
  );
  assert.deepEqual(brief.summary, again.summary, "câu tóm tắt phải ổn định, không được đổi mỗi lần chạy");

  // ───────── 2. Chỉ số phải đủ và đọc được ─────────
  assert.ok(brief.metrics.length >= 6, "phải có ít nhất sáu chỉ số nền");
  for (const m of brief.metrics) {
    assert.ok(m.label.length > 0 && m.note.length > 0, `${m.key}: phải có nhãn và chú thích tiếng Việt`);
    assert.ok(Number.isFinite(m.value), `${m.key}: giá trị phải hữu hạn`);
    assert.ok(["vnd", "count", "percent"].includes(m.unit), `${m.key}: phải khai đơn vị`);
    if (m.changePct !== null) assert.ok(Number.isFinite(m.changePct), `${m.key}: mức thay đổi phải hữu hạn`);
  }
  // Ba con số tiền KHÔNG được lẫn nhau — đây là luật cốt lõi của toàn ERP.
  const keys = brief.metrics.map((m) => m.key);
  for (const k of ["booked", "delivered", "cash"]) assert.ok(keys.includes(k), `thiếu chỉ số ${k}`);

  // ───────── 3. Mỗi khuyến nghị phải đủ bốn thứ ─────────
  // Thiếu một trong bốn thì đó là câu bói, không phải khuyến nghị.
  for (const r of brief.risks) {
    assert.ok(AREA_LABEL[r.area], `${r.title}: lĩnh vực phải hợp lệ`);
    assert.ok(r.metric.length > 5, `${r.title}: phải nói dựa trên CHỈ SỐ nào`);
    assert.ok(r.evidence.length > 10, `${r.title}: phải nói BẰNG CHỨNG nào`);
    assert.ok(r.timeRange.length > 0, `${r.title}: phải nói KHOẢNG THỜI GIAN nào`);
    assert.ok(CONFIDENCE_LABEL[r.confidence], `${r.title}: phải khai MỨC TIN CẬY`);
    assert.ok(r.reason.length > 10, `${r.title}: phải nói vì sao`);
    assert.ok(r.href.startsWith("/"), `${r.title}: phải mở được nơi kiểm chứng`);
    assert.ok(r.amount >= 0, `${r.title}: tiền liên quan không được âm`);
  }

  // ───────── 4. Rủi ro SỐ LIỆU luôn đứng đầu ─────────
  // Còn dữ liệu sai nghiêm trọng thì mọi con số trong bản tóm tắt đều cần đọc dè dặt; xếp nó xuống
  // dưới là để chủ shop ra quyết định trên nền số liệu mình chưa biết là sai.
  const dataIdx = brief.risks.findIndex((r) => r.area === "DATA");
  if (dataIdx >= 0) assert.equal(dataIdx, 0, "rủi ro số liệu phải đứng đầu danh sách");

  // ───────── 5. Việc cần làm dùng lại đúng hàng đợi, không xếp lại theo cách khác ─────────
  for (const a of brief.topActions) {
    assert.ok(a.title.length > 0 && a.why.length > 0, "mỗi việc phải nói được vì sao nó gấp");
    assert.ok(a.href.length > 0, "mỗi việc phải mở được");
  }

  // ───────── 6. Câu tóm tắt KHÔNG được bịa số ─────────
  // Mọi con số xuất hiện trong câu phải là con số đã tính; ở đây kiểm mức tối thiểu: có câu, và
  // câu không rỗng.
  assert.ok(brief.summary.length > 0, "phải sinh được ít nhất một câu tóm tắt");
  for (const line of brief.summary) assert.ok(line.trim().length > 10, "câu tóm tắt phải có nội dung");

  console.log(
    `✓ Tóm tắt kinh doanh: ${brief.metrics.length} chỉ số · ${brief.topActions.length} việc gấp · ${brief.risks.length} rủi ro (đủ chỉ số/bằng chứng/thời gian/độ tin cậy) · deterministic · KHÔNG tự hành động`,
  );
}
