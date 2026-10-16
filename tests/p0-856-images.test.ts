/**
 * ═══════════ ẢNH TRONG HỘP THƯ KHÁCH (P0-B #856 · HSLC «Sương Sung Sướng», 16/10/2026) ═══════════
 *
 * Pancake có ảnh chả mực (khách) + ảnh đóng gói (page) mà hộp thư ERP không hiện. Lần theo đường ảnh, ba chỗ làm mất ảnh:
 *  1. MỘT DÒNG ĐÃ CÓ KHÔNG BAO GIỜ ĐƯỢC BỔ SUNG ẢNH: mọi đường ghi (`receiveFanpageEvent` cả hai phía, `writeThreadPage` của nhập lịch
 *     sử) dùng `onConflictDoNothing(message_id)`. Dòng tới TRƯỚC mà không mang ảnh — lượt QUÉT LẠI (`catchUpFanpage` ghi `imageUrls: []`),
 *     dòng cũ trước 08/10/2026 (bot đọc xong thì XOÁ địa chỉ ảnh · tin page chỉ ảnh không được ghi) — thì webhook tới sau / nhập lịch sử
 *     chạy lại đều bị bỏ qua ⇒ ảnh mất VĨNH VIỄN dù Pancake vẫn giữ.
 *  2. Lượt quét lại tự vứt ảnh: tin khách có chữ + ảnh tới qua đường này được ghi CHỈ chữ.
 *  3. Ảnh AI gửi (ảnh câu mẫu) không lưu địa chỉ, dòng `BOT_SENT` chữ rỗng bị hộp thư bỏ qua ⇒ không bao giờ hiện.
 *
 * Khoá (đi qua ĐÚNG đường ghi + `loadInboxThread`; Pancake GIẢ, không gọi mạng thật — luật 65; mốc theo đồng hồ thật — luật 50):
 *  · ảnh khách (chỉ ảnh · chữ + ảnh) · ảnh page (chỉ ảnh · chữ + ảnh) · ảnh AI · ảnh khách sau khi bot đã đọc ⇒ hiện, đúng thứ tự;
 *  · dòng có sẵn thiếu ảnh ⇒ webhook trùng / nhập lịch sử BỔ SUNG ảnh, không đổi gì khác, không ghi đè ảnh đã có, không tạo dòng thứ hai;
 *  · bổ sung từ Pancake: tin thiếu được ghi (dấu lịch sử ⇒ bot không trả lời), chạy lại ⇒ 0 thay đổi, KHÔNG có lời gọi gửi nào;
 *  · ảnh quảng cáo/tin phía page chỉ ảnh vẫn KHÔNG tính là trả lời (không đổi luật #857);
 *  · quyền: không có `ai_sales:view` ⇒ không đọc được dòng thời gian (ảnh nằm trong đó).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { saveConnection, setConnectionStatus, testOrgConnection } from "@/lib/connectors/service";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { botImageHref, catchUpImageUrls, fanpageVisitorKey, fillMissingImageUrls, receiveFanpageEvent, type FanpageEvent } from "@/lib/sales-chatbot/fanpage";
import { planHistoryMessages, resyncThreadFromPancake, writeThreadPage } from "@/lib/sales-chatbot/history";
import { loadInboxThread } from "@/lib/sales-chatbot/inbox";

const ORG = "p0-856-anh";
const PAGE = "8560000001";
const PAGE_TOKEN = "pancake_page_token_anh856_0123456789abcdef";
const MIN = 60_000;
const IMG = (n: string) => `https://content.pancake.vn/2.1-25/2026/10/16/${n}.jpg`;
const naive = (ms: number) => new Date(ms).toISOString().replace("Z", "");

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

const okFetch = (async () => new Response(JSON.stringify({ success: true, conversations: [], messages: [] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

function testPure() {
  // Lượt quét lại lấy ảnh từ CHÍNH trang tin Pancake vừa đọc (không thêm lời gọi nào).
  const raw = [
    { id: "m1", message: "Chả mực này còn không ạ", attachments: [{ type: "photo", url: IMG("cha-muc") }] },
    { id: "m2", message: "", attachments: [{ type: "sticker", url: "https://x/sticker.png" }] },
  ];
  assert.deepEqual(catchUpImageUrls(raw, "m1"), [IMG("cha-muc")], "tin có chữ + ảnh ⇒ giữ ảnh");
  assert.deepEqual(catchUpImageUrls(raw, "m2"), [], "nhãn dán không phải ảnh để bot đọc");
  assert.deepEqual(catchUpImageUrls(raw, "khong-co"), []);
  // Đường quét lại không còn ghi cứng `imageUrls: []`.
  const src = readFileSync(path.join(process.cwd(), "lib/sales-chatbot/fanpage.ts"), "utf8");
  const catchUp = src.slice(src.indexOf("export async function catchUpFanpage"));
  assert.ok(!/imageUrls: \[\]/.test(catchUp.slice(0, catchUp.indexOf("\n}\n"))), "catchUpFanpage không được vứt ảnh của tin khách");
  assert.equal(botImageHref("abc"), "/api/ai-sales/quick-reply-images/abc", "ảnh AI mở qua tuyến có kiểm quyền đã có");
  // UI: ảnh lỗi / hết hạn có trạng thái rõ, xem ảnh lớn, lazy-load.
  const ui = readFileSync(path.join(process.cwd(), "app/(dashboard)/ai/sales-chatbot/inbox/thread-view.tsx"), "utf8");
  assert.match(ui, /onError/, "ảnh tải lỗi phải có trạng thái lỗi");
  assert.match(ui, /Ảnh không tải được/, "câu trạng thái lỗi rõ ràng");
  assert.match(ui, /loading="lazy"/);
  assert.match(ui, /data-testid="inbox-image-viewer"/, "bấm ảnh ⇒ xem ảnh lớn ngay trong hộp thư");
}

export async function testP0856Images() {
  console.log("Ảnh trong hộp thư khách (P0-B #856):");
  testPure();
  await cleanup();
  const savedKey = process.env.PLATFORM_SECRETS_KEY;
  process.env.PLATFORM_SECRETS_KEY = "khoa-kiem-thu-anh-856-0123456789abcdefghijklmnopqrstuvwxyz";
  try {
    await provisionOrganization({ code: ORG, name: "Shop ảnh", plan: "standard", modules: ["customers", "products", "orders", "inventory", "ai_sales"], admin: { email: `admin@${ORG}.local`, name: "Chủ shop", password: "AnhHop@123456" }, source: "TEST", actor: null });
    const enabled = await getEnabledModules(ORG);
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = { id: u.id, email: u.email, name: u.name, role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: ORG, name: ORG, isHome: false }, modules: [...enabled] } as unknown as SessionUser;
      const viewer = { ...admin, id: "anh-viewer", role: "VIEWER", permissions: ["ai_sales:view"] } as unknown as SessionUser;
      const stranger = { ...admin, id: "anh-nguoi-ngoai", role: "VIEWER", permissions: [] } as unknown as SessionUser;
      assert.ok("ok" in (await saveConnection(admin, { connectorKey: "pancake-fanpage", settings: { pageId: PAGE }, secrets: { pageAccessToken: PAGE_TOKEN } })));
      assert.ok("ok" in (await testOrgConnection(admin, "pancake-fanpage", { tester: { fetch: okFetch } })));
      assert.ok("ok" in (await setConnectionStatus(admin, "pancake-fanpage", "ACTIVE")));

      const c = schema.salesChatConversations;
      const t = schema.salesChatInbound;
      const TH = "t-suong";
      const t0 = Date.now() - 180 * MIN;
      const ev = (p: Partial<FanpageEvent> & { messageId: string }): FanpageEvent => ({ pageId: PAGE, threadId: TH, text: "", customerName: "Sương Sung Sướng", fromPage: false, humanStaff: false, inbox: true, comment: null, imageUrls: [], ...p });
      const thread = async () => {
        const [conv] = await db.select({ id: c.id }).from(c).where(and(eq(c.channel, "FANPAGE"), eq(c.visitorKey, fanpageVisitorKey(PAGE, TH)))).limit(1);
        assert.ok(conv, "hội thoại phải có");
        const r = await loadInboxThread(viewer, conv.id);
        assert.ok(r.ok, JSON.stringify(r));
        return { id: conv.id, items: r.thread.items };
      };
      const row = async (messageId: string) => (await db.select().from(t).where(eq(t.messageId, messageId)))[0];

      // ── 1. Webhook: ảnh khách (chỉ ảnh / chữ + ảnh), ảnh page (chỉ ảnh / chữ + ảnh) ⇒ hiện đúng phía, đúng thứ tự ──
      assert.ok((await receiveFanpageEvent(ev({ messageId: "c-1", text: "Chả mực này shop còn không", imageUrls: [IMG("cha-muc")] }), new Date(t0))).queued);
      await receiveFanpageEvent(ev({ messageId: "c-2", imageUrls: [IMG("cha-muc-2")] }), new Date(t0 + MIN));
      const pageImg = await receiveFanpageEvent(ev({ messageId: "p-1", fromPage: true, imageUrls: [IMG("dong-goi")] }), new Date(t0 + 2 * MIN));
      assert.ok(!pageImg.queued && /không có chữ/.test(pageImg.reason), `ảnh page không chữ KHÔNG tính là trả lời (luật #857): ${pageImg.reason}`);
      await receiveFanpageEvent(ev({ messageId: "p-2", fromPage: true, humanStaff: true, text: "Dạ hàng đóng gói đây ạ", imageUrls: [IMG("dong-goi-2")] }), new Date(t0 + 3 * MIN));
      let items = (await thread()).items;
      const byImage = (u: string) => items.find((i) => i.images.includes(u));
      assert.equal(byImage(IMG("cha-muc"))?.side, "CUSTOMER", "ảnh khách kèm chữ hiện");
      assert.equal(byImage(IMG("cha-muc"))?.text, "Chả mực này shop còn không", "chữ + ảnh không mất phần nào");
      assert.equal(byImage(IMG("cha-muc-2"))?.side, "CUSTOMER", "tin CHỈ ảnh của khách vẫn là một tin mở xem được");
      assert.equal(byImage(IMG("dong-goi"))?.side, "PAGE", "ảnh page (Pancake / nhân viên) không chữ hiện");
      assert.equal(byImage(IMG("dong-goi-2"))?.side, "PAGE", "ảnh page kèm chữ hiện");
      const order = [IMG("cha-muc"), IMG("cha-muc-2"), IMG("dong-goi"), IMG("dong-goi-2")].map((u) => items.findIndex((i) => i.images.includes(u)));
      assert.deepEqual([...order].sort((a, b) => a - b), order, "ảnh nằm đúng vị trí theo thời gian");

      // ── 2. Bot đã đọc ảnh (mô tả ghép vào chữ) ⇒ địa chỉ ảnh vẫn giữ, hộp thư vẫn hiện ──
      await db.update(t).set({ text: "Chả mực này shop còn không\n[Khách gửi ảnh: chả mực chiên vàng]", status: "DONE" }).where(eq(t.messageId, "c-1"));
      items = (await thread()).items;
      assert.ok(byImage(IMG("cha-muc")), "đọc xong không làm mất ảnh");

      // ── 3. Ảnh AI gửi (ảnh câu mẫu) — dòng BOT_SENT mang địa chỉ qua tuyến có kiểm quyền ⇒ hiện ở phía AI ──
      await db.insert(t).values({ pageId: PAGE, threadId: TH, messageId: "bot-out:anh-1", text: "", imageUrls: [botImageHref("qr-menu")], status: "DONE", processedAt: new Date(t0 + 4 * MIN), note: "BOT_SENT", createdAt: new Date(t0 + 4 * MIN) });
      await db.insert(t).values({ pageId: PAGE, threadId: TH, messageId: "pancake-bot-img-id", text: "", status: "DONE", processedAt: new Date(t0 + 4 * MIN), note: "BOT_SENT", createdAt: new Date(t0 + 4 * MIN) });
      items = (await thread()).items;
      assert.equal(byImage(botImageHref("qr-menu"))?.side, "BOT", "ảnh AI gửi phải hiện");
      assert.equal(items.filter((i) => i.side === "BOT").length, 1, "dòng mang mã kênh của cùng tin ảnh (chữ rỗng, không ảnh) không thành bong bóng trống");
      const src = readFileSync(path.join(process.cwd(), "lib/sales-chatbot/fanpage.ts"), "utf8");
      assert.match(src, /imageUrls: up\.sourceIds\.map\(botImageHref\)/, "lượt bot gửi ảnh câu mẫu ghi địa chỉ ảnh vào dòng ghi sẵn");

      // ── 4. Dòng có sẵn THIẾU ảnh (lượt quét lại / dòng cũ) ⇒ webhook trùng tới sau BỔ SUNG ảnh, không dòng thứ hai ──
      await db.insert(t).values({ pageId: PAGE, threadId: TH, messageId: "c-3", text: "Gửi shop ảnh chả mực", status: "DONE", processedAt: new Date(t0 + 5 * MIN), note: null, createdAt: new Date(t0 + 5 * MIN), transport: "PANCAKE" });
      await db.insert(t).values({ pageId: PAGE, threadId: TH, messageId: "p-3", text: "[Ảnh]", status: "DONE", processedAt: new Date(t0 + 6 * MIN), note: "PAGE_REPLY", createdAt: new Date(t0 + 6 * MIN) });
      const before = (await db.select({ id: t.id }).from(t).where(eq(t.threadId, TH))).length;
      await receiveFanpageEvent(ev({ messageId: "c-3", text: "Gửi shop ảnh chả mực", imageUrls: [IMG("cha-muc-3")] }), new Date());
      await receiveFanpageEvent(ev({ messageId: "p-3", fromPage: true, imageUrls: [IMG("dong-goi-3")] }), new Date());
      assert.deepEqual((await row("c-3")).imageUrls, [IMG("cha-muc-3")], "ảnh khách được bổ sung vào dòng có sẵn");
      assert.deepEqual((await row("p-3")).imageUrls, [IMG("dong-goi-3")], "ảnh page được bổ sung vào dòng có sẵn");
      assert.equal((await row("c-3")).status, "DONE", "bổ sung ảnh không đổi trạng thái (không kích AI lần hai)");
      assert.equal((await db.select({ id: t.id }).from(t).where(eq(t.threadId, TH))).length, before, "không dòng thứ hai");
      // Không ghi đè ảnh đã có.
      assert.equal(await fillMissingImageUrls(PAGE, "c-1", [IMG("khac")]), false);
      assert.deepEqual((await row("c-1")).imageUrls, [IMG("cha-muc")], "ảnh đã có giữ nguyên");

      // ── 5. Nhập lịch sử / bổ sung từ Pancake theo mã tin: thiếu ⇒ ghi; có mà thiếu ảnh ⇒ bổ sung; chạy lại ⇒ 0 thay đổi ──
      await db.insert(t).values({ pageId: PAGE, threadId: TH, messageId: "c-4", text: "Ảnh nè", status: "DONE", processedAt: new Date(t0 + 7 * MIN), createdAt: new Date(t0 + 7 * MIN) });
      const pancakeMsgs = [
        { id: "c-4", from: { id: "psid-suong", name: "Sương Sung Sướng" }, message: "Ảnh nè", attachments: [{ type: "photo", url: IMG("cha-muc-4") }], inserted_at: naive(t0 + 7 * MIN) },
        { id: "p-4", from: { id: PAGE, admin_id: "nv-1" }, message: "", attachments: [{ type: "photo", url: IMG("dong-goi-4") }], inserted_at: naive(t0 + 8 * MIN) },
      ];
      const plan = planHistoryMessages(pancakeMsgs, PAGE, { nowMs: Date.now(), freshMs: 2 * MIN, fallbackName: "Sương" });
      const w1 = await writeThreadPage(PAGE, TH, plan.rows, new Date());
      assert.equal(w1.inserted, 1, "tin page thiếu được ghi");
      assert.equal(w1.imagesFilled, 1, "dòng có sẵn thiếu ảnh được bổ sung");
      assert.deepEqual((await row("c-4")).imageUrls, [IMG("cha-muc-4")]);
      assert.deepEqual((await row("p-4")).imageUrls, [IMG("dong-goi-4")]);
      const w2 = await writeThreadPage(PAGE, TH, plan.rows, new Date());
      assert.equal(w2.inserted + w2.imagesFilled, 0, "chạy lại ⇒ không đổi gì (idempotent)");

      // Bổ sung MỘT hội thoại từ Pancake: chỉ GET, tin thiếu mang dấu lịch sử (bot không trả lời), không lời gọi gửi nào.
      const calls: { url: string; method: string }[] = [];
      const pcFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        const body = String(input).includes("current_count") ? { success: true, messages: [] } : { success: true, messages: [...pancakeMsgs, { id: "c-5", from: { id: "psid-suong", name: "Sương" }, message: "", attachments: [{ type: "photo", url: IMG("cha-muc-5") }], inserted_at: naive(t0 + 9 * MIN) }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const conv = await thread();
      assert.ok("error" in (await resyncThreadFromPancake(viewer, conv.id, { fetch: pcFetch, sleep: async () => {} })), "chỉ người quản lý chatbot được bổ sung");
      const rs = await resyncThreadFromPancake(admin, conv.id, { fetch: pcFetch, sleep: async () => {} });
      assert.ok("ok" in rs, JSON.stringify(rs));
      assert.equal(calls.filter((x) => x.method !== "GET").length, 0, "KHÔNG gửi gì cho khách");
      const c5 = await row("c-5");
      assert.deepEqual(c5.imageUrls, [IMG("cha-muc-5")]);
      assert.equal(c5.status, "DONE", "tin bổ sung không vào hàng chờ của bot");
      assert.ok(c5.importedAt, "mang dấu nhập lịch sử");
      const again = await resyncThreadFromPancake(admin, conv.id, { fetch: pcFetch, sleep: async () => {} });
      assert.ok("ok" in again && /0 tin mới/.test(again.message) && /0 ảnh/.test(again.message), JSON.stringify(again));
      items = (await thread()).items;
      for (const u of ["cha-muc-3", "dong-goi-3", "cha-muc-4", "dong-goi-4", "cha-muc-5"]) assert.ok(byImage(IMG(u)), `ảnh ${u} hiện sau khi bổ sung`);

      // ── 6. Quyền: không có quyền xem AI bán hàng ⇒ không đọc được dòng thời gian (ảnh nằm trong đó) ──
      const denied = await loadInboxThread(stranger, conv.id);
      assert.ok(!denied.ok, "người ngoài không xem được ảnh hội thoại");
    });
    console.log("  ✓ đạt");
  } finally {
    if (savedKey === undefined) delete process.env.PLATFORM_SECRETS_KEY;
    else process.env.PLATFORM_SECRETS_KEY = savedKey;
    await cleanup();
  }
}

if (process.argv[1]?.endsWith("p0-856-images.test.ts")) {
  testP0856Images().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
