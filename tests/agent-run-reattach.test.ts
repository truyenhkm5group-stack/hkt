import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { docBanKhai } from "@/lib/constants/agent-run-reattach";

/**
 * ═══════════ GẮN LẠI LƯỢT CHẠY AGENT VỀ ĐÚNG VIỆC ═══════════
 *
 * Sáu dòng đầu tiên của sổ `tech_agent_runs` đều nằm dưới `TECH-1` — một việc phần lớn chúng chưa
 * bao giờ chạm tới. Nguyên nhân đã vá ở mã nguồn; còn lại là những dòng ĐÃ GHI.
 *
 * Bài này khoá ba tính chất, và tính chất đầu là thứ phân biệt một lượt SỬA với một lượt ĐOÁN:
 *
 *   1. Script KHÔNG suy diễn — nó nhận một BẢN KHAI tường minh và chỉ thi hành bản khai ấy.
 *   2. Chạy thử là MẶC ĐỊNH; `--apply` mới ghi.
 *   3. Gỡ liên kết KHÔNG phải xoá dữ liệu.
 */

const goc = path.resolve(__dirname, "..");

export function testBanKhaiGanLai() {
  // ───────── Đọc bản khai ─────────
  const ok = docBanKhai(["github:123:1=TECH-2", "github:456:1=-", "--apply"]);
  assert.deepEqual(ok.loi, [], "bản khai đúng dạng thì không có lỗi");
  assert.deepEqual(ok.muc, [
    { externalRef: "github:123:1", taskCode: "TECH-2" },
    // Dấu `-` = KHÔNG THUỘC VIỆC NÀO. Đó là câu trả lời đúng cho lượt tự kiểm, không phải một chỗ trống.
    { externalRef: "github:456:1", taskCode: null },
  ]);

  /*
    ───────── DẠNG SAI PHẢI DỪNG, KHÔNG ĐƯỢC ĐOÁN Ý ─────────

    `github:123:1` (thiếu vế phải) có thể hiểu là "gỡ liên kết" hoặc "người gõ thiếu". Hai cách
    hiểu ấy cho hai kết quả khác hẳn nhau trên dữ liệu thật, nên script không được chọn hộ.
  */
  for (const xau of ["github:123:1", "=TECH-2", "github:123:1="]) {
    const v = docBanKhai([xau]);
    assert.equal(v.muc.length, 0, `"${xau}" không được tạo ra mục nào`);
    assert.equal(v.loi.length, 1, `"${xau}" phải báo lỗi`);
  }

  // Cờ không phải là mục.
  assert.equal(docBanKhai(["--apply"]).muc.length, 0);
}

export function testGanLaiSourceGuards() {
  const src = readFileSync(path.join(goc, "scripts/agent-run-reattach.ts"), "utf8");
  const than = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /*
    ───────── CHẠY THỬ LÀ MẶC ĐỊNH ─────────

    Một kịch bản sửa dữ liệu mà ghi ngay khi chạy là một kịch bản người ta chỉ dám chạy một lần —
    và lần ấy họ chưa biết nó sẽ làm gì.
  */
  assert.ok(/const apply = process\.argv\.includes\("--apply"\)/.test(than), "phải có cờ --apply");
  const iGhi = than.indexOf("db.update(schema.techAgentRuns)");
  assert.ok(iGhi > 0, "phải có đúng đường ghi");
  const dongGhi = than.slice(than.lastIndexOf("\n", iGhi), than.indexOf("\n", iGhi));
  assert.ok(/if \(apply\)/.test(dongGhi), `lệnh ghi phải nằm sau \`if (apply)\` — thấy: ${dongGhi.trim()}`);

  /*
    ───────── CHỈ ĐỔI Ô QUY KẾT, KHÔNG ĐỤNG BẰNG CHỨNG ─────────

    Gỡ liên kết là nói "lượt chạy này không thuộc việc nào", KHÔNG phải xoá nó. Cổng, tệp đã đổi,
    nhánh, tóm tắt đều là bằng chứng của một lượt chạy CÓ THẬT và phải còn nguyên.
  */
  assert.ok(!/db\.delete\(/.test(than), "script KHÔNG được xoá dòng nào");
  const iSet = than.indexOf("set({", iGhi);
  const khoiSet = than.slice(iSet, than.indexOf("})", iSet) + 2);
  assert.equal(khoiSet.replace(/\s/g, ""), "set({taskId:taskIdMoi})", `chỉ được đổi ô quy kết, thấy: ${khoiSet}`);

  /*
    ───────── KHÔNG SUY DIỄN TỪ DỮ LIỆU ─────────

    AGENTS.md mục 35: không đoán người/việc cho dòng lịch sử. Script chỉ thi hành bản khai; nó
    không được tự dò mã việc trong tên nhánh rồi "tự hiểu".
  */
  assert.ok(!/branch\.(match|split|replace)/.test(than), "KHÔNG được suy mã việc từ tên nhánh — bản khai là nguồn duy nhất");

  /*
    ───────── KHÔNG TÌM THẤY LÀ MỘT KẾT QUẢ ─────────

    Một lượt sửa chạy xong, in vài dòng, không sửa gì — người đọc sẽ tưởng nó đã sửa.
  */
  assert.ok(/if \(khongThay\) process\.exit\(1\)/.test(than), "không tìm thấy dòng nào thì phải trả mã thoát khác 0");

  /*
    ───────── PHẢI GỌI ĐƯỢC TỪ OPS, VÀ XẾP ĐÚNG LỚP ─────────

    Một kịch bản sửa dữ liệu chỉ chạy được trên máy của người viết là một kịch bản không ai dùng.
    Nhưng nó phải nằm trong lớp GHI NẶNG để chịu đúng hàng rào của nhóm ấy.
  */
  const ops = readFileSync(path.join(goc, ".github/workflows/ops-vps.yml"), "utf8");
  assert.ok(/- agent-run-reattach/.test(ops), "phải có trong danh sách thao tác ops");
  assert.ok(/agent-run-reattach\)\s*\n\s*fetch_script agent-run-reattach\.ts/.test(ops), "phải có nhánh thực thi");
  const iNang = ops.indexOf("DOC_NANG=");
  const dongNang = ops.slice(iNang, ops.indexOf("\n", iNang));
  assert.ok(dongNang.includes("agent-run-reattach"), "phải xếp vào lớp GHI NẶNG, không phải đọc nhẹ");
}
