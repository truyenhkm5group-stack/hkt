import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import type { VerifiedOutcome } from "@/lib/constants/data-quality";
import { RETURN_RULE, RETURN_RATE_SORTABLE, type OrderOutcome } from "@/lib/constants/returns";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;
const i = schema.orderItems;

/** Cước ĐVVC của đơn: ưu tiên số trên vận đơn, không có thì lấy phí đối tác Pancake ghi trên đơn */
const FEE = sql`coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}, 0)`;
/** Doanh thu COD của đơn: ưu tiên số THỰC THU trên vận đơn, chưa có thì COD vận đơn, rồi COD trên đơn Pancake */
const COD = sql`coalesce(nullif(${s.codCollected}, 0), nullif(${s.codAmount}, 0), ${o.cod}, 0)`;

const MAX_COD = RETURN_RULE.maxCodForFakeDelivery;
const RETURN_COD = RETURN_RULE.maxCodForReturn;
/** Khách đã trả trước (chuyển khoản / ví) — đơn COD 0 nhưng giao thật */
const PREPAID = sql`(coalesce(${o.prepaid}, 0) + coalesce(${o.transferMoney}, 0))`;




/**
 * Kết quả cuối cùng của một đơn — dùng chung cho MỌI báo cáo (tổng quan, lợi nhuận, tỷ lệ giao thành công, lương, COD).
 * ĐƠN GIAO THÀNH CÔNG = đơn có doanh thu COD THỰC > 100K (tiền thực thu / đã về), không phụ thuộc vào việc có trạng thái Viettel Post hay không.
 * Ưu tiên trạng thái VẬN ĐƠN Viettel Post (đầu cuối giao hàng) trước trạng thái đơn Pancake:
 *  1. vận đơn đang hoàn / đã hoàn → không thành công (hoàn);
 *  2. COD thực thu > 100K (webhook / bảng kê / danh sách vận đơn) → giao thành công, kể cả khi trạng thái vận đơn chưa cập nhật;
 *  2b. vận đơn "giao thành công" nhưng doanh thu COD < 50K → ĐƠN HOÀN (khách trả hàng, VTP vẫn báo giao thành công chiều hoàn);
 *  3. vận đơn đã giao → giao thành công, trừ quy tắc phát hiện không thành công (COD ≤ 100K, COD = 0 & cước nhỏ, vận đơn chiều về);
 *  4. vận đơn đang đi (lấy hàng, đang giao, giao thất bại chờ phát lại) → đang giao;
 *  5. chưa có trạng thái vận đơn mới xét theo Pancake: huỷ / hoàn / đã giao / đã gửi / chưa gửi.
 * Yêu cầu FROM orders LEFT JOIN shipments.
 */
/**
 * PHẠM VI ĐƠN VÀO BÁO CÁO: đơn đã xác nhận trên Pancake, cộng đơn huỷ/xoá để các trang còn
 * đếm được số đơn huỷ. Chỉ loại đơn "Mới" chưa chốt — đơn chưa xác nhận thì chưa phải nghiệp vụ bán hàng.
 *
 * Vì sao cần: Tổng quan / Lợi nhuận / Lương / Quảng cáo lọc theo CONFIRMED_STAGES, còn trang
 * Tỷ lệ giao thành công trước đây không lọc gì cả, nên cùng một kỳ hai trang ra hai tổng đơn khác nhau.
 * ORDER_OUTCOME xếp đơn huỷ vào 'CANCELLED' nên việc giữ chúng KHÔNG ảnh hưởng giao thành công / hoàn.
 */
export const REPORTABLE_ORDER = sql`${o.stage} <> 'NEW'`;

/**
 * ĐÃ CÓ BẰNG CHỨNG TIỀN cho vận đơn này hay chưa: có số thực thu, hoặc vận đơn đã xuất hiện
 * trên chi tiết bảng kê tải từ Viettel Post (kể cả bảng kê ghi thu 0 — đó vẫn là bằng chứng
 * KHÔNG thu được đồng nào).
 */
