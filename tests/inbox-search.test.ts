/**
 * ═══════════ HỘP THƯ — TÌM KIẾM + BỘ LỌC (P0 inbox-search, chủ shop 11/10/2026) ═══════════
 *
 * Ca thật (tên / số trong bài này đều GIẢ): tìm SĐT ở «Tin khách chưa đọc» không ra (đúng luật V3, thiếu gợi ý); «+84…» và «09xx xxx xxx» ở «Tất cả» không ra (không
 * chuẩn hoá SĐT); tên có khoảng trắng không ra tên viết liền (không bỏ khoảng trắng). Mọi SĐT ở đây là SỐ GIẢ.
 *
 *  · Thuần: một SĐT viết sáu cách ⇒ cùng một phần lõi; tên bỏ dấu / khoảng trắng (TS = SQL); mã đơn ngắn / đầy đủ; gợi ý «có ở Tất
 *    cả»; danh sách mới (đổi ô tìm / bộ lọc) KHÔNG mang hội thoại đang mở của danh sách cũ.
 *  · Mã nguồn: `listInbox` gọi ĐÚNG một điểm nối; ô tìm giữ hội thoại đang mở theo URL SỐNG.
 *  · CSDL (tổ chức THẬT `tim-hop-thu-a` + `tim-hop-thu-b`, tự cấp, tự dọn — mốc theo đồng hồ thật): SĐT hồ sơ «+84» · SĐT chỉ có
 *    trong tin khách · SĐT / tên / mã trên đơn · SĐT Pancake · chat web · tên có / không khoảng trắng / dấu · tìm + từng bộ lọc +
 *    phân trang · UNREAD rỗng ⇒ gợi ý đúng số · tổ chức khác không lọt · ĐO thời gian trên ≥ 3.000 hội thoại.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { and, eq, ne, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { MANUAL_ORDER_ID_PREFIX, manualOrderShortCode } from "@/lib/constants/manual-orders";
import { NGUYEN_AM_CO_DAU } from "@/lib/queries/carrier-substate-sql";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { fanpageVisitorKey, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { listInbox } from "@/lib/sales-chatbot/inbox";
import { inboxDisplayRows } from "@/lib/sales-chatbot/inbox-read-shared";
import { foldSql, inboxSearchSql, parseInboxSearch } from "@/lib/sales-chatbot/inbox-search";
import {
  activeOutsideList,
  dropSelectionOnSearch,
  foldSearchText,
  INBOX_SEARCH_DEBOUNCE_MS,
  inboxActiveChip,
  inboxChipHref,
  inboxEmptyHint,
  inboxFilterLabels,
  inboxListKey,
  inboxListQuery,
  inboxQueryState,
  inboxScopeHref,
  inboxSearchHref,
  inboxSearchMode,
  shouldLiveSearch,
  shownForList,
} from "@/lib/sales-chatbot/inbox-search-shared";
import { inboxParams, type InboxFilter, type InboxFilterState, type InboxRow } from "@/lib/sales-chatbot/inbox-shared";

const ORG_A = "tim-hop-thu-a";
const ORG_B = "tim-hop-thu-b";
const MIN = 60_000;
const FILLER = 3_000;

function row(id: string, over: Partial<InboxRow> = {}): InboxRow {
  return { id, channel: "FANPAGE", pageId: "p", pageName: null, status: "OPEN", handoffReason: null, customerName: id, customerPhone: null, customerId: null, preview: "", previewSide: null, previewAt: null, afterPreview: null, latestPreview: "", latestSide: null, latestAt: null, newestCustomerAt: null, readCursorAt: null, lastActivityAt: new Date(0).toISOString(), waitingSince: null, unread: false, unreadCount: 0, avatarUrl: null, aiHold: "AI_ACTIVE", handling: "AI", needsHuman: null, humanHandling: null, closed: false, source: "PANCAKE", assigneeUserId: null, assigneeName: null, hasOrder: false, labels: [], level: null, ...over };
}

const STATE: InboxFilterState = { filter: "ALL", q: "", page: null, channel: null, handler: null, assignee: null, phone: null, level: null, period: null, from: null, to: null, label: null, limit: 100, selected: null };

function testPure() {
  // Một SĐT, sáu cách viết ⇒ MỘT phần lõi.
  for (const v of ["0900111222", "+84900111222", "84900111222", "0900 111 222", "0900.111.222", "(+84) 900-111-222"]) {
    assert.equal(parseInboxSearch(v)?.phone, "900111222", `«${v}» ⇒ lõi 900111222`);
  }
  assert.equal(parseInboxSearch("111222")?.phone, "111222", "6 số cuối ⇒ tìm một phần");
  assert.equal(parseInboxSearch("0900")?.phone, null, "4 chữ số: chỉ vế thô cũ");
  assert.equal(parseInboxSearch("Hoa Mai")?.phone, null);
  assert.equal(parseInboxSearch("Hoa Mai")?.fold, "hoamai", "bỏ khoảng trắng");
  assert.equal(parseInboxSearch("ĐẶNG Ngọc Ánh")?.fold, "dangngocanh", "bỏ dấu, chữ hoa có dấu");
  assert.equal(parseInboxSearch("a")?.fold, null, "một ký tự: không tìm tên bỏ dấu");
  assert.equal(parseInboxSearch("   "), null, "ô tìm rỗng ⇒ không lọc");
  assert.equal(parseInboxSearch("#5E7A9C1B")?.orderPrefix, `${MANUAL_ORDER_ID_PREFIX}5e7a9c1b`, "mã ngắn đơn ERP");
  assert.equal(parseInboxSearch("5e7a9c1b")?.orderPrefix, `${MANUAL_ORDER_ID_PREFIX}5e7a9c1b`, "mã ngắn không dấu #");
  assert.equal(parseInboxSearch("0900111222")?.orderId, null, "SĐT không bị đọc thành mã đơn");
  assert.equal(parseInboxSearch("12345")?.displayId, 12345, "số hiển thị đơn Pancake");
  // Bảng chữ hoa có dấu của SQL: cùng 67 ký tự, mỗi ký tự MỘT ký tự (translate cần hai bảng dài bằng nhau).
  assert.equal([...NGUYEN_AM_CO_DAU.toUpperCase()].length, [...NGUYEN_AM_CO_DAU].length);
  assert.equal(foldSearchText("HoaMai Le"), "hoamaile");
  assert.equal(foldSearchText("Lê Hoa Mai".normalize("NFD")), "lehoamai", "chuỗi NFD (dấu rời) cũng bỏ được");

  // Gợi ý: bộ lọc rỗng mà «Tất cả» có.
  const counts = (over: Partial<Record<InboxFilter, number>>) => ({ ALL: 0, UNREAD: 0, AI: 0, HUMAN: 0, NEEDS_HUMAN: 0, ORDERED: 0, NOT_ORDERED: 0, UNANSWERED: 0, MINE: 0, UNASSIGNED: 0, ...over }) as Record<InboxFilter, number>;
  assert.deepEqual(inboxEmptyHint("UNREAD", counts({ ALL: 1 }), "0900111222")?.count, 1);
  assert.match(inboxEmptyHint("UNREAD", counts({ ALL: 1 }), "0900111222")!.text, /khớp «0900111222» ở «Tất cả»/);
  assert.equal(inboxEmptyHint("ALL", counts({ ALL: 0 }), "x"), null, "đang ở Tất cả ⇒ không gợi ý");
  assert.equal(inboxEmptyHint("UNREAD", counts({ ALL: 0 }), "x"), null, "Tất cả cũng rỗng ⇒ không gợi ý");
  assert.equal(inboxEmptyHint("UNREAD", counts({ ALL: 3, UNREAD: 1 }), "x"), null, "bộ lọc có hàng ⇒ không gợi ý");

  // Danh tính danh sách: đổi ô tìm / bộ lọc ⇒ khoá khác; đổi hội thoại đang mở / số hàng ⇒ CÙNG khoá.
  const k0 = inboxListKey(STATE);
  assert.notEqual(inboxListKey({ ...STATE, q: "0900111222" }), k0);
  assert.notEqual(inboxListKey({ ...STATE, filter: "UNREAD" }), k0);
  assert.notEqual(inboxListKey({ ...STATE, page: "p2" }), k0);
  assert.equal(inboxListKey({ ...STATE, selected: "x", limit: 200 }), k0);

  // Hội thoại đang mở «old» của danh sách cũ KHÔNG được chèn vào kết quả tìm mới; cùng danh sách (tự làm mới) thì vẫn đứng yên.
  const prev = { key: k0, rows: [row("a"), row("old"), row("b")] };
  const kSearch = inboxListKey({ ...STATE, q: "kim" });
  const fresh = [row("x"), row("y")];
  const display = inboxDisplayRows(fresh, shownForList(prev, kSearch), { activeId: "old", filter: "ALL", reads: new Map() });
  assert.deepEqual(display.map((r) => r.id), ["x", "y"], "kết quả tìm mới không mang hội thoại cũ");
  assert.ok(activeOutsideList("old", display), "⇒ báo «đang mở hội thoại ngoài kết quả»");
  const refresh = inboxDisplayRows([row("a"), row("b")], shownForList(prev, k0), { activeId: "old", filter: "ALL", reads: new Map() });
  assert.deepEqual(refresh.map((r) => r.id), ["a", "old", "b"], "cùng danh sách: hội thoại đang mở đứng yên như cũ");
  assert.ok(!activeOutsideList("old", refresh));
  assert.ok(!activeOutsideList(null, fresh), "không mở gì ⇒ không báo");
  console.log("  ✓ thuần: SĐT 6 dạng = 1 lõi · tên bỏ dấu/khoảng trắng · mã đơn · gợi ý «Tất cả» · danh sách mới không mang hội thoại cũ");
}

/** URL ⇒ trạng thái, ĐÚNG cách `page.tsx` đọc (phần cần cho bài này) — để soát vòng URL → trạng thái → URL. */
function stateOf(href: string): InboxFilterState {
  const p = new URL(href, "http://x").searchParams;
  return { ...STATE, filter: (p.get("f") as InboxFilter | null) ?? "ALL", q: p.get("q") ?? "", page: p.get("pg"), handler: p.get("xl") === "nguoi" ? "HUMAN" : p.get("xl") === "ai" ? "AI" : null, assignee: p.get("nv"), selected: p.get("c"), searchScope: p.get("pv") === "loc" ? "FILTER" : null };
}

