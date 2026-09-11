import { and, eq, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ NGĂN KÉO TRA NHANH MỘT KIỆN HÀNG ═══════════
 *
 * ĐO ĐƯỢC TRƯỚC KHI SỬA. Để gọi một khách giao hụt, người CSKH phải mở: trang vận đơn → trang chi
 * tiết → quay lại → trang đơn (xem khách mua gì) → trang khách (xem đã mua bao nhiêu lần) → tab
 * Pancake. Sáu lần chuyển màn hình cho MỘT cuộc gọi, và mỗi lần chuyển là một lần chờ tải.
 *
 * Ngăn kéo này gom đúng những thứ cần để nói chuyện với khách vào MỘT lần tải: khách là ai, mua gì,
 * đã mua mấy lần, ĐVVC nói gì, đã giao hụt mấy lần, ai đã chăm và chăm cái gì.
 *
 * KHÔNG có nút nào tự nhắn khách. Nút ở đây ghi lại việc NGƯỜI đã làm — ERP không thay người nói
 * chuyện với khách.
 */

export type QuickView = {
  shipmentId: string;
  tracking: string;
  stageLabel: string;
  rawStatus: string;
  customer: string;
  phone: string;
  address: string;
  codAmount: number;
  orderId: string | null;
  orderSystemId: number | null;
  items: { name: string; qty: number; price: number }[];
  /** Hành trình ĐVVC, mới nhất trước. Chỉ nguồn MANG TIN, không có lần tra cứu rỗng. */
  timeline: { at: Date; status: string; note: string; location: string; source: string }[];
  failedAttempts: number;
  /** Lần gửi thứ mấy của đơn — đơn gửi lại lần hai nói lên nhiều thứ khi gọi khách. */
  attemptNo: number | null;
  /** Lịch sử mua của khách: đã giao thành công mấy đơn, đã hoàn mấy đơn. */
  history: { delivered: number; returned: number; totalOrders: number } | null;
  careActions: { kind: string; label: string; note: string; actor: string; at: Date }[];
  /** Link chat Pancake nếu có — mở thẳng, không phải đi tìm. */
  chatUrl: string | null;
};

export async function getShipmentQuickView(shipmentId: string): Promise<QuickView | null> {
  const db = await getDb();

  const [s] = rowsOf<{
    id: string;
    tracking: string;
    stage: string;
    raw: string | null;
    cod: string | number;
    r_name: string;
    r_phone: string;
    r_addr: string;
    order_id: string | null;
    system_id: number | null;
    bill_name: string | null;
    bill_phone: string | null;
    customer_id: string | null;
    page_id: string | null;
    conversation_id: string | null;
    attempt_no: number | null;
  }>(
    await db.execute(sql`
      select s.id,
             coalesce(nullif(s.vtp_order_number, ''), nullif(s.tracking_code, ''), s.id) as tracking,
             s.stage::text as stage,
             s.vtp_status_name as raw,
             s.cod_amount as cod,
             s.receiver_name as r_name,
             s.receiver_phone as r_phone,
             s.receiver_address as r_addr,
             s.attempt_no,
             s.order_id,
             o.system_id, o.bill_full_name as bill_name, o.bill_phone, o.customer_id, o.page_id, o.conversation_id
        from shipments s
        left join orders o on o.id = s.order_id
       where s.id = ${shipmentId}
       limit 1
    `),
  );
  if (!s) return null;

  const timeline = rowsOf<{ at: string; status: string; note: string; location: string; source: string }>(
    await db.execute(sql`
      select e.occurred_at as at, coalesce(nullif(e.status_name, ''), e.status) as status, e.note, e.location, e.source
        from shipment_events e
       where e.shipment_id = ${shipmentId}
         and e.source in ('VTP_WEBHOOK','PANCAKE','VTP_IMPORT','VTP_UI_MANUAL_VERIFICATION','MANUAL')
       order by e.occurred_at desc
       limit 12
    `),
  );

  const items = s.order_id
    ? rowsOf<{ name: string; qty: number; price: string | number }>(
        await db.execute(sql`
          select coalesce(nullif(oi.product_name, ''), 'Mẫu chưa rõ')
                 || case when oi.variation_detail <> '' then ' · ' || oi.variation_detail else '' end as name,
                 oi.quantity as qty,
                 oi.unit_price as price
            from order_items oi
           where oi.order_id = ${s.order_id}
           order by oi.quantity desc
           limit 12
        `),
      )
    : [];

  /*
    LỊCH SỬ KHÁCH ĐẾM THEO SĐT, không theo `customer_id`.

    Pancake tách khách theo trang, nên cùng một người nhắn từ hai trang là hai `customer_id`. Khi
    gọi điện thì thứ cần biết là "người cầm số này đã mua mấy lần" — và số điện thoại mới là thứ
    theo người.
  */
  const phone = s.bill_phone || s.r_phone || "";
  const [his] = phone
    ? await db
        .select({
          delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')::int`,
          returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME_FAST} in ('RETURNED','RETURNED_BY_RULE'))::int`,
          tong: sql<number>`count(*)::int`,
        })
        .from(schema.orders)
        // MỖI ĐƠN MỘT DÒNG. Đơn gửi lại lần hai mà nối cả hai vận đơn thì một đơn hoàn bị đếm hai lần,
        // và lịch sử khách hiện ra tệ hơn sự thật ngay lúc người CSKH đang cầm máy gọi họ.
        .leftJoin(schema.shipments, and(eq(schema.shipments.orderId, schema.orders.id), PRIMARY_ATTEMPT))
        .where(and(eq(schema.orders.billPhone, phone), notInArray(schema.orders.stage, ["DELETED"])))
    : [];

  // Số lần giao hụt đếm từ CHẶNG ĐÃ CHUẨN HOÁ của sự kiện, không dò chữ trong tên trạng thái:
  // ĐVVC đổi cách viết một chữ là phép dò chữ im lặng trả về 0.
  const [demHut] = rowsOf<{ lan: number }>(
    await db.execute(sql`select count(*)::int as lan from shipment_events where shipment_id = ${shipmentId} and normalized_stage = 'DELIVERY_FAILED'`),
  );

  const care = rowsOf<{ kind: string; note: string; actor: string; at: string }>(
    await db.execute(sql`
      select kind, note, actor_email as actor, created_at as at
        from care_actions
       where shipment_id = ${shipmentId}
       order by created_at desc
       limit 10
    `),
  );

  return {
    shipmentId: s.id,
    tracking: s.tracking,
    stageLabel: SHIPMENT_STAGE_LABEL[s.stage as keyof typeof SHIPMENT_STAGE_LABEL] ?? s.stage,
    rawStatus: s.raw || "Chưa có trạng thái",
    customer: s.bill_name || s.r_name || "Khách chưa có tên",
    phone,
    address: s.r_addr || "",
    codAmount: Number(s.cod ?? 0),
    orderId: s.order_id,
    orderSystemId: s.system_id === null || s.system_id === undefined ? null : Number(s.system_id),
    items: items.map((i) => ({ name: i.name, qty: Number(i.qty ?? 0), price: Number(i.price ?? 0) })),
    timeline: timeline.map((t) => ({ at: new Date(t.at), status: t.status, note: t.note ?? "", location: t.location ?? "", source: t.source })),
    failedAttempts: Number(demHut?.lan ?? 0),
    attemptNo: s.attempt_no === null || s.attempt_no === undefined ? null : Number(s.attempt_no),
    history: his ? { delivered: Number(his.delivered ?? 0), returned: Number(his.returned ?? 0), totalOrders: Number(his.tong ?? 0) } : null,
    careActions: care.map((c) => ({ kind: c.kind, label: CARE_ACTION_LABEL[c.kind as CareActionKind] ?? c.kind, note: c.note ?? "", actor: c.actor ?? "", at: new Date(c.at) })),
    chatUrl: s.page_id && s.conversation_id ? `https://pancake.vn/${s.page_id}?c_id=${s.conversation_id}` : null,
  };
}
