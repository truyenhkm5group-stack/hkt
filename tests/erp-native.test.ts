/**
 * ═══════════ «CHUYỂN HẲN SANG ERP» — SHOP ĐẾN TỪ PANCAKE (ORDER_OUTCOME.md mục 11.3 · chủ shop chốt 04/10/2026) ═══════════
 *
 * Shop nhập lịch sử đơn Pancake rồi tắt kết nối: CSDL có đơn không `erp-`, nên phép nhận diện «tổ chức đồng bộ đơn» theo dữ
 * liệu đẩy MỌI đơn ERP mới ra khỏi báo cáo (doanh thu, lợi nhuận, marketer). Bài này khoá:
 *  · TRƯỚC tuyên bố: có một đơn Pancake ⇒ đơn ERP ĐỨNG NGOÀI `IN_SALES_REPORTS` (hành vi cũ, đúng cho tổ chức còn đồng bộ);
 *  · thiếu `settings:manage` ⇒ từ chối, không ghi gì;
 *  · tuyên bố ⇒ đơn ERP VÀO `IN_SALES_REPORTS`, đơn Pancake vẫn vào (lịch sử giữ nguyên); có nhật ký; bấm lần hai ⇒ từ chối;
 *  · tổ chức NHÀ không bao giờ tuyên bố được và không thấy khung (luật 3.9 của nhà không đổi một đơn).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { ERP_NATIVE_SETTING_KEY } from "@/lib/constants/manual-orders";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { IN_SALES_REPORTS } from "@/lib/queries/manual-order-sql";
import { createManualOrderCore, declareErpNativeCore, erpNativeView } from "@/lib/records/order-create";

const ORG = "chuyen-han-erp";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const inReports = async (orderId: string) => {
  const db = await getDb();
  const [r] = await db.select({ v: IN_SALES_REPORTS }).from(schema.orders).where(eq(schema.orders.id, orderId));
  return r?.v === true;
};

export async function testErpNative() {
  await cleanupOrg(ORG);
  try {
    await provisionOrganization({ code: ORG, name: "Shop chuyển từ Pancake", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "ChuyenHan@123" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop chuyển từ Pancake", isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const sales = { ...admin, role: "MANAGER", permissions: ["orders:read", "orders:write"] } as unknown as SessionUser;

      const [c] = await db.insert(schema.customers).values({ name: "Chị Mai", phone: "0912000111", address: "1 Hàng Bài", province: "Hà Nội" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-ch-prod", name: "Váy", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-ch-var", productId: "erp-ch-prod", sku: "VAY-M", retailPrice: 300_000 });
      const made = await createManualOrderCore(admin, { customerId: c.id, stage: "CONFIRMED", channel: "Fanpage", note: "", orderDiscount: 0, shippingFee: 0, lines: [{ variantId: "erp-ch-var", quantity: 1, unitPrice: 300_000, discount: 0 }] });
      assert.ok(made.ok, JSON.stringify(made));

      // Chỉ có đơn ERP ⇒ đã vào báo cáo, không cần khung.
      assert.equal(await inReports(made.id), true);
      assert.equal((await erpNativeView(admin))?.hasSyncedOrders, false, "không có đơn Pancake ⇒ không hiện khung");

      // Nhập lịch sử Pancake (một đơn không `erp-`) ⇒ phép nhận diện theo dữ liệu đẩy đơn ERP RA NGOÀI — đúng cái bẫy cần sửa.
      await db.insert(schema.orders).values({ id: "777001", stage: "DELIVERED", status: 3, billFullName: "Khách Pancake cũ", totalPrice: 250_000, totalPriceAfterDiscount: 250_000, insertedAt: new Date() });
      assert.equal(await inReports(made.id), false, "trước tuyên bố: đơn ERP đứng ngoài báo cáo");
      assert.equal(await inReports("777001"), true);
      const view = await erpNativeView(admin);
      assert.ok(view && view.hasSyncedOrders && view.canDeclare && !view.declared, JSON.stringify(view));

      // Thiếu quyền cấu hình ⇒ từ chối, không ghi.
      const denied = await declareErpNativeCore(sales);
      assert.ok(!denied.ok && denied.code === "FORBIDDEN", JSON.stringify(denied));
      assert.equal((await db.select().from(schema.settings).where(eq(schema.settings.key, ERP_NATIVE_SETTING_KEY))).length, 0);

      // Tuyên bố ⇒ đơn ERP vào báo cáo; lịch sử Pancake vẫn vào; có nhật ký; bấm lần hai ⇒ từ chối.
      const ok = await declareErpNativeCore(admin);
      assert.ok(ok.ok, JSON.stringify(ok));
      assert.equal(await inReports(made.id), true, "sau tuyên bố: đơn ERP vào mọi báo cáo");
      assert.equal(await inReports("777001"), true, "đơn Pancake đã nhập giữ nguyên làm lịch sử");
      const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "ORDERS_ERP_NATIVE"));
      assert.equal(logs.length, 1);
      const again = await declareErpNativeCore(admin);
      assert.ok(!again.ok && again.code === "CONFLICT");
      assert.ok((await erpNativeView(admin))?.declared);
    });

    // Tổ chức NHÀ: không thấy khung, không tuyên bố được.
    await withOrganization((await getHomeOrganization()).code, async () => {
      const home = { id: "home-admin", email: "admin@home.local", name: "QT nhà", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null } as unknown as SessionUser;
      assert.equal(await erpNativeView(home), null);
      const r = await declareErpNativeCore(home);
      assert.ok(!r.ok && r.code === "NOT_SUPPORTED", JSON.stringify(r));
      assert.equal((await (await getDb()).select().from(schema.settings).where(eq(schema.settings.key, ERP_NATIVE_SETTING_KEY))).length, 0, "nhà không bao giờ có dòng này");
    });
  } finally {
    await cleanupOrg(ORG);
  }
  console.log("  ✓ Chuyển hẳn sang ERP: có đơn Pancake đã nhập ⇒ đơn ERP đứng ngoài báo cáo (bẫy cũ); thiếu quyền ⇒ từ chối, không ghi; tuyên bố ⇒ đơn ERP vào báo cáo, lịch sử Pancake giữ nguyên, có nhật ký, bấm lần hai bị chặn; tổ chức nhà không thấy khung, không tuyên bố được");
}
