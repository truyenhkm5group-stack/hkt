/**
 * PHIẾU CÔNG VIỆC HIỆN TRƯỜNG (module `field_jobs`, 0200 · docs/verticals/home-service.md) + mẫu «Dịch vụ tại nhà».
 *
 *  1. THUẦN — bước chuyển trạng thái (nghiệm thu rồi không đổi, huỷ từ mọi bước chưa xong); tổng báo giá chưa có dòng ⇒ null;
 *     đã thu chỉ cộng phiếu thu còn hiệu lực; hẹn nối tiếp không trùng; hạn bảo hành dịch vụ cộng tháng (cuối tháng); mã phiếu
 *     theo ngày VN lấy số lớn nhất + 1.
 *  2. TỔ CHỨC THẬT (`fj-home`, cài mẫu): quyền field_jobs:write; khách đồng ý cần ≥ 1 dòng; thợ bị hẹn chồng giờ ⇒ chặn, hẹn nối
 *     tiếp ⇒ được; nghiệm thu cần tên người ký; không thu khi chưa báo giá / không thu vượt; huỷ phiếu thu cần lý do và trả lại
 *     phần còn nợ; sửa báo giá sau nghiệm thu ⇒ chặn; huỷ phiếu cần lý do; ảnh kiểm kiểu + cỡ; lượt bảo hành trỏ về phiếu gốc.
 *
 * Mốc giờ đi theo ĐỒNG HỒ THẬT (luật 50): giờ hẹn dựng tương đối từ bây giờ.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { installBlueprint, planForOrg } from "@/lib/blueprints/install";
import { HOME_SERVICE_BLUEPRINT } from "@/lib/blueprints/templates/home-service";
import { validateBlueprint } from "@/lib/blueprints/validate";
import { canMoveFieldJob, fieldJobMoney, fieldJobTotal, nextFieldJobCode, serviceWarrantyUntil, slotsOverlap } from "@/lib/constants/field-jobs";
import { moduleDef } from "@/lib/constants/platform-modules";
import { BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fieldJobDaySchedule, fieldJobDetail, listFieldJobs } from "@/lib/queries/field-jobs";
import { addFieldJobPhotoCore, createFieldJobCore, moveFieldJobCore, openFieldJobRevisitCore, recordFieldJobReceiptCore, updateFieldJobQuoteCore, voidFieldJobReceiptCore } from "@/lib/records/field-jobs";

const ORG = "fj-home";

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
/** «YYYY-MM-DDTHH:MM» giờ VN của (bây giờ + N ngày) lúc HH:MM. */
const vnSlot = (days: number, hhmm: string) => `${new Date(Date.now() + 7 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10)}T${hhmm}`;

function testPure() {
  assert.ok(canMoveFieldJob("QUOTED", "ACCEPTED") && canMoveFieldJob("SCHEDULED", "SCHEDULED") && canMoveFieldJob("IN_PROGRESS", "CANCELLED"));
  assert.ok(!canMoveFieldJob("QUOTED", "SCHEDULED"), "chưa đồng ý báo giá thì chưa hẹn");
  assert.ok(!canMoveFieldJob("DONE", "CANCELLED") && !canMoveFieldJob("CANCELLED", "QUOTED"), "nghiệm thu / huỷ rồi không đổi");
  assert.equal(fieldJobTotal([]), null, "chưa có dòng ⇒ chưa báo giá, không phải 0");
  assert.deepEqual(fieldJobMoney([{ quantity: 2, unitPrice: 300_000 }, { quantity: 1, unitPrice: 150_000 }], [{ amount: 200_000, status: "CONFIRMED" }, { amount: 500_000, status: "VOIDED" }]), { total: 750_000, paid: 200_000, due: 550_000 });
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 5, h, m));
  assert.ok(!slotsOverlap({ start: at(2), end: at(3) }, { start: at(3), end: at(4) }), "hẹn nối tiếp không trùng");
  assert.ok(slotsOverlap({ start: at(2), end: at(3) }, { start: at(2, 30), end: at(4) }));
  assert.equal(serviceWarrantyUntil("2026-01-31", 1), "2026-02-28");
  assert.equal(serviceWarrantyUntil("2026-10-05", null), null, "không khai tháng ⇒ không bảo hành");
  assert.equal(nextFieldJobCode(new Date("2026-10-04T18:00:00Z"), ["CV-261005-01", "CV-261005-07", "CV-261004-99"]), "CV-261005-08", "ngày VN (01:00 sáng 05/10) · số lớn nhất + 1");
  assert.equal(nextFieldJobCode(new Date("2026-10-04T03:00:00Z"), []), "CV-261004-01");

  const v = validateBlueprint(HOME_SERVICE_BLUEPRINT);
  assert.ok(v.ok, JSON.stringify(v.errors));
  assert.equal(BUSINESS_TYPE_SPEC.homeservice.templateKey, "home-service");
  assert.equal(moduleDef("field_jobs")?.homeOptIn, true, "module phiếu công việc TẮT ở tổ chức nhà");
}

