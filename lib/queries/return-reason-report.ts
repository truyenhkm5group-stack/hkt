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
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { OM_MARKETER_ID, orderMarketerJoin } from "@/lib/queries/order-marketer";
import { MARKETER_UNRESOLVED } from "@/lib/constants/marketer-attribution";
import { rowsOf } from "@/lib/sql-rows";
import { orderHasProductCode, variantIdsOfCodes } from "@/lib/queries/product-code";
import { reasonGroupTable } from "@/lib/constants/return-reason-mapping";
import { getReasonGroupOverrides } from "@/lib/queries/return-reason-config";
import { reasonsForShipments, type ReasonVerdict } from "@/lib/queries/return-reason";
import {
  RETURN_REASON_GROUP_LABEL,
  RETURN_REASON_GROUPS,
  RETURN_REASON_LABEL,
  REASON_NEEDS_HUMAN,
  type ReasonConfidence,
  type ReturnReason,
  type ReturnReasonGroup,
} from "@/lib/constants/return-reason";
import { rescueRate, type RescueRate } from "@/lib/constants/return-rescue";
import { timeBasisColumnSql, type TimeBasis } from "@/lib/constants/report-time-basis";
import type { Period } from "@/lib/search-params";

const o = schema.orders;

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
  /**
   * TỶ LỆ TRÊN ĐÃ GỬI (incidence) — số ca của lý do ÷ ĐÃ GỬI. Trả lời câu khác hẳn `share`:
   * "cứ 100 kiện gửi đi thì bao nhiêu kiện hỏng vì lý do này". `null` khi chưa gửi kiện nào.
   */
  incidence: number | null;
  /** Doanh thu mất của riêng lý do này. */
  lostRevenue: number;
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
  incidence: number | null;
  lostRevenue: number;
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

/**
 * ═══ MỘT DÒNG MARKETER — CÙNG TẬP CA VỚI BẢNG LÝ DO, KHÔNG TÍNH LẠI ═══
 *
 * Dòng này dựng từ CHÍNH các ca mà bảng lý do đã đếm, nên cộng mọi dòng (kể cả "Chưa xác định")
 * luôn bằng con số tổng ở đầu khối. Đó là bất biến chủ shop nêu: bật chiều marketer KHÔNG được làm
 * đổi tổng.
 */
export type MarketerReturnRow = {
  /** `null` = nhóm "Chưa xác định" — một nhóm THẬT, luôn hiện, không bao giờ bị lọc mất. */
  marketerId: string | null;
  finished: number;
  delivered: number;
  returned: number;
  returnRate: number | null;
  successRate: number | null;
  lostRevenue: number;
  topReason: { reason: ReturnReason; label: string; count: number } | null;
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
  /**
   * ĐỘ PHỦ QUY KẾT MARKETER trên ĐÚNG tập ca của báo cáo này.
   *
   * Đo trên tập đang hiện chứ không đo trên toàn bộ đơn: một con số độ phủ của tập khác không nói
   * gì về bảng người đọc đang nhìn. `pct` là `null` khi tập rỗng — không phải 0%.
   */
  marketerCoverage: { total: number; resolved: number; pct: number | null };
  /** Vỡ theo marketer. Cộng mọi dòng = `finished`; nhóm "Chưa xác định" luôn có mặt khi có ca. */
  marketers: MarketerReturnRow[];
  /** Doanh thu mất vì hoàn, trên chính tập ca này — để khối hành động nói được bằng tiền. */
  lostRevenue: number;
  /**
   * ĐÃ GỬI của chính tập đang lọc — mẫu số của TỶ LỆ TRÊN ĐÃ GỬI (`incidence`).
   *
   * Khác `finished` đúng phần đơn còn đang chạy. Hai mẫu số cho hai câu hỏi khác nhau, và chúng
   * KHÔNG được trộn: "vải xấu chiếm 40% ca hoàn" và "vải xấu xảy ra với 9% lô hàng đã gửi" là hai
   * phát biểu khác nhau, dùng nhầm là phóng đại gấp bốn lần.
   */
  eligibleSent: number;
  /** Đơn của tập này còn đang chạy — nằm trong `eligibleSent`, ngoài `finished`. */
  active: number;
};

