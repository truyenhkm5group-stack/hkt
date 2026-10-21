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
import { chayKhongJit, getDb, schema } from "@/db";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { ELIGIBLE_SENT_SQL } from "@/lib/constants/returns";
import { OM_CONFLICT, OM_EVIDENCE, OM_MARKETER_ID, OM_STATE, orderMarketerJoin, summarizeMarketerCoverage } from "@/lib/queries/order-marketer";
import { MARKETER_EVIDENCE, MARKETER_UNRESOLVED, type MarketerCoverage, type MarketerEvidence, type MarketerLinkState } from "@/lib/constants/marketer-attribution";
import { rowsOf } from "@/lib/sql-rows";
import { ORDER_SOURCE } from "@/lib/queries/order-source";
import { matchesReasonFilters, postOfficeQuery, reasonFacetsOf, type ReasonFacets, type ReasonFilterFacts, type ReasonFilterSelection } from "@/lib/returns/reason-filters";
import { orderHasProductCode, variantIdsOfCodes } from "@/lib/queries/product-code";
import { getReasonGrouping, getReasonTaxonomy } from "@/lib/queries/return-reason-config";
import { reasonsForShipments, type ReasonVerdict } from "@/lib/queries/return-reason";
import { EMPTY_CONFIDENCE_COUNTS, RETURN_REASON_LABEL, REASON_NEEDS_HUMAN, RETURN_REASONS, type ReasonConfidence, type ReturnReason } from "@/lib/constants/return-reason";
import { EVIDENCE_TIERS, resolveEvidence, type EvidenceTier, type ReasonGroupKey, type ReasonGrouping, type ReasonTaxonomy } from "@/lib/constants/return-reason-evidence";
import type { DepartmentCode } from "@/lib/constants/departments";
import { rescueRate, type RescueRate } from "@/lib/constants/return-rescue";
import { timeBasisColumnSql, type TimeBasis } from "@/lib/constants/report-time-basis";
import type { Period } from "@/lib/search-params";
import { NO_ORDER_VALUE_FILTER, orderValueKey, orderValueWhereSql, type OrderValueFilter } from "@/lib/constants/order-value";
import { memo } from "@/lib/cache";

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
  /** Khoá nhóm của CÁCH XẾP ĐANG BẬT (`report.taxonomy`) — nhóm cũ hoặc nhóm theo chứng cứ. */
  group: ReasonGroupKey;
  label: string;
  /** Một câu: nhóm này sửa ở đâu. Đi kèm dòng để màn hình không phải tra bảng của từng cách xếp. */
  action: string;
  /** Phòng đi sửa — `null` khi chưa đủ căn cứ chỉ một phòng (mục 24), và luôn `null` ở cách xếp cũ. */
  department: DepartmentCode | null;
  /**
   * BẬC CHỨNG CỨ của các ca HOÀN trong nhóm. Cộng lại = `count`. Một nhóm 300 ca mà 290 ca chỉ có
   * lời ĐVVC là một nhóm khác hẳn nhóm 300 ca đã có người xác nhận — dù con số đầu dòng như nhau.
   */
  tiers: Record<EvidenceTier, number>;
  count: number;
  rescued: number;
  rescue: RescueRate;
  share: number;
  incidence: number | null;
  lostRevenue: number;
  /** Đơn hoàn của nhóm KHÔNG có giá trị đơn — `lostRevenue` không tính chúng (chưa biết ≠ 0). */
  lostRevenueUnknown: number;
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
  /**
   * Đơn của người này đi bằng loại bằng chứng nào. Cộng hai ô = `finished` (với nhóm "Chưa xác
   * định" thì cả hai ô đều 0).
   *
   * Phải hiện ra: "38 đơn theo chiến dịch" và "38 đơn theo fanpage phụ trách" là hai mức chắc chắn
   * khác nhau, và người quản lý cần phân biệt được trước khi lấy tỷ lệ hoàn ra nói chuyện với ai.
   */
  byEvidence: Record<MarketerEvidence, number>;
};

