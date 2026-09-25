"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Lock, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { CostSheetStatusBadge } from "@/app/(dashboard)/production/_components/badges";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { setEstimatedCost } from "@/lib/actions/estimated-cost";
import { createCostSheet, finalizeCostSheet, updateCostSheetDraft } from "@/lib/actions/production-costing";
import { COST_LINE_KIND_LABEL, COST_LINE_KINDS, computeCostSheet, PERCENT_UNIT, type CostLineKind, type CostSheetStatus } from "@/lib/constants/production-os";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";

export type CostSheetView = {
  id: string;
  version: number;
  status: CostSheetStatus;
  totalUnitCost: number;
  notes: string;
  createdBy: string;
  createdAt: Date;
  finalizedAt: Date | null;
  finalizedBy: string;
  topicId: string | null;
  lines: { kind: string; description: string; qty: number; unit: string; unitCost: number; amount: number }[];
};

type Row = { kind: CostLineKind; description: string; qty: string; unit: string; unitCost: string };

const EMPTY_ROW: Row = { kind: "FABRIC", description: "", qty: "1", unit: "", unitCost: "" };

function toRows(lines: CostSheetView["lines"]): Row[] {
  return lines.map((l) => ({ kind: (COST_LINE_KINDS as readonly string[]).includes(l.kind) ? (l.kind as CostLineKind) : "OTHER", description: l.description, qty: String(l.qty), unit: l.unit, unitCost: l.unit === PERCENT_UNIT ? "" : String(l.unitCost) }));
}

function toInput(rows: Row[]) {
  return rows.map((r) => ({ kind: r.kind, description: r.description, qty: Number(r.qty.replace(",", ".")) || 0, unit: r.unit.trim(), unitCost: Math.round(Number(r.unitCost) || 0) }));
}

/**
 * Bảng giá thành có phiên bản. Bản NHÁP sửa được; bản ĐÃ CHỐT chỉ đọc — muốn đổi thì "Tạo phiên bản mới
 * từ bản này". Tổng tính lại ngay trên màn hình bằng CHÍNH `computeCostSheet` mà máy chủ dùng khi lưu.
 */
