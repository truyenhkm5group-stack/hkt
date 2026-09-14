import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { IDEA_MAX_IMAGES, ideaTitle } from "@/lib/constants/ideas";
import { getIdea, ideaCounts, listIdeas, listMarketers } from "@/lib/queries/ideas";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * Ý TƯỞNG MARKETING.
 *
 * Ba điều phải giữ:
 *   1. Truy vấn danh sách KHÔNG được kéo theo dữ liệu ảnh — ảnh nằm trong CSDL nên một trang 24 ý
 *      tưởng mà lấy cả ảnh là vài chục MB mỗi lần mở trang.
 *   2. Quá trình trao đổi giữ nguyên, không ghi đè: mỗi lần quản lý chốt đều đọc lại được lý do.
 *   3. Xoá ý tưởng thì ảnh và trao đổi đi theo, không để lại rác trong CSDL.
 */
export async function testIdeas() {
  const db = await getDb();

  const [idea] = await db
    .insert(schema.marketingIdeas)
    .values({
      marketerId: "mkt-1",
      marketerName: "Trần Thu",
      ideaDate: "2026-09-09",
      content: "Video mặc thử Q003 mùa thu\nQuay 3 dáng, nhấn chất vải và độ rủ.\nChạy trên fanpage + landing.",
      createdBy: "thu@shop.vn",
      createdByName: "Trần Thu",
    })
    .returning({ id: schema.marketingIdeas.id });

  const anhGia = Buffer.from("anh-gia-de-kiem-thu").toString("base64");
  await db.insert(schema.marketingIdeaImages).values([
    { ideaId: idea.id, contentType: "image/jpeg", bytes: 120_000, data: anhGia, sortOrder: 0 },
    { ideaId: idea.id, contentType: "image/jpeg", bytes: 98_000, data: anhGia, sortOrder: 1 },
  ]);
  clearMemo();

  // ───────── 1. Tiêu đề lấy từ dòng đầu của nội dung ─────────
  assert.equal(ideaTitle("Video mặc thử Q003 mùa thu\nchi tiết…"), "Video mặc thử Q003 mùa thu");
  assert.equal(ideaTitle("\n\n  Bộ ảnh feed tháng 9  \nsau"), "Bộ ảnh feed tháng 9", "bỏ qua dòng trống ở đầu");
  assert.equal(ideaTitle("   "), "(chưa có nội dung)", "nội dung rỗng vẫn phải có tiêu đề đọc được");

  // ───────── 2. Danh sách chỉ mang id ảnh, không mang dữ liệu ảnh ─────────
  const ds = await listIdeas({ period: ALL, status: "ALL", pageSize: 50 });
  const dong = ds.rows.find((r) => r.id === idea.id);
  assert.ok(dong, "ý tưởng vừa tạo phải nằm trong danh sách");
  assert.equal(dong.imageIds.length, 2, "biết được ý tưởng có mấy ảnh");
  assert.equal(dong.marketerName, "Trần Thu", "cột marketer phụ trách");
  assert.equal(dong.ideaDate, "2026-09-09", "cột ngày do người đăng chọn");
  const chuoi = JSON.stringify(dong);
  assert.ok(!chuoi.includes(anhGia), "truy vấn danh sách KHÔNG được chứa dữ liệu ảnh");

  // ───────── 3. Trao đổi giữ nguyên cả quá trình ─────────
  await db.insert(schema.marketingIdeaComments).values([
    { ideaId: idea.id, authorEmail: "sep@shop.vn", authorName: "Quản lý", body: "Thêm cảnh cận chất vải.", statusSet: "CHANGES" },
    { ideaId: idea.id, authorEmail: "thu@shop.vn", authorName: "Trần Thu", body: "Đã quay thêm, gửi lại ảnh." },
    { ideaId: idea.id, authorEmail: "sep@shop.vn", authorName: "Quản lý", body: "Ổn rồi, chạy đi.", statusSet: "APPROVED" },
  ]);
  await db.update(schema.marketingIdeas).set({ status: "APPROVED", reviewedBy: "Quản lý", reviewedAt: new Date() }).where(eq(schema.marketingIdeas.id, idea.id));
  clearMemo();

  const chiTiet = await getIdea(idea.id);
  assert.ok(chiTiet, "phải mở được chi tiết ý tưởng");
  assert.equal(chiTiet.comments.length, 3, "giữ đủ cả ba lượt trao đổi, không ghi đè");
  assert.equal(chiTiet.comments[0].statusSet, "CHANGES", "đọc lại được vì sao ý tưởng từng bị yêu cầu sửa");
  assert.equal(chiTiet.comments[2].statusSet, "APPROVED", "và vì sao cuối cùng được duyệt");
  assert.equal(chiTiet.status, "APPROVED");
  assert.equal(chiTiet.images.length, 2, "chi tiết biết có mấy ảnh");
  assert.ok(!JSON.stringify(chiTiet.images).includes(anhGia), "chi tiết cũng chỉ mang id và dung lượng, ảnh tải riêng qua route");

  // ───────── 4. Đếm theo trạng thái cộng lại bằng tổng ─────────
  const dem = await ideaCounts({ period: ALL });
  const cong = (["NEW", "REVIEWING", "CHANGES", "APPROVED", "REJECTED"] as const).reduce((t, k) => t + dem[k], 0);
  assert.equal(cong, dem.ALL, "cộng các trạng thái phải bằng tổng — không ý tưởng nào rơi ra ngoài");
  assert.ok(dem.APPROVED >= 1);

  // ───────── 5. Trần số ảnh phải là con số thật, không phải lời hứa ─────────
  assert.ok(IDEA_MAX_IMAGES > 0 && IDEA_MAX_IMAGES <= 20, "trần ảnh phải có và ở mức hợp lý vì ảnh nằm trong CSDL");

  // ───────── 6. Xoá ý tưởng thì ảnh và trao đổi đi theo ─────────
  await db.delete(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, idea.id));
  const [conAnh] = await db.select({ n: sql<number>`count(*)` }).from(schema.marketingIdeaImages).where(eq(schema.marketingIdeaImages.ideaId, idea.id));
  const [conCmt] = await db.select({ n: sql<number>`count(*)` }).from(schema.marketingIdeaComments).where(eq(schema.marketingIdeaComments.ideaId, idea.id));
  assert.equal(Number(conAnh?.n ?? 0), 0, "xoá ý tưởng phải xoá ảnh theo, không để rác trong CSDL");
  assert.equal(Number(conCmt?.n ?? 0), 0, "và xoá cả phần trao đổi");
  clearMemo();

  /**
   * ───────── 7. ĐĂNG ĐƯỢC KHI CHƯA KHAI BÁO NHÂN SỰ NÀO ─────────
   *
   * SỰ CỐ THẬT (10/09/2026), chủ shop báo bằng ảnh chụp màn hình: hộp thoại "Thêm ý tưởng" có ô
   * "Marketer phụ trách" RỖNG và nút "Đăng ý tưởng" xám vĩnh viễn.
   *
   * Nguyên nhân: ô đó là `select` lấy danh sách từ khai báo nhân sự phòng Marketing ở trang Lương.
   * Shop chưa khai ai ⇒ danh sách rỗng ⇒ trường bắt buộc không bao giờ điền được ⇒ không có đường
   * nào đăng được ý tưởng ĐẦU TIÊN. Một màn hình tự khoá mình lại.
   *
   * Bài kiểm này khoá HỢP ĐỒNG mà giao diện dựa vào: tên marketer là chữ TỰ DO, `marketerId` chỉ là
   * liên kết tuỳ chọn. Ai đó siết `marketerName` thành khoá ngoại tới bảng nhân sự thì đỏ ngay,
   * thay vì để màn hình lại tự khoá lần nữa.
   */
  const [tuDo] = await db
    .insert(schema.marketingIdeas)
    .values({
      marketerId: null,
      marketerName: "Chị Hà (chưa khai nhân sự)",
      ideaDate: "2026-09-10",
      content: "Ý tưởng đăng khi chưa khai báo nhân sự nào",
      createdBy: "chu@shop.vn",
      createdByName: "Chủ shop",
    })
    .returning({ id: schema.marketingIdeas.id });
  const daDang = await getIdea(tuDo.id);
  assert.ok(daDang, "phải đăng được ý tưởng khi CHƯA khai báo nhân sự nào");
  assert.equal(daDang.marketerName, "Chị Hà (chưa khai nhân sự)", "tên marketer là chữ tự do, không phải khoá ngoại");

  // Và tên tự do đó phải quay lại thành GỢI Ý cho lần sau — nếu không, mỗi lần đăng lại gõ từ đầu.
  clearMemo();
  const goiY = await listMarketers();
  assert.ok(
    goiY.some((m) => m.name === "Chị Hà (chưa khai nhân sự)"),
    "tên đã dùng phải thành gợi ý cho lần sau, kể cả khi người đó không có trong bảng nhân sự",
  );
  await db.delete(schema.marketingIdeas).where(eq(schema.marketingIdeas.id, tuDo.id));

  console.log("✓ Ý tưởng marketing: danh sách không kéo dữ liệu ảnh, giữ đủ quá trình trao đổi, xoá sạch ảnh & nhận xét");
  console.log(`✓ Đăng được khi chưa khai nhân sự: tên marketer là chữ tự do · tên đã dùng thành gợi ý lần sau (${goiY.length} gợi ý)`);
}
