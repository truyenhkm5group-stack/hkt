import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { CO_MAU_TOI_THIEU } from "@/lib/queries/impact";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ CHĂM SÓC CÓ CỨU ĐƯỢC ĐƠN KHÔNG ═══════════
 *
 * Câu hỏi đáng tiền nhất của khâu giao vận, và tới hôm nay ERP chưa trả lời được lần nào.
 *
 * ─── VÌ SAO KHÔNG DỰNG LẠI QUÁ KHỨ ───
 *
 * Cám dỗ rất lớn: đã có hàng nghìn đơn giao hụt trong lịch sử, lấy ra chia hai nhóm là có ngay một
 * tỷ lệ nghe rất thuyết phục. Nhưng dữ liệu cũ **không mang actor**: không biết ai đã gọi, gọi lúc
 * nào, hay có gọi không. Chia nhóm bằng phỏng đoán rồi gọi kết quả là "hiệu quả chăm sóc" là bịa
 * một con số rồi dán nhãn khoa học lên nó.
 *
 * Nên cohort bắt đầu từ **lần ghi nhận chăm sóc đầu tiên** (bảng `care_actions`). Trước mốc đó là
 * CHƯA ĐO, và màn hình phải nói đúng như vậy.
 *
 * ─── QUAN SÁT, KHÔNG PHẢI NHÂN QUẢ ───
 *
 * Đây KHÔNG phải thí nghiệm có đối chứng. Người CSKH chọn gọi ai — và họ có xu hướng gọi đơn to,
 * khách quen, đơn còn cứu được. Chênh lệch tỷ lệ giữa hai nhóm vì thế mang sẵn thiên lệch đó.
 * `caveat` đi kèm mọi con số và phải được hiện lên màn hình, không giấu trong tài liệu.
 */

export type CareArm = {
  label: string;
  cohort: number;
  delivered: number;
  returned: number;
  pending: number;
  /** Tỷ lệ cứu được, chỉ tính trên đơn ĐÃ NGÃ NGŨ. `null` khi mẫu chưa đủ. */
  rescueRate: number | null;
  /** Tiền COD đã về của nhóm — SỰ THẬT, đo từ đơn đã giao. */
  recoveredCod: number;
};

export type CareEffectiveness = {
  /** Mốc bắt đầu đo. `null` = chưa ai ghi nhận lần chăm nào. */
  since: Date | null;
  cared: CareArm;
  notCared: CareArm;
  /** Chênh lệch điểm phần trăm. `null` khi một trong hai nhóm chưa đủ mẫu. */
  gapPoints: number | null;
  minSample: number;
  measurable: boolean;
  caveat: string;
  note: string;
};

const RONG = (label: string): CareArm => ({ label, cohort: 0, delivered: 0, returned: 0, pending: 0, rescueRate: null, recoveredCod: 0 });

