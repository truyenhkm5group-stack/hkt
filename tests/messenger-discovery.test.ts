import assert from "node:assert/strict";
import {
  DISCOVERY_REASONS,
  MESSENGER_FIELDS,
  MESSENGER_REQUIRED_PERMISSIONS,
  WEBHOOK_STATES,
  appRoleOf,
  checkPageWebhook,
  diagnosePageDiscovery,
  discoveryLogLine,
  inspectToken,
  isPermissionReason,
  messengerConnectUrl,
  pagesFromCode,
  type RawPage,
} from "@/lib/integrations/messenger/graph";
import { DISCOVERY_GUIDE, PERMISSION_INFO, WEBHOOK_GUIDE, permissionTable, webhookRow } from "@/lib/integrations/messenger/permission-guide";

/**
 * ═══════════ KHÁM PHÁ PAGE FACEBOOK — PHÂN BIỆT ĐÚNG VÌ SAO KHÔNG NỐI ĐƯỢC (sự cố 06/10/2026) ═══════════
 *
 * Production: `reason=PERMISSION_NOT_GRANTED granted=public_profile … accounts=0` — câu «không quản lý page nào» sai, và
 * «thiếu quyền» chưa đủ: chủ page sửa được việc BỎ CHỌN, còn «quyền chưa thêm vào app» / «cần App Review» là việc của chủ
 * nền tảng ở App Dashboard. Bài này khoá bảy lý do:
 *   1. bỏ chọn quyền                         ⇒ PERMISSION_DECLINED
 *   2. có vai trò trong app mà vẫn không cấp  ⇒ PERMISSION_NOT_IN_APP (quyền chưa thêm vào app)
 *   3. không vai trò, không cấp               ⇒ PERMISSION_NEEDS_APP_REVIEW (Advanced Access)
 *      (gọi roles lỗi                         ⇒ PERMISSION_NOT_GRANTED — không đoán)
 *   4. không quyền quản trị / Nhắn tin page   ⇒ NO_MESSAGING_TASK
 *   5. đủ quyền, 0 page                       ⇒ NO_PAGES
 *   6. webhook chưa đăng ký / thiếu trường    ⇒ checkPageWebhook NOT_SUBSCRIBED / MISSING_FIELDS
 *   7. token hết hạn / không hợp lệ          ⇒ TOKEN_EXPIRED (debug_token)
 * Cộng: phân trang > 100 page, không token / app secret nào lọt vào log hay chẩn đoán. Không gọi mạng thật (luật 65); mốc
 * thời gian dựng từ đồng hồ thật (luật 50), không ghim ngày.
 */

const APP = { appId: "1234567890", appSecret: "APP_SECRET_khong_bao_gio_lo" };
const USER_TOKEN = "USER_TOKEN_bi_mat_123456";
const ALL = ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement", "business_management"];
const granted = (xs: string[], declined: string[] = []) => [...xs.map((permission) => ({ permission, status: "granted" })), ...declined.map((permission) => ({ permission, status: "declined" }))];
const page = (id: string, over: Partial<RawPage> = {}): RawPage => ({ id, name: `Page ${id}`, hasToken: true, tasks: ["MESSAGING"], viaBusiness: false, ...over });
const SECRETS = [USER_TOKEN, APP.appSecret, "PAGE_TOKEN_", "USER_TOKEN_"];
const clean = (label: string, v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  for (const x of SECRETS) assert.ok(!s.includes(x), `${label}: lộ «${x}» trong ${s.slice(0, 200)}`);
};

