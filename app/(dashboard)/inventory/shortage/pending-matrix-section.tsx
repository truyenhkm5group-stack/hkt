"use client";

import { Copy, Search } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  EMPTY_FABRIC_NORM,
  PENDING_MEASURES,
  PENDING_MEASURE_HINT,
  PENDING_MEASURE_LABEL,
  fabricPlan,
  measureOf,
  measureText,
  pendingMatrixAsText,
  type FabricNorm,
  type PendingMatrix,
  type PendingMeasure,
} from "@/lib/constants/pending-matrix";
import { cellKey, colorSwatch } from "@/lib/constants/production";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Định mức vải là số người đặt vải gõ để TÍNH TRÊN MÀN HÌNH — ERP chưa có bảng định mức nguyên liệu,
 * và con số này không đi vào báo cáo / giá vốn nào. Nên nó chỉ nằm ở trình duyệt của người gõ
 * (localStorage), đọc/ghi trong try/catch: không có thì trang vẫn chạy, chỉ là phải gõ lại.
 */
const NORMS_KEY = "erp.inventory.fabric-norms.v1";
const FABRIC_UNITS = ["m", "kg", "yard", "cây"] as const;

function loadNorms(): Record<string, FabricNorm> {
  try {
    const raw = window.localStorage.getItem(NORMS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, FabricNorm>) : {};
  } catch {
    return {};
  }
}

function saveNorms(norms: Record<string, FabricNorm>) {
  try {
    window.localStorage.setItem(NORMS_KEY, JSON.stringify(norms));
  } catch {
    // Trình duyệt chặn lưu (chế độ riêng tư): vẫn tính được trong phiên này.
  }
}

/** Ô trống = chưa khai (null), không phải 0. Nhận cả dấu phẩy thập phân kiểu Việt. */
function parseNum(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const numText = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? String(n) : "");
const fmtFabric = (n: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(n);

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`Đã sao chép ${what} — dán thẳng vào Excel / Google Sheet / Zalo`);
  } catch {
    toast.error("Trình duyệt không cho sao chép");
  }
}

