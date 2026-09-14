import assert from "node:assert/strict";
import { and, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { shipmentSearchCondition } from "@/lib/queries/shipments";
import { looksLikePhone, parseSearchTerm, phoneVariants } from "@/lib/queries/search-terms";

/**
 * ═══════ Ô TÌM KIẾM KHÔNG ĐƯỢC NÓI "KHÔNG CÓ GÌ" VỀ THỨ ĐANG NẰM TRONG KHO ═══════
 *
 * LỖI ĐÃ SỬA. `normalizePhone` chạy ở đường GHI, nên CSDL lưu `0xxxxxxxxx` — đo production
 * 13/09/2026: 1.843/1.843 số đúng chuẩn, 0 dòng dạng `84…`, 0 dòng có `+`, 0 dòng có dấu cách.
 * Nhưng đường ĐỌC ghép thẳng chuỗi người gõ vào `ilike '%…%'`.
 *
 * Chủ shop copy số từ Pancake hoặc từ tin nhắn — nơi số thường ở dạng `+84 912 345 678` — dán vào
 * ô tìm và nhận về danh sách RỖNG. Ô tìm không báo lỗi, nó chỉ nói "không có gì", nên kết luận tự
 * nhiên là "ERP thiếu dữ liệu" — rồi người ta đi tạo lại một bản ghi đã tồn tại.
 */

/* ───── 1 · Nhận dạng và nở biến thể số điện thoại ───── */
export function testSearchTermParsing() {
  for (const v of ["0912345678", "+84912345678", "84912345678", "0912 345 678", "0912-345-678", "(091) 234 5678"]) {
    assert.ok(looksLikePhone(v), `"${v}" phải được nhận là số điện thoại`);
    assert.ok(phoneVariants(v).includes("0912345678"), `"${v}" phải nở ra dạng chuẩn 0912345678`);
  }

  // KHÔNG được nhận nhầm: mã vận đơn và mã quảng cáo cũng toàn số.
  assert.equal(looksLikePhone("PKE1508909058"), false, "mã vận đơn có chữ — không phải số điện thoại");
  assert.equal(looksLikePhone("123456789012345678"), false, "mã quảng cáo Facebook 15–20 số — không phải số điện thoại");
  assert.equal(looksLikePhone("3461"), false, "mã đơn 4 số — quá ngắn để là số điện thoại");

  const t = parseSearchTerm("  #3461 ");
  assert.equal(t?.orderNo, 3461, "`#3461` và `3461` là cùng một mã đơn — dấu # chỉ là cách hiển thị");
  assert.equal(parseSearchTerm("3461")?.orderNo, 3461);
  assert.equal(parseSearchTerm("abc")?.orderNo, null, "chữ không phải mã đơn");
  /*
    SỐ ĐIỆN THOẠI KHÔNG PHẢI MÃ ĐƠN — và đây từng làm ĐỔ TRANG, không phải trả về rỗng.

    `orders.system_id` là `integer` (trần 2.147.483.647). Gõ `84912345678` mà đem so với cột đó thì
    Postgres báo `22003: value out of range for type integer`. Mã đơn thật đang ở mức bốn chữ số.
  */
  assert.equal(parseSearchTerm("84912345678")?.orderNo, null, "số điện thoại 11 chữ số KHÔNG được đem so với mã đơn — tràn kiểu integer");
  assert.equal(parseSearchTerm("0912345678")?.orderNo, null, "số điện thoại 10 chữ số cũng vậy");
  assert.equal(parseSearchTerm("99999999999")?.orderNo, null, "số vượt trần integer không bao giờ là mã đơn hợp lệ");
  assert.equal(parseSearchTerm("   "), null, "toàn khoảng trắng ⇒ không lọc gì");
  assert.equal(parseSearchTerm("  PKE123  ")?.raw, "PKE123", "cắt khoảng trắng hai đầu");

  console.log("✓ Từ khoá tìm kiếm: 6 cách viết số điện thoại đều nở về dạng chuẩn · mã vận đơn/mã quảng cáo KHÔNG bị nhận nhầm · #3461 = 3461");
}

/* ───── 2 · Tìm thật trên CSDL: mọi cách gõ đều ra đúng một vận đơn ───── */
export async function testShipmentSearch(db: Db) {
  const P = "srch-";
  try {
    await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm tìm kiếm", customId: "SRCHQ", isRemoved: false }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "SRCHQ-L", detail: "L" }).onConflictDoNothing();
    await db.insert(schema.orders).values({ id: `${P}o1`, systemId: 987654, stage: "CONFIRMED", status: 2, insertedAt: new Date("2026-08-01T03:00:00Z"), billFullName: "Nguyễn Thị Tìm", billPhone: "0912345678", totalPriceAfterDiscount: 500_000 }).onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${P}i1`, orderId: `${P}o1`, variantId: `${P}v1`, sku: "SRCHQ-L", productName: "Đầm tìm kiếm", quantity: 1, lineTotal: 500_000, isBonus: false }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: `${P}VTP001`, trackingCode: `${P}VTP001`, stage: "IN_TRANSIT", receiverName: "Nguyễn Thị Tìm", receiverPhone: "0912345678", createdAt: new Date("2026-08-02T04:00:00Z") }).onConflictDoNothing();

    const tim = async (q: string) => {
      const cond = shipmentSearchCondition(q);
      const rows = await db
        .select({ id: schema.shipments.id })
        .from(schema.shipments)
        .where(and(sql`${schema.shipments.id} like ${`${P}%`}`, cond));
      return rows.map((r) => r.id);
    };

    /*
      SÁU CÁCH GÕ CÙNG MỘT SỐ. Bản cũ chỉ ra kết quả cho cách thứ nhất — năm cách còn lại trả về
      rỗng, và đó là năm cách mà người ta thực sự copy từ Pancake / Zalo / tin nhắn.
    */
    for (const q of ["0912345678", "+84912345678", "84912345678", "0912 345 678", "0912-345-678", "+84 912 345 678"]) {
      assert.deepEqual(await tim(q), [`${P}s1`], `tìm theo SĐT dạng "${q}" phải ra đúng vận đơn đó`);
    }

    // Mã vận đơn — thường và HOA, có khoảng trắng thừa hai đầu.
    assert.deepEqual(await tim(`${P}VTP001`), [`${P}s1`], "tìm theo mã vận đơn");
    assert.deepEqual(await tim(`  ${P}vtp001  `), [`${P}s1`], "mã vận đơn không phân biệt hoa thường, cắt khoảng trắng");

    // Mã đơn hiển thị, cả hai cách viết.
    assert.deepEqual(await tim("987654"), [`${P}s1`], "tìm theo mã đơn");
    assert.deepEqual(await tim("#987654"), [`${P}s1`], "tìm theo mã đơn có dấu #");

    // Mã đơn Pancake dạng chuỗi.
    assert.deepEqual(await tim(`${P}o1`), [`${P}s1`], "tìm theo mã đơn Pancake (chuỗi)");

    // Tên khách, và MÃ HÀNG / SKU — thứ trước đây chỉ có ở bộ lọc riêng, gõ vào ô tìm ra rỗng.
    assert.deepEqual(await tim("Nguyễn Thị Tìm"), [`${P}s1`], "tìm theo tên khách");
    assert.deepEqual(await tim("SRCHQ-L"), [`${P}s1`], "tìm theo SKU");
    assert.deepEqual(await tim("Đầm tìm kiếm"), [`${P}s1`], "tìm theo tên sản phẩm");

    // Không khớp thì rỗng — nhưng là rỗng THẬT.
    assert.deepEqual(await tim("0999999999"), [], "số không có trong kho ⇒ rỗng");
    assert.deepEqual(await tim("KHONGTONTAI"), [], "mã không có trong kho ⇒ rỗng");

    /*
      TÌM KIẾM PHẢI GHÉP ĐƯỢC VỚI BỘ LỌC, KHÔNG THAY THẾ CHÚNG.

      `shipmentSearchCondition` trả về một mệnh đề để `and()` với phần còn lại. Nếu nó tự dựng
      `where` riêng thì gõ vào ô tìm sẽ xoá mọi bộ lọc đang bật — đúng hành vi mà đề bài cấm.
    */
    const ghep = await db
      .select({ id: schema.shipments.id })
      .from(schema.shipments)
      .where(and(sql`${schema.shipments.id} like ${`${P}%`}`, shipmentSearchCondition("0912345678"), sql`${schema.shipments.stage} = 'IN_TRANSIT'`));
    assert.deepEqual(ghep.map((r) => r.id), [`${P}s1`], "tìm kiếm ghép được với bộ lọc chặng");
    const ghepTruot = await db
      .select({ id: schema.shipments.id })
      .from(schema.shipments)
      .where(and(sql`${schema.shipments.id} like ${`${P}%`}`, shipmentSearchCondition("0912345678"), sql`${schema.shipments.stage} = 'DELIVERED'`));
    assert.deepEqual(ghepTruot, [], "bộ lọc vẫn có hiệu lực khi đang tìm — tìm kiếm KHÔNG được nuốt bộ lọc");

    console.log("✓ Tìm vận đơn: 6 cách viết SĐT · mã vận đơn hoa/thường · #987654 và 987654 · mã Pancake · tên khách · SKU · tên sản phẩm — và ghép được với bộ lọc, không nuốt bộ lọc");
  } finally {
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} like ${`${P}%`}`);
    await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like ${`${P}%`}`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}%`}`);
    await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like ${`${P}%`}`);
    await db.delete(schema.products).where(sql`${schema.products.id} like ${`${P}%`}`);
  }
}
