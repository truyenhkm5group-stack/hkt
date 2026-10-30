/**
 * ═══ E2 · GỬI EMAIL THẬT QUA GOOGLE WORKSPACE SMTP (connector `gws-smtp`, chủ shop chốt 30/10/2026) ═══
 *
 * Mọi bài dùng SMTP GIẢ (tiêm `SmtpTransportFactory`) — không mở socket, không gọi smtp.gmail.com (AGENTS 65).
 * Khoá:
 *  1. THUẦN — App Password chuẩn hoá (16 chữ, bỏ khoảng trắng), hộp thư hợp lệ, phân loại lỗi SMTP (AUTH · tạm · vĩnh viễn),
 *     che bí mật trong mọi câu lỗi.
 *  2. ADAPTER — From = hộp thư đã đăng nhập; Message-ID ổn định; In-Reply-To / References; List-Unsubscribe +
 *     List-Unsubscribe-Post đúng RFC 8058; thiếu tiêu đề huỷ / Message-ID ⇒ không gửi; lỗi đăng nhập ⇒ dừng lô.
 *  3. SỔ CONNECTOR — PER_ORG, App Password là ô bí mật, có hàm kiểm tra, có trong LIVE_EMAIL_ADAPTERS; mặc định email vẫn TẮT.
 *  4. TỔ CHỨC THẬT `wg-a`: LIVE bị từ chối khi kết nối chưa bật; lưu → bí mật mã hoá (không có chữ thô trong CSDL) → Kiểm tra
 *     (verify, không gửi) → Bật → quản trị bật LIVE → thư đã duyệt đi qua SMTP giả, lead thành «Đã liên hệ»; lỗi đăng nhập dừng lượt,
 *     thư sau không bị đụng; tắt kết nối ⇒ thư nằm chờ kèm lý do.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { findConnector, isOrgConfigurable, secretFields } from "@/lib/connectors/registry";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { ORG_CONNECTION_TESTERS } from "@/lib/connectors/testers";
import { buildOutgoingEmail } from "@/lib/email-provider/message";
import { EmailSendError } from "@/lib/email-provider/types";
import { classifySmtpError, GWS_SMTP_HOST, GWS_SMTP_PORT, GwsSmtpProvider, maskSecret, normalizeAppPassword, smtpCredentialsOf, verifySmtp, type SmtpTransportFactory, type SmtpTransportLike } from "@/lib/integrations/gws-smtp/client";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { DEFAULT_EMAIL_SETTINGS, LIVE_EMAIL_ADAPTERS } from "@/lib/wholesale/email-constants";
import { saveEmailAllowedCountriesCore } from "@/lib/wholesale/email-countries";
import { approveEmailCore, emailDraftForLeadCore, runEmailOutboxTick, saveEmailSettingsCore } from "@/lib/wholesale/email-outbox";

const ORG = "wg-a";
const NOW = new Date("2026-10-30T03:00:00Z");
const PASS = "abcdefghijklmnop";
const PASS_SPACED = "abcd efgh ijkl mnop";
const MAILBOX = "truyenhk@vnxcommerce.com";
const SENDER = { name: "VNX Commerce", email: MAILBOX, companyName: "Công ty VNX Commerce", address: "12 Lê Lợi, Hải Châu, Đà Nẵng" };

type Call = { kind: "verify" | "send"; mail?: Record<string, unknown>; opts: { host: string; port: number; user: string; pass: string } };

/** SMTP giả: ghi lại mọi lượt; `plan` quyết từng lượt OK hay ném lỗi kiểu nodemailer. */
function fakeSmtp(calls: Call[], plan: (Record<string, unknown> | "ok")[] = []): SmtpTransportFactory {
  return (opts) => {
    const t: SmtpTransportLike = {
      async verify() {
        calls.push({ kind: "verify", opts });
        const step = plan.shift() ?? "ok";
        if (step !== "ok") throw Object.assign(new Error(String(step.message ?? "lỗi")), step);
        return true;
      },
      async sendMail(mail) {
        calls.push({ kind: "send", mail, opts });
        const step = plan.shift() ?? "ok";
        if (step !== "ok") throw Object.assign(new Error(String(step.message ?? "lỗi")), step);
        return { messageId: String(mail.messageId), response: "250 2.0.0 OK", accepted: [mail.to], rejected: [] };
      },
      close() {},
    };
    return t;
  };
}

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testPure() {
  assert.equal(normalizeAppPassword(" ABCD efgh ijkl MNOP "), PASS, "App Password: bỏ khoảng trắng, chữ thường");
  assert.deepEqual(smtpCredentialsOf({ appPassword: PASS_SPACED }, { mailbox: " Truyenhk@VNXcommerce.com " }), { user: MAILBOX, pass: PASS });
  assert.match(JSON.stringify(smtpCredentialsOf({ appPassword: "matkhaudangnhap123" }, { mailbox: MAILBOX })), /16 chữ cái/, "mật khẩu đăng nhập ≠ App Password");
  assert.match(JSON.stringify(smtpCredentialsOf({ appPassword: PASS }, { mailbox: "khong-phai-email" })), /hộp thư/);
  assert.equal(classifySmtpError({ code: "EAUTH", responseCode: 535 }).kind, "AUTH");
  assert.equal(classifySmtpError({ responseCode: 421 }).kind, "TRANSIENT", "4xx ⇒ tạm");
  assert.equal(classifySmtpError({ responseCode: 550 }).kind, "PERMANENT", "5xx ⇒ vĩnh viễn");
  assert.equal(classifySmtpError({ code: "ETIMEDOUT" }).kind, "TRANSIENT", "hết giờ ⇒ tạm");
  assert.equal(classifySmtpError(new Error("lạ")).kind, "TRANSIENT", "không biết ⇒ không kết luận vĩnh viễn");
  assert.equal(maskSecret(`sai ${PASS} và ${PASS_SPACED}`, PASS), "sai •••• và ••••", "che cả dạng liền lẫn dạng 4 cụm");
}

