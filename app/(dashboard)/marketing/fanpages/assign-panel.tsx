"use client";

import { useState, useTransition } from "react";
import { TableToolsFor } from "@/components/data-table/table-tools";
import { History, Undo2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignFanpage, renameFanpage, revokeAssignment, toggleFanpage } from "@/lib/actions/fanpage-attribution";
import { FANPAGE_ACCESS_HINT, FANPAGE_ACCESS_LABEL, FANPAGE_ACCESS_TONE, type FanpageAccessStatus } from "@/lib/constants/fanpage-access";
import { formatDate, formatNumber, formatVND, todayVN } from "@/lib/format";
import { cn } from "@/lib/utils";

export type FanpageView = {
  id: string;
  externalPageId: string;
  /** Tên hiển thị đã chọn: alias (người đặt) > name (API) > page_id. */
  name: string;
  /** Tên NGƯỜI đặt, để đổ vào ô sửa. */
  alias: string;
  /** Tên API trả về — hiện riêng để người khai phân biệt được nguồn của cái tên. */
  externalName: string;
  access: FanpageAccessStatus;
  active: boolean;
  orders: number;
  confirmedOrders: number;
  confirmedRevenue: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  current: { assignmentId: string; marketerId: string; marketerLabel: string; effectiveFrom: string } | null;
  history: { id: string; marketerLabel: string; effectiveFrom: string; effectiveTo: string | null; active: boolean; note: string }[];
};

export type MarketerOption = { id: string; label: string; department: string };

/**
 * KHAI AI PHỤ TRÁCH FANPAGE NÀO, KỂ TỪ NGÀY NÀO.
 *
 * Ba điều màn hình này cố tình KHÔNG làm:
 *   · không có nút "đổi người" ghi đè dòng cũ — đổi người là đóng một khoảng và mở một khoảng;
 *   · không có ô gõ Page ID — page do máy phát hiện từ chính đơn đã về, gõ tay là một lượt sai
 *     chính tả chờ sẵn mà màn hình vẫn báo "đã gán";
 *   · không tự chạy đối soát sau mỗi lần lưu — lượt đối soát quét toàn bộ đơn, và người khai năm
 *     fanpage liên tiếp không nên phải trả giá đó năm lần.
 */
