/**
 * ═══════════ HỌC TỪ CHỖ NGƯỜI SỬA ═══════════
 *
 * Bài này đo MỘT quyết định: chỗ sửa ấy dạy điều gì. Ranh giới quan trọng nhất không phải "sửa
 * nhiều hay sửa ít" mà "có đổi dữ kiện không" — và nó phải thắng phép đo độ dài, vì người đổi
 * đúng một con số rồi giữ nguyên cả câu là một chỗ sửa RẤT NHỎ về chữ nhưng RẤT LỚN về nghĩa.
 *
 * Mọi thứ ở đây là hàm thuần trên chuỗi: không đồng hồ, không CSDL, không biến môi trường (luật 65).
 */
import assert from "node:assert/strict";
import {
  EDIT_KIND_LABEL,
  EDIT_KINDS,
  REWRITE_KEEP_RATIO,
  STYLE_EXAMPLES_MAX,
  classifyEdit,
  factsOf,
  feedsTheModel,
  keepRatio,
  styleExamplesBlock,
} from "@/lib/constants/copilot-learning";

export function testCopilotLearning() {
  // gửi nguyên văn — kể cả khi chỉ khác khoảng trắng hay dấu câu
  {
    const cau = "Dạ mẫu này bên em 499.000 ₫ ạ";
    assert.equal(classifyEdit(cau, cau).kind, "SENT_AS_IS");
    assert.equal(classifyEdit(cau, `  ${cau}!!  `).kind, "SENT_AS_IS", "thêm dấu chấm than không phải một lần sửa");
    assert.equal(classifyEdit(cau, "").kind, "SENT_AS_IS", "không có câu cuối ⇒ đã gửi bản máy");
    assert.equal(classifyEdit(cau, cau).keepRatio, 1);
  }

  // sửa cách nói — cùng dữ kiện, khác giọng — là thứ DUY NHẤT mô hình được học
  {
    const may = "Dạ mẫu này 499.000 ₫ ạ, chị cho em xin size nhé";
    const nguoi = "Dạ chị ơi, mẫu này bên em 499.000 ₫ thôi ạ, chị cho em xin size với ạ ❤️";
    const kq = classifyEdit(may, nguoi);
    assert.equal(kq.kind, "WORDING");
    assert.deepEqual(kq.factsAdded, []);
    assert.equal(feedsTheModel(kq.kind), true);
    for (const k of EDIT_KINDS) if (k !== "WORDING") assert.equal(feedsTheModel(k), false, `${k} không được đưa cho mô hình`);
  }

  // ĐỔI MỘT CON SỐ LÀ SỬA DỮ KIỆN — dù câu gần như giữ nguyên
  {
    const may = "Dạ mẫu này bên em 499.000 ₫ ạ, chị cho em xin size với ạ";
    const nguoi = "Dạ mẫu này bên em 450.000 ₫ ạ, chị cho em xin size với ạ";
    const kq = classifyEdit(may, nguoi);
    assert.equal(kq.kind, "FACTS", "một chữ số đổi nghĩa cả câu — không phải lỗi giọng văn");
    assert.ok(kq.keepRatio > 0.8, "phép đo chữ nói rằng đây là sửa nhẹ...");
    assert.ok(kq.factsAdded.some((f) => f.includes("450000")), "...nhưng phân loại phải đi theo dữ kiện");
    assert.ok(kq.factsRemoved.some((f) => f.includes("499000")));
    assert.equal(feedsTheModel(kq.kind), false, "đưa cặp này cho mô hình là dạy nó bịa số");
  }

  // thêm một size máy không nói cũng là sửa dữ kiện
  {
    const kq = classifyEdit("Dạ chị cho em xin chiều cao cân nặng ạ", "Dạ chị cao 1m60 nặng 55kg thì mặc size L nhé ạ");
    assert.equal(kq.kind, "FACTS");
    assert.ok(kq.factsAdded.some((f) => f.startsWith("size")), kq.reason);
    assert.match(kq.reason, /ERP thiếu dữ liệu/);
  }

  // người BỎ ĐI một con số máy nói thừa — vẫn là dữ kiện, nhưng câu giải thích khác
  {
    const kq = classifyEdit("Dạ 499.000 ₫ ạ, ship 25.000 ₫ nữa ạ", "Dạ 499.000 ₫ ạ");
    assert.equal(kq.kind, "FACTS");
    assert.deepEqual(kq.factsAdded, []);
    assert.ok(kq.factsRemoved.some((f) => f.includes("25000")));
    assert.match(kq.reason, /máy nói thừa/);
  }

  // viết lại hẳn tách khỏi sửa nhẹ — nếu không, một bản nháp bị vứt trông như bản gần đúng
  {
    const kq = classifyEdit("Dạ mẫu này bên em còn đủ size ạ", "Chị inbox em số điện thoại nha");
    assert.equal(kq.kind, "REWRITE");
    assert.ok(kq.keepRatio < REWRITE_KEEP_RATIO, `giữ ${kq.keepRatio}`);
    assert.equal(feedsTheModel(kq.kind), false);
  }

  // phép đọc tiền dùng CHUNG bộ đọc với lưới chặn — không có bộ thứ hai lỏng hơn
  {
    // Cùng một số tiền viết ba kiểu phải ra cùng một dữ kiện, nếu không thì đổi cách viết sẽ bị
    // chấm nhầm thành đổi giá.
    const a = factsOf("giá 499.000 ₫");
    const b = factsOf("giá 499000đ");
    const c = factsOf("giá 499k");
    assert.deepEqual(a.money, b.money, "499.000 ₫ và 499000đ là một");
    assert.deepEqual(a.money, c.money, "499k và 499.000 ₫ là một");
    assert.equal(classifyEdit("Dạ 499.000 ₫ ạ", "Dạ 499k nha chị").kind, "WORDING", "viết tắt tiền là cách nói, không phải đổi giá");
  }

  // số điện thoại người thêm vào là dữ kiện — đó là chỗ ERP chưa có
  {
    const kq = classifyEdit("Dạ chị cho em xin số điện thoại ạ", "Dạ em gọi lại số 0912345678 của chị nhé ạ");
    assert.equal(kq.kind, "FACTS");
    assert.ok(kq.factsAdded.some((f) => f.includes("0912345678")));
  }

  // keepRatio đo theo TỪ CỦA MÁY còn sống sót, và câu rỗng là 0 chứ không phải chia cho 0
  {
    assert.equal(keepRatio("", "gì đó"), 0);
    assert.equal(keepRatio("a b c d", "a b c d"), 1);
    assert.equal(keepRatio("a b c d", "a b"), 0.5);
    // Con số KHÔNG tính là một từ: chúng đã được so riêng bằng bộ đọc của lưới chặn, và đếm lại ở
    // đây thì đổi cách viết tiền sẽ điều khiển phép đo giọng văn.
    assert.equal(keepRatio("dạ 499.000 ₫ ạ", "dạ 499k ạ"), 1, "đổi cách viết tiền không làm mất một chữ nào");
  }

  // mỗi loại có một nhãn đọc được — bảng không in ra mã nội bộ
  {
    for (const k of EDIT_KINDS) assert.ok(EDIT_KIND_LABEL[k]?.length > 3, k);
  }

  // khối ví dụ: rỗng khi chưa học được gì, và luôn kèm câu cấm mượn dữ kiện
  {
    assert.equal(styleExamplesBlock([]), "", "chưa có cặp nào ⇒ không thêm chữ nào vào prompt");
    const cap = Array.from({ length: STYLE_EXAMPLES_MAX + 3 }, (_, i) => ({ suggested: `máy ${i}`, final: `người ${i}` }));
    const khoi = styleExamplesBlock(cap);
    assert.equal((khoi.match(/Máy viết:/g) ?? []).length, STYLE_EXAMPLES_MAX, "không được vượt trần ví dụ");
    assert.match(khoi, /không mượn con số|Tuyệt đối không mượn/i, "thiếu câu này là mời mô hình chép số từ ví dụ");
    assert.ok(khoi.includes("máy 0") && khoi.includes("người 0"), "ví dụ mới nhất phải đứng đầu");
  }

  console.log(
    `✓ Học từ chỗ shop sửa: bốn loại sửa tách bạch · đổi một con số là SỬA DỮ KIỆN dù giữ ${Math.round(classifyEdit("Dạ mẫu này bên em 499.000 ₫ ạ, chị cho em xin size với ạ", "Dạ mẫu này bên em 450.000 ₫ ạ, chị cho em xin size với ạ").keepRatio * 100)}% chữ · chỉ WORDING được đưa lại cho mô hình · con số không tính là từ khi đo giọng văn`,
  );
}
