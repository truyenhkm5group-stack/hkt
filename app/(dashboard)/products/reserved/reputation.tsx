"use client";

import * as React from "react";
import { TableCell } from "@/components/ui/table";
import type { PhoneReputation } from "@/lib/constants/phone-reputation";
import { formatDate, formatNumber } from "@/lib/format";

/**
 * Hai cột "Tỷ lệ hoàn" / "Cảnh báo SĐT" THEO PANCAKE trên danh sách chờ xuất. Trang in danh sách ngay;
 * các ô này tự điền sau, theo lô 25 đơn (route `/api/phone-reputation`), vì Pancake chỉ trả theo
 * từng SĐT. Ba trạng thái tách rời: đang hỏi "…" · không có số "—" · có số.
 */
const LO = 25;
type State = { data: Record<string, PhoneReputation | null>; pending: Set<string> };
const Ctx = React.createContext<State>({ data: {}, pending: new Set() });

export function PhoneReputationProvider({ orderIds, children }: { orderIds: string[]; children: React.ReactNode }) {
  const key = orderIds.join(",");
  const [state, setState] = React.useState<State>(() => ({ data: {}, pending: new Set(orderIds) }));
  React.useEffect(() => {
    const ids = [...new Set(key ? key.split(",") : [])];
    let huy = false;
    setState({ data: {}, pending: new Set(ids) });
    (async () => {
      for (let i = 0; i < ids.length && !huy; i += LO) {
        const lo = ids.slice(i, i + LO);
        let data: Record<string, PhoneReputation | null> = {};
        try {
          const res = await fetch("/api/phone-reputation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderIds: lo }) });
          if (res.ok) data = ((await res.json()) as { data?: Record<string, PhoneReputation | null> }).data ?? {};
        } catch {
          // Lỗi mạng ⇒ các ô của lô này thành "—" (chưa biết), không phải 0.
        }
        if (huy) return;
        setState((cu) => {
          const pending = new Set(cu.pending);
          for (const id of lo) pending.delete(id);
          return { data: { ...cu.data, ...data }, pending };
        });
      }
    })();
    return () => {
      huy = true;
    };
  }, [key]);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

function useReputation(orderId: string): PhoneReputation | null | "pending" {
  const st = React.useContext(Ctx);
  if (st.pending.has(orderId)) return "pending";
  return st.data[orderId] ?? null;
}

export function ReturnRateCell({ orderId }: { orderId: string }) {
  const r = useReputation(orderId);
  if (r === "pending") return <TableCell className="text-right text-xs text-muted-foreground">…</TableCell>;
  if (!r || r.returnRatePct === null) return <TableCell className="text-right text-xs text-muted-foreground" title={r ? "Pancake chưa có đơn nào của SĐT này" : "Chưa hỏi được Pancake"}>—</TableCell>;
  return (
    <TableCell className="text-right" title={`Theo Pancake, trên mọi shop: thành công ${formatNumber(r.orderSuccess)} · thất bại ${formatNumber(r.orderFail)}. Không phải kết quả đơn của ERP.`}>
      <span className="numeric">{r.returnRatePct}%</span>
      <div className="text-[10.5px] text-muted-foreground">
        {formatNumber(r.orderFail)}/{formatNumber(r.orderSuccess + r.orderFail)} đơn
      </div>
    </TableCell>
  );
}

export function PhoneWarningCell({ orderId }: { orderId: string }) {
  const r = useReputation(orderId);
  if (r === "pending") return <TableCell className="text-right text-xs text-muted-foreground">…</TableCell>;
  if (!r) return <TableCell className="text-right text-xs text-muted-foreground" title="Chưa hỏi được Pancake">—</TableCell>;
  if (!r.warningCount) return <TableCell className="text-right text-xs text-muted-foreground" title="Chưa shop nào báo SĐT này trên Pancake" />;
  const title = r.warnings.map((w) => `${w.at ? `${formatDate(w.at)}: ` : ""}${w.reason || "(không ghi lý do)"}`).join("\n");
  return (
    <TableCell className="text-right" title={`Số lần SĐT bị shop khác báo trên Pancake:\n${title}`}>
      <span className="numeric font-semibold text-amber-600 dark:text-amber-400">{formatNumber(r.warningCount)}</span>
    </TableCell>
  );
}
