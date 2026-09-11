import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * ═══════════ HẰNG SỐ KHÔNG ĐƯỢC ĐI QUA RANH GIỚI "use client" ═══════════
 *
 * SỰ CỐ THẬT (11/09/2026). `/bank` hỏng hẳn trên production: `TypeError: f.BANK_TABS.includes is
 * not a function`. `BANK_TABS` là một MẢNG khai trong `bank-tabs.tsx` — tệp có `"use client"` — và
 * Server Component `bank/page.tsx` import nó về gọi `.includes()`.
 *
 * Qua ranh giới đó Next KHÔNG đưa giá trị thật sang: nó thay module bằng một *client reference
 * proxy*. Phía máy chủ, `BANK_TABS` là một đối tượng tham chiếu, không phải mảng. Chương trình chạy
 * tới dòng gọi `.includes()` mới nổ.
 *
 * ─── VÌ SAO KHÔNG CÔNG CỤ NÀO THẤY ───
 *
 * `tsc` thấy kiểu đúng (nó đọc mã nguồn, không đọc phép thay module lúc dựng). `eslint` không có
 * luật này. `npm run build` thành công. Chỉ có người dùng mở trang mới thấy — và đó chính là điều
 * đã xảy ra: chủ shop báo lỗi, không phải lá chắn.
 *
 * ─── ĐÂY LÀ LẦN THỨ CHÍN CỦA MỘT HÌNH DẠNG ───
 *
 * Trước đó: `export { IDEA_REVIEW_DECISIONS }` trong tệp `"use server"` làm hỏng cả `/ideas`.
 * `tests/use-server-exports.test.ts` khoá NỬA KIA của cùng một vấn đề. Nửa này chưa ai canh.
 *
 * Nên bài kiểm này quét CẢ BỀ MẶT, không canh một danh sách gõ tay: mọi tệp máy chủ import từ mọi
 * tệp `"use client"`.
 *
 * ─── LUẬT ───
 *
 * Server Component chỉ được lấy từ tệp `"use client"` hai thứ:
 *   · COMPONENT (tên PascalCase) — Next dựng sẵn cơ chế tham chiếu cho đúng việc này;
 *   · KIỂU (`import type` / `{ type X }`) — bị xoá sạch lúc biên dịch, không tồn tại khi chạy.
 *
 * Mọi thứ khác — hằng số, mảng, hàm tiện ích — phải nằm ở `lib/constants/*` hoặc `lib/*` và được
 * CẢ HAI phía import từ đó.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/client-boundary-exports.test.ts
 */

const goc = path.resolve(__dirname, "..");
const THU_MUC = ["app", "components", "lib", "hooks"];

function liet(dir: string, ra: string[] = []): string[] {
  const p = path.join(goc, dir);
  if (!fs.existsSync(p)) return ra;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const con = path.join(dir, e.name);
    if (e.isDirectory()) liet(con, ra);
    else if (/\.tsx?$/.test(e.name)) ra.push(con.split(path.sep).join("/"));
  }
  return ra;
}

/** Tệp có chỉ thị `"use client"` ở đầu (bỏ qua chú thích và dòng trống). */
function laClient(src: string): boolean {
  const dau = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").trimStart();
  return /^["']use client["']/.test(dau);
}

/** Đưa mọi dạng đường dẫn về khoá chung để so với danh sách tệp. */
function giaiDuong(tuTep: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(tuTep), spec));
  else return null;
  for (const duoi of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const thu = `${base}${duoi}`;
    if (fs.existsSync(path.join(goc, thu))) return thu;
  }
  return null;
}

export function testClientBoundaryExports() {
  const tep = THU_MUC.flatMap((d) => liet(d));
  const noiDung = new Map(tep.map((f) => [f, fs.readFileSync(path.join(goc, f), "utf8")]));
  const client = new Set(tep.filter((f) => laClient(noiDung.get(f)!)));
  assert.ok(client.size > 5, `phải tìm thấy tệp "use client" — hiện ${client.size}, có lẽ bộ dò chỉ thị đã hỏng`);

  const viPham: string[] = [];
  const canhCoi = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

  for (const [f, src] of noiDung) {
    if (client.has(f)) continue; // tệp client import nhau thì không có ranh giới nào bị vượt
    for (const m of src.matchAll(canhCoi)) {
      const chiKieu = Boolean(m[1]);
      if (chiKieu) continue;
      const dich = giaiDuong(f, m[3]);
      if (!dich || !client.has(dich)) continue;
      for (const raw of m[2].split(",")) {
        const ten = raw.trim();
        if (!ten) continue;
        // `{ type X }` bị xoá lúc biên dịch — không tồn tại khi chạy nên vô hại.
        if (/^type\s/.test(ten)) continue;
        const cuoi = ten.split(/\s+as\s+/).pop()!.trim();
        // Component là thứ DUY NHẤT Next dựng sẵn cơ chế tham chiếu cho.
        if (/^[A-Z][A-Za-z0-9]*$/.test(cuoi)) continue;
        viPham.push(`${f} lấy \`${cuoi}\` từ tệp "use client" ${dich}`);
      }
    }
  }

  assert.deepEqual(
    viPham,
    [],
    `Giá trị đi qua ranh giới "use client" — phía máy chủ nó là proxy tham chiếu, KHÔNG phải giá trị thật:\n  ${viPham.join("\n  ")}\n\n` +
      `Chuyển hằng số / hàm sang lib/constants/* hoặc lib/*, rồi cho CẢ HAI phía import từ đó. ` +
      `Chỉ COMPONENT (PascalCase) và KIỂU mới được đi qua ranh giới này.\n` +
      `tsc, eslint và next build đều KHÔNG thấy lỗi này — chỉ người mở trang mới thấy.`,
  );

  console.log(`✓ Ranh giới "use client": ${client.size} tệp client · ${noiDung.size - client.size} tệp máy chủ · 0 giá trị vượt ranh giới (chỉ component và kiểu được đi qua)`);
}

if (process.argv[1] && /client-boundary-exports\.test\.ts$/.test(process.argv[1])) {
  testClientBoundaryExports();
}
