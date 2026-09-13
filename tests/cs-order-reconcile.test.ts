import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { reconcileOrderNotCreated } from "@/lib/cs/reconcile-order-created";

/**
 * ═══════ "CHƯA TẠO ĐƠN" PHẢI TỰ TẮT KHI ĐƠN ĐÃ CÓ — VÀ CHỈ KHI ĐÓ ═══════
 *
 * Case `ORDER_NOT_CREATED` mang một điều kiện SỐNG: "đơn chưa tồn tại". Nó đúng lúc case sinh ra
 * rồi hết đúng ngay khi ai đó lên đơn — nhưng không có đường nào tắt case, nên nó nằm lại mãi.
 *
 * ─── CÁI BẪY MÀ BÀI KIỂM NÀY TỒN TẠI ĐỂ CHẶN ───
 *
 * Cách sửa "hiển nhiên" là: case có `order_id` ⇒ đơn đã tạo ⇒ đóng. Đo production 13/09/2026:
 *
 *   29 case đang mở · 25 case có `order_id`
 *   → trong 25 cái đó, số `order_id` trỏ tới đơn tạo SAU khi case đủ thông tin: **0**
 *
 * Cả 25 đều trỏ tới đơn CŨ của khách. `chat-detect` gán `orderId` = đơn gần nhất của khách cho
 * MỌI case nó tạo, và chính nội dung case viết ra điều đó: *"Đơn gần nhất #… là của lần mua
 * trước."* Case chỉ được tạo KHI đã đối chiếu và KHÔNG thấy đơn tương ứng.
 *
 * Nên luật "có `order_id` thì đóng" sẽ đóng 25/29 case — gần như toàn bộ hàng đợi — mà KHÔNG một
 * case nào trong đó có đơn thật. Hàng đợi sạch bong và việc thì biến mất.
 */
