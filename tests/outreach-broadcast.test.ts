import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { conversationVerdict, META_WINDOW_MARGIN_MINUTES, timesFromMessages } from "@/lib/constants/outreach-broadcast";
import type { PancakeMessage } from "@/lib/integrations/pancake/pages";
import { createBroadcast, resumeBroadcast, runBroadcast, stopBroadcast, type BroadcastClient } from "@/lib/outreach/broadcast";
import { previewBroadcast } from "@/lib/queries/outreach-broadcast";

/**
 * ═══════ GỬI TIN HÀNG LOẠT: ĐÚNG NGƯỜI, MỖI NGƯỜI MỘT LẦN, KHÔNG NGOÀI 24 GIỜ ═══════
 *
 * Mọi mốc dựng TƯƠNG ĐỐI với đồng hồ thật (AGENTS.md mục 50): truy vấn lọc đơn theo `now()` của CSDL.
 */

const H = 3_600_000;

/* ───── 1 · Luật thuần ───── */
export function testBroadcastVerdictPure() {
  const now = new Date("2026-09-26T10:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * H);
  const shopLast = { replyState: "SHOP_LAST" as const, minSilenceHours: 1 };

  assert.equal(conversationVerdict({ lastCustomerAt: null, lastShopAt: ago(2) }, shopLast, now), "NO_CUSTOMER_MESSAGE");
  // Biên an toàn: 24 giờ trừ 10 phút. Ngay trước biên còn nhắn được, đúng biên thì không.
  const bien = 24 - META_WINDOW_MARGIN_MINUTES / 60;
  assert.equal(conversationVerdict({ lastCustomerAt: ago(bien - 0.01), lastShopAt: ago(bien - 0.5) }, { replyState: "ANY", minSilenceHours: 0 }, now), null, "trước biên 24 giờ còn nhắn được");
  assert.equal(conversationVerdict({ lastCustomerAt: ago(bien), lastShopAt: ago(1) }, shopLast, now), "OUTSIDE_WINDOW", "chạm biên ⇒ Meta sẽ từ chối, không gửi");
  // Ngoài cửa sổ là lý do MẠNH NHẤT — đứng trước mọi lý do khác.
  assert.equal(conversationVerdict({ lastCustomerAt: ago(30), lastShopAt: ago(40) }, shopLast, now), "OUTSIDE_WINDOW");

  assert.equal(conversationVerdict({ lastCustomerAt: ago(3), lastShopAt: ago(2) }, shopLast, now), null, "shop nhắn cuối, im 2 giờ ⇒ gửi");
  assert.equal(conversationVerdict({ lastCustomerAt: ago(2), lastShopAt: ago(3) }, shopLast, now), "CUSTOMER_REPLIED", "khách nhắn cuối ⇒ nhân viên trả lời, máy không bắn tin mẫu");
  assert.equal(conversationVerdict({ lastCustomerAt: ago(2), lastShopAt: null }, shopLast, now), "CUSTOMER_REPLIED", "shop chưa nhắn gì ⇒ khách là người nhắn cuối");
  assert.equal(conversationVerdict({ lastCustomerAt: ago(3), lastShopAt: ago(2) }, { replyState: "CUSTOMER_LAST", minSilenceHours: 0 }, now), "SHOP_REPLIED");
  assert.equal(conversationVerdict({ lastCustomerAt: ago(3), lastShopAt: ago(0.5) }, shopLast, now), "NOT_SILENT_YET", "im chưa đủ 1 giờ");
  assert.equal(conversationVerdict({ lastCustomerAt: ago(3), lastShopAt: ago(0.5) }, { replyState: "SHOP_LAST", minSilenceHours: 0 }, now), null);

  const KHACH_HOI = ago(5);
  const SHOP_GUI_ANH = ago(4);
  const t = timesFromMessages([
    { fromPage: false, insertedAt: KHACH_HOI, text: "giá bao nhiêu", hasAttachment: false },
    { fromPage: true, insertedAt: SHOP_GUI_ANH, text: "", hasAttachment: true },
    { fromPage: false, insertedAt: ago(1), text: "", hasAttachment: false }, // tin rỗng (sự kiện hệ thống) KHÔNG phải khách nhắn lại
    { fromPage: true, insertedAt: null, text: "không có mốc", hasAttachment: false },
  ]);
  assert.equal(t.lastCustomerAt, KHACH_HOI);
  assert.equal(t.lastShopAt, SHOP_GUI_ANH, "ảnh của shop là một tin");
  console.log("✓ Gửi tin hàng loạt · luật thuần: ngoài 24 giờ (trừ biên 10 phút) không gửi · khách nhắn cuối để nhân viên · im chưa đủ giờ chờ · tin rỗng không tính");
}

/* ───── 2 · Xem trước → chụp danh sách → gửi, trên CSDL thật với client Pancake GIẢ ───── */
export async function testBroadcastFlowDb(db: Db) {
  const P = "obc-";
  const PAGE = `${P}page`;
  const ago = (h: number) => new Date(Date.now() - h * H);
  const conv = (id: string, v: Partial<typeof schema.conversationFunnel.$inferInsert>) => ({ pageId: PAGE, conversationId: `${P}${id}`, pancakeCustomerId: `cust-${id}`, customerName: `Nguyễn Thị ${id}`, ...v });
  try {
    await db.insert(schema.conversationFunnel).values([
      conv("ok1", { lastCustomerMessageAt: ago(5), lastShopMessageAt: ago(4), tags: ["Kiểm hàng"] }),
      conv("ok2", { lastCustomerMessageAt: ago(6), lastShopMessageAt: ago(3), tags: ["Kiểm hàng"] }),
      conv("fail", { lastCustomerMessageAt: ago(7), lastShopMessageAt: ago(6), tags: ["Kiểm hàng"] }),
      conv("replied-live", { lastCustomerMessageAt: ago(8), lastShopMessageAt: ago(7), tags: ["Kiểm hàng"] }),
      conv("old", { lastCustomerMessageAt: ago(30), lastShopMessageAt: ago(29), tags: ["Kiểm hàng"] }),
      conv("cust-last", { lastCustomerMessageAt: ago(2), lastShopMessageAt: ago(3), tags: ["Kiểm hàng"] }),
      conv("ordered", { lastCustomerMessageAt: ago(5), lastShopMessageAt: ago(4), tags: ["Kiểm hàng"], phone: "0911000111" }),
      conv("tag-out", { lastCustomerMessageAt: ago(5), lastShopMessageAt: ago(4), tags: ["Kiểm hàng", "Đã gửi"] }),
      conv("no-cust", { lastCustomerMessageAt: ago(5), lastShopMessageAt: ago(4), tags: ["Kiểm hàng"], pancakeCustomerId: "" }),
    ]);
    // Đơn ghép theo SĐT, KHÔNG theo hội thoại — luật "đã có đơn" phải bắt được cả đường này.
    await db.insert(schema.orders).values({ id: `${P}order`, stage: "NEW", billPhone: "0911000111", insertedAt: ago(10) });

    const filters = { pageIds: [PAGE], from: "", to: "", tagsAny: ["Kiểm hàng"], tagsNone: ["Đã gửi"], replyState: "SHOP_LAST" as const, minSilenceHours: 1, phone: "ANY" as const, order: "NO_ORDER" as const, skipRecentHours: 24, limit: 500 };
    const p = await previewBroadcast(filters);
    assert.deepEqual(
      p.eligible.map((e) => e.conversationId),
      [`${P}replied-live`, `${P}fail`, `${P}ok2`, `${P}ok1`],
      "đúng bốn khách, GẦN HẠN 24 giờ nhất đi trước",
    );
    assert.equal(p.excluded.OUTSIDE_WINDOW, 1, "khách quá 24 giờ được ĐẾM, không biến mất");
    assert.equal(p.excluded.CUSTOMER_REPLIED, 1);
    assert.equal(p.excluded.HAS_ORDER, 1, "đơn ghép bằng SĐT cũng là đã có đơn");
    assert.equal(p.excluded.NO_CUSTOMER_ID, 1);
    assert.equal(p.excluded.RECENTLY_BROADCAST, undefined);
    assert.ok(!p.eligible.some((e) => e.conversationId === `${P}tag-out`), "thẻ loại trừ thắng thẻ bắt buộc");

    const limited = await previewBroadcast({ ...filters, limit: 2 });
    assert.equal(limited.eligible.length, 2);
    assert.equal(limited.excluded.OVER_LIMIT, 2, "vượt trần được đếm, không lặng lẽ cắt");

    const created = await createBroadcast({ filters, messages: ["Chào {ten} ơi", "Tin thứ hai"], mediaUrls: [], gapSeconds: 1 }, { id: null, label: "test" });
    assert.ok(created.ok);
    if (!created.ok) return;
    const second = await createBroadcast({ filters, messages: ["x"], mediaUrls: [], gapSeconds: 1 }, { id: null, label: "test" });
    assert.equal(second.ok, false, "đang có lượt chạy ⇒ không tạo lượt thứ hai (hai lượt song song dễ nhắn một khách hai lần)");

    // Client GIẢ: không một tin thật nào rời máy.
    const sends: { conv: string; text: string }[] = [];
    const client: BroadcastClient = {
      async listMessages(_page, conversationId) {
        const at = (h: number) => new Date(Date.now() - h * H);
        const m = (fromPage: boolean, h: number): PancakeMessage => ({ id: `${fromPage}-${h}`, text: "x", fromId: "", fromName: "", fromPage, insertedAt: at(h), hasAttachment: false });
        // Khách vừa nhắn lại SAU lượt quét — lượt kiểm lại phải thấy và để nhân viên trả lời.
        if (conversationId === `${P}replied-live`) return [m(false, 8), m(true, 7), m(false, 0.1)];
        return [m(false, 5), m(true, 3)];
      },
      async sendMessage(_page, conversationId, _cust, text) {
        await new Promise((r) => setTimeout(r, 2));
        if (conversationId === `${P}fail`) return { ok: false, error: "(#10) Tin nhắn này được gửi ngoài khoảng thời gian cho phép" };
        sends.push({ conv: conversationId, text });
        return { ok: true, id: `mid-${conversationId}-${sends.length}` };
      },
      async sendAttachment() {
        return { ok: true };
      },
    };
    const noSleep = async () => undefined;

    // Hai vòng chạy CÙNG LÚC trên cùng một lượt: vòng sau nhận lượt, vòng trước tự thoát; mỗi khách tối đa một lần.
    const [runA, runB] = await Promise.all([runBroadcast(created.broadcastId, { client, sleep: noSleep }), runBroadcast(created.broadcastId, { client, sleep: noSleep })]);
    const xuLy = (c: { sent: number; skipped: number; failed: number }) => c.sent + c.skipped + c.failed;
    assert.equal(xuLy(runA) + xuLy(runB), 4, "mỗi khách được xử lý đúng một lần");
    assert.ok(Math.min(xuLy(runA), xuLy(runB)) <= 1, "vòng bị thay chỉ làm nốt khách đang cầm rồi thoát — mỗi lượt MỘT vòng chạy, không gửi gấp đôi nhịp");
    const R = schema.outreachBroadcastRecipients;
    const rows = await db.select().from(R).where(eq(R.broadcastId, created.broadcastId));
    const by = new Map(rows.map((r) => [r.conversationId.slice(P.length), r]));
    assert.equal(by.get("ok1")?.status, "SENT");
    assert.equal(by.get("ok1")?.messagesSent, 2, "gửi đủ hai tin");
    assert.equal(by.get("ok2")?.status, "SENT");
    assert.equal(by.get("fail")?.status, "FAILED");
    assert.equal(by.get("fail")?.reason, "POLICY_WINDOW", "lỗi được phân loại để bảng nói được việc phải làm");
    assert.equal(by.get("replied-live")?.status, "SKIPPED");
    assert.equal(by.get("replied-live")?.reason, "CUSTOMER_REPLIED", "khách vừa nhắn trong lúc chạy ⇒ KHÔNG bắn tin mẫu");
    for (const c of ["ok1", "ok2"]) assert.equal(sends.filter((s) => s.conv === `${P}${c}`).length, 2, `${c}: đúng hai tin, không hơn — hai vòng song song không nhân đôi`);
    assert.ok(sends.some((s) => s.text.startsWith("Chào chị ")), "biến {ten} được thay");
    const [b] = await db.select().from(schema.outreachBroadcasts).where(eq(schema.outreachBroadcasts.id, created.broadcastId));
    assert.equal(b.status, "DONE");

    // Chạy lại lượt đã xong: không gửi thêm gì.
    const before = sends.length;
    await runBroadcast(created.broadcastId, { client, sleep: noSleep });
    assert.equal(sends.length, before, "lượt đã xong không bị gửi lại");

    // Lượt mới cùng bộ lọc: khách vừa nhận tin bị loại.
    const again = await previewBroadcast(filters);
    assert.equal(again.excluded.RECENTLY_BROADCAST, 2, "khách đã nhận tin trong 24 giờ không nhận lần hai");

    // Dừng → tiếp tục: dòng chưa gửi còn nguyên; dòng kẹt SENDING (máy chủ chết giữa lúc gửi) KHÔNG gửi lại.
    const b2 = await createBroadcast({ filters: { ...filters, skipRecentHours: 0 }, messages: ["Tin"], mediaUrls: [], gapSeconds: 1 }, { id: null, label: "test" });
    assert.ok(b2.ok);
    if (!b2.ok) return;
    assert.ok(await stopBroadcast(b2.broadcastId, { id: null, label: "test" }));
    const stoppedRun = await runBroadcast(b2.broadcastId, { client, sleep: noSleep });
    assert.equal(stoppedRun.sent + stoppedRun.skipped + stoppedRun.failed, 0, "lượt đã dừng không gửi gì");
    const [stuck] = await db.select().from(R).where(eq(R.broadcastId, b2.broadcastId)).orderBy(R.seq).limit(1);
    await db.update(R).set({ status: "SENDING", claimedAt: ago(1) }).where(eq(R.id, stuck.id));
    assert.ok((await resumeBroadcast(b2.broadcastId)).ok);
    const [after] = await db.select().from(R).where(eq(R.id, stuck.id));
    assert.equal(after.status, "FAILED", "không biết tin đã đi chưa ⇒ KHÔNG gửi lại (khách có thể nhận hai lần)");
    assert.equal(after.reason, "UNKNOWN");
    const n0 = sends.length;
    await runBroadcast(b2.broadcastId, { client, sleep: noSleep });
    assert.ok(!sends.slice(n0).some((s) => s.conv === stuck.conversationId), "dòng kẹt không được nhặt lại");

    console.log("✓ Gửi tin hàng loạt · CSDL: lọc page/thẻ/đơn(SĐT) · quá 24 giờ và vượt trần được đếm · kiểm lại trước khi gửi · hai vòng song song không nhân đôi · dừng/tiếp tục không gửi lại dòng kẹt");
  } finally {
    const ids = (await db.select({ id: schema.outreachBroadcasts.id }).from(schema.outreachBroadcasts).innerJoin(schema.outreachBroadcastRecipients, eq(schema.outreachBroadcastRecipients.broadcastId, schema.outreachBroadcasts.id)).where(eq(schema.outreachBroadcastRecipients.pageId, PAGE))).map((r) => r.id);
    if (ids.length) await db.delete(schema.outreachBroadcasts).where(inArray(schema.outreachBroadcasts.id, [...new Set(ids)]));
    await db.delete(schema.conversationFunnel).where(eq(schema.conversationFunnel.pageId, PAGE));
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}%`}`);
  }
}
