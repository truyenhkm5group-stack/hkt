"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download, FileUp, Globe, Loader2, PackageCheck, SearchCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui-bits";
import { checkProductImportAction, describeProductImportAction, productsFromWebsiteAction, runProductImportAction } from "@/lib/actions/product-import";
import { PRODUCT_UNIT_SUGGESTIONS } from "@/lib/constants/manual-products";
import { formatNumber, formatVND } from "@/lib/format";
import {
  IMPORT_CORE_TARGETS,
  IMPORT_SEMANTIC_CUSTOM_KEYS,
  IMPORT_TARGET_LABEL,
  PRODUCT_IMPORT_MAX_BYTES,
  productImportTemplateCsv,
  type ImportCheckResult,
  type ImportFileSummary,
  type ImportRowCheck,
  type ImportRunResult,
  type ImportTarget,
} from "@/lib/products/import-shared";
import { cn } from "@/lib/utils";

/**
 * Trình nhập sản phẩm từ tệp: chọn tệp → xem trước + ghép cột → Kiểm tra (chạy thử) → Nhập → Kết quả.
 * Trình duyệt chỉ chuyển byte và giữ lựa chọn ghép cột; MÁY CHỦ đọc tệp, kiểm và ghi ở từng lượt (không tin bảng kết quả
 * đang hiện trên màn hình). Đổi ghép cột / đơn vị mặc định ⇒ kết quả kiểm cũ bị bỏ, phải kiểm lại trước khi nhập.
 */

type FileState = { fileName: string; base64: string };

const STATUS_LABEL: Record<ImportRowCheck["status"], string> = { READY: "Sẽ tạo", EXISTS: "Đã có", ERROR: "Lỗi" };
const RUN_LABEL = { CREATED: "Đã tạo", EXISTS: "Đã có", ERROR: "Lỗi" } as const;

async function toBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(binary);
}

