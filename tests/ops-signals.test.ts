/**
 * ═══════════ TÍN HIỆU VẬN HÀNH CHO TỪNG KHÁCH (LAUNCH SPRINT §11 «Observability before sales» · sứ mệnh saas-ops-signals) ═══════════
 *
 * Người vận hành phải chẩn đoán được tám loại sự cố của MỘT khách: đăng nhập · Facebook · webhook · AI im · gửi tin · đơn không hợp lệ ·
 * ghi đơn · hạn mức. Bài này khoá đúng những gì sửa:
 *
 *  A. THUẦN — bộ che định danh luôn có «***»; lý do mạnh nhất của trang dò nhiều tổ chức; tám dòng của khung (CHƯA BIẾT ≠ 0, «đo từ …»);
 *     bảy dòng gương từ sự thật; lý do gửi hỏng; lõi đơn từ chối ⇒ lý do; danh sách CHECK của migration = hằng số trong mã.
 *  B. ĐĂNG NHẬP — mỗi lý do (không có tài khoản · sai mật khẩu · tài khoản khoá · tổ chức đình chỉ · mã không tồn tại · trang chung) ghi
 *     ĐÚNG một dòng, câu trả người dùng KHÔNG đổi; bị chặn dò ghi MỘT dòng mỗi cửa sổ khoá (không nhân dòng); liên kết đặt mật khẩu / mời
 *     hết hạn · đã dùng có lý do riêng; không mật khẩu, không email thô ở bất kỳ ô nào (CHECK ở CSDL chặn cả lượt ghi lỡ tay).
 *  C. GHI ĐƠN HỎNG ≠ AI HỎNG — lõi đơn ném (trigger CSDL giả lập) bên trong công cụ của bot: sổ AI KHÔNG có dòng ERROR, hội thoại chuyển
 *     người với lý do GHI ĐƠN (không phải AI_DOWN), `audit_logs` có `order.create_failed` mang `correlation_id` = id hội thoại, câu lỗi gốc
 *     (có SĐT) không lọt ra; đơn bị từ chối ⇒ `order.validation_failed`.
 *  D. AI IM CÓ TÊN — lượt AI hỏng ghi `error_class`; lượt bị chặn hạn mức ghi TRẦN nào chạm.
 *  E. GƯƠNG — job `sales-health` (đi ĐÚNG `runJob`) ghi bảy dòng `platform_org_health`; hết lỗi ⇒ về OK, dòng vẫn còn; kiểm webhook
 *     của page có trần lượt gọi Graph và nghỉ khi Graph báo chạm trần.
 *  F. KHUNG — chỉ người vận hành nền tảng đọc được; chưa có dữ liệu ⇒ «chưa biết», không bao giờ «0 lỗi».
 *
 * Tổ chức THẬT `ops-sig` / `ops-sig-dung` (tự cấp, tự dọn), provider AI giả, Graph giả — không gọi mạng (AGENTS 65). Mốc theo đồng hồ
 * thật, dữ liệu gieo TƯƠNG ĐỐI với `now` (AGENTS 50).
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, rmSync } from "node:fs";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { RequestCookies, ResponseCookies } from "next/dist/server/web/spec-extension/cookies";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { OpsSignalsPanel } from "@/components/platform/ops-signals-panel";
import type { AiBlock, AiProvider, AiRequest, AiResponse } from "@/lib/ai/provider";
import { invalidateAiControl } from "@/lib/ai-usage/control";
import { AI_QUOTA_BLOCK_REASONS, AI_USAGE_ERROR_CLASSES } from "@/lib/ai-usage/types";
import { loginAction } from "@/lib/actions/auth";
import { authIdentifierHash, pruneAuthFailures, recordAuthFailure, resetAuthFailureLocksForTests } from "@/lib/auth/auth-failures";
import { LOGIN_ACCOUNT_DISABLED, LOGIN_BAD_CREDENTIALS, strongestLoginFailure } from "@/lib/auth/login";
import { resetLoginThrottle } from "@/lib/auth/login-throttle";
import { hashPassword } from "@/lib/auth/password";
import { resolvePermissions } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { AI_FAILURE_CLASSES } from "@/lib/constants/ai-incidents";
import { AUTH_FAILURE_REASONS, maskLoginIdentifier } from "@/lib/constants/auth-failures";
import {
  buildOpsSignalLines,
  OPS_LEVELS,
  OPS_SIGNAL_KEYS,
  ORDER_ATTEMPT_ENTITY,
  ORDER_CREATE_FAILED_ACTION,
  ORDER_VALIDATION_FAILED_ACTION,
  ORDER_WRITE_HANDOFF_REASON,
  ORG_HEALTH_CHECK_KEYS,
  type OpsSignalInput,
} from "@/lib/constants/ops-signals";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { loadOpsSignalsForOrgs, loadOrgOpsSignals } from "@/lib/platform/ops-signals";
import { resetOrgHealthHotPathForTests } from "@/lib/platform/org-health";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createProductCore } from "@/lib/records/product-create";
import { AI_DOWN_HANDOFF_REASON } from "@/lib/sales-chatbot/ai-hold-shared";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { chatTurn, openConversation, setSalesChatProviderForTests, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { runSalesHealthCheck } from "@/lib/sales-chatbot/health";
import { connectMessengerPage } from "@/lib/sales-chatbot/messenger";
import { buildMirrorRows, mirrorSalesOpsHealth, runWebhookChecks, sendFailureReason, WEBHOOK_CHECK_SETTING_KEY, type MirrorFacts } from "@/lib/sales-chatbot/ops-mirror";
import { omsValidationReason } from "@/lib/sales-chatbot/order-signals";
import { setSettingJson } from "@/lib/settings";
import { runJob } from "@/lib/sync/jobs";
import { hashUserInviteToken, lookupUserInvite } from "@/lib/users/invites";
import { USER_INVITE_INVALID } from "@/lib/users/invite-shared";
import { hashResetToken, lookupResetToken } from "@/lib/users/password-reset";
import { PASSWORD_RESET_INVALID } from "@/lib/users/password-reset-shared";

const A = "ops-sig";
const S = "ops-sig-dung";
const GHOST = "ops-sig-khong-co";
const ADMIN = `chu@${A}.vn`;
const PW = "OpsSignal@2026a";
const LOCKED = `khoa@${A}.vn`;
const LOCKED_PW = "KhoaRoi@2026bc";
const UNKNOWN_EMAIL = "khong-ai-ca@ops-sig.vn";
const S_ADMIN = `chu@${S}.vn`;
const SECRET_PHONE = "0912345678";
const ENV_KEYS = ["FACEBOOK_LOGIN_APP_ID", "FACEBOOK_LOGIN_APP_SECRET", "FACEBOOK_MESSENGER_APP_ID", "FACEBOOK_MESSENGER_APP_SECRET", "PLATFORM_SECRETS_KEY"] as const;
const APP_ID = "777000123456";
const APP_SECRET = "app-secret-ops-signals-0123456789ab";
const PAGE = "4059681723";
const PAGE_TOKEN = "EAAGpagetoken_ops_signals_0123456789";

let ipSeq = 0;
/** Mốc bắt đầu của bài — dọn dòng không định danh của CHÍNH bài này, không đụng dòng của bài khác. */
let startedAt = new Date();
const nextIp = () => `203.0.113.${(ipSeq += 1) + 10}`;

// ─────────────────────────── A. THUẦN ───────────────────────────

