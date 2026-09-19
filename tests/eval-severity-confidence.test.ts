/**
 * MỨC NGHIÊM TRỌNG và ĐỘ TIN CỦA HỆ THỐNG — hai thứ quyết định một phép so mô hình có nghĩa hay không.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ERROR_SEVERITIES,
  EVAL_ERROR_KEYS,
  EVAL_ERROR_KINDS,
  SEVERITY_WEIGHT,
  expectedHarm,
  isSerious,
  severityOf,
  summarizeHarm,
  worstSeverity,
} from "@/lib/constants/eval-severity";
import { EVAL_BUCKETS } from "@/lib/constants/sales-eval-buckets";
import { overconfident, preferSystem, systemConfidence } from "@/lib/constants/system-confidence";

test("một tỷ lệ đúng/sai chung KHÔNG được che mất lỗi nghiêm trọng", () => {
  /*
    Hai mô hình cùng sai 10%. Mô hình A sai toàn câu chữ; mô hình B sai toàn chốt-đơn-khi-khách-
    chưa-đồng-ý. Tỷ lệ chính xác nói chúng như nhau. Phép đo phải nói chúng KHÔNG như nhau.
  */
  const A = Array.from({ length: 10 }, (_, i) => ({ errors: i === 0 ? (["WORDING"] as const satisfies readonly (keyof typeof EVAL_ERROR_KINDS)[]).slice() : [] }));
  const B = Array.from({ length: 10 }, (_, i) => ({ errors: i === 0 ? (["CONFIRMED_WITHOUT_CUSTOMER"] as const satisfies readonly (keyof typeof EVAL_ERROR_KINDS)[]).slice() : [] }));
  const a = summarizeHarm(A);
  const b = summarizeHarm(B);
  assert.equal(a.withError, b.withError, "tỷ lệ sai bằng nhau — đúng như tiền đề");
  assert.ok(b.totalHarm > a.totalHarm * 50, "nhưng kỳ vọng thiệt hại phải cách nhau rất xa");
  assert.equal(a.seriousRate, 0, "câu chữ vụng không phải lỗi nghiêm trọng");
  assert.equal(b.seriousRate, 0.1);

  // Khoảng cách giữa các mức phải LỚN DẦN, không đều. Để đều thì ba lỗi câu chữ "nặng bằng" một
  // lỗi chốt nhầm đơn, và một mô hình viết mượt mà thỉnh thoảng tạo đơn sai sẽ thắng.
  assert.ok(SEVERITY_WEIGHT.CRITICAL / SEVERITY_WEIGHT.HIGH >= 4);
  assert.ok(SEVERITY_WEIGHT.HIGH / SEVERITY_WEIGHT.MEDIUM >= 4);
});

test("chưa chấm ca nào ⇒ tỷ lệ là CHƯA BIẾT, không phải 0%", () => {
  const rong = summarizeHarm([]);
  assert.equal(rong.seriousRate, null, "in '0% lỗi nghiêm trọng' từ số không ca là khẳng định mạnh nhất dựa trên bằng chứng yếu nhất");
  assert.equal(rong.harmPerCase, null);
  assert.equal(rong.evaluated, 0);
  // Và không lỗi nào ⇒ mức nặng nhất là `null`, không phải "LOW".
  assert.equal(worstSeverity([]), null);
});

test("sổ lỗi khai đủ, và mức khai theo HẬU QUẢ", () => {
  for (const k of EVAL_ERROR_KEYS) {
    const e = EVAL_ERROR_KINDS[k];
    assert.ok((ERROR_SEVERITIES as readonly string[]).includes(e.severity));
    assert.ok(e.why.length > 10, `${k} phải nói được hậu quả, không chỉ đặt tên`);
  }
  // Bốn loại đặc tả gọi tên là CRITICAL phải thật sự là CRITICAL.
  for (const k of ["WRONG_SKU_ORDERED", "WRONG_PRICE", "HALLUCINATED_STOCK", "CONFIRMED_WITHOUT_CUSTOMER", "WRONG_ACTION_SENT", "IGNORED_CANCELLATION"] as const) {
    assert.equal(severityOf(k), "CRITICAL", `${k} phải là CRITICAL`);
  }
  for (const k of ["WRONG_COLOR", "WRONG_SIZE", "WRONG_QUANTITY", "WRONG_PRODUCT", "MISSED_PURCHASE_INTENT", "MISSED_COMPLAINT"] as const) {
    assert.equal(severityOf(k), "HIGH", `${k} phải là HIGH`);
  }
  assert.ok(isSerious("HIGH") && isSerious("CRITICAL"));
  assert.ok(!isSerious("LOW") && !isSerious("MEDIUM"));

  // Nhiều lỗi trên một ca thì CỘNG: sai cả màu lẫn size tệ hơn sai mỗi màu, và `max` nói hai ca
  // ấy như nhau.
  assert.ok(expectedHarm(["WRONG_COLOR", "WRONG_SIZE"]) > expectedHarm(["WRONG_COLOR"]));
  assert.equal(worstSeverity(["WORDING", "WRONG_SIZE", "REASKED_KNOWN"]), "HIGH");
});

