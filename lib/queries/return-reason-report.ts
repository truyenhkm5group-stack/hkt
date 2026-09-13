/**
 * ═══════════ BÁO CÁO LÝ DO HOÀN — HAI TẦNG, ĐÚNG MỐC, KHÔNG BỊA ═══════════
 *
 * ─── KHÔNG VIẾT CÔNG THỨC KẾT QUẢ ĐƠN MỚI ───
 *
 * Dùng lại NGUYÊN VẸN hợp đồng đang chạy production: `REPORTABLE_ORDER` · `PRIMARY_ATTEMPT` ·
 * `outcomeColumn()`. Mọi luật loại trừ chủ shop nêu đã nằm sẵn trong đó và báo cáo này thừa
 * hưởng mà không khai lại:
 *
 *   · vận đơn chiều về (`…1P1`) có `order_id = NULL` (267/2.103 trên production, KHÔNG cái nào
 *     có `order_id`) nên `leftJoin` không bao giờ kéo chúng vào như một đơn riêng;
 *   · "Shop huỷ lấy" → `CANCELLED`; "Lấy không thành công" → `UNKNOWN`. Cả hai nằm NGOÀI cả tử
 *     lẫn mẫu, vì mẫu số chỉ gồm ba kết quả kết thúc;
 *   · "Giao thành công một phần" không tự thành công — nó đi qua luật doanh thu như mọi đơn khác;
 *   · COD/tiền KHÔNG phải chứng cứ logistics; nó chỉ tham gia qua chính `ORDER_OUTCOME`.
 *
 * ─── MỐC THỜI GIAN: NGÀY KẾT QUẢ CUỐI, KHÔNG PHẢI NGÀY ĐẶT ĐƠN ───
 *
 * Bản trước lọc theo `orders.inserted_at` để "cùng cột với báo cáo GTC". Sai với báo cáo NÀY:
 * câu hỏi ở đây là "tháng này xử lý xong bao nhiêu ca hoàn, vì sao", và một ca đóng hôm nay có
 * thể là đơn của tháng trước — đo trên production, ngày tạo đơn và ngày gửi lệch trung bình 4,5
 * ngày, cao nhất 26 ngày; tới mốc kết quả cuối thì còn xa hơn.
 *
 * Ca chưa có mốc kết quả cuối thì KHÔNG rơi về `created_at` — nó nằm ngoài kỳ, và số ca rơi ra
 * được in ra chứ không giấu.
 *
 * ─── ĐỘ MỊN: ĐƠN, KHÔNG PHẢI DÒNG HÀNG ───
 *
 * Một đơn hai mã hàng mà hoàn thì KHÔNG có gì trong dữ liệu nói mã nào gây hoàn. Đơn đó được đếm
 * cho CẢ HAI mã (đúng: cả hai đều bị ảnh hưởng) và lý do gắn ở MỨC ĐƠN, không giả vờ gán cho
 * từng mã. Số đơn nhiều mã được in ra để người đọc biết tổng theo mã lớn hơn tổng thật bao nhiêu.
 */
