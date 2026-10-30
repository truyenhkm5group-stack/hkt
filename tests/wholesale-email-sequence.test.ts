/**
 * CHUỖI THƯ THEO DÕI (P4a · lib/wholesale/email-sequence.ts + email-sequence-core.ts).
 *
 *  1. THUẦN: không khai N / K ⇒ không có lần nhắc nào. Đến hạn đúng sau K ngày, tối đa N lần. Dừng khi khách trả lời, huỷ đăng ký,
 *     khiếu nại, bounce cứng, bị chặn / không liên hệ, lead Thắng / Mất. Có thư đang mở ⇒ chưa soạn thêm. Chưa gửi thư mở đầu ⇒ chưa nhắc.
 *  2. TỔ CHỨC THẬT: chưa khai ⇒ bảng trống và soạn bị từ chối. Chỉ `wholesale:config` khai được. Đến hạn ⇒ soạn từ mẫu thành thư
 *     DRAFT (FOLLOWUP) chờ duyệt — không tự gửi, không thêm thư SENT nào. Soạn AI ⇒ nháp AI bước 1, đưa vào hộp thư đi ra thư
 *     FOLLOWUP. Điều kiện dừng đo trên CSDL thật. Mẫu vi phạm hàng rào ⇒ không tạo thư.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { ScopeDecision } from "@/lib/auth/scope-guard";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { savePriceListCore } from "@/lib/records/trade";
import { promoteAiDraftCore, saveEmailAiSettingsCore } from "@/lib/wholesale/email-ai-draft";
import { parseEmailSequenceSettings, renderSequenceTemplate, sequenceState, type SequenceInput } from "@/lib/wholesale/email-sequence";
import { createFollowupDraftCore, loadSequenceBoard, saveEmailSequenceSettingsCore } from "@/lib/wholesale/email-sequence-core";

const ORG = "em-seq";
const DAY = 86_400_000;

function testPure() {
  const t0 = new Date("2026-10-01T03:00:00Z");
  const cfg = parseEmailSequenceSettings({ maxFollowups: 2, gapDays: 3 });
  const base: SequenceInput = { settings: cfg, hasEmail: true, leadStatus: "CONTACTED", suppressed: false, sent: [{ sequenceStep: 0, sentAt: t0 }], eventKinds: ["QUEUED", "SENT"], hasOpenMail: false };
  const at = (days: number) => new Date(t0.getTime() + days * DAY);
  assert.deepEqual(sequenceState({ ...base, settings: parseEmailSequenceSettings({}) }, at(30)), { state: "STOPPED", reason: "NOT_CONFIGURED" }, "không khai ⇒ không nhắc, không có số mặc định");
  assert.deepEqual(parseEmailSequenceSettings({ maxFollowups: 0, gapDays: -1 }), { maxFollowups: null, gapDays: null, templates: { vi: "", en: "" } }, "số sai ⇒ coi như chưa khai");
  assert.equal(sequenceState({ ...base, settings: parseEmailSequenceSettings({ maxFollowups: 2 }) }, at(30)).state, "STOPPED", "thiếu K ⇒ không nhắc");
  assert.equal(sequenceState(base, at(2.9)).state, "WAITING");
  const due = sequenceState(base, at(3));
  assert.ok(due.state === "DUE" && due.nextStep === 1, "đúng K ngày ⇒ đến hạn lần nhắc 1");
  assert.equal(sequenceState({ ...base, sent: [...base.sent, { sequenceStep: 1, sentAt: at(3) }] }, at(5)).state, "WAITING", "K ngày tính từ thư TRƯỚC");
  const second = sequenceState({ ...base, sent: [...base.sent, { sequenceStep: 1, sentAt: at(3) }] }, at(6));
  assert.ok(second.state === "DUE" && second.nextStep === 2);
  assert.deepEqual(sequenceState({ ...base, sent: [...base.sent, { sequenceStep: 1, sentAt: at(3) }, { sequenceStep: 2, sentAt: at(6) }] }, at(30)), { state: "STOPPED", reason: "COMPLETED" }, "đủ N lần ⇒ dừng");
  const stop = (over: Partial<SequenceInput>) => sequenceState({ ...base, ...over }, at(30));
  assert.deepEqual(stop({ eventKinds: ["SENT", "REPLY"] }), { state: "STOPPED", reason: "REPLIED" });
  assert.deepEqual(stop({ eventKinds: ["UNSUBSCRIBE"] }), { state: "STOPPED", reason: "UNSUBSCRIBED" });
  assert.deepEqual(stop({ eventKinds: ["COMPLAINT"] }), { state: "STOPPED", reason: "COMPLAINT" });
  assert.deepEqual(stop({ eventKinds: ["BOUNCE_HARD"] }), { state: "STOPPED", reason: "BOUNCE_HARD" });
  assert.equal(stop({ eventKinds: ["BOUNCE_SOFT"] }).state, "DUE", "bounce mềm không dừng chuỗi");
  assert.deepEqual(stop({ suppressed: true }), { state: "STOPPED", reason: "SUPPRESSED" });
  assert.deepEqual(stop({ leadStatus: "DO_NOT_CONTACT" }), { state: "STOPPED", reason: "SUPPRESSED" });
  assert.deepEqual(stop({ leadStatus: "WON" }), { state: "STOPPED", reason: "LEAD_CLOSED" });
  assert.deepEqual(stop({ leadStatus: "LOST" }), { state: "STOPPED", reason: "LEAD_CLOSED" });
  assert.deepEqual(stop({ hasEmail: false }), { state: "STOPPED", reason: "NO_EMAIL" });
  assert.deepEqual(stop({ sent: [] }), { state: "STOPPED", reason: "NOT_STARTED" });
  assert.deepEqual(stop({ hasOpenMail: true }), { state: "PENDING_MAIL", nextStep: 1 }, "đang có thư / nháp mở ⇒ không soạn chồng");
  assert.equal(renderSequenceTemplate("Kính gửi {{ten_doanh_nghiep}} — {{ten_shop}} (lần {{lan_nhac}}) {{la}}", { businessName: "Quán A", shopName: "HSLC", step: 1 }), "Kính gửi Quán A — HSLC (lần 2) {{la}}");
  console.log("  ✓ thuần: không khai ⇒ không nhắc · đến hạn sau K ngày từ thư trước · tối đa N · dừng: trả lời / huỷ ĐK / khiếu nại / bounce cứng / chặn / Thắng-Mất · thư mở ⇒ không chồng");
}

class FakeAi implements AiProvider {
  readonly name = "fake";
  readonly model = "gemini-2.5-flash";
  readonly schemaDialect = "openai" as const;
  lastSystem = "";
  constructor(public reply: string) {}
  async complete(req: AiRequest): Promise<AiResponse> {
    this.lastSystem = req.system;
    return { content: [{ type: "text", text: this.reply }], stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model, latencyMs: 5 };
  }
}

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

const errOf = (r: object) => ("error" in r ? String((r as { error: string }).error) : "");
const ALL: ScopeDecision = { allow: "ALL", explain: "kiểm thử" };

async function testOrg() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Hải sản chuỗi thư", plan: "standard", modules: ["customers", "products", "orders", "inventory", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT chuỗi", password: "ChuoiThu@12345" }, source: "TEST", actor: null });
  try {
    const modules = [...(await getEnabledModules(ORG))];
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { departmentCodes: [], positionId: null, organization: { code: ORG, name: "Hải sản chuỗi thư", isHome: false }, modules };
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", ...base };
      const sale: SessionUser = { ...admin, role: "CS", permissions: ["wholesale:view", "wholesale:work"] };

      await db.insert(schema.products).values({ id: "sq-prod", name: "Chả cá thu", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values({ id: "sq-va", productId: "sq-prod", sku: "CCT-1K", size: "1kg", retailPrice: 300_000 });
      assert.ok((await savePriceListCore(admin, null, { name: "Sỉ chung", isDefault: true, tiers: [{ variantId: "sq-va", minQuantity: 10, unitPrice: 250_000 }] })).ok);

      const now = new Date();
      const lead = async (name: string, email: string, over: Partial<typeof schema.wholesaleLeads.$inferInsert> = {}) => {
        const [l] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: name, email, phoneCountryCode: "84", enrichmentStatus: "READY", contactStatus: "CONTACTED", ...over }).returning({ id: schema.wholesaleLeads.id });
        await db.insert(schema.wholesaleEmailOutbox).values({ leadId: l.id, toEmail: email, recipientDomain: email.split("@")[1], subject: "Bảng giá sỉ chả cá thu", bodyText: "Kính gửi anh/chị, chả cá thu 1kg giá sỉ 250.000 ₫ từ 10 gói. Anh/chị trả lời email để nhận báo giá ạ.", templateKey: "OPENER_D0", sequenceStep: 0, status: "SENT", mode: "DRY_RUN", sentAt: new Date(now.getTime() - 5 * DAY), approvalUsedAt: new Date(now.getTime() - 5 * DAY), idempotencyKey: `${l.id}:OPENER_D0:0:${email}`, preparedBy: "USER" });
        return l.id;
      };
      const a = await lead("Quán Biển A", "a@quanbien.vn");
      const b = await lead("Quán Biển B", "b@quanbien.vn");
      const replied = await lead("Quán Đã Trả Lời", "r@quanbien.vn");
      const won = await lead("Quán Đã Mua", "w@quanbien.vn", { contactStatus: "WON" });
      const blocked = await lead("Quán Bị Chặn", "x@quanbien.vn");
      const unsub = await lead("Quán Huỷ ĐK", "u@quanbien.vn");
      const bounced = await lead("Quán Bounce", "bo@quanbien.vn");
      await db.insert(schema.wholesaleEmailEvents).values([
        { leadId: replied, kind: "REPLY" },
        { leadId: unsub, kind: "UNSUBSCRIBE" },
        { leadId: bounced, kind: "BOUNCE_HARD" },
      ]);
      await db.insert(schema.wholesaleSuppressions).values({ kind: "EMAIL", value: "x@quanbien.vn", reason: "khách xin không nhận thư" });
      const sentBefore = (await db.select().from(schema.wholesaleEmailOutbox).where(eq(schema.wholesaleEmailOutbox.status, "SENT"))).length;

      // ── Chưa khai ⇒ không có lần nhắc nào.
      const b0 = await loadSequenceBoard(ALL, now);
      assert.ok(!("unavailable" in b0) && !b0.configured && b0.due.length === 0);
      assert.match(errOf(await createFollowupDraftCore(sale, a, { source: "TEMPLATE" }, now)), /chưa khai/);

      // ── Chỉ wholesale:config khai; khai thiếu một nửa bị chặn.
      assert.match(errOf(await saveEmailSequenceSettingsCore(sale, { maxFollowups: 2, gapDays: 3, reason: "thử" })), /wholesale:config/);
      assert.match(errOf(await saveEmailSequenceSettingsCore(admin, { maxFollowups: 2, reason: "thiếu K" })), /CẢ/);
      const tpl = "Kính gửi {{ten_doanh_nghiep}}, bên em gửi lại thư trước về bảng giá sỉ chả cá thu. Anh/chị trả lời email này giúp em để nhận báo giá chi tiết nhé.";
      assert.ok("ok" in (await saveEmailSequenceSettingsCore(admin, { maxFollowups: 2, gapDays: 3, templates: { vi: tpl, en: "" }, reason: "Chuỗi nhắc thí điểm HSLC" })));

      // ── Bảng: chỉ lead còn chuỗi; mọi điều kiện dừng đo trên CSDL thật.
      const b1 = await loadSequenceBoard(ALL, now);
      assert.ok(!("unavailable" in b1));
      assert.deepEqual(b1.due.map((d) => d.leadId).sort(), [a, b].sort());
      assert.deepEqual(b1.stopped, { REPLIED: 1, LEAD_CLOSED: 1, SUPPRESSED: 1, UNSUBSCRIBED: 1, BOUNCE_HARD: 1 });
      for (const id of [replied, won, blocked, unsub, bounced]) assert.match(errOf(await createFollowupDraftCore(sale, id, { source: "TEMPLATE" }, now)), /đã dừng/);
      assert.match(errOf(await createFollowupDraftCore(sale, a, { source: "TEMPLATE" }, new Date(now.getTime() - 3 * DAY))), /Chưa tới hạn/, "chưa đủ K ngày ⇒ từ chối");

      // ── Mẫu ⇒ thư DRAFT FOLLOWUP chờ duyệt; KHÔNG gửi.
      const t = await createFollowupDraftCore(sale, a, { source: "TEMPLATE" }, now);
      assert.ok("ok" in t && t.kind === "OUTBOX", errOf(t));
      const [mail] = await db.select().from(schema.wholesaleEmailOutbox).where(eq(schema.wholesaleEmailOutbox.id, t.outboxId));
      assert.deepEqual([mail.templateKey, mail.sequenceStep, mail.status, mail.approvedByUserId, mail.subject.startsWith("Re: ")], ["FOLLOWUP", 1, "DRAFT", null, true]);
      assert.ok(mail.bodyText.includes("Quán Biển A"));
      assert.equal((await db.select().from(schema.wholesaleEmailOutbox).where(eq(schema.wholesaleEmailOutbox.status, "SENT"))).length, sentBefore, "không tự gửi thư nào");
      assert.match(errOf(await createFollowupDraftCore(sale, a, { source: "TEMPLATE" }, now)), /đang có thư/, "đã có thư nhắc mở ⇒ không soạn chồng");
      const b2 = await loadSequenceBoard(ALL, now);
      assert.ok(!("unavailable" in b2) && !b2.due.some((d) => d.leadId === a));

      // ── AI ⇒ nháp AI bước 1 (lời nhắc «thư nhắc»), người đưa vào hộp thư đi ⇒ thư FOLLOWUP bước 1.
      assert.match(errOf(await createFollowupDraftCore(sale, b, { source: "AI" }, now, { ai: { provider: new FakeAi("x"), source: "BYOK" } })), /TẮT/, "AI soạn email tắt ⇒ không soạn");
      assert.ok("ok" in (await saveEmailAiSettingsCore(admin, { enabled: true, dailyMaxDrafts: 10, dailyCostCapUsd: 1, reason: "thí điểm" })));
      const fake = new FakeAi("SUBJECT: Re: Bảng giá sỉ chả cá thu\n---\nKính gửi Quý anh/chị Quán Biển B, bên em xin nhắc lại thư trước về chả cá thu 1kg giá sỉ 250.000 ₫ từ 10 gói. Anh/chị trả lời email này để nhận báo giá chi tiết ạ.");
      const ai = await createFollowupDraftCore(sale, b, { source: "AI" }, now, { ai: { provider: fake, source: "BYOK" } });
      assert.ok("ok" in ai && ai.kind === "AI_DRAFT" && ai.draft.status === "DRAFT", errOf(ai));
      assert.match(fake.lastSystem, /THƯ NHẮC LẦN 1/);
      const p = await promoteAiDraftCore(admin, ai.draft.id, { subject: "Re: Bảng giá sỉ chả cá thu", body: "Kính gửi Quý anh/chị Quán Biển B, bên em xin nhắc lại thư trước về chả cá thu 1kg giá sỉ 250.000 ₫ từ 10 gói. Anh/chị trả lời email này để nhận báo giá chi tiết ạ." });
      assert.ok("ok" in p, errOf(p));
      const [fu] = await db.select().from(schema.wholesaleEmailOutbox).where(eq(schema.wholesaleEmailOutbox.id, p.outboxId));
      assert.deepEqual([fu.templateKey, fu.sequenceStep, fu.status], ["FOLLOWUP", 1, "DRAFT"]);

      // ── Mẫu vi phạm hàng rào ⇒ không tạo thư.
      const c = await lead("Quán Biển C", "c@quanbien.vn");
      await saveEmailSequenceSettingsCore(admin, { maxFollowups: 2, gapDays: 3, templates: { vi: "Kính gửi {{ten_doanh_nghiep}}, đơn đầu giảm 20% và giao trong 1 ngày. Anh/chị trả lời giúp em nhé.", en: "" }, reason: "mẫu thử sai" });
      const n0 = (await db.select().from(schema.wholesaleEmailOutbox)).length;
      assert.match(errOf(await createFollowupDraftCore(sale, c, { source: "TEMPLATE" }, now)), /vi phạm/);
      assert.equal((await db.select().from(schema.wholesaleEmailOutbox)).length, n0);

      // ── Bỏ cấu hình (trống cả hai) ⇒ chuỗi tắt.
      await saveEmailSequenceSettingsCore(admin, { maxFollowups: null, gapDays: null, reason: "tắt chuỗi" });
      const b3 = await loadSequenceBoard(ALL, now);
      assert.ok(!("unavailable" in b3) && !b3.configured && b3.due.length === 0);
    });
  } finally {
    await cleanupOrg();
  }
  console.log("  ✓ tổ chức thật: chưa khai ⇒ không nhắc · chỉ wholesale:config khai · đến hạn đúng lead · dừng (trả lời / Thắng / chặn / huỷ ĐK / bounce) · mẫu ⇒ thư DRAFT, không tự gửi · không soạn chồng · AI ⇒ nháp bước 1 ⇒ FOLLOWUP · mẫu vi phạm ⇒ không tạo thư");
}

export async function testWholesaleEmailSequence() {
  console.log("\n— Chuỗi thư theo dõi (P4a)");
  testPure();
  await testOrg();
}
