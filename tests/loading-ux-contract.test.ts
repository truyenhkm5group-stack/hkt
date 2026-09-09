import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * ───────────── HỢP ĐỒNG TRẢI NGHIỆM CHỜ ─────────────
 *
 * Lời phàn nàn gốc của chủ shop không phải "chậm" mà là "không biết nó đang chạy hay đã treo".
 * Cái chữa nó là một bộ quy tắc giao diện — và quy tắc giao diện thì rất dễ bị gỡ mất trong một
 * lần sửa sau này mà không ai nhận ra, vì gỡ xong màn hình vẫn hiển thị đúng số.
 *
 * Bài kiểm thử này khoá chúng ở MỨC MÃ NGUỒN (cùng cách `tests/ui-consistency.test.ts` làm). Nó
 * KHÔNG thay được việc bấm thử bằng mắt; nó chỉ bảo đảm phần dây nối không bị tháo.
 */

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

const read = (p: string) => readFileSync(p, "utf8");

/** Trang nặng: có kỳ báo cáo hoặc bảng dữ liệu ⇒ mở lần đầu phải có khung xương riêng. */
const ROUTES_CAN_KHUNG_XUONG = [
  "app/(dashboard)/orders",
  "app/(dashboard)/shipments",
  "app/(dashboard)/products",
  "app/(dashboard)/products/performance",
  "app/(dashboard)/inventory",
  "app/(dashboard)/inventory/planning",
  "app/(dashboard)/reports",
  "app/(dashboard)/reports/returns",
  "app/(dashboard)/ads",
  "app/(dashboard)/cod",
  "app/(dashboard)/expenses",
  "app/(dashboard)/payroll",
  "app/(dashboard)/alerts",
  "app/(dashboard)/data-quality",
  "app/(dashboard)/customers",
  "app/(dashboard)/landing",
  "app/(dashboard)/cs",
  "app/(dashboard)/outreach",
  "app/(dashboard)/returns",
  "app/(dashboard)/audit",
  "app/(dashboard)/integrations",
];