function testChanDoanThuan() {
  assert.ok((MESSENGER_REQUIRED_PERMISSIONS as readonly string[]).includes("pages_read_engagement"), "pages_read_engagement là quyền bắt buộc");
  assert.equal(diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111")] }).reason, null, "đủ quyền + page có token + quyền Nhắn tin ⇒ không lỗi");
  assert.equal(diagnosePageDiscovery({ permissions: granted(ALL), raw: [] }).reason, "NO_PAGES", "5");
  const b = diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111", { tasks: ["ANALYZE", "ADVERTISE"] })] });
  assert.equal(b.reason, "NO_MESSAGING_TASK", "4");
  assert.deepEqual(b.withoutMessaging, [{ name: "Page 11111", tasks: ["ANALYZE", "ADVERTISE"] }], "4: nói page nào, đang có quyền gì");
  const c = diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111", { hasToken: false }), page("22222", { hasToken: false, viaBusiness: true })] });
  assert.equal(c.reason, "NO_PAGE_TOKEN");
  assert.equal(c.viaBusiness, 1);
  const d = diagnosePageDiscovery({ permissions: granted(["pages_show_list", "pages_manage_metadata", "pages_read_engagement"], ["pages_messaging"]), raw: [page("11111")] });
  assert.equal(d.reason, "PERMISSION_DECLINED", "1: quyền đi TRƯỚC page — page hiện đủ mà thiếu pages_messaging thì gửi tin vẫn hỏng");
  assert.deepEqual(d.missing, ["pages_messaging"]);
  // Đúng triệu chứng production: chỉ public_profile.
  const prod = granted(["public_profile"]);
  assert.equal(diagnosePageDiscovery({ permissions: prod, raw: [] }).reason, "PERMISSION_NOT_GRANTED", "không biết vai trò ⇒ giữ lý do cũ, không đoán");
  assert.equal(diagnosePageDiscovery({ permissions: prod, raw: [], appRole: { state: "HAS_ROLE", role: "testers" } }).reason, "PERMISSION_NOT_IN_APP", "2");
  assert.equal(diagnosePageDiscovery({ permissions: prod, raw: [], appRole: { state: "NO_ROLE", role: null } }).reason, "PERMISSION_NEEDS_APP_REVIEW", "3");
  assert.equal(diagnosePageDiscovery({ permissions: prod, raw: [], appRole: { state: "UNKNOWN", why: "lỗi" } }).reason, "PERMISSION_NOT_GRANTED", "3: roles lỗi ⇒ không kết luận");
  assert.deepEqual(diagnosePageDiscovery({ permissions: prod, raw: [] }).missing, [...MESSENGER_REQUIRED_PERMISSIONS]);
  // Thiếu riêng pages_read_engagement cũng chặn.
  assert.equal(diagnosePageDiscovery({ permissions: granted(["pages_show_list", "pages_messaging", "pages_manage_metadata"]), raw: [page("11111")] }).reason, "PERMISSION_NOT_GRANTED");
  // Bỏ chọn thắng «chưa thêm vào app» — chủ page sửa được ngay.
  assert.equal(diagnosePageDiscovery({ permissions: granted(["public_profile"], ["pages_messaging"]), raw: [], appRole: { state: "HAS_ROLE", role: "administrators" } }).reason, "PERMISSION_DECLINED");
  // Token hết hạn đứng đầu.
  assert.equal(diagnosePageDiscovery({ permissions: null, raw: [], userToken: { state: "EXPIRED", expiresAt: null, why: "x" } }).reason, "TOKEN_EXPIRED", "7");
  assert.equal(diagnosePageDiscovery({ permissions: null, raw: [] }).reason, "NO_PAGES", "không đọc được quyền ⇒ không đoán thiếu quyền");
  const dup = diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111", { hasToken: false }), page("11111", { viaBusiness: true })] });
  assert.ok(dup.reason === null && dup.accountsSeen === 1, "cùng page thấy hai đường ⇒ một page, giữ bản có token");
  for (const r of DISCOVERY_REASONS) assert.equal(isPermissionReason(r), r === "TOKEN_EXPIRED" || r.startsWith("PERMISSION_"), r);
  const line = discoveryLogLine("hslc-hmt-shop", diagnosePageDiscovery({ permissions: prod, raw: [], appRole: { state: "NO_ROLE", role: "insights users" } }));
  assert.match(line, /reason=PERMISSION_NEEDS_APP_REVIEW granted=public_profile declined=- missing=pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement appRole=none:insights_users userToken=- accounts=0/);
  assert.ok(!/Page 11111/.test(discoveryLogLine("x", c)), "dòng log không mang tên page");
}

function testHuongXuLy() {
  for (const r of DISCOVERY_REASONS) {
    const g = DISCOVERY_GUIDE[r];
    assert.ok(g && g.title && g.steps.length > 0, `lý do ${r} phải có hướng xử lý`);
    assert.ok(!/không quản lý page nào/i.test(g.title + g.steps.join(" ")), `${r}: không câu chung chung`);
  }
  assert.equal(DISCOVERY_GUIDE.PERMISSION_NOT_IN_APP.actor, "PLATFORM_OWNER");
  assert.equal(DISCOVERY_GUIDE.PERMISSION_NEEDS_APP_REVIEW.actor, "PLATFORM_OWNER");
  assert.equal(DISCOVERY_GUIDE.PERMISSION_DECLINED.actor, "PAGE_OWNER");
  assert.ok(DISCOVERY_GUIDE.PERMISSION_NOT_IN_APP.steps.join(" ").includes("Engage with customers on Messenger from Meta"));
  for (const s of WEBHOOK_STATES) if (s !== "OK") assert.ok(WEBHOOK_GUIDE[s].steps.length > 0, `webhook ${s} phải có hướng xử lý`);
  for (const p of MESSENGER_REQUIRED_PERMISSIONS) assert.ok(PERMISSION_INFO[p], `${p} phải nói vì sao cần`);
  const t = permissionTable({ granted: ["pages_show_list"], declined: ["pages_messaging"] }, MESSENGER_REQUIRED_PERMISSIONS);
  assert.deepEqual(t.map((x) => x.status), ["GRANTED", "DECLINED", "MISSING", "MISSING"]);
  assert.ok(permissionTable({ granted: null, declined: [] }, MESSENGER_REQUIRED_PERMISSIONS).every((x) => x.status === "UNKNOWN"), "không đọc được quyền ⇒ UNKNOWN, không phải «thiếu»");
}

type Scene = {
  permissions?: unknown;
  accounts?: Record<string, unknown>[];
  /** Tổng số page để chia trang 100/lượt (thay `accounts`). */
  accountTotal?: number;
  businesses?: Record<string, unknown>[];
  owned?: Record<string, unknown>[];
  meId?: string | null;
  roles?: { user: string; role: string }[] | "error";
  debug?: Record<string, Record<string, unknown>> | "error";
  subscribed?: Record<string, Record<string, unknown>[] | { code: number }>;
};
function fakeGraph(s: Scene) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    const tok = u.searchParams.get("access_token") ?? "";
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    // Lỗi giả CỐ Ý nhắc lại token trong câu — để kiểm `scrub` thật sự che.
    const fail = (code = 100) => json({ error: { message: `lỗi giả, token=${tok}`, code } }, 400);
    if (u.pathname.endsWith("/oauth/access_token")) return json({ access_token: USER_TOKEN });
    if (u.pathname.endsWith("/me/permissions")) return s.permissions === undefined ? fail(190) : json({ data: s.permissions });
    if (u.pathname.endsWith("/me/accounts")) {
      if (s.accountTotal) {
        const from = Number(u.searchParams.get("after")?.replace("C", "") ?? 0);
        const to = Math.min(s.accountTotal, from + 100);
        const data = Array.from({ length: to - from }, (_, k) => ({ id: String(500000 + from + k), name: `P${from + k}`, access_token: `PAGE_TOKEN_${from + k}xx`, tasks: ["MESSAGING"] }));
        return json({ data, paging: to < s.accountTotal ? { cursors: { after: `C${to}` }, next: `https://graph.facebook.com/next?access_token=${tok}` } : { cursors: { after: `C${to}` } } });
      }
      return json({ data: s.accounts ?? [] });
    }
    if (u.pathname.endsWith("/me/businesses")) return json({ data: s.businesses ?? [] });
    if (u.pathname.endsWith("/owned_pages")) return json({ data: s.owned ?? [] });
    if (u.pathname.endsWith("/client_pages")) return json({ data: [] });
    if (u.pathname.endsWith("/me") && u.searchParams.get("fields") === "id") return s.meId ? json({ id: s.meId }) : fail();
    if (u.pathname.endsWith(`/${APP.appId}/roles`)) return !s.roles || s.roles === "error" ? fail(200) : json({ data: s.roles.map((r) => ({ app_id: APP.appId, ...r })) });
    if (u.pathname.endsWith("/debug_token")) {
      if (!s.debug || s.debug === "error") return fail();
      const d = s.debug[u.searchParams.get("input_token") ?? ""];
      return d ? json({ data: d }) : fail();
    }
    const m = /\/(\d+)\/subscribed_apps$/.exec(u.pathname);
    if (m && s.subscribed?.[m[1]]) {
      const v = s.subscribed[m[1]];
      return Array.isArray(v) ? json({ data: v }) : fail(v.code);
    }
    return fail();
  }) as typeof fetch;
  return { fetch: f, calls };
}