// ─────────────────────────── 2. ADAPTER ───────────────────────────

async function testAdapter() {
  const calls: Call[] = [];
  const ok = await verifySmtp({ user: MAILBOX, pass: PASS }, fakeSmtp(calls));
  assert.ok(ok.ok && ok.message.includes("chưa gửi thư nào"), ok.message);
  assert.deepEqual([calls.length, calls[0]!.kind, calls[0]!.opts.host, calls[0]!.opts.port], [1, "verify", GWS_SMTP_HOST, GWS_SMTP_PORT], "kiểm tra = verify, KHÔNG sendMail");
  const bad = await verifySmtp({ user: MAILBOX, pass: PASS }, fakeSmtp([], [{ code: "EAUTH", responseCode: 535, message: `535 Username and Password not accepted ${PASS}` }]));
  assert.ok(!bad.ok && /Xác minh 2 bước/.test(bad.message) && !bad.message.includes(PASS), "sai đăng nhập ⇒ hướng dẫn, không lộ App Password");
  const net = await verifySmtp({ user: MAILBOX, pass: PASS }, fakeSmtp([], [{ code: "ECONNECTION", message: `kết nối hỏng khi gửi ${PASS}` }]));
  assert.ok(!net.ok && !net.message.includes(PASS), "câu lỗi mạng đã che bí mật");

  const url = "https://vnx.vnxcommerce.com/api/wholesale/unsubscribe/vnxu1.wg-a.x";
  const prior = "<wsm-d0@vnxcommerce.com>";
  const msg = buildOutgoingEmail({ outboxId: "f1", sender: { ...SENDER, email: "khac@vnxcommerce.com" }, to: "chu@nhahang.vn", subject: "Nhắc", body: "Em nhắc bảng giá", unsubscribeUrl: url, idempotencyKey: "k", threadMessageIds: [prior] });
  const sent: Call[] = [];
  const p = new GwsSmtpProvider({ user: MAILBOX, pass: PASS }, fakeSmtp(sent));
  const r = await p.send(msg);
  const mail = sent[0]!.mail!;
  assert.deepEqual(mail.from, { name: "VNX Commerce", address: MAILBOX }, "From = hộp thư đã đăng nhập (Gmail đổi From lạ)");
  assert.equal(mail.messageId, "<wsm-f1@vnxcommerce.com>", "Message-ID ổn định theo id thư");
  assert.deepEqual([mail.inReplyTo, mail.references], [prior, prior], "thư nhắc nối luồng");
  const headers = mail.headers as Record<string, string>;
  assert.equal(headers["List-Unsubscribe"], `<${url}>`, "RFC 8058: List-Unsubscribe trỏ route huỷ");
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "RFC 8058: One-Click");
  assert.deepEqual([mail.disableFileAccess, mail.disableUrlAccess], [true, true], "không cho nodemailer đọc tệp / tải URL");
  assert.deepEqual(r, { providerMessageId: "<wsm-f1@vnxcommerce.com>", messageIdHeader: "<wsm-f1@vnxcommerce.com>" });

  const noUnsub = { ...msg, headers: { "Message-ID": msg.headers["Message-ID"]! } };
  await assert.rejects(p.send(noUnsub), (e: unknown) => e instanceof EmailSendError && !e.transient, "thiếu tiêu đề huỷ đăng ký ⇒ không gửi");
  const fail = (step: Record<string, unknown>) => new GwsSmtpProvider({ user: MAILBOX, pass: PASS }, fakeSmtp([], [step])).send(msg);
  await assert.rejects(fail({ responseCode: 550, message: "550 mailbox unavailable" }), (e: unknown) => e instanceof EmailSendError && !e.transient, "550 ⇒ vĩnh viễn");
  await assert.rejects(fail({ responseCode: 421, message: "421 try later" }), (e: unknown) => e instanceof EmailSendError && e.transient, "421 ⇒ tạm");
  await assert.rejects(fail({ code: "EAUTH", responseCode: 535, message: `bad ${PASS}` }), (e: unknown) => e instanceof EmailSendError && (e as { stopBatch?: boolean }).stopBatch === true && !e.message.includes(PASS), "sai đăng nhập ⇒ dừng lô, không lộ bí mật");
}