export async function testCsOrderReconcile(db: Db) {
  const P = "csrec-";
  const T = (h: number) => new Date(Date.UTC(2026, 7, 10, h, 0, 0));
  try {
    const donCu = `${P}o-cu`;
    const donMoi = `${P}o-moi`;
    const donSdt = `${P}o-sdt`;
    // Đơn CŨ: tạo 6 giờ TRƯỚC khi case đủ thông tin.
    await db.insert(schema.orders).values({ id: donCu, stage: "CONFIRMED", status: 2, insertedAt: T(2), billPhone: "0900000111", billFullName: "Khách A", conversationId: `${P}conv-a`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    // Đơn MỚI: tạo SAU khi case đủ thông tin, cùng hội thoại.
    await db.insert(schema.orders).values({ id: donMoi, stage: "CONFIRMED", status: 2, insertedAt: T(14), billPhone: "0900000222", billFullName: "Khách B", conversationId: `${P}conv-b`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    // Đơn theo SĐT, tạo SAU, KHÔNG cùng hội thoại.
    await db.insert(schema.orders).values({ id: donSdt, stage: "CONFIRMED", status: 2, insertedAt: T(14), billPhone: "0900000333", billFullName: "Khách C", conversationId: `${P}conv-khac`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();

    const caseVals = [
      // 1. CÁI BẪY: mang `order_id` của đơn CŨ, hội thoại cũng chỉ có đơn cũ ⇒ PHẢI GIỮ NGUYÊN.
      { id: `${P}c1`, orderId: donCu, conversationId: `${P}conv-a`, customerPhone: "0900000111", infoCompleteAt: T(8) },
      // 2. Hội thoại đã sinh đơn SAU ⇒ đóng.
      { id: `${P}c2`, orderId: null, conversationId: `${P}conv-b`, customerPhone: "0900000222", infoCompleteAt: T(8) },
      // 3. SĐT lên đơn SAU, khác hội thoại ⇒ đóng ở bậc 2.
      { id: `${P}c3`, orderId: null, conversationId: `${P}conv-c`, customerPhone: "0900000333", infoCompleteAt: T(8) },
      // 4. Không có gì ⇒ vẫn là việc thật.
      { id: `${P}c4`, orderId: null, conversationId: `${P}conv-d`, customerPhone: "0900000999", infoCompleteAt: T(8) },
      // 5. Có chứng cứ NHƯNG đã có người nhận ⇒ máy KHÔNG quyết thay người.
      { id: `${P}c5`, orderId: null, conversationId: `${P}conv-b`, customerPhone: "0900000222", infoCompleteAt: T(8), assignee: "Chị Hoa" },
    ];
    for (const v of caseVals) {
      await db
        .insert(schema.csCases)
        .values({ id: v.id, kind: "ORDER_NOT_CREATED", status: "OPEN", source: "PANCAKE_CHAT", title: "thử", orderId: v.orderId, conversationId: v.conversationId, customerPhone: v.customerPhone, infoCompleteAt: v.infoCompleteAt, assignee: v.assignee ?? "", createdAt: T(8) })
        .onConflictDoNothing();
    }

    // ───────── CHẠY THỬ KHÔNG ĐƯỢC GHI GÌ ─────────
    const thu = await reconcileOrderNotCreated({ dryRun: true });
    assert.ok(thu.closedTotal >= 2, "chạy thử vẫn phải ĐẾM được số case đóng được");
    const conMo = await db.select({ id: schema.csCases.id }).from(schema.csCases).where(sql`${schema.csCases.id} like ${`${P}%`} and ${schema.csCases.status} = 'OPEN'`);
    assert.equal(conMo.length, 5, "chạy thử KHÔNG được ghi — đổi dữ liệu production phải là quyết định tường minh");

    // ───────── CHẠY THẬT ─────────
    const kq = await reconcileOrderNotCreated({ dryRun: false, actor: "test" });
    const doc = async (id: string) => (await db.select().from(schema.csCases).where(eq(schema.csCases.id, id)))[0];

    const c1 = await doc(`${P}c1`);
    assert.equal(c1.status, "OPEN", "CASE CÓ order_id CỦA ĐƠN CŨ PHẢI GIỮ NGUYÊN — đây là 25/29 case trên production, và đóng chúng là xoá sạch hàng đợi");
    assert.equal(c1.resolution, "", "và không được ghi kết luận gì lên nó");

    const c2 = await doc(`${P}c2`);
    assert.equal(c2.status, "AUTO_RESOLVED", "hội thoại đã sinh đơn SAU ⇒ đóng");
    assert.ok(c2.resolution.startsWith("CONVERSATION_HAS_ORDER"), "kết luận phải nói đúng bậc chứng cứ đã dùng");
    assert.ok(c2.resolvedAt, "phải có mốc đóng");

    const c3 = await doc(`${P}c3`);
    assert.equal(c3.status, "AUTO_RESOLVED", "SĐT lên đơn SAU ⇒ đóng");
    assert.ok(c3.resolution.startsWith("PHONE_ORDERED_AFTER"));

    const c4 = await doc(`${P}c4`);
    assert.equal(c4.status, "OPEN", "không chứng cứ nào ⇒ vẫn là việc thật");

    const c5 = await doc(`${P}c5`);
    assert.equal(c5.status, "OPEN", "case đã có người nhận thì MÁY không quyết thay — để người đó xem lại");

    /*
      Hàm chạy trên TOÀN BẢNG (đúng vai của nó ở production), còn CSDL kiểm thử còn case của khối
      khác. Nên ở đây khẳng định theo HƯỚNG: mỗi bậc phải đếm được ÍT NHẤT phần của fixture này,
      và phần "người đã chạm" / "còn treo" không được rơi về 0. Khẳng định chính xác nằm ở từng
      case phía trên — đó mới là thứ nói lên luật đúng hay sai.
    */
    assert.ok(kq.closed.CONVERSATION_HAS_ORDER >= 1, "phải đóng được case có hội thoại sinh đơn sau");
    assert.ok(kq.closed.PHONE_ORDERED_AFTER >= 1, "phải đóng được case có SĐT lên đơn sau");
    assert.ok(kq.humanTouched >= 1, "case có người chạm được đếm riêng, không giấu đi");
    assert.ok(kq.stillPending >= 1, "case chưa có chứng cứ vẫn phải được đếm là việc thật");
    assert.equal(kq.openBefore, kq.closedTotal + kq.humanTouched + kq.stillPending, "bốn con số phải cộng đủ — thiếu một nhóm nghĩa là có case rơi khỏi mọi phân loại");

    // ───────── CHẠY LẠI KHÔNG ĐỔI GÌ THÊM ─────────
    const lai = await reconcileOrderNotCreated({ dryRun: false, actor: "test" });
    assert.equal(lai.closedTotal, 0, "chạy lại không còn gì để đóng — thao tác idempotent");
    assert.equal(lai.openBefore, kq.openBefore - kq.closedTotal, "số case đang mở giảm đúng bằng số đã đóng");
    assert.equal((await doc(`${P}c2`)).resolution, c2.resolution, "và không ghi đè kết luận đã có");

    // KHÔNG XOÁ LỊCH SỬ: case đóng vẫn tra được đủ.
    assert.ok((await doc(`${P}c2`)).conversationId, "giữ nguyên hội thoại");
    assert.ok((await doc(`${P}c2`)).createdAt, "giữ nguyên mốc tạo");

    console.log("✓ Đối chiếu 'chưa tạo đơn': order_id của ĐƠN CŨ không đóng case (25/29 trên production) · hội thoại/SĐT có đơn tạo SAU thì đóng · người đã nhận thì máy không đụng · chạy thử không ghi · chạy lại idempotent");
  } finally {
    await db.delete(schema.csCases).where(sql`${schema.csCases.id} like ${`${P}%`}`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}%`}`);
  }
}
