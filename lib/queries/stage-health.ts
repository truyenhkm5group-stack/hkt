import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import {
  CASE_ACTION,
  CASE_SLA_HOURS,
  CASE_TYPE_LABEL,
  KIND_TO_CASE,
  CASE_TEAM,
  TEAM_LABEL,
  ageLabel,
  type CaseTeam,
  type CaseType,
} from "@/lib/constants/action-queue";
import { AGING_BUCKETS, OPERATING_FUNNEL, type AgingKey, type SourceStatus, type StageKey, type StageSpec } from "@/lib/constants/operating-funnel";
import { combineImpact, getRecoveryRates, type MoneyImpact } from "@/lib/queries/impact";
import { getLogisticsFreshness, type LogisticsFreshness } from "@/lib/queries/logistics-freshness";
import { getReturnPipeline } from "@/lib/queries/return-pipeline";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ SỨC KHOẺ TỪNG KHÂU VẬN HÀNH ═══════════
 *
 * Một màn hình duy nhất trả lời bốn câu, cho từng khâu:
 *
 *   A. ĐANG KẸT Ở ĐÂU?               → `backlog` + `aging` + `oldestHours`
 *   B. VIỆC NÀO CẦN LÀM NGAY?        → `exceptions` (đã xếp theo tiền treo), `action`
 *   C. AI PHỤ TRÁCH?                 → `team`
 *   D. THU HỒI ĐƯỢC BAO NHIÊU TIỀN?  → `impact` — tiền treo (SỰ THẬT) tách khỏi ước tính thu hồi
 *
 * ─── VÌ SAO ĐỌC TỪ HÀNG ĐỢI VIỆC, KHÔNG ĐẾM LẠI TỪ ĐƠN ───
 *
 * Cám dỗ lớn nhất khi dựng bảng điều khiển là tự viết một câu đếm cho mỗi ô. Làm thế thì sáu tháng
 * sau con số "đơn kẹt" trên bảng điều khiển và con số trên trang Cần xử lý lệch nhau, không ai biết
 * cái nào đúng, và cả hai cùng mất giá trị.
 *
 * Nên khâu ở đây không có luật phát hiện riêng. Nó cộng lại chính những việc mà hàng đợi đã phát
 * hiện, đã chống trùng, đã tự đóng khi điều kiện hết. Bấm vào một khâu là ra đúng những việc đó.
 *
 * Hệ quả phải nói thẳng: **khâu nào không có luật cảnh báo thì không có tồn đọng để hiện.** Đó là
 * `DATA_UNAVAILABLE`, không phải "khâu này đang khoẻ".
 */

/** Ngưỡng tồn đọng để gọi là đang kẹt. Đặt một chỗ; sửa ở đây là sửa mọi khâu. */
const NGUONG = { canhBao: 10, kẹt: 40 } as const;

export type StageStatus = "OK" | "WARNING" | "BLOCKED" | "UNKNOWN";

export type StageException = {
  type: CaseType;
  label: string;
  count: number;
  /** Tiền đang treo ở loại việc này (đồng). SỰ THẬT, không nhân hệ số. */
  amount: number;
  /** Việc quá hạn xử lý. Loại việc cố ý không đặt hạn thì luôn 0. */
  breached: number;
  /** Việc chưa ai nhận trong loại này. */
  unassigned: number;
  oldestHours: number;
  action: string;
  href: string;
};

