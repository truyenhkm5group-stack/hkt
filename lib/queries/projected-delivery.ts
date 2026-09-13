import { and, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_SUBSTATES, CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { confidenceOf, PROJECTED_GTC_VERSION, type ProbabilityBasis, type ProbabilityConfidence } from "@/lib/constants/projected-delivery";
import { CARRIER_HANDOFF_AT_SQL, FINAL_OUTCOME_AT_SQL, type TimeBasis } from "@/lib/constants/report-time-basis";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ XÁC SUẤT HỌC TỪ LỊCH SỬ THẬT, KHÔNG PHẢI TỪ MỘT CON SỐ AI ĐÓ GÕ VÀO ═══════════
 *
 * Xem `lib/constants/projected-delivery.ts` cho hợp đồng đầy đủ và cho lý do hai báo cáo đang lệch.
 */

export type StateProbability = {
  substate: CarrierSubstate;
  label: string;
  /** Số vận đơn TỪNG ở trạng thái này và ĐÃ có kết cục cuối. */
  sample: number;
  delivered: number;
  /** `null` khi mẫu bằng 0 — CHƯA ĐO ĐƯỢC, không phải 0%. */
  p: number | null;
  confidence: ProbabilityConfidence;
};

/**
 * ─── VÌ SAO `distinct` LÀ PHẦN QUAN TRỌNG NHẤT CỦA CÂU LỆNH NÀY ───
 *
 * Một vận đơn "chờ phát lại" có thể sinh năm sự kiện: Viettel Post thử lại webhook tới 5 lần, và
 * ERP cũng nhận cùng trạng thái qua cả tra API lẫn nhập tệp. Đếm theo SỰ KIỆN nghĩa là để số lần
 * thử lại quyết định xác suất — kiện nào webhook lặp nhiều thì "nặng" hơn trong mô hình.
 *
 * `select distinct s.id, con` cắt đúng chỗ đó: mỗi vận đơn đóng góp ĐÚNG MỘT quan sát cho mỗi
 * trạng thái nó từng đi qua.
 *
 * ─── VÀ VÌ SAO MẪU SỐ CHỈ GỒM KIỆN ĐÃ KẾT THÚC ───
 *
 * Kiện đang chạy chưa nói được gì về kết cục. Đưa nó vào mẫu số là trộn "chưa biết" với "đã biết
 * là hỏng": xác suất tụt xuống chỉ vì hôm nay có nhiều kiện mới, và mô hình dự báo ngày càng bi
 * quan theo tốc độ bán hàng chứ không theo chất lượng giao vận.
 */
export async function getStateDeliveryProbabilities(): Promise<{ version: string; states: StateProbability[]; totalSample: number }> {
  return memo(`state-delivery-prob:${PROJECTED_GTC_VERSION}`, 600_000, async () => {
    const db = await getDb();
    const con = carrierSubstateSql(sql`nullif(regexp_replace(e.status, '[^0-9]', '', 'g'), '')::int`, sql`e.status_name`, sql`null::text`);
    const rows = rowsOf<{ con: string; mau: number; giao: number }>(
      await db.execute(sql`
        with ket_cuc as (
          /*
            KẾT CỤC CUỐI lấy từ chính chứng từ ĐVVC đã được chuẩn hoá vào bảng shipments, không suy từ
            tiền và không suy từ trạng thái Pancake. Chỉ hai hướng được coi là ĐÃ KẾT THÚC.
          */
          select s.id,
                 (s.stage = 'DELIVERED') as da_giao,
                 (s.stage in ('DELIVERED', 'RETURNED')) as da_ket_thuc
            from shipments s
           where s.order_id is not null
        ),
        quan_sat as (
          -- MỘT vận đơn × MỘT trạng thái = MỘT quan sát, bất kể bao nhiêu sự kiện.
          select distinct e.shipment_id, ${con} as con
            from shipment_events e
            join ket_cuc k on k.id = e.shipment_id and k.da_ket_thuc
           where e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL')
        )
        select q.con,
               count(*)::int as mau,
               count(*) filter (where k.da_giao)::int as giao
          from quan_sat q
          join ket_cuc k on k.id = q.shipment_id
         group by q.con
      `),
    );
    const theoCon = new Map(rows.map((r) => [r.con, { mau: Number(r.mau), giao: Number(r.giao) }]));
    const states: StateProbability[] = CARRIER_SUBSTATES.map((k) => {
      const r = theoCon.get(k) ?? { mau: 0, giao: 0 };
      return {
        substate: k,
        label: CARRIER_SUBSTATE_LABEL[k],
        sample: r.mau,
        delivered: r.giao,
        p: r.mau > 0 ? r.giao / r.mau : null,
        confidence: confidenceOf(r.mau),
      };
    });
    return { version: PROJECTED_GTC_VERSION, states, totalSample: states.reduce((a, s) => a + s.sample, 0) };
  });
}

export type ProbabilityLookup = {
  version: string;
  /** Xác suất cho một trạng thái, kèm căn cứ và độ tin cậy. `p === null` ⇒ CHƯA ĐO ĐƯỢC. */
  of: (substate: CarrierSubstate) => { p: number | null; basis: ProbabilityBasis; confidence: ProbabilityConfidence; sample: number };
  states: StateProbability[];
};

/**
 * Bảng tra xác suất dùng chung cho MỌI báo cáo.
 *
 * Bậc lùi cố ý NGẮN và cố ý KHÔNG có bậc "mặc định": hết bậc thì trả `null`, và nơi gọi phải in
 * "chưa đo được". Một con số đoán trông y hệt một con số đo được — đó là thứ nguy hiểm hơn cả
 * không có số.
 */
export async function getProbabilityLookup(): Promise<ProbabilityLookup> {
  const { version, states } = await getStateDeliveryProbabilities();
  const theo = new Map(states.map((s) => [s.substate, s]));
  return {
    version,
    states,
    of: (substate) => {
      const s = theo.get(substate);
      if (!s || s.p === null || s.confidence === "INSUFFICIENT_DATA") {
        /*
          TRẢ `null`, KHÔNG trả con số thô.

          Cám dỗ: mẫu chỉ 3 kiện nhưng vẫn có một tỷ lệ (2/3) — "thôi cứ đưa ra, có còn hơn không".
          Không: một con số đoán in ra trông Y HỆT một con số đo được, và người đọc không có cách
          nào phân biệt. `sample` vẫn được trả về để màn hình nói được "mới 3 ca, chưa đủ để kết
          luận" — đó là thông tin thật; còn 66,7% ở đây là tiếng ồn đội lốt tri thức.
        */
        return { p: null, basis: "NONE", confidence: s?.confidence ?? "INSUFFICIENT_DATA", sample: s?.sample ?? 0 };
      }
      return { p: s.p, basis: "GLOBAL_STATE", confidence: s.confidence, sample: s.sample };
    },
  };
}

/* ═══════════════════ ĐỐI CHIẾU NGƯỢC: MÔ HÌNH NÀY CÓ ĐÚNG KHÔNG ═══════════════════ */

export type Backtest = {
  /** Số vận đơn đã kết thúc được đem ra thử. */
  sample: number;
  /** Sai số tuyệt đối trung bình giữa xác suất dự báo và kết cục thật (0..1). */
  mae: number | null;
  /** Lệch hệ thống: dương = mô hình LẠC QUAN hơn thực tế. */
  bias: number | null;
  /** Tỷ lệ vận đơn có ít nhất một trạng thái đủ mẫu để dự báo. */
  coverage: number | null;
  byState: { substate: CarrierSubstate; sample: number; predicted: number; actual: number }[];
};

/**
 * ═══════════ KHÔNG CÔNG BỐ MỘT MÔ HÌNH CHƯA ĐƯỢC THỬ NGƯỢC ═══════════
 *
 * Lấy chính những vận đơn ĐÃ KẾT THÚC, giả vờ chỉ biết trạng thái chúng từng đi qua, để mô hình
 * đoán, rồi so với kết cục thật. Nếu sai số lớn hoặc lệch hệ thống rõ thì con số "ước tính" không
 * được in ra như một con số chắc chắn — và màn hình phải nói điều đó.
 *
 * `bias` dương nghĩa là mô hình LẠC QUAN hơn thực tế: nó hứa giao được nhiều hơn số thật sự giao
 * được. Đó là hướng sai nguy hiểm hơn, vì nó thổi doanh thu ước tính và thổi lợi nhuận theo.
 */
export async function backtestProjectedDelivery(): Promise<Backtest> {
  const db = await getDb();
  const lookup = await getProbabilityLookup();
  const con = carrierSubstateSql(sql`nullif(regexp_replace(e.status, '[^0-9]', '', 'g'), '')::int`, sql`e.status_name`, sql`null::text`);
  const rows = rowsOf<{ shipment_id: string; con: string; da_giao: boolean }>(
    await db.execute(sql`
      with ket_cuc as (
        select s.id, (s.stage = 'DELIVERED') as da_giao
          from shipments s
         where s.order_id is not null and s.stage in ('DELIVERED', 'RETURNED')
      )
      select distinct e.shipment_id, ${con} as con, k.da_giao
        from shipment_events e
        join ket_cuc k on k.id = e.shipment_id
       where e.source in ('VTP_WEBHOOK','VTP_IMPORT','VTP_POLL')
    `),
  );

  /*
    MỘT VẬN ĐƠN MỘT DỰ BÁO, không phải một dự báo cho mỗi trạng thái nó từng đi qua.

    Lấy trạng thái có mẫu LỚN NHẤT trong số các trạng thái kiện đó từng ở — đó là trạng thái mà mô
    hình biết rõ nhất. Trung bình cộng nhiều trạng thái sẽ trộn một quan sát chắc chắn với một quan
    sát nhiễu và làm hỏng cả hai.
  */
  const theoKien = new Map<string, { daGiao: boolean; tot: { p: number; sample: number; con: CarrierSubstate } | null }>();
  for (const r of rows) {
    const k = theoKien.get(r.shipment_id) ?? { daGiao: r.da_giao, tot: null };
    const tra = lookup.of(r.con as CarrierSubstate);
    if (tra.p !== null && (!k.tot || tra.sample > k.tot.sample)) k.tot = { p: tra.p, sample: tra.sample, con: r.con as CarrierSubstate };
    theoKien.set(r.shipment_id, k);
  }

  let n = 0;
  let tongSaiSo = 0;
  let tongLech = 0;
  const theoCon = new Map<CarrierSubstate, { n: number; duBao: number; that: number }>();
  for (const k of theoKien.values()) {
    if (!k.tot) continue;
    n += 1;
    const that = k.daGiao ? 1 : 0;
    tongSaiSo += Math.abs(k.tot.p - that);
    tongLech += k.tot.p - that;
    const c = theoCon.get(k.tot.con) ?? { n: 0, duBao: 0, that: 0 };
    c.n += 1;
    c.duBao += k.tot.p;
    c.that += that;
    theoCon.set(k.tot.con, c);
  }
  return {
    sample: n,
    mae: n ? Math.round((tongSaiSo / n) * 1000) / 1000 : null,
    bias: n ? Math.round((tongLech / n) * 1000) / 1000 : null,
    coverage: theoKien.size ? Math.round((n / theoKien.size) * 1000) / 10 : null,
    byState: [...theoCon.entries()]
      .map(([substate, c]) => ({ substate, sample: c.n, predicted: Math.round((c.duBao / c.n) * 1000) / 1000, actual: Math.round((c.that / c.n) * 1000) / 1000 }))
      .sort((a, b) => b.sample - a.sample),
  };
}

/* ═══════════════════ CHỈ SỐ GIAO VẬN ƯỚC TÍNH — MỘT NGUỒN CHO MỌI BÁO CÁO ═══════════════════ */

export type ActiveBreakdown = Partial<Record<CarrierSubstate, number>>;

/**
 * ═══ GRAIN LÀ THAM SỐ, CÔNG THỨC THÌ KHÔNG ═══
 *
 * `PRODUCT` — gộp theo mã hàng của shop (`products.custom_id`). Bảng lợi nhuận dùng grain này.
 * `VARIANT` — gộp theo mẫu mã, ĐÚNG khoá `VARIANT_KEY` của bảng hiệu quả theo mã
 *             (`coalesce(order_items.variant_id, 'sku:'||sku||'|'||product_name||'|'||detail)`),
 *             để mỗi dòng trên bảng đó có con số ước tính của CHÍNH nó.
 *
 * Hai grain là hai lát cắt khác nhau của cùng một tập đơn — chúng ĐƯỢC PHÉP ra số khác nhau. Cái
 * không được phép là hai CÔNG THỨC, và đó là thứ bản này xoá: cả hai đi qua đúng một vòng lặp cân
 * xác suất bên dưới, chỉ khác khoá gộp.
 */
export const PROJECTED_GRAINS = ["PRODUCT", "VARIANT"] as const;
export type ProjectedGrain = (typeof PROJECTED_GRAINS)[number];

export type ProjectedProductRow = {
  /** Khoá gộp: mã hàng (`PRODUCT`) hoặc khoá mẫu mã (`VARIANT`). `""` = chưa lần được về đâu. */
  code: string;
  name: string;
  /** Đơn đã bàn giao ĐVVC trong cohort — mẫu số của tỷ lệ ước tính. */
  eligibleSent: number;
  deliveredActual: number;
  failedActual: number;
  /** Đơn chưa có kết cục, tách theo ĐÚNG trạng thái ĐVVC đang báo. */
  active: number;
  activeByState: ActiveBreakdown;
  /** Tỷ lệ GTC THỰC TẾ: chỉ trên đơn ĐÃ KẾT THÚC. `null` = chưa đơn nào kết thúc. */
  actualRate: number | null;
  /** Ước tính giao được = đã giao thật + Σ(đang ở trạng thái s × P(s)). */
  projectedDelivered: number;
  projectedRate: number | null;
  deliveredRevenueActual: number;
  /** Doanh thu GTC ước tính — cân THEO TỪNG ĐƠN, không nhân tổng doanh số với một tỷ lệ. */
  projectedDeliveredRevenue: number;
  /** Số đơn đang chạy mà mô hình KHÔNG dự báo được (trạng thái chưa đủ mẫu). */
  unmodelledActive: number;
};

export type ProjectedMetrics = {
  version: string;
  rows: ProjectedProductRow[];
  /** Đơn chưa lần được về mã hàng nào — CHƯA BIẾT, không gộp vào "mã khác". */
  unmappedOrders: number;
  /** Đơn thuộc nhiều mã: được cộng cho MỌI mã, nên tổng theo mã > tổng đơn thật. */
  multiCodeOrders: number;
  totalOrders: number;
  probabilities: StateProbability[];
};

/**
 * ═══════════ DOANH THU GTC ƯỚC TÍNH CÂN THEO TỪNG ĐƠN ═══════════
 *
 * Cách cũ ở `profit-nominal.ts:289` là `grossSales × (1 − r)`: nhân TOÀN BỘ doanh số của mã với
 * MỘT tỷ lệ. Nó coi mọi đơn chưa kết thúc như nhau — đơn vừa rời kho sáng nay và đơn đã "chờ phát
 * lại" ba ngày có cùng triển vọng. Chúng không có.
 *
 * Ở đây mỗi đơn mang xác suất của CHÍNH trạng thái nó đang ở:
 *
 *     DT ước tính = DT các đơn ĐÃ GIAO + Σ(DT đơn đang chạy × P(trạng thái của nó))
 *
 * Đơn đang ở trạng thái chưa đủ mẫu KHÔNG bị gán một xác suất đoán: nó nằm ngoài phần ước tính và
 * được đếm riêng ở `unmodelledActive`, để người đọc biết phần chưa dự báo được lớn tới đâu.
 *
 * ─── GRAIN ───
 *
 * Đơn có nhiều mã hàng: doanh thu chia theo `line_total` của từng dòng hàng (đúng cách bảng lợi
 * nhuận đang chia), còn SỐ ĐƠN thì cộng cho mọi mã — nên tổng theo mã lớn hơn tổng đơn thật, và
 * `multiCodeOrders` nói ra phần chồng lấn đó. KHÔNG chia số đơn theo tỷ lệ: một đơn hỏng thì cả
 * hai mã trong đơn đều bị ảnh hưởng, không phải mỗi mã hỏng một nửa.
 */
export async function getProjectedDeliveryMetrics(
  period: { from: Date | null; to: Date | null },
  basis: TimeBasis = "SHIPPED",
  grain: ProjectedGrain = "PRODUCT",
): Promise<ProjectedMetrics> {
  const key = `projected-metrics:${PROJECTED_GTC_VERSION}:${basis}:${grain}:${period.from?.toISOString() ?? "-"}:${period.to?.toISOString() ?? "-"}`;
  return memo(key, 90_000, async () => {
    const db = await getDb();
    const lookup = await getProbabilityLookup();
    const con = carrierSubstateSql(sql`"shipments"."vtp_status"`, sql`"shipments"."vtp_status_name"`, sql`"shipments"."stage"::text`);

    /*
      ═══ MỐC COHORT LÀ THAM SỐ, KHÔNG PHẢI MỘT KHÁC BIỆT NGẦM ═══

      Hai báo cáo hỏi hai câu khác nhau và cần hai cohort khác nhau — đó KHÔNG phải lỗi:

        `SHIPPED` — "lô hàng GỬI ĐI trong khoảng này đã đi tới đâu". Bảng hiệu quả theo mã mặc định
                    mốc này; cột đầu của nó tên "Đã gửi" nên bất kỳ mốc nào khác đều là một cái bẫy.
        `ORDERED` — "đơn CHỐT trong khoảng này sinh ra bao nhiêu tiền". Bảng lợi nhuận dùng mốc này,
                    vì doanh số POS, chi phí quảng cáo và giá vốn của nó đều đi theo ngày chốt đơn.
        `OUTCOME` — "trong khoảng này chốt xong bao nhiêu ca". Cohort này gần như chỉ gồm kiện ĐÃ
                    kết thúc, nên phần "ước tính" tự nhiên teo về 0 và số dự báo trùng số thật.
                    Đó là câu trả lời ĐÚNG cho câu hỏi đó, không phải một lỗi cần vá.

      Cái SAI trước bản này không phải là nhiều cohort — mà là nhiều CÔNG THỨC, mỗi bên xử lý nhóm
      đơn chưa rõ một kiểu, và không màn hình nào nói ra mình đang dùng mốc nào. Nay công thức chỉ
      còn MỘT, mốc là tham số hiện rõ, và mỗi trang truyền xuống ĐÚNG mốc mà nó đang hiển thị.

      Ba mốc dùng lại đúng ba biểu thức của `lib/constants/report-time-basis.ts` — bảng số liệu và
      con số ước tính của cùng một trang phải cắt cùng một tập đơn, nếu không thì "tỷ lệ ước tính"
      lại nói về một lô hàng khác với lô đang nằm trên bảng.
    */
    const MOC_THEO_BASIS: Record<TimeBasis, { expr: SQL; coTheRong: boolean }> = {
      // `orders.inserted_at` là cột NOT NULL ⇒ không cần lọc rỗng; hai mốc kia là `coalesce(...)`
      // của các cột chứng từ ĐVVC và CÓ THỂ rỗng khi chưa có chứng từ nào.
      ORDERED: { expr: sql`"orders"."inserted_at"`, coTheRong: false },
      SHIPPED: { expr: sql.raw(CARRIER_HANDOFF_AT_SQL), coTheRong: true },
      OUTCOME: { expr: sql.raw(FINAL_OUTCOME_AT_SQL), coTheRong: true },
    };
    const { expr: moc, coTheRong } = MOC_THEO_BASIS[basis];
    const dk: SQL[] = [sql`"shipments"."order_id" is not null`];
    if (period.from) dk.push(sql`${moc} >= ${period.from}`);
    if (period.to) dk.push(sql`${moc} <= ${period.to}`);
    if ((period.from || period.to) && coTheRong) dk.push(sql`${moc} is not null`);

    /*
      Khoá gộp của grain `VARIANT` phải là ĐÚNG biểu thức `VARIANT_KEY` ở `return-rate.ts` — chép
      lệch một dấu nối thì hai bảng gộp ra hai tập dòng khác nhau và con số lại rời nhau, đúng thứ
      bản này đang đi xoá. Tên hiển thị lấy `sku` (rơi về tên sản phẩm khi mẫu mã không có SKU) để
      trùng cách bảng kia đặt nhãn dòng.
    */
    const khoa = grain === "VARIANT" ? sql`coalesce(oi.variant_id, 'sku:' || oi.sku || '|' || oi.product_name || '|' || oi.variation_detail)` : sql`p.custom_id`;
    const ten = grain === "VARIANT" ? sql`coalesce(nullif(oi.sku, ''), oi.product_name)` : sql`p.name`;

    const rows = rowsOf<{ order_id: string; code: string | null; name: string | null; line_total: string | number; order_total: string | number; stage: string; con: string }>(
      await db.execute(sql`
        select "orders"."id" as order_id,
               ${khoa} as code,
               ${ten} as name,
               coalesce(sum(oi.line_total), 0) as line_total,
               max("orders"."total_price_after_discount") as order_total,
               max("shipments"."stage"::text) as stage,
               max(${con}) as con
          from "shipments"
          join "orders" on "orders"."id" = "shipments"."order_id" and ${PRIMARY_ATTEMPT}
          left join order_items oi on oi.order_id = "orders"."id" and oi.is_bonus = false
          left join product_variants pv on pv.id = oi.variant_id
          left join products p on p.id = pv.product_id
         where ${and(...dk)}
         group by "orders"."id", ${khoa}, ${ten}
      `),
    );

    type Acc = ProjectedProductRow & { _revActive: number };
    const theoMa = new Map<string, Acc>();
    const maCuaDon = new Map<string, Set<string>>();
    let unmappedOrders = 0;

    const lay = (code: string, name: string): Acc => {
      const cu = theoMa.get(code);
      if (cu) return cu;
      const moi: Acc = {
        code,
        name,
        eligibleSent: 0,
        deliveredActual: 0,
        failedActual: 0,
        active: 0,
        activeByState: {},
        actualRate: null,
        projectedDelivered: 0,
        projectedRate: null,
        deliveredRevenueActual: 0,
        projectedDeliveredRevenue: 0,
        unmodelledActive: 0,
        _revActive: 0,
      };
      theoMa.set(code, moi);
      return moi;
    };

    for (const r of rows) {
      const code = (r.code ?? "").trim();
      if (!code) {
        unmappedOrders += 1;
        continue;
      }
      const set = maCuaDon.get(r.order_id) ?? new Set<string>();
      set.add(code);
      maCuaDon.set(r.order_id, set);

      const row = lay(code, r.name ?? "");
      // Doanh thu của mã trong đơn = tổng dòng hàng của mã đó; không có dòng nào thì lấy tiền đơn.
      const doanhThu = Number(r.line_total ?? 0) || Number(r.order_total ?? 0);
      const substate = r.con as CarrierSubstate;
      row.eligibleSent += 1;

      if (substate === "DELIVERED") {
        row.deliveredActual += 1;
        row.deliveredRevenueActual += doanhThu;
        row.projectedDelivered += 1;
        row.projectedDeliveredRevenue += doanhThu;
      } else if (substate === "RETURNED" || substate === "CANCELLED") {
        row.failedActual += 1;
      } else {
        row.active += 1;
        row.activeByState[substate] = (row.activeByState[substate] ?? 0) + 1;
        const tra = lookup.of(substate);
        if (tra.p === null) {
          // KHÔNG gán một xác suất đoán. Đơn này nằm ngoài phần ước tính và được nói ra.
          row.unmodelledActive += 1;
        } else {
          row.projectedDelivered += tra.p;
          row.projectedDeliveredRevenue += doanhThu * tra.p;
        }
      }
    }

    let multiCodeOrders = 0;
    for (const set of maCuaDon.values()) if (set.size > 1) multiCodeOrders += 1;

    const ket: ProjectedProductRow[] = [...theoMa.values()].map((r) => {
      const ketThuc = r.deliveredActual + r.failedActual;
      const { _revActive, ...rest } = r;
      void _revActive;
      return {
        ...rest,
        actualRate: ketThuc ? Math.round((r.deliveredActual / ketThuc) * 1000) / 10 : null,
        projectedDelivered: Math.round(r.projectedDelivered * 100) / 100,
        // Làm tròn CHỈ Ở ĐÂY, sau khi cộng xong: làm tròn từng bước sẽ tích luỹ sai số.
        projectedRate: r.eligibleSent ? Math.round((r.projectedDelivered / r.eligibleSent) * 1000) / 10 : null,
        projectedDeliveredRevenue: Math.round(r.projectedDeliveredRevenue),
      };
    });

    return {
      version: lookup.version,
      rows: ket.sort((a, b) => b.eligibleSent - a.eligibleSent || a.code.localeCompare(b.code)),
      unmappedOrders,
      multiCodeOrders,
      totalOrders: maCuaDon.size + unmappedOrders,
      probabilities: lookup.states,
    };
  });
}
