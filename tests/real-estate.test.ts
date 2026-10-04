/**
 * BẢNG HÀNG BẤT ĐỘNG SẢN (module `real_estate`, 0201 · docs/verticals/real-estate.md) + mẫu «Sàn / đại lý bất động sản».
 *
 *  1. THUẦN — giữ chỗ còn hiệu lực chỉ khi ACTIVE và chưa tới hạn; trạng thái căn ưu tiên bán > khoá > cọc > giữ > trống; dán
 *     danh sách căn (diện tích «75,5», giá «3.250.000.000», trống ⇒ chưa công bố, mã lặp / số hỏng báo theo dòng).
 *  2. TỔ CHỨC THẬT (`re-san`, cài mẫu): quyền; dự án bắt buộc khai giờ giữ chỗ; sale B KHÔNG giữ trùng căn sale A đang giữ;
 *     giữ chỗ quá hạn tự về còn trống và người khác giữ được; sale B không cọc chồng lên giữ chỗ của A; A chuyển giữ chỗ thành
 *     cọc (khách của lượt giữ); ký bán cần cọc + số hợp đồng; hoàn cọc cần lý do và trả căn về còn trống; khoá căn chặn giữ chỗ;
 *     khách của lượt giữ ẩn với sale khác; chỉ mục CSDL chặn hai dòng ACTIVE cùng căn.
 *
 * Mốc giờ đi theo ĐỒNG HỒ THẬT (luật 50): «bây giờ» là Date.now(), quá hạn dựng bằng now + giờ giữ chỗ.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { REAL_ESTATE_AGENCY_BLUEPRINT } from "@/lib/blueprints/templates/real-estate-agency";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { moduleDef } from "@/lib/constants/platform-modules";
import { holdLive, parseUnitLines, unitState } from "@/lib/constants/real-estate";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { myLiveHolds, reBoard } from "@/lib/queries/real-estate";
import { addReUnitsCore, closeReDepositCore, createReProjectCore, depositReUnitCore, holdReUnitCore, lockReUnitCore, releaseReHoldCore, sellReUnitCore } from "@/lib/records/real-estate";

const ORG = "re-san";

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
const msgOf = (r: { ok: true } | { ok: false; errors: { message: string }[] }) => (r.ok ? "" : r.errors.map((e) => e.message).join(" | "));

function testPure() {
  const now = new Date("2026-10-05T03:00:00Z");
  assert.ok(holdLive({ status: "ACTIVE", expiresAt: "2026-10-05T03:00:01Z" }, now));
  assert.ok(!holdLive({ status: "ACTIVE", expiresAt: "2026-10-05T03:00:00Z" }, now), "đúng mốc hạn là hết");
  assert.ok(!holdLive({ status: "RELEASED", expiresAt: "2026-10-06T00:00:00Z" }, now));
  const live = [{ status: "ACTIVE", expiresAt: "2026-10-06T00:00:00Z" }];
  assert.equal(unitState({ soldAt: "2026-10-01", lockedAt: "2026-10-02", hasActiveDeposit: true, holds: live }, now), "SOLD");
  assert.equal(unitState({ soldAt: null, lockedAt: "2026-10-02", hasActiveDeposit: false, holds: [] }, now), "LOCKED");
  assert.equal(unitState({ soldAt: null, lockedAt: null, hasActiveDeposit: true, holds: live }, now), "DEPOSITED");
  assert.equal(unitState({ soldAt: null, lockedAt: null, hasActiveDeposit: false, holds: live }, now), "HELD");
  assert.equal(unitState({ soldAt: null, lockedAt: null, hasActiveDeposit: false, holds: [{ status: "ACTIVE", expiresAt: "2026-10-05T02:00:00Z" }] }, now), "AVAILABLE", "giữ quá hạn ⇒ còn trống");

  const p = parseUnitLines("A-1201 | Toà A | 12 | 68,5 | 3.250.000.000\n\nA-1202|Toà A|12||\na-1201 | x\nB-1 | | | abc | 1");
  assert.deepEqual(p.units.map((u) => [u.code, u.areaM2, u.listPrice]), [["A-1201", 68.5, 3_250_000_000], ["A-1202", null, null]], "trống ⇒ chưa công bố");
  assert.deepEqual(p.errors.map((e) => e.line), [4, 5], "mã lặp (khác hoa thường) và số hỏng báo đúng dòng");

  const v = validateBlueprint(REAL_ESTATE_AGENCY_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(BUSINESS_TYPE_SPEC.realestate.templateKey, "real-estate-agency");
  assert.equal(moduleDef("real_estate")?.homeOptIn, true, "module bảng hàng TẮT ở tổ chức nhà");
}

export async function testRealEstate() {
  testPure();
  const home = await getHomeOrganization();
  assert.ok(!(await getEnabledModules(home.code)).has("real_estate"), "0201: tổ chức nhà KHÔNG bật bảng hàng");
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Sàn thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT sàn", password: "SanBds@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const modules = async () => [...(await getEnabledModules(ORG))];
      const sessionOf = async (over: Partial<SessionUser> = {}): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT sàn", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Sàn thử", isHome: false }, modules: await modules(), ...over });
      let admin = await sessionOf();
      const plan = await planForOrg(REAL_ESTATE_AGENCY_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      assert.ok((await installBlueprint(REAL_ESTATE_AGENCY_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      admin = await sessionOf();
      const [a, b] = await db
        .insert(schema.users)
        .values([
          { email: `a@${ORG}.local`, name: "Sale An", passwordHash: "x", role: "CS", active: true },
          { email: `b@${ORG}.local`, name: "Sale Bình", passwordHash: "x", role: "CS", active: true },
        ])
        .returning({ id: schema.users.id });
      const saleA = await sessionOf({ id: a.id, name: "Sale An", role: "CS", permissions: ["real_estate:view", "real_estate:hold"] });
      const saleB = await sessionOf({ id: b.id, name: "Sale Bình", role: "CS", permissions: ["real_estate:view", "real_estate:hold"] });
      const viewer = await sessionOf({ role: "VIEWER", permissions: ["real_estate:view"] });

      // Dự án + căn.
      assert.equal(codeOf(await createReProjectCore(saleA, { code: "SKY", name: "Sky Garden", holdHours: 24 })), "FORBIDDEN", "sale không tạo dự án");
      assert.deepEqual(fieldsOf(await createReProjectCore(admin, { code: "SKY", name: "Sky Garden" })), ["holdHours"], "giờ giữ chỗ BẮT BUỘC khai");
      const pj = await createReProjectCore(admin, { code: "SKY", name: "Sky Garden", holdHours: 24 });
      assert.ok(pj.ok);
      assert.ok((await addReUnitsCore(admin, pj.id, "A-1201 | A | 12 | 68,5 | 3.250.000.000\nA-1202 | A | 12 | 75 | 3.600.000.000\nA-1203 | A | 12 | 75 |")).ok);
      assert.equal(codeOf(await addReUnitsCore(admin, pj.id, "A-1202 | A | 12")), "CONFLICT", "mã căn đã có ⇒ không thêm");
      const units = await db.select({ id: schema.reUnits.id, code: schema.reUnits.code }).from(schema.reUnits).where(eq(schema.reUnits.projectId, pj.id));
      const id = (code: string) => units.find((x) => x.code === code)!.id;

      // Giữ chỗ — không ai giữ trùng.
      const t0 = new Date();
      assert.equal(codeOf(await holdReUnitCore(viewer, id("A-1201"), { customerName: "Chị Mai" }, t0)), "FORBIDDEN");
      const hA = await holdReUnitCore(saleA, id("A-1201"), { customerName: "Chị Mai", customerPhone: "0903 111 000" }, t0);
      assert.ok(hA.ok, JSON.stringify(hA));
      const clash = await holdReUnitCore(saleB, id("A-1201"), { customerName: "Anh Tùng" }, new Date(t0.getTime() + 60_000));
      assert.equal(codeOf(clash), "CONFLICT");
      assert.match(msgOf(clash), /Sale An/, "nói rõ ai đang giữ");
      // Bảng hàng: sale B thấy ai giữ, KHÔNG thấy khách của A.
      const boardB = await reBoard(pj.id, { userId: b.id, manager: false }, new Date(t0.getTime() + 60_000));
      const u1 = boardB.units.find((x) => x.code === "A-1201")!;
      assert.ok(u1.state === "HELD" && u1.hold?.saleName === "Sale An" && u1.hold.customerName === null, "khách của lượt giữ ẩn với sale khác");
      assert.equal(boardB.counts.HELD, 1);
      assert.equal((await myLiveHolds(a.id, t0)).length, 1);
      // Sale B không cọc chồng lên giữ chỗ của A.
      assert.equal(codeOf(await depositReUnitCore(saleB, id("A-1201"), { amount: 100_000_000, customerName: "Anh Tùng" }, new Date(t0.getTime() + 60_000))), "CONFLICT");
      // Quá hạn ⇒ tự về còn trống, B giữ được.
      const later = new Date(t0.getTime() + 25 * 3_600_000);
      const boardLater = await reBoard(pj.id, { userId: b.id, manager: false }, later);
      assert.equal(boardLater.units.find((x) => x.code === "A-1201")!.state, "AVAILABLE", "giữ chỗ quá hạn tự về còn trống");
      const hB = await holdReUnitCore(saleB, id("A-1201"), { customerName: "Anh Tùng" }, later);
      assert.ok(hB.ok, JSON.stringify(hB));
      const old = await db.select({ status: schema.reHolds.status }).from(schema.reHolds).where(eq(schema.reHolds.id, hA.id));
      assert.equal(old[0].status, "EXPIRED", "lượt cũ quá hạn chuyển EXPIRED khi có lượt giữ mới");
      // Chỉ mục CSDL chặn hai dòng ACTIVE cùng căn kể cả khi đi vòng đường ghi.
      await assert.rejects(db.insert(schema.reHolds).values({ unitId: id("A-1201"), customerName: "x", expiresAt: new Date(later.getTime() + 3_600_000), heldAt: later }));

      // Nhả: của mình không cần lý do; của người khác chỉ quản lý + lý do.
      assert.equal(codeOf(await releaseReHoldCore(saleA, hB.id, "", later)), "FORBIDDEN");
      assert.deepEqual(fieldsOf(await releaseReHoldCore(admin, hB.id, "", later)), ["reason"]);

      // Cọc: B chuyển giữ chỗ của mình thành cọc (khách của lượt giữ).
      const dep = await depositReUnitCore(saleB, id("A-1201"), { amount: 200_000_000 }, later);
      assert.ok(dep.ok, JSON.stringify(dep));
      const [d] = await db.select().from(schema.reDeposits).where(eq(schema.reDeposits.id, dep.id));
      assert.equal(d.customerName, "Anh Tùng", "cọc lấy khách của lượt giữ");
      assert.equal((await db.select().from(schema.reHolds).where(and(eq(schema.reHolds.id, hB.id), eq(schema.reHolds.status, "CONVERTED")))).length, 1);
      assert.equal(codeOf(await holdReUnitCore(saleA, id("A-1201"), { customerName: "Chị Mai" }, later)), "CONFLICT", "căn đã cọc không giữ được");

      // Hoàn cọc cần lý do ⇒ căn về còn trống; cọc thẳng căn trống cần tên khách; ký bán cần cọc + số HĐ.
      assert.deepEqual(fieldsOf(await closeReDepositCore(admin, dep.id, { outcome: "REFUNDED", reason: "" })), ["reason"]);
      assert.ok((await closeReDepositCore(admin, dep.id, { outcome: "REFUNDED", reason: "Khách không vay được" }, later)).ok);
      assert.equal((await reBoard(pj.id, { userId: a.id, manager: false }, later)).units.find((x) => x.code === "A-1201")!.state, "AVAILABLE");
      assert.deepEqual(fieldsOf(await depositReUnitCore(saleA, id("A-1202"), { amount: 150_000_000 }, later)), ["customerName"], "cọc thẳng căn trống cần tên khách");
      assert.equal(codeOf(await sellReUnitCore(admin, id("A-1202"), "HĐ-01", later)), "CONFLICT", "chưa cọc ⇒ chưa ký bán");
      assert.ok((await depositReUnitCore(saleA, id("A-1202"), { amount: 150_000_000, customerName: "Chị Mai" }, later)).ok);
      assert.deepEqual(fieldsOf(await sellReUnitCore(admin, id("A-1202"), " ", later)), ["contract"]);
      assert.ok((await sellReUnitCore(admin, id("A-1202"), "HĐ-SKY-001", later)).ok);
      assert.equal(codeOf(await sellReUnitCore(admin, id("A-1202"), "HĐ-SKY-002", later)), "CONFLICT", "bán rồi không bán lần hai");

      // Khoá căn.
      assert.deepEqual(fieldsOf(await lockReUnitCore(admin, id("A-1203"), true, "")), ["reason"]);
      assert.ok((await lockReUnitCore(admin, id("A-1203"), true, "Chủ đầu tư rút căn")).ok);
      assert.equal(codeOf(await holdReUnitCore(saleA, id("A-1203"), { customerName: "Chị Mai" }, later)), "CONFLICT", "căn khoá không giữ được");
      const finalBoard = await reBoard(pj.id, { userId: u.id, manager: true }, later);
      assert.deepEqual(finalBoard.counts, { AVAILABLE: 1, HELD: 0, DEPOSITED: 0, SOLD: 1, LOCKED: 1 });
      assert.ok((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "RE_UNIT"))).length >= 7, "mọi lượt ghi có nhật ký (2 giữ · 2 cọc · hoàn · bán · khoá)");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ bảng hàng BĐS: dự án bắt buộc khai giờ giữ chỗ; không giữ trùng / cọc chồng; giữ quá hạn tự về còn trống và người khác giữ được; chỉ mục chặn hai giữ chỗ cùng căn; khách ẩn với sale khác; cọc lấy khách của lượt giữ; hoàn cọc cần lý do; ký bán cần cọc + HĐ; khoá căn chặn giữ; mẫu Sàn BĐS; nhà TẮT");
}
