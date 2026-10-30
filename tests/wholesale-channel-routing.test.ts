/**
 * ═══════════ KẾ HOẠCH KÊNH: NƯỚC NGOÀI — EMAIL · TRONG NƯỚC — ZALO · CHUYỂN SANG EMAIL (chủ shop 30/10/2026) ═══════════
 *
 *  1. THUẦN — ma trận kênh: quốc tế có / không email · trong nước có Zalo · Zalo hỏng (không số di động · không có tài khoản ·
 *     nhân viên đánh dấu) có / không email · khách IM LẶNG không đổi kênh · hoàn tác quay về Zalo · KHÔNG LIÊN HỆ · danh sách
 *     chặn. Nước người nhận theo khoá tỉnh.
 *  2. CỔNG NƯỚC (issue #1085) trong `evaluateEmailSend`: danh sách rỗng ⇒ gửi thật nằm chờ `COUNTRY_NOT_REVIEWED` · chạy thử
 *     vẫn đi kèm cảnh báo · nước đã rà ⇒ qua · không xác định được nước ⇒ coi như chưa rà.
 *  3. TỔ CHỨC THẬT `wr-a`: «Zalo không gửi được» (quyền · zod · phạm vi · chỉ thêm dòng · hoàn tác là dòng mới) · `NO_ACCOUNT`
 *     ⇒ `zalo_status = NOT_FOUND` · kế hoạch theo lô đọc đúng · lõi soạn email TỪ CHỐI lead trong nước còn Zalo · danh sách nước
 *     chỉ quản trị sửa, bắt buộc lý do, có audit.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { contactPlanOf, zaloMarkerOf, ZALO_MARK_OUTCOME, ZALO_UNMARK_OUTCOME, type ContactPlanInput } from "@/lib/wholesale/contact-plan";
import { confirmLeadCountryCore, contactPlansFor, markZaloUndeliverableCore, undoZaloUndeliverableCore } from "@/lib/wholesale/contact-plan-store";
import { DEFAULT_EMAIL_SETTINGS, type EmailSettings } from "@/lib/wholesale/email-constants";
import { saveEmailAllowedCountriesCore } from "@/lib/wholesale/email-countries";
import { emailDraftForLeadCore } from "@/lib/wholesale/email-outbox";
import { getEmailSettings } from "@/lib/wholesale/email-outbox-store";
import { evaluateEmailSend, type EmailPolicyInput } from "@/lib/wholesale/email-policy";
import { leadCountryOf } from "@/lib/wholesale/lead-country";

const ORG = "wr-a";

// ─────────────────────────── 1. MA TRẬN KÊNH (THUẦN) ───────────────────────────

/** Nước đi qua ĐÚNG thang chứng cứ của máy chủ (`leadCountryOf`), không gõ tay — bài kiểm không có luật thứ hai. */
function input(over: Partial<ContactPlanInput["lead"]> & { provinceKey?: string | null } = {}, rest: Partial<Omit<ContactPlanInput, "lead" | "country">> = {}): ContactPlanInput {
  const { provinceKey = "da nang", ...rest0 } = over;
  const lead = { contactStatus: "QUALIFIED", placeId: null, phone: "+84905123456", phoneKind: "MOBILE", email: null, websiteDomain: "quan.vn", zaloStatus: null, ...rest0 };
  return {
    lead,
    country: leadCountryOf({ confirmedCountry: null, provinceKey, phoneCountryCode: null, phones: [lead.phone], websiteDomain: lead.websiteDomain, email: lead.email }),
    consents: [],
    suppressions: [],
    zaloMarker: null,
    allowedCountries: [],
    ...rest,
  };
}

