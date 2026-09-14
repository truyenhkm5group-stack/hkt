import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { classifyOutreachError, OUTREACH_ERROR_SPECS } from "@/lib/constants/outreach-errors";
import { sendOutreachTargets } from "@/lib/outreach/send";

/**
 * ═══════ GỬI TIN: BẤM HAI LẦN KHÔNG ĐƯỢC THÀNH HAI TIN ═══════
 *
 * ĐO PRODUCTION 13/09/2026
 *   CROSS_SELL  483 chờ · 1 đã gửi · 25 LỖI      → 25/25 là `(#10)` cửa sổ 24 giờ của Meta
 *   NURTURE   1.602 chờ · 58 chuyển đổi · 20 LỖI → 17 là `(#551)` khách không nhận được tin
 */

/* ───── 1 · Phân loại lỗi: cái nào thử lại có ích, cái nào không ───── */
export function testOutreachErrorClassify() {
  // `#10` là CHÍNH SÁCH, không phải sự cố. Bán chéo nhắm khách đã nhận hàng vài ngày trước nên
  // LUÔN nằm ngoài cửa sổ 24 giờ — thử lại không bao giờ đổi kết quả.
  const w = classifyOutreachError("(#10) Tin nhắn này được gửi ngoài khoảng thời gian cho phép. Tìm hiểu thêm về chính sách mới");
  assert.equal(w.kind, "POLICY_WINDOW");
  assert.equal(w.retryable, false, "thử lại một lỗi chính sách chỉ tạo thêm một dòng đỏ nữa");
  assert.ok(w.action.includes("Zalo"), "phải nói lối ra thật, không chỉ nói vì sao hỏng");

  assert.equal(classifyOutreachError("(#551) Người này hiện không có mặt.").kind, "USER_UNAVAILABLE");
  assert.equal(classifyOutreachError("(#100) Bạn không thể bỏ trống tin nhắn mà phải điền nội dung").kind, "CONTENT_REJECTED");
  assert.equal(classifyOutreachError("(#100) …").retryable, true, "nội dung sai thì sửa mẫu tin rồi gửi lại được");
  assert.equal(classifyOutreachError("Không có hội thoại Pancake — nhắn qua Zalo/SMS").kind, "NO_CONVERSATION");
  assert.equal(classifyOutreachError("socket hang up").kind, "TRANSIENT");
  assert.equal(classifyOutreachError("").kind, "UNKNOWN", "rỗng là CHƯA PHÂN LOẠI, không phải 'không lỗi'");
  assert.equal(classifyOutreachError(null).kind, "UNKNOWN");

  // Không phụ thuộc dấu tiếng Việt — Pancake/Meta trả về cả bản có dấu lẫn không dấu.
  assert.equal(classifyOutreachError("Tin nhan nay duoc gui ngoai khoang thoi gian cho phep").kind, "POLICY_WINDOW");

  for (const k of Object.keys(OUTREACH_ERROR_SPECS) as (keyof typeof OUTREACH_ERROR_SPECS)[]) {
    assert.ok(OUTREACH_ERROR_SPECS[k].action.trim().length > 20, `${k}: thiếu VIỆC PHẢI LÀM`);
  }
  console.log("✓ Phân loại lỗi gửi tin: #10 là CHÍNH SÁCH (không thử lại được) · #551 khách không nhận · #100 sửa nội dung · mỗi loại có việc phải làm");
}