export type StageHealth = {
  key: StageKey;
  label: string;
  order: number;
  team: CaseTeam;
  teamLabel: string;
  status: StageStatus;
  /** Số việc đang mở thuộc khâu này. */
  backlog: number;
  /** Việc chưa ai nhận — con số quan trọng nhất của một khâu đang tắc. */
  unassigned: number;
  /**
   * Số VIỆC đang mở trong hàng đợi cho khâu này.
   *
   * Thường bằng `backlog`. Khác nhau ở khâu hàng hoàn, và khác một cách CÓ CHỦ Ý: hàng đợi cố ý
   * chỉ mở 15 việc đích danh + 1 việc gộp, còn `backlog` là dân số thật (đo được 484 kiện). Hiện
   * cả hai để không ai nhìn 16 rồi tưởng chỉ còn 16 kiện.
   */
  queueCases: number;
  /** Chia theo tuổi việc — thứ phân biệt "đang bận" với "đang tắc". */
  aging: Record<AgingKey, number>;
  oldestHours: number;
  oldestLabel: string;
  /**
   * Tuổi TRUNG VỊ và p90 của việc đang mở ở khâu này.
   *
   * "Cũ nhất" một mình nói dối theo cả hai hướng: một việc bị quên từ tháng trước làm khâu đang chạy
   * tốt trông như thảm hoạ, còn 200 việc mới tinh thì trông như không có gì. Trung vị nói tình hình
   * chung, p90 nói cái đuôi — và cái đuôi mới là chỗ khách bỏ đi.
   */
  medianAgeHours: number;
  p90AgeHours: number;
  /** Việc đã quá hạn xử lý theo SLA của chính loại việc đó. */
  breached: number;
  impact: MoneyImpact;
  exceptions: StageException[];
  /** Việc nên làm đầu tiên ở khâu này — lấy từ ngoại lệ treo nhiều tiền nhất. */
  nextAction: string | null;
  href: string;
  sourceStatus: SourceStatus;
  sourceNote: string;
  moneyMeaning: string;
  /** Tỷ lệ chuyển sang khâu sau. `null` = khâu này không có phép đo chuyển đổi nào có nghĩa. */
  conversion: { label: string; inCount: number; outCount: number; rate: number } | null;
};

/**
 * Gộp theo BỘ PHẬN — trả lời câu C ("ai phụ trách") ở mức cả ngày, không phải từng việc.
 *
 * Có `unassigned` vì đó là con số nói lên nhiều nhất: 40 việc đã có người cầm khác hẳn 40 việc
 * không ai cầm, dù cả hai cùng hiện "40 việc đang mở".
 */
export type TeamLoad = {
  team: CaseTeam;
  label: string;
  backlog: number;
  breached: number;
  unassigned: number;
  moneyAtRisk: number;
  /** Khâu nặng nhất của bộ phận này — chỗ để bắt đầu. */
  worstStage: string | null;
};

/**
 * Độ tươi của trạng thái vận đơn — nói ra vì một khâu "thông" trên màn hình mà số liệu bên dưới cũ
 * ba tiếng thì màn hình đang nói dối một cách lịch sự.
 */
export type LogisticsDataFreshness = {
  inFlight: number;
  /** Kiện có sự kiện ĐVVC cũ hơn ngưỡng của chặng nó đang ở. */
  stale: number;
  critical: number;
  /** Webhook còn sống không — con số này mới nói integration có đang chạy hay không. */
  webhookLastHour: number;
  webhookLast24h: number;
  /** Số lượt tra cứu liên tiếp mà tài khoản API VTP không thấy vận đơn nào. */
  apiBlindStreak: number;
  /** Câu giải thích nguyên nhân + việc cần làm. `null` khi mọi thứ bình thường. */
  note: string | null;
  href: string;
};

export type FunnelHealth = {
  stages: StageHealth[];
  /** Trạng thái vận đơn đang tươi tới đâu. */
  logistics: LogisticsDataFreshness;
  /** Tải việc theo bộ phận, xếp nhiều tiền treo trước. */
  byTeam: TeamLoad[];
  /** Khâu tắc nhất — nhiều tiền treo nhất trong nhóm đang kẹt. `null` khi không khâu nào kẹt. */
  worst: StageHealth | null;
  totalBacklog: number;
  totalAtRisk: number;
  /** Tổng ước tính thu hồi. `null` khi không khâu nào đủ mẫu lịch sử. */
  totalRecoverable: number | null;
  /** Phần tiền treo nằm ở loại việc chưa đo được tỷ lệ cứu — nói ra để không ai tưởng đã tính hết. */
  unestimatedAtRisk: number;
  measuredAt: Date;
};

/** Số lượt, viết gọn để câu giải thích không bị một con số dài nuốt mất ý. */
function formatSoLuot(n: number): string {
  return n >= 1000 ? `${Math.floor(n / 100) / 10} nghìn` : String(n);
}

/** Khâu nào ứng với loại việc nào — đảo ngược sổ đăng ký, dựng một lần. */
const STAGE_OF_CASE = new Map<CaseType, StageKey>();
for (const s of OPERATING_FUNNEL) for (const t of s.caseTypes) if (!STAGE_OF_CASE.has(t)) STAGE_OF_CASE.set(t, s.key);