export type ReturnReasonReport = {
  /** Cách xếp nhóm của lượt dựng này. Màn hình in ra để không ai so số của hai cách xếp với nhau. */
  taxonomy: ReasonTaxonomy;
  /** Câu phải hiện ra (ghi đè nhóm cũ không chuyển được). Rỗng = không có gì phải báo. */
  taxonomyNotes: string[];
  /** Bậc chứng cứ trên MỌI ca hoàn của tập — kể cả ca chưa xác định (`UNKNOWN`). Cộng lại = `returned`. */
  evidenceTiers: Record<EvidenceTier, number>;
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
   * ═══ ĐỘ PHỦ LÝ DO — MẪU SỐ CỦA CHẤT LƯỢNG BÁO CÁO, KHÔNG ĐƯỢC GIẤU ═══
   *
   * BA phần, không hai (`lib/constants/return-reason-source.ts`):
   *   `known`      — xếp được vào danh mục.
   *   `rawOnly`    — CÓ chữ thật nhưng chưa xếp được ⇒ mở chữ ra đọc rồi chọn lý do.
   *   `noEvidence` — chưa ai nói một chữ nào ⇒ phải ĐI HỎI.
   *
   * `unknown = rawOnly + noEvidence`, giữ lại để nơi gọi cũ không đổi nghĩa. Nhưng màn hình phải
   * tách hai phần ấy ra: chúng dẫn tới hai việc khác hẳn nhau, và gộp lại thì việc dễ làm nhất
   * (đọc chữ đã có sẵn) bị chôn trong một con số trông như bế tắc.
   */
  reasonCoverage: { known: number; unknown: number; rawOnly: number; noEvidence: number; pct: number | null };
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
  marketerCoverage: MarketerCoverage;
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
  /**
   * Ca hoàn KHÔNG vào nhóm nào của cách xếp đang bật. Ở cách xếp cũ = ca lý do `UNKNOWN`; ở cách xếp theo chứng cứ còn gồm lời khai có
   * lý do mà chưa đủ căn cứ cho nhóm nào (giao chậm chưa xác minh). Bất biến: tổng `groups[].count` + `ungrouped` = `returned`.
   */
  ungrouped: number;
  /** Đơn hoàn KHÔNG có giá trị đơn — `lostRevenue` không tính chúng. */
  lostRevenueUnknown: number;
  /**
   * 2b — số đơn của từng lựa chọn bộ lọc (nguồn · ĐVVC · care · tỉnh · trạng thái) trên tập TRƯỚC khi lọc 2b, + độ phủ bưu cục. Ô chọn
   * in đúng các số này; KHÔNG có danh sách bưu cục (chữ ĐVVC có thể mang tên / SĐT bưu tá).
   */
  facets: ReasonFacets;
};

