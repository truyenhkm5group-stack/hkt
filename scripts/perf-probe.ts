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
import { thoiGianThucThi, trungVi } from "@/lib/constants/perf-explain";
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
const chamNhat: { ms: number; sql: string; full: string; params: unknown[]; ham: string | null }[] = [];
/**
 * HÀM NÀO ĐANG ĐƯỢC ĐO khi một câu chậm chạy. Đo production 24/09/2026: câu chậm nhất (8.199 ms) chỉ
 * in được 600 ký tự đầu — toàn là biểu thức kết quả đơn, không thấy `from` — nên KHÔNG định vị được
 * nó thuộc hàm nào, và không vá được mà không đoán. Ghi tên hàm + in phần ĐUÔI câu lệnh (nơi có
 * `from` / `where` / `group by` ngoài cùng) là đủ để lần đo sau trỏ thẳng vào dòng mã.
 */
let hamDangDo: string | null = null;
let dbCalls = 0;
let dbRows = 0;

/**
 * ═══════ CHỜ XIN KẾT NỐI — CHI PHÍ KHÔNG NẰM TRONG BẤT KỲ CÂU LỆNH NÀO ═══════
 *
 * Bể kết nối của production là `max = 5` trên VPS **2 nhân** (xem `db/index.ts`, có số đo kèm lý
 * do). Nghĩa là câu lệnh thứ sáu trở đi KHÔNG chạy chậm — nó chưa chạy, nó đang xếp hàng.
 *
 * Thời gian xếp hàng ấy không xuất hiện ở bất kỳ phép đo `Pool.query` nào (đồng hồ chỉ bắt đầu khi
 * câu lệnh đã có kết nối), nên một hàm có thể mất 9 giây với "tổng thời gian csdl 1,2 giây" mà
 * không ai giải thích nổi 7,8 giây còn lại. Đây chính là chỗ hai lần chẩn đoán sai của bản trước
 * rơi vào: cả hai đều đọc con số câu lệnh rồi kết luận về hình dạng truy vấn.
 *
 * Đo bằng cách bọc `Pool.connect` (mọi lượt `query` đều xin kết nối qua đó) và ghi lại đỉnh hàng
 * đợi. `waitPeak > 0` là bằng chứng bể cạn; `waitMs` là giá phải trả.
 */
let poolWaitMs = 0;
let poolWaitCount = 0;
let poolWaitPeak = 0;
let poolQueuePeak = 0;

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
  /** Tổng thời gian XẾP HÀNG xin kết nối, và lần chờ lâu nhất. Bể cạn thì hai số này bùng lên. */
  poolWaitMs: number;
  poolWaitPeak: number;
  /** Số lượt xin kết nối phải chờ (> 1ms) và đỉnh hàng đợi quan sát được. */
  poolQueuePeak: number;
  note: string;
}[] = [];

/**
 * XOÁ ĐỆM TRƯỚC MỖI PHÉP ĐO.
 *
 * Lượt đo đầu tiên đã lấp đệm cho các lượt sau: `getControlTower` từng ra 0ms chỉ vì trang chủ vừa
 * gọi nó xong. Không xoá thì bảng xếp hạng nói dối, và ta đi sửa nhầm hàm.
 */
/**
 * ═══════ CÂU CHẬM BÊN TRONG MỘT HÀM TRỌNG ĐIỂM ═══════
 *
 * Danh sách "tám câu chậm nhất" là của CẢ lượt đo, nên một hàm 8,6 giây rải trên 22 câu lệnh
 * (Báo cáo lợi nhuận danh nghĩa, đo 23/09/2026 sau khi đã tắt JIT hai câu lớn) bị các trang có
 * một câu 16 giây che mất hoàn toàn — không biết phải sửa câu nào. Hàm khớp mẫu dưới đây được ghi
 * lại MỌI câu từ 50ms trở lên trong lượt NGUỘI, in thành một mục riêng.
 */
const TRONG_DIEM = /getNominalProfitReport|getMarketerDailyNominal|getAdsPerformance|getMarketerReport|getAdsDecision|salesByProductPage|dataQualitySummary|getDataQualityIssues|codSettlementSummary|listCodSettlement|customerFacets|getCashflowStatement/;
let cauTrongHam: { ms: number; sql: string }[] | null = null;
const cauTheoHam = new Map<string, { ms: number; sql: string }[]>();

