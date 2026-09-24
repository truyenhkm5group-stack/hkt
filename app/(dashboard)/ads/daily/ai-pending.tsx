"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

/**
 * Lịch làm mới để nhặt đoạn diễn giải AI đang viết ở nền (xem `AiExplanation` trong findings.tsx).
 *
 * DỪNG TRƯỚC 20 GIÂY: bộ khử trùng lặp của `memo` (`lib/cache.ts`, `TRAN_CHO_CHUNG`) coi một lượt
 * tính quá 20 giây là đã bị bỏ rơi. Làm mới sau mốc đó mà mô hình vẫn chưa trả lời thì trang sẽ
 * khởi động một lượt gọi mô hình THỨ HAI — trả tiền hai lần cho cùng một đoạn văn. Hết lịch thì in
 * một câu, không tự làm mới nữa.
 */
const LICH_LAM_MOI_MS = [6_000, 12_000, 18_000];

export function AiPendingRefresh() {
  const router = useRouter();
  const [hetLich, setHetLich] = useState(false);

  /*
    Hẹn MỘT LẦN khi thành phần xuất hiện. `router.refresh()` giữ nguyên thành phần phía client nếu
    nó vẫn đứng đúng chỗ, nên lịch không bị đặt lại sau mỗi lượt làm mới; đoạn diễn giải về tới nơi
    thì thành phần này bị thay thế và các hẹn giờ còn lại tự huỷ.
  */
  useEffect(() => {
    const timers = LICH_LAM_MOI_MS.map((ms, i) =>
      setTimeout(() => {
        router.refresh();
        if (i === LICH_LAM_MOI_MS.length - 1) timers.push(setTimeout(() => setHetLich(true), 2_000));
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [router]);

  return (
    <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Sparkles className="size-3.5" />
      {hetLich ? "Phần diễn giải bằng AI vẫn đang viết — tải lại trang sau ít phút để xem." : "Phần diễn giải bằng AI đang được viết — sẽ tự hiện trong giây lát, số liệu phía trên không phụ thuộc vào nó."}
    </p>
  );
}
