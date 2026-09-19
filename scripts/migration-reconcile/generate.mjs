/**
 * SINH HAI MIGRATION HOÀ GIẢI TỪ CHÍNH SQL ĐÃ CHẠY THẬT — không gõ tay lại một câu nào.
 *
 *   node scripts/migration-reconcile/generate.mjs
 *
 * ═══ VÌ SAO SINH RA CHỨ KHÔNG VIẾT TAY ═══
 *
 * Hoà giải phải mang đúng hiệu ứng lược đồ của 16 migration đã chạy trên bản chạy thử và 4
 * migration của `main` mà bản chạy thử sẽ bỏ qua. Gõ tay lại hai mươi tệp SQL là hai mươi cơ hội
 * chép sót một cột — và chép sót ở đây không đỏ ở đâu cả, nó chỉ làm hai CSDL khác nhau một cột
 * rồi im lặng.
 *
 * Nên tệp này ĐỌC chính các tệp ấy từ kho và biến đổi từng câu lệnh thành dạng chạy-lại-được.
 * Thứ tự câu lệnh GIỮ NGUYÊN: chuỗi gốc đã chạy thành công một lần, và trong chuỗi ấy có cả
 * `create table` rồi `drop table` cùng một bảng — đảo thứ tự là ra một lược đồ khác.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const show = (ref, p) => execFileSync("git", ["show", `${ref}:${p}`], { encoding: "utf-8" });
const lsMigrations = (ref, re) =>
  execFileSync("git", ["ls-tree", "--name-only", ref, "drizzle/"], { encoding: "utf-8" })
    .split("\n")
    .filter((f) => re.test(f))
    .sort();

/**
 * Biến một câu lệnh thành dạng CHẠY LẠI ĐƯỢC.
 *
 * Bốn phép, và phép thứ tư là phép duy nhất không phải chỉ thêm `IF NOT EXISTS`:
 *   · create table / create index      → thêm `if not exists`
 *   · add column                        → thêm `if not exists`
 *   · drop column                       → thêm `if exists`
 *   · add constraint                    → thêm một câu `drop constraint if exists` NGAY TRƯỚC nó,
 *     vì Postgres không có `add constraint if not exists`. Bỏ rồi thêm lại là cách duy nhất chạy
 *     lại được, và nó an toàn ở đây vì ràng buộc được thêm lại y hệt ngay câu sau.
 */
