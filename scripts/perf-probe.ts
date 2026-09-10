/**
 * ĐO TỪNG TRUY VẤN CỦA TRANG CHẬM, TRÊN DỮ LIỆU THẬT.
 *
 * Smoke test nói được TRANG nào chậm, không nói được HÀM nào chậm. Đo bằng PGlite tại máy cũng
 * không thay được: dữ liệu khác, kế hoạch truy vấn khác. Script này chạy TRONG container
 * production, chỉ ĐỌC, và in thời gian từng hàm mà Server Component của trang đó gọi.
 *
 * ⚠ ĐỌC CON SỐ NÀY CHO ĐÚNG. Probe xoá TOÀN BỘ bộ nhớ đệm trước mỗi phép đo, nên nó dựng lại điều
 * kiện XẤU NHẤT TUYỆT ĐỐI — kể cả những lớp đệm có TTL 5 phút mà người dùng gần như không bao giờ
 * trả giá. Ví dụ thật: `getReturnRateSummary` ở đây ra 5.549ms, còn trang `/reports/returns` mà
 * người dùng mở thật chỉ mất **170ms**. Cả hai đều đúng; chỉ một cái là trải nghiệm của chủ shop.
 *
 * Dùng probe để TÌM hàm nào đắt. Dùng `ops smoke` để biết người dùng thật chờ bao lâu.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/perf-probe.ts
 */
import "dotenv/config";
import { resolvePeriod } from "@/lib/search-params";
import { clearMemo } from "@/lib/cache";

/**
 * ĐẾM THỜI GIAN CSDL RIÊNG VỚI THỜI GIAN ỨNG DỤNG.
 *
 * Đo được: đọc toàn bộ 2.431 dòng từ bảng đã tính sẵn chỉ mất 33–48ms (EXPLAIN ANALYZE, nhánh dự
 * phòng ghi rõ "never executed"). Nhưng hàm báo cáo vẫn mất 5–14 giây. Nghĩa là phần lớn thời gian
 * KHÔNG nằm ở việc chạy câu lệnh — và nếu không tách ra thì còn đoán mãi.
 *
 * Bọc thẳng `Pool.query` của `pg`: mọi câu lệnh đều đi qua đó, không sót đường nào.
 */
let dbMs = 0;
const chamNhat: { ms: number; sql: string; full: string; params: unknown[] }[] = [];
let dbCalls = 0;
let dbRows = 0;

/**
 * ═══════ CÂU LỆNH LẶP LẠI — NGHI PHẠM SỐ MỘT ═══════
 *
 * Một hàm báo cáo mất 18 giây với 104 lượt truy vấn thì câu hỏi đầu tiên KHÔNG phải "câu nào chậm"
 * mà là **"có bao nhiêu câu là cùng một câu chạy lại"**. Nhiều báo cáo dựng lại cùng một tập nền
 * (kết quả đơn, giá vốn đã chốt, tổng hợp vận đơn) mỗi lần cần tới nó.
 *
 * Gom theo HÌNH DẠNG câu lệnh: bỏ khoảng trắng thừa và thay mọi số/chuỗi bằng `?`, nên hai lần
 * chạy cùng một truy vấn với tham số khác nhau vẫn được coi là một.
 */
type LanChay = { lan: number; ms: number; rows: number; mau: string };
let lapHienTai = new Map<string, LanChay>();

/** Tham số của lượt gọi — `pg` nhận cả `query(text, values)` lẫn `query({ text, values })`. */
function layThamSo(args: unknown[]): unknown[] {
  const first = args[0] as { values?: unknown[] } | null;
  if (first && typeof first === "object" && Array.isArray(first.values)) return first.values;
  return Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
}

function hinhDang(sqlText: string): string {
  return sqlText
    .replace(/\s+/g, " ")
    .replace(/'[^']*'/g, "'?'")
    .replace(/\$\d+/g, "$?")
    .replace(/\b\d+\b/g, "?")
    .trim();
}