// ─────────────────────────── 3. SỔ CONNECTOR ───────────────────────────

function testRegistry() {
  const spec = findConnector("gws-smtp");
  assert.ok(spec && isOrgConfigurable(spec), "gws-smtp là kết nối theo tổ chức, cấu hình ở /settings/connections");
  assert.deepEqual(secretFields(spec).map((f) => f.key), ["appPassword"], "chỉ App Password là bí mật (hiện dạng che)");
  assert.equal(spec.kind, "MESSAGING");
  assert.ok(spec.consumers.length > 0, "có luồng đọc lúc chạy");
  assert.ok(ORG_CONNECTION_TESTERS["gws-smtp"], "có hàm kiểm tra");
  assert.ok(LIVE_EMAIL_ADAPTERS.includes("gws-smtp"));
  assert.equal(DEFAULT_EMAIL_SETTINGS.mode, "OFF", "thêm adapter KHÔNG đổi chế độ mặc định");
}

// ─────────────────────────── 4. TỔ CHỨC THẬT ───────────────────────────

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

async function addLead(name: string, email: string): Promise<string> {
  const db = await getDb();
  const [l] = await db.insert(schema.wholesaleLeads).values({ source: "STAFF", businessName: name, email, contactStatus: "QUALIFIED", enrichmentStatus: "READY" }).returning({ id: schema.wholesaleLeads.id });
  await db.insert(schema.wholesaleContactConsents).values({ leadId: l!.id, channel: "EMAIL", contactValue: email, basis: "OPT_IN_FORM", evidenceText: "Khách điền form nhận báo giá ở hội chợ", source: "STAFF", recordedByName: "Thử" });
  return l!.id;
}

