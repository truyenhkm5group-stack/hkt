/**
 * ═══ E1 · NỀN TẢNG EMAIL BÁN SỈ Ở CHẾ ĐỘ CHẠY THỬ (hộp thư đi · cổng chính sách · huỷ đăng ký · nhận phản hồi, 27/10/2026) ═══
 *
 * Khoá:
 *  1. THUẦN — cổng chính sách chặn ĐÚNG từng lý do, gom đủ lý do, tất định; lý do tự hết ⇒ giữ ở hàng đợi, còn lại ⇒ chặn hẳn;
 *     email công khai KHÔNG có đồng ý ⇒ chặn (dùng chính `contactability()` của P1a); OFF / DRY_RUN / LIVE-không-adapter.
 *  2. THUẦN — tiêu đề: Message-ID tất định, In-Reply-To / References cho thư nhắc, List-Unsubscribe + List-Unsubscribe-Post
 *     đúng RFC 8058, chặn chèn tiêu đề, nhãn [QC], chân thư có danh tính + địa chỉ + link huỷ.
 *  3. TỔ CHỨC THẬT `we-a` / `we-b`: soạn từ hàng đợi liên hệ → duyệt → job chạy thử ⇒ SENT `dryrun-…`, lead KHÔNG đổi trạng thái
 *     liên hệ; chạy hai lần / hai lượt song song ⇒ đúng MỘT thư; lỗi tạm lùi dần, lỗi vĩnh viễn FAILED; hạn mức giữ lại; nút dừng
 *     dừng dễ mở khó; sửa sau duyệt ⇒ phải duyệt lại; huỷ đăng ký ⇒ chặn EMAIL + sự kiện + dừng thư chờ, bấm lại không ghi thêm;
 *     token A gắn nhãn B ⇒ 404; trả lời ⇒ REPLY + dừng chuỗi + một việc phòng Kinh doanh, đọc lại không nhân; thư tự động bỏ qua;
 *     thư nhắc nối luồng; chưa áp 0264 ⇒ job không hỏng, trang in câu báo.
 *  4. MÃ NGUỒN — sổ sự kiện chỉ thêm; nhà cung cấp chạy thử không gọi mạng; chỉ MỘT chỗ gọi `.send(` (vòng gửi sau cổng).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { GET as unsubGET, POST as unsubPOST } from "@/app/api/wholesale/unsubscribe/[token]/route";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { parseUnsubscribeToken, WHOLESALE_UNSUBSCRIBE_PREFIX } from "@/lib/constants/email-unsubscribe";
import { DryRunEmailProvider } from "@/lib/email-provider/dry-run";
import { buildOutgoingEmail, emailContentHash, EMAIL_ADVERTISING_SUBJECT_PREFIX, messageIdFor } from "@/lib/email-provider/message";
import { EmailSendError, type EmailProvider, type OutgoingEmail } from "@/lib/email-provider/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { listOutbox } from "@/lib/queries/wholesale-email-outbox";
import { contactability } from "@/lib/wholesale/contactability";
import { DEFAULT_EMAIL_SETTINGS, EMAIL_BACKOFF_CAP_MS, emailBackoffMs, emailIdempotencyKey, mergeEmailSettings, type EmailSettings } from "@/lib/wholesale/email-constants";
import { ingestInboundEmail, normalizeMessageId } from "@/lib/wholesale/email-inbound";
import { approveEmailCore, cancelEmailCore, editEmailDraftCore, emailDraftForLeadCore, emailOutboxHasWork, reopenEmailCore, runEmailOutboxTick, saveEmailSettingsCore, setEmailPauseCore } from "@/lib/wholesale/email-outbox";
import { evaluateEmailSend, type EmailPolicyInput } from "@/lib/wholesale/email-policy";

const ORG_A = "we-a";
const ORG_B = "we-b";
const NOW = new Date("2026-10-27T03:00:00Z");

// ─────────────────────────── 1. CỔNG CHÍNH SÁCH (THUẦN) ───────────────────────────

const SENDER = { name: "Hải sản Hà My", email: "banhang@hamy.vn", companyName: "Hộ kinh doanh Hà My", address: "12 Lê Lợi, Hải Châu, Đà Nẵng" };
// Nước người nhận đã rà luật (cổng nước — tests/wholesale-channel-routing.test.ts đo riêng): bộ ca dưới đây đo các lý do KHÁC.
const SETTINGS: EmailSettings = { ...DEFAULT_EMAIL_SETTINGS, mode: "DRY_RUN", sender: SENDER, allowedCountries: ["VN"] };
const HASH = emailContentHash("lan@nhahang.vn", "Bảng giá", "Chào anh chị");

function baseInput(over: Partial<EmailPolicyInput> = {}, msg: Partial<EmailPolicyInput["message"]> = {}): EmailPolicyInput {
  return {
    settings: SETTINGS,
    message: { status: "QUEUED", toEmail: "lan@nhahang.vn", recipientDomain: "nhahang.vn", campaignId: "camp-1", approvedByUserId: "u1", approvedAt: NOW, approvedHash: HASH, contentHash: HASH, approvalUsedAt: null, ...msg },
    leadEmail: "lan@nhahang.vn",
    leadContactStatus: "READY_TO_CONTACT",
    contactability: { allowed: true, reason: "CONSENTED", detail: "Có đồng ý" },
    suppressionHit: null,
    leadEventKinds: [],
    duplicateSent: false,
    counts: { lastHour: 0, today: 0, domainToday: 0 },
    recipientCountry: "VN",
    ...over,
  };
}

function testPolicy() {
  const ok = evaluateEmailSend(baseInput());
  assert.deepEqual([ok.allowed, ok.reasons, ok.sendMode], [true, [], "DRY_RUN"], "đủ mọi điều kiện ⇒ được gửi (chạy thử)");
  assert.deepEqual(evaluateEmailSend(baseInput()), ok, "tất định: hai lần cùng đầu vào ⇒ cùng kết quả");

  const one = (inp: EmailPolicyInput) => evaluateEmailSend(inp);
  const cases: [string, EmailPolicyInput, string, boolean][] = [
    ["chế độ OFF", baseInput({ settings: { ...SETTINGS, mode: "OFF" } }), "MODE_OFF", true],
    ["dừng tổ chức", baseInput({ settings: { ...SETTINGS, paused: true, pausedReason: "rà soát" } }), "KILL_ORG", true],
    ["dừng chiến dịch", baseInput({ settings: { ...SETTINGS, pausedCampaignIds: ["camp-1"] } }), "KILL_CAMPAIGN", true],
    ["dừng tên miền nhận", baseInput({ settings: { ...SETTINGS, blockedDomains: ["nhahang.vn"] } }), "KILL_DOMAIN", true],
    ["thiếu địa chỉ người gửi", baseInput({ settings: { ...SETTINGS, sender: { ...SENDER, address: "" } } }), "SENDER_INCOMPLETE", true],
    ["hạn mức giờ", baseInput({ counts: { lastHour: 20, today: 20, domainToday: 0 } }), "LIMIT_HOUR", true],
    ["hạn mức ngày", baseInput({ counts: { lastHour: 0, today: 100, domainToday: 0 } }), "LIMIT_DAY", true],
    ["hạn mức tên miền", baseInput({ counts: { lastHour: 0, today: 0, domainToday: 5 } }), "LIMIT_DOMAIN", true],
    ["khách đã trả lời", baseInput({ leadEventKinds: ["SENT", "REPLY"] }), "LEAD_STOPPED", false],
    ["khách huỷ đăng ký", baseInput({ leadEventKinds: ["UNSUBSCRIBE"] }), "LEAD_STOPPED", false],
    ["trả về vĩnh viễn", baseInput({ leadEventKinds: ["BOUNCE_HARD"] }), "LEAD_STOPPED", false],
    ["báo rác", baseInput({ leadEventKinds: ["COMPLAINT"] }), "LEAD_STOPPED", false],
    ["KHÔNG LIÊN HỆ", baseInput({ leadContactStatus: "DO_NOT_CONTACT" }), "LEAD_STOPPED", false],
    ["không đủ căn cứ liên hệ", baseInput({ contactability: { allowed: false, reason: "NO_CONSENT", detail: "chưa có đồng ý" } }), "NOT_CONTACTABLE", false],
    ["khớp danh sách chặn", baseInput({ suppressionHit: "Khách xin thôi" }), "SUPPRESSED", false],
    ["email lead đã đổi", baseInput({ leadEmail: "khac@nhahang.vn" }), "ADDRESS_CHANGED", false],
    ["chưa duyệt", baseInput({}, { approvedByUserId: null, approvedAt: null, approvedHash: null }), "NOT_APPROVED", false],
    ["sửa sau khi duyệt", baseInput({}, { contentHash: "khac" }), "APPROVAL_STALE", false],
    ["lượt duyệt đã dùng", baseInput({}, { approvalUsedAt: NOW }), "APPROVAL_USED", false],
    ["đã gửi thật cùng khoá", baseInput({ duplicateSent: true }), "DUPLICATE", false],
    ["không ở trạng thái chờ gửi", baseInput({}, { status: "DRAFT" }), "BAD_STATUS", false],
  ];
  for (const [ten, inp, reason, hold] of cases) {
    const d = one(inp);
    assert.equal(d.allowed, false, `${ten} ⇒ chặn`);
    assert.deepEqual(d.reasons, [reason], `${ten} ⇒ đúng một lý do ${reason}, nhận ${d.reasons.join(",")}`);
    assert.equal(d.hold, hold, `${ten} ⇒ ${hold ? "giữ ở hàng đợi" : "chặn hẳn"}`);
    assert.equal(d.details.length, 1);
    assert.equal(d.sendMode, null);
  }
  assert.ok(one(baseInput({ leadEventKinds: ["BOUNCE_SOFT", "DELIVERED", "SENT"] })).allowed, "trả về TẠM / đã tới hộp thư không dừng chuỗi");

  // Gom ĐỦ lý do; một lý do chặn hẳn lẫn vào ⇒ không còn là «giữ lại».
  const many = one(baseInput({ settings: { ...SETTINGS, mode: "OFF", paused: true }, suppressionHit: "x" }));
  assert.deepEqual(many.reasons, ["MODE_OFF", "KILL_ORG", "SUPPRESSED"]);
  assert.equal(many.hold, false, "có lý do chặn hẳn ⇒ không giữ ở hàng đợi");

  // LIVE: chưa có adapter ⇒ chặn (giữ lại); chủ shop chưa bật ⇒ chặn; có adapter + chủ shop bật ⇒ gửi THẬT.
  const live = one(baseInput({ settings: { ...SETTINGS, mode: "LIVE", liveEnabledByUserId: "owner" } }));
  assert.deepEqual([live.reasons, live.hold], [["LIVE_NO_ADAPTER"], true], "LIVE không adapter ⇒ chặn, thư nằm chờ");
  assert.deepEqual(one(baseInput({ settings: { ...SETTINGS, mode: "LIVE" }, liveAdapters: ["ses"] })).reasons, ["LIVE_NOT_OWNER_ENABLED"]);
  const liveOk = one(baseInput({ settings: { ...SETTINGS, mode: "LIVE", liveEnabledByUserId: "owner" }, liveAdapters: ["ses"] }));
  assert.deepEqual([liveOk.allowed, liveOk.sendMode], [true, "LIVE"]);

  // Email công khai trên website KHÔNG phải đồng ý — dùng CHÍNH hàm của P1a, không suy diễn lại.
  const lead = { contactStatus: "QUALIFIED", placeId: null, phone: null, email: "Lan@NhaHang.vn ", websiteDomain: "nhahang.vn" };
  const pub = contactability(lead, [], [], "EMAIL", "AUTOMATED");
  const blocked = one(baseInput({ contactability: pub }));
  assert.deepEqual(blocked.reasons, ["NOT_CONTACTABLE"], "email công khai không đồng ý ⇒ chặn");
  assert.match(blocked.details[0]!, /công khai trên website KHÔNG phải đồng ý/);
  const consented = contactability(lead, [{ channel: "EMAIL", contactValue: "lan@nhahang.vn", basis: "OPT_IN_FORM", revokedAt: null }], [], "EMAIL", "AUTOMATED");
  assert.ok(one(baseInput({ contactability: consented })).allowed, "có đồng ý đúng địa chỉ ⇒ được");
  const suppressed = contactability(lead, [{ channel: "EMAIL", contactValue: "lan@nhahang.vn", basis: "OPT_IN_FORM", revokedAt: null }], [{ kind: "EMAIL", value: "lan@nhahang.vn" }], "EMAIL", "AUTOMATED");
  assert.equal(one(baseInput({ contactability: suppressed })).allowed, false, "danh sách chặn thắng đồng ý");
}

function testSettingsAndBackoff() {
  assert.equal(mergeEmailSettings(null).mode, "OFF", "chưa lưu gì ⇒ TẮT");
  assert.equal(mergeEmailSettings({ mode: "GUI_HET" }).mode, "OFF", "chế độ lạ ⇒ TẮT (rơi về phía hẹp)");
  const m = mergeEmailSettings({ mode: "DRY_RUN", blockedDomains: ["a.vn", "b.vn"], pausedCampaignIds: ["c1"], limits: { perHour: 999999, perDay: 50 } });
  assert.deepEqual([m.mode, m.blockedDomains, m.pausedCampaignIds, m.limits.perHour, m.limits.perDay], ["DRY_RUN", ["a.vn", "b.vn"], ["c1"], 20, 50], "mảng lồng giữ nguyên; vượt trần cứng ⇒ mặc định");
  assert.equal(emailBackoffMs(1), 5 * 60_000);
  assert.equal(emailBackoffMs(2), 10 * 60_000);
  assert.equal(emailBackoffMs(50), EMAIL_BACKOFF_CAP_MS, "lùi dần có trần");
  assert.ok(parseUnsubscribeToken(`vnxu1.we-a.${"A".repeat(43)}`));
  for (const bad of ["", "vnxu1.we-a.ngan", `vnxs1.we-a.${"A".repeat(43)}`, `vnxu1.WE_A.${"A".repeat(43)}`]) assert.equal(parseUnsubscribeToken(bad), null, bad);
}

// ─────────────────────────── 2. TIÊU ĐỀ (THUẦN) ───────────────────────────

function testHeaders() {
  const url = "https://hamy.vnxcommerce.com/api/wholesale/unsubscribe/vnxu1.we-a.xyz";
  const d0 = buildOutgoingEmail({ outboxId: "abc-123", sender: SENDER, to: "lan@nhahang.vn", subject: "Bảng giá sỉ\r\nBcc: ke-xau@x.vn", body: "Chào chị Lan", unsubscribeUrl: url, idempotencyKey: "k", threadMessageIds: [] });
  assert.equal(d0.headers["Message-ID"], "<wsm-abc-123@hamy.vn>", "Message-ID tất định theo id thư + tên miền gửi");
  assert.equal(d0.headers["List-Unsubscribe"], `<${url}>`, "RFC 8058: List-Unsubscribe là URI https trong ngoặc nhọn");
  assert.equal(d0.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "RFC 8058: đúng nguyên văn");
  assert.ok(!("In-Reply-To" in d0.headers) && !("References" in d0.headers), "thư mở đầu không có tiêu đề luồng");
  assert.ok(!/[\r\n]/.test(d0.subject) && d0.subject.startsWith(EMAIL_ADVERTISING_SUBJECT_PREFIX), "chặn chèn tiêu đề + nhãn [QC]");
  assert.ok(d0.text.includes(SENDER.companyName) && d0.text.includes(SENDER.address) && d0.text.includes(url), "chân thư: danh tính + địa chỉ + link huỷ");
  const again = buildOutgoingEmail({ outboxId: "abc-123", sender: SENDER, to: "lan@nhahang.vn", subject: "[QC] Bảng giá", body: "x", unsubscribeUrl: url, idempotencyKey: "k", threadMessageIds: [] });
  assert.equal(again.subject, "[QC] Bảng giá", "không gắn nhãn hai lần");
  const f1 = buildOutgoingEmail({ outboxId: "f-2", sender: SENDER, to: "lan@nhahang.vn", subject: "Nhắc", body: "x", unsubscribeUrl: url, idempotencyKey: "k2", threadMessageIds: ["<wsm-a@hamy.vn>", "<wsm-b@hamy.vn>"] });
  assert.equal(f1.headers["In-Reply-To"], "<wsm-b@hamy.vn>", "thư nhắc trả lời thư MỚI nhất");
  assert.equal(f1.headers.References, "<wsm-a@hamy.vn> <wsm-b@hamy.vn>", "References = cả luồng, cũ → mới");
  assert.equal(messageIdFor("x", "wholesale-email.invalid"), "<wsm-x@wholesale-email.invalid>");
  assert.equal(normalizeMessageId(" abc@x.vn "), "<abc@x.vn>");
  assert.equal(normalizeMessageId("<abc@x.vn>"), "<abc@x.vn>");
  assert.equal(normalizeMessageId("a b"), null);
}

// ─────────────────────────── 4. MÃ NGUỒN ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function testSource() {
  const files = [...walk("lib"), ...walk("app")];
  const writes = files.filter((f) => /(update|delete)\(\s*schema\.wholesaleEmailEvents\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(writes, [], "sổ sự kiện email CHỈ THÊM — không đường nào sửa / xoá");
  const dry = readFileSync("lib/email-provider/dry-run.ts", "utf8");
  assert.ok(!/\bfetch\(|node:(net|tls|http|https)|nodemailer|process\.env/.test(dry), "nhà cung cấp chạy thử không gọi mạng, không đọc biến môi trường");
  const usesEmail = files.filter((f) => !f.startsWith("lib/email-provider/") && /from "@\/lib\/email-provider(\/[a-z-]+)?"/.test(readFileSync(f, "utf8")));
  const senders = usesEmail.filter((f) => /\.send\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(senders, ["lib/wholesale/email-outbox.ts"], "chỉ vòng gửi (sau cổng chính sách) gọi nhà cung cấp — AI không có đường gửi thẳng");
  assert.deepEqual(usesEmail.filter((f) => /resolveEmailProvider\(|new DryRunEmailProvider\(/.test(readFileSync(f, "utf8"))), ["lib/wholesale/email-outbox.ts"], "chỉ vòng gửi dựng nhà cung cấp");
  const outbox = readFileSync("lib/wholesale/email-outbox.ts", "utf8");
  assert.ok(outbox.indexOf("evaluateEmailSend(input)") < outbox.indexOf("provider.send("), "cổng hỏi TRƯỚC khi gọi nhà cung cấp");
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

async function provision(code: string) {
  await cleanupOrg(code);
  await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "wholesale_leads"], admin: { email: `chu@${code}.local`, name: "Chủ shop", password: "HopThuDi@2026!" }, source: "TEST", actor: null });
}

function sessionOf(code: string, u: { id: string; email: string }, modules: string[], over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "Chủ shop", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: `Shop ${code}`, isHome: false }, modules, ...over };
}

async function addLead(name: string, email: string | null, consent: boolean): Promise<string> {
  const db = await getDb();
  const [l] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: name, email, contactStatus: "QUALIFIED", enrichmentStatus: "READY" }).returning({ id: schema.wholesaleLeads.id });
  if (consent && email) await db.insert(schema.wholesaleContactConsents).values({ leadId: l!.id, channel: "EMAIL", contactValue: email.trim().toLowerCase(), basis: "OPT_IN_FORM", evidenceText: "Khách điền form nhận báo giá ở hội chợ 20/10", source: "STAFF", recordedByName: "Thử" });
  return l!.id;
}

const outboxOf = async (id: string) => (await getDb()).query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, id) });
const eventsOf = async (leadId: string, kind?: string) => (await getDb()).select().from(schema.wholesaleEmailEvents).where(kind ? and(eq(schema.wholesaleEmailEvents.leadId, leadId), eq(schema.wholesaleEmailEvents.kind, kind)) : eq(schema.wholesaleEmailEvents.leadId, leadId));

/** Lead mới ⇒ lời chào EMAIL ở hàng đợi liên hệ ⇒ đưa vào hộp thư đi ⇒ duyệt (+ xếp gửi). */
async function draftAndApprove(user: SessionUser, leadId: string, queue = true): Promise<string> {
  const d = await emailDraftForLeadCore(user, leadId, { useAi: false }, NOW);
  assert.ok("ok" in d, JSON.stringify(d));
  const a = await approveEmailCore(user, d.id, { queue }, NOW);
  assert.ok("ok" in a, JSON.stringify(a));
  return d.id;
}

