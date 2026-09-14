import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { Actor } from "@/lib/constants/actor";
import type { ReturnCondition } from "@/lib/constants/returns-condition";
import { INSPECT_AGE_DAYS, ITEM_CONDITION_LABEL, ITEM_CONDITION_NEEDS_NOTE, ITEM_CONDITION_RESTOCKS, isItemCondition, itemHasDiscrepancy, type ItemCondition } from "@/lib/constants/return-lifecycle";
import { IS_RETURN_AWAITING_WAREHOUSE } from "@/lib/queries/return-rate";
import { returnProductContext, type ItemsBasis, type OrderLinkBasis, type ReturnProductContext } from "@/lib/returns/product-context";
import type { StationRow } from "@/lib/returns/inspection-filter";

/**
 * ───────────── VÒNG ĐỜI KIỂM HÀNG HOÀN ─────────────
 *
 *   ĐVVC báo hoàn  →  ĐÃ VỀ KHO  →  CHỜ ĐẾM  →  ĐÃ KIỂM  →  {bán lại được · không bán được}
 *                                                                 ↓
 *                                                    phiếu tái nhập CHỈ phần đếm được
 *
 * VÌ SAO KHÔNG GỘP "ĐÃ VỀ" VỚI "VÀO TỒN": một kiện hàng quay về có thể thiếu món, rách, bẩn, hoặc
 * khách đã bóc ra dùng. Cộng nguyên số đã xuất trở lại tồn là ghi vào sổ một lượng hàng không có
 * thật — và phần chênh nằm im trong số tồn, không ai tìm ra được, cho tới lúc kiểm kê cuối kỳ.
 * Kế hoạch sản xuất trong suốt thời gian đó đặt thiếu đúng bằng phần chênh ấy.
 *
 * Nên ERP tách hai mốc: ghi nhận kiện ĐÃ VỀ là việc của người nhận hàng (nhanh, hàng loạt);
 * quyết định hàng nào VÀO TỒN là việc của người ĐẾM (từng kiện, có số, có lý do khi thiếu).
 *
 * Đo trên production 09/09/2026: 445 kiện đang chờ, 497 món, chưa kiện nào được đếm.
 */

const ins = schema.returnInspections;
const s = schema.shipments;
/** Nơi ghi phiếu: CSDL thường hoặc giao dịch đang mở — phiếu tái nhập phải nằm CÙNG giao dịch với việc lật trạng thái kiện. */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];


/**
 * GHI NHẬN KIỆN ĐÃ VỀ TỚI KHO. Chưa đếm, chưa vào tồn.
 *
 * Idempotent: `shipment_id` là khoá duy nhất nên bấm lại lần hai không tạo thêm phiếu và không đè
 * mốc/người nhận của lần đầu. Trả về đúng số kiện được ghi nhận MỚI trong lần gọi này.
 */
export async function markReturnsArrived(ids: string[], actor: Actor, note?: string) {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, ids: [] as string[] };
  const db = await getDb();
  const shipments = await db.select({ id: s.id, orderId: s.orderId }).from(s).where(inArray(s.id, unique));
  if (!shipments.length) return { count: 0, ids: [] as string[] };

  const now = new Date();
  const rows = await db
    .insert(ins)
    .values(
      shipments.map((sh) => ({
        shipmentId: sh.id,
        orderId: sh.orderId,
        status: "RECEIVED" as const,
        receivedAt: now,
        receivedBy: actor.label,
        receivedByUserId: actor.id,
        note: note?.trim() ?? "",
      })),
    )
    .onConflictDoNothing({ target: ins.shipmentId })
    .returning({ id: ins.shipmentId });
  return { count: rows.length, ids: rows.map((r) => r.id) };
}

/**
 * Huỷ ghi nhận đã về (bấm nhầm kiện). CHỈ được huỷ khi kiện CHƯA đếm: đã đếm rồi thì đã có phiếu
 * tái nhập và tồn đã đổi — muốn sửa phải lập phiếu điều chỉnh kho, để lại dấu vết, không xoá ngược.
 */
export async function undoReturnArrived(ids: string[]): Promise<{ count: number; blocked: number }> {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, blocked: 0 };
  const db = await getDb();
  const rows = await db.select({ shipmentId: ins.shipmentId, status: ins.status }).from(ins).where(inArray(ins.shipmentId, unique));
  const removable = rows.filter((r) => r.status === "RECEIVED").map((r) => r.shipmentId);
  const blocked = rows.length - removable.length;
  if (removable.length) await db.delete(ins).where(and(inArray(ins.shipmentId, removable), eq(ins.status, "RECEIVED")));
  return { count: removable.length, blocked };
}

export type InspectionInput = {
  shipmentId: string;
  condition: ReturnCondition;
  /** Số món ĐẾM ĐƯỢC và còn bán lại được. Chỉ số này được cộng vào tồn. */
  restockQty: number;
  /** Số món về nhưng không bán lại được (rách, bẩn, thiếu phụ kiện). */
  unsellableQty: number;
  note: string;
  actor: Actor;
};

export type InspectionResult = { ok: true; restocked: number; receiptId: string | null } | { error: string };

/**
 * ĐƯỜNG ĐẾM NHANH CẢ KIỆN CHỈ ĐƯỢC CỘNG TỒN KHI KIỆN CÓ ĐÚNG MỘT MẪU MÃ.
 *
 * Trước đây kiện nhiều mẫu mã được "phân bổ theo tỷ lệ dòng hàng của đơn" — tức là ERP đoán món nào
 * quay về, làm tròn, rồi ghi vào sổ như thể đã đếm. Kiện 2 áo đỏ + 1 áo đen, kho đếm được 2, sổ ghi
 * 1 đỏ + 1 đen (hoặc 2 đỏ tuỳ cách làm tròn) — không ai biết cái nào đúng, và tồn của MỖI mẫu mã sai
 * theo hai chiều ngược nhau cho tới kỳ kiểm kê.
 *
 * Trả về mẫu mã duy nhất, hoặc LÝ DO không cộng được — lý do đó hiện thẳng cho người đếm để họ
 * chuyển sang đếm từng món, chứ không phải một số 0 lặng lẽ.
 */
