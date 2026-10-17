/**
 * ═══════ qa × 0245: CHỈ MỤC CHỮ CHUẨN HOÁ (migration 0247) + NGOẠI LỆ TẠO TRƯỚC CHỈ Ở `qa` ═══════
 *
 * Khoá bốn điều mà nếu trôi đi thì cả bản sửa vô nghĩa hoặc nguy hiểm (mục 65: đo mã nguồn và hợp đồng, không đo máy):
 *   1. MỘT chỉ mục, một câu: 0247, công cụ tạo trước và ứng viên của ops `migration-rehearsal` nói CÙNG một biểu thức, CÙNG một tên —
 *      lệch tên thì 0247 `IF NOT EXISTS` dựng chỉ mục thứ hai ở `qa`; lệch biểu thức thì planner không dùng được chỉ mục.
 *   2. Biểu thức trùng vế «tin mẫu chéo luồng» trong hàm của 0245 — chỉ mục chỉ có ích khi khớp đúng biểu thức hàm tra.
 *   3. Ngoại lệ có giới hạn: chỉ `qa`, chỉ khi 0245 chưa áp, chặn khi thiếu RAM (ngưỡng = của erp-backup.sh, không gõ lại).
 *   4. ops-vps.yml chỉ cho `--apply` đi khi đủ bốn tiền điều kiện ở máy chủ, và kết quả MÃ HOÁ.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CAU_TAO,
  CAU_XOA_INVALID,
  MOC_0245,
  MOC_0247,
  RAM_TOI_THIEU_MB,
  TEN_CHI_MUC,
  THAN_CHI_MUC,
  TO_CHUC_DUOC_PHEP,
  docThamSo,
  lapKeHoach,
  ramDungDuocMb,
} from "../scripts/org-0245-index-preseed";

const goc = path.resolve(__dirname, "..");
const doc = (p: string) => readFileSync(path.join(goc, p), "utf8").replace(/\r\n/g, "\n");

export function testQa0245Index() {
  // ── 1. Một chỉ mục, một câu ──
  const m0247 = doc("drizzle/0247_sales_chat_inbound_text_hash_idx.sql");
  assert.ok(m0247.includes(`CREATE INDEX IF NOT EXISTS "${TEN_CHI_MUC}" ${THAN_CHI_MUC};`), "0247 phải tạo ĐÚNG chỉ mục mà công cụ tạo trước dựng (cùng tên, cùng biểu thức)");
  assert.ok(!/CONCURRENTLY/.test(m0247.replace(/^--.*$/gm, "")), "0247 chạy trong giao dịch migration — không CONCURRENTLY");
  assert.equal(CAU_TAO, `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${TEN_CHI_MUC}" ${THAN_CHI_MUC}`);
  assert.equal(CAU_XOA_INVALID, `DROP INDEX CONCURRENTLY IF EXISTS "${TEN_CHI_MUC}"`);
  const journal = JSON.parse(doc("drizzle/meta/_journal.json")) as { entries: { tag: string; when: number }[] };
  assert.ok(journal.entries.some((e) => e.tag === "0247_sales_chat_inbound_text_hash_idx"), "0247 phải có trong sổ _journal.json");
  assert.equal(MOC_0245, journal.entries.find((e) => e.tag === "0245_sales_chat_last_inbound")?.when, "MOC_0245 phải là mốc `when` của 0245 trong sổ (drizzle ghi đúng số này khi áp)");
  assert.equal(MOC_0247, journal.entries.find((e) => e.tag === "0247_sales_chat_inbound_text_hash_idx")?.when, "MOC_0247 phải là mốc `when` của 0247 trong sổ");
  // Sổ tương thích: 0247 chưa áp thì mã vẫn phục vụ được — thiếu mục này thì `qa` (thiếu 0245+0246+0247) sập thay vì DEGRADED_MIGRATION.
  const compat = doc("lib/constants/migration-serve-compat.ts");
  assert.ok(compat.includes(`tag: "0247_sales_chat_inbound_text_hash_idx"`), "0247 phải khai trong MIGRATION_SERVE_COMPAT");
  assert.ok(doc("tests/migration-serve-compat.test.ts").includes(`drop index if exists "${TEN_CHI_MUC}"`), "bài kiểm lược đồ cũ phải gỡ cả chỉ mục 0247");

  const reh = doc("scripts/erp-migration-rehearsal.sh");
  const ten = /^MR_CHI_MUC_THU_TEN="([^"]+)"$/m.exec(reh)?.[1];
  assert.equal(ten, TEN_CHI_MUC, "ứng viên của migration-rehearsal phải cùng tên với 0247");
  const ung = /^MR_CHI_MUC_THU="(.*)"$/m.exec(reh)?.[1]?.replace(/\\"/g, '"').replace("$MR_CHI_MUC_THU_TEN", TEN_CHI_MUC);
  assert.equal(ung, `CREATE INDEX IF NOT EXISTS "${TEN_CHI_MUC}" ${THAN_CHI_MUC}`, "ứng viên đã đo trên bản sao phải TRÙNG KÝ TỰ với 0247");

  const schema = doc("db/schema.ts");
  assert.ok(schema.includes(`index("${TEN_CHI_MUC}")`) && /using\("hash", sql`\(btrim\(regexp_replace\(\$\{t\.text\}, '\[\[:space:\]\]\+', ' ', 'g'\)\)\)`\)/.test(schema), "db/schema.ts phải khai chỉ mục 0247 (hash trên chữ chuẩn hoá)");

  // ── 2. Trùng vế «tin mẫu chéo luồng» của hàm 0245 ──
  const m0245 = doc("drizzle/0245_sales_chat_last_inbound.sql");
  assert.ok(m0245.includes(`p.note = 'PAGE_REPLY'`) && m0245.includes(`btrim(regexp_replace(p."text", '[[:space:]]+', ' ', 'g'))`), "hàm 0245 phải còn tra đúng biểu thức mà chỉ mục phủ");
  assert.ok(THAN_CHI_MUC.includes(`btrim(regexp_replace("text", '[[:space:]]+', ' ', 'g'))`) && THAN_CHI_MUC.endsWith(`WHERE "note" = 'PAGE_REPLY'`));
  assert.ok(!m0245.includes(TEN_CHI_MUC), "0245 không tạo chỉ mục này — không có đường thứ hai nào dựng nó");

  // ── 3. Ngoại lệ có giới hạn ──
  assert.deepEqual([...TO_CHUC_DUOC_PHEP], ["qa"], "ngoại lệ chủ shop duyệt chỉ cho `qa`");
  // Chủ shop 17/10/2026: diễn tập khôi phục GIỮ 700 MB; riêng câu tạo chỉ mục được 350 MB (gấp đôi số đo thật ≈ 172 MB).
  const ramSh = Number(/^RAM_TOI_THIEU_DIEN_TAP_MB=(\d+)$/m.exec(doc("scripts/erp-backup.sh"))?.[1]);
  assert.equal(ramSh, 700, "ngưỡng diễn tập khôi phục GIỮ NGUYÊN 700 MB (chủ shop: không hạ)");
  assert.equal(RAM_TOI_THIEU_MB, 350, "ngưỡng riêng của câu tạo chỉ mục = 350 MB, đúng mức chủ shop duyệt — đổi phải có quyết định mới");
  assert.ok(RAM_TOI_THIEU_MB < ramSh, "ngưỡng tạo chỉ mục không bao giờ vượt lên làm thay ngưỡng diễn tập");
  const chay = doc("scripts/org-0245-index-preseed.ts");
  assert.ok(chay.indexOf("const chanNgay = lapKeHoach(ngay).chan") > 0 && chay.indexOf("const chanNgay = lapKeHoach(ngay).chan") < chay.indexOf("await client.query(CAU_TAO)"), "đo LẠI RAM + giao dịch dài ngay TRƯỚC câu dựng, thiếu thì dừng");

  assert.deepEqual(docThamSo(["qa"]), { org: "qa", apply: false });
  assert.deepEqual(docThamSo(["qa", "--apply"]), { org: "qa", apply: true });
  for (const sai of [["hslc-hmt-shop"], ["home"], ["qa", "hslc"], [], ["qa", "--force"], ["--apply"]]) assert.ok("error" in docThamSo(sai), `phải từ chối ${JSON.stringify(sai)}`);

  assert.equal(ramDungDuocMb("MemTotal:  2010000 kB\nMemAvailable:  716800 kB\n"), 700);
  assert.equal(ramDungDuocMb("MemTotal: 1 kB\n"), null);

  const du = { da0245: false, da0247: false, chiMuc: null, cauDai: 0, ramMb: 900 } as const;
  assert.deepEqual(lapKeHoach(du), { viec: "TAO", ly_do: "0245 chưa áp, chỉ mục chưa có", chan: [] });
  assert.equal(lapKeHoach({ ...du, chiMuc: { hopLe: false } }).viec, "XOA_INVALID_ROI_TAO");
  assert.equal(lapKeHoach({ ...du, chiMuc: { hopLe: true } }).viec, "KHONG_LAM_GI");
  assert.equal(lapKeHoach({ ...du, da0245: true }).viec, "KHONG_LAM_GI", "0245 đã áp ⇒ chỉ mục đi đường chuẩn 0247, không tạo ngoài migration");
  assert.equal(lapKeHoach({ ...du, da0245: true, chiMuc: { hopLe: false } }).viec, "XOA_INVALID", "0245 đã áp mà còn bản INVALID ⇒ chỉ xoá để 0247 dựng lại (IF NOT EXISTS sẽ bỏ qua bản hỏng mãi)");
  assert.equal(lapKeHoach({ ...du, da0245: true, chiMuc: { hopLe: true } }).viec, "KHONG_LAM_GI");
  // 0247 đã ghi sổ: migrator không chạy lại nó ⇒ chỉ mục thiếu / hỏng chỉ còn công cụ này dựng lại (review lượt 2).
  assert.equal(lapKeHoach({ ...du, da0245: true, da0247: true, chiMuc: { hopLe: false } }).viec, "XOA_INVALID_ROI_TAO");
  assert.equal(lapKeHoach({ ...du, da0245: true, da0247: true, chiMuc: null }).viec, "TAO");
  assert.equal(lapKeHoach({ ...du, da0245: true, da0247: true, chiMuc: { hopLe: true } }).viec, "KHONG_LAM_GI");
  assert.deepEqual(lapKeHoach({ ...du, ramMb: 349 }).chan, ["RAM dùng được 349 MB < 350 MB"]);
  assert.deepEqual(lapKeHoach({ ...du, ramMb: null }).chan, ["không đọc được RAM dùng được"], "thiếu số đo RAM không phải «đủ»");
  assert.equal(lapKeHoach({ ...du, cauDai: 1 }).chan.length, 1, "có câu dài đang chạy (migrate / đọc nặng) ⇒ không chen vào");

  // Công cụ chỉ chạy đúng hai câu DDL đã khai — không câu ghi dữ liệu nào.
  const cc = doc("scripts/org-0245-index-preseed.ts");
  const ma = cc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\b(insert into|update\s+"?\w+"?\s+set|delete from|truncate|alter table|drop table)\b/i.test(ma), "công cụ tạo trước không được ghi / sửa dữ liệu hay lược đồ ngoài chỉ mục");
  assert.ok(!/\b(create|drop)\s+index\b/i.test(ma.replace(/export const CAU_(TAO|XOA_INVALID) = `[^`]*`;/g, "")), "DDL chỉ nằm trong hai hằng CAU_TAO / CAU_XOA_INVALID");

  // ── 4. ops-vps.yml ──
  const ops = doc(".github/workflows/ops-vps.yml");
  const maHoa = /OPS_THAO_TAC_MA_HOA: "([^"]+)"/.exec(ops)?.[1] ?? "";
  assert.ok(` ${maHoa} `.includes(" org-0245-index-preseed "), "kết quả phải MÃ HOÁ");
  const nhanh = /^ {14}org-0245-index-preseed\)\n([\s\S]*?scripts\/org-0245-index-preseed\.ts) ;;\n/m.exec(ops)?.[1] ?? "";
  assert.ok(nhanh, "ops-vps.yml phải có nhánh org-0245-index-preseed");
  for (const can of [`-lt ${RAM_TOI_THIEU_MB}`, "-lt 2048", "-mmin -120", "-mtime -14", `'"result":"OK"'`, "exit 1", "fetch_script org-0245-index-preseed.ts", "ma_hoa_ket_qua chay_voi_arg"])
    assert.ok(nhanh.includes(can), `nhánh ops phải có \`${can}\``);
  assert.ok(nhanh.indexOf("exit 1") < nhanh.indexOf("fetch_script"), "tiền điều kiện phải chặn TRƯỚC khi chạy script");
  console.log("✓ qa × 0245: 0247 = công cụ tạo trước = ứng viên rehearsal (một câu) · trùng biểu thức hàm 0245 · chỉ qa · RAM ≥ 350 riêng tạo chỉ mục (diễn tập giữ 700) · ops chặn --apply khi thiếu RAM / ổ / sao lưu / diễn tập");
}
