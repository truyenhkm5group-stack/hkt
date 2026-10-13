/**
 * ═══════════ P0 inbox-list-perf (13/10/2026) — HỘP THƯ HSLC 13–29 GIÂY, MỞ HỘI THOẠI KẸT «ĐANG MỞ…» ═══════════
 *
 * Production (ops inbox-perf-probe, HSLC 3.629 hội thoại): listInbox nguội p50 13.364 ms, nạp MỘT hội thoại 155 ms. Fixture #792 (3.000
 * hội thoại) ~117 ms. Tái hiện ở đây: cột lưu sẵn 0245 có ⇒ listInbox ~0,1 giây; tổ chức CHƯA có cột (DEGRADED_MIGRATION — lượt dẫn
 * xuất 0245 quá 600 giây) ⇒ định nghĩa #803 tính cho TỪNG hội thoại, ba lượt trên cả hộp thư, và vế «tin mẫu cũ» dò CHÉO LUỒNG mọi
 * dòng PAGE_REPLY của page cho mỗi dòng phía page sau tin khách cuối. Lịch sử dài có tin chào mẫu (sender_kind NULL) ⇒ hàng chục giây.
 * Khoá:
 *  1. THỨ TỰ RẺ TRƯỚC (`CHEAP_FIRST`) ≡ bản chuẩn (`CANONICAL` — thân hàm CSDL 0245) TỪNG hội thoại, trên fixture có lịch sử mẫu chào;
 *  2. listInbox tính trực tiếp ≡ listInbox lưu sẵn (thẻ · thứ tự · cờ · số chưa đọc) — tập «chưa đọc» dựng MỘT lần;
 *  3. số đo trước / sau in ra (không ngưỡng — AGENTS 38). Trong `npm test` fixture NHỎ (1.000 hội thoại, 200 luồng lịch sử dài — đủ
 *     cho đối chiếu từng hội thoại, ~1 lượt mỗi phép đo); lượt ĐO ≥ 5.000 hội thoại chạy riêng: `npm run perf:inbox` (cờ `--big`). Lý do:
 *     CI chạy npm test HAI lần với trần 30 phút — bản 5.000 hội thoại (đường cũ 18–34 s/lượt) làm job «có token giả» bị huỷ (#827);
 *  4. chuyển hội thoại: phần thuần chọn đúng payload khi bấm nhanh A→B→C, câu trả lời muộn không đè; tự làm mới không chồng lượt và
 *     giãn nhịp; khung chat không còn `router.refresh()`; trang nạp hội thoại SONG SONG với danh sách.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { forgetMemo } from "@/lib/cache";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { listInbox } from "@/lib/sales-chatbot/inbox";
import { INBOX_UNREAD_SWITCH_KEY, inboxUnreadMaterialized } from "@/lib/sales-chatbot/inbox-unread";
import { acceptThreadResponse, nextRefreshDelayMs, pickThreadPayload, REFRESH_MAX_DELAY_MS, refreshDue, serverPayloadFresh, THREAD_FETCH_TIMEOUT_MS } from "@/lib/sales-chatbot/inbox-switch-shared";
import { humanSeenAtSql, latestCustomerTurnUnhandledFor, type TurnSqlOrder } from "@/lib/sales-chatbot/response-ownership-ledger";
import { buildInboxFixture } from "./inbox-unread-fixture";
import { seedInboxFixture } from "./inbox-unread-seed";

const ORG = "hop-thu-list-perf";
const PAGE = "pg-list-perf";
/** Cỡ fixture: `npm test` = nhỏ (đối chiếu); `npm run perf:inbox` (`--big`) = ≥ 5.000 hội thoại (đo). */
type Size = { n: number; heavy: number; runs: number };
const SMALL: Size = { n: 1000, heavy: 200, runs: 1 };
const BIG: Size = { n: 5000, heavy: 600, runs: 3 };
const HIST = 10;
const TPL = "Chào bạn! Cảm ơn bạn đã nhắn tin cho shop. Shop sẽ phản hồi trong ít phút, bạn vui lòng chờ nhé ạ.";