export async function getCareEffectiveness(): Promise<CareEffectiveness> {
  return memo("care-effectiveness", 120_000, async () => {
    const db = await getDb();

    const [moc] = rowsOf<{ since: string | null }>(await db.execute(sql`select min(created_at) as since from care_actions`));
    const since = moc?.since ? new Date(moc.since) : null;
    if (!since) {
      return {
        since: null,
        cared: RONG("Có người chăm"),
        notCared: RONG("Không ai chăm"),
        gapPoints: null,
        minSample: CO_MAU_TOI_THIEU,
        measurable: false,
        caveat: "",
        note: "Chưa có lần ghi nhận chăm sóc nào. Bắt đầu ghi ở ngăn kéo tra nhanh của trang Vận đơn — CỐ Ý không dựng lại quá khứ: dữ liệu cũ không biết ai đã gọi, chia nhóm bằng phỏng đoán là bịa số.",
      };
    }

    /*
      COHORT: kiện có sự kiện GIAO HỤT kể từ mốc bắt đầu đo.

      Mốc lấy từ SỰ KIỆN, không từ `shipments.stage` hiện tại: một kiện giao hụt rồi giao lại thành
      công thì `stage` đã là DELIVERED — lọc theo `stage` sẽ vứt mất đúng nhóm CỨU ĐƯỢC, tức là chỉ
      còn lại thất bại và tỷ lệ cứu luôn bằng 0.

      Nhánh chăm sóc: có `care_actions` ghi SAU lần giao hụt đó. Chăm trước khi hụt không tính —
      không thể cứu một sự cố chưa xảy ra.
    */
    const rows = rowsOf<{ co_cham: boolean; outcome: string; n: number; cod: string | number }>(
      await db.execute(sql`
        with hut as (
          select s.id,
                 s.order_id,
                 min(e.occurred_at) as luc_hut
            from shipments s
            join shipment_events e on e.shipment_id = s.id and e.normalized_stage = 'DELIVERY_FAILED'
           where e.occurred_at >= ${since.toISOString()}::timestamptz
           group by s.id, s.order_id
        ),
        phan as (
          select h.id,
                 exists (select 1 from care_actions c where c.shipment_id = h.id and c.created_at >= h.luc_hut) as co_cham,
                 (select sh.stage::text from shipments sh where sh.id = h.id) as chang,
                 coalesce((select sh.cod_collected from shipments sh where sh.id = h.id), 0) as cod
            from hut h
        )
        select co_cham,
               case when chang = 'DELIVERED' then 'DELIVERED'
                    when chang in ('RETURNED','RETURNING') then 'RETURNED'
                    else 'PENDING' end as outcome,
               count(*)::int as n,
               sum(case when chang = 'DELIVERED' then cod else 0 end) as cod
          from phan
         group by 1, 2
      `),
    );

    const dung = (co: boolean, label: string): CareArm => {
      const cua = rows.filter((r) => Boolean(r.co_cham) === co);
      const lay = (o: string) => cua.filter((r) => r.outcome === o).reduce((a, r) => a + Number(r.n ?? 0), 0);
      const delivered = lay("DELIVERED");
      const returned = lay("RETURNED");
      const pending = lay("PENDING");
      const ngaNgu = delivered + returned;
      return {
        label,
        cohort: delivered + returned + pending,
        delivered,
        returned,
        pending,
        // Mẫu số là đơn ĐÃ NGÃ NGŨ. Đơn còn đang chạy chưa nói được gì — đưa vào mẫu số là đếm nó
        // như một lần cứu hụt trong khi nó còn chưa có kết quả.
        rescueRate: ngaNgu >= CO_MAU_TOI_THIEU ? delivered / ngaNgu : null,
        recoveredCod: cua.reduce((a, r) => a + Number(r.cod ?? 0), 0),
      };
    };

    const cared = dung(true, "Có người chăm");
    const notCared = dung(false, "Không ai chăm");
    const doDuoc = cared.rescueRate !== null && notCared.rescueRate !== null;

    return {
      since,
      cared,
      notCared,
      gapPoints: doDuoc ? (cared.rescueRate! - notCared.rescueRate!) * 100 : null,
      minSample: CO_MAU_TOI_THIEU,
      measurable: doDuoc,
      caveat:
        "QUAN SÁT, KHÔNG PHẢI NHÂN QUẢ: người CSKH chọn gọi ai, và thường chọn đơn to, khách quen, đơn còn cứu được. Chênh lệch dưới đây mang sẵn thiên lệch đó — dùng để theo dõi xu hướng, không dùng để kết luận 'gọi một cuộc cứu được X%'.",
      note: doDuoc
        ? `Đo từ ${since.toLocaleDateString("vi-VN")}.`
        : `Đo từ ${since.toLocaleDateString("vi-VN")}. Chưa nhóm nào đủ ${CO_MAU_TOI_THIEU} đơn đã ngã ngũ nên chưa tính tỷ lệ — số nhỏ sẽ nhảy loạn theo từng đơn, và người đọc sẽ tin vào một con số không đứng vững.`,
    };
  });
}
