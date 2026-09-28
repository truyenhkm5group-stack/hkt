"use client";

import * as React from "react";
import { TableCell } from "@/components/ui/table";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { phoneRiskReasons, type PhoneReputation, type PhoneRiskReason, type PhoneRiskThresholds } from "@/lib/constants/phone-reputation";
import { formatDate, formatNumber } from "@/lib/format";

/**
 * Hai cột "Tỷ lệ hoàn" / "Cảnh báo SĐT" THEO PANCAKE trên danh sách chờ xuất. Trang in danh sách ngay;
 * các ô này tự điền sau, theo lô 25 đơn (route `/api/phone-reputation`), vì Pancake chỉ trả theo
 * từng SĐT. Ba trạng thái tách rời: đang hỏi "…" · không có số "—" · có số.
 */
const LO = 25;
type State = { data: Record<string, PhoneReputation | null>; pending: Set<string> };
const Ctx = React.createContext<State>({ data: {}, pending: new Set() });
/** Ngưỡng rủi ro đọc từ cấu hình cảnh báo ở máy chủ. `null` = không có ngưỡng ⇒ không gắn cảnh báo nào. */
const NguongCtx = React.createContext<PhoneRiskThresholds | null>(null);

export function PhoneReputationProvider({ orderIds, thresholds, children }: { orderIds: string[]; thresholds: PhoneRiskThresholds | null; children: React.ReactNode }) {
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
  return (
    <NguongCtx.Provider value={thresholds}>
      <Ctx.Provider value={state}>{children}</Ctx.Provider>
    </NguongCtx.Provider>
  );
}

function useRisk(orderId: string): PhoneRiskReason[] {
  const t = React.useContext(NguongCtx);
  const st = React.useContext(Ctx);
  return t ? phoneRiskReasons(st.data[orderId], t) : [];
}

const RISK_TEXT = "text-rose-700 dark:text-rose-400";
const RISK_CHIP = "ml-1 rounded bg-rose-100 px-1 text-[10px] font-semibold text-rose-800 dark:bg-rose-950/60 dark:text-rose-300";

function useReputation(orderId: string): PhoneReputation | null | "pending" {
  const st = React.useContext(Ctx);
  if (st.pending.has(orderId)) return "pending";
  return st.data[orderId] ?? null;
}

export function ReturnRateCell({ orderId }: { orderId: string }) {
  const r = useReputation(orderId);
  const cao = useRisk(orderId).includes("RETURN_RATE");
  if (r === "pending") return <TableCell className="text-right text-xs text-muted-foreground">…</TableCell>;
  if (!r || r.returnRatePct === null) return <TableCell className="text-right text-xs text-muted-foreground" title={r ? "Pancake chưa có đơn nào của SĐT này" : "Chưa hỏi được Pancake"}>—</TableCell>;
  return (
    <TableCell className="text-right" title={`Theo Pancake, trên mọi shop: thành công ${formatNumber(r.orderSuccess)} · thất bại ${formatNumber(r.orderFail)}. Không phải kết quả đơn của ERP.`}>
      <span className={cao ? `numeric font-semibold ${RISK_TEXT}` : "numeric"}>{r.returnRatePct}%</span>
      {cao ? <span className={RISK_CHIP}>cao</span> : null}
      <div className="text-[10.5px] text-muted-foreground">
        {formatNumber(r.orderFail)}/{formatNumber(r.orderSuccess + r.orderFail)} đơn
      </div>
    </TableCell>
  );
}

export function PhoneWarningCell({ orderId }: { orderId: string }) {
  const r = useReputation(orderId);
  const cao = useRisk(orderId).includes("WARNINGS");
  if (r === "pending") return <TableCell className="text-right text-xs text-muted-foreground">…</TableCell>;
  if (!r) return <TableCell className="text-right text-xs text-muted-foreground" title="Chưa hỏi được Pancake">—</TableCell>;
  if (!r.warningCount) return <TableCell className="text-right text-xs text-muted-foreground" title="Chưa shop nào báo SĐT này trên Pancake" />;
  const title = r.warnings.map((w) => `${w.at ? `${formatDate(w.at)}: ` : ""}${w.reason || "(không ghi lý do)"}`).join("\n");
  return (
    <TableCell className="text-right" title={`Số lần SĐT bị shop khác báo trên Pancake:\n${title}`}>
      <span className={`numeric font-semibold ${cao ? RISK_TEXT : "text-amber-600 dark:text-amber-400"}`}>{formatNumber(r.warningCount)}</span>
      {cao ? <span className={RISK_CHIP}>cao</span> : null}
    </TableCell>
  );
}

/**
 * KHUNG CẢNH BÁO ĐẦU TRANG: các đơn chờ xuất vượt ngưỡng rủi ro, kèm lý do — để người đóng gói / CSKH
 * thấy trước khi gửi (gọi xác nhận, xin cọc) thay vì phải dò từng dòng. Chỉ hiện khi đã có đơn vượt;
 * còn đang hỏi Pancake thì nói rõ là đang hỏi, không im lặng như thể không có đơn nào.
 */
export function PhoneRiskSummary({ labels }: { labels: Record<string, string> }) {
  const t = React.useContext(NguongCtx);
  const st = React.useContext(Ctx);
  if (!t) return null;
  const rui = Object.keys(labels)
    .map((id) => ({ id, rep: st.data[id], ly: phoneRiskReasons(st.data[id], t) }))
    .filter((x) => x.ly.length > 0);
  const dangHoi = st.pending.size;
  if (!rui.length) return dangHoi ? <p className="text-xs text-muted-foreground">Đang hỏi Pancake uy tín SĐT của {formatNumber(dangHoi)} đơn…</p> : null;
  return (
    <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        <AlertTriangle className="size-4" aria-hidden />
        {formatNumber(rui.length)} đơn rủi ro cao theo Pancake — tỷ lệ hoàn trên {t.phoneRiskReturnRatePct}% hoặc SĐT bị báo trên {formatNumber(t.phoneRiskWarningCount)} lần
        {dangHoi ? <span className="font-normal opacity-80">· còn {formatNumber(dangHoi)} đơn đang hỏi</span> : null}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {rui.map((x) => (
          <li key={x.id}>
            <Link href={`/orders/${x.id}`} className="font-semibold underline-offset-2 hover:underline">
              {labels[x.id]}
            </Link>{" "}
            {x.ly
              .map((l) => (l === "RETURN_RATE" ? `hoàn ${x.rep?.returnRatePct}% (${formatNumber(x.rep?.orderFail ?? 0)}/${formatNumber((x.rep?.orderFail ?? 0) + (x.rep?.orderSuccess ?? 0))} đơn)` : `bị báo ${formatNumber(x.rep?.warningCount ?? 0)} lần`))
              .join(" · ")}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11px] opacity-80">Ngưỡng sửa ở trang Cảnh báo. Đây là số của toàn mạng Pancake — nên gọi xác nhận hoặc xin cọc trước khi gửi.</p>
    </div>
  );
}