export function singleVariantForParcel(ctx: ReturnProductContext | undefined): { variantId: string } | { error: string } {
  if (!ctx || ctx.basis === "UNRESOLVED") {
    return { error: "Kiện này chưa ghép được đơn nên không biết cộng vào mẫu mã nào. Ghi kết luận không vào tồn kèm mã hàng ở ô lý do, hoặc lập phiếu tái nhập tay ở trang Nhập kho có ghi mã vận đơn." };
  }
  if (ctx.basis === "AMBIGUOUS") {
    return { error: `Mã gốc ${ctx.viaBaseCode ?? ""} lần ra ${ctx.candidateOrderIds.length} đơn khác nhau — ERP không chọn hộ. CS gắn đúng đơn trước, hoặc lập phiếu tái nhập tay có ghi mã vận đơn.` };
  }
  const variants = new Set(ctx.items.map((it) => it.variantId).filter((v): v is string => Boolean(v)));
  const unmapped = ctx.items.filter((it) => !it.variantId);
  if (!variants.size) return { error: "Không dòng hàng nào của đơn khớp được với danh mục mẫu mã ERP — đồng bộ sản phẩm từ Pancake rồi đếm lại." };
  if (variants.size > 1 || unmapped.length) {
    const coTang = ctx.items.some((it) => it.isBonus);
    return {
      error: `Kiện có ${variants.size + unmapped.length} mẫu mã${coTang ? " (kể cả hàng tặng)" : ""} — một con số tổng không nói được món nào về. Bấm “Kiểm từng món” để đếm theo mẫu mã.`,
    };
  }
  return { variantId: [...variants][0] };
}

/**
 * KHO ĐẾM XONG MỘT KIỆN. Đây là nơi DUY NHẤT hàng hoàn được cộng lại tồn, và chỉ đúng phần đếm được.
 *
 * Không đếm lại lần hai: đã kiểm rồi mà cho kiểm tiếp thì phiếu tái nhập cộng tồn hai lần. Muốn sửa
 * số thì lập phiếu điều chỉnh kho — có người ký, có lý do, và nhìn thấy được trên sổ.
 *
 * Bối cảnh sản phẩm được ghép LẠI ngay tại đây bằng định danh (`product-context.ts`), không tin cột
 * `return_inspections.order_id`: cột đó NULL cho mọi vận đơn chiều về (luật 7), và trước đây điều đó
 * làm phiếu ghi "bán lại được, 0 món" mà không ai hay.
 */
export async function recordInspection(input: InspectionInput): Promise<InspectionResult> {
  const ctx = (await returnProductContext([input.shipmentId])).get(input.shipmentId);
  return recordInspectionWithContext(input, ctx);
}

async function recordInspectionWithContext(input: InspectionInput, ctx: ReturnProductContext | undefined): Promise<InspectionResult> {
  const db = await getDb();
  const [row] = await db.select().from(ins).where(eq(ins.shipmentId, input.shipmentId));
  if (!row) return { error: "Kiện này chưa được ghi nhận đã về kho" };
  if (row.status === "INSPECTED") return { error: "Kiện này đã đếm rồi — muốn sửa số thì lập phiếu điều chỉnh kho" };

  const restock = Math.max(0, Math.trunc(input.restockQty));
  const unsellable = Math.max(0, Math.trunc(input.unsellableQty));
  const note = input.note.trim();
  if (input.condition === "RESTOCKABLE" && restock <= 0) return { error: "Kết luận bán lại được thì phải đếm được ít nhất một món" };
  if (input.condition !== "RESTOCKABLE" && !note) return { error: "Kết luận không bán được thì phải ghi rõ vì sao" };

  // CỘNG TỒN thì phải biết cộng vào MẪU MÃ NÀO — và chỉ một mẫu mã. Mọi trường hợp khác trả lý do,
  // không bao giờ phân bổ, không bao giờ ghi 0 lặng lẽ.
  let restockVariantId: string | null = null;
  if (restock > 0) {
    const one = singleVariantForParcel(ctx);
    if ("error" in one) return { error: one.error };
    if (ctx && ctx.expectedQty !== null && restock > ctx.expectedQty) {
      return { error: `Đếm được ${restock} món nhưng đơn chỉ có ${ctx.expectedQty} — nhiều hơn kỳ vọng thì bấm “Kiểm từng món” và ghi rõ lý do.` };
    }
    restockVariantId = one.variantId;
  }

  // MỘT GIAO DỊCH, CÓ KHOÁ — giống hệt đường đếm theo món. Hai người (hoặc một người bấm đúp) cùng
  // kết luận một kiện: người sau phải chờ khoá, thấy INSPECTED và dừng; phiếu kho của lượt sau bị huỷ
  // cùng giao dịch nên tồn không cộng hai lần.
  let receiptId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ status: ins.status }).from(ins).where(eq(ins.id, row.id)).for("update");
      if (!locked || locked.status === "INSPECTED") throw new Error("DA_DEM_ROI");

      // CHỈ phần bán lại được mới sinh phiếu tái nhập — phiếu là nơi duy nhất tồn kho thay đổi.
      receiptId = restockVariantId ? await createRestockReceipt(tx, restockVariantId, input.shipmentId, restock, note, input.actor) : null;

      const flipped = await tx
        .update(ins)
        .set({
          status: "INSPECTED",
          // Vận đơn chiều về ghi nhận với `order_id` NULL: điền đơn vừa lần ra để lịch sử tra được theo đơn.
          orderId: row.orderId ?? ctx?.orderId ?? null,
          condition: input.condition,
          restockQty: receiptId ? restock : 0,
          unsellableQty: unsellable,
          note,
          inspectedAt: new Date(),
          inspectedBy: input.actor.label,
          inspectedByUserId: input.actor.id,
          stockReceiptId: receiptId,
          updatedAt: new Date(),
        })
        .where(and(eq(ins.id, row.id), eq(ins.status, "RECEIVED")))
        .returning({ id: ins.id });
      if (!flipped.length) throw new Error("DA_DEM_ROI");

      // Đóng kiện trên vận đơn: từ đây nó thôi nằm trong "hàng hoàn chờ xử lý", và phần đếm thiếu so với
      // số đã xuất hiện ra thành HÀNG HỤT trên sổ kho thay vì biến mất.
      await closeReturnedShipment(tx, input.shipmentId, ctx, input.actor, note);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "DA_DEM_ROI") return { error: "Kiện này vừa được người khác đếm — không ghi lại lần hai" };
    throw e;
  }

  return { ok: true, restocked: receiptId ? restock : 0, receiptId };
}

/**
 * Đóng kiện trên vận đơn — và trên CẢ vận đơn chiều đi khi kiện được đếm qua vận đơn chiều về.
 *
 * Vận đơn chiều về (mã gốc + 1P1) là một dòng `shipments` riêng (luật 7). Đếm xong mà chỉ đóng dòng
 * ấy thì vận đơn chiều đi cùng mã gốc vẫn `return_received_at` NULL: sổ kho vẫn coi hàng "chưa về",
 * và bàn nhận có thể hiện lại đúng kiện vừa đếm dưới mã gốc — kho đếm lần hai, tồn cộng lần hai.
 */
async function closeReturnedShipment(tx: DbLike, shipmentId: string, ctx: ReturnProductContext | undefined, actor: Actor, note: string) {
  const now = new Date();
  const stamp = { returnReceivedAt: now, returnReceivedBy: actor.label, returnReceivedNote: note || null, updatedAt: now };
  await tx.update(s).set(stamp).where(and(eq(s.id, shipmentId), isNull(s.returnReceivedAt)));
  if (ctx?.basis === "RETURN_LEG" && ctx.orderId && ctx.viaBaseCode) {
    const base = ctx.viaBaseCode.toUpperCase();
    await tx
      .update(s)
      .set(stamp)
      .where(and(eq(s.orderId, ctx.orderId), isNull(s.returnReceivedAt), or(eq(sql`upper(${s.vtpOrderNumber})`, base), eq(sql`upper(${s.trackingCode})`, base))));
  }
}