function testMatrix() {
  // Quốc tế ⇒ email (có / không email).
  const intl = contactPlanOf(input({ provinceKey: "intl jp", phone: null, phoneKind: null, email: "Buyer@Tokyo-Foods.jp" }));
  assert.deepEqual([intl.track, intl.channel, intl.international, intl.country, intl.email], ["INTL_EMAIL", "EMAIL", true, "JP", "buyer@tokyo-foods.jp"]);
  assert.ok(intl.notes.some((n) => n.includes("chưa rà luật") || n.includes("Chưa rà luật")), "nước chưa rà ⇒ kế hoạch nói email chỉ chạy thử");
  const intlNoMail = contactPlanOf(input({ provinceKey: "intl jp", email: null }));
  assert.equal(intlNoMail.track, "NO_CHANNEL");
  assert.ok(intlNoMail.notes.some((n) => n.startsWith("Chưa có email")), "không có email ⇒ nói rõ «chạy tìm email», không đoán");
  assert.equal(intlNoMail.channel, null, "khách nước ngoài có SĐT di động vẫn KHÔNG đi Zalo");

  // Trong nước có Zalo ⇒ Zalo, kể cả khi có email.
  const zalo = contactPlanOf(input({ email: "chu@quan.vn" }));
  assert.deepEqual([zalo.track, zalo.channel, zalo.country, zalo.zaloBlock], ["DOMESTIC_ZALO", "ZALO", "VN", null]);

  // Khách IM LẶNG: hàm không có đầu vào nào về phản hồi — lead đã liên hệ, hẹn gọi lại quá hạn vẫn ở Zalo.
  const silent = contactPlanOf(input({ email: "chu@quan.vn", contactStatus: "CONTACTED", zaloStatus: "FOUND" }));
  assert.equal(silent.track, "DOMESTIC_ZALO", "khách chưa trả lời KHÔNG phải «không gửi được»");

  // Zalo hỏng (ba đường) + có email ⇒ chuyển sang email; không email ⇒ thiếu kênh + gợi ý tìm email.
  const noMobile = contactPlanOf(input({ phone: "+842363888999", phoneKind: "LANDLINE", email: "chu@quan.vn" }));
  assert.deepEqual([noMobile.track, noMobile.zaloBlock?.source], ["DOMESTIC_EMAIL_FALLBACK", "NO_MOBILE"]);
  assert.equal(contactPlanOf(input({ phone: null, phoneKind: null, email: "chu@quan.vn" })).zaloBlock?.source, "NO_MOBILE", "không SĐT ⇒ không Zalo");
  const noAccount = contactPlanOf(input({ zaloStatus: "NOT_FOUND", email: "chu@quan.vn" }));
  assert.deepEqual([noAccount.track, noAccount.zaloBlock?.source], ["DOMESTIC_EMAIL_FALLBACK", "ZALO_STATUS"], "zalo_status = NOT_FOUND là MỘT sự thật «không có tài khoản»");
  const marked = contactPlanOf(input({ email: "chu@quan.vn" }, { zaloMarker: { reason: "BLOCKS_STRANGERS", at: "2026-10-30T02:00:00.000Z" } }));
  assert.deepEqual([marked.track, marked.channel, marked.zaloBlock?.source], ["DOMESTIC_EMAIL_FALLBACK", "EMAIL", "MARKER"]);
  const brokenNoMail = contactPlanOf(input({ email: null }, { zaloMarker: { reason: "WRONG_NUMBER", at: "2026-10-30T02:00:00.000Z" } }));
  assert.deepEqual([brokenNoMail.track, brokenNoMail.channel], ["NO_CHANNEL", null]);
  assert.ok(brokenNoMail.notes.some((n) => n.startsWith("Chưa có email")));

  // KHÔNG LIÊN HỆ / danh sách chặn ⇒ dừng mọi kênh, cả khi Zalo hỏng và có email.
  assert.equal(contactPlanOf(input({ contactStatus: "DO_NOT_CONTACT", email: "chu@quan.vn" })).track, "STOPPED");
  assert.equal(contactPlanOf(input({ email: "chu@quan.vn", zaloStatus: "NOT_FOUND" }, { suppressions: [{ kind: "EMAIL", value: "chu@quan.vn" }] })).track, "STOPPED");
  assert.equal(contactPlanOf(input({ provinceKey: "intl sg", email: "a@b.sg" }, { suppressions: [{ kind: "DOMAIN", value: "quan.vn" }] })).track, "STOPPED", "chặn theo tên miền website ⇒ dừng cả email");

  // Bản xem trước cổng tự gửi của P1a: email công khai không có đồng ý ⇒ máy chưa được tự gửi (cổng E1 sẽ chặn).
  assert.equal(intl.emailGate?.reason, "NO_CONSENT");
  const consented = contactPlanOf(input({ provinceKey: "intl jp", email: "buyer@tokyo-foods.jp" }, { consents: [{ channel: "EMAIL", contactValue: "buyer@tokyo-foods.jp", basis: "OPT_IN_FORM", revokedAt: null }], allowedCountries: ["JP"] }));
  assert.deepEqual([consented.emailGate?.allowed, consented.countryReviewed], [true, true]);

  // Chưa biết nước ⇒ làn «thiếu căn cứ nước», KHÔNG tự xếp vào «trong nước — Zalo» (bất đồng cũ: thiếu khoá tỉnh = VN).
  const unknown = contactPlanOf(input({ provinceKey: null, phone: null, phoneKind: null, websiteDomain: null, email: "buyer@gmail.com" }));
  assert.deepEqual([unknown.track, unknown.channel, unknown.country], ["COUNTRY_UNKNOWN", null, null]);
  assert.equal(contactPlanOf(input({ provinceKey: null, phone: "+1 415 555 0100", phoneKind: null, websiteDomain: "pacificseafood.com", email: "b@pacificseafood.com" })).track, "COUNTRY_UNKNOWN", "+1 dùng chung Mỹ/Canada + .com ⇒ chưa biết");
  assert.equal(contactPlanOf(input({ provinceKey: null, phone: null, phoneKind: null, websiteDomain: "fisch.de", email: "a@fisch.de" })).track, "INTL_EMAIL", "lead không khoá tỉnh nhưng tên miền .de ⇒ nước ngoài, đi email");
  assert.equal(contactPlanOf(input({ contactStatus: "DO_NOT_CONTACT", provinceKey: null, phone: null, phoneKind: null, websiteDomain: null })).track, "STOPPED", "dừng thắng cả khi chưa biết nước");

  // Dấu Zalo: dòng mới nhất giữa đánh dấu / hoàn tác quyết định; dòng thiếu lý do bị bỏ.
  const t = (m: number) => new Date(Date.UTC(2026, 9, 30, 2, m));
  assert.equal(zaloMarkerOf([]), null);
  assert.deepEqual(zaloMarkerOf([{ outcome: ZALO_MARK_OUTCOME, meta: { reason: "WRONG_NUMBER" }, createdAt: t(1) }]), { reason: "WRONG_NUMBER", at: t(1).toISOString() });
  assert.equal(zaloMarkerOf([{ outcome: ZALO_MARK_OUTCOME, meta: { reason: "WRONG_NUMBER" }, createdAt: t(1) }, { outcome: ZALO_UNMARK_OUTCOME, meta: {}, createdAt: t(2) }]), null, "hoàn tác sau ⇒ hết hiệu lực");
  assert.equal(zaloMarkerOf([{ outcome: ZALO_UNMARK_OUTCOME, meta: {}, createdAt: t(2) }, { outcome: ZALO_MARK_OUTCOME, meta: { reason: "NO_ACCOUNT" }, createdAt: t(3) }])?.reason, "NO_ACCOUNT", "đánh dấu lại sau hoàn tác");
  assert.equal(zaloMarkerOf([{ outcome: "SENT", meta: null, createdAt: t(5) }, { outcome: ZALO_MARK_OUTCOME, meta: { reason: "LA" }, createdAt: t(4) }]), null, "lý do lạ ⇒ bỏ, không đoán");
}

