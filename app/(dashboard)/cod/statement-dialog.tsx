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
import { importVtpOrderList, importVtpStatementDetail, parseVtpStatementText, previewVtpOrderList, previewVtpStatementDetail, saveVtpStatements } from "@/lib/actions/cod-statements";
import { formatVND, todayVN } from "@/lib/format";
import type { StatementSummary } from "@/lib/integrations/viettelpost/statement";
import type { DetailMatch, OrderListMatch } from "@/lib/integrations/viettelpost/statement-db";
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

function DetailImport({ onDone }: { onDone: () => void }) {
  const [reference, setReference] = useState("");
  const [receivedAt, setReceivedAt] = useState(todayVN());
  const [rows, setRows] = useState<DetailMatch[] | null>(null);
  const [pending, startTransition] = useTransition();
  const summary = useMemo(() => {
    const list = rows ?? [];
    const matched = list.filter((r) => r.shipmentId);
    return { matched: matched.length, unmatched: list.length - matched.length, cod: list.reduce((a, r) => a + r.cod, 0), fee: list.reduce((a, r) => a + r.fee, 0), net: list.reduce((a, r) => a + r.net, 0) };
  }, [rows]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!reference) {
      const m = file.name.match(/[A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+){2,}/i);
      if (m) setReference(m[0].toUpperCase());
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const base64 = btoa(binary);
    startTransition(async () => {
      const result = await previewVtpStatementDetail({ base64, filename: file.name });
      if ("error" in result) toast.error(result.error);
      else {
        setRows(result.rows);
        toast.success(`Đã đọc ${result.rows.length} vận đơn`);
      }
    });
  };

  const submit = () =>
    startTransition(async () => {
      if (!rows?.length) return;
      if (!reference.trim()) {
        toast.error("Nhập mã bảng kê");
        return;
      }
      const result = await importVtpStatementDetail({
        summary: { reference: reference.trim(), receivedAt, codGross: summary.cod, feeTotal: summary.fee, netAmount: summary.net },
        rows: rows.map((r) => ({ trackingCode: r.trackingCode, cod: r.cod, fee: r.fee, net: r.net })),
      });
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(`Đã ghép ${result.matched} vận đơn vào bảng kê${result.unmatched ? ` · ${result.unmatched} mã không có trong ERP` : ""}`);
        onDone();
      }
    });

  return (
    <div className="space-y-3 pt-2">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label>Mã bảng kê</Label>
          <Input value={reference} onChange={(e) => setReference(e.target.value.toUpperCase())} placeholder="PCOD-A-GLMTQY04-2609-55" />
        </div>
        <div className="space-y-1">
          <Label>Ngày đối soát</Label>
          <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>File chi tiết (.xlsx / .csv)</Label>
          <Input type="file" accept=".xlsx,.xls,.csv,.txt" onChange={(e) => onFile(e.target.files?.[0])} disabled={pending} />
        </div>
      </div>
      {rows ? (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">Ghép được {summary.matched}/{rows.length} vận đơn</Badge>
            {summary.unmatched ? <Badge variant="outline">{summary.unmatched} mã không có trong ERP</Badge> : null}
            <Badge variant="outline">COD {formatVND(summary.cod)}</Badge>
            <Badge variant="outline">Cước {formatVND(summary.fee)}</Badge>
            <Badge variant="outline">Thu về {formatVND(summary.net)}</Badge>
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mã vận đơn</TableHead>
                  <TableHead>Đơn ERP</TableHead>
                  <TableHead className="text-right">COD</TableHead>
                  <TableHead className="text-right">Cước</TableHead>
                  <TableHead className="text-right">Thu về</TableHead>
                  <TableHead>Trạng thái COD</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, i) => (
                  <TableRow key={`${r.trackingCode}-${i}`} className={r.shipmentId ? "" : "opacity-60"}>
                    <TableCell className="font-mono text-xs">{r.trackingCode}</TableCell>
                    <TableCell className="text-sm">{r.orderLabel || <span className="text-muted-foreground">Không có trong ERP</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.cod)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.fee)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.net)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.codStatus === "PAID_TO_BANK" ? "Đã về ngân hàng (sẽ ghi lại)" : (r.codStatus ?? "—")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button type="button" onClick={submit} disabled={pending || !summary.matched}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null} Ghi bảng kê & đánh dấu {summary.matched} vận đơn đã về
            </Button>
          </DialogFooter>
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
  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    const payloads = await Promise.all(files.map(async (f) => ({ base64: await fileToBase64(f), filename: f.name })));
    startTransition(async () => {
      const merged = new Map<string, OrderListMatch>();
      const errors: string[] = [];
      let total = 0;
      for (const p of payloads) {
        const result = await previewVtpOrderList(p);
        if ("error" in result) {
          errors.push(`${p.filename}: ${result.error}`);
          continue;
        }
        total += result.rows.length;
        // cùng mã vận đơn ở nhiều tệp → lấy dòng có ngày cập nhật mới nhất (tệp sau ghi đè nếu không có ngày)
        for (const r of result.rows) {
          const prev = merged.get(r.trackingCode);
          if (!prev || !prev.statusDate || (r.statusDate && r.statusDate >= prev.statusDate)) merged.set(r.trackingCode, r);
        }
      }
      for (const e of errors) toast.error(e);
      if (merged.size) {
        setRows([...merged.values()]);
        setFileNames(files.map((f) => f.name));
        toast.success(`Đã đọc ${total} dòng từ ${files.length} tệp · ${merged.size} vận đơn (gộp trùng)`);
      }
    });
  };
  const submit = () =>
    startTransition(async () => {
      if (!rows?.length) return;
      const result = await importVtpOrderList(rows.filter((r) => r.shipmentId).map((r) => ({ trackingCode: r.trackingCode, statusText: r.statusText, cod: r.cod, fee: r.fee, statusDate: r.statusDate })));
      if ("error" in result) toast.error(result.error);
      else {
        toast.success(`Đã cập nhật ${result.updated} vận đơn · ${result.paid} đánh dấu COD đã về ngân hàng${result.unknown ? ` · ${result.unknown} trạng thái chưa nhận ra` : ""}`);
        onDone();
      }
    });

  return (
    <div className="space-y-3 pt-2">
      <div className="space-y-1">
        <Label>File Excel/CSV xuất từ Quản lý vận đơn (viettelpost.vn) — chọn được nhiều tệp</Label>
        <Input type="file" multiple accept=".xlsx,.xls,.csv,.txt" onChange={(e) => onFiles(e.target.files)} disabled={pending} />
        <p className="text-[11px] text-muted-foreground">Chọn nhiều tệp (nhiều khoảng ngày) cùng lúc; cùng một mã vận đơn ở nhiều tệp sẽ lấy dòng có ngày cập nhật mới nhất. Cần có cột Mã vận đơn và Trạng thái; nếu có Tiền thu hộ, Cước, Ngày cập nhật thì ERP ghi thêm. Chỉ nâng trạng thái COD, không hạ vận đơn đã về ngân hàng.</p>
        {fileNames.length ? <p className="text-[11px] text-muted-foreground">Đã chọn: {fileNames.join(", ")}</p> : null}

      </div>
      {rows ? (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="secondary">Ghép được {summary.matched}/{rows.length} vận đơn</Badge>
            {summary.legs ? <Badge variant="outline" title="Vận đơn chiều về (mã gốc + 1P1) — ghi thành vận đơn riêng, đơn gốc được tính là đơn hoàn">{summary.legs} vận đơn chiều về → đơn hoàn</Badge> : null}
            <Badge variant="outline">Đã trả (COD về NH): {summary.paid}</Badge>
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
                  <TableHead className="text-right">COD</TableHead>
                  <TableHead className="text-right">Cước</TableHead>
                  <TableHead>Ngày</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 300).map((r, i) => (
                  <TableRow key={`${r.trackingCode}-${i}`} className={r.shipmentId ? "" : "opacity-60"}>
                    <TableCell className="font-mono text-xs">{r.trackingCode}</TableCell>
                    <TableCell className="text-sm">{r.orderLabel || <span className="text-muted-foreground">Không có trong ERP</span>}</TableCell>
                    <TableCell className="text-sm">{r.statusText}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.mapped.stage === "UNKNOWN" ? "?" : `${SHIPMENT_STAGE_LABEL[r.mapped.stage]}${r.mapped.cod === "PAID_TO_BANK" ? " · COD về NH" : ""}`}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.cod)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatVND(r.fee)}</TableCell>
                    <TableCell className="text-xs">{r.statusDate ? fmtDate(r.statusDate) : "—"}</TableCell>
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