const HAS_CASH_EVIDENCE = sql`(coalesce(${s.codCollected}, 0) > 0
  or ${s.codStatementRef} is not null
  or ${s.codStatus} = 'NOT_APPLICABLE')`;

/**
 * SỐ TIỀN DÙNG ĐỂ KẾT LUẬN.
 *
 * Quy tắc do chủ shop chốt:
 *  · ĐÃ có bằng chứng  → dùng TIỀN THỰC THU. Bảng kê ghi 25K trên đơn khai báo 499K thì
 *    đơn đó là đơn hoàn, bất kể Viettel Post ghi "giao thành công".
 *  · CHƯA có bằng chứng → TẠM dùng COD khai báo. Tiền của kỳ này có thể về ở bảng kê kỳ sau,
 *    nên không được coi "chưa có số" là "thu được 0đ" rồi kết luận đơn hoàn.
 *
 * Cả hai nhánh đều cộng tiền khách chuyển trước.
 */
const OUTCOME_MONEY = sql`(case when ${HAS_CASH_EVIDENCE}
  then coalesce(${s.codCollected}, 0)
  else greatest(coalesce(${s.codAmount}, 0), coalesce(${o.cod}, 0)) end + ${PREPAID})`;

/**
 * Đơn đang được kết luận bằng số TẠM TÍNH (chưa có chứng từ tiền). Dùng để hiển thị riêng,
 * vì con số của nhóm này còn thay đổi khi bảng kê kỳ sau về.
 */
export const IS_PROVISIONAL = sql`(${s.id} is not null and ${s.stage} = 'DELIVERED' and not ${HAS_CASH_EVIDENCE})`;

/**
 * Kết quả cuối cùng của một đơn — dùng chung cho MỌI báo cáo.
 *
 *  1. đang/đã hoàn → HOÀN, dù đã từng thu tiền;
 *  2. tiền > 100K → GIAO THÀNH CÔNG;
 *  3. đã giao mà tiền < 50K → HOÀN (khách chỉ trả phí, hoặc bảng kê xác nhận không thu được);
 *  4. đã giao mà tiền 50K–100K → KHÔNG THÀNH CÔNG;
 *  5. đang đi → ĐANG GIAO;
 *  6. chưa có vận đơn thì mới xét trạng thái Pancake, cũng theo đúng ngưỡng tiền trên.
 *
 * Yêu cầu FROM orders LEFT JOIN shipments.
 */
export const ORDER_OUTCOME = sql<OrderOutcome>`case
  when ${s.stage} in ('RETURNING','RETURNED') then 'RETURNED'
  when ${OUTCOME_MONEY} > ${MAX_COD} and (${s.stage} = 'DELIVERED' or ${s.codStatus} in ('COLLECTED','RECONCILED','PAID_TO_BANK')) then 'DELIVERED'
  when ${s.stage} = 'DELIVERED' and ${OUTCOME_MONEY} < ${RETURN_COD} then 'RETURNED'
  when ${s.stage} = 'DELIVERED' then 'RETURNED_BY_RULE'
  when ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED') and ${o.stage} not in ('CANCELLED','DELETED') then 'IN_TRANSIT'
  when ${o.stage} in ('CANCELLED','DELETED') then 'CANCELLED'
  when ${o.stage} in ('RETURNING','PARTIAL_RETURN','RETURNED') then 'RETURNED'
  when ${o.stage} in ('DELIVERED','PAID') and ${OUTCOME_MONEY} > ${MAX_COD} then 'DELIVERED'
  when ${o.stage} in ('DELIVERED','PAID') and ${OUTCOME_MONEY} < ${RETURN_COD} then 'RETURNED'
  when ${o.stage} in ('DELIVERED','PAID') then 'RETURNED_BY_RULE'
  when ${o.stage} = 'SHIPPED' then 'IN_TRANSIT'
  else 'NOT_SHIPPED' end`;

