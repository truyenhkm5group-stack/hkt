import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * ═══════ NÚT LÀM MỚI PHẢI THẬT SỰ LÀM MỚI, VÀ PHẢI CÓ Ở MỌI BÁO CÁO ═══════
 *
 * Kiểu hỏng nguy hiểm nhất của một nút làm mới không phải là nó BÁO LỖI — mà là nó chạy trơn tru,
 * quay đúng một vòng, rồi trả về ĐÚNG CON SỐ CŨ. Báo cáo nặng đi qua `memo()` với TTL 60–120 giây,
 * nên chỉ gọi `router.refresh()` thôi là dựng lại trang trên một bộ số vẫn nằm trong đệm. Người
 * dùng không có cách nào phát hiện: màn hình nháy một cái, số y nguyên, và họ tin là dữ liệu chưa
 * đổi. Đó là lý do bài kiểm này canh ở mức MÃ NGUỒN chứ không chờ ai đó nhìn ra.
 *
 * Ba vế, mất vế nào cũng đủ làm nút thành đồ trang trí:
 *   1. Server action xoá đệm (`clearMemo`).
 *   2. Nút gọi server action TRƯỚC `router.refresh()` — đảo thứ tự là lượt dựng lại đọc đệm CŨ rồi
 *      mới tới lệnh xoá, tức vẫn ra số cũ nhưng lần sau mới đúng: sai một nhịp, khó thấy hơn hẳn.
 *   3. Nút nằm trong `PageHeader`, và MỌI trang bảng điều khiển dùng `PageHeader` — đó là thứ duy
 *      nhất bảo đảm "mọi báo cáo đều có nút", kể cả báo cáo viết sau bài kiểm này.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/refresh-button.test.ts
 */
const ACTION = "lib/actions/refresh.ts";
const NUT = "components/refresh-button.tsx";
const TIEU_DE = "components/page-header.tsx";
const THU_MUC_TRANG = path.join("app", "(dashboard)");

function doc(f: string) {
  return readFileSync(f, "utf8");
}

/**
 * Bỏ chú thích trước khi quét TÊN HÀM. Tệp trong kho này giải thích vì sao KHÔNG dùng một hàm nào
 * đó ngay trong chú thích của hàm dùng cái ngược lại — quét cả chú thích là bài kiểm đỏ vì một câu
 * văn, đúng thứ khiến người ta đi xoá câu văn thay vì đọc nó.
 */
function boChuThich(src: string) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Mọi `page.tsx` dưới nhóm bảng điều khiển. Đường dẫn chỉ dùng để ĐỌC tệp và để in ra, không làm khoá tra cứu. */
function trangBangDieuKhien(dir: string): string[] {
  const out: string[] = [];
  for (const muc of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, muc.name);
    if (muc.isDirectory()) out.push(...trangBangDieuKhien(p));
    else if (muc.name === "page.tsx") out.push(p);
  }
  return out;
}

export async function testRefreshButton() {
  // ───────── 1. Server action phải xoá đệm, không chỉ trả về một mốc giờ ─────────
  const action = boChuThich(doc(ACTION));
  assert.ok(/\bclearMemo\s*\(/.test(action), `${ACTION}: không gọi clearMemo() — nút làm mới sẽ dựng lại trang trên số CŨ còn trong đệm 60–120 giây.`);
  assert.ok(
    !/\bstaleMemo\s*\(/.test(action),
    `${ACTION}: dùng staleMemo() — đánh dấu cũ trả NGAY số cũ cho chính cú bấm vừa yêu cầu số mới. Đường NGƯỜI bấm phải xoá hẳn (xem tests/cache-semantics.test.ts).`,
  );

  // ───────── 2. Xoá đệm TRƯỚC, dựng lại SAU ─────────
  const nut = boChuThich(doc(NUT));
  const goiAction = nut.indexOf("await refreshReportData(");
  const goiRefresh = nut.indexOf("router.refresh(");
  assert.ok(goiAction > 0, `${NUT}: không gọi refreshReportData() — không có gì xoá đệm trước khi dựng lại.`);
  assert.ok(goiRefresh > 0, `${NUT}: không gọi router.refresh() — không có gì lấy lại dữ liệu từ máy chủ.`);
  assert.ok(goiAction < goiRefresh, `${NUT}: gọi router.refresh() TRƯỚC khi xoá đệm — lượt dựng lại đọc đúng số cũ, lệch một nhịp.`);

  // ───────── 3. Nút đi theo tiêu đề trang, và mọi trang đều có tiêu đề trang ─────────
  assert.ok(/<RefreshButton\b/.test(doc(TIEU_DE)), `${TIEU_DE}: không render <RefreshButton /> — mỗi trang lại phải tự thêm nút, và trang viết sau sẽ quên.`);

  const trang = trangBangDieuKhien(THU_MUC_TRANG);
  assert.ok(trang.length > 50, `Chỉ tìm thấy ${trang.length} trang bảng điều khiển — bộ quét hỏng, không phải kho mã teo lại.`);
  const thieu = trang.filter((f) => {
    const src = doc(f);
    // Trang chỉ chuyển hướng thì không có gì để làm mới — bỏ qua, nhưng phải là chuyển hướng THẬT.
    if (/\bredirect\s*\(/.test(src) && !/<\w/.test(src)) return false;
    return !/<PageHeader\b/.test(src);
  });
  assert.deepEqual(thieu, [], `Trang bảng điều khiển không dùng <PageHeader> nên KHÔNG có nút làm mới: ${thieu.join(", ")}`);

  console.log(`✓ Nút làm mới: xoá đệm trước khi dựng lại · nằm trong PageHeader · ${trang.length} trang bảng điều khiển đều có tiêu đề trang`);
}

if (process.argv[1] && /refresh-button\.test\.ts$/.test(process.argv[1])) {
  void testRefreshButton();
}
