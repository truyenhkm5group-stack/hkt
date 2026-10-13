"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Eye, Loader2, Save, Tag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { previewPlannedCostImpact, setPlannedCosts, type PlannedCostPreview } from "@/lib/actions/estimated-cost";
import { COST_BASIS_LABEL, type CostBasis } from "@/lib/constants/estimated-cost";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import type { CostCenterRow } from "@/lib/queries/cost-center";
import { cn } from "@/lib/utils";

/** Nhận cả "150.000", "150,000" lẫn "150000" — người Việt gõ dấu chấm ngăn nghìn. */
function docSoTien(v: string): number {
  return Math.round(Number(v.replace(/[.,\s₫đ]/g, "")));
}

const ngayVN = (s: string | null) => (s ? s.split("-").reverse().join("/") : "mọi kỳ");

function Nhan({ basis }: { basis: string }) {
  const b = basis as CostBasis;
  const tone =
    b === "ACTUAL" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
    : b === "PLANNED" ? "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300"
    : b === "UNKNOWN" ? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"
    : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  return <span className={cn("inline-block whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium", tone)}>{COST_BASIS_LABEL[b] ?? basis}</span>;
}

function Tien({ v }: { v: number | null | undefined }) {
  return v === null || v === undefined ? <span className="text-muted-foreground">—</span> : <>{formatVND(v)}</>;
}

/**
 * Bảng Trung tâm giá vốn: sửa giá kế hoạch HÀNG LOẠT → XEM TRƯỚC tác động lên lợi nhuận dự tính →
 * lưu. Nút Lưu chỉ mở khi bản xem trước khớp đúng những ô đang sửa — đổi một ô là phải xem lại.
 */