export type ReasonFilter = {
  period: Period;
  basis?: TimeBasis;
  codes?: string[];
  /** Mẫu mã cụ thể (`VARIANT_KEY` của bảng hiệu quả theo mã) — hẹp hơn mã hàng một bậc. */
  variantKeys?: string[];
  /**
   * Marketer — khoá `users`/`payroll` hoặc `MARKETER_UNRESOLVED`. Lọc theo nhóm "Chưa xác định" là
   * một lựa chọn HỢP LỆ: đó thường là nhóm cần đi lấp dữ liệu nhất.
   */
  marketerIds?: string[];
  groups?: ReturnReasonGroup[];
  reasons?: ReturnReason[];
};

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
  /*
    LỌC THEO MẪU MÃ dùng CHÍNH khoá `VARIANT_KEY` của bảng hiệu quả theo mã — chép lệch một dấu nối
    thì bấm vào một dòng ở bảng trên sẽ mở ra một tập đơn khác ở bảng dưới, và không ai phát hiện.
  */
  if (f.variantKeys?.length) {
    const ds = f.variantKeys.map((k) => sql`${k}`);
    conds.push(sql`exists (
      select 1 from order_items oi where oi.order_id = ${o.id} and oi.is_bonus = false
        and coalesce(oi.variant_id, 'sku:' || oi.sku || '|' || oi.product_name || '|' || oi.variation_detail) in (${sql.join(ds, sql`, `)})
    )`);
  }

  /*
    ═══ VÌ SAO CÂU NÀY VIẾT BẰNG SQL THÔ ═══

    Quy kết marketer cần BA phép nối trái vào ba bảng tra (`lib/queries/order-marketer.ts`), và bộ
    dựng truy vấn của Drizzle không nhận một mảnh `join` thô mang bí danh riêng. Viết vòng vo để ép
    nó vào bộ dựng sẽ sinh ra một bản quy kết THỨ HAI — đúng thứ tệp hằng số kia tồn tại để chặn.
  */
  const locMarketer = f.marketerIds?.length ? [...new Set(f.marketerIds)] : null;
  const coChuaXacDinh = locMarketer?.includes(MARKETER_UNRESOLVED) ?? false;
  const idThat = (locMarketer ?? []).filter((x) => x !== MARKETER_UNRESOLVED);
  const veMarketer: SQL[] = [];
  if (locMarketer) {
    if (idThat.length) veMarketer.push(sql`b.marketer_id in (${sql.join(idThat.map((x) => sql`${x}`), sql`, `)})`);
    if (coChuaXacDinh) veMarketer.push(sql`b.marketer_id is null`);
  }
  const locSauCung = veMarketer.length ? sql` and (${sql.join(veMarketer, sql` or `)})` : locMarketer ? sql` and false` : sql``;

  const rows = rowsOf<{ order_id: string; shipment_id: string | null; outcome: string; basis_at: unknown; marketer_id: string | null; revenue: string | number }>(
    await db.execute(sql`
      select b.order_id, b.shipment_id, b.outcome, b.basis_at, b.marketer_id, b.revenue
        from (
          select "orders"."id" as order_id,
                 "shipments"."id" as shipment_id,
                 ${ORDER_OUTCOME_FAST} as outcome,
                 ${sql.raw(timeBasisColumnSql(basis))} as basis_at,
                 coalesce("orders"."total_price_after_discount", 0) as revenue,
                 ${OM_MARKETER_ID} as marketer_id
            from "orders"
            left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
            ${orderMarketerJoin(sql`"orders"."ad_id"`, sql`coalesce("orders"."post_id", '')`)}
           where ${and(...conds)}
          offset 0
        ) b
       /*
          CỐ Ý LẤY CẢ 'IN_TRANSIT': mẫu số của TỶ LỆ TRÊN ĐÃ GỬI là cả lô hàng đã bàn giao, không
          phải riêng phần đã ngã ngũ. Lấy hẹp rồi cộng thêm một truy vấn thứ hai để có mẫu số là
          mở đường cho hai con số "đã gửi" cùng tồn tại trên một màn hình.
       */
       where b.outcome in ('DELIVERED','RETURNED','RETURNED_BY_RULE','IN_TRANSIT')${locSauCung}
    `),
  );

  return {
    basis,
    rows: rows.map((r) => ({
      orderId: r.order_id,
      shipmentId: r.shipment_id,
      outcome: r.outcome,
      basisAt: r.basis_at as Date | null,
      marketerId: r.marketer_id,
      revenue: Number(r.revenue ?? 0),
    })),
  };
}