export function testLoadingUxContract() {
  // ───────── 1. MỞ TRANG LẦN ĐẦU: khung xương đúng hình dạng trang ─────────
  for (const route of ROUTES_CAN_KHUNG_XUONG) {
    const file = path.join(route, "loading.tsx");
    assert.ok(existsSync(file), `${route} thiếu loading.tsx — mở trang lần đầu sẽ trắng màn hình`);
    const src = read(file);
    assert.match(src, /Skeleton|skeletons/i, `${file} phải dựng khung xương, không được trả về null`);
  }
  assert.ok(existsSync("app/(dashboard)/loading.tsx"), "nhóm bảng điều khiển phải có khung xương mặc định");

  // ───────── 2. ĐỔI TRANG: có thanh tiến trình ─────────
  const layout = read("app/(dashboard)/layout.tsx");
  assert.match(layout, /NavProgressProvider/, "layout phải bọc NavProgressProvider — nếu không, không chỗ nào biết đang điều hướng");
  assert.match(layout, /StaleWhileRefreshing/, "layout phải bọc StaleWhileRefreshing — giữ số cũ trong lúc chờ số mới");

  const nav = read("components/nav-progress.tsx");
  assert.match(nav, /useLinkStatus/, "mục menu phải dùng useLinkStatus để hiện chấm chờ đúng mục vừa bấm");
  assert.match(nav, /position:\s*fixed|fixed inset-x-0 top-0/, "thanh tiến trình phải cố định trên đỉnh trang");

  // ───────── 3. PHẢN HỒI NHANH: KHÔNG được nháy spinner ─────────
  const nguong = /const SHOW_AFTER_MS = (\d+)/.exec(nav);
  assert.ok(nguong, "phải có ngưỡng thời gian trước khi hiện trạng thái chờ");
  const ms = Number(nguong[1]);
  assert.ok(ms >= 150 && ms <= 250, `ngưỡng hiện trạng thái chờ nên trong khoảng 150–250 ms, đang là ${ms}`);
  // Cả ba thứ hiện ra khi chờ đều phải đi qua ngưỡng đó, không cái nào hiện ngay lập tức.
  for (const thanhPhan of ["NavProgressBar", "RefreshingBadge", "StaleWhileRefreshing"]) {
    const than = nav.slice(nav.indexOf(`function ${thanhPhan}`));
    assert.match(than.slice(0, 900), /SHOW_AFTER_MS/, `${thanhPhan} phải đợi qua ngưỡng, nếu không phản hồi nhanh sẽ nháy`);
  }

  // ───────── 4. ĐỔI KỲ / BỘ LỌC: giữ số cũ, và yêu cầu MỚI NHẤT thắng ─────────
  const toolbar = read("components/data-table/toolbar.tsx");
  assert.match(toolbar, /useNavTransition/, "thanh lọc phải dùng useNavTransition");
  // `startTransition` là thứ khiến React giữ cây cũ và luôn lấy kết quả của lần điều hướng mới nhất.
  assert.match(toolbar, /startTransition/, "nuqs phải nhận startTransition — nếu không, màn hình đứng im và yêu cầu cũ có thể ghi đè yêu cầu mới");
  assert.doesNotMatch(
    toolbar,
    /useTransition\s*\}\s*from\s*"react"/,
    "không được dùng React.useTransition trần trong thanh lọc: thanh tiến trình chung sẽ không biết có việc đang chạy",
  );

  // Ô ngày tuỳ chọn: phải chống rung, nếu không mỗi ký tự gõ là một lần dựng lại trang.
  const periodFilter = toolbar.slice(toolbar.indexOf("export function PeriodFilter"));
  assert.match(periodFilter, /setTimeout\(/, "ô ngày tuỳ chọn phải chống rung trước khi gửi lên máy chủ");
  const treHoan = /,\s*(\d{3,4})\);/.exec(periodFilter);
  assert.ok(treHoan && Number(treHoan[1]) >= 300, `độ trễ chống rung phải từ 300 ms trở lên, đang là ${treHoan?.[1] ?? "không có"}`);
  assert.match(periodFilter, /d\{4\}/, "chỉ gửi khi ngày đã hợp lệ (kiểm định dạng YYYY-MM-DD)");

  // ───────── 5. MỌI CHỖ GÂY ĐIỀU HƯỚNG ĐỀU PHẢI BÁO LÊN THANH TIẾN TRÌNH ─────────
  // Component nào ghi lên URL với `shallow: false` (đi vòng lên máy chủ) mà lại dùng
  // React.useTransition trần thì người dùng bấm xong sẽ không thấy dấu hiệu gì.
  //
  // NGOẠI LỆ CÓ CHỦ Ý: ba tệp dưới đây dùng transition cho một thao tác GHI hoặc một lần TẢI DỮ
  // LIỆU, không phải cho điều hướng — `router.push` chỉ chạy SAU khi việc đó xong. Đẩy chúng lên
  // thanh tiến trình chung sẽ khiến thanh này chạy mỗi lần lưu biểu mẫu, làm loãng đúng tín hiệu
  // mà nó sinh ra để mang: "đang mở trang khác". Thêm tệp vào danh sách này phải là quyết định
  // có ý thức, kèm lý do.
  const NGOAI_LE = new Map<string, string>([
    ["app/(dashboard)/inventory/planning/orders/production-editor.tsx", "transition bọc thao tác LƯU bảng sản xuất"],
    ["app/(dashboard)/inventory/planning/orders/[id]/order-actions.tsx", "transition bọc server action đổi trạng thái lệnh sản xuất"],
    ["components/global-search.tsx", "transition bọc lần TẢI kết quả tìm kiếm, không bọc điều hướng"],
  ]);
  const clientFiles = [...walk("app/(dashboard)", ".tsx"), ...walk("components", ".tsx")];
  const viPham: string[] = [];
  for (const file of clientFiles) {
    const src = read(file);
    if (!src.includes('"use client"')) continue;
    const duongDan = file.split(path.sep).join("/");
    if (NGOAI_LE.has(duongDan)) continue;
    const dieuHuong = /shallow:\s*false/.test(src) || /router\.push\(/.test(src);
    const transitionTran = /import\s*\{[^}]*useTransition[^}]*\}\s*from\s*"react"/.test(src);
    if (dieuHuong && transitionTran) viPham.push(duongDan);
  }
  // Ngoại lệ phải còn tồn tại thật — tệp bị đổi tên mà danh sách còn nguyên là danh sách nói dối.
  for (const [file, lyDo] of NGOAI_LE) assert.ok(existsSync(file), `ngoại lệ trỏ tới tệp không còn tồn tại: ${file} (${lyDo})`);
  assert.deepEqual(viPham, [], `các tệp sau gây điều hướng nhưng không báo lên thanh tiến trình chung: ${viPham.join(", ")}`);

  // ───────── 6. BA TRẠNG THÁI PHẢI PHÂN BIỆT ĐƯỢC ─────────
  assert.ok(existsSync("app/(dashboard)/error.tsx"), "phải có màn hình lỗi riêng");
  const err = read("app/(dashboard)/error.tsx");
  assert.match(err, /reset/, "màn hình lỗi phải có nút thử lại — khác hẳn màn hình trống");
  const uiBits = read("components/ui-bits.tsx");
  assert.match(uiBits, /export function EmptyState/, "phải có EmptyState riêng cho trạng thái TRỐNG");
  const skeletons = read("components/skeletons.tsx");
  for (const shape of ["TablePageSkeleton", "ReportPageSkeleton", "SectionsPageSkeleton"]) {
    assert.match(skeletons, new RegExp(`export function ${shape}`), `thiếu khung xương ${shape}`);
  }

  // ───────── 7. KHÔNG NHÁY SỐ 0 ─────────
  // Giữ số cũ nghĩa là KHÔNG được thay nội dung bằng khung xương khi chỉ đổi tham số URL.
  // `StaleWhileRefreshing` chỉ làm mờ, không được render fallback thay cho children.
  const stale = nav.slice(nav.indexOf("export function StaleWhileRefreshing"));
  assert.match(stale.slice(0, 1200), /opacity/, "giữ số cũ phải làm MỜ, không được thay bằng khung xương");
  assert.doesNotMatch(stale.slice(0, 1200), /return\s*<Skeleton/, "không được thay nội dung cũ bằng khung xương khi đổi kỳ");

  console.log(
    `✓ Hợp đồng trải nghiệm chờ: ${ROUTES_CAN_KHUNG_XUONG.length} trang có khung xương riêng · thanh tiến trình + giữ số cũ mắc đúng chỗ · ngưỡng ${ms} ms chống nháy · ô ngày chống rung · 0 chỗ điều hướng bị bỏ sót · trạng thái tải/trống/lỗi tách bạch`,
  );
}