export function CostSheets({
  modelId,
  topicId,
  productId,
  sheets,
  canWrite,
  canApprove,
  canAssumptions,
}: {
  modelId: string;
  topicId: string | null;
  productId: string | null;
  sheets: CostSheetView[];
  canWrite: boolean;
  canApprove: boolean;
  canAssumptions: boolean;
}) {
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [rows, setRows] = useState<Row[]>([EMPTY_ROW]);
  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState<string | null>(sheets[0]?.id ?? null);
  const [pending, start] = useNavTransition();
  const router = useRouter();
  const tinh = useMemo(() => computeCostSheet(toInput(rows)), [rows]);

  const moMoi = (base?: CostSheetView) => {
    setRows(base ? toRows(base.lines) : [EMPTY_ROW]);
    setNotes(base ? `Từ V${base.version}. ${base.notes}`.trim() : "");
    setEditing({ id: null });
  };
  const moSua = (s: CostSheetView) => {
    setRows(toRows(s.lines));
    setNotes(s.notes);
    setEditing({ id: s.id });
  };
  const setRow = (i: number, patch: Partial<Row>) => setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const luu = () =>
    start(async () => {
      if (editing?.id) {
        const r = await updateCostSheetDraft({ costSheetId: editing.id, lines: toInput(rows), notes });
        if ("error" in r) {
          toast.error(r.error);
          return;
        }
        toast.success(`Đã lưu · ${formatVND(r.totalUnitCost)}/sp`);
      } else {
        const r = await createCostSheet({ modelId, topicId, lines: toInput(rows), notes });
        if ("error" in r) {
          toast.error(r.error);
          return;
        }
        toast.success(`Đã tạo V${r.version} · ${formatVND(r.totalUnitCost)}/sp${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
      }
      setEditing(null);
      router.refresh();
    });

  const chot = (s: CostSheetView) => {
    if (!confirm(`Chốt V${s.version} (${formatVND(s.totalUnitCost)}/sp)? Bản đã chốt KHÔNG sửa được nữa.`)) return;
    start(async () => {
      const r = await finalizeCostSheet(s.id);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã chốt V${r.version}`);
        router.refresh();
      }
    });
  };

  // ĐƯỜNG DUY NHẤT sang giá ước tính của BCLN: `setEstimatedCost` có sẵn (quyền reports:assumptions).
  const dungLamGiaUocTinh = (s: CostSheetView) => {
    if (!productId) return;
    start(async () => {
      const r = await setEstimatedCost({ productId, unitCost: s.totalUnitCost, reason: `Bảng giá thành V${s.version} đã chốt${s.finalizedBy ? ` bởi ${s.finalizedBy}` : ""} (sản xuất · topic/giá thành)` });
      if ("error" in r) toast.error(r.error);
      else toast.success(`Đã đặt giá vốn dự tính ${formatVND(s.totalUnitCost)}/sp cho báo cáo lợi nhuận danh nghĩa`);
    });
  };

  return (
    <div className="space-y-3">
      {sheets.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-1.5 pr-2">Phiên bản</th>
                <th className="py-1.5 pr-2">Trạng thái</th>
                <th className="py-1.5 pr-2 text-right">Giá thành / sp</th>
                <th className="py-1.5 pr-2">Người lập · chốt</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {sheets.map((s) => (
                <tr key={s.id} className="border-b align-top last:border-0">
                  <td className="py-2 pr-2">
                    <button type="button" className="font-mono font-semibold underline-offset-2 hover:underline" onClick={() => setOpen(open === s.id ? null : s.id)}>
                      V{s.version}
                    </button>
                    {topicId && s.topicId === topicId ? <span className="ml-1 text-[10.5px] text-muted-foreground">topic này</span> : null}
                    {open === s.id ? (
                      <div className="mt-2 space-y-1">
                        <table className="text-xs">
                          <tbody>
                            {s.lines.map((l, i) => (
                              <tr key={i}>
                                <td className="pr-2 text-muted-foreground">{COST_LINE_KIND_LABEL[l.kind as CostLineKind] ?? l.kind}</td>
                                <td className="pr-2">{l.description || "—"}</td>
                                <td className="pr-2 text-right tabular-nums">
                                  {formatNumber(l.qty)} {l.unit}
                                </td>
                                <td className="pr-2 text-right tabular-nums">{l.unit === PERCENT_UNIT ? "—" : formatVND(l.unitCost)}</td>
                                <td className="text-right font-medium tabular-nums">{formatVND(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {s.notes ? <p className="text-xs text-muted-foreground">{s.notes}</p> : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2">
                    <CostSheetStatusBadge status={s.status} />
                  </td>
                  <td className="py-2 pr-2 text-right font-semibold tabular-nums">{formatVND(s.totalUnitCost)}</td>
                  <td className="py-2 pr-2 text-xs text-muted-foreground">
                    {s.createdBy || "—"} · {formatDateTime(s.createdAt)}
                    {s.finalizedAt ? (
                      <div>
                        <Lock className="mr-1 inline size-3" />
                        chốt bởi {s.finalizedBy || "—"} · {formatDateTime(s.finalizedAt)}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      {canWrite && s.status === "DRAFT" ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => moSua(s)}>
                          <Pencil className="size-3.5" /> Sửa
                        </Button>
                      ) : null}
                      {canApprove && s.status === "DRAFT" ? (
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => chot(s)}>
                          <Lock className="size-3.5" /> Chốt
                        </Button>
                      ) : null}
                      {canWrite ? (
                        <Button size="sm" variant="ghost" disabled={pending} onClick={() => moMoi(s)} title="Tạo phiên bản mới, chép dòng của bản này">
                          <Copy className="size-3.5" />
                        </Button>
                      ) : null}
                      {s.status === "FINAL" && canAssumptions ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending || !productId}
                          title={productId ? "Ghi tổng này làm giá vốn dự tính (Báo cáo lợi nhuận danh nghĩa) qua đúng đường đặt giá dự tính có sẵn" : "Mẫu chưa có sản phẩm Pancake — chưa có mã hàng để đặt giá dự tính"}
                          onClick={() => dungLamGiaUocTinh(s)}
                        >
                          <Tag className="size-3.5" /> Dùng làm giá ước tính
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Chưa có bảng giá thành nào cho mẫu này.</p>
      )}

      {canWrite && !editing ? (
        <Button size="sm" variant="outline" onClick={() => moMoi()}>
          <Plus className="size-4" /> Phiên bản giá thành mới
        </Button>
      ) : null}

      {editing ? (
        <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
          <div className="text-sm font-semibold">{editing.id ? "Sửa bảng nháp" : "Phiên bản mới"}</div>
          <p className="text-xs text-muted-foreground">
            Dòng thường: thành tiền = SL × đơn giá. Hao hụt theo tỷ lệ: chọn loại <b>Hao hụt</b>, đơn vị <code>%</code>, SL là số phần trăm — tính trên tổng các dòng KHÔNG phải %.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pr-1">Loại</th>
                  <th className="pr-1">Diễn giải</th>
                  <th className="pr-1">SL</th>
                  <th className="pr-1">Đơn vị</th>
                  <th className="pr-1">Đơn giá (đ)</th>
                  <th className="pr-1 text-right">Thành tiền</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const tien = "error" in tinh ? null : tinh.lines[i]?.amount ?? null;
                  return (
                    <tr key={i}>
                      <td className="py-0.5 pr-1">
                        <select value={r.kind} onChange={(e) => setRow(i, { kind: e.target.value as CostLineKind })} className="h-8 rounded-md border bg-background px-1 text-xs">
                          {COST_LINE_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {COST_LINE_KIND_LABEL[k]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-0.5 pr-1">
                        <Input className="h-8 min-w-[140px] text-xs" value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
                      </td>
                      <td className="py-0.5 pr-1">
                        <Input className="h-8 w-20 text-xs tabular-nums" inputMode="decimal" value={r.qty} onChange={(e) => setRow(i, { qty: e.target.value })} />
                      </td>
                      <td className="py-0.5 pr-1">
                        <Input className="h-8 w-16 text-xs" value={r.unit} placeholder="m, cái, %" onChange={(e) => setRow(i, { unit: e.target.value })} />
                      </td>
                      <td className="py-0.5 pr-1">
                        <Input className="h-8 w-28 text-xs tabular-nums" inputMode="numeric" disabled={r.unit.trim() === PERCENT_UNIT} value={r.unitCost} onChange={(e) => setRow(i, { unitCost: e.target.value.replace(/[^\d]/g, "") })} />
                      </td>
                      <td className="py-0.5 pr-1 text-right tabular-nums">{tien === null ? "—" : formatVND(tien)}</td>
                      <td className="py-0.5">
                        <Button size="icon" variant="ghost" className="size-7" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length <= 1}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setRows([...rows, { ...EMPTY_ROW, kind: "OTHER" }])}>
              <Plus className="size-4" /> Thêm dòng
            </Button>
            <span className="ml-auto text-sm">
              {"error" in tinh ? <span className="text-destructive">{tinh.error}</span> : <>Tổng <b className="tabular-nums">{formatVND(tinh.total)}</b>/sp</>}
            </span>
          </div>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ghi chú: báo giá của xưởng nào, ngày nào, điều kiện…" />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={pending}>
              Huỷ
            </Button>
            <Button size="sm" onClick={luu} disabled={pending || "error" in tinh}>
              {editing.id ? "Lưu bản nháp" : "Tạo phiên bản"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
