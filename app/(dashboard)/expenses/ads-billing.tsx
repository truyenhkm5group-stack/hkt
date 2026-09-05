"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { saveAdAccountThreshold } from "@/lib/actions/alerts";
import { FB_ACCOUNT_STATUS_LABEL } from "@/lib/constants/alerts";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import type { BillingRow } from "@/lib/integrations/facebook/billing";
import { cn } from "@/lib/utils";

const money = (v: number, currency: string) => (currency === "VND" ? `${formatNumber(v)} ₫` : `${formatNumber(v)} ${currency}`);

function ThresholdInput({ row, canWrite }: { row: BillingRow; canWrite: boolean }) {
  const [value, setValue] = useState(row.threshold ? String(row.threshold) : "");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const dirty = (row.threshold ? String(row.threshold) : "") !== value.trim();
  const save = () =>
    startTransition(async () => {
      const n = Number(value.replace(/[^\d]/g, ""));
      const r = await saveAdAccountThreshold(row.accountId, n > 0 ? n : null);
      if ("error" in r) toast.error(r.error);
      else { toast.success("Đã lưu ngưỡng thanh toán"); router.refresh(); }
    });
  if (!canWrite) return <span className="tabular-nums">{row.threshold ? money(row.threshold, row.currency) : row.learnedThreshold ? `~${money(row.learnedThreshold, row.currency)} (tự học)` : "—"}</span>;
  return (
    <div className="flex items-center gap-1">
      <Input className="h-8 w-32 text-right tabular-nums" inputMode="numeric" value={value} placeholder={row.learnedThreshold ? `~${formatNumber(row.learnedThreshold)}` : "nhập"} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && dirty) save(); }} />
      {dirty ? <Button size="icon" variant="ghost" className="size-8" onClick={save} disabled={pending} aria-label="Lưu"><Check className="size-4" /></Button> : null}
    </div>
  );
}

export function AdsBillingTable({ rows, warnPercent, canWrite }: { rows: BillingRow[]; warnPercent: number; canWrite: boolean }) {
  if (!rows.length) return <p className="px-4 py-6 text-center text-sm text-muted-foreground">Chưa có dữ liệu. Bấm “Cập nhật dư nợ” (cần FACEBOOK_ACCESS_TOKEN có quyền ads_read / business_management).</p>;
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead>Tài khoản QC</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead className="text-right">Dư nợ</TableHead>
            <TableHead className="text-right">Ngưỡng thanh toán</TableHead>
            <TableHead className="w-[220px]">% tới ngưỡng</TableHead>
            <TableHead>Thanh toán bằng · kỳ hoá đơn</TableHead>
            <TableHead className="text-right">Lần thu gần nhất</TableHead>
            <TableHead className="text-right">Cập nhật</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const threshold = r.threshold && r.threshold > 0 ? r.threshold : r.learnedThreshold && r.learnedThreshold > 0 ? r.learnedThreshold : null;
            const pct = threshold ? Math.min(150, (r.balance / threshold) * 100) : null;
            const blocked = [2, 3, 8, 9].includes(r.accountStatus) || r.disableReason > 0;
            const tone = blocked || (pct !== null && pct >= 100) ? "rose" : pct !== null && pct >= warnPercent ? "amber" : "emerald";
            return (
              <TableRow key={r.accountId} className={cn(blocked && "bg-rose-50/40 dark:bg-rose-950/20")}>
                <TableCell>
                  <div className="font-medium">{r.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">act_{r.accountId} · {r.relation === "owned" ? "sở hữu" : "được cấp"}{r.isPrepay ? " · trả trước" : ""}</div>
                </TableCell>
                <TableCell>
                  <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", blocked ? "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300")}>{FB_ACCOUNT_STATUS_LABEL[r.accountStatus] ?? `Mã ${r.accountStatus}`}</span>
                  {r.disableReason ? <div className="mt-1 text-[11px] text-rose-600">Lý do khoá: {r.disableReason}</div> : null}
                </TableCell>
                <TableCell className={cn("text-right font-semibold tabular-nums", blocked && "text-rose-600")}>{money(r.balance, r.currency)}</TableCell>
                <TableCell className="text-right"><div className="flex justify-end"><ThresholdInput row={r} canWrite={canWrite} /></div></TableCell>
                <TableCell>
                  {pct === null ? <span className="text-xs text-muted-foreground">Chưa biết ngưỡng — nhập từ Trung tâm thanh toán Meta</span> : (
                    <div>
                      <div className="h-2 w-full overflow-hidden rounded bg-muted"><div className={cn("h-full rounded", tone === "rose" ? "bg-rose-500" : tone === "amber" ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(100, pct)}%` }} /></div>
                      <div className={cn("mt-1 text-xs tabular-nums", tone === "rose" ? "text-rose-600" : tone === "amber" ? "text-amber-600" : "text-muted-foreground")}>{Math.round(pct)}%{!r.threshold && r.learnedThreshold ? " · ngưỡng tự học" : ""}</div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  <div>{r.fundingSource || "—"}</div>
                  <div className="text-muted-foreground">{r.nextBillDate ? `Kỳ hoá đơn ${r.nextBillDate}` : ""}</div>
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground">{r.lastPaidAt ? formatDateTime(r.lastPaidAt) : "—"}</TableCell>
                <TableCell className="text-right text-xs text-muted-foreground" title={r.fetchedAt ? formatDateTime(r.fetchedAt) : ""}>{r.fetchedAt ? formatTimeAgo(r.fetchedAt) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
