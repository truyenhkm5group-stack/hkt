/**
 * ═══════════ ẢNH ĐẠI DIỆN KHÁCH QUA PROXY ERP (chủ shop 11/10/2026, ưu tiên 2 sau P0 hộp thư) ═══════════
 *
 * Đo HSLC: ~0/300 hội thoại có ảnh — webhook Pancake không có trường ảnh, danh sách hội thoại của API Pancake có nhưng URL mang
 * `page_access_token`. Bài kiểm khoá:
 *  1. THUẦN: `stripAvatarToken` bỏ MỌI tham số khoá (không chỉ `access_token`), không cất URL còn dấu khoá ở chỗ khác; ref chỉ nhận
 *     host trong `AVATAR_PROXY_HOSTS` (host giả dạng `pages.fm.evil.vn` bị chặn); ref đọc lại từ `state` được kiểm lại từ đầu;
 *     token chỉ gắn vào host PANCAKE, đúng page; chẩn đoán «có ảnh» = đúng thứ hộp thư hiện.
 *  2. TẢI ẢNH (fetch GIẢ — không gọi mạng thật, AGENTS 65): host lạ không gọi; chuyển hướng sang host lạ dừng; bước chuyển hướng KHÔNG
 *     mang token; không phải ảnh raster (HTML · SVG) bị chặn; quá cỡ (khai báo hoặc dòng byte) bị chặn; `redirect: "manual"`.
 *  3. LÕI ROUTE trên CSDL tổ chức THẬT `anh-dai-dien-proxy` (tự cấp, tự dọn): thiếu quyền ⇒ 403; mã hội thoại của tổ chức khác ⇒ 404;
 *     không ref ⇒ 404; có ref ⇒ ảnh + ETag, đệm trúng KHÔNG gọi fetch lần hai, `If-None-Match` ⇒ 304; thiếu token / tải hỏng ⇒ 404 và
 *     lỗi cũng được đệm; không token trong phản hồi lẫn trong `state`.
 *  4. ĐƯỜNG GHI: danh sách hội thoại của lượt quét lại (`noteListedAvatars`) ghi ref KHÔNG khoá cho hội thoại ĐÃ CÓ, không mở hội
 *     thoại mới, lần hai không ghi lại.
 *  5. MÃ NGUỒN: route qua `apiGuard` + `ai_sales:view`; lõi không ghi CSDL, không in nhật ký URL, không tự khai danh sách host; hộp thư
 *     dựng ảnh bằng `avatarProxyHref`; ops audit đếm ref.
 * Mốc thời gian đi theo đồng hồ THẬT (AGENTS 50).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import {
  AVATAR_PROXY_HOSTS,
  avatarProxyHref,
  avatarProxyRefFrom,
  avatarProxyRefOfState,
  avatarStatusOf,
  avatarTokenParamNames,
  mergePancakeAvatarFacts,
  pancakeAvatarFactsOf,
  pancakeAvatarPatch,
  pancakeAvatarRefOf,
  stripAvatarToken,
} from "@/lib/sales-chatbot/avatar-profile";
import { AVATAR_FETCH, AvatarLru, avatarFetchUrl, avatarHopAllowed, avatarProxyCore, fetchAvatarImage } from "@/lib/sales-chatbot/avatar-proxy";
import { fanpageVisitorKey, noteListedAvatars } from "@/lib/sales-chatbot/fanpage";
import { parseHistoryRun } from "@/lib/sales-chatbot/history-shared";
import { pendingThreadOf } from "@/lib/sales-chatbot/history";
import { auditAvatars } from "@/scripts/inbox-avatar-audit";

const ORG = "anh-dai-dien-proxy";
const PAGE = "1100000000001";
const TOKEN = "PAGE_TOKEN_BI_MAT_1234567890";
const TOK_URL = (psid: string) => `https://pages.fm/api/v1/pages/${PAGE}/avatar/${psid}?page_access_token=${TOKEN}&width=100`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(routes: (url: string) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return routes(url);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const img = (body: Uint8Array = JPEG, type = "image/jpeg", extra: Record<string, string> = {}) => new Response(body.slice(), { status: 200, headers: { "content-type": type, ...extra } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

// ─────────────────────────── 1. THUẦN ───────────────────────────

function testPure() {
  // stripAvatarToken: bỏ mọi tham số khoá, giữ tham số thường, bỏ #…
  assert.equal(stripAvatarToken(TOK_URL("42")), `https://pages.fm/api/v1/pages/${PAGE}/avatar/42?width=100`);
  assert.equal(stripAvatarToken("https://pages.fm/a?access_token=x&page_access_token=y&token=z&api_key=k&key=1&secret=s&signature=g&w=2#frag"), "https://pages.fm/a?w=2");
  assert.equal(stripAvatarToken("https://scontent.xx.fbcdn.net/v/t1/p.jpg?oh=ab&oe=6712ABCD&_nc_sid=1"), "https://scontent.xx.fbcdn.net/v/t1/p.jpg?oh=ab&oe=6712ABCD&_nc_sid=1", "chữ ký CDN (oh/oe) không phải khoá của shop ⇒ giữ");
  for (const bad of ["http://pages.fm/a?access_token=x", "https://u:p@pages.fm/a", "https://pages.fm:8443/a", "không phải URL", "", null, 42, "https://pages.fm/access_token/abc", `https://pages.fm/${"a".repeat(1100)}`]) {
    assert.equal(stripAvatarToken(bad), null, `không cất: ${String(bad).slice(0, 50)}`);
  }
  assert.deepEqual(avatarTokenParamNames(TOK_URL("42")), ["page_access_token"]);
  assert.deepEqual(avatarTokenParamNames("https://pages.fm/a?w=1"), []);

  // Ref: chỉ host đã khai; host giả dạng bị chặn; không bao giờ mang giá trị khoá.
  const ref = avatarProxyRefFrom(TOK_URL("42"));
  assert.deepEqual(ref, { url: `https://pages.fm/api/v1/pages/${PAGE}/avatar/42?width=100`, tokenParams: ["page_access_token"] });
  for (const evil of ["https://pages.fm.evil.vn/a?access_token=x", "https://evilpages.fm/a?access_token=x", "https://example.com/a.jpg?token=x", "https://169.254.169.254/latest?access_token=x", "https://localhost/a?token=x"]) {
    assert.equal(avatarProxyRefFrom(evil), null, `host lạ: ${evil}`);
  }
  assert.ok(avatarProxyRefFrom("https://content.pancake.vn/u/1.jpg?access_token=x"), "tên con của pancake.vn ⇒ được");
  assert.ok(AVATAR_PROXY_HOSTS.includes("fbcdn.net") && AVATAR_PROXY_HOSTS.includes("pages.fm"));

  // Ref đọc lại từ state: kiểm lại từ đầu.
  assert.deepEqual(pancakeAvatarRefOf(ref), ref);
  assert.equal(pancakeAvatarRefOf({ url: TOK_URL("42"), tokenParams: [] }), null, "ref còn khoá (dòng bị sửa tay) ⇒ bỏ");
  assert.equal(pancakeAvatarRefOf({ url: "https://evil.vn/a.jpg", tokenParams: [] }), null, "ref host lạ ⇒ bỏ");
  assert.deepEqual(pancakeAvatarRefOf({ url: "https://pages.fm/a", tokenParams: ["page_access_token", "width", "x;y", 1] })?.tokenParams, ["page_access_token"], "chỉ nhận TÊN tham số khoá hợp lệ");
  assert.equal(pancakeAvatarRefOf(null), null);

  // Lõi Pancake: URL mang khoá ⇒ lý do TOKENIZED_URL + ref không khoá; gộp gói: bản có ref thắng.
  const facts = pancakeAvatarFactsOf({ from: { avatar_url: TOK_URL("42") } }, "POLL");
  assert.deepEqual(facts, { url: null, outcome: "TOKENIZED_URL", via: "POLL", ref });
  assert.deepEqual(pancakeAvatarFactsOf({ from: { avatar_url: "https://evil.vn/a?access_token=x" } }), { url: null, outcome: "TOKENIZED_URL" }, "host lạ ⇒ chỉ lý do, không ref");
  assert.equal(mergePancakeAvatarFacts([{ url: null, outcome: "TOKENIZED_URL" }, facts]).ref?.url, ref!.url, "cùng lý do: bản có ref thắng");

  // Bản vá state: ghi ref; cùng ref ⇒ không ghi lại; ref mới ⇒ ghi; KHÔNG BAO GIỜ có giá trị khoá.
  const now = new Date();
  const p1 = pancakeAvatarPatch({}, facts, now);
  assert.ok(p1 && (p1.pancakeAvatarRef as { url: string }).url === ref!.url && (p1.pancakeAvatar as { outcome: string }).outcome === "TOKENIZED_URL");
  assert.ok(!JSON.stringify(p1).includes(TOKEN), "state không mang token");
  assert.equal(pancakeAvatarPatch({ ...p1 }, facts, new Date(now.getTime() + 60_000)), null, "cùng ref trong hạn ⇒ không ghi mỗi lượt");
  const p2 = pancakeAvatarPatch({ ...p1 }, pancakeAvatarFactsOf({ from: { avatar_url: TOK_URL("43") } }), new Date(now.getTime() + 60_000));
  assert.ok(p2 && (p2.pancakeAvatarRef as { url: string }).url.includes("/avatar/43"), "khách đổi ảnh ⇒ ref mới");
  assert.ok(!JSON.stringify(pendingThreadOf({ id: "P_1", from: { avatar_url: TOK_URL("42") } })).includes(TOKEN), "lượt nhập lịch sử: không token");
  assert.deepEqual(pendingThreadOf({ id: "P_1", from: { avatar_url: TOK_URL("42") } })?.avatarRef, ref, "lượt nhập lịch sử mang ref");
  const run = parseHistoryRun({ status: "RUNNING", pending: [{ id: "P_1", name: "", phones: [], avatarUrl: null, avatarOutcome: "TOKENIZED_URL", avatarRef: ref, updatedAt: null }, { id: "P_2", avatarRef: { url: TOK_URL("9"), tokenParams: [] } }] });
  assert.deepEqual(run.pending[0].avatarRef, ref);
  assert.equal(run.pending[1].avatarRef, undefined, "ref mang khoá trong settings ⇒ bỏ khi đọc lại");

  // Chẩn đoán «có ảnh» = đúng thứ hộp thư hiện.
  assert.deepEqual(avatarStatusOf({ pancakeAvatarRef: ref, pancakeAvatar: { at: now.toISOString(), outcome: "TOKENIZED_URL" } }, now), { status: "PROFILE_AVAILABLE", source: "PANCAKE", reason: "PANCAKE_PROXY" });
  assert.equal(avatarStatusOf({ pancakeAvatarRef: { url: TOK_URL("1"), tokenParams: [] }, pancakeAvatar: { at: now.toISOString(), outcome: "TOKENIZED_URL" } }, now).reason, "PANCAKE_URL_REQUIRES_TOKEN", "ref hỏng ⇒ như chưa có");
  assert.equal(avatarProxyRefOfState({ pancakeAvatarRef: ref })?.url, ref!.url);

  // Đường dẫn cho trình duyệt: TƯƠNG ĐỐI, không token, không URL nguồn.
  const href = avatarProxyHref("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", ref!);
  assert.match(href, /^\/api\/ai-sales\/avatar\/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed\?v=[0-9a-z]+$/);
  assert.notEqual(href, avatarProxyHref("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed", avatarProxyRefFrom(TOK_URL("43"))!), "ảnh đổi ⇒ phiên bản đổi");

  // Gắn token: chỉ host Pancake, chỉ đúng page.
  assert.equal(avatarFetchUrl(ref!, PAGE, TOKEN), `https://pages.fm/api/v1/pages/${PAGE}/avatar/42?width=100&page_access_token=${TOKEN}`);
  assert.equal(avatarFetchUrl(ref!, "9999999", TOKEN), null, "đường dẫn /pages/<id>/ khác page của hội thoại ⇒ không gửi token");
  assert.equal(avatarFetchUrl(ref!, PAGE, null), null, "đòi token mà không có ⇒ không gọi");
  assert.equal(avatarFetchUrl({ url: "https://scontent.xx.fbcdn.net/a.jpg", tokenParams: ["access_token"] }, PAGE, TOKEN), null, "CDN Facebook KHÔNG BAO GIỜ nhận token của shop");
  assert.equal(avatarFetchUrl({ url: "https://scontent.xx.fbcdn.net/a.jpg", tokenParams: [] }, PAGE, TOKEN), "https://scontent.xx.fbcdn.net/a.jpg", "không đòi token ⇒ gọi thẳng, không gắn");
  assert.equal(avatarHopAllowed("https://pages.fm.evil.vn/a"), false);
  assert.equal(avatarHopAllowed("http://pages.fm/a"), false);
  assert.equal(avatarHopAllowed("https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=1"), true);

  // LRU: trần mục + trần byte + hạn.
  const lru = new AvatarLru(2, 25);
  const e = (n: number) => ({ at: 0, ok: true as const, body: new Uint8Array(n), contentType: "image/jpeg", etag: '"x"' });
  lru.set("a", e(10));
  lru.set("b", e(10));
  lru.get("a", 1);
  lru.set("c", e(10));
  assert.ok(lru.get("a", 1) && !lru.get("b", 1) && lru.get("c", 1), "vượt trần ⇒ bỏ mục ít dùng nhất");
  lru.set("d", e(20));
  assert.ok(lru.size <= 2 && lru.get("d", 1), "vượt trần byte ⇒ bỏ bớt");
  assert.equal(lru.get("d", AVATAR_FETCH.okTtlMs + 1), null, "quá hạn ⇒ hết");
  lru.set("f", { at: 0, ok: false });
  assert.equal(lru.get("f", AVATAR_FETCH.failTtlMs + 1), null, "lỗi đệm ngắn hơn");
  console.log("  ✓ thuần: bỏ mọi tham số khoá · ref chỉ host đã khai · ref đọc lại kiểm từ đầu · token chỉ tới Pancake đúng page · chẩn đoán = thứ hộp thư hiện · LRU có trần");
}

// ─────────────────────────── 2. TẢI ẢNH (fetch giả) ───────────────────────────

async function testFetch() {
  const first = avatarFetchUrl(avatarProxyRefFrom(TOK_URL("42"))!, PAGE, TOKEN)!;
  // Pancake chuyển sang CDN Facebook ⇒ đi tiếp, bước sau KHÔNG mang token.
  const ok = fakeFetch((u) => (u.startsWith("https://pages.fm/") ? redirect("https://scontent.xx.fbcdn.net/v/p.jpg?oh=1&oe=2") : img()));
  const got = await fetchAvatarImage(first, ok.fetch);
  assert.ok(got && got.contentType === "image/jpeg" && got.body.byteLength === JPEG.byteLength);
  assert.equal(ok.calls.length, 2);
  assert.ok(!ok.calls[1].url.includes(TOKEN), "bước chuyển hướng không mang token");
  assert.ok(ok.calls.every((c) => c.init?.redirect === "manual" && c.init?.signal), "không để fetch tự theo chuyển hướng · có hết giờ");

  // Chuyển hướng sang host lạ ⇒ dừng, không gọi host đó.
  const evil = fakeFetch((u) => (u.startsWith("https://pages.fm/") ? redirect("https://169.254.169.254/latest/meta-data") : img()));
  assert.equal(await fetchAvatarImage(first, evil.fetch), null);
  assert.equal(evil.calls.length, 1, "host lạ không bao giờ bị gọi");
  // URL đầu ở host lạ ⇒ không gọi gì.
  const none = fakeFetch(() => img());
  assert.equal(await fetchAvatarImage("https://evil.vn/a.jpg", none.fetch), null);
  assert.equal(none.calls.length, 0);
  // Vòng chuyển hướng ⇒ dừng ở trần.
  const loop = fakeFetch(() => redirect("https://pages.fm/loop"));
  assert.equal(await fetchAvatarImage("https://pages.fm/loop", loop.fetch), null);
  assert.equal(loop.calls.length, AVATAR_FETCH.maxRedirects + 1);

  // Không phải ảnh raster ⇒ chặn.
  for (const type of ["text/html", "image/svg+xml", "application/json", ""]) {
    assert.equal(await fetchAvatarImage(first, fakeFetch(() => img(JPEG, type)).fetch), null, `kiểu «${type}» bị chặn`);
  }
  assert.ok(await fetchAvatarImage(first, fakeFetch(() => img(JPEG, "image/webp; charset=binary")).fetch), "image/webp kèm tham số ⇒ nhận");
  // Quá cỡ: khai báo, và dòng byte không khai báo.
  assert.equal(await fetchAvatarImage(first, fakeFetch(() => img(JPEG, "image/jpeg", { "content-length": String(AVATAR_FETCH.maxBytes + 1) })).fetch), null, "khai báo quá cỡ ⇒ chặn");
  const big = () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent > AVATAR_FETCH.maxBytes) return ctrl.close();
        sent += 256_000;
        ctrl.enqueue(new Uint8Array(256_000));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
  };
  assert.equal(await fetchAvatarImage(first, fakeFetch(big).fetch), null, "dòng byte vượt trần ⇒ cắt, chặn");
  // Lỗi HTTP / ném ⇒ null, không ném ra ngoài.
  assert.equal(await fetchAvatarImage(first, fakeFetch(() => new Response("x", { status: 403 })).fetch), null);
  assert.equal(
    await fetchAvatarImage(
      first,
      fakeFetch(() => {
        throw new Error("ECONNRESET");
      }).fetch,
    ),
    null,
  );
  console.log("  ✓ tải ảnh: host lạ không gọi · chuyển hướng sang host lạ dừng · bước sau không mang token · HTML/SVG bị chặn · quá cỡ bị chặn · lỗi không ném");
}

// ─────────────────────────── 3–4. CSDL: lõi route + đường ghi ───────────────────────────

async function cleanup() {
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

async function testDb() {
  await cleanup();
  // Hội thoại của CSDL NHÀ (tổ chức khác) mang ref hợp lệ — người của `ORG` không được thấy ảnh này.
  const home = await getDb();
  const hc = schema.salesChatConversations;
  const ref = avatarProxyRefFrom(TOK_URL("42"))!;
  const [homeConv] = await home
    .insert(hc)
    .values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, `${PAGE}_home`), pageId: PAGE, threadId: `${PAGE}_home`, state: { pancakeAvatarRef: ref } })
    .returning({ id: hc.id });
  try {
    await provisionOrganization({ code: ORG, name: "Shop ảnh proxy", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "AnhDaiDien@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const outsider = { ...admin, id: "khong-quyen", role: "VIEWER", permissions: [] } as unknown as SessionUser;
      const c = schema.salesChatConversations;
      const conv = async (thread: string, state: Record<string, unknown>) => {
        const [r] = await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, thread), pageId: PAGE, threadId: thread, state }).returning({ id: c.id });
        return r.id;
      };
      const withRef = await conv(`${PAGE}_1`, { pancakeAvatarRef: ref });
      const noRef = await conv(`${PAGE}_2`, { pancakeAvatar: { at: new Date().toISOString(), outcome: "TOKENIZED_URL" } });
      const noToken = await conv(`${PAGE}_3`, { pancakeAvatarRef: avatarProxyRefFrom(TOK_URL("43")) });
      const broken = await conv(`${PAGE}_4`, { pancakeAvatarRef: avatarProxyRefFrom(TOK_URL("44")) });

      const cache = new AvatarLru();
      const pancake = fakeFetch((url) => (url.includes("/avatar/44") ? new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }) : url.startsWith("https://pages.fm/") ? redirect("https://scontent.xx.fbcdn.net/p.jpg") : img()));
      let tokenAsks = 0;
      const deps = (over: { token?: string | null } = {}) => ({
        fetch: pancake.fetch,
        cache,
        pageToken: async (pageId: string) => {
          tokenAsks += 1;
          return pageId === PAGE ? (over.token === undefined ? TOKEN : over.token) : null;
        },
      });

      assert.deepEqual(await avatarProxyCore(outsider, withRef, null, deps()), { status: 403, reason: "NO_PERMISSION" }, "thiếu ai_sales:view ⇒ 403");
      assert.deepEqual(await avatarProxyCore(admin, homeConv.id, null, deps()), { status: 404, reason: "NO_CONVERSATION" }, "hội thoại của tổ chức khác ⇒ 404");
      assert.deepEqual(await avatarProxyCore(admin, "../../etc/passwd", null, deps()), { status: 404, reason: "NO_CONVERSATION" });
      assert.deepEqual(await avatarProxyCore(admin, noRef, null, deps()), { status: 404, reason: "NO_REF" }, "không ref ⇒ 404 (client lùi về chữ cái)");
      assert.equal(pancake.calls.length, 0, "chưa qua cổng thì chưa gọi Pancake");

      const r1 = await avatarProxyCore(admin, withRef, null, deps());
      assert.ok(r1.status === 200 && r1.contentType === "image/jpeg" && r1.body.byteLength === JPEG.byteLength && /^"[0-9a-f]{24}"$/.test(r1.etag));
      assert.equal(pancake.calls.length, 2, "Pancake + CDN");
      assert.ok(pancake.calls[0].url.includes(TOKEN) && !pancake.calls[1].url.includes(TOKEN), "token chỉ tới Pancake");
      assert.ok(!JSON.stringify({ ...r1, body: [...r1.body] }).includes(TOKEN), "phản hồi không mang token");
      const r2 = await avatarProxyCore(admin, withRef, null, deps());
      assert.ok(r2.status === 200 && r2.etag === r1.etag);
      assert.equal(pancake.calls.length, 2, "đệm trúng ⇒ KHÔNG gọi fetch lần hai");
      assert.deepEqual(await avatarProxyCore(admin, withRef, r1.etag, deps()), { status: 304, etag: r1.etag }, "If-None-Match ⇒ 304");
      assert.equal(tokenAsks, 1, "đệm trúng ⇒ không mở token lần hai");

      assert.deepEqual(await avatarProxyCore(admin, noToken, null, deps({ token: null })), { status: 404, reason: "NO_TOKEN" }, "kết nối không có token ⇒ 404, không gọi");
      assert.equal(pancake.calls.length, 2);
      assert.deepEqual(await avatarProxyCore(admin, noToken, null, deps()), { status: 404, reason: "CACHED_FAILURE" }, "lỗi cũng đệm — không hỏi lại mỗi lần mở trang");
      assert.deepEqual(await avatarProxyCore(admin, broken, null, deps()), { status: 404, reason: "FETCH_FAILED" }, "Pancake trả HTML ⇒ 404");
      const before = pancake.calls.length;
      assert.deepEqual(await avatarProxyCore(admin, broken, null, deps()), { status: 404, reason: "CACHED_FAILURE" });
      assert.equal(pancake.calls.length, before);

      // State trong CSDL không bao giờ có token.
      const rows = await db.select({ state: c.state }).from(c);
      assert.ok(!JSON.stringify(rows).includes(TOKEN) && !/access_token=/.test(JSON.stringify(rows)), "state không mang tham số khoá");

      // ── Đường ghi: danh sách hội thoại của lượt quét lại ──
      const fresh = await conv(`${PAGE}_5`, {});
      const listed = [
        { id: `${PAGE}_5`, type: "INBOX", from: { name: "Lan", avatar_url: TOK_URL("55") } },
        { id: `${PAGE}_6`, type: "INBOX", from: { name: "Chưa có trong ERP", avatar_url: TOK_URL("66") } },
        { id: `${PAGE}_7`, type: "COMMENT", from: { avatar_url: TOK_URL("77") } },
      ];
      const countBefore = (await db.select({ id: c.id }).from(c)).length;
      assert.equal(await noteListedAvatars(PAGE, listed, new Date()), 1, "chỉ hội thoại ĐÃ CÓ được ghi");
      assert.equal((await db.select({ id: c.id }).from(c)).length, countBefore, "không mở hội thoại mới");
      const [st] = await db.select({ state: c.state }).from(c).where(eq(c.id, fresh));
      assert.equal(avatarProxyRefOfState(st.state)?.url, `https://pages.fm/api/v1/pages/${PAGE}/avatar/55?width=100`);
      assert.equal(((st.state as Record<string, unknown>).pancakeAvatar as { via?: string }).via, "POLL");
      assert.ok(!JSON.stringify(st.state).includes(TOKEN), "ref ghi từ danh sách không mang token");
      assert.equal(await noteListedAvatars(PAGE, listed, new Date()), 0, "lần hai cùng ảnh ⇒ không ghi lại");

      // Hộp thư dựng ảnh bằng đường dẫn proxy; audit đếm ref.
      const rep = auditAvatars(
        (await db.select({ channel: c.channel, pageId: c.pageId, threadId: c.threadId, customerId: c.customerId, state: c.state }).from(c)).map((r) => ({ ...r, transport: "PANCAKE" })),
        new Map(),
        new Date(),
      );
      assert.equal(rep.withProxyRef, 4, "ba ref ban đầu + một ref từ danh sách");
      assert.equal(rep.shown, 4);
      assert.equal(rep.proxyNeedsToken, 4);
      assert.deepEqual(rep.proxyRefHost, { "pages.fm": 4 });
      assert.ok(!JSON.stringify(rep).includes("pages.fm/api"), "audit không in URL");
    });
    console.log("  ✓ lõi route (CSDL tổ chức thật): thiếu quyền 403 · tổ chức khác 404 · không ref 404 · ảnh + ETag · đệm trúng không gọi lại · 304 · thiếu token / HTML ⇒ 404 có đệm · state không token");
    console.log("  ✓ đường ghi: danh sách hội thoại quét lại ghi ref KHÔNG khoá cho hội thoại đã có, không mở hội thoại mới, lần hai không ghi · audit đếm ref theo host");
  } finally {
    await home.delete(hc).where(eq(hc.id, homeConv.id));
    await cleanup();
  }
}

// ─────────────────────────── 5. MÃ NGUỒN ───────────────────────────

function testSource() {
  const route = readFileSync("app/api/ai-sales/avatar/[conversationId]/route.ts", "utf8");
  assert.match(route, /await apiGuard\(null, \{ format: "text" \}\)/, "route qua cổng phiên + tổ chức");
  assert.match(route, /can\(user, "ai_sales:view"\)/, "cùng quyền với inbox-read / inbox-images");
  assert.match(route, /avatarProxyCore\(user, conversationId, request\.headers\.get\("if-none-match"\)\)/);
  assert.match(route, /"cache-control": "private, max-age=86400"/);
  assert.match(route, /etag: r\.etag/);
  const routeCode = route.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(routeCode, /token|secret|console\.|\.url\b/i, "route không đụng token, không in nhật ký, không trả URL nguồn");

  const core = readFileSync("lib/sales-chatbot/avatar-proxy.ts", "utf8");
  assert.doesNotMatch(core, /console\./, "lõi không in nhật ký (không bao giờ in URL mang token)");
  assert.deepEqual([...new Set(core.match(/\bdb\.\w+\(/g) ?? [])], ["db.select("], "lõi chỉ ĐỌC CSDL — token không bao giờ được ghi ở chỗ mới");
  assert.doesNotMatch(core, /redirect: "follow"|fbcdn|pages\.fm|pancake\.vn/, "không tự theo chuyển hướng · không tự khai danh sách host (một chỗ: avatar-profile.ts)");
  assert.match(core, /redirect: "manual"/);
  assert.match(core, /isAllowedAvatarHost\(u\.hostname\)/);

  const profile = readFileSync("lib/sales-chatbot/avatar-profile.ts", "utf8");
  assert.equal((profile.match(/export const AVATAR_PROXY_HOSTS = /g) ?? []).length, 1);

  const inbox = readFileSync("lib/sales-chatbot/inbox.ts", "utf8");
  assert.match(inbox, /avatarProxyHref\(conversationId, ref\)/, "hộp thư dựng ảnh proxy bằng hàm chung");
  assert.match(inbox, /avatarUrl: avatarOf\(r\.state, r\.id\)/, "dòng danh sách");
  assert.match(inbox, /avatarUrl: avatarOf\(conv\.state, conv\.id\)/, "khung hội thoại");
  // Avatar trong dòng vẫn là link riêng (sibling của link dòng) — không lồng <a> trong <a> (#784).
  const list = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/conversation-list.tsx", "utf8");
  assert.match(list, /<ChannelAvatar name=\{r\.customerName\} channel=\{r\.channel\} src=\{r\.avatarUrl\} \/>/);
  const fp = readFileSync("lib/sales-chatbot/fanpage.ts", "utf8");
  assert.match(fp, /await noteListedAvatars\(pageId, listed, now\(\)\);/, "lượt quét lại ghi ảnh từ CHÍNH danh sách vừa tải");
  const sc = readFileSync("scripts/inbox-avatar-audit.ts", "utf8");
  assert.match(sc, /avatarProxyRefOfState\(st\)/, "ops audit đếm ref proxy");
  console.log("  ✓ mã nguồn: route qua apiGuard + ai_sales:view · lõi không ghi CSDL / không log · một danh sách host · hộp thư dùng avatarProxyHref · quét lại ghi ảnh");
}

export async function testAvatarProxy() {
  console.log("Ảnh đại diện khách qua proxy ERP (avatar-proxy):");
  testPure();
  await testFetch();
  await testDb();
  testSource();
}