export function PendingMatrixSection({ matrices, orphanUnits, orphanVariants }: { matrices: PendingMatrix[]; orphanUnits: number; orphanVariants: number }) {
  const [measure, setMeasure] = useQueryState("m", parseAsStringLiteral(PENDING_MEASURES).withDefault("pending").withOptions({ history: "replace", clearOnDefault: true, scroll: false }));
  const [q, setQ] = useState("");
  const [norms, setNorms] = useState<Record<string, FabricNorm>>({});
  // Đọc sau khi gắn vào trang, không đọc lúc dựng: máy chủ không có localStorage, đọc sớm là lệch HTML.
  useEffect(() => setNorms(loadNorms()), []);

  const setNorm = (productId: string, patch: Partial<FabricNorm>) =>
    setNorms((cur) => {
      const next = { ...cur, [productId]: { ...EMPTY_FABRIC_NORM, ...cur[productId], ...patch } };
      saveNorms(next);
      return next;
    });

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    // Mã không còn gì ở con số đang xem (vd. đủ hàng khi xem "Thiếu") thì ẩn — bảng toàn số 0 chỉ làm dài trang.
    const hasAny = (m: PendingMatrix) => {
      const t = measureOf(m.total, measure);
      return t.qty > 0 || t.unknown > 0;
    };
    return matrices.filter((m) => hasAny(m) && (!k || `${m.productCode} ${m.productName}`.toLowerCase().includes(k)));
  }, [matrices, measure, q]);

  const grand = shown.reduce((t, m) => {
    const v = measureOf(m.total, measure);
    return { qty: t.qty + v.qty, unknown: t.unknown + v.unknown };
  }, { qty: 0, unknown: 0 });

  const copyAll = () => copy(shown.map((m) => pendingMatrixAsText(m, measure, norms[m.productId])).join("\n\n"), `${formatNumber(shown.length)} bảng`);

  return (
    <SectionCard
      id="cho-xuat"
      title={`Chi tiết chờ xuất theo mã · màu · size — ${formatNumber(shown.length)} mã`}
      description={`${PENDING_MEASURE_LABEL[measure]}: ${measureText(grand, formatNumber)} cái · gõ định mức vải để tính lượng vải cần đặt theo màu`}
      hint={
        <>
          <p>
            <b>Chờ xuất</b> = số cái các đơn đã chốt đang giữ, hàng chưa rời kho (cùng cột &ldquo;đã chốt&rdquo; của sổ kho). <b>Thiếu</b> = phần chờ xuất mà tồn thực tế không đủ phân. <b>Cần đặt thêm</b> = thiếu − hàng đã đặt xưởng chưa về.
          </p>
          <p className="mt-1.5">Mua vải theo <b>Cần đặt thêm</b>; tính theo <b>Chờ xuất</b> là mua vải cho cả những chiếc kho đang có sẵn.</p>
          <p className="mt-1.5">
            &ldquo;+?&rdquo; = có mẫu chưa có phiếu nhập nên không biết thiếu bao nhiêu — phần đó KHÔNG được tính vào vải. Định mức vải chỉ lưu trên trình duyệt này, không lưu vào ERP.
          </p>
        </>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border p-0.5" role="group" aria-label="Con số đang xem">
            {PENDING_MEASURES.map((m) => (
              <button
                key={m}
                type="button"
                title={PENDING_MEASURE_HINT[m]}
                onClick={() => void setMeasure(m)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap", measure === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {PENDING_MEASURE_LABEL[m]}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã / tên" className="h-8 w-40 pl-7 text-xs" />
          </div>
          <Button variant="outline" size="sm" onClick={copyAll} disabled={!shown.length}>
            <Copy className="size-4" /> Sao chép tất cả
          </Button>
        </div>
      }
      padded={false}
    >
      {shown.length === 0 ? (
        <EmptyState title={matrices.length ? `Không mã nào có số "${PENDING_MEASURE_LABEL[measure]}"` : "Không có hàng chờ xuất"} description={matrices.length ? "Đổi sang con số khác hoặc xoá ô tìm kiếm." : "Mọi đơn đã chốt đều đã rời kho."} className="m-4" />
      ) : (
        <div className="divide-y">
          {shown.map((m) => (
            <ProductMatrix key={m.productId} m={m} measure={measure} norm={norms[m.productId] ?? EMPTY_FABRIC_NORM} onNorm={(patch) => setNorm(m.productId, patch)} />
          ))}
        </div>
      )}
      {orphanUnits ? (
        <p className="border-t px-5 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          ⚠ {formatNumber(orphanUnits)} cái chờ xuất thuộc {formatNumber(orphanVariants)} mẫu KHÔNG còn trong danh mục — không biết mã / màu / size nên không xếp được vào bảng. Đồng bộ lại sản phẩm từ Pancake để chúng hiện ra.
        </p>
      ) : null}
    </SectionCard>
  );
}

function ProductMatrix({ m, measure, norm, onNorm }: { m: PendingMatrix; measure: PendingMeasure; norm: FabricNorm; onNorm: (patch: Partial<FabricNorm>) => void }) {
  const plan = fabricPlan(m, measure, norm);
  const hasNorm = norm.common !== null || Object.values(norm.bySize).some((x) => x !== null && x !== undefined);
  const unit = norm.unit || "m";
  const cell = (v: { qty: number; unknown: number }, strong = false) => (
    <span className={cn(v.qty === 0 && v.unknown === 0 && "text-muted-foreground/50", strong && "font-bold", v.unknown > 0 && "text-amber-700 dark:text-amber-300")} title={v.unknown > 0 ? `${formatNumber(v.unknown)} cái chưa biết tồn (mẫu chưa có phiếu nhập)` : undefined}>
      {measureText(v, formatNumber)}
    </span>
  );

  return (
    <div className="px-5 py-3.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-semibold">{m.productCode || m.productName}</span>
          {m.productCode ? <span className="ml-1.5 text-sm text-muted-foreground">{m.productName}</span> : null}
          <span className="ml-2 text-xs text-muted-foreground">
            {PENDING_MEASURE_LABEL[measure]} <b className="text-foreground">{measureText(measureOf(m.total, measure), formatNumber)}</b> cái
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <label className="flex items-center gap-1 text-muted-foreground">
            Định mức chung
            <Input inputMode="decimal" defaultValue={numText(norm.common)} key={`c-${numText(norm.common)}`} onBlur={(e) => onNorm({ common: parseNum(e.target.value) })} className="h-7 w-16 px-2 text-right text-xs" placeholder="—" aria-label={`Định mức vải chung / cái của ${m.productCode}`} />
          </label>
          <select value={unit} onChange={(e) => onNorm({ unit: e.target.value })} className="h-7 rounded-md border bg-transparent px-1 text-xs" aria-label="Đơn vị vải">
            {FABRIC_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}/cái
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-muted-foreground">
            Hao hụt
            <Input inputMode="decimal" defaultValue={numText(norm.wastePct)} key={`w-${numText(norm.wastePct)}`} onBlur={(e) => onNorm({ wastePct: parseNum(e.target.value) })} className="h-7 w-12 px-2 text-right text-xs" placeholder="0" aria-label="Hao hụt phần trăm" />%
          </label>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => copy(pendingMatrixAsText(m, measure, norm), `bảng ${m.productCode || m.productName}`)}>
            <Copy className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-auto border-collapse text-sm tabular-nums">
          <thead>
            <tr className="border-b text-[11px] text-muted-foreground">
              <th className="py-1.5 pr-3 text-left font-semibold">Màu \ Size</th>
              {m.sizes.map((s) => (
                <th key={s} className="min-w-[52px] px-2 py-1.5 text-right font-semibold">
                  {s}
                </th>
              ))}
              <th className="min-w-[60px] px-2 py-1.5 text-right font-semibold text-foreground">Tổng màu</th>
              <th className="min-w-[84px] px-2 py-1.5 text-right font-semibold text-foreground">
                Vải ({unit})
                <InfoHint label="Cách tính vải">Vải của màu = Σ theo size (số cái × định mức size) × (1 + hao hụt), làm tròn lên 0,1. Size có hàng mà chưa khai định mức (kể cả định mức chung) thì màu đó chưa tính được — in &ldquo;—&rdquo;, không in một con số thiếu.</InfoHint>
              </th>
            </tr>
          </thead>
          <tbody>
            {m.colors.map((c, i) => {
              const sw = colorSwatch(c);
              const line = plan.lines[i];
              return (
                <tr key={c} className="border-b border-hairline">
                  <td className="py-1.5 pr-3 whitespace-nowrap">
                    <span className="mr-1.5 inline-block size-2.5 rounded-full border align-middle" style={{ background: sw.bg }} />
                    {c}
                  </td>
                  {m.sizes.map((s) => (
                    <td key={s} className="px-2 py-1.5 text-right">
                      {cell(measureOf(m.cells[cellKey(c, s)], measure))}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right">{cell(measureOf(m.byColor[c], measure), true)}</td>
                  <td className="px-2 py-1.5 text-right font-semibold">{line.fabric === null ? <span className="text-muted-foreground" title="Còn size chưa khai định mức">—</span> : hasNorm ? fmtFabric(line.fabric) : <span className="text-muted-foreground">—</span>}</td>
                </tr>
              );
            })}
            <tr className="border-b bg-surface-sunken/40 font-semibold">
              <td className="py-1.5 pr-3">Tổng size</td>
              {m.sizes.map((s) => (
                <td key={s} className="px-2 py-1.5 text-right">
                  {cell(measureOf(m.bySize[s], measure))}
                </td>
              ))}
              <td className="px-2 py-1.5 text-right">{cell(measureOf(m.total, measure), true)}</td>
              <td className={cn("px-2 py-1.5 text-right font-bold", plan.total !== null && hasNorm ? "text-primary" : "text-muted-foreground")}>{plan.total !== null && hasNorm ? fmtFabric(plan.total) : "—"}</td>
            </tr>
            <tr className="text-xs text-muted-foreground">
              <td className="py-1.5 pr-3 whitespace-nowrap">Định mức {unit}/cái</td>
              {m.sizes.map((s) => (
                <td key={s} className="px-1 py-1">
                  <Input
                    inputMode="decimal"
                    defaultValue={numText(norm.bySize[s])}
                    key={`${s}-${numText(norm.bySize[s])}`}
                    onBlur={(e) => onNorm({ bySize: { ...norm.bySize, [s]: parseNum(e.target.value) } })}
                    placeholder={numText(norm.common) || "—"}
                    className="h-7 w-14 px-1.5 text-right text-xs"
                    aria-label={`Định mức vải size ${s}`}
                  />
                </td>
              ))}
              <td colSpan={2} className="px-2 py-1 text-[11px]">
                size trống = định mức chung
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {hasNorm && plan.missingSizes.length ? <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">Chưa khai định mức cho size {plan.missingSizes.join(", ")} — màu có size đó chưa tính được vải.</p> : null}
      {plan.unknown > 0 ? <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">+? = {formatNumber(plan.unknown)} cái thuộc mẫu chưa có phiếu nhập — không biết thiếu bao nhiêu nên KHÔNG tính vào vải; kho lập phiếu nhập thì ERP mới tính được.</p> : null}
    </div>
  );
}
