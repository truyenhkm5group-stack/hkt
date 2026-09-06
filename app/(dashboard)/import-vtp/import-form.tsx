"use client";

import { FileUp, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { importVtpDataFiles, type VtpImportFileResult } from "@/lib/actions/cod-statements";
import { MAX_LIST_FILES, MAX_LIST_RAW_BYTES } from "@/lib/constants/cod";
import { formatNumber } from "@/lib/format";
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

export function VtpImportForm() {
  const [files, setFiles] = useState<VtpImportFileResult[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const onFiles = async (list: FileList | null) => {
    const chosen = list ? Array.from(list) : [];
    if (!chosen.length) return;
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
    setPicked(chosen.map((f) => f.name));
    const payload = await Promise.all(chosen.map(async (f) => ({ base64: await fileToBase64(f), filename: f.name })));
    start(async () => {
      const result = await importVtpDataFiles(payload);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setFiles(result.files);
      const bad = result.files.filter((f) => f.kind === "ERROR").length;
      toast.success(`Đã nhập ${result.files.length - bad}/${result.files.length} tệp · ${formatNumber(result.orderRows)} dòng vận đơn · ${formatNumber(result.statementRows)} dòng bảng kê`);
      if (bad) toast.warning(`${bad} tệp không đọc được — xem lý do trong bảng`);
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="vtp-files">Chọn tệp Excel/CSV tải từ Viettel Post — cả hai loại, nhiều tệp cùng lúc (tối đa {MAX_LIST_FILES})</Label>
        <Input id="vtp-files" type="file" multiple accept=".xlsx,.xls,.csv,.txt" onChange={(e) => onFiles(e.target.files)} disabled={pending} />
        <p className="text-[11px] text-muted-foreground">
          Không cần chọn loại tệp: ERP tự nhận <strong>Danh sách vận đơn</strong> (có cột Trạng thái) hay
          <strong> Chi tiết bảng kê COD</strong> (có cột Tiền thu về). Danh sách vận đơn được xử lý trước để bảng kê có vận đơn mà ghi tiền lên.
        </p>
        {picked.length ? <p className="text-[11px] text-muted-foreground">Đã chọn: {picked.join(", ")}</p> : null}
      </div>

      {pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Đang đọc và ghi dữ liệu…
        </p>
      ) : null}

      {files ? (
        <div className="overflow-x-auto rounded-md border">
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

      {!files && !pending ? (
        <p className="flex items-center gap-2 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          <FileUp className="size-5" /> Chọn tệp để bắt đầu. Nhập lại cùng một tệp nhiều lần không làm hỏng dữ liệu:
          dòng cũ hơn bị bỏ qua, dòng trùng không ghi lại.
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => { setFiles(null); setPicked([]); }} disabled={pending || !files}>
          Nhập tệp khác
        </Button>
      </div>
    </div>
  );
}