test("mười bốn nhóm câu đã có sẵn — không khai lại một danh sách thứ hai", () => {
  // Đặc tả liệt kê các nhóm phải so theo. Kho mã ĐÃ có chúng (`EVAL_BUCKETS`), nên bài kiểm này
  // khoá việc dùng lại thay vì để ai đó khai một danh sách thứ hai rồi hai bảng lệch nhau.
  assert.equal(EVAL_BUCKETS.length, 14);
  for (const c of ["PRICE", "COLOR_ASK", "SIZE_ASK", "VARIANT_PICK", "PURCHASE_INTENT", "CONFIRM_VANG", "CHANGE_CHOICE", "CONTACT", "COMPLAINT", "DELIVERY", "RETURN_EXCHANGE", "UNKNOWN_PRODUCT", "HANDOFF"]) {
    assert.ok(EVAL_BUCKETS.some((b) => b.key === c), `thiếu nhóm ${c}`);
  }
});

test("độ tin HỆ THỐNG dựng từ bằng chứng, giữ riêng khỏi độ tin MÔ HÌNH", () => {
  // Không dấu hiệu nào ⇒ CHƯA BIẾT. Đây là chỗ dễ vi phạm nhất vì 0 rất tiện.
  assert.equal(systemConfidence([]).value, null);

  const manh = systemConfidence(["EXACT_SKU", "EXPLICIT_COLOR", "EXPLICIT_SIZE", "EXPLICIT_CONFIRMATION", "CATALOG_MATCH"]);
  assert.ok(manh.value !== null && manh.value > 0.7);
  assert.ok(manh.why.includes("thuận:"), "một con số không kèm lý do thì không ai sửa được gì từ nó");

  // Dấu hiệu nghịch NẶNG HƠN: một mâu thuẫn chưa gỡ xoá được nhiều bằng chứng thuận, vì nó nói ta
  // đang hiểu sai một chỗ nào đó mà chưa biết chỗ nào.
  const conMauThuan = systemConfidence(["EXACT_SKU", "EXPLICIT_COLOR", "CONFLICTING_VARIANTS", "MISSING_CATALOG"]);
  assert.ok(conMauThuan.value !== null && conMauThuan.value < manh.value!);
  assert.ok(conMauThuan.why.includes("nghịch:"));

  // Size do MÁY suy ra là dấu hiệu NGHỊCH — nối thẳng với ca E của sổ nguồn.
  const suyRa = systemConfidence(["EXACT_SKU", "INFERRED_SIZE"]);
  const khachNoi = systemConfidence(["EXACT_SKU", "EXPLICIT_SIZE"]);
  assert.ok(suyRa.value! < khachNoi.value!, "size máy đoán phải làm GIẢM độ tin so với size khách tự chọn");
});

test("bộ định tuyến ƯU TIÊN độ tin hệ thống, và nói rõ con số đến từ đâu", () => {
  assert.deepEqual(preferSystem(0.9, 0.2), { value: 0.9, from: "SYSTEM" }, "có bằng chứng thì đọc bằng chứng");
  assert.deepEqual(preferSystem(null, 0.7), { value: 0.7, from: "MODEL" }, "chưa đọc được gì thì mới lùi về lời tự chấm của mô hình");
  assert.deepEqual(preferSystem(null, null), { value: null, from: "NONE" });

  /*
    CHỖ HAI CON SỐ LỆCH NHAU là chỗ đáng đọc nhất: mô hình rất tự tin trong khi hệ thống gần như
    không có bằng chứng nào — dấu hiệu kinh điển của một câu bịa trôi chảy. Trộn hai con số thành
    một trung bình là xoá đúng tín hiệu ấy, nên chúng phải ở riêng.
  */
  assert.equal(overconfident(0.1, 0.95), true);
  assert.equal(overconfident(0.9, 0.95), false, "cả hai cùng cao thì không có gì bất thường");
  assert.equal(overconfident(null, 0.95), false, "chưa đo được hệ thống thì KHÔNG kết luận là bịa");
});
