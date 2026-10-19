"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmCodeWeights, revokeCodeWeights } from "@/lib/actions/payroll-code";

/**
 * Lối ra CÓ NGƯỜI DUYỆT cho khoản chờ "thiếu một phần trọng số" (`lib/constants/payroll-code.ts`).
 * Bắt ghi lý do: lời xác nhận nói "số 0 là thật / phần chưa gán không thuộc ai trong nhóm" — một câu
 * khẳng định về tiền, nên phải có người đứng tên. Nó chỉ áp cho ĐÚNG số đo đang hiện (dấu vân tay);
 * số đo đổi thì khoản quay lại chờ. Người thứ hai duyệt khi nhóm Lương bật cưỡng chế duyệt.
 * Action `revalidatePath` trang này.
 */
export function ConfirmWeightsButton({ monthKey, productId, code, fingerprints }: { monthKey: string; productId: string; code: string; fingerprints: string[] }) {
  const [mo, setMo] = useState(false);
  const [lyDo, setLyDo] = useState("");
  const [pending, start] = useTransition();
  if (!mo) {
    return (
      <Button size="sm" variant="outline" className="mt-1" onClick={() => setMo(true)}>
        Xác nhận trọng số mã {code} cho tháng {monthKey}
      </Button>
    );
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <p className="w-full text-xs text-muted-foreground">Xác nhận áp cho ĐÚNG số đo đang hiện; số đo đổi (ghép chiến dịch, đơn chốt kết quả) thì phải xác nhận lại — nên làm ngay trước khi chốt kỳ.</p>
      <Input className="h-8 w-[360px] max-w-full" value={lyDo} onChange={(e) => setLyDo(e.target.value)} placeholder="Vì sao số đo hiện có là đủ (vd: B nghỉ chạy QC cả tháng)" />
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await confirmCodeWeights({ monthKey, productId, fingerprints, reason: lyDo });
            if ("error" in r) toast.error(r.error);
            else toast.success("Đã xác nhận trọng số");
          })
        }
      >
        Xác nhận
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setMo(false)}>
        Thôi
      </Button>
    </div>
  );
}

/** Huỷ một lời xác nhận trọng số — có lý do, cùng đường duyệt. */
export function RevokeConfirmationButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-1 h-6 px-2 text-xs"
      disabled={pending}
      onClick={() => {
        const ly = window.prompt("Lý do huỷ lời xác nhận (ít nhất 10 ký tự):");
        if (!ly) return;
        start(async () => {
          const r = await revokeCodeWeights({ id, reason: ly });
          if ("error" in r) toast.error(r.error);
          else toast.success("Đã huỷ lời xác nhận");
        });
      }}
    >
      Huỷ xác nhận
    </Button>
  );
}