export type ReasonFilter = {
  period: Period;
  basis?: TimeBasis;
  /**
   * Khoảng GIÁ TRỊ ĐƠN (xem `lib/constants/order-value.ts`). Có mặt ở đây vì bảng lý do hoàn đứng
   * trên CÙNG một trang với bảng theo mã hàng: một bảng lọc còn bảng kia đọc cả kỳ là đặt hai tập
   * đơn khác nhau dưới cùng một tiêu đề, và người đọc sẽ cộng chúng lại.
   *
   * `ReasonDrilldownFilter` mở rộng kiểu này nên hai tầng drilldown cũng đi theo, không cần khai lại.
   */
  value?: OrderValueFilter;
  codes?: string[];
  /** Mẫu mã cụ thể (`VARIANT_KEY` của bảng hiệu quả theo mã) — hẹp hơn mã hàng một bậc. */
  variantKeys?: string[];
  /**
   * Marketer — khoá `users`/`payroll` hoặc `MARKETER_UNRESOLVED`. Lọc theo nhóm "Chưa xác định" là
   * một lựa chọn HỢP LỆ: đó thường là nhóm cần đi lấp dữ liệu nhất.
   */
  marketerIds?: string[];
  groups?: ReasonGroupKey[];
  reasons?: ReturnReason[];
  /**
   * ÉP một cách xếp nhóm — CHỈ cho lượt chạy thử (`scripts/reason-taxonomy-dryrun.ts`) dựng cả hai
   * cách trên cùng một tập ca. Màn hình KHÔNG truyền: nó đọc cờ `returns.reason-taxonomy`.
   */
  taxonomy?: ReasonTaxonomy;
} & ReasonFilterSelection;

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
  const locGiaTri = orderValueWhereSql(f.value ?? NO_ORDER_VALUE_FILTER);
  if (locGiaTri) conds.push(sql.raw(locGiaTri));
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

  /*
    TẮT JIT — ĐO ĐƯỢC, KHÔNG ĐOÁN (ops perf-probe run 35889901709, 23/09/2026, sau deploy 50787a47).

    Câu này, cùng tham số, xen kẽ JIT bật / JIT tắt, trung vị 3 lượt mỗi bên:
        JIT bật   4.034 ms   [4.943 · 4.034 · 3.934]
        JIT tắt   183 ms     [201 · 157 · 183]        ⇒ 95 % là Postgres BIÊN DỊCH câu lệnh.
    Trên đường ứng dụng thật nó đo được 12.435 ms và 10.847 ms — hai lượt gọi, vì
    `getReturnIntelligence` (/reports/returns) gọi lại `getReturnReasonReport`. Tệp này từng vắng mặt
    khỏi danh sách tệp dùng `chayKhongJit`. Không đổi KẾT QUẢ — JIT chỉ đổi cách thực thi.
    Xem docs/perf/JIT-bat-tat-2026-09-23.md.
  */
  const rows = rowsOf<{
    order_id: string;
    shipment_id: string | null;
    outcome: string;
    basis_at: unknown;
    marketer_id: string | null;
    marketer_evidence: MarketerEvidence | null;
    marketer_state: MarketerLinkState;
    marketer_conflict: boolean;
    revenue: string | number | null;
    src: string;
    carrier: string | null;
    province_raw: string | null;
    post_office: string | null;
    care_owner: string | null;
    care_any: boolean | string | null;
  }>(
    await chayKhongJit(db, (tx) => tx.execute(sql`
      select b.order_id, b.shipment_id, b.outcome, b.basis_at, b.marketer_id, b.marketer_evidence, b.marketer_state, b.marketer_conflict, b.revenue,
             b.src, b.carrier, b.province_raw, b.post_office, b.care_owner, b.care_any
        from (
          select "orders"."id" as order_id,
                 "shipments"."id" as shipment_id,
                 ${ORDER_OUTCOME_FAST} as outcome,
                 ${sql.raw(timeBasisColumnSql(basis))} as basis_at,
                 -- KHÔNG coalesce về 0: đơn thiếu giá trị là CHƯA BIẾT, đếm riêng (AGENTS.md mục 42).
                 "orders"."total_price_after_discount" as revenue,
                 ${OM_MARKETER_ID} as marketer_id,
                 ${OM_EVIDENCE} as marketer_evidence,
                 ${OM_STATE} as marketer_state,
                 ${OM_CONFLICT} as marketer_conflict,
                 -- 2b (lib/returns/reason-filters.ts): dữ kiện lọc — nguồn đơn MỘT định nghĩa (ORDER_SOURCE), ĐVVC + bưu cục của vận đơn
                 -- chính (vị trí lần phát cuối), người cầm đợt care mới nhất (users.id, luật 34). Lọc ở TS: tỉnh phải qua findProvince.
                 ${ORDER_SOURCE} as src,
                 "shipments"."carrier" as carrier,
                 "orders"."ship_province" as province_raw,
                 (select e.location from "shipment_events" e
                   where e.shipment_id = "shipments"."id" and e.normalized_stage::text in ('OUT_FOR_DELIVERY', 'DELIVERY_FAILED', 'DELIVERED')
                   order by e.occurred_at desc, e.id desc limit 1) as post_office,
                 (select sc.owner_id from "shipment_care" sc where sc.shipment_id = "shipments"."id" order by sc.episode_no desc, sc.opened_at desc limit 1) as care_owner,
                 exists (select 1 from "shipment_care" sc where sc.shipment_id = "shipments"."id") as care_any
            from "orders"
            left join "shipments" on "shipments"."order_id" = "orders"."id" and ${PRIMARY_ATTEMPT}
            ${orderMarketerJoin(sql`"orders"."ad_id"`, sql`coalesce("orders"."post_id", '')`, sql`"orders"."id"`)}
           where ${and(...conds)}
          offset 0
        ) b
       /*
          CỐ Ý LẤY CẢ 'IN_TRANSIT': mẫu số của TỶ LỆ TRÊN ĐÃ GỬI là cả lô hàng đã bàn giao, không
          phải riêng phần đã ngã ngũ. Lấy hẹp rồi cộng thêm một truy vấn thứ hai để có mẫu số là
          mở đường cho hai con số "đã gửi" cùng tồn tại trên một màn hình.
       */
       where b.outcome in (${sql.raw(ELIGIBLE_SENT_SQL)})${locSauCung}
    `)),
  );

  const mapped = rows.map((r) => {
    const careAny = r.care_any === true || r.care_any === "t";
    const facts: ReasonFilterFacts = {
      outcome: r.outcome,
      source: r.src,
      carrier: r.carrier,
      provinceRaw: r.province_raw,
      postOffice: r.post_office,
      careOwner: r.care_owner,
      careState: !careAny ? "NONE" : r.care_owner ? "OWNED" : "UNOWNED",
    };
    return { r, facts };
  });
  // Bộ đếm từng lựa chọn đứng trên tập TRƯỚC khi lọc 2b (mọi bộ lọc khác của trang đã áp trong SQL) — ô chọn in số ca có thật.
  const facets = reasonFacetsOf(mapped.map((x) => x.facts));
  const kept = mapped.filter((x) => matchesReasonFilters(x.facts, f)).map((x) => x.r);
  return {
    basis,
    facets,
    rows: kept.map((r) => ({
      orderId: r.order_id,
      shipmentId: r.shipment_id,
      outcome: r.outcome,
      basisAt: r.basis_at as Date | null,
      marketerId: r.marketer_id,
      marketerEvidence: r.marketer_evidence,
      marketerState: r.marketer_state,
      marketerConflict: Boolean(r.marketer_conflict),
      // `?? 0` TẠI CHỖ GỌI, có chủ ý: mọi tổng giá trị cộng phần ĐÃ BIẾT; `revenueKnown` đếm riêng phần chưa biết (mục 42).
      revenue: Number(r.revenue ?? 0),
      revenueKnown: r.revenue !== null && r.revenue !== undefined,
    })),
  };
}

