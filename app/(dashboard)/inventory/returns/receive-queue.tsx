"use client";

import { RECEIVE_SLA_DAYS } from "@/lib/constants/return-lifecycle";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PackageCheck, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { confirmReturnReceived } from "@/lib/actions/returns-warehouse";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import type { ItemsBasis, OrderLinkBasis, ReturnItem, ReturnProductContext } from "@/lib/returns/product-context";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BÀN NHẬN HÀNG HOÀN ═══════════
 *
 * Mỗi dòng trả lời đúng câu hỏi của người đang đứng ở kho: kiện này là đơn nào, lẽ ra có món gì,
 * bao nhiêu cái, nằm đây bao lâu rồi. Mức độ tin cậy nói thẳng trên dòng — kiện chưa ghép được đơn
 * KHÔNG được trình bày giống kiện đã ghép chắc.
 *
 * Bấm "đã nhận" ở đây CHỈ chuyển kiện sang hàng đợi ĐẾM. Nó không cộng một món nào vào tồn.
 */

export type QueueRow = {
  shipmentId: string;
  code: string | null;
  receiverName: string;
  receiverPhone: string;
  codAmount: number;
  returnedAt: string | null;
  ageDays: number | null;
  ctx: ReturnProductContext;
};

const BASIS_LABEL: Record<OrderLinkBasis, string> = {
  DIRECT: "Ghép chắc",
  RETURN_LEG: "Qua mã gốc",
  AMBIGUOUS: "Mã gốc ra nhiều đơn",
  UNRESOLVED: "Chưa xác định đơn/sản phẩm",
};

const BASIS_HINT: Record<OrderLinkBasis, string> = {
  DIRECT: "Vận đơn mang sẵn khoá đơn, do khâu đồng bộ gắn theo mã vận đơn. Đây là căn cứ chắc nhất.",
  RETURN_LEG: "Vận đơn chiều về (mã gốc + 1P1) không mang khoá đơn. ERP lần ngược MÃ GỐC về vận đơn chiều đi rồi lấy đơn của nó — vẫn là định danh, không phải đoán theo khách.",
  AMBIGUOUS: "Mã gốc lần ra nhiều đơn khác nhau. ERP KHÔNG chọn hộ — cần người đối chiếu rồi gắn tay.",
  UNRESOLVED: "Không có định danh nào dẫn tới đơn. ERP không ghép theo SĐT hay tên khách vì một khách mua nhiều lần sẽ ghép nhầm mà trông vẫn như thật.",
};

/** Kiện chưa ghép được thì phải nhìn ra ngay, không lẫn vào đám đã ghép chắc. */
const BASIS_TONE: Record<OrderLinkBasis, string> = {
  DIRECT: "bg-muted text-muted-foreground",
  RETURN_LEG: "bg-info/12 text-info",
  AMBIGUOUS: "bg-warning/15 text-amber-700 dark:text-amber-300",
  UNRESOLVED: "bg-destructive/10 text-destructive",
};

const ITEMS_NOTE: Record<ItemsBasis, string> = {
  ITEM_EVIDENCE: "Phiếu trả ghi rõ món và số lượng — đây là hàng thực sự được khai báo hoàn.",
  ORDER_ONLY: "Mới chỉ biết kiện thuộc đơn nào, CHƯA biết món nào thực sự nằm trong kiện. Đối chiếu bằng mắt khi mở kiện.",
  NONE: "Chưa đủ căn cứ để nói trong kiện có gì.",
};

function ItemLine({ it }: { it: ReturnItem }) {
  const variant = [it.color, it.size].filter(Boolean).join(" / ");
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium">{it.sku || it.name || "—"}</span>
      {variant ? <span className="text-muted-foreground"> · {variant}</span> : null}
      <span className="numeric"> × {it.quantity}</span>
      {it.isBonus ? <span className="ml-1 rounded bg-muted px-1 text-[10px]">tặng</span> : null}
    </span>
  );
}