/**
 * ───────── Quy tắc THỰC TẾ (Data Truth) — dùng cho trang Chất lượng dữ liệu ─────────
 * Khác ORDER_OUTCOME legacy ở đúng một điểm: trạng thái Pancake/Viettel Post KHÔNG được
 * coi là bằng chứng doanh thu. Không có số tiền thực thu → UNVERIFIED ("Chưa xác minh"),
 * tuyệt đối không quy về 0 và không đoán.
 */

/**
 * TIỀN COD ĐÃ THỰC THU. Ưu tiên số thực thu; nếu chưa có số nhưng Viettel Post đã xác nhận
 * trạng thái thu tiền thì lấy COD khai báo trên vận đơn. COD khai báo đơn thuần KHÔNG phải bằng chứng.
 */
export const CASH_COLLECTED = sql<number>`coalesce(nullif(${s.codCollected}, 0),
  case when ${s.codStatus} in ('COLLECTED','RECONCILED','PAID_TO_BANK') then nullif(${s.codAmount}, 0) end, 0)`;

/** Tổng tiền CÓ BẰNG CHỨNG của đơn: COD đã thu + tiền khách chuyển trước đã ghi nhận. */
export const VERIFIED_CASH = sql<number>`(${CASH_COLLECTED} + ${PREPAID})`;

/**
 * TRẦN tiền mà đơn này có thể thu được (COD đã thu / COD khai báo trên vận đơn / COD trên đơn Pancake, cộng trả trước).
 * Dùng để kết luận CHẮC CHẮN theo hướng bất lợi: nếu trần vẫn dưới ngưỡng thì đơn không thể là giao thành công,
 * kể cả khi chưa có số thực thu. Đây là suy luận từ giới hạn trên, không phải phỏng đoán.
 */
const MAX_POSSIBLE_CASH = sql<number>`(greatest(${CASH_COLLECTED}, coalesce(${s.codAmount}, 0), coalesce(${o.cod}, 0)) + ${PREPAID})`;

/**
 * CÓ ĐỌC ĐƯỢC SỐ TIỀN hay không. Có bằng chứng khi: đã thu được tiền, khách đã chuyển trước,
 * hoặc vận đơn giao xong với COD khai báo = 0 (không có gì để thu — bản thân nó là một kết luận).
 */
export const HAS_CASH_PROOF = sql`(${CASH_COLLECTED} > 0 or ${PREPAID} > 0
  or (${s.id} is not null and ${s.stage} = 'DELIVERED' and coalesce(${s.codAmount}, 0) = 0))`;

/** Có tín hiệu "đã giao xong" từ bất kỳ nguồn nào (chưa chứng minh được tiền). */
const DELIVERY_SIGNAL = sql`(${s.stage} = 'DELIVERED' or ${o.stage} in ('DELIVERED','PAID'))`;

/**
 * Kết quả đơn theo quy tắc THỰC TẾ (Data Truth) — dùng cho trang Chất lượng dữ liệu.
 * Khác ORDER_OUTCOME legacy ở đúng một điểm: trạng thái Pancake/Viettel Post KHÔNG phải bằng chứng doanh thu.
 *  1. Huỷ vẫn là huỷ.
 *  2. Đang/đã hoàn vẫn là HOÀN dù đã từng thu tiền.
 *  3. COD đã THỰC THU > 100K → giao thành công: tiền đã trao tay tại cửa, dù trạng thái vận đơn chưa cập nhật.
 *  4. Đang giao vẫn là ĐANG GIAO dù khách đã trả trước.
 *  5. Có tín hiệu giao xong thì xét tiền:
 *     · trần tiền < 50K → HOÀN (chắc chắn, không cần số thực thu);
 *     · trần tiền ≤ 100K → KHÔNG THÀNH CÔNG (chắc chắn);
 *     · trần tiền > 100K nhưng không đọc được đồng nào → CHƯA XÁC MINH (không đoán, không quy về 0);
 *     · có bằng chứng → so tiền thật với hai ngưỡng.
 */
