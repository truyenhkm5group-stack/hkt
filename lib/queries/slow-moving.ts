import { and, eq, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { coverDaysOf, paceOfPlanRow, qtyForCoverDays, roundCoverDays } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { OUTCOME_FENCE, PRIMARY_ATTEMPT, outcomeColumn } from "@/lib/queries/return-rate";
import { RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { SLOW_MOVING_KEY, classifyStockRisk, resolveSlowMovingRules, type ResolvedSlowMovingRules, type SlowMovingRules, type StockRisk } from "@/lib/constants/slow-moving";

/**
 * ───────────── HÀNG BÁN CHẬM & VỐN NẰM CHẾT ─────────────
 *
 * Đối trọng của trang Kế hoạch sản xuất. Kế hoạch chỉ nhìn cái SẮP HẾT; nếu không có bảng này thì
 * shop chỉ thấy chỗ cần đổ thêm tiền vào, không bao giờ thấy chỗ tiền đang nằm chết.
 *
 * Đặc tả tồn kho: docs/inventory-forecast-contract.md. KHÔNG có công thức tồn hay tốc độ riêng ở
 * đây: mỗi dòng đọc thẳng DÒNG KẾ HOẠCH SX (`getReplenishmentPlan`) — tồn khả dụng, tốc độ gửi đi,
 * nhịp hao kho sau độ trễ hoàn, số ngày còn đủ hàng. Trước 27/09/2026 bảng này tự tính một tốc độ
 * RÒNG (bỏ đơn hoàn, bỏ hàng tặng) nên cùng một mẫu mã có hai "số ngày còn đủ hàng" trên cùng một
 * trang; chủ shop giao Tech Lead chốt và định nghĩa của Kế hoạch SX thắng (xem hợp đồng §1–2).
 *
 * TẬP DÒNG không đổi: mẫu mã BIẾT tồn và còn hàng (khả dụng > 0). Mẫu như vậy luôn nằm trong bản kế
 * hoạch (`isPlanRowActive`: khả dụng > 0 ⇒ tồn ≠ 0), nên đọc `plan.rows` là đọc đủ.
 *
 * GIÁ TRỊ VỐN tính theo GIÁ NHẬP, không theo giá bán: đây là số tiền đã bỏ ra và chưa thu lại,
 * không phải doanh thu có thể thu.
 */

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;

export type SlowMovingRow = {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  available: number;
  /** Tốc độ GỬI ĐI của Kế hoạch SX (món/ngày, đã bỏ ngày đột biến) — CÙNG số với cột "Gửi đi/ngày" ở bảng trên. */
  velocity: number;
  /**
   * Số ngày còn đủ hàng của Kế hoạch SX (`coverDaysOf`, một chữ số thập phân) — CÙNG số với bảng Kế
   * hoạch và Quyết định vốn tồn. `null` khi không gửi đi cái nào, hoặc hàng hoàn về bằng hàng đi —
   * không phải vô cực, không phải 0.
   */
  daysOfCover: number | null;
  /** Lần cuối bán được (giao thành công); `null` = chưa bán được lần nào. */
  lastSoldAt: Date | null;
  daysSinceLastSale: number | null;
  /** Món gửi đi (đơn không huỷ) / món đã hoàn của đơn lên trong cửa sổ hàng chết — căn cứ lớp `RETURNED_OUT`. */
  shippedInDeadWindow: number;
  returnedInDeadWindow: number;
  unitCost: number;
  /** Tiền vốn đang nằm trong lô hàng này. */
  stockValue: number;
  /** Phần vốn VƯỢT mức cần thiết — tiền đáng lẽ không phải nằm đây. */
  excessValue: number;
  risk: StockRisk;
  reason: string;
};

export type SlowMovingReport = {
  rows: SlowMovingRow[];
  /** Tổng vốn đang nằm trong hàng tồn (theo giá nhập). */
  totalStockValue: number;
  /** Tổng phần vốn vượt mức cần thiết. */
  totalExcessValue: number;
  byRisk: Record<StockRisk, { count: number; value: number }>;
  /** Bộ ngưỡng ĐÃ DÙNG để xếp loại — màn hình in đúng bộ này, không đọc lại hằng số. */
  rules: SlowMovingRules;
};

/**
 * Sự kiện của CỬA SỔ HÀNG CHẾT theo mẫu mã — thứ duy nhất bảng này đọc thêm ngoài dòng kế hoạch:
 *   · lần cuối THẬT SỰ giao được hàng (toàn lịch sử, ORDER_OUTCOME = DELIVERED — căn cứ luật hàng chết);
 *   · số món gửi đi (đơn KHÔNG HUỶ, cùng căn cứ "gộp" với tốc độ gửi đi) và số món đã HOÀN, của đơn lên
 *     trong `deadDays` ngày — để nhận ra mẫu "gửi đi mà không giao được" (`RETURNED_OUT`).
 * KHÔNG phải một định nghĩa tốc độ: không chia cho số ngày, không vào số ngày phủ.
 *
 * Kết quả đơn tính MỘT lần cho mỗi dòng trong bảng dẫn xuất (`OUTCOME_FENCE` chặn Postgres nội tuyến lại
 * ba lần). Dùng ĐÚNG bí danh bảng mà `ORDER_OUTCOME` mong đợi (`orders`/`shipments`): đặt bí danh khác sẽ
 * khiến nó lặng lẽ trỏ sang bảng ở câu ngoài và trả về kết quả sai mà không báo lỗi.
 */
function deadWindowFactsSubquery(db: Awaited<ReturnType<typeof getDb>>, deadDays: number) {
  const base = db
    .select({
      variantId: oi.variantId,
      insertedAt: sql<Date>`${o.insertedAt}`.as("sm_inserted_at"),
      qty: sql<number>`${oi.quantity}`.as("sm_qty"),
      outcome: outcomeColumn(),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .offset(OUTCOME_FENCE)
    .as("sm_base");
  const trongCuaSo = sql`${base.insertedAt} >= now() - (${deadDays} || ' days')::interval`;
  return db
    .select({
      variantId: base.variantId,
      // Lần cuối THẬT SỰ giao được hàng — đơn hoàn nghĩa là chưa bán được.
      lastSoldAt: sql<Date | null>`max(${base.insertedAt}) filter (where ${base.outcome} = 'DELIVERED')`.as("sm_last_sold"),
      shipped: sql<number>`coalesce(sum(${base.qty}) filter (where ${trongCuaSo} and ${base.outcome} <> 'CANCELLED'), 0)`.as("sm_shipped_dead"),
      returned: sql<number>`coalesce(sum(${base.qty}) filter (where ${trongCuaSo} and ${base.outcome} in (${sql.raw(RETURNED_OUTCOMES_SQL)})), 0)`.as("sm_returned_dead"),
    })
    .from(base)
    .groupBy(base.variantId)
    .as("sm_dead");
}

/**
 * Ngưỡng hàng chậm ĐANG CÓ HIỆU LỰC: mặc định trong mã + ghi đè thưa ở `settings`
 * (`inventory.slowMoving`). Đọc thô rồi đưa qua `resolveSlowMovingRules` — KHÔNG dùng
 * `getSettingJson` vì hàm ấy trộn sẵn với mặc định, và bộ ghi đè sai phải bị bỏ NGUYÊN BỘ.
 */
export async function loadSlowMovingRules(): Promise<ResolvedSlowMovingRules> {
  const db = await getDb();
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, SLOW_MOVING_KEY) }).catch(() => null);
  if (!row) return resolveSlowMovingRules(null);
  let raw: unknown;
  try {
    raw = JSON.parse(row.value);
  } catch {
    return { ...resolveSlowMovingRules(null), ignored: "Ghi đè không đọc được (không phải JSON)" };
  }
  return resolveSlowMovingRules(raw);
}

async function slowMovingUncached(rules: SlowMovingRules): Promise<SlowMovingReport> {
  const db = await getDb();
  /*
    JIT TẮT cho câu lần bán cuối — cùng họ truy vấn sổ bán theo mẫu mã đã đo (8.578ms bật ↔ 26ms tắt).
    Dòng kế hoạch đọc qua bộ đệm của chính trang Kế hoạch SX: một lượt tính cho cả hai bảng.
  */
  const [plan, lastRows] = await Promise.all([
    getReplenishmentPlan(),
    chayKhongJit(db, (tx) => {
      const f = deadWindowFactsSubquery(tx, rules.deadDays);
      return tx.select({ variantId: f.variantId, lastSoldAt: f.lastSoldAt, shipped: f.shipped, returned: f.returned }).from(f);
    }),
  ]);
  const facts = new Map(lastRows.map((r) => [r.variantId, r]));

  const out: SlowMovingRow[] = [];
  const byRisk: Record<StockRisk, { count: number; value: number }> = {
    DEAD: { count: 0, value: 0 },
    RETURNED_OUT: { count: 0, value: 0 },
    EXCESS: { count: 0, value: 0 },
    SLOW: { count: 0, value: 0 },
    HEALTHY: { count: 0, value: 0 },
  };
  let totalStockValue = 0;
  let totalExcessValue = 0;

  for (const r of plan.rows) {
    // Chưa có phiếu nhập ⇒ tồn là CHƯA BIẾT ⇒ không kết luận gì về vốn nằm chết.
    if (!r.stockKnown) continue;
    const available = r.available;
    if (available <= 0) continue;

    // MỘT nhịp hao kho, MỘT số ngày phủ — của Kế hoạch SX, làm tròn một chỗ.
    const pace = paceOfPlanRow(r);
    const daysOfCover = roundCoverDays(coverDaysOf(available, pace));
    const unitCost = r.unitCost;
    const stockValue = available * unitCost;
    const f = facts.get(r.variantId);
    const lastSoldAt = f?.lastSoldAt ? new Date(f.lastSoldAt) : null;
    const shippedInDeadWindow = Number(f?.shipped ?? 0);
    const returnedInDeadWindow = Number(f?.returned ?? 0);
    const daysSinceLastSale = lastSoldAt ? Math.floor((Date.now() - lastSoldAt.getTime()) / 86_400_000) : null;

    const { risk, reason } = classifyStockRisk({ velocity: pace.velocity, daysOfCover, daysSinceLastSale, shippedInDeadWindow, returnedInDeadWindow }, rules);

    /**
     * PHẦN VỐN VƯỢT MỨC = tiền nằm trong số hàng nhiều hơn mức đủ bán trong kỳ lành mạnh — đo bằng
     * ĐÚNG nhịp hao kho đã xếp loại (nghịch đảo của `coverDaysOf`).
     * Hàng chết thì TOÀN BỘ là vượt mức — không có nhịp bán nào để giữ lại phần nào cả. Hoàn gần hết
     * cũng vậy: tốc độ gửi đi dương nhưng không món nào ở lại tay khách, nên không có "mức đủ bán" nào.
     */
    const healthyQty = risk === "RETURNED_OUT" ? 0 : Math.ceil(qtyForCoverDays(rules.healthyCoverDays, pace) - 1e-9);
    const excessQty = Math.max(0, available - healthyQty);
    const excessValue = risk === "HEALTHY" ? 0 : excessQty * unitCost;

    totalStockValue += stockValue;
    totalExcessValue += excessValue;
    byRisk[risk].count += 1;
    byRisk[risk].value += stockValue;

    out.push({
      variantId: r.variantId,
      productId: r.productId,
      productName: r.productName ?? "",
      sku: r.sku ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      available,
      velocity: Math.round(pace.velocity * 100) / 100,
      daysOfCover,
      lastSoldAt,
      daysSinceLastSale,
      shippedInDeadWindow,
      returnedInDeadWindow,
      unitCost,
      stockValue,
      excessValue,
      risk,
      reason,
    });
  }

  // Vốn nằm chết nhiều nhất lên trước — đó là thứ đáng xả trước.
  out.sort((x, y) => y.excessValue - x.excessValue || y.stockValue - x.stockValue);
  return { rows: out, totalStockValue, totalExcessValue, byRisk, rules };
}

export async function getSlowMoving(): Promise<SlowMovingReport> {
  const { rules } = await loadSlowMovingRules();
  // Ngưỡng ảnh hưởng kết quả ⇒ nằm trong khoá đệm (AGENTS.md §2).
  return memo(`slowMoving:${JSON.stringify(rules)}`, 120_000, () => slowMovingUncached(rules));
}
