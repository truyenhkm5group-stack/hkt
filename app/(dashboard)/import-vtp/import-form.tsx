"use client";

import { AlertTriangle, CheckCircle2, FileUp, Loader2, ShieldCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { importVtpDataFiles, previewVtpDataFiles, type ImportPreview, type VtpImportFileResult } from "@/lib/actions/cod-statements";
import { MAX_LIST_FILES, MAX_LIST_RAW_BYTES } from "@/lib/constants/cod";
import { PREVIEW_VERDICT_HINT, PREVIEW_VERDICT_LABEL, PREVIEW_VERDICT_ORDER, PREVIEW_VERDICT_TONE } from "@/lib/constants/vtp-import";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { formatDateTime, formatNumber, MISSING_TEXT } from "@/lib/format";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<VtpImportFileResult["kind"], string> = {
  ORDER_LIST: "Danh sách vận đơn",
  STATEMENT_DETAIL: "Chi tiết bảng kê COD",
  ERROR: "Không đọc được",
};

async function fileToBase64(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Picked = { filename: string; base64: string };

/**
 * ═══════════ NHẬP TỆP VIETTEL POST: XEM TRƯỚC RỒI MỚI GHI ═══════════
 *
 * Trước bản này form chỉ có một bước — chọn tệp là ghi thẳng. Nhập tệp là đường CỨU khi webhook
 * rơi và tài khoản API không đọc được vận đơn Pancake tạo, nhưng nó cũng là đường duy nhất mà một
 * người, bằng một cú bấm, đổi trạng thái hàng trăm vận đơn bằng nội dung một tệp chưa ai đọc.
 *
 * Bước xem trước CHỈ ĐỌC và dùng lại đúng trình đọc + bộ ghép mà đường ghi dùng, nên con số ở hai
 * bước không thể lệch nhau vì hai luật khác nhau.
 */
export function VtpImportForm() {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [previews, setPreviews] = useState<ImportPreview[] | null>(null);
  const [files, setFiles] = useState<VtpImportFileResult[] | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setPicked([]);
    setPreviews(null);
    setFiles(null);
  };

  const onFiles = async (list: FileList | null) => {
    const chosen = list ? Array.from(list) : [];
    if (!chosen.length) return;
    setPreviews(null);
    setFiles(null);
    if (chosen.length > MAX_LIST_FILES) {
      toast.error(`Đang chọn ${chosen.length} tệp, tối đa ${MAX_LIST_FILES} tệp mỗi lượt`);
      return;
    }
    const bytes = chosen.reduce((sum, f) => sum + f.size, 0);
    if (bytes > MAX_LIST_RAW_BYTES) {
      toast.error(`Tổng ${(bytes / 1_000_000).toFixed(1)} MB, tối đa ${(MAX_LIST_RAW_BYTES / 1_000_000).toFixed(1)} MB mỗi lượt`);
      return;
    }
    const payload: Picked[] = await Promise.all(chosen.map(async (f) => ({ base64: await fileToBase64(f), filename: f.name })));
    setPicked(payload);
    start(async () => {
      const result = await previewVtpDataFiles(payload);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setPreviews(result.previews);
      const doi = result.previews.reduce((sum, p) => sum + p.counts.NEWER, 0);
      toast.success(doi ? `Chạy thử xong — ${formatNumber(doi)} vận đơn sẽ được cập nhật` : "Chạy thử xong — không có vận đơn nào cần cập nhật");
    });
  };

  const apply = () => {
    if (!picked.length) return;
    start(async () => {
      const result = await importVtpDataFiles(picked);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setFiles(result.files);
      setPreviews(null);
      const bad = result.files.filter((f) => f.kind === "ERROR").length;
      toast.success(`Đã ghi ${result.files.length - bad}/${result.files.length} tệp · ${formatNumber(result.orderRows)} dòng vận đơn · ${formatNumber(result.statementRows)} dòng bảng kê`);
      if (bad) toast.warning(`${bad} tệp không đọc được — xem lý do trong bảng`);
    });
  };

  const tongMoi = previews?.reduce((s, p) => s + p.counts.NEWER, 0) ?? 0;
  const daGhiTruoc = previews?.filter((p) => p.previouslyAppliedAt) ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="vtp-files">Chọn tệp Excel/CSV tải từ Viettel Post — cả hai loại, nhiều tệp cùng lúc (tối đa {MAX_LIST_FILES})</Label>
        <Input id="vtp-files" type="file" multiple accept=".xlsx,.xls,.csv,.txt" onChange={(e) => onFiles(e.target.files)} disabled={pending} />
        <p className="text-[11px] text-muted-foreground">
          Không cần chọn loại tệp: ERP tự nhận <strong>Danh sách vận đơn</strong> (có cột Trạng thái) hay
          <strong> Chi tiết bảng kê COD</strong> (có cột Tiền thu về). Chọn tệp xong ERP <strong>chạy thử trước</strong> — chưa ghi gì cả.
        </p>
        {picked.length ? <p className="text-[11px] text-muted-foreground">Đã chọn: {picked.map((p) => p.filename).join(", ")}</p> : null}
      </div>

      {pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Đang đọc tệp…
        </p>
      ) : null}

      {previews ? (
        <div className="space-y-3 rounded-xl border border-brand/40 bg-brand/5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="size-4 text-brand" />
            <span className="text-sm font-semibold">Chạy thử — chưa ghi một dòng nào</span>
            <Badge variant="secondary">{formatNumber(previews.reduce((s, p) => s + p.rows, 0))} dòng đọc được</Badge>
          </div>

          {daGhiTruoc.length ? (
            /* Idempotent không phải là một lời hứa trừu tượng: nói thẳng tệp này đã được ghi rồi. */
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
              {daGhiTruoc.map((p) => `${p.filename} đã được ghi lúc ${formatDateTime(p.previouslyAppliedAt)}`).join(" · ")}. Ghi lại cùng tệp
              không tạo thêm dòng lịch sử nào — chống trùng nằm ở khoá (vận đơn, nguồn, trạng thái, mốc ĐVVC).
            </p>
          ) : null}

          {previews.map((p) => (
            <KhoiXemTruoc key={`${p.filename}-${p.checksum}`} p={p} />
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={apply} disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Ghi vào ERP{tongMoi ? ` · ${formatNumber(tongMoi)} vận đơn cập nhật` : ""}
            </Button>
            <Button size="sm" variant="outline" onClick={reset} disabled={pending}>
              Huỷ, chọn tệp khác
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Ghi vào ERP <strong>không bao giờ hạ</strong> trạng thái bằng một dòng tệp cũ hơn — dòng đó vẫn vào lịch sử.
            </span>
          </div>
        </div>
      ) : null}

      {files ? (
        <div className="overflow-x-auto rounded-md border">
          <div className="flex items-center gap-2 border-b bg-emerald-50 px-3 py-2 text-[12.5px] font-medium text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            <CheckCircle2 className="size-4" /> Đã ghi vào ERP
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tệp</TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Giai đoạn</TableHead>
                <TableHead className="text-right">Dòng</TableHead>
                <TableHead className="text-right">Đã ghi</TableHead>
                <TableHead>Kết quả</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f.filename} className={f.kind === "ERROR" ? "opacity-70" : ""}>
                  <TableCell className="max-w-[220px] truncate text-xs">{f.filename}</TableCell>
                  <TableCell>
                    <Badge variant={f.kind === "ERROR" ? "outline" : "secondary"}>{KIND_LABEL[f.kind]}</Badge>
                  </TableCell>
                  <TableCell className="numeric text-xs">
                    {f.periodFrom && f.periodTo ? `${f.periodFrom} → ${f.periodTo}` : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="numeric text-right">{formatNumber(f.rows)}</TableCell>
                  <TableCell className="numeric text-right">
                    {formatNumber(f.applied)}
                    {f.withCash ? <span className="block text-[10.5px] text-muted-foreground">{formatNumber(f.withCash)} có tiền thực thu</span> : null}
                  </TableCell>
                  <TableCell className={cn("max-w-[420px] text-xs", f.kind === "ERROR" ? "text-destructive" : "text-muted-foreground")}>
                    {f.matchedBatch ? <span className="mr-1 font-medium text-foreground">{f.matchedBatch}</span> : null}
                    {f.note}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      {!previews && !files && !pending ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <FileUp className="size-5" /> Chọn tệp để bắt đầu. ERP đọc thử trước và cho xem tệp sẽ đổi gì; chỉ khi bạn bấm
          &ldquo;Ghi vào ERP&rdquo; mới có dữ liệu được ghi.
        </p>
      ) : null}

      {files ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={reset} disabled={pending}>
            Nhập tệp khác
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ═══════════ MỘT TỆP, MỘT KHỐI — VÀ NHÓM LẠI THEO PHÁN QUYẾT ═══════════
 *
 * Một tệp Viettel Post thật có 1.198 dòng (đo 16/09/2026). Đổ cả nghìn dòng vào một bảng phẳng thì
 * người bấm không đọc, và không đọc nghĩa là bước xem trước không còn công dụng gì.
 *
 * Nên bảng mẫu CHỈ giữ dòng KHÁC với thứ ERP đang giữ — dòng "giống ERP" không có gì để xem và đã
 * bị loại ngay ở `previewVtpOrderListFile`. Trên đó là các ô đếm, BẤM ĐƯỢC: người muốn xem riêng
 * "cũ hơn ERP" hay "cần người quyết" thì lọc thẳng ở đây.
 *
 * Bốn phán quyết `SAME` · `DUPLICATE_ROW` · `OLDER` · `UNKNOWN_STATUS` KHÔNG phải lỗi (luật 49) và
 * không được gộp thành một nhãn "bỏ qua" — mỗi cái nói một chuyện khác, và gộp lại thì người đọc
 * không biết tệp có vấn đề hay chính ERP có vấn đề.
 */
function KhoiXemTruoc({ p }: { p: ImportPreview }) {
  const [loc, setLoc] = useState<string | null>(null);
  const mau = loc ? p.sample.filter((r) => r.verdict === loc) : p.sample;

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-semibold">{p.filename}</span>
        <Badge variant={p.error ? "outline" : "secondary"}>{KIND_LABEL[p.kind]}</Badge>
        <span className="text-[11px] text-muted-foreground">
          {formatNumber(p.rows)} dòng · mã tệp {p.checksum.slice(0, 12)}…
        </span>
      </div>
      {p.error ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {p.error}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {PREVIEW_VERDICT_ORDER.filter((v) => p.counts[v] > 0).map((v) => {
              // Nhóm "giống ERP" không lọc được: nó cố ý KHÔNG có dòng nào trong bảng mẫu.
              const coDong = p.sample.some((r) => r.verdict === v);
              return (
                <button
                  key={v}
                  type="button"
                  disabled={!coDong}
                  onClick={() => setLoc(loc === v ? null : v)}
                  title={coDong ? PREVIEW_VERDICT_HINT[v] : `${PREVIEW_VERDICT_HINT[v]} — nhóm này không có dòng nào để xem`}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[11.5px] font-medium transition-opacity",
                    PREVIEW_VERDICT_TONE[v],
                    loc === v && "ring-2 ring-foreground/40",
                    !coDong && "cursor-default opacity-60",
                  )}
                >
                  {PREVIEW_VERDICT_LABEL[v]}: {formatNumber(p.counts[v])}
                </button>
              );
            })}
            {loc ? (
              <button type="button" onClick={() => setLoc(null)} className="rounded-md px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground underline">
                bỏ lọc
              </button>
            ) : null}
          </div>
          {mau.length ? (
            <div className="mt-2 max-h-72 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mã vận đơn</TableHead>
                    <TableHead>Kết luận</TableHead>
                    <TableHead>VTP nói (nguyên văn)</TableHead>
                    <TableHead>ERP đang giữ</TableHead>
                    <TableHead>Vì sao</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mau.map((r, i) => (
                    <TableRow key={`${r.trackingCode}-${i}`}>
                      <TableCell className="font-mono text-[11.5px]">
                        {r.trackingCode}
                        {r.orderLabel ? <span className="block text-[10.5px] text-muted-foreground">{r.orderLabel}</span> : null}
                      </TableCell>
                      <TableCell>
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", PREVIEW_VERDICT_TONE[r.verdict])}>{PREVIEW_VERDICT_LABEL[r.verdict]}</span>
                      </TableCell>
                      <TableCell className="text-[11.5px]">
                        {r.fileStatusText || MISSING_TEXT}
                        <span className="block text-[10.5px] text-muted-foreground">{r.fileStatusAt ?? MISSING_TEXT}</span>
                      </TableCell>
                      <TableCell className="text-[11.5px]">
                        {r.erpStage ? SHIPMENT_STAGE_LABEL[r.erpStage] : MISSING_TEXT}
                        <span className="block text-[10.5px] text-muted-foreground">{r.erpStatusAt ? formatDateTime(new Date(r.erpStatusAt)) : MISSING_TEXT}</span>
                      </TableCell>
                      <TableCell className="max-w-[280px] text-[11px] text-muted-foreground">{r.note}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-muted-foreground">
              {loc ? "Nhóm này không có dòng nào để xem." : "Không dòng nào khác với thứ ERP đang giữ — ghi vào cũng không đổi gì."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
