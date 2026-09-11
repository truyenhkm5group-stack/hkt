"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, MessageSquare, Phone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { loadShipmentQuickView, recordCareAction } from "@/lib/actions/care";
import { CARE_ACTION_KINDS, CARE_ACTION_LABEL, type CareActionKind } from "@/lib/constants/delivery-tower";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import type { QuickView } from "@/lib/queries/shipment-quickview";
import { cn } from "@/lib/utils";

/**
 * ───────────── NGĂN KÉO TRA NHANH ─────────────
 *
 * ĐO ĐƯỢC: gọi một khách giao hụt trước đây cần SÁU lần chuyển màn hình (vận đơn → chi tiết → quay
 * lại → đơn → khách → tab Pancake). Ngăn kéo này gom vào MỘT lần mở, và danh sách phía sau không
 * mất chỗ — đóng lại là vẫn ở đúng dòng vừa đọc.
 *
 * Dữ liệu tải KHI MỞ, không tải sẵn cho cả 60 dòng: tải sẵn là bắt người dùng trả giá cho 59 kiện
 * họ không mở.
 *
 * KHÔNG có nút nào tự nhắn khách. Nút ở đây GHI LẠI việc người vừa làm.
 */
export function CareDrawer({
  shipmentId,
  children,
  className,
  open: openNgoai,
  onOpenChange,
}: {
  shipmentId: string;
  /** Không truyền thì ngăn kéo không tự vẽ nút mở — dùng cho nơi đã có sẵn nút (ô lệnh ⌘K). */
  children?: React.ReactNode;
  className?: string;
  /** Điều khiển từ ngoài. Bỏ trống thì ngăn kéo tự quản trạng thái mở của mình. */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [openTrong, setOpenTrong] = useState(false);
  const open = openNgoai ?? openTrong;
  const setOpen = (v: boolean) => {
    setOpenTrong(v);
    onOpenChange?.(v);
  };
  const [data, setData] = useState<QuickView | null>(null);
  const [dangTai, setDangTai] = useState(false);
  const [kind, setKind] = useState<CareActionKind>("CALLED_REACHED");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function tai() {
    if (data) return;
    setDangTai(true);
    const r = await loadShipmentQuickView(shipmentId);
    setData(r ?? null);
    setDangTai(false);
  }

  function ghi() {
    start(async () => {
      const r = await recordCareAction({ shipmentId, kind, note });
      if (r.error) {
        setMsg(r.error);
        return;
      }
      setMsg("Đã ghi nhận");
      setNote("");
      const lai = await loadShipmentQuickView(shipmentId);
      setData(lai ?? null);
    });
  }

  // Mở từ ngoài (ô lệnh ⌘K) cũng phải nạp dữ liệu — nếu chỉ nạp trong hàm bấm nút thì ngăn kéo
  // mở ra rỗng và đứng im mãi.
  useEffect(() => {
    if (open && !data && !dangTai) void tai();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      {children ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            void tai();
          }}
          className={cn("text-left hover:underline", className)}
        >
          {children}
        </button>
      ) : null}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-xl">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-base">{data ? `${data.customer} · ${data.tracking}` : "Đang mở kiện hàng…"}</SheetTitle>
            <SheetDescription>
              {data ? `${data.stageLabel} · VTP báo "${data.rawStatus}" · COD ${formatVND(data.codAmount)}` : "Tải thông tin cần để gọi khách"}
            </SheetDescription>
          </SheetHeader>

          {dangTai || !data ? (
            <div className="flex items-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Đang tải…
            </div>
          ) : (
            <div className="space-y-4 px-4 pb-8">
              {/* ───── Gọi được ngay, không phải copy số ───── */}
              <div className="flex flex-wrap items-center gap-2">
                {data.phone ? (
                  <a href={`tel:${data.phone}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] font-semibold hover:bg-accent">
                    <Phone className="size-3.5" /> {data.phone}
                  </a>
                ) : (
                  <span className="rounded-lg border px-2.5 py-1.5 text-[12.5px] text-muted-foreground">Chưa có SĐT</span>
                )}
                {data.chatUrl ? (
                  <a href={data.chatUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent">
                    <MessageSquare className="size-3.5" /> Mở chat Pancake
                  </a>
                ) : null}
                {data.orderSystemId ? (
                  <Link href={`/orders/${data.orderId}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent">
                    <ExternalLink className="size-3.5" /> Đơn #{data.orderSystemId}
                  </Link>
                ) : null}
                <Link href={`/shipments/${data.shipmentId}`} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1.5 text-[12.5px] hover:bg-accent">
                  Chi tiết vận đơn
                </Link>
              </div>

              {data.address ? <p className="text-[12px] leading-snug text-muted-foreground">{data.address}</p> : null}

              {/* ───── Khách này đã mua bao nhiêu lần: đổi hẳn cách nói chuyện ───── */}
              {data.history ? (
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-[12px]">
                  <b>Khách cũ:</b> {formatNumber(data.history.totalOrders)} đơn · giao thành công {formatNumber(data.history.delivered)} · hoàn {formatNumber(data.history.returned)}
                  {data.attemptNo && data.attemptNo > 1 ? <> · đây là lần gửi thứ {data.attemptNo}</> : null}
                  {data.failedAttempts > 0 ? <> · bưu tá đã giao hụt {formatNumber(data.failedAttempts)} lần</> : null}
                  {/* Đếm theo SĐT, không theo customer_id: Pancake tách khách theo trang nên một người có thể có nhiều hồ sơ. */}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">Đếm theo số điện thoại — một người nhắn từ hai trang Pancake vẫn là một khách.</div>
                </div>
              ) : null}

              {data.items.length ? (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách đặt gì</div>
                  <ul className="space-y-0.5 text-[12.5px]">
                    {data.items.map((it, idx) => (
                      <li key={idx} className="flex justify-between gap-3">
                        <span>{it.name}</span>
                        <span className="numeric shrink-0 text-muted-foreground">
                          {formatNumber(it.qty)} × {formatVND(it.price)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">ĐVVC nói gì</div>
                {data.timeline.length ? (
                  <ul className="space-y-1.5 border-l pl-3 text-[12px]">
                    {data.timeline.map((t, idx) => (
                      <li key={idx} className="relative">
                        <span className="absolute -left-[15px] top-1.5 size-1.5 rounded-full bg-border" />
                        <div className="font-medium">{t.status}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatDateTime(t.at)}
                          {t.location ? ` · ${t.location}` : ""} · {t.source}
                        </div>
                        {t.note ? <div className="text-[11.5px] leading-snug text-muted-foreground">{t.note}</div> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  /* Không có mốc nào là một THÔNG TIN, không phải một ô trống: kiện này ERP chưa từng nhận tin gì. */
                  <p className="text-[12px] text-muted-foreground">Chưa nhận được sự kiện nào từ ĐVVC cho kiện này — đây là lỗ hổng dữ liệu, không phải kiện đang yên ổn.</p>
                )}
              </div>

              {/* ───── Ghi lại việc vừa làm ───── */}
              <div className="rounded-xl border p-3">
                <div className="text-[12px] font-semibold">Ghi lại việc vừa làm</div>
                <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  ERP không tự nhắn khách. Ghi ở đây để đo được việc chăm có cứu được đơn hay không — đo từ hôm nay, không dựng lại quá khứ.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CARE_ACTION_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setKind(k)}
                      className={cn("rounded-lg border px-2 py-1 text-[11.5px]", kind === k ? "border-primary bg-primary/10 font-semibold" : "hover:bg-accent")}
                    >
                      {CARE_ACTION_LABEL[k]}
                    </button>
                  ))}
                </div>
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Khách nói gì? (không bắt buộc)" className="mt-2 min-h-[60px] text-[12.5px]" />
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" onClick={ghi} disabled={pending}>
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Ghi nhận
                  </Button>
                  {msg ? <span className="text-[12px] text-muted-foreground">{msg}</span> : null}
                </div>
              </div>

              {data.careActions.length ? (
                <div>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Đã chăm trước đó</div>
                  <ul className="space-y-1 text-[12px]">
                    {data.careActions.map((c, idx) => (
                      <li key={idx}>
                        <b className="font-medium">{c.label}</b>
                        {c.note ? ` · ${c.note}` : ""}
                        <span className="text-[11px] text-muted-foreground">
                          {" "}
                          · {c.actor || "không rõ người"} · {formatDateTime(c.at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
