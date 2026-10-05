"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Download, Loader2, PackageCheck, Printer, Undo2, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { assignCourierAction, selfDeliveredAction, selfDeliveryFailedAction } from "@/lib/actions/shipping-routes";
import { formatVND } from "@/lib/format";

/** Một đơn tự giao — dữ liệu thuần (máy chủ đã xếp tuyến), trình duyệt chỉ vẽ và gọi action. */
export type SelfDeliveryRow = {
  id: string;
  code: string;
  receiverName: string;
  phone: string;
  address: string;
  ward: string;
  province: string;
  toCollect: number;
  items: string;
  note: string;
  courierUserId: string | null;
  courierName: string;
};

export type SelfDeliveryGroup = { key: string; ward: string; province: string; rows: SelfDeliveryRow[] };

const csvCell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;

/** Tệp CSV cho người giao (mở bằng Excel / Google Sheets) — dựng ở trình duyệt từ đúng danh sách đang xem. */
function downloadCsv(groups: SelfDeliveryGroup[]) {
  const head = ["Xã / phường", "Tỉnh / thành", "Mã đơn", "Người nhận", "SĐT", "Địa chỉ", "Hàng", "Thu của khách (đ)", "Người giao", "Ghi chú"];
  const lines = [head.map(csvCell).join(",")];
  for (const g of groups) for (const r of g.rows) lines.push([r.ward, r.province, r.code, r.receiverName, r.phone, r.address, r.items, r.toCollect, r.courierName, r.note].map(csvCell).join(","));
  const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `danh-sach-tu-giao-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** «Đã giao» — phiếu giao có ký nhận; mặc định người ký = người nhận trên đơn, mốc = bây giờ (sửa được). */
function DeliveredButton({ row }: { row: SelfDeliveryRow }) {
  const [open, setOpen] = useState(false);
  const [receiver, setReceiver] = useState(row.receiverName);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PackageCheck className="size-4" /> Đã giao
      </Button>
    );
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await selfDeliveredAction(row.id, { signedAt: new Date().toISOString(), receiverName: receiver, note });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="w-full max-w-sm space-y-2 rounded-lg border bg-background p-3 text-left">
      <p className="text-[12px] text-muted-foreground">Ghi phiếu giao lúc này. Tiền thu được ghi bằng phiếu thu ở trang đơn.</p>
      <Input value={receiver} onChange={(e) => setReceiver(e.target.value)} placeholder="Người ký nhận" aria-label="Người ký nhận" />
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Ghi chú (không bắt buộc)" aria-label="Ghi chú phiếu giao" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu phiếu giao
        </Button>
      </div>
    </div>
  );
}

/** «Giao không thành công» — bắt buộc lý do; đơn «Đã hoàn», hàng về tồn ngay (ORDER_OUTCOME.md mục 11.2). */
function FailedButton({ row }: { row: SelfDeliveryRow }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Undo2 className="size-4" /> Không thành công
      </Button>
    );
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await selfDeliveryFailedAction(row.id, { reason });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      toast.success(res.message);
      setOpen(false);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="w-full max-w-sm space-y-2 rounded-lg border bg-background p-3 text-left">
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Vì sao (khách không nhận, sai địa chỉ…) — bắt buộc" aria-label="Lý do giao không thành công" />
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Thôi
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xác nhận không thành công
        </Button>
      </div>
    </div>
  );
}

export function SelfDeliveryBoard({ groups, couriers, canWrite }: { groups: SelfDeliveryGroup[]; couriers: { id: string; label: string }[]; canWrite: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [courier, setCourier] = useState("");
  const [pending, setPending] = useState(false);
  const allIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups]);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const assign = async (courierUserId: string | null) => {
    const ids = allIds.filter((id) => selected.has(id));
    if (!ids.length) {
      toast.error("Chọn ít nhất một đơn.");
      return;
    }
    setPending(true);
    try {
      const res = await assignCourierAction(ids, courierUserId);
      if ("error" in res) toast.error(res.error);
      else {
        toast.success(res.message);
        setSelected(new Set());
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        {canWrite ? (
          <>
            <span className="text-[12.5px] text-muted-foreground">Đã chọn {selected.size} đơn</span>
            <select className="h-8 rounded-md border bg-background px-2 text-[13px]" value={courier} onChange={(e) => setCourier(e.target.value)} aria-label="Người giao">
              <option value="">— Chọn người giao —</option>
              {couriers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" disabled={pending || !courier || !selected.size} onClick={() => assign(courier)}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <UserCheck className="size-4" />} Giao cho người này
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={pending || !selected.size} onClick={() => assign(null)}>
              Bỏ người giao
            </Button>
          </>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="size-4" /> In danh sách
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => downloadCsv(groups)}>
            <Download className="size-4" /> Xuất CSV
          </Button>
        </div>
      </div>
      {groups.map((g) => {
        const ids = g.rows.map((r) => r.id);
        const all = ids.every((id) => selected.has(id));
        const sum = g.rows.reduce((s, r) => s + r.toCollect, 0);
        return (
          <section key={g.key} className="break-inside-avoid rounded-xl border bg-card">
            <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
              {canWrite ? <input type="checkbox" className="size-4 print:hidden" checked={all} onChange={(e) => toggle(ids, e.target.checked)} aria-label={`Chọn cả ${g.ward}`} /> : null}
              <h3 className="text-[14px] font-semibold">
                {g.ward} <span className="font-normal text-muted-foreground">· {g.province}</span>
              </h3>
              <span className="ml-auto text-[12.5px] text-muted-foreground">
                {g.rows.length} đơn · thu {formatVND(sum)}
              </span>
            </header>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] text-muted-foreground">
                  <tr>
                    {canWrite ? <th className="w-8 px-3 py-1.5 print:hidden" /> : null}
                    <th className="px-2 py-1.5">Đơn · người nhận</th>
                    <th className="px-2 py-1.5">Địa chỉ</th>
                    <th className="px-2 py-1.5">Hàng</th>
                    <th className="px-2 py-1.5 text-right">Thu của khách</th>
                    <th className="px-2 py-1.5">Người giao</th>
                    {canWrite ? <th className="px-2 py-1.5 print:hidden" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.id} className="border-t align-top">
                      {canWrite ? (
                        <td className="px-3 py-2 print:hidden">
                          <input type="checkbox" className="size-4" checked={selected.has(r.id)} onChange={(e) => toggle([r.id], e.target.checked)} aria-label={`Chọn đơn ${r.code}`} />
                        </td>
                      ) : null}
                      <td className="px-2 py-2">
                        <Link href={`/orders/${encodeURIComponent(r.id)}`} className="font-medium text-primary hover:underline">
                          {r.code}
                        </Link>
                        <div>{r.receiverName || "—"}</div>
                        <div className="tabular-nums text-muted-foreground">{r.phone || "—"}</div>
                      </td>
                      <td className="max-w-[260px] px-2 py-2">
                        {r.address || "—"}
                        {r.note ? <div className="mt-1 text-[12px] text-muted-foreground">Ghi chú: {r.note}</div> : null}
                      </td>
                      <td className="max-w-[240px] px-2 py-2">{r.items || "—"}</td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums">{formatVND(r.toCollect)}</td>
                      <td className="px-2 py-2">{r.courierName || <span className="text-muted-foreground">Chưa giao cho ai</span>}</td>
                      {canWrite ? (
                        <td className="px-2 py-2 print:hidden">
                          <div className="flex flex-col items-end gap-1.5">
                            <DeliveredButton row={r} />
                            <FailedButton row={r} />
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
