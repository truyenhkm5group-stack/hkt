import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CAT_LOI_CONG, DAU_CAT, catDauRa, coCongDo, docLoiCong } from "@/lib/constants/agent-run-error";

/**
 * ═══════════ CỔNG ĐỎ PHẢI NÓI ĐƯỢC VÌ SAO NÓ ĐỎ ═══════════
 *
 * Sổ lượt chạy từng ghi đúng `"Có cổng kiểm thử ĐỎ."` và bốn huy hiệu. Câu hỏi *"sửa cái gì"* chỉ
 * trả lời được bằng cách rời ERP mở log GitHub Actions — đường mà chủ shop không có.
 *
 * Hai luật khoá ở đây:
 *
 *  1. **Cắt giữ CẢ ĐẦU LẪN ĐUÔI.** Bản nháp đầu dùng `.slice(-1200)`, tức giữ mỗi đuôi. Với một
 *     lượt `tsc` bốn chục lỗi thì nó vứt đúng lỗi THỨ NHẤT — thứ thường là nguyên nhân, còn phần
 *     giữ lại toàn là dây chuyền.
 *  2. **Cổng đỏ mà không có câu lỗi KHÁC HẲN không có cổng đỏ.** Gộp hai ca là để một lượt HỎNG
 *     hiện ra như một lượt sạch (AGENTS.md mục 42).
 */

const goc = path.resolve(__dirname, "..");

export function testLoiCongDocDuoc() {
  /* ───────── CẮT: ĐẦU SỐNG SÓT, ĐUÔI SỐNG SÓT, GIỮA KHAI LÀ ĐÃ RƠI ───────── */
  const ngan = "lib/x.ts(3,9): error TS2304";
  assert.equal(catDauRa(ngan), ngan, "ngắn hơn trần thì trả nguyên văn, không thêm dấu cắt");
  assert.equal(catDauRa("  có đuôi trắng   \n\n"), "  có đuôi trắng", "cắt đuôi trắng — nó chỉ làm loãng khối in ra");

  const dongDau = "lib/queries/tech.ts(1,1): error TS0001: LỖI ĐẦU TIÊN";
  const dongCuoi = "lib/queries/tech.ts(999,1): error TS9999: LỖI CUỐI CÙNG";
  const dai = [dongDau, ..."x".repeat(9_000).split(""), dongCuoi].join("\n");
  const cat = catDauRa(dai);

  assert.ok(cat.includes(dongDau), "LỖI ĐẦU TIÊN phải sống sót — nó thường là nguyên nhân, và `.slice(-n)` vứt đúng nó");
  assert.ok(cat.includes(dongCuoi), "và khẳng định vừa gãy của npm test nằm ở cuối nên đuôi cũng phải sống sót");
  assert.ok(cat.includes(DAU_CAT), "phần giữa rơi thì phải NÓI RA — cắt im lặng là in một câu lỗi không đúng như nó xảy ra");
  assert.ok(cat.length < dai.length, "và thật sự ngắn đi");

  /* Trần là trần: phần giữ lại không được vượt quá nó (cộng dòng dấu cắt). */
  assert.ok(cat.length <= CAT_LOI_CONG.moiCong + DAU_CAT.length + 40, "giữ trong trần, không phình sổ");

  /* ───────── ĐỌC: BA TRẠNG THÁI, BA KẾT QUẢ ───────── */
  const sach = { typecheckResult: "PASSED", lintResult: "PASSED", testResult: "PASSED", buildResult: "PASSED" };
  const do_ = { typecheckResult: "FAILED", lintResult: "PASSED", testResult: "PASSED", buildResult: "UNKNOWN" };

  assert.equal(coCongDo(sach), false);
  assert.equal(coCongDo(do_), true);
  assert.equal(coCongDo({ typecheckResult: "UNKNOWN", lintResult: "SKIPPED", testResult: "UNKNOWN", buildResult: "UNKNOWN" }), false, "CHƯA CHẠY không phải ĐỎ — bốn cổng chưa xác minh là một lượt chưa đo, không phải một lượt hỏng");

  assert.deepEqual(docLoiCong({ chiPhi: null }, false), { kind: "KHONG_DO" }, "không cổng nào đỏ ⇒ không có gì để in");

  const chuaGhi = docLoiCong({ chiPhi: { usd: 0.01 } }, true);
  assert.equal(chuaGhi.kind, "CHUA_GHI", "cổng ĐỎ mà sổ không giữ câu lỗi ⇒ phải nói CHƯA GHI ĐƯỢC, KHÔNG được im lặng như lượt sạch");

  const co = docLoiCong({ loiCong: [{ ten: "typecheck", exitCode: 2, dauRa: "error TS2304" }] }, true);
  assert.equal(co.kind, "CO");
  assert.deepEqual(co.kind === "CO" ? co.ds : null, [{ ten: "typecheck", exitCode: 2, dauRa: "error TS2304" }]);

  /* `exitCode` thiếu là CHƯA BIẾT (`null`), không phải 0 — 0 nghĩa là "thoát sạch" (mục 42). */
  const thieuMa = docLoiCong({ loiCong: [{ ten: "test", dauRa: "gãy" }] }, true);
  assert.equal(thieuMa.kind === "CO" ? thieuMa.ds[0].exitCode : "x", null, "thiếu mã thoát ⇒ null, KHÔNG phải 0 — 0 là 'thoát sạch', một khẳng định khác hẳn");

  /* ───────── DỮ LIỆU RÁC KHÔNG ĐƯỢC LÀM SẬP TRANG ───────── */
  for (const rac of [null, undefined, "x", 7, [1, 2], { loiCong: "abc" }, { loiCong: [null, 5, {}, { ten: "" }] }]) {
    assert.doesNotThrow(() => docLoiCong(rac, true), `metadata lạ (${JSON.stringify(rac)}) không được ném lỗi`);
    assert.equal(docLoiCong(rac, true).kind, "CHUA_GHI", "…và rơi về CHƯA GHI ĐƯỢC, không phải 'lượt sạch'");
  }

  /* Mảng có một mục hợp lệ lẫn một mục rác ⇒ giữ mục hợp lệ, bỏ mục rác. */
  const lan = docLoiCong({ loiCong: [null, { ten: "lint", exitCode: 1, dauRa: "a" }] }, true);
  assert.equal(lan.kind === "CO" ? lan.ds.length : 0, 1, "lọc mục rác nhưng KHÔNG vứt mục đọc được");

  console.log("✓ Câu lỗi cổng đỏ: cắt giữ đầu+đuôi kèm dấu cắt · ba trạng thái tách nhau · rác không làm sập trang");
}

