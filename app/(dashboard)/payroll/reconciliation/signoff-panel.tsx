"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { revokeProfitReconciliation, signProfitReconciliation } from "@/lib/actions/payroll-reconciliation";

/**
 * CẤP 1 CỦA DUYỆT HAI CẤP: ký bảng đối soát đang hiện. Gửi kèm khoá dấu vân tay của ĐÚNG bảng này —
 * server đo lại và từ chối nếu số đã đổi. Action `revalidatePath` trang này nên không `router.refresh()`.
 */
export function SignoffPanel({ monthKey, fingerprintKey, locked, signoffs }: { monthKey: string; fingerprintKey: string; locked: boolean; signoffs: { id: string; current: boolean; signedByEmail: string; signedAt: string; reason: string; status: string }[] }) {
  const [lyDo, setLyDo] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3 text-sm">
      {signoffs.length ? (
        <ul className="space-y-1">
          {signoffs.map((s) => (
            <li key={s.id} className={s.current ? "font-medium" : "text-muted-foreground"}>
              {s.current ? "✓ Khớp số hiện tại" : "✗ Ký trên số CŨ (không còn áp)"} · {s.signedByEmail} · {s.signedAt.slice(0, 16).replace("T", " ")} · {s.status === "RECONCILED" ? "đã khớp nguồn" : "còn khoản chưa đối soát"} — {s.reason}
              {!locked ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-1 h-6 px-2 text-xs"
                  disabled={pending}
                  onClick={() => {
                    const ly = window.prompt("Lý do huỷ chữ ký (ít nhất 10 ký tự):");
                    if (!ly) return;
                    start(async () => {
                      const r = await revokeProfitReconciliation({ id: s.id, reason: ly });
                      if ("error" in r) toast.error(r.error);
                      else toast.success("Đã huỷ chữ ký");
                    });
                  }}
                >
                  Huỷ
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Chưa ai ký đối soát tháng {monthKey}.</p>
      )}
      {locked ? (
        <p className="text-muted-foreground">Tháng đã khoá lương — ảnh chụp đã mang chữ ký của nó.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 w-[460px] max-w-full" value={lyDo} onChange={(e) => setLyDo(e.target.value)} placeholder="Đã đối chiếu những gì (vd: sổ COD tới 15/11, giá vốn các mã còn thiếu đã kiểm, phí hoàn…)" />
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await signProfitReconciliation({ monthKey, fingerprintKey, reason: lyDo });
                if ("error" in r) toast.error(r.error);
                else toast.success("Đã ký đối soát cấp 1");
              })
            }
          >
            Ký đối soát tháng {monthKey}
          </Button>
          <p className="w-full text-xs text-muted-foreground">
            Chữ ký áp cho ĐÚNG các con số đang hiện (mã {fingerprintKey}); số đổi thì phải ký lại. Người ký cấp 1 KHÔNG được bấm duyệt kỳ lương (cấp 2) của tháng này. Người thứ hai duyệt chữ ký khi nhóm Lương bật cưỡng chế duyệt.
          </p>
        </div>
      )}
    </div>
  );
}
