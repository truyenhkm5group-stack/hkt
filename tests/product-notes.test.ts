import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { NOTE_CATEGORIES, NOTE_CATEGORY_LABEL } from "@/lib/constants/product-notes";
import { latestNotes, listProductNotes } from "@/lib/queries/product-notes";
import { productNoteInput } from "@/lib/validation/product-notes";

/**
 * ═══════ GHI CHÚ LÀ BỐI CẢNH, KHÔNG BAO GIỜ LÀ ĐẦU VÀO CỦA MỘT PHÉP TÍNH ═══════
 *
 * Ô "Ghi chú" cũ trên trang sản phẩm là cột ĐỒNG BỘ TỪ PANCAKE: màn hình hiện nó ra và không ai
 * trong shop viết vào được — nên nó nằm đó suốt, trông như một tính năng đã xong.
 *
 * Bản này thêm đường ghi thật. Và vì đây là một ô chữ TỰ DO, điều quan trọng nhất không phải nó
 * làm được gì mà là nó KHÔNG được làm gì: không con số nào của ERP đọc bảng này. Một câu ghi vội
 * mà ảnh hưởng tới tồn kho hay giá vốn là đường ngắn nhất để nó thành một dòng trong báo cáo tài
 * chính.
 */
/**
 * Drizzle bọc lỗi CSDL lại thành "Failed query: …" và đẩy lỗi gốc xuống `cause`, nên so khớp trên
 * `message` sẽ KHÔNG bao giờ thấy tên ràng buộc — bài kiểm đỏ trong khi CSDL đang chặn đúng.
 */
function viPhamRangBuoc(ten: string) {
  return (e: unknown) => {
    const chuoi: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur; i++) {
      chuoi.push(String((cur as { message?: string })?.message ?? cur));
      cur = (cur as { cause?: unknown })?.cause;
    }
    return chuoi.join(" | ").includes(ten);
  };
}