export async function testFieldJobs() {
  testPure();
  const home = await getHomeOrganization();
  assert.ok(!(await getEnabledModules(home.code)).has("field_jobs"), "0200: tổ chức nhà KHÔNG bật phiếu công việc");
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Dịch vụ thử", plan: "standard", modules: [], admin: { email: `admin@${ORG}.local`, name: "QT dịch vụ", password: "DichVu@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const sessionOf = async (over: Partial<SessionUser> = {}): Promise<SessionUser> => ({ id: u.id, email: u.email, name: "QT dịch vụ", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Dịch vụ thử", isHome: false }, modules: [...(await getEnabledModules(ORG))], ...over });
      let admin = await sessionOf();
      const plan = await planForOrg(HOME_SERVICE_BLUEPRINT, admin);
      assert.ok(plan.ok, JSON.stringify(plan.steps.filter((s) => s.action === "BLOCKED")));
      assert.ok((await installBlueprint(HOME_SERVICE_BLUEPRINT, admin, { expectedPlanHash: plan.planHash })).ok);
      assert.deepEqual([...(await getEnabledModules(ORG))].sort(), [...HOME_SERVICE_BLUEPRINT.modules].sort());
      admin = await sessionOf();
      const viewer = await sessionOf({ role: "VIEWER", permissions: ["field_jobs:view"] });

      const [kh] = await db.insert(schema.customers).values({ name: "Anh Long", phone: "0912 333 444", address: "12 Lê Lợi" }).returning({ id: schema.customers.id });
      const [tho] = await db.insert(schema.users).values({ email: `tho@${ORG}.local`, name: "Thợ Tuấn", passwordHash: "x", role: "VIEWER", active: true }).returning({ id: schema.users.id });
      const quote = { customerId: kh.id, title: "Vệ sinh 2 máy lạnh", address: "12 Lê Lợi", warrantyMonths: 3, lines: [{ description: "Vệ sinh máy lạnh treo tường", quantity: 2, unitPrice: 200_000 }] };

      assert.equal(codeOf(await createFieldJobCore(viewer, quote)), "FORBIDDEN");
      const empty = await createFieldJobCore(admin, { ...quote, lines: [] });
      assert.ok(empty.ok);
      assert.deepEqual(fieldsOf(await moveFieldJobCore(admin, empty.id, { to: "ACCEPTED" })), ["lines"], "chưa có dòng báo giá ⇒ không đồng ý được");
      assert.deepEqual(fieldsOf(await recordFieldJobReceiptCore(admin, empty.id, { amount: 100_000 })), ["amount"], "chưa báo giá ⇒ chưa biết thu bao nhiêu");
      assert.ok((await moveFieldJobCore(admin, empty.id, { to: "CANCELLED", reason: "Khách đổi ý" })).ok);

      const j1 = await createFieldJobCore(admin, quote);
      assert.ok(j1.ok, JSON.stringify(j1));
      const j2 = await createFieldJobCore(admin, { ...quote, title: "Thay ống nước bếp", lines: [{ description: "Ống + công", quantity: 1, unitPrice: 450_000 }] });
      assert.ok(j2.ok);
      const codes = (await listFieldJobs({ view: "all", q: "", userId: u.id })).map((j) => j.code).sort();
      assert.equal(new Set(codes).size, codes.length, "mã phiếu không trùng");
      assert.equal(codeOf(await moveFieldJobCore(admin, j1.id, { to: "SCHEDULED", assigneeUserId: tho.id, start: vnSlot(1, "09:00"), durationMin: 120 })), "CONFLICT", "chưa đồng ý ⇒ chưa hẹn");
      assert.ok((await moveFieldJobCore(admin, j1.id, { to: "ACCEPTED", note: "Zalo" })).ok);
      assert.ok((await moveFieldJobCore(admin, j2.id, { to: "ACCEPTED" })).ok);
      assert.ok((await moveFieldJobCore(admin, j1.id, { to: "SCHEDULED", assigneeUserId: tho.id, start: vnSlot(1, "09:00"), durationMin: 120 })).ok);
      assert.deepEqual(fieldsOf(await moveFieldJobCore(admin, j2.id, { to: "SCHEDULED", assigneeUserId: tho.id, start: vnSlot(1, "10:30"), durationMin: 60 })), ["start"], "thợ đã có hẹn chồng giờ ⇒ chặn");
      assert.ok((await moveFieldJobCore(admin, j2.id, { to: "SCHEDULED", assigneeUserId: tho.id, start: vnSlot(1, "11:00"), durationMin: 60 })).ok, "hẹn nối tiếp ⇒ được");
      assert.ok((await moveFieldJobCore(admin, j1.id, { to: "SCHEDULED", assigneeUserId: tho.id, start: vnSlot(1, "08:00"), durationMin: 180 })).ok, "dời hẹn của chính phiếu không tự trùng với chính nó");
      const day = await fieldJobDaySchedule(vnSlot(1, "00:00").slice(0, 10));
      assert.deepEqual(day.map((g) => [g.assigneeName, g.jobs.length]), [["Thợ Tuấn", 2]]);
      assert.equal((await listFieldJobs({ view: "mine", q: "", userId: tho.id })).length, 2, "«Việc của tôi» của thợ");

      // Tiền.
      assert.ok((await recordFieldJobReceiptCore(admin, j1.id, { amount: 100_000, method: "BANK", note: "Cọc" })).ok);
      assert.deepEqual(fieldsOf(await recordFieldJobReceiptCore(admin, j1.id, { amount: 400_000 })), ["amount"], "vượt số còn phải thu ⇒ chặn");
      // Phát sinh tại nhà khách: thêm dòng — tổng tăng, còn nợ tăng theo.
      assert.ok((await moveFieldJobCore(admin, j1.id, { to: "IN_PROGRESS" })).ok);
      const { customerId: _omit, ...quoteOnly } = quote;
      void _omit;
      assert.ok((await updateFieldJobQuoteCore(admin, j1.id, { ...quoteOnly, lines: [...quote.lines, { description: "Bơm gas bổ sung", quantity: 1, unitPrice: 250_000 }] })).ok);
      let d1 = (await fieldJobDetail(j1.id))!;
      assert.deepEqual([d1.total, d1.paid, d1.due], [650_000, 100_000, 550_000]);
      assert.deepEqual(fieldsOf(await updateFieldJobQuoteCore(admin, j1.id, { ...quoteOnly, lines: [{ description: "x", quantity: 1, unitPrice: 50_000 }] })), ["lines"], "tổng mới nhỏ hơn số đã thu ⇒ chặn");

      // Ảnh.
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
      assert.ok((await addFieldJobPhotoCore(admin, j1.id, { phase: "BEFORE", contentType: "image/jpeg", base64: jpeg })).ok);
      assert.equal(codeOf(await addFieldJobPhotoCore(admin, j1.id, { phase: "AFTER", contentType: "image/svg+xml", base64: jpeg })), "INVALID", "kiểu ảnh lạ ⇒ chặn");

      // Nghiệm thu.
      assert.deepEqual(fieldsOf(await moveFieldJobCore(admin, j1.id, { to: "DONE" })), ["signedByName"], "nghiệm thu cần tên người ký");
      assert.ok((await moveFieldJobCore(admin, j1.id, { to: "DONE", signedByName: "Long", note: "Máy chạy êm" })).ok);
      assert.equal(codeOf(await updateFieldJobQuoteCore(admin, j1.id, quoteOnly)), "CONFLICT", "nghiệm thu rồi không sửa báo giá");
      assert.equal(codeOf(await moveFieldJobCore(admin, j1.id, { to: "CANCELLED", reason: "Nhầm" })), "CONFLICT");
      assert.ok((await recordFieldJobReceiptCore(admin, j1.id, { amount: 550_000 })).ok, "thu nốt sau nghiệm thu");
      d1 = (await fieldJobDetail(j1.id))!;
      assert.equal(d1.due, 0);
      assert.ok(d1.warrantyUntil && d1.inWarranty === true, "bảo hành 3 tháng tính từ ngày nghiệm thu");
      const r0 = d1.receipts[0];
      assert.deepEqual(fieldsOf(await voidFieldJobReceiptCore(admin, r0.id, "x")), ["reason"]);
      assert.ok((await voidFieldJobReceiptCore(admin, r0.id, "Ghi nhầm hình thức")).ok);
      assert.equal((await fieldJobDetail(j1.id))!.due, 100_000, "huỷ phiếu thu ⇒ khoản đó lại thành còn nợ");

      // Lượt bảo hành.
      assert.equal(codeOf(await openFieldJobRevisitCore(admin, j2.id, "Rò nước lại")), "CONFLICT", "chưa nghiệm thu ⇒ chưa có bảo hành");
      const rv = await openFieldJobRevisitCore(admin, j1.id, "Máy chảy nước lại");
      assert.ok(rv.ok);
      const rvd = (await fieldJobDetail(rv.id))!;
      assert.ok(rvd.parent?.id === j1.id && rvd.status === "QUOTED" && rvd.total === null, "phiếu mới trỏ về phiếu gốc, chưa có báo giá");
      assert.deepEqual((await fieldJobDetail(j1.id))!.revisits.map((x) => x.id), [rv.id]);

      assert.deepEqual(fieldsOf(await moveFieldJobCore(admin, j2.id, { to: "CANCELLED", reason: "" })), ["reason"], "huỷ cần lý do");
      assert.ok((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "FIELD_JOB"))).length >= 10, "mọi lượt ghi có nhật ký");
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ phiếu công việc: đồng ý cần báo giá, thợ không bị hẹn chồng giờ (nối tiếp được, dời hẹn không tự trùng), phát sinh tăng tổng, không thu khi chưa báo giá / vượt báo giá, huỷ phiếu thu trả lại công nợ, nghiệm thu cần người ký và khoá báo giá, bảo hành tính từ nghiệm thu, lượt bảo hành trỏ phiếu gốc; mẫu Dịch vụ tại nhà; nhà TẮT");
}
