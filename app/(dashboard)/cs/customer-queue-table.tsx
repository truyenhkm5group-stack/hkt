"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/misc";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CS_KIND_LABEL, CS_STATUS_LABEL } from "@/lib/constants/cs";
import { STICKY_HEAD, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { formatDate, formatNumber, formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export type CustomerQueueRow = {
  key: string;
  customerName: string;
  customerPhone: string;
  openCount: number;
  kinds: string[];
  oldestAt: string;
  latestAt: string;
  anyAssigned: boolean;
  cases: { id: string; kind: string; status: string; source: string; orderId: string | null; title: string; createdAt: string; assignee: string }[];
};

/**
 * ═══════ MỘT KHÁCH — MỘT DÒNG, BUNG RA THẤY ĐỦ TỪNG VIỆC ═══════
 *
 * Dòng gom là PHÉP CHIẾU để đọc, không phải bản ghi mới: mỗi việc bên trong giữ nguyên mã, loại,
 * đơn, nguồn và mốc tạo của nó, và bấm vào là mở đúng case đó.
 *
 * Đo production 13/09/2026: 426 dòng việc đang mở nhưng chỉ 296 khách — gần một phần ba hàng đợi
 * là cùng người với một dòng khác.
 */
export function CustomerQueueTable({ rows }: { rows: CustomerQueueRow[] }) {
  const [mo, setMo] = useState<Set<string>>(new Set());
  const bung = (k: string) =>
    setMo((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  if (!rows.length) return <p className="py-10 text-center text-sm text-muted-foreground">Không có việc nào đang mở.</p>;

  return (
    <div className={cn(TABLE_SCROLL)}>
      <Table>
        <TableHeader className={STICKY_HEAD}>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Khách</TableHead>
            <TableHead className="w-24 text-right">Việc đang mở</TableHead>
            <TableHead>Loại việc</TableHead>
            <TableHead className="w-32">Cũ nhất</TableHead>
            <TableHead className="w-28">Người nhận</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const dangMo = mo.has(r.key);
            return (
              <>
                <TableRow key={r.key} className="cursor-pointer hover:bg-row-hover" onClick={() => bung(r.key)}>
                  <TableCell className="px-2">{dangMo ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                  <TableCell>
                    <div className="font-medium">{r.customerName || "—"}</div>
                    {r.customerPhone ? (
                      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                        <span className="font-mono text-xs text-muted-foreground">{r.customerPhone}</span>
                        <CopyButton value={r.customerPhone} className="size-5 shrink-0 [&_svg]:size-3" />
                      </div>
                    ) : (
                      // KHÔNG bịa số: dòng không có định danh khách phải nói thẳng là chưa nối được.
                      <div className="text-xs text-muted-foreground">chưa nối được khách</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={cn("numeric font-semibold", r.openCount > 1 && "text-warning")}>{formatNumber(r.openCount)}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.kinds.map((k) => (
                        <Badge key={k} variant="secondary" className="text-[10px]">
                          {CS_KIND_LABEL[k as keyof typeof CS_KIND_LABEL] ?? k}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" title={formatDate(r.oldestAt, true)}>
                    {formatTimeAgo(r.oldestAt)}
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.anyAssigned ? <span className="text-muted-foreground">đã có người</span> : <span className="font-medium text-warning">chưa ai nhận</span>}
                  </TableCell>
                </TableRow>
                {dangMo ? (
                  <TableRow key={`${r.key}-chi-tiet`} className="bg-muted/30">
                    <TableCell />
                    <TableCell colSpan={5} className="py-2">
                      <ul className="space-y-1.5">
                        {r.cases.map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                            <Badge variant="secondary" className="text-[10px]">{CS_KIND_LABEL[c.kind as keyof typeof CS_KIND_LABEL] ?? c.kind}</Badge>
                            <span className="font-medium">{c.title}</span>
                            <span className="text-muted-foreground">{CS_STATUS_LABEL[c.status as keyof typeof CS_STATUS_LABEL] ?? c.status}</span>
                            <span className="text-muted-foreground">· {formatDate(c.createdAt)}</span>
                            <span className="text-muted-foreground">· {c.source}</span>
                            {c.assignee ? <span className="text-muted-foreground">· {c.assignee}</span> : null}
                            {c.orderId ? (
                              <Link href={`/orders/${c.orderId}`} className="inline-flex items-center gap-1 text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
                                <ExternalLink className="size-3" /> đơn
                              </Link>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                ) : null}
              </>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
