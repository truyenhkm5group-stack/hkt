import assert from "node:assert/strict";
import { diagnosePageDiscovery, discoveryLogLine, messengerConnectUrl, pagesFromCode, type RawPage } from "@/lib/integrations/messenger/graph";

/**
 * ═══════════ KHÁM PHÁ PAGE FACEBOOK — PHÂN BIỆT ĐÚNG VÌ SAO KHÔNG CÓ PAGE (sự cố 06/10/2026) ═══════════
 *
 * OAuth xong, ERP báo «không quản lý page nào có quyền nhắn tin» cho MỌI thất bại. Bài này khoá sáu ca phải tách:
 *   A. Meta trả 0 page                       ⇒ NO_PAGES
 *   B. Meta trả page nhưng thiếu quyền Nhắn tin ⇒ NO_MESSAGING_TASK
 *   C. ERP nhận page nhưng loại (không token)   ⇒ NO_PAGE_TOKEN
 *   D. quyền bắt buộc bị bỏ chọn               ⇒ PERMISSION_DECLINED
 *   E. quyền không hề được cấp (App Review / Development / Login for Business) ⇒ PERMISSION_NOT_GRANTED
 *   F. page chỉ thấy qua Business Portfolio     ⇒ tìm thêm qua /me/businesses (owned_pages / client_pages)
 * Không gọi mạng thật (luật 65): Graph giả tiêm vào.
 */

const APP = { appId: "1234567890", appSecret: "APP_SECRET_khong_bao_gio_lo" };
const ALL = ["pages_show_list", "pages_messaging", "pages_manage_metadata", "pages_read_engagement", "business_management"];
const granted = (xs: string[], declined: string[] = []) => [...xs.map((permission) => ({ permission, status: "granted" })), ...declined.map((permission) => ({ permission, status: "declined" }))];
const page = (id: string, over: Partial<RawPage> = {}): RawPage => ({ id, name: `Page ${id}`, hasToken: true, tasks: ["MESSAGING"], viaBusiness: false, ...over });

function testChanDoanThuan() {
  assert.equal(diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111")] }).reason, null, "đủ quyền + page có token + quyền Nhắn tin ⇒ không lỗi");
  const a = diagnosePageDiscovery({ permissions: granted(ALL), raw: [] });
  assert.equal(a.reason, "NO_PAGES", "A");
  const b = diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111", { tasks: ["ANALYZE", "ADVERTISE"] })] });
  assert.equal(b.reason, "NO_MESSAGING_TASK", "B");
  assert.deepEqual(b.withoutMessaging, [{ name: "Page 11111", tasks: ["ANALYZE", "ADVERTISE"] }], "B: nói page nào, đang có quyền gì");
  const c = diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111", { hasToken: false }), page("22222", { hasToken: false, viaBusiness: true })] });
  assert.equal(c.reason, "NO_PAGE_TOKEN", "C");
  assert.equal(c.viaBusiness, 1);
  const d = diagnosePageDiscovery({ permissions: granted(["pages_show_list", "pages_manage_metadata"], ["pages_messaging"]), raw: [page("11111")] });
  assert.equal(d.reason, "PERMISSION_DECLINED", "D: quyền đi TRƯỚC page — page hiện đủ mà thiếu pages_messaging thì gửi tin vẫn hỏng");
  assert.deepEqual(d.missing, ["pages_messaging"]);
  const e = diagnosePageDiscovery({ permissions: granted(["public_profile", "email"]), raw: [] });
  assert.equal(e.reason, "PERMISSION_NOT_GRANTED", "E: hộp thoại không hề hỏi quyền page (chỉ có public_profile, email)");
  assert.deepEqual(e.missing, ["pages_show_list", "pages_messaging", "pages_manage_metadata"]);
  assert.equal(diagnosePageDiscovery({ permissions: null, raw: [] }).reason, "NO_PAGES", "không đọc được quyền ⇒ không đoán thiếu quyền");
  const dup = diagnosePageDiscovery({ permissions: granted(ALL), raw: [page("11111", { hasToken: false }), page("11111", { viaBusiness: true })] });
  assert.ok(dup.reason === null && dup.accountsSeen === 1, "cùng page thấy hai đường ⇒ một page, giữ bản có token");
  const line = discoveryLogLine("hslc-hmt-shop", c);
  assert.match(line, /reason=NO_PAGE_TOKEN .*accounts=2 viaBusiness=1 noToken=2/);
  assert.ok(!/Page 11111/.test(line), "dòng log không mang tên page");
}

type Scene = { permissions?: unknown; accounts?: Record<string, unknown>[]; businesses?: Record<string, unknown>[]; owned?: Record<string, unknown>[] };
function fakeGraph(s: Scene) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const u = new URL(url);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u.pathname.endsWith("/oauth/access_token")) return json({ access_token: "USER_TOKEN_bi_mat_123456" });
    if (u.pathname.endsWith("/me/permissions")) return s.permissions === undefined ? json({ error: { message: "x", code: 100 } }, 400) : json({ data: s.permissions });
    if (u.pathname.endsWith("/me/accounts")) return json({ data: s.accounts ?? [] });
    if (u.pathname.endsWith("/me/businesses")) return json({ data: s.businesses ?? [] });
    if (u.pathname.endsWith("/owned_pages")) return json({ data: s.owned ?? [] });
    if (u.pathname.endsWith("/client_pages")) return json({ data: [] });
    return json({ error: { message: "không có", code: 100 } }, 400);
  }) as typeof fetch;
  return { fetch: f, calls };
}