function testGlobalSearchPure() {
  // 1 · Đang ở «Tin khách chưa đọc» mà gõ SĐT ⇒ tìm TOÀN hộp thư: không thẻ / bộ lọc nào áp ngầm.
  const unread: InboxFilterState = { ...STATE, filter: "UNREAD" };
  const searching = stateOf(inboxSearchHref(unread, " 0368 000 111 ", null));
  assert.equal(searching.q, "0368 000 111", "ô tìm vào URL (cắt hai đầu)");
  assert.equal(searching.filter, "UNREAD", "thẻ cũ VẪN nằm trong URL (để xoá ô tìm là về đúng nó)");
  assert.equal(inboxSearchMode(searching), "GLOBAL", "mặc định tìm toàn hộp thư");
  assert.equal(inboxQueryState(searching).filter, "ALL", "thẻ «chưa đọc» KHÔNG áp khi đang tìm");
  assert.equal(inboxActiveChip(searching), "ALL", "không thẻ nhanh nào hiện như đang bật");
  const busy: InboxFilterState = { ...STATE, q: "0900111222", filter: "NEEDS_HUMAN", handler: "HUMAN", assignee: "u1", page: "p2", channel: "ZALO", phone: "HAS", level: "PHONE_ONLY", period: "7D", label: "lb1" };
  const eff = inboxQueryState(busy);
  assert.deepEqual([eff.filter, eff.handler, eff.assignee, eff.page, eff.channel, eff.phone, eff.level, eff.period, eff.label], ["ALL", null, null, null, null, null, null, null, null], "cần người / AI-người / người phụ trách / page / kênh / SĐT / level / thời gian / nhãn: KHÔNG áp ngầm");
  assert.deepEqual(inboxListQuery(busy), { filter: "ALL", channel: null, q: "0900111222", label: null, page: null, phone: null, level: null, assignee: null, period: null, from: null, to: null, limit: 100, handler: null }, "tham số listInbox của trang = toàn hộp thư");
  assert.deepEqual(inboxFilterLabels(busy, { p2: "Page Hai" }), ["Cần người", "Page Page Hai", "Kênh Zalo OA", "Người đang xử lý", "Nhân viên phụ trách", "Có SĐT", "Level khách", "Thời gian tin cuối", "Nhãn"], "tên các bộ lọc đang tạm bỏ qua");

  // 2 · Chọn TƯỜNG MINH «Chỉ tìm trong bộ lọc hiện tại» ⇒ UNREAD vẫn giữ.
  const scoped = stateOf(inboxScopeHref(searching, "FILTER", null));
  assert.equal(scoped.searchScope, "FILTER");
  assert.equal(inboxSearchMode(scoped), "FILTERED");
  assert.equal(inboxQueryState(scoped).filter, "UNREAD", "trong bộ lọc: UNREAD giữ nguyên");
  assert.equal(inboxListQuery(scoped).filter, "UNREAD");
  assert.equal(inboxActiveChip(scoped), "UNREAD");
  // Gõ tiếp trong phạm vi đã chọn ⇒ phạm vi giữ; «Tìm toàn hộp thư» ⇒ bỏ phạm vi.
  assert.equal(stateOf(inboxSearchHref(scoped, "0368", null)).searchScope, "FILTER", "đang tìm trong bộ lọc mà gõ tiếp ⇒ giữ lựa chọn");
  assert.equal(inboxSearchMode(stateOf(inboxScopeHref(scoped, "GLOBAL", null))), "GLOBAL");
  // «Trong bộ lọc» mà không có bộ lọc nào ⇒ vẫn là toàn hộp thư (không có gì để thu hẹp).
  assert.equal(inboxSearchMode({ ...STATE, q: "x", searchScope: "FILTER" }), "GLOBAL");

  // 3 · Xoá ô tìm ⇒ về ĐÚNG bộ lọc trước đó, và phạm vi không lưu sang lần tìm sau.
  assert.equal(inboxSearchHref(searching, "", null), "/ai/sales-chatbot/inbox?f=UNREAD", "xoá ô tìm (toàn hộp thư) ⇒ về «chưa đọc»");
  assert.equal(inboxSearchHref(scoped, "   ", null), "/ai/sales-chatbot/inbox?f=UNREAD", "xoá ô tìm (trong bộ lọc) ⇒ về «chưa đọc», bỏ pv");
  const restored = stateOf(inboxSearchHref(scoped, "", null));
  assert.equal(inboxSearchMode(restored), "NONE");
  assert.equal(inboxQueryState(restored).filter, "UNREAD", "bộ lọc áp lại như trước khi tìm");
  assert.equal(stateOf(inboxSearchHref(restored, "lan", null)).searchScope, null, "lần tìm MỚI lại mặc định toàn hộp thư");
  assert.equal(inboxParams({ ...STATE, filter: "UNREAD", searchScope: "FILTER" }).toString(), "f=UNREAD", "không có ô tìm ⇒ pv không bao giờ vào URL");
  // Hội thoại đang mở (URL sống) đi theo lần tìm; về đầu danh sách.
  const withSel = new URL(inboxSearchHref({ ...unread, limit: 300 }, "lan", "conv-9"), "http://x").searchParams;
  assert.equal(withSel.get("c"), "conv-9");
  assert.equal(withSel.get("n"), null, "đổi ô tìm ⇒ về đầu danh sách");

  // 4 · Thẻ nhanh khi đang tìm toàn hộp thư = chọn tường minh tìm trong thẻ đó; không tìm ⇒ như cũ.
  const chip = stateOf(inboxChipHref(searching, "UNANSWERED"));
  assert.deepEqual([chip.filter, chip.searchScope, inboxSearchMode(chip)], ["UNANSWERED", "FILTER", "FILTERED"]);
  assert.equal(inboxChipHref(unread, "UNREAD"), "/ai/sales-chatbot/inbox", "không tìm: bấm lại thẻ đang bật ⇒ «Tất cả»");
  assert.equal(inboxChipHref(scoped, "UNREAD"), "/ai/sales-chatbot/inbox?q=0368+000+111&pv=loc", "trong bộ lọc: bấm lại thẻ đang bật ⇒ bỏ thẻ");

  // 5 · Danh sách: tìm toàn hộp thư từ «chưa đọc» hay từ «Tất cả» là CÙNG một danh sách.
  assert.equal(inboxListKey(searching), inboxListKey({ ...STATE, q: "0368 000 111" }));
  assert.notEqual(inboxListKey(scoped), inboxListKey(searching), "đổi phạm vi ⇒ danh sách khác");

  // 6 · Hội thoại đang mở chỉ giữ khi nằm trong kết quả tìm.
  const rs = [{ id: "a" }, { id: "b" }];
  assert.equal(dropSelectionOnSearch("0900", "x", rs, 2), true, "không có trong kết quả (đủ mọi kết quả) ⇒ bỏ chọn");
  assert.equal(dropSelectionOnSearch("0900", "a", rs, 2), false, "có trong kết quả ⇒ giữ");
  assert.equal(dropSelectionOnSearch("0900", "x", rs, 250), false, "kết quả quá trang đầu ⇒ không biết ⇒ không bỏ (chỉ báo)");
  assert.equal(dropSelectionOnSearch("", "x", rs, 2), false, "không tìm ⇒ không đụng tới hội thoại đang mở");
  assert.equal(dropSelectionOnSearch("0900", null, rs, 2), false);

  // 7 · Gõ là tìm: debounce ~300 ms, từ 2 ký tự; xoá ô tìm thì tìm lại ngay.
  assert.equal(INBOX_SEARCH_DEBOUNCE_MS, 300);
  assert.equal(shouldLiveSearch("a"), false);
  assert.equal(shouldLiveSearch("an"), true);
  assert.equal(shouldLiveSearch("  "), true, "xoá ô tìm ⇒ tự về bộ lọc cũ");
  console.log("  ✓ thuần: ô tìm = toàn hộp thư (bỏ 9 loại bộ lọc ngầm) · «chỉ trong bộ lọc» giữ UNREAD · xoá ô tìm về đúng bộ lọc · thẻ khi đang tìm · bỏ chọn ngoài kết quả · debounce 300 ms");
}

