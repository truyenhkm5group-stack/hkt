"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { removeSuppressionAction } from "@/lib/actions/wholesale";
import { formatDateTime } from "@/lib/format";
import { formatVnPhone } from "@/lib/wholesale/phone";

type Row = { id: string; kind: string; value: string; reason: string; by: string; at: string; leadId: string | null };

const KIND: Record<string, string> = { PHONE: "SĐT", DOMAIN: "Website", PLACE: "Địa điểm Google" };

export function SuppressionTable({ rows }: { rows: Row[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (!rows.length) return <p className="text-sm text-muted-foreground">Chưa có ai trong danh sách.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b">
          <th className="py-1 text-left font-medium">Loại</th>
          <th className="py-1 text-left font-medium">Giá trị</th>
          <th className="py-1 text-left font-medium">Lý do</th>
          <th className="py-1 text-left font-medium">Ai / khi nào</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b align-top last:border-0">
            <td className="py-1">{KIND[r.kind] ?? r.kind}</td>
            <td className="max-w-[220px] break-all py-1">{r.kind === "PHONE" ? formatVnPhone(r.value) : r.kind === "PLACE" ? <span className="font-mono text-[11px]">{r.value}</span> : r.value}</td>
            <td className="py-1">
              {r.reason}
              {r.leadId ? (
                <>
                  {" "}
                  <Link className="text-[11px] text-primary hover:underline" href={`/wholesale/leads/${r.leadId}`}>
                    lead
                  </Link>
                </>
              ) : null}
            </td>
            <td className="py-1 text-xs text-muted-foreground">
              {r.by || "—"} · {formatDateTime(r.at)}
            </td>
            <td className="py-1 text-right">
              {open === r.id ? (
                <div className="flex gap-1">
                  <Input className="h-8" placeholder="Lý do gỡ" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const res = await removeSuppressionAction(r.id, reason);
                        if ("error" in res) toast.error(res.error);
                        else {
                          toast.success("Đã gỡ khỏi danh sách");
                          setOpen(null);
                          setReason("");
                          router.refresh();
                        }
                      })
                    }
                  >
                    Gỡ
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>
                  Gỡ…
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
