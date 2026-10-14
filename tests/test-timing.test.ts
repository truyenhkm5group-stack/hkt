import assert from "node:assert/strict";

/**
 * ═══════════ BẢNG THỜI GIAN CỦA BỘ KIỂM THỬ — ĐỂ CHIA JOB BẰNG SỐ ĐO, KHÔNG BẰNG CẢM GIÁC ═══════════
 *
 * 13/10 trần job kiểm thử đã phải nâng 35′ → 45′ (#830), và 14/10 lượt «có token giả» của #842 vẫn bị cắt
 * ở 45,5′ trong khi chính bộ ấy chạy 34,2′ ở nhánh ẩn danh và 34,6′ trên main. Biên còn ~10′ trên một bộ
 * chạy 34–35′, nên một runner chậm là đỏ — và lần nâng trần kế tiếp cũng sẽ hết tác dụng như lần trước.
 *
 * Việc đúng là CHIA bộ kiểm thử, nhưng chia ở đâu thì phải có SỐ: nhóm nào ăn bao nhiêu phút. Không ai đo,
 * vì bộ kiểm thử chỉ in «✓ …» chứ không in thời gian. Lớp đo trong `sync-fixtures.test.ts` lấy mốc quanh
 * mỗi dòng in và cuối lượt in bảng N nhóm chậm nhất — số ấy có sẵn trong log của MỌI lượt cổng, không tốn
 * thêm một lượt chạy nào.
 *
 * Hàm dựng bảng là HÀM THUẦN nên đo được mà không phải chạy bộ kiểm thử (bộ đầy đủ mất 34 phút).
 */

export type NhipDo = { ms: number; dong: string };

/** Mốc chia cột — một bài 5 phút và một bài 5 giây không được in cùng một kiểu. */
const NGUONG_NOI_BAT_MS = 60_000;

/** Giây, một chữ số thập phân — đủ để xếp hạng, không giả vờ chính xác hơn đồng hồ của runner. */
export function giay(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Bảng N nhóm chậm nhất + tổng. Giữ NGUYÊN thứ tự giảm dần theo thời gian; nhóm bằng nhau giữ thứ tự xuất
 * hiện (ổn định) để hai lượt chạy giống nhau in ra giống nhau.
 */
export function bangThoiGian(nhip: readonly NhipDo[], n = 15): string[] {
  const tong = nhip.reduce((s, x) => s + x.ms, 0);
  const xep = nhip.map((x, i) => ({ ...x, i })).sort((a, b) => b.ms - a.ms || a.i - b.i).slice(0, n);
  const ra = [`THỜI GIAN: ${nhip.length} nhóm · tổng ${giay(tong)} · ${n} nhóm chậm nhất:`];
  for (const x of xep) {
    const phan = tong > 0 ? Math.round((x.ms / tong) * 100) : 0;
    const dau = x.ms >= NGUONG_NOI_BAT_MS ? "⏱" : " ";
    ra.push(`  ${dau} ${giay(x.ms).padStart(8)} ${String(phan).padStart(3)}%  ${x.dong.slice(0, 110)}`);
  }
  return ra;
}

export function testTestTiming() {
  const nhip: NhipDo[] = [
    { ms: 400, dong: "✓ Sản phẩm" },
    { ms: 125_000, dong: "✓ Hộp thư — chưa đọc lưu sẵn" },
    { ms: 61_000, dong: "✓ Sao lưu" },
    { ms: 400, dong: "✓ Landing" },
  ];
  const ra = bangThoiGian(nhip, 3);
  assert.match(ra[0], /4 nhóm · tổng 186\.8s · 3 nhóm chậm nhất/);
  assert.match(ra[1], /⏱\s+125\.0s\s+67%\s+✓ Hộp thư/, "nhóm chậm nhất lên đầu, có phần trăm, có dấu nổi bật");
  assert.match(ra[2], /⏱\s+61\.0s\s+33%\s+✓ Sao lưu/);
  assert.equal(ra.length, 4, "đúng N dòng + một dòng tiêu đề");
  assert.ok(!ra.some((d) => /Landing/.test(d)), "nhóm nhanh không chiếm chỗ của nhóm chậm");

  // Dưới ngưỡng thì KHÔNG mang dấu nổi bật — bảng phải phân biệt được «chậm thật» với «đứng đầu nhưng nhanh».
  const nhe = bangThoiGian([{ ms: 900, dong: "✓ a" }, { ms: 100, dong: "✓ b" }], 2);
  assert.ok(!nhe[1].includes("⏱"), "0,9s không phải là nhóm chậm");

  // Ổn định: hai nhóm bằng nhau giữ thứ tự xuất hiện, nên hai lượt chạy in ra giống hệt nhau.
  const deu = bangThoiGian([{ ms: 5, dong: "✓ trước" }, { ms: 5, dong: "✓ sau" }], 2);
  assert.match(deu[1], /✓ trước/);
  assert.match(deu[2], /✓ sau/);

  // Không nhóm nào ⇒ không chia cho 0, không in phần trăm vô nghĩa.
  assert.deepEqual(bangThoiGian([], 5), ["THỜI GIAN: 0 nhóm · tổng 0.0s · 5 nhóm chậm nhất:"]);

  console.log("  ✓ Bảng thời gian bộ kiểm thử: xếp theo thời gian · phần trăm · dấu nổi bật ≥ 60s · ổn định khi bằng nhau · bộ rỗng không chia cho 0");
}
