/**
 * ═══════════ INBOX-V2-A: BỘ LỌC GỌN · CHƯA ĐỌC TRƯỚC · HÀNG GỌN · ẢNH ĐẠI DIỆN KHÔNG LINK GIẢ (chủ shop 09/10/2026) ═══════════
 *
 *  · Thuần: bản khai tham số URL (`INBOX_URL_PARAMS`) phủ ĐÚNG mọi tham số `page.tsx` đọc — một lượt dọn giao diện không được
 *    lặng lẽ làm mất bộ lọc nào; mọi bộ lọc nâng cao có ô trong «Lọc ▾»; mọi thẻ của `INBOX_FILTERS` vẫn chọn được; đường dẫn dựng
 *    lại đúng mã cũ (`sdt=co|khong`, `xl=ai|nguoi`); huy hiệu «Lọc (n)»; hàng đang mở đứng yên; MỘT trạng thái trên hàng.
 *  · Mã nguồn: không dựng đường dẫn Facebook (từ PSID / mã luồng) ở hộp thư — không nguồn nào trả link hồ sơ thật.
 *  · CSDL (tổ chức THẬT `hop-thu-v2a`, tự cấp, tự dọn): thứ tự mặc định = CHƯA ĐỌC trước, trong nhóm tin mới nhất trước — xếp ở
 *    MÁY CHỦ nên «Xem thêm» (limit 50 → 100) ra đúng phần nối tiếp; «Chờ trả lời» vẫn khách chờ lâu nhất trước.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey } from "@/lib/sales-chatbot/fanpage";
import { listInbox } from "@/lib/sales-chatbot/inbox";
import {
  avatarHrefOf,
  compactCount,
  compactTimeAgo,
  INBOX_FILTERS,
  INBOX_MORE_FILTERS,
  INBOX_QUICK_FILTERS,
  INBOX_URL_PARAMS,
  inboxAdvancedCount,
  inboxHref,
  inboxParams,
  inboxRowStatus,
  keepActiveInPlace,
  type InboxFilterState,
  type InboxRow,
} from "@/lib/sales-chatbot/inbox-shared";

const ORG = "hop-thu-v2a";
const DIR = "app/(dashboard)/ai/sales-chatbot/inbox";
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Tham số URL hộp thư có TRƯỚC INBOX-V2-A (đọc từ page.tsx của origin/main 09/10/2026) — không được mất cái nào. */
const LEGACY_PARAMS = ["f", "ch", "q", "c", "lb", "sdt", "lv", "nv", "tg", "tu", "den", "n", "xl", "pg"];

const BASE: InboxFilterState = { filter: "ALL", q: "", page: null, channel: null, handler: null, assignee: null, phone: null, level: null, period: null, from: null, to: null, label: null, limit: 100, selected: null };

