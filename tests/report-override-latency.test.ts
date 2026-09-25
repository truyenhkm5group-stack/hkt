import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ═══════════ Ô ĐẶT SỐ DỰ TÍNH KHÔNG ĐƯỢC DỰNG TRANG HAI LẦN ═══════════
 *
 * Chủ shop báo (25/09/2026): "phần đặt số dự tính đang hơi lag". Nguyên nhân: server action đã gọi
 * `revalidatePath("/reports")` — trên Next 15 lượt gọi đó TRẢ LUÔN giao diện mới — mà ô nhập còn gọi
 * thêm `router.refresh()`, tức một lượt dựng NGUỘI thứ hai của trang Báo cáo lợi nhuận, và nút Lưu
 * quay suốt cả hai lượt.
 *
 * Khoá ba điều ở mức mã nguồn:
 *  1. Các ô này không gọi `router.refresh()` nữa.
 *  2. ĐIỀU KIỆN để bỏ nó là an toàn vẫn còn: action của chúng vẫn `revalidatePath("/reports")`.
 *     Ai gỡ dòng đó ở action thì bài này đỏ — lúc đó trang sẽ không còn tự cập nhật.
 *  3. Popover GTC giữ nội dung SỐNG khi đóng (`forceMount` tới cả Portal) — lượt lưu đang chạy nằm
 *     trong nó; gỡ ra thì vòng quay trên cây bút không bao giờ tắt.
 */
const doc = (p: string) => readFileSync(p, "utf8");

export function testReportOverrideLatency() {
  const o = [
    "app/(dashboard)/reports/assumptions-form.tsx",
    "app/(dashboard)/reports/estimated-cost-control.tsx",
  ];
  for (const f of o) {
    const src = doc(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/router\.refresh\s*\(/.test(src), `${f}: gọi router.refresh() sau server action đã revalidatePath — dựng trang Báo cáo hai lần`);
  }
  for (const f of ["lib/actions/delivery-rate-override.ts", "lib/actions/estimated-cost.ts", "lib/actions/report-settings.ts"]) {
    assert.ok(doc(f).includes('revalidatePath("/reports")'), `${f}: thiếu revalidatePath("/reports") — ô nhập đã bỏ router.refresh() nên trang sẽ KHÔNG tự cập nhật`);
  }
  const pop = doc("components/ui/popover.tsx");
  assert.ok(/<PopoverPrimitive\.Portal forceMount=\{forceMount\}>/.test(pop), "PopoverContent phải chuyển forceMount xuống Portal");
  assert.ok(/<ReturnRateOverride \{\.\.\.props\} onStart=/.test(doc("app/(dashboard)/reports/estimated-cost-control.tsx")), "popover GTC phải đóng ngay khi bấm Lưu");
  assert.ok(/forceMount>\s*\n\s*<ReturnRateOverride/.test(doc("app/(dashboard)/reports/estimated-cost-control.tsx")), "popover GTC phải giữ nội dung sống khi đóng");
  console.log("✓ Ô đặt số dự tính: một lượt dựng trang (không router.refresh thừa) · action vẫn revalidatePath · popover đóng ngay, nội dung sống tới khi lưu xong");
}
