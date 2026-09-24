"use client";

import { useState, useTransition } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatVND } from "@/lib/format";
import { applyIntradayScale, proposeIntradayScale, type IntradayProposal } from "@/lib/actions/ads-budget";
import { cn } from "@/lib/utils";

/**
 * Hai cú bấm, giống ô Bàn tay của bảng quyết định: ĐỀ NGHỊ đọc ngân sách thật trên Facebook và in cả
 * hai số (trước → sau); chỉ cú thứ hai mới gọi Facebook. Ngân sách đích nằm trong phiếu duyệt nên không
 * có ô gõ tay — muốn số khác thì bấm đề nghị lại.
 */
export function IntradayScaleAction({ campaignId }: { campaignId: string }) {
  const [proposal, setProposal] = useState<IntradayProposal | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  const propose = () =>
    start(async () => {
      setMessage(null);
      const r = await proposeIntradayScale(campaignId);
      if ("error" in r) {
        setMessage({ tone: "err", text: r.error });
        setProposal(null);
        return;
      }
      setProposal(r);
      if (r.blocked) setMessage({ tone: "err", text: r.blocked });
    });

  const apply = () =>
    start(async () => {
      if (!proposal?.token || proposal.nextBudgetVnd === null) return;
      const r = await applyIntradayScale({ campaignId, nextBudgetVnd: proposal.nextBudgetVnd, token: proposal.token });
      if ("error" in r) {
        setMessage({ tone: "err", text: r.error });
        return;
      }
      setMessage({ tone: "ok", text: r.detail });
      setDone(true);
    });

  return (
    <div className="flex flex-col items-end gap-1">
      {!proposal ? (
        <Button size="sm" variant="outline" onClick={propose} disabled={pending}>
          {pending ? "Đang đọc Facebook…" : "Xem đề nghị +20%"}
        </Button>
      ) : proposal.token && !done ? (
        <>
          <span className="text-xs text-muted-foreground">
            {proposal.currentBudgetVnd === null ? "—" : formatVND(proposal.currentBudgetVnd)} →{" "}
            <strong className="numeric text-foreground">{proposal.nextBudgetVnd === null ? "—" : formatVND(proposal.nextBudgetVnd)}</strong>
          </span>
          {proposal.warning ? (
            <span className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {proposal.warning}
            </span>
          ) : null}
          <Button size="sm" onClick={apply} disabled={pending}>
            {pending ? "Đang gửi tới Facebook…" : "Xác nhận tăng"}
          </Button>
        </>
      ) : null}
      {message ? (
        <span className={cn("max-w-[320px] text-right text-[11px]", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>{message.text}</span>
      ) : null}
    </div>
  );
}