function testFilterContract() {
  // 1. Bản khai = tham số page.tsx đọc = tham số cũ.
  const page = readFileSync(`${DIR}/page.tsx`, "utf8");
  const read = new Set([...page.matchAll(/\b(?:one|day)\("([a-z]+)"\)/g)].map((m) => m[1]));
  assert.deepEqual([...read].sort(), Object.keys(INBOX_URL_PARAMS).sort(), "page.tsx đọc ĐÚNG các tham số trong INBOX_URL_PARAMS");
  assert.deepEqual(Object.keys(INBOX_URL_PARAMS).sort(), [...LEGACY_PARAMS].sort(), "không tham số cũ nào bị bỏ, không tham số lạ");

  // 2. Mọi bộ lọc có chỗ bấm: nâng cao ⇒ ô `name="…"` trong «Lọc ▾»; nhanh ⇒ ô tìm + thẻ.
  const filters = readFileSync(`${DIR}/inbox-filters.tsx`, "utf8");
  for (const [k, v] of Object.entries(INBOX_URL_PARAMS)) {
    if (v.kind === "nav") continue;
    assert.ok(filters.includes(`name="${k}"`), `«${v.label}» (${k}) phải có ô trong bộ lọc`);
  }
  assert.match(filters, /INBOX_QUICK_FILTERS\.map/, "hàng thẻ nhanh");
  assert.match(filters, /INBOX_MORE_FILTERS\.map/, "thẻ còn lại trong ô «Trạng thái»");
  assert.ok(INBOX_QUICK_FILTERS.length <= 5, "≤ 5 thẻ nhanh");
  assert.deepEqual([...INBOX_QUICK_FILTERS, ...INBOX_MORE_FILTERS, "ALL"].sort(), [...INBOX_FILTERS].sort(), "mọi thẻ của INBOX_FILTERS vẫn chọn được (nhanh · Trạng thái · Tất cả)");
  for (const f of ["UNREAD", "UNANSWERED", "NEEDS_HUMAN"] as const) assert.ok((INBOX_QUICK_FILTERS as readonly string[]).includes(f), `${f} là thẻ nhanh`);
  // Trang không còn rải 11 thẻ / hàng level / hàng page ra ngoài.
  assert.ok(!/INBOX_FILTERS\.map/.test(page) && !/inbox-page-chips|inbox-levels/.test(page), "page.tsx không tự vẽ lại hàng thẻ cũ");
  assert.match(page, /<InboxFilters\b/);

  // 3. Đường dẫn dựng lại ĐÚNG mã cũ, mọi khoá.
  const full: InboxFilterState = { filter: "ORDERED", q: "Lan", page: "123", channel: "ZALO", handler: "HUMAN", assignee: "none", phone: "NONE", level: "PHONE_ONLY", period: "CUSTOM", from: "2026-10-01", to: "2026-10-02", label: "lb1", limit: 300, selected: "conv-1" };
  const p = inboxParams(full);
  assert.deepEqual(Object.fromEntries(p), { f: "ORDERED", ch: "ZALO", lb: "lb1", pg: "123", q: "Lan", sdt: "khong", lv: "PHONE_ONLY", nv: "none", tg: "CUSTOM", tu: "2026-10-01", den: "2026-10-02", n: "300", xl: "nguoi", c: "conv-1" });
  assert.deepEqual([...p.keys()].sort(), [...LEGACY_PARAMS].sort(), "đủ 14 tham số khi mọi bộ lọc bật");
  assert.equal(inboxParams({ ...BASE, phone: "HAS", handler: "AI" }).toString(), "sdt=co&xl=ai");
  assert.equal(inboxHref(BASE), "/ai/sales-chatbot/inbox", "không lọc gì ⇒ URL trần");
  assert.equal(inboxHref(full, { c: null, f: null }).includes("c="), false, "patch null bỏ khoá");

  // 4. Huy hiệu «Lọc (n)»: thẻ nhanh không tính; khoảng ngày là MỘT.
  assert.equal(inboxAdvancedCount(BASE), 0);
  assert.equal(inboxAdvancedCount({ ...BASE, filter: "UNREAD" }), 0, "thẻ nhanh đã hiện trên màn hình");
  assert.equal(inboxAdvancedCount({ ...BASE, filter: "ORDERED" }), 1, "thẻ trong «Trạng thái» tính");
  assert.equal(inboxAdvancedCount({ ...BASE, period: "CUSTOM", from: "2026-10-01", to: "2026-10-02" }), 1);
  assert.equal(inboxAdvancedCount(full), 9);
  console.log(`  ✓ bộ lọc gọn: ${LEGACY_PARAMS.length} tham số cũ còn đủ · ${INBOX_QUICK_FILTERS.length} thẻ nhanh + «Lọc» · mọi ô nâng cao có chỗ bấm · URL mã cũ`);
}

function row(id: string, over: Partial<InboxRow> = {}): InboxRow {
  return { id, channel: "FANPAGE", pageId: "p", pageName: null, status: "OPEN", handoffReason: null, customerName: id, customerPhone: null, customerId: null, preview: "", previewSide: null, lastActivityAt: new Date(0).toISOString(), waitingSince: null, unread: true, unreadCount: 1, avatarUrl: null, aiHold: "AI_ACTIVE", handling: "AI", needsHuman: null, humanHandling: null, closed: false, source: "PANCAKE", assigneeUserId: null, assigneeName: null, hasOrder: false, labels: [], level: null, ...over };
}

