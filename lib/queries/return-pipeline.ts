import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { TEAM_LABEL, ageLabel, type CaseTeam } from "@/lib/constants/action-queue";
import { RETURN_PIPELINE, RETURN_STAGE_BY_KEY, type ReturnStageKey } from "@/lib/constants/return-pipeline";
import { CONDITION_LABEL, RETURN_CONDITIONS, type ReturnCondition } from "@/lib/constants/returns-condition";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ ĐO ĐƯỜNG ỐNG HÀNG HOÀN ═══════════
 *
 * Trả lời câu chưa ai trả lời được: **hàng hoàn đang nằm ở đâu, và giữ bao nhiêu vốn?**
 *
 * Trước đây chỉ có hai con số rời: một con số kiện chờ ở trạm kiểm đếm và 16 việc ở hàng đợi. Không
 * chỗ nào nói phần còn lại đang ở khâu nào, tồn bao lâu, hay giữ bao nhiêu tiền.
 *
 * Đo trên production 10/09/2026, lần đầu nhìn thấy toàn bộ dân số:
 *
 *   ĐVVC đã trả · kho chưa nhận   484 kiện   77.457.000đ   tuổi giữa 17,2 ngày · cũ nhất 35,4 ngày
 *   ĐVVC đang chở về              165 kiện   26.953.000đ   tuổi giữa  0,2 ngày
 *   ─────────────────────────────────────────────────────────────────────────────
 *   Chưa MỘT kiện nào được ghi nhận vào kho: bảng `return_inspections` trống hoàn toàn.
 *
 * 77 triệu vốn đang nằm ở chỗ shop mà sổ sách không biết, trung bình đã hai tuần rưỡi.
 *
 * ─── TIỀN: BA LOẠI, KHÔNG GỘP ───
 *
 *   `goodsCost`        SỰ THẬT   giá vốn hàng trong kiện, lấy từ `canonical_order_outcome`.
 *   `returnShipping`   SỰ THẬT   cước chiều hoàn đã phát sinh, từ đơn.
 *   `capitalReleased`  SỐ THẬT   vốn ĐÃ vào lại tồn qua phiếu tái nhập — đã xảy ra, không phải ước.
 *
 * KHÔNG có "tiền có thể thu hồi" tính theo GIÁ BÁN. Hàng hoàn quay về kho là lấy lại VỐN, không
 * phải lấy lại doanh thu — doanh thu của đơn đó đã mất từ lúc khách không nhận. Gọi giá bán của
 * toàn bộ hàng hoàn là "tiền có thể thu hồi" sẽ thổi con số lên nhiều lần.
 *
 * ─── GRAIN: KIỆN, KHÔNG PHẢI ĐƠN ───
 *
 * Đường ống này đếm KIỆN HÀNG — thứ người kho cầm trên tay. Một đơn gửi lại hai lần rồi hoàn cả hai
 * là hai kiện phải đếm, không phải một. Nhưng giá vốn thì thuộc về ĐƠN, nên hàm trả về cả `parcels`
 * lẫn `orders`: hai số bằng nhau thì tiền cộng đúng; lệch nhau thì phần chênh hiện ra để thấy, chứ
 * không giấu trong một con số duy nhất.
 */

export type ReturnStageHealth = {
  key: ReturnStageKey;
  label: string;
  order: number;
  team: CaseTeam;
  teamLabel: string;
  actionable: boolean;
  parcels: number;
  orders: number;
  /** Giá vốn hàng đang nằm ở khâu này (đồng). SỰ THẬT. */
  goodsCost: number;
  /** Cước chiều hoàn đã phát sinh của các đơn ở khâu này (đồng). `null` = CHƯA ĐO ĐƯỢC. */
  returnShipping: number | null;
  medianAgeHours: number;
  p90AgeHours: number;
  oldestHours: number;
  oldestLabel: string;
  /** Kiện đã quá hạn của khâu. Khâu không đặt hạn thì luôn 0. */
  slaBreach: number;
  /** Bao nhiêu kiện thật sự cần người làm. Khâu chỉ-đo thì bằng 0. */
  actionableCount: number;
  moneyMeaning: string;
  href: string;
};

export type ReturnConditionRow = {
  condition: ReturnCondition;
  label: string;
  parcels: number;
  restockQty: number;
  unsellableQty: number;
  goodsCost: number;
};

export type ReturnPipeline = {
  stages: ReturnStageHealth[];
  /** Chia theo kết luận sau khi đếm — chỉ áp cho kiện ĐÃ đếm. */
  conditions: ReturnConditionRow[];
  totalParcels: number;
  /** Vốn đang KẸT trong đường ống: mọi khâu chưa vào lại tồn và chưa kết luận mất. */
  capitalLocked: number;
  /** Vốn ĐÃ giải phóng qua phiếu tái nhập. Số thật, đã xảy ra. */
  capitalReleased: number;
  /** Vốn mất hẳn: đếm xong và kết luận không bán lại được. */
  capitalWrittenOff: number;
  /**
   * Cước chiều hoàn của toàn bộ kiện trong đường ống. `null` = CHƯA ĐO ĐƯỢC.
   *
   * Đo trên production 10/09/2026: `orders.return_fee > 0` ở **0/2.509 đơn**. Nguồn chưa có dữ
   * liệu, nên hiện 0đ sẽ đọc thành "hoàn hàng không tốn cước" — sai, và sai theo hướng dễ chịu.
   * Cước chiều đi thì có (1.945/1.976 vận đơn), nên đây là lỗ hổng của riêng chiều hoàn.
   */
  returnShipping: number | null;
  /** Có đơn nào trong đường ống ghi được cước hoàn hay không. */
  returnShippingKnown: boolean;
  measuredAt: Date;
};