function sqlList(file: string, column: string): string[] {
  const m = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(file);
  assert.ok(m, `không thấy CHECK của ${column}`);
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

function mirrorFacts(p: Partial<MirrorFacts> = {}): MirrorFacts {
  return {
    health: { status: "GREEN", checks: [{ key: "PROVIDER", level: "OK", title: "", detail: "" }, { key: "WEBHOOK", level: "OK", title: "", detail: "" }, { key: "BACKLOG", level: "OK", title: "", detail: "" }] },
    snapshot: {
      botEnabled: true,
      queue: { pending: 0, retrying: 0, oldestPendingAt: null, failedAiDown24h: 0, failedSend24h: 0, abandoned24h: 0, deadLetter: 0 },
      provider: { okInWindow: 3, errorsInWindow: 0, blockedInWindow: 0, lastOkAt: null, lastErrorAt: null, lastErrorKind: null, lastErrorLabel: null },
    },
    inbound: { send7d: 0, deadOther24h: 0, deadOther7d: 0, abandoned7d: 0, lastProcessingAt: null, plan24h: 0, plan7d: 0 },
    lastSend: null,
    lastPlanStop: null,
    lastAiDown: null,
    orders: { write: null, validation: null },
    pages: { active: [], failing: [] },
    webhook: { states: {}, checkedNow: 0, skipped: null },
    entitlement: { allowed: true, reason: null },
    balanceClosed: false,
    ...p,
  };
}

function testPure() {
  // Che định danh: luôn «***», không bao giờ email / SĐT nguyên vẹn.
  assert.equal(maskLoginIdentifier("EMAIL", "nguyenvana@gmail.com"), "ng***@gmail.com");
  assert.equal(maskLoginIdentifier("EMAIL", "ab@x.vn"), "a***@x.vn", "phần trước @ ngắn chỉ giữ một ký tự");
  assert.equal(maskLoginIdentifier("PHONE", SECRET_PHONE), "0912***78");
  assert.equal(maskLoginIdentifier(null, "chuoi-la"), "***");
  for (const v of [maskLoginIdentifier("EMAIL", ADMIN), maskLoginIdentifier("PHONE", SECRET_PHONE)]) assert.ok(v.includes("***") && v !== ADMIN && !v.includes(SECRET_PHONE));

  // Trang chung dò nhiều tổ chức: lý do nói nhiều nhất về chỗ tài khoản nằm; «không có» ở tổ chức nhà không quy về nhà.
  assert.deepEqual(strongestLoginFailure([{ reason: "NO_IDENTITY", orgCode: "nha" }, { reason: "BAD_PASSWORD", orgCode: A }], "nha"), { reason: "BAD_PASSWORD", orgCode: A });
  assert.deepEqual(strongestLoginFailure([{ reason: "NO_IDENTITY", orgCode: "nha" }], "nha"), { reason: "NO_IDENTITY", orgCode: null });
  assert.deepEqual(strongestLoginFailure([{ reason: "NO_IDENTITY", orgCode: A }, { reason: "NO_IDENTITY", orgCode: "nha" }], "nha"), { reason: "NO_IDENTITY", orgCode: A }, "chỉ mục cũ trỏ tổ chức đã xoá tài khoản ⇒ quy về tổ chức đó");
  assert.deepEqual(strongestLoginFailure([{ reason: "ORG_INACTIVE", orgCode: S }, { reason: "NO_IDENTITY", orgCode: "nha" }], "nha"), { reason: "ORG_INACTIVE", orgCode: S });

  // Tám dòng: chưa có gì ⇒ CHƯA BIẾT (null), không phải 0.
  const now = new Date();
  const empty: OpsSignalInput = { mirror: {}, login: null, aiErrors: null, aiBlocked: null, aiLastAnyAt: null, signalsSince: null };
  const lines = buildOpsSignalLines(empty, now);
  assert.deepEqual(lines.map((l) => l.key), [...OPS_SIGNAL_KEYS], "đúng tám dòng, đúng thứ tự");
  for (const l of lines) {
    assert.equal(l.level, "UNKNOWN", `${l.key}: chưa có dữ liệu ⇒ UNKNOWN`);
    assert.equal(l.count24h, null, `${l.key}: chưa có dữ liệu ⇒ đếm null («—»), không phải 0`);
  }
  // Sổ mới mở hai ngày ⇒ «0» thật kèm «đo từ …»; module tắt ⇒ dòng chỉ có gương là N/A.
  const since = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  const fresh = buildOpsSignalLines({ ...empty, signalsSince: since, aiSalesEnabled: false }, now);
  const login = fresh.find((l) => l.key === "LOGIN")!;
  assert.ok(login.level === "OK" && login.count24h === 0 && login.measuredFrom === since, JSON.stringify(login));
  assert.equal(fresh.find((l) => l.key === "SEND")?.level, "NA");
  assert.equal(buildOpsSignalLines({ ...empty, signalsSince: new Date(now.getTime() - 30 * 86_400_000).toISOString() }, now)[0].measuredFrom, null, "mốc ngoài cửa sổ 7 ngày ⇒ số trọn vẹn");
  // Gương cũ ⇒ cờ «cũ»; gương chỉ có sự cố đường nóng ⇒ ghi chú «chưa đối chiếu».
  const stale = buildOpsSignalLines({ ...empty, mirror: { SEND: { key: "SEND", level: "WARNING", count24h: 2, count7d: 3, lastAt: null, lastReason: "TOKEN", correlationId: null, detail: null, since: null, measuredAt: new Date(now.getTime() - 3_600_000).toISOString() } } }, now).find((l) => l.key === "SEND")!;
  assert.ok(stale.stale && stale.count24h === 2 && stale.lastReasonLabel !== null, JSON.stringify(stale));
  const hot = buildOpsSignalLines({ ...empty, mirror: { ORDER_WRITE: { key: "ORDER_WRITE", level: "CRITICAL", count24h: 1, count7d: 1, lastAt: now.toISOString(), lastReason: "ORDER_DRAFT_ERROR", correlationId: "c-1", detail: null, since: null, measuredAt: null } } }, now).find((l) => l.key === "ORDER_WRITE")!;
  assert.ok(hot.level === "CRITICAL" && hot.note?.includes("chưa có lượt đo"), JSON.stringify(hot));
  // AI: dòng lỗi cũ chưa phân loại ⇒ nhãn «chưa phân loại», không đoán lớp.
  const ai = buildOpsSignalLines({ ...empty, aiErrors: { count24h: 1, count7d: 2, lastAt: now.toISOString(), lastReason: null, correlationId: "conv-x", extra: "sales_chatbot", unclassified: 2 }, aiLastAnyAt: now.toISOString() }, now).find((l) => l.key === "AI")!;
  assert.ok(ai.level === "WARNING" && ai.lastReason === "UNCLASSIFIED" && ai.correlationId === "conv-x", JSON.stringify(ai));

  // Gương: bảy dòng từ sự thật (hàm thuần).
  const ok = buildMirrorRows(mirrorFacts());
  assert.deepEqual(ok.map((r) => r.key).sort(), [...ORG_HEALTH_CHECK_KEYS].sort());
  assert.equal(ok.find((r) => r.key === "FB_CONNECTION")?.level, "NA", "không page nối thẳng ⇒ không áp dụng");
  assert.ok(ok.filter((r) => r.key !== "FB_CONNECTION").every((r) => r.level === "OK"), JSON.stringify(ok));
  const sick = buildMirrorRows(
    mirrorFacts({
      pages: { active: ["p1", "p2"], failing: [{ pageId: "p2", reason: "TOKEN", at: now.toISOString() }] },
      webhook: { states: { p1: "NOT_SUBSCRIBED" }, checkedNow: 1, skipped: null },
      orders: { write: { count24h: 1, count7d: 1, lastAt: now.toISOString(), lastReason: "ORDER_DRAFT_ERROR", correlationId: "conv-1" }, validation: null },
      balanceClosed: true,
      health: { status: "OFF", checks: [] },
    }),
  );
  const by = (k: string) => sick.find((r) => r.key === k)!;
  assert.ok(by("FB_CONNECTION").level === "CRITICAL" && by("FB_CONNECTION").count24h === 1, "page lỗi token ⇒ NGHIÊM TRỌNG");
  assert.ok(by("WEBHOOK").level === "CRITICAL" && by("WEBHOOK").lastReason === "NOT_SUBSCRIBED", JSON.stringify(by("WEBHOOK")));
  assert.ok(by("ORDER_WRITE").level === "CRITICAL" && by("ORDER_WRITE").correlationId === "conv-1");
  assert.ok(by("QUOTA").level === "CRITICAL" && by("QUOTA").lastReason === "BALANCE_EXHAUSTED", "hết số dư ⇒ một lý do có tên");
  assert.equal(by("AI").level, "NA", "bot tắt ⇒ không áp dụng, không báo động");
  for (const r of sick) assert.ok(!r.detail || r.detail.length <= 300, `${r.key}: detail ngắn`);
  assert.equal(buildMirrorRows(mirrorFacts({ inbound: null }))[1].level, "UNKNOWN", "không đọc được hàng chờ ⇒ CHƯA BIẾT");

  assert.equal(sendFailureReason("Facebook từ chối: x — Token page hết hiệu lực — chủ page vào Chatbot bán hàng → Messenger, bấm «Đổi page» để nối lại."), "TOKEN");
  assert.equal(sendFailureReason("lỗi gửi — Pancake không nhận tin: conversation_id not found"), "REJECTED");
  assert.equal(sendFailureReason("Request timed out"), "TIMEOUT");
  assert.equal(omsValidationReason({ code: "INVALID", errors: [{ field: "customerId", message: "Vượt hạn mức nợ của Nguyễn Văn A" }] }), "CREDIT_LIMIT");
  assert.equal(omsValidationReason({ code: "CONFLICT", errors: [] }), "OMS_CONFLICT");

  // Danh sách CHECK của migration + lược đồ = hằng số trong mã (thêm lý do mà quên migration ⇒ đỏ ở đây, không đợi production).
  const mig = readFileSync("drizzle/0236_saas_ops_signals.sql", "utf8");
  const schemaTs = readFileSync("db/schema.ts", "utf8");
  assert.deepEqual(sqlList(mig, "reason_code"), [...AUTH_FAILURE_REASONS]);
  assert.deepEqual(sqlList(mig, "error_class"), [...AI_USAGE_ERROR_CLASSES]);
  assert.deepEqual([...AI_USAGE_ERROR_CLASSES], [...AI_FAILURE_CLASSES, ...AI_QUOTA_BLOCK_REASONS]);
  assert.deepEqual(sqlList(mig, "check_key"), [...ORG_HEALTH_CHECK_KEYS]);
  assert.deepEqual(sqlList(mig, "level"), [...OPS_LEVELS]);
  for (const list of [AUTH_FAILURE_REASONS, AI_USAGE_ERROR_CLASSES, ORG_HEALTH_CHECK_KEYS]) assert.ok(schemaTs.includes(list.map((x) => `'${x}'`).join(",")), "db/schema.ts mang đúng danh sách CHECK");
  assert.ok(!/\bupdate\b/i.test(mig.replace(/--.*$/gm, "")), "0236 KHÔNG backfill dòng cũ");
  console.log("✓ Tín hiệu vận hành (thuần): che định danh · lý do mạnh nhất · tám dòng (chưa biết ≠ 0, «đo từ», gương cũ) · bảy dòng gương · CHECK của migration = hằng số");
}

// ─────────────────────────── «Như request thật» cho loginAction ───────────────────────────

const NEXT_STORES = [workAsyncStorage, workUnitAsyncStorage] as unknown as Record<string, unknown>[];
const ALS_METHODS = ["run", "getStore", "exit", "enterWith", "disable"] as const;
function installRealStores() {
  for (const store of NEXT_STORES) {
    if (store instanceof AsyncLocalStorage || Object.prototype.hasOwnProperty.call(store, "run")) continue;
    const real = new AsyncLocalStorage<unknown>() as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ALS_METHODS) store[m] = real[m].bind(real);
  }
}
function removeRealStores() {
  for (const store of NEXT_STORES) if (!(store instanceof AsyncLocalStorage)) for (const m of ALS_METHODS) delete store[m];
}

