"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { refreshReportData } from "@/lib/actions/refresh";
import { vnClock } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ───────────── NÚT LÀM MỚI SỐ LIỆU CỦA TRANG ĐANG MỞ ─────────────
 *
 * Thay cho F5. Bấm F5 là dựng lại toàn bộ ứng dụng — mất vị trí cuộn, đóng mọi hộp thoại, tải lại
 * khung sườn và thanh bên — trong khi thứ duy nhất cần mới là mấy con số. Nút này chỉ lấy lại phần
 * do máy chủ dựng cho ĐÚNG địa chỉ đang mở: URL, bộ lọc, kỳ báo cáo, trang, thứ tự sắp xếp và vị
 * trí cuộn đều giữ nguyên.
 *
 * Hai bước, đúng thứ tự, và thứ tự là phần quan trọng:
 *   1. `refreshReportData()` xoá đệm báo cáo trên máy chủ (`lib/actions/refresh.ts` giải thích vì
 *      sao xoá hẳn thay vì đánh dấu cũ). Bỏ bước này thì truy vấn trúng đệm 60–120 giây và trả về
 *      ĐÚNG con số cũ — nút chạy đủ mọi thứ trừ việc làm mới.
 *   2. `router.refresh()` trong một `useNavTransition()`, nên trang dùng LẠI y nguyên bộ hiển thị
 *      trạng thái chờ đã có sẵn: thanh tiến trình trên đỉnh, nhãn "Đang cập nhật báo cáo…" cạnh
 *      tiêu đề, và số cũ mờ đi nhưng VẪN HIỆN thay vì nháy về màn hình trắng.
 *
 * Dưới 1024px chỉ còn biểu tượng: trang như Vận đơn đã có sẵn hai nút dài, thêm một nhãn nữa là
 * chính TIÊU ĐỀ trang bị cắt cụt ("Vận đơn …") — đo được ở bề rộng 986px. Biểu tượng mũi tên xoay
 * là quy ước ai cũng đọc được, và dấu chỉ dẫn vẫn nói đủ câu khi rê chuột vào.
 *
 * Mốc "số đang hiện tải lúc nào" đi kèm trong dấu chỉ dẫn: nếu không nói ra, người dùng bấm xong
 * thấy các con số y hệt (vì dữ liệu THẬT SỰ không đổi) và không có cách nào phân biệt với "nút
 * hỏng". Một mốc giờ nhích lên là bằng chứng rẻ nhất cho việc lượt làm mới đã chạy thật.
 */
export function RefreshButton({
  label = "Làm mới",
  className,
  variant = "outline",
  size = "sm",
}: {
  label?: string | null;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const router = useRouter();
  const [dangDungLai, startTransition] = useNavTransition();
  const [dangXoaDem, setDangXoaDem] = React.useState(false);
  const [taiLuc, setTaiLuc] = React.useState<number | null>(null);
  const dangCho = dangXoaDem || dangDungLai;

  /*
    Mốc tải đặt trong effect chứ không ở giá trị khởi tạo: máy chủ dựng HTML ở một thời điểm, trình
    duyệt hydrate ở một thời điểm khác, gán thẳng `Date.now()` là hai bên ra hai chuỗi khác nhau.
  */
  React.useEffect(() => setTaiLuc(Date.now()), []);

  /*
    `dangDungLai` chuyển true → false nghĩa là máy chủ đã dựng xong và số mới đã lên màn hình. Đó là
    mốc đúng để cập nhật nhãn giờ — không phải lúc bấm, vì lúc bấm số vẫn là số cũ.
  */
  const daTungChay = React.useRef(false);
  React.useEffect(() => {
    if (dangDungLai) {
      daTungChay.current = true;
      return;
    }
    if (!daTungChay.current) return;
    daTungChay.current = false;
    setTaiLuc(Date.now());
  }, [dangDungLai]);

  const lamMoi = () => {
    if (dangCho) return;
    setDangXoaDem(true);
    void (async () => {
      try {
        const ket = await refreshReportData();
        if ("error" in ket) {
          toast.error(ket.error);
          return;
        }
        startTransition(() => router.refresh());
      } catch {
        // Mất mạng / máy chủ đang khởi động lại. Nói ra thay vì để nút quay rồi im lặng trở về cũ.
        toast.error("Không làm mới được — kiểm tra kết nối rồi thử lại.");
      } finally {
        setDangXoaDem(false);
      }
    })();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant={variant} size={size} className={cn("shrink-0", className)} onClick={lamMoi} disabled={dangCho} aria-label="Làm mới số liệu">
          <RefreshCw className={cn("size-4", dangCho && "animate-spin")} aria-hidden />
          {label ? <span className="hidden lg:inline">{label}</span> : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px]">
        Tải lại số liệu của trang này — giữ nguyên bộ lọc, kỳ báo cáo và vị trí đang xem, không tải lại cả trang.
        {taiLuc ? <span className="mt-1 block opacity-80">Số đang hiện tải lúc {vnClock(new Date(taiLuc))}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}
