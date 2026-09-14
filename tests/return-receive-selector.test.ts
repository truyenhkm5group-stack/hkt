import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { receiveQueue } from "@/lib/returns/receive-queue";

/**
 * ═══════ NGƯỜI KHO KHÔNG ĐƯỢC PHÉP CHỌN NHẦM KIỆN ═══════
 *
 * LỖI ĐÃ SỬA. Trang gọi hàng đợi mà KHÔNG truyền ô tìm, rồi trình duyệt lọc trên đúng 400 dòng đã
 * tải. Phần lọc phía máy chủ có sẵn trong truy vấn nhưng chưa nơi nào gọi.
 *
 * Hậu quả ở đúng lúc tệ nhất: người kho cầm một kiện, gõ mã vận đơn, và nếu kiện đó nằm ngoài 400
 * dòng cũ nhất thì màn hình nói "0 kiện" — đọc ra là "kiện này không có trong hệ thống". Rồi họ
 * chọn đại một dòng gần giống, hoặc lập phiếu mới cho một kiện đã có. Không lỗi, không cảnh báo,
 * chỉ là một danh sách rỗng.
 */
export async function testReturnReceiveSelector(db: Db) {
  const P = "rsel-";
  try {
    /*
      Dựng 6 kiện chờ nhận. Kiện CẦN TÌM cố ý là kiện MỚI NHẤT, còn trần chỉ lấy 3 dòng CŨ NHẤT —
      đúng hình dạng đã gây lỗi: thứ người ta đi tìm nằm ngoài phần được tải.
    */
    for (let i = 0; i < 6; i++) {
      await db
        .insert(schema.shipments)
        .values({
          id: `${P}s${i}`,
          vtpOrderNumber: `${P}VD${i}`,
          trackingCode: `${P}VD${i}`,
          stage: "RETURNED",
          receiverName: i === 5 ? "Nguyễn Thị Mới" : `Khách ${i}`,
          receiverPhone: "0900000001",
          returnedAt: new Date(2026, 7, 1 + i),
          createdAt: new Date(2026, 7, 1 + i),
        })
        .onConflictDoNothing();
    }

    // ───── Không tìm: trần cắt đúng phần cũ nhất, và TỔNG vẫn nói đủ ─────
    const chuaTim = await receiveQueue({ limit: 3 });
    const cua = (r: { code: string | null }[]) => r.map((x) => x.code).filter((c) => c?.startsWith(P));
    assert.equal(cua(chuaTim.rows).length, 3, "trần 3 thì chỉ nạp 3 dòng");
    assert.ok(chuaTim.total >= 6, "nhưng TỔNG phải đếm đủ mọi kiện đang chờ — nếu không màn hình giấu mất phần còn lại");
    assert.ok(!cua(chuaTim.rows).includes(`${P}VD5`), "kiện mới nhất KHÔNG nằm trong phần được tải — đây chính là kiện mà bản cũ không tìm ra");

    // ───── Tìm đúng mã: máy chủ lọc trên TOÀN BỘ, không chỉ phần đã tải ─────
    const timMa = await receiveQueue({ limit: 3, q: `${P}VD5` });
    assert.deepEqual(cua(timMa.rows), [`${P}VD5`], "gõ mã vận đơn phải ra đúng kiện đó, dù nó nằm ngoài trần");

    // ───── Tìm theo tên khách ─────
    const timTen = await receiveQueue({ limit: 3, q: "Nguyễn Thị Mới" });
    assert.deepEqual(cua(timTen.rows), [`${P}VD5`], "tìm theo tên khách cũng phải chạy ở máy chủ");

    /*
      ───── MỘT SĐT RA NHIỀU KIỆN: PHẢI RA ĐỦ, KHÔNG ĐƯỢC CHỌN HỘ ─────

      Sáu kiện dùng chung một số điện thoại — khách mua nhiều lần là chuyện bình thường. Trả về một
      kiện duy nhất ở đây là tệ hơn trả về sáu: người kho sẽ bấm nhận đúng cái ERP chọn hộ, và
      không có gì trên màn hình nói rằng còn năm kiện khác cũng khớp.
    */
    const timSdt = await receiveQueue({ limit: 50, q: "0900000001" });
    assert.equal(cua(timSdt.rows).length, 6, "một SĐT ra nhiều kiện thì phải hiện ĐỦ — ERP không chọn hộ kiện nào");

    const khongCo = await receiveQueue({ limit: 50, q: "KHONG-TON-TAI-XYZ" });
    assert.equal(cua(khongCo.rows).length, 0, "không khớp gì thì rỗng — nhưng là rỗng THẬT, sau khi đã xét toàn bộ");

    /*
      ───── KHOÁ Ở MỨC MÃ NGUỒN ─────

      Hành vi đúng hôm nay không ngăn được ai đó bỏ lại tham số tìm kiếm khi sửa trang sau này. Bài
      kiểm đọc chính trang và bắt buộc ô tìm phải được truyền xuống truy vấn.
    */
    const trang = readFileSync("app/(dashboard)/inventory/returns/page.tsx", "utf8");
    assert.ok(/receiveQueue\(\{[^}]*q:/.test(trang), "trang Kiểm đếm hàng hoàn PHẢI truyền ô tìm xuống truy vấn — lọc tại chỗ sẽ không bao giờ thấy kiện ngoài trần");

    console.log("✓ Bộ chọn kiện hoàn: ô tìm chạy ở MÁY CHỦ trên toàn bộ kiện chờ nhận · một SĐT ra nhiều kiện thì hiện đủ, không chọn hộ · trang buộc phải truyền ô tìm");
  } finally {
    await db.delete(schema.shipments).where(sql`${schema.shipments.id} like ${`${P}%`}`);
  }
}
