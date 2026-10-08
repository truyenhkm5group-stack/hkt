"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressPlace, useAddressCheck } from "@/components/orders/address-place";
import { chatOrderContextAction, createOrderFromChatAction } from "@/lib/actions/chat-orders";
import { manualOrderTotals } from "@/lib/constants/manual-orders";
import { formatVND } from "@/lib/format";
import type { ChatOrderContext } from "@/lib/records/chat-order";

/**
 * FORM TẠO ĐƠN TRONG KHUNG CHAT (POS tự chủ · P5). Hợp đồng với hộp thư (M8): props `{ conversationId, defaults?, onCreated? }`,
 * không tự đọc tin nhắn — chỉ hỏi máy chủ quyền + khách của hội thoại + mẫu mã + đơn đã có (`chatOrderContextAction`).
 *
 * Mỗi lần mở form sinh MỘT `requestKey`: bấm «Tạo đơn» hai lần hay mạng gửi lại thì máy chủ trả đúng đơn đã tạo. Số tiền xem
 * trước tính bằng CHÍNH hàm của máy chủ (`manualOrderTotals`); máy chủ kiểm lại mọi thứ lúc lưu.
 */

type Line = { variantId: string; quantity: string; unitPrice: string };
const EMPTY_LINE: Line = { variantId: "", quantity: "1", unitPrice: "" };
const SELECT = "h-8 w-full rounded-md border bg-background px-2 text-[12.5px]";

function toInt(v: string, fallback = Number.NaN): number {
  const digits = v.replace(/[^\d]/g, "");
  return digits ? Number(digits) : fallback;
}

function newRequestKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function ChatOrderForm({
  conversationId,
  defaults,
  onCreated,
}: {
  conversationId: string;
  defaults?: { name?: string; phone?: string; address?: string; customerId?: string | null };
  onCreated?: (orderId: string) => void;
}) {
  const [ctx, setCtx] = useState<ChatOrderContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [useCustomer, setUseCustomer] = useState(true);
  const [name, setName] = useState(defaults?.name ?? "");
  const [phone, setPhone] = useState(defaults?.phone ?? "");
  const [address, setAddress] = useState(defaults?.address ?? "");
  const [province, setProvince] = useState("");
  // Xã / phường: bộ đọc địa chỉ của máy chủ đề xuất; người chọn thì người thắng.
  const [pickedWard, setPickedWard] = useState("");
  const [stage, setStage] = useState<"CONFIRMED" | "NEW">("CONFIRMED");
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }]);
  const [shippingFee, setShippingFee] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void chatOrderContextAction(conversationId).then((r) => {
      if (!alive) return;
      if ("error" in r) setLoadError(r.error);
      else setCtx(r.context);
    });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const addressLine = address.trim() || (useCustomer ? (ctx?.customer?.address ?? "") : "");
  const provinceLine = province.trim() || (useCustomer && !address.trim() ? (ctx?.customer?.province ?? "") : "");
  const check = useAddressCheck(addressLine, provinceLine);
  const ward = pickedWard || check?.ward || "";

  const variantById = useMemo(() => new Map((ctx?.variants ?? []).map((v) => [v.id, v])), [ctx]);
  const customerId = useCustomer ? (defaults?.customerId ?? ctx?.customer?.id ?? null) : null;
  const payloadLines = lines.map((l) => ({ variantId: l.variantId, quantity: toInt(l.quantity), unitPrice: toInt(l.unitPrice), discount: 0 }));
  const preview = manualOrderTotals(payloadLines, 0, toInt(shippingFee, 0));

  if (loadError) return <p className="text-[12.5px] text-destructive">{loadError}</p>;
  if (!ctx) {
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Đang mở form…
      </p>
    );
  }
  if (!ctx.canCreate) return <p className="text-[12.5px] text-muted-foreground">{ctx.reason}</p>;
  if (created) {
    return (
      <div className="space-y-2 text-[12.5px]">
        <p>
          Đã tạo đơn{" "}
          <Link href={`/orders/${encodeURIComponent(created)}`} className="font-medium underline underline-offset-2">
            mở đơn
          </Link>
          .
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setCreated(null);
            setRequestKey(newRequestKey());
            setLines([{ ...EMPTY_LINE }]);
            setNote("");
          }}
        >
          Tạo thêm một đơn khác
        </Button>
      </div>
    );
  }

  // Hồ sơ gắn qua SĐT gõ tay (chưa khớp Facebook): chữ hiển thị là chữ khách GÕ trong hội thoại, không phải của hồ sơ (luật 5).
  const unverified = Boolean(ctx.customer && !ctx.customer.verified);
  const setLine = (i: number, patch: Partial<Line>) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await createOrderFromChatAction(conversationId, {
        requestKey,
        customerId,
        name,
        phone,
        address,
        province,
        ward,
        stage,
        lines: payloadLines,
        shippingFee: toInt(shippingFee, 0),
        note,
      });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      toast.success(r.message);
      setCreated(r.orderId);
      onCreated?.(r.orderId);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="w-full max-w-xl space-y-3 text-[12.5px]" data-testid="chat-order-form">
      {ctx.existing.length ? (
        <p className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Hội thoại này đã có {ctx.existing.length} đơn còn sống
          {ctx.existing.some((e) => e.byBot) ? " (có đơn bot chốt)" : ""}:{" "}
          {ctx.existing.map((e, i) => (
            <span key={e.id}>
              {i ? ", " : ""}
              <Link href={`/orders/${encodeURIComponent(e.id)}`} className="underline underline-offset-2">
                {e.id.slice(0, 14)}
              </Link>
            </span>
          ))}
          . Kiểm tra trước khi tạo thêm — ERP không chặn.
        </p>
      ) : null}

      {ctx.customer || defaults?.customerId ? (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={useCustomer} onChange={(e) => setUseCustomer(e.target.checked)} />
          <span>
            {unverified ? "Khách gõ trong hội thoại" : "Khách của hội thoại"}: <b>{ctx.customer ? [ctx.customer.name, ctx.customer.phone].filter(Boolean).join(" · ") || "—" : "đã gắn"}</b>
          </span>
        </label>
      ) : null}
      {unverified ? (
        <p className="text-[11.5px] text-muted-foreground" data-testid="chat-order-unverified">
          Chưa xác minh là chủ hồ sơ của SĐT này (chưa khớp tài khoản Facebook đang chat) — ERP không điền tên / địa chỉ đã lưu của hồ sơ. Ô trống lấy chữ khách gõ trong hội thoại; không có thì phải nhập.
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={unverified ? (ctx.customer?.name ? "Người nhận (trống = tên khách gõ trong chat)" : "Tên người nhận (bắt buộc)") : customerId ? "Người nhận (trống = tên khách)" : "Tên khách"} aria-label="Tên người nhận" />
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder={customerId ? "SĐT nhận (trống = SĐT khách)" : "SĐT khách"} aria-label="SĐT người nhận" />
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder={unverified ? (ctx.customer?.address ? "Địa chỉ giao (trống = địa chỉ khách gõ trong chat)" : "Địa chỉ giao (bắt buộc)") : customerId ? "Địa chỉ giao (trống = địa chỉ khách)" : "Địa chỉ giao"} aria-label="Địa chỉ giao" className="sm:col-span-2" />
        <Input value={province} onChange={(e) => setProvince(e.target.value)} placeholder="Tỉnh / thành (tuỳ chọn)" aria-label="Tỉnh / thành" />
        <AddressPlace check={check} ward={ward} onPick={setPickedWard} />
      </div>
      {!customerId ? <p className="text-[11.5px] text-muted-foreground">Chưa chọn khách: ERP tìm khách theo SĐT; đã có thì dùng lại (không sửa hồ sơ), chưa có thì tạo mới.</p> : null}

      <div className="space-y-1.5">
        {lines.map((l, i) => {
          const v = variantById.get(l.variantId);
          return (
            <div key={i} className="grid grid-cols-[1fr_56px_96px_28px] items-center gap-1.5">
              <select
                className={SELECT}
                value={l.variantId}
                onChange={(e) => {
                  const picked = variantById.get(e.target.value);
                  setLine(i, { variantId: e.target.value, unitPrice: l.unitPrice || (picked?.price ? String(picked.price) : "") });
                }}
                aria-label={`Mẫu mã dòng ${i + 1}`}
              >
                <option value="">— Chọn sản phẩm —</option>
                {ctx.variants.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                    {o.sku ? ` (${o.sku})` : ""}
                  </option>
                ))}
              </select>
              <Input className="h-8" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} aria-label={`Số lượng dòng ${i + 1}`} />
              <Input className="h-8" inputMode="numeric" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} placeholder={v?.price ? String(v.price) : "Đơn giá"} aria-label={`Đơn giá dòng ${i + 1}`} />
              <Button type="button" size="icon" variant="ghost" className="size-7" disabled={lines.length === 1} onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))} aria-label="Bỏ dòng">
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })}
        <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setLines((prev) => [...prev, { ...EMPTY_LINE }])}>
          <Plus className="size-3.5" /> Thêm dòng
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <Input inputMode="numeric" value={shippingFee} onChange={(e) => setShippingFee(e.target.value)} placeholder="Phí ship khách trả (0 nếu miễn)" aria-label="Phí ship" />
        <select className={SELECT} value={stage} onChange={(e) => setStage(e.target.value === "NEW" ? "NEW" : "CONFIRMED")} aria-label="Trạng thái đơn">
          <option value="CONFIRMED">Đã xác nhận (khách đã chốt)</option>
          <option value="NEW">Mới (chờ khách xác nhận)</option>
        </select>
      </div>
      <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ghi chú đơn (tuỳ chọn)" aria-label="Ghi chú đơn" />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>Khách trả (gồm ship): <b>{preview.ok ? formatVND(preview.totals.totalPriceAfterDiscount + preview.totals.shippingFee) : "—"}</b></span>
        <Button size="sm" onClick={() => void submit()} disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null} Tạo đơn
        </Button>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}
