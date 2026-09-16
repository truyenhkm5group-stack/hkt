"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * TỰ LÀM MỚI HÀNG ĐỢI — để nhân viên không phải bấm F5 mới thấy khách vừa nhắn.
 *
 * `router.refresh()` chạy lại Server Component và thay dữ liệu tại chỗ: KHÔNG tải lại trang, nên
 * chữ đang gõ dở trong ô soạn không bị mất. Đây là lý do dùng nó thay vì `location.reload()` —
 * một người đang sửa câu giữa chừng mà màn hình tự nạp lại sẽ mất công gõ, và lần sau họ sẽ tắt
 * tính năng này đi.
 *
 * DỪNG KHI TAB ẨN: làm mới một tab không ai nhìn chỉ tốn truy vấn. Hiện lại thì làm mới ngay một
 * lần, vì lúc ấy mới là lúc người ta cần thấy số mới nhất.
 *
 * Không dùng websocket: hàng đợi này vài chục dòng và người trực đọc theo nhịp phút. Một đường
 * kết nối giữ mãi để tiết kiệm mươi giây là đổi một thứ phức tạp lấy một thứ không ai cảm nhận được.
 */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  const [lanCuoi, setLanCuoi] = useState<Date | null>(null);

  useEffect(() => {
    const lam = () => {
      router.refresh();
      setLanCuoi(new Date());
    };
    const id = setInterval(() => {
      if (document.visibilityState === "visible") lam();
    }, Math.max(5, seconds) * 1000);
    const khiHien = () => {
      if (document.visibilityState === "visible") lam();
    };
    document.addEventListener("visibilitychange", khiHien);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", khiHien);
    };
  }, [router, seconds]);

  return (
    <span className="text-[11px] text-muted-foreground">
      tự làm mới mỗi {seconds}s{lanCuoi ? ` · lần cuối ${lanCuoi.toLocaleTimeString("vi-VN")}` : ""}
    </span>
  );
}
