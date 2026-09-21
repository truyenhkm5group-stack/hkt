import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ═══════════ ĐƯỜNG THÀNH CÔNG CỦA SCRIPT AGENT PHẢI CÓ LỐI THOÁT ═══════════
 *
 * ĐÃ CẮN THẬT, lượt chạy agent #18 — và nó cắn ở đúng chỗ đau nhất: sau khi MỌI thứ đã thành công.
 *
 *     Chạy agent DOCUMENTATION          ✓
 *     Kiểm phạm vi tệp và in bằng chứng ✓   ← lần đầu tiên xanh
 *     Chép sổ lượt chạy về ERP          ✓
 *     Đẩy nhánh agent                   ✓
 *     Dựng tiêu đề và thân PR           … đứng im
 *
 * `scripts/agent-pr-text.ts` gọi `main()` rồi chỉ bắt `.catch()`. PGlite giữ một handle mở, nên
 * `main()` chạy xong mà vòng lặp sự kiện của Node không bao giờ rỗng — tiến trình sống tiếp, bước
 * treo, và job chỉ chết sau 60 phút.
 *
 * **Không lỗi, không log, không gì đỏ.** Lớp hỏng này cần một bài kiểm ở mức mã nguồn vì không
 * cổng nào khác nhìn thấy nó, và nó chỉ lộ ra khi mọi thứ khác đã đúng.
 *
 * ─── VÌ SAO KHÔNG QUÉT CẢ THƯ MỤC `scripts/` ───
 *
 * Bản đầu của bài kiểm này quét mọi script chạm CSDL và bắt nhầm 11 tệp đang chạy tốt. Lý do: có
 * script thoát bằng MÃ KẾT QUẢ (`process.exit(res.status === "SUCCEEDED" ? 0 : 1)`) — đúng và cần
 * thiết, vì mã thoát của chúng mang thông tin. Một bài kiểm bắt nhầm là một bài kiểm người ta tắt.
 *
 * Nên luật ở đây hẹp và chính xác: **CÂU LỆNH CUỐI CÙNG của `main()` phải là một lệnh thoát**, hoặc
 * lời gọi `main()` phải nối `.then()` để thoát. Đó đúng là tính chất mà lượt #18 thiếu, và là tính
 * chất mà cả 11 tệp kia đều đã có.
 */

const goc = path.resolve(__dirname, "..");

/**
 * Các script chạy TRONG dây chuyền agent trên máy Actions. Danh sách khai tường minh: một tệp mới
 * thêm vào dây chuyền phải được thêm vào đây, và người thêm sẽ đọc tới dòng này.
 */
const SCRIPT_DAY_CHUYEN = [
  "agent-runner-check.ts",
  "agent-fetch-task.ts",
  "agent-proof-setup.ts",
  "agent-run.ts",
  "agent-proof-report.ts",
  "agent-run-report.ts",
  "agent-pr-text.ts",
];

/** Thân hàm `main()`, cắt bằng phép đếm ngoặc — không đoán theo thụt lề. */
function thanMain(ma: string): string | null {
  const i = ma.search(/async function main\s*\(/);
  if (i < 0) return null;
  const mo = ma.indexOf("{", i);
  if (mo < 0) return null;
  let sau = 0;
  for (let j = mo; j < ma.length; j += 1) {
    if (ma[j] === "{") sau += 1;
    else if (ma[j] === "}") {
      sau -= 1;
      if (sau === 0) return ma.slice(mo + 1, j);
    }
  }
  return null;
}

/** Bỏ chú thích — một câu GIẢI THÍCH về `process.exit` không phải là một lệnh `process.exit`. */
function boChuThich(ma: string): string {
  return ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function testScriptDayChuyenPhaiThoat() {
  const thieu: string[] = [];
  for (const t of SCRIPT_DAY_CHUYEN) {
    const ma = boChuThich(readFileSync(path.join(goc, "scripts", t), "utf8"));

    // Cách 1: lời gọi `main()` tự nối một lệnh thoát.
    // `[^)]*` KHÔNG khớp được `() =>` vì chính nó chứa dấu `)` — dùng phép quét ký tự bất kỳ.
    if (/main\(\)[\s\S]{0,60}\.then\([\s\S]{0,40}process\.exit\(/.test(ma)) continue;

    // Cách 2: câu lệnh CUỐI CÙNG trong `main()` là một lệnh thoát.
    const than = thanMain(ma);
    if (than === null) {
      thieu.push(`${t} (không tìm thấy hàm main)`);
      continue;
    }
    const dongCuoi = than
      .split("\n")
      .map((d) => d.trim())
      .filter(Boolean)
      .pop();
    if (!dongCuoi?.startsWith("process.exit(")) thieu.push(`${t} (câu cuối của main: ${dongCuoi?.slice(0, 40) ?? "(rỗng)"})`);
  }

  assert.deepEqual(
    thieu,
    [],
    `script trong dây chuyền agent mà đường THÀNH CÔNG không thoát sẽ TREO tới khi job hết giờ — không lỗi, không log (lượt chạy #18): ${thieu.join(" · ")}`,
  );
}
