/**
 * NỀN TẢNG — KỊCH BẢN CHẤP NHẬN QUAN TRỌNG NHẤT CỦA PHASE 1 (yêu cầu mục 55) + tấn công truy cập
 * trực tiếp theo id (mục 30).
 *
 *   Tổ chức A: bật Đơn hàng · Kho · Sản xuất        Tổ chức B: bật Đơn hàng · Kho, TẮT Sản xuất
 *   Đơn A, đơn B. Người A thấy A không thấy B; người B thấy B không thấy A.
 *   Người B mở /production ⇒ chặn. Người A ⇒ được. Bật Sản xuất cho B ⇒ người B mở được NGAY —
 *   cùng tiến trình, không deploy, không khởi động lại.
 *
 * Hai tổ chức là hai CSDL PGlite THẬT (không giả lập), người dùng là tài khoản thật trong CSDL của
 * từng tổ chức, "request" là token phiên ký bằng đúng khoá của ứng dụng và đi qua đúng đường xác
 * minh (`setSessionTokenSourceForTests` chỉ thay NGUỒN token, không thay phép xác minh).
 * Tự dọn: mã tổ chức `pq-`, dòng nhà mang tiền tố `pq-`.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { SignJWT } from "jose";
import { env } from "@/lib/env";
import { getEnabledModules, pathAccess } from "@/lib/platform/capabilities";
import { currentOrganization, setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { setOrganizationModule } from "@/lib/platform/module-config";
import { provisionOrganization } from "@/lib/platform/provision";

const A = "pq-alpha";
const B = "pq-beta";

type Seeded = { orderId: string; customerId: string; productId: string; shipmentId: string; workItemId: string; productionOrderId: string | null; userId: string; email: string };

async function seed(org: string, withProduction: boolean): Promise<Seeded> {
  return withOrganization(org, async () => {
    const db = await getDb();
    const customerId = `${org}-cus`;
    const productId = `${org}-prd`;
    const orderId = `${org}-ord`;
    await db.insert(schema.customers).values({ id: customerId, name: `Khách của ${org}` });
    await db.insert(schema.products).values({ id: productId, name: `Sản phẩm của ${org}` });
    await db.insert(schema.orders).values({ id: orderId, customerId, billFullName: `Đơn của ${org}`, insertedAt: new Date() });
    const [ship] = await db.insert(schema.shipments).values({ orderId, vtpOrderNumber: `${org}-VD1` }).returning({ id: schema.shipments.id });
    const workItemId = `${org}-wi`;
    await db.insert(schema.workItems).values({ id: workItemId, sourceType: "MANUAL_TASK", sourceKey: workItemId, authority: "WORK", status: "NEW", title: `Việc của ${org}` });
    let productionOrderId: string | null = null;
    if (withProduction) {
      const [po] = await db.insert(schema.productionOrders).values({ code: `${org}-PO1` }).returning({ id: schema.productionOrders.id });
      productionOrderId = po.id;
    }
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(user, `quản trị của ${org} có trong CSDL của ${org}`);
    return { orderId, customerId, productId, shipmentId: ship.id, workItemId, productionOrderId, userId: user.id, email: user.email };
  });
}

async function asUser<T>(org: string, who: Seeded, fn: () => Promise<T>): Promise<T> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: who.email, name: "Quản trị", role: "ADMIN", org, lgn: now })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(who.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(new TextEncoder().encode(env.authSecret));
  setSessionTokenSourceForTests(async () => token);
  try {
    const ctx = await currentOrganization();
    assert.equal(ctx.code, org, "token phiên quyết định tổ chức");
    assert.equal(ctx.source, "SESSION");
    return await fn();
  } finally {
    setSessionTokenSourceForTests(null);
  }
}

/** Mọi lối đọc theo id mà một kẻ tấn công ở tổ chức kia có thể thử. */
async function visible(target: Seeded) {
  const db = await getDb();
  return {
    order: !!(await db.query.orders.findFirst({ where: eq(schema.orders.id, target.orderId) })),
    customer: !!(await db.query.customers.findFirst({ where: eq(schema.customers.id, target.customerId) })),
    product: !!(await db.query.products.findFirst({ where: eq(schema.products.id, target.productId) })),
    shipment: !!(await db.query.shipments.findFirst({ where: eq(schema.shipments.id, target.shipmentId) })),
    task: !!(await db.query.workItems.findFirst({ where: eq(schema.workItems.id, target.workItemId) })),
    productionOrder: target.productionOrderId ? !!(await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, target.productionOrderId) })) : false,
    // SQL thô — đúng dạng 1.879 đoạn SQL của kho: không có một mệnh đề lọc tổ chức nào, vẫn không thấy.
    rawOrderCount: Number(((await db.execute(sql`select count(*)::int as n from orders where id = ${target.orderId}`)) as unknown as { rows: { n: number }[] }).rows[0].n),
  };
}