async function timed(page: string, fn: string, run: () => Promise<unknown>) {
  clearMemo();
  hamDangDo = `${page} · ${fn}`;
  lapHienTai = new Map();
  cauTrongHam = TRONG_DIEM.test(fn) ? [] : null;
  const dbBefore = dbMs;
  const callsBefore = dbCalls;
  const rowsBefore = dbRows;
  const waitBefore = poolWaitMs;
  poolWaitPeak = 0;
  poolQueuePeak = 0;
  const t0 = Date.now();
  try {
    const out = await run();
    const ms = Date.now() - t0;
    if (cauTrongHam) cauTheoHam.set(fn, [...cauTrongHam].sort((a, b) => b.ms - a.ms).slice(0, 15));
    cauTrongHam = null;

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
      poolWaitMs: poolWaitMs - waitBefore,
      poolWaitPeak,
      poolQueuePeak,
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
      poolWaitMs: poolWaitMs - waitBefore,
      poolWaitPeak,
      poolQueuePeak,
      note: `LỖI: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Số lượt EXPLAIN mỗi điều kiện JIT. 3 là tối thiểu để có trung vị; mỗi lượt chạy thật một câu vài giây trên production. */
const LUOT_EXPLAIN = 3;

async function main() {
  // Bọc `Pool.query` NGAY ĐẦU, trước khi bất kỳ truy vấn nào chạy. Đặt ở mức mô-đun thì cần
  // top-level await, mà bản dựng CJS không hỗ trợ.
  {
    const pg = (await import("pg")).default as unknown as {
      Pool: { prototype: { query: (...args: unknown[]) => Promise<unknown>; connect: (...args: unknown[]) => Promise<unknown> } };
    };
    const original = pg.Pool.prototype.query;

    /*
      CÂU TRONG GIAO DỊCH KHÔNG ĐI QUA `Pool.query`.

      `chayKhongJit` mở giao dịch trên một kết nối riêng rồi gọi `client.query` — nên mọi câu đã
      được tắt JIT đều VÔ HÌNH với bộ đếm bên dưới. Mục "câu chậm bên trong hàm trọng điểm" cần
      thấy cả hai đường, nên nó bọc `Client.query` (đường chung của cả pool lẫn giao dịch). Chỉ
      mục ấy đọc lớp bọc này: `Pool.query` gọi xuống `Client.query`, đếm cả hai vào `dbMs` là đếm
      trùng.
    */
    {
      const client = (pg as unknown as { Client: { prototype: { query: (...args: unknown[]) => unknown } } }).Client.prototype;
      const goc = client.query;
      client.query = function boc(...args: unknown[]) {
        const out = goc.apply(this, args as never);
        const cau = cauTrongHam;
        const text = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string } | undefined)?.text ?? "");
        if (cau && text && out && typeof (out as Promise<unknown>).then === "function") {
          const t0 = Date.now();
          (out as Promise<unknown>).then(
            () => {
              const ms = Date.now() - t0;
              if (ms >= 50) cau.push({ ms, sql: text.replace(/\s+/g, " ").trim().slice(0, 180) });
            },
            () => undefined,
          );
        }
        return out;
      };
    }

    /*
      ĐO THỜI GIAN XẾP HÀNG XIN KẾT NỐI.

      `Pool.query` bên trong gọi `Pool.connect`. Bọc `connect` thì đo được đúng phần mà đồng hồ của
      `query` KHÔNG thấy: khoảng thời gian câu lệnh nằm chờ tới lượt vì bể đã cạn. Trên bể 5 kết nối
      của máy hai nhân, đây thường là phần lớn nhất của một hàm "chậm".
    */
    const originalConnect = pg.Pool.prototype.connect;
    pg.Pool.prototype.connect = function patchedConnect(...args: unknown[]) {
      const self = this as unknown as { waitingCount?: number; totalCount?: number; idleCount?: number };
      const queued = Number(self.waitingCount ?? 0);
      if (queued > poolQueuePeak) poolQueuePeak = queued;
      const t0 = Date.now();
      const out = originalConnect.apply(this, args as never) as Promise<unknown>;
      if (out && typeof (out as Promise<unknown>).then === "function") {
        return (out as Promise<unknown>).then(
          (c) => {
            const ms = Date.now() - t0;
            // Dưới 1ms là lấy được kết nối rảnh ngay — không phải xếp hàng, đừng tính vào.
            if (ms > 1) {
              poolWaitMs += ms;
              poolWaitCount += 1;
              if (ms > poolWaitPeak) poolWaitPeak = ms;
            }
            return c;
          },
          (e) => {
            poolWaitMs += Date.now() - t0;
            throw e;
          },
        );
      }
      return out;
    };
    /**
     * GHI LẠI CÂU LỆNH CHẬM NHẤT KÈM NGUYÊN VĂN SQL.
     *
     * "getBusinessBrief 46 giây" chưa sửa được gì — 105 lượt gọi thì phải biết lượt NÀO. Ba vòng
     * chẩn đoán trước đều phải đoán, và đoán sai hai lần. Bộ đo phải tự trả lời câu đó.
     */
    const ghiCham = (sqlText: string, ms: number, params: unknown[] = []) => {
      // Đường POOL (không giao dịch). Đường giao dịch do lớp bọc `Client.query` ở trên ghi — `Pool.query`
      // gọi xuống client ở dạng callback nên lớp bọc kia không thấy nó, hai nguồn không trùng nhau.
      if (cauTrongHam && ms >= 50) cauTrongHam.push({ ms, sql: sqlText.replace(/\s+/g, " ").trim().slice(0, 180) });
      if (ms < 200) return;
      // Giữ NGUYÊN VĂN đầy đủ + tham số để lát nữa chạy EXPLAIN ANALYZE trên đúng câu đó.
      chamNhat.push({ ms, sql: sqlText.replace(/\s+/g, " ").trim().slice(0, 600), full: sqlText, params, ham: hamDangDo });
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
  /*
    ═══ HAI CÔNG CỤ COPILOT ĐƯỢC DÙNG NHIỀU NHẤT — ĐO TRƯỚC MỌI THỨ KHÁC ═══

    ĐO THẬT 22/09/2026 từ sổ `ai_interactions`, 7 ngày gần nhất:

        công cụ                  lượt   TB      max
        get_care_queue_summary     76   12,9s   64,1s
        get_data_freshness         49   16,8s   63,3s

    Đây là ĐỘ TRỄ NGƯỜI DÙNG THẬT CHỊU: mọi câu hỏi Copilot đều chờ ít nhất chừng ấy. Câu hỏi của
    chủ shop lúc 03:14 mất 63,2 giây.

    Cả hai hàm ĐÃ có `memo()` (30s và 60s) — nên đây không phải chuyện thiếu đệm, mà là bản thân
    truy vấn nặng. Probe xoá đệm trước mỗi phép đo nên nó dựng lại đúng điều kiện lần gọi ĐẦU,
    tức đúng thứ người dùng gặp khi đệm vừa hết hạn.

    Đo TRƯỚC mọi thứ khác vì hàng đợi care là thứ được hỏi nhiều nhất trong ngày.
  */
  const care = await import("@/lib/queries/care-workbench");
  await timed("/shipments (công cụ AI)", "getCareQueue", () => care.getCareQueue());
  const fresh = await import("@/lib/queries/logistics-freshness");
  await timed("/shipments (công cụ AI)", "getLogisticsFreshness", () => fresh.getLogisticsFreshness());

  /*
    PHỄU BÁN HÀNG — 34,4 giây lúc máy RẢNH, và là trang duy nhất ĐỔ khi máy bận (deploy #392:
    hết kết nối CSDL). Bốn hàm này từng KHÔNG có `memo()` ở bất cứ tầng nào; từ vòng vá 24/09/2026
    chúng đệm 120 giây (docs/perf/vong-va-2026-09-24.md) — cột ẤM của chúng phải về gần 0, còn cột
    NGUỘI vẫn là chi phí thật của lần mở đầu.
  */
  const funnel = await import("@/lib/queries/sales-funnel");
  await timed("/reports/funnel", "getSalesFunnel", () => funnel.getSalesFunnel(month));
  await timed("/reports/funnel", "getAttributionCoverage", () => funnel.getAttributionCoverage(month));
  await timed("/reports/funnel", "getFunnelBySource", () => funnel.getFunnelBySource(month));
  const staff = await import("@/lib/queries/staff-performance");
  await timed("/reports/funnel", "getStaffPerformance", () => staff.getStaffPerformance(month, "sellerName"));

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
  /*
    LN DANH NGHĨA NGUỘI 37,1 GIÂY (perf-audit, production 23/09/2026) — và từ #165 nó nằm dưới cả
    bảng bóc tách MKTer của /ads/daily. Phép chia ngày × MKTer chỉ tốn 0,5s khi báo cáo đã trong
    đệm, nên chỗ phải sửa nằm BÊN TRONG báo cáo. Đo từng phần con xuất ra được để thấy câu nào.
  */
  const nominal = await import("@/lib/queries/profit-nominal");
  await timed("/reports?tab=nominal", "getNominalProfitReport 30 ngày", () => nominal.getNominalProfitReport(month, "ORDERED"));
  const mdn = await import("@/lib/queries/marketer-daily-nominal");
  await timed("/ads/daily", "getMarketerDailyNominal 30 ngày", () => mdn.getMarketerDailyNominal(month));
  await timed("/reports?tab=nominal", "resolveAssumptions", () => nominal.resolveAssumptions());
  await timed("/reports?tab=nominal", "productReturnHistory 90 ngày", () => nominal.productReturnHistory(90));
  await timed("/reports?tab=nominal", "purchaseByProduct 30 ngày", () => nominal.purchaseByProduct(month));
  const projected = await import("@/lib/queries/projected-delivery");
  await timed("/reports?tab=nominal", "getProjectedDeliveryMetrics ORDERED 30 ngày", () => projected.getProjectedDeliveryMetrics(month, "ORDERED", "PRODUCT"));
  await timed("/ads", "adsRoas 30 ngày", () => ads.getAdsRoas(month, "campaign"));
  await timed("/ads", "adsRoas toàn kỳ", () => ads.getAdsRoas(all, "campaign"));

  /*
    ═══════ BẢNG QUYẾT ĐỊNH QUẢNG CÁO — THỨ ĐẮT NHẤT CỦA `/ads`, VÀ CHƯA TỪNG ĐƯỢC ĐO ═══════

    `/ads` là màn hình chậm nhất của cả hệ thống tính tới 22/09/2026, và nó chậm gấp đôi trong
    đúng MỘT lượt deploy. Đo bằng smoke test qua bốn bản liên tiếp:

        48918cec   26,7s
        fd6dd489   58,9s   ← lượt này sửa `lib/queries/ads-decision.ts` (+160 dòng cột gộp mới)
        cd1c061d   60,2s
        04fc955f   45,2s · 41,7s (hai mẫu, cùng bản mã)

    Bước nhảy nằm gọn ở `fd6dd489`. Nhưng `getAdsDecision` KHÔNG có trong bộ đo này, nên câu nói
    ấy mới chỉ là suy luận từ MỐC THỜI GIAN — và thứ duy nhất của `/ads` đang được đo (`adsRoas`,
    0,3–1,4 giây) không giải thích nổi 40 giây. Suy từ mốc thời gian sang nguyên nhân là đúng cái
    bẫy tệp này sinh ra để chặn, nên: đo đã.

    Hàm đã dùng khuôn mẫu rẻ (bảng dẫn xuất + `OUTCOME_FENCE` + `chayKhongJit`) — nếu nó vẫn đắt
    thì nguyên nhân KHÔNG nằm ở hình dạng truy vấn, và đoán thêm một vòng nữa là phí công.

    Đo hai chiều vì chúng đi qua HAI bảng dẫn xuất khác nhau: `campaign` (chiều mặc định của
    trang) dùng `ads_decision_facts`, còn `product` dùng `ads_product_facts` — bảng có thêm một
    `window function` chia cước theo dòng hàng. Hai con số tách được "giá của bảng quyết định"
    khỏi "giá của riêng chiều mã hàng".

    `decisionStability` đo riêng vì trang gọi nó SAU `getAdsDecision` theo chuỗi, không song song:
    thời gian của nó cộng THẲNG vào thời gian người dùng ngồi chờ.
  */
  const adsDec = await import("@/lib/queries/ads-decision");
  await timed("/ads", "getAdsDecision campaign", () => adsDec.getAdsDecision(month, "campaign"));
  await timed("/ads", "getAdsDecision product", () => adsDec.getAdsDecision(month, "product"));
  /*
    KHỐI CUỐI TRANG /ads — "hiệu quả theo marketer" — 9,7s nguội (perf-audit 24/09/2026), và bỏ đọc
    tồn kho (#199) KHÔNG làm nó nhanh lên: chỗ tốn nằm ở phần khác. Đo nó và các phần con xuất ra
    được, theo KỲ MẶC ĐỊNH CỦA TRANG (tháng này, `resolvePeriod(raw, "month")`), để mục "câu chậm
    bên trong hàm trọng điểm" chỉ đúng câu phải sửa.
  */
  const thangTrang = resolvePeriod({}, "month");
  const adsPerf = await import("@/lib/queries/ads-performance");
  const payrollQ = await import("@/lib/queries/payroll");
  await timed("/ads", "getAdsPerformance tháng này", () => adsPerf.getAdsPerformance(thangTrang));
  await timed("/ads", "getMarketerReport tháng này", () => payrollQ.getMarketerReport(thangTrang));
  await timed("/ads", "salesByProductPage tháng này (delivered)", () => payrollQ.salesByProductPage(thangTrang, "delivered"));
  const ledger = await import("@/lib/queries/marketing-ledger");
  const { vnDay } = await import("@/lib/constants/marketing-decision-ledger");
  await timed("/ads", "decisionStability campaign", async () => {
    const d = await adsDec.getAdsDecision(month, "campaign");
    return ledger.decisionStability(
      "campaign",
      d.rows.map((r) => r.key),
      vnDay(new Date()),
    );
  });

  /*
    ═══════ /ads/daily — ĐO TỪNG CHẶNG, KHÔNG ĐO CẢ TRANG ═══════

    Trang này đã bị chẩn đoán sai HAI LẦN vì đọc con số tổng rồi suy ra nguyên nhân (xem
    `docs/marketing-daily-contract.md` mục 13). Nên ở đây tách đúng những chặng mà trang thật sự
    chờ, mỗi chặng một dòng:

      · bảng theo ngày (pnlFacts + chi QC + số lượng + chi phí phân bổ)  — khối chính
      · bảng theo ngày KHÔNG kèm kỳ trước                                — để biết giá của mũi tên so sánh
      · bóc tách theo marketer / mã hàng                                 — nghi phạm N+1
      · độ tươi nguồn · đích                                             — phải rẻ, nếu không là bất thường
      · lớp AI                                                           — mạng bên ngoài, không phải CSDL

    So `có kỳ trước` với `không kỳ trước` trả lời được một câu cụ thể: dải KPI "so với kỳ trước" có
    đang nhân đôi toàn bộ chi phí của trang hay không.
  */
  /*
    PHÉP SO SÁNH PHÂN BIỆT ĐƯỢC.

    `getDailyBreakdown` của Báo cáo lợi nhuận dùng CHÍNH bảng dẫn xuất `orderFacts` mà bảng theo
    ngày dùng, chỉ khác là không có các cột riêng của báo cáo marketing. Đặt hai con số cạnh nhau
    thì trả lời dứt khoát được câu "chi phí này là của tính năng mới hay là chi phí có sẵn của cả
    kho mã" — thay vì đoán lần thứ ba.
  */
  const rep = await import("@/lib/queries/reports");
  await timed("/reports (nền)", "getDailyBreakdown 30d", () => rep.getDailyBreakdown(month, "created"));

  /*
    ═══ THANG BẬC TỶ LỆ ĐO RIÊNG, VÌ NÓ LÀ CHI PHÍ DÙNG CHUNG CHỨ KHÔNG PHẢI CHI PHÍ CỦA TRANG ═══

    `productDeliveryRates` kéo theo hợp đồng `PROJECTED_GTC_V3` — bảng xác suất học từ ~19.000 dòng
    `shipment_events`. Nó có bộ đệm riêng 90 giây và Báo cáo lợi nhuận danh nghĩa cũng gọi nó, nên
    LƯỢT ĐẦU của bất kỳ trang nào cũng trả tiền, còn lượt sau thì không.

    Đo riêng hai dòng này để lần sau không ai phải đoán lại: con số "nguội" của /ads/daily là giá
    của thang bậc dùng chung hay là giá của chính bảng theo ngày. 22/09/2026 tôi đã mất một vòng
    chẩn đoán vì hai thứ ấy nằm gộp trong một con số.
  */
  const dr = await import("@/lib/queries/delivery-rate");
  const pd = await import("@/lib/queries/projected-delivery");
  await timed("/ads/daily (dùng chung)", "getProjectedDeliveryMetrics 30d", () => pd.getProjectedDeliveryMetrics(month, "ORDERED", "PRODUCT"));
  await timed("/ads/daily (dùng chung)", "productDeliveryRates 30d", () => dr.productDeliveryRates(month));

  const md = await import("@/lib/queries/marketing-daily");
  const { previousPeriod } = await import("@/lib/search-params");
  await timed("/ads/daily", "marketingDaily 30d (có kỳ trước)", () => md.getMarketingDaily(month, "created", {}, previousPeriod(month)));
  await timed("/ads/daily", "marketingDaily 30d (không kỳ trước)", () => md.getMarketingDaily(month, "created", {}));
  await timed("/ads/daily", "breakdown marketer", () => md.getMarketingBreakdown(month, "created", "marketer", {}));
  await timed("/ads/daily", "breakdown product", () => md.getMarketingBreakdown(month, "created", "product", {}));
  await timed("/ads/daily", "breakdown campaign", () => md.getMarketingBreakdown(month, "created", "campaign", {}));
  const mdDb = await import("@/db");
  await timed("/ads/daily", "marketingFreshness", async () => md.marketingFreshness(await mdDb.getDb()));
  const mt = await import("@/lib/queries/marketing-targets");
  await timed("/ads/daily", "evaluateMarketingTargets", async () => {
    const d = await md.getMarketingDaily(month, "created", {});
    return mt.evaluateMarketingTargets(d.totals, month, null);
  });
  // Kỳ NGẮN: bản tin Lark và cảnh báo chỉ đọc một ngày. Nếu một ngày cũng đắt thì chi phí đi theo
  // SỐ CÂU TRUY VẤN chứ không theo lượng dữ liệu — hai nguyên nhân, hai cách sửa.
  const motNgay = resolvePeriod({ period: "yesterday" }, "yesterday");
  await timed("/ads/daily", "marketingDaily 1 ngày", () => md.getMarketingDaily(motNgay, "created", {}));

  /*
    ═══════════ NĂM MÀN HÌNH CHẬM CHƯA TỪNG CÓ MỘT PHÉP ĐO NÀO ═══════════

    Smoke test của deploy 22/09/2026 (`48918cec`, 76/76 đạt) in ra 20 màn hình vượt ngưỡng 2 giây.
    Bốn trang nặng nhất đã có mặt ở trên; số còn lại thì chưa ai đo bao giờ, nên mọi câu nói về
    chúng tới giờ đều là phỏng đoán:

        /reports/returns                       61,8s
        /data-quality?issue=unlinked-shipment  34,6s
        /cod?recon=stale                       28,7s
        /customers                             23,2s
        /work/okr                              22,0s
        /payroll                               13,7s
        /inventory/returns                      9,2s

    ─── VÌ SAO `/reports/returns` ĐO Ở 90 NGÀY, KHÔNG PHẢI 30 ───

    Trang khai `defaultPeriod: "90d"`, nên người mở trang KHÔNG hề thấy con số 30 ngày. Đo ở 30
    ngày rồi kết luận về một trang chạy 90 ngày là tự cho mình một bài dễ hơn bài thật — và với
    báo cáo này, 90 ngày là gần ba lần số dòng. Hai phép đo của trang ấy đã có ở trên vẫn giữ
    nguyên mốc 30 ngày để so được với lịch sử; năm phép đo thêm ở đây chạy ĐÚNG mốc của trang.

    ─── VÀ VÌ SAO ĐO ĐỦ CẢ MƯỜI HÀM CỦA TRANG ĐÓ ───

    `/reports/returns` chờ MƯỜI truy vấn (bảy ở lượt một, ba ở lượt hai) rồi mới vẽ được ký tự đầu
    tiên. Trước bản này chỉ hai trong mười được đo, nên tám hàm còn lại có thể đang giữ phần lớn
    của 61,8 giây mà không ai biết. Một trang chậm mà chỉ đo 20% số hàm của nó thì con số đo được
    không trả lời được câu hỏi nào.
  */
  const ret90 = resolvePeriod({ period: "90d" }, "90d");
  const rr2 = await import("@/lib/queries/return-rate");
  await timed("/reports/returns", "getReturnRateSummary 90d", () => rr2.getReturnRateSummary(ret90, ""));
  await timed("/reports/returns", "getReturnRateByVariant 90d", () =>
    rr2.getReturnRateByVariant({ period: ret90, q: "", minShipped: 0, sort: "returned", dir: "desc", page: 1, pageSize: 50 }),
  );
  await timed("/reports/returns", "getReturnRateBySource 90d", () => rr2.getReturnRateBySource(ret90, ""));
  await timed("/reports/returns", "getReturnRateByTier 90d", () => rr2.getReturnRateByTier(ret90, ""));
  const logi = await import("@/lib/queries/logistics");
  await timed("/reports/returns", "logisticsPerformance 90d", () => logi.logisticsPerformance(ret90));
  const rrr = await import("@/lib/queries/return-reason-report");
  await timed("/reports/returns", "getReturnReasonReport 90d", () => rrr.getReturnReasonReport({ period: ret90 }));
  const ri = await import("@/lib/queries/return-intelligence");
  /*
    Nơi gọi thật truyền `reasonReport` đã dựng sẵn để khỏi dựng lần hai. Ở đây CỐ Ý không truyền:
    con số cần biết là chi phí ĐẦY ĐỦ của hàm này, còn phần dùng chung đã được đo riêng ngay trên.
    Truyền vào sẽ đo một hàm rẻ hơn hàm đang chạy trên production ở nhánh drilldown.
  */
  await timed("/reports/returns", "getReturnIntelligence 90d", () => ri.getReturnIntelligence({ period: ret90, previous: previousPeriod(ret90), basis: "SHIPPED" }));

  const dqi = await import("@/lib/queries/data-quality-issues");
  await timed("/data-quality", "getDataQualityIssues", () => dqi.getDataQualityIssues());

  /*
    `/customers` khai `defaultPeriod: "all"` và bắn BA truy vấn song song trên cùng bộ lọc. Đo cả
    ba: nếu chi phí chia đều thì việc phải làm là dựng chung một tập nền, còn nếu dồn vào một hàm
    thì đó là một câu lệnh phải sửa — hai kết luận khác nhau, và không đoán được từ con số trang.
  */
  const cus = await import("@/lib/queries/customers");
  const cusParams = { page: 1, pageSize: 50, sort: "lastOrderAt", dir: "desc" as const, q: "", filters: {}, period: all };
  await timed("/customers", "listCustomers", () => cus.listCustomers(cusParams));
  await timed("/customers", "customerFacets", () => cus.customerFacets(cusParams));
  await timed("/customers", "customerSummary", () => cus.customerSummary(cusParams));

  /*
    VÒNG VÁ 24/09/2026 (docs/perf/vong-va-2026-09-24.md). Các hàm dưới đây vừa chạy câu kết quả đơn
    trong `chayKhongJit` theo HÌNH DẠNG, chưa có số đo riêng — và sáu trong số đó trước nay KHÔNG có
    mặt trong probe, nên trang của chúng chậm mà không ai nói được câu nào. Đo ở đây cho có trước/sau.
    Mỗi hàm theo ĐÚNG kỳ mặc định của trang mình.
  */
  const dqq = await import("@/lib/queries/data-quality");
  await timed("/data-quality", "dataQualitySummary 90d", () => dqq.dataQualitySummary(ret90));
  await timed("/data-quality", "dataQualityOrders unverified 90d", () => dqq.dataQualityOrders("unverified", ret90, 1, 50, ""));
  await timed("/data-quality", "unlinkedShipments", () => dqq.unlinkedShipments(1, 50, "", "updatedAt", "desc"));
  const prod = await import("@/lib/queries/products");
  const prodParams = { ...cusParams, sort: "erpStock" };
  await timed("/products", "productFacets", () => prod.productFacets(prodParams));
  await timed("/products", "productSummary", () => prod.productSummary(prodParams));
  const cashflowQ = await import("@/lib/queries/cashflow");
  await timed("/reports/cashflow", "getCashflow (tab dự phóng)", () => cashflowQ.getCashflow());
  const bridgeQ = await import("@/lib/queries/profit-cash-bridge");
  await timed("/reports/cashflow", "getProfitCashBridge tháng này", () => bridgeQ.getProfitCashBridge(thangTrang));
  const statementQ = await import("@/lib/queries/cashflow-statement");
  await timed("/reports/cashflow", "getCashflowStatement tháng này", () => statementQ.getCashflowStatement(thangTrang));
  const convQ = await import("@/lib/queries/conversion-funnel");
  await timed("/reports/funnel", "getConversionFunnel", () => convQ.getConversionFunnel(month));
  await timed("/reports/funnel", "getConversionByDimension employee", () => convQ.getConversionByDimension(month, "employee"));

  const okr = await import("@/lib/queries/okr");
  const quy = okr.currentQuarter();
  const bsc = await import("@/lib/queries/bsc");
  await timed("/work/okr", "listObjectives", () => okr.listObjectives({ period: quy, includeDraft: true }, month));
  await timed("/work/okr", "getScorecard", () => bsc.getScorecard({ scope: "COMPANY", departmentId: null, period: quy }, month));

  const pay = await import("@/lib/queries/payroll");
  await timed("/payroll", "getPayrollReport profit1", () => pay.getPayrollReport(month, "profit1"));

  const insp = await import("@/lib/returns/inspection");
  await timed("/inventory/returns", "listPendingInspections", () => insp.listPendingInspections());
  const uni = await import("@/lib/returns/unidentified");
  await timed("/inventory/returns", "listUnidentifiedReturns", () => uni.listUnidentifiedReturns({}));

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
    ═══ XẾP HÀNG XIN KẾT NỐI ═══

    Đây là phần thời gian KHÔNG nằm trong bất kỳ câu lệnh nào. Bể của production là `max = 5` trên
    máy 2 nhân, nên một hàm bắn nhiều câu song song sẽ tự làm chậm chính nó. Cột "chờ bể" lớn mà
    "csdl" nhỏ nghĩa là vấn đề nằm ở SỐ LƯỢNG câu chạy đồng thời, không nằm ở câu nào cả.
  */
  const coCho = results.filter((r) => r.poolWaitMs > 0).sort((a, b) => b.poolWaitMs - a.poolWaitMs);
  console.log("\n── CHỜ XIN KẾT NỐI (thời gian KHÔNG nằm trong câu lệnh nào) ──");
  if (!coCho.length) console.log("  (không hàm nào phải xếp hàng — bể kết nối không phải nút thắt)");
  for (const r of coCho.slice(0, 10)) {
    const tiLe = r.ms > 0 ? Math.round((r.poolWaitMs / r.ms) * 100) : 0;
    console.log(`  ${String(r.poolWaitMs).padStart(6)}ms chờ (${String(tiLe).padStart(3)}% của hàm)  đỉnh 1 lượt ${String(r.poolWaitPeak).padStart(5)}ms  đỉnh hàng đợi ${r.poolQueuePeak}  ${r.fn}`);
  }
  console.log(`  Tổng ${poolWaitMs}ms chờ trên ${poolWaitCount} lượt xin kết nối · PGPOOL_MAX=${process.env.PGPOOL_MAX ?? "(mặc định 5)"}`);

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
    ═══ EXPLAIN ANALYZE CHO BA CÂU CHẬM NHẤT — DƯỚI CẢ HAI ĐIỀU KIỆN JIT ═══

    "Câu này 10 giây" chưa sửa được gì. Kế hoạch thực thi mới nói được VÌ SAO: quét tuần tự hay
    dùng chỉ mục, chạy MỘT lần hay chạy lại cho từng dòng (loops), đọc bao nhiêu khối đệm.

    ─── BẢN CŨ ĐO NHẦM ĐƯỜNG (sửa 23/09/2026) ───

    Bản trước chạy `explain` thẳng trên bể kết nối, NGOÀI mọi giao dịch — tức JIT BẬT. Ứng dụng
    thì chạy các báo cáo này bên trong `chayKhongJit()` (`db/index.ts`): `begin; set local jit =
    off; …`. Hai điều kiện khác nhau, và con số của bản cũ đi thẳng vào tệp chứng từ
    `docs/perf/TECH-5-so-do-tho-2026-09-22.md`. Việc TECH-10 dựng ưu tiên số 1 của nó lên con số
    ấy, và tệp chứng từ không cảnh báo (đã vá ở PR #174).

    Sửa đúng không phải là chuyển sang JIT tắt rồi thôi. Câu hỏi thật là "JIT góp BAO NHIÊU", và
    chỉ trả lời được khi đo CẢ HAI — cùng câu, cùng tham số, cùng lúc.

    ─── THIẾT KẾ PHÉP ĐO ───

    · Hai điều kiện: JIT MẶC ĐỊNH (giữ để so được với lịch sử) và JIT TẮT — lặp lại ĐÚNG câu lệnh
      `chayKhongJit` phát ra, không một câu nào khác.
    · XEN KẼ bật–tắt–bật–tắt… chứ không chạy hết một bên rồi mới sang bên kia. Máy 2 nhân đang
      phục vụ người thật, tải lên xuống theo phút; xen kẽ để độ trôi của tải rơi đều lên cả hai.
    · Mỗi điều kiện ${LUOT_EXPLAIN} lượt, lấy TRUNG VỊ và in đủ từng lượt. Một mẫu trên máy này không
      nói được gì (`/payroll/payslip` từng đo 333 ms / 5.873 ms / 1.723 ms — lệch 18 lần).
    · Mỗi lượt trong giao dịch RIÊNG, kết thúc bằng `rollback`: đây là select, nhưng rollback bảo
      đảm `set local` không rò sang lượt sau trên cùng kết nối.
    · Câu chậm nhất in kế hoạch ĐẦY ĐỦ của lượt JIT tắt, KHÔNG cắt. Tệp toàn văn ngày 22/09 bị cắt
      còn 47 dòng và mất đúng khối `JIT:` — đó là lý do câu hỏi JIT phải ghi CHƯA ĐO ĐƯỢC.

    Chỉ ĐỌC: EXPLAIN ANALYZE có chạy thật, nhưng đây đều là select, trong giao dịch bị rollback.
  */
  {
    const LUOT = LUOT_EXPLAIN;
    type Client = { query: (t: string) => Promise<{ rows?: Record<string, string>[] }>; release: () => void };
    const pg = (await import("pg")).default as unknown as {
      Pool: new (o: { connectionString: string; max: number }) => { connect: () => Promise<Client>; end: () => Promise<void> };
    };
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "", max: 1 });
    const chayMotLuot = async (cauLenh: string, jitTat: boolean): Promise<string[]> => {
      const c = await pool.connect();
      try {
        await c.query("begin");
        // ĐÚNG câu mà `chayKhongJit` phát ra — không thêm, không bớt.
        if (jitTat) await c.query("set local jit = off");
        const r = await c.query(`explain (analyze, buffers, timing) ${cauLenh}`);
        return (r.rows ?? []).map((x) => String(Object.values(x)[0]));
      } finally {
        await c.query("rollback").catch(() => undefined);
        c.release();
      }
    };
    const thoiGian = thoiGianThucThi;

    console.log(`\n── KẾ HOẠCH THỰC THI CỦA BA CÂU CHẬM NHẤT · JIT BẬT vs JIT TẮT · ${LUOT} lượt mỗi bên, xen kẽ ──`);
    for (const c of chamNhat.slice(0, 3)) {
      const cauLenh = nhungThamSo(c.full, c.params);
      const bat: number[] = [];
      const tat: number[] = [];
      let keHoachTat: string[] = [];
      let khoiJit: string[] = [];
      try {
        for (let k = 0; k < LUOT; k += 1) {
          const dBat = await chayMotLuot(cauLenh, false);
          const tb = thoiGian(dBat);
          if (tb !== null) bat.push(tb);
          // Khối `JIT:` chỉ xuất hiện khi JIT bật và thật sự biên dịch — giữ lại một bản để in.
          if (!khoiJit.length) {
            const iJ = dBat.findIndex((x) => x.trim().startsWith("JIT:"));
            if (iJ >= 0) khoiJit = dBat.slice(iJ, iJ + 6);
          }
          const dTat = await chayMotLuot(cauLenh, true);
          const tt = thoiGian(dTat);
          if (tt !== null) tat.push(tt);
          keHoachTat = dTat;
        }
      } catch (e) {
        console.log(`\n  ${c.ms}ms — không EXPLAIN được: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const mBat = trungVi(bat);
      const mTat = trungVi(tat);
      console.log(`\n  ${c.ms}ms trong lượt đo đường ứng dụng · hàm: ${c.ham ?? "(ngoài timed)"} · ${c.sql.slice(0, 110)}…`);
      console.log(`    JIT MẶC ĐỊNH  trung vị ${mBat === null ? "CHƯA ĐO ĐƯỢC" : `${mBat.toFixed(1)} ms`}  [${bat.map((x) => x.toFixed(1)).join(" · ")}]`);
      console.log(`    JIT TẮT       trung vị ${mTat === null ? "CHƯA ĐO ĐƯỢC" : `${mTat.toFixed(1)} ms`}  [${tat.map((x) => x.toFixed(1)).join(" · ")}]`);
      if (mBat !== null && mTat !== null && mBat > 0) {
        const gop = mBat - mTat;
        console.log(`    ⇒ phần chênh khi tắt JIT: ${gop.toFixed(1)} ms (${((gop / mBat) * 100).toFixed(0)} % của thời gian JIT bật)`);
      } else {
        console.log("    ⇒ phần chênh khi tắt JIT: CHƯA ĐO ĐƯỢC (thiếu một trong hai phía)");
      }
      if (khoiJit.length) console.log(khoiJit.map((l) => `    ${l.slice(0, 200)}`).join("\n"));
      else console.log("    (lượt JIT bật không in khối JIT: — tức JIT không biên dịch câu này)");
      if (chamNhat.indexOf(c) === 0) {
        console.log("    ── kế hoạch ĐẦY ĐỦ, lượt JIT TẮT cuối cùng, KHÔNG cắt ──");
        console.log(keHoachTat.map((l) => `    ${l}`).join("\n"));
      }
    }
    await pool.end().catch(() => undefined);
  }

  console.log("\n── CÂU CHẬM BÊN TRONG TỪNG HÀM TRỌNG ĐIỂM (lượt nguội, từ 50ms) ──");
  for (const [fn, cau] of cauTheoHam) {
    console.log(`\n  ${fn}: ${cau.length ? "" : "(không câu nào từ 50ms)"}`);
    for (const c of cau) console.log(`    ${String(c.ms).padStart(6)}ms  ${c.sql}`);
  }

  console.log("\n── TÁM CÂU LỆNH SQL CHẬM NHẤT (nguyên văn, cắt 600 ký tự) ──");
  if (!chamNhat.length) console.log("  (không câu lệnh nào vượt 200ms)");
  for (const c of chamNhat) {
    const gon = c.full.replace(/\s+/g, " ").trim();
    // Câu chậm ở đây đi thẳng qua POOL, tức là CHƯA được bọc `chayKhongJit` (câu đã bọc chạy trong giao dịch).
    console.log(`\n  ${c.ms}ms · hàm: ${c.ham ?? "(ngoài timed)"} · ngoài chayKhongJit\n  ĐẦU: ${c.sql}\n  ĐUÔI: …${gon.slice(-500)}`);
  }
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