// ─────────────────────────── 2. CỔNG NƯỚC (THUẦN) ───────────────────────────

const SENDER = { name: "Hải sản Hà My", email: "banhang@hamy.vn", companyName: "Hộ kinh doanh Hà My", address: "12 Lê Lợi, Hải Châu, Đà Nẵng" };

function policyInput(settings: Partial<EmailSettings>, recipientCountry: string | null, liveAdapters: string[] = ["gws"]): EmailPolicyInput {
  return {
    settings: { ...DEFAULT_EMAIL_SETTINGS, mode: "DRY_RUN", sender: SENDER, ...settings },
    message: { status: "QUEUED", toEmail: "a@b.jp", recipientDomain: "b.jp", campaignId: null, approvedByUserId: "u1", approvedAt: "2026-10-30T02:00:00Z", approvedHash: "h", contentHash: "h", approvalUsedAt: null },
    leadEmail: "a@b.jp",
    leadContactStatus: "QUALIFIED",
    contactability: { allowed: true, reason: "CONSENTED", detail: "" },
    suppressionHit: null,
    leadEventKinds: [],
    duplicateSent: false,
    counts: { lastHour: 0, today: 0, domainToday: 0 },
    liveAdapters,
    recipientCountry,
  };
}

function testCountryGate() {
  const live = { mode: "LIVE" as const, liveEnabledByUserId: "owner" };
  const empty = evaluateEmailSend(policyInput(live, "JP"));
  assert.deepEqual([empty.allowed, empty.reasons, empty.hold], [false, ["COUNTRY_NOT_REVIEWED"], true], "danh sách RỖNG mặc định ⇒ gửi thật nằm chờ");
  assert.match(empty.details[0] ?? "", /chưa rà luật nước JP/);
  assert.equal(evaluateEmailSend(policyInput({ ...live, allowedCountries: ["VN"] }, "JP")).reasons[0], "COUNTRY_NOT_REVIEWED", "rà VN không mở cửa cho JP");
  const ok = evaluateEmailSend(policyInput({ ...live, allowedCountries: ["JP"] }, "JP"));
  assert.deepEqual([ok.allowed, ok.sendMode, ok.warnings], [true, "LIVE", []]);
  assert.deepEqual(evaluateEmailSend(policyInput({ ...live, allowedCountries: ["JP"] }, null)).reasons, ["COUNTRY_NOT_REVIEWED"], "không xác định được nước ⇒ coi như chưa rà");
  const dry = evaluateEmailSend(policyInput({}, "JP"));
  assert.deepEqual([dry.allowed, dry.sendMode], [true, "DRY_RUN"], "chạy thử vẫn đi hết đường ống");
  assert.equal(dry.warnings.length, 1);
  assert.match(dry.warnings[0]!, /chưa rà luật nước JP/, "…nhưng in lý do");
  assert.deepEqual(evaluateEmailSend(policyInput({ allowedCountries: ["JP"] }, "JP")).warnings, []);
  assert.deepEqual(DEFAULT_EMAIL_SETTINGS.allowedCountries, [], "không có nước mặc định nào, kể cả VN");
}

