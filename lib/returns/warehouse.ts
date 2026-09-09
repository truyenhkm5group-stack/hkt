import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { markReturnsArrived, undoReturnArrived } from "@/lib/returns/inspection";

const s = schema.shipments;

/**
 * Kiện CHƯA được ghi nhận đã về. Kiện đã ghi nhận nằm ở hàng đợi ĐẾM (`listPendingInspections`),
 * không còn là việc của người nhận hàng — nếu không tách, bấm "xác nhận hàng loạt" sẽ lặp lại mãi
 * trên cùng một đống kiện.
 */
const NOT_YET_ARRIVED = sql`not exists (select 1 from return_inspections ri where ri.shipment_id = ${s.id})`;

/**
 * Kho GHI NHẬN kiện hàng hoàn đã về tới nơi.
 *
 * ĐÂY KHÔNG PHẢI LÚC HÀNG VÀO TỒN. Trước đây thao tác này lập luôn một phiếu tái nhập bằng đúng số
 * đã xuất — tức là ERP tự khẳng định "kiện về đủ" cho hàng trăm kiện chưa ai mở ra. Kiện thiếu món
 * hay hàng hỏng vẫn được cộng vào tồn như hàng lành, và phần chênh không bao giờ hiện ra.
 *
 * Từ nay: ghi nhận đã về chỉ mở một phiếu CHỜ ĐẾM. Hàng vào tồn ở bước đếm
 * (`recordInspection`), theo số người kiểm đếm được, và chỉ phần còn bán lại được.
 *
 * Idempotent: kiện đã ghi nhận rồi thì bấm lại không tạo thêm phiếu.
 */
export async function markReturnReceived(ids: string[], actor: string, note?: string) {
  return markReturnsArrived(ids, actor, note);
}

/**
 * Huỷ ghi nhận đã về (bấm nhầm kiện). Chỉ huỷ được kiện CHƯA ĐẾM — đã đếm thì tồn đã đổi theo phiếu
 * tái nhập, và sửa tồn phải bằng phiếu điều chỉnh có người ký, không bằng cách xoá ngược lịch sử.
 *
 * Vẫn gỡ mốc `return_received_at` cho các kiện được xác nhận từ trước khi có luồng đếm.
 */
export async function undoReturnReceived(ids: string[]) {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, blocked: 0 };
  const db = await getDb();
  const { count, blocked } = await undoReturnArrived(unique);
  const rows = await db
    .update(s)
    .set({ returnReceivedAt: null, returnReceivedBy: null, returnReceivedNote: null, updatedAt: new Date() })
    .where(
      and(
        inArray(s.id, unique),
        sql`${s.returnReceivedAt} is not null`,
        // Không gỡ mốc của kiện ĐÃ ĐẾM: mốc đó đi cùng một phiếu tái nhập có thật.
        sql`not exists (select 1 from return_inspections ri where ri.shipment_id = ${s.id} and ri.status = 'INSPECTED')`,
      ),
    )
    .returning({ id: s.id });
  return { count: Math.max(count, rows.length), blocked };
}

/**
 * Hàng hoàn ĐÃ VỀ TỚI SHOP mà kho chưa xác nhận.
 *
 * Chỉ tính vận đơn ở trạng thái RETURNED — tức Viettel Post đã trả hàng xong cho người gửi
 * (mã 504). Vận đơn RETURNING vẫn đang trên đường về, xác nhận nhận hàng lúc đó là bịa dữ liệu.
 *
 * Đây là phần tồn kho đang bị hụt: hàng có thật trong kho nhưng ERP chưa cộng lại, nên kế hoạch
 * đặt hàng sẽ đặt thừa.
 *
 * Đếm CẢ hàng tặng: chúng cũng nằm trong kiện hàng quay về và cách tính tồn của ERP đã tính,
 * nên số món ở đây phải khớp với mức tồn tăng lên sau khi xác nhận.
 *
 * Chỉ tính vận đơn CÓ GẮN ĐƠN. Viettel Post tạo vận đơn riêng cho chiều hoàn (mã ...1P1) và khi
 * nó phát thành công về shop thì vận đơn đó cũng ở trạng thái RETURNED — nhưng nó không có đơn
 * nào, không có món hàng nào, nên đưa vào hàng chờ kho chỉ tạo ra hàng trăm dòng rỗng. Hàng hoàn
 * của đơn đã nằm ở chính vận đơn gốc.
 */
