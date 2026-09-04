"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { ExpenseCategory } from "@/db/schema";
import { importBankLedger, previewBankLedger } from "@/lib/actions/bank-import";
import { EXPENSE_CATEGORY_LABEL, EXPENSE_CATEGORY_ORDER, EXPENSE_CATEGORY_TONE } from "@/lib/constants/expenses";
import { formatVND } from "@/lib/format";
import { PLAN_STATUS_LABEL, type PlannedRow } from "@/lib/integrations/bank/ledger";

const SOURCE_LABEL: Record<PlannedRow["categorySource"], string> = {
  ledger: "theo nhãn sao kê",
  employee: "trùng tên nhân sự",
  keyword: "theo từ khoá",
  amount: "≥ 5 triệu → nhập hàng",
  default: "chưa rõ → Khác",
};

function fmtDate(key: string) {
  const [y, m, d] = key.split("-");
  return `${d}/${m}/${y}`;
}

/** Nhập sao kê MB Bank (JSON/CSV từ app quản lý giao dịch) thành chi phí ERP */
export function BankImportDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<PlannedRow[] | null>(null);
  const [category, setCategory] = useState<Record<string, ExpenseCategory>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [included, setIncluded] = useState<Set<string>>(new Set()); // dòng CPQC / nhập hàng được bật thủ công
  const [showSkipped, setShowSkipped] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const reset = () => {
    setText("");
    setRows(null);
    setCategory({});
    setExcluded(new Set());
    setIncluded(new Set());
  };

  const summary = useMemo(() => {
    if (!rows) return null;
    const by = (s: PlannedRow["status"]) => rows.filter((r) => r.status === s);
    const selected = [...by("new").filter((r) => !excluded.has(r.key)), ...by("not_operating").filter((r) => included.has(r.key))];
    return {
      selected,
      selectedTotal: selected.reduce((a, r) => a + r.amount, 0),
      duplicate: by("duplicate").length,
      inflow: by("inflow"),
      nonPl: by("non_pl"),
      notOperating: by("not_operating"),
    };
  }, [rows, excluded, included]);

  const preview = (source: string) =>
    startTransition(async () => {
      const result = await previewBankLedger(source);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setRows(result.rows);
      setCategory({});
      setExcluded(new Set());
      setIncluded(new Set());
      toast.success(`Đã đọc ${result.rows.length} giao dịch`);
    });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    setText(content);
    preview(content);
  };

  const submit = () =>
    startTransition(async () => {
      if (!summary?.selected.length) {
        toast.error("Chưa chọn dòng nào");
        return;
      }
      const payload = summary.selected.map((r) => ({ reference: r.reference, date: r.date, amount: r.amount, category: category[r.key] ?? r.category, description: r.description }));
      const result = await importBankLedger(payload);
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Đã nhập ${result.inserted} khoản chi${result.skipped ? ` · bỏ qua ${result.skipped} dòng trùng` : ""}`);
      setOpen(false);
      reset();
      router.refresh();
    });

  const visible = rows ? (showSkipped ? rows : rows.filter((r) => r.status === "new" || r.status === "duplicate" || r.status === "not_operating")) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <FileUp className="size-4" /> Nhập sao kê
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Nhập sao kê ngân hàng vào chi phí</DialogTitle>
          <DialogDescription>
            Chọn file JSON hoặc CSV xuất từ app “Quản lý giao dịch MB Bank” (hoặc dán nội dung). Chỉ tiền ra thuộc chi phí vận hành được ghi; tiền vào, chuyển nội bộ, trả nợ gốc… được bỏ qua. Quảng cáo (đã lấy từ tài khoản QC) và nhập hàng (đã nằm
            trong giá vốn) mặc định không nhập — tích chọn nếu muốn nhập với nhóm khác. Dòng đã nhập trước đó (trùng mã giao dịch) không bị nhập lại. Bạn có thể sửa nhóm chi phí từng dòng trước khi nhập.
          </DialogDescription>
        </DialogHeader>

        {!rows ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
                <Upload className="size-4" /> Chọn file .json / .csv
                <input type="file" accept=".json,.csv,.txt,application/json,text/csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
              <span className="text-xs text-muted-foreground">hoặc dán nội dung file bên dưới</span>
            </div>
            <Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"transactions":[...]}  hoặc  Ngày,Giờ,Tiền vào,Tiền ra,Nội dung,Đối tác,Mã GD,…' className="font-mono text-xs" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="button" onClick={() => preview(text)} disabled={pending || !text.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Đọc & xem trước
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            {summary ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">
                  Sẽ nhập {summary.selected.length} dòng · {formatVND(summary.selectedTotal)}
                </Badge>
                {summary.duplicate ? <Badge variant="outline">Đã có: {summary.duplicate}</Badge> : null}
                {summary.inflow.length ? (
                  <Badge variant="outline">
                    Tiền vào: {summary.inflow.length} · {formatVND(summary.inflow.reduce((a, r) => a + r.amount, 0))}
                  </Badge>
                ) : null}
                {summary.nonPl.length ? (
                  <Badge variant="outline">
                    Không tính lãi/lỗ: {summary.nonPl.length} · {formatVND(summary.nonPl.reduce((a, r) => a + r.amount, 0))}
                  </Badge>
                ) : null}
                {summary.notOperating.length ? (
                  <Badge variant="outline">
                    CPQC / nhập hàng (không nhập): {summary.notOperating.length} · {formatVND(summary.notOperating.reduce((a, r) => a + r.amount, 0))}
                  </Badge>
                ) : null}
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={showSkipped} onCheckedChange={(v) => setShowSkipped(v === true)} /> Hiện cả dòng bỏ qua
                </label>
              </div>
            ) : null}
            <div className="max-h-[50vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Ngày</TableHead>
                    <TableHead>Đối tác · nội dung</TableHead>
                    <TableHead className="text-right">Số tiền</TableHead>
                    <TableHead className="w-48">Nhóm chi phí</TableHead>
                    <TableHead>Trạng thái</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => {
                    const optional = r.status === "not_operating";
                    const isNew = r.status === "new" || (optional && included.has(r.key));
                    const cat = category[r.key] ?? r.category;
                    return (
                      <TableRow key={r.key} className={isNew ? "" : "opacity-60"}>
                        <TableCell>
                          {r.status === "new" ? (
                            <Checkbox
                              checked={!excluded.has(r.key)}
                              onCheckedChange={(v) =>
                                setExcluded((prev) => {
                                  const next = new Set(prev);
                                  if (v === true) next.delete(r.key);
                                  else next.add(r.key);
                                  return next;
                                })
                              }
                            />
                          ) : optional ? (
                            <Checkbox
                              checked={included.has(r.key)}
                              onCheckedChange={(v) =>
                                setIncluded((prev) => {
                                  const next = new Set(prev);
                                  if (v === true) next.add(r.key);
                                  else next.delete(r.key);
                                  return next;
                                })
                              }
                            />
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{fmtDate(r.date)}</TableCell>
                        <TableCell className="max-w-[360px]">
                          <div className="truncate font-medium" title={r.raw}>
                            {r.counterparty || "—"}
                          </div>
                          <div className="truncate text-xs text-muted-foreground" title={r.raw}>
                            {r.raw}
                          </div>
                          {r.bankRef ? <div className="text-[11px] text-muted-foreground">{r.bankRef}</div> : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{formatVND(r.amount)}</TableCell>
                        <TableCell>
                          {isNew ? (
                            <>
                              <Select value={cat} onValueChange={(v) => setCategory((prev) => ({ ...prev, [r.key]: v as ExpenseCategory }))}>
                                <SelectTrigger className="h-8 w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {EXPENSE_CATEGORY_ORDER.map((c) => (
                                    <SelectItem key={c} value={c}>
                                      {EXPENSE_CATEGORY_LABEL[c]}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <div className="mt-1 text-[11px] text-muted-foreground">{SOURCE_LABEL[r.categorySource]}</div>
                            </>
                          ) : r.status === "duplicate" ? (
                            <span className={`rounded px-1.5 py-0.5 text-xs ${EXPENSE_CATEGORY_TONE[r.category]}`}>{EXPENSE_CATEGORY_LABEL[r.category]}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">{r.ledgerCategory}</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{PLAN_STATUS_LABEL[r.status]}</TableCell>
                      </TableRow>
                    );
                  })}
                  {!visible.length ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                        Không có dòng tiền ra mới để nhập
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
                Chọn file khác
              </Button>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Huỷ
              </Button>
              <Button type="button" onClick={submit} disabled={pending || !summary?.selected.length}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Nhập {summary?.selected.length ?? 0} khoản chi
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
