"use client";

import { useState, useTransition } from "react";
import { Hand, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/info-hint";
import { formatVND } from "@/lib/format";
import { applyAdsBudgetChange, proposeAdsBudgetChange, type AdsProposal } from "@/lib/actions/ads-budget";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN TAY — HAI CÚ BẤM, VÀ CÚ THỨ HAI MỚI CHẠM TIỀN ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md` mục 5. Chủ shop duyệt 22/09/2026 ở nấc `COPILOT`.
 *
 * ─── VÌ SAO KHÔNG PHẢI MỘT NÚT ───
 *
 * Một nút "Áp dụng khuyến nghị" duy nhất sẽ đúng về mặt số bấm và sai về mặt trách nhiệm: người
 * bấm không thấy ngân sách hiện tại, không thấy ngân sách sau khi đổi, và không có gì để đối chiếu
 * nếu sáng mai con số trông lạ. Bước ĐỀ NGHỊ đọc trạng thái thật từ Facebook rồi in cả hai số ra;
 * chỉ khi ấy cú bấm thứ hai mới có nghĩa là một quyết định.
 *
 * ─── PHIẾU DUYỆT ĐI KÈM ĐỀ NGHỊ, KHÔNG PHẢI ĐI KÈM PHIÊN ───
 *
 * `token` gắn với (người · tool · đầu vào). Giao diện không sửa được con số sau khi đề nghị đã phát:
 * đổi một chữ số là phiếu vô hiệu và máy chủ từ chối. Nên ô ngân sách ở đây cố ý KHÔNG cho gõ tay —
 * muốn số khác thì bấm đề nghị lại.
 */

type Props = { campaignId: string; decision: string; ready: boolean };

export function AdsBudgetAction({ campaignId, decision, ready }: Props) {
  const [proposal, setProposal] = useState<AdsProposal | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  /*
    Khuyến nghị chưa chín thì KHÔNG hiện nút.

    Không phải để giấu: dòng vẫn nói rõ "chưa chín · giữ N ngày" ngay trên bảng. Một nút bấm được
    rồi báo lỗi là mời người dùng thử lại cho tới khi nó chịu — và đó chính là cách một hàng rào bị
    mài mòn thành một lời nhắc.
  */
  if (!ready) return null;

  const propose = () =>
    start(async () => {
      setMessage(null);
      const r = await proposeAdsBudgetChange(campaignId);
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
      if (!proposal?.token || !proposal.action) return;
      const r = await applyAdsBudgetChange({
        campaignId,
        action: proposal.action,
        nextBudgetVnd: proposal.nextBudgetVnd,
        token: proposal.token,
      });
      if ("error" in r) {
        setMessage({ tone: "err", text: r.error });
        return;
      }
      setMessage({ tone: "ok", text: r.detail });
      setDone(true);
    });

  return (
    <div className="border-t bg-background px-5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Hand className="size-3.5" />
        Bàn tay
        <InfoHint>
          ERP gọi thẳng Facebook để đổi ngân sách hoặc tạm dừng chiến dịch. Chỉ chạy khi chủ shop đã bật đường ghi trên máy chủ, khuyến nghị đã chín,
          và có người bấm xác nhận. Mọi lượt — kể cả lượt bị chặn — đều vào sổ kèm ngân sách trước/sau để quay lui được.
        </InfoHint>
      </p>

      {!proposal ? (
        <div className="mt-2">
          <Button size="sm" variant="outline" onClick={propose} disabled={pending}>
            {pending ? "Đang đọc trạng thái trên Facebook…" : `Xem đề nghị cho "${decision}"`}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">
              Hành động: <strong className="text-foreground">{proposal.actionLabel}</strong>
            </span>
            <span className="text-muted-foreground">
              Ngân sách ngày:{" "}
              <strong className="numeric text-foreground">{proposal.currentBudgetVnd === null ? "—" : formatVND(proposal.currentBudgetVnd)}</strong>
              {proposal.nextBudgetVnd !== null ? (
                <>
                  {" → "}
                  <strong className="numeric text-foreground">{formatVND(proposal.nextBudgetVnd)}</strong>
                </>
              ) : null}
            </span>
            <span className="text-muted-foreground">Khuyến nghị đã giữ {proposal.heldDays} ngày</span>
          </div>

          {proposal.warning ? (
            <p className="flex items-start gap-1 text-xs text-amber-600 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              {proposal.warning}
            </p>
          ) : null}

          {proposal.token && !done ? (
            <Button size="sm" onClick={apply} disabled={pending}>
              {pending ? "Đang gửi tới Facebook…" : `Xác nhận: ${proposal.actionLabel}`}
            </Button>
          ) : null}
        </div>
      )}

      {message ? (
        <p className={cn("mt-2 text-xs", message.tone === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>{message.text}</p>
      ) : null}
    </div>
  );
}