export async function testPlatformIsolation() {
  for (const code of [A, B]) rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });

  // ── Cấp hai tổ chức: A có Sản xuất, B không ──
  await provisionOrganization({ code: A, name: "Tổ chức A", modules: ["customers", "products", "orders", "inventory", "production"], admin: { email: `admin@${A}.local`, name: "QT A", password: "Alpha@12345" }, source: "TEST", actor: null });
  await provisionOrganization({ code: B, name: "Tổ chức B", modules: ["customers", "products", "orders", "inventory"], admin: { email: `admin@${B}.local`, name: "QT B", password: "Beta@12345" }, source: "TEST", actor: null });
  const a = await seed(A, true);
  const b = await seed(B, false);
  const homeDb = await getPlatformDb();
  await homeDb.insert(schema.orders).values({ id: "pq-home-ord", billFullName: "Đơn của tổ chức nhà", insertedAt: new Date() });

  // ── Người A thấy A, không thấy B; người B thấy B, không thấy A (kể cả truy cập thẳng theo id) ──
  await asUser(A, a, async () => {
    assert.deepEqual(await visible(a), { order: true, customer: true, product: true, shipment: true, task: true, productionOrder: true, rawOrderCount: 1 }, "người A thấy mọi thứ của A");
    assert.deepEqual(await visible(b), { order: false, customer: false, product: false, shipment: false, task: false, productionOrder: false, rawOrderCount: 0 }, "người A KHÔNG thấy gì của B dù biết id");
    const db = await getDb();
    assert.equal(await db.query.orders.findFirst({ where: eq(schema.orders.id, "pq-home-ord") }), undefined, "người A không thấy đơn của tổ chức nhà");
    // Ghi theo id của B (PATCH sản phẩm / đơn của tổ chức khác) — 0 dòng bị chạm.
    const up1 = await db.update(schema.orders).set({ billFullName: "BỊ SỬA" }).where(eq(schema.orders.id, b.orderId)).returning({ id: schema.orders.id });
    const up2 = await db.update(schema.products).set({ name: "BỊ SỬA" }).where(eq(schema.products.id, b.productId)).returning({ id: schema.products.id });
    const del = await db.delete(schema.workItems).where(eq(schema.workItems.id, b.workItemId)).returning({ id: schema.workItems.id });
    assert.equal(up1.length + up2.length + del.length, 0, "ghi / xoá theo id của B từ phiên A không chạm dòng nào");
  });
  await asUser(B, b, async () => {
    assert.deepEqual(await visible(b), { order: true, customer: true, product: true, shipment: true, task: true, productionOrder: false, rawOrderCount: 1 });
    assert.deepEqual(await visible(a), { order: false, customer: false, product: false, shipment: false, task: false, productionOrder: false, rawOrderCount: 0 }, "người B KHÔNG thấy gì của A dù biết id");
  });
  await withOrganization(B, async () => {
    const db = await getDb();
    const row = await db.query.orders.findFirst({ where: eq(schema.orders.id, b.orderId) });
    assert.equal(row?.billFullName, `Đơn của ${B}`, "đơn của B nguyên vẹn sau lượt tấn công từ A");
  });
  assert.equal(await homeDb.query.orders.findFirst({ where: eq(schema.orders.id, a.orderId) }), undefined, "CSDL nhà không có đơn của A");

  // ── Module: B không có Sản xuất ⇒ /production bị chặn; A có ⇒ được ──
  await asUser(B, b, async () => {
    assert.deepEqual(await pathAccess("/production"), { module: "production", enabled: false }, "người B mở /production ⇒ chặn");
    assert.deepEqual(await pathAccess("/inventory/planning"), { module: "production", enabled: false }, "trang con của Sản xuất nằm dưới /inventory cũng bị chặn");
    assert.equal((await pathAccess("/orders")).enabled, true);
    for (const off of ["marketing", "payroll", "tech", "connector_pancake", "integrations"]) assert.ok(!(await getEnabledModules()).has(off as never), `B không có ${off}`);
  });
  await asUser(A, a, async () => assert.deepEqual(await pathAccess("/production"), { module: "production", enabled: true }, "người A mở /production ⇒ được"));

  // ── Bật Sản xuất cho B — KHÔNG deploy, không khởi động lại: có hiệu lực ngay ──
  const actor = { orgCode: B, userId: b.userId, email: b.email };
  const on = await setOrganizationModule({ orgCode: B, moduleKey: "production", enabled: true, reason: "Kiểm thử §55", actor, source: "TEST" });
  assert.deepEqual(on, { ok: true, changed: true });
  await asUser(B, b, async () => assert.equal((await pathAccess("/production")).enabled, true, "bật xong ⇒ người B mở /production được ngay"));
  // Phụ thuộc: tắt Kho khi Sản xuất đang dựa vào nó ⇒ chặn + giải thích, không để trạng thái hỏng.
  const blocked = await setOrganizationModule({ orgCode: B, moduleKey: "inventory", enabled: false, actor, source: "TEST" });
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.code, "HAS_DEPENDENTS");
  // Connector dùng credential của tổ chức nhà ⇒ tổ chức khác không bật được (fail closed).
  const conn = await setOrganizationModule({ orgCode: B, moduleKey: "connector_pancake", enabled: true, actor, source: "TEST" });
  assert.equal(!conn.ok && conn.code, "REQUIRES_HOME_CREDENTIALS");
  const off = await setOrganizationModule({ orgCode: B, moduleKey: "production", enabled: false, reason: "Kiểm thử §55 — tắt lại", actor, source: "TEST" });
  assert.deepEqual(off, { ok: true, changed: true });
  await asUser(B, b, async () => assert.equal((await pathAccess("/production")).enabled, false, "tắt lại ⇒ chặn lại ngay"));
  // A không bị ảnh hưởng bởi lượt đổi của B.
  await asUser(A, a, async () => assert.equal((await pathAccess("/production")).enabled, true));

  // ── Nhật ký: mỗi lượt đổi có vết ở CẢ HAI nơi ──
  const pa = await homeDb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, B));
  const changes = pa.filter((r) => r.subject === "production" && r.source === "TEST" && r.actorUserId === b.userId);
  assert.deepEqual(changes.map((r) => r.action).sort(), ["MODULE_DISABLE", "MODULE_ENABLE"], "nhật ký nền tảng: ai, bật rồi tắt");
  await withOrganization(B, async () => {
    const db = await getDb();
    const tenantLog = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "PLATFORM_MODULE"));
    assert.equal(tenantLog.filter((r) => r.entityId === "production").length, 2, "quản trị của B thấy hai lượt đổi trong nhật ký của chính họ");
    assert.equal(tenantLog.every((r) => r.userId === b.userId), true, "người bấm là thành viên B ⇒ khoá tài khoản được ghi");
  });

  // Dọn
  await homeDb.delete(schema.orders).where(eq(schema.orders.id, "pq-home-ord"));
  console.log("✓ Nền tảng · kịch bản §55: hai tổ chức, đọc/ghi theo id của tổ chức kia chạm 0 dòng (kể cả SQL thô) · Sản xuất bật/tắt cho B có hiệu lực ngay, không deploy · phụ thuộc chặn + giải thích · connector của nhà không bật được · nhật ký hai nơi");
}
