"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmCodeWeights } from "@/lib/actions/payroll-code";

/**
 * Lối ra CÓ NGƯỜI DUYỆT cho khoản chờ "thiếu một phần trọng số" (`lib/constants/payroll-code.ts`).
 * Bắt ghi lý do: lời xác nhận nói "số 0 là thật / phần chưa gán không thuộc ai trong nhóm" — một câu
 * khẳng định về tiền, nên phải có người đứng tên. Action `revalidatePath` trang này.
 */
export function ConfirmWeightsButton({ monthKey, productId, code }: { monthKey: string; productId: string; code: string }) {
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
      <Input className="h-8 w-[360px] max-w-full" value={lyDo} onChange={(e) => setLyDo(e.target.value)} placeholder="Vì sao số đo hiện có là đủ (vd: B nghỉ chạy QC cả tháng)" />
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await confirmCodeWeights({ monthKey, productId, reason: lyDo });
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