function testSource() {
  const inbox = readFileSync("lib/sales-chatbot/inbox.ts", "utf8");
  assert.match(inbox, /const searchCond = await inboxSearchCondition\(q\.q\);/, "listInbox nối ĐÚNG một điểm sang inbox-search.ts");
  assert.doesNotMatch(inbox, /INBOUND_NAME\} ilike/, "không còn vế ilike cũ ở inbox.ts");
  const filters = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/inbox-filters.tsx", "utf8");
  assert.match(filters, /if \(liveSelected\) p\.set\("c", liveSelected\);/, "ô tìm giữ hội thoại đang mở theo URL sống");
  assert.doesNotMatch(filters, /p\.set\("c", state\.selected\)/, "không dùng hội thoại của lượt dựng trước");
  const list = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/conversation-list.tsx", "utf8");
  assert.match(list, /shownForList\(shown\.current, listKey\)/, "bản đã hiện gắn với danh tính danh sách");
  assert.match(list, /data-testid="inbox-active-outside"/);
  const page = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx", "utf8");
  assert.match(page, /inboxEmptyHint\(eff\.filter, list\.counts, q\)/, "gợi ý đọc CÙNG câu đếm của trang (theo bộ lọc THẬT SỰ áp)");
  // Ô tìm toàn hộp thư: trang đi qua ĐÚNG một đường (inboxListQuery ⇒ inboxQueryState), không tự chép bộ lọc vào listInbox.
  assert.match(page, /listInbox\(user, inboxListQuery\(state\)\)/, "trang gọi listInbox bằng inboxListQuery(state)");
  assert.match(page, /one\("pv"\) === "loc"/, "phạm vi «trong bộ lọc» chỉ khi người dùng chọn (pv=loc)");
  assert.match(filters, /window\.setTimeout\(\(\) => search\(value, how\), INBOX_SEARCH_DEBOUNCE_MS\)/, "gõ là tìm (debounce)");
  assert.match(filters, /type="submit"[^>]*aria-label="Tìm"/, "nút «Tìm» rõ ràng (Enter cũng gửi form)");
  assert.match(filters, /data-testid="inbox-search-scope"/, "dòng «Đang tìm trong toàn hộp thư»");
  assert.match(filters, /Chỉ tìm trong bộ lọc hiện tại/);
  assert.match(filters, /data-testid="inbox-search-loading"/, "trạng thái đang tải");
  assert.match(list, /dropSelectionOnSearch\(state\.q, activeId, display, total\)/, "bỏ chọn hội thoại không nằm trong kết quả");
  console.log("  ✓ mã nguồn: một điểm nối · ô tìm giữ c sống · danh sách theo khoá · gợi ý từ cùng câu đếm");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  for (const code of [ORG_A, ORG_B]) {
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
    if (org) {
      await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
      await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
    }
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

async function adminOf(code: string): Promise<SessionUser> {
  const enabled = await getEnabledModules(code);
  const db = await getDb();
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${code}.local`) });
  assert.ok(u);
  return { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code, name: code, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
}

type Side = "C" | "BOT" | "STAFF";
type Msg = { side: Side; text: string; ago: number };

async function testDb() {
  await cleanup();
  try {
    for (const code of [ORG_A, ORG_B]) {
      await provisionOrganization({ code, name: `Shop ${code}`, plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${code}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    }
    const T0 = Date.now();
    const at = (msAgo: number) => new Date(T0 - msAgo);
    const c = schema.salesChatConversations;
    const t = schema.salesChatInbound;

    // ═══ TỔ CHỨC B — một khách «bí mật» không bao giờ được hiện ở A ═══
    await withOrganization(ORG_B, async () => {
      const db = await getDb();
      const [cu] = await db.insert(schema.customers).values({ name: "Bí Mật Bê", phone: "0900999000" }).returning({ id: schema.customers.id });
      await db.insert(c).values({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey("page-b", "tb"), pageId: "page-b", threadId: "tb", customerId: cu.id, lastCustomerAt: at(10 * MIN) });
      await db.insert(t).values({ pageId: "page-b", threadId: "tb", messageId: "tb-0", text: "sdt 0900 999 000", customerName: "Bí Mật Bê", status: "DONE", createdAt: at(10 * MIN) });
    });

    await withOrganization(ORG_A, async () => {
      const db = await getDb();
      const admin = await adminOf(ORG_A);
      const PAGE = "page-tim";
      const PAGE2 = "page-tim-2";
      const mk = async (o: { thread: string; page?: string; name?: string; customerId?: string | null; state?: Record<string, unknown>; msgs: Msg[]; read?: boolean; channel?: "FANPAGE" | "WEB" }) => {
        const page = o.page ?? PAGE;
        const last = (s: Side) => o.msgs.filter((m) => m.side === s).reduce<Date | null>((x, m) => (!x || at(m.ago) > x ? at(m.ago) : x), null);
        const web = o.channel === "WEB";
        const [cv] = await db
          .insert(c)
          .values({ channel: o.channel ?? "FANPAGE", status: "OPEN", visitorKey: web ? `web-${o.thread}` : fanpageVisitorKey(page, o.thread), pageId: web ? null : page, threadId: web ? null : o.thread, customerId: o.customerId ?? null, state: o.state ?? {}, lastCustomerAt: last("C"), lastBotAt: last("BOT"), lastStaffAt: last("STAFF"), createdAt: at(300 * MIN) })
          .returning({ id: c.id });
        for (const [i, m] of o.msgs.entries()) {
          if (web) {
            await db.insert(schema.salesChatMessages).values({ conversationId: cv.id, seq: i + 1, role: m.side === "C" ? "user" : "assistant", content: [{ type: "text", text: m.text }], createdAt: at(m.ago) });
            continue;
          }
          await db.insert(t).values({ pageId: page, threadId: o.thread, messageId: m.side === "STAFF" ? `staff-out:${o.thread}-${i}` : `${o.thread}-${i}`, text: m.text, note: m.side === "BOT" ? "BOT_SENT" : m.side === "STAFF" ? PAGE_REPLY : null, customerName: o.name ?? "Khách", status: "DONE", createdAt: at(m.ago) });
        }
        if (o.read) await db.insert(schema.salesChatReads).values({ conversationId: cv.id, userId: admin.id, readThroughAt: new Date(T0) });
        return cv.id;
      };
      const reply = (ago: number): Msg => ({ side: "BOT", text: "Dạ em ghi nhận ạ", ago });

      // Ca của chủ shop (tên giả): hồ sơ CRM «Lê Hoa Mai» lưu SĐT dạng +84, tên Messenger «HoaMai Le», tin cuối là của AI và người xem đã đọc.
      const [cuHoso] = await db.insert(schema.customers).values({ name: "Lê Hoa Mai", phone: "+84900111222" }).returning({ id: schema.customers.id });
      const HOSO = await mk({ thread: "hoso", name: "HoaMai Le", customerId: cuHoso.id, msgs: [{ side: "C", text: "lấy chị 2kg", ago: 60 * MIN }, reply(59 * MIN)], read: true });
      // SĐT CHỈ có trong tin khách (chưa hồ sơ, chưa đơn, job level chưa chạy).
      const TIN = await mk({ thread: "tin", name: "Khách Tin Nhắn", msgs: [{ side: "C", text: "sdt em 0900 333 444 nha", ago: 50 * MIN }, reply(49 * MIN)], read: true });
      // SĐT + tên chỉ có trên ĐƠN ERP của hội thoại.
      const DON = await mk({ thread: "don", name: "Khách Đơn", msgs: [{ side: "C", text: "chốt đơn nha", ago: 40 * MIN }, reply(39 * MIN)], read: true });
      // Mã cố định (có chữ cái) để mã ngắn không bao giờ là một dãy số trông như SĐT.
      const orderId = `${MANUAL_ORDER_ID_PREFIX}5e7a9c1b-0000-4000-8000-00000000a001`;
      await db.insert(schema.orders).values({ id: orderId, stage: "CONFIRMED", billPhone: "0900555666", shipPhone: "0900555666", billFullName: "Võ Ngọc Ánh", shipFullName: "Võ Ngọc Ánh", salesConversationId: DON, insertedAt: at(39 * MIN) });
      // SĐT Pancake ghi nhận (lượt nhập lịch sử).
      const PANCAKE = await mk({ thread: "pancake", name: "Khách Pancake", state: { pancakePhones: ["0900777888"] }, msgs: [{ side: "C", text: "còn hàng không", ago: 30 * MIN }, reply(29 * MIN)], read: true });
      // Chat web: SĐT trong khối chữ của khách.
      const WEB = await mk({ thread: "web", channel: "WEB", msgs: [{ side: "C", text: "Số em 0900.888.999", ago: 25 * MIN }, reply(24 * MIN)], read: true });
      // «Trần Hoa Mài» CHƯA ĐỌC (tin khách sau con trỏ) — để soát tìm + bộ lọc UNREAD.
      const [cuHoso2] = await db.insert(schema.customers).values({ name: "Trần Hoa Mài" }).returning({ id: schema.customers.id });
      const HOSO2 = await mk({ thread: "hoso2", name: "Hoa Mai Tran", customerId: cuHoso2.id, msgs: [{ side: "C", text: "shop ơi", ago: 5 * MIN }] });
      // Cùng tên, page KHÁC.
      const KHAC_PAGE = await mk({ thread: "khac", page: PAGE2, name: "Hoa Mai Page Hai", msgs: [{ side: "C", text: "alo", ago: 20 * MIN }, reply(19 * MIN)], read: true });

      // ═══ 3.000 hội thoại nền (4 tin mỗi hội thoại + 1.000 đơn) — để ĐO, và để chắc điều kiện không «khớp nhầm» cả hộp thư ═══
      const pad = (n: number) => String(n).padStart(6, "0");
      for (let start = 0; start < FILLER; start += 500) {
        const idx = Array.from({ length: Math.min(500, FILLER - start) }, (_, k) => start + k);
        const convs = await db
          .insert(c)
          .values(idx.map((i) => ({ channel: "FANPAGE", status: "OPEN", visitorKey: fanpageVisitorKey(PAGE, `f-${i}`), pageId: PAGE, threadId: `f-${i}`, customerPhone: `0911${pad(i)}`, lastCustomerAt: at(400 * MIN + i * 1000), lastBotAt: at(399 * MIN + i * 1000), createdAt: at(500 * MIN + i * 1000) })))
          .returning({ id: c.id, threadId: c.threadId });
        await db.insert(t).values(
          idx.flatMap((i) => [
            { pageId: PAGE, threadId: `f-${i}`, messageId: `f-${i}-0`, text: "Báo giá chả cá thu?", customerName: `Khách nền ${i}`, status: "DONE", createdAt: at(402 * MIN + i * 1000) },
            { pageId: PAGE, threadId: `f-${i}`, messageId: `f-${i}-1`, text: "Dạ giá 280k ạ", note: "BOT_SENT", customerName: `Khách nền ${i}`, status: "DONE", createdAt: at(401 * MIN + i * 1000) },
            { pageId: PAGE, threadId: `f-${i}`, messageId: `f-${i}-2`, text: `lấy 1kg nhé sdt 0922${pad(i)}`, customerName: `Khách nền ${i}`, status: "DONE", createdAt: at(400 * MIN + i * 1000) },
            { pageId: PAGE, threadId: `f-${i}`, messageId: `f-${i}-3`, text: "Dạ em lên đơn ạ", note: "BOT_SENT", customerName: `Khách nền ${i}`, status: "DONE", createdAt: at(399 * MIN + i * 1000) },
          ]),
        );
        const withOrder = convs.filter((_, k) => idx[k] % 3 === 0);
        if (withOrder.length) await db.insert(schema.orders).values(withOrder.map((cv) => ({ id: `${MANUAL_ORDER_ID_PREFIX}${crypto.randomUUID()}`, stage: "CONFIRMED" as const, billPhone: `0933${cv.threadId!.slice(2).padStart(6, "0")}`, billFullName: "Người Nhận Nền", salesConversationId: cv.id, insertedAt: at(398 * MIN) })));
      }

      const find = async (q: string, over: Record<string, unknown> = {}) => {
        const r = await listInbox(admin, { filter: "ALL", q, limit: 500, ...over }, new Date(T0 + 1000));
        assert.ok(r.ok, JSON.stringify(r));
        return r;
      };
      const ids = async (q: string, over: Record<string, unknown> = {}) => (await find(q, over)).rows.map((r) => r.id).sort();
      const only = async (q: string, want: string[], why: string, over: Record<string, unknown> = {}) => assert.deepEqual(await ids(q, over), [...want].sort(), `${why} — «${q}» ${JSON.stringify(over)}`);

      // 1 · SĐT hồ sơ lưu «+84…»: sáu cách gõ đều ra ĐÚNG một hội thoại.
      for (const v of ["0900111222", "+84900111222", "84900111222", "0900 111 222", "0900.111.222", "+84 900-111-222"]) await only(v, [HOSO], "SĐT hồ sơ (+84) chuẩn hoá");
      // 2 · SĐT chỉ có trong TIN KHÁCH.
      for (const v of ["0900333444", "+84 900 333 444", "333444"]) await only(v, [TIN], "SĐT chỉ có trong tin khách");
      // 3 · ĐƠN của hội thoại: SĐT · tên (bỏ dấu, hoa / thường) · mã ngắn / đầy đủ.
      for (const v of ["0900555666", "+84900555666", "Võ Ngọc Ánh", "vo ngoc anh", "NGỌC ÁNH", `#${manualOrderShortCode(orderId)}`, manualOrderShortCode(orderId).toLowerCase(), orderId]) await only(v, [DON], "đơn của hội thoại");
      // 4 · SĐT Pancake · 5 · chat web.
      await only("0900 777 888", [PANCAKE], "SĐT Pancake (state.pancakePhones)");
      await only("+84900888999", [WEB], "SĐT trong tin chat web");
      // 6 · TÊN: có / không khoảng trắng, có / không dấu, tên Messenger lẫn tên CRM.
      for (const v of ["Hoa Mai", "HoaMai", "hoa mai", "HOA MAI"]) await only(v, [HOSO, HOSO2, KHAC_PAGE], "tên bỏ khoảng trắng / dấu");
      await only("hoamaile", [HOSO], "tên Messenger «HoaMai Le»");
      await only("Lê Hoa", [HOSO], "tên CRM «Lê Hoa Mai»");
      await only("tran", [HOSO2], "không dấu ⇄ có dấu («Trần»)");
      await only("0900999000", [], "khách của TỔ CHỨC KHÁC không lọt (SĐT)");
      await only("Bí Mật Bê", [], "khách của TỔ CHỨC KHÁC không lọt (tên)");

      // 7 · Tìm + từng bộ lọc.
      await only("hoa mai", [HOSO2], "tìm + Tin khách chưa đọc", { filter: "UNREAD" });
      await only("hoa mai", [KHAC_PAGE], "tìm + một page", { page: PAGE2 });
      await only("hoa mai", [HOSO], "tìm + Có SĐT", { phone: "HAS" });
      await only("hoa mai", [HOSO2, KHAC_PAGE], "tìm + Chưa có SĐT", { phone: "NONE" });
      await only("0900555666", [DON], "tìm + Đã chốt", { filter: "ORDERED" });
      await only("0900555666", [], "tìm + Chưa chốt", { filter: "NOT_ORDERED" });
      await only("hoa mai", [HOSO2], "tìm + Chờ trả lời", { filter: "UNANSWERED" });
      await only("hoa mai", [HOSO2], "tìm + Chưa ai nhận (chỉ ca đang có việc của người)", { filter: "UNASSIGNED" });
      await only("hoa mai", [HOSO, HOSO2, KHAC_PAGE], "tìm + người phụ trách «chưa ai cầm»", { assignee: "none" });
      await only("hoa mai", [], "tìm + Của tôi", { filter: "MINE" });

      // 7b · Ô TÌM = TOÀN HỘP THƯ (P0 inbox-search-global 12/10/2026) — đi ĐÚNG đường của trang: trạng thái URL ⇒ inboxListQuery ⇒ listInbox.
      const viaPage = async (s: Partial<InboxFilterState>) => {
        const r = await listInbox(admin, inboxListQuery({ ...STATE, limit: 500, ...s }), new Date(T0 + 1000));
        assert.ok(r.ok, JSON.stringify(r));
        return r;
      };
      // Từ «Tin khách chưa đọc», tìm SĐT của hội thoại ĐÃ ĐỌC (HOSO: tin cuối là AI, người xem đã đọc) ⇒ PHẢI ra; ba cách gõ ⇒ CÙNG khách.
      for (const v of ["0900111222", "+84900111222", "0900 111 222"]) {
        const r = await viaPage({ filter: "UNREAD", q: v });
        assert.deepEqual(r.rows.map((x) => x.id), [HOSO], `từ «chưa đọc», «${v}» ⇒ ra hội thoại ĐÃ ĐỌC`);
        assert.equal(r.total, 1);
      }
      // Bộ lọc khác cũng KHÔNG áp ngầm (cần người · người xử lý · chưa ai nhận · page khác).
      assert.deepEqual((await viaPage({ filter: "NEEDS_HUMAN", handler: "HUMAN", assignee: "none", page: PAGE2, q: "0900111222" })).rows.map((x) => x.id), [HOSO], "cần người / người xử lý / page khác không thu hẹp lần tìm");
      // «Chỉ tìm trong bộ lọc hiện tại» (pv=loc) ⇒ UNREAD giữ nguyên ⇒ hội thoại đã đọc KHÔNG ra; gợi ý «Tất cả» đúng số.
      const scopedR = await viaPage({ filter: "UNREAD", q: "0900111222", searchScope: "FILTER" });
      assert.deepEqual(scopedR.rows.map((x) => x.id), [], "trong bộ lọc «chưa đọc»: hội thoại đã đọc không ra");
      assert.equal(scopedR.counts.ALL, 1);
      // Xoá ô tìm ⇒ bộ lọc cũ áp lại: «chưa đọc» không có HOSO.
      const back = await viaPage({ filter: "UNREAD", q: "" });
      assert.ok(!back.rows.some((x) => x.id === HOSO), "xoá ô tìm ⇒ về «chưa đọc» (HOSO đã đọc không có)");
      assert.ok(back.rows.some((x) => x.id === HOSO2), "«chưa đọc» lại có hội thoại chưa đọc");

      // 7c · KHỚP SĐT CHÍNH XÁC XẾP ĐẦU: EXACT ghi SĐT đó (đã đọc, cũ) · MENTION chỉ NHẮC số trong tin (chưa đọc, mới hơn — thứ tự thường đứng trước).
      const EXACT = await mk({ thread: "exact", name: "Khách Khớp Đúng", msgs: [{ side: "C", text: "cho chị hỏi", ago: 120 * MIN }, reply(119 * MIN)], read: true });
      await db.update(c).set({ customerPhone: "0900 246 810" }).where(eq(c.id, EXACT));
      const MENTION = await mk({ thread: "mention", name: "Khách Nhắc Số", msgs: [{ side: "C", text: "chị nhắn giúp số 0900246810 của bạn chị", ago: 2 * MIN }] });
      for (const v of ["0900246810", "+84900246810", "0900 246 810"]) {
        assert.deepEqual((await viaPage({ q: v })).rows.map((x) => x.id), [EXACT, MENTION], `«${v}»: khớp SĐT chính xác đứng đầu, chỉ-nhắc-số đứng sau`);
        assert.deepEqual((await viaPage({ filter: "UNREAD", q: v })).rows.map((x) => x.id), [EXACT, MENTION], `«${v}» từ «chưa đọc»: vẫn toàn hộp thư, khớp chính xác đầu`);
      }
      assert.deepEqual((await viaPage({ filter: "UNANSWERED", searchScope: "FILTER", q: "0900246810" })).rows.map((x) => x.id), [MENTION], "trong «Chờ trả lời»: chỉ hội thoại đang chờ");
      // Số DỞ (không phải SĐT đủ) ⇒ không xếp hạng — thứ tự thường («Tất cả»: tin mới nhất trước).
      assert.deepEqual((await viaPage({ q: "246810" })).rows.map((x) => x.id), [MENTION, EXACT], "số dở: thứ tự thường");
      // EXACT / MENTION ở lại: không khớp ô tìm nào của các bước sau (SĐT / tên riêng).

      // 8 · UNREAD rỗng ⇒ gợi ý «Tất cả» ĐÚNG số (ca của chủ shop).
      const unread = await find("0900111222", { filter: "UNREAD" });
      assert.equal(unread.rows.length, 0, "UNREAD rỗng là ĐÚNG (tin cuối là câu trả lời của AI — đã xử lý)");
      assert.equal(unread.counts.UNREAD, 0);
      assert.equal(unread.counts.ALL, 1, "cùng câu đếm: «Tất cả» có 1");
      const hint = inboxEmptyHint("UNREAD", unread.counts, "0900111222");
      assert.equal(hint?.count, 1, "gợi ý «Có 1 hội thoại khớp ở Tất cả»");

      // 9 · Phân trang: «Xem thêm» (nâng limit) ra ĐÚNG phần nối tiếp; tổng không đổi; không trùng hàng.
      const p50 = await find("Khách nền", { limit: 50 });
      const p100 = await find("Khách nền", { limit: 100 });
      assert.equal(p50.total, FILLER, "tên kênh «Khách nền i» ⇒ đủ 3.000");
      assert.equal(p100.total, p50.total);
      assert.deepEqual(p100.rows.slice(0, 50).map((r) => r.id), p50.rows.map((r) => r.id), "trang sau nối tiếp trang trước");
      assert.equal(new Set(p100.rows.map((r) => r.id)).size, 100);
      const narrow = await find("0911000123");
      assert.equal(narrow.total, 1, "SĐT nền: đúng một hội thoại, không khớp nhầm cả hộp thư");

      // 10 · Đường danh sách mã (`= any`) và điều kiện nguyên khối (nhánh > RESOLVE_MAX) ra CÙNG số.
      for (const v of ["0900111222", "hoa mai", "Khách nền", "333444", `#${manualOrderShortCode(orderId)}`]) {
        const terms = parseInboxSearch(v)!;
        const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(c).leftJoin(schema.customers, eq(schema.customers.id, c.customerId)).where(and(ne(c.channel, "TEST"), inboxSearchSql(terms)));
        assert.equal(Number(n.n), (await find(v)).counts.ALL, `nhánh nguyên khối = nhánh danh sách mã («${v}»)`);
      }

      // 11 · Bỏ dấu: TypeScript = Postgres trên cùng chuỗi (kể cả chữ hoa có dấu và chuỗi NFD).
      for (const s of ["Võ Ngọc Ánh", "PHẠM THỊ ĐÀO", "HoaMai Le", "Trần  Hoa-Thuỷ", "Lê Hoa Mai".normalize("NFD"), "Ánh Ọ Ỵ đ Đ"]) {
        const [r] = await db.select({ v: foldSql(sql`${s}::text`) }).from(sql`(select 1) x`);
        assert.equal(r.v, foldSearchText(s), `bỏ dấu TS = SQL: «${s}»`);
      }

      // 12 · ĐO (≥ 3.000 hội thoại, ~12.000 tin, ~1.000 đơn): trung vị 3 lượt `listInbox` — để so, không phải ngưỡng đạt / không đạt.
      const median = async (q: string) => {
        const xs: number[] = [];
        for (let i = 0; i < 3; i++) {
          const s = performance.now();
          await find(q, { limit: 100 });
          xs.push(performance.now() - s);
        }
        return Math.round(xs.sort((a, b) => a - b)[1]);
      };
      const perf = { none: await median(""), phone: await median("+84 900 333 444"), name: await median("hoa mai"), code: await median(`#${manualOrderShortCode(orderId)}`), broad: await median("Khách nền") };
      console.log(`  · đo PGlite ${FILLER + 7} hội thoại: không tìm ${perf.none} ms · SĐT ${perf.phone} ms · tên ${perf.name} ms · mã đơn ${perf.code} ms · ô tìm rộng (3.000 khớp) ${perf.broad} ms (trung vị 3 lượt — số so, chưa có đích)`);
    });

    // ═══ TỔ CHỨC B nhìn từ phía nó: không thấy khách của A, thấy khách của mình ═══
    await withOrganization(ORG_B, async () => {
      const admin = await adminOf(ORG_B);
      const r = async (q: string) => {
        const x = await listInbox(admin, { filter: "ALL", q, limit: 100 });
        assert.ok(x.ok);
        return x.rows.length;
      };
      assert.equal(await r("0900111222"), 0, "B không thấy SĐT khách của A");
      assert.equal(await r("hoa mai"), 0, "B không thấy tên khách của A");
      assert.equal(await r("+84 900 999 000"), 1, "B thấy khách của chính mình");
    });
    console.log("  ✓ CSDL: SĐT 6 dạng · SĐT trong tin · đơn (SĐT/tên/mã) · Pancake · web · tên khoảng trắng/dấu · tìm × 8 bộ lọc · UNREAD ⇒ gợi ý đúng số · phân trang · hai nhánh cùng số · TS = SQL · tổ chức khác không lọt");
  } finally {
    await cleanup();
  }
}

export async function testInboxSearch() {
  console.log("Hộp thư — tìm kiếm + bộ lọc (inbox-search):");
  testPure();
  testGlobalSearchPure();
  testSource();
  await testDb();
}