/**
 * Phiếu TÁI NHẬP cho đúng số đếm được, vào ĐÚNG MỘT mẫu mã. Không có phân bổ: kiện nhiều mẫu mã đi
 * đường đếm từng món (`recordItemInspection`), nơi mỗi dòng phiếu là một con số người kho đã đếm.
 */
async function createRestockReceipt(db: DbLike, variantId: string, shipmentId: string, restock: number, note: string, actor: Actor): Promise<string> {
  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({
      kind: "RETURN",
      receivedAt: new Date(),
      reference: `Đếm hàng hoàn ${shipmentId}`,
      note,
      totalQuantity: restock,
      totalCost: 0,
      createdBy: actor.label,
    })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId, quantity: restock, unitCost: 0, shipmentId });
  return receipt.id;
}

/** `variantId` là thứ DUY NHẤT nối được dòng hàng với sổ kho — thiếu nó thì món đếm được không
 *  biết cộng vào mẫu mã nào, nên nó phải đi cùng mọi dòng hàng ngay từ truy vấn. */
export type InspectionItem = { variantId: string | null; sku: string; name: string; color: string; size: string; quantity: number };

export type PendingInspection = {
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  customerName: string;
  customerPhone: string;
  receivedAt: Date;
  /**
   * Lúc ĐVVC trả kiện về shop. `null` = chưa có chứng từ — KHÔNG lùi về `receivedAt`.
   *
   * Hai mốc trả lời hai câu khác nhau và không suy ra nhau: `receivedAt` là lúc ERP biết, mốc này
   * là lúc kiện thật sự quay về. Một lượt đối soát sổ giấy ghi nhận cả trăm kiện trong một giây,
   * nên `receivedAt` của chúng gần như bằng nhau — chỉ mốc ĐVVC mới sắp được chúng theo thời gian.
   */
  returnedAt: Date | null;
  receivedBy: string;
  /** Số món KỲ VỌNG quay về. `null` = CHƯA BIẾT (không ghép được đơn) — không phải 0. */
  expectedQty: number | null;
  /** Căn cứ của danh sách món: có phiếu trả từng dòng, hay chỉ suy từ cả đơn, hay không có gì. */
  itemsBasis: ItemsBasis;
  /** Kiện ghép với đơn bằng cách nào — AMBIGUOUS/UNRESOLVED là "chưa ghép được", không phải "đơn trống". */
  linkBasis: OrderLinkBasis;
  ageDays: number;
  /**
   * Từng dòng hàng của đơn: mã, tên, màu, size, số lượng.
   *
   * Lấy sẵn ở đây thay vì để màn hình tự tra: người đếm cầm kiện hàng trên tay cần biết NGAY phải
   * thấy gì trong đó. Bắt họ mở đơn ở tab khác để đọc màu/size là biến việc 10 giây thành việc 40
   * giây — nhân với 453 kiện thì đó là hơn một ngày công.
   */
  items: InspectionItem[];
};

/** Gộp dòng hàng của đơn thành JSON ngay trong SQL — một truy vấn, không N+1. */
const ITEMS_JSON = sql<string>`coalesce((
  select json_agg(json_build_object(
    'variantId', oi.variant_id,
    'sku', coalesce(nullif(oi.sku, ''), ''),
    'name', coalesce(oi.product_name, ''),
    'color', coalesce(pv.color, ''),
    'size', coalesce(pv.size, ''),
    'quantity', oi.quantity
  ) order by oi.product_name)
  from order_items oi
  left join product_variants pv on pv.id = oi.variant_id
  where oi.order_id = ${ins.orderId}
), '[]')`;

function parseItems(raw: unknown): InspectionItem[] {
  if (!raw) return [];
  const list = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    const r = x as Record<string, unknown>;
    return {
      variantId: r.variantId ? String(r.variantId) : null,
      sku: String(r.sku ?? ""),
      name: String(r.name ?? ""),
      color: String(r.color ?? ""),
      size: String(r.size ?? ""),
      quantity: Number(r.quantity ?? 0),
    };
  });
}

/** Kiện ĐÃ VỀ nhưng CHƯA ĐẾM — việc của kho, và là phần hàng có thật mà sổ đang chưa biết. */
export async function listPendingInspections(limit = 100): Promise<PendingInspection[]> {
  const db = await getDb();
  const rows = await db
    .select({
      shipmentId: ins.shipmentId,
      code: s.vtpOrderNumber,
      tracking: s.trackingCode,
      orderId: ins.orderId,
      orderCode: sql<string | null>`(select coalesce(nullif(o2.custom_id, ''), o2.system_id::text) from orders o2 where o2.id = ${ins.orderId})`,
      customerName: sql<string>`coalesce((select coalesce(nullif(o2.bill_full_name, ''), nullif(o2.ship_full_name, ''), '') from orders o2 where o2.id = ${ins.orderId}), '')`,
      customerPhone: sql<string>`coalesce((select coalesce(nullif(o2.bill_phone, ''), nullif(o2.ship_phone, ''), '') from orders o2 where o2.id = ${ins.orderId}), '')`,
      receivedAt: ins.receivedAt,
      returnedAt: s.returnedAt,
      receivedBy: ins.receivedBy,
      expectedQty: sql<number>`coalesce((select sum(oi.quantity) from order_items oi where oi.order_id = ${ins.orderId}), 0)`,
      items: ITEMS_JSON,
    })
    .from(ins)
    .leftJoin(s, eq(s.id, ins.shipmentId))
    .where(eq(ins.status, "RECEIVED"))
    .orderBy(asc(ins.receivedAt))
    .limit(limit);

  /*
    VÁ CHO VẬN ĐƠN CHIỀU VỀ (mã gốc + 1P1).

    Theo quy ước của kho mã, vận đơn chiều về là một dòng `shipments` RIÊNG với `order_id` NULL —
    nên `return_inspections.order_id` chép lại cũng NULL, và mọi truy vấn con ở trên trả rỗng:
    người đếm nhìn thấy đúng một mã vận đơn trần trụi, không biết trong kiện lẽ ra có gì.

    Ghép lại bằng ĐỊNH DANH qua `product-context` (mã gốc → vận đơn chiều đi → đơn), CHỈ cho những
    dòng đang trống, và gộp một lượt cho cả loạt chứ không mỗi dòng một truy vấn.
  */
  // Ghép bối cảnh cho MỌI dòng (không chỉ dòng thiếu đơn): `product-context` là nơi duy nhất biết
  // món nào THỰC SỰ bị trả (`return_quantity`) và căn cứ của danh sách — đường đếm phải thấy đúng
  // cái mà bàn nhận đã thấy, không được tự suy từ cả đơn rồi mặc định "đủ".
  const boSung = await returnProductContext(rows.map((r) => r.shipmentId));

  const now = Date.now();
  return rows.map((r) => {
    const them = boSung.get(r.shipmentId);
    const goc = parseItems(r.items);
    const items = them && them.items.length ? them.items.map((i) => ({ variantId: i.variantId, sku: i.sku, name: i.name, color: i.color, size: i.size, quantity: i.quantity })) : goc;
    const itemsBasis: ItemsBasis = them && them.itemsBasis !== "NONE" ? them.itemsBasis : goc.length ? "ORDER_ONLY" : "NONE";
    return {
      shipmentId: r.shipmentId,
      code: r.code ?? r.tracking ?? null,
      orderId: r.orderId ?? them?.orderId ?? null,
      orderCode: r.orderCode ?? them?.orderCode ?? null,
      customerName: r.customerName ?? "",
      customerPhone: r.customerPhone ?? "",
      receivedAt: r.receivedAt,
      returnedAt: r.returnedAt ?? null,
      receivedBy: r.receivedBy,
      // CHƯA BIẾT là null — không ép về 0, và không dùng `||` (nó nuốt luôn một số 0 thật).
      expectedQty: itemsBasis === "NONE" ? null : items.reduce((a, x) => a + x.quantity, 0),
      itemsBasis,
      linkBasis: them?.basis ?? (r.orderId ? "DIRECT" : "UNRESOLVED"),
      ageDays: Math.floor((now - new Date(r.receivedAt).getTime()) / 86_400_000),
      items,
    };
  });
}

