/**
 * ═══════════ SĂN KHÁCH SỈ P1a — CHẶN EMAIL · NHẬT KÝ ĐỒNG Ý · KHỬ TRÙNG EMAIL · NHIỆT ĐỘ (0261) ═══════════
 *
 *  1. THUẦN — `normalizeEmail` (trim + chữ thường, KHÔNG bỏ dấu chấm Gmail); `contactability` (mặc định KHÔNG khi thiếu đồng
 *     ý, email công khai không phải đồng ý, thu hồi ⇒ không, danh sách chặn thắng đồng ý, đồng ý gắn với ĐỊA CHỈ); nhiệt độ ở
 *     các ca biên (7 / 8 / 30 / 31 ngày, hẹn gọi lại, không có mốc, WON = không áp dụng).
 *  2. TỔ CHỨC THẬT `wl-consent`: chặn EMAIL chặn finalizeLead / soạn lời chào / huỷ lời chào đang chờ; nút «Không liên hệ»
 *     đưa cả email vào danh sách; khử trùng theo email (finalizeLead và đọc website) đúng thứ tự PHONE → DOMAIN → EMAIL → NAME,
 *     không gộp lead đã có người chăm; ghi / thu hồi đồng ý (quyền, phạm vi, căn cứ, chỉ thêm); và CHỨNG MINH SỔ TƯƠNG THÍCH
 *     cho 0261: CSDL chưa áp ⇒ đọc rơi về phía hẹp, ghi trả lỗi, nút «Không liên hệ» vẫn chạy.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_LEAD_HUNTER_CONFIG } from "@/lib/wholesale/config";
import { leadContactability, recordConsentCore, revokeConsentCore } from "@/lib/wholesale/consents";
import { contactability, normalizeContactValue, normalizeEmail, type ContactabilityLead } from "@/lib/wholesale/contactability";
import { enrichLeadWebsite, finalizeLead, findMasterLead } from "@/lib/wholesale/engine";
import { addEmailSuppressionCore, updateLeadStatusCore } from "@/lib/wholesale/leads";
import { prepareOutreachCore } from "@/lib/wholesale/outreach";
import type { EnrichmentProvider } from "@/lib/wholesale/providers";
import { saveLeadHunterConfig, suppressionHit } from "@/lib/wholesale/store";
import { leadTemperature, TEMPERATURE_HOT_DAYS, TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS, TEMPERATURE_WARM_DAYS } from "@/lib/wholesale/temperature";

const ORG = "wl-consent";

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testNormalizeEmail() {
  assert.equal(normalizeEmail("  Chu.Quan@Gmail.COM "), "chu.quan@gmail.com", "trim + chữ thường");
  assert.equal(normalizeEmail("chu.quan@gmail.com"), "chu.quan@gmail.com", "Gmail: KHÔNG bỏ dấu chấm");
  assert.notEqual(normalizeEmail("chuquan@gmail.com"), normalizeEmail("chu.quan@gmail.com"), "hai địa chỉ Gmail khác dấu chấm vẫn là HAI khoá");
  assert.equal(normalizeEmail("ban+si@quan.vn"), "ban+si@quan.vn", "không bỏ phần +nhãn");
  assert.equal(normalizeEmail("mailto:DatBan@Quan.vn"), "datban@quan.vn");
  for (const bad of ["", "   ", "khong-phai-email", "a@b", "a b@c.vn", null, undefined]) assert.equal(normalizeEmail(bad), null, String(bad));
  assert.equal(normalizeContactValue("PHONE", "0905 123 456"), "+84905123456");
  assert.equal(normalizeContactValue("ZALO", "+84905123456"), "+84905123456");
  assert.equal(normalizeContactValue("EMAIL", " A@B.VN "), "a@b.vn");
}

function testContactability() {
  const lead: ContactabilityLead = { contactStatus: "QUALIFIED", placeId: "ChIJx", phone: "+84905123456", email: "Chu@Quan.vn", websiteDomain: "quan.vn" };
  // Mặc định KHÔNG: email công khai (đọc từ website) mà không có dòng đồng ý ⇒ máy không được tự gửi.
  const none = contactability(lead, [], [], "EMAIL");
  assert.equal(none.allowed, false);
  assert.equal(none.reason, "NO_CONSENT");
  assert.match(none.detail, /website KHÔNG phải đồng ý/);
  assert.equal(contactability(lead, [], [], "PHONE").reason, "NO_CONSENT", "kênh nào cũng mặc định KHÔNG");
  // Có đồng ý còn hiệu lực đúng kênh, đúng địa chỉ (chuẩn hoá) ⇒ được.
  const ok = contactability(lead, [{ channel: "EMAIL", contactValue: "chu@quan.vn", basis: "REPLIED_INBOUND", revokedAt: null }], [], "EMAIL");
  assert.deepEqual([ok.allowed, ok.reason, ok.basis], [true, "CONSENTED", "REPLIED_INBOUND"]);
  // Đồng ý kênh khác không dùng được cho email.
  assert.equal(contactability(lead, [{ channel: "PHONE", contactValue: "+84905123456", basis: "VERBAL_CONSENT", revokedAt: null }], [], "EMAIL").reason, "NO_CONSENT");
  // Đồng ý cho ĐỊA CHỈ KHÁC (khách đổi email) không tính.
  assert.equal(contactability(lead, [{ channel: "EMAIL", contactValue: "cu@quan.vn", basis: "OPT_IN_FORM", revokedAt: null }], [], "EMAIL").reason, "NO_CONSENT");
  // Thu hồi ⇒ không.
  const revoked = contactability(lead, [{ channel: "EMAIL", contactValue: "chu@quan.vn", basis: "OPT_IN_FORM", revokedAt: new Date() }], [], "EMAIL");
  assert.deepEqual([revoked.allowed, revoked.reason], [false, "CONSENT_REVOKED"]);
  // Thu hồi một dòng nhưng còn dòng khác còn hiệu lực ⇒ được.
  assert.equal(contactability(lead, [{ channel: "EMAIL", contactValue: "chu@quan.vn", basis: "OPT_IN_FORM", revokedAt: new Date() }, { channel: "EMAIL", contactValue: "chu@quan.vn", basis: "VERBAL_CONSENT", revokedAt: null }], [], "EMAIL").allowed, true);
  // Căn cứ lạ (không thuộc danh sách đóng) không phải đồng ý.
  assert.equal(contactability(lead, [{ channel: "EMAIL", contactValue: "chu@quan.vn", basis: "PUBLIC_WEBSITE", revokedAt: null }], [], "EMAIL").allowed, false);
  // Danh sách chặn THẮNG đồng ý — khớp bất kỳ khoá nào, chặn mọi kênh.
  const consent = [{ channel: "EMAIL", contactValue: "chu@quan.vn", basis: "OPT_IN_FORM", revokedAt: null }];
  assert.equal(contactability(lead, consent, [{ kind: "EMAIL", value: "chu@quan.vn" }], "EMAIL").reason, "SUPPRESSED");
  assert.equal(contactability(lead, consent, [{ kind: "EMAIL", value: "chu@quan.vn" }], "PHONE", "MANUAL").reason, "SUPPRESSED", "chặn email ⇒ không liên hệ cả gọi tay");
  assert.equal(contactability(lead, consent, [{ kind: "DOMAIN", value: "quan.vn" }], "EMAIL").reason, "SUPPRESSED");
  assert.equal(contactability(lead, consent, [{ kind: "EMAIL", value: "khac@quan.vn" }], "EMAIL").reason, "CONSENTED", "dòng chặn email KHÁC không chạm lead này");
  // KHÔNG LIÊN HỆ thắng tất cả; thiếu địa chỉ ⇒ NO_CONTACT_VALUE.
  assert.equal(contactability({ ...lead, contactStatus: "DO_NOT_CONTACT" }, consent, [], "EMAIL").reason, "DO_NOT_CONTACT");
  assert.equal(contactability({ ...lead, email: "rac" }, consent, [], "EMAIL").reason, "NO_CONTACT_VALUE");
  // Thủ công: không cần đồng ý (quy trình gọi điện giữ nguyên), nhưng câu chữ nói rõ máy không được tự gửi.
  const manual = contactability(lead, [], [], "EMAIL", "MANUAL");
  assert.deepEqual([manual.allowed, manual.reason], [true, "MANUAL_ALLOWED"]);
  assert.match(manual.detail, /KHÔNG được tự gửi/);
}

function testTemperature() {
  const now = new Date("2026-10-27T03:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const t = (over: Parameters<typeof leadTemperature>[0]) => leadTemperature(over, now);
  // Khách đã phản hồi — ranh giới ngày.
  assert.equal(t({ grade: "C", status: "INTERESTED", lastContactAt: daysAgo(TEMPERATURE_HOT_DAYS) }).temperature, "HOT", "đúng 7 ngày vẫn NÓNG");
  assert.equal(t({ grade: "C", status: "INTERESTED", lastContactAt: daysAgo(TEMPERATURE_HOT_DAYS + 1) }).temperature, "WARM", "8 ngày ⇒ ẤM");
  assert.equal(t({ grade: "A", status: "NEGOTIATING", lastContactAt: daysAgo(TEMPERATURE_WARM_DAYS) }).temperature, "WARM", "đúng 30 ngày vẫn ẤM");
  const cold = t({ grade: "A", status: "PRICE_SENT", lastContactAt: daysAgo(TEMPERATURE_WARM_DAYS + 1) });
  assert.equal(cold.temperature, "COLD", "31 ngày ⇒ NGUỘI dù hạng A");
  assert.ok(cold.reasons.some((r) => r.includes("31 ngày")), cold.reasons.join(" | "));
  assert.equal(t({ grade: "A", status: "PRICE_SENT", lastContactAt: daysAgo(40), nextFollowupAt: new Date(now.getTime() + 86_400_000) }).temperature, "WARM", "im lâu nhưng đã hẹn gọi lại ⇒ ẤM");
  assert.equal(t({ grade: "A", status: "PRICE_SENT", lastContactAt: daysAgo(40), nextFollowupAt: daysAgo(1) }).temperature, "COLD", "hẹn đã qua không cứu được");
  // Mốc gần nhất là MAX của các mốc: liên hệ cũ nhưng ghi chú mới ⇒ NÓNG.
  assert.equal(t({ grade: "B", status: "INTERESTED", lastContactAt: daysAgo(50), lastActivityAt: daysAgo(2).toISOString() }).temperature, "HOT");
  // Không có mốc nào ⇒ ẤM kèm câu "chưa có mốc", không phải NÓNG.
  const unknown = t({ grade: "A", status: "INTERESTED" });
  assert.equal(unknown.temperature, "WARM");
  assert.ok(unknown.reasons.some((r) => r.includes("Chưa có mốc")));
  // Chưa phản hồi: không bao giờ NÓNG.
  assert.equal(t({ grade: "A", status: "CONTACTED", lastContactAt: daysAgo(0) }).temperature, "WARM", "vừa gọi mà khách chưa phản hồi ⇒ chưa NÓNG");
  assert.equal(t({ grade: "B", status: "NEW" }).temperature, "WARM");
  assert.equal(t({ grade: "C", status: "QUALIFIED" }).temperature, "COLD");
  assert.equal(t({ grade: null, status: "NEW" }).temperature, "COLD");
  assert.equal(t({ grade: "A", status: "NO_ANSWER", contactAttemptCount: TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS - 1 }).temperature, "WARM");
  assert.equal(t({ grade: "A", status: "NO_ANSWER", contactAttemptCount: TEMPERATURE_NO_ANSWER_COLD_ATTEMPTS }).temperature, "COLD");
  // Kết cục.
  const won = t({ grade: "A", status: "WON", lastContactAt: daysAgo(1) });
  assert.equal(won.temperature, null, "đã thành khách ⇒ KHÔNG ÁP DỤNG, không phải nguội");
  assert.ok(won.reasons.length > 0);
  assert.equal(t({ grade: "A", status: "LOST" }).temperature, "COLD");
  assert.equal(t({ grade: "A", status: "DO_NOT_CONTACT", lastContactAt: daysAgo(0) }).temperature, "COLD");
  // Trạng thái lạ ⇒ đọc như NEW (không ném).
  assert.equal(t({ grade: "D", status: "???" }).temperature, "COLD");
  // Ngày giờ hỏng ⇒ coi như không có mốc.
  assert.equal(t({ grade: "A", status: "INTERESTED", lastContactAt: "không-phải-ngày" }).temperature, "WARM");
}

// ─────────────────────────── 2. TỔ CHỨC THẬT ───────────────────────────

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

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser>, modules: string[]): SessionUser {
  return { id: u.id, email: u.email, name: "QT thử đồng ý", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Thử đồng ý sỉ", isHome: false }, modules, ...over };
}

async function testDb() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Thử đồng ý sỉ", plan: "standard", modules: ["customers", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT thử đồng ý", password: "DongY@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const L = schema.wholesaleLeads;
      const modules = [...(await getEnabledModules(ORG))];
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = sessionOf(u, {}, modules);
      const [viewerRow] = await db.insert(schema.users).values({ email: `xem@${ORG}.local`, name: "Chỉ xem", role: "CS", passwordHash: "x", dataScope: "ALL" }).returning();
      const viewer = sessionOf(viewerRow!, { role: "CS", name: "Chỉ xem", permissions: ["wholesale:view"] }, modules);
      const [saleRow] = await db.insert(schema.users).values({ email: `sale@${ORG}.local`, name: "Sale Lan", role: "CS", passwordHash: "x", dataScope: "ASSIGNED" }).returning();
      const sale = sessionOf(saleRow!, { role: "CS", name: "Sale Lan", permissions: ["wholesale:view", "wholesale:work"], scope: "ASSIGNED" }, modules);
      await saveLeadHunterConfig({ ...DEFAULT_LEAD_HUNTER_CONFIG, websiteEnrichment: { enabled: true, maxPages: 2 } });
      const cfg = { ...DEFAULT_LEAD_HUNTER_CONFIG, websiteEnrichment: { enabled: true, maxPages: 2 } };
      const t0 = new Date("2026-10-01T03:00:00Z");
      const at = (min: number) => new Date(t0.getTime() + min * 60_000);
      const ctx = { cfg, stats: [], now: () => at(1000) };
      const mk = async (over: Partial<typeof L.$inferInsert> & { firstSeenAt: Date }) => {
        const [row] = await db.insert(L).values({ source: "MANUAL_IMPORT", enrichmentStatus: "READY", segment: "SEAFOOD_RESTAURANT", ...over }).returning();
        return row!;
      };
      const get = async (id: string) => (await db.query.wholesaleLeads.findFirst({ where: eq(L.id, id) }))!;

      // ── Khử trùng theo email: dạng lưu cũ còn chữ hoa / khoảng trắng vẫn khớp ──
      const a = await mk({ businessName: "Quán Biển A", email: " Chu@QuanA.vn ", phoneRaw: "0905111222", normalizedPhone: "+84905111222", phoneKind: "MOBILE", phoneSource: "IMPORT", firstSeenAt: at(0) });
      assert.notEqual(await finalizeLead(ctx, a.id, null), "DUPLICATE");
      const b = await mk({ businessName: "Nhà hàng khác tên", email: "chu@quana.VN", firstSeenAt: at(10) });
      assert.equal(await finalizeLead(ctx, b.id, null), "DUPLICATE");
      const bRow = await get(b.id);
      assert.equal(bRow.duplicateOfLeadId, a.id, "trỏ về lead lâu đời hơn");
      assert.equal(bRow.filterReason, "DUPLICATE_EMAIL");
      // Thứ tự: SĐT đứng TRƯỚC email — lead mang SĐT của X và email của A ⇒ trùng X theo SĐT.
      const x = await mk({ businessName: "Quán X", email: "x@quanx.vn", phoneRaw: "0905333444", normalizedPhone: "+84905333444", phoneKind: "MOBILE", phoneSource: "IMPORT", firstSeenAt: at(20) });
      await finalizeLead(ctx, x.id, null);
      const n = await mk({ businessName: "Quán N", email: "chu@quana.vn", phoneRaw: "0905333444", normalizedPhone: "+84905333444", phoneKind: "MOBILE", phoneSource: "IMPORT", firstSeenAt: at(30) });
      assert.equal(await finalizeLead(ctx, n.id, null), "DUPLICATE");
      const nRow = await get(n.id);
      assert.deepEqual([nRow.duplicateOfLeadId, nRow.filterReason], [x.id, "DUPLICATE_PHONE"], "SĐT → tên miền → EMAIL → tên");
      // Tên miền cũng đứng trước email.
      const d1 = await mk({ businessName: "Quán D1", website: "https://quand.vn", websiteDomain: "quand.vn", email: "d1@quand.vn", firstSeenAt: at(40) });
      await finalizeLead(ctx, d1.id, null);
      assert.deepEqual(await findMasterLead(null, { domain: "quand.vn", email: "chu@quana.vn" }), { id: d1.id, by: "DOMAIN" });
      assert.deepEqual(await findMasterLead(null, { email: "CHU@quana.vn" }), { id: a.id, by: "EMAIL" });
      // Liên kết trùng cũ không bị gỡ: B vẫn trỏ về A sau mọi lượt trên.
      assert.equal((await get(b.id)).duplicateOfLeadId, a.id);

      // ── Đọc website điền email đã thuộc lead khác ⇒ đánh dấu trùng (lead mới, chưa ai chăm) ──
      const enricher = (email: string): EnrichmentProvider => ({
        key: "WEBSITE",
        label: "giả",
        role: "ENRICHMENT",
        googleSourced: false,
        billable: false,
        async enrich(site) {
          return { status: "DONE", pagesRead: 1, note: "Đọc 1 trang", findings: [{ kind: "EMAIL", value: email, sourceUrl: `${site}/lien-he` }] };
        },
      });
      const w = await mk({ businessName: "Quán W", website: "https://quanw.vn", websiteDomain: "quanw.vn", websiteStatus: "PENDING", firstSeenAt: at(50) });
      await enrichLeadWebsite({ ...ctx, enricher: enricher("  CHU@QuanA.vn") }, await get(w.id));
      const wRow = await get(w.id);
      assert.equal(wRow.email, "chu@quana.vn", "email từ website lưu ở dạng chuẩn hoá");
      assert.deepEqual([wRow.enrichmentStatus, wRow.duplicateOfLeadId, wRow.filterReason], ["DUPLICATE", a.id, "DUPLICATE_EMAIL"]);
      // Lead đã có người chăm ⇒ máy KHÔNG gộp, chỉ ghi một dòng để người xem.
      const v = await mk({ businessName: "Quán V", website: "https://quanv.vn", websiteDomain: "quanv.vn", websiteStatus: "PENDING", contactStatus: "CONTACTED", firstContactAt: at(55), firstSeenAt: at(55) });
      await enrichLeadWebsite({ ...ctx, enricher: enricher("chu@quana.vn") }, await get(v.id));
      const vRow = await get(v.id);
      assert.deepEqual([vRow.enrichmentStatus, vRow.duplicateOfLeadId], ["READY", null], "lead người chăm không bị máy ghi đè");
      const vActs = await db.select().from(schema.wholesaleLeadActivities).where(eq(schema.wholesaleLeadActivities.leadId, v.id));
      assert.ok(vActs.some((x) => x.note.includes("không tự gộp")), "để lại vết cho người xem");
      // Lead kia MỚI HƠN ⇒ không gộp ngược lead cũ vào lead mới.
      const old = await mk({ businessName: "Quán Cũ", website: "https://quancu.vn", websiteDomain: "quancu.vn", websiteStatus: "PENDING", firstSeenAt: new Date("2026-09-01T00:00:00Z") });
      await enrichLeadWebsite({ ...ctx, enricher: enricher("x@quanx.vn") }, await get(old.id));
      assert.equal((await get(old.id)).enrichmentStatus, "READY");

      // ── Danh sách chặn EMAIL ──
      assert.ok("error" in (await addEmailSuppressionCore(viewer, { email: "a@b.vn", reason: "khách xin ngừng" })), "không có wholesale:work ⇒ không thêm được");
      assert.ok("error" in (await addEmailSuppressionCore(admin, { email: "khong-hop-le", reason: "khách xin ngừng" })));
      assert.ok("error" in (await addEmailSuppressionCore(admin, { email: "a@b.vn", reason: "x" })), "lý do bắt buộc");
      // Lead Y có SĐT + email, soạn lời chào xong rồi mới bị chặn ⇒ lời chào đang chờ bị huỷ, soạn lại bị chặn.
      const y = await mk({ businessName: "Quán Y", email: "Spam@QuanY.vn", phoneRaw: "0905777888", normalizedPhone: "+84905777888", phoneKind: "MOBILE", phoneSource: "IMPORT", contactStatus: "QUALIFIED", firstSeenAt: at(60) });
      const draft = await prepareOutreachCore(admin, y.id, { channel: "PHONE_CALL", useAi: false });
      assert.ok("ok" in draft, JSON.stringify(draft));
      const added = await addEmailSuppressionCore(admin, { email: "  SPAM@quany.VN ", reason: "khách trả lời xin ngừng gửi" });
      assert.ok("ok" in added && added.email === "spam@quany.vn" && !added.existed && added.leads === 1, JSON.stringify(added));
      const again = await addEmailSuppressionCore(admin, { email: "spam@quany.vn", reason: "bấm lại lần hai" });
      assert.ok("ok" in again && again.existed, "thêm lại ⇒ MỘT dòng, không nhân");
      const supRows = await db.select().from(schema.wholesaleSuppressions).where(and(eq(schema.wholesaleSuppressions.kind, "EMAIL"), eq(schema.wholesaleSuppressions.value, "spam@quany.vn")));
      assert.equal(supRows.length, 1);
      assert.equal(supRows[0]!.createdByUserId, admin.id, "người thêm lưu bằng khoá tài khoản");
      const item = await db.query.wholesaleOutreachItems.findFirst({ where: eq(schema.wholesaleOutreachItems.id, "ok" in draft ? draft.id : "") });
      assert.equal(item?.status, "CANCELLED", "lời chào đang chờ bị huỷ");
      const blocked = await prepareOutreachCore(admin, y.id, { channel: "PHONE_CALL", useAi: false });
      assert.ok("error" in blocked && /danh sách không liên hệ/.test(blocked.error), JSON.stringify(blocked));
      assert.ok(await suppressionHit({ email: " Spam@QuanY.vn" }), "suppressionHit chuẩn hoá email");
      // Lead mới mang email bị chặn ⇒ finalizeLead lọc SUPPRESSED.
      const z = await mk({ businessName: "Quán Z", email: "spam@quany.vn", phoneRaw: "0905999000", normalizedPhone: "+84905999000", phoneKind: "MOBILE", phoneSource: "IMPORT", firstSeenAt: at(70) });
      assert.equal(await finalizeLead(ctx, z.id, null), "FILTERED");
      assert.equal((await get(z.id)).filterReason, "SUPPRESSED");
      // Nút «Không liên hệ» trên lead đưa cả EMAIL vào danh sách.
      const k = await mk({ businessName: "Quán K", email: "Chu@QuanK.vn", firstSeenAt: at(80) });
      assert.ok("ok" in (await updateLeadStatusCore(admin, k.id, { status: "DO_NOT_CONTACT", note: "khách từ chối" })));
      assert.ok(await suppressionHit({ email: "chu@quank.vn" }), "DNC ⇒ email vào danh sách");

      // ── Nhật ký đồng ý ──
      const q = await mk({ businessName: "Quán Q", website: "https://quanq.vn", websiteDomain: "quanq.vn", websiteStatus: "PENDING", phoneRaw: "0905121212", normalizedPhone: "+84905121212", phoneKind: "MOBILE", phoneSource: "IMPORT", firstSeenAt: at(90) });
      await enrichLeadWebsite({ ...ctx, enricher: enricher("lienhe@quanq.vn") }, await get(q.id));
      let qRow = await get(q.id);
      assert.equal(qRow.email, "lienhe@quanq.vn");
      let view = await leadContactability(qRow, null);
      assert.deepEqual([view.byChannel.EMAIL.allowed, view.byChannel.EMAIL.reason], [false, "NO_CONSENT"], "email công khai trên website KHÔNG phải đồng ý");
      assert.equal(view.byChannel.PHONE.reason, "NO_CONSENT");
      assert.equal((await db.select().from(schema.wholesaleContactConsents)).length, 0, "bộ đọc website không bao giờ ghi một dòng đồng ý");
      // Quyền + phạm vi + căn cứ.
      const evidence = { channel: "EMAIL", basis: "REPLIED_INBOUND", evidenceText: "Khách gửi mail hỏi bảng giá sỉ 27/10" };
      assert.ok("error" in (await recordConsentCore(viewer, q.id, evidence)), "không có wholesale:work");
      assert.ok("error" in (await recordConsentCore(sale, q.id, evidence)), "phạm vi «Được giao» ⇒ lead của người khác không ghi được");
      assert.ok("error" in (await recordConsentCore(admin, q.id, { ...evidence, evidenceText: "ok" })), "bằng chứng quá ngắn");
      assert.ok("error" in (await recordConsentCore(admin, q.id, { ...evidence, basis: "PUBLIC_WEBSITE" })), "căn cứ ngoài danh sách đóng");
      assert.ok("error" in (await recordConsentCore(admin, q.id, { ...evidence, basis: "EXISTING_CUSTOMER" })), "chưa là khách hàng");
      assert.ok("error" in (await recordConsentCore(admin, q.id, { ...evidence, basis: "B2B_PUBLIC_PROCUREMENT" })), "lời mời chào hàng cần link");
      assert.ok("error" in (await recordConsentCore(admin, q.id, { ...evidence, evidenceUrl: "javascript:alert(1)" })), "link phải http(s)");
      const rec = await recordConsentCore(admin, q.id, evidence);
      assert.ok("ok" in rec, JSON.stringify(rec));
      const stored = await db.query.wholesaleContactConsents.findFirst({ where: eq(schema.wholesaleContactConsents.id, "ok" in rec ? rec.id : "") });
      assert.deepEqual([stored?.contactValue, stored?.recordedByUserId, stored?.source], ["lienhe@quanq.vn", admin.id, "STAFF"], "trống địa chỉ ⇒ lấy email của lead; người ghi = khoá tài khoản");
      qRow = await get(q.id);
      view = await leadContactability(qRow, null);
      assert.deepEqual([view.byChannel.EMAIL.allowed, view.byChannel.EMAIL.reason], [true, "CONSENTED"]);
      assert.equal(view.byChannel.PHONE.allowed, false, "đồng ý email không mở kênh gọi tự động");
      // Thu hồi ⇒ không; dòng KHÔNG bị xoá; thu hồi lần hai báo lỗi.
      const consentId = "ok" in rec ? rec.id : "";
      assert.ok("error" in (await revokeConsentCore(admin, consentId, { reason: "x" })), "lý do thu hồi bắt buộc");
      assert.ok("ok" in (await revokeConsentCore(admin, consentId, { reason: "khách nhắn xin ngừng gửi mail" })));
      assert.ok("error" in (await revokeConsentCore(admin, consentId, { reason: "bấm lại lần hai" })), "đã thu hồi ⇒ không ghi đè mốc");
      view = await leadContactability(qRow, null);
      assert.deepEqual([view.byChannel.EMAIL.allowed, view.byChannel.EMAIL.reason], [false, "CONSENT_REVOKED"]);
      const all = await db.select().from(schema.wholesaleContactConsents).where(eq(schema.wholesaleContactConsents.leadId, q.id));
      assert.equal(all.length, 1, "nhật ký chỉ thêm — thu hồi không xoá dòng");
      assert.ok(all[0]!.revokedAt && all[0]!.revokedByUserId === admin.id);
      const acts = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, q.id), eq(schema.wholesaleLeadActivities.kind, "CONSENT")));
      assert.equal(acts.length, 2, "ghi + thu hồi đều vào lịch sử lead");
      // CSDL tự chặn dòng thu hồi thiếu lý do.
      await assert.rejects(async () => void (await db.insert(schema.wholesaleContactConsents).values({ leadId: q.id, channel: "EMAIL", contactValue: "lienhe@quanq.vn", basis: "OPT_IN_FORM", evidenceText: "form landing 27/10", revokedAt: new Date() })), "CHECK revoke");
      await assert.rejects(async () => void (await db.insert(schema.wholesaleContactConsents).values({ leadId: q.id, channel: "EMAIL", contactValue: "lienhe@quanq.vn", basis: "NONE", evidenceText: "không có căn cứ" })), "CHECK basis: không có NONE");
      // Đã chặn ⇒ đồng ý không mở lại được.
      await addEmailSuppressionCore(admin, { email: "lienhe@quanq.vn", reason: "khách xin ngừng gửi" });
      assert.ok("ok" in (await recordConsentCore(admin, q.id, { ...evidence, basis: "VERBAL_CONSENT", evidenceText: "Gọi 28/10, chị chủ đồng ý nhận mail" })));
      view = await leadContactability(await get(q.id), null);
      assert.equal(view.byChannel.EMAIL.reason, "SUPPRESSED", "danh sách chặn thắng đồng ý mới");
      // Lead KHÔNG LIÊN HỆ ⇒ không ghi đồng ý.
      assert.ok("error" in (await recordConsentCore(admin, k.id, evidence)));

      // ── SERVE-COMPAT 0261 (lib/constants/migration-serve-compat.ts): CSDL như TRƯỚC 0261 — bảng đồng ý chưa có, CHECK kind cũ.
      await db.execute(sql.raw(`ALTER TABLE wholesale_contact_consents RENAME TO wholesale_contact_consents_tam`));
      await db.execute(sql.raw(`ALTER TABLE wholesale_suppressions DROP CONSTRAINT wholesale_suppressions_kind_check`));
      await db.execute(sql.raw(`ALTER TABLE wholesale_suppressions ADD CONSTRAINT wholesale_suppressions_kind_check CHECK (kind IN ('PHONE','DOMAIN','PLACE')) NOT VALID`));
      try {
        const old = await leadContactability(await get(q.id), null);
        assert.equal(old.schemaReady, false, "thiếu bảng ⇒ biết là CHƯA ÁP, không giả là đã đọc");
        assert.deepEqual([old.byChannel.EMAIL.allowed, old.byChannel.EMAIL.reason], [false, "SUPPRESSED"], "danh sách chặn vẫn đọc được");
        const r2 = await mk({ businessName: "Quán Cũ Lược Đồ", email: "cu@luocdo.vn", phoneRaw: "0905454545", normalizedPhone: "+84905454545", phoneKind: "MOBILE", phoneSource: "IMPORT", firstSeenAt: at(95) });
        const oldView = await leadContactability(r2, null);
        assert.deepEqual([oldView.schemaReady, oldView.byChannel.EMAIL.allowed, oldView.byChannel.EMAIL.reason], [false, false, "NO_CONSENT"], "thiếu bảng ⇒ rơi về phía HẸP");
        const rec2 = await recordConsentCore(admin, r2.id, evidence);
        assert.ok("error" in rec2 && /0261/.test(rec2.error), JSON.stringify(rec2));
        const rev2 = await revokeConsentCore(admin, consentId, { reason: "thử trên lược đồ cũ" });
        assert.ok("error" in rev2 && /0261/.test(rev2.error), JSON.stringify(rev2));
        const sup2 = await addEmailSuppressionCore(admin, { email: "cu@luocdo.vn", reason: "khách xin ngừng gửi" });
        assert.ok("error" in sup2 && /0261/.test(sup2.error), JSON.stringify(sup2));
        // Nút «Không liên hệ» vẫn chạy: bỏ riêng dòng email, SĐT vẫn vào danh sách.
        assert.ok("ok" in (await updateLeadStatusCore(admin, r2.id, { status: "DO_NOT_CONTACT", note: "khách từ chối" })));
        assert.ok(await suppressionHit({ phone: "+84905454545" }), "SĐT vẫn vào danh sách");
        assert.equal(await suppressionHit({ email: "cu@luocdo.vn" }), null, "dòng email bị bỏ (CHECK cũ), không làm hỏng lượt ghi");
      } finally {
        await db.execute(sql.raw(`ALTER TABLE wholesale_contact_consents_tam RENAME TO wholesale_contact_consents`));
        await db.execute(sql.raw(`ALTER TABLE wholesale_suppressions DROP CONSTRAINT wholesale_suppressions_kind_check`));
        await db.execute(sql.raw(`ALTER TABLE wholesale_suppressions ADD CONSTRAINT wholesale_suppressions_kind_check CHECK (kind IN ('PHONE','DOMAIN','PLACE','EMAIL'))`));
      }
    });
  } finally {
    await cleanupOrg();
  }
}

export async function testWholesaleConsent() {
  testNormalizeEmail();
  testContactability();
  testTemperature();
  await testDb();
  console.log("✓ Săn khách sỉ P1a: chặn EMAIL (chuẩn hoá, huỷ lời chào, DNC) · đồng ý liên hệ mặc định KHÔNG, email công khai ≠ đồng ý, thu hồi · khử trùng email PHONE→DOMAIN→EMAIL→NAME · nhiệt độ ca biên");
}