function idempotent(stmt) {
  let s = stmt;
  s = s.replace(/\bCREATE TABLE\s+(?!IF NOT EXISTS)/gi, "CREATE TABLE IF NOT EXISTS ");
  s = s.replace(/\bCREATE (UNIQUE )?INDEX\s+(?!IF NOT EXISTS)/gi, (_m, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `);
  s = s.replace(/\bADD COLUMN\s+(?!IF NOT EXISTS)/gi, "ADD COLUMN IF NOT EXISTS ");
  s = s.replace(/\bDROP COLUMN\s+(?!IF EXISTS)/gi, "DROP COLUMN IF EXISTS ");
  // Bản kết xuất của drizzle-kit CÓ chứa lệnh xoá ràng buộc / chỉ mục (nó so với một ảnh chụp
  // meta đã lệch). Chúng phải chịu được việc đối tượng không tồn tại, nếu không lượt chạy trên
  // một CSDL trắng sẽ chết ở câu xoá một thứ chưa bao giờ được tạo.
  s = s.replace(/\bDROP CONSTRAINT\s+(?!IF EXISTS)/gi, "DROP CONSTRAINT IF EXISTS ");
  s = s.replace(/\bDROP INDEX\s+(?!IF EXISTS)/gi, "DROP INDEX IF EXISTS ");

  /*
    `CREATE TYPE ... AS ENUM` không có dạng `IF NOT EXISTS` trong Postgres. Bọc vào một khối `DO`
    bắt `duplicate_object` là cách chạy-lại-được duy nhất — cùng đúng cái khuôn mà migration của
    `main` đã dùng cho ràng buộc, nên đây không phải một phát minh riêng của tệp này.
  */
  if (/^\s*CREATE TYPE\b/i.test(s)) {
    return [`DO $$ BEGIN\n  ${s.trim()};\nEXCEPTION WHEN duplicate_object THEN NULL; END $$`];
  }

  const add = /^\s*ALTER TABLE\s+("?[\w.]+"?)\s+ADD CONSTRAINT\s+("?[\w]+"?)/i.exec(s);
  /*
    TRẢ VỀ MỘT MẢNG, không phải một chuỗi.

    Câu `drop constraint if exists` phải là một CÂU LỆNH RIÊNG, không được dán vào trước câu `add`
    bằng một dấu xuống dòng. Drizzle chạy mỗi khối giữa hai `--> statement-breakpoint` như MỘT
    truy vấn chuẩn bị sẵn, và trình điều khiển từ chối hai câu lệnh trong một truy vấn — lượt chạy
    đầu chết đúng ở đó.
  */
  return add ? [`ALTER TABLE ${add[1]} DROP CONSTRAINT IF EXISTS ${add[2]}`, s] : [s];
}

/** Cắt một tệp .sql của drizzle thành từng câu lệnh, bỏ chú thích và dòng trống. */
function statements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((x) =>
      x
        .split("\n")
        .filter((d) => !/^\s*--/.test(d))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
    .map((x) => x.replace(/;\s*$/, ""));
}

function build(ref, files, header) {
  const out = [header, "--> statement-breakpoint"];
  for (const f of files) {
    out.push(`-- ┌─ ${f.replace("drizzle/", "")} ` + "─".repeat(Math.max(0, 60 - f.length)));
    for (const st of statements(show(ref, f))) {
      for (const one of idempotent(st)) out.push(`${one};`, "--> statement-breakpoint");
    }
  }
  // Bỏ dấu ngắt câu thừa ở cuối.
  while (out[out.length - 1] === "--> statement-breakpoint") out.pop();
  return out.join("\n") + "\n";
}

mkdirSync("scripts/migration-reconcile/out", { recursive: true });

// ── R1: bốn migration của `main` mà bản chạy thử SẼ BỎ QUA ──
const R1_HEADER = `-- HOÀ GIẢI R1 — BỐN MIGRATION CỦA \`main\` MÀ BẢN CHẠY THỬ SẼ BỎ QUA.
--
-- Drizzle quyết định "đã chạy chưa" bằng MỐC THỜI GIAN trong sổ, không bằng tên tệp. Bản chạy thử
-- có mốc trần 1789381643786 (14/09/2026), cao hơn mốc của \`main\` 0084–0087 — nên khi gộp nhánh,
-- bốn migration ấy sẽ bị BỎ QUA VĨNH VIỄN ở đó, im lặng.
--
-- Đó không phải chuyện nhỏ: \`main\` 0090 chạy \`ALTER TABLE "fanpages"\`, mà bảng \`fanpages\` do
-- chính 0086 tạo ra. Thiếu nó thì lượt migration trên bản chạy thử CHẾT giữa chừng — \`IF NOT
-- EXISTS\` trên tên cột không cứu được một bảng không tồn tại.
--
-- Tệp này mang đúng hiệu ứng của bốn migration ấy, chạy lại được. Trên CSDL đã có chúng (bản
-- production) nó bị bỏ qua vì mốc thấp hơn trần; trên bản chạy thử nó chạy và tạo đủ.
--
-- SINH RA bởi scripts/migration-reconcile/generate.mjs — đừng sửa tay.`;
const r1Files = lsMigrations("origin/main", /drizzle\/008[4-7]_/);
writeFileSync("scripts/migration-reconcile/out/R1.sql", build("origin/main", r1Files, R1_HEADER));

// ── R2: TRẠNG THÁI CUỐI của lược đồ nhánh, KHÔNG phải bản phát lại 16 migration ──
//
// Bản đầu ghép 16 migration rồi thêm `IF NOT EXISTS` vào từng câu. Bài kiểm bác bỏ ngay, và lý do
// đáng ghi lại: IDEMPOTENT TỪNG CÂU KHÔNG PHẢI IDEMPOTENT CẢ CHUỖI khi trong chuỗi có lệnh XOÁ.
//
// Cụ thể: 0088 tạo `sales_size_profiles` và các khoá ngoại trỏ tới nó; 0091 xoá cả cột
// `size_profile_id` lẫn bảng ấy. Phát lại chuỗi trên một CSDL đã ở trạng thái CUỐI thì câu
// "thêm khoá ngoại trên `test_product_profiles.size_profile_id`" chạy vào một cột không còn tồn
// tại — và `IF NOT EXISTS` trên tên ràng buộc không cứu được một cột đã bị xoá.
//
// Nên R2 mô tả TRẠNG THÁI CUỐI: bản kết xuất toàn lược đồ mà drizzle-kit sinh từ `db/schema.ts`
// của nhánh, biến thành chạy-lại-được. Không có lệnh xoá nào trong đó, nên không có bẫy thứ tự
// nào cả. Trên CSDL đã có sẵn đối tượng thì mọi câu thành không-làm-gì.
//
// Đánh đổi phải nói rõ: bản kết xuất mô tả cái `db/schema.ts` NÓI, còn 16 migration mô tả cái đã
// THẬT SỰ chạy. Hai thứ lệch nhau thì R2 đi theo `db/schema.ts`. Bài kiểm vì vậy không chỉ so hai
// đường với nhau mà còn đòi những bảng/cột cụ thể phải có mặt.
const R2_HEADER = `-- HOÀ GIẢI R2 — TRẠNG THÁI CUỐI CỦA LƯỢC ĐỒ NHÁNH, DẠNG CHẠY LẠI ĐƯỢC.
--
-- 16 migration 0084–0099 của nhánh đều có mốc THẤP HƠN mốc trần của production. Gộp nhánh vào
-- \`main\` mà không có tệp này thì production BỎ QUA CẢ 16, im lặng, và không bao giờ có lược đồ
-- nhân sự AI.
--
-- ĐÂY KHÔNG PHẢI BẢN PHÁT LẠI 16 MIGRATION. Phát lại là hỏng: trong chuỗi ấy 0088 tạo
-- \`sales_size_profiles\` cùng các khoá ngoại trỏ tới nó, rồi 0091 xoá cả cột lẫn bảng — phát lại
-- trên một CSDL đã ở trạng thái cuối sẽ chạy câu "thêm khoá ngoại" vào một cột không còn tồn tại.
-- Idempotent TỪNG CÂU không phải idempotent CẢ CHUỖI khi trong chuỗi có lệnh xoá.
--
-- Tệp này mô tả TRẠNG THÁI CUỐI, không có một lệnh xoá nào, nên không có bẫy thứ tự nào.
--
-- ⚠ MỐC CỦA TỆP NÀY PHẢI LỚN HƠN MỌI MỐC CỦA \`main\`, và vì thế nó CHỈ được đưa vào sổ Ở LÚC GỘP
--   NHÁNH. Đưa vào sổ của nhánh lúc này là nâng mốc trần của bản chạy thử lên trên mốc của
--   \`main\` 0088–0106, và khi ấy toàn bộ 19 migration đó bị bỏ qua vĩnh viễn ở bản chạy thử.
--
-- SINH RA bởi scripts/migration-reconcile/generate.mjs từ bản kết xuất của drizzle-kit.`;

const dump = readFileSync("scripts/migration-reconcile/full-schema.sql", "utf-8");
const r2out = [R2_HEADER, "--> statement-breakpoint"];
for (const st of statements(dump)) {
  for (const one of idempotent(st)) r2out.push(`${one};`, "--> statement-breakpoint");
}
while (r2out[r2out.length - 1] === "--> statement-breakpoint") r2out.pop();
writeFileSync("scripts/migration-reconcile/out/R2.sql", r2out.join("\n") + "\n");

console.log(`R1: ${r1Files.length} tệp nguồn → scripts/migration-reconcile/out/R1.sql`);
console.log(`R2: bản kết xuất toàn lược đồ → scripts/migration-reconcile/out/R2.sql`);