export function AssignPanel({ pages, marketers, canWrite }: { pages: FanpageView[]; marketers: MarketerOption[]; canWrite: boolean }) {
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, { marketerId: string; from: string; note: string }>>({});
  const [pending, startTransition] = useTransition();
  const today = todayVN();

  const get = (id: string) => draft[id] ?? { marketerId: "", from: today, note: "" };
  const set = (id: string, patch: Partial<{ marketerId: string; from: string; note: string }>) => setDraft((d) => ({ ...d, [id]: { ...get(id), ...patch } }));

  const save = (page: FanpageView) => {
    const d = get(page.id);
    if (!d.marketerId) {
      toast.error("Chưa chọn marketer");
      return;
    }
    startTransition(async () => {
      const r = await assignFanpage({ fanpageId: page.id, marketerId: d.marketerId, effectiveFrom: d.from, note: d.note });
      if ("error" in r) toast.error(r.error, { duration: 9000 });
      else {
        toast.success(r.message ?? "Đã gán", { duration: 8000 });
        setDraft((s) => ({ ...s, [page.id]: { marketerId: "", from: today, note: "" } }));
      }
    });
  };

  const revoke = (assignmentId: string) =>
    startTransition(async () => {
      const r = await revokeAssignment({ assignmentId });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message ?? "Đã thu hồi", { duration: 8000 });
      }
    });

  const saveAlias = (page: FanpageView) =>
    startTransition(async () => {
      const r = await renameFanpage({ fanpageId: page.id, alias: aliasDraft[page.id] ?? "" });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã đặt tên gợi nhớ");
        setAliasDraft((d) => {
          const next = { ...d };
          delete next[page.id];
          return next;
        });
      }
    });

  const toggle = (page: FanpageView) =>
    startTransition(async () => {
      const r = await toggleFanpage({ fanpageId: page.id, active: !page.active });
      if ("error" in r) toast.error(r.error);
    });

  if (!pages.length) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
        Chưa có fanpage nào trong sổ. Bấm <b>Đối soát lại</b> ở đầu trang để máy phát hiện fanpage từ <code>page_id</code> của đơn đã đồng bộ.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {pages.map((p) => {
        const d = get(p.id);
        const showHistory = openHistory === p.id;
        return (
          <div key={p.id} className={cn("rounded-xl border bg-card p-4 text-[13px] shadow-xs", !p.active && "opacity-60")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{p.externalPageId}</code>
                  <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", FANPAGE_ACCESS_TONE[p.access])} title={FANPAGE_ACCESS_HINT[p.access]}>
                    {FANPAGE_ACCESS_LABEL[p.access]}
                  </span>
                  {!p.active ? <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Đã tắt</span> : null}
                </div>
                <p className="mt-1 text-muted-foreground">
                  {formatNumber(p.orders)} đơn · {formatNumber(p.confirmedOrders)} đã xác nhận · {formatVND(p.confirmedRevenue)} · đơn đầu {formatDate(p.firstOrderAt)} · gần nhất {formatDate(p.lastOrderAt)}
                </p>
                {p.alias && p.externalName && p.alias !== p.externalName ? (
                  <p className="mt-0.5 text-[11.5px] text-muted-foreground">Tên Pancake: {p.externalName}</p>
                ) : null}
                <p className="mt-1">
                  {p.current ? (
                    <>
                      Đang phụ trách: <b>{p.current.marketerLabel}</b> <span className="text-muted-foreground">từ {formatDate(p.current.effectiveFrom)}</span>
                    </>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">Chưa ai phụ trách — đơn của page này không quy kết được cho ai.</span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {canWrite ? (
                  <div className="flex items-center gap-1">
                    <Input
                      className="h-8 w-40"
                      placeholder="Tên gợi nhớ…"
                      maxLength={120}
                      value={aliasDraft[p.id] ?? p.alias}
                      onChange={(e) => setAliasDraft((d) => ({ ...d, [p.id]: e.target.value }))}
                    />
                    {(aliasDraft[p.id] ?? p.alias) !== p.alias ? (
                      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => saveAlias(p)}>
                        Lưu tên
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpenHistory(showHistory ? null : p.id)}>
                  <History className="size-4" /> Lịch sử ({p.history.length})
                </Button>
                {canWrite ? (
                  <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => toggle(p)}>
                    {p.active ? "Tắt page" : "Bật lại"}
                  </Button>
                ) : null}
              </div>
            </div>

            {canWrite ? (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
                <div className="min-w-[190px]">
                  <Label className="text-[11px] text-muted-foreground">Giao cho</Label>
                  <Select value={d.marketerId} onValueChange={(v) => set(p.id, { marketerId: v })}>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Chọn marketer" />
                    </SelectTrigger>
                    <SelectContent>
                      {marketers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.label} <span className="text-muted-foreground">· {m.department}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[11px] text-muted-foreground">Hiệu lực từ ngày</Label>
                  <Input type="date" className="h-9 w-[160px]" value={d.from} onChange={(e) => set(p.id, { from: e.target.value })} />
                </div>
                <div className="min-w-[200px] flex-1">
                  <Label className="text-[11px] text-muted-foreground">Ghi chú (tuỳ chọn)</Label>
                  <Input className="h-9" value={d.note} maxLength={300} placeholder="Vì sao chuyển…" onChange={(e) => set(p.id, { note: e.target.value })} />
                </div>
                <Button type="button" size="sm" disabled={pending} onClick={() => save(p)}>
                  <UserPlus className="size-4" /> Gán
                </Button>
              </div>
            ) : null}

            {showHistory ? (
              <>
                <TableToolsFor tableId="marketing-fanpages-assign-panel" />
                <div className="mt-3 overflow-x-auto border-t pt-3">
                  {p.history.length ? (
                    <table id="marketing-fanpages-assign-panel" className="w-full min-w-[520px] text-[12.5px]">
                      <thead className="text-left text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Marketer</th>
                          <th className="py-1 pr-3 font-medium">Từ</th>
                          <th className="py-1 pr-3 font-medium">Đến</th>
                          <th className="py-1 pr-3 font-medium">Ghi chú</th>
                          <th className="py-1 font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {p.history.map((h) => (
                          <tr key={h.id} className={cn("border-t", !h.active && "text-muted-foreground line-through")}>
                            <td className="py-1.5 pr-3 font-medium">{h.marketerLabel}</td>
                            <td className="py-1.5 pr-3">{formatDate(h.effectiveFrom)}</td>
                            <td className="py-1.5 pr-3">{h.effectiveTo ? formatDate(h.effectiveTo) : <span className="text-emerald-700 dark:text-emerald-400">còn hiệu lực</span>}</td>
                            <td className="py-1.5 pr-3">{h.note || "—"}</td>
                            <td className="py-1.5 text-right">
                              {canWrite && h.active ? (
                                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => revoke(h.id)}>
                                  <Undo2 className="size-3.5" /> Thu hồi
                                </Button>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-muted-foreground">Chưa có phân công nào cho fanpage này.</p>
                  )}
                  <p className="mt-2 text-[11.5px] text-muted-foreground">
                    Thu hồi là <b>tắt</b> một dòng khai sai, không xoá: đơn đã quy kết bằng dòng đó vẫn truy ngược được. Sau khi sửa, bấm <b>Đối soát lại</b> ở đầu trang.
                  </p>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