/* ───── 2 · Giữ chỗ nguyên tử: hai lượt gửi song song chỉ ra một tin ───── */
export async function testOutreachIdempotentSend(db: Db) {
  const P = "outs-";
  try {
    const mk = async (id: string) => {
      await db
        .insert(schema.outreachTargets)
        .values({ id, segment: "CROSS_SELL", status: "PENDING", pageId: "", conversationId: "", pancakeCustomerId: "", customerName: "Khách", phone: "0900000001", message: "xin chào", dedupeKey: id })
        .onConflictDoNothing();
    };
    await mk(`${P}t1`);

    /*
      KHÔNG có hội thoại Pancake ⇒ đường gửi dừng ở `SKIPPED` trước khi chạm nhà cung cấp. Nhờ vậy
      bài kiểm chứng minh được cơ chế GIỮ CHỖ mà không gửi một tin thật nào tới khách thật.
    */
    const [a, b] = await Promise.all([sendOutreachTargets([`${P}t1`], "test-a"), sendOutreachTargets([`${P}t1`], "test-b")]);
    const tong = a.sent + a.failed + a.skipped + b.sent + b.failed + b.skipped;
    assert.equal(tong, 1, "hai lượt gửi song song trên CÙNG một dòng chỉ được xử lý ĐÚNG MỘT lần — bấm hai lần không thành hai tin");

    const [row] = await db.select().from(schema.outreachTargets).where(eq(schema.outreachTargets.id, `${P}t1`));
    assert.equal(row.status, "SKIPPED", "không có hội thoại ⇒ bỏ qua, không phải lỗi");
    assert.equal(row.errorKind, "NO_CONVERSATION", "và lý do được phân loại để bảng nói được việc phải làm");

    // Dòng đã kết thúc KHÔNG được gửi lại bởi một lượt bấm khác.
    const lai = await sendOutreachTargets([`${P}t1`], "test-c");
    assert.equal(lai.sent + lai.failed + lai.skipped, 0, "dòng đã có kết cục không được lượt bấm sau nhặt lại");

    // Dòng chưa tới hạn phải được TRẢ LẠI `PENDING`, không kẹt ở `SENDING`.
    await mk(`${P}t2`);
    await db.update(schema.outreachTargets).set({ nextAt: new Date(Date.now() + 86_400_000) }).where(eq(schema.outreachTargets.id, `${P}t2`));
    const chuaToiHan = await sendOutreachTargets([`${P}t2`], "test-d");
    assert.equal(chuaToiHan.notDue, 1, "dòng chưa tới hạn được ĐẾM, không bị nuốt");
    assert.equal(chuaToiHan.sent + chuaToiHan.failed + chuaToiHan.skipped, 0, "và không bị xử lý");
    const [r2] = await db.select().from(schema.outreachTargets).where(eq(schema.outreachTargets.id, `${P}t2`));
    assert.equal(r2.status, "PENDING", "chưa tới hạn ⇒ KHÔNG bị giành chỗ, giữ nguyên PENDING — một dòng kẹt ở SENDING là một tin không bao giờ được gửi");

    /*
      BÀI KIỂM QUAN TRỌNG NHẤT CỦA KHỐI NÀY.

      Điều kiện "đến hạn" phải nằm TRONG lệnh giành chỗ. `isDue()` đòi `status === 'PENDING'`; nếu
      gọi nó SAU khi giành (lúc dòng đã là `SENDING`) thì nó trả `false` cho MỌI dòng và đường gửi
      đứng im hoàn toàn — không lỗi, không dòng đỏ, chỉ là không tin nào đi. Một dòng ĐÃ tới hạn
      phải thực sự được xử lý.
    */
    await mk(`${P}t3`);
    const toiHan = await sendOutreachTargets([`${P}t3`], "test-e");
    assert.equal(toiHan.skipped, 1, "dòng ĐÃ tới hạn phải được xử lý thật — nếu con số này là 0 thì đường gửi đã chết im lặng");
    assert.equal(toiHan.notDue, 0);

    console.log("✓ Gửi tin: hai lượt song song chỉ xử lý một lần (giữ chỗ nguyên tử) · dòng đã kết thúc không bị nhặt lại · dòng chưa tới hạn không kẹt ở SENDING");
  } finally {
    await db.delete(schema.outreachTargets).where(sql`${schema.outreachTargets.id} like ${`${P}%`}`);
  }
}
