"use client";

import { useState, useTransition } from "react";
import { Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/info-hint";
import { formatVND } from "@/lib/format";
import { applyProductBudgetPlan, proposeProductBudgetPlan, type ProductBudgetPlan } from "@/lib/actions/ads-budget";
import { ADS_WRITE_DENIAL_REASON } from "@/lib/constants/ads-write";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN TAY CẤP MÃ — MỘT QUYẾT ĐỊNH, NHIỀU CHIẾN DỊCH, VẪN HAI CÚ BẤM ═══════════
 *
 * Đo production 23/09/2026: 6/8 khuyến nghị hành động ở cấp CHIẾN DỊCH nói về chiến dịch đã tắt —
 * shop chạy ~619 chiến dịch mỗi 14 ngày, còn bằng chứng tiền cần 15 ngày để chín. Mã hàng thì sống
 * lâu, nên kết luận ở cấp mã và áp lên các chiến dịch ĐANG CHẠY của mã.
 *
 * ─── VÌ SAO PHẢI IN CẢ BẢNG TRƯỚC KHI CHO BẤM ───
 *
 * Một cú bấm ở đây đổi ngân sách của nhiều chiến dịch cùng lúc. Người bấm phải thấy TỪNG chiến dịch:
 * ngân sách hiện tại, ngân sách sau khi đổi, hoặc vì sao nó bị bỏ qua (đã tắt · vượt trần trong
 * ngày · đã đổi hôm nay). Không thấy bảng ấy thì cú bấm thứ hai không phải một quyết định.
 *
 * Phiếu duyệt khoá ĐÚNG tập (chiến dịch → ngân sách đích). Giao diện không sửa được một con số nào;
 * muốn khác thì bấm đề nghị lại.
 */

type Props = { productId: string; productName: string; decision: string; ready: boolean };

export function ProductBudgetPlanAction({ productId, productName, decision, ready }: Props) {
  const [plan, setPlan] = useState<ProductBudgetPlan | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  // Cùng luật với bàn tay cấp chiến dịch: chưa chín thì KHÔNG hiện nút, dòng đã tự nói "chưa chín".
  if (!ready) return null;

  const propose = () =>
    start(async () => {
      setMessage(null);
      const r = await proposeProductBudgetPlan(productId);
      if ("error" in r) {
        setMessage({ tone: "err", text: r.error });
        setPlan(null);
        return;
      }
      setPlan(r);
      if (r.blocked) setMessage({ tone: "err", text: r.blocked });
    });

  const apply = () =>
    start(async () => {
      if (!plan?.token) return;
      const r = await applyProductBudgetPlan({
        productId,
        rows: plan.rows.filter((x) => x.allow).map((x) => ({ campaignId: x.campaignId, nextBudgetVnd: x.nextBudgetVnd })),
        token: plan.token,
      });
      if ("error" in r) {
        setMessage({ tone: "err", text: r.error });
        return;
      }
      setMessage({ tone: "ok", text: r.detail });
      setDone(true);
    });

  const duoc = plan?.rows.filter((r) => r.allow) ?? [];

  return (
    <div className="border-t bg-background px-5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-medium">
        <Hand className="size-3.5" />
        Bàn tay theo mã hàng
        <InfoHint>
          Kết luận ở cấp MÃ HÀNG, áp lên các chiến dịch ĐANG CHẠY của mã (Facebook báo ACTIVE). TĂNG = nâng ngân sách một bước; CẮT = HẠ ngân
          sách một bước, không bao giờ tạm dừng cả mã. Trần dịch chuyển trong ngày tính CỘNG DỒN qua mọi chiến dịch, nên khi chạm trần thì các
          chiến dịch chi ít nhất bị để lại. Mọi dòng — kể cả dòng bị bỏ qua — đều vào sổ.
        </InfoHint>
      </p>

      {!plan ? (
        <div className="mt-2">
          <Button size="sm" variant="outline" onClick={propose} disabled={pending}>
            {pending ? "Đang đọc từng chiến dịch trên Facebook…" : `Xem kế hoạch "${decision}" cho mã ${productName}`}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted-foreground">
            Khuyến nghị cấp mã đã giữ {plan.heldDays} ngày · <strong className="text-foreground">{duoc.length}</strong>/{plan.rows.length} chiến dịch sẽ đổi
            {duoc.length ? (
              <>
                {" "}
                · tổng dịch chuyển <strong className="numeric text-foreground">{formatVND(plan.totalShiftVnd)}</strong>/ngày
              </>
            ) : null}
          </p>
          {plan.rows.length ? (
            <div className="max-h-72 overflow-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">Chiến dịch</th>
                    <th className="px-2 py-1 text-right font-medium">Ngân sách ngày</th>
                    <th className="px-2 py-1 text-left font-medium">Kết quả</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.map((r) => (
                    <tr key={r.campaignId} className="border-t">
                      <td className="max-w-[18rem] truncate px-2 py-1" title={r.name}>
                        {r.name || r.campaignId}
                      </td>
                      <td className="numeric whitespace-nowrap px-2 py-1 text-right">
                        {r.currentBudgetVnd === null ? "—" : formatVND(r.currentBudgetVnd)}
                        {r.allow && r.nextBudgetVnd !== null ? ` → ${formatVND(r.nextBudgetVnd)}` : ""}
                      </td>
                      <td className={cn("px-2 py-1", r.allow ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                        {r.allow ? "Sẽ đổi" : r.denial ? (
                          <span className="inline-flex items-center gap-1">
                            Bỏ qua
                            <InfoHint>{r.reason || ADS_WRITE_DENIAL_REASON[r.denial]}</InfoHint>
                          </span>
                        ) : (
                          "Bỏ qua"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {plan.token && !done ? (
            <Button size="sm" onClick={apply} disabled={pending}>
              {pending ? "Đang gửi tới Facebook…" : `Xác nhận: đổi ngân sách ${duoc.length} chiến dịch`}
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
