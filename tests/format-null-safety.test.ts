import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MISSING_TEXT, NOT_APPLICABLE_TEXT, formatNumber, formatPercent, formatVND, pct, pctOrNull } from "@/lib/format";

/**
 * ═══════ CHƯA BIẾT KHÔNG ĐƯỢC IN RA THÀNH 0 ═══════
 *
 * Tầng truy vấn của kho mã này giữ `NULL` rất kỹ — `metricTrust` có `UNKNOWN` riêng, `verdict()`
 * có `NOT_MEASURED` riêng, `stockKnown` / `cogsKnown` là cờ chứ không phải số 0. Bản cũ của
 * `lib/format.ts` xoá toàn bộ công sức đó ở phân đoạn cuối cùng bằng `Number(value ?? 0)`:
 * `formatVND(null)` in ra `0 ₫`.
 *
 * Bài kiểm này khoá hợp đồng ba trạng thái ở mức hành vi, và khoá luôn ở mức MÃ NGUỒN rằng cái
 * mặc định ẩn kia không quay lại — vì nó sẽ quay lại dưới dạng một dòng "cho gọn".
 */
export function testFormatNullSafety() {
  // ───────── 0 THẬT vẫn phải là 0 ─────────
  assert.equal(formatVND(0), "0 ₫", "0 đã đo được vẫn in ra 0 ₫");
  assert.equal(formatNumber(0), "0", "0 việc là một câu trả lời, không phải chỗ trống");
  assert.equal(formatPercent(0), "0.0%", "0% đã đo được vẫn in ra 0.0%");
  assert.equal(formatVND(0, { compact: true }), "0", "bản rút gọn của 0 vẫn là 0");

  // ───────── CHƯA BIẾT in ra dấu gạch, KHÔNG in ra 0 ─────────
  for (const missing of [null, undefined]) {
    assert.equal(formatVND(missing), MISSING_TEXT, `formatVND(${String(missing)}) phải là "—", không phải "0 ₫"`);
    assert.equal(formatVND(missing, { compact: true }), MISSING_TEXT, "bản rút gọn cũng không được bịa số 0");
    assert.equal(formatVND(missing, { sign: true }), MISSING_TEXT, "bản có dấu cũng vậy");
    assert.equal(formatNumber(missing), MISSING_TEXT, `formatNumber(${String(missing)}) phải là "—"`);
    assert.equal(formatPercent(missing), MISSING_TEXT, `formatPercent(${String(missing)}) phải là "—", không phải "0.0%"`);
  }

  // ───────── NaN / Infinity là dấu vết của phép chia cho 0, không phải một con số ─────────
  assert.equal(formatVND(Number.NaN), MISSING_TEXT, "NaN không được in ra 'NaN ₫'");
  assert.equal(formatNumber(Number.NaN), MISSING_TEXT, "NaN không được in ra 'NaN'");
  assert.equal(formatPercent(Number.NaN), MISSING_TEXT, "NaN không được in ra 'NaN%'");
  assert.equal(formatVND(Number.POSITIVE_INFINITY), MISSING_TEXT, "Infinity là lỗi chia cho 0, không phải 'rất nhiều tiền'");
  assert.equal(formatNumber(Number.NEGATIVE_INFINITY), MISSING_TEXT, "-Infinity cũng vậy");

  // ───────── SỐ ÂM giữ nguyên dấu, không rơi vào nhánh chưa biết ─────────
  assert.equal(formatVND(-1500), "-1.500 ₫", "lỗ vẫn phải hiện ra là lỗ");
  assert.equal(formatVND(-1500, { compact: true }), "-2k", "bản rút gọn giữ dấu âm");
  assert.equal(formatNumber(-7), "-7", "số âm không phải chưa biết");
  assert.equal(formatPercent(-12.34), "-12.3%", "tăng trưởng âm là một con số có thật");
  assert.equal(formatVND(1500, { sign: true }), "+1.500 ₫", "tuỳ chọn dấu vẫn chạy");

  // ───────── SỐ LỚN ─────────
  assert.equal(formatVND(1_234_567_890), "1.234.567.890 ₫", "tiền VND in đủ chữ số, không rút gọn ngầm");
  assert.equal(formatVND(1_234_567_890, { compact: true }), "1.23 tỷ", "bản rút gọn của số tỷ");
  assert.equal(formatVND(2_500_000, { compact: true }), "2.5 tr", "bản rút gọn của số triệu");
  assert.equal(formatNumber(9_876_543), "9.876.543", "số lượng lớn vẫn có dấu phân cách nghìn");
  assert.equal(formatVND(Number.MAX_SAFE_INTEGER), "9.007.199.254.740.991 ₫", "số nguyên lớn nhất vẫn là số hữu hạn");

  // ───────── CHUỖI RỖNG là CHƯA BIẾT, không phải 0 ─────────
  // Trình điều khiển Postgres trả kiểu `numeric` về dưới dạng chuỗi; `Number("")` ra 0 là đúng
  // cái bẫy đang sửa, nên nhánh này phải được xử lý riêng.
  assert.equal(formatVND("" as unknown as number), MISSING_TEXT, "chuỗi rỗng không phải 0 đồng");
  assert.equal(formatVND("  " as unknown as number), MISSING_TEXT, "chuỗi toàn khoảng trắng cũng vậy");
  assert.equal(formatVND("12345" as unknown as number), "12.345 ₫", "chuỗi số vẫn đọc được — kiểu numeric của Postgres");

  // ───────── CHỮ THAY THẾ KHI CHƯA BIẾT ─────────
  assert.equal(formatVND(null, { missing: "chưa đo được" }), "chưa đo được", "nơi gọi được đặt tên riêng cho chỗ trống");
  assert.equal(formatNumber(null, { missing: NOT_APPLICABLE_TEXT }), "N/A", "'không áp dụng' khác 'chưa biết' — nơi gọi tự chọn");
  assert.equal(formatVND(0, { missing: "chưa đo được" }), "0 ₫", "có chữ thay thế vẫn KHÔNG được nuốt mất số 0 thật");

  // ───────── MẪU SỐ 0: `pctOrNull` nói CHƯA CÓ MẪU, `pct` nói 0 cho việc vẽ ─────────
  assert.equal(pctOrNull(0, 0), null, "chưa đơn nào có kết quả cuối ⇒ tỷ lệ CHƯA BIẾT, không phải 0%");
  assert.equal(pctOrNull(5, 0), null, "mẫu số 0 thì tử số bao nhiêu cũng không ra tỷ lệ");
  assert.equal(pctOrNull(null, 10), null, "tử số chưa biết thì tỷ lệ chưa biết");
  assert.equal(pctOrNull(3, 4), 75, "có mẫu số thì tính bình thường");
  assert.equal(pctOrNull(0, 4), 0, "0 trên 4 là 0% THẬT — đã đo, kết quả bằng không");
  assert.equal(formatPercent(pctOrNull(0, 0)), MISSING_TEXT, "và nối vào hàm in ra thì thành '—'");
  assert.equal(pct(0, 0), 0, "`pct` giữ nguyên 0 cho bề rộng thanh biểu đồ — đó là lý do nó còn tồn tại");

  // ───────── KHOÁ Ở MỨC MÃ NGUỒN ─────────
  // Hành vi đúng hôm nay không ngăn được ai đó viết lại `?? 0` "cho gọn" vào tuần sau. Bài kiểm
  // đọc chính tệp định dạng và chặn cái mặc định ẩn đó quay lại.
  const src = readFileSync(new URL("../lib/format.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export const MISSING_TEXT"));
  assert.ok(
    !/Number\(\s*value\s*\?\?\s*0\s*\)/.test(body),
    "lib/format.ts không được quy CHƯA BIẾT về 0 bằng `Number(value ?? 0)` — đó chính là lỗi bản này sửa",
  );
  assert.ok(body.includes("function finiteOrNull"), "phải đi qua `finiteOrNull` — một cửa duy nhất quyết định 'có phải số không'");

  console.log("✓ Định dạng: 0 thật in ra 0, chưa biết in ra '—', NaN/Infinity/chuỗi rỗng không hoá thành 0");
}

if (process.argv[1] && /format-null-safety\.test\.ts$/.test(process.argv[1])) {
  testFormatNullSafety();
}
