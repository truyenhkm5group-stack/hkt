"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setTechRunVerdictAction } from "@/lib/actions/tech";
import { DO_DAI_TOI_THIEU_GHI_CHU_LOI, REVIEW_VERDICT_LABEL, type ReviewVerdict } from "@/lib/constants/agent-clean-streak";

/**
 * Ghi phán quyết review cho MỘT lượt chạy — mắt xích nối lượt review của người với chuỗi "lượt
 * chạy sạch" trên `/tech/agents`.
 *
 * Hai nút, không phải một ô chọn: "Sạch" là một khẳng định cần một cú bấm có chủ đích, và "Có
 * lỗi" đòi nói lỗi gì trước khi gửi được — một phán quyết không kèm lý do thì không ai học được gì.
 *
 * Lượt SỬA theo review vẫn chấm được (để đọc lại), nhưng màn hình nói rõ nó KHÔNG cộng vào chuỗi.
 */
export function RunVerdict({
  runId,
  taskId,
  verdict,
  note,
  laLuotSua,
}: {
  runId: string;
  taskId: string;
  verdict: ReviewVerdict | null;
  note: string;
  laLuotSua: boolean;
}) {
  const [pending, start] = useTransition();
  const [moLoi, setMoLoi] = useState(false);
  const [ghiChu, setGhiChu] = useState("");
  const [doi, setDoi] = useState(false);
  const router = useRouter();

  const gui = (v: ReviewVerdict, n?: string) =>
    start(async () => {
      const res = await setTechRunVerdictAction({ runId, verdict: v, note: n, taskId });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(`Đã ghi: ${REVIEW_VERDICT_LABEL[v]}`);
      setMoLoi(false);
      setDoi(false);
      setGhiChu("");
      router.refresh();
    });

  const chuThichSua = laLuotSua ? (
    <span className="text-[11px] text-muted-foreground" title="Lượt chạy lại theo phản hồi review làm đúng điều vừa được chỉ ra — đó là làm theo chỉ dẫn, không phải giao được việc sạch. Tính nó thì chuỗi thổi phồng được bằng cách chạy lại.">
      · lượt sửa — không tính vào chuỗi sạch
    </span>
  ) : null;

  if (verdict && !doi) {
    return (
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">Review:</span>
        <span className={verdict === "SACH" ? "font-medium" : "font-medium text-destructive"}>{REVIEW_VERDICT_LABEL[verdict]}</span>
        {note ? <span className="text-muted-foreground">— {note}</span> : null}
        {chuThichSua}
        <button type="button" className="text-muted-foreground underline underline-offset-2" onClick={() => setDoi(true)}>
          đổi
        </button>
      </div>
    );
  }

  const du = ghiChu.trim().length >= DO_DAI_TOI_THIEU_GHI_CHU_LOI;
  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="text-muted-foreground">{verdict ? "Đổi phán quyết:" : "Chưa review —"}</span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => gui("SACH")}>
          Sạch
        </Button>
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pending} onClick={() => setMoLoi((x) => !x)}>
          Có lỗi…
        </Button>
        {chuThichSua}
      </div>
      {moLoi ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={ghiChu}
            onChange={(e) => setGhiChu(e.target.value)}
            placeholder="Lỗi gì? (bắt buộc, ít nhất một câu)"
            className="min-w-[16rem] flex-1 rounded-lg border bg-background px-2 py-1 text-[11px]"
          />
          <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" disabled={pending || !du} onClick={() => gui("CO_LOI", ghiChu)}>
            Ghi có lỗi
          </Button>
        </div>
      ) : null}
    </div>
  );
}