// ─────────────────────────── 3. TỔ CHỨC THẬT ───────────────────────────

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, code));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

function sessionOf(u: { id: string; email: string }, modules: string[], over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "Chủ shop", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: `Shop ${ORG}`, isHome: false }, modules, ...over };
}

async function testDb() {
  await cleanupOrg(ORG);
  await provisionOrganization({ code: ORG, name: `Shop ${ORG}`, plan: "standard", modules: ["customers", "wholesale_leads"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "KenhLienHe@2026!" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const modules = [...(await getEnabledModules(ORG))];
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
      assert.ok(u);
      const admin = sessionOf(u, modules);
      const [saleRow] = await db.insert(schema.users).values({ email: `sale@${ORG}.local`, name: "Sale Hoa", role: "CS", passwordHash: "x" }).returning();
      const sale = sessionOf(saleRow!, modules, { role: "CS", name: "Sale Hoa", permissions: ["wholesale:view", "wholesale:work"] });
      const viewer = sessionOf(saleRow!, modules, { role: "CS", permissions: ["wholesale:view"] });
      const manager = sessionOf(u, modules, { role: "MANAGER", permissions: ["wholesale:view", "wholesale:work", "wholesale:config"] });
      const mk = async (v: Partial<typeof schema.wholesaleLeads.$inferInsert>) => (await db.insert(schema.wholesaleLeads).values({ source: "STAFF", contactStatus: "QUALIFIED", enrichmentStatus: "READY", ...v }).returning())[0]!;
      const quan = await mk({ businessName: "Quán Zalo", phoneRaw: "0905123456", normalizedPhone: "+84905123456", phoneKind: "MOBILE", email: "chu@quanzalo.vn", provinceKey: "da nang" });
      const tokyo = await mk({ businessName: "Tokyo Foods", email: "buyer@tokyo-foods.jp", provinceKey: "intl jp" });

      const plans0 = await contactPlansFor([quan.id, tokyo.id]);
      assert.deepEqual([plans0.get(quan.id)?.track, plans0.get(tokyo.id)?.track], ["DOMESTIC_ZALO", "INTL_EMAIL"]);

      // Lõi soạn email TỪ CHỐI lead trong nước còn nhắn Zalo được (email chỉ là dự phòng).
      const refused = await emailDraftForLeadCore(sale, quan.id, { useAi: false });
      assert.ok("error" in refused && /Trong nước — Zalo/.test(refused.error), JSON.stringify(refused));

      // «Zalo không gửi được»: quyền · zod (không có lý do «khách chưa trả lời») · ghi dòng · đi một chiều.
      assert.ok("error" in (await markZaloUndeliverableCore(viewer, quan.id, { reason: "BLOCKS_STRANGERS" })), "không có wholesale:work ⇒ từ chối");
      assert.ok("error" in (await markZaloUndeliverableCore(sale, quan.id, { reason: "NO_REPLY" })), "«khách chưa trả lời» không phải lý do");
      assert.ok("error" in (await markZaloUndeliverableCore(sale, quan.id, {})), "thiếu lý do ⇒ từ chối");
      const t0 = new Date(Date.now() - 60_000);
      assert.ok("ok" in (await markZaloUndeliverableCore(sale, quan.id, { reason: "BLOCKS_STRANGERS", note: "Gửi tin báo «không nhận tin người lạ»" }, t0)));
      const p1 = (await contactPlansFor([quan.id])).get(quan.id)!;
      assert.deepEqual([p1.track, p1.zaloBlock?.source], ["DOMESTIC_EMAIL_FALLBACK", "MARKER"]);
      const rows1 = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, quan.id), eq(schema.wholesaleLeadActivities.kind, "ZALO")));
      assert.equal(rows1.length, 1);
      assert.equal(rows1[0]!.actorId, saleRow!.id, "người làm lưu bằng khoá tài khoản");
      assert.equal((await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, quan.id) }))!.zaloStatus, null, "chặn người lạ không phải «không có tài khoản»");

      // Hoàn tác = THÊM một dòng; dòng đánh dấu cũ còn nguyên; lead quay lại Zalo.
      assert.ok("ok" in (await undoZaloUndeliverableCore(sale, quan.id, { note: "khách đã kết bạn" }, new Date(t0.getTime() + 1_000))));
      const rows2 = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, quan.id), eq(schema.wholesaleLeadActivities.kind, "ZALO")));
      assert.deepEqual(rows2.map((r) => r.outcome).sort(), [ZALO_MARK_OUTCOME, ZALO_UNMARK_OUTCOME].sort(), "không xoá dòng nào");
      assert.equal((await contactPlansFor([quan.id])).get(quan.id)?.track, "DOMESTIC_ZALO");
      assert.ok("error" in (await undoZaloUndeliverableCore(sale, quan.id, {})), "không có dấu nào đang hiệu lực ⇒ không ghi dòng thừa");

      // «Không có tài khoản» ⇒ zalo_status = NOT_FOUND (một sự thật), và lead đi email dự phòng.
      assert.ok("ok" in (await markZaloUndeliverableCore(sale, quan.id, { reason: "NO_ACCOUNT" }, new Date(t0.getTime() + 2_000))));
      assert.equal((await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, quan.id) }))!.zaloStatus, "NOT_FOUND");
      assert.equal((await contactPlansFor([quan.id])).get(quan.id)?.track, "DOMESTIC_EMAIL_FALLBACK");
      const drafted = await emailDraftForLeadCore(sale, quan.id, { useAi: false });
      assert.ok("ok" in drafted, `làn chuyển sang email ⇒ soạn được thư (chạy thử): ${JSON.stringify(drafted)}`);

      // Danh sách chặn thắng: dừng cả email dự phòng.
      await db.insert(schema.wholesaleSuppressions).values({ kind: "EMAIL", value: "chu@quanzalo.vn", reason: "khách xin thôi" });
      assert.equal((await contactPlansFor([quan.id])).get(quan.id)?.track, "STOPPED");

      // Chưa biết nước (không ô quét · SĐT +1 dùng chung · .com) ⇒ làn «thiếu căn cứ nước»; NGƯỜI xác nhận ⇒ vào đúng làn.
      const hub = await mk({ businessName: "Seafood Hub", email: "buy@seafoodhub.com", phoneRaw: "+1 604 555 0100", websiteDomain: "seafoodhub.com" });
      assert.equal((await contactPlansFor([hub.id])).get(hub.id)?.track, "COUNTRY_UNKNOWN");
      assert.match(JSON.stringify(await emailDraftForLeadCore(sale, hub.id, { useAi: false })), /Thiếu căn cứ nước/, "chưa biết nước ⇒ không soạn email");
      assert.ok("error" in (await confirmLeadCountryCore(viewer, hub.id, { country: "CA" })), "không có wholesale:work ⇒ từ chối");
      assert.ok("error" in (await confirmLeadCountryCore(sale, hub.id, { country: "XX" })), "mã nước lạ ⇒ từ chối");
      assert.ok("ok" in (await confirmLeadCountryCore(sale, hub.id, { country: "us", note: "khách nói ở Seattle" }, new Date(Date.now() - 5_000))));
      assert.deepEqual([(await contactPlansFor([hub.id])).get(hub.id)?.track, (await contactPlansFor([hub.id])).get(hub.id)?.country], ["INTL_EMAIL", "US"]);
      assert.ok("ok" in (await confirmLeadCountryCore(sale, hub.id, { country: "CA", note: "sửa lại: chi nhánh Vancouver" })));
      const hubRows = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, hub.id), eq(schema.wholesaleLeadActivities.kind, "EDIT")));
      assert.equal(hubRows.length, 2, "xác nhận lại là một dòng MỚI, không sửa dòng cũ");
      assert.equal((await contactPlansFor([hub.id])).get(hub.id)?.country, "CA", "dòng mới nhất thắng");

      // Danh sách nước: chỉ quản trị, bắt buộc lý do, mã lạ bị chặn, có audit; kế hoạch đọc lại.
      assert.ok("error" in (await saveEmailAllowedCountriesCore(manager, { countries: ["JP"], reason: "Đã rà luật Nhật với luật sư 29/10" })), "MANAGER có wholesale:config vẫn không sửa được");
      assert.ok("error" in (await saveEmailAllowedCountriesCore(admin, { countries: ["JP"], reason: "ok" })), "lý do bắt buộc");
      assert.ok("error" in (await saveEmailAllowedCountriesCore(admin, { countries: ["XX"], reason: "Đã rà luật nước XX" })), "mã nước lạ ⇒ chặn");
      const saved = await saveEmailAllowedCountriesCore(admin, { countries: ["jp", "JP"], reason: "Đã rà luật Nhật với luật sư 29/10" });
      assert.ok("ok" in saved && saved.countries.join() === "JP", JSON.stringify(saved));
      assert.deepEqual((await getEmailSettings()).allowedCountries, ["JP"]);
      assert.equal((await contactPlansFor([tokyo.id])).get(tokyo.id)?.countryReviewed, true);
      const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "WHOLESALE_EMAIL_COUNTRIES"));
      assert.equal(logs.length, 1);
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