export async function testProductNotes(db: Db) {
  const P = "pnote-";

  // ───────── Lược đồ: nhóm ĐÓNG, thân bắt buộc, và KHÔNG có ô nào cho tên người viết ─────────
  assert.equal(productNoteInput.safeParse({ productId: "p", body: "x", category: "KHONG_CO" }).success, false, "nhóm lạ phải bị chặn ở cửa — ô gõ tự do sinh ra ba cách viết cho cùng một nhóm");
  assert.equal(productNoteInput.safeParse({ productId: "p", body: "ab" }).success, false, "ghi chú quá ngắn thì người đọc lại không hiểu được gì");
  const hopLe = productNoteInput.safeParse({ productId: "p", body: "  Lô tháng 8 vải mỏng hơn mẫu  " });
  assert.equal(hopLe.success, true);
  assert.equal(hopLe.success && hopLe.data.body, "Lô tháng 8 vải mỏng hơn mẫu", "cắt khoảng trắng thừa");
  assert.equal(hopLe.success && hopLe.data.category, "OTHER", "chưa chọn nhóm thì vào nhóm Khác, không phải nhóm đầu danh sách");
  assert.ok(!("actorName" in (hopLe.success ? hopLe.data : {})), "lược đồ KHÔNG được có ô tên người viết — tên do MÁY CHỦ đọc từ users");
  for (const c of NOTE_CATEGORIES) assert.ok(NOTE_CATEGORY_LABEL[c], `${c}: thiếu nhãn tiếng Việt`);

  try {
    await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm ghi chú", customId: "PN1", isRemoved: false }).onConflictDoNothing();
    await db.insert(schema.products).values({ id: `${P}p2`, name: "Áo ghi chú", customId: "PN2", isRemoved: false }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "PN1-L", detail: "L" }).onConflictDoNothing();
    await db.insert(schema.users).values({ id: `${P}u1`, email: "kho@shop.vn", name: "Chị Kho", passwordHash: "x", role: "WAREHOUSE" }).onConflictDoNothing();

    // ───────── RÀNG BUỘC Ở MỨC CSDL, không chỉ ở lược đồ đầu vào ─────────
    await assert.rejects(
      () => db.insert(schema.productNotes).values({ id: `${P}bad1`, productId: `${P}p1`, body: "   " }).then(() => undefined),
      viPhamRangBuoc("product_notes_body_check"),
      "ghi chú rỗng chiếm chỗ 'ghi chú mới nhất' và đẩy ghi chú thật xuống — CSDL phải chặn",
    );
    await assert.rejects(
      () => db.insert(schema.productNotes).values({ id: `${P}bad2`, productId: `${P}p1`, body: "x y z", category: "LUNG_TUNG" }).then(() => undefined),
      viPhamRangBuoc("product_notes_category_check"),
      "nhóm lạ phải bị chặn ở CSDL luôn",
    );

    // ───────── Đọc: mới nhất trước, kèm mã mẫu mã và danh tính người viết ─────────
    await db.insert(schema.productNotes).values({ id: `${P}n1`, productId: `${P}p1`, body: "Ghi chú cũ", category: "QUALITY", actorUserId: `${P}u1`, actorName: "Chị Kho", createdAt: new Date("2026-08-01T02:00:00Z") });
    await db.insert(schema.productNotes).values({ id: `${P}n2`, productId: `${P}p1`, variantId: `${P}v1`, body: "Size L hay bị chật", category: "SIZING", actorUserId: `${P}u1`, actorName: "Chị Kho", createdAt: new Date("2026-08-05T02:00:00Z") });
    // Dòng do MÁY ghi: `actorUserId = null` là hợp lệ và CÓ NGHĨA RÕ RÀNG, khác hẳn "chưa biết ai".
    await db.insert(schema.productNotes).values({ id: `${P}n3`, productId: `${P}p2`, body: "Nhập từ tệp cũ", category: "OTHER", actorUserId: null, actorName: "Job nhập liệu", createdAt: new Date("2026-08-03T02:00:00Z") });

    const ds = await listProductNotes(`${P}p1`);
    assert.equal(ds.length, 2, "chỉ ghi chú của ĐÚNG sản phẩm đó");
    assert.equal(ds[0].id, `${P}n2`, "mới nhất đứng trước");
    assert.equal(ds[0].variantSku, "PN1-L", "ghi chú mức mẫu mã phải hiện mã mẫu mã, không bắt người đọc tự tra");
    assert.equal(ds[1].variantSku, null, "ghi chú mức sản phẩm không gắn mẫu mã nào");
    assert.equal(ds[0].actorUserId, `${P}u1`, "quy kết đi bằng KHOÁ tài khoản, không bằng ô chữ");

    /*
      MỘT TRUY VẤN CHO CẢ TRANG DANH SÁCH.

      Cách hiển nhiên là gọi `listProductNotes` trong vòng lặp dòng — đúng kết quả, và là N+1 trên
      một bảng sẽ chỉ dài thêm. `distinct on` lấy dòng đầu của mỗi nhóm trong một lượt quét.
    */
    const xem = await latestNotes([`${P}p1`, `${P}p2`, `${P}khong-co`]);
    assert.equal(xem.size, 2, "sản phẩm chưa có ghi chú nào thì KHÔNG có mục — không phải một mục rỗng");
    assert.equal(xem.get(`${P}p1`)?.body, "Size L hay bị chật", "xem trước là ghi chú MỚI NHẤT");
    assert.equal(xem.get(`${P}p1`)?.total, 2, "và nói luôn còn bao nhiêu ghi chú nữa");
    assert.equal(xem.get(`${P}p2`)?.total, 1);
    assert.deepEqual(await latestNotes([]), new Map(), "danh sách rỗng thì không chạm CSDL");

    /*
      ═══ ĐIỀU QUAN TRỌNG NHẤT: GHI CHÚ KHÔNG ĐƯỢC CHẠM VÀO MỘT CON SỐ NÀO ═══

      Quét MÃ NGUỒN ĐÃ VÀO KHO. Không truy vấn báo cáo / tồn kho / giá vốn / lợi nhuận nào được
      nhắc tới bảng này. Bài kiểm đọc `git ls-files` chứ không đọc đĩa, nên nó đỏ ngay trên máy
      người viết thay vì đợi tới lúc một con số đã sai trên production.
    */
    const nguon = execSync("git ls-files lib app", { encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.tsx?$/.test(f));
    /** Vùng ĐƯỢC PHÉP nhắc tới bảng ghi chú: chính nó, và màn hình sản phẩm hiển thị nó. */
    const DUOC_PHEP = /^(lib\/(queries|actions|constants|validation)\/product-notes\.ts|app\/\(dashboard\)\/products\/)/;
    const viPham = nguon.filter((f) => {
      if (DUOC_PHEP.test(f)) return false;
      try {
        return /productNotes|product_notes/.test(execSync(`git show HEAD:${f}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      } catch {
        // Tệp chưa vào kho: khối hành vi phía trên đã kiểm, và repo-integrity chặn việc commit
        // một tệp import thứ chưa vào kho.
        return false;
      }
    });
    assert.deepEqual(viPham, [], `bảng ghi chú bị đọc ở ngoài vùng cho phép: ${viPham.join(", ")} — một ô chữ tự do KHÔNG được tham gia vào bất kỳ con số nào`);

    console.log("✓ Ghi chú vận hành sản phẩm: nhóm đóng · thân bắt buộc · quy kết bằng khoá tài khoản (máy ghi thì id = null) · xem trước một truy vấn cho cả trang · KHÔNG con số nào đọc bảng này");
  } finally {
    await db.delete(schema.productNotes).where(sql`${schema.productNotes.id} like ${`${P}%`}`);
    await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v1`));
    await db.delete(schema.products).where(sql`${schema.products.id} like ${`${P}%`}`);
    await db.delete(schema.users).where(eq(schema.users.id, `${P}u1`));
  }
}