class ScriptedProvider implements EmailProvider {
  readonly name = "kich-ban";
  readonly mode = "DRY_RUN" as const;
  readonly sent: OutgoingEmail[] = [];
  constructor(private readonly plan: ("ok" | "tam" | "vinh-vien")[], private readonly delayMs = 0) {}
  async send(msg: OutgoingEmail) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const step = this.plan.shift() ?? "ok";
    if (step === "tam") throw new EmailSendError("Nhà cung cấp 503", true);
    if (step === "vinh-vien") throw new EmailSendError("Địa chỉ không tồn tại", false);
    this.sent.push(msg);
    return { providerMessageId: `dryrun-kb-${this.sent.length}`, messageIdHeader: msg.headers["Message-ID"]! };
  }
}

function tokenOf(msg: OutgoingEmail): string {
  const m = /<([^>]+)>/.exec(msg.headers["List-Unsubscribe"] ?? "");
  assert.ok(m, "thư phải có List-Unsubscribe");
  const path = new URL(m[1]!).pathname;
  assert.ok(path.startsWith(WHOLESALE_UNSUBSCRIBE_PREFIX));
  return decodeURIComponent(path.slice(WHOLESALE_UNSUBSCRIBE_PREFIX.length));
}

async function hit(method: "GET" | "POST", token: string): Promise<{ status: number; body: string }> {
  const req = new NextRequest(`http://localhost${WHOLESALE_UNSUBSCRIBE_PREFIX}${token}`, method === "POST" ? { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" } : { method });
  const ctx = { params: Promise.resolve({ token }) };
  const res = method === "POST" ? await unsubPOST(req, ctx) : await unsubGET(req, ctx);
  return { status: res.status, body: await res.text() };
}

async function testDb() {
  await provision(ORG_A);
  await provision(ORG_B);
  try {
    let tokenA = "";
    let leadA = "";
    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const modules = [...(await getEnabledModules(ORG_A))];
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG_A}.local`) });
      assert.ok(u);
      const admin = sessionOf(ORG_A, u, modules);
      const [saleRow] = await db.insert(schema.users).values({ email: `sale@${ORG_A}.local`, name: "Sale Hoa", role: "CS", passwordHash: "x" }).returning();
      const sale = sessionOf(ORG_A, saleRow!, modules, { role: "CS", name: "Sale Hoa", permissions: ["wholesale:view", "wholesale:work"] });

      // ── Chế độ: mặc định TẮT; LIVE bị từ chối khi chưa có adapter; người không phải chủ shop không bật được LIVE. ──
      leadA = await addLead("Nhà hàng Biển Xanh", "Lan@BienXanh.vn", true);
      const idOff = await draftAndApprove(admin, leadA);
      assert.equal(await emailOutboxHasWork(NOW), false, "email TẮT ⇒ job không có việc");
      const off = await runEmailOutboxTick({ now: NOW });
      assert.equal(off.skipped, "MODE_OFF");
      assert.equal((await outboxOf(idOff))?.status, "QUEUED", "TẮT ⇒ thư nằm chờ, không bị chặn hẳn");
      const settingsIn = { mode: "DRY_RUN", sender: SENDER, limits: { perHour: 20, perDay: 100, perRecipientDomainPerDay: 5 } };
      assert.match(JSON.stringify(await saveEmailSettingsCore(admin, { ...settingsIn, mode: "LIVE" }, NOW)), /Chưa có nhà cung cấp email/, "LIVE không adapter ⇒ từ chối");
      assert.ok("error" in (await saveEmailSettingsCore(sale, settingsIn, NOW)), "người không có wholesale:config không đổi chế độ");
      assert.match(JSON.stringify(await saveEmailSettingsCore({ ...admin, role: "MANAGER", permissions: ["wholesale:view", "wholesale:work", "wholesale:config"] }, { ...settingsIn, mode: "LIVE" }, NOW, ["ses"])), /Chỉ chủ shop/);
      assert.ok("ok" in (await saveEmailSettingsCore(admin, settingsIn, NOW)));

      // ── Chạy thử: SENT `dryrun-…`, sự kiện SENT mode=DRY_RUN, lead KHÔNG đổi trạng thái liên hệ. ──
      const dry = new DryRunEmailProvider();
      assert.equal(await emailOutboxHasWork(NOW), true);
      const t1 = await runEmailOutboxTick({ now: NOW, provider: dry });
      assert.deepEqual([t1.sent, t1.blocked, t1.held], [1, 0, 0], JSON.stringify(t1));
      const sentRow = await outboxOf(idOff);
      assert.equal(sentRow?.status, "SENT");
      assert.equal(sentRow?.mode, "DRY_RUN");
      assert.ok(sentRow?.providerMessageId?.startsWith("dryrun-"), "mã giả có tiền tố dryrun-");
      assert.equal(sentRow?.messageIdHeader, `<wsm-${idOff}@hamy.vn>`);
      assert.ok(sentRow?.approvalUsedAt, "lượt duyệt đã dùng");
      const sentEv = await eventsOf(leadA, "SENT");
      assert.equal(sentEv.length, 1);
      assert.equal((sentEv[0]!.meta as { mode?: string }).mode, "DRY_RUN");
      const leadAfter = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadA) });
      assert.deepEqual([leadAfter?.contactAttemptCount, leadAfter?.firstContactAt, leadAfter?.contactStatus], [0, null, "READY_TO_CONTACT"], "chạy thử không phải một lần liên hệ thật");
      assert.equal(dry.sent.length, 1);
      tokenA = tokenOf(dry.sent[0]!);
      assert.equal(parseUnsubscribeToken(tokenA)?.orgCode, ORG_A, "token mang mã tổ chức");
      const tokRow = await db.query.wholesaleUnsubscribeTokens.findFirst({ where: eq(schema.wholesaleUnsubscribeTokens.outboxId, idOff) });
      assert.ok(tokRow && !JSON.stringify(tokRow).includes(parseUnsubscribeToken(tokenA)!.secret), "chỉ lưu BĂM token");

      // ── Idempotency: chạy lại ⇒ không gửi thêm; soạn lại cùng khoá ⇒ từ chối; lời chào gốc đã chuyển «Đã huỷ». ──
      const t2 = await runEmailOutboxTick({ now: NOW, provider: dry });
      assert.deepEqual([t2.considered, dry.sent.length], [0, 1], "gửi hai lần ⇒ một SENT");
      const src = await db.query.wholesaleOutreachItems.findFirst({ where: and(eq(schema.wholesaleOutreachItems.leadId, leadA), eq(schema.wholesaleOutreachItems.channel, "EMAIL")) });
      assert.equal(src?.status, "CANCELLED", "lời chào không đi hai đường");

      // Hai lượt song song trên cùng một thư ⇒ đúng một lượt gọi nhà cung cấp.
      const leadP = await addLead("Quán Nhậu Sóng", "song@quansong.vn", true);
      const idP = await draftAndApprove(admin, leadP);
      const slow = new ScriptedProvider([], 30);
      const [p1, p2] = await Promise.all([runEmailOutboxTick({ now: NOW, provider: slow }), runEmailOutboxTick({ now: NOW, provider: slow })]);
      assert.equal(slow.sent.length, 1, "hai lượt song song ⇒ một lượt gửi");
      assert.equal(p1.sent + p2.sent, 1);
      assert.equal((await outboxOf(idP))?.status, "SENT");

      // ── Email công khai KHÔNG có đồng ý ⇒ BLOCKED, sự kiện BLOCKED, câu lý do nói rõ. ──
      const leadB = await addLead("Buffet Công Khai", "lienhe@buffetck.vn", false);
      const idB = await draftAndApprove(admin, leadB);
      const tb = await runEmailOutboxTick({ now: NOW, provider: dry });
      assert.equal(tb.blocked, 1);
      const rb = await outboxOf(idB);
      assert.equal(rb?.status, "BLOCKED");
      assert.match(rb?.blockedReason ?? "", /công khai trên website KHÔNG phải đồng ý/);
      assert.equal((await eventsOf(leadB, "BLOCKED")).length, 1);
      assert.ok("ok" in (await reopenEmailCore(admin, idB, NOW)), "mở lại thư bị chặn");
      const reopened = await outboxOf(idB);
      assert.deepEqual([reopened?.status, reopened?.approvedByUserId, reopened?.approvalUsedAt], ["DRAFT", null, null], "mở lại ⇒ mất lượt duyệt cũ");
      assert.ok("ok" in (await cancelEmailCore(admin, idB, NOW)));

      // ── Sửa sau khi duyệt ⇒ về chờ duyệt; nội dung đổi lén sau khi xếp gửi ⇒ APPROVAL_STALE. ──
      const leadE = await addLead("Lẩu Dê Sửa", "de@laude.vn", true);
      const idE = await draftAndApprove(admin, leadE, false);
      assert.ok("ok" in (await editEmailDraftCore(admin, idE, { subject: "Bảng giá mới", body: "Chào anh, em gửi bảng giá sỉ mới." }, NOW)));
      const edited = await outboxOf(idE);
      assert.deepEqual([edited?.status, edited?.approvedHash], ["DRAFT", null], "sửa ⇒ về «Chờ duyệt», mất lượt duyệt");
      assert.ok("ok" in (await approveEmailCore(admin, idE, { queue: true }, NOW)));
      await db.update(schema.wholesaleEmailOutbox).set({ bodyText: "Nội dung bị đổi sau khi duyệt" }).where(eq(schema.wholesaleEmailOutbox.id, idE));
      await runEmailOutboxTick({ now: NOW, provider: dry });
      assert.match((await outboxOf(idE))?.blockedReason ?? "", /sửa sau khi duyệt/);

      // ── Lỗi tạm ⇒ lùi dần; lỗi vĩnh viễn ⇒ FAILED. ──
      const leadT = await addLead("Nhà hàng Lỗi Tạm", "tam@loitam.vn", true);
      const idT = await draftAndApprove(admin, leadT);
      await runEmailOutboxTick({ now: NOW, provider: new ScriptedProvider(["tam"]) });
      const rt = await outboxOf(idT);
      assert.deepEqual([rt?.status, rt?.attempts, rt?.nextAttemptAt?.getTime()], ["QUEUED", 1, NOW.getTime() + 5 * 60_000], "lỗi tạm ⇒ hẹn 5 phút sau");
      assert.equal((await runEmailOutboxTick({ now: NOW, provider: new ScriptedProvider([]) })).considered, 0, "chưa tới hạn ⇒ không thử lại");
      await runEmailOutboxTick({ now: new Date(NOW.getTime() + 6 * 60_000), provider: new ScriptedProvider(["vinh-vien"]) });
      const rf = await outboxOf(idT);
      assert.equal(rf?.status, "FAILED", "lỗi vĩnh viễn ⇒ FAILED");
      assert.equal((await eventsOf(leadT, "FAILED")).length, 1);

      // ── Hạn mức giờ ⇒ giữ ở hàng đợi; nút dừng: dừng dễ, mở khó. ──
      assert.ok("ok" in (await saveEmailSettingsCore(admin, { ...settingsIn, limits: { perHour: 2, perDay: 100, perRecipientDomainPerDay: 5 } }, NOW)));
      const leadL = await addLead("Nhà hàng Hạn Mức", "hm@hanmuc.vn", true);
      const idL = await draftAndApprove(admin, leadL);
      const tl = await runEmailOutboxTick({ now: NOW, provider: dry });
      assert.equal(tl.held, 1, "đã gửi 2 thư chạy thử trong giờ ⇒ thư thứ ba nằm chờ");
      const rl = await outboxOf(idL);
      assert.equal(rl?.status, "QUEUED");
      assert.match(rl?.lastError ?? "", /hạn mức thư \/ giờ/);
      assert.ok("ok" in (await saveEmailSettingsCore(admin, settingsIn, NOW)));
      assert.ok("ok" in (await setEmailPauseCore(sale, { scope: "ORG", paused: true, reason: "Khách phàn nàn" })), "người chăm lead bấm DỪNG được");
      assert.ok("error" in (await setEmailPauseCore(sale, { scope: "ORG", paused: false })), "người chăm lead KHÔNG mở lại được");
      const later = new Date(NOW.getTime() + 20 * 60_000);
      const tp = await runEmailOutboxTick({ now: later, provider: dry });
      assert.deepEqual([tp.held, tp.sent], [1, 0], "nút dừng tổ chức ⇒ không thư nào đi");
      assert.ok("ok" in (await setEmailPauseCore(admin, { scope: "ORG", paused: false })));
      assert.ok("ok" in (await setEmailPauseCore(sale, { scope: "DOMAIN", target: "HanMuc.vn", paused: true })));
      assert.equal((await runEmailOutboxTick({ now: new Date(later.getTime() + 20 * 60_000), provider: dry })).held, 1, "dừng theo tên miền nhận");
      assert.ok("ok" in (await setEmailPauseCore(admin, { scope: "DOMAIN", target: "hanmuc.vn", paused: false })));
      assert.equal((await runEmailOutboxTick({ now: new Date(later.getTime() + 40 * 60_000), provider: dry })).sent, 1, "mở lại ⇒ thư đi");

      // ── LIVE không adapter: cổng giữ lại (cài thẳng setting như thể ai đó sửa tay CSDL). ──
      const leadV = await addLead("Nhà hàng Gửi Thật", "live@guithat.vn", true);
      const idV = await draftAndApprove(admin, leadV);
      await db.update(schema.settings).set({ value: JSON.stringify({ ...mergeEmailSettings(JSON.parse((await db.query.settings.findFirst({ where: eq(schema.settings.key, "wholesale.email") }))!.value)), mode: "LIVE", liveEnabledByUserId: u.id }) }).where(eq(schema.settings.key, "wholesale.email"));
      const tv = await runEmailOutboxTick({ now: new Date(later.getTime() + 60 * 60_000) });
      assert.deepEqual([tv.sent, tv.held], [0, 1], "LIVE mà chưa có nhà cung cấp ⇒ không gửi, thư nằm chờ");
      assert.match((await outboxOf(idV))?.lastError ?? "", /CHƯA có nhà cung cấp/);
      assert.ok("ok" in (await saveEmailSettingsCore(admin, settingsIn, NOW)));
      assert.ok("ok" in (await cancelEmailCore(admin, idV, NOW)));

      // ── Huỷ đăng ký: GET chỉ đọc; POST một chạm ⇒ chặn EMAIL + sự kiện + dừng thư chờ; bấm lại không ghi thêm. ──
      const pending = await db
        .insert(schema.wholesaleEmailOutbox)
        .values({ leadId: leadA, toEmail: "lan@bienxanh.vn", subject: "Nhắc", bodyText: "Nhắc lại bảng giá", templateKey: "FOLLOWUP", sequenceStep: 1, status: "QUEUED", idempotencyKey: emailIdempotencyKey(leadA, "FOLLOWUP", 1, "lan@bienxanh.vn"), preparedBy: "USER", threadId: idOff })
        .returning({ id: schema.wholesaleEmailOutbox.id });
      const g = await hit("GET", tokenA);
      assert.equal(g.status, 200);
      assert.match(g.body, /la\*\*\*@bienxanh\.vn/, "trang xác nhận che email");
      assert.equal((await eventsOf(leadA, "UNSUBSCRIBE")).length, 0, "GET không huỷ hộ ai");
      const p = await hit("POST", tokenA);
      assert.equal(p.status, 200);
      const sup = await db.query.wholesaleSuppressions.findFirst({ where: and(eq(schema.wholesaleSuppressions.kind, "EMAIL"), eq(schema.wholesaleSuppressions.value, "lan@bienxanh.vn")) });
      assert.ok(sup, "huỷ đăng ký ⇒ chặn EMAIL");
      assert.equal((await eventsOf(leadA, "UNSUBSCRIBE")).length, 1);
      assert.equal((await outboxOf(pending[0]!.id))?.status, "CANCELLED", "thư chờ của lead bị dừng");
      assert.equal((await hit("POST", tokenA)).status, 200, "bấm lại vẫn trả trang «đã huỷ»");
      assert.equal((await eventsOf(leadA, "UNSUBSCRIBE")).length, 1, "bấm lại không ghi thêm");
      const tokUsed = await db.query.wholesaleUnsubscribeTokens.findFirst({ where: eq(schema.wholesaleUnsubscribeTokens.outboxId, idOff) });
      assert.equal(tokUsed?.usedVia, "ONE_CLICK");

      // ── Trả lời: REPLY + dừng chuỗi + MỘT việc phòng Kinh doanh; đọc lại không nhân; thư tự động bỏ qua; thư nhắc nối luồng. ──
      const leadR = await addLead("Nhà hàng Trả Lời", "chu@traloi.vn", true);
      await db.update(schema.wholesaleLeads).set({ assignedToUserId: saleRow!.id, assignedToName: "Sale Hoa" }).where(eq(schema.wholesaleLeads.id, leadR));
      const idR = await draftAndApprove(admin, leadR);
      const rec = new DryRunEmailProvider();
      await runEmailOutboxTick({ now: new Date(later.getTime() + 80 * 60_000), provider: rec });
      const d0 = await outboxOf(idR);
      assert.equal(d0?.status, "SENT");
      const [fu] = await db
        .insert(schema.wholesaleEmailOutbox)
        .values({ leadId: leadR, toEmail: "chu@traloi.vn", recipientDomain: "traloi.vn", subject: "Nhắc lại bảng giá", bodyText: "Em nhắc lại bảng giá sỉ ạ", templateKey: "FOLLOWUP", sequenceStep: 1, status: "DRAFT", idempotencyKey: emailIdempotencyKey(leadR, "FOLLOWUP", 1, "chu@traloi.vn"), preparedBy: "USER", threadId: idR })
        .returning({ id: schema.wholesaleEmailOutbox.id });
      assert.ok("ok" in (await approveEmailCore(admin, fu!.id, { queue: true }, NOW)));
      await runEmailOutboxTick({ now: new Date(later.getTime() + 100 * 60_000), provider: rec });
      assert.equal(rec.sent.length, 2);
      assert.equal(rec.sent[1]!.headers["In-Reply-To"], d0!.messageIdHeader, "thư nhắc trả lời đúng thư D0");
      assert.equal(rec.sent[1]!.headers.References, d0!.messageIdHeader);
      const [fu2] = await db
        .insert(schema.wholesaleEmailOutbox)
        .values({ leadId: leadR, toEmail: "chu@traloi.vn", subject: "Nhắc lần 2", bodyText: "Em nhắc lần hai", templateKey: "FOLLOWUP", sequenceStep: 2, status: "QUEUED", idempotencyKey: emailIdempotencyKey(leadR, "FOLLOWUP", 2, "chu@traloi.vn"), preparedBy: "USER", threadId: idR })
        .returning({ id: schema.wholesaleEmailOutbox.id });
      const auto = await ingestInboundEmail({ messageId: "<ooo-1@traloi.vn>", inReplyTo: d0!.messageIdHeader, from: "chu@traloi.vn", subject: "Vắng mặt", text: "Tôi đang nghỉ phép", autoSubmitted: "auto-replied" }, NOW);
      assert.equal(auto.status, "IGNORED_AUTO", "thư trả lời tự động không phải khách trả lời");
      const reply = { messageId: "<rep-1@traloi.vn>", inReplyTo: "<khong-co@x.vn>", references: [d0!.messageIdHeader!, "<khong-co@x.vn>"], from: "Chị Hạnh <Chu@TraLoi.vn>", subject: "Re: [QC] Bảng giá", text: "Gửi chị báo giá ruốc 10kg nhé" };
      const r1 = await ingestInboundEmail(reply, NOW);
      assert.ok(r1.status === "MATCHED", JSON.stringify(r1));
      assert.deepEqual([r1.leadId, r1.outboxId, r1.stopped, r1.matchedBy], [leadR, idR, 1, "THREAD"], "nối luồng qua References khi In-Reply-To lạ; dừng thư nhắc lần 2");
      assert.ok(r1.workItemId, "tạo việc cho người phụ trách");
      assert.equal((await outboxOf(fu2!.id))?.status, "CANCELLED");
      const r2 = await ingestInboundEmail(reply, NOW);
      assert.equal(r2.status, "DUPLICATE", "đọc lại cùng Message-ID ⇒ không ghi thêm");
      assert.equal((await eventsOf(leadR, "REPLY")).length, 1);
      const tasks = await db.select().from(schema.workItems).where(and(eq(schema.workItems.businessEntity, "WHOLESALE_LEAD"), eq(schema.workItems.businessEntityId, leadR)));
      assert.equal(tasks.length, 1, "đúng MỘT việc");
      assert.equal(tasks[0]!.assigneeId, saleRow!.id, "việc giao đúng người phụ trách lead");
      const leadRAfter = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadR) });
      assert.ok(leadRAfter?.firstResponseAt, "ghi mốc phản hồi đầu tiên");
      assert.equal((await ingestInboundEmail({ messageId: "<la@x.vn>", from: "nguoi-la@x.vn", subject: "?", text: "?" }, NOW)).status, "UNMATCHED");

      // Cổng sau khi trả lời: lead dừng hẳn.
      const [after] = await db
        .insert(schema.wholesaleEmailOutbox)
        .values({ leadId: leadR, toEmail: "chu@traloi.vn", subject: "Nhắc lần 3", bodyText: "Em nhắc lần ba", templateKey: "FOLLOWUP", sequenceStep: 3, status: "DRAFT", idempotencyKey: emailIdempotencyKey(leadR, "FOLLOWUP", 3, "chu@traloi.vn"), preparedBy: "USER", threadId: idR })
        .returning({ id: schema.wholesaleEmailOutbox.id });
      const ap = await approveEmailCore(admin, after!.id, { queue: true }, NOW);
      assert.ok("ok" in ap && ap.warnings.some((w) => /trả lời/.test(w)), "người duyệt được báo trước: lead đã trả lời");
      await runEmailOutboxTick({ now: new Date(later.getTime() + 120 * 60_000), provider: rec });
      assert.equal((await outboxOf(after!.id))?.status, "BLOCKED", "reply ⇒ dừng chuỗi");

      // Trang đọc được (phạm vi ALL).
      const listed = await listOutbox({ allow: "ALL" } as Parameters<typeof listOutbox>[0], "sent");
      assert.ok(!("unavailable" in listed) && listed.length >= 4);
    });

    // ── Cách ly tổ chức: token A gắn nhãn B / tổ chức không có / sai dạng ⇒ cùng một 404, B không bị ghi gì. ──
    const secret = parseUnsubscribeToken(tokenA)!.secret;
    for (const t of [`vnxu1.${ORG_B}.${secret}`, `vnxu1.khong-co-to-chuc.${secret}`, "vnxu1.we-a.ngan", "rac"]) {
      assert.equal((await hit("POST", t)).status, 404, `token ${t.slice(0, 20)}… ⇒ 404`);
      assert.equal((await hit("GET", t)).status, 404);
    }
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      assert.equal((await db.select().from(schema.wholesaleSuppressions)).length, 0, "lượt giả không ghi gì ở B");
      assert.equal((await db.select().from(schema.wholesaleEmailEvents)).length, 0);
      // ── SERVE-COMPAT 0264: bảng chưa có ⇒ job không hỏng, trang in câu báo. ──
      await db.execute(sql.raw(`ALTER TABLE wholesale_email_outbox RENAME TO wholesale_email_outbox_tam`));
      try {
        assert.equal(await emailOutboxHasWork(NOW), false, "chưa áp 0264 ⇒ job không có việc, không ném");
        assert.deepEqual(await listOutbox({ allow: "ALL" } as Parameters<typeof listOutbox>[0], "open"), { unavailable: true });
      } finally {
        await db.execute(sql.raw(`ALTER TABLE wholesale_email_outbox_tam RENAME TO wholesale_email_outbox`));
      }
    });
  } finally {
    await cleanupOrg(ORG_A);
    await cleanupOrg(ORG_B);
  }
}

export async function testWholesaleEmail() {
  testPolicy();
  testSettingsAndBackoff();
  testHeaders();
  testSource();
  await testDb();
  console.log(
    "  ✓ E1 email bán sỉ (chạy thử): cổng chặn đúng 21 lý do, gom đủ, tất định · email công khai không đồng ý ⇒ chặn · OFF / DRY_RUN / LIVE-không-adapter · List-Unsubscribe + One-Click đúng RFC 8058 · gửi 2 lần / 2 lượt song song ⇒ 1 SENT · chạy thử không đổi trạng thái lead · lỗi tạm lùi dần, vĩnh viễn FAILED · hạn mức + nút dừng (dừng dễ mở khó) · huỷ đăng ký ⇒ chặn EMAIL + dừng thư chờ · token A gắn nhãn B ⇒ 404 · trả lời ⇒ REPLY + dừng chuỗi + 1 việc · chưa áp 0264 không sập",
  );
}
