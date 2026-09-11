import { and, eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { PANCAKE_ORDER_STATUS } from "@/lib/constants/pancake";
import { CONVERSION_DIMENSION_LABEL, dimensionHasUnassigned, ORDER_STEPS, type ConversionDimension, type EvidenceTier, type OrderStepKey } from "@/lib/constants/conversion";
import { LOW_COVERAGE_PCT, UNASSIGNED_LABEL, type AttributionField } from "@/lib/constants/sales-funnel";
import { successRate } from "@/lib/queries/metrics";
import { ORDER_SOURCE, ORDER_SOURCE_LABEL, type OrderSourceKey } from "@/lib/queries/order-source";
import { ORDER_OUTCOME_FAST, OUTCOME_FENCE, PRIMARY_ATTEMPT, SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ PHỄU ĐƠN HÀNG: TẠO → XÁC NHẬN → VẬN ĐƠN → RỜI KHO → GIAO ═══════════
 *
 * Đặc tả: `docs/revenue-conversion-contract.md` · hằng số: `lib/constants/conversion.ts`.
 *
 * Khác `getSalesFunnel` (`lib/queries/sales-funnel.ts`) ở ba chỗ, và ba chỗ đó là lý do file này tồn
 * tại — không phải để có thêm một phễu thứ hai:
 *
 *  1. **Tách "đã tạo vận đơn" khỏi "hàng đã rời kho".** Phễu cũ nhảy thẳng từ xác nhận sang rời kho,
 *     nên khoảng trống lớn nhất của kho — mã đã in mà bưu tá chưa lấy — không hiện ra ở đâu.
 *  2. **Có THỜI GIAN giữa các bước**, không chỉ số lượng. Một phễu không có thời gian không nói được
 *     đơn đang KẸT ở đâu, mà kẹt mới là thứ làm được gì đó ngay.
 *  3. **Đơn khuyết bằng chứng hiện thành số**, không bị kẹp lặng lẽ (xem `evidenceGaps`).
 *
 * ─── PHỄU KHÔNG PHÌNH: ĐO THEO "ĐI ĐƯỢC TỚI ĐÂU", KHÔNG ĐẾM TỪNG BƯỚC RỜI RẠC ───
 *
 * Mỗi đơn được gán một MỨC ĐI ĐƯỢC (1..5), rồi bước n = số đơn có mức ≥ n. Phễu vì thế thu hẹp theo
 * ĐỊNH NGHĨA, không nhờ kẹp số.
 *
 * Vì sao phải làm thế thay vì đếm từng bước độc lập: một đơn bị huỷ sau khi đã gửi vẫn ĐÃ TỪNG rời
 * kho, và một đơn `ORDER_OUTCOME = DELIVERED` có thể KHÔNG có dòng vận đơn nào (luật kết quả đơn có
 * nhánh dựa trên trạng thái Pancake `DELIVERED`/`PAID`). Đếm rời rạc thì "đã rời kho" có thể lớn hơn
 * "đã xác nhận", và cái hình vẽ ra không còn là cái phễu.
 *
 * ─── VÀ ĐÂY LÀ CHỖ PHẢI CẨN THẬN NHẤT ───
 *
 * Bước cuối dùng ĐÚNG `ORDER_OUTCOME_FAST = 'DELIVERED'`, KHÔNG phải "rời kho VÀ giao thành công".
 * Thêm điều kiện "và" vào sẽ tạo ra định nghĩa giao thành công THỨ HAI trong ERP — thứ mà `AGENTS.md`
 * mục 3.1 cấm tuyệt đối. Nên đơn giao thành công mà thiếu chứng từ vận đơn được xếp mức 5 (nó ĐÃ tới
 * tay khách, chỉ là ERP không có chứng từ chặng giữa) và được ĐẾM RIÊNG ở `evidenceGaps` để không ai
 * tưởng dữ liệu đầy đủ.
 */

const o = schema.orders;
const s = schema.shipments;

/**
 * Trạng thái Pancake nghĩa là "đã rời trạng thái chờ".
 *
 * Suy từ `PANCAKE_ORDER_STATUS` chứ KHÔNG gõ tay danh sách số: thêm một trạng thái mới vào bảng đó
 * mà quên sửa ở đây thì mốc xác nhận sẽ lệch âm thầm.
 */
const CONFIRMED_STATUS_CODES = Object.entries(PANCAKE_ORDER_STATUS)
  .filter(([, v]) => v.stage !== "NEW" && v.stage !== "WAITING")
  .map(([k]) => Number(k));

/** Mốc XÁC NHẬN của đơn: lần đầu trạng thái rời khỏi nhóm chờ. `NULL` = chưa có lịch sử. */
const CONFIRMED_AT = sql`(
  select min(h.updated_at) from order_status_history h
   where h.order_id = ${o.id}
     and h.status in ${sql.raw(`(${CONFIRMED_STATUS_CODES.join(",")})`)}
)`;

/**
 * Mốc ERP GHI NHẬN vận đơn.
 *
 * CỐ Ý gọi là "ghi nhận" chứ không phải "tạo mã": `shipments.created_at` là lúc ERP đọc được vận
 * đơn, không phải lúc mã được tạo trên Viettel Post. Sự kiện hành trình sớm nhất gần sự thật hơn nên
 * được ưu tiên. Gọi nó là "lúc tạo mã" là gán cho một con số ý nghĩa nó không có.
 */
const SHIPMENT_SEEN_AT = sql`coalesce(
  (select min(e.occurred_at) from shipment_events e where e.shipment_id = ${s.id}),
  ${s.createdAt}
)`;

/**
 * Giờ giữa hai mốc, `NULL` khi thiếu một đầu hoặc khi mốc sau ngược trước mốc trước.
 *
 * Thiếu mốc là CHƯA BIẾT, KHÔNG phải 0 giờ: trả 0 sẽ kéo trung vị xuống bằng những đơn ta không đo
 * được, và con số đẹp đó mô tả sai đúng cái nó định mô tả.
 *
 * Mốc ngược (`to < from`) cũng trả `NULL`: dữ liệu Pancake / ĐVVC có thể lệch giờ, và một khoảng âm
 * là dấu hiệu dữ liệu sai, không phải một khoảng thời gian.
 */
function hoursBetween(from: unknown, to: unknown): SQL<number> {
  return sql<number>`case when ${from} is not null and ${to} is not null and ${to} >= ${from}
    then extract(epoch from (${to} - ${from})) / 3600 end`;
}

export type StepTiming = {
  /** Trung vị giờ từ bước trước tới bước này. `null` = không có cặp mốc nào đo được. */
  medianHours: number | null;
  p90Hours: number | null;
  /** Bao nhiêu phần đơn của bước này đo được thời gian (0–1). `null` khi bước rỗng. */
  coverage: number | null;
  /** Vì sao độ phủ thấp — hiện thẳng, không để người đọc đoán. */
  note: string;
};

export type ConversionStep = {
  key: OrderStepKey;
  label: string;
  count: number;
  /** So với bước ĐẦU (0–1). */
  ofStart: number;
  /** So với bước LIỀN TRƯỚC (0–1) — đây mới là tỷ lệ chuyển đổi của riêng bước này. */
  ofPrevious: number;
  previousLabel: string;
  /** Số đơn RƠI ở bước này = bước trước − bước này. */
  dropOff: number;
  /** Tỷ lệ rơi (0–1); `null` ở bước đầu (không có bước trước để so). */
  dropOffRate: number | null;
  tier: EvidenceTier;
  caveat: string;
  timing: StepTiming;
};

export type EvidenceGaps = {
  /** Giao thành công mà KHÔNG có dòng vận đơn nào — kết luận dựa trên trạng thái Pancake. */
  deliveredWithoutShipment: number;
  /** Có vận đơn mà đơn vẫn ở trạng thái chờ — Pancake chưa được cập nhật. */
  shipmentWithoutConfirm: number;
  /** Hàng đã rời kho mà không có lịch sử trạng thái nào để tính mốc xác nhận. */
  noStatusHistory: number;
};

export type ConversionFunnel = {
  steps: ConversionStep[];
  /** Đơn huỷ — RỜI phễu, không phải thất bại giao vận. */
  cancelled: number;
  /** Đơn huỷ SAU khi đã rời trạng thái chờ. Đây là phần bước "đã xác nhận" đang gánh. */
  cancelledAfterConfirm: number;
  /** Đơn chưa biết kết quả. KHÔNG được tính là thất bại. */
  unfinished: number;
  evidenceGaps: EvidenceGaps;
};

function periodWhere(period: Period): SQL {
  const from = period.from ? sql`${o.insertedAt} >= ${period.from.toISOString()}::timestamptz` : sql`true`;
  const to = period.to ? sql`${o.insertedAt} <= ${period.to.toISOString()}::timestamptz` : sql`true`;
  return sql`${from} and ${to}`;
}

/**
 * Bảng dẫn xuất một-dòng-một-đơn, kèm MỨC ĐI ĐƯỢC và các mốc thời gian.
 *
 * `OUTCOME_FENCE` (`offset 0`) là rào tối ưu hoá: không có nó Postgres kéo truy vấn con lên và nội
 * tuyến lại `ORDER_OUTCOME` vào TỪNG cột gộp — đã đo 27,7 giây so với 93 ms trên cùng dữ liệu.
 */
function funnelFacts(db: Awaited<ReturnType<typeof getDb>>, where: SQL, dimColumn: SQL = sql`''`) {
  return db
    .select({
      outcome: ORDER_OUTCOME_FAST.as("f_outcome"),
      revenue: sql<number>`${o.totalPriceAfterDiscount}`.as("f_revenue"),
      leftWarehouse: sql<boolean>`${SHIPMENT_LEFT_WAREHOUSE}`.as("f_left"),
      hasShipment: sql<boolean>`${s.id} is not null`.as("f_has_ship"),
      confirmedStage: sql<boolean>`${o.stage} not in ('NEW','WAITING')`.as("f_confirmed"),
      insertedAt: sql`${o.insertedAt}`.as("f_inserted"),
      confirmedAt: sql`${CONFIRMED_AT}`.as("f_confirmed_at"),
      shipmentSeenAt: sql`${SHIPMENT_SEEN_AT}`.as("f_ship_at"),
      pickedUpAt: sql`${s.pickedUpAt}`.as("f_picked_at"),
      deliveredAt: sql`${s.deliveredAt}`.as("f_delivered_at"),
      /** Chiều phân nhóm. `''` khi truy vấn không tách chiều — một hình dạng bảng duy nhất. */
      dimKey: sql<string>`${dimColumn}`.as("f_dim"),
    })
    .from(o)
    // MỖI ĐƠN MỘT DÒNG: đơn gửi lại hai lần không được đếm hai lần (xem PRIMARY_ATTEMPT).
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(where)
    .offset(OUTCOME_FENCE);
}

/**
 * MỨC ĐI ĐƯỢC của một đơn (1..5). Một biểu thức, một chỗ — mọi bước đọc lại nó.
 *
 * Xếp từ cao xuống thấp: mức cao HÀM Ý mọi mức dưới. Đó là toàn bộ cơ chế chống phễu phình.
 */
function reachedLevel(f: { outcome: unknown; leftWarehouse: unknown; hasShipment: unknown; confirmedStage: unknown }): SQL<number> {
  return sql<number>`case
    when ${f.outcome} = 'DELIVERED' then 5
    when ${f.leftWarehouse} then 4
    when ${f.hasShipment} then 3
    when ${f.confirmedStage} then 2
    else 1 end`;
}

export async function getConversionFunnel(period: Period): Promise<ConversionFunnel> {
  return memo(`conversionFunnel:${periodKey(period)}`, 120_000, async () => {
    const db = await getDb();
    const facts = funnelFacts(db, periodWhere(period)).as("cf_facts");
    const level = reachedLevel(facts);

    const [row] = await db
      .select({
        total: sql<number>`count(*)`,
        lvl2: sql<number>`count(*) filter (where ${level} >= 2)`,
        lvl3: sql<number>`count(*) filter (where ${level} >= 3)`,
        lvl4: sql<number>`count(*) filter (where ${level} >= 4)`,
        lvl5: sql<number>`count(*) filter (where ${level} >= 5)`,
        cancelled: sql<number>`count(*) filter (where ${facts.outcome} = 'CANCELLED')`,
        cancelledAfterConfirm: sql<number>`count(*) filter (where ${facts.outcome} = 'CANCELLED' and ${facts.confirmedStage})`,
        unfinished: sql<number>`count(*) filter (where ${facts.outcome} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN'))`,
        deliveredWithoutShipment: sql<number>`count(*) filter (where ${facts.outcome} = 'DELIVERED' and not ${facts.hasShipment})`,
        shipmentWithoutConfirm: sql<number>`count(*) filter (where ${facts.hasShipment} and not ${facts.confirmedStage})`,
        noStatusHistory: sql<number>`count(*) filter (where ${facts.confirmedStage} and ${facts.confirmedAt} is null)`,

        // ── Thời gian giữa các bước: trung vị + p90 + số cặp đo được ──
        confirmMed: sql<number>`percentile_cont(0.5) within group (order by ${hoursBetween(facts.insertedAt, facts.confirmedAt)})`,
        confirmP90: sql<number>`percentile_cont(0.9) within group (order by ${hoursBetween(facts.insertedAt, facts.confirmedAt)})`,
        confirmN: sql<number>`count(${hoursBetween(facts.insertedAt, facts.confirmedAt)})`,
        labelMed: sql<number>`percentile_cont(0.5) within group (order by ${hoursBetween(facts.confirmedAt, facts.shipmentSeenAt)})`,
        labelP90: sql<number>`percentile_cont(0.9) within group (order by ${hoursBetween(facts.confirmedAt, facts.shipmentSeenAt)})`,
        labelN: sql<number>`count(${hoursBetween(facts.confirmedAt, facts.shipmentSeenAt)})`,
        pickMed: sql<number>`percentile_cont(0.5) within group (order by ${hoursBetween(facts.shipmentSeenAt, facts.pickedUpAt)})`,
        pickP90: sql<number>`percentile_cont(0.9) within group (order by ${hoursBetween(facts.shipmentSeenAt, facts.pickedUpAt)})`,
        pickN: sql<number>`count(${hoursBetween(facts.shipmentSeenAt, facts.pickedUpAt)})`,
        deliverMed: sql<number>`percentile_cont(0.5) within group (order by ${hoursBetween(facts.pickedUpAt, facts.deliveredAt)})`,
        deliverP90: sql<number>`percentile_cont(0.9) within group (order by ${hoursBetween(facts.pickedUpAt, facts.deliveredAt)})`,
        deliverN: sql<number>`count(${hoursBetween(facts.pickedUpAt, facts.deliveredAt)})`,
      })
      .from(facts);

    const counts: Record<OrderStepKey, number> = {
      CREATED: Number(row?.total ?? 0),
      CONFIRMED: Number(row?.lvl2 ?? 0),
      SHIPMENT_CREATED: Number(row?.lvl3 ?? 0),
      LEFT_WAREHOUSE: Number(row?.lvl4 ?? 0),
      DELIVERED: Number(row?.lvl5 ?? 0),
    };

    const num = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
    const timings: Record<OrderStepKey, StepTiming> = {
      CREATED: { medianHours: null, p90Hours: null, coverage: null, note: "Bước đầu — không có bước trước để đo." },
      CONFIRMED: {
        medianHours: num(row?.confirmMed),
        p90Hours: num(row?.confirmP90),
        coverage: counts.CONFIRMED > 0 ? Math.min(1, Number(row?.confirmN ?? 0) / counts.CONFIRMED) : null,
        // Mốc xác nhận là giờ của người thao tác trên Pancake; đơn không có lịch sử thì KHÔNG đo được.
        note: "Mốc lấy từ lịch sử trạng thái Pancake. Đơn không có dòng lịch sử nào thì không đo được, không tính là 0 giờ.",
      },
      SHIPMENT_CREATED: {
        medianHours: num(row?.labelMed),
        p90Hours: num(row?.labelP90),
        coverage: counts.SHIPMENT_CREATED > 0 ? Math.min(1, Number(row?.labelN ?? 0) / counts.SHIPMENT_CREATED) : null,
        note: "Tới mốc ERP GHI NHẬN vận đơn, không phải lúc tạo mã trên Viettel Post.",
      },
      LEFT_WAREHOUSE: {
        medianHours: num(row?.pickMed),
        p90Hours: num(row?.pickP90),
        coverage: counts.LEFT_WAREHOUSE > 0 ? Math.min(1, Number(row?.pickN ?? 0) / counts.LEFT_WAREHOUSE) : null,
        note: "Mốc bưu tá lấy hàng, từ sự kiện Viettel Post.",
      },
      DELIVERED: {
        medianHours: num(row?.deliverMed),
        p90Hours: num(row?.deliverP90),
        coverage: counts.DELIVERED > 0 ? Math.min(1, Number(row?.deliverN ?? 0) / counts.DELIVERED) : null,
        note: "Từ lúc lấy hàng tới lúc ĐVVC báo giao. Đơn kết luận giao thành công theo tiền mà không có mốc thì không đo được.",
      },
    };

    const start = counts.CREATED;
    const steps: ConversionStep[] = ORDER_STEPS.map((spec, i) => {
      const count = counts[spec.key];
      const prev = i === 0 ? count : counts[ORDER_STEPS[i - 1].key];
      return {
        key: spec.key,
        label: spec.label,
        count,
        ofStart: start > 0 ? count / start : 0,
        ofPrevious: prev > 0 ? count / prev : 0,
        previousLabel: spec.previousLabel,
        dropOff: Math.max(0, prev - count),
        dropOffRate: i === 0 ? null : prev > 0 ? Math.max(0, prev - count) / prev : null,
        tier: spec.tier,
        caveat: spec.caveat,
        timing: timings[spec.key],
      };
    });

    return {
      steps,
      cancelled: Number(row?.cancelled ?? 0),
      cancelledAfterConfirm: Number(row?.cancelledAfterConfirm ?? 0),
      unfinished: Number(row?.unfinished ?? 0),
      evidenceGaps: {
        deliveredWithoutShipment: Number(row?.deliveredWithoutShipment ?? 0),
        shipmentWithoutConfirm: Number(row?.shipmentWithoutConfirm ?? 0),
        noStatusHistory: Number(row?.noStatusHistory ?? 0),
      },
    };
  });
}

/* ───────────────────────── CHUYỂN ĐỔI THEO CHIỀU ───────────────────────── */

// Kiểu và nhãn của chiều nằm ở `lib/constants/conversion.ts` — client cần chúng, nên không khai ở đây.
export type { ConversionDimension };
export { CONVERSION_DIMENSION_LABEL };

export type ConversionRow = {
  key: string;
  label: string;
  /** Dòng gộp phần không gán được. KHÔNG chia đều cho ai. */
  unassigned: boolean;
  created: number;
  confirmed: number;
  shipmentCreated: number;
  leftWarehouse: number;
  delivered: number;
  returned: number;
  unfinished: number;
  /** Xác nhận / tạo (0–1); `null` khi chưa có đơn. */
  confirmRate: number | null;
  /** Giao TC / đã rời kho (0–1); `null` khi chưa gửi đơn nào. */
  deliveryRate: number | null;
  /** Tỷ lệ giao thành công trên đơn ĐÃ KẾT THÚC (%); `null` khi chưa đơn nào kết thúc. */
  successRate: number | null;
  deliveredRevenue: number;
  /** Trung vị giờ từ lên đơn tới xác nhận; `null` khi không đo được. */
  medianHoursToConfirm: number | null;
  /** Bước RƠI NHIỀU NHẤT của dòng này — thứ trả lời "rò ở đâu" mà không phải đọc 5 cột. */
  worstStep: OrderStepKey | null;
  worstStepDropOff: number;
};

export type ConversionByDimension = {
  dimension: ConversionDimension;
  rows: ConversionRow[];
  /** Phần đơn gán được (0–1). Dưới ngưỡng thì mọi so sánh chỉ nói về phần có gán. */
  coverage: number;
  lowCoverage: boolean;
  /** Tổng đơn của kỳ — cộng các dòng phải đúng bằng con số này. */
  total: number;
};

/** Cột phân nhóm theo chiều. MỘT chỗ duy nhất ánh xạ chiều → biểu thức. */
function dimensionColumn(dim: ConversionDimension, field: AttributionField): SQL {
  switch (dim) {
    case "employee":
      // Dùng lại đúng ánh xạ vai → cột của `staff-performance.ts`; không khai lại vai ở đây.
      switch (field) {
        case "sellerName":
          return sql`${o.sellerName}`;
        case "careName":
          return sql`${o.careName}`;
        case "marketerName":
          return sql`${o.marketerName}`;
        case "creatorName":
          return sql`${o.creatorName}`;
        case "editorName":
          return sql`coalesce((select h.editor_name from order_status_history h where h.order_id = ${o.id} and h.editor_name <> '' order by h.updated_at limit 1), '')`;
      }
      break;
    case "source":
      // Kênh của một đơn được quyết định ở đúng một chỗ trong ERP.
      return sql`${ORDER_SOURCE}`;
    case "product":
      /*
        MẪU MÃ BÁN CHẠY NHẤT CỦA ĐƠN, không phải mọi mẫu mã.

        Một đơn nhiều mẫu mã mà tách thành nhiều dòng thì tổng đơn sẽ lớn hơn số đơn thật, và bài
        kiểm "cộng các chiều phải bằng tổng" sẽ đỏ — đúng ra phải đỏ, vì lúc đó ta đang đếm đơn nhiều
        lần. Nên mỗi đơn quy về MỘT mẫu mã: dòng hàng có tiền lớn nhất, bỏ hàng tặng.
      */
      return sql`coalesce((select coalesce(nullif(i.product_name, ''), i.sku, 'Không rõ') from order_items i
        where i.order_id = ${o.id} and i.is_bonus = false
        order by i.line_total desc nulls last, i.id limit 1), '')`;
    case "day":
      return sql`to_char(${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
    case "hour":
      return sql`lpad(extract(hour from ${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::text, 2, '0')`;
  }
  return sql`''`;
}

/**
 * Chuyển đổi tách theo một chiều.
 *
 * Ba luật của `docs/sales-funnel-contract.md` được giữ nguyên ở đây:
 *  · đơn không gán được vào MỘT dòng "Chưa gán" hiện tường minh, không chia đều;
 *  · mẫu số của tỷ lệ giao là đơn ĐÃ RỜI KHO, không phải tổng đơn;
 *  · mẫu số rỗng ⇒ `null` ⇒ màn hình hiện "—", không hiện 0%.
 */
export async function getConversionByDimension(
  period: Period,
  dimension: ConversionDimension,
  field: AttributionField = "sellerName",
): Promise<ConversionByDimension> {
  return memo(`conversionByDim:${dimension}:${dimension === "employee" ? field : "-"}:${periodKey(period)}`, 120_000, async () => {
    const db = await getDb();
    const facts = funnelFacts(db, periodWhere(period), dimensionColumn(dimension, field)).as("cd_facts");
    const level = reachedLevel(facts);
    const dim = sql`coalesce(${facts.dimKey}, '')`;

    const rows = await db
      .select({
        key: sql<string>`${dim}`,
        created: sql<number>`count(*)`,
        confirmed: sql<number>`count(*) filter (where ${level} >= 2)`,
        shipmentCreated: sql<number>`count(*) filter (where ${level} >= 3)`,
        leftWarehouse: sql<number>`count(*) filter (where ${level} >= 4)`,
        delivered: sql<number>`count(*) filter (where ${level} >= 5)`,
        returned: sql<number>`count(*) filter (where ${facts.outcome} in ('RETURNED','RETURNED_BY_RULE'))`,
        unfinished: sql<number>`count(*) filter (where ${facts.outcome} in ('IN_TRANSIT','NOT_SHIPPED','UNKNOWN'))`,
        deliveredRevenue: sql<number>`coalesce(sum(${facts.revenue}) filter (where ${facts.outcome} = 'DELIVERED'), 0)`,
        confirmMed: sql<number>`percentile_cont(0.5) within group (order by ${hoursBetween(facts.insertedAt, facts.confirmedAt)})`,
      })
      .from(facts)
      .groupBy(dim);

    const total = rows.reduce((t, r) => t + Number(r.created ?? 0), 0);
    const assigned = rows.filter((r) => r.key !== "").reduce((t, r) => t + Number(r.created ?? 0), 0);

    const out: ConversionRow[] = rows.map((r) => {
      const created = Number(r.created ?? 0);
      const confirmed = Number(r.confirmed ?? 0);
      const shipmentCreated = Number(r.shipmentCreated ?? 0);
      const leftWarehouse = Number(r.leftWarehouse ?? 0);
      const delivered = Number(r.delivered ?? 0);
      const returned = Number(r.returned ?? 0);

      /*
        BƯỚC RƠI NHIỀU NHẤT — tính bằng SỐ ĐƠN rơi, không bằng tỷ lệ.

        Cố ý: một bước rơi 90% của 2 đơn không phải vấn đề của shop; một bước rơi 20% của 400 đơn thì
        đúng là chỗ mất tiền. Xếp việc theo tỷ lệ sẽ đẩy những dòng mẫu bé lên đầu.
      */
      const drops: { key: OrderStepKey; n: number }[] = [
        { key: "CONFIRMED", n: created - confirmed },
        { key: "SHIPMENT_CREATED", n: confirmed - shipmentCreated },
        { key: "LEFT_WAREHOUSE", n: shipmentCreated - leftWarehouse },
        { key: "DELIVERED", n: leftWarehouse - delivered },
      ];
      const worst = drops.filter((d) => d.n > 0).sort((a, b) => b.n - a.n)[0] ?? null;

      const unassigned = r.key === "";
      const label = unassigned ? UNASSIGNED_LABEL : dimension === "source" ? (ORDER_SOURCE_LABEL[r.key as OrderSourceKey] ?? r.key) : r.key;
      return {
        key: r.key || "__unassigned__",
        label,
        unassigned,
        created,
        confirmed,
        shipmentCreated,
        leftWarehouse,
        delivered,
        returned,
        unfinished: Number(r.unfinished ?? 0),
        confirmRate: created > 0 ? confirmed / created : null,
        // Mẫu số là đơn ĐÃ RỜI KHO: không kênh/người nào chịu trách nhiệm cho đơn chưa từng gửi đi.
        deliveryRate: leftWarehouse > 0 ? delivered / leftWarehouse : null,
        successRate: successRate(delivered, returned),
        deliveredRevenue: Number(r.deliveredRevenue ?? 0),
        medianHoursToConfirm: r.confirmMed === null || r.confirmMed === undefined ? null : Math.round(Number(r.confirmMed) * 10) / 10,
        worstStep: worst?.key ?? null,
        worstStepDropOff: worst?.n ?? 0,
      };
    });

    // Xếp theo DOANH THU GIAO THÀNH CÔNG, không theo số đơn; dòng "Chưa gán" luôn xuống cuối.
    out.sort((a, b) => Number(a.unassigned) - Number(b.unassigned) || b.deliveredRevenue - a.deliveredRevenue || b.created - a.created);
    const coverage = total > 0 ? assigned / total : 0;
    return {
      dimension,
      rows: out,
      coverage,
      lowCoverage: dimensionHasUnassigned(dimension) && total > 0 && coverage * 100 < LOW_COVERAGE_PCT,
      total,
    };
  });
}