/* ═════════════ QUÉT MÃ NGUỒN ═════════════ */

export function testLoiCongGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const runner = bo(readFileSync(path.join(goc, "lib/agents/runner.ts"), "utf8"));
  const trang = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/tasks/[id]/page.tsx"), "utf8"));

  /*
    RUNNER PHẢI ĐI QUA `catDauRa`.

    `.slice(-n)` trên đầu ra cổng là đúng thứ bản vá này bỏ đi: nó giữ mỗi đuôi và vứt lỗi đầu
    tiên. Khoá ở mức mã nguồn để nó không lặng lẽ quay lại.
  */
  const khoiGhi = runner.slice(runner.indexOf("loiCong:"));
  assert.ok(khoiGhi.length > 0, "runner phải ghi câu lỗi vào sổ");
  assert.match(khoiGhi.slice(0, 200), /catDauRa\(/, "runner phải cắt bằng `catDauRa`");
  assert.doesNotMatch(khoiGhi.slice(0, 200), /\.slice\(\s*-/, "KHÔNG được quay lại `.slice(-n)`: nó vứt đúng lỗi đầu tiên");

  /* Màn hình phải đi qua hàm đọc chung, không tự bóc `metadata.loiCong`. */
  assert.match(trang, /docLoiCong\(/, "trang việc phải đọc câu lỗi qua hàm chung");
  assert.match(trang, /CHUA_GHI/, "…và phải hiện riêng trạng thái CHƯA GHI ĐƯỢC, nếu không lượt hỏng trông như lượt sạch");

  console.log("✓ Quét mã nguồn: runner cắt qua `catDauRa` (không `.slice(-n)`) · màn hình đọc qua hàm chung và hiện CHƯA GHI ĐƯỢC");
}
