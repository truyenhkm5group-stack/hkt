import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CARRIER_SUBSTATES, CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { confidenceOf, PROJECTED_GTC_VERSION, type ProbabilityBasis, type ProbabilityConfidence } from "@/lib/constants/projected-delivery";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
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