/**
 * MỘT HÌNH DUY NHẤT ĐI QUA RANH GIỚI MÁY CHỦ → TRÌNH DUYỆT.
 *
 * Trạm đếm nhận dòng từ HAI đường: danh sách dựng lúc vẽ trang, và kết quả bắn mã trả về từ server
 * action. Hai đường phải cho ra đúng một hình, nếu không thì kiện vừa bắn hiển thị khác kiện có sẵn
 * — và bộ lọc, phép sắp xếp đọc trúng chỗ trống.
 *
 * `Date` → chuỗi ISO là chỗ dễ trượt nhất: RSC chuyển được `Date` nên bản dựng lúc vẽ trang trả về
 * `Date`, còn nhánh nào lỡ đi qua JSON lại trả về chuỗi. Hai kiểu ấy so sánh và định dạng khác nhau
 * mà TypeScript không kêu, vì `any` từ ranh giới đã nuốt mất. Ép về chuỗi ở ĐÚNG một chỗ này.
 */
export function toStationRow(p: PendingInspection): StationRow {
  return {
    shipmentId: p.shipmentId,
    code: p.code,
    orderId: p.orderId,
    orderCode: p.orderCode,
    customerName: p.customerName,
    customerPhone: p.customerPhone,
    receivedBy: p.receivedBy,
    receivedAt: p.receivedAt.toISOString(),
    returnedAt: p.returnedAt ? p.returnedAt.toISOString() : null,
    expectedQty: p.expectedQty,
    itemsBasis: p.itemsBasis,
    linkBasis: p.linkBasis,
    ageDays: p.ageDays,
    items: p.items.map((it) => ({ variantId: it.variantId ?? null, sku: it.sku, name: it.name, color: it.color, size: it.size, quantity: it.quantity })),
  };
}

/**
 * QUÉT MÃ VẬN ĐƠN → RA ĐÚNG MỘT KIỆN.
 *
 * Người đếm cầm kiện hàng, bắn mã, và phải thấy ngay kiện đó — không phải cuộn tìm trong 453 dòng.
 *
 * Dò theo BỐN mã cùng lúc vì mã in trên kiện không phải lúc nào cũng là mã ERP dùng làm khoá: mã
 * vận đơn Viettel Post, mã tra cứu, mã tham chiếu (vận đơn chiều hoàn mang mã gốc), và mã đơn của
 * shop. So khớp KHÔNG phân biệt hoa thường và bỏ khoảng trắng thừa — máy quét hay thêm cả hai.
 */
export async function findPendingByCode(code: string): Promise<PendingInspection | null> {
  const q = code.trim();
  if (!q) return null;
  const list = await listPendingInspections(1000);
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const target = norm(q);
  return (
    list.find((r) => norm(r.code) === target || norm(r.orderCode) === target || norm(r.shipmentId) === target) ??
    // Bắn thiếu vài ký tự đầu (máy quét đọc hụt) vẫn tìm được, miễn là ĐỦ DÀI để không mơ hồ.
    (target.length >= 6 ? (list.find((r) => norm(r.code).endsWith(target) || norm(r.orderCode).endsWith(target)) ?? null) : null)
  );
}

export type InspectionSummary = {
  /** Kiện đã về, chờ đếm. */
  pending: number;
  /**
   * Số món KỲ VỌNG của các kiện chờ đếm — phần hàng chưa ai xác nhận có thật hay không.
   * `null` = CHƯA BIẾT: có kiện chờ đếm nhưng không kiện nào ghép được đơn. Không phải 0.
   */
  pendingItems: number | null;
  /** Kiện chờ đếm CHƯA ghép được đơn — số món của chúng không nằm trong `pendingItems`. */
  unknownParcels: number;
  /** Kiện chờ đếm quá 3 ngày: hàng nằm trong kho mà sổ vẫn chưa biết. */
  stale: number;
  inspected: number;
  restockedQty: number;
  unsellableQty: number;
};

/**
 * SỐ MÓN KỲ VỌNG CỦA CÁC KIỆN CHỜ ĐẾM — ghép bằng định danh, không đọc `return_inspections.order_id`.
 *
 * Cột đó NULL cho mọi vận đơn chiều về (luật 7), và tổng `sum(order_items.quantity)` theo cột đó
 * (a) cho 0 với những kiện ấy, (b) bỏ qua `return_quantity` khi đơn có phiếu trả từng dòng — nên
 * cùng một kiện, thẻ đầu trang nói một số và hàng đợi đếm nói số khác. Dùng đúng máy ghép mà
 * `listPendingInspections` dùng; CHƯA BIẾT là `null`, không phải 0.
 */
async function pendingExpectedItems(db: Db): Promise<{ pendingItems: number | null; unknownParcels: number }> {
  const rows = await db.select({ shipmentId: ins.shipmentId }).from(ins).where(eq(ins.status, "RECEIVED"));
  if (!rows.length) return { pendingItems: 0, unknownParcels: 0 };
  const ctx = await returnProductContext(rows.map((r) => r.shipmentId));
  let known = 0;
  let items = 0;
  let unknownParcels = 0;
  for (const r of rows) {
    const c = ctx.get(r.shipmentId);
    if (!c || c.expectedQty === null) {
      unknownParcels += 1;
      continue;
    }
    known += 1;
    items += c.expectedQty;
  }
  return { pendingItems: known ? items : null, unknownParcels };
}

