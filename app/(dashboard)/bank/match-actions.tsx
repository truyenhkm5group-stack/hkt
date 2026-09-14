"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { autoConfirmExactMatches, linkBankTransaction } from "@/lib/actions/bank";
import type { MatchTargetType } from "@/lib/integrations/bank/match";

/**
 * XÁC NHẬN / BỎ QUA một gợi ý đối khớp.
 *
 * "Bỏ qua" cố ý KHÔNG ghi gì vào cơ sở dữ liệu: nó chỉ ẩn dòng khỏi màn hình trong phiên này. Ghi
 * một trạng thái "đã từ chối" nghe hợp lý nhưng sẽ khoá dòng đó lại — hôm sau nhập thêm chứng từ
 * đúng thì gợi ý không hiện lại nữa, và người dùng không hiểu vì sao.
 *
 * Muốn gỡ một liên kết đã nối thì dùng nút gỡ ở tab Giao dịch, nơi có đủ ngữ cảnh.
 */
export function MatchActions({ txnId, type, targetId, compact = false }: { txnId: string; type: MatchTargetType; targetId: string; compact?: boolean }) {
  const [dangChay, setDangChay] = React.useState(false);
  const [boQua, setBoQua] = React.useState(false);
  const router = useRouter();

  if (boQua) return <span className="text-[11.5px] text-muted-foreground">đã bỏ qua</span>;

  const noi = async () => {
    setDangChay(true);
    const r = await linkBankTransaction({ id: txnId, type, targetId });
    setDangChay(false);
    if ("error" in r) {
      toast.error(r.error);
      return;
    }
    toast.success("Đã nối giao dịch với chứng từ");
    router.refresh();
  };

  if (compact) {
    return (
      <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" disabled={dangChay} onClick={noi}>
        {dangChay ? <Loader2 className="size-3 animate-spin" /> : "Chọn"}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" className="h-8" disabled={dangChay} onClick={noi}>
        {dangChay ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Xác nhận
      </Button>
      <Button size="sm" variant="ghost" className="h-8" disabled={dangChay} onClick={() => setBoQua(true)}>
        <X className="size-4" /> Bỏ qua
      </Button>
    </div>
  );
}

/**
 * Tự nối các khớp ĐỊNH DANH.
 *
 * Nút nói rõ nó sắp làm gì và với bao nhiêu dòng trước khi bấm — một nút "tự động" không nói con số
 * là nút không ai dám bấm lần thứ hai sau khi nó làm sai một lần.
 */
export function AutoConfirmButton({ count }: { count: number }) {
  const [dangChay, setDangChay] = React.useState(false);
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-300/60 bg-emerald-50/60 px-4 py-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/20">
      <Sparkles className="size-4 shrink-0 text-emerald-600" />
      <span className="text-sm">
        <b>{count} giao dịch</b> có mã chứng từ trùng khớp và số tiền khớp chính xác — nối được ngay, không cần xem từng dòng.
      </span>
      <Button
        size="sm"
        className="ml-auto h-8"
        disabled={dangChay}
        onClick={async () => {
          setDangChay(true);
          const r = await autoConfirmExactMatches();
          setDangChay(false);
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(r.message);
            router.refresh();
          }
        }}
      >
        {dangChay ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Tự nối {count} dòng
      </Button>
    </div>
  );
}