const REDIRECT = "https://erp.test/api/connect/messenger/callback";
const nowSec = () => Math.floor(Date.now() / 1000);

async function testKhamPhaThat() {
  const results: unknown[] = [];
  // 2 vs 3: đúng triệu chứng production (chỉ public_profile), khác nhau ở VAI TRÒ của người bấm.
  const roleYes = fakeGraph({ permissions: granted(["public_profile"]), accounts: [], meId: "777001", roles: [{ user: "777001", role: "testers" }, { user: "777002", role: "administrators" }] });
  const r2 = await pagesFromCode(APP, "CODE", REDIRECT, roleYes.fetch);
  assert.ok("pages" in r2 && r2.diagnostic.reason === "PERMISSION_NOT_IN_APP" && r2.diagnostic.appRole?.state === "HAS_ROLE", JSON.stringify(r2));
  const rolesCall = roleYes.calls.find((c) => c.includes(`/${APP.appId}/roles`));
  assert.ok(rolesCall && new URL(rolesCall).searchParams.get("appsecret_proof"), "hỏi roles bằng app token kèm appsecret_proof");
  assert.match(discoveryLogLine("hslc-hmt-shop", r2.diagnostic), /appRole=has:testers/);
  assert.ok(!discoveryLogLine("hslc-hmt-shop", r2.diagnostic).includes("777001"), "log không mang mã người dùng");
  results.push(r2);

  const roleNo = fakeGraph({ permissions: granted(["public_profile"]), accounts: [], meId: "777009", roles: [{ user: "777001", role: "testers" }] });
  const r3 = await pagesFromCode(APP, "CODE", REDIRECT, roleNo.fetch);
  assert.ok("pages" in r3 && r3.diagnostic.reason === "PERMISSION_NEEDS_APP_REVIEW" && r3.diagnostic.appRole?.state === "NO_ROLE", JSON.stringify(r3));
  results.push(r3);

  const insights = fakeGraph({ permissions: granted(["public_profile"]), accounts: [], meId: "777003", roles: [{ user: "777003", role: "insights users" }] });
  const r3b = await pagesFromCode(APP, "CODE", REDIRECT, insights.fetch);
  assert.ok("pages" in r3b && r3b.diagnostic.reason === "PERMISSION_NEEDS_APP_REVIEW", "vai trò «insights users» không đủ Standard Access");

  const roleErr = fakeGraph({ permissions: granted(["public_profile"]), accounts: [], meId: "777001", roles: "error" });
  const r3c = await pagesFromCode(APP, "CODE", REDIRECT, roleErr.fetch);
  assert.ok("pages" in r3c && r3c.diagnostic.reason === "PERMISSION_NOT_GRANTED" && r3c.diagnostic.appRole?.state === "UNKNOWN", "roles lỗi ⇒ không kết luận");
  results.push(r3c);

  // Luồng bình thường không tốn lời gọi roles / debug_token.
  const ok = fakeGraph({ permissions: granted(ALL), accounts: [{ id: "77777777", name: "Shop", access_token: "PAGE_TOKEN_ok_1234567", tasks: ["MESSAGING"] }] });
  const rok = await pagesFromCode(APP, "CODE", REDIRECT, ok.fetch);
  assert.ok("pages" in rok && rok.pages.length === 1 && rok.diagnostic.reason === null);
  assert.ok(!ok.calls.some((c) => c.includes("/roles") || c.includes("/debug_token")), "đủ quyền ⇒ không hỏi vai trò / token");

  // 1: bỏ chọn ⇒ không hỏi vai trò (chủ page tự sửa được).
  const dec = fakeGraph({ permissions: granted(["pages_show_list", "pages_manage_metadata", "pages_read_engagement"], ["pages_messaging"]), accounts: [] });
  const r1 = await pagesFromCode(APP, "CODE", REDIRECT, dec.fetch);
  assert.ok("pages" in r1 && r1.diagnostic.reason === "PERMISSION_DECLINED" && !dec.calls.some((c) => c.includes("/roles")));
  results.push(r1);

  // 4: page có token nhưng tài khoản không có quyền Nhắn tin.
  const nm = fakeGraph({ permissions: granted(ALL), accounts: [{ id: "66666666", name: "Page chỉ quảng cáo", access_token: "PAGE_TOKEN_ads_123456", tasks: ["ADVERTISE", "ANALYZE"] }] });
  const r4 = await pagesFromCode(APP, "CODE", REDIRECT, nm.fetch);
  assert.ok("pages" in r4 && r4.diagnostic.reason === "NO_MESSAGING_TASK" && r4.pages.every((p) => !p.canMessage));
  results.push(r4);

  // 5: đủ quyền, 0 page.
  const np = fakeGraph({ permissions: granted(ALL), accounts: [] });
  const r5 = await pagesFromCode(APP, "CODE", REDIRECT, np.fetch);
  assert.ok("pages" in r5 && r5.diagnostic.reason === "NO_PAGES");
  results.push(r5);

  // 7 (token người dùng): /me/permissions lỗi 190, debug_token nói is_valid=false ⇒ TOKEN_EXPIRED, không đi tiếp /me/accounts.
  const exp = fakeGraph({ debug: { [USER_TOKEN]: { is_valid: false, app_id: APP.appId, error: { message: `Session expired for ${USER_TOKEN}` } } } });
  const r7 = await pagesFromCode(APP, "CODE", REDIRECT, exp.fetch);
  assert.ok("pages" in r7 && r7.diagnostic.reason === "TOKEN_EXPIRED" && r7.diagnostic.userToken?.state === "EXPIRED", JSON.stringify(r7));
  assert.ok(!exp.calls.some((c) => c.includes("/me/accounts")), "token hết hạn ⇒ dừng");
  results.push(r7);

  // Quyền không đọc được + debug_token cũng lỗi ⇒ vẫn khám phá page như cũ, không đoán.
  const u = fakeGraph({ accounts: [{ id: "77777777", name: "Shop", access_token: "PAGE_TOKEN_ok_1234567", tasks: ["MESSAGING"] }] });
  const ru = await pagesFromCode(APP, "CODE", REDIRECT, u.fetch);
  assert.ok("pages" in ru && ru.pages.length === 1 && ru.diagnostic.granted === null && ru.diagnostic.reason === null && ru.diagnostic.userToken?.state === "UNKNOWN");
  results.push(ru);

  // Business Portfolio (page chỉ thấy qua doanh nghiệp) vẫn nối được.
  const f = fakeGraph({ permissions: granted(ALL), accounts: [], businesses: [{ id: "99999999" }], owned: [{ id: "55555555", name: "HSLC", access_token: "PAGE_TOKEN_biz_123456", tasks: ["MANAGE", "MESSAGING"] }] });
  const rf = await pagesFromCode(APP, "CODE", REDIRECT, f.fetch);
  assert.ok("pages" in rf && rf.pages.length === 1 && rf.diagnostic.viaBusiness === 1 && rf.diagnostic.reason === null);

  // Phân trang: 230 page qua 3 lượt bằng con trỏ của ta (không theo URL `next` chứa token).
  const many = fakeGraph({ permissions: granted(ALL), accountTotal: 230 });
  const rm = await pagesFromCode(APP, "CODE", REDIRECT, many.fetch);
  const accCalls = many.calls.filter((c) => c.includes("/me/accounts"));
  assert.ok("pages" in rm && rm.pages.length === 230 && rm.diagnostic.eligible === 230 && accCalls.length === 3, `phân trang: ${"pages" in rm ? rm.pages.length : "lỗi"} page, ${accCalls.length} lượt`);
  assert.ok(accCalls.every((c) => !c.includes("graph.facebook.com/next")), "không theo URL next");

  for (const r of results) {
    if (r && typeof r === "object" && "diagnostic" in r) {
      const diag = (r as { diagnostic: Parameters<typeof discoveryLogLine>[1] }).diagnostic;
      clean("chẩn đoán", diag);
      clean("log", discoveryLogLine("org", diag));
    } else clean("lỗi", r);
  }
}