export const ORDER_OUTCOME_VERIFIED = sql<VerifiedOutcome>`case
  when ${o.stage} in ('CANCELLED','DELETED') then 'CANCELLED'
  when ${s.stage} in ('RETURNING','RETURNED') then 'RETURNED'
  when ${CASH_COLLECTED} > ${MAX_COD} then 'DELIVERED'
  when ${s.stage} in ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERY_FAILED') then 'IN_TRANSIT'
  when ${o.stage} in ('RETURNING','PARTIAL_RETURN','RETURNED') then 'RETURNED'
  when ${DELIVERY_SIGNAL} then (case
    when ${MAX_POSSIBLE_CASH} < ${RETURN_COD} then 'RETURNED'
    when ${MAX_POSSIBLE_CASH} <= ${MAX_COD} then 'RETURNED_BY_RULE'
    when not ${HAS_CASH_PROOF} then 'UNVERIFIED'
    when ${VERIFIED_CASH} > ${MAX_COD} then 'DELIVERED'
    when ${VERIFIED_CASH} < ${RETURN_COD} then 'RETURNED'
    else 'RETURNED_BY_RULE' end)
  when ${o.stage} = 'SHIPPED' then 'IN_TRANSIT'
  else 'NOT_SHIPPED' end`;

/** Pancake báo đã giao/đã thanh toán nhưng không có vận đơn giao thành công và cũng không có tiền thực thu. */
export const IS_PANCAKE_DECLARED_ONLY = sql`(${o.stage} in ('DELIVERED','PAID')
  and (${s.stage} is null or ${s.stage} <> 'DELIVERED') and not ${HAS_CASH_PROOF})`;

/** Viettel Post ghi "giao thành công" (kể cả chiều hoàn) nhưng tiền thực thu < 50K. */
export const IS_VTP_LOW_CASH = sql`(${s.stage} = 'DELIVERED' and ${HAS_CASH_PROOF} and ${VERIFIED_CASH} < ${RETURN_COD})`;

/** Pancake và Viettel Post nói hai điều khác nhau về cùng một đơn. */
export const IS_STATUS_CONFLICT = sql`(${s.id} is not null and (
  (${o.stage} in ('DELIVERED','PAID') and ${s.stage} in ('RETURNING','RETURNED'))
  or (${o.stage} in ('RETURNING','PARTIAL_RETURN','RETURNED') and ${s.stage} = 'DELIVERED')
  or (${o.stage} in ('CANCELLED','DELETED') and ${s.stage} in ('DELIVERED','OUT_FOR_DELIVERY','IN_TRANSIT'))))`;

/** Hàng hoàn kho CHƯA xác nhận nhận về — không được cộng lại tồn kho. */
export const IS_RETURN_NOT_RECEIVED = sql`(${s.stage} in ('RETURNING','RETURNED') and ${s.returnReceivedAt} is null)`;

/**
 * Hàng hoàn ở GRAIN ĐƠN (cần orders LEFT JOIN shipments) — dùng cho tồn kho.
 * Rộng hơn IS_RETURN_NOT_RECEIVED vì phủ cả RETURNED_BY_RULE (vận đơn báo "giao thành công"
 * nhưng khách chỉ trả phí, hàng vẫn quay về). Kho chưa xác nhận nhận → hàng CHƯA có trong tồn.
 */
export const RETURN_PENDING_WAREHOUSE = sql`(${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE') and ${s.returnReceivedAt} is null)`;

const IS_RETURNED = sql`${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`;
/** Giao thất bại, đang chờ phát lại (chưa kết thúc nhưng khả năng hoàn cao) */
const IS_FAILED = sql`${ORDER_OUTCOME} = 'IN_TRANSIT' and ${s.stage} = 'DELIVERY_FAILED'`;
const IS_PENDING = sql`${ORDER_OUTCOME} = 'NOT_SHIPPED'`;
const IS_SHIPPED = sql`${ORDER_OUTCOME} in ('IN_TRANSIT','DELIVERED','RETURNED','RETURNED_BY_RULE')`;

/** Khoá gộp theo mẫu mã: id mẫu mã Pancake, hoặc SKU + tên nếu mẫu mã chưa có trong ERP */
const VARIANT_KEY = sql<string>`coalesce(${i.variantId}, 'sku:' || ${i.sku} || '|' || ${i.productName} || '|' || ${i.variationDetail})`;