export async function getReturnReasonReport(f: ReasonFilter): Promise<ReturnReasonReport> {
  const [{ basis, rows: tatCa }, ghiDeNhom] = await Promise.all([baseRows(f), getReasonGroupOverrides()]);
  /*
    BẢNG TRA NHÓM dựng MỘT lần cho cả lượt báo cáo, đã áp phần ghi đè của chủ shop. Mọi chỗ xếp
    nhóm trong hàm này đọc `nhomCua`, KHÔNG đọc thẳng `RETURN_REASON_GROUP_OF` — hai đường tra
    khác nhau là hai con số khác nhau giữa bảng nhóm và bảng chi tiết.
  */
  const nhomCua = reasonGroupTable(ghiDeNhom);

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

  /*
    `rows` gồm CẢ đơn đang chạy (để có mẫu số "đã gửi"). Mọi phép đếm về LÝ DO chỉ chạy trên phần
    ĐÃ NGÃ NGŨ — đơn đang chạy chưa có kết quả nên không có lý do hoàn để đếm.
  */
  const eligibleSent = rows.length;
  const ketThucRows = rows.filter((r) => r.outcome !== "IN_TRANSIT");
  const active = eligibleSent - ketThucRows.length;
  const finished = ketThucRows.length;
  const delivered = ketThucRows.filter((r) => r.outcome === "DELIVERED").length;
  const hoanRows = ketThucRows.filter((r) => r.outcome !== "DELIVERED");
  const returned = hoanRows.length;

  // Hỏi lý do cho CẢ đơn hoàn LẪN đơn giao thành công: cột "đã cứu" cần biết đơn nào từng mang
  // lý do hoàn rồi vẫn tới tay khách.
  const moiShipmentId = ketThucRows.map((r) => r.shipmentId).filter((x): x is string => Boolean(x));
  const verdicts = await reasonsForShipments(moiShipmentId);

  type Acc = { count: number; rescued: number; eligible: number; withIntervention: number; lostRevenue: number; confidence: Record<ReasonConfidence, number> };
  const moi = (): Acc => ({ count: 0, rescued: 0, eligible: 0, withIntervention: 0, lostRevenue: 0, confidence: { CONFIRMED: 0, CARRIER_CODE: 0, CARRIER_TEXT: 0, NONE: 0 } });
  const theoLyDo = new Map<ReturnReason, Acc>();
  const lyDoTheoDon = new Map<string, ReturnReason>();

  for (const r of ketThucRows) {
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
      cur.lostRevenue += r.revenue;
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
    const g = nhomCua[reason];
    const list = details.get(g) ?? [];
    list.push({
      reason,
      label: RETURN_REASON_LABEL[reason],
      count: a.count,
      rescued: a.rescued,
      rescue: rescueRate({ eligible: a.eligible, withIntervention: a.withIntervention, rescued: a.rescued }),
      share: mauTyTrong ? (a.count / mauTyTrong) * 100 : 0,
      incidence: eligibleSent ? Math.round((a.count / eligibleSent) * 1000) / 10 : null,
      lostRevenue: a.lostRevenue,
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
  for (const reason of Object.keys(nhomCua) as ReturnReason[]) {
    if (reason === "UNKNOWN") continue;
    if (f.reasons?.length && !f.reasons.includes(reason)) continue;
    const g = nhomCua[reason];
    const list = details.get(g) ?? [];
    if (!list.some((d) => d.reason === reason)) {
      list.push({
        reason,
        label: RETURN_REASON_LABEL[reason],
        count: 0,
        rescued: 0,
        rescue: { value: null, state: "NO_CASES" },
        share: 0,
        incidence: eligibleSent ? 0 : null,
        lostRevenue: 0,
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
        incidence: eligibleSent ? Math.round((count / eligibleSent) * 1000) / 10 : null,
        lostRevenue: list.reduce((n, d) => n + d.lostRevenue, 0),
        details: list,
      };
    });

  const products = await productRows(f, hoanRows, lyDoTheoDon, ketThucRows);
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
    marketerCoverage: {
      total: ketThucRows.length,
      resolved: ketThucRows.filter((r) => r.marketerId).length,
      pct: ketThucRows.length ? Math.round((ketThucRows.filter((r) => r.marketerId).length / ketThucRows.length) * 1000) / 10 : null,
    },
    marketers: marketerRows(ketThucRows, verdicts),
    lostRevenue: hoanRows.reduce((n, r) => n + r.revenue, 0),
    eligibleSent,
    active,
  };
}

/**
 * Vỡ theo MARKETER trên đúng tập ca đã lọc. Không truy vấn thêm: mỗi ca đã mang sẵn `marketerId`
 * từ `baseRows`, nên mọi dòng ở đây là phép đếm lại trên cùng một mảng — không có đường nào để
 * tổng theo marketer lệch khỏi tổng chung.
 */
function marketerRows(
  rows: { orderId: string; shipmentId: string | null; outcome: string; marketerId: string | null; revenue: number }[],
  verdicts: Map<string, { reason: ReturnReason }>,
): MarketerReturnRow[] {
  const theoNguoi = new Map<string | null, { finished: number; delivered: number; returned: number; lostRevenue: number; reasons: Map<ReturnReason, number> }>();
  for (const r of rows) {
    const cur = theoNguoi.get(r.marketerId) ?? { finished: 0, delivered: 0, returned: 0, lostRevenue: 0, reasons: new Map() };
    cur.finished += 1;
    if (r.outcome === "DELIVERED") cur.delivered += 1;
    else {
      cur.returned += 1;
      cur.lostRevenue += r.revenue;
      const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
      const ly = v?.reason ?? "UNKNOWN";
      if (ly !== "UNKNOWN") cur.reasons.set(ly, (cur.reasons.get(ly) ?? 0) + 1);
    }
    theoNguoi.set(r.marketerId, cur);
  }
  return [...theoNguoi]
    .map(([marketerId, v]) => {
      const top = [...v.reasons].sort((a, b) => b[1] - a[1])[0];
      return {
        marketerId,
        finished: v.finished,
        delivered: v.delivered,
        returned: v.returned,
        returnRate: v.finished ? Math.round((v.returned / v.finished) * 1000) / 10 : null,
        successRate: v.finished ? Math.round((v.delivered / v.finished) * 1000) / 10 : null,
        lostRevenue: v.lostRevenue,
        topReason: top ? { reason: top[0], label: RETURN_REASON_LABEL[top[0]], count: top[1] } : null,
      };
    })
    // "Chưa xác định" xuống cuối: nó là một nhóm thật nhưng không phải một người để so sánh.
    .sort((a, b) => (a.marketerId === null ? 1 : b.marketerId === null ? -1 : b.finished - a.finished));
}

/* ═══════════════════ DRILLDOWN: TỪ MỘT LÝ DO XUỐNG TỪNG VẬN ĐƠN ═══════════════════ */

export type ReasonDrilldownRow = {
  orderId: string;
  systemId: number | null;
  shipmentId: string | null;
  tracking: string | null;
  customer: string;
  phone: string;
  province: string;
  productCodes: string;
  skus: string;
  marketerId: string | null;
  outcome: string;
  carrierStatus: string;
  reason: ReturnReason;
  reasonLabel: string;
  confidence: ReasonConfidence;
  evidence: string;
  /** CHỮ GỐC của ĐVVC, nguyên văn. Rỗng = không có chứng từ nào — khác "có nhưng không khớp danh mục". */
  rawReason: string;
  careOwner: string;
  careActions: number;
  basisAt: Date | null;
};

/**
 * ═══ DRILLDOWN BA TẦNG — MỘT BỘ LỌC, KHÔNG TÍNH LẠI Ở TẦNG NÀO ═══
 *
 * Dùng LẠI `baseRows` với NGUYÊN bộ lọc của bảng phía trên (kỳ · mốc · mã hàng · mẫu mã · marketer)
 * rồi mới lọc theo lý do. Viết một truy vấn riêng cho mỗi tầng là mở đường cho chuyện kinh điển:
 * bảng nói 93 ca, bấm vào ra 87 dòng, và không ai biết con số nào đúng.
 *
 * `tests/return-intelligence.test.ts` khoá đúng bất biến đó: tổng số dòng drilldown của mọi lý do
 * phải bằng số ca hoàn ĐÃ BIẾT lý do mà bảng tổng hợp in ra.
 */

/**
 * Bộ lọc của HAI tầng dưới trong drilldown ba tầng: NHÓM LÝ DO → MÃ HÀNG → VẬN ĐƠN.
 *
 * `productCode` là tầng GIỮA và cố ý KHÔNG dùng `f.codes`: `codes` lọc theo ĐƠN (cả đơn vào hay
 * cả đơn ra, vì nó là bộ lọc của cả báo cáo), còn ở đây người đọc vừa bấm vào MỘT ô mã trong bảng
 * vỡ theo mã — họ muốn đúng những đơn có mã đó, kể cả đơn còn mang mã khác.
 */
export type ReasonDrilldownFilter = ReasonFilter & { reason?: ReturnReason; group?: ReturnReasonGroup; productCode?: string; limit?: number };

/**
 * Chọn tập ca hoàn khớp bộ lọc lý do. Dùng chung cho danh sách vận đơn VÀ bảng vỡ theo mã hàng —
 * hai tầng của cùng một drilldown phải đứng trên CÙNG một tập, nếu không tổng của tầng giữa sẽ
 * không bằng số dòng của tầng dưới.
 */
async function chonCaHoan(f: ReasonDrilldownFilter) {
  const { rows: tatCa } = await baseRows(f);
  const rows = tatCa.filter((r) => {
    if (r.basisAt === null) return false;
    const t = new Date(r.basisAt as unknown as string).getTime();
    if (f.period.from && t < f.period.from.getTime()) return false;
    if (f.period.to && t > f.period.to.getTime()) return false;
    // Đơn đang chạy chưa có kết quả ⇒ chưa có lý do hoàn để liệt kê.
    return r.outcome !== "DELIVERED" && r.outcome !== "IN_TRANSIT";
  });
  const RONG = { chon: [] as typeof rows, verdicts: new Map<string, ReasonVerdict>(), maCuaDon: new Map<string, string[]>() };
  if (!rows.length) return RONG;

  const shipmentIds = rows.map((r) => r.shipmentId).filter((x): x is string => Boolean(x));
  const [verdicts, ghiDeNhom] = await Promise.all([reasonsForShipments(shipmentIds), getReasonGroupOverrides()]);
  // CÙNG bảng tra nhóm với bảng tổng hợp: bấm vào một nhóm phải ra đúng số dòng nhóm đó in ra.
  const nhomCua = reasonGroupTable(ghiDeNhom);
  const chon = rows.filter((r) => {
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    const reason: ReturnReason = v?.reason ?? "UNKNOWN";
    if (f.reason) return reason === f.reason;
    if (f.group) return reason !== "UNKNOWN" && nhomCua[reason] === f.group;
    // MỘT MÃ HÀNG trong một nhóm — tầng giữa của drilldown. Lọc mã ở đây chứ không ở `baseRows`
    // vì một đơn có thể mang nhiều mã, và `f.codes` lọc theo ĐƠN (cả đơn vào hay cả đơn ra).
    return true;
  });
  if (!chon.length) return { ...RONG, verdicts };

  /*
    MÃ HÀNG CỦA TỪNG ĐƠN, lấy cho TOÀN BỘ tập đã chọn chứ không chỉ phần hiện ra.

    Lấy sau khi cắt trang thì bảng vỡ theo mã chỉ đếm được 300 đơn đầu, và tổng của nó sẽ nhỏ hơn
    con số nhóm ngay phía trên — đúng kiểu lệch mà không ai giải thích được.
  */
  const maCuaDon = await maHangCuaDon(chon.map((r) => r.orderId));
  const loc = f.productCode ? chon.filter((r) => (maCuaDon.get(r.orderId) ?? []).includes(f.productCode as string)) : chon;
  return { chon: loc, verdicts, maCuaDon };
}

/** Mã hàng của một tập đơn. Đơn nhiều mã trả về nhiều mã — không chọn hộ một mã "chính". */
async function maHangCuaDon(orderIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!orderIds.length) return out;
  const db = await getDb();
  const rows = rowsOf<{ order_id: string; code: string }>(
    await db.execute(sql`
      select distinct oi.order_id as order_id, p.custom_id as code
        from order_items oi
        join product_variants pv on pv.id = oi.variant_id
        join products p on p.id = pv.product_id
       where oi.order_id in (${sql.join([...orderIds].map((x) => sql`${x}`), sql`, `)})
         and oi.is_bonus = false and coalesce(p.custom_id, '') <> ''`),
  );
  for (const r of rows) out.set(r.order_id, [...(out.get(r.order_id) ?? []), r.code]);
  return out;
}

/**
 * TẦNG GIỮA: một nhóm lý do vỡ ra theo MÃ HÀNG.
 *
 * Đơn mang nhiều mã được đếm cho MỌI mã của nó (cùng luật với bảng mã hàng phía trên) và đánh dấu
 * ở cột riêng — chia nhỏ theo tỷ lệ là bịa ra một phép phân bổ mà không có căn cứ nào. Nên tổng
 * cột này có thể LỚN HƠN số ca của nhóm, và số đó được in ra chứ không giấu.
 */
export type ReasonProductRow = { code: string; count: number; share: number };

export async function reasonProductBreakdown(f: ReasonDrilldownFilter): Promise<{ rows: ReasonProductRow[]; cases: number; unmapped: number }> {
  const { chon, maCuaDon } = await chonCaHoan({ ...f, productCode: undefined });
  const dem = new Map<string, number>();
  let chuaGhepMa = 0;
  for (const r of chon) {
    const codes = maCuaDon.get(r.orderId) ?? [];
    if (!codes.length) {
      chuaGhepMa += 1;
      continue;
    }
    for (const c of codes) dem.set(c, (dem.get(c) ?? 0) + 1);
  }
  const cases = chon.length;
  const rows = [...dem]
    .map(([code, count]) => ({ code, count, share: cases ? Math.round((count / cases) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, "vi"));
  return { rows, cases, unmapped: chuaGhepMa };
}

export async function listReasonShipments(f: ReasonDrilldownFilter): Promise<ReasonDrilldownRow[]> {
  const { chon, verdicts } = await chonCaHoan(f);
  if (!chon.length) return [];

  const gioiHan = Math.max(1, Math.min(500, f.limit ?? 300));
  const lay = chon.slice(0, gioiHan);
  const db = await getDb();
  const ids = lay.map((r) => r.orderId);
  const chiTiet = rowsOf<{
    order_id: string;
    system_id: number | null;
    tracking: string | null;
    customer: string;
    phone: string;
    province: string;
    codes: string | null;
    skus: string | null;
    carrier_status: string | null;
    care_owner: string | null;
    care_actions: number | string;
  }>(
    await db.execute(sql`
      -- TÊN BẢNG ĐẦY ĐỦ, KHÔNG BÍ DANH: PRIMARY_ATTEMPT phát ra "orders"."id" / "shipments"."id",
      -- nên đặt bí danh o / s ở đây làm câu lệnh hỏng với "missing FROM-clause entry".
      select "orders"."id" as order_id, "orders"."system_id", "orders"."bill_full_name" as customer,
             "orders"."bill_phone" as phone, "orders"."ship_province" as province,
             "shipments"."tracking_code" as tracking, "shipments"."vtp_status_name" as carrier_status,
             (select string_agg(distinct p.custom_id, ', ') from order_items oi
                join product_variants pv on pv.id = oi.variant_id
                join products p on p.id = pv.product_id and coalesce(p.custom_id,'') <> ''
               where oi.order_id = "orders"."id" and oi.is_bonus = false) as codes,
             (select string_agg(distinct nullif(oi.sku,''), ', ') from order_items oi where oi.order_id = "orders"."id" and oi.is_bonus = false) as skus,
             (select c.owner_email from shipment_care c where c.shipment_id = "shipments"."id" order by c.created_at desc limit 1) as care_owner,
             (select count(*) from care_actions ca where ca.shipment_id = "shipments"."id") as care_actions
        from "orders"
        left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
       where "orders"."id" in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})
    `),
  );
  const theoDon = new Map(chiTiet.map((r) => [r.order_id, r]));

  return lay.map((r) => {
    const d = theoDon.get(r.orderId);
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    const reason: ReturnReason = v?.reason ?? "UNKNOWN";
    return {
      orderId: r.orderId,
      systemId: d?.system_id ?? null,
      shipmentId: r.shipmentId,
      tracking: d?.tracking ?? null,
      customer: d?.customer ?? "",
      phone: d?.phone ?? "",
      province: d?.province ?? "",
      productCodes: d?.codes ?? "",
      skus: d?.skus ?? "",
      marketerId: r.marketerId,
      outcome: r.outcome,
      carrierStatus: d?.carrier_status ?? "",
      reason,
      reasonLabel: RETURN_REASON_LABEL[reason],
      confidence: v?.confidence ?? "NONE",
      evidence: v?.evidence ?? "",
      rawReason: v?.rawReason ?? "",
      careOwner: d?.care_owner ?? "",
      careActions: Number(d?.care_actions ?? 0),
      basisAt: r.basisAt,
    };
  });
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
