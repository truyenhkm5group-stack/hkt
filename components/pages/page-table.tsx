"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PREVIEW_ACTION_REASON, usePageAction, type PageActionRunner } from "@/components/pages/page-action-button";
import { formatDate, formatDateTime, formatNumber, formatPercent, formatVND, MISSING_HINT, MISSING_TEXT } from "@/lib/format";
import type { TableColumn, TableData, TableRowActionData } from "@/lib/pages/types";

/**
 * ═══════════ BẢNG CỦA TRANG ĐỘNG (Phase 4) ═══════════
 *
 * Nhận dữ liệu ĐÃ PHÂN GIẢI ở máy chủ (`TableData`: cột + dòng + tổng) và dựng cột Ở ĐÂY, phía trình duyệt —
 * không hàm / định nghĩa cột nào đi qua ranh giới Server → Client (AGENTS.md mục 2).
 *
 * KHÔNG dùng `DataTable`: nó gắn trang / sắp xếp vào tham số URL CHUNG (`page`, `sort`), nên hai bảng trên cùng
 * một trang động sẽ lật trang của nhau. Mỗi bảng lật trang bằng tham số RIÊNG `<blockId>_page` — đúng khoá trình
 * phân giải đọc (`resolveTable`), ≤ 100 dòng / lượt; bảng in rõ "đang hiện bao nhiêu trên tổng".
 *
 * HÀNH ĐỘNG THEO DÒNG (Phase 5): cột cuối mang ≤ 3 nút; bấm gửi `recordId` của dòng + vị trí hành động — máy chủ đọc
 * lại `rowActions` ĐÃ XUẤT BẢN và kiểm bản ghi trong phạm vi người bấm. Nút tắt kèm lý do (quyền, module, xem trước).
 */

function cellText(value: unknown, format: TableColumn["format"]): { text: string; missing: boolean } {
  if (value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) return { text: MISSING_TEXT, missing: true };
  switch (format) {
    case "vnd":
      return { text: formatVND(Number(value)), missing: false };
    case "number":
      return { text: formatNumber(Number(value)), missing: false };
    case "percent":
      return { text: formatPercent(Number(value)), missing: false };
    case "date":
      return { text: formatDate(value as string), missing: false };
    case "datetime":
      return { text: formatDateTime(value as string), missing: false };
    default:
      if (typeof value === "boolean") return { text: value ? "Có" : "Không", missing: false };
      if (Array.isArray(value)) return { text: value.map(String).join(", "), missing: false };
      if (typeof value === "object") return { text: JSON.stringify(value), missing: false };
      return { text: String(value), missing: false };
  }
}

const NUMERIC = new Set<TableColumn["format"]>(["vnd", "number", "percent"]);

/** Liên kết tới trang `n` của MỘT bảng — giữ nguyên mọi tham số khác (kỳ, trang của bảng khác). */
function usePageHref(blockId: string): (n: number) => string {
  const pathname = usePathname();
  const params = useSearchParams();
  return (n: number) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (n <= 1) next.delete(`${blockId}_page`);
    else next.set(`${blockId}_page`, String(n));
    const q = next.toString();
    return q ? `${pathname}?${q}` : pathname;
  };
}

function RowActions({ blockId, recordId, actions, run }: { blockId: string; recordId: string; actions: TableRowActionData[]; run?: PageActionRunner }) {
  const { pending, fire } = usePageAction(run);
  const [confirming, setConfirming] = React.useState<TableRowActionData | null>(null);
  const go = (a: TableRowActionData, done?: () => void) => fire(blockId, {}, done ? () => done() : undefined, { recordId, actionIndex: a.index });
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {actions.map((a) => {
        const reason = !a.enabled ? (a.reason ?? "Hành động này đang không dùng được.") : !run ? PREVIEW_ACTION_REASON : null;
        return (
          <Button key={a.index} type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={pending || reason !== null} title={reason ?? undefined} onClick={() => (a.confirm ? setConfirming(a) : go(a))}>
            {a.label}
          </Button>
        );
      })}
      {confirming ? (
        <AlertDialog open onOpenChange={(o) => !pending && !o && setConfirming(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirming.label}?</AlertDialogTitle>
              <AlertDialogDescription>{confirming.confirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={(e) => {
                  e.preventDefault();
                  go(confirming, () => setConfirming(null));
                }}
              >
                Xác nhận
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

export function PageTable({ blockId, data, run }: { blockId: string; data: TableData; run?: PageActionRunner }) {
  const { columns, rows, total, page, pageSize } = data;
  const actions = data.rowActions ?? [];
  const hrefOf = usePageHref(blockId);
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (rows.length === 0) {
    return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{data.appliedFilters ? "Không có dòng nào khớp bộ lọc đang chọn." : "Chưa có dòng nào khớp cấu hình của bảng này."}</p>;
  }
  const from = (Math.max(1, page) - 1) * pageSize + 1;
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table columnToggle={false}>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.id} className={NUMERIC.has(c.format) ? "text-right" : undefined}>
                  {c.label}
                </TableHead>
              ))}
              {actions.length ? <TableHead className="text-right">Thao tác</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                {columns.map((c, i) => {
                  const { text, missing } = cellText(r.cells[c.id], c.format);
                  const body = missing ? (
                    <span className="text-muted-foreground" title={MISSING_HINT}>
                      {text}
                    </span>
                  ) : (
                    text
                  );
                  return (
                    <TableCell key={c.id} className={NUMERIC.has(c.format) ? "numeric text-right" : undefined}>
                      {i === 0 && r.href ? (
                        <Link href={r.href} className="font-medium hover:underline">
                          {body}
                        </Link>
                      ) : (
                        body
                      )}
                    </TableCell>
                  );
                })}
                {actions.length ? (
                  <TableCell className="text-right">
                    <RowActions blockId={blockId} recordId={r.id} actions={actions} run={run} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          Dòng {formatNumber(from)}–{formatNumber(from + rows.length - 1)} trên tổng {formatNumber(total)}
          {data.appliedFilters ? ` · đang lọc ${formatNumber(data.appliedFilters)} điều kiện` : ""}
        </p>
        {pages > 1 ? (
          <nav aria-label="Phân trang" className="flex items-center gap-1">
            {page > 1 ? (
              <Link href={hrefOf(page - 1)} scroll={false} className="rounded-md px-2 py-1 font-medium hover:bg-muted">
                ← Trước
              </Link>
            ) : null}
            <span className="numeric px-1">
              Trang {formatNumber(page)}/{formatNumber(pages)}
            </span>
            {page < pages ? (
              <Link href={hrefOf(page + 1)} scroll={false} className="rounded-md px-2 py-1 font-medium hover:bg-muted">
                Sau →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </div>
  );
}
