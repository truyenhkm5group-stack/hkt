import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { memo } from "@/lib/cache";
import { pctOrNull } from "@/lib/format";
import {
  CONDITION_UNKNOWN,
  REPORTED_CONDITION_LABEL,
  coverageVerdict,
  type CoverageVerdict,
  type ReportedCondition,
} from "@/lib/constants/inspection-truth";
import { receiptUnitCost } from "@/lib/queries/cost-basis";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ SỰ THẬT VỀ KIỂM HÀNG HOÀN: ĐẾM CHỨNG CỨ, KHÔNG ĐẾM SUY DIỄN ═══════════
 *
 * Mọi con số ở đây trả lời đúng một câu: **có bao nhiêu món thực sự có người nhìn vào và ghi lại?**
 *
 * Đo trên production 14/09/2026 trước khi viết dòng nào:
 *
 *   747 món đã vào lại tồn qua phiếu kho
 *   132 món có dòng `return_inspection_items`   ← CÓ chứng cứ, và tất cả đều `OK`
 *   615 món chỉ có kết luận ở mức CẢ KIỆN        ← CHƯA BIẾT, không phải "tốt"
 *     0 món được kết luận là hỏng
 *
 * Con số cuối cùng là chỗ dễ đọc sai nhất: **0 hỏng trên 132 món ĐÃ XEM**, không phải 0 hỏng trên
 * 747 món. In "0% hỏng" là phát biểu về 615 món chưa ai mở ra — nên tỷ lệ hỏng ở đây là `null`
 * khi độ phủ chưa đủ, và ĐỘ PHỦ luôn đứng cạnh con số.
 *
 * ─── BA SUY DIỄN BỊ CẤM, VIẾT THÀNH SQL ───
 *
 * Không nhánh nào dưới đây đọc `stock_receipt_id`, `restock_qty` hay `condition` của CẢ KIỆN để
 * kết luận một MÓN là tốt. Chứng cứ duy nhất được chấp nhận là một dòng `return_inspection_items`.
 */

export type ConditionRow = {
  condition: ReportedCondition;
  label: string;
  items: number;
  /** Tỷ lệ trên số món CÓ CHỨNG CỨ. `null` khi chưa có món nào có chứng cứ. */
  share: number | null;
};

export type InspectionTruth = {
  parcels: {
    total: number;
    /** Kiện có ít nhất một dòng kết luận từng món. */
    withItemEvidence: number;
    /** Kiện đã lập phiếu tái nhập nhưng KHÔNG có dòng món nào — "đã đếm" theo đường một chạm cũ. */
    parcelLevelOnly: number;
    /** Kiện chưa có lượt đếm nào. */
    noEvidence: number;
  };
  items: {
    /** Món đã vào lại tồn qua phiếu kho. */
    restocked: number;
    /** Món có dòng kết luận riêng. */
    withEvidence: number;
    /** Món chưa ai kết luận riêng — CHƯA BIẾT. */
    unknown: number;
  };
  conditions: ConditionRow[];
  coverage: {
    /** Phần trăm món có chứng cứ. `null` khi chưa có món nào vào tồn. */
    pct: number | null;
    verdict: CoverageVerdict;
  };
  /** Món được kết luận là hỏng. `null` = CHƯA ĐỦ CĂN CỨ để nói — khác hẳn 0. */
  damagedItems: number | null;
  /** Tỷ lệ hỏng trên món CÓ CHỨNG CỨ. `null` khi chưa đủ căn cứ. */
  damagedRate: number | null;
  actor: {
    inspectedParcels: number;
    withInspectorKey: number;
    withReceiverKey: number;
    inspectorPct: number | null;
    receiverPct: number | null;
  };
  cost: {
    restockedQty: number;
    qtyWithCost: number;
    /** Giá trị hàng ĐÃ quay lại tồn, chỉ tính phần BIẾT giá vốn (đồng). */
    knownRecoveredValue: number;
    /** Số món không tra được giá vốn — giá trị của chúng KHÔNG được ước lượng. */
    unknownQty: number;
    coveragePct: number | null;
  };
};

type ParcelRow = { nhom: string; kien: string | number; co_nguoi_kiem: string | number; co_nguoi_nhan: string | number; da_dem: string | number };
type CondRow = { condition: string; items: string | number };
type CostRow = { mon: string | number; mon_co_gia: string | number; gia_tri: string | number };

const n = (v: unknown) => Number(v ?? 0);