import { and, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { outcomeColumn, OUTCOME_FENCE, PRIMARY_ATTEMPT, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { orderHasProductCode, variantIdsOfCodes } from "@/lib/queries/product-code";
import { reasonsForShipments } from "@/lib/queries/return-reason";
import {
  RETURN_REASON_GROUP_LABEL,
  RETURN_REASON_GROUP_OF,
  RETURN_REASON_GROUPS,
  RETURN_REASON_LABEL,
  REASON_NEEDS_HUMAN,
  type ReasonConfidence,
  type ReturnReason,
  type ReturnReasonGroup,
} from "@/lib/constants/return-reason";
import { rescueRate, type RescueRate } from "@/lib/constants/return-rescue";
import { FINAL_OUTCOME_AT_SQL, CARRIER_HANDOFF_AT_SQL, type TimeBasis } from "@/lib/constants/report-time-basis";
import type { Period } from "@/lib/search-params";

const o = schema.orders;
const s = schema.shipments;

/** Một dòng lý do chi tiết. `rescue` mang trạng thái riêng vì "chưa theo dõi được" ≠ 0%. */
export type ReasonDetailRow = {
  reason: ReturnReason;
  label: string;
  /** Số đơn HOÀN mang lý do này. */
  count: number;
  /** Số đơn từng mang lý do này nhưng kết cục GIAO THÀNH CÔNG — tức đã cứu được. */
  rescued: number;
  rescue: RescueRate;
  /** Trên tổng đơn hoàn ĐÃ XÁC ĐỊNH ĐƯỢC LÝ DO. Cộng lại đúng 100%. */
  share: number;
  confidence: Record<ReasonConfidence, number>;
  /** Lý do này máy KHÔNG suy được — 0 ở đây nghĩa là chưa ai ghi, không phải không có ca nào. */
  needsHuman: boolean;
};

export type ReasonGroupRow = {
  group: ReturnReasonGroup;
  label: string;
  count: number;
  rescued: number;
  rescue: RescueRate;
  share: number;
  details: ReasonDetailRow[];
};

export type ProductReturnRow = {
  code: string;
  name: string;
  finished: number;
  delivered: number;
  returned: number;
  returnRate: number | null;
  successRate: number | null;
  topReason: { reason: ReturnReason; label: string; count: number; share: number } | null;
  multiSku: number;
};

export type ReturnReasonReport = {
  period: Period;
  basis: TimeBasis;
  finished: number;
  delivered: number;
  returned: number;
  returnRate: number | null;
  successRate: number | null;
  groups: ReasonGroupRow[];
  products: ProductReturnRow[];
  /**
   * ĐỘ PHỦ LÝ DO — mẫu số của chất lượng báo cáo, không được giấu.
   * `known` = đơn hoàn xác định được lý do; `unknown` = chưa ai hỏi vì sao.
   */
  reasonCoverage: { known: number; unknown: number; pct: number | null };
  /** Ca rơi khỏi kỳ vì KHÔNG có mốc kết quả cuối — in ra thay vì lặng lẽ bỏ. */
  missingBasis: number;
  multiSkuOrders: number;
  /** Tổng ca đủ điều kiện xét cứu và số ca có thao tác người — để màn hình giải thích được cột cứu. */
  rescueCoverage: { eligible: number; withIntervention: number; rescued: number };
};

export type ReasonFilter = {
  period: Period;
  basis?: TimeBasis;
  codes?: string[];
  groups?: ReturnReasonGroup[];
  reasons?: ReturnReason[];
};

/** Cột mốc của từng cách lọc. `ORDERED` là cột đơn, hai cái kia là cột vận đơn. */
function basisColumn(basis: TimeBasis): string {
  if (basis === "ORDERED") return `${"orders"}.inserted_at`;
  return basis === "SHIPPED" ? CARRIER_HANDOFF_AT_SQL : FINAL_OUTCOME_AT_SQL;
}

/**
 * Dòng thô: mỗi ĐƠN một dòng, kèm kết quả chuẩn, vận đơn quyết định và mốc của cách lọc đang dùng.
 *
 * `basisAt` được chọn ra RIÊNG chứ không nhét vào `where`, để đếm được bao nhiêu ca rơi ra vì
 * thiếu mốc — con số đó là một phần của báo cáo, không phải rác cần quét đi.
 */
async function baseRows(f: ReasonFilter) {
  const db = await getDb();
  const basis = f.basis ?? "OUTCOME";
  const conds: SQL[] = [REPORTABLE_ORDER];
  if (f.codes?.length) {
    const { variantIds } = await variantIdsOfCodes(f.codes);
    conds.push(orderHasProductCode(sql`${o.id}`, variantIds));
  }

  const base = db
    // Bí danh TƯỜNG MINH: `orders.id` và `shipments.id` cùng tên "id", nên bảng dẫn xuất sẽ có hai
    // cột trùng tên và Postgres từ chối với "column reference id is ambiguous".
    .select({
      orderId: sql<string>`${o.id}`.as("rr_order_id"),
      shipmentId: sql<string | null>`${s.id}`.as("rr_shipment_id"),
      outcome: outcomeColumn(),
      basisAt: sql<Date | null>`${sql.raw(basisColumn(basis))}`.as("rr_basis_at"),
    })
    .from(o)
    .leftJoin(s, and(sql`${s.orderId} = ${o.id}`, PRIMARY_ATTEMPT))
    .where(and(...conds))
    .offset(OUTCOME_FENCE)
    .as("rr_base");

  const khoang: SQL[] = [sql`${base.outcome} in ('DELIVERED','RETURNED','RETURNED_BY_RULE')`];
  return {
    basis,
    rows: await db.select({ orderId: base.orderId, shipmentId: base.shipmentId, outcome: base.outcome, basisAt: base.basisAt }).from(base).where(and(...khoang)),
  };
}

export async function getReturnReasonReport(f: ReasonFilter): Promise<ReturnReasonReport> {
  const { basis, rows: tatCa } = await baseRows(f);

  /*
    LỌC KỲ TRONG BỘ NHỚ, KHÔNG Ở SQL — cố ý.

    Cần phân biệt ba nhóm: trong kỳ · ngoài kỳ · KHÔNG CÓ MỐC. Nếu đẩy điều kiện ngày vào `where`
    thì nhóm thứ ba biến mất cùng nhóm thứ hai và không ai biết nó tồn tại. Số ca thiếu mốc là
    thông tin về chất lượng dữ liệu, phải in ra.
  */
  const coMoc = tatCa.filter((r) => r.basisAt !== null);
  const missingBasis = tatCa.length - coMoc.length;
  const rows = coMoc.filter((r) => {
    const t = new Date(r.basisAt as unknown as string).getTime();
    if (f.period.from && t < f.period.from.getTime()) return false;
    if (f.period.to && t > f.period.to.getTime()) return false;
    return true;
  });

  const finished = rows.length;
  const delivered = rows.filter((r) => r.outcome === "DELIVERED").length;
  const hoanRows = rows.filter((r) => r.outcome !== "DELIVERED");
  const returned = hoanRows.length;

  // Hỏi lý do cho CẢ đơn hoàn LẪN đơn giao thành công: cột "đã cứu" cần biết đơn nào từng mang
  // lý do hoàn rồi vẫn tới tay khách.
  const moiShipmentId = rows.map((r) => r.shipmentId).filter((x): x is string => Boolean(x));
  const verdicts = await reasonsForShipments(moiShipmentId);

  type Acc = { count: number; rescued: number; eligible: number; withIntervention: number; confidence: Record<ReasonConfidence, number> };
  const moi = (): Acc => ({ count: 0, rescued: 0, eligible: 0, withIntervention: 0, confidence: { CONFIRMED: 0, CARRIER_CODE: 0, CARRIER_TEXT: 0, NONE: 0 } });
  const theoLyDo = new Map<ReturnReason, Acc>();
  const lyDoTheoDon = new Map<string, ReturnReason>();

  for (const r of rows) {
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    const reason: ReturnReason = v?.reason ?? "UNKNOWN";
    const cur = theoLyDo.get(reason) ?? moi();
    if (r.outcome === "DELIVERED") {
      /*
        ĐƠN GIAO THÀNH CÔNG MÀ VẪN MANG LÝ DO HOÀN = ca đã được cứu.

        Chỉ đếm khi lý do đến từ CHỨNG TỪ (không phải `UNKNOWN`): một đơn giao thành công bình
        thường chưa bao giờ gặp nguy cơ hoàn, đếm nó vào tử số là ghi công cho việc không ai làm.
      */
      if (reason !== "UNKNOWN") {
        cur.rescued += 1;
        cur.eligible += 1;
        if (v?.confidence === "CONFIRMED") cur.withIntervention += 1;
      }
    } else {
      cur.count += 1;
      cur.confidence[v?.confidence ?? "NONE"] += 1;
      if (reason !== "UNKNOWN") cur.eligible += 1;
      if (v?.confidence === "CONFIRMED") cur.withIntervention += 1;
      if (r.shipmentId) lyDoTheoDon.set(r.orderId, reason);
    }
    theoLyDo.set(reason, cur);
  }

  const unknown = theoLyDo.get("UNKNOWN")?.count ?? 0;
  const known = returned - unknown;
  /*
    TỶ TRỌNG TÍNH TRÊN ĐƠN ĐÃ XÁC ĐỊNH ĐƯỢC LÝ DO, không trên tổng đơn hoàn.

    Lấy tổng đơn hoàn làm mẫu số thì mọi tỷ trọng bị kéo xuống bởi phần chưa ai hỏi — "vải xấu
    12%" trong khi thực tế trong số ca ĐÃ BIẾT thì vải xấu chiếm 40%. Phần chưa biết được báo
    riêng bằng độ phủ, ngay phía trên bảng.
  */
  const mauTyTrong = known;

  const details = new Map<ReturnReasonGroup, ReasonDetailRow[]>();
  for (const [reason, a] of theoLyDo) {
    if (reason === "UNKNOWN") continue;
    const g = RETURN_REASON_GROUP_OF[reason];
    const list = details.get(g) ?? [];
    list.push({
      reason,
      label: RETURN_REASON_LABEL[reason],
      count: a.count,
      rescued: a.rescued,
      rescue: rescueRate({ eligible: a.eligible, withIntervention: a.withIntervention, rescued: a.rescued }),
      share: mauTyTrong ? (a.count / mauTyTrong) * 100 : 0,
      confidence: a.confidence,
      needsHuman: REASON_NEEDS_HUMAN[reason],
    });
    details.set(g, list);
  }

  /*
    MỌI LÝ DO TRONG SỔ ĐỀU RA MỘT DÒNG, kể cả dòng 0.

    Bảng chỉ có những lý do đã xảy ra sẽ nói với chủ shop rằng shop không có vấn đề về size, trong
    khi sự thật là chưa ai ghi lý do size lần nào. Dòng 0 kèm cờ `needsHuman` phân biệt được hai
    chuyện đó.
  */
  for (const reason of Object.keys(RETURN_REASON_GROUP_OF) as ReturnReason[]) {
    if (reason === "UNKNOWN") continue;
    if (f.reasons?.length && !f.reasons.includes(reason)) continue;
    const g = RETURN_REASON_GROUP_OF[reason];
    const list = details.get(g) ?? [];
    if (!list.some((d) => d.reason === reason)) {
      list.push({
        reason,
        label: RETURN_REASON_LABEL[reason],
        count: 0,
        rescued: 0,
        rescue: { value: null, state: "NO_CASES" },
        share: 0,
        confidence: { CONFIRMED: 0, CARRIER_CODE: 0, CARRIER_TEXT: 0, NONE: 0 },
        needsHuman: REASON_NEEDS_HUMAN[reason],
      });
    }
    details.set(g, list);
  }

  const groups: ReasonGroupRow[] = RETURN_REASON_GROUPS.filter((g) => g !== "UNKNOWN")
    .filter((g) => !f.groups?.length || f.groups.includes(g))
    .map((g) => {
      const list = (details.get(g) ?? []).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "vi"));
      const count = list.reduce((n, d) => n + d.count, 0);
      const rescued = list.reduce((n, d) => n + d.rescued, 0);
      const eligible = list.reduce((n, d) => n + (d.count + d.rescued), 0);
      const withIntervention = list.reduce((n, d) => n + (d.rescue.state === "MEASURED" ? 1 : 0), 0);
      return {
        group: g,
        label: RETURN_REASON_GROUP_LABEL[g],
        count,
        rescued,
        rescue: rescueRate({ eligible, withIntervention, rescued }),
        share: mauTyTrong ? (count / mauTyTrong) * 100 : 0,
        details: list,
      };
    });

  const products = await productRows(f, hoanRows, lyDoTheoDon, rows);
  const eligibleTong = [...theoLyDo].filter(([r]) => r !== "UNKNOWN").reduce((n, [, a]) => n + a.eligible, 0);
  const interventionTong = [...theoLyDo].filter(([r]) => r !== "UNKNOWN").reduce((n, [, a]) => n + a.withIntervention, 0);
  const rescuedTong = [...theoLyDo].filter(([r]) => r !== "UNKNOWN").reduce((n, [, a]) => n + a.rescued, 0);

  return {
    period: f.period,
    basis,
    finished,
    delivered,
    returned,
    returnRate: finished ? (returned / finished) * 100 : null,
    successRate: finished ? (delivered / finished) * 100 : null,
    groups,
    products,
    reasonCoverage: { known, unknown, pct: returned ? (known / returned) * 100 : null },
    missingBasis,
    multiSkuOrders: products.reduce((n, p) => Math.max(n, p.multiSku), 0),
    rescueCoverage: { eligible: eligibleTong, withIntervention: interventionTong, rescued: rescuedTong },
  };
}

