import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * ═══════════ TỆP "use server" CHỈ ĐƯỢC XUẤT HÀM ASYNC ═══════════
 *
 * SỰ CỐ THẬT (10/09/2026, chủ shop báo kèm ảnh). Đăng xong một ý tưởng thì trang Ý tưởng marketing
 * hiện "Có lỗi khi tải trang", mã lỗi `1944668306`. Log máy chủ nói đúng một câu:
 *
 *     ⨯ Error: A "use server" file can only export async functions, found object.
 *
 * Thủ phạm là MỘT DÒNG ở cuối `lib/actions/ideas.ts`:
 *
 *     export { IDEA_REVIEW_DECISIONS };
 *
 * Một hằng số được xuất lại từ tệp Server Action. Next.js coi mọi thứ xuất ra từ tệp `"use server"`
 * là một điểm gọi từ xa, nên chỉ chấp nhận hàm async — gặp mảng thì ném lỗi lúc CHẠY, và lỗi đó
 * đánh sập cả trang.
 *
 * VÌ SAO KHÔNG CÔNG CỤ NÀO BẮT ĐƯỢC:
 *  · `tsc` xanh — xuất lại một hằng số là TypeScript hoàn toàn hợp lệ;
 *  · `eslint` xanh — không luật nào biết ý nghĩa của `"use server"`;
 *  · `npm run build` xanh — Next.js chỉ kiểm lúc nạp mô-đun khi chạy;
 *  · kiểm thử đơn vị xanh — không bài nào nạp mô-đun qua đường Server Action của Next.
 * Nó chỉ lộ ra khi có người thật bấm vào trang. Và dòng ấy là dòng CHẾT: không nơi nào import nó
 * từ đây, hằng số đã có sẵn ở `lib/constants/ideas.ts`.
 *
 * Bài kiểm này đọc MÃ NGUỒN: mọi tệp `"use server"` chỉ được xuất hàm async (`export async function`)
 * hoặc kiểu (`export type` / `export interface`, bị xoá lúc biên dịch nên vô hại).
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/use-server-exports.test.ts
 */

const goc = path.resolve(__dirname, "..");

function quetTep(thuMuc: string, ket: string[] = []): string[] {
  const day = path.join(goc, thuMuc);
  for (const ten of readdirSync(day)) {
    if (ten === "node_modules" || ten === ".next") continue;
    const duong = path.join(day, ten);
    if (statSync(duong).isDirectory()) quetTep(path.join(thuMuc, ten), ket);
    else if (ten.endsWith(".ts") || ten.endsWith(".tsx")) ket.push(path.join(thuMuc, ten).split(path.sep).join("/"));
  }
  return ket;
}

/** Dòng `export ...` nào KHÔNG phải hàm async và cũng không phải kiểu. */
function xuatSai(src: string): string[] {
  const loi: string[] = [];
  for (const dong of src.split(/\r?\n/)) {
    const s = dong.trim();
    if (!s.startsWith("export")) continue;
    // Hợp lệ: hàm async. Kiểu bị xoá lúc biên dịch nên không tới được Next.
    if (/^export\s+async\s+function\s/.test(s)) continue;
    if (/^export\s+(type|interface)\s/.test(s)) continue;
    if (/^export\s+\{[^}]*\}\s+from\s+/.test(s) && /\btype\b/.test(s)) continue;
    loi.push(s);
  }
  return loi;
}

export function testUseServerExports() {
  const tep = [...quetTep("lib"), ...quetTep("app")];
  assert.ok(tep.length > 100, `đọc hụt cây mã nguồn (chỉ thấy ${tep.length} tệp)`);

  const useServer: string[] = [];
  const viPham: string[] = [];

  for (const f of tep) {
    const src = readFileSync(path.join(goc, f), "utf8");
    // `"use server"` phải nằm ở ĐẦU tệp mới có hiệu lực với cả mô-đun.
    if (!/^\s*(\/\*[\s\S]*?\*\/\s*)?["']use server["']/.test(src)) continue;
    useServer.push(f);
    for (const dong of xuatSai(src)) viPham.push(`${f} → ${dong}`);
  }

  assert.ok(useServer.length > 15, `không tìm thấy đủ tệp Server Action (chỉ ${useServer.length}) — bộ dò đã hẹp lại`);
  assert.deepEqual(
    viPham,
    [],
    `tệp "use server" xuất thứ KHÔNG phải hàm async — Next.js ném lỗi lúc chạy và đánh sập cả trang:\n  ${viPham.join("\n  ")}\n` +
      "Hằng số dùng chung thuộc về lib/constants/*, không xuất lại từ tệp Server Action.",
  );

  console.log(`✓ Ranh giới Server Action: ${useServer.length} tệp "use server" · chỉ xuất hàm async · 0 hằng số lọt ra (lỗi này tsc/eslint/build đều không thấy)`);
}

if (process.argv[1] && /use-server-exports\.test\.ts$/.test(process.argv[1])) {
  testUseServerExports();
}