export async function inspectionTruth(): Promise<InspectionTruth> {
  return memo("inspection-truth", 120_000, async () => {
    const db = await getDb();

    const [parcelRows, condRows, costRows] = await Promise.all([
      /*
        BA NHÓM KIỆN, XÉT THEO CHỨNG CỨ CÓ THẬT — không theo trạng thái tự khai.

        Thứ tự `case` quan trọng: hỏi "có dòng món không?" TRƯỚC, vì một kiện vừa có dòng món vừa
        có phiếu vẫn phải rơi vào nhóm mạnh nhất.
      */
      db.execute(sql`
        select case
                 when exists (select 1 from return_inspection_items ii where ii.inspection_id = i.id) then 'ITEM_CONFIRMED'
                 when i.stock_receipt_id is not null or i.status = 'INSPECTED' then 'PARCEL_LEVEL_ONLY'
                 else 'NO_EVIDENCE'
               end as nhom,
               count(*)::int as kien,
               count(*) filter (where i.inspected_by_user_id is not null)::int as co_nguoi_kiem,
               count(*) filter (where i.received_by_user_id is not null)::int as co_nguoi_nhan,
               count(*) filter (where i.status = 'INSPECTED')::int as da_dem
        from return_inspections i
        group by 1
      `),
      // Phân loại CHỈ đọc dòng món. Không dòng món ⇒ không có mặt ở đây ⇒ CHƯA BIẾT.
      db.execute(sql`
        select condition::text as condition, coalesce(sum(actual_qty), 0)::int as items
        from return_inspection_items
        group by 1
      `),
      /*
        GIÁ VỐN CỦA HÀNG ĐÃ QUAY LẠI TỒN.

        Đọc từ dòng phiếu `RETURN` (chứng từ làm đổi tồn thật), và giá vốn lấy từ phiếu NHẬP gần
        nhất của chính mẫu mã ấy. Món không tra được giá thì KHÔNG cộng vào tổng — nó được đếm
        riêng ở `unknownQty`, vì một tổng tiền trộn cả phần chưa biết là một tổng trông như chính
        xác mà không phải.
      */
      db.execute(sql`
        select coalesce(sum(ri.quantity), 0)::int as mon,
               coalesce(sum(ri.quantity) filter (where ${receiptUnitCost(sql`ri.variant_id`)} is not null), 0)::int as mon_co_gia,
               coalesce(sum(ri.quantity * ${receiptUnitCost(sql`ri.variant_id`)}) filter (where ${receiptUnitCost(sql`ri.variant_id`)} is not null), 0)::bigint as gia_tri
        from stock_receipt_items ri
        join stock_receipts r on r.id = ri.receipt_id
        where r.kind = 'RETURN'
      `),
    ]);

    const theoNhom = new Map(rowsOf<ParcelRow>(parcelRows).map((r) => [String(r.nhom), r]));
    const withItemEvidence = n(theoNhom.get("ITEM_CONFIRMED")?.kien);
    const parcelLevelOnly = n(theoNhom.get("PARCEL_LEVEL_ONLY")?.kien);
    const noEvidence = n(theoNhom.get("NO_EVIDENCE")?.kien);
    const totalParcels = withItemEvidence + parcelLevelOnly + noEvidence;

    const inspectedParcels = [...theoNhom.values()].reduce((a, r) => a + n(r.da_dem), 0);
    const withInspectorKey = [...theoNhom.values()].reduce((a, r) => a + n(r.co_nguoi_kiem), 0);
    const withReceiverKey = [...theoNhom.values()].reduce((a, r) => a + n(r.co_nguoi_nhan), 0);

    const cost = rowsOf<CostRow>(costRows)[0];
    const restocked = n(cost?.mon);
    const qtyWithCost = n(cost?.mon_co_gia);

    const demDieuKien = new Map(rowsOf<CondRow>(condRows).map((r) => [String(r.condition), n(r.items)]));
    const withEvidence = [...demDieuKien.values()].reduce((a, b) => a + b, 0);
    // CHƯA BIẾT = món đã vào tồn mà không có dòng kết luận nào. Không bao giờ âm.
    const unknown = Math.max(0, restocked - withEvidence);

    const verdict = coverageVerdict(withEvidence, restocked);

    const conditions: ConditionRow[] = [];
    for (const [k, v] of demDieuKien) {
      conditions.push({
        condition: k as ReportedCondition,
        label: REPORTED_CONDITION_LABEL[k as ReportedCondition] ?? k,
        items: v,
        share: pctOrNull(v, withEvidence),
      });
    }
    conditions.sort((a, b) => b.items - a.items);
    // CHƯA BIẾT luôn có mặt và luôn đứng CUỐI — nó không phải một kết luận, nó là phần chưa có.
    if (unknown > 0) {
      conditions.push({ condition: CONDITION_UNKNOWN, label: REPORTED_CONDITION_LABEL[CONDITION_UNKNOWN], items: unknown, share: null });
    }

    /*
      HỎNG: `null` KHI CHƯA ĐỦ CĂN CỨ.

      Không có dòng nào mang `DAMAGED` thì con số đúng là "chưa biết", không phải 0 — trừ khi độ
      phủ đã đủ để câu "không món nào hỏng" có nghĩa. Đây là khác biệt mà cả bản phát hành này tồn
      tại để giữ.
    */
    const damagedItems = verdict === "NONE" ? null : (demDieuKien.get("DAMAGED") ?? 0);

    return {
      parcels: { total: totalParcels, withItemEvidence, parcelLevelOnly, noEvidence },
      items: { restocked, withEvidence, unknown },
      conditions,
      coverage: { pct: pctOrNull(withEvidence, restocked), verdict },
      damagedItems,
      // Tỷ lệ chỉ có nghĩa khi độ phủ đủ. Dưới ngưỡng ⇒ `null` ⇒ màn hình in "—" kèm nhãn.
      damagedRate: verdict === "ENOUGH" ? pctOrNull(demDieuKien.get("DAMAGED") ?? 0, withEvidence) : null,
      actor: {
        inspectedParcels,
        withInspectorKey,
        withReceiverKey,
        inspectorPct: pctOrNull(withInspectorKey, inspectedParcels),
        receiverPct: pctOrNull(withReceiverKey, totalParcels),
      },
      cost: {
        restockedQty: restocked,
        qtyWithCost,
        knownRecoveredValue: n(cost?.gia_tri),
        unknownQty: Math.max(0, restocked - qtyWithCost),
        coveragePct: pctOrNull(qtyWithCost, restocked),
      },
    };
  });
}
