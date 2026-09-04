import type { CodStatus, OrderStage, ShipmentStage } from "@/db/schema";
import { ORDER_STAGE_LABEL, SOURCE_COLORS } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { cn } from "@/lib/utils";

const base = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

const orderTone: Record<OrderStage, string> = {
  NEW: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  WAITING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  CONFIRMED: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PACKING: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  READY_TO_SHIP: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950/60 dark:text-fuchsia-300",
  SHIPPED: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  DELIVERED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  PAID: "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300",
  RETURNING: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  PARTIAL_RETURN: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  RETURNED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  CANCELLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  DELETED: "bg-zinc-200 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500",
};

const shipmentTone: Record<ShipmentStage, string> = {
  PENDING: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  PICKED_UP: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  IN_TRANSIT: "bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  OUT_FOR_DELIVERY: "bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  DELIVERED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DELIVERY_FAILED: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  RETURNING: "bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300",
  RETURNED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  CANCELLED: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const codTone: Record<CodStatus, string> = {
  NOT_APPLICABLE: "bg-muted text-muted-foreground",
  PENDING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  COLLECTED: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  RECONCILED: "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  PAID_TO_BANK: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  DISPUTED: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
};

export function OrderStageBadge({ stage, label, className }: { stage: OrderStage; label?: string; className?: string }) {
  return (
    <span className={cn(base, orderTone[stage] ?? orderTone.NEW, className)}>
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {label ?? ORDER_STAGE_LABEL[stage]}
    </span>
  );
}

export function ShipmentStageBadge({ stage, label, className }: { stage: ShipmentStage; label?: string; className?: string }) {
  return (
    <span className={cn(base, shipmentTone[stage] ?? shipmentTone.UNKNOWN, className)}>
      <span className="size-1.5 rounded-full bg-current opacity-70" />
      {label ?? SHIPMENT_STAGE_LABEL[stage]}
    </span>
  );
}

export function CodStatusBadge({ status, className }: { status: CodStatus; className?: string }) {
  return <span className={cn(base, codTone[status], className)}>{COD_STATUS_LABEL[status]}</span>;
}

export function SourceBadge({ source, className }: { source: string; className?: string }) {
  return <span className={cn(base, "font-medium", SOURCE_COLORS[source] ?? "bg-muted text-muted-foreground", className)}>{source}</span>;
}

export function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    SUCCESS: ["Thành công", "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"],
    PARTIAL: ["Một phần", "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"],
    RUNNING: ["Đang chạy", "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"],
    FAILED: ["Thất bại", "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"],
    PROCESSED: ["Đã xử lý", "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"],
    RECEIVED: ["Đã nhận", "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"],
    IGNORED: ["Bỏ qua", "bg-muted text-muted-foreground"],
  };
  const [label, tone] = map[status] ?? [status, "bg-muted text-muted-foreground"];
  return <span className={cn(base, tone)}>{label}</span>;
}