/**
 * BIỂU THỨC HẠN XỬ LÝ, sinh từ chính `CASE_SLA_HOURS`.
 *
 * Đếm việc trễ hạn trong CSDL nhanh hơn nhiều so với nạp cả nghìn dòng lên rồi lọc trong ứng dụng.
 * Nhưng ngưỡng vẫn chỉ có MỘT nguồn: câu SQL này được dựng từ hằng số, không gõ lại số giờ.
 * Loại việc `null` (cố ý không đặt hạn) không xuất hiện trong biểu thức nên không bao giờ bị đếm trễ.
 */
function slaBreachExpr() {
  const parts = Object.entries(KIND_TO_CASE)
    .map(([kind, type]) => [kind, CASE_SLA_HOURS[type]] as const)
    .filter(([, hours]) => hours !== null)
    .map(([kind, hours]) => sql`when n.kind = ${kind} then ${hours}`);
  if (!parts.length) return sql`false`;
  const cases = parts.reduce((a, b) => sql`${a} ${b}`);
  /*
    ÉP KIỂU TƯỜNG MINH — KHÔNG BỎ ĐƯỢC.

    Tham số rời không mang kiểu, nên Postgres suy mọi nhánh `then` ra text rồi so sánh
    numeric với text và từ chối: `operator does not exist: numeric > text`.

    Đây là lần thứ HAI cùng một lỗi trong một ngày (lần đầu ở lib/queries/return-pipeline.ts).
    `tsc` không thấy được: cả hai cách viết đều là SQL hợp lệ về kiểu TypeScript.
  */
  return sql`extract(epoch from (now() - coalesce(n.occurred_at, n.created_at))) / 3600 > (case ${cases} else null end)::numeric`;
}

/** Cột đếm cho từng mốc tuổi: `giờ >= mốc trước` và `< mốc này`. */
function agingCols() {
  const age = sql`extract(epoch from (now() - coalesce(n.occurred_at, n.created_at))) / 3600`;
  const cols = AGING_BUCKETS.map((b, i) => {
    const from = i === 0 ? 0 : AGING_BUCKETS[i - 1].maxHours;
    const cond = Number.isFinite(b.maxHours) ? sql`${age} >= ${from} and ${age} < ${b.maxHours}` : sql`${age} >= ${from}`;
    return sql`, count(*) filter (where ${cond})::int as ${sql.identifier(b.key)}`;
  });
  return cols.reduce((a, b) => sql`${a}${b}`);
}

type KindRow = {
  kind: string;
  n: number;
  money: string | number;
  breached: number;
  unassigned: number;
  oldest: string | number;
  median_h: string | number | null;
  p90_h: string | number | null;
} & Record<AgingKey, number>;

type TypeTotals = { count: number; money: number; breached: number; unassigned: number; oldest: number; median: number; p90: number } & Record<AgingKey, number>;

function emptyAging(): Record<AgingKey, number> {
  const out = {} as Record<AgingKey, number>;
  for (const b of AGING_BUCKETS) out[b.key] = 0;
  return out;
}

function emptyTotals(): TypeTotals {
  return { count: 0, money: 0, breached: 0, unassigned: 0, oldest: 0, median: 0, p90: 0, ...emptyAging() };
}

/**
 * Một câu duy nhất cho toàn bộ bảng điều khiển.
 *
 * Tiền lấy từ đơn (giá trị đơn) hoặc vận đơn (COD) tuỳ đối tượng của việc — cùng một trục tiền,
 * không cộng chồng, giống hệt cách hàng đợi việc chấm điểm. Việc gắn với mẫu mã / tài khoản quảng
 * cáo không có số tiền tra được thì là 0, và phần "chưa ước tính được" sẽ nói giúp điều đó.
 */