export async function inspectionSummary(): Promise<InspectionSummary> {
  const db = await getDb();
  const [[row], expected] = await Promise.all([
    db
      .select({
        pending: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED')`,
        stale: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - make_interval(days => ${INSPECT_AGE_DAYS.TON_DONG}))`,
        inspected: sql<number>`count(*) filter (where ${ins.status} = 'INSPECTED')`,
        restockedQty: sql<number>`coalesce(sum(${ins.restockQty}), 0)`,
        unsellableQty: sql<number>`coalesce(sum(${ins.unsellableQty}), 0)`,
      })
      .from(ins),
    pendingExpectedItems(db),
  ]);
  return {
    pending: Number(row?.pending ?? 0),
    pendingItems: expected.pendingItems,
    unknownParcels: expected.unknownParcels,
    stale: Number(row?.stale ?? 0),
    inspected: Number(row?.inspected ?? 0),
    restockedQty: Number(row?.restockedQty ?? 0),
    unsellableQty: Number(row?.unsellableQty ?? 0),
  };
}

export type InspectionDashboard = {
  /** ĐVVC báo hoàn nhưng kho CHƯA bấm nhận — hàng đang trên đường về hoặc đã tới mà chưa ai ghi. */
  awaitingArrival: number;
  /** Đã nhận, CHƯA đếm. Đây là phần hàng có thật mà sổ đang chưa biết. */
  pendingInspection: number;
  /** Số món kỳ vọng của kiện chờ đếm. `null` = CHƯA BIẾT (không kiện nào ghép được đơn), không phải 0. */
  pendingItems: number | null;
  /** Kiện chờ đếm chưa ghép được đơn — không nằm trong `pendingItems`. */
  unknownParcels: number;
  /** Đã đếm và đã vào lại tồn. */
  restocked: number;
  restockedQty: number;
  damaged: number;
  missing: number;
  wrongItem: number;
  unsellable: number;
  /** Tuổi của các kiện CHỜ ĐẾM — hàng nằm càng lâu thì sổ càng sai lâu. */
  aging: { duoi1Ngay: number; tu1Den3Ngay: number; tu3Den7Ngay: number; tren7Ngay: number; cuNhatNgay: number };
};

/**
 * BẢNG ĐIỀU KHIỂN KIỂM HÀNG HOÀN.
 *
 * Sáu con số + tuổi tồn đọng, trả về trong MỘT lượt. Tách "chờ nhận" khỏi "chờ đếm" là cố ý: hai
 * việc đó thuộc hai người khác nhau và tắc ở hai chỗ khác nhau — gộp lại thì không biết phải đi
 * giục ai.
 */
export async function inspectionDashboard(): Promise<InspectionDashboard> {
  const db = await getDb();
  const [[row], [choNhan], expected] = await Promise.all([
    db
      .select({
        pendingInspection: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED')`,
        restocked: sql<number>`count(*) filter (where ${ins.condition} = 'RESTOCKABLE')`,
        restockedQty: sql<number>`coalesce(sum(${ins.restockQty}), 0)`,
        damaged: sql<number>`count(*) filter (where ${ins.condition} = 'DAMAGED')`,
        missing: sql<number>`count(*) filter (where ${ins.condition} = 'MISSING')`,
        wrongItem: sql<number>`count(*) filter (where ${ins.condition} = 'WRONG_ITEM')`,
        unsellable: sql<number>`count(*) filter (where ${ins.condition} = 'UNSELLABLE')`,
        d1: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} >= now() - make_interval(days => ${INSPECT_AGE_DAYS.TUOI}))`,
        d13: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - make_interval(days => ${INSPECT_AGE_DAYS.TUOI}) and ${ins.receivedAt} >= now() - make_interval(days => ${INSPECT_AGE_DAYS.TON_DONG}))`,
        d37: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - make_interval(days => ${INSPECT_AGE_DAYS.TON_DONG}) and ${ins.receivedAt} >= now() - make_interval(days => ${INSPECT_AGE_DAYS.QUA_HAN}))`,
        d7: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - make_interval(days => ${INSPECT_AGE_DAYS.QUA_HAN}))`,
        oldest: sql<number>`coalesce(extract(day from now() - min(${ins.receivedAt}) filter (where ${ins.status} = 'RECEIVED')), 0)`,
      })
      .from(ins),
    // Cùng MỘT vị ngữ với bàn nhận hàng và xác nhận hàng loạt — thẻ này không được nói con số khác.
    db.select({ n: sql<number>`count(*)` }).from(s).where(IS_RETURN_AWAITING_WAREHOUSE),
    pendingExpectedItems(db),
  ]);
  return {
    awaitingArrival: Number(choNhan?.n ?? 0),
    pendingInspection: Number(row?.pendingInspection ?? 0),
    pendingItems: expected.pendingItems,
    unknownParcels: expected.unknownParcels,
    restocked: Number(row?.restocked ?? 0),
    restockedQty: Number(row?.restockedQty ?? 0),
    damaged: Number(row?.damaged ?? 0),
    missing: Number(row?.missing ?? 0),
    wrongItem: Number(row?.wrongItem ?? 0),
    unsellable: Number(row?.unsellable ?? 0),
    aging: {
      duoi1Ngay: Number(row?.d1 ?? 0),
      tu1Den3Ngay: Number(row?.d13 ?? 0),
      tu3Den7Ngay: Number(row?.d37 ?? 0),
      tren7Ngay: Number(row?.d7 ?? 0),
      cuNhatNgay: Math.floor(Number(row?.oldest ?? 0)),
    },
  };
}

