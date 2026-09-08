import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * ───────────── TÌM KIẾM TOÀN HỆ THỐNG ─────────────
 *
 * Trước đây ô tìm kiếm chỉ ĐIỀU HƯỚNG: gõ số điện thoại rồi chọn "Đơn hàng" là nhảy sang trang đơn
 * với bộ lọc. Người dùng phải đoán trước dữ liệu nằm ở module nào — trong khi câu hỏi thật thường
 * là "số này có gì?", không phải "tìm số này trong bảng đơn".
 *
 * Nay trả về KẾT QUẢ THẬT từ mọi thực thể cùng lúc.
 *
 * LUẬT QUAN TRỌNG NHẤT — MỘT SỐ ĐIỆN THOẠI KHÔNG PHẢI MỘT ĐƠN:
 * cùng một số có thể có nhiều đơn và nhiều vận đơn (mua nhiều lần, gửi lại, vận đơn chiều hoàn).
 * Tìm kiếm PHẢI trả về tất cả và nói rõ có bao nhiêu, tuyệt đối không nhảy thẳng vào cái đầu tiên.
 * Số điện thoại chỉ là KHOÁ TRA CỨU, không phải danh tính của một đơn hàng.
 */

export type SearchHit = {
  kind: "ORDER" | "SHIPMENT" | "CUSTOMER" | "PRODUCT";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

export type SearchResult = {
  query: string;
  hits: SearchHit[];
  /** Tổng số bản ghi khớp từng loại — có thể lớn hơn số dòng trả về. */
  counts: { orders: number; shipments: number; customers: number; products: number };
  /** Cảnh báo khi một khoá tra cứu khớp nhiều bản ghi — người dùng phải tự chọn. */
  ambiguous: string | null;
};

const digitsOnly = (v: string) => v.replace(/\D/g, "");

export async function searchEntities(rawQuery: string, limitPerKind = 5): Promise<SearchResult> {
  const q = rawQuery.trim();
  const empty: SearchResult = { query: q, hits: [], counts: { orders: 0, shipments: 0, customers: 0, products: 0 }, ambiguous: null };
  if (q.length < 2) return empty;

  const db = await getDb();
  const like = `%${q}%`;
  const digits = digitsOnly(q);
  /**
   * `orders.system_id` là INTEGER 4 byte của Postgres. Mã vận đơn Viettel Post cũng toàn chữ số và
   * dài hơn hẳn, nên nếu đem so thẳng thì cơ sở dữ liệu báo TRÀN SỐ và cả ô tìm kiếm sập — đúng lúc
   * người dùng dán một mã vận đơn vào, tức là ca dùng phổ biến nhất.
   */
  const PG_INT_MAX = 2_147_483_647;
  const numeric = Number(q.replace(/^#/, ""));
  const asSystemId = Number.isInteger(numeric) && numeric > 0 && numeric <= PG_INT_MAX ? numeric : null;

  const o = schema.orders;
  const s = schema.shipments;
  const c = schema.customers;
  const p = schema.products;

  const [orders, shipments, customers, products] = await Promise.all([
    db
      .select({
        id: o.id,
        systemId: o.systemId,
        name: o.billFullName,
        phone: o.billPhone,
        total: o.totalPriceAfterDiscount,
        stage: o.stage,
        insertedAt: o.insertedAt,
        total_count: sql<number>`count(*) over ()`,
      })
      .from(o)
      .where(
        sql`(${o.billPhone} ilike ${like} or ${o.billFullName} ilike ${like} or ${o.id} = ${q}
          ${asSystemId ? sql`or ${o.systemId} = ${asSystemId}` : sql``}
          ${digits.length >= 8 ? sql`or ${o.billPhone} like ${`%${digits}%`} or ${o.shipPhone} like ${`%${digits}%`}` : sql``})`,
      )
      .orderBy(sql`${o.insertedAt} desc`)
      .limit(limitPerKind),
    db
      .select({
        id: s.id,
        code: s.vtpOrderNumber,
        tracking: s.trackingCode,
        stage: s.stage,
        orderId: s.orderId,
        reference: s.orderReference,
        updatedAt: s.updatedAt,
        total_count: sql<number>`count(*) over ()`,
      })
      .from(s)
      .where(sql`(${s.vtpOrderNumber} ilike ${like} or ${s.trackingCode} ilike ${like} or ${s.orderReference} ilike ${like} or ${s.id} = ${q})`)
      .orderBy(sql`${s.updatedAt} desc`)
      .limit(limitPerKind),
    db
      .select({ id: c.id, name: c.name, phone: c.phone, orders: c.orderCount, succeed: c.succeedOrderCount, total_count: sql<number>`count(*) over ()` })
      .from(c)
      .where(sql`(${c.name} ilike ${like} ${digits.length >= 8 ? sql`or ${c.phone} like ${`%${digits}%`}` : sql`or ${c.phone} ilike ${like}`})`)
      .orderBy(sql`coalesce(${c.lastOrderAt}, ${c.createdAt}) desc`)
      .limit(limitPerKind),
    db
      .select({ id: p.id, name: p.name, code: p.customId, total_count: sql<number>`count(*) over ()` })
      .from(p)
      .where(sql`(${p.name} ilike ${like} or ${p.customId} ilike ${like})`)
      .limit(limitPerKind),
  ]);

  const hits: SearchHit[] = [
    ...orders.map((r) => ({
      kind: "ORDER" as const,
      id: r.id,
      title: `Đơn #${r.systemId ?? r.id} · ${r.name || "Khách"}`,
      subtitle: `${r.phone || "chưa có SĐT"} · ${Math.round(Number(r.total ?? 0)).toLocaleString("vi-VN")}đ · ${r.stage} · ${new Date(r.insertedAt).toLocaleDateString("vi-VN")}`,
      href: `/orders/${r.id}`,
    })),
    ...shipments.map((r) => ({
      kind: "SHIPMENT" as const,
      id: r.id,
      title: `Vận đơn ${r.code || r.tracking || r.id}`,
      // Vận đơn KHÔNG có đơn là chuyện bình thường (chiều hoàn) — nói ra thay vì để trống khó hiểu.
      subtitle: `${r.stage}${r.orderId ? "" : ` · không gắn đơn${r.reference ? ` · tham chiếu ${r.reference}` : ""}`}`,
      href: `/shipments/${r.id}`,
    })),
    ...customers.map((r) => ({
      kind: "CUSTOMER" as const,
      id: r.id,
      title: r.name || r.phone || r.id,
      subtitle: `${r.phone || "chưa có SĐT"} · ${Number(r.orders ?? 0)} đơn · ${Number(r.succeed ?? 0)} đơn thành công`,
      href: `/customers/${r.id}`,
    })),
    ...products.map((r) => ({
      kind: "PRODUCT" as const,
      id: r.id,
      title: r.name || r.id,
      subtitle: r.code ? `Mã ${r.code}` : "Sản phẩm",
      href: `/products/${r.id}`,
    })),
  ];

  const counts = {
    orders: Number(orders[0]?.total_count ?? 0),
    shipments: Number(shipments[0]?.total_count ?? 0),
    customers: Number(customers[0]?.total_count ?? 0),
    products: Number(products[0]?.total_count ?? 0),
  };

  // Một số điện thoại khớp nhiều đơn / nhiều vận đơn là chuyện BÌNH THƯỜNG, không phải lỗi — nhưng
  // người dùng phải được nói cho biết, để không tưởng cái đầu tiên là cái duy nhất.
  const ambiguous =
    digits.length >= 8 && (counts.orders > 1 || counts.shipments > 1)
      ? `Số này có ${counts.orders} đơn và ${counts.shipments} vận đơn — chọn đúng bản ghi cần xem, đừng lấy cái đầu tiên.`
      : null;

  return { query: q, hits, counts, ambiguous };
}