async function loadKindRows(): Promise<KindRow[]> {
  const db = await getDb();
  return rowsOf<KindRow>(
    await db.execute(sql`
      select n.kind,
             count(*)::int as n,
             coalesce(sum(coalesce(o.total_price_after_discount, s.cod_amount, 0)), 0) as money,
             count(*) filter (where ${slaBreachExpr()})::int as breached,
             count(*) filter (where n.assigned_to is null)::int as unassigned,
             coalesce(max(extract(epoch from (now() - coalesce(n.occurred_at, n.created_at))) / 3600), 0) as oldest,
             percentile_cont(0.5) within group (order by extract(epoch from (now() - coalesce(n.occurred_at, n.created_at))) / 3600) as median_h,
             percentile_cont(0.9) within group (order by extract(epoch from (now() - coalesce(n.occurred_at, n.created_at))) / 3600) as p90_h
             ${agingCols()}
        from notifications n
        left join orders o on o.id = n.entity_id and n.entity_type = 'ORDER'
        left join shipments s on s.id = n.entity_id and n.entity_type = 'SHIPMENT'
       -- Việc đã đóng hoặc đã cố ý bỏ qua KHÔNG phải tồn đọng: đếm chúng là báo tắc ở nơi đã thông.
       where n.resolved_at is null and n.ignored_at is null
       group by n.kind
    `),
  );
}

/** Nguồn dữ liệu của từng khâu có thật hay không — đo, không khai sẵn. */
/**
 * ═══════ ĐỘ TƯƠI ĐỌC TỪ SỰ KIỆN ĐVVC, KHÔNG PHẢI TỪ LẦN TRA CỨU ═══════
 *
 * Bản đầu ở đây đếm `last_vtp_sync_at` — "lần cuối ERP gọi API". Con số đó VÔ NGHĨA: đo được nguồn
 * `VTP_POLL` sinh ra **0 sự kiện từ trước tới nay**, nên một lần tra cứu không làm dữ liệu tươi thêm
 * một giây nào. Nó chỉ nói "ta có gọi", không nói "ta có biết kiện hàng đang ở đâu".
 *
 * Nay dùng `lib/queries/logistics-freshness.ts`: tuổi tính từ SỰ KIỆN ĐVVC gần nhất, ngưỡng theo
 * từng chặng.
 */
async function loadSourceStatus(db: Awaited<ReturnType<typeof getDb>>, tuoi: LogisticsFreshness): Promise<Record<StageKey, SourceStatus>> {
  const [row] = rowsOf<{ bank: number; production: number; inspections: number; receipts: number; cs: number }>(
    await db.execute(sql`
      select (select count(*)::int from bank_transactions) as bank,
             (select count(*)::int from production_orders) as production,
             (select count(*)::int from return_inspections) as inspections,
             (select count(*)::int from stock_receipts) as receipts,
             (select count(*)::int from cs_cases) as cs`),
  );
  const bank = Number(row?.bank ?? 0);
  const production = Number(row?.production ?? 0);
  const receipts = Number(row?.receipts ?? 0);
  const cs = Number(row?.cs ?? 0);

  const base = Object.fromEntries(OPERATING_FUNNEL.map((s) => [s.key, "HEALTHY" as SourceStatus])) as Record<StageKey, SourceStatus>;
  // Có case CSKH nhưng KHÔNG có mốc phản hồi đầu tiên ⇒ đo được tồn đọng, chưa đo được tốc độ.
  base.LEAD = cs > 0 ? "DEGRADED" : "DATA_UNAVAILABLE";
  // Chưa có lệnh sản xuất nào ⇒ không có gì để đo. Không hiện 0 như thể mọi thứ đúng hạn.
  base.PRODUCTION = production > 0 ? "HEALTHY" : "DATA_UNAVAILABLE";
  // Sổ ngân hàng trống ⇒ đối chiếu tiền về mới chỉ dựa vào bảng kê ĐVVC, chưa có số dư thật đối ứng.
  base.CASH_RECEIVED = bank > 0 ? "HEALTHY" : "DEGRADED";
  // Ít phiếu nhập ⇒ phần lớn mẫu mã chưa biết tồn, sổ kho nói được rất ít.
  base.INVENTORY = receipts > 0 ? (receipts < 10 ? "DEGRADED" : "HEALTHY") : "DATA_UNAVAILABLE";
  /*
    Quá NỬA số kiện đang chạy im lặng quá ngưỡng của chặng nó đang ở ⇒ khâu giao vận KHÔNG được coi
    là nguồn khoẻ. Ngưỡng một nửa, cố ý rộng: vài kiện chậm là bình thường, quá nửa là hệ thống đang
    nhìn logistics qua một cửa sổ mờ.

    DEGRADED ở đây là NGUỒN yếu, KHÔNG phải đơn hỏng. Nó không đổi kết quả của một đơn nào.
  */
  const khongTuoi = tuoi.byClass.STALE + tuoi.byClass.CRITICAL_STALE;
  if (tuoi.inFlight > 0 && khongTuoi * 2 > tuoi.inFlight) {
    base.HANDED_TO_CARRIER = "DEGRADED";
    base.IN_TRANSIT = "DEGRADED";
    base.RETURNING = "DEGRADED";
  }
  return base;
}

