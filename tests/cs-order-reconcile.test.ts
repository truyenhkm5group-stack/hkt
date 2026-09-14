import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { reconcileOrderNotCreated, stillPendingOrderNotCreated } from "@/lib/cs/reconcile-order-created";
import { ORDER_MATCH_WINDOW_DAYS, ORDER_MATERIALIZED_STATUS_CODES, PANCAKE_STATUS_CONFIRMED, isOrderMaterialized } from "@/lib/constants/order-materialized";

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
    /*
      ĐƠN CŨ — CỦA LƯỢT MUA TRƯỚC.

      Bản đầu của fixture này đặt đơn cũ cách mốc case ĐÚNG 6 GIỜ, với tiền đề "trước mốc ⇒ là
      lượt mua cũ". Đo production 14/09/2026 lật đổ tiền đề đó: trong bốn case có đơn đã xác nhận
      cùng hội thoại, khoảng cách thật là **3 giờ · 5 giờ · 83 giờ · 298 giờ** — hai cái đầu CHÍNH
      LÀ đơn mà case đang chờ (máy quét chỉ nhận ra sau khi đơn đã lên POS vài giờ), hai cái sau
      mới là lượt mua khác.

      Nên một đơn cách 6 giờ KHÔNG phải "đơn cũ" — nó nằm đúng trong vùng của đơn thật. Fixture
      chuyển sang **20 ngày**, đúng chữ ký của ca mua lại đo được trên production (298 giờ), để
      cái bẫy nó canh vẫn là cái bẫy thật chứ không phải một con số tự đặt ra.

      Điều bài kiểm này canh KHÔNG đổi: `order_id` một mình không bao giờ được đóng case.
    */
    await db.insert(schema.orders).values({ id: donCu, stage: "CONFIRMED", status: 2, insertedAt: new Date(T(2).getTime() - 20 * 86_400_000), billPhone: "0900000111", billFullName: "Khách A", conversationId: `${P}conv-a`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    // Đơn MỚI: tạo SAU khi case đủ thông tin, cùng hội thoại.
    await db.insert(schema.orders).values({ id: donMoi, stage: "CONFIRMED", status: 2, insertedAt: T(14), billPhone: "0900000222", billFullName: "Khách B", conversationId: `${P}conv-b`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    // Đơn theo SĐT, tạo SAU, KHÔNG cùng hội thoại.
    await db.insert(schema.orders).values({ id: donSdt, stage: "CONFIRMED", status: 2, insertedAt: T(14), billPhone: "0900000333", billFullName: "Khách C", conversationId: `${P}conv-khac`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();

    /*
      BẬC 3 — VẬN ĐƠN. Đơn được lên bằng SỐ NGƯỜI NHẬN HỘ nên `bill_phone` khác số của case, và hội
      thoại không được gắn vào đơn: hai bậc trên đều KHÔNG lần ra. Thứ duy nhất còn lại là chứng từ
      ĐVVC — hàng đã gửi tới đúng số điện thoại của khách, sau khi họ cho đủ thông tin.
    */
    await db.insert(schema.orders).values({ id: `${P}o-ship`, stage: "SHIPPED", status: 3, insertedAt: T(14), billPhone: "0900000777", conversationId: `${P}conv-khac-2`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    await db.insert(schema.shipments).values([
      { id: `${P}s-sau`, orderId: `${P}o-ship`, vtpOrderNumber: `${P}VD-SAU`, receiverPhone: "0900000444", createdAt: T(15) },
      // Vận đơn CŨ của chính khách đó, tạo TRƯỚC lúc case đủ thông tin — KHÔNG được dùng để đóng.
      { id: `${P}s-truoc`, orderId: `${P}o-ship`, vtpOrderNumber: `${P}VD-TRUOC`, receiverPhone: "0900000555", createdAt: T(2) },
    ]).onConflictDoNothing();

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
      // 6. Chỉ có VẬN ĐƠN gửi tới số này, tạo SAU ⇒ đóng ở bậc 3.
      { id: `${P}c6`, orderId: null, conversationId: `${P}conv-e`, customerPhone: "0900000444", infoCompleteAt: T(8) },
      // 7. Có vận đơn nhưng tạo TRƯỚC lúc đủ thông tin ⇒ đó là lần gửi CŨ, KHÔNG đóng.
      { id: `${P}c7`, orderId: null, conversationId: `${P}conv-f`, customerPhone: "0900000555", infoCompleteAt: T(8) },
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
    assert.equal(conMo.length, 7, "chạy thử KHÔNG được ghi — đổi dữ liệu production phải là quyết định tường minh");

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

    const c6 = await doc(`${P}c6`);
    assert.equal(c6.status, "AUTO_RESOLVED", "có VẬN ĐƠN gửi tới số này sau khi đủ thông tin ⇒ hàng đã đi, đơn chắc chắn tồn tại");
    assert.ok(c6.resolution.startsWith("SHIPMENT_CREATED"), "kết luận phải nói đúng bậc chứng cứ đã dùng");

    const c7 = await doc(`${P}c7`);
    assert.equal(c7.status, "OPEN", "VẬN ĐƠN CŨ (tạo trước lúc khách cho đủ thông tin) KHÔNG được đóng case — cùng cái bẫy với order_id, chỉ ở một cột khác");

    /*
      Hàm chạy trên TOÀN BẢNG (đúng vai của nó ở production), còn CSDL kiểm thử còn case của khối
      khác. Nên ở đây khẳng định theo HƯỚNG: mỗi bậc phải đếm được ÍT NHẤT phần của fixture này,
      và phần "người đã chạm" / "còn treo" không được rơi về 0. Khẳng định chính xác nằm ở từng
      case phía trên — đó mới là thứ nói lên luật đúng hay sai.
    */
    assert.ok(kq.closed.CONVERSATION_HAS_ORDER >= 1, "phải đóng được case có hội thoại sinh đơn sau");
    assert.ok(kq.closed.PHONE_ORDERED_AFTER >= 1, "phải đóng được case có SĐT lên đơn sau");
    assert.ok(kq.closed.SHIPMENT_CREATED >= 1, "phải đóng được case chỉ có chứng từ vận đơn");
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

    /*
      ═══ NƠI SINH DÙNG ĐÚNG VỊ TỪ CỦA NƠI ĐỌC ═══

      Đóng case cũ mới là dọn hậu quả. Nếu máy quét vẫn tạo lại case cho hội thoại đã có đơn thì
      mỗi lượt quét lại đẻ ra đúng những case vừa đóng — `dedupe_key` mang NGÀY nên hôm sau là một
      khoá mới và không có gì chặn. `lib/cs/chat-detect.ts` gọi chính hàm này ngay trước khi ghi.
    */
    const conTreo = await stillPendingOrderNotCreated([
      { key: "co-don", conversationId: `${P}conv-b`, phone: "0900000222", infoCompleteAt: T(8) },
      { key: "co-van-don", conversationId: `${P}conv-e`, phone: "0900000444", infoCompleteAt: T(8) },
      { key: "van-don-cu", conversationId: `${P}conv-f`, phone: "0900000555", infoCompleteAt: T(8) },
      { key: "that-su-treo", conversationId: `${P}conv-d`, phone: "0900000999", infoCompleteAt: T(8) },
    ]);
    assert.equal(conTreo.has("co-don"), false, "hội thoại đã có đơn ⇒ KHÔNG tạo lại case");
    assert.equal(conTreo.has("co-van-don"), false, "đã có vận đơn gửi tới số này ⇒ KHÔNG tạo lại case");
    assert.equal(conTreo.has("van-don-cu"), true, "vận đơn CŨ không phải chứng cứ — case này vẫn phải được tạo");
    assert.equal(conTreo.has("that-su-treo"), true, "không chứng cứ nào ⇒ đây là việc thật, phải tạo");

    /*
      CUỘC ĐUA: máy quét thấy đủ thông tin, người lên đơn ngay sau đó, case chưa kịp ghi.

      Vị từ chạy TẠI THỜI ĐIỂM GHI nên nó thấy đơn vừa tạo — case không bao giờ ra đời. Dựng lại
      đúng thứ tự đó: hỏi khi chưa có đơn (còn treo) → tạo đơn → hỏi lại (hết treo).
    */
    const truocDua = await stillPendingOrderNotCreated([{ key: "dua", conversationId: `${P}conv-race`, phone: "0900000888", infoCompleteAt: T(8) }]);
    assert.equal(truocDua.has("dua"), true, "chưa có đơn thì đúng là còn treo");
    await db.insert(schema.orders).values({ id: `${P}o-race`, stage: "CONFIRMED", status: 2, insertedAt: T(9), billPhone: "0900000888", conversationId: `${P}conv-race`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    const sauDua = await stillPendingOrderNotCreated([{ key: "dua", conversationId: `${P}conv-race`, phone: "0900000888", infoCompleteAt: T(8) }]);
    assert.equal(sauDua.has("dua"), false, "đơn về giữa lúc quét và lúc ghi ⇒ case KHÔNG được sinh ra");

    // ───────── BẬC 4: POS "ĐÃ XÁC NHẬN" = ĐƠN ĐÃ ĐƯỢC TẠO (chủ shop chốt 14/09/2026) ─────────
    //
    // Ba bậc đầu đóng được 0/10 case trên production vì `info_complete_at` là mốc MÁY QUÉT nhận
    // ra, không phải mốc KHÁCH đưa thông tin — đơn gần như luôn ra đời TRƯỚC mốc ấy.
    //
    // Bậc này đổi trục sang ĐỊNH DANH (cùng hội thoại) + ĐỘ GẦN (cửa sổ hai phía). Bài kiểm khoá
    // cả hai chiều: đóng được đơn trong cửa sổ, và KHÔNG đóng đơn ngoài cửa sổ.
    const W = ORDER_MATCH_WINDOW_DAYS;
    const ngay = (d: number) => new Date(Date.now() - d * 86_400_000);

    // (a) Đơn ĐÃ XÁC NHẬN của cùng hội thoại, TRƯỚC mốc 1 ngày (trong cửa sổ) ⇒ ĐÓNG.
    await db.insert(schema.orders).values({ id: `${P}o-pos`, stage: "CONFIRMED", status: 1, insertedAt: ngay(1), billPhone: "0900000777", conversationId: `${P}conv-pos`, totalPriceAfterDiscount: 250_000 }).onConflictDoNothing();
    await db.insert(schema.csCases).values({ id: `${P}c-pos`, kind: "ORDER_NOT_CREATED", status: "OPEN", source: "PANCAKE_CHAT", title: "POS đã xác nhận", customerPhone: "0900000777", conversationId: `${P}conv-pos`, assignee: "", resolution: "", infoCompleteAt: new Date(), createdAt: new Date(), dedupeKey: `${P}c-pos` }).onConflictDoNothing();

    // (b) Đơn ĐÃ GIAO của cùng hội thoại nhưng NGOÀI cửa sổ ⇒ GIỮ MỞ. Đây đúng là ca đo được trên
    //     production: case 09-11 có đơn cùng hội thoại 08-29 `DELIVERED` — KHÁCH MUA LẠI.
    await db.insert(schema.orders).values({ id: `${P}o-cu`, stage: "DELIVERED", status: 3, insertedAt: ngay(W + 10), billPhone: "0900000666", conversationId: `${P}conv-cu`, totalPriceAfterDiscount: 250_000 }).onConflictDoNothing();
    await db.insert(schema.csCases).values({ id: `${P}c-cu`, kind: "ORDER_NOT_CREATED", status: "OPEN", source: "PANCAKE_CHAT", title: "khách mua lại", customerPhone: "0900000666", conversationId: `${P}conv-cu`, assignee: "", resolution: "", infoCompleteAt: new Date(), createdAt: new Date(), dedupeKey: `${P}c-cu` }).onConflictDoNothing();

    // (c) Đơn cùng hội thoại, trong cửa sổ, nhưng CHƯA xác nhận (`NEW`) ⇒ GIỮ MỞ.
    await db.insert(schema.orders).values({ id: `${P}o-moi`, stage: "NEW", status: 0, insertedAt: ngay(1), billPhone: "0900000555", conversationId: `${P}conv-moi`, totalPriceAfterDiscount: 250_000 }).onConflictDoNothing();
    await db.insert(schema.csCases).values({ id: `${P}c-moi`, kind: "ORDER_NOT_CREATED", status: "OPEN", source: "PANCAKE_CHAT", title: "đơn mới chưa xác nhận", customerPhone: "0900000555", conversationId: `${P}conv-moi`, assignee: "", resolution: "", infoCompleteAt: new Date(), createdAt: new Date(), dedupeKey: `${P}c-moi` }).onConflictDoNothing();

    await reconcileOrderNotCreated({ dryRun: false, actor: "test" });
    const pos = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, `${P}c-pos`) });
    const cu = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, `${P}c-cu`) });
    const moi = await db.query.csCases.findFirst({ where: eq(schema.csCases.id, `${P}c-moi`) });
    assert.equal(pos?.status, "AUTO_RESOLVED", "POS đã xác nhận đơn của CHÍNH hội thoại ấy, trong cửa sổ ⇒ phải đóng");
    assert.match(pos?.resolution ?? "", /POS_CONFIRMED/, "lý do đóng phải nêu đúng bậc chứng cứ đã dùng");
    assert.equal(cu?.status, "OPEN", "đơn cùng hội thoại nhưng NGOÀI cửa sổ là KHÁCH MUA LẠI — đóng nó là đóng một việc thật");
    assert.equal(moi?.status, "OPEN", "đơn chưa xác nhận (NEW) KHÔNG chứng minh đơn đã được tạo — chủ shop vạch ranh giới ở 'Đã xác nhận'");

    // Lá chắn lúc GHI phải dùng CÙNG luật: hội thoại đã có đơn xác nhận ⇒ KHÔNG sinh case mới.
    const posGuard = await stillPendingOrderNotCreated([{ key: "pos", conversationId: `${P}conv-pos`, phone: "0900000777", infoCompleteAt: new Date() }]);
    assert.equal(posGuard.has("pos"), false, "nơi SINH phải thấy cùng chứng cứ với nơi ĐỌC — nếu không, mỗi ngày lại đẻ ra đúng case mà lượt đối chiếu sau đó phải đóng");
    const cuGuard = await stillPendingOrderNotCreated([{ key: "cu", conversationId: `${P}conv-cu`, phone: "0900000666", infoCompleteAt: new Date() }]);
    assert.equal(cuGuard.has("cu"), true, "đơn ngoài cửa sổ thì lá chắn vẫn phải cho case ra đời");

    // ───────── LUẬT "ĐÃ XÁC NHẬN" BÁM MÃ SỐ, KHÔNG BÁM CHUỖI HIỂN THỊ ─────────
    assert.equal(isOrderMaterialized({ status: PANCAKE_STATUS_CONFIRMED }), true, "mã 1 = 'Đã xác nhận' = đơn đã được tạo — đúng câu chủ shop chốt");
    assert.equal(isOrderMaterialized({ stage: "CONFIRMED" }), true);
    assert.equal(isOrderMaterialized({ stage: "DELIVERED" }), true, "đã giao thì càng chắc chắn là đã tạo");
    assert.equal(isOrderMaterialized({ stage: "NEW" }), false, "chưa ai xác nhận");
    assert.equal(isOrderMaterialized({ stage: "WAITING" }), false, "'chờ hàng' đứng TRƯỚC xác nhận");
    assert.equal(isOrderMaterialized({ stage: "CANCELLED" }), false, "đơn đã huỷ ⇒ khách có thể đang cần đơn MỚI, việc CSKH vẫn thật");
    assert.equal(isOrderMaterialized({ stage: "DELETED" }), false);
    assert.equal(isOrderMaterialized({}), false, "CHƯA BIẾT không phải 'đã tạo' — lề an toàn nghiêng về giữ case mở");
    assert.equal(isOrderMaterialized({ stage: null, status: null }), false);
    // Danh sách mã SINH RA từ bảng trạng thái Pancake, không gõ lại.
    assert.ok(ORDER_MATERIALIZED_STATUS_CODES.includes(PANCAKE_STATUS_CONFIRMED), "mã 'Đã xác nhận' phải nằm trong danh sách sinh ra");
    assert.ok(!ORDER_MATERIALIZED_STATUS_CODES.includes(0) && !ORDER_MATERIALIZED_STATUS_CODES.includes(6), "mã 'Mới' và 'Đã huỷ' phải nằm ngoài");

    console.log("✓ Đối chiếu 'chưa tạo đơn': order_id của ĐƠN CŨ không đóng case (25/29 trên production) · hội thoại/SĐT có đơn tạo SAU thì đóng · người đã nhận thì máy không đụng · vận đơn gửi tới số đó sau khi đủ thông tin thì đóng, vận đơn CŨ thì không · POS 'Đã xác nhận' trong cửa sổ thì đóng, ngoài cửa sổ (khách mua lại) thì KHÔNG · 'Mới'/'Huỷ' không phải đã tạo · luật bám MÃ SỐ không bám chuỗi · nơi sinh và nơi đọc dùng CHUNG một bộ vị từ · chạy thử không ghi · chạy lại idempotent");
  } finally {
    await db.delete(schema.csCases).where(sql`${schema.csCases.id} like ${`${P}%`}`);
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} like ${`${P}%`}`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}%`}`);
  }
}