function testPure() {
  // Tự làm mới: bình thường đúng nhịp; máy chủ chậm ⇒ gấp đôi thời gian lượt trước, trần 60 giây.
  assert.equal(nextRefreshDelayMs(5_000, null), 5_000);
  assert.equal(nextRefreshDelayMs(5_000, 800), 5_000, "lượt nhanh ⇒ nhịp thường");
  assert.equal(nextRefreshDelayMs(5_000, 13_000), 26_000, "HSLC 13 giây ⇒ chờ 26 giây, không dồn ba lượt chồng nhau");
  assert.equal(nextRefreshDelayMs(5_000, 90_000), REFRESH_MAX_DELAY_MS, "trần giãn nhịp");
  assert.equal(nextRefreshDelayMs(5_000, Number.NaN), 5_000);
  const base = { now: 100_000, notBefore: 90_000, visible: true, lastDoneAt: 95_000, everyMs: 5_000 };
  assert.equal(refreshDue({ ...base, pending: true }), false, "lượt trước CHƯA xong ⇒ không chồng lượt (dù đã quá hạn hẹn)");
  assert.equal(refreshDue({ ...base, pending: false }), true);
  assert.equal(refreshDue({ ...base, pending: false, notBefore: 120_000 }), false, "chưa tới mốc hẹn (đã giãn)");
  assert.equal(refreshDue({ ...base, pending: false, visible: false }), false, "tab ẩn: thưa gấp 6");
  assert.equal(refreshDue({ ...base, pending: false, visible: false, lastDoneAt: 60_000 }), true);

  // Chuyển hội thoại liên tục A→B→C, câu trả lời về SAI THỨ TỰ (C về trước, A và B về muộn).
  type P = { id: string };
  const fetched = new Map<string, { at: number; payload: P }>();
  let wanted: string | null = null;
  const respond = (id: string, at: number) => {
    if (acceptThreadResponse(id, wanted)) fetched.set(id, { at, payload: { id } });
  };
  const noServer = { id: null, s: null };
  wanted = "A";
  wanted = "B";
  wanted = "C";
  assert.equal(pickThreadPayload("C", noServer, fetched), null, "chưa có bản nào của C ⇒ «Đang mở…», KHÔNG hiện A / B");
  respond("C", 3);
  respond("A", 4);
  respond("B", 5);
  assert.deepEqual(pickThreadPayload("C", noServer, fetched)?.payload, { id: "C" }, "hiện đúng C — A / B về muộn không đè");
  assert.ok(!fetched.has("A") && !fetched.has("B"), "câu trả lời của hội thoại đã rời không được ghi");
  // Bản trang dựng (tự làm mới) mới hơn bản route ⇒ hiện bản mới hơn; bản trang dựng của hội thoại KHÁC không bao giờ được chọn.
  assert.deepEqual(pickThreadPayload("C", { id: "C", s: { at: 9, payload: { id: "C" } } }, fetched)?.at, 9);
  assert.deepEqual(pickThreadPayload("C", { id: "A", s: { at: 99, payload: { id: "A" } } }, fetched)?.payload, { id: "C" });
  assert.equal(pickThreadPayload(null, noServer, fetched), null);
  assert.equal(serverPayloadFresh("C", { id: "C", s: { at: 1_000, payload: { id: "C" } } }, 2_500), true, "vừa dựng ⇒ khỏi nạp lại");
  assert.equal(serverPayloadFresh("C", { id: "C", s: { at: 1_000, payload: { id: "C" } } }, 3_500), false);
  assert.equal(serverPayloadFresh("C", { id: "A", s: { at: 1_000, payload: { id: "A" } } }, 1_100), false);
  assert.ok(THREAD_FETCH_TIMEOUT_MS >= 10_000 && THREAD_FETCH_TIMEOUT_MS <= 30_000);
  console.log("  ✓ thuần: tự làm mới không chồng lượt + giãn nhịp (13 s ⇒ 26 s, trần 60 s) · A→B→C sai thứ tự ⇒ hiện đúng C, A/B muộn bị bỏ");
}

