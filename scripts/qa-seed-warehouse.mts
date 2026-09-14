/**
 * ĐỔ DỮ LIỆU CHO LƯỢT KIỂM MẮT khối đo hiệu suất kho hàng hoàn.
 *
 * Chỉ dùng cho CSDL kiểm thử cục bộ — KHÔNG bao giờ chạy trên production (script này ghi thẳng).
 * Nó cố ý dựng đủ mọi nhánh hiển thị: bốn nhóm tuổi, một người đếm có khoá, một lượt đếm vô danh,
 * một phiếu tái nhập hai mẫu mã, và một kiện quá hạn.
 */
import "dotenv/config";

const url = (process.env.DATABASE_URL || "").trim();
if (!url.startsWith("pglite://")) {
  console.error("Từ chối chạy: chỉ đổ dữ liệu vào PGlite cục bộ, không phải CSDL thật.");
  process.exit(1);
}

const { getDb, schema } = await import("@/db");
const db = await getDb();
const P = "qa-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm lụa kiểm thử" }).onConflictDoNothing();
await db
  .insert(schema.productVariants)
  .values([
    { id: `${P}v1`, productId: `${P}p1`, sku: "Q002-DO-M", color: "Đỏ", size: "M" },
    { id: `${P}v2`, productId: `${P}p1`, sku: "Q002-XANH-L", color: "Xanh", size: "L" },
  ])
  .onConflictDoNothing();
await db
  .insert(schema.users)
  .values([
    // Tài khoản mà lượt kiểm mắt đăng nhập bằng — `sub` của phiếu JWT phải khớp `id` này, nếu không
    // máy chủ đá về trang đăng nhập và mọi khẳng định về nội dung đều sai vì lý do không liên quan.
    { id: "qa-admin", email: "qa@local", name: "QA Kho", role: "ADMIN", passwordHash: "x" },
    { id: `${P}u1`, email: "kho1@test.vn", name: "Nguyễn Thị Kho", role: "WAREHOUSE", passwordHash: "x" },
    { id: `${P}u2`, email: "kho2@test.vn", name: "Trần Văn Đếm", role: "WAREHOUSE", passwordHash: "x" },
  ])
  .onConflictDoNothing();

// Bốn kiện CHỜ ĐẾM, mỗi kiện rơi vào một nhóm tuổi khác nhau.
const choDem = [6, 30, 60, 100];
for (const [i, h] of choDem.entries()) {
  const id = `${P}s-cho-${i}`;
  await db
    .insert(schema.shipments)
    .values({ id, vtpOrderNumber: `QA-CHO-${i}`, trackingCode: `QA-CHO-${i}`, carrier: "VTP", stage: "RETURNED" })
    .onConflictDoNothing();
  await db.insert(schema.returnInspections).values({ id: `${P}i-cho-${i}`, shipmentId: id, status: "RECEIVED", receivedAt: gio(h) }).onConflictDoNothing();
}

// Một phiếu tái nhập HAI mẫu mã của CÙNG một kiện — chứng minh "một kiện nhiều món vẫn là một kiện".
await db
  .insert(schema.shipments)
  .values({ id: `${P}s-xong`, vtpOrderNumber: "QA-XONG", trackingCode: "QA-XONG", carrier: "VTP", stage: "RETURNED" })
  .onConflictDoNothing();
await db
  .insert(schema.stockReceipts)
  .values({ id: `${P}r1`, kind: "RETURN", receivedAt: gio(3), reference: "Đếm hàng hoàn QA", totalQuantity: 3 })
  .onConflictDoNothing();
await db
  .insert(schema.stockReceiptItems)
  .values([
    { id: `${P}ri1`, receiptId: `${P}r1`, variantId: `${P}v1`, quantity: 2, shipmentId: `${P}s-xong` },
    { id: `${P}ri2`, receiptId: `${P}r1`, variantId: `${P}v2`, quantity: 1, shipmentId: `${P}s-xong` },
  ])
  .onConflictDoNothing();
await db
  .insert(schema.returnInspections)
  .values({
    id: `${P}i-xong`,
    shipmentId: `${P}s-xong`,
    status: "INSPECTED",
    receivedAt: gio(5),
    inspectedAt: gio(3),
    inspectedBy: "Nguyễn Thị Kho",
    inspectedByUserId: `${P}u1`,
    condition: "RESTOCKABLE",
    restockQty: 3,
    unsellableQty: 1,
    stockReceiptId: `${P}r1`,
  })
  .onConflictDoNothing();

// Một kiện hỏng do người thứ hai đếm, và một lượt đếm VÔ DANH (không có khoá tài khoản).
for (const [i, spec] of [
  { who: `${P}u2`, ten: "Trần Văn Đếm", dk: "DAMAGED" as const },
  { who: null, ten: "Ghi tay không rõ ai", dk: "MISSING" as const },
].entries()) {
  const id = `${P}s-hong-${i}`;
  await db
    .insert(schema.shipments)
    .values({ id, vtpOrderNumber: `QA-HONG-${i}`, trackingCode: `QA-HONG-${i}`, carrier: "VTP", stage: "RETURNED" })
    .onConflictDoNothing();
  await db
    .insert(schema.returnInspections)
    .values({
      id: `${P}i-hong-${i}`,
      shipmentId: id,
      status: "INSPECTED",
      receivedAt: gio(20),
      inspectedAt: gio(2),
      inspectedBy: spec.ten,
      inspectedByUserId: spec.who,
      condition: spec.dk,
      note: "hàng về không nguyên vẹn",
      restockQty: 0,
      unsellableQty: 2,
    })
    .onConflictDoNothing();
}

const [dem] = await db.select({ n: (await import("drizzle-orm")).sql<number>`count(*)` }).from(schema.returnInspections);
console.log(`✓ đã đổ dữ liệu kiểm mắt · ${Number(dem?.n ?? 0)} phiếu kiểm`);
process.exit(0);
