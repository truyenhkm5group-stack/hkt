/**
 * BẢO HÀNH & ĐỔI TRẢ THEO SERIAL (module `warranty`, 0196 · docs/verticals/household.md) + mẫu ngành «Gia dụng».
 *
 *  1. THUẦN — hạn = ngày mua + N tháng (31/01 + 1 tháng = cuối tháng 2, năm nhuận đúng), ngày hết hạn vẫn còn bảo hành, phiếu
 *     huỷ, chuyển trạng thái ca (xong / từ chối không đổi nữa), chuẩn hoá serial; mẫu hợp lệ, module TẮT ở nhà.
 *  2. TỔ CHỨC THẬT (`wr-shop`, cài mẫu gia dụng): quyền warranty:write; serial trùng (không phân biệt hoa thường) bị chặn khi
 *     phiếu cũ còn hiệu lực, huỷ phiếu cũ thì lập lại được; ngày mua tương lai bị chặn; ca trên phiếu huỷ bị chặn; «ngoài hạn»
 *     tính đúng; xong cần cách xử lý, từ chối cần lý do; tiền trống = chưa biết; tra theo SĐT (bỏ ký tự) / serial; hàng đợi ca
 *     chỉ ca đang mở.
 *
 * Mốc ngày đi theo ĐỒNG HỒ THẬT (luật 50): ngày mua dựng tương đối từ hôm nay.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { HOUSEHOLD_BLUEPRINT } from "@/lib/blueprints/templates/household";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { moduleDef } from "@/lib/constants/platform-modules";
import { canTransitionClaim, inWarrantyOn, normalizeSerial, warrantyCardState, warrantyExpiry } from "@/lib/constants/warranty";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { openWarrantyClaims, searchWarrantyCards } from "@/lib/queries/warranty";
import { advanceWarrantyClaimCore, createWarrantyCardCore, openWarrantyClaimCore, voidWarrantyCardCore } from "@/lib/records/warranty";

const ORG = "wr-shop";

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const codeOf = (r: { ok: true } | { ok: false; code: string }) => (r.ok ? "OK" : r.code);
const fieldsOf = (r: { ok: true } | { ok: false; errors: { field: string }[] }) => (r.ok ? [] : r.errors.map((e) => e.field));
const vnDay = (offsetDays = 0) => new Date(Date.now() + 7 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

function testPure() {
  assert.equal(warrantyExpiry("2026-01-31", 1), "2026-02-28", "tháng đích ngắn hơn ⇒ ngày cuối tháng");
  assert.equal(warrantyExpiry("2028-01-31", 1), "2028-02-29", "năm nhuận");
  assert.equal(warrantyExpiry("2026-03-15", 12), "2027-03-15");
  assert.equal(warrantyExpiry("2026-11-30", 3), "2027-02-28", "qua năm + tháng ngắn");
  assert.equal(warrantyExpiry("2026-02-30", 12), null, "ngày không có thật");
  assert.equal(warrantyExpiry("2026-01-01", 0), null);
  assert.equal(warrantyExpiry("2026-01-01", 121), null);
  assert.ok(inWarrantyOn("2026-12-31", "2026-12-31"), "ngày hết hạn vẫn còn bảo hành");
  assert.ok(!inWarrantyOn("2026-12-31", "2027-01-01"));
  assert.deepEqual(warrantyCardState({ status: "ACTIVE", expiresOn: "2026-12-31" }, "2026-12-21"), { state: "IN_WARRANTY", daysLeft: 10 });
  assert.deepEqual(warrantyCardState({ status: "ACTIVE", expiresOn: "2026-12-31" }, "2027-01-05"), { state: "EXPIRED", daysLeft: -5 });
  assert.equal(warrantyCardState({ status: "VOID", expiresOn: "2099-01-01" }, "2026-01-01").state, "VOID");
  assert.ok(canTransitionClaim("OPEN", "DONE") && canTransitionClaim("IN_PROGRESS", "REJECTED"));
  assert.ok(!canTransitionClaim("DONE", "REJECTED") && !canTransitionClaim("REJECTED", "OPEN") && !canTransitionClaim("IN_PROGRESS", "OPEN"), "ca đã đóng không đổi; không lùi về mới");
  assert.equal(normalizeSerial("  SN  001 "), "SN 001");
  assert.equal(normalizeSerial("   "), null);

  const v = validateBlueprint(HOUSEHOLD_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(BUSINESS_TYPE_SPEC.household.templateKey, "household");
  assert.equal(moduleDef("warranty")?.homeOptIn, true, "module bảo hành TẮT ở tổ chức nhà");
}

export async function testWarranty() {
  testPure();
  const home = await getHomeOrganization();
  assert.ok(!(await getEnabledModules(home.code)).has("warranty"), "0196: tổ chức nhà KHÔNG bật bảo hành");
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Gia dụng thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT gia dụng", password: "GiaDung@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (over: Partial<SessionUser> = {}): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT gia dụng", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Gia dụng thử", isHome: false }, modules: [...(await getEnabledModules(ORG))], ...over });
      let admin = await sessionOf();
      const plan = await planForOrg(HOUSEHOLD_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      assert.ok((await installBlueprint(HOUSEHOLD_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      assert.deepEqual([...(await getEnabledModules(ORG))].sort(), [...HOUSEHOLD_BLUEPRINT.modules].sort());
      admin = await sessionOf();
      const viewer = await sessionOf({ role: "VIEWER", permissions: ["warranty:view", "customers:view"] });

      const [kh] = await db.insert(schema.customers).values({ name: "Chị Hằng", phone: "0903 111 222" }).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-wr-prod", name: "Nồi chiên không dầu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-wr-v", productId: "erp-wr-prod", sku: "NCKD-5L", size: "5 lít", retailPrice: 1_490_000 });
      const card = (over: Record<string, unknown> = {}) => ({ customerId: kh.id, variantId: "erp-wr-v", serial: "SN-001", purchasedOn: vnDay(-30), months: 12, ...over });

      assert.equal(codeOf(await createWarrantyCardCore(viewer, card())), "FORBIDDEN");
      const c1 = await createWarrantyCardCore(admin, card());
      assert.ok(c1.ok, JSON.stringify(c1));
      const [row1] = await db.select().from(schema.warrantyCards).where(eq(schema.warrantyCards.id, c1.id));
      assert.equal(row1.expiresOn, warrantyExpiry(vnDay(-30), 12), "hạn do máy chủ tính");
      assert.equal(row1.productName, "Nồi chiên không dầu · 5 lít", "tên sản phẩm chụp lại");
      assert.deepEqual(fieldsOf(await createWarrantyCardCore(admin, card({ serial: " sn-001 " }))), ["serial"], "serial trùng (khác hoa thường) ⇒ chặn");
      assert.deepEqual(fieldsOf(await createWarrantyCardCore(admin, card({ serial: "SN-002", purchasedOn: vnDay(3) }))), ["purchasedOn"], "ngày mua tương lai ⇒ chặn");
      const old = await createWarrantyCardCore(admin, card({ serial: "SN-OLD", purchasedOn: vnDay(-400), months: 12 }));
      assert.ok(old.ok);

      // Ca bảo hành.
      const v1 = await voidWarrantyCardCore(admin, c1.id, "x");
      assert.deepEqual(fieldsOf(v1), ["reason"], "huỷ phiếu cần lý do");
      const cl1 = await openWarrantyClaimCore(admin, c1.id, { issue: "Không lên nguồn" });
      assert.ok(cl1.ok, JSON.stringify(cl1));
      assert.deepEqual(fieldsOf(await openWarrantyClaimCore(admin, c1.id, { issue: "lỗi" })), ["issue"], "mô tả lỗi ≥ 5 ký tự");
      const clOld = await openWarrantyClaimCore(admin, old.id, { issue: "Quạt kêu to bất thường" });
      assert.ok(clOld.ok);
      assert.deepEqual(fieldsOf(await advanceWarrantyClaimCore(admin, cl1.id, { status: "DONE" })), ["resolution"], "xong cần cách xử lý");
      assert.deepEqual(fieldsOf(await advanceWarrantyClaimCore(admin, cl1.id, { status: "REJECTED", rejectReason: "" })), ["rejectReason"], "từ chối cần lý do");
      assert.ok((await advanceWarrantyClaimCore(admin, cl1.id, { status: "IN_PROGRESS" })).ok);
      const [inProg] = await db.select().from(schema.warrantyClaims).where(eq(schema.warrantyClaims.id, cl1.id));
      assert.equal(inProg.assigneeUserId, u.id, "nhận xử lý ⇒ giao cho người bấm khi chưa có người nhận");
      assert.ok((await advanceWarrantyClaimCore(admin, cl1.id, { status: "DONE", resolution: "REPAIRED", costVnd: 150_000, chargedVnd: null })).ok);
      const [done] = await db.select().from(schema.warrantyClaims).where(eq(schema.warrantyClaims.id, cl1.id));
      assert.ok(done.closedAt && done.resolution === "REPAIRED" && done.costVnd === 150_000 && done.chargedVnd === null, "tiền thu khách trống = chưa biết, không phải 0");
      assert.equal(codeOf(await advanceWarrantyClaimCore(admin, cl1.id, { status: "REJECTED", rejectReason: "Nhầm" })), "CONFLICT", "ca đã xong không đổi nữa");

      // Tra cứu + hàng đợi.
      const bySdt = await searchWarrantyCards("111222");
      assert.equal(bySdt.length, 2, "SĐT có dấu cách vẫn tra được bằng chữ số");
      const bySerial = await searchWarrantyCards("sn-old");
      assert.equal(bySerial.length, 1);
      assert.equal(bySerial[0].state, "EXPIRED");
      assert.equal(bySerial[0].claims[0].inWarrantyWhenOpened, false, "ca mở sau hạn ⇒ ngoài bảo hành");
      const c1View = bySdt.find((c) => c.id === c1.id)!;
      assert.ok(c1View.state === "IN_WARRANTY" && c1View.claims[0].inWarrantyWhenOpened);
      const queue = await openWarrantyClaims();
      assert.deepEqual(queue.map((q) => q.id), [clOld.id], "hàng đợi chỉ ca đang mở");

      // Huỷ phiếu ⇒ không mở ca được nữa, serial lập lại được.
      assert.ok((await voidWarrantyCardCore(admin, c1.id, "Khách trả hàng")).ok);
      assert.equal(codeOf(await openWarrantyClaimCore(admin, c1.id, { issue: "Lỗi lần hai" })), "CONFLICT");
      assert.ok((await createWarrantyCardCore(admin, card({ serial: "SN-001", purchasedOn: vnDay(-1) }))).ok, "phiếu cũ huỷ ⇒ serial dùng lại được");
      assert.equal((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "WARRANTY_CARD"))).length >= 4, true, "mọi lượt ghi có nhật ký");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ bảo hành theo serial: hạn tính đúng cuối tháng / năm nhuận, ngày hết hạn còn bảo hành; serial trùng chặn (không phân biệt hoa thường), huỷ thì dùng lại; ngày mua tương lai chặn; ngoài hạn tính lúc đọc; xong cần cách xử lý, từ chối cần lý do, ca đóng không đổi; tiền trống = chưa biết; tra theo SĐT / serial; mẫu Gia dụng cài đúng module; nhà TẮT");
}