function statusOf(spec: StageSpec, backlog: number, breached: number, source: SourceStatus): StageStatus {
  if (source === "DATA_UNAVAILABLE") return "UNKNOWN";
  if (!spec.caseTypes.length) return "UNKNOWN";
  if (backlog >= NGUONG.kẹt || breached > 0) return "BLOCKED";
  if (backlog >= NGUONG.canhBao) return "WARNING";
  return "OK";
}

/**
 * SỨC KHOẺ TOÀN PHỄU.
 *
 * Đệm 120 giây: bảng này là thứ người vận hành mở đầu ngày và F5 liên tục, còn dữ liệu bên dưới
 * chỉ đổi khi job phát hiện chạy — làm mới nhanh hơn chu kỳ đó là đốt CPU của một máy hai nhân.
 */
export async function getFunnelHealth(): Promise<FunnelHealth> {
  return memo("stage-health", 120_000, async () => {
    const db = await getDb();
    const tuoiVanDon = await getLogisticsFreshness();
    const [kindRows, source, rates, hoan] = await Promise.all([
      loadKindRows(),
      loadSourceStatus(db, tuoiVanDon),
      getRecoveryRates(),
      getReturnPipeline(),
    ]);

    // Gom theo LOẠI VIỆC trước (nhiều `kind` có thể về cùng một loại), rồi mới gom theo khâu.
    const byType = new Map<CaseType, TypeTotals>();
    for (const r of kindRows) {
      const type = KIND_TO_CASE[r.kind] ?? "OTHER";
      const cur = byType.get(type) ?? emptyTotals();
      cur.count += Number(r.n ?? 0);
      cur.money += Number(r.money ?? 0);
      cur.breached += Number(r.breached ?? 0);
      cur.unassigned += Number(r.unassigned ?? 0);
      cur.oldest = Math.max(cur.oldest, Number(r.oldest ?? 0));
      // Trung vị/p90 gộp từ nhiều `kind` về một loại việc: lấy trọng số theo SỐ VIỆC, không lấy
      // trung bình cộng của hai trung vị — hai nhóm lệch nhau về cỡ thì trung bình cộng nói sai.
      const soCu = cur.count - Number(r.n ?? 0);
      const soMoi = Number(r.n ?? 0);
      const tong = soCu + soMoi;
      if (tong > 0) {
        cur.median = (cur.median * soCu + Number(r.median_h ?? 0) * soMoi) / tong;
        cur.p90 = Math.max(cur.p90, Number(r.p90_h ?? 0));
      }
      for (const b of AGING_BUCKETS) cur[b.key] += Number(r[b.key] ?? 0);
      byType.set(type, cur);
    }

    const stages: StageHealth[] = OPERATING_FUNNEL.map((spec) => {
      const aging = emptyAging();
      const exceptions: StageException[] = [];
      let backlog = 0;
      let breached = 0;
      let unassigned = 0;
      let oldest = 0;
      let medianSum = 0;
      let p90 = 0;

      for (const type of spec.caseTypes) {
        // Loại việc chỉ thuộc về MỘT khâu — nếu không, một đồng bị đếm ở hai chỗ và tổng sai.
        if (STAGE_OF_CASE.get(type) !== spec.key) continue;
        const v = byType.get(type);
        if (!v || v.count === 0) continue;
        backlog += v.count;
        breached += v.breached;
        unassigned += v.unassigned;
        oldest = Math.max(oldest, v.oldest);
        medianSum += v.median * v.count;
        p90 = Math.max(p90, v.p90);
        for (const b of AGING_BUCKETS) aging[b.key] += v[b.key];
        exceptions.push({
          type,
          label: CASE_TYPE_LABEL[type],
          count: v.count,
          amount: v.money,
          breached: v.breached,
          unassigned: v.unassigned,
          oldestHours: v.oldest,
          action: CASE_ACTION[type],
          href: `/alerts?type=${type}`,
        });
      }

      exceptions.sort((a, b) => b.amount - a.amount || b.count - a.count);

      /*
        ═══ KHÂU HÀNG HOÀN ĐỌC TỪ ĐƯỜNG ỐNG, KHÔNG TỪ HÀNG ĐỢI VIỆC ═══

        Đây là khâu DUY NHẤT mà hai con số khác nhau một cách chính đáng, và phải nói rõ vì sao.

        Hàng đợi việc cố ý chỉ mở 16 việc: nêu đích danh 15 kiện cũ nhất rồi gộp phần còn lại thành
        MỘT việc — sinh mỗi kiện một việc sẽ đẩy vài trăm dòng vào hàng đợi cùng lúc và làm cả hàng
        đợi bị bỏ qua. Quyết định đó đúng cho HÀNG ĐỢI.

        Nhưng nó sai cho BẢNG ĐIỀU HÀNH. Đo trên production 10/09/2026: 16 việc ↔ 484 kiện thật giữ
        77,5 triệu vốn. Lấy 16 làm số của khâu là báo cáo thiếu đi 77 triệu.

        Nên: tồn đọng và tiền lấy từ đường ống (dân số thật), còn "việc cần làm ngay" vẫn là 16 của
        hàng đợi. Hai câu hỏi khác nhau, hai con số khác nhau, cùng hiện ra.
      */
      if (spec.key === "RETURN_INSPECTION") {
        const cho = hoan.stages.filter((h) => h.actionable && h.parcels > 0);
        const kien = cho.reduce((t, h) => t + h.parcels, 0);
        if (kien > 0) {
          backlog = kien;
          breached = cho.reduce((t, h) => t + h.slaBreach, 0);
          oldest = Math.max(oldest, ...cho.map((h) => h.oldestHours));
          // Tuổi cũng phải lấy từ đường ống: tuổi của 16 việc cảnh báo không mô tả 484 kiện thật.
          medianSum = cho.reduce((t, h) => t + h.medianAgeHours * h.parcels, 0);
          p90 = Math.max(p90, ...cho.map((h) => h.p90AgeHours));
          for (const b of AGING_BUCKETS) aging[b.key] = 0;
          // Chia mốc tuổi theo tuổi TRUNG VỊ của từng khâu: không có tuổi từng kiện ở đây, và bịa
          // một phân phối chi tiết thì tệ hơn là nói thẳng mức trung bình.
          for (const h of cho) {
            const moc = AGING_BUCKETS.find((b) => h.medianAgeHours < b.maxHours) ?? AGING_BUCKETS[AGING_BUCKETS.length - 1];
            aging[moc.key] += h.parcels;
          }
        }
      }
      const impact =
        spec.key === "RETURN_INSPECTION"
          ? {
              // Vốn kẹt là SỰ THẬT đo từ giá vốn đơn. "Cứu được" ở đây nghĩa là hàng vào lại tồn —
              // một định nghĩa khác hẳn "đơn giao thành công", nên KHÔNG dùng bộ ước lượng chung.
              moneyAtRisk: hoan.capitalLocked,
              estimatedRecoverable: null,
              estimateBasis: null,
              sample: null,
              unestimatedAtRisk: hoan.capitalLocked,
            }
          : combineImpact(
              exceptions.map((e) => ({ type: e.type, amount: e.amount })),
              rates,
            );
      const src = source[spec.key];

      return {
        key: spec.key,
        label: spec.label,
        order: spec.order,
        team: spec.team,
        teamLabel: TEAM_LABEL[spec.team],
        status: statusOf(spec, backlog, breached, src),
        backlog,
        queueCases: exceptions.reduce((t, e) => t + e.count, 0),
        unassigned,
        aging,
        oldestHours: oldest,
        oldestLabel: oldest > 0 ? ageLabel(oldest) : "—",
        medianAgeHours: backlog > 0 ? medianSum / backlog : 0,
        p90AgeHours: p90,
        breached,
        impact,
        exceptions,
        nextAction: exceptions[0]?.action ?? null,
        href: spec.href,
        sourceStatus: src,
        sourceNote: spec.sourceNote,
        moneyMeaning: spec.moneyMeaning,
        conversion: null,
      };
    });

    /*
      TẢI VIỆC THEO BỘ PHẬN — cộng theo ĐỘI CỦA TỪNG LOẠI VIỆC, không theo đội chủ khâu.

      Hai thứ này khác nhau và trộn vào nhau là quy trách nhiệm nhầm người: khâu "Đang giao" do
      giao vận trông, nhưng việc "đơn đã huỷ mà hàng vẫn đang đi" thì ai gọi ĐVVC thu hồi mới là
      người xử lý. `CASE_TEAM` đã trả lời câu đó cho từng loại việc; ở đây chỉ cộng lại.
    */
    const teams = new Map<CaseTeam, TeamLoad>();
    const nangNhat = new Map<CaseTeam, { label: string; money: number }>();
    for (const st of stages) {
      for (const e of st.exceptions) {
        const team = CASE_TEAM[e.type];
        const cur = teams.get(team) ?? { team, label: TEAM_LABEL[team], backlog: 0, breached: 0, unassigned: 0, moneyAtRisk: 0, worstStage: null };
        cur.backlog += e.count;
        cur.breached += e.breached;
        cur.unassigned += e.unassigned;
        cur.moneyAtRisk += e.amount;
        teams.set(team, cur);
        // Khâu nặng nhất tính theo TIỀN, không theo số việc: 3 việc treo 40 triệu cần người trước
        // 200 việc treo 2 triệu.
        const dinh = nangNhat.get(team);
        if (!dinh || e.amount > dinh.money) nangNhat.set(team, { label: st.label, money: e.amount });
      }
    }
    for (const load of teams.values()) load.worstStage = nangNhat.get(load.team)?.label ?? null;

    const kẹt = stages.filter((s) => s.status === "BLOCKED" || s.status === "WARNING");
    const worst = kẹt.slice().sort((a, b) => b.impact.moneyAtRisk - a.impact.moneyAtRisk || b.backlog - a.backlog)[0] ?? null;
    const coUocTinh = stages.some((s) => s.impact.estimatedRecoverable !== null);

    const khongTuoi = tuoiVanDon.byClass.STALE + tuoiVanDon.byClass.CRITICAL_STALE;
    const cuQuaNua = tuoiVanDon.inFlight > 0 && khongTuoi * 2 > tuoiVanDon.inFlight;
    return {
      stages,
      logistics: {
        inFlight: tuoiVanDon.inFlight,
        stale: khongTuoi,
        critical: tuoiVanDon.byClass.CRITICAL_STALE,
        webhookLastHour: tuoiVanDon.webhookLastHour,
        webhookLast24h: tuoiVanDon.webhookLast24h,
        apiBlindStreak: tuoiVanDon.apiBlindStreak,
        note: !cuQuaNua
          ? null
          : tuoiVanDon.apiBlindStreak >= 3
            ? `Tài khoản API Viettel Post KHÔNG thấy vận đơn của shop (${formatSoLuot(tuoiVanDon.apiBlindStreak)} lượt tra liên tiếp không có kết quả) — vận đơn do Pancake tạo thuộc tài khoản VTP khác. Bộ tra cứu đã tự hạ xuống chế độ dò để khỏi đập vào một API không trả về gì, nên trạng thái vận đơn hiện CHỈ đến từ webhook. VIỆC CẦN LÀM: trỏ ERP về đúng tài khoản Viettel Post mà Pancake đang dùng.`
            : `Quá nửa số kiện đang chạy (${formatSoLuot(khongTuoi)}/${formatSoLuot(tuoiVanDon.inFlight)}) im lặng quá ngưỡng của chặng. Webhook nhận ${formatSoLuot(tuoiVanDon.webhookLastHour)} sự kiện trong 1 giờ qua, ${formatSoLuot(tuoiVanDon.webhookLast24h)} trong 24 giờ. Đây là vấn đề ĐỘ TƯƠI DỮ LIỆU, không phải kết luận về đơn: kết quả đơn vẫn theo chứng từ cuối cùng.`,
        href: "/integrations",
      },
      byTeam: [...teams.values()].sort((a, b) => b.moneyAtRisk - a.moneyAtRisk || b.backlog - a.backlog),
      worst,
      totalBacklog: stages.reduce((a, s) => a + s.backlog, 0),
      totalAtRisk: stages.reduce((a, s) => a + s.impact.moneyAtRisk, 0),
      totalRecoverable: coUocTinh ? stages.reduce((a, s) => a + (s.impact.estimatedRecoverable ?? 0), 0) : null,
      unestimatedAtRisk: stages.reduce((a, s) => a + s.impact.unestimatedAtRisk, 0),
      measuredAt: new Date(),
    };
  });
}

