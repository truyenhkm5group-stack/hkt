import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { PARCEL_CONDITIONS_WITHOUT_GOODS, type ReturnDisposition } from "@/lib/constants/return-disposition";
import { foldOf, loadEntries, loadSubjects } from "@/lib/queries/return-dispositions";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ KẾT CỤC HÀNG HOÀN THEO MẪU (Company OS · Agent E · cho trang 360) ═══════════
 *
 * `getModelReturnDispositions(productId)` — một chỗ đọc để trang 360 / cockpit không tự tính. KHÔNG
 * có công thức mới: đối tượng lấy từ `loadSubjects` (định nghĩa duy nhất), tình trạng từ
 * `foldDispositions` (hàm thuần), giá trị huỷ là ẢNH CHỤP ghi trên dòng sổ lúc huỷ.
 *
 * MỖI Ô LÀ `number | null`; `null` = CHƯA BIẾT (luật 42), không phải 0:
 *  · Mẫu có kiện hoàn KIỂM CẢ KIỆN (không dòng từng món) mà trong đơn có mẫu này ⇒ phần hàng không
 *    bán được của kiện ấy không chia được theo mẫu ⇒ các ô SỐ MÓN theo trạng thái / huỷ / trả xưởng là
 *    `null`, và `basis.parcelLevelSubjects` nói có bao nhiêu kiện như vậy. KHÔNG chia hộ.
 *  · Ô NHẬP LẠI SAU SỬA luôn chính xác: nó đọc thẳng dòng sổ mang phiếu tái nhập của đúng mẫu mã.
 *  · Giá trị huỷ: dòng huỷ nào CHƯA BIẾT giá vốn thì tổng là `null` (phần đã biết nằm ở
 *    `writeOffValueKnownPart`) — một tổng trộn phần chưa biết trông chính xác mà không phải.
 *  · Mẫu chưa có món hàng hoàn nào không tái nhập (và không kiện cả kiện nào) ⇒ 0 THẬT.
 *
 * Giá trị là ƯỚC TÍNH (`basis.value = "ESTIMATED"`) và KHÔNG nằm trong báo cáo lợi nhuận nào.
 */

export type ModelReturnDispositions = {
  productId: string;
  /** Đối tượng (món / dòng) còn phần chưa có kết cục cuối. */
  openSubjects: number | null;
  pendingQty: number | null;
  reworkQty: number | null;
  restockedAfterReworkQty: number;
  writtenOffQty: number | null;
  returnedToSupplierQty: number | null;
  writeOffValueEstimate: number | null;
  writeOffValueKnownPart: number;
  writeOffValueUnknownQty: number;
  /** Số dòng sổ theo kết cục — đếm dòng quyết định của mẫu này (theo mẫu mã của dòng sổ). */
  decisions: Record<ReturnDisposition, number>;
  basis: {
    value: "ESTIMATED";
    /** Kiện kiểm cả kiện, có hàng không bán được, trong đơn có mẫu này — không chia được theo mẫu. */
    parcelLevelSubjects: number;
    itemSubjects: number;
  };
};

export async function getModelReturnDispositions(productId: string): Promise<ModelReturnDispositions> {
  const db = await getDb();
  const [subjects, [parcel], quyetDinh] = await Promise.all([
    loadSubjects(db, sql`subj.grain = 'ITEM' and pv.product_id = ${productId}`),
    db
      .execute(sql`
        select count(*)::int as n
        from return_inspections i0
        where i0.status = 'INSPECTED' and i0.unsellable_qty > 0
          and coalesce(i0.condition, '') not in (${sql.join(PARCEL_CONDITIONS_WITHOUT_GOODS.map((c) => sql`${c}`), sql`, `)})
          and not exists (select 1 from return_inspection_items ii2 where ii2.inspection_id = i0.id)
          and exists (select 1 from order_items oi join product_variants pv on pv.id = oi.variant_id where oi.order_id = i0.order_id and pv.product_id = ${productId})
      `)
      .then((r) => rowsOf<{ n: number | string }>(r)),
    db
      .execute(sql`
        select rd.disposition, count(*)::int as n,
               coalesce(sum(rd.qty) filter (where rd.disposition = 'RESTOCK_AFTER_REWORK'), 0)::int as restocked
        from return_dispositions rd
        join product_variants pv on pv.id = rd.variant_id
        where pv.product_id = ${productId}
        group by rd.disposition
      `)
      .then((r) => rowsOf<{ disposition: string; n: number | string; restocked: number | string }>(r)),
  ]);

  const entries = await loadEntries(db, subjects.map((s) => s.subjectKey));
  let openSubjects = 0;
  let pendingQty = 0;
  let reworkQty = 0;
  let writtenOffQty = 0;
  let returnedToSupplierQty = 0;
  let known = 0;
  let unknownQty = 0;
  for (const s of subjects) {
    const h = entries.get(s.subjectKey) ?? [];
    const f = foldOf(s, h);
    if (f.remaining > 0) openSubjects += 1;
    if (f.state === "REWORK") reworkQty += f.remaining;
    else if (f.state === "PENDING_DECISION") pendingQty += f.remaining;
    writtenOffQty += f.writtenOff;
    returnedToSupplierQty += f.returnedToSupplier;
    for (const e of h) {
      if (e.disposition !== "WRITE_OFF") continue;
      if (e.valueEstimate === null) unknownQty += e.qty;
      else known += e.valueEstimate;
    }
  }

  const decisions: Record<ReturnDisposition, number> = { PENDING_DECISION: 0, REWORK: 0, RESTOCK_AFTER_REWORK: 0, WRITE_OFF: 0, RETURN_TO_SUPPLIER: 0 };
  let restockedAfterReworkQty = 0;
  for (const r of quyetDinh) {
    if (r.disposition in decisions) decisions[r.disposition as ReturnDisposition] = Number(r.n);
    restockedAfterReworkQty += Number(r.restocked ?? 0);
  }

  const parcelLevelSubjects = Number(parcel?.n ?? 0);
  const chuaChia = parcelLevelSubjects > 0;
  return {
    productId,
    openSubjects: chuaChia ? null : openSubjects,
    pendingQty: chuaChia ? null : pendingQty,
    reworkQty: chuaChia ? null : reworkQty,
    restockedAfterReworkQty,
    writtenOffQty: chuaChia ? null : writtenOffQty,
    returnedToSupplierQty: chuaChia ? null : returnedToSupplierQty,
    writeOffValueEstimate: chuaChia || unknownQty > 0 ? null : known,
    writeOffValueKnownPart: known,
    writeOffValueUnknownQty: unknownQty,
    decisions,
    basis: { value: "ESTIMATED", parcelLevelSubjects, itemSubjects: subjects.length },
  };
}
