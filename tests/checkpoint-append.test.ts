import assert from "node:assert/strict";
import { chenMuc, dongBiMat, dungNoiDungMoi } from "../scripts/checkpoint-append";

/**
 * ═══════════ CHECKPOINT CHỈ ĐƯỢC THÊM — BÀI KIỂM DỰNG TỪ ĐÚNG SỰ CỐ ĐÃ XẢY RA ═══════════
 *
 * 13/10/2026: một phiên dựng nội dung mới từ bản `CHECKPOINT.md` đã đọc 30 phút trước rồi đẩy.
 * Git không va (cha đúng là đầu nhánh vừa fetch) nên lượt ghi lọt, và nó ăn mất đúng một dòng mà
 * phiên khác vừa thêm — dòng ghi kết luận của phép đo probe #831. Bài này khoá hai tính chất đã
 * ngăn được chuyện đó: dựng xong KHÔNG mất dòng nào, và mất dòng thì phải NÓI RA chứ không im.
 */

const SO_GOC = [
  "# CHECKPOINT — ChotDonTuDong Launch",
  "",
  "> Mọi phiên ĐỌC TỆP NÀY TRƯỚC khi làm.",
  "",
  "## Checkpoint 13/10 ~19:00 — bàn giao",
  "",
  "- **ĐÃ XÁC NHẬN (probe #831):** JIT — listInbox «JIT 291 hàm», đếm-thẻ «JIT 187 hàm».",
  "- Bản sửa sẵn: fix/inbox-list-subplans @ 4ccf931b.",
  "",
  "## Checkpoint 09/10 ~04:30",
  "",
  "- readiness 60 %.",
].join("\n");

export function testCheckpointChiDuocThem() {
  /* 1 · Mục mới lên ĐẦU danh sách nhưng SAU khối tiêu đề — sổ xếp mới trước cũ. */
  const moi = chenMuc(SO_GOC, "## Checkpoint 13/10 ~21:15 — Team\n\n- gỡ nghẽn cổng #827/#831.");
  const dong = moi.split("\n");
  assert.equal(dong[0], "# CHECKPOINT — ChotDonTuDong Launch", "khối tiêu đề phải đứng nguyên ở đầu tệp");
  const viTri = dong.findIndex((d) => d.startsWith("## "));
  assert.match(dong[viTri], /21:15 — Team/, "mục mới phải đứng TRƯỚC mục checkpoint gần nhất");
  assert.ok(dong.indexOf("## Checkpoint 13/10 ~19:00 — bàn giao") > viTri, "mục cũ vẫn còn, chỉ lùi xuống");

  /* 2 · Chèn thuần tuý KHÔNG được làm mất một dòng nào — kể cả dòng kết luận phép đo. */
  assert.deepEqual(dongBiMat(SO_GOC, moi), [], "chèn một mục mới không được làm mất dòng nào");
  assert.ok(moi.includes("JIT 291 hàm"), "dòng kết luận của phép đo phải còn nguyên");

  /* 3 · CHÍNH SỰ CỐ: nội dung dựng từ bản ĐỌC TRƯỚC (thiếu dòng probe) bị bắt, và nói ra dòng mất. */
  const banCu = SO_GOC.split("\n").filter((d) => !d.includes("probe #831")).join("\n");
  const mat = dongBiMat(SO_GOC, chenMuc(banCu, "## Checkpoint mới"));
  assert.equal(mat.length, 1, "đúng một dòng bị mất");
  assert.match(mat[0], /probe #831/, "phải NÓI RA đúng dòng bị mất, không im lặng");

  /* 4 · So theo BỘI: một dòng lặp hai lần mà bản mới còn một thì vẫn là mất một. */
  assert.deepEqual(dongBiMat("- x\n- x", "- x"), ["- x"], "mất một lần xuất hiện vẫn là mất");
  assert.deepEqual(dongBiMat("- x", "- x\n- x"), [], "thêm một lần xuất hiện không phải là mất");

  /* 5 · Xê dịch dòng trống / khoảng trắng hai đầu không bị coi là mất chữ. */
  assert.deepEqual(dongBiMat("- x\n\n- y", "\n  - x  \n- y\n\n"), [], "dòng trống và khoảng trắng hai đầu không tính");

  /* 6 · Đoạn rỗng bị từ chối — một lượt ghi không có gì để nói là một lỗi, không phải việc hợp lệ. */
  assert.throws(() => chenMuc(SO_GOC, "   \n  "), /rỗng/, "đoạn thêm rỗng phải bị từ chối");

  /* 7 · Sổ chưa có mục nào thì nối vào cuối, vẫn không mất gì. */
  const chuaCoMuc = "# CHECKPOINT\n\n> đọc trước.";
  assert.deepEqual(dongBiMat(chuaCoMuc, chenMuc(chuaCoMuc, "## Mục đầu tiên")), []);
  assert.ok(chenMuc(chuaCoMuc, "## Mục đầu tiên").trimEnd().endsWith("## Mục đầu tiên"));

  /* 8 · dungNoiDungMoi là cửa duy nhất: chèn xong tự kiểm, và nó CHỈ nhận đoạn thêm — không có
         tham số nào nhận cả tệp, nên không đường nào dựng nội dung từ một bản đọc trước đó. */
  assert.equal(dungNoiDungMoi.length, 2, "dungNoiDungMoi(goc, muc) — đúng hai tham số, không nhận 'nội dung đầy đủ'");
  assert.ok(dungNoiDungMoi(SO_GOC, "## Mục mới").includes("JIT 291 hàm"));

  console.log(
    "✓ Checkpoint chỉ được THÊM: mục mới lên đầu sau khối tiêu đề · chèn không mất dòng nào · bản dựng từ nội dung ĐỌC TRƯỚC bị bắt và nêu đúng dòng mất · so theo bội · khoảng trắng không tính · đoạn rỗng bị từ chối · sổ chưa có mục thì nối cuối",
  );
}
