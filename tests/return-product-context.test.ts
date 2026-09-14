import assert from "node:assert/strict";
import { schema, type Db } from "@/db";
import { returnProductContext, summarizeReturnItems } from "@/lib/returns/product-context";

/**
 * ───────── KIỆN HOÀN NÀY LÀ HÀNG GÌ ─────────
 *
 * Bài kiểm này khoá đúng một điều: ERP chỉ được nói "kiện này gồm món X" khi có ĐỊNH DANH dẫn tới
 * đó, và phải im lặng đúng cách khi không có.
 *
 * Vì sao đáng khoá: cách sai hấp dẫn nhất là ghép theo SĐT người nhận — nó chạy được ngay, phủ gần
 * hết danh sách, và sai âm thầm với mọi khách mua lần thứ hai. Kho đếm theo con số đó rồi cộng vào
 * tồn thì sai số nằm im tới kỳ kiểm kê, còn kế hoạch sản xuất lệch suốt thời gian ấy.
 *
 * Mẫu mã và đơn ở đây mang tiền tố `rpc-` riêng, không đụng fixture chung.
 */
export async function testReturnProductContext(db: Db) {
  const ngay = (d: string) => new Date(`${d}T00:00:00Z`);

  // ───────── Dàn cảnh ─────────
  await db.insert(schema.products).values({ id: "rpc-prod", name: "Áo RPC" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: "rpc-var-do-l", productId: "rpc-prod", sku: "Q002", color: "Đỏ", size: "L", retailPrice: 250000 },
      { id: "rpc-var-den-xl", productId: "rpc-prod", sku: "Q001", color: "Đen", size: "XL", retailPrice: 250000 },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.orders)
    .values([
      { id: "rpc-o1", customId: "#3997", systemId: 3997, stage: "SHIPPED", status: 3, cod: 500000, insertedAt: ngay("2026-08-01") },
      { id: "rpc-o2", customId: "#3998", systemId: 3998, stage: "SHIPPED", status: 3, cod: 250000, insertedAt: ngay("2026-08-02") },
      { id: "rpc-o3", customId: "#3999", systemId: 3999, stage: "SHIPPED", status: 3, cod: 750000, insertedAt: ngay("2026-08-03") },
      { id: "rpc-o4", customId: "#4000", systemId: 4000, stage: "SHIPPED", status: 3, cod: 250000, insertedAt: ngay("2026-08-04") },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.orderItems)
    .values([
      // o1: hai dòng, không có bằng chứng mức món
      { id: "rpc-i1", orderId: "rpc-o1", variantId: "rpc-var-do-l", productId: "rpc-prod", productName: "Áo RPC", sku: "Q002", quantity: 1, unitPrice: 250000 },
      { id: "rpc-i2", orderId: "rpc-o1", variantId: "rpc-var-den-xl", productId: "rpc-prod", productName: "Áo RPC", sku: "Q001", quantity: 1, unitPrice: 250000 },
      // o2: một dòng duy nhất
      { id: "rpc-i3", orderId: "rpc-o2", variantId: "rpc-var-do-l", productId: "rpc-prod", productName: "Áo RPC", sku: "Q002", quantity: 1, unitPrice: 250000 },
      // o3: hoàn MỘT PHẦN — 3 món bán, chỉ 1 món bị trả
      { id: "rpc-i4", orderId: "rpc-o3", variantId: "rpc-var-do-l", productId: "rpc-prod", productName: "Áo RPC", sku: "Q002", quantity: 2, returnQuantity: 1, unitPrice: 250000 },
      { id: "rpc-i5", orderId: "rpc-o3", variantId: "rpc-var-den-xl", productId: "rpc-prod", productName: "Áo RPC", sku: "Q001", quantity: 1, returnQuantity: 0, unitPrice: 250000 },
      // o4: mẫu mã đã bị xoá khỏi bảng biến thể (variantId null) — chỉ còn ảnh chụp lúc bán
      { id: "rpc-i6", orderId: "rpc-o4", variantId: null, productId: "rpc-prod", productName: "Áo RPC bản cũ", variationDetail: "Xanh / S", sku: "Q009", quantity: 2, unitPrice: 250000 },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.shipments)
    .values([
      // (1) ghép thẳng: vận đơn mang sẵn order_id
      { id: "rpc-s1", orderId: "rpc-o1", vtpOrderNumber: "RPC0001", stage: "RETURNED", returnedAt: ngay("2026-08-20") },
      // (4) cùng một đơn o2 có HAI lần gửi — vận đơn gốc và vận đơn gửi lại
      { id: "rpc-s2a", orderId: "rpc-o2", vtpOrderNumber: "RPC0002", stage: "RETURNED", returnedAt: ngay("2026-08-21") },
      { id: "rpc-s2b", orderId: "rpc-o2", vtpOrderNumber: "RPC0002B", stage: "RETURNED", returnedAt: ngay("2026-08-22") },
      // (6) vận đơn chiều về 1P1: order_id NULL, mã gốc nằm ở order_reference
      { id: "rpc-s3leg", orderId: null, orderReference: "RPC0003", vtpOrderNumber: "RPC00031P1", stage: "RETURNED", returnedAt: ngay("2026-08-23") },
      { id: "rpc-s3", orderId: "rpc-o3", vtpOrderNumber: "RPC0003", stage: "DELIVERED" },
      // (3) không lần ra đơn nào
      { id: "rpc-s4", orderId: null, vtpOrderNumber: "RPC9999", stage: "RETURNED", returnedAt: ngay("2026-08-24") },
      // (7) mẫu mã đã xoá
      { id: "rpc-s5", orderId: "rpc-o4", vtpOrderNumber: "RPC0004", stage: "RETURNED", returnedAt: ngay("2026-08-25") },
      // mơ hồ: mã gốc RPCDUP trỏ tới HAI đơn khác nhau
      { id: "rpc-s6leg", orderId: null, orderReference: "RPCDUP", vtpOrderNumber: "RPCDUP1P1", stage: "RETURNED", returnedAt: ngay("2026-08-26") },
      { id: "rpc-s6a", orderId: "rpc-o1", vtpOrderNumber: "RPCDUP", stage: "DELIVERED" },
      { id: "rpc-s6b", orderId: "rpc-o2", trackingCode: "RPCDUP", vtpOrderNumber: "RPCDUP-B", stage: "DELIVERED" },
    ])
    .onConflictDoNothing();

  const ctx = await returnProductContext(["rpc-s1", "rpc-s2a", "rpc-s2b", "rpc-s3leg", "rpc-s4", "rpc-s5", "rpc-s6leg"]);

  // ───────── 1. Ghép thẳng, đơn nhiều món ─────────
  const c1 = ctx.get("rpc-s1")!;
  assert.equal(c1.basis, "DIRECT", "vận đơn mang sẵn order_id thì đó là căn cứ chắc nhất");
  assert.equal(c1.orderCode, "#3997");
  assert.equal(c1.items.length, 2, "đơn hai dòng phải hiện đủ hai dòng");
  assert.equal(c1.expectedQty, 2);
  assert.equal(c1.itemsBasis, "ORDER_ONLY", "biết đơn KHÔNG có nghĩa là biết món nào thực sự quay về");
  assert.deepEqual(
    c1.items.map((i) => `${i.sku}/${i.color}/${i.size}×${i.quantity}`).sort(),
    ["Q001/Đen/XL×1", "Q002/Đỏ/L×1"],
    "kho phải đọc được mã hàng, màu, size và số lượng ngay trên dòng",
  );

  // ───────── 2. Một đơn, một món ─────────
  const c2 = ctx.get("rpc-s2a")!;
  assert.equal(c2.basis, "DIRECT");
  assert.equal(c2.expectedQty, 1);

  // ───────── 4. Một đơn có nhiều lần gửi ─────────
  // Hai vận đơn của cùng đơn o2 đều ghép được, và mỗi kiện đều thấy đủ hàng của đơn — nhưng chúng
  // là HAI kiện vật lý, nên phần tổng hợp phải cộng hai lần chứ không gộp làm một.
  const c2b = ctx.get("rpc-s2b")!;
  assert.equal(c2b.orderId, "rpc-o2", "lần gửi thứ hai vẫn thuộc đúng đơn đó");
  assert.equal(c2b.expectedQty, 1);

  // ───────── 5 + 6. Vận đơn chiều về 1P1 là BẰNG CHỨNG, và hoàn một phần ─────────
  const c3 = ctx.get("rpc-s3leg")!;
  assert.equal(c3.basis, "RETURN_LEG", "vận đơn 1P1 phải lần được về đơn qua MÃ GỐC, không qua người");
  assert.equal(c3.viaBaseCode, "RPC0003", "phải nói được đã lần qua mã gốc nào");
  assert.equal(c3.orderId, "rpc-o3");
  assert.equal(c3.itemsBasis, "ITEM_EVIDENCE", "đơn có return_quantity > 0 là bằng chứng mức món");
  assert.equal(c3.items.length, 1, "hoàn một phần: CHỈ hiện dòng thực sự bị trả, không phải cả đơn");
  assert.equal(c3.items[0].sku, "Q002");
  assert.equal(c3.expectedQty, 1, "đơn bán 3 món mà chỉ 1 món bị trả — không được kỳ vọng cả 3 quay về");

  // ───────── 3. Không lần ra đơn ─────────
  const c4 = ctx.get("rpc-s4")!;
  assert.equal(c4.basis, "UNRESOLVED");
  assert.equal(c4.orderId, null);
  assert.deepEqual(c4.items, [], "không có căn cứ thì không được bịa ra món nào");
  assert.equal(c4.expectedQty, null, "CHƯA BIẾT phải là null — trả 0 là nói dối 'kiện này không có gì'");

  // ───────── 7. Mẫu mã bị xoá / đổi tên ─────────
  const c5 = ctx.get("rpc-s5")!;
  assert.equal(c5.items.length, 1, "mẫu mã bị xoá khỏi bảng biến thể KHÔNG được làm dòng hàng biến mất");
  assert.equal(c5.items[0].sku, "Q009");
  assert.equal(c5.items[0].name, "Áo RPC bản cũ", "tên chụp lúc bán vẫn phải đọc được");
  assert.equal(c5.items[0].size, "Xanh / S", "mất biến thể thì dùng mô tả chụp lúc bán làm phương án hai");
  assert.equal(c5.expectedQty, 2);

  // ───────── Mơ hồ: một mã gốc ra hai đơn ─────────
  const c6 = ctx.get("rpc-s6leg")!;
  assert.equal(c6.basis, "AMBIGUOUS", "mã gốc trỏ tới hai đơn thì KHÔNG được chọn bừa một cái");
  assert.equal(c6.orderId, null);
  assert.equal(c6.expectedQty, null);
  assert.equal(c6.candidateOrderIds.length, 2, "phải nêu cả hai ứng viên để người xử lý tự quyết");

  // ───────── 8. Tổng hợp: chỉ cộng phần ghép được ─────────
  const sum = summarizeReturnItems(ctx.values());
  assert.equal(sum.unmapped, 2, "hai kiện chưa ghép được (không lần ra + mơ hồ) phải đếm riêng");
  assert.equal(sum.mapped, 5);
  assert.equal(sum.expectedUnits, 2 + 1 + 1 + 1 + 2, "chỉ cộng món của kiện đã ghép được — không ước lượng phần chưa biết");
  assert.ok(
    sum.unconfirmedItems >= 1,
    "phải đếm được bao nhiêu kiện mới chỉ biết đơn chứ chưa xác nhận mặt hàng — con số này là mức độ tin cậy của cả bảng",
  );
  // Q002 nằm ở bốn kiện: s1(×1) · s2a(×1) · s2b(×1) · s3leg(×1). Hai lần gửi của cùng đơn o2 là
  // HAI kiện vật lý nên cộng hai lần — kho phải dọn chỗ cho từng kiện, không phải cho từng đơn.
  const q002 = sum.topSkus.find((x) => x.sku === "Q002");
  assert.equal(q002?.qty, 4, "gộp theo mã hàng để kho biết phải dọn chỗ cho bao nhiêu cái mỗi mã");
  assert.equal(sum.topSkus[0].sku, "Q002", "mã nhiều hàng nhất đứng đầu");

  // ───────── 12. Không N+1 ─────────
  // Ghép cho 7 kiện phải tốn đúng ngần ấy truy vấn như ghép cho 1 kiện. Đo bằng số lần gọi thật.
  const dem = { n: 0 };
  const goc = db.execute.bind(db);
  (db as unknown as { execute: typeof goc }).execute = ((...args: Parameters<typeof goc>) => {
    dem.n += 1;
    return goc(...args);
  }) as typeof goc;
  try {
    dem.n = 0;
    await returnProductContext(["rpc-s1"]);
    const motKien = dem.n;
    dem.n = 0;
    await returnProductContext(["rpc-s1", "rpc-s2a", "rpc-s2b", "rpc-s3leg", "rpc-s4", "rpc-s5", "rpc-s6leg"]);
    const bayKien = dem.n;
    assert.equal(bayKien, motKien, `7 kiện phải tốn đúng số truy vấn của 1 kiện (đo được ${motKien} → ${bayKien})`);
    assert.ok(bayKien <= 4, `tối đa 4 truy vấn cho cả danh sách, đo được ${bayKien}`);
  } finally {
    (db as unknown as { execute: typeof goc }).execute = goc;
  }

  console.log(
    `✓ Ghép sản phẩm cho kiện hoàn: ghép thẳng · 1P1 lần qua mã gốc · hoàn một phần chỉ hiện món bị trả · mã gốc ra 2 đơn ⇒ mơ hồ, không chọn bừa · không lần ra ⇒ CHƯA BIẾT (null, không phải 0) · mẫu mã đã xoá vẫn đọc được · ${sum.expectedUnits} món dự kiến từ ${sum.mapped} kiện, ${sum.unmapped} kiện chưa ghép được tính riêng · 7 kiện = 1 kiện về số truy vấn`,
  );
}