const results: {
  page: string;
  fn: string;
  ms: number;
  dbMs: number;
  calls: number;
  rows: number;
  /** Lượt gọi thứ hai, đệm còn nguyên — con số người dùng thật gặp phần lớn thời gian. */
  warmMs: number;
  /** Câu lệnh chạy lại nhiều nhất trong hàm này: số lần · tổng ms · nguyên văn rút gọn. */
  lapNhieuNhat: { lan: number; ms: number; mau: string } | null;
  /** Số câu lệnh KHÁC NHAU. `calls` trừ đi số này là phần chạy lại. */
  khacNhau: number;
  note: string;
}[] = [];

/**
 * XOÁ ĐỆM TRƯỚC MỖI PHÉP ĐO.
 *
 * Lượt đo đầu tiên đã lấp đệm cho các lượt sau: `getControlTower` từng ra 0ms chỉ vì trang chủ vừa
 * gọi nó xong. Không xoá thì bảng xếp hạng nói dối, và ta đi sửa nhầm hàm.
 */
async function timed(page: string, fn: string, run: () => Promise<unknown>) {
  clearMemo();
  lapHienTai = new Map();
  const dbBefore = dbMs;
  const callsBefore = dbCalls;
  const rowsBefore = dbRows;
  const t0 = Date.now();
  try {
    const out = await run();
    const ms = Date.now() - t0;

    /*
      LƯỢT THỨ HAI: ĐỆM CÒN NGUYÊN.

      Hai con số này trả lời hai câu khác nhau và cả hai đều cần:
        · NGUỘI — chi phí thật của hàm. Đây là thứ phải sửa.
        · ẤM    — thứ người dùng gặp phần lớn thời gian.
      Chỉ nhìn con số ấm là để bộ đệm che mất một hàm 18 giây; chỉ nhìn nguội là hoảng vì một chi
      phí mà người dùng hiếm khi trả. Báo cáo phải in cả hai.
    */
    const t1 = Date.now();
    await run().catch(() => undefined);
    const warmMs = Date.now() - t1;

    const lap = [...lapHienTai.values()].filter((v) => v.lan > 1).sort((a, b) => b.ms - a.ms)[0] ?? null;
    const size = out === undefined ? 0 : JSON.stringify(out).length;
    results.push({
      page,
      fn,
      ms,
      dbMs: dbMs - dbBefore,
      calls: dbCalls - callsBefore,
      rows: dbRows - rowsBefore,
      warmMs,
      lapNhieuNhat: lap ? { lan: lap.lan, ms: lap.ms, mau: lap.mau } : null,
      khacNhau: lapHienTai.size,
      note: `${Math.round(size / 1024)}kB`,
    });
  } catch (error) {
    results.push({
      page,
      fn,
      ms: Date.now() - t0,
      dbMs: dbMs - dbBefore,
      calls: dbCalls - callsBefore,
      rows: dbRows - rowsBefore,
      warmMs: 0,
      lapNhieuNhat: null,
      khacNhau: lapHienTai.size,
      note: `LỖI: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function main() {
  // Bọc `Pool.query` NGAY ĐẦU, trước khi bất kỳ truy vấn nào chạy. Đặt ở mức mô-đun thì cần
  // top-level await, mà bản dựng CJS không hỗ trợ.
  {
    const pg = (await import("pg")).default as unknown as { Pool: { prototype: { query: (...args: unknown[]) => Promise<unknown> } } };
    const original = pg.Pool.prototype.query;
    /**
     * GHI LẠI CÂU LỆNH CHẬM NHẤT KÈM NGUYÊN VĂN SQL.
     *
     * "getBusinessBrief 46 giây" chưa sửa được gì — 105 lượt gọi thì phải biết lượt NÀO. Ba vòng
     * chẩn đoán trước đều phải đoán, và đoán sai hai lần. Bộ đo phải tự trả lời câu đó.
     */
    const ghiCham = (sqlText: string, ms: number, params: unknown[] = []) => {
      if (ms < 200) return;
      // Giữ NGUYÊN VĂN đầy đủ + tham số để lát nữa chạy EXPLAIN ANALYZE trên đúng câu đó.
      chamNhat.push({ ms, sql: sqlText.replace(/\s+/g, " ").trim().slice(0, 600), full: sqlText, params });
      chamNhat.sort((a, b) => b.ms - a.ms);
      chamNhat.length = Math.min(chamNhat.length, 8);
    };
    const ghiLap = (sqlText: string, ms: number, rows: number) => {
      const khoa = hinhDang(sqlText);
      const cur = lapHienTai.get(khoa) ?? { lan: 0, ms: 0, rows: 0, mau: sqlText.replace(/\s+/g, " ").trim().slice(0, 220) };
      cur.lan += 1;
      cur.ms += ms;
      cur.rows += rows;
      lapHienTai.set(khoa, cur);
    };
    pg.Pool.prototype.query = function patched(...args: unknown[]) {
      const t0 = Date.now();
      const first = args[0] as unknown;
      const sqlText = typeof first === "string" ? first : String((first as { text?: string } | null)?.text ?? "");
      const out = original.apply(this, args as never) as Promise<unknown>;
      if (out && typeof (out as Promise<unknown>).then === "function") {
        return (out as Promise<unknown>).then(
          (kq) => {
            const ms = Date.now() - t0;
            const rows = Number((kq as { rowCount?: number } | null)?.rowCount ?? 0);
            dbMs += ms;
            dbCalls += 1;
            dbRows += rows;
            ghiCham(sqlText, ms, layThamSo(args));
            ghiLap(sqlText, ms, rows);
            return kq;
          },
          (e) => {
            const ms = Date.now() - t0;
            dbMs += ms;
            dbCalls += 1;
            ghiCham(sqlText, ms);
            ghiLap(sqlText, ms, 0);
            throw e;
          },
        );
      }
      const ms = Date.now() - t0;
      dbMs += ms;
      dbCalls += 1;
      ghiCham(sqlText, ms);
      return out;
    };
  }

  // Đúng kỳ mặc định của từng trang: đó là thứ người dùng thật mở ra.
  const month = resolvePeriod({ period: "30d" }, "30d");
  const all = resolvePeriod({ period: "all" }, "all");

  // Đo TRUNG TÂM ĐIỀU KHIỂN TRƯỚC trang chủ: trang chủ gọi nó bên trong, nên đo sau là đo đệm.
  const tower = await import("@/lib/queries/control-tower");
  await timed("/ (thành phần)", "getControlTower", () => tower.getControlTower());

  // Bóc từng thành phần trang chủ: biết "trang chủ chậm" chưa sửa được gì, phải biết HÀM nào.
  const fin = await import("@/lib/queries/financial-truth");
  await timed("/ (thành phần)", "getFinancialTruth", () => fin.getFinancialTruth(month));
  const codq = await import("@/lib/queries/cod");
  await timed("/ (thành phần)", "codCashSummary", () => codq.codCashSummary(month));
  const eng = await import("@/lib/queries/cost-engine");
  await timed("/ (thành phần)", "getOperatingCost", () => eng.getOperatingCost(month));

  const cod = await import("@/lib/queries/cod-settlement");
  await timed("/cod", "codSettlementSummary", () => cod.codSettlementSummary(month));
  await timed("/cod", "codSettlementCounts", () => cod.codSettlementCounts(month));
  await timed("/cod", "listCodSettlement", () => cod.listCodSettlement({ period: month, status: "ALL", q: "", page: 1, pageSize: 50 }));
  await timed("/cod", "listStatementPayments", () => cod.listStatementPayments(40));
  await timed("/cod", "statementGapDays", () => cod.statementGapDays());
  await timed("/cod", "missingStatementPeriods", () => cod.missingStatementPeriods());

  const rr = await import("@/lib/queries/return-rate");
  await timed("/reports/returns", "getReturnRateSummary", () => rr.getReturnRateSummary(month, ""));
  await timed("/reports/returns", "getReturnRateByVariant", () =>
    rr.getReturnRateByVariant({ period: month, q: "", minShipped: 0, sort: "returned", dir: "desc", page: 1, pageSize: 50 }),
  );

  const dash = await import("@/lib/queries/dashboard");
  await timed("/", "getDashboardData", () => dash.getDashboardData(month));

  /**
   * ĐIỂM MÙ ĐÃ SỬA (10/09/2026).
   *
   * Bộ đo này từng chỉ đo `getDashboardData` rồi kết luận "trang chủ = 40 giây". Nhưng trang chủ
   * còn chờ HAI thứ nữa mà bộ đo không hề nhìn tới: `getBusinessBrief` và `getDashboardActionQueue`.
   * Cả hai nằm trong Suspense nên HTML đầu tiên ra sớm — nhưng phản hồi HTTP chỉ KẾT THÚC khi chúng
   * xong, tức smoke vẫn tính đủ thời gian đó.
   *
   * Sửa lớp tăng tốc xong mà trang chủ vẫn quá hạn 60 giây chính là vì phần chưa ai đo.
   */
  const brief = await import("@/lib/queries/business-brief");
  await timed("/ (Suspense)", "getBusinessBrief", () => brief.getBusinessBrief(month));
  const dq = await import("@/lib/queries/dashboard-queue");
  await timed("/ (Suspense)", "getDashboardActionQueue", () => dq.getDashboardActionQueue());
  // Trang NHANH để đối chiếu — nếu mọi thứ đều chậm thì vấn đề nằm ở chỗ khác.
  const ads = await import("@/lib/queries/ads-roas");
  // Kỳ MẶC ĐỊNH của trang (30 ngày) và kỳ TOÀN BỘ — chênh nhau bao nhiêu cho biết chi phí đi theo
  // lượng dữ liệu hay theo số câu truy vấn.
  await timed("/ads", "adsRoas 30 ngày", () => ads.getAdsRoas(month, "campaign"));
  await timed("/ads", "adsRoas toàn kỳ", () => ads.getAdsRoas(all, "campaign"));

  results.sort((a, b) => b.ms - a.ms);
  console.log("\n── THỜI GIAN TỪNG TRUY VẤN (chậm nhất trước) ──");
  // IN CẢ PHẦN TÁCH CSDL / ỨNG DỤNG: "chậm" chưa sửa được gì, phải biết thời gian nằm ở Postgres
  // hay ở Node, và bao nhiêu lượt gọi. 39 giây trong 20 lượt gọi khác hẳn 39 giây trong 4.000 lượt.
  for (const r of results)
    console.log(
      `${String(r.ms).padStart(7)}ms  csdl ${String(r.dbMs).padStart(6)}ms  ứng dụng ${String(Math.max(0, r.ms - r.dbMs)).padStart(6)}ms  ${String(r.calls).padStart(5)} lượt  ${r.page.padEnd(16)} ${r.fn.padEnd(26)} ${r.note}`,
    );
  const total = results.reduce((t, r) => t + r.ms, 0);
  console.log(`\nTổng ${total}ms cho ${results.length} truy vấn.`);

  /*
    ═══ NGUỘI SO VỚI ẤM ═══

    Bộ đệm che được một hàm 18 giây: trang vẫn 100ms và mọi lá chắn vẫn xanh. Nhưng chi phí đó
    KHÔNG biến mất — nó rơi vào đúng người mở trang lúc đệm vừa hết hạn, và đó thường là chủ shop
    mở máy buổi sáng. In cả hai để không ai kết luận "backend đã khoẻ" từ con số ấm.
  */
  console.log("\n── NGUỘI ↔ ẤM (đệm rỗng ↔ đệm còn nguyên) ──");
  for (const r of [...results].sort((a, b) => b.ms - a.ms).slice(0, 12)) {
    const tiLe = r.warmMs > 0 ? `${Math.round(r.ms / Math.max(1, r.warmMs))}x` : "—";
    console.log(`  ${String(r.ms).padStart(7)}ms nguội  ${String(r.warmMs).padStart(6)}ms ấm  ${tiLe.padStart(6)}  ${r.fn}`);
  }

  /*
    ═══ CÂU LỆNH CHẠY LẠI ═══

    Đây là chỗ tìm NGUYÊN NHÂN CHUNG. Nhiều báo cáo dựng lại cùng một tập nền — kết quả đơn, giá
    vốn đã chốt, tổng hợp vận đơn — mỗi lần cần tới. Nếu một hàm chạy CÙNG một hình dạng câu lệnh
    hàng chục lần thì việc phải làm là dùng chung tập nền, không phải tối ưu câu lệnh đó.
  */
  console.log("\n── CHẠY LẠI CÙNG MỘT CÂU (nghi phạm số một của hàm chậm) ──");
  const coLap = results.filter((r) => r.lapNhieuNhat && r.lapNhieuNhat.lan > 1).sort((a, b) => (b.lapNhieuNhat?.ms ?? 0) - (a.lapNhieuNhat?.ms ?? 0));
  if (!coLap.length) console.log("  (không hàm nào chạy lại cùng một câu)");
  for (const r of coLap.slice(0, 8)) {
    const l = r.lapNhieuNhat as { lan: number; ms: number; mau: string };
    console.log(`\n  ${r.fn}: ${r.calls} lượt · ${r.khacNhau} câu khác nhau · ${r.rows} dòng`);
    console.log(`    câu chạy lại nhiều nhất: x${l.lan} lượt, tốn ${l.ms}ms`);
    console.log(`    ${l.mau}`);
  }

  /*
    ═══ EXPLAIN ANALYZE CHO BA CÂU CHẬM NHẤT ═══

    "Câu này 10 giây" chưa sửa được gì. Kế hoạch thực thi mới nói được VÌ SAO: quét tuần tự hay
    dùng chỉ mục, chạy MỘT lần hay chạy lại cho từng dòng (loops), đọc bao nhiêu khối đệm.

    Chạy ngay tại đây trên đúng câu vừa đo, với đúng tham số của nó — không chép tay, không dựng
    lại. Chỉ ĐỌC: EXPLAIN ANALYZE có chạy thật nhưng đây đều là select.
  */
  {
    const pg = (await import("pg")).default as unknown as {
      Pool: new (o: { connectionString: string; max: number }) => { query: (t: string) => Promise<unknown>; end: () => Promise<void> };
    };
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 1 });
    console.log("\n── KẾ HOẠCH THỰC THI CỦA BA CÂU CHẬM NHẤT ──");
    for (const c of chamNhat.slice(0, 3)) {
      try {
        const r = (await pool.query(`explain (analyze, buffers, timing) ${nhungThamSo(c.full, c.params)}`)) as { rows?: Record<string, string>[] };
        const dong = (r.rows ?? []).map((x) => String(Object.values(x)[0]));
        // Chỉ in nút ĐẮT hoặc chạy lại nhiều lần — bản kế hoạch đầy đủ dài hàng trăm dòng.
        const dangChuY = dong.filter((l) => /loops=[2-9]|loops=\d\d|actual time=\d{3,}|Seq Scan|SubPlan|shared read/.test(l));
        console.log(`\n  ${c.ms}ms · ${c.sql.slice(0, 110)}…`);
        console.log(dangChuY.slice(0, 14).map((l) => `    ${l.trim().slice(0, 190)}`).join("\n") || "    (không nút nào đáng chú ý)");
        for (const l of dong) if (l.startsWith("Execution Time") || l.startsWith("Planning Time")) console.log(`    ${l}`);
      } catch (e) {
        console.log(`\n  ${c.ms}ms — không EXPLAIN được: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await pool.end().catch(() => undefined);
  }

  console.log("\n── TÁM CÂU LỆNH SQL CHẬM NHẤT (nguyên văn, cắt 600 ký tự) ──");
  if (!chamNhat.length) console.log("  (không câu lệnh nào vượt 200ms)");
  for (const c of chamNhat) console.log(`\n  ${c.ms}ms\n  ${c.sql}`);
  process.exit(0);
}

/**
 * Nhúng tham số vào câu lệnh để EXPLAIN chạy được — nó không nhận tham số rời.
 *
 * Chỉ dùng cho công cụ chẩn đoán chạy tay trên ops, không nằm trên đường của người dùng.
 */
function nhungThamSo(text: string, params: unknown[]): string {
  return text.replace(/\$(\d+)/g, (_, i) => {
    const v = params[Number(i) - 1];
    if (v === null || v === undefined) return "null";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (v instanceof Date) return `'${v.toISOString()}'`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
}

main().catch((error) => {
  console.error("perf-probe lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