/**
 * ═══ ĐỆM 90 GIÂY (AGENTS mục 2), KHOÁ GỒM MỌI TRƯỜNG MÀ HÀM ĐỌC ═══
 *
 * /reports/returns gọi hàm này mỗi lượt mở (kỳ này) và tầng quyết định gọi thêm cho kỳ trước; trước
 * đây không có đệm nên mỗi lượt xem trả lại ~1–1,4 s (ops perf-probe 29/09/2026). Khoá gồm ĐỦ các
 * trường bộ lọc mà `baseRows` + thân hàm đọc — thiếu một trường là hai bộ lọc khác nhau nhận cùng một
 * kết quả. Các trường riêng của drilldown (`reason`, `group`, `productCode`, `limit`) chỉ `chonCaHoan`
 * đọc, không đi qua hàm này.
 *
 * Người vừa XÁC NHẬN lý do hoặc SỬA NHÓM lý do phải thấy số mới ngay: hai action ấy gọi `clearMemo()`.
 * Kết quả trả về là đối tượng DÙNG CHUNG giữa các lượt đọc — nơi nhận không được sửa tại chỗ.
 */
export async function getReturnReasonReport(f: ReasonFilter): Promise<ReturnReasonReport> {
  // Cờ cách xếp NẰM TRONG khoá nhớ đệm: bật cờ xong mà còn đọc bản dựng theo cách cũ là một lượt
  // màn hình nói một đằng, `settings` nói một nẻo (AGENTS.md mục 2: tham số đổi kết quả ⇒ vào khoá).
  const taxonomy = f.taxonomy ?? (await getReasonTaxonomy());
  const key = [
    "return-reason-report",
    taxonomy,
    f.basis ?? "-",
    f.period.from?.toISOString() ?? "-",
    f.period.to?.toISOString() ?? "-",
    orderValueKey(f.value ?? NO_ORDER_VALUE_FILTER),
    (f.codes ?? []).join("+"),
    (f.variantKeys ?? []).join("+"),
    (f.marketerIds ?? []).join("+"),
    (f.groups ?? []).join("+"),
    (f.reasons ?? []).join("+"),
    // 2b — mọi bộ lọc vào khoá (AGENTS mục 2): thiếu một trường là hai bộ lọc khác nhau nhận cùng một kết quả.
    (f.sources ?? []).join("+"),
    (f.carriers ?? []).join("+"),
    (f.careOwners ?? []).join("+"),
    (f.provinces ?? []).join("+"),
    encodeURIComponent(postOfficeQuery(f.postOffice)),
    (f.outcomes ?? []).join("+"),
  ].join(":");
  return memo(key, 90_000, () => dungBaoCaoLyDo({ ...f, taxonomy }));
}