function downloadTemplate() {
  const blob = new Blob([productImportTemplateCsv()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "mau-nhap-san-pham.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function StatusBadge({ status }: { status: keyof typeof RUN_LABEL | ImportRowCheck["status"] }) {
  const label = status === "READY" ? STATUS_LABEL.READY : RUN_LABEL[status as keyof typeof RUN_LABEL];
  const tone =
    status === "ERROR"
      ? "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
      : status === "EXISTS"
        ? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
        : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
  return <Badge className={cn("border-0", tone)}>{label}</Badge>;
}

export function ImportWizard({ canWriteStock }: { canWriteStock: boolean }) {
  const [pending, start] = useTransition();
  const [file, setFile] = useState<FileState | null>(null);
  const [summary, setSummary] = useState<ImportFileSummary | null>(null);
  const [mapping, setMapping] = useState<(ImportTarget | null)[]>([]);
  const [defaultUnit, setDefaultUnit] = useState("cái");
  const [check, setCheck] = useState<ImportCheckResult | null>(null);
  const [result, setResult] = useState<ImportRunResult | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteUrl, setSiteUrl] = useState("");
  const [siteNote, setSiteNote] = useState<string | null>(null);

  const customKeys = useMemo(() => new Set(summary?.customFields.map((f) => f.key) ?? []), [summary]);
  const options = useMemo(() => {
    const core = IMPORT_CORE_TARGETS.map((t) => {
      const semanticMissing = (t === "package_size" || t === "category") && !customKeys.has(t);
      return { value: t as ImportTarget, label: semanticMissing ? `${IMPORT_TARGET_LABEL[t]} — chưa khai field, không lưu` : IMPORT_TARGET_LABEL[t] };
    });
    const custom = (summary?.customFields ?? [])
      .filter((f) => !(IMPORT_SEMANTIC_CUSTOM_KEYS as readonly string[]).includes(f.key))
      .map((f) => ({ value: `custom:${f.key}` as ImportTarget, label: `Field: ${f.label}${f.required ? " *" : ""}` }));
    return [...core, ...custom];
  }, [summary, customKeys]);

  const reset = () => {
    setSummary(null);
    setMapping([]);
    setCheck(null);
    setResult(null);
    setError(null);
  };

  const onFile = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    reset();
    if (f.size > PRODUCT_IMPORT_MAX_BYTES) {
      setError(`Tệp ${(f.size / 1024 / 1024).toFixed(1)} MB — tối đa 2 MB mỗi lượt. Chia tệp rồi nhập từng phần.`);
      return;
    }
    setSiteNote(null);
    load({ fileName: f.name, base64: await toBase64(f) });
  };

  /** Tệp (chọn từ máy hoặc dựng từ website) ⇒ bước 1 của trình nhập. */
  const load = (state: FileState) => {
    setFile(state);
    start(async () => {
      const r = await describeProductImportAction(state);
      if (!("ok" in r)) {
        setError(r.error);
        return;
      }
      setSummary(r);
      setMapping(r.suggested);
    });
  };

  /** Link website ⇒ máy chủ đọc sản phẩm ⇒ tệp CSV đúng khuôn mẫu ⇒ đi tiếp đúng các bước như tệp thường. */
  const fromWebsite = () => {
    reset();
    setSiteNote(null);
    start(async () => {
      const r = await productsFromWebsiteAction(siteUrl);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setSiteNote(r.message);
      load({ fileName: r.fileName, base64: r.base64 });
    });
  };

  const setCol = (i: number, v: string) => {
    setMapping((prev) => prev.map((x, j) => (j === i ? ((v || null) as ImportTarget | null) : x)));
    setCheck(null);
    setResult(null);
  };

  const runCheck = () => {
    if (!file) return;
    setError(null);
    setResult(null);
    start(async () => {
      const r = await checkProductImportAction(file, { mapping, defaultUnit });
      if (!("ok" in r)) {
        setError(r.error);
        return;
      }
      setCheck(r);
    });
  };

  const runImport = () => {
    if (!file || !check) return;
    setError(null);
    start(async () => {
      const r = await runProductImportAction(file, { mapping, defaultUnit }, check.checksum);
      if (!("ok" in r)) {
        setError(r.error);
        return;
      }
      setResult(r);
      setCheck(null);
      toast.success(`Đã tạo ${formatNumber(r.counts.created)} sản phẩm`);
    });
  };

  const shownRows = check ? (onlyProblems ? check.rows.filter((r) => r.status !== "READY" || r.warnings.length > 0) : check.rows) : [];
  const errOf = (row: ImportRowCheck, field: string) => row.errors.filter((e) => e.field === field);
  const cellCls = (row: ImportRowCheck, field: string) => (errOf(row, field).length ? "bg-rose-50 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200" : "");

  return (
    <div className="space-y-5">
      {/* ── Bước 1: tệp ── */}
      <SectionCard
        title="1 · Chọn tệp"
        description="CSV (UTF-8, dấu phẩy / chấm phẩy / tab) hoặc Excel .xlsx — dòng đầu là tiêu đề cột"
        actions={
          <Button type="button" variant="outline" size="sm" onClick={downloadTemplate}>
            <Download className="size-4" /> Tải tệp mẫu CSV
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="pi-file" className="sr-only">
            Tệp sản phẩm
          </Label>
          <Input id="pi-file" type="file" accept=".csv,.txt,.xlsx,.xls,text/csv" className="max-w-md" disabled={pending} onChange={(e) => void onFile(e.target.files)} />
          {pending && !summary ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Đang đọc tệp…
            </span>
          ) : null}
          {summary ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileUp className="size-3.5" /> {summary.fileName} · {summary.kind}
              {summary.delimiter ? ` · phân cách "${summary.delimiter === "\t" ? "tab" : summary.delimiter}"` : ""} · {formatNumber(summary.totalRows)} dòng · SHA-256 {summary.checksum.slice(0, 12)}…
            </span>
          ) : null}
        </div>
        <div className="mt-4 space-y-1.5 border-t pt-4" data-testid="product-import-website">
          <Label htmlFor="pi-site" className="flex items-center gap-1.5 text-sm">
            <Globe className="size-4" /> Hoặc lấy từ website của shop
          </Label>
          <p className="text-xs text-muted-foreground">
            Dán link website (Shopify, Haravan, WooCommerce) hoặc một trang sản phẩm — máy đọc tên, SKU, giá, danh mục rồi đưa vào các bước bên dưới để bạn
            kiểm trước khi nhập.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input id="pi-site" value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="shopcuaban.vn" maxLength={500} className="max-w-md" disabled={pending} />
            <Button type="button" variant="outline" onClick={fromWebsite} disabled={pending || !siteUrl.trim()}>
              {pending && !summary ? <Loader2 className="size-4 animate-spin" /> : <Globe className="size-4" />} Đọc từ website
            </Button>
          </div>
          {siteNote ? <p className="text-xs text-emerald-700 dark:text-emerald-400">{siteNote}</p> : null}
        </div>
        {error ? (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
          </p>
        ) : null}
      </SectionCard>

      {/* ── Bước 2: ghép cột + xem trước ── */}
      {summary ? (
        <SectionCard title="2 · Ghép cột" description={`Chọn ô đích cho từng cột — xem trước ${formatNumber(summary.preview.length)}/${formatNumber(summary.totalRows)} dòng đầu`}>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="pi-unit" className="text-xs">
                Đơn vị tính mặc định (dòng không có cột đơn vị)
              </Label>
              <Input
                id="pi-unit"
                list="pi-unit-suggest"
                value={defaultUnit}
                onChange={(e) => {
                  setDefaultUnit(e.target.value);
                  setCheck(null);
                }}
                className="h-8 w-40"
              />
              <datalist id="pi-unit-suggest">
                {PRODUCT_UNIT_SUGGESTIONS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </div>
            {!canWriteStock ? <p className="text-xs text-amber-700 dark:text-amber-300">Bạn chưa có quyền nhập kho — cột Tồn đầu (nếu ghép) sẽ báo lỗi.</p> : null}
          </div>
          <div className="max-h-[420px] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  {summary.headers.map((h, i) => (
                    <th key={i} className="min-w-40 border-b px-2 py-1.5 text-left align-top font-medium">
                      <div className="mb-1 truncate" title={h}>
                        {h}
                      </div>
                      <select
                        aria-label={`Ô đích của cột ${h}`}
                        className={cn("h-7 w-full rounded-md border bg-background px-1.5 text-xs", mapping[i] ? "border-primary/60" : "text-muted-foreground")}
                        value={mapping[i] ?? ""}
                        onChange={(e) => setCol(i, e.target.value)}
                        disabled={pending}
                      >
                        <option value="">— Bỏ qua —</option>
                        {options.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.preview.map((r, ri) => (
                  <tr key={ri} className="border-b last:border-0">
                    {summary.headers.map((_, ci) => (
                      <td key={ci} className={cn("max-w-56 truncate px-2 py-1", !mapping[ci] && "text-muted-foreground/60")} title={r[ci]}>
                        {r[ci]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button type="button" onClick={runCheck} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <SearchCheck className="size-4" />} Kiểm tra
            </Button>
            <span className="text-xs text-muted-foreground">Chạy thử trên toàn bộ tệp — chưa ghi gì vào ERP.</span>
          </div>
        </SectionCard>
      ) : null}

      {/* ── Bước 3: kết quả kiểm ── */}
      {check ? (
        <SectionCard
          title="3 · Kết quả kiểm"
          description={`${formatNumber(check.counts.ready)} sẽ tạo · ${formatNumber(check.counts.exists)} đã có (bỏ qua) · ${formatNumber(check.counts.error)} lỗi`}
          actions={
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Chỉ dòng lỗi / cảnh báo
            </label>
          }
        >
          {check.mappingErrors.length ? (
            <ul className="mb-3 space-y-1 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
              {check.mappingErrors.map((m, i) => (
                <li key={i}>• {m}</li>
              ))}
            </ul>
          ) : null}
          {check.warnings.length ? (
            <ul className="mb-3 space-y-1 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
              {check.warnings.map((m, i) => (
                <li key={i}>• {m}</li>
              ))}
            </ul>
          ) : null}
          <div className="max-h-[520px] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-left">
                <tr>
                  <th className="px-2 py-1.5">Dòng</th>
                  <th className="px-2 py-1.5">Trạng thái</th>
                  <th className="px-2 py-1.5">Tên sản phẩm</th>
                  <th className="px-2 py-1.5">SKU</th>
                  <th className="px-2 py-1.5 text-right">Giá bán</th>
                  <th className="px-2 py-1.5 text-right">Giá vốn</th>
                  <th className="px-2 py-1.5">Đơn vị</th>
                  <th className="px-2 py-1.5 text-right">Tồn đầu</th>
                  <th className="px-2 py-1.5">Field tuỳ biến</th>
                  <th className="px-2 py-1.5">Lỗi / cảnh báo</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((r) => (
                  <tr key={r.line} className="border-b align-top last:border-0">
                    <td className="numeric px-2 py-1">{r.line}</td>
                    <td className="px-2 py-1">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className={cn("px-2 py-1", cellCls(r, "name"))}>{r.name || "—"}</td>
                    <td className={cn("px-2 py-1 font-mono", cellCls(r, "sku"))}>
                      {r.sku || "—"}
                      {r.skuGenerated && r.sku ? <span className="ml-1 rounded bg-sky-100 px-1 font-sans text-[10px] text-sky-800 dark:bg-sky-950 dark:text-sky-200">tự sinh</span> : null}
                    </td>
                    <td className={cn("numeric px-2 py-1 text-right", cellCls(r, "price"))}>{formatVND(r.price)}</td>
                    <td className={cn("numeric px-2 py-1 text-right", cellCls(r, "cost"))}>{formatVND(r.cost)}</td>
                    <td className={cn("px-2 py-1", cellCls(r, "selling_unit"))}>
                      {r.unit || "—"}
                      {r.unitFromDefault ? <span className="ml-1 text-[10px] text-muted-foreground">(mặc định)</span> : null}
                    </td>
                    <td className={cn("numeric px-2 py-1 text-right", cellCls(r, "initial_stock"))}>{formatNumber(r.initialStock)}</td>
                    <td className="px-2 py-1">
                      {Object.entries(r.custom).map(([k, v]) => (
                        <div key={k} className={cn(errOf(r, `custom:${k}`).length && "text-rose-700 dark:text-rose-300")}>
                          <span className="text-muted-foreground">{k}:</span> {v}
                        </div>
                      ))}
                    </td>
                    <td className="px-2 py-1">
                      {r.errors.map((e, i) => (
                        <div key={`e${i}`} className="text-rose-700 dark:text-rose-300">
                          {e.message}
                        </div>
                      ))}
                      {r.warnings.map((w, i) => (
                        <div key={`w${i}`} className="text-amber-700 dark:text-amber-300">
                          {w}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" onClick={runImport} disabled={pending || check.counts.ready === 0 || check.mappingErrors.length > 0}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Nhập {formatNumber(check.counts.ready)} sản phẩm
            </Button>
            <span className="text-xs text-muted-foreground">
              Chỉ dòng «Sẽ tạo» được ghi; dòng lỗi và dòng đã có bị bỏ qua. Tồn đầu (nếu có) vào MỘT phiếu Nhập hàng —{" "}
              {check.receiptPricing === "MKT_QUOTE" ? "đơn giá theo giá báo MKT của tổ chức" : "đơn giá lấy từ cột Giá vốn, trống = chưa biết giá"}.
            </span>
          </div>
        </SectionCard>
      ) : null}

      {/* ── Bước 4: kết quả nhập ── */}
      {result ? (
        <SectionCard title="4 · Kết quả nhập" description={`${formatNumber(result.counts.created)} đã tạo · ${formatNumber(result.counts.exists)} đã có · ${formatNumber(result.counts.error)} lỗi`}>
          <div className="mb-3 space-y-1 text-sm">
            <p className="flex items-center gap-1.5">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" /> Tệp {result.fileName} · SHA-256 {result.checksum.slice(0, 12)}…
            </p>
            {result.receiptId ? (
              <p className="flex items-center gap-1.5">
                <PackageCheck className="size-4 text-emerald-600 dark:text-emerald-400" /> Phiếu Nhập hàng tồn đầu:{" "}
                <Link href="/inventory/receipts" className="font-mono text-primary underline-offset-2 hover:underline">
                  {result.receiptId}
                </Link>
                {result.missingPrice.length ? <span className="text-amber-700 dark:text-amber-300"> · chưa có đơn giá: {result.missingPrice.join(", ")}</span> : null}
              </p>
            ) : null}
            {result.receiptError ? (
              <p className="rounded-md bg-rose-50 px-3 py-2 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200">
                Phiếu tồn đầu KHÔNG ghi được: {result.receiptError} — sản phẩm đã tạo nhưng tồn còn «Chưa có phiếu nhập». Lập phiếu ở Nhập hàng / kiểm kê.
              </p>
            ) : null}
          </div>
          <div className="max-h-[520px] overflow-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted text-left">
                <tr>
                  <th className="px-2 py-1.5">Dòng</th>
                  <th className="px-2 py-1.5">Kết quả</th>
                  <th className="px-2 py-1.5">Tên sản phẩm</th>
                  <th className="px-2 py-1.5">SKU</th>
                  <th className="px-2 py-1.5 text-right">Tồn đầu</th>
                  <th className="px-2 py-1.5">Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.line} className="border-b align-top last:border-0">
                    <td className="numeric px-2 py-1">{r.line}</td>
                    <td className="px-2 py-1">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-2 py-1">
                      {r.productId ? (
                        <Link href={`/products/${encodeURIComponent(r.productId)}`} className="text-primary underline-offset-2 hover:underline">
                          {r.name}
                        </Link>
                      ) : (
                        r.name || "—"
                      )}
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {r.sku || "—"}
                      {r.skuGenerated && r.sku ? <span className="ml-1 rounded bg-sky-100 px-1 font-sans text-[10px] text-sky-800 dark:bg-sky-950 dark:text-sky-200">tự sinh</span> : null}
                    </td>
                    <td className="numeric px-2 py-1 text-right">{formatNumber(r.initialStock)}</td>
                    <td className="px-2 py-1">
                      {r.errors.map((e, i) => (
                        <div key={`e${i}`} className="text-rose-700 dark:text-rose-300">
                          {e.message}
                        </div>
                      ))}
                      {r.warnings.map((w, i) => (
                        <div key={`w${i}`} className="text-amber-700 dark:text-amber-300">
                          {w}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/products">Về danh sách sản phẩm</Link>
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