export type ReturnRateQuery = {
  period: Period;
  q: string;
  minShipped: number;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type ReturnRateRow = {
  key: string;
  variantId: string | null;
  sku: string;
  productName: string;
  variationDetail: string;
  image: string | null;
  shipped: number;
  delivered: number;
  returned: number;
  returnedByRule: number;
  inTransit: number;
  /** Đang chờ phát lại (giao thất bại chưa kết thúc) */
  failed: number;
  /** Tỷ lệ hoàn dự kiến (%) = (hoàn + chờ phát lại × xác suất thành hoàn) ÷ (giao thật + hoàn + chờ phát lại) */
  expectedRate: number | null;
  /** TỶ LỆ GIAO THÀNH CÔNG (%) = giao thành công (COD thực > 100K) ÷ (giao thành công + không thành công) trên đơn đã kết thúc; null nếu chưa có đơn kết thúc */
  successRate: number | null;
  /** Tỷ lệ giao thành công dự kiến (%) khi các đơn chờ phát lại kết thúc = 100 − tỷ lệ hoàn dự kiến */
  expectedSuccessRate: number | null;
  cancelled: number;
  returnedQty: number;
  lostRevenue: number;
  deliveredRevenue: number;
  /** % hoàn trên các đơn đã có kết quả (giao thật + hoàn); null nếu chưa có đơn nào kết thúc */
  rate: number | null;
};

export { RETURN_RATE_SORTABLE } from "@/lib/constants/returns";

function baseWhere(period: Period, q: string): SQL | undefined {
  const conds: SQL[] = [eq(i.isBonus, false), REPORTABLE_ORDER];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${i.sku} ilike ${like} or ${i.productName} ilike ${like} or ${i.variationDetail} ilike ${like})`);
  }
  return and(...conds);
}

/** Tỷ lệ hoàn theo từng mẫu mã (SKU) — gộp theo đơn, một đơn có N mẫu mã được tính cho cả N mẫu mã. */
export async function getReturnRateByVariant(query: ReturnRateQuery): Promise<{ rows: ReturnRateRow[]; total: number; pageCount: number; all: ReturnRateRow[] }> {
  const db = await getDb();
  const raw = await db
    .select({
      key: VARIANT_KEY,
      variantId: sql<string | null>`max(${i.variantId})`,
      sku: sql<string>`max(${i.sku})`,
      productName: sql<string>`max(${i.productName})`,
      variationDetail: sql<string>`max(${i.variationDetail})`,
      image: sql<string | null>`max(${i.image})`,
      shipped: sql<number>`count(distinct ${o.id}) filter (where ${IS_SHIPPED})`,
      delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
      returnedByRule: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      failed: sql<number>`count(distinct ${o.id}) filter (where ${IS_FAILED})`,
      cancelled: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
      returnedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${IS_RETURNED}), 0)`,
      lostRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${IS_RETURNED}), 0)`,
      deliveredRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(baseWhere(query.period, query.q))
    .groupBy(VARIANT_KEY);

  const p = await failedToReturnRate();
  const all: ReturnRateRow[] = raw
    .map((r) => {
      const delivered = Number(r.delivered);
      const returned = Number(r.returned);
      const finished = delivered + returned;
      const failedN = Number(r.failed);
      const expectedRate = finished + failedN ? ((returned + failedN * p.rate) / (finished + failedN)) * 100 : null;
      return {
        key: r.key,
        variantId: r.variantId,
        sku: r.sku ?? "",
        productName: r.productName ?? "",
        variationDetail: r.variationDetail ?? "",
        image: r.image,
        shipped: Number(r.shipped),
        delivered,
        returned,
        returnedByRule: Number(r.returnedByRule),
        inTransit: Number(r.inTransit),
        failed: Number(r.failed),
        expectedRate,
        successRate: finished ? (delivered / finished) * 100 : null,
        expectedSuccessRate: expectedRate === null ? null : 100 - expectedRate,
        cancelled: Number(r.cancelled),
        returnedQty: Number(r.returnedQty),
        lostRevenue: Number(r.lostRevenue),
        deliveredRevenue: Number(r.deliveredRevenue),
        rate: finished ? (returned / finished) * 100 : null,
      };
    })
    .filter((r) => r.shipped >= query.minShipped);

  const sortKey = RETURN_RATE_SORTABLE.includes(query.sort) ? query.sort : "successRate";
  const sign = query.dir === "asc" ? 1 : -1;
  all.sort((a, b) => {
    if (sortKey === "sku") return sign * (a.sku || a.productName).localeCompare(b.sku || b.productName, "vi");
    const av = a[sortKey as keyof ReturnRateRow] as number | null;
    const bv = b[sortKey as keyof ReturnRateRow] as number | null;
    if (av === null && bv === null) return b.shipped - a.shipped;
    if (av === null) return 1; // chưa có kết quả xếp cuối
    if (bv === null) return -1;
    return sign * (av - bv) || b.returned - a.returned || b.shipped - a.shipped;
  });

  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const start = (query.page - 1) * query.pageSize;
  return { rows: all.slice(start, start + query.pageSize), total, pageCount, all };
}

export type ReturnRateSummary = {
  orders: number;
  shipped: number;
  delivered: number;
  returned: number;
  returnedByRule: number;
  inTransit: number;
  /** Chờ phát lại (giao thất bại chưa kết thúc) */
  failed: number;
  /** Chờ xử lý, chưa gửi ĐVVC (không tính vào tỷ lệ) */
  pending: number;
  cancelled: number;
  lostRevenue: number;
  rate: number | null;
  /** Tỷ lệ hoàn dự kiến khi các đơn chờ phát lại kết thúc (theo xác suất lịch sử) */
  expectedRate: number | null;
  /** TỶ LỆ GIAO THÀNH CÔNG chung (%) = giao thành công ÷ (giao thành công + không thành công) */
  successRate: number | null;
  /** Tỷ lệ giao thành công dự kiến (%) khi đơn chờ phát lại kết thúc */
  expectedSuccessRate: number | null;
  /** Xác suất đơn giao thất bại → hoàn, học từ lịch sử (%) và cỡ mẫu */
  failedToReturnPct: number;
  failedSample: number;
  /** Đơn đã kết thúc (giao / hoàn) mà vận đơn chưa có trạng thái Viettel Post thật — đang tính theo trạng thái Pancake */
  finishedNoVtp: number;
  /** Đơn đang kết luận bằng số TẠM TÍNH: chưa có chứng từ tiền, số sẽ đổi khi bảng kê về. */
  provisional: number;
};

/** Xác suất một vận đơn đã từng giao thất bại cuối cùng thành hoàn (180 ngày gần nhất); dưới 15 mẫu dùng 60% */
export async function failedToReturnRate(): Promise<{ rate: number; sample: number }> {
  return memo("failedToReturnRate", 300_000, async () => {
    const db = await getDb();
    const [row] = await db
      .select({
        // Theo DOANH THU chứ không theo trạng thái: Viettel Post ghi "giao thành công" cho cả
        // chiều hoàn, nên đếm bằng stage thô sẽ làm tỷ lệ "giao thất bại → hoàn" thấp giả tạo
        // và khiến báo cáo lợi nhuận / kế hoạch sản xuất lạc quan quá mức.
        returned: sql<number>`count(*) filter (where ${SHIPMENT_RETURNED})`,
        delivered: sql<number>`count(*) filter (where ${SHIPMENT_DELIVERED})`,
      })
      .from(sql`(select distinct e.shipment_id from shipment_events e where e.occurred_at >= now() - interval '180 days' and (e.status in ('505','506','507','510') or e.status_name ilike '%thất bại%' or e.status_name ilike '%hẹn%' or e.status_name ilike '%không liên lạc%')) f`)
      .innerJoin(s, sql`${s.id} = f.shipment_id`)
      .leftJoin(o, eq(o.id, s.orderId));
    const returned = Number(row?.returned ?? 0);
    const delivered = Number(row?.delivered ?? 0);
    const sample = returned + delivered;
    return { rate: sample >= 15 ? returned / sample : 0.6, sample };
  });
}

/** Tổng hợp ở cấp đơn (mỗi đơn tính một lần) với cùng bộ lọc kỳ / tìm kiếm */
export async function getReturnRateSummary(period: Period, q: string): Promise<ReturnRateSummary> {
  const db = await getDb();
  // Phạm vi đơn dùng chung — nếu thiếu, trang Tỷ lệ giao thành công sẽ đếm cả đơn "Mới"
  // và ra tổng đơn khác Tổng quan trong cùng một kỳ.
  const conds: SQL[] = [REPORTABLE_ORDER];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  const term = q.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`exists (select 1 from order_items oi where oi.order_id = ${o.id} and oi.is_bonus = false and (oi.sku ilike ${like} or oi.product_name ilike ${like} or oi.variation_detail ilike ${like}))`);
  }
  const [row] = await db
    .select({
      orders: sql<number>`count(*)`,
      shipped: sql<number>`count(*) filter (where ${IS_SHIPPED})`,
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${IS_RETURNED})`,
      returnedByRule: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'RETURNED_BY_RULE')`,
      inTransit: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      failed: sql<number>`count(*) filter (where ${IS_FAILED})`,
      pending: sql<number>`count(*) filter (where ${IS_PENDING})`,
      cancelled: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'CANCELLED')`,
      lostRevenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${IS_RETURNED}), 0)`,
      // vận đơn đã kết thúc theo Pancake nhưng chưa có trạng thái Viettel Post thật (webhook / tra cứu / nhập danh sách vận đơn)
      finishedNoVtp: sql<number>`count(*) filter (where ${s.id} is not null and ${s.vtpStatusDate} is null and ${ORDER_OUTCOME} in ('DELIVERED','RETURNED','RETURNED_BY_RULE'))`,
      provisional: sql<number>`count(*) filter (where ${IS_PROVISIONAL})`,
    })
    .from(o)
    .leftJoin(s, eq(s.orderId, o.id))
    .where(conds.length ? and(...conds) : undefined);
  const delivered = Number(row?.delivered ?? 0);
  const returned = Number(row?.returned ?? 0);
  const failed = Number(row?.failed ?? 0);
  const p = await failedToReturnRate();
  return {
    orders: Number(row?.orders ?? 0),
    shipped: Number(row?.shipped ?? 0),
    delivered,
    returned,
    returnedByRule: Number(row?.returnedByRule ?? 0),
    inTransit: Number(row?.inTransit ?? 0),
    failed,
    pending: Number(row?.pending ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    lostRevenue: Number(row?.lostRevenue ?? 0),
    rate: delivered + returned ? (returned / (delivered + returned)) * 100 : null,
    expectedRate: delivered + returned + failed ? ((returned + failed * p.rate) / (delivered + returned + failed)) * 100 : null,
    successRate: delivered + returned ? (delivered / (delivered + returned)) * 100 : null,
    expectedSuccessRate: delivered + returned + failed ? 100 - ((returned + failed * p.rate) / (delivered + returned + failed)) * 100 : null,
    failedToReturnPct: Math.round(p.rate * 100),
    failedSample: p.sample,
    finishedNoVtp: Number(row?.finishedNoVtp ?? 0),
    provisional: Number(row?.provisional ?? 0),
  };
}

export type VariantOrderRow = {
  id: string;
  systemId: number | null;
  insertedAt: Date;
  stage: (typeof schema.orders.$inferSelect)["stage"];
  outcome: OrderOutcome;
  billFullName: string;
  billPhone: string;
  shipProvince: string;
  quantity: number;
  lineTotal: number;
  cod: number;
  fee: number;
  vtpOrderNumber: string | null;
  shipmentStage: (typeof schema.shipments.$inferSelect)["stage"] | null;
  returnedReason: string | null;
};

/** Danh sách đơn của một mẫu mã trong kỳ kèm kết quả, để đối chiếu (tối đa 300 đơn, hoàn xếp trước) */
export async function listOrdersForVariant(key: string, period: Period): Promise<VariantOrderRow[]> {
  const db = await getDb();
  const conds: SQL[] = [eq(VARIANT_KEY, key), eq(i.isBonus, false), REPORTABLE_ORDER];
  if (period.from) conds.push(gte(o.insertedAt, period.from));
  if (period.to) conds.push(lte(o.insertedAt, period.to));
  const rows = await db
    .select({
      id: o.id,
      systemId: o.systemId,
      insertedAt: o.insertedAt,
      stage: o.stage,
      outcome: ORDER_OUTCOME,
      billFullName: o.billFullName,
      billPhone: o.billPhone,
      shipProvince: o.shipProvince,
      quantity: sql<number>`sum(${i.quantity})`,
      lineTotal: sql<number>`sum(${i.lineTotal})`,
      cod: sql<number>`${COD}`,
      fee: sql<number>`${FEE}`,
      vtpOrderNumber: s.vtpOrderNumber,
      shipmentStage: s.stage,
      returnedReason: o.returnedReason,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(and(...conds))
    .groupBy(o.id, s.id)
    .orderBy(sql`case when ${IS_RETURNED} then 0 when ${ORDER_OUTCOME} = 'DELIVERED' then 2 else 1 end`, desc(o.insertedAt))
    .limit(300);
  return rows.map((r) => ({ ...r, quantity: Number(r.quantity), lineTotal: Number(r.lineTotal), cod: Number(r.cod), fee: Number(r.fee) }));
}

/* ------------------------------------------------------------------ *
 * Kết quả ở mức VẬN ĐƠN (trang Vận đơn, đối soát COD) — cùng ngưỡng doanh thu với ORDER_OUTCOME.
 * Dùng khi chỉ truy vấn bảng shipments (có thể LEFT JOIN orders để lấy tiền khách chuyển trước).
 * ------------------------------------------------------------------ */

/** Doanh thu COD của một vận đơn: ưu tiên tiền thực thu, chưa có thì tiền thu hộ khai trên vận đơn */
export const SHIPMENT_COD = sql`coalesce(nullif(${s.codCollected}, 0), ${s.codAmount}, 0)`;

/**
 * Kết quả vận đơn = ĐÚNG một định nghĩa với ORDER_OUTCOME, không phải bản rút gọn riêng.
 *
 * Trước đây hai chỗ này tự tính (`stage = 'DELIVERED' and COD > 100K`) nên trang Vận đơn
 * ĐẾM THIẾU so với Tổng quan: vận đơn đã thực thu > 100K theo bảng kê nhưng trạng thái VTP
 * chưa kịp cập nhật thì Tổng quan tính là giao thành công còn trang Vận đơn thì không.
 * Chúng cũng bỏ qua quy tắc cước < 10K và quy tắc vận đơn chiều về.
 *
 * ORDER_OUTCOME chạy được ở grain vận đơn: mọi tham chiếu tới `orders` đều qua coalesce,
 * nên vận đơn chưa ghép đơn (order NULL) vẫn cho kết quả đúng theo dữ liệu của chính nó.
 * Yêu cầu FROM shipments LEFT JOIN orders.
 */
export const SHIPMENT_DELIVERED = sql`(${ORDER_OUTCOME} = 'DELIVERED')`;
export const SHIPMENT_RETURNED = sql`(${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`;

/**
 * Vận đơn CÒN TIỀN COD ĐỂ THU. Vận đơn đã hoàn / huỷ thì khoản COD khai báo không bao giờ về nữa,
 * dù trạng thái COD chưa được cập nhật. Trước đây chỉ trang Đối soát COD lọc điều kiện này còn
 * Báo cáo dòng tiền thì không, nên hai trang báo "COD đã thu chờ về" khác nhau.
 */
export const COD_COLLECTABLE = sql`(${s.stage} not in ('RETURNED', 'CANCELLED'))`;