/**
 * ═══════════ BẢNG GHI CÔNG: VIỆC LÀM XONG ĐÃ ĐEM VỀ GÌ ═══════════
 *
 * Đây là vòng phản hồi mà một hàng đợi việc thiếu thì sớm muộn cũng bị bỏ: người vận hành xử lý cả
 * ngày mà không có gì nói lại rằng công đó đáng bao nhiêu.
 *
 * Ba con số, ba nghĩa khác hẳn nhau, cố ý KHÔNG gộp:
 *
 *  · `closedByPeople`  — số việc CÓ NGƯỜI bấm đóng. Việc tự đóng vì điều kiện hết không tính:
 *                        đơn tự đi tiếp thì không phải công của ai.
 *  · `valueHandled`    — tiền nằm trong những việc đó lúc chúng được đóng. Là KHỐI LƯỢNG đã đụng
 *                        tới, KHÔNG phải tiền thu về.
 *  · `recoveredValue`  — SỰ THẬT, không phải ước tính: phần trong đó có đơn CUỐI CÙNG giao thành
 *                        công, đọc thẳng từ bảng kết quả đơn.
 *
 * Vì sao `recoveredValue` không phải là "công của người xử lý" một cách tuyệt đối: vài đơn vẫn về
 * đích dù không ai làm gì. Bảng này KHÔNG tuyên bố nhân quả — nó nói "những việc đã xử lý mang theo
 * ngần này tiền, và ngần này trong đó đã về đích". Đủ để thấy công việc có nghĩa, không quá lời.
 */
