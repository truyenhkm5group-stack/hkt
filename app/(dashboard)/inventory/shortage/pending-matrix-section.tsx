"use client";

import { Copy, Search } from "lucide-react";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { importFabricNorms, saveFabricNorm } from "@/lib/actions/fabric-norms";
import {
  EMPTY_FABRIC_NORM,
  FABRIC_UNITS,
  LEGACY_FABRIC_NORMS_KEY,
  PENDING_MEASURES,
  PENDING_MEASURE_HINT,
  PENDING_MEASURE_LABEL,
  fabricPlan,
  hasFabricQty,
  measureOf,
  measureText,
  pendingMatrixAsText,
  sameFabricNorm,
  type FabricNorm,
  type PendingMatrix,
  type PendingMeasure,
  type StoredFabricNorm,
} from "@/lib/constants/pending-matrix";
import { cellKey, colorSwatch } from "@/lib/constants/production";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Định mức vải là số người đặt vải gõ để TÍNH TRÊN MÀN HÌNH — không đi vào báo cáo / giá vốn nào.
 *
 * Từ OD-P2-04 nó lưu ở ERP (bảng `fabric_norms`), nên mọi người thấy cùng một số. Bản cũ lưu trong
 * `localStorage` của từng trình duyệt: màn hình chỉ ĐỌC khoá cũ để mời người có quyền bấm nhập MỘT
 * LẦN — không tự đẩy, không ghi lại, không xoá (bản dự phòng của người gõ).
 */
const DISMISS_KEY = `${LEGACY_FABRIC_NORMS_KEY}.dismissed`;

