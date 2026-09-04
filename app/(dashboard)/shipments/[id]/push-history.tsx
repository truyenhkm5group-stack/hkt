"use client";

import { useState } from "react";
import { History, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

type PushRecord = Record<string, unknown>;

function pick(record: PushRecord, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "";
}

function pickDate(record: PushRecord, ...keys: string[]) {
  const raw = pick(record, ...keys);
  if (!raw) return "—";
  const asNumber = Number(raw);
  const date = Number.isFinite(asNumber) && raw.length >= 10 ? new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber) : new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : formatDateTime(date);
}

/** Lịch sử Viettel Post đẩy webhook — chỉ tải khi người dùng bấm nút */
export function PushHistoryPanel({ shipmentId }: { shipmentId: string }) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<PushRecord[] | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/shipments/${shipmentId}/push-history`);
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; items?: PushRecord[] };
      if (!res.ok || body.ok === false) toast.error(body.error || `Không tải được lịch sử (${res.status})`);
      else setItems(body.items ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Các lần Viettel Post gọi webhook về ERP cho vận đơn này (lấy trực tiếp từ API VTP).</p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <History className="size-4" />}
          {items ? "Tải lại" : "Tải lịch sử webhook"}
        </Button>
      </div>
      {items ? (
        items.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[560px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Thời điểm</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Kết quả</TableHead>
                  <TableHead>Ghi chú</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.slice(0, 50).map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-xs text-muted-foreground">{pickDate(item, "PUSH_DATE", "CREATED_DATE", "DATE", "TIME", "createdAt", "created_at", "date")}</TableCell>
                    <TableCell className="text-xs">
                      {pick(item, "ORDER_STATUS", "STATUS", "status")}
                      {pick(item, "STATUS_NAME", "ORDER_STATUS_NAME", "statusName") ? ` · ${pick(item, "STATUS_NAME", "ORDER_STATUS_NAME", "statusName")}` : ""}
                    </TableCell>
                    <TableCell className="text-xs">{pick(item, "RESPONSE", "RESPONSE_CODE", "HTTP_STATUS", "RESULT", "response", "result") || "—"}</TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">{pick(item, "NOTE", "MESSAGE", "URL", "note", "message") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Viettel Post chưa ghi nhận lần đẩy webhook nào cho vận đơn này.</p>
        )
      ) : null}
    </div>
  );
}