/**
 * ═══════════ "NHẬN ĐỦ" CHO KIỆN NHIỀU MẪU MÃ ═══════════
 *
 * ─── VÌ SAO ĐƯỜNG ĐẾM NHANH TỪ CHỐI KIỆN NHIỀU MẪU MÃ, VÀ VÌ SAO CHỖ NÀY KHÁC ───
 *
 * `singleVariantForParcel` chặn kiện nhiều mẫu mã vì đường đó nhận MỘT CON SỐ TỔNG. Kiện 2 áo đỏ +
 * 1 áo đen mà người đếm gõ "2" thì không ai biết 2 đó là món nào — và mọi cách chia đều là đoán.
 * Luật ấy đúng và không được nới.
 *
 * Nhưng **"nhận đủ" KHÔNG phải một con số tổng**. Nó là một khẳng định về TỪNG DÒNG: mọi dòng hàng
 * kỳ vọng đều quay về, đúng bằng số kỳ vọng của chính nó. Phân bổ được xác định hoàn toàn bởi danh
 * sách hàng kỳ vọng — không còn gì để đoán.
 *
 * ─── NÊN NÓ KHÔNG PHẢI MỘT ĐƯỜNG GHI MỚI ───
 *
 * Hàm này CHỈ dựng danh sách món (mỗi dòng: thực nhận = kỳ vọng, kết luận `OK`) rồi giao cho
 * `recordItemInspection` — đường đếm từng món đã có. Nhờ vậy nó thừa hưởng nguyên vẹn: một giao
 * dịch, khoá dòng chống bấm đúp, MỘT phiếu tái nhập với MỘT DÒNG MỖI MẪU MÃ, chặn đếm lần hai, và
 * đóng cả vận đơn chiều đi khi kiện đi qua vận đơn chiều về.
 *
 * Đo trên production 14/09/2026: 300 kiện chờ đếm, phần lớn có 2 mẫu mã — với luật cũ thì mỗi kiện
 * phải mở ngăn kéo đếm từng món, tức 300 lần mở ngăn kéo cho những kiện còn nguyên seal.
 *
 * ─── BỐN THỨ VẪN CHẶN ───
 *
 *  1. Kiện chưa ghép được đơn (`UNRESOLVED`) — không có danh sách kỳ vọng thì không có gì để "đủ".
 *  2. Mã gốc lần ra NHIỀU đơn (`AMBIGUOUS`) — nhiều danh sách kỳ vọng, ERP không chọn hộ.
 *  3. Dòng hàng chưa ghép được mẫu mã — món đó không biết cộng vào đâu, và ghi "đủ" cho nó là ghi
 *     một món vào sổ mà tồn không bao giờ nhận được.
 *  4. Danh sách chỉ SUY TỪ CẢ ĐƠN (`ORDER_ONLY`) — người đếm phải nói rõ đã đối chiếu thực tế
 *     (`orderOnlyConfirmed`), nếu không một kiện hoàn MỘT PHẦN sẽ được ghi là về đủ.
 */
export type FullReturnResult = { ok: true; restocked: number; receiptId: string | null; variants: number } | { error: string };

export async function recordFullReturnInspection(input: {
  shipmentId: string;
  actor: Actor;
  note?: string;
  orderOnlyConfirmed?: boolean;
  /** Bối cảnh đã ghép sẵn — chỉ để chạy hàng loạt không N+1. */
  ctx?: ReturnProductContext;
}): Promise<FullReturnResult> {
  const ctx = input.ctx ?? (await returnProductContext([input.shipmentId])).get(input.shipmentId);
  if (!ctx || ctx.basis === "UNRESOLVED") {
    return { error: "Kiện này chưa ghép được đơn nên không có danh sách hàng kỳ vọng — đếm từng món và ghi rõ mã hàng." };
  }
  if (ctx.basis === "AMBIGUOUS") {
    return { error: `Mã gốc ${ctx.viaBaseCode ?? ""} lần ra ${ctx.candidateOrderIds.length} đơn khác nhau — ERP không chọn hộ. CS gắn đúng đơn trước.` };
  }
  // Dòng số lượng 0 không phải một món quay về; bỏ ra thay vì để `recordItemInspection` từ chối cả kiện.
  const items = ctx.items.filter((it) => it.quantity > 0);
  if (!items.length) return { error: "Đơn của kiện này không còn dòng hàng nào — đếm từng món và ghi rõ." };

  const chuaGhep = items.filter((it) => !it.variantId);
  if (chuaGhep.length) {
    return {
      error: `${chuaGhep.length} dòng hàng chưa ghép được mẫu mã (${chuaGhep.map((it) => it.sku || it.name).join(", ")}) — ghi "đủ" cho chúng là ghi một món mà tồn không bao giờ nhận được. Đồng bộ sản phẩm từ Pancake rồi đếm lại.`,
    };
  }

  const res = await recordItemInspection({
    shipmentId: input.shipmentId,
    actor: input.actor,
    orderOnlyConfirmed: input.orderOnlyConfirmed,
    ctx,
    items: items.map((it) => ({
      expectedVariantId: it.variantId,
      expectedSku: it.sku,
      expectedName: it.name,
      expectedColor: it.color,
      expectedSize: it.size,
      expectedQty: it.quantity,
      // THỰC NHẬN = KỲ VỌNG. Đây chính là nội dung của hai chữ "nhận đủ", viết ra thành số.
      actualVariantId: it.variantId,
      actualSku: it.sku,
      actualQty: it.quantity,
      condition: "OK" as const,
      note: "",
    })),
  });
  if ("error" in res) return res;
  return { ok: true, restocked: res.restocked, receiptId: res.receiptId, variants: new Set(items.map((it) => it.variantId)).size };
}

export type BulkInspectionResult = {
  done: number;
  /** Kiện KHÔNG xử lý được, kèm mã kiện để người đếm nhận ra và lý do để biết làm gì tiếp. */
  failed: { shipmentId: string; code: string | null; error: string }[];
};

/**
 * ĐẾM HÀNG LOẠT — dùng khi nhiều kiện có CÙNG kết luận.
 *
 * Ca thật ở kho: mở một xe hàng hoàn, mười kiện còn nguyên seal, cùng "nhận đủ". Bắt bấm mười lần
 * qua mười màn hình là lý do người ta bỏ luôn việc ghi nhận.
 *
 * BA RÀNG BUỘC KHÔNG ĐƯỢC NỚI, kể cả khi làm hàng loạt:
 *  1. "Nhận đủ" nghĩa là ĐÚNG BẰNG số ERP đã xuất — không có ô nhập số nào ở đường hàng loạt, nên
 *     không ai vô tình khai một con số mình chưa đếm.
 *  2. Kết luận không bán được VẪN phải có lý do; thiếu lý do thì kiện đó bị bỏ qua, không im lặng.
 *  3. Từng kiện chạy qua ĐÚNG hàm `recordInspection` — không có đường ghi tắt nào bỏ qua luật
 *     "đã đếm rồi thì không đếm lại".
 */
