/**
 * NHẮC MUA LẠI + SỔ LIÊN HỆ KHÁCH (0189 · docs/verticals/reorder-reminders.md).
 *
 *  1. THUẦN — trung vị khoảng cách (≥ 2 ngày mua, cùng ngày đếm một), thứ tự nguồn chu kỳ (của khách → mặc định → chưa
 *     biết, KHÔNG số đoán), ranh giới sắp đến hạn / đến hạn, hẹn lại / không mua nữa chỉ áp khi SAU đơn gần nhất.
 *  2. TỔ CHỨC THẬT (PGlite riêng, không Pancake): chỉ đơn ĐÃ CHỐT / ĐÃ GIAO là một lần mua; chu kỳ mặc định chỉ người có
 *     settings:manage khai; ghi liên hệ cần customers:write, hẹn ngày phải sau hôm nay; người làm đi bằng khoá tài khoản.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { medianGapDays, reorderState, type ReorderSetting } from "@/lib/constants/reorder";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { loadReorderBoard } from "@/lib/queries/reorder";
import { createManualOrderCore } from "@/lib/records/order-create";
import { recordTouchpointCore, setReorderSettingCore } from "@/lib/records/touchpoints";

const ORG = "ro-si";

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

function testPure() {
  assert.equal(medianGapDays(["2026-09-01"]), null, "một lần mua ⇒ chưa đo được");
  assert.equal(medianGapDays(["2026-09-01", "2026-09-01"]), null, "hai đơn CÙNG ngày là một lần mua");
  assert.equal(medianGapDays(["2026-09-01", "2026-09-08", "2026-09-15", "2026-10-15"]), 7, "trung vị — một lần nghỉ dài không kéo lệch nhịp");
  assert.equal(medianGapDays(["2026-09-01", "2026-09-05", "2026-09-15"]), 7, "số khoảng chẵn ⇒ trung bình hai giữa (4, 10 ⇒ 7)");

  const none: ReorderSetting = { defaultCycleDays: null, dueSoonDays: 3 };
  const def: ReorderSetting = { defaultCycleDays: 10, dueSoonDays: 3 };
  const today = "2026-10-02";
  assert.equal(reorderState({ orderDays: ["2026-09-01"], today, setting: none, lastTouch: null }).status, "UNKNOWN", "một lần mua + chưa khai mặc định ⇒ CHƯA BIẾT, không đoán");
  const d = reorderState({ orderDays: ["2026-09-01"], today, setting: def, lastTouch: null });
  assert.deepEqual([d.status, d.cycleSource, d.expectedOn, d.daysUntil], ["DUE", "DEFAULT", "2026-09-11", -21]);
  const own = (days: string[]) => reorderState({ orderDays: days, today, setting: def, lastTouch: null });
  assert.equal(own(["2026-09-18", "2026-09-25"]).status, "DUE", "hạn 2026-10-02 = hôm nay ⇒ đến hạn");
  assert.equal(own(["2026-09-20", "2026-09-27"]).status, "DUE_SOON", "còn 2 ngày ≤ 3");
  assert.equal(own(["2026-09-22", "2026-09-29"]).status, "NOT_DUE", "còn 4 ngày");
  assert.equal(own(["2026-09-18", "2026-09-25"]).cycleSource, "OWN", "có ≥ 2 lần mua ⇒ chu kỳ của khách thắng mặc định");

  const base = { orderDays: ["2026-09-01"], today, setting: def };
  assert.equal(reorderState({ ...base, lastTouch: { on: "2026-09-30", outcome: "NOT_NOW", nextContactOn: "2026-10-05" } }).status, "SNOOZED");
  assert.equal(reorderState({ ...base, lastTouch: { on: "2026-09-30", outcome: "NOT_NOW", nextContactOn: "2026-10-02" } }).status, "DUE", "tới ngày hẹn ⇒ quay lại danh sách");
  assert.equal(reorderState({ ...base, lastTouch: { on: "2026-09-30", outcome: "NO_ANSWER", nextContactOn: null } }).status, "DUE", "không ai nghe KHÔNG giấu khách đi");
  assert.equal(reorderState({ ...base, lastTouch: { on: "2026-09-30", outcome: "DECLINED", nextContactOn: null } }).status, "DECLINED");
  assert.equal(reorderState({ ...base, orderDays: ["2026-09-01", "2026-10-01"], lastTouch: { on: "2026-09-30", outcome: "DECLINED", nextContactOn: null } }).status === "DECLINED", false, "đặt đơn SAU lời từ chối ⇒ tự mở lại");
}

export async function testReorderReminders() {
  testPure();
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản nhắc mua", plan: "standard", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT nhắc", password: "NhacMua@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const org = { code: ORG, name: "Hải sản nhắc mua", isHome: false };
      const admin: SessionUser = { id: u.id, email: u.email, name: "QT nhắc", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: org };
      const viewer: SessionUser = { ...admin, role: "VIEWER", permissions: ["customers:view"] };

      const [ca, cb, cc] = await db.insert(schema.customers).values([{ name: "Quán Cá Ngon" }, { name: "Chị Mai" }, { name: "Nhà hàng Sóng" }]).returning({ id: schema.customers.id });
      await db.insert(schema.products).values({ id: "erp-ro-prod", name: "Tôm sú", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "erp-ro-v", productId: "erp-ro-prod", sku: "TS-1", retailPrice: 300_000 });
      const order = async (customerId: string, stage: "CONFIRMED" | "NEW", daysAgo: number) => {
        const r = await createManualOrderCore(admin, { customerId, stage, lines: [{ variantId: "erp-ro-v", quantity: 1, unitPrice: 300_000, discount: 0 }] });
        assert.ok(r.ok, JSON.stringify(r));
        await db.update(schema.orders).set({ insertedAt: new Date(Date.now() - daysAgo * 86_400_000) }).where(eq(schema.orders.id, r.id));
        return r.id;
      };
      // A: mua đều 7 ngày, lần cuối 8 ngày trước ⇒ quá hạn 1 ngày. B: mua một lần 20 ngày trước. C: chỉ có đơn MỚI ⇒ chưa mua.
      await order(ca.id, "CONFIRMED", 22);
      await order(ca.id, "CONFIRMED", 15);
      await order(ca.id, "CONFIRMED", 8);
      await order(cb.id, "CONFIRMED", 20);
      await order(cc.id, "NEW", 3);

      let board = await loadReorderBoard();
      const row = (id: string) => board.rows.find((r) => r.customerId === id);
      assert.deepEqual([row(ca.id)?.status, row(ca.id)?.cycleDays, row(ca.id)?.daysUntil], ["DUE", 7, -1]);
      assert.equal(row(cb.id)?.status, "UNKNOWN", "một lần mua, chưa khai mặc định ⇒ chưa biết");
      assert.equal(row(cc.id), undefined, "đơn Mới không phải một lần mua");

      // Chu kỳ mặc định: chỉ settings:manage; khai 30 ngày ⇒ B còn 10 ngày, chưa tới hạn.
      assert.equal(codeOf(await setReorderSettingCore(viewer, { defaultCycleDays: 30, dueSoonDays: 3 })), "FORBIDDEN");
      assert.ok((await setReorderSettingCore(admin, { defaultCycleDays: 30, dueSoonDays: 3 })).ok);
      board = await loadReorderBoard();
      assert.deepEqual([row(cb.id)?.status, row(cb.id)?.cycleSource, row(cb.id)?.daysUntil], ["NOT_DUE", "DEFAULT", 10]);

      // Sổ liên hệ: quyền, hẹn ngày phải sau hôm nay, hẹn lại ⇒ rời danh sách gọi; người làm = khoá tài khoản.
      assert.equal(codeOf(await recordTouchpointCore(viewer, ca.id, { kind: "CALL", outcome: "NOT_NOW" })), "FORBIDDEN");
      assert.equal(codeOf(await recordTouchpointCore(admin, ca.id, { kind: "CALL", outcome: "NOT_NOW", nextContactOn: "2020-01-01" })), "INVALID");
      const no = await recordTouchpointCore(admin, ca.id, { kind: "CALL", outcome: "NO_ANSWER" });
      assert.ok(no.ok);
      board = await loadReorderBoard();
      assert.equal(row(ca.id)?.status, "DUE", "không nghe máy ⇒ vẫn trong danh sách gọi");
      const later = new Date(Date.now() + 3 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10);
      assert.ok((await recordTouchpointCore(admin, ca.id, { kind: "MESSAGE", outcome: "NOT_NOW", note: "Tuần sau nhập hàng", nextContactOn: later })).ok);
      board = await loadReorderBoard();
      assert.equal(row(ca.id)?.status, "SNOOZED");
      assert.equal(row(ca.id)?.lastTouch?.note, "Tuần sau nhập hàng");
      const [tp] = await db.select().from(schema.customerTouchpoints).where(eq(schema.customerTouchpoints.outcome, "NO_ANSWER"));
      assert.ok(tp.userId === u.id && tp.userName === "QT nhắc", "luật 34: khoá tài khoản + tên do máy chủ đọc");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("✓ Nhắc mua lại: trung vị khoảng cách (cùng ngày đếm một), chu kỳ của khách → mặc định → chưa biết (không đoán); chỉ đơn đã chốt / đã giao là lần mua; hẹn lại / không mua nữa chỉ áp sau đơn gần nhất, không nghe máy không giấu khách; chu kỳ mặc định cần settings:manage; sổ liên hệ cần customers:write, quy kết bằng khoá tài khoản");
}
