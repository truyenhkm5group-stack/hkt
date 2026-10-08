/**
 * ═══════════ TRẦN TẦN SUẤT CỦA CHAT CÔNG KHAI (`/chat` · `/chat/embed`) ═══════════
 *
 * Trang chat công khai và ô chat nhúng không cần đăng nhập; mỗi tin là một lượt AI. Cổng `lib/sales-chatbot/public-chat-limits.ts`
 * (ngưỡng + lý do ở `lib/constants/public-chat-limits.ts`, phép tính xô ở `lib/rate-limit.ts`) áp trần theo KHÁCH · IP · TỔ
 * CHỨC trước mọi lượt đọc / ghi của tổ chức. Bài này đòi:
 *  1. Xô lượt THUẦN, đồng hồ DỰNG (AGENTS.md mục 50 · 65 — không chờ, không đọc đồng hồ thật): đúng `burst`, đúng thời gian chờ,
 *     gửi đúng nhịp không bao giờ chạm trần, đồng hồ lùi không cộng lượt; TẤT CẢ HOẶC KHÔNG; kho có trần và không bao giờ xoá
 *     trần của chính kẻ đang dội.
 *  2. Khoá IP: chỉ IP công khai; nội bộ / cổng docker / loopback / 100.64 ⇒ bỏ chiều IP; IPv6 gom /64; IPv4 trong IPv6 quy về
 *     IPv4; phần client tự khai bên trái `X-Forwarded-For` không đổi được khoá.
 *  3. KHÁCH THẬT KHÔNG BỊ CHẶN NHẦM, chạy trên NGƯỠNG THẬT: 30 tin mỗi 5 giây · gõ dồn · tải lại trang · mở chat trên 30 trang ·
 *     10 khách chung một IP nhắn liên tục · 40 khách cùng lúc ở một shop · livestream 120 khách mở chat cùng lúc.
 *  4. BÃO BỊ CHẶN: một khách gửi dồn · một máy xoay cookie · bão phân tán ⇒ đúng chiều, đúng câu; lượt bị chặn không trừ xô
 *     của người khác; IP không tin được không thành một xô chung.
 *  5. Lõi THẬT trên hai tổ chức THẬT `pcl-a` / `pcl-b` (tự cấp, tự dọn; provider AI giả, không mạng): vượt trần ⇒ KHÔNG gọi AI,
 *     KHÔNG ghi tin, KHÔNG tạo hội thoại, KHÔNG dòng sổ AI; lõi trừ đúng xô của cổng; hai tổ chức không chia chung trần; khách
 *     thật 30 tin / 5 giây qua lõi không bị chặn; khung chat tự đọc lại hội thoại (kể cả lúc shop đang bị bão) mà không tạo gì.
 *  6. Hợp đồng nguồn: action đọc IP bằng `clientIpFrom` (phần Caddy ghi), không đọc X-Real-IP; cổng đứng TRƯỚC lượt đọc CSDL;
 *     khung chat tự làm mới bằng `refreshPublicChatAction`, không bằng `startPublicChatAction` (trước đây mỗi 15 giây một hội
 *     thoại rác cho mỗi tab đang mở).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { AiProvider, AiResponse } from "@/lib/ai/provider";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { invalidateSubscriptions } from "@/lib/billing/standing";
import { PUBLIC_CHAT_LIMIT_MESSAGES, PUBLIC_CHAT_LIMITS, type PublicChatAction } from "@/lib/constants/public-chat-limits";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { setRequestHostSlugForTests } from "@/lib/platform/host-org";
import { invalidateOrgFlags } from "@/lib/platform/org-flags";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { resetAiCustomerSeenForTests } from "@/lib/pricing/ai-customer";
import { invalidateAiEntitlement } from "@/lib/pricing/ai-gate";
import { invalidatePricing } from "@/lib/pricing/entitlements";
import { invalidatePriceBook } from "@/lib/pricing/price-book";
import { admit, pruneBuckets, rateLimitIpKey, takeAll, type BucketRule } from "@/lib/rate-limit";
import { DEFAULT_SALES_CHATBOT_CONFIG, SALES_CHATBOT_LIMITS, SALES_CHATBOT_SETTING_KEY } from "@/lib/sales-chatbot/config";
import { setSalesChatProviderForTests, TURN_NO_CONVERSATION_ERROR, visitorKeyOf } from "@/lib/sales-chatbot/engine";
import { refreshPublicChat, sendPublicChat, startPublicChat } from "@/lib/sales-chatbot/public";
import { publicChatGate, publicChatLimitKeyCount, resetPublicChatLimitsForTests, setPublicChatClockForTests, type PublicChatGate } from "@/lib/sales-chatbot/public-chat-limits";
import { setSettingJson } from "@/lib/settings";

/** Mốc của ĐỒNG HỒ DỰNG (mili giây) — không phải một ngày lịch; cổng không đọc đồng hồ nào khác ngoài đồng hồ được tiêm. */
const T0 = 10_000_000;
const SEC = 1_000;
const MIN = 60_000;

