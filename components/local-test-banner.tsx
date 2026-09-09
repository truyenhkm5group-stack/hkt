import { FlaskConical } from "lucide-react";
import { LOCAL_TEST_NOTICE, isLocalTestMode } from "@/lib/local-mode";

/**
 * Dải cảnh báo của BẢN TEST TRÊN MÁY.
 *
 * Bản test dựng bằng `npm run local` trông y hệt ERP thật — cùng giao diện, cùng báo cáo, chỉ khác
 * ở chỗ số liệu là dữ liệu giả. Rủi ro lớn nhất của cách làm "thử trên máy trước" là đọc nhầm số
 * của bản test rồi ra quyết định thật, nên bản test phải tự khai báo trên MỌI trang.
 *
 * Chỉ hiện khi `ERP_LOCAL_TEST=1` — cờ do `npm run local:setup` ghi vào `.env.local`. Máy chủ thật
 * không đặt cờ này nên không bao giờ hiện dải cảnh báo.
 */
export function LocalTestBanner() {
  if (!isLocalTestMode()) return null;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-amber-400 px-3 py-1.5 text-center text-xs font-semibold text-amber-950 dark:bg-amber-500 dark:text-amber-950">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>{LOCAL_TEST_NOTICE}</span>
    </div>
  );
}