export type RecoveryScoreboard = {
  days: number;
  closedByPeople: number;
  /** Việc điều kiện tự hết — nêu ra để không ai nhầm nó là năng suất. */
  closedAutomatically: number;
  valueHandled: number;
  recoveredValue: number;
  /** Số việc trong nhóm đã đóng mà đơn về đích. */
  deliveredCases: number;
};

export async function getRecoveryScoreboard(days = 7): Promise<RecoveryScoreboard> {
  return memo(`stage-health:scoreboard:${days}`, 300_000, async () => {
    const db = await getDb();
    const [row] = rowsOf<{ closed: number; auto: number; handled: string | number; recovered: string | number; delivered: number }>(
      await db.execute(sql`
        with viec as (
          select n.id,
                 n.resolution,
                 coalesce(o.total_price_after_discount, s.cod_amount, 0) as tien,
                 -- MỘT DÒNG MỖI VIỆC. Bảng kết quả đơn có grain (đơn × vận đơn), nối thẳng vào sẽ
                 -- nhân tiền của đơn nhiều lần gửi lên đúng bằng số lần gửi.
                 exists (select 1 from canonical_order_outcome m where m.order_id = n.entity_id and m.outcome = 'DELIVERED') as ve_dich
            from notifications n
            left join orders o on o.id = n.entity_id and n.entity_type = 'ORDER'
            left join shipments s on s.id = n.entity_id and n.entity_type = 'SHIPMENT'
           where n.resolved_at >= now() - make_interval(days => ${days})
        )
        select count(*) filter (where resolution = 'MANUAL')::int as closed,
               count(*) filter (where resolution = 'AUTO')::int as auto,
               coalesce(sum(tien) filter (where resolution = 'MANUAL'), 0) as handled,
               coalesce(sum(tien) filter (where resolution = 'MANUAL' and ve_dich), 0) as recovered,
               count(*) filter (where resolution = 'MANUAL' and ve_dich)::int as delivered
          from viec
      `),
    );
    return {
      days,
      closedByPeople: Number(row?.closed ?? 0),
      closedAutomatically: Number(row?.auto ?? 0),
      valueHandled: Number(row?.handled ?? 0),
      recoveredValue: Number(row?.recovered ?? 0),
      deliveredCases: Number(row?.delivered ?? 0),
    };
  });
}
