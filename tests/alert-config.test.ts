import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_ALERT_CONFIG } from "@/lib/constants/alerts";

/**
 * CẤU HÌNH CẢNH BÁO — CÁI NÚT PHẢI CÓ TÁC DỤNG.
 *
 * Lỗi mà bài kiểm thử này chặn, và nó đã từng xảy ra thật:
 *
 * `z.object()` CẮT BỎ khoá không được khai báo. Một cờ bật/tắt có mặt trong kiểu dữ liệu và có ô
 * tích trên giao diện, nhưng thiếu trong lược đồ kiểm tra ở máy chủ, sẽ biến mất mỗi lần chủ shop
 * bấm Lưu. Sau đó `loadAlertConfig` trộn lại với giá trị mặc định, nên cảnh báo ÂM THẦM BẬT LẠI như
 * chưa từng bị tắt.
 *
 * Không có thông báo lỗi nào. Người dùng chỉ thấy mình tắt rồi mà nó vẫn kêu — và sẽ kết luận là
 * phần mềm hỏng, đúng như vậy.
 *
 * Kiểm ở mức mã nguồn vì đây là ràng buộc giữa BA nơi phải khớp nhau: kiểu dữ liệu, lược đồ zod,
 * và giao diện.
 */
export function testAlertConfig() {
  const flags = Object.keys(DEFAULT_ALERT_CONFIG.enabled);
  assert.ok(flags.length >= 12, `phải có đủ cờ bật/tắt, đang có ${flags.length}`);

  // ───────── 1. Lược đồ máy chủ phải nhận MỌI cờ ─────────
  const action = readFileSync("lib/actions/alerts.ts", "utf8");
  const enabledBlock = action.slice(action.indexOf("enabled: z.object("), action.indexOf("});", action.indexOf("enabled: z.object(")));
  for (const flag of flags) {
    assert.ok(new RegExp(`\\b${flag}\\s*:`).test(enabledBlock), `cờ "${flag}" thiếu trong lược đồ zod — bấm Lưu là nó biến mất, rồi cảnh báo tự bật lại`);
  }

  // Ngưỡng cũng vậy: thiếu trong lược đồ thì chỉnh xong lưu là quay về mặc định.
  for (const key of ["pendingHours", "staleDays", "lookbackDays", "returnInspectionDays"]) {
    assert.ok(new RegExp(`\\b${key}\\s*:`).test(action), `ngưỡng "${key}" thiếu trong lược đồ zod — chỉnh xong sẽ không lưu được`);
  }

  // ───────── 2. Giao diện phải có ô tích cho MỌI cờ ─────────
  // Cờ không có ô tích thì chủ shop không tắt được, dù máy chủ có nhận.
  const form = readFileSync("app/(dashboard)/alerts/alerts-actions.tsx", "utf8");
  for (const flag of flags) {
    assert.ok(form.includes(`form.enabled.${flag}`), `cờ "${flag}" không có ô tích trên giao diện — chủ shop không tắt được`);
  }

  console.log(`✓ Cấu hình cảnh báo: ${flags.length} cờ bật/tắt đều có mặt ở CẢ ba nơi (kiểu dữ liệu · lược đồ máy chủ · giao diện) — nút tắt thật sự có tác dụng`);
}