async function testTokenVaVaiTro() {
  const T = "PAGE_TOKEN_check_123456";
  const g = (debug: Scene["debug"]) => fakeGraph({ debug });
  assert.equal((await inspectToken(APP, T, g({ [T]: { is_valid: true, app_id: APP.appId, expires_at: 0 } }).fetch)).state, "VALID", "expires_at = 0 ⇒ không hết hạn");
  assert.equal((await inspectToken(APP, T, g({ [T]: { is_valid: true, app_id: APP.appId, expires_at: nowSec() + 86400 } }).fetch)).state, "VALID");
  const past = await inspectToken(APP, T, g({ [T]: { is_valid: true, app_id: APP.appId, expires_at: nowSec() - 3600 } }).fetch);
  assert.ok(past.state === "EXPIRED" && past.expiresAt, "7: expires_at đã qua ⇒ EXPIRED");
  assert.equal((await inspectToken(APP, T, g({ [T]: { is_valid: false } }).fetch)).state, "EXPIRED", "7: is_valid=false");
  assert.equal((await inspectToken(APP, T, g({ [T]: { is_valid: true, app_id: "999999999" } }).fetch)).state, "EXPIRED", "token của app khác");
  const unk = await inspectToken(APP, T, g("error").fetch);
  assert.equal(unk.state, "UNKNOWN", "debug_token lỗi ⇒ không kết luận");
  clean("why", unk);
  const call = g({ [T]: { is_valid: true } });
  await inspectToken(APP, T, call.fetch);
  const q = new URL(call.calls[0]).searchParams;
  assert.ok(q.get("appsecret_proof") && q.get("access_token") === `${APP.appId}|${APP.appSecret}`, "debug_token hỏi bằng app token + appsecret_proof");

  assert.equal((await appRoleOf(APP, USER_TOKEN, fakeGraph({ meId: "1", roles: [{ user: "1", role: "developers" }] }).fetch)).state, "HAS_ROLE");
  assert.equal((await appRoleOf(APP, USER_TOKEN, fakeGraph({ meId: null, roles: [] }).fetch)).state, "UNKNOWN", "/me lỗi ⇒ không kết luận");
}

