"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Pencil, Printer, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deleteProductionOrder, setProductionStatus } from "@/lib/actions/production";

export function OrderActions({ id, status, text, canWrite }: { id: string; status: string; text: string; canWrite: boolean }) {
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const router = useRouter();
  const set = (s: string) => startTransition(async () => { const r = await setProductionStatus(id, s); if ("error" in r) toast.error(r.error); else router.refresh(); });
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" size="sm"><a href={`/print/production/${id}`} target="_blank" rel="noreferrer"><Printer className="size-4" /> In / lưu PDF</a></Button>
      <Button variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(text); toast.success("Đã sao chép bảng dạng văn bản để dán vào Zalo"); } catch { toast.error("Không sao chép được"); } }}><Copy className="size-4" /> Sao chép văn bản</Button>
      {canWrite && (status === "DRAFT" || status === "SENT") ? <Button variant="outline" size="sm" onClick={() => { setEditing(true); router.push(`/inventory/planning/orders/${id}/edit`); }} disabled={editing}><Pencil className="size-4" /> Sửa</Button> : null}
      {canWrite && status === "DRAFT" ? <Button size="sm" onClick={() => set("SENT")} disabled={pending}><Send className="size-4" /> Đánh dấu đã gửi xưởng</Button> : null}
      {canWrite && status === "SENT" ? <Button size="sm" variant="outline" onClick={() => set("RECEIVED")} disabled={pending}>Đã nhận hàng về</Button> : null}
      {canWrite && status !== "CANCELLED" && status !== "RECEIVED" ? <Button size="sm" variant="ghost" onClick={() => set("CANCELLED")} disabled={pending}>Huỷ bảng</Button> : null}
      {canWrite && status === "DRAFT" ? <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("Xoá bảng nháp này?")) startTransition(async () => { const r = await deleteProductionOrder(id); if ("error" in r) toast.error(r.error); else router.push("/inventory/planning/orders"); }); }} disabled={pending}><Trash2 className="size-4" /></Button> : null}
    </div>
  );
}