export async function pendingReturnedForWarehouse() {
  const db = await getDb();
  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
      items: sql<number>`coalesce(sum((select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${s.orderId})), 0)`,
      oldestAt: sql<Date | null>`min(${s.returnedAt})`,
      /**
       * VỐN ĐANG NẰM NGOÀI SỔ — tính theo GIÁ NHẬP của chính các món trong kiện.
       *
       * Vì sao cần con số này: "445 kiện chờ đếm" không nói lên mức độ nghiêm trọng. Quy ra tiền
       * thì nó so sánh được với vốn nằm chết và với tiền mặt đang có — và mới trả lời được câu
       * "có đáng bỏ một buổi ra đếm không".
       */
      value: sql<number>`coalesce(sum((
        select coalesce(sum(oi.quantity * coalesce(nullif(pv.last_imported_price, 0), 0)), 0)
        from order_items oi left join product_variants pv on pv.id = oi.variant_id
        where oi.order_id = ${s.orderId}
      )), 0)`,
      /** Quá 30 ngày: nhóm có nguy cơ không bao giờ được đếm. */
      stale: sql<number>`count(*) filter (where ${s.returnedAt} < now() - interval '30 days')`,
    })
    .from(s)
    .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt), isNotNull(s.orderId), NOT_YET_ARRIVED));
  return {
    count: Number(row?.count ?? 0),
    items: Number(row?.items ?? 0),
    oldestAt: row?.oldestAt ?? null,
    value: Number(row?.value ?? 0),
    stale: Number(row?.stale ?? 0),
  };
}

/** Danh sách vận đơn hoàn đã về tới shop, cũ nhất trước — dùng cho thao tác xác nhận hàng loạt. */
export async function listPendingReturnedIds(limit: number) {
  const db = await getDb();
  const rows = await db
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt), isNotNull(s.orderId), NOT_YET_ARRIVED))
    .orderBy(asc(s.returnedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Khi kho lập PHIẾU TÁI NHẬP, đóng các vận đơn hoàn đang chờ tương ứng — cũ nhất trước — cho tới khi
 * đủ số lượng vừa đếm được của từng mẫu mã.
 *
 * Vì sao cần: "hoàn chờ nhận" là hàng ERP biết phải quay về nhưng chưa có trong tồn. Không đóng thì
 * con số này phình mãi và kho không biết lô nào đã xử lý. Đóng theo số ĐẾM THỰC TẾ (không phải theo
 * số suy ra từ vận đơn) nên phần đếm thiếu hiện ra thành hàng hụt thay vì bị giấu.
 *
 * Một vận đơn có nhiều mẫu mã: đóng vận đơn đó thì mọi mẫu mã trong kiện được tính là đã xử lý —
 * đúng thực tế vì cả kiện hàng quay về cùng lúc.
 */
export async function settleReturnsForVariants(counts: { variantId: string; quantity: number }[], actor: string, note?: string) {
  const wanted = new Map<string, number>();
  for (const c of counts) if (c.quantity > 0) wanted.set(c.variantId, (wanted.get(c.variantId) ?? 0) + c.quantity);
  if (!wanted.size) return { shipmentIds: [] as string[], firstByVariant: new Map<string, string>() };
  const db = await getDb();
  const rows = await db
    .select({
      shipmentId: s.id,
      variantId: schema.orderItems.variantId,
      quantity: schema.orderItems.quantity,
      returnedAt: s.returnedAt,
    })
    .from(s)
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, s.orderId))
    .where(
      and(
        isNull(s.returnReceivedAt),
        inArray(schema.orderItems.variantId, [...wanted.keys()]),
        // Chỉ đóng kiện ĐÃ VỀ TỚI SHOP. Vận đơn còn RETURNING vẫn đang trên đường về; đóng lúc đó
        // là bịa dữ liệu. Số kho đếm được vẫn vào tồn qua phiếu, chỉ là chưa gạch được kiện nào.
        sql`(${s.stage} in ('RETURNED','CANCELLED') or exists (select 1 from orders o2 where o2.id = ${s.orderId} and o2.stage in ('CANCELLED','DELETED')))`,
      ),
    )
    .orderBy(asc(s.returnedAt));

  const closed = new Set<string>();
  const firstByVariant = new Map<string, string>();
  for (const [variantId, want] of wanted) {
    let remaining = want;
    for (const row of rows) {
      if (remaining <= 0) break;
      if (row.variantId !== variantId) continue;
      if (!firstByVariant.has(variantId)) firstByVariant.set(variantId, row.shipmentId);
      if (!closed.has(row.shipmentId)) closed.add(row.shipmentId);
      remaining -= Number(row.quantity ?? 0);
    }
  }
  if (closed.size) {
    await db
      .update(s)
      .set({ returnReceivedAt: new Date(), returnReceivedBy: actor, returnReceivedNote: note?.trim() || null, updatedAt: new Date() })
      .where(and(inArray(s.id, [...closed]), isNull(s.returnReceivedAt)));
  }
  return { shipmentIds: [...closed], firstByVariant };
}

/** Hàng hoàn đang chờ kho nhận, gộp theo mẫu mã — để phiếu tái nhập biết dự kiến bao nhiêu món. */
export async function pendingReturnsByVariant() {
  const db = await getDb();
  const rows = await db
    .select({ variantId: schema.orderItems.variantId, quantity: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
    .from(s)
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, s.orderId))
    .where(
      and(
        isNull(s.returnReceivedAt),
        sql`(${s.stage} in ('RETURNING','RETURNED','CANCELLED') or exists (select 1 from orders o2 where o2.id = ${s.orderId} and o2.stage in ('CANCELLED','DELETED')))`,
      ),
    )
    .groupBy(schema.orderItems.variantId);
  return new Map(rows.filter((r) => r.variantId).map((r) => [r.variantId as string, Number(r.quantity ?? 0)]));
}