async function queued(user: SessionUser, leadId: string): Promise<string> {
  const d = await emailDraftForLeadCore(user, leadId, { useAi: false }, NOW);
  assert.ok("ok" in d, JSON.stringify(d));
  const a = await approveEmailCore(user, d.id, { queue: true }, NOW);
  assert.ok("ok" in a, JSON.stringify(a));
  return d.id;
}

async function testDb() {
  await cleanupOrg();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-gws-smtp-0123456789abcdefghijklmnopqrstuvwxyz-ABCDEF";
  await provisionOrganization({ code: ORG, name: "Shop gửi thư", plan: "standard", modules: ["customers", "wholesale_leads"], admin: { email: `chu@${ORG}.local`, name: "Chủ shop", password: "GuiThuThat@2026!" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const modules = [...(await getEnabledModules(ORG))];
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `chu@${ORG}.local`) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: "Chủ shop", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: "Shop gửi thư", isHome: false }, modules };
      const settingsIn = { mode: "LIVE", sender: SENDER, limits: { perHour: 20, perDay: 100, perRecipientDomainPerDay: 5 } };

      // ── LIVE bị từ chối khi kết nối chưa có / chưa bật. ──
      assert.match(JSON.stringify(await saveEmailSettingsCore(admin, settingsIn, NOW)), /chưa sẵn sàng/, "chưa có kết nối ⇒ không bật được GỬI THẬT");

      // ── Lưu → bí mật mã hoá; Kiểm tra (verify, không gửi) → Bật. ──
      const saved = await saveConnection(admin, { connectorKey: "gws-smtp", settings: { mailbox: MAILBOX }, secrets: { appPassword: PASS_SPACED } });
      assert.ok("ok" in saved, JSON.stringify(saved));
      const row = await db.query.orgConnections.findFirst({ where: eq(schema.orgConnections.connectorKey, "gws-smtp") });
      assert.ok(row?.secretsEnc && !JSON.stringify(row).includes(PASS) && !JSON.stringify(row).includes(PASS_SPACED), "App Password không nằm dạng thô trong CSDL");
      const calls: Call[] = [];
      const badTest = await testOrgConnection(admin, "gws-smtp", { tester: { smtpTransport: fakeSmtp(calls, [{ code: "EAUTH", responseCode: 535, message: "535 bad" }]) } });
      assert.ok("error" in badTest && !badTest.error.includes(PASS), "kiểm tra sai ⇒ lỗi, không lộ bí mật");
      const okTest = await testOrgConnection(admin, "gws-smtp", { tester: { smtpTransport: fakeSmtp(calls) } });
      assert.ok("ok" in okTest, JSON.stringify(okTest));
      assert.ok(calls.every((c) => c.kind === "verify") && calls.every((c) => c.opts.user === MAILBOX && c.opts.pass === PASS), "kiểm tra chỉ verify, đúng hộp thư + App Password đã chuẩn hoá");
      assert.ok("ok" in (await setConnectionStatus(admin, "gws-smtp", "ACTIVE")));
      const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, "gws-smtp"));
      assert.ok(logs.length > 0 && !JSON.stringify(logs).includes(PASS), "nhật ký không chứa App Password");

      // ── Bật LIVE (quản trị) + nước VN đã rà luật (cổng nước của #1102) ⇒ thư đã duyệt đi qua SMTP giả; lead «Đã liên hệ». ──
      assert.ok("ok" in (await saveEmailSettingsCore(admin, settingsIn, NOW)));
      assert.ok("ok" in (await saveEmailAllowedCountriesCore(admin, { countries: ["VN"], reason: "Bài kiểm: giả định đã rà luật thư chào hàng VN" })));
      const leadA = await addLead("Nhà hàng Gửi Thật", "chu@guithat.vn");
      const idA = await queued(admin, leadA);
      const sent: Call[] = [];
      const t1 = await runEmailOutboxTick({ now: NOW, smtpTransport: fakeSmtp(sent) });
      assert.deepEqual([t1.mode, t1.sent], ["LIVE", 1], JSON.stringify(t1));
      const out = await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, idA) });
      assert.deepEqual([out?.status, out?.mode, out?.provider], ["SENT", "LIVE", "gws-smtp"]);
      const mail = sent.find((c) => c.kind === "send")!.mail!;
      assert.equal(mail.messageId, out?.messageIdHeader, "Message-ID lưu = Message-ID gửi (nối luồng trả lời)");
      assert.equal((mail.headers as Record<string, string>)["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      assert.match(String((mail.headers as Record<string, string>)["List-Unsubscribe"]), /\/api\/wholesale\/unsubscribe\/vnxu1\.wg-a\./);
      const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadA) });
      assert.deepEqual([lead?.contactStatus, lead?.contactAttemptCount], ["CONTACTED", 1], "gửi THẬT mới là một lần liên hệ");

      // ── Sai đăng nhập ⇒ DỪNG lượt: thư đầu hẹn lại, thư sau không bị đụng. ──
      const idB = await queued(admin, await addLead("Quán Một", "mot@quanmot.vn"));
      const idC = await queued(admin, await addLead("Quán Hai", "hai@quanhai.vn"));
      const t2 = await runEmailOutboxTick({ now: NOW, smtpTransport: fakeSmtp([], [{ code: "EAUTH", responseCode: 535, message: "535 bad" }]) });
      assert.ok(t2.stopped && t2.retried === 1 && t2.sent === 0, JSON.stringify(t2));
      const rows = await db.select({ id: schema.wholesaleEmailOutbox.id, status: schema.wholesaleEmailOutbox.status, attempts: schema.wholesaleEmailOutbox.attempts }).from(schema.wholesaleEmailOutbox).where(and(eq(schema.wholesaleEmailOutbox.status, "QUEUED")));
      const byId = new Map(rows.map((r) => [r.id, r.attempts]));
      assert.deepEqual([byId.has(idB), byId.has(idC)], [true, true], "cả hai vẫn chờ, không FAILED");
      assert.equal([byId.get(idB), byId.get(idC)].filter((n) => n === 1).length, 1, "chỉ MỘT thư bị thử rồi lượt dừng");

      // ── Tắt kết nối ⇒ thư nằm chờ, lý do nói rõ. ──
      assert.ok("ok" in (await setConnectionStatus(admin, "gws-smtp", "DISABLED")));
      const t3 = await runEmailOutboxTick({ now: new Date(NOW.getTime() + 3_600_000), smtpTransport: fakeSmtp([]) });
      assert.equal(t3.sent, 0);
      const held = await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, idC) });
      assert.match(held?.lastError ?? "", /Chưa gửi được ở chế độ LIVE/, "kết nối tắt ⇒ giữ thư, nói lý do");
    });
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanupOrg();
  }
}

export async function testWholesaleEmailGws() {
  testPure();
  await testAdapter();
  testRegistry();
  await testDb();
  console.log(
    "  ✓ E2 Google Workspace SMTP: App Password 16 chữ chuẩn hoá · lỗi SMTP AUTH / tạm / vĩnh viễn · bí mật che ở mọi câu lỗi, mã hoá trong CSDL · kiểm tra = verify không gửi · From = hộp thư đăng nhập · Message-ID ổn định + nối luồng · List-Unsubscribe One-Click (RFC 8058) · LIVE cần kết nối bật + quản trị · gửi thật ⇒ lead «Đã liên hệ» · sai đăng nhập dừng lô · kết nối tắt ⇒ thư chờ",
  );
}
