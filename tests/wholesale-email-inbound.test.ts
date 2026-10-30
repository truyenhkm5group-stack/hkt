/**
 * ═══ E3 · ĐỌC & PHÂN LOẠI THƯ TRẢ LỜI (IMAP cùng connector gws-smtp, chủ shop duyệt lộ trình 31/10/2026) ═══
 *
 * IMAP GIẢ + AI GIẢ — không mở socket, không gọi model (AGENTS 65). Khoá:
 *  1. THUẦN — thư tự động; cắt trích thư cũ; che dãy ≥ 12 số (SĐT giữ); xin huỷ bằng chữ (cụm rõ nghĩa / từ ngắn chỉ khi là cả dòng);
 *     phân loại AI chỉ nhận câu trích NGUYÊN VĂN, sai ⇒ KHÁC; ghép mẫu mã chỉ khi DUY NHẤT và có trong chính thư; số lượng không có
 *     trong thư ⇒ MOQ; cấu hình bật AI thiếu trần ⇒ coi như tắt; tiêu đề / cấu trúc thư IMAP.
 *  2. TỔ CHỨC THẬT `wi-a`: TẮT ⇒ không mở hộp thư; lượt đầu đặt mốc, không đọc lùi; chỉ thư nối luồng / khớp đúng một lead mới tải
 *     thân (thư lạ, thư tự động KHÔNG tải); trích thư cắt phần cũ, không đính kèm; REPLY dừng thư chờ + chuỗi nhắc (#1103 STOPPED);
 *     «unsubscribe» bằng chữ ⇒ chặn EMAIL + UNSUBSCRIBE, không tốn lượt AI; HỎI GIÁ ⇒ NHÁP báo giá máy lập (DRAFT, người lập NULL,
 *     đúng bậc giá sỉ); trần AI / ngày; trùng Message-ID không nhân; mốc UID tiến; lỗi hộp thư che App Password.
 *  3. MÃ NGUỒN — hộp thư mở `readOnly`, `logger: false`, không lệnh đổi cờ / xoá / chuyển thư.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider } from "@/lib/ai/provider";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import type { SmtpTransportFactory } from "@/lib/integrations/gws-smtp/client";
import { htmlToText, messageIdList, parseHeaderBlock, pickTextPart, type InboundHeader, type MailboxReader, type MailboxReaderFactory } from "@/lib/integrations/gws-smtp/imap";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import { DryRunEmailProvider } from "@/lib/email-provider/dry-run";
import { approveEmailCore, emailDraftForLeadCore, runEmailOutboxTick, saveEmailSettingsCore } from "@/lib/wholesale/email-outbox";
import {
  EMAIL_INBOUND_CURSOR_KEY,
  isAutomatedReply,
  matchQuoteLines,
  parseClassification,
  parseEmailInboundSettings,
  redactInboundText,
  runEmailInboundTick,
  saveEmailInboundSettingsCore,
  stripQuotedReply,
  textUnsubscribeIntent,
  type CatalogEntry,
} from "@/lib/wholesale/email-reply";
import { sequenceState } from "@/lib/wholesale/email-sequence";

const ORG = "wi-a";
const NOW = new Date("2026-10-31T03:00:00Z");
const PASS = "abcdefghijklmnop";
const MAILBOX = "truyenhk@vnxcommerce.com";
const SENDER = { name: "VNX Commerce", email: MAILBOX, companyName: "Công ty VNX Commerce", address: "12 Lê Lợi, Hải Châu, Đà Nẵng" };

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testPure() {
  const h = (o: Partial<InboundHeader>) => ({ autoSubmitted: null, autoHint: null, subject: "Re: Bảng giá", ...o });
  assert.ok(isAutomatedReply(h({ autoSubmitted: "auto-replied" })));
  assert.ok(!isAutomatedReply(h({ autoSubmitted: "no" })), "Auto-Submitted: no = người viết");
  assert.ok(isAutomatedReply(h({ autoHint: "precedence:bulk" })));
  assert.ok(isAutomatedReply(h({ subject: "Trả lời tự động: Tôi đang vắng mặt" })));
  assert.ok(isAutomatedReply(h({ subject: "Out of Office: Re: price" })));
  assert.ok(!isAutomatedReply(h({})));

  assert.equal(stripQuotedReply("Chị lấy 20kg nhé\n\nVào 30/10/2026, VNX đã viết:\n> Chào chị\n> Bảng giá"), "Chị lấy 20kg nhé", "cắt phần trích thư cũ");
  assert.equal(stripQuotedReply("OK\n> cũ\nThêm ý\nOn Thu, Oct 30, 2026 VNX <a@b.vn> wrote:\nold"), "OK\nThêm ý");
  assert.equal(redactInboundText("Gọi 0905123456, chuyển khoản 1903 4567 8901 23 nhé"), "Gọi 0905123456, chuyển khoản [đã che dãy số] nhé", "SĐT giữ, số tài khoản che");
  assert.equal(redactInboundText("Thẻ 4111-1111-1111-1111"), "Thẻ [đã che dãy số]");

  for (const yes of ["Please unsubscribe me", "Vui lòng huỷ đăng ký giúp", "đừng gửi email nữa", "Stop", "STOP!", "Hủy", "Tôi không muốn nhận thư này"]) assert.ok(textUnsubscribeIntent(yes), yes);
  for (const no of ["We ship non-stop to Singapore", "Chị không huỷ đơn đâu, gửi bảng giá nhé", "Stop by our store anytime, we want 20kg", "Báo giá giúp chị"]) assert.ok(!textUnsubscribeIntent(no), no);

  const reply = "Cho em xin giá CM-500, số lượng 20 kg nhé";
  const c = parseClassification('Kết quả: {"class":"PRICE_REQUEST","quote":"Cho em xin giá CM-500","items":[{"product":"CM-500","quantity":20}]}', reply);
  assert.deepEqual([c.cls, c.evidenceMissing, c.items], ["PRICE_REQUEST", false, [{ product: "CM-500", quantity: 20 }]]);
  const fake = parseClassification('{"class":"PRICE_REQUEST","quote":"Gửi giá 100 tấn","items":[{"product":"X","quantity":1}]}', reply);
  assert.deepEqual([fake.cls, fake.evidenceMissing, fake.items], ["OTHER", true, []], "câu trích không có trong thư ⇒ KHÁC, không căn cứ");
  assert.equal(parseClassification("không phải JSON", reply).cls, "OTHER");
  assert.deepEqual(parseClassification('{"class":"INTERESTED","quote":"Cho em xin giá","items":[{"product":"CM-500","quantity":1}]}', reply).items, [], "mục hàng chỉ giữ cho HỎI GIÁ");

  const catalog: CatalogEntry[] = [
    { variantId: "v-cm500", sku: "CM-500", productName: "Chả mực Hạ Long", label: "Chả mực Hạ Long 500g", productVariantCount: 2, moq: 10 },
    { variantId: "v-cm1k", sku: "CM-1K", productName: "Chả mực Hạ Long", label: "Chả mực Hạ Long 1kg", productVariantCount: 2, moq: 5 },
    { variantId: "v-ruoc", sku: "RT-01", productName: "Ruốc tôm", label: "Ruốc tôm", productVariantCount: 1, moq: 3 },
  ];
  assert.deepEqual(matchQuoteLines([{ product: "CM-500", quantity: 20 }], reply, catalog), { lines: [{ variantId: "v-cm500", quantity: 20, quantityFrom: "EMAIL" }], unmatched: [] }, "SKU có trong thư, số lượng có trong thư");
  assert.deepEqual(matchQuoteLines([{ product: "Chả mực Hạ Long", quantity: null }], "Giá chả mực hạ long bao nhiêu?", catalog).lines, [], "tên có HAI mẫu mã ⇒ không đoán");
  assert.deepEqual(matchQuoteLines([{ product: "ruốc tôm", quantity: 7 }], "Ruốc tôm giá sỉ thế nào?", catalog).lines, [{ variantId: "v-ruoc", quantity: 3, quantityFrom: "MOQ" }], "số lượng không có trong thư ⇒ MOQ");
  assert.deepEqual(matchQuoteLines([{ product: "RT-01", quantity: 5 }], "Báo giá giúp chị", catalog).unmatched, ["RT-01"], "AI bịa mã không có trong thư ⇒ không ghép");

  assert.equal(parseEmailInboundSettings({ enabled: true, aiClassify: true }).aiClassify, false, "bật AI thiếu trần ⇒ coi như tắt");
  assert.equal(parseEmailInboundSettings(null).enabled, false, "mặc định TẮT");

  const hb = parseHeaderBlock("References: <a@x.vn>\r\n <b@y.vn>\r\nAuto-Submitted: auto-replied\r\n");
  assert.deepEqual([messageIdList(hb.references), hb["auto-submitted"]], [["<a@x.vn>", "<b@y.vn>"], "auto-replied"], "gấp dòng tiêu đề");
  assert.deepEqual(pickTextPart({ type: "multipart/mixed", childNodes: [{ type: "multipart/alternative", childNodes: [{ part: "1.1", type: "text/plain" }, { part: "1.2", type: "text/html" }] }, { part: "2", type: "application/pdf", disposition: "attachment" }] }), { part: "1.1", html: false, attachments: 1 }, "chọn text/plain, đếm đính kèm");
  assert.deepEqual(pickTextPart({ type: "multipart/alternative", childNodes: [{ part: "1", type: "text/html" }] }), { part: "1", html: true, attachments: 0 });
  assert.equal(htmlToText("<p>Chào&nbsp;chị</p><script>x</script><br>Giá?"), "Chào chị\n\nGiá?");
}

// ─────────────────────────── 3. MÃ NGUỒN ───────────────────────────

function testSource() {
  const src = readFileSync("lib/integrations/gws-smtp/imap.ts", "utf8");
  assert.ok(/mailboxOpen\("INBOX", \{ readOnly: true \}\)/.test(src), "INBOX mở chỉ đọc");
  assert.ok(/logger: false/.test(src), "không ghi log (imapflow mặc định log qua pino)");
  assert.ok(!/messageFlags(Add|Set|Remove)|messageDelete|messageMove|messageCopy|\.append\(/.test(src), "không đổi cờ / xoá / chuyển / thêm thư");
}

// ─────────────────────────── 2. TỔ CHỨC THẬT ───────────────────────────

type FakeMsg = { header: InboundHeader; text: string; attachments: number };

function fakeReader(box: { msgs: FakeMsg[]; uidNext: number; bodyCalls: number[]; opens: number; failWith?: string }): MailboxReaderFactory {
  return (creds) => {
    const r: MailboxReader = {
      async open() {
        box.opens++;
        if (box.failWith) throw new Error(`${box.failWith} ${creds.pass}`);
        return { uidValidity: "7", uidNext: box.uidNext };
      },
      async headersAfter(after, limit) {
        return box.msgs.filter((m) => m.header.uid > after).map((m) => m.header).sort((a, b) => a.uid - b.uid).slice(0, limit);
      },
      async firstUidSince() {
        return null;
      },
      async body(uid) {
        box.bodyCalls.push(uid);
        const m = box.msgs.find((x) => x.header.uid === uid)!;
        return { text: m.text, attachments: m.attachments };
      },
      async close() {},
    };
    return r;
  };
}

function header(uid: number, o: Partial<InboundHeader>): InboundHeader {
  return { uid, messageId: `<m${uid}@khach.vn>`, inReplyTo: null, references: [], from: null, fromName: null, subject: "Re: [QC] Bảng giá", autoSubmitted: null, autoHint: null, date: NOW, ...o };
}

function fakeAi(calls: string[], answers: string[]): { provider: AiProvider; source: "BYOK" } {
  const provider = {
    name: "ai-gia",
    model: "gemini-2.5-flash",
    async complete(req: { messages: { content: { type: string; text?: string }[] }[] }) {
      calls.push(String(req.messages[0]?.content[0]?.text ?? ""));
      return { content: [{ type: "text", text: answers.shift() ?? '{"class":"OTHER","quote":""}' }], usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "gemini-2.5-flash", stopReason: "end_turn", latencyMs: 1 };
    },
  } as unknown as AiProvider;
  return { provider, source: "BYOK" };
}

const okSmtp: SmtpTransportFactory = () => ({ async verify() { return true; }, async sendMail(m) { return { messageId: String(m.messageId) }; } });

async function cleanupOrg() {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  await pdb.delete(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

async function testDb() {
  await cleanupOrg();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-imap-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEFGH";
  await provisionOrganization({ code: ORG, name: "Shop đọc thư", plan: "standard", modules: ["customers", "wholesale_leads"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "DocThuTraLoi@2026!" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const modules = [...(await getEnabledModules(ORG))];
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "Chủ shop", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop đọc thư", isHome: false }, modules };

      // Kết nối Google Workspace (cùng credential gửi + đọc).
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "gws-smtp", settings: { mailbox: MAILBOX }, secrets: { appPassword: PASS } })));
      assert.ok("ok" in (await testOrgConnection(admin, "gws-smtp", { tester: { smtpTransport: okSmtp } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "gws-smtp", "ACTIVE")));

      // Danh mục + bảng giá sỉ cho nháp báo giá.
      await db.insert(schema.products).values({ id: "wi-prod", name: "Chả mực Hạ Long", raw: { origin: "ERP_MANUAL" } });
      await db.insert(schema.productVariants).values([
        { id: "wi-cm500", productId: "wi-prod", sku: "CM-500", size: "500g", retailPrice: 180_000 },
        { id: "wi-cm1k", productId: "wi-prod", sku: "CM-1K", size: "1kg", retailPrice: 340_000 },
      ]);
      const [pl] = await db.insert(schema.priceLists).values({ name: "Sỉ chung", isDefault: true, active: true }).returning({ id: schema.priceLists.id });
      await db.insert(schema.priceListItems).values([
        { priceListId: pl!.id, variantId: "wi-cm500", minQuantity: 10, unitPrice: 150_000 },
        { priceListId: pl!.id, variantId: "wi-cm500", minQuantity: 50, unitPrice: 140_000 },
      ]);

      // Bốn lead có đồng ý, mỗi lead nhận một thư D0 (chạy thử).
      assert.ok("ok" in (await saveEmailSettingsCore(admin, { mode: "DRY_RUN", sender: SENDER, limits: { perHour: 50, perDay: 100, perRecipientDomainPerDay: 5 } }, NOW)));
      const leads: Record<string, { id: string; email: string; outboxId: string; mid: string }> = {};
      for (const [k, name, email] of [["A", "Nhà hàng An", "an@nhahangan.vn"], ["B", "Quán Bình", "binh@quanbinh.vn"], ["C", "Đại lý Cường", "cuong@dailycuong.vn"], ["D", "Bếp Dung", "dung@bepdung.vn"]] as const) {
        const [l] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: name, email, contactStatus: "QUALIFIED", enrichmentStatus: "READY" }).returning({ id: schema.wholesaleLeads.id });
        await db.insert(schema.wholesaleContactConsents).values({ leadId: l!.id, channel: "EMAIL", contactValue: email, basis: "OPT_IN_FORM", evidenceText: "Khách điền form nhận báo giá", source: "STAFF", recordedByName: "Thử" });
        const d = await emailDraftForLeadCore(admin, l!.id, { useAi: false }, NOW);
        assert.ok("ok" in d, JSON.stringify(d));
        assert.ok("ok" in (await approveEmailCore(admin, d.id, { queue: true }, NOW)));
        leads[k] = { id: l!.id, email, outboxId: d.id, mid: "" };
      }
      assert.equal((await runEmailOutboxTick({ now: NOW, provider: new DryRunEmailProvider() })).sent, 4);
      for (const k of Object.keys(leads)) leads[k]!.mid = (await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, leads[k]!.outboxId) }))!.messageIdHeader!;
      // Thư nhắc đang chờ của A — phải bị dừng khi A trả lời.
      const [fu] = await db
        .insert(schema.wholesaleEmailOutbox)
        .values({ leadId: leads.A!.id, toEmail: leads.A!.email, subject: "Nhắc", bodyText: "Em nhắc bảng giá", templateKey: "FOLLOWUP", sequenceStep: 1, status: "QUEUED", idempotencyKey: `${leads.A!.id}:FOLLOWUP:1:${leads.A!.email}`, preparedBy: "USER", threadId: leads.A!.outboxId })
        .returning({ id: schema.wholesaleEmailOutbox.id });

      // ── TẮT ⇒ không mở hộp thư. ──
      const box = { msgs: [] as FakeMsg[], uidNext: 101, bodyCalls: [] as number[], opens: 0 };
      assert.equal((await runEmailInboundTick({ now: NOW, reader: fakeReader(box) })).skipped, "DISABLED");
      assert.equal(box.opens, 0, "tắt ⇒ không kết nối IMAP");
      assert.ok("error" in (await saveEmailInboundSettingsCore(admin, { enabled: true, aiClassify: true, dailyMaxClassify: null, dailyCostCapUsd: null })), "bật AI phải khai trần");
      assert.ok("ok" in (await saveEmailInboundSettingsCore(admin, { enabled: true, aiClassify: true, dailyMaxClassify: 2, dailyCostCapUsd: 1 })));

      // ── Lượt đầu: chưa gửi thật lần nào ⇒ mốc = UIDNEXT − 1, không đọc lùi. ──
      const t0 = await runEmailInboundTick({ now: NOW, reader: fakeReader(box) });
      assert.equal(t0.scanned, 0);
      assert.deepEqual(await getSettingJson<unknown>(EMAIL_INBOUND_CURSOR_KEY, null), { uidValidity: "7", lastUid: 100 });

      box.msgs.push(
        { header: header(101, { inReplyTo: leads.A!.mid, from: leads.A!.email, autoSubmitted: "auto-replied", subject: "Vắng mặt" }), text: "Tôi đang nghỉ", attachments: 0 },
        { header: header(102, { from: "nguoi-la@khac.vn", subject: "Hợp tác quảng cáo" }), text: "Nội dung lạ KHÔNG được tải", attachments: 0 },
        { header: header(103, { inReplyTo: leads.A!.mid, references: [leads.A!.mid], from: leads.A!.email }), text: "Chị quan tâm, em gọi lại cho chị nhé\nSĐT 0905123456\n\nVào 30/10/2026, VNX đã viết:\n> Chào anh/chị\n> Bảng giá cũ", attachments: 2 },
        { header: header(104, { inReplyTo: leads.B!.mid, from: leads.B!.email }), text: "Please unsubscribe me from this list.", attachments: 0 },
        { header: header(105, { references: ["<khong-co@x.vn>", leads.C!.mid], from: "ke-toan@dailycuong.vn" }), text: "Cho em xin giá CM-500, số lượng 20 kg nhé", attachments: 0 },
        { header: header(106, { inReplyTo: leads.D!.mid, from: leads.D!.email }), text: "Bên chị cảm ơn, hiện chưa có nhu cầu.", attachments: 0 },
        { header: header(107, { messageId: "<m103@khach.vn>", inReplyTo: leads.A!.mid, from: leads.A!.email }), text: "bản lặp của 103", attachments: 0 },
      );
      const aiCalls: string[] = [];
      const ai = fakeAi(aiCalls, ['{"class":"INTERESTED","quote":"Chị quan tâm, em gọi lại cho chị nhé"}', '{"class":"PRICE_REQUEST","quote":"Cho em xin giá CM-500","items":[{"product":"CM-500","quantity":20}]}', '{"class":"DECLINED","quote":"hiện chưa có nhu cầu"}']);
      const t1 = await runEmailInboundTick({ now: NOW, reader: fakeReader(box), ai: { ai } });
      assert.deepEqual([t1.scanned, t1.ignoredAuto, t1.ignoredUnrelated, t1.matched, t1.duplicate, t1.unsubscribed, t1.classified, t1.quotes], [7, 1, 1, 4, 1, 1, 2, 1], JSON.stringify(t1));
      assert.deepEqual(box.bodyCalls.filter((x) => x === 101 || x === 102), [], "thư tự động + thư lạ: KHÔNG tải nội dung");
      assert.equal(aiCalls.length, 2, "thư xin huỷ không tốn lượt AI; lượt thứ ba chạm trần 2 / ngày");
      assert.ok(!aiCalls.some((c) => c.includes("Bảng giá cũ")), "AI chỉ thấy phần viết mới");

      // A: REPLY, trích không có thư cũ, có ghi chú đính kèm; thư nhắc bị dừng; chuỗi nhắc STOPPED (#1103).
      const evA = await db.select().from(schema.wholesaleEmailEvents).where(and(eq(schema.wholesaleEmailEvents.leadId, leads.A!.id), eq(schema.wholesaleEmailEvents.kind, "REPLY")));
      assert.equal(evA.length, 1, "trùng Message-ID không nhân");
      const snip = String((evA[0]!.meta as { snippet?: string }).snippet);
      assert.ok(snip.includes("Chị quan tâm") && !snip.includes("Bảng giá cũ") && snip.includes("[2 tệp đính kèm — ERP không tải]") && snip.includes("0905123456"), snip);
      assert.equal((await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, fu!.id) }))?.status, "CANCELLED", "thư nhắc chờ bị dừng");
      const kindsA = (await db.select({ k: schema.wholesaleEmailEvents.kind }).from(schema.wholesaleEmailEvents).where(eq(schema.wholesaleEmailEvents.leadId, leads.A!.id))).map((r) => r.k);
      const st = sequenceState({ settings: { maxFollowups: 3, gapDays: 3, templates: { vi: "", en: "" } }, hasEmail: true, leadStatus: "CONTACTED", suppressed: false, sent: [{ sequenceStep: 0, sentAt: NOW }], eventKinds: kindsA, hasOpenMail: false }, new Date(NOW.getTime() + 10 * 86_400_000));
      assert.deepEqual(st, { state: "STOPPED", reason: "REPLIED" }, "chuỗi nhắc #1103 dừng vì khách trả lời");
      const actA = await db.select().from(schema.wholesaleLeadActivities).where(and(eq(schema.wholesaleLeadActivities.leadId, leads.A!.id), eq(schema.wholesaleLeadActivities.outcome, "INTERESTED")));
      assert.equal(actA.length, 1, "lịch sử ghi phân loại Quan tâm kèm căn cứ");
      assert.equal((actA[0]!.meta as { replyQuote?: string }).replyQuote, "Chị quan tâm, em gọi lại cho chị nhé");
      const tasks = await db.select().from(schema.workItems).where(eq(schema.workItems.businessEntityId, leads.A!.id));
      assert.equal(tasks.length, 1, "MỘT việc «trả lời khách» phòng Kinh doanh");

      // B: unsubscribe bằng chữ ⇒ chặn EMAIL + UNSUBSCRIBE (đúng đường huỷ E1).
      const supB = await db.query.wholesaleSuppressions.findFirst({ where: and(eq(schema.wholesaleSuppressions.kind, "EMAIL"), eq(schema.wholesaleSuppressions.value, leads.B!.email)) });
      assert.ok(supB, "huỷ bằng chữ ⇒ dòng chặn EMAIL");
      assert.equal((await db.select().from(schema.wholesaleEmailEvents).where(and(eq(schema.wholesaleEmailEvents.leadId, leads.B!.id), eq(schema.wholesaleEmailEvents.kind, "UNSUBSCRIBE")))).length, 1);

      // C: nối luồng qua References (In-Reply-To lạ, địa chỉ khác) ⇒ HỎI GIÁ ⇒ NHÁP báo giá máy lập, đúng bậc giá sỉ.
      const quotes = await db.select().from(schema.wholesaleQuotations).where(eq(schema.wholesaleQuotations.leadId, leads.C!.id));
      assert.equal(quotes.length, 1);
      assert.deepEqual([quotes[0]!.status, quotes[0]!.createdByUserId, quotes[0]!.createdByName], ["DRAFT", null, "Máy (thư hỏi giá)"], "nháp, người lập = máy, chưa gửi");
      const qLines = await db.select().from(schema.wholesaleQuotationLines).where(eq(schema.wholesaleQuotationLines.quotationId, quotes[0]!.id));
      assert.deepEqual(qLines.map((l) => [l.variantId, l.quantity, l.unitPrice]), [["wi-cm500", 20, 150_000]], "SL 20 có trong thư, bậc ≥ 10 = 150.000");

      // D: lượt AI thứ ba chạm trần ⇒ chưa phân loại, nói rõ.
      const actD = await db.select().from(schema.wholesaleLeadActivities).where(eq(schema.wholesaleLeadActivities.leadId, leads.D!.id));
      assert.ok(actD.some((a) => /chạm trần 2 thư/.test(a.note)), "trần AI / ngày giữ được");

      // ── Mốc UID tiến; lượt sau không đọc lại. ──
      assert.deepEqual(await getSettingJson<unknown>(EMAIL_INBOUND_CURSOR_KEY, null), { uidValidity: "7", lastUid: 107 });
      const t2 = await runEmailInboundTick({ now: NOW, reader: fakeReader(box), ai: { ai } });
      assert.equal(t2.scanned, 0);

      // ── Lỗi hộp thư: câu lỗi che App Password. ──
      await setSettingJson(EMAIL_INBOUND_CURSOR_KEY, { uidValidity: "7", lastUid: 107 });
      const bad = await runEmailInboundTick({ now: NOW, reader: fakeReader({ ...box, failWith: "AUTHENTICATIONFAILED Invalid credentials", opens: 0 }) });
      assert.ok(bad.error && !bad.error.includes(PASS), JSON.stringify(bad));
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
}

export async function testWholesaleEmailInbound() {
  testPure();
  testSource();
  await testDb();
  console.log(
    "  ✓ E3 thư trả lời (IMAP giả + AI giả): tắt ⇒ không mở hộp thư · lượt đầu không đọc lùi · chỉ thư nối luồng / khớp một lead mới tải thân · thư tự động bỏ · cắt trích cũ, che dãy số, không đính kèm · REPLY dừng thư chờ + chuỗi nhắc · «unsubscribe» bằng chữ ⇒ chặn EMAIL, không tốn AI · câu trích phải có thật · HỎI GIÁ ⇒ nháp báo giá máy lập đúng bậc · trần AI / ngày · trùng Message-ID không nhân · lỗi che App Password",
  );
}
