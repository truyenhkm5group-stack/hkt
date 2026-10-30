"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addEmailSuppressionAction, removeSuppressionAction } from "@/lib/actions/wholesale";
import { formatDateTime } from "@/lib/format";
import { SUPPRESSION_KIND_LABEL } from "@/lib/wholesale/contactability";
import { formatVnPhone } from "@/lib/wholesale/phone";

type Row = { id: string; kind: string; value: string; reason: string; by: string; at: string; leadId: string | null };

const KIND: Record<string, string> = SUPPRESSION_KIND_LABEL;

/**
 * Thêm một EMAIL vào danh sách (0261). SĐT / website / địa điểm vào danh sách qua nút «Không liên hệ» trên lead; email thì
 * hay đến từ một thư «xin ngừng gửi» không gắn được ngay với lead nào, nên có ô thêm tay. Máy chủ chuẩn hoá (trim + chữ thường).
 */
export function EmailSuppressionForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="mb-3 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await addEmailSuppressionAction({ email, reason });
          if ("error" in res) toast.error(res.error);
          else {
            toast.success(res.existed ? `${res.email} đã có trong danh sách` : `Đã chặn ${res.email}${res.leads ? ` · ${res.leads} lead mang email này` : ""}`);
            setEmail("");
            setReason("");
            router.refresh();
          }
        });
      }}
    >
      <label className="grid gap-1 text-xs text-muted-foreground">
        Email không liên hệ
        <Input className="h-8 w-60" type="email" placeholder="chu@quan.vn" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="grid flex-1 gap-1 text-xs text-muted-foreground">
        Lý do
        <Input className="h-8 min-w-[220px]" placeholder="vd: khách trả lời xin ngừng gửi mail" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Button size="sm" type="submit" disabled={pending || !email.trim()}>
        Thêm vào danh sách
      </Button>
    </form>
  );
}

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