async function asAction(fn: () => Promise<unknown>, ip: string): Promise<unknown> {
  const workStore = { route: "/login", page: "/login", incrementalCache: {}, isStaticGeneration: false, forceStatic: false, dynamicShouldError: false, pendingRevalidatedTags: [] as string[] };
  const requestStore = {
    type: "request",
    phase: "action",
    implicitTags: { tags: [], expirationsByCacheKind: new Map() },
    url: { pathname: "/login", search: "" },
    headers: new Headers({ "x-forwarded-for": ip, "x-erp-path": "/login" }),
    cookies: new RequestCookies(new Headers()),
    mutableCookies: new ResponseCookies(new Headers()),
    userspaceMutableCookies: new ResponseCookies(new Headers()),
    draftMode: { isEnabled: false },
  };
  setSessionTokenSourceForTests(null);
  try {
    return await workAsyncStorage.run(workStore as unknown as Parameters<typeof workAsyncStorage.run>[0], () => workUnitAsyncStorage.run(requestStore as unknown as Parameters<typeof workUnitAsyncStorage.run>[0], fn));
  } catch (error) {
    const digest = error && typeof error === "object" && "digest" in error ? String((error as { digest: unknown }).digest) : "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw error;
    return { redirected: true };
  }
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const login = (email: string, password: string, ip: string, org?: string) => asAction(() => loginAction(undefined, form({ email, password, next: "/", ...(org ? { org } : {}) })), ip);

type FailureRow = typeof schema.platformAuthFailures.$inferSelect;
async function failuresOf(email: string | null): Promise<FailureRow[]> {
  const pdb = await getPlatformDb();
  const t = schema.platformAuthFailures;
  return pdb.select().from(t).where(email ? eq(t.identifierHash, authIdentifierHash(email)) : sql`${t.identifierHash} is null`);
}

/** Một lượt đăng nhập hỏng ⇒ đúng một dòng mới mang lý do + tổ chức mong đợi; câu trả người dùng giữ nguyên. */
async function expectLoginFailure(label: string, input: { email: string; password: string; org?: string }, want: { reason: string; org: string | null; message: string }) {
  const before = (await failuresOf(input.email)).length;
  const v = await login(input.email, input.password, nextIp(), input.org);
  assert.deepEqual(v, { error: want.message }, `${label}: câu trả người dùng KHÔNG đổi`);
  const rows = await failuresOf(input.email);
  assert.equal(rows.length, before + 1, `${label}: đúng MỘT dòng mới`);
  const last = rows.sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  assert.equal(last.reasonCode, want.reason, `${label}: lý do`);
  assert.equal(last.orgCode, want.org, `${label}: tổ chức`);
  assert.equal(last.flow, "LOGIN");
  assert.ok(last.identifierMasked?.includes("***") && /^[0-9a-f]{64}$/.test(last.ipHash ?? ""), `${label}: định danh che + IP băm`);
}

async function testLoginReasons() {
  resetLoginThrottle();
  resetAuthFailureLocksForTests();
  const home = (await getHomeOrganization()).code;
  await expectLoginFailure("không có tài khoản trong tổ chức gõ", { email: UNKNOWN_EMAIL, password: PW, org: A }, { reason: "NO_IDENTITY", org: A, message: LOGIN_BAD_CREDENTIALS });
  await expectLoginFailure("sai mật khẩu", { email: ADMIN, password: "SaiMatKhau@1", org: A }, { reason: "BAD_PASSWORD", org: A, message: LOGIN_BAD_CREDENTIALS });
  await expectLoginFailure("tài khoản khoá", { email: LOCKED, password: LOCKED_PW, org: A }, { reason: "USER_INACTIVE", org: A, message: LOGIN_ACCOUNT_DISABLED });
  await expectLoginFailure("tổ chức đình chỉ", { email: S_ADMIN, password: PW, org: S }, { reason: "ORG_INACTIVE", org: S, message: LOGIN_BAD_CREDENTIALS });
  await expectLoginFailure("mã tổ chức không tồn tại (mã gõ bừa KHÔNG vào sổ)", { email: ADMIN, password: PW, org: GHOST }, { reason: "ORG_NOT_FOUND", org: null, message: LOGIN_BAD_CREDENTIALS });
  await expectLoginFailure("trang chung, sai mật khẩu ⇒ quy về tổ chức có tài khoản", { email: ADMIN, password: "SaiMatKhau@2" }, { reason: "BAD_PASSWORD", org: A, message: LOGIN_BAD_CREDENTIALS });
  await expectLoginFailure("trang chung, email không ở đâu ⇒ không quy về nhà", { email: `${UNKNOWN_EMAIL}.x`, password: PW }, { reason: "NO_IDENTITY", org: null, message: LOGIN_BAD_CREDENTIALS });
  assert.notEqual(home, A);
  // Đăng nhập ĐÚNG không ghi gì.
  const before = (await failuresOf(ADMIN)).length;
  const okLogin = await login(ADMIN, PW, nextIp(), A);
  assert.deepEqual(okLogin, { redirected: true }, "đăng nhập đúng vẫn vào như cũ");
  assert.equal((await failuresOf(ADMIN)).length, before, "lượt đúng không sinh dòng lỗi");
  console.log("✓ Lỗi đăng nhập có lý do: NO_IDENTITY · BAD_PASSWORD · USER_INACTIVE · ORG_INACTIVE · ORG_NOT_FOUND · trang chung — câu trả người dùng không đổi");
}

async function testThrottleNoAmplify() {
  resetLoginThrottle();
  resetAuthFailureLocksForTests();
  const ip = nextIp();
  const throttledRows = async () => (await failuresOf(ADMIN)).filter((r) => r.reasonCode === "THROTTLED");
  const startThrottled = (await throttledRows()).length;
  for (let i = 0; i < 5; i++) await login(ADMIN, `Sai@${i}xyz`, ip, A);
  // Cặp (email, IP) đã khoá: bắn thêm 6 lượt — chỉ MỘT dòng THROTTLED cho cửa sổ khoá này.
  for (let i = 0; i < 6; i++) {
    const v = (await login(ADMIN, `Sai@${i}abc`, ip, A)) as { error?: string };
    assert.ok(v.error?.startsWith("Sai quá nhiều lần"), `lượt bị chặn vẫn trả câu chặn như cũ: ${JSON.stringify(v)}`);
  }
  const thr = await throttledRows();
  assert.equal(thr.length - startThrottled, 1, `bị chặn ⇒ MỘT dòng mỗi cửa sổ khoá, không một dòng mỗi lượt (có ${thr.length - startThrottled})`);
  assert.ok(thr.every((r) => r.orgCode === A && r.dedupeKey && /^[0-9a-f]{64}$/.test(r.dedupeKey)), "dòng chặn mang tổ chức + khoá chống trùng đã băm");
  // Nhiều tiến trình: khoá chống trùng ở CSDL chặn lần nữa (đường ghi quên trạng thái bộ nhớ vẫn không nhân dòng).
  const lock = { key: `pair:${A}:${ADMIN}|${ip}`, lockedUntil: Date.now() + 60_000 };
  resetAuthFailureLocksForTests();
  assert.equal(await recordAuthFailure({ flow: "LOGIN", reason: "THROTTLED", orgCode: A, identifier: ADMIN, ip, lock }), true);
  resetAuthFailureLocksForTests();
  assert.equal(await recordAuthFailure({ flow: "LOGIN", reason: "THROTTLED", orgCode: A, identifier: ADMIN, ip, lock }), false, "cùng cửa sổ khoá ở tiến trình khác ⇒ CSDL từ chối dòng thứ hai");
  assert.equal(await recordAuthFailure({ flow: "LOGIN", reason: "THROTTLED", orgCode: A, identifier: ADMIN, ip, lock: null }), false, "THROTTLED không có khoá ⇒ không ghi (không chống trùng được)");
  resetLoginThrottle();
  console.log("✓ Bị chặn dò: một dòng THROTTLED mỗi cửa sổ khoá (bộ nhớ + khoá duy nhất ở CSDL) — kẻ dò không khuếch đại được lượt ghi");
}

async function testLinkReasons() {
  resetLoginThrottle();
  const tok = (c: string) => c.repeat(43).slice(0, 43);
  await withOrganization(A, async () => {
    const db = await getDb();
    const admin = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN) });
    assert.ok(admin);
    const r = schema.passwordResetTokens;
    await db.insert(r).values([
      { userId: admin.id, tokenHash: hashResetToken(tok("u")), createdVia: "PLATFORM", expiresAt: new Date(Date.now() + 3_600_000), usedAt: new Date() },
      { userId: admin.id, tokenHash: hashResetToken(tok("e")), createdVia: "PLATFORM", expiresAt: new Date(Date.now() - 60_000) },
      { userId: admin.id, tokenHash: hashResetToken(tok("r")), createdVia: "PLATFORM", expiresAt: new Date(Date.now() + 3_600_000), revokedAt: new Date() },
    ]);
    const i = schema.userInvites;
    await db.insert(i).values([
      { tokenHash: hashUserInviteToken(tok("a")), email: `moi1@${A}.vn`, role: "CS", expiresAt: new Date(Date.now() + 3_600_000), acceptedAt: new Date() },
      { tokenHash: hashUserInviteToken(tok("x")), email: `moi2@${A}.vn`, role: "CS", expiresAt: new Date(Date.now() - 60_000) },
    ]);
  });
  const reset = async (token: string, want: string, who: string | null) => {
    const v = await lookupResetToken(A, token, { ip: nextIp() });
    assert.deepEqual(v, { ok: false, error: PASSWORD_RESET_INVALID }, "liên kết hỏng: câu chung không đổi");
    const rows = (await failuresOf(who)).filter((x) => x.flow === "RESET_LINK" && x.reasonCode === want);
    assert.ok(rows.length >= 1 && rows.every((x) => x.orgCode === A), `${want}: ${JSON.stringify(rows)}`);
  };
  await reset(tok("u"), "RESET_LINK_USED", ADMIN);
  await reset(tok("e"), "RESET_LINK_EXPIRED", ADMIN);
  await reset(tok("r"), "RESET_LINK_REVOKED", ADMIN);
  await reset(tok("z"), "RESET_LINK_INVALID", null);
  const invite = async (token: string, want: string, who: string) => {
    const v = await lookupUserInvite(A, token, { ip: nextIp() });
    assert.deepEqual(v, { ok: false, error: USER_INVITE_INVALID });
    const rows = (await failuresOf(who)).filter((x) => x.flow === "INVITE" && x.reasonCode === want);
    assert.ok(rows.length === 1 && rows[0].orgCode === A, `${want}: ${JSON.stringify(rows)}`);
  };
  await invite(tok("a"), "INVITE_USED", `moi1@${A}.vn`);
  await invite(tok("x"), "INVITE_EXPIRED", `moi2@${A}.vn`);
  // Đường dẫn trỏ tổ chức không tồn tại ⇒ ORG_NOT_FOUND, KHÔNG mang mã gõ bừa.
  await lookupResetToken(GHOST, tok("q"), { ip: nextIp() });
  const ghost = (await failuresOf(null)).filter((x) => x.flow === "RESET_LINK" && x.reasonCode === "ORG_NOT_FOUND");
  assert.ok(ghost.length >= 1 && ghost.every((x) => x.orgCode === null));
  console.log("✓ Liên kết đặt mật khẩu / mời: đã dùng · hết hạn · đã thay · sai · mã tổ chức lạ — câu chung không đổi, lý do riêng trong sổ");
}