const vkOf = (tag: string) => visitorKeyOf(`pcl-${tag}-xxxxxxxxxxxxxxxxxxxxxxxx`);
/** IP công khai thứ `i` (11.0.0.0/8 — có định tuyến công khai, không rơi vào dải nội bộ nào). */
const ipOf = (i: number) => `11.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

// ─────────────────────────── 1 · XÔ LƯỢT THUẦN ───────────────────────────

function testBucketMath() {
  const R: BucketRule = { burst: 3, refillMs: SEC };
  let f: number | undefined;
  for (let i = 0; i < 3; i++) {
    const a = admit(f, R, T0);
    assert.ok(a.ok, `lượt ${i + 1}/3 cùng một mốc phải vào`);
    f = a.fullAt;
  }
  assert.deepEqual(admit(f, R, T0), { ok: false, retryAfterMs: SEC }, "lượt thứ 4 cùng mốc bị chặn, chờ đúng một nhịp");
  assert.equal(admit(f, R, T0 + SEC - 1).ok, false, "chờ thiếu 1 ms ⇒ vẫn chặn");
  const one = admit(f, R, T0 + SEC);
  assert.ok(one.ok, "chờ đúng một nhịp ⇒ vào");
  assert.equal(admit(one.fullAt, R, T0 + SEC).ok, false, "…và chỉ ĐÚNG MỘT lượt");
  // Gửi đều đúng nhịp: bao nhiêu lượt cũng không chạm trần.
  let g: number | undefined;
  for (let i = 0; i < 1_000; i++) {
    const a = admit(g, R, T0 + i * SEC);
    assert.ok(a.ok, `gửi đúng nhịp, lượt ${i + 1}`);
    g = a.fullAt;
  }
  // Đồng hồ lùi (chỉnh giờ máy) không được tính là đã chờ.
  let h: number | undefined;
  for (let i = 0; i < 3; i++) {
    const a = admit(h, R, T0);
    if (a.ok) h = a.fullAt;
  }
  assert.equal(admit(h, R, T0 - 10 * MIN).ok, false, "đồng hồ lùi 10 phút không cộng lượt nào");
}

function testTakeAll() {
  const store = new Map<string, number>();
  const visitor = (key: string) => ({ key, rule: { burst: 1, refillMs: 10 * SEC }, scope: "visitor" as const });
  const org = { key: "org", rule: { burst: 5, refillMs: 10 * SEC }, scope: "org" as const };
  assert.ok(takeAll(store, [visitor("a"), org], T0, 100).ok);
  const orgAfterOne = store.get("org");
  for (let i = 0; i < 50; i++) {
    const r = takeAll(store, [visitor("a"), org], T0, 100);
    assert.ok(!r.ok && r.scope === "visitor", "khách «a» đã cạn xô ⇒ chặn theo khách");
  }
  assert.equal(store.get("org"), orgAfterOne, "50 lượt bị chặn ở xô khách KHÔNG trừ xô tổ chức (tất cả hoặc không)");
  assert.ok(takeAll(store, [visitor("b"), org], T0, 100).ok, "khách khác vẫn gửi được");
  // Cạn xô tổ chức ⇒ lượt bị chặn không tạo khoá mới, không trừ xô khách.
  for (let i = 0; i < 3; i++) assert.ok(takeAll(store, [visitor(`c${i}`), org], T0, 100).ok);
  const r = takeAll(store, [visitor("moi"), org], T0, 100);
  assert.ok(!r.ok && r.scope === "org", "xô tổ chức cạn ⇒ chặn theo tổ chức");
  assert.equal(store.has("moi"), false, "lượt bị chặn không tạo khoá mới trong kho");
  // Hai xô cùng cạn ⇒ báo xô phải chờ LÂU NHẤT.
  const s2 = new Map<string, number>();
  const slow = { key: "slow", rule: { burst: 1, refillMs: 10 * SEC }, scope: "visitor" as const };
  const fast = { key: "fast", rule: { burst: 1, refillMs: SEC }, scope: "org" as const };
  assert.ok(takeAll(s2, [slow, fast], T0, 100).ok);
  assert.deepEqual(takeAll(s2, [slow, fast], T0, 100), { ok: false, scope: "visitor", retryAfterMs: 10 * SEC });
}

function testPrune() {
  // Lượt 1: xô đã đầy lại bị dọn trước — không mất thông tin gì.
  const s = new Map<string, number>([
    ["da-day-1", T0 - 1],
    ["da-day-2", T0],
    ["con-han", T0 + 5 * SEC],
  ]);
  pruneBuckets(s, T0, 2);
  assert.deepEqual([...s.keys()], ["con-han"], "chỉ xô đã đầy lại bị dọn khi còn chỗ");
  // Lượt 2: lũ khoá mới (đang có bão) ⇒ kho không vượt trần, và khoá ĐANG BỊ DỘI không bao giờ bị dọn mất.
  const MAX = 10;
  const kho = new Map<string, number>();
  const R = { burst: 1, refillMs: MIN };
  const doi = { key: "ke-doi", rule: R, scope: "ip" as const };
  assert.ok(takeAll(kho, [doi], T0, MAX).ok, "lượt đầu của kẻ dội vào");
  for (let i = 0; i < 1_000; i++) {
    takeAll(kho, [{ key: `rac-${i}`, rule: R, scope: "ip" as const }], T0, MAX);
    assert.ok(kho.size <= MAX, `kho không vượt trần (${kho.size})`);
    assert.equal(takeAll(kho, [doi], T0, MAX).ok, false, `kẻ dội vẫn bị chặn sau ${i + 1} khoá rác`);
  }
}

// ─────────────────────────── 2 · KHOÁ IP ───────────────────────────

function testIpKey() {
  const cases: [string | null | undefined, string | null][] = [
    ["203.0.113.9", "4:203.0.113.9"],
    ["8.8.8.8", "4:8.8.8.8"],
    ["unknown", null],
    [null, null],
    [undefined, null],
    ["", null],
    ["deadbeef", null],
    ["1.2.3", null],
    ["256.1.1.1", null],
    ["1.2.3.4.5", null],
    ["10.0.0.1", null],
    ["172.18.0.1", null],
    ["172.16.0.1", null],
    ["172.31.255.255", null],
    ["172.15.0.1", "4:172.15.0.1"],
    ["172.32.0.1", "4:172.32.0.1"],
    ["192.168.1.10", null],
    ["127.0.0.1", null],
    ["169.254.1.1", null],
    ["100.64.0.1", null],
    ["100.127.255.255", null],
    ["100.63.0.1", "4:100.63.0.1"],
    ["100.128.0.1", "4:100.128.0.1"],
    ["0.0.0.0", null],
    ["224.0.0.1", null],
    ["255.255.255.255", null],
    ["::1", null],
    ["::", null],
    ["fe80::1", null],
    ["fd00::1", null],
    ["fc00::1", null],
    ["ff02::1", null],
    ["::ffff:203.0.113.9", "4:203.0.113.9"],
    ["::ffff:cb00:7109", "4:203.0.113.9"],
    ["::ffff:10.0.0.1", null],
    ["::ffff:127.0.0.1", null],
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "6:2001:db8:1:2::/64"],
    ["2001:DB8:1:2::1", "6:2001:db8:1:2::/64"],
    ["2001:db8::1", "6:2001:db8:0:0::/64"],
    ["1:2:3:4:5:6:1.2.3.4", "6:1:2:3:4::/64"],
    ["1:2:3:4:5:6:7:8:9", null],
    ["1::2::3", null],
    ["12345::1", null],
    [":1:2:3:4:5:6:7", null],
    ["1.2.3.4::", null],
  ];
  for (const [ip, want] of cases) assert.equal(rateLimitIpKey(ip), want, `rateLimitIpKey(${JSON.stringify(ip)})`);
  assert.equal(rateLimitIpKey("2001:db8:1:2::aaaa"), rateLimitIpKey("2001:db8:1:2:ffff:1:2:3"), "cùng dải /64 ⇒ cùng khoá (đổi 64 bit cuối không né được trần)");
  assert.notEqual(rateLimitIpKey("2001:db8:1:2::1"), rateLimitIpKey("2001:db8:1:3::1"), "khác dải /64 ⇒ khác khoá");
  // Ghép với bộ đọc IP của màn đăng nhập: phần client tự khai bên TRÁI không đổi được khoá.
  assert.equal(rateLimitIpKey(clientIpFrom("6.6.6.6, 203.0.113.9")), "4:203.0.113.9", "khoá là IP Caddy ghi (bên phải), không phải phần client khai");
  assert.equal(rateLimitIpKey(clientIpFrom(null)), null, "không có header (chạy dev, không qua Caddy) ⇒ bỏ chiều IP");
}

// ─────────────────────────── 3 · KHÁCH THẬT KHÔNG BỊ CHẶN NHẦM (ngưỡng THẬT) ───────────────────────────

type Ev = { at: number; action: PublicChatAction; visitorKey: string | null; ip: string | null; org?: string };

/** Chạy các lượt theo đúng thứ tự thời gian qua CỔNG THẬT (`publicChatGate`, ngưỡng thật), đồng hồ dựng. */
function play(events: Ev[], org = "pcl-sim"): { ev: Ev; r: PublicChatGate }[] {
  return [...events].sort((a, b) => a.at - b.at).map((ev) => ({ ev, r: publicChatGate({ action: ev.action, orgCode: ev.org ?? org, visitorKey: ev.visitorKey, ip: ev.ip }, ev.at) }));
}

function assertAllPass(name: string, events: Ev[]) {
  resetPublicChatLimitsForTests();
  const out = play(events);
  const bad = out.filter((x) => !x.r.ok);
  assert.equal(bad.length, 0, `${name}: ${bad.length}/${out.length} lượt bị chặn nhầm — lượt đầu tiên ở +${bad.length ? (bad[0].ev.at - T0) / SEC : 0}s, ${bad.length && !bad[0].r.ok ? bad[0].r.scope : ""}`);
}

function testRealCustomers() {
  const ip = "203.0.113.10";
  // Một khách nhắn 30 tin, mỗi tin cách 5 giây (và cách 10 giây) — rồi cả MỘT HỘI THOẠI ĐẦY (engine chuyển người sau
  // `turnsPerConversation` lượt) ở nhịp 5 giây: ngưỡng khai "gửi đều 1 tin / 5 giây thì không bao giờ chạm trần" phải đúng thật,
  // không chỉ nhờ mạch dồn `burst` che đi (đột biến «1 tin / 10 giây» vẫn qua được 30 tin nhờ mạch dồn).
  for (const [gap, n] of [
    [5 * SEC, 30],
    [10 * SEC, 30],
    [5 * SEC, SALES_CHATBOT_LIMITS.turnsPerConversation],
  ] as const) {
    const vk = vkOf(`that-${gap}-${n}`);
    assertAllPass(`khách thật ${n} tin / ${gap / SEC} giây`, [{ at: T0, action: "start", visitorKey: vk, ip }, ...Array.from({ length: n }, (_, i) => ({ at: T0 + (i + 1) * gap, action: "send" as const, visitorKey: vk, ip }))]);
  }
  // Gõ dồn: 8 tin trong 4 giây («alo» · «shop ơi» · …), rồi 22 tin mỗi 6 giây.
  const burstVk = vkOf("go-don");
  assertAllPass("khách gõ dồn rồi nhắn đều", [
    { at: T0, action: "start", visitorKey: burstVk, ip },
    ...Array.from({ length: 8 }, (_, i) => ({ at: T0 + SEC + i * 500, action: "send" as const, visitorKey: burstVk, ip })),
    ...Array.from({ length: 22 }, (_, i) => ({ at: T0 + 10 * SEC + i * 6 * SEC, action: "send" as const, visitorKey: burstVk, ip })),
  ]);
  // Cổng không bao giờ chặn sớm hơn trần cũ của engine (vượt nó thì bot IM nhưng tin VẪN GHI — quyết định 05/10/2026).
  assert.ok(PUBLIC_CHAT_LIMITS.send.visitor.burst >= SALES_CHATBOT_LIMITS.webMessagesPerVisitorPer10Min, "khách gửi dồn đủ trần cũ của engine trong một mạch vẫn qua cổng");
  const vkEngine = vkOf("tran-cu");
  assertAllPass("dồn đúng trần cũ của engine", Array.from({ length: SALES_CHATBOT_LIMITS.webMessagesPerVisitorPer10Min }, () => ({ at: T0, action: "send" as const, visitorKey: vkEngine, ip })));
  // Tải lại trang 6 lần trong 2 phút + bấm «Hội thoại mới» 2 lần.
  const reload = vkOf("tai-lai");
  assertAllPass("tải lại trang + hội thoại mới", Array.from({ length: 8 }, (_, i) => ({ at: T0 + i * 15 * SEC, action: "start" as const, visitorKey: reload, ip })));
  // Mở ô chat trên 30 trang sản phẩm liền nhau, mỗi trang chừng 11 giây.
  const browse = vkOf("xem-trang");
  assertAllPass("mở chat trên 30 trang sản phẩm", Array.from({ length: 30 }, (_, i) => ({ at: T0 + i * 11 * SEC, action: "start" as const, visitorKey: browse, ip })));
  // 10 khách CHUNG MỘT IP (CGNAT / Wi-Fi quán) nhắn liên tục, mỗi người một tin / 20 giây, suốt 30 phút.
  const shared = "198.51.100.77";
  assertAllPass(
    "10 khách chung một IP",
    Array.from({ length: 10 }, (_, k) => {
      const vk = vkOf(`chung-ip-${k}`);
      return [{ at: T0 + k * SEC, action: "start" as const, visitorKey: vk, ip: shared }, ...Array.from({ length: 90 }, (_, i) => ({ at: T0 + k * 2 * SEC + (i + 1) * 20 * SEC, action: "send" as const, visitorKey: vk, ip: shared }))];
    }).flat(),
  );
  // 40 bàn của một quán (cùng Wi-Fi) mở chat trong cùng một phút.
  assertAllPass(
    "40 bàn mở chat cùng lúc",
    Array.from({ length: 40 }, (_, k) => ({ at: T0 + k * 1_500, action: "start" as const, visitorKey: vkOf(`ban-${k}`), ip: shared })),
  );
  // Shop đông: 40 khách (40 IP) nhắn cùng lúc, mỗi người một tin / 20 giây, suốt 30 phút.
  assertAllPass(
    "40 khách cùng lúc ở một shop",
    Array.from({ length: 40 }, (_, k) => {
      const vk = vkOf(`dong-${k}`);
      return Array.from({ length: 90 }, (_, i) => ({ at: T0 + k * 500 + i * 20 * SEC, action: "send" as const, visitorKey: vk, ip: ipOf(1_000 + k) }));
    }).flat(),
  );
  // Livestream: 120 khách mở chat trong 10 giây, rồi mỗi người gửi một tin trong 30 giây sau đó.
  assertAllPass(
    "livestream 120 khách",
    Array.from({ length: 120 }, (_, k) => [
      { at: T0 + Math.floor((k * 10 * SEC) / 120), action: "start" as const, visitorKey: vkOf(`live-${k}`), ip: ipOf(2_000 + k) },
      { at: T0 + 10 * SEC + Math.floor((k * 30 * SEC) / 120), action: "send" as const, visitorKey: vkOf(`live-${k}`), ip: ipOf(2_000 + k) },
    ]).flat(),
  );
}

// ─────────────────────────── 4 · BÃO BỊ CHẶN ───────────────────────────

function countOk(out: { r: PublicChatGate }[]): number {
  return out.filter((x) => x.r.ok).length;
}

function testStorms() {
  const L = PUBLIC_CHAT_LIMITS;
  // (a) Một khách gửi dồn 10 tin / giây trong 60 giây.
  resetPublicChatLimitsForTests();
  const spam = vkOf("spam");
  const a = play(Array.from({ length: 600 }, (_, i) => ({ at: T0 + i * 100, action: "send" as const, visitorKey: spam, ip: "203.0.113.50" })));
  const aOk = countOk(a);
  assert.ok(aOk >= L.send.visitor.burst && aOk <= L.send.visitor.burst + Math.floor(MIN / L.send.visitor.refillMs) + 1, `một khách gửi dồn: lọt ${aOk} lượt`);
  assert.ok(a.every((x) => x.r.ok || (x.r.scope === "visitor" && x.r.error === PUBLIC_CHAT_LIMIT_MESSAGES.tooFastSend)), "chặn theo KHÁCH, câu «gửi nhanh quá»");
  // 568 lượt bị chặn không trừ xô tổ chức: ngay sau đó 200 khách khác (200 IP) vẫn gửi được cùng lúc.
  const after = play(Array.from({ length: 200 }, (_, i) => ({ at: T0 + MIN, action: "send" as const, visitorKey: vkOf(`sau-spam-${i}`), ip: ipOf(3_000 + i) })));
  assert.equal(countOk(after), 200, "lượt bị chặn của kẻ gửi dồn không làm cạn xô của cả shop");

  // (b) Một máy xoay cookie: mỗi lượt một khách mới, 10 lượt / giây trong 60 giây, cùng một IP.
  resetPublicChatLimitsForTests();
  const b = play(Array.from({ length: 600 }, (_, i) => ({ at: T0 + i * 100, action: "send" as const, visitorKey: vkOf(`xoay-${i}`), ip: "203.0.113.60" })));
  const bOk = countOk(b);
  assert.ok(bOk >= L.send.ip.burst && bOk <= L.send.ip.burst + Math.floor(MIN / L.send.ip.refillMs) + 1, `một máy xoay cookie: lọt ${bOk} lượt`);
  assert.ok(b.every((x) => x.r.ok || (x.r.scope === "ip" && x.r.error === PUBLIC_CHAT_LIMIT_MESSAGES.tooFastSend)), "chặn theo IP, câu «gửi nhanh quá»");
  assert.ok(publicChatGate({ action: "send", orgCode: "pcl-sim", visitorKey: vkOf("ip-khac"), ip: "203.0.113.61" }, T0 + MIN).ok, "khách ở IP khác không bị vạ lây");
  // Cùng máy đó MỞ hội thoại liên tục.
  resetPublicChatLimitsForTests();
  const bs = play(Array.from({ length: 600 }, (_, i) => ({ at: T0 + i * 100, action: "start" as const, visitorKey: vkOf(`mo-${i}`), ip: "203.0.113.62" })));
  const bsOk = countOk(bs);
  assert.ok(bsOk >= L.start.ip.burst && bsOk <= L.start.ip.burst + Math.floor(MIN / L.start.ip.refillMs) + 1, `một máy mở hội thoại liên tục: lọt ${bsOk} lượt`);
  assert.ok(bs.every((x) => x.r.ok || (x.r.scope === "ip" && x.r.error === PUBLIC_CHAT_LIMIT_MESSAGES.tooFastStart)), "chặn theo IP, câu «mở chat nhanh quá»");

  // (c) Bão phân tán: mỗi lượt một khách mới + một IP mới, 50 lượt / giây trong 60 giây.
  resetPublicChatLimitsForTests();
  const c = play(Array.from({ length: 3_000 }, (_, i) => ({ at: T0 + i * 20, action: "send" as const, visitorKey: vkOf(`bao-${i}`), ip: ipOf(10_000 + i) })));
  const cOk = countOk(c);
  assert.ok(cOk >= L.send.org.burst && cOk <= L.send.org.burst + Math.floor(MIN / L.send.org.refillMs) + 1, `bão phân tán: lọt ${cOk} lượt`);
  assert.ok(c.every((x) => x.r.ok || (x.r.scope === "org" && x.r.error === PUBLIC_CHAT_LIMIT_MESSAGES.shopBusy)), "chặn theo TỔ CHỨC, câu «shop đang nhận quá nhiều tin»");
  // (d) Hai tổ chức không chia chung trần: đúng các khách + IP đó vào shop KHÁC ⇒ qua hết.
  const d = play(Array.from({ length: 200 }, (_, i) => ({ at: T0 + MIN, action: "send" as const, visitorKey: vkOf(`bao-${i}`), ip: ipOf(10_000 + i), org: "pcl-sim-khac" })));
  assert.equal(countOk(d), 200, "shop B không bị bão của shop A làm cạn xô");

  // (e) IP không tin được (cổng docker / không có / nội bộ) KHÔNG thành một xô chung: 100 khách cùng lúc đều qua; cùng 100 khách
  //     ấy từ MỘT IP công khai thì xô IP chặn ở đúng `burst`.
  for (const untrusted of ["172.18.0.1", "unknown", "::ffff:10.1.2.3", null]) {
    resetPublicChatLimitsForTests();
    const e = play(Array.from({ length: 100 }, (_, i) => ({ at: T0, action: "send" as const, visitorKey: vkOf(`docker-${i}`), ip: untrusted })));
    assert.equal(countOk(e), 100, `IP ${JSON.stringify(untrusted)} không tin được ⇒ bỏ chiều IP, không chặn mù`);
  }
  resetPublicChatLimitsForTests();
  const pub = play(Array.from({ length: 100 }, (_, i) => ({ at: T0, action: "send" as const, visitorKey: vkOf(`cong-khai-${i}`), ip: "203.0.113.70" })));
  assert.equal(countOk(pub), L.send.ip.burst, "IP công khai ⇒ xô IP chặn ở đúng `burst`");

  // (f) Kho có trần ngay cả khi bão rải khắp 500 shop (mỗi lượt được vào sinh hai khoá mới — khách + IP): ~60.000 khoá đòi chỗ.
  resetPublicChatLimitsForTests();
  const f = play(Array.from({ length: 30_000 }, (_, i) => ({ at: T0 + i * 10, action: "start" as const, visitorKey: vkOf(`tran-kho-${i}`), ip: ipOf(100_000 + i), org: `pcl-sim-${i % 500}` })));
  assert.ok(countOk(f) * 2 > PUBLIC_CHAT_LIMITS.maxKeys, `phải đòi quá trần kho mới đo được trần (${countOk(f)} lượt vào)`);
  assert.ok(publicChatLimitKeyCount() <= PUBLIC_CHAT_LIMITS.maxKeys, `kho giữ ${publicChatLimitKeyCount()} khoá, trần ${PUBLIC_CHAT_LIMITS.maxKeys}`);
  resetPublicChatLimitsForTests();
}

// ─────────────────────────── 5 · NGƯỠNG + CÂU KHÁCH THẤY + HỢP ĐỒNG NGUỒN ───────────────────────────

function testConstantsAndSource() {
  const L = PUBLIC_CHAT_LIMITS;
  const perMin = (r: BucketRule) => MIN / r.refillMs;
  for (const action of ["start", "send"] as const) {
    for (const scope of ["visitor", "ip", "org"] as const) {
      const r = L[action][scope];
      assert.ok(Number.isInteger(r.burst) && r.burst >= 1 && Number.isInteger(r.refillMs) && r.refillMs > 0, `${action}.${scope} hợp lệ`);
    }
    // Mỗi tầng gom nhiều người hơn tầng dưới ⇒ phải rộng hơn (cả mạch dồn lẫn nhịp bền vững).
    assert.ok(L[action].visitor.burst <= L[action].ip.burst && L[action].ip.burst <= L[action].org.burst, `${action}: burst khách ≤ IP ≤ tổ chức`);
    assert.ok(perMin(L[action].visitor) < perMin(L[action].ip) && perMin(L[action].ip) < perMin(L[action].org), `${action}: nhịp khách < IP < tổ chức`);
  }
  for (const m of Object.values(PUBLIC_CHAT_LIMIT_MESSAGES)) {
    assert.ok(!/\bIP\b|\d|rate|limit|429|token|bucket|xô|trần/i.test(m), `câu khách thấy không lộ chi tiết kỹ thuật: «${m}»`);
  }

  const action = readFileSync("lib/actions/public-chat.ts", "utf8");
  assert.match(action, /clientIpFrom\(\(await headers\(\)\)\.get\("x-forwarded-for"\)\)/, "IP đọc bằng clientIpFrom — phần Caddy ghi, cùng cách màn đăng nhập");
  const actionCode = action.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/x-real-ip/i.test(actionCode), "X-Real-IP đi thẳng từ client (Caddy không đặt nó) — không được đọc");
  assert.match(action, /startPublicChat\(await visitorKey\(true\), \{ ip: await requestIp\(\) \}\)/, "mở hội thoại mang IP vào cổng");
  assert.match(action, /sendPublicChat\(key, [^\n]*\{ ip: await requestIp\(\) \}\)/, "gửi tin mang IP vào cổng");

  const core = readFileSync("lib/sales-chatbot/public.ts", "utf8");
  const start = core.indexOf("async function inHostOrg");
  const end = core.indexOf("export type PublicChatOpened");
  assert.ok(start >= 0 && end > start, "tìm thấy inHostOrg");
  const inHost = core.slice(start, end);
  const gateAt = inHost.indexOf("publicChatGate(");
  assert.ok(gateAt >= 0 && gateAt < inHost.indexOf("withOrganization("), "cổng đứng TRƯỚC mọi lượt đọc / ghi CSDL của tổ chức");

  const panel = readFileSync("components/sales-chat/chat-panel.tsx", "utf8");
  const pollAt = panel.indexOf("window.setInterval(");
  const pollEnd = panel.indexOf("15_000", pollAt);
  assert.ok(pollAt >= 0 && pollEnd > pollAt, "tìm thấy vòng tự làm mới của khung chat");
  const poll = panel.slice(pollAt, pollEnd);
  assert.ok(poll.includes("refreshPublicChatAction(") && !poll.includes("startPublicChatAction("), "khung chat tự ĐỌC LẠI hội thoại, không MỞ hội thoại mới mỗi 15 giây");
  // Tin bị cổng chặn KHÔNG được ghi ⇒ khung chat phải gỡ bong bóng tạm và trả chữ về ô nhập (không để khách tưởng tin đã đi).
  const sendAt = panel.indexOf("const send = () =>");
  assert.ok(sendAt >= 0, "tìm thấy hàm gửi của khung chat");
  const send = panel.slice(sendAt, panel.indexOf("return (", sendAt));
  assert.match(send, /else if \(mode === "public"\) \{[^}]*setView\(view\);[^}]*setText\(\(cur\) => cur \|\| t\);/, "lỗi không kèm hội thoại ở trang công khai ⇒ gỡ bong bóng + trả chữ về ô nhập");
}

// ─────────────────────────── 6 · LÕI THẬT TRÊN HAI TỔ CHỨC THẬT ───────────────────────────

const A = "pcl-a";
const B = "pcl-b";
const ORGS = [A, B] as const;
const SLUG: Record<(typeof ORGS)[number], string> = { [A]: "pcl-a-shop", [B]: "pcl-b-shop" };

async function cleanupOrgs() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformUsageEvents).where(inArray(schema.platformUsageEvents.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiUsage).where(inArray(schema.platformAiUsage.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiLedgerEntries).where(inArray(schema.platformAiLedgerEntries.orgCode, [...ORGS]));
  await pdb.delete(schema.platformAiAccounts).where(inArray(schema.platformAiAccounts.orgCode, [...ORGS]));
  await pdb.delete(schema.platformPricePins).where(inArray(schema.platformPricePins.orgCode, [...ORGS]));
  await pdb.delete(schema.platformSubscriptions).where(inArray(schema.platformSubscriptions.orgCode, [...ORGS]));
  for (const code of ORGS) {
    await pdb.delete(schema.platformProductSubscriptions).where(eq(schema.platformProductSubscriptions.orgCode, code));
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformFlagOverrides).where(eq(schema.platformFlagOverrides.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  await pdb.delete(schema.platformAuditLog).where(inArray(schema.platformAuditLog.targetOrgCode, [...ORGS]));
  invalidateOrganizations();
  invalidateCapabilities();
  invalidateSubscriptions();
  invalidatePricing();
  invalidatePriceBook();
  invalidateAiEntitlement();
  invalidateOrgFlags();
  resetAiCustomerSeenForTests();
}

/** Số hội thoại · số tin của tổ chức + số dòng sổ AI dưới mã của nó. */
async function rowCounts(org: string): Promise<{ conversations: number; messages: number; aiRows: number }> {
  const local = await withOrganization(org, async () => {
    const db = await getDb();
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.salesChatConversations);
    const [m] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.salesChatMessages);
    return { conversations: Number(c?.n ?? 0), messages: Number(m?.n ?? 0) };
  });
  const pdb = await getPlatformDb();
  const [a] = await pdb.select({ n: sql<number>`count(*)::int` }).from(schema.platformAiUsage).where(eq(schema.platformAiUsage.orgCode, org));
  return { ...local, aiRows: Number(a?.n ?? 0) };
}

async function testCore() {
  const L = PUBLIC_CHAT_LIMITS;
  const calls = { n: 0 };
  const provider: AiProvider = {
    name: "fake",
    model: "claude-sonnet-5",
    schemaDialect: "anthropic",
    async complete(): Promise<AiResponse> {
      calls.n += 1;
      return { content: [{ type: "text", text: "Dạ chả cá bên em 280k/kg ạ." }], stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "claude-sonnet-5", latencyMs: 1 };
    },
  };
  await cleanupOrgs();
  for (const code of ORGS) {
    await provisionOrganization({ code, name: `Shop ${code}`, plan: "trial", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "PublicChat@123456" }, source: "TEST", actor: null });
  }
  let clock = T0;
  let host: string = SLUG[A];
  try {
    const pdb = await getPlatformDb();
    for (const code of ORGS) await pdb.update(schema.platformOrganizations).set({ publishState: "PUBLISHED", domainSlug: SLUG[code] }).where(eq(schema.platformOrganizations.code, code));
    invalidateOrganizations();
    // Bài dùng model giả (luật 65 — không mạng) qua đường khoá riêng của shop, như tests/self-service-journey.test.ts.
    for (const code of ORGS) await withOrganization(code, () => setSettingJson(SALES_CHATBOT_SETTING_KEY, { ...DEFAULT_SALES_CHATBOT_CONFIG, connectorKey: "anthropic-byok", enabled: true }));
    setSalesChatProviderForTests(() => provider);
    setPublicChatClockForTests(() => clock);
    setRequestHostSlugForTests(() => host);
    resetPublicChatLimitsForTests();

    // ── 1 · Trong trần: khách mở chat, nhắn ⇒ AI trả lời.
    const IP = "203.0.113.20";
    const vk = vkOf("core-a-1");
    const opened = await startPublicChat(vk, { ip: IP });
    assert.ok("ok" in opened, JSON.stringify(opened));
    const conv = opened.view.conversationId;
    const c0 = calls.n;
    const s1 = await sendPublicChat(vk, conv, "Shop ơi chả cá bao nhiêu?", { ip: IP });
    assert.ok("ok" in s1, JSON.stringify(s1));
    assert.ok(calls.n > c0, "trong trần ⇒ AI trả lời");

    // ── 2 · Lõi trừ ĐÚNG xô của cổng: sau một tin qua lõi, khách này còn đúng `burst − 1` lượt.
    let left = 0;
    while (publicChatGate({ action: "send", orgCode: A, visitorKey: vk, ip: IP }).ok) assert.ok(++left <= L.send.visitor.burst, "xô khách phải cạn");
    assert.equal(left, L.send.visitor.burst - 1, "lượt gửi qua lõi đã trừ đúng xô khách của cổng");

    // ── 3 · Vượt trần theo KHÁCH ⇒ không gọi AI, không ghi tin, không dòng sổ AI.
    const before = await rowCounts(A);
    const cb = calls.n;
    assert.deepEqual(await sendPublicChat(vk, conv, "alo alo shop", { ip: IP }), { error: PUBLIC_CHAT_LIMIT_MESSAGES.tooFastSend });
    assert.equal(calls.n, cb, "vượt trần ⇒ KHÔNG gọi AI");
    assert.deepEqual(await rowCounts(A), before, "vượt trần ⇒ KHÔNG ghi tin, KHÔNG tạo hội thoại, KHÔNG dòng sổ AI");
    // Chờ đúng một nhịp ⇒ khách nhắn tiếp được.
    clock += L.send.visitor.refillMs;
    const again = await sendPublicChat(vk, conv, "Ship Hải Phòng bao lâu?", { ip: IP });
    assert.ok("ok" in again, `chờ một nhịp ⇒ nhắn tiếp được: ${JSON.stringify(again).slice(0, 200)}`);

    // ── 4 · Một máy XOAY COOKIE mở hội thoại ⇒ chặn theo IP, không tạo hội thoại. Hai lượt mở qua lõi trừ đúng xô IP.
    const IP2 = "198.51.100.30";
    for (let i = 0; i < 2; i++) assert.ok("ok" in (await startPublicChat(vkOf(`xoay-core-${i}`), { ip: IP2 })), "lượt mở trong trần");
    let opens = 0;
    for (;;) {
      const g = publicChatGate({ action: "start", orgCode: A, visitorKey: vkOf(`xoay-gate-${opens}`), ip: IP2 });
      if (!g.ok) {
        assert.equal(g.scope, "ip");
        break;
      }
      assert.ok(++opens <= L.start.ip.burst, "xô IP phải cạn");
    }
    assert.equal(opens, L.start.ip.burst - 2, "hai lượt mở qua lõi đã trừ đúng xô IP của cổng");
    const before2 = await rowCounts(A);
    assert.deepEqual(await startPublicChat(vkOf("xoay-moi"), { ip: IP2 }), { error: PUBLIC_CHAT_LIMIT_MESSAGES.tooFastStart });
    assert.deepEqual(await rowCounts(A), before2, "lượt mở bị chặn KHÔNG tạo hội thoại / tin chào");

    // ── 5 · Bão PHÂN TÁN (nhiều IP, nhiều cookie) ⇒ trần TỔ CHỨC, câu nói về shop.
    const vk9 = vkOf("core-a-9");
    const IP9 = "203.0.113.99";
    const o9 = await startPublicChat(vk9, { ip: IP9 });
    assert.ok("ok" in o9, JSON.stringify(o9));
    let storm = 0;
    for (;;) {
      const g = publicChatGate({ action: "send", orgCode: A, visitorKey: vkOf(`bao-core-${storm}`), ip: ipOf(50_000 + storm) });
      if (!g.ok) {
        assert.equal(g.scope, "org");
        break;
      }
      assert.ok(++storm <= L.send.org.burst, "xô tổ chức phải cạn");
    }
    const before3 = await rowCounts(A);
    const cb3 = calls.n;
    assert.deepEqual(await sendPublicChat(vk9, o9.view.conversationId, "Còn hàng không shop?", { ip: IP9 }), { error: PUBLIC_CHAT_LIMIT_MESSAGES.shopBusy });
    assert.equal(calls.n, cb3, "bão ⇒ KHÔNG gọi AI");
    assert.deepEqual(await rowCounts(A), before3, "bão ⇒ KHÔNG ghi gì");

    // ── 6 · Hai tổ chức KHÔNG chia chung trần: shop B, đúng cookie + IP vừa bị chặn ở A ⇒ AI trả lời.
    host = SLUG[B];
    const ob = await startPublicChat(vk, { ip: IP });
    assert.ok("ok" in ob, JSON.stringify(ob));
    const cbB = calls.n;
    const sb = await sendPublicChat(vk, ob.view.conversationId, "Shop ơi chả cá bao nhiêu?", { ip: IP });
    assert.ok("ok" in sb, `shop B không bị trần của shop A chặn: ${JSON.stringify(sb).slice(0, 200)}`);
    assert.ok(calls.n > cbB, "shop B: AI trả lời");
    host = SLUG[A];
    assert.deepEqual(await sendPublicChat(vk9, o9.view.conversationId, "Còn hàng không shop?", { ip: IP9 }), { error: PUBLIC_CHAT_LIMIT_MESSAGES.shopBusy }, "shop A vẫn đang chặn — lượt ở B không mở lại xô của A");

    // ── 7 · Khách thật qua LÕI: 30 tin, mỗi tin cách 5 giây ⇒ không lượt nào bị cổng chặn.
    host = SLUG[B];
    const vkR = vkOf("core-b-that");
    const IPR = "203.0.113.150";
    const oR = await startPublicChat(vkR, { ip: IPR });
    assert.ok("ok" in oR, JSON.stringify(oR));
    const cR = calls.n;
    for (let i = 0; i < 30; i++) {
      clock += 5 * SEC;
      const r = await sendPublicChat(vkR, oR.view.conversationId, `Cho em hỏi thêm câu số ${i + 1}`, { ip: IPR });
      assert.ok("ok" in r, `khách thật, tin ${i + 1}/30 bị chặn nhầm: ${JSON.stringify(r).slice(0, 200)}`);
    }
    assert.ok(calls.n > cR, "khách thật được AI trả lời");

    // ── 8 · Khung chat tự ĐỌC LẠI: cùng hội thoại, thấy tin mới, KHÔNG tạo gì — kể cả lúc shop A đang bị bão (xô gửi đã cạn).
    host = SLUG[A];
    const beforeR = await rowCounts(A);
    const rf = await refreshPublicChat(vk, conv);
    assert.ok("ok" in rf && rf.view.conversationId === conv, `đọc lại đúng hội thoại đang mở: ${JSON.stringify(rf).slice(0, 200)}`);
    assert.ok(rf.view.messages.some((m) => m.text.includes("Ship Hải Phòng")), "đọc lại thấy tin mới nhất");
    assert.ok(rf.view.messages.every((m) => Object.keys(m).every((k) => k === "role" || k === "text")), "bản công khai không mang vết công cụ");
    assert.deepEqual(await rowCounts(A), beforeR, "đọc lại KHÔNG tạo hội thoại / tin nào");
    assert.deepEqual(await refreshPublicChat(vkOf("nguoi-la"), conv), { error: TURN_NO_CONVERSATION_ERROR }, "cookie khác không đọc được hội thoại");
    host = SLUG[B];
    assert.deepEqual(await refreshPublicChat(vk, conv), { error: TURN_NO_CONVERSATION_ERROR }, "host B không đọc được hội thoại của A");
  } finally {
    setSalesChatProviderForTests(null);
    setRequestHostSlugForTests(null);
    setPublicChatClockForTests(null);
    resetPublicChatLimitsForTests();
    await cleanupOrgs();
  }
}

export async function testPublicChatLimits() {
  testBucketMath();
  testTakeAll();
  testPrune();
  testIpKey();
  testRealCustomers();
  testStorms();
  testConstantsAndSource();
  await testCore();
  console.log(
    "✓ Trần tần suất chat công khai: xô lượt thuần (đồng hồ dựng, tất cả hoặc không, kho có trần) · IP chỉ phần Caddy ghi, nội bộ / docker bỏ qua, IPv6 gom /64 · khách thật (30 tin / 5 giây, gõ dồn, 10 khách chung IP, 40 khách cùng lúc, livestream) không bị chặn · khách gửi dồn / máy xoay cookie / bão phân tán bị chặn đúng chiều, đúng câu · lõi thật trên hai tổ chức: vượt trần ⇒ không AI, không ghi, hai shop không chung trần · khung chat tự đọc lại không tạo hội thoại",
  );
}