function testRowHelpers() {
  // Hàng đang mở đứng yên dù máy chủ đã xếp nó sang nhóm «đã đọc» / bỏ khỏi thẻ «Chưa đọc».
  const prev = [row("a"), row("b"), row("c"), row("d", { unread: false, unreadCount: 0 })];
  const next = [row("a"), row("c"), row("b", { unread: false, unreadCount: 0 }), row("d", { unread: false, unreadCount: 0 })];
  assert.deepEqual(keepActiveInPlace(next, prev, "b").map((r) => r.id), ["a", "b", "c", "d"], "b mở ⇒ đứng yên ở vị trí 2");
  assert.equal(keepActiveInPlace(next, prev, "b")[1].unread, false, "dữ liệu mới của chính hàng ấy (đã đọc)");
  const gone = keepActiveInPlace([row("a"), row("c")], prev, "b");
  assert.deepEqual(gone.map((r) => r.id), ["a", "b", "c"], "rời thẻ «Chưa đọc» ⇒ giữ bản cũ tại chỗ");
  assert.equal(gone[1].unreadCount, 0, "bản giữ lại không còn đếm chưa đọc");
  assert.deepEqual(keepActiveInPlace(next, null, "b").map((r) => r.id), ["a", "c", "b", "d"], "không có bản trước ⇒ đúng thứ tự máy chủ");
  assert.deepEqual(keepActiveInPlace(next, prev, null).map((r) => r.id), ["a", "c", "b", "d"], "không mở gì ⇒ đúng thứ tự máy chủ");
  assert.deepEqual(keepActiveInPlace([row("x")], prev, "x").map((r) => r.id), ["x"], "hàng chưa từng hiện ⇒ không đoán chỗ");

  // MỘT trạng thái trên hàng. «Cần người» đọc LÝ DO cần người (chủ shop 10/10/2026), không đọc `status = HANDOFF`: hội thoại AI
  // đang nhường nhân viên / bị tiếp quản là «Người đang xử lý», không phải «Cần người».
  assert.equal(inboxRowStatus(row("a", { needsHuman: "AI_HANDOFF", closed: true }))?.kind, "NEEDS_HUMAN");
  assert.equal(inboxRowStatus(row("a", { needsHuman: "AI_HANDOFF", handoffReason: "Khách đòi gặp người" }))?.hint?.includes("Khách đòi gặp người"), true, "lý do AI chuyển người hiện ở chú thích");
  assert.equal(inboxRowStatus(row("a", { needsHuman: "ORDER_REVIEW" }))?.label, "Kiểm đơn");
  assert.equal(inboxRowStatus(row("a", { status: "HANDOFF", humanHandling: "STAFF_COOLDOWN", handling: "HUMAN" })), null, "AI nhường nhân viên ≠ cần người");
  assert.equal(inboxRowStatus(row("a", { closed: true, hasOrder: true }))?.kind, "CLOSED");
  assert.equal(inboxRowStatus(row("a", { hasOrder: true }))?.kind, "DRAFT");
  assert.equal(inboxRowStatus(row("a")), null);

  const now = Date.parse("2026-10-09T05:00:00Z");
  assert.equal(compactTimeAgo(new Date(now - 20_000).toISOString(), now), "vừa xong");
  assert.equal(compactTimeAgo(new Date(now - 5 * 60_000).toISOString(), now), "5 phút");
  assert.equal(compactTimeAgo(new Date(now - 3 * 3_600_000).toISOString(), now), "3 giờ");
  assert.equal(compactTimeAgo(new Date(now - 2 * 86_400_000).toISOString(), now), "2 ngày");
  assert.equal(compactTimeAgo("2026-09-20T18:00:00Z", now), "21/09", "quá 7 ngày ⇒ ngày giờ Việt Nam");
  assert.equal(compactTimeAgo(null, now), "—");

  // Số gọn trên thẻ nhanh (cỡ HSLC: 2146 / 219) — cắt, không làm tròn lên; số đủ ở chú thích.
  const cc: [number, string][] = [[0, "0"], [219, "219"], [999, "999"], [1000, "1k"], [2146, "2,1k"], [2199, "2,1k"], [9999, "9,9k"], [10500, "10k"], [999_999, "999k"], [1_250_000, "1,2tr"], [-5, "0"], [Number.NaN, "0"]];
  for (const [n, out] of cc) assert.equal(compactCount(n), out, `compactCount(${n})`);
  const filters = readFileSync(`${DIR}/inbox-filters.tsx`, "utf8");
  assert.match(filters, /\{compactCount\(counts\[f\]\)\}/, "thẻ nhanh in số gọn");
  assert.match(readFileSync("components/detail-crumb.tsx", "utf8"), /OWN_NAV_PREFIXES = \[[^\]]*"\/ai\/sales-chatbot\/inbox"/, "hộp thư không in dòng vị trí «… / inbox»");
  console.log("  ✓ hàng gọn: hội thoại đang mở đứng yên · một trạng thái / hàng · giờ ngắn");
}