async function testNoRawPii() {
  const pdb = await getPlatformDb();
  const t = schema.platformAuthFailures;
  const rows = await pdb.select().from(t).where(or(inArray(t.orgCode, [A, S]), sql`${t.orgCode} is null`));
  assert.ok(rows.length >= 10, `phải có đủ dòng để quét (${rows.length})`);
  const text = JSON.stringify(rows);
  for (const raw of [ADMIN, LOCKED, UNKNOWN_EMAIL, S_ADMIN, PW, LOCKED_PW, "SaiMatKhau@1", "203.0.113."]) assert.ok(!text.includes(raw), `sổ lỗi đăng nhập không được chứa «${raw}»`);
  // CHECK ở CSDL: một lượt ghi lỡ đưa email thô / băm sai hình vào bị TỪ CHỐI, không lặng lẽ lưu.
  await assert.rejects(pdb.insert(t).values({ flow: "LOGIN", reasonCode: "BAD_PASSWORD", identifierMasked: ADMIN }), "bản che phải có «***»");
  await assert.rejects(pdb.insert(t).values({ flow: "LOGIN", reasonCode: "BAD_PASSWORD", identifierHash: ADMIN }), "định danh chỉ ở dạng băm");
  await assert.rejects(pdb.insert(t).values({ flow: "LOGIN", reasonCode: "WRONG_GUESS" }), "lý do ngoài danh sách đóng bị từ chối");
  // Hạn giữ: dòng quá 90 ngày bị dọn, dòng mới giữ nguyên.
  await pdb.insert(t).values({ flow: "LOGIN", reasonCode: "BAD_PASSWORD", orgCode: A, at: new Date(Date.now() - 91 * 86_400_000) });
  const pruned = await pruneAuthFailures(new Date());
  assert.ok(pruned >= 1, "dọn dòng quá hạn giữ");
  assert.ok((await pdb.select().from(t).where(eq(t.orgCode, A))).length >= 5, "dòng trong hạn giữ không bị đụng");
  console.log("✓ Sổ lỗi đăng nhập không chứa mật khẩu / email / IP thô; CHECK ở CSDL chặn lượt ghi lỡ tay; hạn giữ 90 ngày");
}

