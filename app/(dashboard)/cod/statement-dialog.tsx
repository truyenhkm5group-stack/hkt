"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { importVtpOrderListFiles, importVtpStatementDetailFiles, parseVtpStatementText, previewVtpOrderListFiles, previewVtpStatementDetailFiles, saveVtpStatements } from "@/lib/actions/cod-statements";
import { MAX_LIST_FILES, MAX_LIST_RAW_BYTES } from "@/lib/constants/cod";
import { formatVND } from "@/lib/format";
import type { StatementSummary } from "@/lib/integrations/viettelpost/statement";
import type { OrderListMatch, StatementFileMatch } from "@/lib/integrations/viettelpost/statement-db";
import { SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";

function fmtDate(key: string) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

/** Nhập bảng kê tiền COD Viettel Post: tổng hợp (dán bảng) hoặc chi tiết (file Excel/CSV từng vận đơn) */
export function StatementDialog({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [open, setOpen] = useState(defaultOpen);
  const router = useRouter();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FileSpreadsheet className="size-4" /> Bảng kê Viettel Post
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Bảng kê tiền COD Viettel Post</DialogTitle>
          <DialogDescription>
            Cách nhanh nhất: viettelpost.vn → Quản lý vận đơn → chọn khoảng ngày → Xuất Excel → tải lên ở tab đầu. ERP cập nhật trạng thái thật của từng vận đơn: Giao thành công, Đã trả / Đang chuyển hoàn / Đã duyệt hoàn (đơn hoàn), Chờ phát lại, Đang giao… và cước. Tỷ lệ hoàn tính lại theo trạng thái Viettel Post (GTC = giao thành công & COD &gt; 100K; hoàn = các trạng thái hoàn, hoặc VTP báo giao thành công nhưng doanh thu COD &lt; 50K (giao thành công hàng hoàn), hoặc COD 50K–100K (chỉ thu phí)). Hai tab còn lại dùng cho bảng kê “Tiền hàng đã trả”
            (tổng hợp theo ngày đối soát cho dòng tiền; chi tiết từng bảng kê để gắn vận đơn vào đợt).
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="orders">
          <TabsList>
            <TabsTrigger value="orders">Danh sách vận đơn (khuyên dùng)</TabsTrigger>
            <TabsTrigger value="summary">Bảng kê tổng hợp (dán bảng)</TabsTrigger>
            <TabsTrigger value="detail">Chi tiết một bảng kê (file)</TabsTrigger>
          </TabsList>
          <TabsContent value="orders">
            <OrderListImport
              onDone={() => {
                setOpen(false);
                router.refresh();
              }}
            />
          </TabsContent>
          <TabsContent value="summary">
            <SummaryImport
              onDone={() => {
                setOpen(false);
                router.refresh();
              }}
            />
          </TabsContent>
          <TabsContent value="detail">
            <DetailImport
              onDone={() => {
                setOpen(false);
                router.refresh();
              }}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SummaryImport({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<StatementSummary[] | null>(null);
  const [pending, startTransition] = useTransition();
  const total = useMemo(() => (rows ?? []).reduce((a, r) => ({ cod: a.cod + r.codGross, fee: a.fee + r.feeTotal, net: a.net + r.netAmount }), { cod: 0, fee: 0, net: 0 }), [rows]);

  const parse = () =>
    startTransition(async () => {
      const result = await parseVtpStatementText(text);
      if ("error" in result) toast.error(result.error);
      else setRows(result.rows);
    });
  const save = () =>
    startTransition(async () => {
      if (!rows?.length) return;
      const result = await saveVtpStatements(rows);
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(`Đã ghi ${result.created} bảng kê mới, cập nhật ${result.updated}`);
        onDone();
      }
    });

  return (
    <div className="space-y-3 pt-2">
      {!rows ? (
        <>
          <Textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono text-xs"
            placeholder={"PCOD-A-GLMTQY04-2609-55\t04/09/2026 01:00:29\t24.059.000 ₫\t563.757 ₫\t23.495.243 ₫\nPCOD-A-GLMTQY03-2609-44\t03/09/2026 08:47:32\t58.136.001 ₫\t6.806.381 ₫\t51.329.620 ₫"}
          />
          <DialogFooter>
            <Button type="button" onClick={parse} disabled={pending || !text.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Đọc bảng
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">{rows.length} bảng kê</Badge>
            <Badge variant="outline">Tiền COD {formatVND(total.cod)}</Badge>
            <Badge variant="outline">Cước / dư nợ {formatVND(total.fee)}</Badge>
            <Badge variant="outline">Thu về {formatVND(total.net)}</Badge>
          </div>
          <div className="max-h-[50vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã bảng kê</TableHead>
                  <TableHead>Ngày đối soát</TableHead>
                  <TableHead className="text-right">Tiền COD</TableHead>
                  <TableHead className="text-right">Cước / dư nợ</TableHead>
                  <TableHead className="text-right">Tiền thu về</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.reference}>
                    <TableCell className="font-mono text-xs">{r.reference}</TableCell>
                    <TableCell>{fmtDate(r.receivedAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.codGross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.feeTotal)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatVND(r.netAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRows(null)} disabled={pending}>
              Sửa lại
            </Button>
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Ghi {rows.length} bảng kê
            </Button>
          </DialogFooter>
        </>
      )}
    </div>
  );
}

/**
 * Nhập CHI TIẾT bảng kê — nhiều file một lượt.
 *
 * File chi tiết Viettel Post không chứa mã bảng kê, nên trước đây chủ shop phải gõ tay mã đợt và
 * ngày cho từng file (11 file = 11 lượt), và ngày mặc định "hôm nay" còn ghi đè mất ngày về thật.
 * Nay ERP ghép file với đợt bằng SỐ TIỀN (tổng thu hộ + tổng thu về trùng khít đúng một đợt),
 * không đoán theo ngày và không sửa số của đợt.
 */
function DetailImport({ onDone }: { onDone: () => void }) {
  const [files, setFiles] = useState<StatementFileMatch[] | null>(null);
  const [sourceFiles, setSourceFiles] = useState<{ base64: string; filename: string }[]>([]);
  const [pending, startTransition] = useTransition();

  const onFiles = async (list: FileList | null) => {
    const picked = list ? Array.from(list) : [];
    if (!picked.length) return;
    setFiles(null);
    setSourceFiles([]);
    if (picked.length > MAX_LIST_FILES) { toast.error(`Đang chọn ${picked.length} tệp, tối đa ${MAX_LIST_FILES} tệp mỗi lượt`); return; }
    const totalBytes = picked.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_LIST_RAW_BYTES) {
      toast.error(`Tổng ${(totalBytes / 1_000_000).toFixed(1)} MB, tối đa ${(MAX_LIST_RAW_BYTES / 1_000_000).toFixed(1)} MB mỗi lượt`);
      return;
    }
    const payloads = await Promise.all(picked.map(async (f) => ({ base64: await fileToBase64(f), filename: f.name })));
    startTransition(async () => {
      const result = await previewVtpStatementDetailFiles(payloads);
      if ("error" in result) { toast.error(result.error); return; }
      setFiles(result.files);
      setSourceFiles(payloads);
      const ready = result.files.filter((f) => f.batchId).length;
      toast.success(`Đọc ${result.files.length} tệp · ${ready} tệp ghép được đợt tiền về`);
    });
  };

  const submit = () =>
    startTransition(async () => {
      if (!sourceFiles.length) return;
      const result = await importVtpStatementDetailFiles(sourceFiles);
      if ("error" in result) { toast.error(result.error); return; }
      toast.success(`Đã ghi chứng từ cho ${result.linked} vận đơn · ${result.withCash} vận đơn có tiền thực thu`);
      const noBatch = result.files.filter((f) => !f.batchId).length;
      setFiles(result.files);
      if (noBatch) toast.warning(`${noBatch} tệp chưa khớp đợt tiền về — chứng từ vẫn được ghi, xem lý do trong bảng`);
      else onDone();
    });

  const ready = (files ?? []).filter((f) => f.batchId).length;
  const total = (files ?? []).length;

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-1">
        <Label>File chi tiết bảng kê (.xlsx / .csv) — chọn được nhiều tệp (tối đa {MAX_LIST_FILES})</Label>
        <Input type="file" multiple accept=".xlsx,.xls,.csv,.txt" onChange={(e) => onFiles(e.target.files)} disabled={pending} />
        <p className="text-[11px] text-muted-foreground">
          ERP tự ghép mỗi tệp với đúng đợt tiền về bằng cách so tổng Tiền thu hộ và Tiền thu về với số trên bảng kê —
          không đoán theo ngày. Tệp không khớp đợt nào sẽ được bỏ qua kèm lý do; số tiền của đợt giữ nguyên theo chứng từ gốc.
        </p>
      </div>
      {files ? (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">{files.length} tệp · {ready} khớp đợt tiền về</Badge>
            <Badge variant="outline">Thu về {formatVND(files.reduce((a, f) => a + f.netAmount, 0))}</Badge>
            <Badge variant="outline">{files.reduce((a, f) => a + f.matchedShipments, 0)} vận đơn có trong ERP</Badge>
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tệp</TableHead>
                  <TableHead>Đợt tiền về</TableHead>
                  <TableHead className="text-right">COD</TableHead>
                  <TableHead className="text-right">Cước</TableHead>
                  <TableHead className="text-right">Thu về</TableHead>
                  <TableHead className="text-right">Vận đơn ghép</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={f.filename} className={f.batchId ? "" : "opacity-70"}>
                    <TableCell className="max-w-[220px] truncate text-xs">{f.filename}</TableCell>
                    <TableCell className="text-sm">
                      {f.batchReference ? (
                        <span className="font-medium">{f.batchReference}</span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">{f.issue}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(f.codGross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(f.feeTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(f.netAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.matchedShipments}/{f.rows}
                      {f.unmatchedCodes ? <span className="block text-[10.5px] text-muted-foreground">{f.unmatchedCodes} mã không có trong ERP</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-end">
            <Button onClick={submit} disabled={pending || !total}>
              Nhập chứng từ {total} tệp{ready ? ` (${ready} tệp khớp đợt tiền về)` : ""}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

async function fileToBase64(file: File) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(binary);
}

function OrderListImport({ onDone }: { onDone: () => void }) {
  const [rows, setRows] = useState<OrderListMatch[] | null>(null);
  const [pending, startTransition] = useTransition();
  const summary = useMemo(() => {
    const list = rows ?? [];
    const matched = list.filter((r) => r.shipmentId);
    const byStatus = new Map<string, number>();
    for (const r of matched) byStatus.set(r.statusText || "?", (byStatus.get(r.statusText || "?") ?? 0) + 1);
    return { matched: matched.length, unmatched: list.length - matched.length, legs: matched.filter((r) => r.matchKind === "leg").length, paid: matched.filter((r) => r.mapped.cod === "PAID_TO_BANK").length, unknown: matched.filter((r) => r.mapped.stage === "UNKNOWN").length, byStatus: [...byStatus.entries()].sort((a, b) => b[1] - a[1]) };
  }, [rows]);

  const [fileNames, setFileNames] = useState<string[]>([]);
  const [sourceFiles, setSourceFiles] = useState<{ base64: string; filename: string }[]>([]);
  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    setRows(null);
    setSourceFiles([]);
    // Kiểm tra ngay tại trình duyệt để chủ shop biết phải chia mấy lượt, không phải gửi lên rồi mới báo lỗi.
    if (files.length > MAX_LIST_FILES) { toast.error(`Đang chọn ${files.length} tệp, tối đa ${MAX_LIST_FILES} tệp mỗi lượt — hãy chia thành nhiều lượt`); return; }
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > MAX_LIST_RAW_BYTES) {
      toast.error(`Tổng ${(totalBytes / 1_000_000).toFixed(1)} MB, tối đa ${(MAX_LIST_RAW_BYTES / 1_000_000).toFixed(1)} MB mỗi lượt — hãy chia thành nhiều lượt`);
      return;
    }
    const payloads = await Promise.all(files.map(async (f) => ({ base64: await fileToBase64(f), filename: f.name })));
    startTransition(async () => {
      const result = await previewVtpOrderListFiles(payloads);
      if ("error" in result) { toast.error(result.error); return; }
      if (result.rows.length) {
        setRows(result.rows);
        setSourceFiles(payloads);
        setFileNames(files.map((f) => f.name));
        toast.success(`Đã đọc ${result.rows.length} vận đơn từ ${files.length} tệp`);
      }
    });
  };
  const submit = () =>
    startTransition(async () => {
      if (!rows?.length) return;
      const result = await importVtpOrderListFiles(sourceFiles);
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(`Đã cập nhật ${result.updated} vận đơn, ${result.legs} chiều hoàn · ${result.duplicate} dòng đã có · ${result.stale} dòng cũ bỏ qua`);
        if (result.conflicts || result.missingDate || result.unmatched || result.unknown) {
          toast.warning(`Cần đối chiếu: ${result.conflicts} xung đột, ${result.missingDate} thiếu ngày, ${result.unmatched} chưa ghép, ${result.unknown} trạng thái lạ`);
        } else onDone();
      }
    });

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-1">
        <Label>File Excel/CSV xuất từ Quản lý vận đơn (viettelpost.vn) — chọn được nhiều tệp (tối đa {MAX_LIST_FILES})</Label>
        <Input type="file" multiple accept=".xlsx,.xls,.csv,.txt" onChange={(e) => onFiles(e.target.files)} disabled={pending} />
        <p className="text-[11px] text-muted-foreground">ERP đọc Ngày chuyển trạng thái và Tổng phí, giữ riêng chiều hoàn. File cũ không đè trạng thái mới; thiếu ngày hoặc xung đột cần đối chiếu. Tiền thu hộ là COD khai báo. File này không tự xác minh thực thu hay tiền về ngân hàng; cần bảng kê COD và chứng từ thanh toán.</p>
        {fileNames.length ? <p className="text-[11px] text-muted-foreground">Đã chọn: {fileNames.join(", ")}</p> : null}

      </div>
      {rows ? (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">Ghép được {summary.matched}/{rows.length} vận đơn</Badge>
            {summary.legs ? <Badge variant="outline">{summary.legs} vận đơn chiều hoàn riêng</Badge> : null}
            <Badge variant="outline">Tiền thực thu: chưa xác minh</Badge>
            {summary.unknown ? <Badge variant="outline">Trạng thái chưa nhận ra: {summary.unknown}</Badge> : null}
            {summary.unmatched ? <Badge variant="outline">{summary.unmatched} mã không có trong ERP</Badge> : null}
          </div>
          <div className="flex flex-wrap gap-1 text-[11px] text-muted-foreground">
            {summary.byStatus.slice(0, 12).map(([st, n]) => (
              <span key={st} className="rounded bg-muted px-1.5 py-0.5">{st}: {n}</span>
            ))}
          </div>
          <div className="max-h-[40vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã vận đơn</TableHead>
                  <TableHead>Đơn ERP</TableHead>
                  <TableHead>Trạng thái VTP</TableHead>
                  <TableHead>→ ERP</TableHead>
                  <TableHead className="text-right">COD khai báo</TableHead>
                  <TableHead className="text-right">Tổng phí</TableHead>
                  <TableHead>Ngày trạng thái</TableHead>
                  <TableHead>Đối soát COD / thanh toán VTP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 300).map((r, i) => (
                  <TableRow key={`${r.trackingCode}-${i}`} className={r.shipmentId ? "" : "opacity-60"}>
                    <TableCell className="font-mono text-xs">{r.trackingCode}</TableCell>
                    <TableCell className="text-sm">{r.orderLabel || <span className="text-muted-foreground">{r.matchIssue || "Chưa ghép được trong ERP"}</span>}</TableCell>
                    <TableCell className="text-sm">{r.statusText}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.mapped.stage === "UNKNOWN" ? "?" : SHIPMENT_STAGE_LABEL[r.mapped.stage]}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.cod === null ? "Chưa biết" : formatVND(r.cod)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.fee === null ? "Chưa biết" : formatVND(r.fee)}</TableCell>
                    <TableCell className="text-xs">{r.statusDate ? fmtDate(r.statusDate) : "—"}</TableCell>
                    <TableCell className="text-xs">{r.codReconciliationText || "—"} / {r.paymentText || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length > 300 ? <p className="px-3 py-2 text-xs text-muted-foreground">… và {rows.length - 300} dòng nữa</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" onClick={submit} disabled={pending || !summary.matched}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Cập nhật {summary.matched} vận đơn
            </Button>
          </DialogFooter>
        </>
      ) : null}
    </div>
  );
}