async function testKhamPhaThat() {
  const REDIRECT = "https://erp.test/api/connect/messenger/callback";
  // E: chỉ public_profile được cấp — đúng triệu chứng «Bạn từng đăng nhập… Tiếp tục?» không hỏi quyền page.
  const e = fakeGraph({ permissions: granted(["public_profile", "email"]), accounts: [] });
  const re = await pagesFromCode(APP, "CODE", REDIRECT, e.fetch);
  assert.ok("pages" in re && re.pages.length === 0 && re.diagnostic.reason === "PERMISSION_NOT_GRANTED", JSON.stringify(re));
  assert.ok(!e.calls.some((c) => c.includes("/me/businesses")), "không có business_management ⇒ không hỏi Business Portfolio");

  // F: /me/accounts rỗng, page nằm ở Business Portfolio (có token) ⇒ vẫn nối được.
  const f = fakeGraph({ permissions: granted(ALL), accounts: [], businesses: [{ id: "99999999" }], owned: [{ id: "55555555", name: "HSLC", access_token: "PAGE_TOKEN_biz_123456", tasks: ["MANAGE", "MESSAGING"] }] });
  const rf = await pagesFromCode(APP, "CODE", REDIRECT, f.fetch);
  assert.ok("pages" in rf && rf.pages.length === 1 && rf.pages[0].canMessage && rf.diagnostic.viaBusiness === 1 && rf.diagnostic.reason === null, JSON.stringify("pages" in rf ? rf.diagnostic : rf));
  assert.ok(f.calls.some((c) => c.includes("/99999999/owned_pages")) && f.calls.every((c) => !c.includes("/me/businesses") || c.includes("appsecret_proof=")), "hỏi owned_pages của doanh nghiệp, kèm appsecret_proof");

  // C: page về mà không token ⇒ không nối, lý do rõ.
  const c = fakeGraph({ permissions: granted(ALL), accounts: [{ id: "66666666", name: "Page chưa tích", tasks: ["MESSAGING"] }] });
  const rc = await pagesFromCode(APP, "CODE", REDIRECT, c.fetch);
  assert.ok("pages" in rc && rc.pages.length === 0 && rc.diagnostic.reason === "NO_PAGE_TOKEN" && rc.diagnostic.withoutToken[0] === "Page chưa tích");

  // Quyền không đọc được (Meta lỗi) ⇒ vẫn khám phá page như cũ, không đoán thiếu quyền.
  const u = fakeGraph({ accounts: [{ id: "77777777", name: "Shop", access_token: "PAGE_TOKEN_ok_1234567", tasks: ["MESSAGING"] }] });
  const ru = await pagesFromCode(APP, "CODE", REDIRECT, u.fetch);
  assert.ok("pages" in ru && ru.pages.length === 1 && ru.diagnostic.granted === null && ru.diagnostic.reason === null);

  for (const r of [re, rf, rc, ru]) {
    const s = JSON.stringify("pages" in r ? r.diagnostic : r);
    assert.ok(!s.includes("TOKEN_") && !s.includes(APP.appSecret), "chẩn đoán không mang token / app secret");
  }
}

function testHopThoai() {
  const url = new URL(messengerConnectUrl(APP, "https://erp.test/api/connect/messenger/callback", "STATE"));
  assert.equal(url.searchParams.get("auth_type"), "rerequest", "hộp thoại hỏi LẠI quyền từng bị bỏ chọn — không chỉ «Tiếp tục?»");
  for (const p of ["pages_show_list", "pages_messaging", "pages_manage_metadata"]) assert.ok((url.searchParams.get("scope") ?? "").split(",").includes(p), `xin ${p}`);
}

export async function testMessengerDiscovery() {
  testChanDoanThuan();
  await testKhamPhaThat();
  testHopThoai();
  console.log("✓ Khám phá page Facebook: tách 6 ca (0 page · thiếu quyền Nhắn tin · không token · bỏ chọn quyền · quyền không được cấp · qua Business Portfolio) · hỏi lại quyền · không token trong vết");
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
