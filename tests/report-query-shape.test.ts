import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { carrierSubstate, eventStatusCode } from "@/lib/constants/carrier-substate";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";

/**
 * ═══════════ HÌNH DẠNG CÂU BÁO CÁO: VIỆC LẶP CHO TỪNG DÒNG ═══════════
 *
 * Hai chỗ chậm đo được trên production 28/09/2026 (ops perf-probe + EXPLAIN ANALYZE có đối chứng):
 *
 *  1. Kho dữ liệu học của GTC dự phóng tính trạng thái con ĐVVC trong Postgres cho TỪNG dòng sự kiện
 *     (~0,115 ms/dòng, 1,0–1,6 s mỗi cụm 1.000 kiện) trong khi cả sổ chỉ có 29 cặp (mã, chữ) khác
 *     nhau. Nay tính bằng bản TypeScript, nhớ theo cặp. Giả thuyết đầu tiên — "regex mã bị chép vào 29
 *     vế" — đã bị đo BÁC: chạy hai biểu thức trên cùng 21.402 dòng, cùng lúc, ra 0,116 ↔ 0,117 ms/dòng.
 *  2. Backtest điểm rủi ro: bốn truy vấn con TƯƠNG QUAN quét lại toàn bộ đơn cho TỪNG đơn kiểm tra.
 *     EXPLAIN ANALYZE cùng câu, kỳ 30 ngày: 6.606 ms (bản gốc) → 4.867 ms (tính đuôi SĐT sẵn — regex
 *     chỉ là phần nhỏ) → 139 ms (phép nối băm có gom nhóm). Chỗ tốn là QUÉT LẶP, không phải regex.
 */
export async function testReportQueryShape(db: Db) {
  // ───────── 1a. Mã số của sự kiện: cùng nghĩa với biểu thức SQL cũ ─────────
  const caMa: [string | null, number | null][] = [
    ["501", 501],
    ["VTP-505", 505],
    [" 5 0 3 ", 503],
    ["", null],
    ["abc", null],
    [null, null],
  ];
  for (const [status, ma] of caMa) {
    assert.equal(eventStatusCode(status), ma, `mã của "${status}"`);
    const [row] = (await db.execute(sql`select nullif(regexp_replace(${status}::text, '[^0-9]', '', 'g'), '')::int as ma`)).rows as { ma: number | null }[];
    assert.equal(row.ma === null ? null : Number(row.ma), ma, `SQL và TypeScript tách mã khác nhau ở "${status}"`);
  }

  // ───────── 1b. Trạng thái con của sự kiện: bản TypeScript = bản SQL, trên dạng dữ liệu của sổ sự kiện ─────────
  const caSuKien: [string | null, string | null][] = [
    ["501", "Phát thành công"],
    ["505", "Tồn - Thông báo chuyển hoàn bưu cục gốc"],
    [null, "Chờ phát lại"],
    ["", "Đang vận chuyển"],
    ["xyz", "Rác chưa từng thấy"],
    [null, null],
  ];
  for (const [status, ten] of caSuKien) {
    const ts = carrierSubstate({ code: eventStatusCode(status), text: ten, stage: null }).substate;
    const bt = carrierSubstateSql(sql`nullif(regexp_replace(${status}::text, '[^0-9]', '', 'g'), '')::int`, sql`${ten}::text`, sql`null::text`);
    const [row] = (await db.execute(sql`select ${bt} as con`)).rows as { con: string }[];
    assert.equal(ts, row.con, `trạng thái con của sự kiện (${status}, ${ten}) lệch giữa TypeScript và SQL`);
  }

  // ───────── 1c. Kho dữ liệu học không tính trạng thái con trong SQL cho từng dòng ─────────
  const kho = readFileSync("lib/queries/projected-delivery.ts", "utf8");
  assert.ok(!/CON_SU_KIEN/.test(kho), "kho dữ liệu học: trạng thái con của sự kiện tính bằng TypeScript (nhớ theo cặp), không trong câu nạp");
  assert.match(kho, /select e\.shipment_id, e\.occurred_at, e\.status, e\.status_name/, "câu nạp sự kiện chỉ đọc mã + chữ thô");

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
  // Truy vấn con tương quan trên bảng đã tính sẵn VẪN là quét lặp (3,6 ms × 315 lượt × 4 = 4,5 s đo được).
  assert.ok(!/from duoi_(ket_qua|don) \w+\s+where \w+\.(id <> o\.id|customer_id is not null)/.test(src), "lịch sử khách phải là phép nối có gom nhóm (ls_*), không phải truy vấn con tương quan");
  for (const bang of ["ls_ket_qua", "ls_don", "ls_khach"]) assert.match(src, new RegExp(`left join ${bang} \\w+ on \\w+\\.id = o\\.id`), `nối ${bang} vào câu chính`);

  console.log("✓ Hình dạng câu báo cáo: kho GTC dự phóng tính trạng thái con bằng TypeScript (= SQL, kể cả tách mã) · backtest không regex SĐT trong truy vấn con tương quan");
}
