/**
 * ═══════════ CỚ AI RÚT LUI CÒN ĐÚNG KHÔNG ═══════════
 *
 * Bài này khoá đúng một tính chất, và nó là tính chất an toàn: **mã lạ rơi về nhánh HẸP NHẤT.**
 * Thêm một mã lý do ở `decide.ts` mà quên khai vào sổ thì nó phải là "không đụng tới", chứ không
 * phải "gỡ cờ" — một luật an toàn mặc định mở là một luật vô hại trên giấy.
 *
 * Hàm thuần trên chuỗi: không đồng hồ, không CSDL, không biến môi trường (luật 65).
 */
import assert from "node:assert/strict";
import { RECOVERY_RULES, classifyTakeover } from "@/lib/constants/takeover-recovery";

export function testTakeoverRecovery() {
  // Mã lạ, chuỗi rỗng, khoảng trắng — cả ba đều phải rơi về phía KHÔNG gỡ.
  for (const la of ["", "   ", "MOT_MA_CHUA_AI_NGHI_TOI", "low_confidence: chữ thường"]) {
    assert.equal(classifyTakeover(la).klass, "CAUSE_STANDS", `"${la}" phải rơi về nhánh hẹp nhất`);
  }
  assert.match(classifyTakeover("MA_LA").vi, /chưa được khai|hẹp nhất/, "phải nói rõ vì sao không gỡ");

  // Bảng số đo đã khai ⇒ cớ ấy chứng minh được là hết.
  assert.equal(
    classifyTakeover("SIZE_DATA_MISSING: Không gợi ý được size: ERP chưa có bảng số đo cho mẫu này").klass,
    "CAUSE_GONE",
  );

  // "Không hiểu khách muốn gì" KHÔNG được xếp cùng nhóm với "đã hỏi ba lần" — hai cái đầu cùng
  // mang mã LOW_CONFIDENCE nhưng một cái có thể đã hết cớ, cái kia thì không.
  const khongHieu = classifyTakeover("LOW_CONFIDENCE: Không hiểu được khách đang muốn gì");
  const hoiBaLan = classifyTakeover('LOW_CONFIDENCE: Đã hỏi "size" 3 lần mà chưa có câu trả lời dùng được');
  assert.equal(khongHieu.klass, "CAUSE_UNVERIFIED");
  assert.equal(hoiBaLan.klass, "CAUSE_STANDS");
  assert.notEqual(khongHieu.klass, hoiBaLan.klass, "cùng mã LOW_CONFIDENCE nhưng hai cớ khác nhau");

  // `CAUSE_UNVERIFIED` bắt buộc phải nói ĐO CÁI GÌ thì mới chuyển nhóm được — thiếu câu đó thì
  // nhóm này chỉ là một chỗ để việc nằm lại mãi mãi.
  for (const r of RECOVERY_RULES) {
    if (r.klass === "CAUSE_UNVERIFIED") assert.ok(r.cach && r.cach.length > 20, `${r.prefix}: thiếu cách chứng minh`);
    assert.ok(r.vi.length > 30, `${r.prefix}: thiếu câu giải thích đọc được`);
  }

  // Ba nhóm khách hàng phải xử lý tay — tuyệt đối không bao giờ gỡ.
  for (const p of ["PRICE_NEGOTIATION", "COMPLAINT", "AFTER_SALES"]) {
    assert.equal(classifyTakeover(`${p}: gì đó`).klass, "CAUSE_STANDS", `${p} không bao giờ được gỡ`);
  }

  console.log(
    `✓ Cớ AI rút lui: mã lạ · rỗng · sai kiểu chữ đều rơi về KHÔNG GỠ · cùng mã LOW_CONFIDENCE tách thành hai nhóm khác nhau · ${RECOVERY_RULES.length} luật khai đủ câu giải thích`,
  );
}