/** Vỡ theo MÃ HÀNG. Đơn nhiều mã được đếm cho mọi mã và đánh dấu, không chia nhỏ theo tỷ lệ. */
async function productRows(
  f: ReasonFilter,
  hoanRows: { orderId: string }[],
  lyDoTheoDon: Map<string, ReturnReason>,
  rows: { orderId: string; outcome: unknown }[],
): Promise<ProductReturnRow[]> {
  const db = await getDb();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.orderId);
  /*
    `count(distinct …) over (partition by …)` KHÔNG chạy được trên Postgres ("DISTINCT is not
    implemented for window functions"). Đếm số mã của mỗi đơn bằng một bảng dẫn xuất riêng rồi
    nối vào — cùng kết quả, và đọc ra ý định rõ hơn.
  */
  const map = await db.execute(sql`
    with ma_cua_don as (
      select oi.order_id as order_id, p.custom_id as code, min(p.name) as name
      from order_items oi
      join product_variants v on v.id = oi.variant_id
      join products p on p.id = v.product_id
      where oi.order_id in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) and coalesce(p.custom_id, '') <> ''
      group by oi.order_id, p.custom_id
    ),
    so_ma_moi_don as (select order_id, count(*) as so_ma from ma_cua_don group by order_id)
    select m.order_id, m.code, m.name, n.so_ma
    from ma_cua_don m join so_ma_moi_don n on n.order_id = m.order_id
  `);
  const raw = (map as unknown as { rows?: { order_id: string; code: string; name: string; so_ma: number }[] }).rows ?? (map as unknown as { order_id: string; code: string; name: string; so_ma: number }[]);

  const outcomeOf = new Map(rows.map((r) => [r.orderId, String(r.outcome)]));
  const hoanSet = new Set(hoanRows.map((r) => r.orderId));
  const theoMa = new Map<string, { name: string; finished: number; delivered: number; returned: number; multiSku: number; reasons: Map<ReturnReason, number> }>();
  for (const r of raw) {
    const cur = theoMa.get(r.code) ?? { name: r.name, finished: 0, delivered: 0, returned: 0, multiSku: 0, reasons: new Map() };
    cur.finished += 1;
    if (outcomeOf.get(r.order_id) === "DELIVERED") cur.delivered += 1;
    if (hoanSet.has(r.order_id)) {
      cur.returned += 1;
      const ly = lyDoTheoDon.get(r.order_id);
      if (ly) cur.reasons.set(ly, (cur.reasons.get(ly) ?? 0) + 1);
    }
    if (Number(r.so_ma) > 1) cur.multiSku += 1;
    theoMa.set(r.code, cur);
  }

  return [...theoMa]
    .map(([code, v]) => {
      const top = [...v.reasons].sort((a, b) => b[1] - a[1])[0];
      return {
        code,
        name: v.name,
        finished: v.finished,
        delivered: v.delivered,
        returned: v.returned,
        // Làm tròn MỘT chữ số ngay ở truy vấn, đúng như bản trước: hai nơi làm tròn khác nhau thì
        // bảng và tệp xuất ra hai con số cho cùng một mã.
        returnRate: v.finished ? Math.round((v.returned / v.finished) * 1000) / 10 : null,
        successRate: v.finished ? Math.round((v.delivered / v.finished) * 1000) / 10 : null,
        topReason: top ? { reason: top[0], label: RETURN_REASON_LABEL[top[0]], count: top[1], share: v.returned ? (top[1] / v.returned) * 100 : 0 } : null,
        multiSku: v.multiSku,
      };
    })
    .sort((a, b) => b.returned - a.returned || b.finished - a.finished);
}
