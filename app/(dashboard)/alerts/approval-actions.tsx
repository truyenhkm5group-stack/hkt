"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decideApproval } from "@/lib/actions/approvals";

/**
 * Duyệt / từ chối một yêu cầu.
 *
 * TỪ CHỐI BẮT BUỘC NÊU LÝ DO, và ô lý do hiện ngay tại chỗ thay vì mở hộp thoại: người xin đang chờ,
 * và một lời từ chối không có lý do buộc họ phải đi hỏi lại — tức việc đứng thêm một vòng nữa.
 */
export function ApprovalDecisionButtons({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [dangTuChoi, setDangTuChoi] = useState(false);
  const [lyDo, setLyDo] = useState("");
  const router = useRouter();

  const quyet = (dongY: boolean) =>
    startTransition(async () => {
      const r = await decideApproval(id, dongY, dongY ? undefined : lyDo);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(dongY ? "Đã duyệt" : "Đã từ chối");
        setDangTuChoi(false);
        setLyDo("");
        router.refresh();
      }
    });

  if (dangTuChoi) {
    return (
      <div className="flex shrink-0 items-center gap-2">
        <Input
          autoFocus
          value={lyDo}
          onChange={(e) => setLyDo(e.target.value)}
          placeholder="Vì sao không duyệt?"
          className="h-8 w-56 text-xs"
        />
        <Button size="sm" variant="destructive" className="h-8" disabled={pending || !lyDo.trim()} onClick={() => quyet(false)}>
          Từ chối
        </Button>
        <Button size="sm" variant="ghost" className="h-8" disabled={pending} onClick={() => setDangTuChoi(false)}>
          Thôi
        </Button>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Button size="sm" className="h-8" disabled={pending} onClick={() => quyet(true)}>
        Duyệt
      </Button>
      <Button size="sm" variant="outline" className="h-8" disabled={pending} onClick={() => setDangTuChoi(true)}>
        Từ chối
      </Button>
    </div>
  );
}
