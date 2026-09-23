"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { unstickResolvedHandoffs } from "@/lib/actions/sales-copilot";

/**
 * ═══════════ GỠ KẸT HÀNG LOẠT — MỘT NÚT, VÀ NÓ NÓI RÕ NÓ KHÔNG ĐỤNG GÌ ═══════════
 *
 * Số hiện trên nút là số hội thoại mà cớ máy rút lui đã CHỨNG MINH được là hết (hôm nay: bảng số
 * đo đã khai cho cả 7 mã, nên "ERP chưa có bảng số đo" không còn đúng với cuộc nào).
 *
 * Câu thứ hai quan trọng ngang cái nút: một nút hàng loạt mà không nói nó bỏ qua cái gì thì người
 * bấm phải đoán, và người ta luôn đoán theo hướng "chắc nó dọn hết". Ở đây "dọn hết" nghĩa là ném
 * máy trở lại giữa những cuộc khách đang khiếu nại.
 *
 * Con số ở nút là ẢNH CHỤP LÚC DỰNG TRANG; máy chủ đếm lại lúc bấm. Hai con số lệch nhau là bình
 * thường (bộ nạp chạy mỗi 45 giây), nên kết quả trả về mới là con số thật và nó được in ra.
 */
export function UnstickAll({ soCuoc }: { soCuoc: number }) {
  const [pending, start] = useTransition();

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const kq = await unstickResolvedHandoffs();
              if ("error" in kq) {
                toast.error(kq.error);
                return;
              }
              toast.success(
                kq.goDuoc === 0
                  ? "Không còn cuộc nào thuộc nhóm cớ đã hết"
                  : `Đã gỡ ${kq.goDuoc} cuộc và xếp việc soạn lại · bỏ qua ${kq.boQua} cuộc cớ vẫn đúng hoặc chưa chứng minh`,
              );
            })
          }
        >
          {pending ? "Đang gỡ…" : `Cho máy soạn lại ${soCuoc} cuộc đã hết cớ`}
        </Button>
        <span className="text-xs text-muted-foreground">
          Chỉ những cuộc máy rút vì <strong>ERP chưa có bảng số đo</strong> — cớ ấy nay đã hết.
        </span>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        KHÔNG đụng tới cuộc máy rút vì khách khiếu nại, mặc cả giá, hỏi việc sau bán, hay hỏi ba lần không ai đáp — những cớ
        đó vẫn đúng. Cũng không đụng nhóm “chưa chứng minh được”: gỡ chúng là một phỏng đoán mặc áo thao tác.
      </p>
    </div>
  );
}