export async function recordInspectionBulk(
  shipmentIds: string[],
  condition: ReturnCondition,
  note: string,
  actor: Actor,
  /**
   * Người đếm xác nhận ĐÃ ĐỐI CHIẾU THỰC TẾ với những kiện mà danh sách món chỉ SUY TỪ CẢ ĐƠN.
   *
   * Bắt buộc phải là một lựa chọn tường minh trên màn hình, không phải mặc định: thiếu nó thì một
   * kiện hoàn MỘT PHẦN sẽ được ghi là về đủ, và phần chênh biến mất khỏi sổ.
   */
  orderOnlyConfirmed = false,
): Promise<BulkInspectionResult> {
  const ids = [...new Set(shipmentIds.filter((x) => x.trim()))];
  if (!ids.length) return { done: 0, failed: [] };

  const pending = await listPendingInspections(1000);
  const byId = new Map(pending.map((p) => [p.shipmentId, p]));
  // Ghép bối cảnh MỘT LƯỢT cho cả loạt (bốn truy vấn), rồi từng kiện đi qua đúng luật của đường đếm đơn lẻ.
  const contexts = await returnProductContext(ids);

  const failed: BulkInspectionResult["failed"] = [];
  let done = 0;
  for (const id of ids) {
    const row = byId.get(id);
    const ctx = contexts.get(id);
    const code = row?.code ?? null;
    /*
      "NHẬN ĐỦ" HÀNG LOẠT ĐI QUA ĐƯỜNG ĐẾM TỪNG MÓN, KHÔNG QUA ĐƯỜNG SỐ TỔNG.

      Trước bản này nó gọi `singleVariantForParcel` nên MỌI kiện nhiều mẫu mã đều bị từ chối — đo
      trên production 14/09/2026: phần lớn trong 300 kiện chờ đếm có 2 mẫu mã, tức thao tác hàng
      loạt gần như không dùng được cho đúng nhóm đông nhất.

      "Đủ" là khẳng định theo TỪNG DÒNG chứ không phải một con số tổng, nên phân bổ được xác định
      hoàn toàn — không có gì để đoán. `recordFullReturnInspection` dựng đúng danh sách đó rồi giao
      cho đường đếm từng món; mọi ràng buộc của đường ấy giữ nguyên.
    */
    if (condition === "RESTOCKABLE") {
      if (!row || row.expectedQty === null) {
        failed.push({ shipmentId: id, code, error: "chưa ghép được đơn nên không biết số kỳ vọng — đếm tay từng kiện" });
        continue;
      }
      const r = await recordFullReturnInspection({ shipmentId: id, actor, note, orderOnlyConfirmed, ctx });
      if ("error" in r) failed.push({ shipmentId: id, code, error: r.error });
      else done += 1;
      continue;
    }
    const qty = row?.expectedQty ?? 0;
    // Tới đây chắc chắn KHÔNG phải "nhận đủ" — mọi kết luận còn lại đều KHÔNG cộng tồn.
    const r = await recordInspectionWithContext({ shipmentId: id, condition, restockQty: 0, unsellableQty: qty, note, actor }, ctx);
    if ("error" in r) failed.push({ shipmentId: id, code, error: r.error });
    else done += 1;
  }
  return { done, failed };
}

// ───────────────────────── ĐẾM THEO TỪNG MÓN ─────────────────────────

export type InspectedItemInput = {
  /** Ảnh chụp hàng kỳ vọng — màn hình gửi lên từ bối cảnh đã ghép, để lưu đúng thứ người kho thấy lúc đếm. */
  expectedVariantId: string | null;
  expectedSku: string;
  expectedName: string;
  expectedColor: string;
  expectedSize: string;
  expectedQty: number;
  /** Mẫu mã THỰC NHẬN — khác kỳ vọng khi khách trả nhầm hàng. Bỏ trống thì hiểu là đúng mẫu kỳ vọng. */
  actualVariantId: string | null;
  actualSku: string;
  actualQty: number;
  condition: ItemCondition;
  note: string;
};

export type ItemInspectionResult =
  | { ok: true; restocked: number; receiptId: string | null; hasDiscrepancy: boolean }
  | { error: string };

/**
 * ═══════════ KHO ĐẾM XONG MỘT KIỆN, GHI KẾT LUẬN THEO TỪNG MÓN ═══════════
 *
 * Khác `recordInspection` (một kết luận cho CẢ KIỆN, giữ nguyên cho đường đếm nhanh): ở đây mỗi
 * món có kết luận riêng, nên một kiện vừa đủ một món vừa thiếu một món vừa hỏng một món ghi lại
 * được đúng như thế.
 *
 * BA ĐIỀU KHÔNG ĐƯỢC PHÁ:
 *
 *  1. CHỈ MÓN `OK` MỚI VÀO TỒN, và vào đúng SỐ THỰC NHẬN của chính nó. Sáu kết luận còn lại là
 *     hàng có thật trên bàn nhưng chưa bán lại được — chúng phải hiện thành thất thoát có tên.
 *  2. TỒN CHỈ ĐỔI QUA PHIẾU KHO. Hàm này không tự cộng vào tồn; nó lập phiếu tái nhập và để đúng
 *     cơ chế sổ kho đang có làm phần còn lại.
 *  3. ĐẾM MỘT LẦN. Kiện đã kiểm rồi thì chặn — nếu không, phiếu tái nhập cộng tồn hai lần.
 *
 * Và một khác biệt quan trọng nữa so với đường đếm nhanh: phiếu tái nhập ghi ĐÚNG MẪU MÃ người kho
 * đếm được, không phân bổ theo tỷ lệ dòng hàng của đơn. Phân bổ theo tỷ lệ là phép đoán chấp nhận
 * được khi chỉ biết tổng số; khi đã biết từng món mà vẫn đoán thì là làm hỏng dữ liệu tốt hơn.
 */
