/**
 * ═══════════ LIÊN HỆ HÀNG LOẠT TỪ DANH SÁCH LEAD (chủ shop 31/10/2026) — lib/wholesale/bulk-outreach.ts ═══════════
 *
 *  1. THUẦN: thay biến ĐÚNG TỪNG lead (tên · thành phố · nhóm khách), dòng chỉ có biến rỗng bị bỏ; dự kiến gửi hết theo nhịp.
 *  2. TỔ CHỨC THẬT `wl-bulk` (AI GIẢ, không mạng):
 *     · Soạn email hàng loạt bằng mẫu: lead không đi được email (làn Zalo · thiếu email · KHÔNG LIÊN HỆ) hiện lý do.
 *     · Đưa vào hộp thư đi qua ĐÚNG đường E1: thư đã duyệt ⇒ xếp gửi kèm lý do cổng sẽ chặn (chế độ TẮT…); thư chưa duyệt ⇒ chờ
 *       duyệt; nội dung người sửa là nội dung trong hộp thư đi; lead làn Zalo bị từ chối, không âm thầm bỏ; có audit.
 *     · AI soạn: chạm trần ngày ⇒ DỪNG đúng chỗ và báo còn bao nhiêu khách chưa soạn.
 *     · Phiên Zalo: chỉ lead làn «Trong nước — Zalo», lead nước ngoài được gợi ý email; ghi kết quả qua logZaloResultCore; phiên
 *       sau biết khách đã xử lý hôm nay; KHÔNG một lượt gọi mạng nào.
 *     · Phạm vi dữ liệu: người «Được giao» chỉ đưa được lead của mình vào lô; quyền wholesale:work.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { bulkEmailPrepareCore, bulkEmailSubmitCore, DEFAULT_SUBJECT_TEMPLATE, personalize, sendEta, zaloSessionPrepareCore } from "@/lib/wholesale/bulk-outreach";
import { DEFAULT_LEAD_HUNTER_CONFIG } from "@/lib/wholesale/config";
import { saveEmailAiSettingsCore } from "@/lib/wholesale/email-ai-draft";
import { logZaloResultCore } from "@/lib/wholesale/leads";
import { getLeadHunterConfig, saveLeadHunterConfig } from "@/lib/wholesale/store";

const ORG = "wl-bulk";

function testPure() {
  const cfg = { ...DEFAULT_LEAD_HUNTER_CONFIG, outreach: { ...DEFAULT_LEAD_HUNTER_CONFIG.outreach, shopName: "Hải Sản Làng Chài", productLine: "chả mực", promotionNote: "" } };
  const tpl = "Chào {{ten_doanh_nghiep}} ở {{thanh_pho}} ({{loai_hinh}}),\n{{khuyen_mai}}\n\nBên em là {{ten_shop}}.";
  const a = personalize(cfg, { businessName: "Saigon Market Berlin", segment: "VIET_DIASPORA_GROCERY", areaName: "Berlin", provinceLabel: "Đức" }, DEFAULT_SUBJECT_TEMPLATE, tpl);
  const b = personalize(cfg, { businessName: "Quán Biển Đông", segment: "SEAFOOD_RESTAURANT", areaName: null, provinceLabel: "Đà Nẵng" }, DEFAULT_SUBJECT_TEMPLATE, tpl);
  assert.equal(a.subject, "Bảng giá sỉ chả mực cho Saigon Market Berlin — Hải Sản Làng Chài");
  assert.match(a.body, /^Chào Saigon Market Berlin ở Berlin \(cửa hàng/);
  assert.match(b.body, /^Chào Quán Biển Đông ở Đà Nẵng \(nhà hàng hải sản\)/, "không có khu vực ⇒ thành phố = tỉnh");
  assert.ok(!a.body.includes("{{") && !a.body.includes("khuyen_mai"), "không lòi biến chưa thay");
  assert.equal(a.body.split("\n").length, 3, "dòng chỉ có biến rỗng bị bỏ, dòng trống cố ý (ngắt đoạn) giữ");
  assert.notEqual(a.body, b.body, "mỗi khách một thư");
  const limits = { perHour: 20, perDay: 100, perRecipientDomainPerDay: 5 };
  assert.match(sendEta(30, limits), /khoảng 2 giờ/);
  assert.match(sendEta(250, limits), /khoảng 3 ngày/);
  assert.equal(sendEta(0, limits), "Không có thư nào xếp gửi.");
}

class FakeAi implements AiProvider {
  readonly name = "fake";
  readonly model = "gemini-2.5-flash";
  readonly schemaDialect = "openai" as const;
  calls = 0;
  constructor(public reply: string) {}
  async complete(req: AiRequest): Promise<AiResponse> {
    void req;
    this.calls += 1;
    return { content: [{ type: "text", text: this.reply }], stopReason: "end_turn", usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: this.model, latencyMs: 3 };
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

async function testOrg() {
  await cleanupOrg();
  await provisionOrganization({ code: ORG, name: "Thử liên hệ hàng loạt", plan: "standard", modules: ["customers", "products", "orders", "inventory", "wholesale_leads"], admin: { email: `admin@${ORG}.local`, name: "QT lô", password: "BulkLo@12345" }, source: "TEST", actor: null });
  const savedFetch = globalThis.fetch;
  try {
    const modules = [...(await getEnabledModules(ORG))];
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const base = { departmentCodes: [], positionId: null, organization: { code: ORG, name: "Thử liên hệ hàng loạt", isHome: false }, modules };
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", ...base };
      const [s1] = await db.insert(schema.users).values({ email: `sale@${ORG}.local`, name: "Sale Lan", passwordHash: "x", role: "CS" }).returning();
      const sale: SessionUser = { id: s1!.id, email: s1!.email, name: s1!.name, role: "CS", permissions: ["wholesale:view", "wholesale:work"], scope: "ALL", ...base };
      const [s2] = await db.insert(schema.users).values({ email: `sale2@${ORG}.local`, name: "Sale Hoa", passwordHash: "x", role: "CS", dataScope: "ASSIGNED" }).returning();
      const assigned: SessionUser = { id: s2!.id, email: s2!.email, name: s2!.name, role: "CS", permissions: ["wholesale:view", "wholesale:work"], scope: "ASSIGNED", ...base };
      const viewer: SessionUser = { ...sale, permissions: ["wholesale:view"] };

      const mk = async (v: Partial<typeof schema.wholesaleLeads.$inferInsert>) => (await db.insert(schema.wholesaleLeads).values({ source: "STAFF", enrichmentStatus: "READY", contactStatus: "QUALIFIED", ...v }).returning())[0]!;
      const intl = await mk({ businessName: "Saigon Market Westminster", email: "buyer@saigonmarket.com", websiteDomain: "saigonmarket.com", phoneCountryCode: "1", provinceKey: "intl us", provinceLabel: "Mỹ", areaName: "Westminster California", segment: "VIET_DIASPORA_GROCERY", assignedToUserId: s2!.id });
      const vnMail = await mk({ businessName: "Nhà hàng Biển Đông", email: "mua@biendong.vn", phoneCountryCode: "84", provinceLabel: "Đà Nẵng", segment: "SEAFOOD_RESTAURANT" });
      const vnZalo = await mk({ businessName: "Quán Nhậu Cô Ba", email: "coba@gmail.com", normalizedPhone: "+84905123456", phoneKind: "MOBILE", phoneCountryCode: "84", provinceLabel: "Hà Nội", segment: "PUB_BEER" });
      const noMail = await mk({ businessName: "Tạp hoá Minh Anh", provinceLabel: "Huế" });
      const dnc = await mk({ businessName: "Quán Không Liên Hệ", email: "x@khonglienhe.vn", contactStatus: "DO_NOT_CONTACT" });

      const cfg = await getLeadHunterConfig();
      await saveLeadHunterConfig({ ...cfg, outreach: { ...cfg.outreach, extraTemplates: [{ id: "vk", label: "Chào Việt Kiều", body: "Kính chào {{ten_doanh_nghiep}} tại {{thanh_pho}},\n{{khuyen_mai}}\nBên em gửi bảng giá sỉ đặc sản Việt ạ.", channel: "EMAIL" }] } });

      // ── Quyền + phạm vi ──
      assert.match(errOf(await bulkEmailPrepareCore(viewer, { leadIds: [intl.id] })), /wholesale:work/);
      const scoped = await bulkEmailPrepareCore(assigned, { leadIds: [intl.id, vnMail.id] });
      assert.ok("ok" in scoped, errOf(scoped));
      assert.deepEqual([scoped.prep.items.map((i) => i.leadId), scoped.prep.outOfScope], [[intl.id], 1], "lead ngoài phạm vi không vào lô, đếm riêng");

      // ── Soạn bằng mẫu: thay biến từng lead; lead không đi được email hiện lý do ──
      const prep = await bulkEmailPrepareCore(sale, { leadIds: [intl.id, vnMail.id, vnZalo.id, noMail.id, dnc.id], templateId: "vk" });
      assert.ok("ok" in prep, errOf(prep));
      const by = Object.fromEntries(prep.prep.items.map((i) => [i.leadId, i]));
      assert.equal(by[intl.id]!.body, "Kính chào Saigon Market Westminster tại Westminster California,\nBên em gửi bảng giá sỉ đặc sản Việt ạ.");
      assert.match(by[vnMail.id]!.body, /^Kính chào Nhà hàng Biển Đông tại Đà Nẵng,/);
      assert.match(by[intl.id]!.subject, /Saigon Market Westminster/);
      assert.ok(by[intl.id]!.refusal === null && by[vnMail.id]!.refusal === null, `${by[intl.id]!.refusal} / ${by[vnMail.id]!.refusal}`);
      assert.match(by[vnZalo.id]!.refusal ?? "", /làn/, "lead trong nước nhắn Zalo được ⇒ không đi email");
      assert.match(by[noMail.id]!.refusal ?? "", /Chưa có email/);
      assert.match(by[dnc.id]!.refusal ?? "", /KHÔNG LIÊN HỆ/);

      // ── Đưa vào hộp thư đi qua đường E1 ──
      const edited = "Kính chào Saigon Market Westminster,\nEm gửi anh/chị bảng giá sỉ chả mực, ruốc, nước mắm ạ.";
      const sub = await bulkEmailSubmitCore(sale, {
        items: [
          { leadId: intl.id, subject: "Bảng giá sỉ đặc sản Việt", body: edited, approve: true },
          { leadId: vnMail.id, subject: by[vnMail.id]!.subject, body: by[vnMail.id]!.body, approve: false },
          { leadId: vnZalo.id, subject: "Thử lách làn", body: "Chào quán, bên em gửi bảng giá ạ.", approve: true },
        ],
      });
      assert.ok("ok" in sub, errOf(sub));
      const res = Object.fromEntries(sub.results.map((r) => [r.leadId, r]));
      assert.equal(res[intl.id]!.status, "QUEUED");
      assert.ok(res[intl.id]!.warnings.length > 0, "thư đã duyệt mà cổng sẽ chặn (chế độ TẮT…) ⇒ in lý do, không âm thầm bỏ");
      assert.equal(res[vnMail.id]!.status, "DRAFT", "không tích duyệt ⇒ chỉ vào hộp thư đi chờ duyệt");
      assert.equal(res[vnZalo.id]!.status, "ERROR");
      assert.match(res[vnZalo.id]!.error ?? "", /làn/, "gửi thẳng id lead làn Zalo vẫn bị đường E1 từ chối");
      const row = await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, res[intl.id]!.outboxId!) });
      assert.deepEqual([row?.status, row?.subject, row?.bodyText, row?.approvedByUserId, row?.createdByUserId], ["QUEUED", "Bảng giá sỉ đặc sản Việt", edited, s1!.id, s1!.id], "nội dung người sửa là nội dung trong hộp thư đi; khoá tài khoản người duyệt");
      assert.equal((await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, res[vnMail.id]!.outboxId!) }))?.status, "DRAFT");
      assert.match(sub.eta, /1 thư/);
      assert.equal(sub.dryRun, true);
      const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "WHOLESALE_BULK_EMAIL"));
      assert.equal(logs.length, 1, "lô có một dòng audit tổng (từng thư đã có audit của đường E1)");

      // ── AI soạn: chạm trần ⇒ dừng đúng chỗ, báo còn bao nhiêu ──
      assert.ok("ok" in (await saveEmailAiSettingsCore(admin, { enabled: true, dailyMaxDrafts: 1, dailyCostCapUsd: 1, reason: "Thử trần lô" })));
      const fake = new FakeAi("SUBJECT: Bảng giá sỉ hải sản\n---\nKính gửi Quý anh/chị Nhà hàng Biển Đông, bên em chuyên hải sản đóng gói. Anh/chị vui lòng trả lời email này để nhận bảng giá sỉ chi tiết ạ.");
      const third = await mk({ businessName: "Nhà hàng Sóng Biển", email: "mua@songbien.vn", phoneCountryCode: "84", provinceLabel: "Nha Trang", segment: "SEAFOOD_RESTAURANT" });
      const ai = await bulkEmailPrepareCore(sale, { leadIds: [vnMail.id, third.id], source: "AI" }, new Date(), { ai: { provider: fake, source: "BYOK" } });
      assert.ok("ok" in ai, errOf(ai));
      assert.equal(fake.calls, 1, "trần 1 nháp ⇒ đúng một lượt gọi AI");
      assert.ok(ai.prep.items[0]!.aiDraftId && !ai.prep.items[0]!.refusal);
      assert.match(ai.prep.items[1]!.refusal ?? "", /Chưa soạn — .*trần/);
      assert.deepEqual(ai.prep.aiStop && [ai.prep.aiStop.remaining], [1], "còn 1 khách chưa soạn");

      // ── Phiên Zalo: không gọi mạng; chỉ làn Zalo trong nước; ghi kết quả qua lõi sẵn có ──
      let netCalls = 0;
      globalThis.fetch = (async () => {
        netCalls++;
        throw new Error("phiên Zalo không được gọi mạng");
      }) as typeof fetch;
      const z1 = await zaloSessionPrepareCore(sale, { leadIds: [vnZalo.id, intl.id, noMail.id] });
      assert.ok("ok" in z1, errOf(z1));
      const zb = Object.fromEntries(z1.items.map((i) => [i.leadId, i]));
      assert.equal(zb[vnZalo.id]!.link, "https://zalo.me/0905123456");
      assert.match(zb[vnZalo.id]!.text, /Quán Nhậu Cô Ba/, "tin cá nhân hoá theo khách");
      assert.match(zb[intl.id]!.suggestion ?? "", /Soạn email/, "lead nước ngoài ⇒ gợi ý chuyển sang email");
      assert.ok(zb[noMail.id]!.suggestion || zb[noMail.id]!.reason, "không SĐT ⇒ nói rõ vì sao không nhắn được");
      assert.ok("ok" in (await logZaloResultCore(sale, vnZalo.id, { result: "SENT", note: "Phiên nhắn Zalo tuần tự" })));
      const z2 = await zaloSessionPrepareCore(sale, { leadIds: [vnZalo.id] });
      assert.ok("ok" in z2 && z2.items[0]!.doneToday === "SENT", "phiên sau biết khách đã nhắn hôm nay ⇒ tiếp tục đúng chỗ");
      const acts = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, vnZalo.id), eq(schema.wholesaleLeadActivities.kind, "ZALO")));
      assert.deepEqual([acts.length, acts[0]?.outcome, acts[0]?.actorId], [1, "SENT", s1!.id], "kết quả ghi đúng lõi, mang khoá tài khoản người nhắn");
      assert.equal(netCalls, 0, "không một lượt gọi mạng (không có API Zalo)");
      assert.match(errOf(await zaloSessionPrepareCore(viewer, { leadIds: [vnZalo.id] })), /wholesale:work/);
    });
  } finally {
    globalThis.fetch = savedFetch;
    await cleanupOrg();
  }
}

export async function testWholesaleBulkOutreach() {
  testPure();
  await testOrg();
  console.log("✓ Liên hệ hàng loạt: thay biến đúng từng khách · lý do khi không đi được email · đường E1 + lý do cổng chặn · trần AI dừng đúng chỗ · phiên Zalo ghi kết quả, 0 lượt gọi mạng · phạm vi dữ liệu");
}