export function CostCenterTable({ rows, canWrite, period }: { rows: CostCenterRow[]; canWrite: boolean; period: { key: string; from: string | null; to: string | null; label: string } }) {
  const [loc, setLoc] = React.useState("");
  const [sua, setSua] = React.useState<Record<string, string>>({});
  const [ngay, setNgay] = React.useState("");
  const [lyDo, setLyDo] = React.useState("");
  const [mo, setMo] = React.useState<string | null>(null);
  const [xemTruoc, setXemTruoc] = React.useState<{ key: string; data: PlannedCostPreview } | null>(null);
  const [pending, startTransition] = React.useTransition();

  const items = Object.entries(sua)
    .filter(([, v]) => v.trim() !== "")
    .map(([productId, v]) => ({ productId, unitCost: v.trim() === "0" || v.trim() === "-" ? null : docSoTien(v) }));
  const hopLe = items.every((it) => it.unitCost === null || (Number.isFinite(it.unitCost) && it.unitCost > 0));
  const khoa = JSON.stringify({ items, ngay, period: period.key, from: period.from, to: period.to });
  const daXem = xemTruoc?.key === khoa;

  const q = loc.trim().toLowerCase();
  const hien = q ? rows.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : rows;

  const layGiaBao = () => {
    const next = { ...sua };
    let n = 0;
    for (const r of hien) {
      if (r.planned || r.marketerPrice === null || next[r.productId]) continue;
      next[r.productId] = String(r.marketerPrice);
      n += 1;
    }
    setSua(next);
    toast.info(n ? `Đã điền giá báo MKT vào ${formatNumber(n)} mã chưa có giá kế hoạch — xem trước rồi mới lưu` : "Không mã nào (đang hiện) vừa chưa có giá kế hoạch vừa có giá báo");
  };

  const xem = () =>
    startTransition(async () => {
      const r = await previewPlannedCostImpact({ items, effectiveFrom: ngay || null, period: period.key, from: period.from ?? undefined, to: period.to ?? undefined });
      if ("error" in r) toast.error(r.error);
      else setXemTruoc({ key: khoa, data: r });
    });

  const luu = () => {
    const id = toast.loading(`Đang lưu giá kế hoạch cho ${formatNumber(items.length)} mã…`);
    startTransition(async () => {
      const r = await setPlannedCosts({ items, effectiveFrom: ngay || null, reason: lyDo.trim() });
      if ("error" in r) toast.error(r.error, { id });
      else {
        toast.success(`Đã lưu giá kế hoạch cho ${formatNumber(r.saved)} mã — BCLN đã tính lại`, { id });
        setSua({});
        setXemTruoc(null);
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-60" placeholder="Lọc theo mã / tên…" value={loc} onChange={(e) => setLoc(e.target.value)} />
        {canWrite ? (
          <Button type="button" size="sm" variant="outline" onClick={layGiaBao} title="Chỉ ĐIỀN vào ô sửa — chưa lưu gì. Giá báo MKT không tự thành giá kế hoạch.">
            <Tag className="size-4" /> Điền giá báo MKT cho mã chưa có kế hoạch
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">{formatNumber(hien.length)} mã</span>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table className="min-w-[1150px]">
          <TableHeader>
            <TableRow>
              <TableHead>Mã hàng</TableHead>
              <TableHead className="text-right" title="Giá vốn kế hoạch đang hiệu lực hôm nay — ô DUY NHẤT sửa được. Gõ 0 để bỏ giá kế hoạch (vẫn giữ lịch sử).">Giá kế hoạch</TableHead>
              <TableHead className="text-right" title="Giá nhập bình quân trên phiếu NHẬP KHO gần nhất — chứng từ, nguồn giá thực tế của BCLN.">Phiếu kho gần nhất</TableHead>
              <TableHead className="text-right" title="(Tiền vải + tiền công) ÷ hàng xưởng trả. Tham chiếu: không tự thành giá vốn; «tạm tính» = SL chưa chốt hoặc lô chưa trả xong.">Giá SX xưởng</TableHead>
              <TableHead className="text-right" title="Giá báo MKT đang hiệu lực — cơ sở hoa hồng MKT, KHÔNG phải giá vốn. Chỉ lấp chỗ trống (nhãn Tạm tính) khi mã chưa có giá thật lẫn giá kế hoạch.">Giá báo MKT</TableHead>
              <TableHead className="text-right" title="Giá vốn / sp BCLN chế độ THỰC TẾ dùng trong kỳ đang chọn.">Đang áp dụng · Thực tế</TableHead>
              <TableHead className="text-right" title="Giá vốn / sp BCLN chế độ KẾ HOẠCH dùng trong kỳ đang chọn.">Đang áp dụng · Kế hoạch</TableHead>
              <TableHead className="text-right" title="Giá kế hoạch − giá phiếu kho gần nhất. Dương = kế hoạch cao hơn chứng từ.">KH − phiếu</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hien.map((r) => (
              <React.Fragment key={r.productId}>
                <TableRow className={cn(sua[r.productId] && "bg-sky-50/60 dark:bg-sky-950/20")}>
                  <TableCell className="max-w-[240px] whitespace-normal align-top">
                    <button type="button" className="flex items-start gap-1 text-left" onClick={() => setMo(mo === r.productId ? null : r.productId)} title="Lịch sử giá kế hoạch">
                      {mo === r.productId ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" />}
                      <span>
                        <span className="font-medium">{r.code || "—"}</span>
                        <span className="block text-[11px] text-muted-foreground">{r.name}</span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {canWrite ? (
                      <Input
                        className="numeric ml-auto h-7 w-28 text-right"
                        inputMode="numeric"
                        placeholder={r.planned?.unitCost ? formatNumber(r.planned.unitCost) : "chưa đặt"}
                        value={sua[r.productId] ?? ""}
                        onChange={(e) => setSua({ ...sua, [r.productId]: e.target.value })}
                      />
                    ) : (
                      <Tien v={r.planned?.unitCost ?? null} />
                    )}
                    {sua[r.productId] && ["0", "-"].includes(sua[r.productId].trim()) ? <div className="mt-0.5 text-[10.5px] font-medium text-rose-600">sẽ BỎ giá kế hoạch</div> : null}
                    <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                      {r.planned ? `${formatVND(r.planned.unitCost ?? 0)} · từ ${ngayVN(r.planned.effectiveFrom)} · ${r.planned.setBy ?? "—"}` : "chưa đặt"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Tien v={r.receipt?.unitCost ?? null} />
                    <div className="text-[10.5px] text-muted-foreground">{r.receipt ? formatDate(new Date(r.receipt.at)) : "chưa có phiếu"}</div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Tien v={r.workshop?.unitCost ?? null} />
                    <div className="text-[10.5px] text-muted-foreground">{r.workshop ? (r.workshop.unitCost === null ? r.workshop.reason : r.workshop.provisional ? "tạm tính" : "đã chốt") : "—"}</div>
                  </TableCell>
                  <TableCell className="text-right align-top text-muted-foreground">
                    <Tien v={r.marketerPrice} />
                    <div className="text-[10.5px]">tham chiếu</div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Tien v={r.appliedActual?.unit ?? null} />
                    <div>{r.appliedActual ? <Nhan basis={r.appliedActual.basis} /> : <span className="text-[10.5px] text-muted-foreground">không bán trong kỳ</span>}</div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Tien v={r.appliedPlanned?.unit ?? null} />
                    <div>{r.appliedPlanned ? <Nhan basis={r.appliedPlanned.basis} /> : <span className="text-[10.5px] text-muted-foreground">không bán trong kỳ</span>}</div>
                  </TableCell>
                  <TableCell className={cn("text-right align-top tabular-nums", r.planVsReceipt !== null && r.planVsReceipt !== 0 && (r.planVsReceipt > 0 ? "text-amber-700 dark:text-amber-300" : "text-sky-700 dark:text-sky-300"))}>
                    {r.planVsReceipt === null ? <span className="text-muted-foreground">—</span> : `${r.planVsReceipt > 0 ? "+" : ""}${formatVND(r.planVsReceipt)}`}
                  </TableCell>
                </TableRow>
                {mo === r.productId ? (
                  <TableRow>
                    <TableCell colSpan={8} className="bg-muted/40 text-xs">
                      {r.history.length === 0 ? (
                        <span className="text-muted-foreground">Chưa có lần đặt giá kế hoạch nào.</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {r.history.map((h, i) => (
                            <li key={`${h.setAt}-${i}`}>
                              <b>{h.unitCost === null ? "Bỏ giá kế hoạch" : formatVND(h.unitCost)}</b> · hiệu lực từ {ngayVN(h.effectiveFrom)} · {h.setBy ?? "—"} · {h.setAt ? new Date(h.setAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—"}
                              {h.reason ? ` · “${h.reason}”` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                ) : null}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      {canWrite && items.length ? (
        <div className="sticky bottom-2 space-y-3 rounded-lg border bg-background p-3 shadow-lg">
          <div className="flex flex-wrap items-end gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Đang sửa</div>
              <b>{formatNumber(items.length)} mã</b>
            </div>
            <label className="space-y-1">
              <div className="text-xs text-muted-foreground">Hiệu lực từ (để trống = mọi kỳ)</div>
              <Input type="date" className="h-8 w-40" value={ngay} onChange={(e) => setNgay(e.target.value)} />
            </label>
            <label className="min-w-[260px] flex-1 space-y-1">
              <div className="text-xs text-muted-foreground">Lý do (bắt buộc)</div>
              <Input className="h-8" placeholder="Báo giá xưởng tháng 10, lô thử…" value={lyDo} onChange={(e) => setLyDo(e.target.value)} />
            </label>
            <Button type="button" size="sm" variant="outline" onClick={xem} disabled={pending || !hopLe}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Xem trước tác động
            </Button>
            <Button type="button" size="sm" onClick={luu} disabled={pending || !hopLe || !daXem || lyDo.trim().length < 3} title={daXem ? "" : "Xem trước tác động trước khi lưu"}>
              <Save className="size-4" /> Lưu {formatNumber(items.length)} mã
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setSua({}); setXemTruoc(null); }} disabled={pending}>
              Huỷ sửa
            </Button>
          </div>
          {!hopLe ? <p className="text-xs text-rose-600">Có ô không phải số tiền hợp lệ. Gõ 0 để bỏ giá kế hoạch.</p> : null}
          {daXem && xemTruoc ? (
            <div className="text-xs">
              <p className="mb-1 text-muted-foreground">
                Tác động lên lợi nhuận DỰ TÍNH (chế độ kế hoạch) · {xemTruoc.data.periodLabel}: LN danh nghĩa{" "}
                <b>{xemTruoc.data.totalDeltaNominal === null ? "chưa tính được" : `${xemTruoc.data.totalDeltaNominal >= 0 ? "+" : ""}${formatVND(xemTruoc.data.totalDeltaNominal)}`}</b> · LN ròng (gồm dự phòng rủi ro tồn kho){" "}
                <b>{xemTruoc.data.totalDeltaNet === null ? "chưa tính được" : `${xemTruoc.data.totalDeltaNet >= 0 ? "+" : ""}${formatVND(xemTruoc.data.totalDeltaNet)}`}</b>. Không đổi kỳ đã chốt, không đổi lương, không đổi phiếu kho.
              </p>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="text-left font-normal">Mã</th>
                      <th className="text-right font-normal">SL giao TC ƯT</th>
                      <th className="text-right font-normal">Giá / sp hiện tại</th>
                      <th className="text-right font-normal">Giá mới</th>
                      <th className="text-right font-normal">Δ giá vốn</th>
                      <th className="text-right font-normal">Δ LN danh nghĩa</th>
                    </tr>
                  </thead>
                  <tbody>
                    {xemTruoc.data.rows.map((x) => (
                      <tr key={x.productId}>
                        <td>{x.code || x.productId}</td>
                        <td className="text-right tabular-nums">{formatNumber(Math.round(x.expectedQty))}</td>
                        <td className="text-right tabular-nums"><Tien v={x.currentUnit} /></td>
                        <td className="text-right tabular-nums">{x.newUnit === null ? "bỏ ⇒ giá thật" : formatVND(x.newUnit)}</td>
                        <td className="text-right tabular-nums">{x.applies ? <Tien v={x.deltaCogs} /> : "chưa hiệu lực trong kỳ"}</td>
                        <td className="text-right tabular-nums"><Tien v={x.deltaNominalProfit} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Bấm “Xem trước tác động” — nút Lưu chỉ mở khi bản xem trước khớp đúng những ô đang sửa.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