/**
 * KHÂU CỦA MỘT KIỆN, viết một lần bằng SQL.
 *
 * Thứ tự `case` quan trọng: xét từ trạng thái MUỘN nhất về sớm nhất, để một kiện đã đếm xong không
 * bị xếp nhầm về khâu "chờ đếm" chỉ vì mốc cũ vẫn còn đó.
 */
const KHAU = sql`case
  when ins.stock_receipt_id is not null then 'RESTOCKED'
  when ins.status = 'INSPECTED' and ins.condition = 'RESTOCKABLE' then 'INSPECTED'
  when ins.status = 'INSPECTED' then 'WRITTEN_OFF'
  when ins.id is not null then 'INSPECTION_PENDING'
  when s.return_received_at is not null then 'INSPECTION_PENDING'
  when s.stage = 'RETURNED' then 'CARRIER_RETURN_DELIVERED'
  else 'RETURNING_TO_SENDER'
end`;

/**
 * MỐC BẮT ĐẦU NẰM Ở KHÂU HIỆN TẠI — dùng để tính tuổi.
 *
 * Cố ý KHÔNG dùng ngày tạo vận đơn: một kiện hoàn của đơn ba tháng trước mà kho vừa nhận hôm qua
 * thì tuổi ở khâu này là MỘT NGÀY, không phải ba tháng. Đo sai chỗ này sẽ báo trễ hạn giả hàng loạt.
 */
const MOC_VAO_KHAU = sql`coalesce(
  case
    when ins.status = 'INSPECTED' then ins.inspected_at
    when ins.id is not null then ins.received_at
    when s.return_received_at is not null then s.return_received_at
    else s.returned_at
  end,
  s.updated_at
)`;

type Row = {
  khau: ReturnStageKey;
  parcels: number;
  orders: number;
  goods_cost: string | number;
  return_shipping: string | number;
  co_cuoc: number;
  median_h: string | number | null;
  p90_h: string | number | null;
  oldest_h: string | number | null;
};