/** Mọi đường TẠO thư email đều hỏi làn ở máy chủ — một đường mới quên hỏi là cửa sau cho email tới khách còn nhắn Zalo được. */
function testEveryEmailPathAsksLane() {
  const outbox = readFileSync("lib/wholesale/email-outbox.ts", "utf8");
  const ai = readFileSync("lib/wholesale/email-ai-draft.ts", "utf8");
  // Thân hàm = từ dòng khai báo tới khai báo `export` kế tiếp (kho ghim LF ở tầng .gitattributes).
  const between = (src: string, fn: string) => {
    const start = src.indexOf(`export async function ${fn}`);
    assert.ok(start >= 0, `không thấy ${fn}`);
    const next = src.indexOf("\nexport ", start + 10);
    return src.slice(start, next < 0 ? undefined : next);
  };
  assert.match(between(outbox, "emailDraftFromOutreachCore"), /emailLaneRefusal\(/, "soạn từ lời chào hỏi làn");
  assert.match(between(ai, "aiDraftEmailCore"), /emailLaneRefusal\(/, "AI soạn nháp hỏi làn (trước khi tốn lượt AI)");
  assert.match(between(ai, "promoteAiDraftCore"), /emailLaneRefusal\(/, "đưa nháp AI vào hộp thư đi hỏi làn");
  for (const src of [outbox, ai]) {
    const inserts = (src.match(/\.insert\(schema\.wholesaleEmailOutbox\)/g) ?? []).length;
    assert.ok(inserts <= 1, "mỗi tệp chỉ một chỗ tạo thư — chỗ mới phải đi qua emailLaneRefusal");
  }
}

export async function testWholesaleChannelRouting() {
  testMatrix();
  testEveryEmailPathAsksLane();
  testCountryGate();
  await testDb();
  console.log("✓ Kế hoạch kênh: nước ngoài → email · trong nước → Zalo · Zalo hỏng + có email → email dự phòng · im lặng không đổi kênh · chặn / KHÔNG LIÊN HỆ dừng mọi kênh · «Zalo không gửi được» chỉ thêm dòng, hoàn tác là dòng mới · cổng nước: gửi thật chờ khi chưa rà luật, chạy thử in lý do");
}