function testAvatarNoFakeLink() {
  assert.equal(avatarHrefOf(null), null, "chưa nối hồ sơ ⇒ ảnh không phải link");
  assert.equal(avatarHrefOf("cus 1"), "/customers/cus%201");
  // Không dựng đường dẫn Facebook ở hộp thư: PSID / mã luồng là mã THEO PAGE, không phải hồ sơ (inbox-shared.ts::avatarHrefOf).
  const files = [...readdirSync(DIR).filter((f) => f.endsWith(".tsx")).map((f) => `${DIR}/${f}`), "lib/sales-chatbot/inbox.ts", "lib/sales-chatbot/inbox-shared.ts"];
  const bad = files.filter((f) => /facebook\.com|fb\.com\/|\bm\.me\//i.test(strip(readFileSync(f, "utf8"))));
  assert.deepEqual(bad, [], "không tệp hộp thư nào dựng link Facebook");
  const thread = readFileSync(`${DIR}/thread-view.tsx`, "utf8");
  assert.match(thread, /const avatarHref = avatarHrefOf\(thread\.customer\.id\)/, "ảnh đầu hội thoại đi qua avatarHrefOf");
  console.log(`  ✓ ảnh đại diện: không link Facebook dựng từ PSID (${files.length} tệp) · mở hồ sơ khách khi đã nối`);
}

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

async function testUnreadFirstOrder() {
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop hộp thư V2", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const c = schema.salesChatConversations;
      const PAGE = "page-v2a";
      const now = Date.now();
      // 70 hội thoại: chưa đọc rải đều theo thời gian (mỗi hội thoại thứ 3 đã đọc) — đủ để trang đầu (50) cắt giữa nhóm «đã đọc».
      const values = Array.from({ length: 70 }, (_, i) => {
        const at = new Date(now - (i * 7 + 1) * 60_000);
        const read = i % 3 === 0;
        return { channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, `t${i}`), pageId: PAGE, threadId: `t${i}`, lastCustomerAt: at, lastBotAt: i % 2 ? new Date(at.getTime() + 30_000) : null, staffSeenAt: read ? new Date(at.getTime() + 60_000) : null, customerId: i === 5 ? "khach-5" : null, createdAt: new Date(at.getTime() - 3_600_000) };
      });
      await db.insert(c).values(values);

      const ids = (r: Awaited<ReturnType<typeof listInbox>>) => (r.ok ? r.rows : []);
      const p1 = ids(await listInbox(admin, { limit: 50 }));
      const p2 = ids(await listInbox(admin, { limit: 100 }));
      assert.equal(p1.length, 50);
      assert.equal(p2.length, 70);
      assert.deepEqual(p1.map((r) => r.id), p2.slice(0, 50).map((r) => r.id), "«Xem thêm» ra ĐÚNG phần nối tiếp — thứ tự xếp ở máy chủ, ổn định");
      const firstRead = p2.findIndex((r) => !r.unread);
      assert.ok(firstRead > 0, "có cả hai nhóm");
      assert.ok(p2.slice(firstRead).every((r) => !r.unread), "CHƯA ĐỌC luôn đứng trước ĐÃ ĐỌC (qua cả hai trang)");
      // Chủ shop 10/10/2026 (mục B1, SỬA khẳng định cũ cùng ngày): «chưa đọc» = NGƯỜI chưa mở tin của khách, BẤT KỂ AI đã trả lời
      // hay chưa. Bản trước coi hội thoại bot đã trả lời (i lẻ) là «đã đọc» dù chưa ai mở — đúng cái chủ shop báo sai: khách
      // «xin giá» → AI «Dạ giá 280k…», nhân viên chưa mở ⇒ VẪN chưa đọc. 70 hội thoại: 46 nhân viên chưa mở ⇒ 46 chưa đọc.
      assert.equal(firstRead, 46, "46 hội thoại chưa đọc / 70 (nhân viên chưa mở từ tin khách cuối, kể cả khi bot đã trả lời)");
      const idOf = new Map((await db.select({ id: c.id, threadId: c.threadId }).from(c).where(eq(c.pageId, PAGE))).map((r) => [r.threadId, r.id]));
      const rowOf = (thread: string) => p2.find((r) => r.id === idOf.get(thread))!;
      assert.equal(rowOf("t1").unread, true, "t1: BOT đã trả lời sau tin khách nhưng nhân viên chưa mở ⇒ VẪN chưa đọc");
      assert.ok(rowOf("t1").unreadCount >= 1);
      assert.equal(rowOf("t2").unread, true, "t2: tin cuối là của khách, chưa ai trả lời, chưa ai mở ⇒ chưa đọc");
      assert.equal(rowOf("t3").unread, false, "t3: nhân viên đã mở sau tin khách");
      assert.ok(p2.every((r) => r.unread === (r.unreadCount > 0)), "số chưa đọc trên hàng khớp cờ chưa đọc");
      for (const group of [p2.slice(0, firstRead), p2.slice(firstRead)]) {
        for (let i = 1; i < group.length; i++) assert.ok(group[i - 1].lastActivityAt >= group[i].lastActivityAt, `trong nhóm: tin mới nhất trước (${group[i - 1].id} ≥ ${group[i].id})`);
      }
      assert.ok(p1.some((r) => !r.unread), "trang đầu cắt giữa nhóm đã đọc — phép kiểm có nghĩa");
      assert.deepEqual(p2.filter((r) => r.customerId).map((r) => r.customerId), ["khach-5"], "hàng mang mã hồ sơ khách (ảnh mở hồ sơ)");

      // Thẻ «Chưa đọc»: cùng thứ tự (mới nhất trước), chỉ hàng chưa đọc.
      const unread = ids(await listInbox(admin, { filter: "UNREAD", limit: 100 }));
      assert.deepEqual(unread.map((r) => r.id), p2.slice(0, firstRead).map((r) => r.id));
      // «Chờ trả lời» giữ thứ tự riêng: khách chờ LÂU NHẤT trước.
      const waiting = ids(await listInbox(admin, { filter: "UNANSWERED", limit: 100 }));
      assert.ok(waiting.length > 0);
      for (let i = 1; i < waiting.length; i++) assert.ok(waiting[i - 1].lastActivityAt <= waiting[i].lastActivityAt, "chờ lâu nhất trước");
      console.log(`  ✓ chưa đọc trước: ${firstRead} chưa đọc rồi ${70 - firstRead} đã đọc · trang 50 = tiền tố trang 100 · Chờ trả lời giữ chờ-lâu-nhất-trước`);
    });
  } finally {
    await cleanup();
  }
}

export async function testInboxV2A() {
  testFilterContract();
  testRowHelpers();
  testAvatarNoFakeLink();
  await testUnreadFirstOrder();
}