export async function recordItemInspection(input: {
  shipmentId: string;
  items: InspectedItemInput[];
  actor: Actor;
  orderOnlyConfirmed?: boolean;
  /**
   * Bối cảnh đã ghép sẵn — CHỈ để tránh N+1 khi chạy hàng loạt.
   *
   * Không truyền thì hàm tự tra như cũ. Truyền vào thì nơi gọi phải lấy nó từ CHÍNH
   * `returnProductContext`, không được tự dựng: đây là căn cứ quyết định món nào vào tồn, và một
   * bối cảnh tự chế là một đường vòng qua toàn bộ bậc thang chứng cứ của `product-context.ts`.
   */
  ctx?: ReturnProductContext;
}): Promise<ItemInspectionResult> {
  const db = await getDb();
  const [row] = await db.select().from(ins).where(eq(ins.shipmentId, input.shipmentId));
  if (!row) return { error: "Kiện này chưa được ghi nhận đã về kho" };
  if (row.status === "INSPECTED") return { error: "Kiện này đã đếm rồi — muốn sửa số thì lập phiếu điều chỉnh kho" };
  if (!input.items.length) return { error: "Phải đếm ít nhất một món" };

  // CĂN CỨ DANH SÁCH MÓN. "Chỉ suy từ cả đơn" (không có phiếu trả từng dòng) không được mặc định
  // là đủ: người kho phải nói rõ đã đối chiếu thực tế, nếu không một kiện hoàn một phần sẽ cộng
  // tồn cả đơn.
  const ctx = input.ctx ?? (await returnProductContext([input.shipmentId])).get(input.shipmentId);
  if (ctx?.itemsBasis === "ORDER_ONLY" && !input.orderOnlyConfirmed) {
    return { error: "Đơn này không có phiếu trả từng món — danh sách kỳ vọng chỉ suy từ cả đơn. Xác nhận đã đối chiếu thực tế rồi mới lưu." };
  }

  const actor: Actor = { id: input.actor.id, label: input.actor.label.trim() };
  if (!actor.label) return { error: "Thiếu người kiểm" };

  // Làm sạch + kiểm TOÀN BỘ trước khi ghi bất cứ thứ gì: một món sai thì cả kiện không ghi, chứ
  // không ghi được nửa rồi bỏ dở.
  const items = input.items.map((it) => ({
    ...it,
    expectedQty: Math.max(0, Math.trunc(it.expectedQty)),
    actualQty: Math.max(0, Math.trunc(it.actualQty)),
    note: it.note.trim(),
    actualSku: it.actualSku.trim() || it.expectedSku.trim(),
    actualVariantId: it.actualVariantId ?? it.expectedVariantId,
  }));
  for (const it of items) {
    if (!isItemCondition(it.condition)) return { error: `Kết luận không hợp lệ: ${String(it.condition)}` };
    if (ITEM_CONDITION_NEEDS_NOTE[it.condition] && !it.note) {
      return { error: `${ITEM_CONDITION_LABEL[it.condition]} thì phải ghi rõ vì sao (${it.expectedSku || it.expectedName})` };
    }
    if (it.condition === "OK" && it.actualQty <= 0) {
      return { error: `Kết luận "đủ" thì phải đếm được ít nhất một món (${it.expectedSku || it.expectedName})` };
    }
  }

  const now = new Date();
  const restockTotal = items.filter((it) => ITEM_CONDITION_RESTOCKS[it.condition] && it.actualVariantId).reduce((t, it) => t + it.actualQty, 0);
  const unsellableTotal = items.filter((it) => !ITEM_CONDITION_RESTOCKS[it.condition]).reduce((t, it) => t + it.actualQty, 0);
  const hasDiscrepancy = items.some((it) => itemHasDiscrepancy(it));

  // Gộp theo mẫu mã: cùng một mẫu mã ở hai dòng phải thành MỘT dòng phiếu, nếu không sổ kho có hai
  // bút toán cho cùng một thứ trong cùng một phiếu.
  const byVariant = new Map<string, number>();
  for (const it of items) {
    if (!ITEM_CONDITION_RESTOCKS[it.condition] || it.actualQty <= 0 || !it.actualVariantId) continue;
    byVariant.set(it.actualVariantId, (byVariant.get(it.actualVariantId) ?? 0) + it.actualQty);
  }

  // MỘT GIAO DỊCH: phiếu kho · từng món · lật trạng thái kiện. Hỏng giữa chừng thì không có phiếu
  // kho mồ côi làm tồn tăng mà không có biên bản đếm.
  let receiptId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      // Khoá dòng kiện cho tới hết giao dịch: lượt bấm trùng phải chờ, rồi thấy INSPECTED và dừng.
      const [locked] = await tx.select({ status: ins.status }).from(ins).where(eq(ins.id, row.id)).for("update");
      if (!locked || locked.status === "INSPECTED") throw new Error("DA_DEM_ROI");
    if (byVariant.size) {
      const [receipt] = await tx
        .insert(schema.stockReceipts)
        .values({
          kind: "RETURN",
          receivedAt: now,
          reference: `Đếm hàng hoàn ${input.shipmentId}`,
          note: `Đếm theo từng món · ${byVariant.size} mẫu mã`,
          totalQuantity: restockTotal,
          totalCost: 0,
          createdBy: actor.label,
        })
        .returning({ id: schema.stockReceipts.id });
      receiptId = receipt?.id ?? null;
      if (receiptId) {
        const rid = receiptId;
        await tx.insert(schema.stockReceiptItems).values([...byVariant.entries()].map(([variantId, quantity]) => ({ receiptId: rid, variantId, quantity, shipmentId: input.shipmentId })));
      }
    }

    await tx.insert(schema.returnInspectionItems).values(
      items.map((it) => ({
        inspectionId: row.id,
        shipmentId: input.shipmentId,
        expectedVariantId: it.expectedVariantId,
        expectedSku: it.expectedSku,
        expectedName: it.expectedName,
        expectedColor: it.expectedColor,
        expectedSize: it.expectedSize,
        expectedQty: it.expectedQty,
        actualVariantId: it.actualVariantId,
        actualSku: it.actualSku,
        actualQty: it.actualQty,
        condition: it.condition,
        note: it.note,
        inspectedBy: actor.label,
        inspectedByUserId: actor.id,
        inspectedAt: now,
      })),
    );

    /*
      KẾT LUẬN CẢ KIỆN SUY RA TỪ CÁC MÓN, không bắt người dùng nhập lại lần nữa.

      Cột `condition` của `return_inspections` vẫn được điền để mọi báo cáo và bảng đếm đang có chạy
      y nguyên — nhưng từ nay nó là số DẪN XUẤT; sự thật chi tiết nằm ở bảng từng món.
      Thứ tự ưu tiên theo mức nghiêm trọng: thiếu > sai hàng > hỏng > không bán được.
    */
    const parcelCondition: ReturnCondition = items.every((it) => it.condition === "OK")
      ? "RESTOCKABLE"
      : items.some((it) => it.condition === "SHORT")
        ? "MISSING"
        : items.some((it) => it.condition === "WRONG_ITEM")
          ? "WRONG_ITEM"
          : items.some((it) => it.condition === "DAMAGED")
            ? "DAMAGED"
            : "UNSELLABLE";
    // Ràng buộc CSDL: kết luận khác "bán lại được" thì BẮT BUỘC có lý do. Gộp lý do của từng món để
    // người đọc phiếu kiện thấy ngay vì sao, không phải mở bảng chi tiết.
    const summary = items
      .filter((it) => it.condition !== "OK")
      .map((it) => `${it.expectedSku || it.expectedName}: ${ITEM_CONDITION_LABEL[it.condition]}${it.note ? ` — ${it.note}` : ""}`)
      .join(" · ");

    const flipped = await tx
      .update(ins)
      .set({
        status: "INSPECTED",
        orderId: row.orderId ?? ctx?.orderId ?? null,
        condition: parcelCondition,
        restockQty: restockTotal,
        unsellableQty: unsellableTotal,
        note: summary,
        inspectedAt: now,
        inspectedBy: actor.label,
        inspectedByUserId: actor.id,
        stockReceiptId: receiptId,
        updatedAt: now,
      })
      // Lật trạng thái CÓ ĐIỀU KIỆN: chỉ khi vẫn đang RECEIVED. Hai người bấm cùng lúc thì người sau
      // không lật được ⇒ toàn bộ giao dịch (kể cả phiếu kho vừa lập) bị huỷ, tồn không cộng hai lần.
      .where(and(eq(ins.id, row.id), eq(ins.status, "RECEIVED")))
      .returning({ id: ins.id });
    if (!flipped.length) throw new Error("DA_DEM_ROI");

    // Đóng kiện trên vận đơn — và trên vận đơn chiều đi nếu kiện được đếm qua vận đơn chiều về.
    await closeReturnedShipment(tx, input.shipmentId, ctx, actor, summary);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "DA_DEM_ROI") return { error: "Kiện này vừa được người khác đếm — không ghi lại lần hai" };
    throw e;
  }
  return { ok: true, restocked: restockTotal, receiptId, hasDiscrepancy };
}

/** Kết quả đếm theo món của một kiện — để ngăn kéo hiện lại việc đã làm. */
export async function listInspectedItems(shipmentId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.returnInspectionItems)
    .where(eq(schema.returnInspectionItems.shipmentId, shipmentId))
    .orderBy(asc(schema.returnInspectionItems.createdAt));
}