function testSource() {
  const pane = readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/thread-pane.tsx", "utf8");
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code(pane), /router\.refresh\(|useRouter/, "chuyển hội thoại KHÔNG dựng lại trang (không chạy lại listInbox)");
  assert.match(pane, /THREAD_FETCH_TIMEOUT_MS/, "nạp hội thoại có hạn chờ");
  assert.match(pane, /acceptThreadResponse\(selected, wanted\.current\)/, "câu trả lời cũ không đè hội thoại đang chọn");
  assert.match(pane, /data-testid="inbox-thread-retry"/, "lỗi / quá hạn ⇒ nút Thử lại");
  const auto = code(readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/auto-refresh.tsx", "utf8"));
  assert.match(auto, /useTransition\(\)/, "«đang chạy» = isPending của transition làm mới");
  assert.match(auto, /nextRefreshDelayMs\(everyMs, now - c\.startedAt\)/, "giãn nhịp theo thời gian lượt trước thật sự mất");
  assert.doesNotMatch(auto, /Math\.min\(everyMs, 4_000\)/, "không còn nhả cờ bận sau 4 giây khi lượt trước chưa xong");
  const page = code(readFileSync("app/(dashboard)/ai/sales-chatbot/inbox/page.tsx", "utf8"));
  assert.match(page, /await Promise\.all\(\[\s*selected \? inboxThreadPayload\(user, selected\) : Promise\.resolve\(null\),\s*listInbox\(user, inboxListQuery\(state\)\),/, "trang nạp hội thoại SONG SONG với danh sách");
  const inbox = readFileSync("lib/sales-chatbot/inbox.ts", "utf8");
  const body = inbox.slice(inbox.indexOf("export async function listInbox"), inbox.indexOf("export async function customerHistory"));
  assert.equal((body.match(/unreadSql\.unread/g) ?? []).length, 2, "listInbox dùng biểu thức #803 đúng hai chỗ: mặc định + MỘT lượt dựng tập khi tính trực tiếp");
  assert.match(body, /if \(!unreadSql\.materialized\) \{[\s\S]*?inArray\(c\.id, ids\)/, "tính trực tiếp ⇒ tập chưa đọc dựng MỘT lần, bộ đếm + khoá xếp đọc tập");
  const led = readFileSync("lib/sales-chatbot/response-ownership-ledger.ts", "utf8");
  assert.match(led, /then \$\{latestCustomerTurnUnhandledFor\(col\("page_id"\), col\("thread_id"\), seen, "CHEAP_FIRST"\)\}/, "hộp thư dùng thứ tự rẻ trước");
  assert.match(readFileSync("lib/sales-chatbot/inbox-unread-render.ts", "utf8"), /latestCustomerTurnUnhandledFor\(sql\.raw\("p_page"\), sql\.raw\("p_thread"\), sql\.raw\("p_seen"\)\)/, "thân hàm CSDL 0245 vẫn dựng từ bản CHUẨN");
  console.log("  ✓ mã nguồn: khung chat không router.refresh · hạn chờ + thử lại · tự làm mới theo isPending · trang nạp hội thoại song song · tập chưa đọc một lượt · 0245 vẫn đọc bản chuẩn");
}

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.settings).where(eq(schema.settings.key, INBOX_UNREAD_SWITCH_KEY));
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
}

const p50 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function testDb(size: Size) {
  const N = size.n;
  const HEAVY = size.heavy;
  await cleanup();
  try {
    await provisionOrganization({ code: ORG, name: "Shop hộp thư lớn", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "HopThu@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const [s1] = await db.insert(schema.users).values({ email: `lan@${ORG}.local`, name: "Lan CSKH", passwordHash: "x", role: "CS" }).returning({ id: schema.users.id });

      // ═══ Fixture ≥ 5.000 hội thoại (đường ghi thật — trigger 0245 giữ cột) ═══
      const T0 = Date.now() - 4 * 3_600_000;
      const fx = buildInboxFixture({ seed: 23, conversations: N, t0: T0, cursorShare: [0.45, 0.1] });
      const ids = await seedInboxFixture(fx, PAGE, [admin.id, s1.id]);
      assert.ok(ids.size >= N);

      // Lịch sử dài kiểu HSLC cho HEAVY luồng: tin khách cũ xen tin chào MẪU dài (PAGE_REPLY, sender_kind NULL — dòng trước 0244) và một tin
      // mẫu 2 phút SAU tin cuối (vế «tin mẫu cũ» phải dò chéo luồng). Ghi với trigger tạm tắt (nhanh), rồi dẫn xuất lại cột cho ĐÚNG các
      // luồng đó bằng chính hàm CSDL 0245 — như lượt dẫn xuất của migration.
      const heavy = fx.filter((v) => v.channel === "FANPAGE" && v.msgs.length).slice(0, HEAVY);
      const rows: (typeof t.$inferInsert)[] = [];
      for (const v of heavy) {
        const first = v.msgs[0].at;
        const last = v.msgs[v.msgs.length - 1].at;
        for (let i = 0; i < HIST; i++) rows.push({ pageId: PAGE, threadId: v.key, messageId: `lp-${v.key}-${i}`, text: i % 2 ? TPL : "Khách hỏi cũ", note: i % 2 ? PAGE_REPLY : null, kind: "INBOX", status: "DONE", createdAt: new Date(first - (HIST - i) * 3_600_000) });
        rows.push({ pageId: PAGE, threadId: v.key, messageId: `lp-${v.key}-tail`, text: TPL, note: PAGE_REPLY, kind: "INBOX", status: "DONE", createdAt: new Date(last + 120_000) });
      }
      // Ca biên của vế tin mẫu: cùng chữ nhưng CŨ hơn 168 giờ ở luồng khác (không phải tin mẫu ⇒ có thể là câu trả lời) · chữ < 40 ký tự.
      rows.push({ pageId: PAGE, threadId: heavy[0].key, messageId: "lp-old-tpl", text: `${TPL} (bản cũ)`, note: PAGE_REPLY, kind: "INBOX", status: "DONE", createdAt: new Date(T0 - 200 * 3_600_000) });
      rows.push({ pageId: PAGE, threadId: heavy[1].key, messageId: "lp-old-tpl-2", text: `${TPL} (bản cũ)`, note: PAGE_REPLY, kind: "INBOX", status: "DONE", createdAt: new Date(heavy[1].msgs[heavy[1].msgs.length - 1].at + 180_000) });
      await db.execute(sql.raw("set session_replication_role = replica"));
      try {
        for (let i = 0; i < rows.length; i += 1000) await db.insert(t).values(rows.slice(i, i + 1000));
      } finally {
        await db.execute(sql.raw("set session_replication_role = origin"));
      }
      const heavyIds = heavy.map((v) => ids.get(v.key)!);
      await db.execute(sql`update "sales_chat_conversations" c set "turn_unhandled" = "sales_chat_turn_unhandled_of"(c."id", c."page_id", c."thread_id", greatest(c."last_read_at", c."staff_seen_at")) where c."id" in ${heavyIds}`);

      // ═══ 1. CHEAP_FIRST ≡ CANONICAL từng hội thoại ═══
      const col = (n: string) => sql.raw(`"sales_chat_conversations"."${n}"`);
      const seen = humanSeenAtSql(col("id"), col("staff_seen_at"));
      const turn = (o: TurnSqlOrder) => latestCustomerTurnUnhandledFor(col("page_id"), col("thread_id"), seen, o);
      const diff = await db.select({ id: c.id }).from(c).where(sql`${c.pageId} is not null and (${turn("CANONICAL")}) is distinct from (${turn("CHEAP_FIRST")})`);
      assert.deepEqual(diff, [], "thứ tự rẻ trước cho ĐÚNG kết quả của bản chuẩn ở mọi hội thoại");
      const cached = await db.select({ id: c.id }).from(c).where(sql`${c.pageId} is not null and ${c.turnUnhandled} is distinct from (${turn("CHEAP_FIRST")})`);
      assert.deepEqual(cached, [], "và ĐÚNG kết quả lưu sẵn của thân hàm CSDL 0245");
      const timeTurn = async (o: TurnSqlOrder, onlyHeavy: boolean) => {
        const t0 = performance.now();
        const [r] = await db.select({ n: sql<number>`count(*) filter (where ${turn(o)})::int` }).from(c).where(onlyHeavy ? inArray(c.id, heavyIds) : sql`${c.pageId} is not null`);
        return { ms: Math.round(performance.now() - t0), n: Number(r.n) };
      };
      const canon = await timeTurn("CANONICAL", false);
      const cheap = await timeTurn("CHEAP_FIRST", false);
      assert.equal(canon.n, cheap.n);
      const canonH = await timeTurn("CANONICAL", true);
      const cheapH = await timeTurn("CHEAP_FIRST", true);
      console.log(`  ✓ CHEAP_FIRST ≡ CANONICAL ≡ cột 0245 trên ${ids.size} hội thoại (${rows.length} dòng lịch sử mẫu chào ở ${HEAVY} luồng) · cả hộp thư ${canon.ms} → ${cheap.ms} ms · riêng ${HEAVY} luồng lịch sử dài ${canonH.ms} → ${cheapH.ms} ms (${cheap.n} chưa xử lý)`);

      // ═══ 2 + 3. listInbox: lưu sẵn ≡ tính trực tiếp; số đo ≥ 5.000 hội thoại ═══
      type Listed = Extract<Awaited<ReturnType<typeof listInbox>>, { ok: true }>;
      const run = async (filter: "ALL" | "UNREAD" | "UNANSWERED"): Promise<{ r: Listed; ms: number[] }> => {
        const ms: number[] = [];
        let last: Listed | null = null;
        for (let i = 0; i < size.runs; i++) {
          const t0 = performance.now();
          const r = await listInbox(admin, { filter, limit: 100 });
          ms.push(performance.now() - t0);
          if (!r.ok) throw new Error(r.error);
          last = r;
        }
        return { r: last!, ms };
      };
      const pdb = await getPlatformDb();
      const sw = async (enabled: boolean) => {
        const value = JSON.stringify({ enabled });
        await pdb.insert(schema.settings).values({ key: INBOX_UNREAD_SWITCH_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
        await forgetMemo("inbox-unread-switch");
        assert.equal(await inboxUnreadMaterialized(), enabled);
      };
      const shape = (r: Listed) => ({ counts: r.counts, total: r.total, rows: r.rows.map((x) => `${x.id}:${x.unread ? 1 : 0}:${x.unreadCount}`) });
      const report: string[] = [];
      for (const f of ["ALL", "UNREAD"] as const) {
        await sw(true);
        const mat = await run(f);
        await sw(false);
        const live = await run(f);
        assert.deepEqual(shape(live.r), shape(mat.r), `listInbox ${f}: tính trực tiếp ≡ lưu sẵn (thẻ · thứ tự · cờ · số chưa đọc)`);
        report.push(`${f} lưu sẵn p50 ${Math.round(p50(mat.ms))} ms · tính trực tiếp p50 ${Math.round(p50(live.ms))} ms`);
      }
      await pdb.delete(schema.settings).where(eq(schema.settings.key, INBOX_UNREAD_SWITCH_KEY));
      await forgetMemo("inbox-unread-switch");
      const total = await db.select({ n: sql<number>`count(*)::int` }).from(c).where(ne(c.channel, "TEST"));
      console.log(`  ✓ listInbox trên ${total[0].n} hội thoại — ${report.join(" · ")} (đường cũ tính #803 ba lượt trên cả hộp thư: ≈ 2 × ${canon.ms} ms)`);
    });
  } finally {
    await cleanup();
  }
}

export async function testInboxListPerf(size: Size = SMALL) {
  console.log(`Hộp thư — P0 inbox-list-perf (listInbox nhanh khi chưa có cột 0245, chuyển hội thoại không dựng lại danh sách) · ${size.n} hội thoại:`);
  const t0 = Date.now();
  testPure();
  testSource();
  await testDb(size);
  console.log(`  (bài chạy ${Math.round((Date.now() - t0) / 1000)} s)`);
}

if (process.argv[1] && /inbox-list-perf\.test\.ts$/.test(process.argv[1])) {
  const size = process.argv.includes("--big") ? BIG : SMALL;
  import("./setup-env")
    .then(() => import("@/db/migrate"))
    .then(({ ensureMigrated }) => ensureMigrated())
    .then(() => testInboxListPerf(size))
    .then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
}
