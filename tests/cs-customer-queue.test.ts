import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { listCsCustomerQueue } from "@/lib/queries/cs";
import { parseListParams } from "@/lib/search-params";

/**
 * ═══════ MỘT KHÁCH — MỘT DÒNG VIỆC ═══════
 *
 * ĐO PRODUCTION 13/09/2026
 *   426 dòng việc đang mở · 296 khách duy nhất · 228 case thuộc SĐT có từ 2 case trở lên
 *
 * Tức 130 dòng là cùng người với một dòng khác — gần một phần ba hàng đợi. Người trực gọi cho một
 * khách ba lần, hoặc gọi một lần rồi vẫn thấy hai dòng đỏ còn lại mà không biết đã xử lý tới đâu.
 */
export async function testCsCustomerQueue(db: Db) {
  // Tiền tố RIÊNG: `csq-` đã được `cs-workqueue.test.ts` dùng, và hai bộ fixture chung tiền tố sẽ
  // gom vào nhau làm bài kiểm nói về dữ liệu của người khác.
  const P = "csgrp-";
  const T = (d: number) => new Date(Date.UTC(2026, 7, d, 3, 0, 0));
  try {
    const mk = async (id: string, opts: { customerId?: string | null; phone?: string; kind: string; day: number; assignee?: string; name?: string }) => {
      await db
        .insert(schema.csCases)
        .values({
          id,
          kind: opts.kind,
          status: "OPEN",
          source: "PANCAKE_CHAT",
          title: `việc ${id}`,
          customerId: opts.customerId ?? null,
          customerPhone: opts.phone ?? "",
          customerName: opts.name ?? "",
          assignee: opts.assignee ?? "",
          createdAt: T(opts.day),
        })
        .onConflictDoNothing();
    };
    await db.insert(schema.customers).values({ id: `${P}kh1`, name: "Chị Ba", phone: "0911111111" }).onConflictDoNothing();

    // Khách 1: ba việc, nối bằng customer_id — phải thành MỘT dòng.
    await mk(`${P}a1`, { customerId: `${P}kh1`, phone: "0911111111", kind: "EXCHANGE_SIZE", day: 1, name: "Chị Ba" });
    await mk(`${P}a2`, { customerId: `${P}kh1`, phone: "0911111111", kind: "WRONG_ADDRESS", day: 3 });
    await mk(`${P}a3`, { customerId: `${P}kh1`, phone: "0911111111", kind: "EXCHANGE_SIZE", day: 5, assignee: "Chị Hoa" });
    // Khách 2: hai việc, KHÔNG có customer_id — gom bằng SĐT.
    await mk(`${P}b1`, { phone: "0922222222", kind: "RETURN", day: 2, name: "Chị Tư" });
    await mk(`${P}b2`, { phone: "0922222222", kind: "COMPLAINT", day: 4 });
    // Hai case KHÔNG có định danh nào ⇒ mỗi cái một dòng RIÊNG, không gộp thành "khách không rõ".
    // Dùng loại thuộc ĐÚNG miền mà hàng đợi đang xem (mặc định `CUSTOMER`) — bài kiểm này nói về
    // cách GOM, không nói về cách phân miền.
    await mk(`${P}c1`, { kind: "EXCHANGE_COLOR", day: 6 });
    await mk(`${P}c2`, { kind: "EXCHANGE_COLOR", day: 7 });

    const params = parseListParams({ pageSize: "50" });
    const kq = await listCsCustomerQueue(params);
    const cua = (k: string) => kq.rows.find((r) => r.key === k);

    const kh1 = cua(`c:${P}kh1`);
    assert.ok(kh1, "ba việc của cùng một khách phải gom thành MỘT dòng");
    assert.equal(kh1.openCount, 3);
    assert.deepEqual(kh1.cases.map((x) => x.id).sort(), [`${P}a1`, `${P}a2`, `${P}a3`], "và dòng gom giữ ĐỦ mã của từng case — không mất việc nào");
    assert.deepEqual(kh1.kinds.sort(), ["EXCHANGE_SIZE", "WRONG_ADDRESS"], "loại việc bỏ trùng: hai lần đổi size vẫn là một loại");
    assert.equal(kh1.customerName, "Chị Ba", "tên lấy từ case đầu tiên CÓ tên — không để trống cả dòng vì một case thiếu tên");
    assert.equal(kh1.anyAssigned, true, "đã có người nhận ít nhất một việc");
    assert.equal(kh1.oldestAt.getTime(), T(1).getTime(), "mốc cũ nhất là của việc cũ nhất");
    assert.equal(kh1.latestAt.getTime(), T(5).getTime());

    const kh2 = cua("p:0922222222");
    assert.ok(kh2, "không có customer_id thì gom bằng SĐT");
    assert.equal(kh2.openCount, 2);
    assert.equal(kh2.anyAssigned, false);

    /*
      CASE KHÔNG CÓ ĐỊNH DANH NÀO PHẢI ĐỨNG RIÊNG.

      Gộp những người không quen biết vào một dòng "khách không rõ" là tạo ra một khách hàng không
      tồn tại — rồi ai đó sẽ gọi cho "khách" đó.
    */
    const khongDinhDanh = kq.rows.filter((r) => r.cases.some((x) => x.id === `${P}c1` || x.id === `${P}c2`));
    assert.equal(khongDinhDanh.length, 2, "hai case không định danh phải thành HAI dòng riêng — gộp người không quen biết vào một dòng là tạo ra một khách hàng không tồn tại");
    for (const g of khongDinhDanh) {
      assert.equal(g.openCount, 1, "mỗi dòng đúng một case");
      assert.ok(g.key.startsWith("x:"), "khoá gom phải nói rõ đây là dòng KHÔNG có định danh khách");
      assert.equal(g.customerPhone, "", "và không bịa ra số điện thoại");
    }

    // Khách nhiều việc nhất lên đầu: một cuộc gọi giải quyết được nhiều nhất.
    const cuaMinh = kq.rows.filter((r) => r.key.includes(P) || r.cases.some((x) => x.id.startsWith(P)));
    assert.equal(cuaMinh[0]?.openCount, 3, "khách có nhiều việc nhất đứng trước");

    /*
      ĐÓNG MỘT VIỆC KHÔNG ĐÓNG CẢ DÒNG.

      Dòng gom chỉ là PHÉP CHIẾU. Còn việc chưa xong thì khách vẫn còn trong hàng đợi — và số việc
      phải giảm đúng một.
    */
    await db.update(schema.csCases).set({ status: "DONE" }).where(sql`${schema.csCases.id} = ${`${P}a2`}`);
    const sau = await listCsCustomerQueue(params);
    const kh1b = sau.rows.find((r) => r.key === `c:${P}kh1`);
    assert.ok(kh1b, "đóng một việc KHÔNG được làm khách biến mất khỏi hàng đợi");
    assert.equal(kh1b.openCount, 2, "số việc giảm đúng một");
    assert.ok(!kh1b.cases.some((x) => x.id === `${P}a2`), "việc đã đóng rời dòng gom");

    // LỊCH SỬ KHÔNG MẤT: case đã đóng vẫn nguyên vẹn trong bảng.
    const [daDong] = await db.select().from(schema.csCases).where(sql`${schema.csCases.id} = ${`${P}a2`}`);
    assert.equal(daDong.status, "DONE");
    assert.equal(daDong.kind, "WRONG_ADDRESS", "không xoá, không sửa, không gộp — case giữ nguyên mọi thứ của nó");

    console.log("✓ Hàng đợi CSKH theo khách: 3 việc một khách thành 1 dòng · gom bằng customer_id rồi tới SĐT · case không định danh đứng RIÊNG · đóng một việc không làm mất dòng, không mất lịch sử");
  } finally {
    await db.delete(schema.csCases).where(sql`${schema.csCases.id} like ${`${P}%`}`);
    await db.delete(schema.customers).where(sql`${schema.customers.id} like ${`${P}%`}`);
  }
}