async function testWebhook() {
  const P = "88888888";
  const T = "PAGE_TOKEN_wh_123456";
  const valid = { [T]: { is_valid: true, app_id: APP.appId, expires_at: 0 } };
  const ok = await checkPageWebhook(APP, P, T, fakeGraph({ debug: valid, subscribed: { [P]: [{ id: APP.appId, name: "ERP", subscribed_fields: [...MESSENGER_FIELDS] }] } }).fetch);
  assert.equal(ok.state, "OK");
  const notSub = await checkPageWebhook(APP, P, T, fakeGraph({ debug: valid, subscribed: { [P]: [{ id: "4444444444", name: "Pancake", subscribed_fields: ["messages"] }] } }).fetch);
  assert.ok(notSub.state === "NOT_SUBSCRIBED" && /1 app khác/.test(notSub.detail ?? ""), "6: app khác có, app của ta không");
  const missing = await checkPageWebhook(APP, P, T, fakeGraph({ debug: valid, subscribed: { [P]: [{ id: APP.appId, subscribed_fields: ["messages", "message_echoes"] }] } }).fetch);
  assert.ok(missing.state === "MISSING_FIELDS" && missing.missingFields.join(",") === "messaging_postbacks,feed", JSON.stringify(missing));
  const expired = await checkPageWebhook(APP, P, T, fakeGraph({ debug: { [T]: { is_valid: true, app_id: APP.appId, expires_at: nowSec() - 60 } } }).fetch);
  assert.equal(expired.state, "TOKEN_EXPIRED", "7: token page quá hạn");
  const by190 = await checkPageWebhook(APP, P, T, fakeGraph({ debug: "error", subscribed: { [P]: { code: 190 } } }).fetch);
  assert.equal(by190.state, "TOKEN_EXPIRED", "Meta trả mã 190 ⇒ token hỏng");
  const unknown = await checkPageWebhook(APP, P, T, fakeGraph({ debug: "error", subscribed: { [P]: { code: 1 } } }).fetch);
  assert.equal(unknown.state, "UNKNOWN", "lỗi khác ⇒ không kết luận");
  const getOnly = fakeGraph({ debug: valid, subscribed: { [P]: [] } });
  await checkPageWebhook(APP, P, T, getOnly.fetch);
  assert.ok(getOnly.calls.every((c) => !c.includes("subscribed_fields=")), "chỉ ĐỌC — không gửi subscribed_fields (không đăng ký lại)");
  for (const c of [ok, notSub, missing, expired, by190, unknown]) {
    clean("webhook", c);
    clean("webhook row", webhookRow(c, "Shop"));
  }
  assert.equal(webhookRow(ok, "Shop").guide, null);
  assert.ok(webhookRow(missing, "Shop").label.includes("feed"));
}

function testHopThoai() {
  const url = new URL(messengerConnectUrl(APP, REDIRECT, "STATE"));
  assert.equal(url.searchParams.get("auth_type"), "rerequest", "hộp thoại hỏi LẠI quyền từng bị bỏ chọn — không chỉ «Tiếp tục?»");
  for (const p of MESSENGER_REQUIRED_PERMISSIONS) assert.ok((url.searchParams.get("scope") ?? "").split(",").includes(p), `xin ${p}`);
}

export async function testMessengerDiscovery() {
  testChanDoanThuan();
  testHuongXuLy();
  await testKhamPhaThat();
  await testTokenVaVaiTro();
  await testWebhook();
  testHopThoai();
  console.log("✓ Khám phá page Facebook: 7 lý do (bỏ chọn · quyền chưa thêm vào app · cần App Review · không quyền Nhắn tin · 0 page · webhook chưa đăng ký · token hết hạn) · vai trò tách bằng /roles · phân trang 230 page · không token trong vết");
}

if (/messenger-discovery\.test\.ts$/.test(process.argv[1] ?? "")) {
  testMessengerDiscovery().then(
    () => console.log("ĐẠT"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