export async function getReturnPipeline(): Promise<ReturnPipeline> {
  return memo("return-pipeline", 120_000, async () => {
    const db = await getDb();

    const rows = rowsOf<Row>(
      await db.execute(sql`
        with kien as (
          select s.id as shipment_id,
                 s.order_id,
                 ${KHAU} as khau,
                 extract(epoch from (now() - ${MOC_VAO_KHAU})) / 3600 as tuoi_gio,
                 -- Giá vốn của ĐƠN, lấy một giá trị duy nhất: bảng kết quả đơn có grain
                 -- (đơn × vận đơn) nên nối thẳng sẽ nhân giá vốn lên đúng bằng số lần gửi.
                 coalesce((select max(coalesce(m.recognized_cogs, m.cogs, 0))
                             from canonical_order_outcome m where m.order_id = s.order_id), 0) as goods_cost,
                 coalesce(o.return_fee, 0) as return_shipping
            from shipments s
            left join orders o on o.id = s.order_id
            left join return_inspections ins on ins.shipment_id = s.id
           where s.order_id is not null
             and (s.stage in ('RETURNING', 'RETURNED') or ins.id is not null)
        )
        select khau,
               count(*)::int as parcels,
               count(distinct order_id)::int as orders,
               coalesce(sum(goods_cost), 0) as goods_cost,
               coalesce(sum(return_shipping), 0) as return_shipping,
               count(*) filter (where return_shipping > 0)::int as co_cuoc,
               percentile_cont(0.5) within group (order by tuoi_gio) as median_h,
               percentile_cont(0.9) within group (order by tuoi_gio) as p90_h,
               max(tuoi_gio) as oldest_h
          from kien
         group by khau
      `),
    );

    // Trễ hạn đếm riêng: ngưỡng của mỗi khâu khác nhau nên không gộp được vào câu trên bằng một
    // điều kiện duy nhất. Dựng biểu thức từ chính hằng số, không gõ lại số giờ.
    const nguong = RETURN_PIPELINE.filter((s) => s.slaHours !== null).map((s) => sql`when ${s.key} then ${s.slaHours}`);
    const treRows = nguong.length
      ? rowsOf<{ khau: ReturnStageKey; n: number }>(
          await db.execute(sql`
            with kien as (
              select ${KHAU} as khau,
                     extract(epoch from (now() - ${MOC_VAO_KHAU})) / 3600 as tuoi_gio
                from shipments s
                left join return_inspections ins on ins.shipment_id = s.id
               where s.order_id is not null
                 and (s.stage in ('RETURNING', 'RETURNED') or ins.id is not null)
            )
            select khau, count(*)::int as n
              from kien
             -- Ép kiểu tường minh: tham số rời không mang kiểu, nên Postgres suy nhánh case ra text
             -- rồi so sánh numeric với text và báo lỗi. Loại lỗi chỉ lộ ra khi chạy thật.
             where tuoi_gio > (case khau ${nguong.reduce((a, b) => sql`${a} ${b}`)} else null end)::numeric
             group by khau
          `),
        )
      : [];
    const treTheoKhau = new Map(treRows.map((r) => [r.khau, Number(r.n ?? 0)]));

    const dieuKien = rowsOf<{ condition: ReturnCondition; parcels: number; restock_qty: number; unsellable_qty: number; goods_cost: string | number }>(
      await db.execute(sql`
        select ins.condition,
               count(*)::int as parcels,
               coalesce(sum(ins.restock_qty), 0)::int as restock_qty,
               coalesce(sum(ins.unsellable_qty), 0)::int as unsellable_qty,
               coalesce(sum((select max(coalesce(m.recognized_cogs, m.cogs, 0))
                               from canonical_order_outcome m where m.order_id = ins.order_id)), 0) as goods_cost
          from return_inspections ins
         where ins.status = 'INSPECTED' and ins.condition is not null
         group by ins.condition
      `),
    );

    const theoKhau = new Map(rows.map((r) => [r.khau, r]));
    const stages: ReturnStageHealth[] = RETURN_PIPELINE.map((spec) => {
      const r = theoKhau.get(spec.key);
      const oldest = Number(r?.oldest_h ?? 0);
      const parcels = Number(r?.parcels ?? 0);
      const tre = treTheoKhau.get(spec.key) ?? 0;
      return {
        key: spec.key,
        label: spec.label,
        order: spec.order,
        team: spec.team,
        teamLabel: TEAM_LABEL[spec.team],
        actionable: spec.actionable,
        parcels,
        orders: Number(r?.orders ?? 0),
        goodsCost: Number(r?.goods_cost ?? 0),
        // 0đ ở đây nghĩa là CHƯA CÓ NGUỒN, không phải "không tốn cước" — xem ghi chú ở `returnShipping`.
        returnShipping: Number(r?.co_cuoc ?? 0) > 0 ? Number(r?.return_shipping ?? 0) : null,
        medianAgeHours: Number(r?.median_h ?? 0),
        p90AgeHours: Number(r?.p90_h ?? 0),
        oldestHours: oldest,
        oldestLabel: parcels ? ageLabel(oldest) : "—",
        slaBreach: spec.slaHours === null ? 0 : tre,
        // Khâu chỉ-đo không sinh việc: hàng đang trên xe thì không ai làm gì được.
        actionableCount: spec.actionable ? parcels : 0,
        moneyMeaning: spec.moneyMeaning,
        href: spec.href,
      };
    });

    const theoDK = new Map(dieuKien.map((r) => [r.condition, r]));
    const conditions: ReturnConditionRow[] = RETURN_CONDITIONS.map((c) => {
      const r = theoDK.get(c);
      return {
        condition: c,
        label: CONDITION_LABEL[c],
        parcels: Number(r?.parcels ?? 0),
        restockQty: Number(r?.restock_qty ?? 0),
        unsellableQty: Number(r?.unsellable_qty ?? 0),
        goodsCost: Number(r?.goods_cost ?? 0),
      };
    });

    const coCuoc = rows.some((r) => Number(r.co_cuoc ?? 0) > 0);
    const lay = (k: ReturnStageKey) => stages.find((s) => s.key === k);
    // Vốn KẸT = mọi khâu chưa kết thúc. Khâu "đã vào tồn" và "mất hẳn" đã xong, không kẹt nữa.
    const capitalLocked = stages.filter((s) => s.key !== "RESTOCKED" && s.key !== "WRITTEN_OFF").reduce((t, s) => t + s.goodsCost, 0);

    return {
      stages,
      conditions,
      totalParcels: stages.reduce((t, s) => t + s.parcels, 0),
      capitalLocked,
      capitalReleased: lay("RESTOCKED")?.goodsCost ?? 0,
      capitalWrittenOff: lay("WRITTEN_OFF")?.goodsCost ?? 0,
      returnShipping: coCuoc ? stages.reduce((t, s) => t + (s.returnShipping ?? 0), 0) : null,
      returnShippingKnown: coCuoc,
      measuredAt: new Date(),
    };
  });
}

/** Khâu nào đang giữ nhiều vốn nhất trong nhóm CÓ việc để làm. */
export function worstReturnStage(p: ReturnPipeline): ReturnStageHealth | null {
  return (
    p.stages
      .filter((s) => s.actionable && s.parcels > 0)
      .slice()
      .sort((a, b) => b.goodsCost - a.goodsCost || b.parcels - a.parcels)[0] ?? null
  );
}

export { RETURN_STAGE_BY_KEY };
