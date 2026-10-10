/**
 * ═══════════ ẢNH ĐẠI DIỆN KHÁCH + BẤM ẢNH MỞ TRANG FACEBOOK (chủ shop 10/10/2026, mục E · F) ═══════════
 *
 *  · Bảng chân lý `facebookProfileHrefOf`: URL trang Facebook thật ⇒ dùng; URL Pancake / host giả / trang hội thoại / có khoá ⇒ không;
 *    PSID / `customers.fb_id` (mã THEO PAGE) ⇒ KHÔNG BAO GIỜ thành `facebook.com/<mã>`, kể cả khi nguồn đưa một URL trỏ vào chính mã
 *    đó; mã công khai đã xác minh ⇒ `profile.php?id=`; rỗng ⇒ hồ sơ khách nội bộ + lý do.
 *  · `avatarStatusOf` ra đủ NĂM trạng thái (có ảnh · thiếu quyền · nguồn không cho · hết hạn · chưa lấy) với lý do đúng; nhịp hỏi lại
 *    Graph theo loại kết quả.
 *  · Đường ghi Pancake: webhook / quét lại / nhập lịch sử dùng CÙNG `pancakeAvatarFactsOf` + `pancakeAvatarPatch` (không chép luật),
 *    ảnh mang khoá không bao giờ lưu, gói thiếu ảnh không xoá ảnh đã có, dấu không ghi lại mỗi tin.
 *  · Script ops `inbox-avatar-audit`: dạng mã đếm không lộ giá trị; phép so `fb_id` ↔ PSID của mã hội thoại.
 *  · Mã nguồn: không chỗ nào ghép `facebook.com/` với PSID / mã theo page; link ngoài mở tab mới `noopener noreferrer`; lượt lấp dần
 *    Meta KHÔNG nằm trong đường trả lời và KHÔNG có lịch; ops-vps khai đủ bốn chỗ.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  avatarLinkOf,
  avatarLinkTitle,
  avatarStatusOf,
  cdnExpiryMs,
  facebookProfileHrefOf,
  FACEBOOK_ID_SOURCES,
  pancakeAvatarFactsOf,
  pancakeAvatarPatch,
  PROFILE_DENIED_RETRY_MS,
  PROFILE_REFRESH_MS,
  PROFILE_TRANSIENT_RETRY_MS,
  profileRefreshDue,
} from "@/lib/sales-chatbot/avatar-profile";
import { parsePancakeWebhook } from "@/lib/sales-chatbot/fanpage";
import { pancakeAvatarOf, pendingThreadOf } from "@/lib/sales-chatbot/history";
import { avatarHrefOf, safeAvatarUrl } from "@/lib/sales-chatbot/inbox-shared";
import { auditAvatars, idShapeOf, pancakeThreadPsid, parseAuditArgs, type AuditCustomer } from "@/scripts/inbox-avatar-audit";

const PSID = "25000000000000001";
const NOW = new Date();
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function testFacebookHref() {
  const ok = (url: string, href: string) => assert.deepEqual(facebookProfileHrefOf({ sourceProfileUrl: url }), { href, reason: "FACEBOOK_SOURCE_URL" }, url);
  ok("https://www.facebook.com/nguyen.van.a", "https://www.facebook.com/nguyen.van.a");
  ok("https://m.facebook.com/profile.php?id=100012345678901&ref=x", "https://m.facebook.com/profile.php?id=100012345678901");
  ok("https://fb.com/abc.def/", "https://fb.com/abc.def");
  const no = (url: string, reason: string) => assert.deepEqual(facebookProfileHrefOf({ sourceProfileUrl: url }), { href: null, reason }, url);
  no("http://www.facebook.com/nguyen.van.a", "SOURCE_URL_NOT_FACEBOOK");
  no("https://pancake.vn/shop/conversations/1_2", "SOURCE_URL_NOT_FACEBOOK");
  no("https://pages.fm/api/v1/pages/1/conversations/1_2", "SOURCE_URL_NOT_FACEBOOK");
  no("https://facebook.com.evil.vn/nguyen.van.a", "SOURCE_URL_NOT_FACEBOOK");
  no("https://user:pw@www.facebook.com/nguyen.van.a", "SOURCE_URL_NOT_FACEBOOK");
  no("không phải URL", "SOURCE_URL_NOT_FACEBOOK");
  no("https://www.facebook.com/messages/t/123456", "SOURCE_URL_NOT_PROFILE");
  no("https://www.facebook.com/groups/abcde", "SOURCE_URL_NOT_PROFILE");
  no("https://www.facebook.com/nguyen.van.a?access_token=x", "SOURCE_URL_NOT_PROFILE");
  no("https://www.facebook.com/profile.php?id=abc", "SOURCE_URL_NOT_PROFILE");

  // PSID / mã theo page: KHÔNG BAO GIỜ dựng, kể cả khi nguồn đưa URL trỏ vào chính mã đó.
  for (const source of ["META_PSID", "PANCAKE_CUSTOMER_FB_ID", "PANCAKE_FROM_PSID"] as const) {
    assert.equal(FACEBOOK_ID_SOURCES[source].kind, "PAGE_SCOPED", `${source} là mã theo page (có căn cứ trong kho)`);
    const r = facebookProfileHrefOf({ ids: [{ value: PSID, source }] });
    assert.deepEqual(r, { href: null, reason: "ONLY_PAGE_SCOPED_ID" }, `${source} ⇒ không dựng facebook.com/<PSID>`);
  }
  assert.deepEqual(facebookProfileHrefOf({ sourceProfileUrl: `https://www.facebook.com/${PSID}`, ids: [{ value: PSID, source: "META_PSID" }] }), { href: null, reason: "ONLY_PAGE_SCOPED_ID" }, "URL nguồn trỏ vào PSID ⇒ không dùng");
  assert.deepEqual(facebookProfileHrefOf({ sourceProfileUrl: `https://www.facebook.com/profile.php?id=${PSID}`, ids: [{ value: PSID, source: "PANCAKE_CUSTOMER_FB_ID" }] }), { href: null, reason: "ONLY_PAGE_SCOPED_ID" });
  assert.deepEqual(facebookProfileHrefOf({ ids: [{ value: PSID, kind: "UNPROVEN" }] }), { href: null, reason: "ID_MEANING_UNPROVEN" }, "chưa chứng minh ⇒ không dựng");
  assert.deepEqual(facebookProfileHrefOf({ ids: [{ value: "100012345678901", kind: "PUBLIC_PROFILE" }] }), { href: "https://www.facebook.com/profile.php?id=100012345678901", reason: "FACEBOOK_PUBLIC_ID" });
  assert.deepEqual(facebookProfileHrefOf({ ids: [{ value: PSID, kind: "PUBLIC_PROFILE" }, { value: PSID, source: "META_PSID" }] }), { href: null, reason: "ONLY_PAGE_SCOPED_ID" }, "cùng mã mà một nguồn nói là theo page ⇒ không tin nhãn công khai");
  assert.deepEqual(facebookProfileHrefOf({ sourceProfileUrl: "https://www.facebook.com/a.b.c", ids: [{ value: PSID, source: "META_PSID" }] }).reason, "FACEBOOK_SOURCE_URL", "URL thật thắng mã theo page");
  assert.deepEqual(facebookProfileHrefOf({}), { href: null, reason: "NO_SOURCE_URL" });
  assert.deepEqual(facebookProfileHrefOf({ sourceProfileUrl: "  ", ids: [{ value: "", source: "META_PSID" }] }), { href: null, reason: "NO_SOURCE_URL" }, "rỗng ⇒ không có nguồn");

  // Bấm ảnh: Facebook ⇒ tab mới; không ⇒ hồ sơ nội bộ kèm lý do; chưa nối ⇒ không link.
  const ext = avatarLinkOf({ customerId: "c1", sourceProfileUrl: "https://www.facebook.com/a.b.c" });
  assert.deepEqual(ext, { href: "https://www.facebook.com/a.b.c", external: true, reason: "FACEBOOK_SOURCE_URL" });
  assert.equal(avatarLinkTitle(ext), "Mở trang Facebook");
  const inner = avatarLinkOf({ customerId: "c 1", ids: [{ value: PSID, source: "META_PSID" }] });
  assert.deepEqual(inner, { href: "/customers/c%201", external: false, reason: "ONLY_PAGE_SCOPED_ID" });
  assert.match(avatarLinkTitle(inner), /^Mở hồ sơ khách — chưa có link Facebook: nguồn chỉ có mã theo page/);
  assert.deepEqual(avatarLinkOf({ customerId: null, ids: [{ value: PSID, source: "META_PSID" }] }), { href: null, external: false, reason: "NO_CUSTOMER_PROFILE" });
  assert.deepEqual(avatarHrefOf("c1"), { href: "/customers/c1", external: false, reason: "NO_SOURCE_URL" }, "hộp thư: hàm cũ trả đích + lý do");
  console.log("  ✓ link Facebook: URL thật ⇒ dùng · Pancake / host giả / trang hội thoại ⇒ không · PSID / fb_id ⇒ không bao giờ · rỗng ⇒ hồ sơ nội bộ + lý do");
}

function testAvatarStatus() {
  const ext = (secAhead: number) => `https://platform-lookaside.fbsbx.com/platform/profilepic/?psid=1&ext=${Math.floor(NOW.getTime() / 1000) + secAhead}&hash=x`;
  assert.equal(cdnExpiryMs(ext(60)), (Math.floor(NOW.getTime() / 1000) + 60) * 1000);
  assert.equal(cdnExpiryMs("https://scontent.xx.fbcdn.net/v/a.jpg?oe=6712ABCD"), parseInt("6712ABCD", 16) * 1000);
  assert.equal(cdnExpiryMs("https://cdn.example.vn/a.jpg"), null, "không tham số hạn ⇒ không biết");
  const st = (s: Record<string, unknown>) => avatarStatusOf(s, NOW);
  const cases: [Record<string, unknown>, string, string][] = [
    [{ messengerProfile: { pic: ext(3600), at: iso(H), error: null } }, "PROFILE_AVAILABLE", "META_PIC"],
    [{ pancakeAvatarUrl: "https://content.pancake.vn/avatar/a.jpg" }, "PROFILE_AVAILABLE", "PANCAKE_URL"],
    [{ messengerProfile: { pic: ext(-60), at: iso(H) }, pancakeAvatarUrl: "https://content.pancake.vn/a.jpg" }, "PROFILE_AVAILABLE", "PANCAKE_URL"],
    [{ messengerProfile: { pic: ext(-60), at: iso(H) } }, "PROFILE_EXPIRED", "META_PIC_URL_EXPIRED"],
    [{ messengerProfile: { pic: "https://cdn.example.vn/a.jpg", at: iso(PROFILE_REFRESH_MS + H) } }, "PROFILE_EXPIRED", "META_PIC_STALE"],
    [{ pancakeAvatarUrl: "https://scontent.xx.fbcdn.net/v/a.jpg?oe=5F000000" }, "PROFILE_EXPIRED", "PANCAKE_URL_EXPIRED"],
    [{ messengerProfile: { pic: null, at: iso(H), error: "(#230) Requires pages_messaging permission", code: 230 } }, "PROFILE_PERMISSION_DENIED", "META_PERMISSION"],
    [{ messengerProfile: { pic: null, at: iso(H), error: "(#10) Application does not have permission for this action" } }, "PROFILE_PERMISSION_DENIED", "META_PERMISSION"],
    [{ messengerProfile: { pic: null, at: iso(H), error: "Error validating access token", code: 190 } }, "PROFILE_PERMISSION_DENIED", "META_TOKEN_INVALID"],
    [{ messengerProfile: { pic: null, at: iso(H), error: "Unsupported get request. Object … cannot be loaded", code: 100, subcode: 33 } }, "PROFILE_NOT_AVAILABLE", "META_OBJECT_UNREADABLE"],
    [{ messengerProfile: { pic: null, at: iso(H), error: null, code: null, http: 200 } }, "PROFILE_NOT_AVAILABLE", "META_NO_PROFILE_PIC"],
    [{ pancakeAvatar: { at: iso(H), outcome: "TOKENIZED_URL" } }, "PROFILE_NOT_AVAILABLE", "PANCAKE_URL_REQUIRES_TOKEN"],
    [{ pancakeAvatar: { at: iso(H), outcome: "NO_AVATAR_FIELD" } }, "PROFILE_NOT_AVAILABLE", "PANCAKE_PAYLOAD_NO_AVATAR"],
    [{ messengerProfile: { pic: null, at: iso(H), error: "(#4) Application request limit reached", code: 4 } }, "PROFILE_NOT_FETCHED", "META_RATE_LIMITED"],
    [{ messengerProfile: { pic: null, at: iso(H), error: "fetch failed" } }, "PROFILE_NOT_FETCHED", "META_TRANSIENT"],
    [{}, "PROFILE_NOT_FETCHED", "NEVER_FETCHED"],
    [{ pancakeAvatarUrl: "https://pages.fm/avatar?page_access_token=x" }, "PROFILE_NOT_FETCHED", "NEVER_FETCHED"],
  ];
  const seen = new Set<string>();
  for (const [state, status, reason] of cases) {
    const d = st(state);
    assert.deepEqual([d.status, d.reason], [status, reason], JSON.stringify(state));
    seen.add(d.status);
  }
  assert.equal(seen.size, 5, "đủ năm trạng thái chẩn đoán");
  // «Có ảnh» của chẩn đoán = đúng thứ hộp thư hiện (`safeAvatarUrl`).
  for (const u of ["https://content.pancake.vn/a.jpg", "https://pages.fm/avatar?page_access_token=x", "https://x.vn/a?token=1", "http://x.vn/a.jpg", `https://x.vn/${"a".repeat(2100)}`, "https://x.vn/a b.jpg"]) {
    assert.equal(avatarStatusOf({ pancakeAvatarUrl: u }, NOW).status === "PROFILE_AVAILABLE", safeAvatarUrl(u) !== null, u.slice(0, 60));
  }

  // Nhịp hỏi lại Graph.
  assert.equal(profileRefreshDue(undefined, NOW), true, "chưa hỏi ⇒ tới hạn");
  assert.equal(profileRefreshDue({ pic: ext(3600), at: iso(H) }, NOW), false, "ảnh còn hạn ⇒ không hỏi");
  assert.equal(profileRefreshDue({ pic: ext(-1), at: iso(H) }, NOW), true, "URL CDN báo hết hạn ⇒ hỏi lại ngay");
  assert.equal(profileRefreshDue({ pic: null, at: iso(PROFILE_DENIED_RETRY_MS - H), error: "x", code: 230 }, NOW), false, "thiếu quyền ⇒ chờ một ngày");
  assert.equal(profileRefreshDue({ pic: null, at: iso(PROFILE_DENIED_RETRY_MS + H), error: "x", code: 230 }, NOW), true);
  assert.equal(profileRefreshDue({ pic: null, at: iso(PROFILE_TRANSIENT_RETRY_MS + 60_000), error: "fetch failed" }, NOW), true, "lỗi mạng ⇒ thử lại sau một giờ");
  assert.equal(profileRefreshDue({ pic: null, at: iso(PROFILE_TRANSIENT_RETRY_MS - 60_000), error: "fetch failed" }, NOW), false);
  console.log("  ✓ chẩn đoán ảnh: đủ 5 trạng thái PROFILE_* + lý do · nhịp hỏi lại Graph theo loại kết quả");
}

function testPancakeWritePath() {
  const tokenized = { from: { avatar_url: "https://pages.fm/api/v1/pages/1/avatar/2?page_access_token=BI_MAT" } };
  // URL mang khoá: không lưu URL; bản ĐÃ BỎ khoá đi làm ref proxy (tests/avatar-proxy.test.ts).
  assert.deepEqual(pancakeAvatarFactsOf(tokenized), { url: null, outcome: "TOKENIZED_URL", ref: { url: "https://pages.fm/api/v1/pages/1/avatar/2", tokenParams: ["page_access_token"] } });
  assert.deepEqual(pancakeAvatarFactsOf({ customers: [{ avatar: "https://cdn.example.vn/u/1.jpg" }] }, "POLL"), { url: "https://cdn.example.vn/u/1.jpg", outcome: "URL", via: "POLL" });
  assert.deepEqual(pancakeAvatarFactsOf({ from: { avatar: "http://cdn.example.vn/1.jpg" } }), { url: null, outcome: "INVALID_URL" });
  assert.deepEqual(pancakeAvatarFactsOf({ from: { name: "Lan" } }), { url: null, outcome: "NO_AVATAR_FIELD" });
  // Một luật cho hai đường: hàm cũ của lượt nhập lịch sử trả đúng `url` của lõi.
  for (const o of [tokenized, { customers: [{ avatar: "https://cdn.example.vn/u/1.jpg" }] }, {}]) assert.equal(pancakeAvatarOf(o), pancakeAvatarFactsOf(o).url);
  assert.equal(pendingThreadOf({ id: "P_1", ...tokenized })?.avatarOutcome, "TOKENIZED_URL", "lượt nhập mang lý do không có ảnh");

  // Webhook: tin KHÁCH mang ảnh của khách; tin PAGE không.
  const base = { event_type: "messaging", page_id: "P" };
  const cust = parsePancakeWebhook({ ...base, data: { conversation: { id: "P_4100", type: "INBOX", from_psid: "4100", from: { name: "Lan", avatar_url: "https://pages.fm/x/avatar?page_access_token=t" } }, message: { id: "m1", type: "INBOX", message: "Chào shop", from: { id: "4100", name: "Lan" } } } });
  assert.deepEqual(cust?.avatar, { url: null, outcome: "TOKENIZED_URL", via: "WEBHOOK", ref: { url: "https://pages.fm/x/avatar", tokenParams: ["page_access_token"] } }, "ảnh mang khoá ⇒ lý do + ref KHÔNG khoá, không URL");
  const custOk = parsePancakeWebhook({ ...base, data: { conversation: { id: "P_4100", type: "INBOX", customers: [{ avatar: "https://cdn.example.vn/a.jpg" }] }, message: { id: "m2", type: "INBOX", message: "Hi", from: { id: "4100" } } } });
  assert.equal(custOk?.avatar?.url, "https://cdn.example.vn/a.jpg");
  const page = parsePancakeWebhook({ ...base, data: { conversation: { id: "P_4100", type: "INBOX", customers: [{ avatar: "https://cdn.example.vn/a.jpg" }] }, message: { id: "m3", type: "INBOX", message: "Dạ", from: { id: "P", name: "Shop", avatar_url: "https://cdn.example.vn/page.jpg" } } } });
  assert.equal(page?.avatar, null, "tin phía page ⇒ không ghi ảnh (ảnh trong gói là của page)");

  // Bản vá state: ảnh mới ⇒ ghi; cùng ảnh trong 24 giờ ⇒ không ghi; thiếu ảnh ⇒ không xoá ảnh cũ.
  const url = "https://cdn.example.vn/a.jpg";
  const p1 = pancakeAvatarPatch({}, { url, outcome: "URL", via: "WEBHOOK" }, NOW);
  assert.ok(p1 && p1.pancakeAvatarUrl === url && (p1.pancakeAvatar as { outcome: string }).outcome === "URL");
  const after = { ...p1 };
  assert.equal(pancakeAvatarPatch(after, { url, outcome: "URL", via: "WEBHOOK" }, new Date(NOW.getTime() + H)), null, "cùng ảnh trong hạn ⇒ không ghi mỗi tin");
  const later = pancakeAvatarPatch(after, { url, outcome: "URL" }, new Date(NOW.getTime() + 25 * H));
  assert.ok(later && !("pancakeAvatarUrl" in later), "quá 24 giờ ⇒ chỉ đóng lại dấu");
  const miss = pancakeAvatarPatch(after, { url: null, outcome: "NO_AVATAR_FIELD", via: "WEBHOOK" }, new Date(NOW.getTime() + H));
  assert.ok(miss && !("pancakeAvatarUrl" in miss), "gói thiếu ảnh KHÔNG xoá ảnh đã có");
  assert.equal(pancakeAvatarPatch({ pancakeAvatar: { at: NOW.toISOString(), outcome: "TOKENIZED_URL" } }, { url: null, outcome: "TOKENIZED_URL" }, new Date(NOW.getTime() + H)), null, "cùng lý do trong hạn ⇒ không ghi");
  assert.ok(!JSON.stringify(pancakeAvatarPatch({}, pancakeAvatarFactsOf(tokenized), NOW)).includes("BI_MAT"), "khoá trong URL ảnh không bao giờ vào state");
  console.log("  ✓ đường ghi Pancake: webhook / quét lại / nhập lịch sử cùng một luật · ảnh mang khoá không lưu · thiếu ảnh không xoá · không ghi mỗi tin");
}

function testAuditPure() {
  const shapes: [unknown, string][] = [[null, "EMPTY"], ["", "EMPTY"], [PSID, "DIGITS_LONG"], ["12345", "DIGITS_SHORT"], ["abc_12", "ALNUM"], ["https://www.facebook.com/a", "URL_FACEBOOK"], ["https://pancake.vn/x", "URL_PANCAKE"], ["https://pages.fm/x", "URL_PANCAKE"], ["https://example.com", "URL_OTHER"], ["https://", "URL_OTHER"]];
  for (const [v, s] of shapes) assert.equal(idShapeOf(v), s, String(v));
  assert.equal(pancakeThreadPsid(`P_${PSID}`, "P"), PSID);
  assert.equal(pancakeThreadPsid("P_abc", "P"), null);
  assert.equal(pancakeThreadPsid(PSID, "P"), null);
  assert.deepEqual(parseAuditArgs(["hslc"]), { code: "hslc", limit: 300 });
  assert.deepEqual(parseAuditArgs(["hslc", "--limit=50"]), { code: "hslc", limit: 50 });
  assert.ok("error" in parseAuditArgs(["HSLC"]) && "error" in parseAuditArgs(["hslc", "--limit=0"]) && "error" in parseAuditArgs(["hslc", "--limit=9999"]));

  const customers = new Map<string, AuditCustomer>([
    ["c1", { fbId: PSID, conversationLink: "https://pancake.vn/shop/c/1" }],
    ["c2", { fbId: "999", conversationLink: null }],
  ]);
  const rep = auditAvatars(
    [
      { channel: "FANPAGE", pageId: "P", threadId: `P_${PSID}`, customerId: "c1", transport: "PANCAKE", state: { pancakeAvatar: { at: iso(H), outcome: "TOKENIZED_URL" } } },
      { channel: "FANPAGE", pageId: "P", threadId: "P_123456789", customerId: "c2", transport: "PANCAKE", state: { pancakeAvatarUrl: "https://content.pancake.vn/a.jpg" } },
      { channel: "FANPAGE", pageId: "M", threadId: "4100000000901", customerId: null, transport: "MESSENGER", state: { messengerProfile: { pic: null, at: iso(H), error: "(#230) x", code: 230 } } },
    ],
    customers,
    NOW,
  );
  assert.equal(rep.conversations, 3);
  assert.deepEqual(rep.bySource, { PANCAKE: 2, DIRECT: 1 });
  assert.equal(rep.withAvatarUrl, 1);
  assert.deepEqual([rep.byStatus.PROFILE_AVAILABLE, rep.byStatus.PROFILE_NOT_AVAILABLE, rep.byStatus.PROFILE_PERMISSION_DENIED], [1, 1, 1]);
  assert.deepEqual(rep.metaErrorCodes, { "#230": 1 });
  assert.deepEqual(rep.pancakeOutcome, { TOKENIZED_URL: 1, "CHƯA_THẤY_PAYLOAD": 1 });
  assert.deepEqual(rep.link, { facebook: 0, internal: 2, none: 1, byReason: { ONLY_PAGE_SCOPED_ID: 2, NO_CUSTOMER_PROFILE: 1 } }, "PSID / fb_id ⇒ không bao giờ link Facebook");
  assert.deepEqual(rep.fbIdVsThreadPsid, { equal: 1, different: 1, threadNotPsidShaped: 0 }, "fb_id trùng PSID của mã hội thoại = bằng chứng fb_id là mã theo page");
  assert.equal(rep.linkedFbId.DIGITS_LONG, 1);
  assert.equal(rep.linkedConversationLink.URL_PANCAKE, 1);
  assert.ok(!JSON.stringify(rep).includes(PSID), "báo cáo không mang giá trị mã nào");
  console.log("  ✓ ops inbox-avatar-audit: đếm dạng không lộ giá trị · so fb_id ↔ PSID mã hội thoại · link chỉ về hồ sơ nội bộ");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

function testSource() {
  // Không chỗ nào ghép `facebook.com/` (hay fb.com/) với PSID / mã theo page / mã luồng / mã khách.
  const ID = String.raw`(psid|fbId|fb_id|fbIds|threadId|thread_id|senderId|sender_id|fromId|from_id|from_psid|visitorKey|customerId|customer_id)`;
  const tpl = new RegExp(String.raw`(facebook|fb)\.com/[^\x60"'\n]*\$\{[^}]*\b${ID}\b`, "i");
  const cat = new RegExp(String.raw`(facebook|fb)\.com/?["'\x60]\s*\+\s*[\w.?]*\b${ID}\b`, "i");
  const files = ["lib", "app", "components", "scripts"].flatMap((d) => walk(d));
  const bad = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return tpl.test(src) || cat.test(src);
  });
  assert.deepEqual(bad, [], "không tệp nào dựng link Facebook từ PSID / mã theo page");
  assert.ok(files.length > 500, `quét đủ mã nguồn (${files.length} tệp)`);
  const profile = readFileSync("lib/sales-chatbot/avatar-profile.ts", "utf8");
  assert.equal((profile.match(/https:\/\/www\.facebook\.com\//g) ?? []).length, 1, "lõi chỉ dựng một dạng link: profile.php?id= cho mã công khai đã xác minh");
  assert.doesNotMatch(profile, /from "@\/(db|lib\/(?!sales-chatbot\/avatar-profile))/, "lõi thuần: không import máy chủ");
  const cust = readFileSync("app/(dashboard)/customers/[id]/page.tsx", "utf8");
  assert.doesNotMatch(cust, /facebook\.com\/\$\{customer\.fbId\}/, "hồ sơ khách không còn dựng facebook.com/<fb_id>");
  assert.match(cust, /facebookProfileHrefOf\(\{ ids: \[\{ value: customer\.fbId, source: "PANCAKE_CUSTOMER_FB_ID" \}\] \}\)/);

  // Link ngoài mở tab mới, không với ngược cửa sổ ERP.
  const av = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/avatar.tsx", "utf8");
  assert.match(av, /target="_blank" rel="noopener noreferrer"/);
  assert.match(av, /avatarLinkTitle\(link\)/, "câu rê chuột nói rõ «Mở trang Facebook» / «Mở hồ sơ khách»");
  const tv = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/thread-view.tsx", "utf8");
  assert.match(tv, /<AvatarLinkWrap link=\{avatarHref\}/, "ảnh đầu hội thoại đi qua AvatarLinkWrap");

  // Đường ghi Pancake: cùng một lõi, cùng câu UPDATE của noteCustomerArrived.
  const fp = readFileSync("lib/sales-chatbot/fanpage.ts", "utf8");
  assert.match(fp, /noteCustomerArrived\(ev\.pageId, ev\.threadId, now, ev\.avatar\)/);
  assert.match(fp, /pancakeAvatarFactsOf\(c, "POLL"\)/, "lượt quét lại mang ảnh của danh sách hội thoại");
  const hs = readFileSync("lib/sales-chatbot/history.ts", "utf8");
  assert.match(hs, /return pancakeAvatarFactsOf\(conv\)\.url;/, "lượt nhập lịch sử dùng CÙNG lõi");
  assert.match(hs, /pancakeAvatarPatch\(st, /);

  // Lấp dần Meta: không trong đường trả lời, không lịch, không fan-out.
  const ms = readFileSync("lib/sales-chatbot/messenger.ts", "utf8");
  const reply = ms.slice(ms.indexOf("export async function processMessengerThread("), ms.indexOf("export async function processMessengerThreadDebounced("));
  assert.ok(reply.length > 100 && !/refreshMessengerProfile|backfillMessengerProfiles/.test(reply), "đường trả lời không hỏi hồ sơ");
  for (const f of ["lib/sales-chatbot/fanpage.ts", "lib/sales-chatbot/engine.ts"]) assert.doesNotMatch(readFileSync(f, "utf8"), /backfillMessengerProfiles/, `${f} không gọi lượt lấp dần`);
  assert.doesNotMatch(readFileSync("scripts/scheduler.mjs", "utf8"), /messenger-profile-backfill/, "lượt lấp dần KHÔNG có lịch (đổi lịch cần chủ shop duyệt)");
  assert.doesNotMatch(readFileSync("scripts/scheduler-fanout.mjs", "utf8"), /messenger-profile-backfill/);
  const jobs = readFileSync("lib/sync/jobs.ts", "utf8");
  const job = jobs.slice(jobs.indexOf('"messenger-profile-backfill": {'), jobs.indexOf('"sales-health": {'));
  assert.ok(job.length > 50 && !/fanOut/.test(job), "job chạy tay, không fan-out");
  assert.match(ms, /split\(tk\.token\)\.join\("…"\)/, "câu lỗi Graph che token trước khi lưu");

  // Script ops chỉ đọc + khai đủ bốn chỗ.
  const sc = readFileSync("scripts/inbox-avatar-audit.ts", "utf8");
  assert.match(sc, /process\.env\.ERP_READ_ONLY = "1"/);
  assert.match(sc, /show default_transaction_read_only/);
  assert.doesNotMatch(sc, /\.(insert|update|delete)\(|\binsert into\b|\bupdate \w+ set\b/i, "script không câu ghi");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- inbox-avatar-audit\s+#/, "ops-vps khai lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\binbox-avatar-audit\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\binbox-avatar-audit\b/, "làn ĐỌC nặng");
  assert.match(ops, /inbox-avatar-audit\)\n[\s\S]*?scripts\/inbox-avatar-audit\.ts ;;/, "nhánh chạy");
  console.log(`  ✓ mã nguồn: không ghép facebook.com/ với PSID (${files.length} tệp) · tab mới noopener · lấp dần Meta ngoài đường trả lời, không lịch · ops khai đủ bốn chỗ`);
}

export async function testInboxAvatarProfile() {
  console.log("Ảnh đại diện + link Facebook (inbox-avatar-profile):");
  testFacebookHref();
  testAvatarStatus();
  testPancakeWritePath();
  testAuditPure();
  testSource();
}
