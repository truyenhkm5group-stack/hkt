import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";

/**
 * ═══════════ HÌNH DẠNG CÂU BÁO CÁO: BIỂU THỨC ĐẮT TÍNH MỘT LẦN ═══════════
 *
 * Hai chỗ chậm đo được trên production 28/09/2026 (ops perf-probe) có CÙNG một bệnh: một biểu thức
 * regex được CHÉP vào nơi Postgres đánh giá nó lặp đi lặp lại cho từng dòng.
 *
 *  1. `carrierSubstateSql` chép biểu thức mã vào 29 vế `when` — kho dữ liệu học GTC dự phóng truyền
 *     vào một regex, nên mỗi dòng sự kiện ĐVVC chạy regex tới 29 lần (1,0–1,6 s mỗi cụm 1.000 kiện,
 *     có mặt trong gần mọi hàm báo cáo).
 *  2. Backtest điểm rủi ro trước khi gửi chạy regex trên SĐT của MỌI đơn cũ hơn, cho TỪNG đơn kiểm
 *     tra, bốn truy vấn con — 6,9 s trên 7,0 s của trang Phễu.
 *
 * Kết quả không đổi (bài kiểm TS ↔ SQL của trạng thái con và bài backtest giữ nguyên); bài này chỉ
 * khoá HÌNH DẠNG để bản vá không bị viết ngược lại một cách vô tình.
 */
export function testReportQueryShape() {
  const dialect = new PgDialect();

  // ───────── 1. Biểu thức mã xuất hiện đúng MỘT lần ─────────
  const ma = sql`nullif(regexp_replace(e.status, '[^0-9]', '', 'g'), '')::int`;
  const q = dialect.sqlToQuery(carrierSubstateSql(ma, sql`e.status_name`, sql`null::text`));
  const soLanRegex = (q.sql.match(/regexp_replace\(e\.status/g) ?? []).length;
  assert.equal(soLanRegex, 1, `biểu thức mã phải được tính MỘT lần (bảng con v.ma), không chép vào từng vế — thấy ${soLanRegex} lần`);
  const soLanChu = (q.sql.match(/e\.status_name/g) ?? []).length;
  assert.equal(soLanChu, 1, "biểu thức chữ cũng tính một lần (v.chu)");

  // ───────── 2. Backtest: không regex SĐT bên trong truy vấn con tương quan ─────────
  const src = readFileSync("lib/queries/preship-risk-backtest.ts", "utf8");
  for (const bi of ["oh", "oo"]) {
    assert.ok(
      !new RegExp(`regexp_replace\\(${bi}\\.bill_phone`).test(src),
      `backtest: regex trên ${bi}.bill_phone trong truy vấn con tương quan là quét-cả-bảng-mỗi-đơn — đọc cột duoi đã tính sẵn`,
    );
  }
  assert.match(src, /duoi_don as materialized/, "đuôi SĐT tính một lần cho mỗi đơn");
  assert.match(src, /duoi_ket_qua as materialized/, "phép nối kết quả ⋈ đơn giữ nguyên bội số, tính một lần");

  console.log("✓ Hình dạng câu báo cáo: biểu thức mã / chữ của trạng thái con tính một lần · backtest không regex SĐT trong truy vấn con tương quan");
}