export function ReceiveQueue({ rows, total, canWrite }: { rows: QueueRow[]; total: number; canWrite: boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<QueueRow | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  // Lọc tại chỗ: danh sách đã bị chặn ở phía máy chủ nên đây là vài trăm dòng, gõ tới đâu thấy tới
  // đó, không phải đi vòng lên máy chủ cho mỗi ký tự.
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter(
      (r) =>
        [r.code, r.receiverName, r.receiverPhone, r.ctx.orderCode].some((v) => (v ?? "").toLowerCase().includes(t)) ||
        r.ctx.items.some((it) => it.sku.toLowerCase().includes(t) || it.name.toLowerCase().includes(t)),
    );
  }, [rows, q]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = () => {
    const ids = [...selected];
    if (!ids.length) return;
    start(async () => {
      const r = await confirmReturnReceived({ ids });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.message);
      setSelected(new Set());
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Mã vận đơn, mã đơn, SĐT, tên khách, mã hàng…" className="h-8 w-full pl-8 sm:w-80" />
        </div>
        <span className="text-[12px] text-muted-foreground">
          {formatNumber(visible.length)}/{formatNumber(total)} kiện
        </span>
        {selected.size && canWrite ? (
          <Button size="sm" className="ml-auto h-8" disabled={pending} onClick={confirm}>
            <PackageCheck className="size-3.5" /> Đã nhận {selected.size} kiện
          </Button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-[12.5px]">
          <thead className="bg-table-head text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              {canWrite ? <th className="w-8 px-2 py-2" /> : null}
              <th className="px-2 py-2 text-left">Kiện</th>
              <th className="px-2 py-2 text-left">Đơn · khách</th>
              <th className="px-2 py-2 text-left">Hàng kỳ vọng trong kiện</th>
              <th className="px-2 py-2 text-right">SL</th>
              <th className="px-2 py-2 text-right">COD</th>
              <th className="px-2 py-2 text-right">Tuổi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {visible.map((r) => {
              const c = r.ctx;
              const shown = c.items.slice(0, 2);
              const rest = c.items.length - shown.length;
              return (
                <tr key={r.shipmentId} className="cursor-pointer hover:bg-row-hover" onClick={() => setOpen(r)}>
                  {canWrite ? (
                    <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selected.has(r.shipmentId)} onCheckedChange={() => toggle(r.shipmentId)} aria-label="Chọn kiện" />
                    </td>
                  ) : null}
                  <td className="px-2 py-2">
                    <div className="font-medium">{r.code ?? r.shipmentId}</div>
                    <span className={cn("inline-block rounded px-1 text-[10px]", BASIS_TONE[c.basis])}>{BASIS_LABEL[c.basis]}</span>
                  </td>
                  <td className="px-2 py-2">
                    <div className="font-medium">{c.orderCode ?? "—"}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{r.receiverName || "—"}</div>
                  </td>
                  <td className="max-w-[320px] px-2 py-2">
                    {c.items.length ? (
                      <div className="flex flex-col gap-0.5">
                        {shown.map((it, i) => (
                          <ItemLine key={`${it.sku}-${i}`} it={it} />
                        ))}
                        {rest > 0 ? <span className="text-[11px] text-muted-foreground">+{rest} sản phẩm — bấm để xem đủ</span> : null}
                        {c.itemsBasis === "ORDER_ONLY" ? (
                          <span className="inline-flex w-fit items-center gap-1 rounded bg-warning/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
                            Chưa xác nhận mặt hàng hoàn
                            <InfoHint>{ITEMS_NOTE.ORDER_ONLY}</InfoHint>
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <TriangleAlert className="size-3" /> Chưa xác định đơn/sản phẩm
                        <InfoHint>{BASIS_HINT[c.basis]}</InfoHint>
                      </span>
                    )}
                  </td>
                  {/* CHƯA BIẾT hiện là "—", không phải 0. Số 0 ở đây đọc thành "kiện rỗng". */}
                  <td className="numeric px-2 py-2 text-right font-semibold">{c.expectedQty === null ? "—" : formatNumber(c.expectedQty)}</td>
                  <td className="numeric px-2 py-2 text-right text-muted-foreground">{formatVND(r.codAmount, { compact: true })}</td>
                  <td className={cn("numeric px-2 py-2 text-right", (r.ageDays ?? 0) >= RECEIVE_SLA_DAYS && "font-semibold text-rose-600 dark:text-rose-400")}>
                    {r.ageDays === null ? "—" : `${r.ageDays}n`}
                  </td>
                </tr>
              );
            })}
            {!visible.length ? (
              <tr>
                <td colSpan={canWrite ? 7 : 6} className="px-3 py-10 text-center text-muted-foreground">
                  {q ? "Không có kiện nào khớp từ khoá." : "Không còn kiện nào chờ kho nhận."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Sheet open={Boolean(open)} onOpenChange={(v) => !v && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {open ? (
            <>
              <SheetHeader>
                <SheetTitle>{open.code ?? open.shipmentId}</SheetTitle>
                <SheetDescription>
                  {open.ctx.basis === "RETURN_LEG" && open.ctx.viaBaseCode ? `Lần về đơn qua mã gốc ${open.ctx.viaBaseCode}` : BASIS_HINT[open.ctx.basis]}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6 text-[13px]">
                <section>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Kiện hàng</h3>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    <dt className="text-muted-foreground">Khách</dt>
                    <dd>{open.receiverName || "—"}{open.receiverPhone ? ` · ${open.receiverPhone}` : ""}</dd>
                    <dt className="text-muted-foreground">ĐVVC báo về shop</dt>
                    <dd>{open.returnedAt ? formatDate(new Date(open.returnedAt)) : "—"}{open.ageDays !== null ? ` · ${open.ageDays} ngày trước` : ""}</dd>
                    <dt className="text-muted-foreground">COD khai báo</dt>
                    <dd className="numeric">{formatVND(open.codAmount)}</dd>
                  </dl>
                </section>

                <section>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Đơn gốc</h3>
                  {open.ctx.orderId ? (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                      <dt className="text-muted-foreground">Mã đơn</dt>
                      <dd>
                        <Link href={`/orders/${open.ctx.orderId}`} className="font-semibold text-primary hover:underline">
                          {open.ctx.orderCode ?? open.ctx.orderId}
                        </Link>
                      </dd>
                      <dt className="text-muted-foreground">Ngày đặt</dt>
                      <dd>{open.ctx.orderedAt ? formatDate(new Date(open.ctx.orderedAt)) : "—"}</dd>
                      <dt className="text-muted-foreground">COD đơn</dt>
                      <dd className="numeric">{open.ctx.orderCod === null ? "—" : formatVND(open.ctx.orderCod)}</dd>
                    </dl>
                  ) : (
                    <p className="text-muted-foreground">
                      {open.ctx.basis === "AMBIGUOUS"
                        ? `Mã gốc ${open.ctx.viaBaseCode ?? ""} lần ra ${open.ctx.candidateOrderIds.length} đơn khác nhau — cần người đối chiếu, ERP không chọn hộ.`
                        : "Không có định danh nào dẫn tới đơn."}
                    </p>
                  )}
                </section>

                <section>
                  <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Hàng kỳ vọng quay về
                    <InfoHint>{ITEMS_NOTE[open.ctx.itemsBasis]}</InfoHint>
                  </h3>
                  {open.ctx.items.length ? (
                    <>
                      <ul className="divide-y divide-hairline rounded-lg border">
                        {open.ctx.items.map((it, i) => (
                          <li key={`${it.sku}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2">
                            <div className="min-w-0">
                              <div className="truncate font-medium">{it.name || it.sku || "—"}</div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {it.sku}
                                {[it.color, it.size].filter(Boolean).length ? ` · ${[it.color, it.size].filter(Boolean).join(" / ")}` : ""}
                              </div>
                            </div>
                            <span className="numeric shrink-0 font-semibold">× {it.quantity}</span>
                          </li>
                        ))}
                      </ul>
                      {open.ctx.itemsBasis === "ORDER_ONLY" ? (
                        <p className="mt-1.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[12px] text-amber-800 dark:text-amber-300">
                          Đây là <b>đơn gốc gồm những gì</b>, chưa phải xác nhận hàng nào thực sự quay về. Khách trả một phần là chuyện thường — đối chiếu khi mở kiện.
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <p className="text-muted-foreground">Chưa xác định được.</p>
                  )}
                </section>

                <p className="rounded-lg bg-muted px-2.5 py-1.5 text-[12px] text-muted-foreground">
                  Bấm “đã nhận” chỉ chuyển kiện sang hàng đợi <b>đếm</b>. Tồn kho không đổi cho tới khi có người đếm thực tế.
                </p>

                {canWrite ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await confirmReturnReceived({ ids: [open.shipmentId] });
                        if ("error" in r) {
                          toast.error(r.error);
                          return;
                        }
                        toast.success(r.message);
                        setOpen(null);
                        router.refresh();
                      })
                    }
                  >
                    <PackageCheck className="size-3.5" /> Ghi nhận kiện đã về kho
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