function readLegacy(): { raw: string; norms: Record<string, FabricNorm> } | null {
  try {
    const raw = window.localStorage.getItem(LEGACY_FABRIC_NORMS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const norms: Record<string, FabricNorm> = {};
    for (const [id, n] of Object.entries(parsed as Record<string, unknown>)) {
      if (n && typeof n === "object") norms[id] = { ...EMPTY_FABRIC_NORM, ...(n as Partial<FabricNorm>), bySize: { ...((n as Partial<FabricNorm>).bySize ?? {}) } };
    }
    return { raw, norms };
  } catch {
    return null;
  }
}

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(raw: string) {
  try {
    window.localStorage.setItem(DISMISS_KEY, raw);
  } catch {
    // Trình duyệt chặn lưu: lần sau lời mời hiện lại, không sao.
  }
}

const normsOf = (stored: Record<string, StoredFabricNorm>) => Object.fromEntries(Object.entries(stored).map(([id, s]) => [id, s.norm]));

/** Ô trống = chưa khai (null), không phải 0. Nhận cả dấu phẩy thập phân kiểu Việt. */
function parseNum(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Lượng vải: 0 mét / cái là ô chưa khai (phép tính vẫn coi vậy), không gửi lên như một con số. */
const parseQty = (s: string) => {
  const n = parseNum(s);
  return n === 0 ? null : n;
};

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

export function PendingMatrixSection({
  matrices,
  orphanUnits,
  orphanVariants,
  storedNorms,
  canWrite,
}: {
  matrices: PendingMatrix[];
  orphanUnits: number;
  orphanVariants: number;
  storedNorms: Record<string, StoredFabricNorm>;
  canWrite: boolean;
}) {
  const [measure, setMeasure] = useQueryState("m", parseAsStringLiteral(PENDING_MEASURES).withDefault("pending").withOptions({ history: "replace", clearOnDefault: true, scroll: false }));
  const [q, setQ] = useState("");
  const [norms, setNorms] = useState<Record<string, FabricNorm>>(() => normsOf(storedNorms));
  // Máy chủ dựng lại trang sau mỗi lượt lưu (`revalidatePath`) — số của ERP là số đúng.
  useEffect(() => setNorms(normsOf(storedNorms)), [storedNorms]);

  const setNorm = (productId: string, patch: Partial<FabricNorm>) => {
    const truoc = norms[productId] ?? EMPTY_FABRIC_NORM;
    const sau = { ...truoc, ...patch };
    setNorms((cur) => ({ ...cur, [productId]: sau }));
    void saveFabricNorm({ productId, ...sau }).then((r) => {
      if ("error" in r) {
        toast.error(r.error);
        setNorms((cur) => ({ ...cur, [productId]: truoc }));
      }
    });
  };

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
  const codeOf = useMemo(() => new Map(matrices.map((m) => [m.productId, m.productCode || m.productName])), [matrices]);

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
            &ldquo;+?&rdquo; = có mẫu chưa có phiếu nhập nên không biết thiếu bao nhiêu — phần đó KHÔNG được tính vào vải. Định mức vải lưu trên ERP: ai xem được trang này đều thấy cùng một số, chỉ người có quyền lập kế hoạch sửa được. Định mức chỉ dùng để tính vải ở đây, không vào giá vốn hay báo cáo nào.
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
      {canWrite ? <LegacyImportBanner storedNorms={storedNorms} codeOf={codeOf} /> : null}
      {shown.length === 0 ? (
        <EmptyState title={matrices.length ? `Không mã nào có số "${PENDING_MEASURE_LABEL[measure]}"` : "Không có hàng chờ xuất"} description={matrices.length ? "Đổi sang con số khác hoặc xoá ô tìm kiếm." : "Mọi đơn đã chốt đều đã rời kho."} className="m-4" />
      ) : (
        <div className="divide-y">
          {shown.map((m) => (
            <ProductMatrix key={m.productId} m={m} measure={measure} norm={norms[m.productId] ?? EMPTY_FABRIC_NORM} stored={storedNorms[m.productId]} canWrite={canWrite} onNorm={(patch) => setNorm(m.productId, patch)} />
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

function ProductMatrix({
  m,
  measure,
  norm,
  stored,
  canWrite,
  onNorm,
}: {
  m: PendingMatrix;
  measure: PendingMeasure;
  norm: FabricNorm;
  stored: StoredFabricNorm | undefined;
  canWrite: boolean;
  onNorm: (patch: Partial<FabricNorm>) => void;
}) {
  const plan = fabricPlan(m, measure, norm);
  const hasNorm = norm.common !== null || Object.values(norm.bySize).some((x) => x !== null && x !== undefined);
  const khoa = !canWrite;
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
          {stored?.updatedAt ? (
            <span className="ml-2 text-[11px] text-muted-foreground">
              · định mức sửa lúc {formatDateTime(stored.updatedAt)}
              {stored.updatedByName ? ` bởi ${stored.updatedByName}` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <label className="flex items-center gap-1 text-muted-foreground">
            Định mức chung
            <Input inputMode="decimal" defaultValue={numText(norm.common)} key={`c-${numText(norm.common)}`} onBlur={(e) => onNorm({ common: parseQty(e.target.value) })} disabled={khoa} className="h-7 w-16 px-2 text-right text-xs" placeholder="—" aria-label={`Định mức vải chung / cái của ${m.productCode}`} />
          </label>
          <select value={unit} onChange={(e) => onNorm({ unit: e.target.value })} disabled={khoa} className="h-7 rounded-md border bg-transparent px-1 text-xs" aria-label="Đơn vị vải">
            {FABRIC_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}/cái
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-muted-foreground">
            Hao hụt
            <Input inputMode="decimal" defaultValue={numText(norm.wastePct)} key={`w-${numText(norm.wastePct)}`} onBlur={(e) => onNorm({ wastePct: parseNum(e.target.value) })} disabled={khoa} className="h-7 w-12 px-2 text-right text-xs" placeholder="0" aria-label="Hao hụt phần trăm" />%
          </label>
          <Button variant="ghost" size="sm" className="h-7 px-2" aria-label={`Sao chép bảng ${m.productCode || m.productName}`} title="Sao chép bảng" onClick={() => copy(pendingMatrixAsText(m, measure, norm), `bảng ${m.productCode || m.productName}`)}>
            <Copy className="size-3.5" aria-hidden />
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
                    onBlur={(e) => onNorm({ bySize: { ...norm.bySize, [s]: parseQty(e.target.value) } })}
                    disabled={khoa}
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

/**
 * LỜI MỜI NHẬP MỘT LẦN — chỉ người có `planning:write` thấy (trang chỉ dựng khối này khi có quyền).
 *
 * Đếm hai nhóm, khác việc phải làm:
 *   · CHƯA CÓ trên ERP  → bấm "Nhập vào ERP" (máy chủ chỉ chèn sản phẩm ERP chưa có dòng);
 *   · KHÁC SỐ với ERP   → ERP thắng, không ghi đè; in mã để người xem lại và sửa tay nếu cần.
 * "Ẩn" chỉ nhớ trên trình duyệt này và chỉ cho ĐÚNG bản `localStorage` đang có.
 */
function LegacyImportBanner({ storedNorms, codeOf }: { storedNorms: Record<string, StoredFabricNorm>; codeOf: Map<string, string> }) {
  const [legacy, setLegacy] = useState<{ raw: string; norms: Record<string, FabricNorm> } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [pending, startTransition] = useTransition();
  // Đọc sau khi gắn vào trang: máy chủ không có localStorage, đọc lúc dựng là lệch HTML.
  useEffect(() => {
    const l = readLegacy();
    setLegacy(l);
    setHidden(Boolean(l && readDismissed() === l.raw));
  }, []);

  const { missing, differs } = useMemo(() => {
    const out = { missing: [] as string[], differs: [] as string[] };
    for (const [id, n] of Object.entries(legacy?.norms ?? {})) {
      if (!hasFabricQty(n)) continue;
      const tren = storedNorms[id];
      if (!tren) out.missing.push(id);
      else if (!sameFabricNorm(tren.norm, n)) out.differs.push(id);
    }
    return out;
  }, [legacy, storedNorms]);

  if (!legacy || hidden || (!missing.length && !differs.length)) return null;

  const nhap = () =>
    startTransition(async () => {
      const r = await importFabricNorms({ entries: missing.map((productId) => ({ productId, norm: legacy.norms[productId] })) });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã nhập ${formatNumber(r.imported.length)} định mức · ${formatNumber(r.skippedExisting.length)} ERP đã có (ERP thắng) · ${formatNumber(r.invalid.length)} không hợp lệ`);
      if (r.invalid.length) toast.warning(r.invalid.slice(0, 3).map((x) => `${codeOf.get(x.productId) ?? x.productId}: ${x.reason}`).join(" · "));
    });
  const ma = (ids: string[]) => ids.map((id) => codeOf.get(id) ?? "(mã không hiện ở đây)").slice(0, 8).join(", ") + (ids.length > 8 ? ` +${formatNumber(ids.length - 8)}` : "");

  return (
    <div className="m-4 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-3 text-xs dark:border-amber-700/60 dark:bg-amber-950/30">
      {missing.length ? (
        <p>
          Trình duyệt này còn <b>{formatNumber(missing.length)}</b> định mức vải gõ từ trước, CHƯA có trên ERP. Nhập lên để mọi người cùng thấy một số — ERP chỉ thêm mã chưa có, không ghi đè.
        </p>
      ) : null}
      {differs.length ? (
        <p className={cn(missing.length && "mt-1.5")}>
          <b>{formatNumber(differs.length)}</b> mã có số trên trình duyệt KHÁC số trên ERP — ERP thắng, không tự ghi đè: {ma(differs)}.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {missing.length ? (
          <Button size="sm" onClick={nhap} disabled={pending}>
            {pending ? "Đang nhập…" : `Nhập ${formatNumber(missing.length)} định mức vào ERP`}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            writeDismissed(legacy.raw);
            setHidden(true);
          }}
        >
          Ẩn
        </Button>
      </div>
    </div>
  );
}
