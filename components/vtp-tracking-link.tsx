"use client";

import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TRA CỨU TRÊN VIETTELPOST NGAY TẠI DÒNG, KHÔNG PHẢI MỞ TỪNG VẬN ĐƠN ═══════════
 *
 * Nút "Tra cứu trên Viettel Post" trước đây chỉ có ở TRANG CHI TIẾT. Người trực đơn muốn xem hành
 * trình thật của mười kiện thì phải mở mười trang ERP rồi bấm mười lần — trong khi việc họ cần chỉ
 * là mở trang ĐVVC. Biểu tượng này đưa đúng hành động đó ra danh sách, nằm ngay cạnh mã.
 *
 * ─── BỐN LUẬT ───
 *
 *  1. **Địa chỉ dựng ở MỘT chỗ**: `getViettelPostTrackingUrl` (lib/constants/viettelpost.ts) — cùng
 *     hàm mà trang chi tiết dùng. Không có chuỗi địa chỉ thứ hai trong kho mã.
 *  2. **Chưa có mã Viettel Post thì KHÔNG vẽ gì.** Hàm trả `null` và ở đây trả `null` luôn, không
 *     vẽ nút mờ: một biểu tượng bấm được dẫn tới trang "không tìm thấy" là lời hứa sai. `code` phải
 *     là `shipments.vtp_order_number`, KHÔNG phải `tracking_code` (mã Pancake, thường khác).
 *  3. **Bấm biểu tượng KHÔNG được kích hoạt dòng.** Bảng vận đơn cho bấm cả dòng để mở chi tiết
 *     ERP; chặn nổi bọt ngay tại đây thay vì bắt từng nơi gọi nhớ bọc thêm một lớp. `DataTable` đã
 *     bỏ qua click phát ra từ `a`, nhưng một hàng đợi khác có thể không — lá chắn đặt ở nơi dùng
 *     lại được.
 *  4. **Mở tab mới, không cướp trang đang làm việc.** `rel="noopener noreferrer"` để trang ĐVVC
 *     không cầm `window.opener` của ERP.
 */
export function VtpTrackingLink({ code, className }: { code: string | null | undefined; className?: string }) {
  const url = getViettelPostTrackingUrl(code);
  if (!url) return null;
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className={cn(
        // Cùng ngôn ngữ thị giác với nút sao chép đứng cạnh: mờ vừa đủ để không tranh chỗ với chính
        // mã vận đơn, rõ hẳn khi rê chuột hoặc khi đi bằng bàn phím.
        "size-7 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100",
        className,
      )}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Tra cứu vận đơn trên ViettelPost"
        title="Tra cứu trên ViettelPost"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="size-3.5" />
      </a>
    </Button>
  );
}