const demBac = (): Record<EvidenceTier, number> => Object.fromEntries(EVIDENCE_TIERS.map((t) => [t, 0])) as Record<EvidenceTier, number>;

/**
 * Nhóm "nhà" của một lý do khi CHƯA có ca nào — để in dòng 0. Hỏi chính `groupOf` với một lời khai
 * của NGƯỜI: dòng 0 đứng ở nhóm mà lý do đó sẽ vào nếu có người xác nhận, cùng một hàm với ca thật.
 */
const nhomNha = (grouping: ReasonGrouping, reason: ReturnReason) => grouping.groupOf({ reason, items: [{ source: "HUMAN_CONFIRMED", reason, at: 0 }] });

async function dungBaoCaoLyDo(f: ReasonFilter): Promise<ReturnReasonReport> {
  const [{ basis, rows: tatCa, facets }, grouping] = await Promise.all([baseRows(f), getReasonGrouping(f.taxonomy)]);
  /*
    CÁCH XẾP NHÓM dựng MỘT lần cho cả lượt báo cáo (cờ + ghi đè của chủ shop). Mọi chỗ xếp nhóm
    trong hàm này đọc `grouping.groupOf`, KHÔNG đọc thẳng một bảng tĩnh — hai đường tra khác nhau
    là hai con số khác nhau giữa bảng nhóm và bảng chi tiết.
  */

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

  /*
    GỘP THEO (NHÓM, LÝ DO), không theo lý do. Ở cách xếp theo chứng cứ, CÙNG một lý do vào hai nhóm
    tuỳ ai nói ra ("vải mỏng" của nhân viên ⇒ chất lượng; của bưu tá ⇒ khách từ chối chưa rõ) —
    gộp theo lý do là trộn hai thứ ấy lại. Ở cách xếp cũ mỗi lý do đúng một nhóm nên hai cách gộp
    cho cùng con số.
  */
  type Acc = { group: ReasonGroupKey | null; reason: ReturnReason; count: number; rescued: number; eligible: number; withIntervention: number; lostRevenue: number; lostUnknown: number; confidence: Record<ReasonConfidence, number>; tiers: Record<EvidenceTier, number> };
  const moi = (group: ReasonGroupKey | null, reason: ReturnReason): Acc => ({ group, reason, count: 0, rescued: 0, eligible: 0, withIntervention: 0, lostRevenue: 0, lostUnknown: 0, confidence: EMPTY_CONFIDENCE_COUNTS(), tiers: demBac() });
  const theoLyDo = new Map<string, Acc>();
  const lyDoTheoDon = new Map<string, ReturnReason>();
  const evidenceTiers = demBac();
  let ungrouped = 0;
  // Người đã động vào ca (xác nhận HOẶC ghi nhận) — mẫu của cột "đã cứu". Ghi chú chăm sóc là một
  // thao tác người thật; tách nhãn "Người xác nhận" ra khỏi nó không được làm cột cứu mất ca.
  const coNguoi = (c: ReasonConfidence | undefined) => c === "CONFIRMED" || c === "STAFF_REPORTED";

  for (const r of ketThucRows) {
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    const reason: ReturnReason = v?.reason ?? "UNKNOWN";
    const group = v ? grouping.groupOf(v) : null;
    if (r.outcome !== "DELIVERED" && group === null) ungrouped += 1;
    const k = `${group ?? "-"}|${reason}`;
    const cur = theoLyDo.get(k) ?? moi(group, reason);
    if (r.outcome === "DELIVERED") {
      /*
        ĐƠN GIAO THÀNH CÔNG MÀ VẪN MANG LÝ DO HOÀN = ca đã được cứu.

        Chỉ đếm khi lý do đến từ CHỨNG TỪ (không phải `UNKNOWN`): một đơn giao thành công bình
        thường chưa bao giờ gặp nguy cơ hoàn, đếm nó vào tử số là ghi công cho việc không ai làm.
      */
      if (reason !== "UNKNOWN") {
        cur.rescued += 1;
        cur.eligible += 1;
        if (coNguoi(v?.confidence)) cur.withIntervention += 1;
      }
    } else {
      const tier = v ? grouping.tierOf(v) : "UNKNOWN";
      cur.count += 1;
      cur.lostRevenue += r.revenue;
      if (!r.revenueKnown) cur.lostUnknown += 1;
      cur.confidence[v?.confidence ?? "NONE"] += 1;
      cur.tiers[tier] += 1;
      evidenceTiers[tier] += 1;
      if (reason !== "UNKNOWN") cur.eligible += 1;
      if (coNguoi(v?.confidence)) cur.withIntervention += 1;
      if (r.shipmentId) lyDoTheoDon.set(r.orderId, reason);
    }
    theoLyDo.set(k, cur);
  }

  const unknown = [...theoLyDo.values()].filter((a) => a.reason === "UNKNOWN").reduce((n, a) => n + a.count, 0);
  const known = returned - unknown;
  /*
    ─── TÁCH PHẦN CHƯA BIẾT LÀM HAI, VÌ CHÚNG LÀ HAI VIỆC KHÁC NHAU ───

    Kiện `RAW_ONLY` đã CÓ chữ của ai đó — việc phải làm là mở ra đọc rồi chọn lý do, làm được ngay
    hôm nay. Kiện `NO_EVIDENCE` thì không có gì để đọc: phải gọi khách hoặc để kho ghi lại khi mở
    kiện. Gộp chúng thành một con số "chưa xác định" làm phần dễ làm nhất biến mất khỏi tầm mắt.

    Đếm trên ĐÚNG tập đơn hoàn đang hiện (`hoanRows`), không đếm trên toàn shop: một con số độ phủ
    của tập khác không nói gì về bảng người đọc đang nhìn.
  */
  let rawOnly = 0;
  let noEvidence = 0;
  for (const r of hoanRows) {
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    if ((v?.reason ?? "UNKNOWN") !== "UNKNOWN") continue;
    if (v?.coverage === "RAW_ONLY") rawOnly += 1;
    else noEvidence += 1;
  }
  /*
    TỶ TRỌNG TÍNH TRÊN ĐƠN ĐÃ XÁC ĐỊNH ĐƯỢC LÝ DO, không trên tổng đơn hoàn.

    Lấy tổng đơn hoàn làm mẫu số thì mọi tỷ trọng bị kéo xuống bởi phần chưa ai hỏi — "vải xấu
    12%" trong khi thực tế trong số ca ĐÃ BIẾT thì vải xấu chiếm 40%. Phần chưa biết được báo
    riêng bằng độ phủ, ngay phía trên bảng.
  */
  const mauTyTrong = known;

  const details = new Map<ReasonGroupKey, ReasonDetailRow[]>();
  const bacTheoNhom = new Map<ReasonGroupKey, Record<EvidenceTier, number>>();
  const chuaBietGiaTri = new Map<ReasonGroupKey, number>();
  for (const a of theoLyDo.values()) {
    const { reason, group: g } = a;
    if (reason === "UNKNOWN" || g === null) continue;
    chuaBietGiaTri.set(g, (chuaBietGiaTri.get(g) ?? 0) + a.lostUnknown);
    const b = bacTheoNhom.get(g) ?? demBac();
    for (const t of EVIDENCE_TIERS) b[t] += a.tiers[t];
    bacTheoNhom.set(g, b);
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
  for (const reason of RETURN_REASONS) {
    if (reason === "UNKNOWN") continue;
    if (f.reasons?.length && !f.reasons.includes(reason)) continue;
    const g = nhomNha(grouping, reason);
    if (g === null) continue;
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
        confidence: EMPTY_CONFIDENCE_COUNTS(),
        needsHuman: REASON_NEEDS_HUMAN[reason],
      });
    }
    details.set(g, list);
  }

  const groups: ReasonGroupRow[] = grouping.groups
    .filter((x) => !f.groups?.length || f.groups.includes(x.key))
    .map(({ key: g, label, action, department }) => {
      const list = (details.get(g) ?? []).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "vi"));
      const count = list.reduce((n, d) => n + d.count, 0);
      const rescued = list.reduce((n, d) => n + d.rescued, 0);
      const eligible = list.reduce((n, d) => n + (d.count + d.rescued), 0);
      const withIntervention = list.reduce((n, d) => n + (d.rescue.state === "MEASURED" ? 1 : 0), 0);
      return {
        group: g,
        label,
        action,
        department,
        tiers: bacTheoNhom.get(g) ?? demBac(),
        count,
        rescued,
        rescue: rescueRate({ eligible, withIntervention, rescued }),
        share: mauTyTrong ? (count / mauTyTrong) * 100 : 0,
        incidence: eligibleSent ? Math.round((count / eligibleSent) * 1000) / 10 : null,
        lostRevenue: list.reduce((n, d) => n + d.lostRevenue, 0),
        lostRevenueUnknown: chuaBietGiaTri.get(g) ?? 0,
        details: list,
      };
    });

  const products = await productRows(f, hoanRows, lyDoTheoDon, ketThucRows);
  const daBiet = [...theoLyDo.values()].filter((a) => a.reason !== "UNKNOWN");
  const eligibleTong = daBiet.reduce((n, a) => n + a.eligible, 0);
  const interventionTong = daBiet.reduce((n, a) => n + a.withIntervention, 0);
  const rescuedTong = daBiet.reduce((n, a) => n + a.rescued, 0);

  return {
    facets,
    taxonomy: grouping.taxonomy,
    taxonomyNotes: grouping.notes,
    evidenceTiers,
    period: f.period,
    basis,
    finished,
    delivered,
    returned,
    returnRate: finished ? (returned / finished) * 100 : null,
    successRate: finished ? (delivered / finished) * 100 : null,
    groups,
    products,
    reasonCoverage: { known, unknown, rawOnly, noEvidence, pct: returned ? (known / returned) * 100 : null },
    missingBasis,
    multiSkuOrders: products.reduce((n, p) => Math.max(n, p.multiSku), 0),
    rescueCoverage: { eligible: eligibleTong, withIntervention: interventionTong, rescued: rescuedTong },
    /*
      ĐỘ PHỦ dựng bằng CHÍNH phép gộp của `lib/queries/order-marketer.ts` — mỗi ca đã mang sẵn tình
      trạng và loại bằng chứng từ `baseRows`, nên không có đường nào để ô độ phủ và bảng theo
      marketer trên cùng màn hình nói hai con số khác nhau.
    */
    marketerCoverage: summarizeMarketerCoverage(ketThucRows.map((r) => ({ state: r.marketerState, evidence: r.marketerEvidence, conflicts: r.marketerConflict ? 1 : 0, n: 1 }))),
    marketers: marketerRows(ketThucRows, verdicts),
    lostRevenue: hoanRows.reduce((n, r) => n + r.revenue, 0),
    eligibleSent,
    active,
    ungrouped,
    lostRevenueUnknown: hoanRows.filter((r) => !r.revenueKnown).length,
  };
}