// ─────────────────────────── C · D. Bot: ghi đơn hỏng ≠ AI hỏng; AI im có tên ───────────────────────────

function scripted(steps: ((results: Record<string, unknown>[]) => AiBlock[])[], opts: { throwWith?: string } = {}): AiProvider {
  let round = 0;
  return {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(req: AiRequest): Promise<AiResponse> {
      if (opts.throwWith) throw new Error(opts.throwWith);
      const last = req.messages[req.messages.length - 1];
      const results = last.content.filter((b): b is Extract<AiBlock, { type: "tool_result" }> => b.type === "tool_result").map((b) => JSON.parse(b.content) as Record<string, unknown>);
      const step = steps[Math.min(round, steps.length - 1)];
      round += 1;
      const content = step(results);
      return { content, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
}

async function aiRowsOf(conversationId: string) {
  const pdb = await getPlatformDb();
  return pdb.select().from(schema.platformAiUsage).where(and(eq(schema.platformAiUsage.orgCode, A), eq(schema.platformAiUsage.conversationId, conversationId)));
}

async function testBotSignals(variantId: string) {
  resetOrgHealthHotPathForTests();
  await withOrganization(A, async () => {
    const db = await getDb();
    const c = schema.salesChatConversations;
    let n = 0;
    const use = (name: string, input: unknown): AiBlock => ({ type: "tool_use", id: `tu-${++n}`, name, input });
    const customer = use("create_customer", { name: "Nguyễn Thị Lan", phone: SECRET_PHONE, address: "12 Hàng Bạc, Hoàn Kiếm, Hà Nội" });

    // ── C1. Lõi đơn NÉM (trigger CSDL giả lập, câu lỗi mang SĐT) ⇒ KHÔNG phải AI hỏng ──
    await db.execute(sql.raw(`create or replace function ops_test_fail_orders() returns trigger language plpgsql as $f$ begin raise exception 'ops-test: lõi đơn hỏng giả lập (khách ${SECRET_PHONE})'; end $f$`));
    await db.execute(sql.raw(`drop trigger if exists ops_test_fail_orders on orders`));
    await db.execute(sql.raw(`create trigger ops_test_fail_orders before insert on orders for each row execute function ops_test_fail_orders()`));
    try {
      setSalesChatProviderForTests(() => scripted([() => [customer], () => [use("create_draft_order", { items: [{ variant_id: variantId, quantity: 1 }] })], () => [{ type: "text", text: "Dạ." }]]));
      const vk = visitorKeyOf(`ops-sig-don-hong-${Date.now()}`);
      const w = await openConversation("WEB", { visitorKey: vk });
      const r = await chatTurn(w.id, `Cho em 1 gói, ${SECRET_PHONE}, 12 Hàng Bạc Hà Nội`, { channel: "WEB", visitorKey: vk });
      assert.ok(r.ok, r.ok ? "" : r.error);
      const [conv] = await db.select().from(c).where(eq(c.id, w.id));
      assert.equal(conv.status, "HANDOFF", "vẫn có người tiếp nhận");
      assert.equal(conv.handoffReason, ORDER_WRITE_HANDOFF_REASON, "chuyển người mang lý do GHI ĐƠN");
      assert.notEqual(conv.handoffReason, AI_DOWN_HANDOFF_REASON, "KHÔNG phải «AI tạm không trả lời được»");
      assert.ok((conv.lastError ?? "").includes("ORDER_DRAFT_ERROR") && !(conv.lastError ?? "").includes(SECRET_PHONE), `lỗi hội thoại có mã, không câu gốc: ${conv.lastError}`);
      assert.equal(conv.orderId, null, "không đơn nào được ghi là đã chốt");
      const view = r.ok ? r.view : null;
      assert.ok(view && !view.messages.some((m) => m.role === "assistant" && /đã chốt|đã lên đơn/i.test(m.text)), "không câu bot nào nói đã chốt / đã lên đơn");
      const ai = await aiRowsOf(w.id);
      assert.ok(ai.length >= 1 && ai.every((x) => x.status === "OK" && x.errorClass === null), `sổ AI KHÔNG có dòng ERROR vì lỗi đơn: ${JSON.stringify(ai.map((x) => [x.status, x.errorClass]))}`);
      const audits = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, ORDER_CREATE_FAILED_ACTION), eq(schema.auditLogs.correlationId, w.id)));
      assert.equal(audits.length, 1, "MỘT dòng order.create_failed mang correlation_id = id hội thoại");
      const d = audits[0].detail as Record<string, unknown>;
      assert.ok(audits[0].entity === ORDER_ATTEMPT_ENTITY && audits[0].actorKind === "AGENT" && d.reasonCode === "ORDER_DRAFT_ERROR" && d.tool === "create_draft_order" && d.sqlState === "P0001", JSON.stringify(audits[0]));
      assert.ok(!JSON.stringify(audits[0]).includes(SECRET_PHONE), "nhật ký không mang câu lỗi gốc (có SĐT khách)");
      const handoff = await db.select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, `sales-chat:handoff:${w.id}`));
      assert.ok(handoff.length === 1 && handoff[0].body.startsWith(ORDER_WRITE_HANDOFF_REASON), "nhân viên được báo đúng lý do ghi đơn");
      const pdb = await getPlatformDb();
      const [mirror] = await pdb.select().from(schema.platformOrgHealth).where(and(eq(schema.platformOrgHealth.orgCode, A), eq(schema.platformOrgHealth.checkKey, "ORDER_WRITE")));
      assert.ok(mirror && mirror.level === "CRITICAL" && mirror.correlationId === w.id && mirror.lastReason === "ORDER_DRAFT_ERROR", `gương ghi đơn hiện NGAY: ${JSON.stringify(mirror)}`);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ops_test_fail_orders on orders`));
      await db.execute(sql.raw(`drop function if exists ops_test_fail_orders()`));
      setSalesChatProviderForTests(null);
    }

    // ── C2. Đơn KHÔNG HỢP LỆ (mã hàng không có) ⇒ order.validation_failed, kết quả công cụ cho model không đổi ──
    setSalesChatProviderForTests(() => scripted([() => [customer], () => [use("create_draft_order", { items: [{ variant_id: "khong-co-ma-nay", quantity: 1 }] })], () => [{ type: "text", text: "Dạ mã này shop chưa có ạ." }]]));
    try {
      const vk = visitorKeyOf(`ops-sig-don-sai-${Date.now()}`);
      const w = await openConversation("WEB", { visitorKey: vk });
      const r = await chatTurn(w.id, `Cho em 1 gói, ${SECRET_PHONE}, 12 Hàng Bạc Hà Nội`, { channel: "WEB", visitorKey: vk });
      assert.ok(r.ok && r.view.messages.some((m) => m.role === "assistant" && m.text.includes("chưa có")), "bot vẫn trả lời khách như cũ");
      const v = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, ORDER_VALIDATION_FAILED_ACTION), eq(schema.auditLogs.correlationId, w.id)));
      assert.ok(v.length === 1 && (v[0].detail as Record<string, unknown>).reasonCode === "UNKNOWN_SKU", JSON.stringify(v));
      assert.ok((await aiRowsOf(w.id)).every((x) => x.status === "OK"));
    } finally {
      setSalesChatProviderForTests(null);
    }

    // ── D1. AI hỏng thật ⇒ ERROR mang LỚP lỗi (hết tiền) ──
    setSalesChatProviderForTests(() => scripted([() => []], { throwWith: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}' }));
    try {
      const vk = visitorKeyOf(`ops-sig-ai-hong-${Date.now()}`);
      const w = await openConversation("WEB", { visitorKey: vk });
      await chatTurn(w.id, "Shop ơi còn hàng không?", { channel: "WEB", visitorKey: vk });
      const rows = await aiRowsOf(w.id);
      const err = rows.filter((x) => x.status === "ERROR");
      assert.ok(err.length === 1 && err[0].errorClass === "CREDIT", `AI im có tên: ${JSON.stringify(rows.map((x) => [x.status, x.errorClass]))}`);
      const [conv] = await db.select().from(c).where(eq(c.id, w.id));
      assert.equal(conv.handoffReason, AI_DOWN_HANDOFF_REASON, "AI hỏng thật vẫn đi đường AI_DOWN như cũ");
    } finally {
      setSalesChatProviderForTests(null);
    }

    // ── D2. Hạn mức chặn ⇒ BLOCKED_QUOTA mang TRẦN nào chạm ──
    const pdb = await getPlatformDb();
    const o = schema.platformOrganizations;
    const [before] = await pdb.select({ settings: o.settings }).from(o).where(eq(o.code, A));
    await pdb.update(o).set({ settings: sql`jsonb_set(coalesce(${o.settings}, '{}'::jsonb), '{ai}', '{"limits":{"costUsdHard":0}}'::jsonb)` }).where(eq(o.code, A));
    invalidateAiControl();
    invalidateOrganizations();
    setSalesChatProviderForTests(() => scripted([() => [{ type: "text", text: "Dạ." }]]));
    try {
      const vk = visitorKeyOf(`ops-sig-han-muc-${Date.now()}`);
      const w = await openConversation("WEB", { visitorKey: vk });
      await chatTurn(w.id, "Shop ơi?", { channel: "WEB", visitorKey: vk });
      const blocked = (await aiRowsOf(w.id)).filter((x) => x.status === "BLOCKED_QUOTA");
      assert.ok(blocked.length === 1 && blocked[0].errorClass === "COST_HARD", `lý do hạn mức được giữ: ${JSON.stringify(blocked)}`);
    } finally {
      setSalesChatProviderForTests(null);
      await pdb.update(o).set({ settings: before?.settings ?? {} }).where(eq(o.code, A));
      invalidateAiControl();
      invalidateOrganizations();
    }
  });
  console.log("✓ Bot: lõi đơn ném ⇒ sổ AI vẫn OK, chuyển người lý do GHI ĐƠN, order.create_failed mang id hội thoại, câu gốc không lọt; đơn sai ⇒ order.validation_failed; AI hỏng ⇒ ERROR có lớp; hạn mức ⇒ BLOCKED_QUOTA có trần");
}

// ─────────────────────────── E. Gương sức khoẻ ───────────────────────────

function fakeGraph(mode: { subscribed: "NONE" | "OK" | "RATE" }, calls: string[]) {
  return (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/debug_token")) return json({ data: { is_valid: true, app_id: APP_ID } });
    if (u.pathname.endsWith(`/${PAGE}/subscribed_apps`)) {
      if (mode.subscribed === "RATE") return json({ error: { message: "Application request limit reached", code: 4 } }, 400);
      if (u.searchParams.get("fields")) return json({ data: mode.subscribed === "OK" ? [{ id: APP_ID, subscribed_fields: ["messages", "messaging_postbacks", "message_echoes", "feed"] }] : [] });
      return json({ success: true });
    }
    if (u.pathname.endsWith(`/${PAGE}`)) return json({ id: PAGE });
    if (u.pathname.endsWith("/me")) return json({ id: PAGE, name: "Shop Tín Hiệu" });
    return json({ error: { message: "không có", code: 100 } }, 400);
  }) as typeof fetch;
}

async function testMirror() {
  const pdb = await getPlatformDb();
  const h = schema.platformOrgHealth;
  const now = new Date();
  // Gửi hỏng 10 phút trước (dòng tin khách thật của CSDL tổ chức).
  await withOrganization(A, async () => {
    const db = await getDb();
    await db.insert(schema.salesChatInbound).values({ pageId: "pg-ops", threadId: "th-ops", messageId: `m-ops-${Date.now()}`, text: "alo", customerName: "Khách", status: "DONE", note: "lỗi gửi — Pancake không nhận tin: conversation_id not found", createdAt: new Date(now.getTime() - 10 * 60_000), processedAt: new Date(now.getTime() - 10 * 60_000) });
  });
  // Job THẬT (đường của bộ lập lịch) ⇒ bảy dòng gương.
  const job = (await runJob("sales-health", { trigger: "MANUAL", actor: "ops-signals-test", org: A })) as { run: { status: string }; result: { mirror: string } | null };
  assert.ok(job.run.status === "SUCCESS" || job.run.status === "PARTIAL", JSON.stringify(job.run));
  assert.ok(job.result?.mirror.startsWith("gương 7 kiểm"), `job ghi gương: ${job.result?.mirror}`);
  const rows = await pdb.select().from(h).where(eq(h.orgCode, A));
  assert.deepEqual(rows.map((r) => r.checkKey).sort(), [...ORG_HEALTH_CHECK_KEYS].sort(), "đúng bảy dòng, một dòng mỗi kiểm");
  const row = (k: string) => rows.find((r) => r.checkKey === k)!;
  assert.ok(row("SEND").level === "WARNING" && row("SEND").count24h === 1 && row("SEND").lastReason === "REJECTED" && row("SEND").measuredAt, JSON.stringify(row("SEND")));
  assert.ok(row("ORDER_WRITE").level === "CRITICAL" && (row("ORDER_WRITE").count24h ?? 0) >= 1 && row("ORDER_WRITE").measuredAt, "lượt đo đếm lại sổ đơn của bot");
  assert.ok(row("ORDER_VALIDATION").level === "WARNING" && (row("ORDER_VALIDATION").count24h ?? 0) >= 1);
  assert.equal(row("FB_CONNECTION").level, "NA", "chưa nối page nào ⇒ không áp dụng");
  for (const r of rows) assert.ok(!(r.detail ?? "").includes(SECRET_PHONE) && !(r.detail ?? "").includes("@"), `${r.checkKey}: detail không PII`);

  // Hết lỗi (cửa sổ trôi qua) ⇒ dòng VỀ OK, không bị xoá, «lần cuối» vẫn giữ.
  const later = new Date(now.getTime() + 9 * 86_400_000);
  await withOrganization(A, async () => {
    const r = await runSalesHealthCheck(later);
    const msg = await mirrorSalesOpsHealth({ health: r.health, snapshot: r.snapshot, now: later });
    assert.ok(msg.startsWith("gương 7 kiểm"), msg);
  });
  const after = await pdb.select().from(h).where(eq(h.orgCode, A));
  assert.equal(after.length, 7, "kiểm đã hết lỗi vẫn còn dòng (không xoá im)");
  const send = after.find((r) => r.checkKey === "SEND")!;
  const write = after.find((r) => r.checkKey === "ORDER_WRITE")!;
  assert.ok(send.level === "OK" && send.count24h === 0 && send.count7d === 0 && send.lastAt !== null, `gửi tin về OK, lần cuối còn: ${JSON.stringify(send)}`);
  assert.ok(write.level === "OK" && write.count24h === 0 && write.lastAt !== null && write.since.getTime() === later.getTime(), `ghi đơn về OK, mốc mức mới: ${JSON.stringify(write)}`);

  // Kiểm đăng ký webhook của page nối thẳng: Graph giả, có trần, nghỉ khi chạm trần.
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.FACEBOOK_LOGIN_APP_ID = APP_ID;
  process.env.FACEBOOK_LOGIN_APP_SECRET = APP_SECRET;
  delete process.env.FACEBOOK_MESSENGER_APP_ID;
  delete process.env.FACEBOOK_MESSENGER_APP_SECRET;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-tin-hieu-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await withOrganization(A, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: "Chủ", role: "ADMIN", permissions: ["settings:manage", "ai_sales:manage", "ai_sales:view"], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: A, name: A, isHome: false }, modules: [...(await getEnabledModules(A))] } as unknown as SessionUser;
      const mode: { subscribed: "NONE" | "OK" | "RATE" } = { subscribed: "OK" };
      const calls: string[] = [];
      const f = fakeGraph(mode, calls);
      const conn = await connectMessengerPage(admin, { id: PAGE, name: "Shop Tín Hiệu", token: PAGE_TOKEN, canMessage: true }, { fetch: f });
      assert.ok("ok" in conn, JSON.stringify(conn));
      mode.subscribed = "NONE";
      calls.length = 0;
      const t0 = new Date();
      const w1 = await runWebhookChecks([PAGE], t0, { fetchImpl: f });
      assert.ok(w1.states[PAGE] === "NOT_SUBSCRIBED" && w1.checkedNow === 1 && calls.length === 2, `một page = 2 lời gọi Graph: ${JSON.stringify(w1)} ${calls.join(",")}`);
      calls.length = 0;
      const w2 = await runWebhookChecks([PAGE], new Date(t0.getTime() + 60_000), { fetchImpl: f });
      assert.ok(w2.states[PAGE] === "NOT_SUBSCRIBED" && w2.checkedNow === 0 && calls.length === 0, "chưa tới nhịp ⇒ KHÔNG gọi Graph, giữ kết quả cũ");
      mode.subscribed = "RATE";
      const t3 = new Date(t0.getTime() + 7 * 3_600_000);
      const w3 = await runWebhookChecks([PAGE], t3, { fetchImpl: f });
      assert.ok(w3.skipped === "RATE_LIMITED" && w3.states[PAGE] === "NOT_SUBSCRIBED", `Graph chạm trần ⇒ dừng, giữ kết quả cũ: ${JSON.stringify(w3)}`);
      calls.length = 0;
      const w4 = await runWebhookChecks([PAGE], new Date(t3.getTime() + 60_000), { fetchImpl: f });
      assert.ok(w4.skipped === "RATE_PAUSED" && calls.length === 0, "đang nghỉ ⇒ không gọi Graph");
      // Gương: page chưa đăng ký webhook ⇒ WEBHOOK NGHIÊM TRỌNG, FB vẫn ổn (token còn hạn).
      const r = await runSalesHealthCheck(new Date());
      await setSettingJson(WEBHOOK_CHECK_SETTING_KEY, { pages: { [PAGE]: { at: new Date().toISOString(), state: "NOT_SUBSCRIBED" } }, pausedUntil: null });
      await mirrorSalesOpsHealth({ health: r.health, snapshot: r.snapshot, fetchImpl: f });
    });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  const final = await pdb.select().from(h).where(eq(h.orgCode, A));
  const wh = final.find((r) => r.checkKey === "WEBHOOK")!;
  const fb = final.find((r) => r.checkKey === "FB_CONNECTION")!;
  assert.ok(wh.level === "CRITICAL" && wh.lastReason === "NOT_SUBSCRIBED", JSON.stringify(wh));
  assert.ok(fb.level === "OK" && (fb.detail ?? "").includes("1/1 page đã kiểm"), JSON.stringify(fb));
  console.log("✓ Gương sức khoẻ: job sales-health ghi bảy dòng (gửi hỏng · ghi đơn · đơn sai), hết lỗi ⇒ về OK không xoá, kiểm webhook có trần lượt gọi + nghỉ khi Graph chạm trần");
}

// ─────────────────────────── F. Khung «Sự cố 24 giờ / 7 ngày» ───────────────────────────

async function testPanel() {
  const home = await getHomeOrganization();
  const operator: SessionUser = { id: "ops-op", email: "op@nha.local", name: "Vận hành", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: home.code, name: home.name, isHome: true } };
  const customerAdmin: SessionUser = { ...operator, id: "ops-kh", organization: { code: A, name: A, isHome: false } };
  const homeViewer: SessionUser = { ...operator, id: "ops-xem", role: "VIEWER", permissions: resolvePermissions("VIEWER", null) };
  for (const [who, u] of [["quản trị của khách", customerAdmin], ["người nhà không có platform:operate", homeViewer]] as const) {
    const one = await loadOrgOpsSignals(u, A);
    assert.ok(!one.ok && one.code === "FORBIDDEN", `${who} KHÔNG đọc được khung: ${JSON.stringify(one)}`);
    const many = await loadOpsSignalsForOrgs(u, [A, S]);
    assert.ok(!many.ok && many.code === "FORBIDDEN", `${who} KHÔNG gom được nhiều tổ chức`);
  }
  const r = await loadOrgOpsSignals(operator, A, { aiSalesEnabled: true });
  assert.ok(r.ok, JSON.stringify(r));
  const line = (k: string) => r.value.lines.find((l) => l.key === k)!;
  assert.deepEqual(r.value.lines.map((l) => l.key), [...OPS_SIGNAL_KEYS]);
  assert.ok(line("LOGIN").level === "WARNING" && (line("LOGIN").count24h ?? 0) >= 5 && line("LOGIN").measuredFrom !== null, JSON.stringify(line("LOGIN")));
  assert.ok(line("LOGIN").detail?.includes("***"), "định danh lần cuối hiện ở dạng che");
  assert.ok(line("AI").level !== "UNKNOWN" && (line("AI").count24h ?? 0) >= 1 && line("AI").correlationId, JSON.stringify(line("AI")));
  assert.ok(line("QUOTA").count24h !== null && (line("QUOTA").count24h ?? 0) >= 1 && line("QUOTA").lastReason === "COST_HARD", JSON.stringify(line("QUOTA")));
  assert.equal(line("WEBHOOK").level, "CRITICAL");
  // Gom nhiều tổ chức trong MỘT lượt: tổ chức chưa có gì ⇒ «chưa biết», không «0 lỗi».
  const many = await loadOpsSignalsForOrgs(operator, [A, S, GHOST]);
  assert.ok(many.ok && many.value.size === 3);
  const ghost = many.value.get(GHOST)!;
  for (const k of ["FB_CONNECTION", "WEBHOOK", "SEND", "ORDER_VALIDATION", "ORDER_WRITE", "AI", "QUOTA"]) {
    const l = ghost.lines.find((x) => x.key === k)!;
    assert.ok(l.level === "UNKNOWN" && l.count24h === null && l.count7d === null, `${k}: chưa có dữ liệu ⇒ CHƯA BIẾT: ${JSON.stringify(l)}`);
  }
  assert.equal(many.value.get(S)!.lines.find((l) => l.key === "LOGIN")!.lastReason, "ORG_INACTIVE");
  // Khung in «—» cho chỗ chưa biết, không bao giờ «0» thay cho nó.
  (globalThis as { React?: typeof React }).React ??= React;
  const html = renderToStaticMarkup(createElement(OpsSignalsPanel, { data: ghost }));
  assert.ok(html.includes('data-ops-signals="ops-sig-khong-co"') && (html.match(/>—</g) ?? []).length >= 7, "ô chưa biết in «—»");
  assert.ok(!html.includes(ADMIN), "khung không in email thô");
  console.log("✓ Khung sự cố: chỉ người vận hành nền tảng đọc được (khách / người nhà thiếu quyền bị từ chối); một lượt gom nhiều tổ chức; chưa có dữ liệu ⇒ «—», không «0 lỗi»");
}

// ─────────────────────────── dựng / dọn ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [A, S]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  const codes = [A, S, GHOST];
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, codes));
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, codes));
  await pdb.delete(schema.platformIdentities).where(inArray(schema.platformIdentities.orgCode, codes));
  await pdb.delete(schema.platformMessengerPages).where(inArray(schema.platformMessengerPages.orgCode, codes));
  await pdb.delete(schema.platformOrgHealth).where(inArray(schema.platformOrgHealth.orgCode, codes));
  const hashes = [ADMIN, LOCKED, UNKNOWN_EMAIL, `${UNKNOWN_EMAIL}.x`, S_ADMIN, `moi1@${A}.vn`, `moi2@${A}.vn`].map(authIdentifierHash);
  const t = schema.platformAuthFailures;
  await pdb.delete(t).where(or(inArray(t.orgCode, codes), inArray(t.identifierHash, hashes), and(sql`${t.orgCode} is null`, sql`${t.identifierHash} is null`, gte(t.at, startedAt))));
  invalidateOrganizations();
  invalidateCapabilities();
}

export async function testOpsSignals() {
  startedAt = new Date(Date.now() - 1_000);
  testPure();
  await cleanup();
  await provisionOrganization({ code: A, name: "Shop tín hiệu", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: ADMIN, name: "Chủ shop", password: PW }, source: "TEST", actor: null });
  await provisionOrganization({ code: S, name: "Shop đình chỉ", plan: "standard", modules: ["customers"], admin: { email: S_ADMIN, name: "Chủ", password: PW }, source: "TEST", actor: null });
  installRealStores();
  try {
    const variantId = await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.users).values({ email: LOCKED, name: "Nhân viên nghỉ", passwordHash: await hashPassword(LOCKED_PW), role: "VIEWER", active: false });
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, ADMIN) });
      assert.ok(u);
      const admin: SessionUser = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: resolvePermissions("ADMIN", null), scope: "ALL", departmentCodes: [], positionId: null, organization: { code: A, name: A, isHome: false }, modules: [...(await getEnabledModules(A))] };
      const p = await createProductCore(admin, { name: "Chả mực tín hiệu", code: "OPS-CHA-MUC", unit: "gói", retailPrice: 400_000, cost: null, variants: [{ sku: "OPS-CHA-MUC", size: "", color: "", retailPrice: 400_000, cost: null, selling: true }] });
      assert.ok(p.ok, JSON.stringify(p));
      const v = await db.query.productVariants.findFirst({ where: eq(schema.productVariants.productId, p.id) });
      assert.ok(v);
      await setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true, shippingFee: null });
      return v.id;
    });
    const pdb = await getPlatformDb();
    await pdb.update(schema.platformOrganizations).set({ status: "SUSPENDED" }).where(eq(schema.platformOrganizations.code, S));
    invalidateOrganizations();

    await testLoginReasons();
    await testThrottleNoAmplify();
    await testLinkReasons();
    await testNoRawPii();
    await testBotSignals(variantId);
    await testMirror();
    await testPanel();
  } finally {
    removeRealStores();
    setSalesChatProviderForTests(null);
    resetLoginThrottle();
    await cleanup();
  }
}

if (/ops-signals\.test\.ts$/.test(process.argv[1] ?? "")) testOpsSignals().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
