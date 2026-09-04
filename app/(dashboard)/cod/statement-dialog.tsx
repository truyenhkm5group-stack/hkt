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
import { importVtpStatementDetail, parseVtpStatementText, previewVtpStatementDetail, saveVtpStatements } from "@/lib/actions/cod-statements";
import { formatVND, todayVN } from "@/lib/format";
import type { StatementSummary } from "@/lib/integrations/viettelpost/statement";
import type { DetailMatch } from "@/lib/integrations/viettelpost/statement-db";

function fmtDate(key: string) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

/** Nhập bảng kê tiền COD Viettel Post: tổng hợp (dán bảng) hoặc chi tiết (file Excel/CSV từng vận đơn) */
export function StatementDialog() {
  const [open, setOpen] = useState(false);
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
            Lấy từ viettelpost.vn → Thống kê tiền hàng → Tiền hàng đã trả. Tổng hợp: bôi đen bảng và dán vào ô bên dưới (mỗi dòng một bảng kê) → ERP ghi nhận tiền COD, cước và tiền thu về theo ngày đối soát vào báo cáo dòng tiền. Chi tiết: mở một bảng kê, xuất Excel và tải lên → ERP
            ghép từng vận đơn, đánh dấu đã về ngân hàng và ghi cước thực tế.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="summary">
          <TabsList>
            <TabsTrigger value="summary">Tổng hợp (dán bảng)</TabsTrigger>
            <TabsTrigger value="detail">Chi tiết một bảng kê (file)</TabsTrigger>
          </TabsList>
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