/**
 * Vỡ theo MARKETER trên đúng tập ca đã lọc. Không truy vấn thêm: mỗi ca đã mang sẵn `marketerId`
 * từ `baseRows`, nên mọi dòng ở đây là phép đếm lại trên cùng một mảng — không có đường nào để
 * tổng theo marketer lệch khỏi tổng chung.
 */
function marketerRows(
  rows: { orderId: string; shipmentId: string | null; outcome: string; marketerId: string | null; marketerEvidence: MarketerEvidence | null; revenue: number }[],
  verdicts: Map<string, { reason: ReturnReason }>,
): MarketerReturnRow[] {
  const theoNguoi = new Map<
    string | null,
    { finished: number; delivered: number; returned: number; lostRevenue: number; reasons: Map<ReturnReason, number>; byEvidence: Record<MarketerEvidence, number> }
  >();
  for (const r of rows) {
    const cur = theoNguoi.get(r.marketerId) ?? {
      finished: 0,
      delivered: 0,
      returned: 0,
      lostRevenue: 0,
      reasons: new Map(),
      byEvidence: Object.fromEntries(MARKETER_EVIDENCE.map((e) => [e, 0])) as Record<MarketerEvidence, number>,
    };
    cur.finished += 1;
    if (r.marketerEvidence) cur.byEvidence[r.marketerEvidence] += 1;
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
        byEvidence: v.byEvidence,
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
  /** Bậc chứng cứ của ca — cùng hàm với ô bậc ở bảng nhóm. */
  evidenceTier: EvidenceTier;
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
export type ReasonDrilldownFilter = ReasonFilter & { reason?: ReturnReason; group?: ReasonGroupKey; productCode?: string; limit?: number };

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
  const [verdicts, grouping] = await Promise.all([reasonsForShipments(shipmentIds), getReasonGrouping(f.taxonomy)]);
  // CÙNG cách xếp nhóm với bảng tổng hợp: bấm vào một nhóm phải ra đúng số dòng nhóm đó in ra.
  const chon = rows.filter((r) => {
    const v = r.shipmentId ? verdicts.get(r.shipmentId) : undefined;
    const reason: ReturnReason = v?.reason ?? "UNKNOWN";
    /*
      Lý do VÀ nhóm cùng lúc: ở cách xếp theo chứng cứ một lý do nằm được ở hai nhóm, nên bấm vào
      dòng "Vải mỏng" của nhóm "Khách từ chối — chưa rõ" phải ra đúng các ca của dòng đó.
    */
    if (f.reason && reason !== f.reason) return false;
    if (f.group) return reason !== "UNKNOWN" && v !== undefined && grouping.groupOf(v) === f.group;
    if (f.reason) return true;
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

/**
 * TẬP CA HOÀN kèm lời khai — CHỈ cho lượt chạy thử đổi cách xếp (`scripts/reason-taxonomy-dryrun.ts`).
 * Dùng ĐÚNG `chonCaHoan` của drilldown, nên ma trận chuyển nhóm đứng trên cùng tập ca với bảng.
 */
export async function returnedReasonCases(f: ReasonDrilldownFilter): Promise<{ orderId: string; shipmentId: string | null; verdict: ReasonVerdict | null }[]> {
  const { chon, verdicts } = await chonCaHoan(f);
  return chon.map((r) => ({ orderId: r.orderId, shipmentId: r.shipmentId, verdict: r.shipmentId ? (verdicts.get(r.shipmentId) ?? null) : null }));
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
      evidenceTier: v ? resolveEvidence(v.items).tier : "UNKNOWN",
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
