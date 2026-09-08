import type { CodStatus, OrderStage, ShipmentStage } from "@/db/schema";
import { ORDER_STAGE_LABEL, SOURCE_COLORS } from "@/lib/constants/pancake";
import { COD_STATUS_LABEL, SHIPMENT_STAGE_LABEL } from "@/lib/constants/viettelpost";
import { OUTCOME_LABEL, OUTCOME_TONE, type OrderOutcome } from "@/lib/constants/returns";
import { VERIFIED_OUTCOME_LABEL, type VerifiedOutcome } from "@/lib/constants/data-quality";
import { TRUTH_DIMENSIONS, type TruthDimension } from "@/lib/constants/truth";
import { cn } from "@/lib/utils";

const base = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-[11.5px] font-semibold leading-5";

/**
 * BỐN CHIỀU KHÁC NHAU, ĐỪNG ĐỂ NHÌN GIỐNG NHAU.
 *
 * "Đã giao" của Pancake, "Giao thành công" của Viettel Post, "Đã về ngân hàng" của tiền và "Giao
 * thành công" của KẾT QUẢ ĐƠN là bốn điều khác hẳn nhau — nhưng cả bốn đều là nhãn xanh hình viên
 * thuốc. Người đọc thấy xanh là yên tâm mà không biết mình đang nhìn chiều nào.
 *
 * Mỗi nhãn nay mang một tiền tố ngắn nói rõ ĐANG NÓI VỀ CHIỀU NÀO, kèm tooltip giải thích nguồn sự
 * thật của chiều đó (lib/constants/truth.ts).
 */
const DIMENSION_PREFIX: Record<TruthDimension, string> = {
  order_status: "Đơn",
  shipment_status: "VĐ",
  shipment_outcome: "KQ",
  payment_status: "Tiền",
  reconciliation_status: "Đối soát",
};

function DimensionMark({ dimension }: { dimension: TruthDimension }) {
  return (
    <span className="rounded-sm bg-current/15 px-1 text-[9.5px] font-bold tracking-wide uppercase opacity-80" aria-hidden>
      {DIMENSION_PREFIX[dimension]}
    </span>
  );
}

function dimensionTitle(dimension: TruthDimension, value: string) {
  const d = TRUTH_DIMENSIONS[dimension];
  return `${d.label}: ${value}
${d.question}
Nguồn sự thật: ${d.sourceOfTruth}
Không suy ra từ: ${d.neverInferFrom.join(", ")}`;
}

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

export function OrderStageBadge({ stage, label, className, showDimension = true }: { stage: OrderStage; label?: string; className?: string; showDimension?: boolean }) {
  const text = label ?? ORDER_STAGE_LABEL[stage];
  return (
    <span className={cn(base, orderTone[stage] ?? orderTone.NEW, className)} title={dimensionTitle("order_status", text)}>
      {showDimension ? <DimensionMark dimension="order_status" /> : <span className="size-1.5 rounded-full bg-current opacity-70" />}
      {text}
    </span>
  );
}

export function ShipmentStageBadge({ stage, label, className, showDimension = true }: { stage: ShipmentStage; label?: string; className?: string; showDimension?: boolean }) {
  const text = label ?? SHIPMENT_STAGE_LABEL[stage];
  return (
    <span className={cn(base, shipmentTone[stage] ?? shipmentTone.UNKNOWN, className)} title={dimensionTitle("shipment_status", text)}>
      {showDimension ? <DimensionMark dimension="shipment_status" /> : <span className="size-1.5 rounded-full bg-current opacity-70" />}
      {text}
    </span>
  );
}

export function CodStatusBadge({ status, className, showDimension = true }: { status: CodStatus; className?: string; showDimension?: boolean }) {
  return (
    <span className={cn(base, codTone[status], className)} title={dimensionTitle("payment_status", COD_STATUS_LABEL[status])}>
      {showDimension ? <DimensionMark dimension="payment_status" /> : null}
      {COD_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * KẾT QUẢ ĐƠN — chiều thứ ba, và là chiều duy nhất được dùng cho KPI. Trước đây nó được vẽ tay ở
 * ba trang khác nhau nên mỗi trang một kiểu; nay chung một nhãn với mọi chiều còn lại.
 */
export function OrderOutcomeBadge({ outcome, className, showDimension = true }: { outcome: OrderOutcome; className?: string; showDimension?: boolean }) {
  return (
    <span className={cn(base, OUTCOME_TONE[outcome], className)} title={dimensionTitle("shipment_outcome", OUTCOME_LABEL[outcome])}>
      {showDimension ? <DimensionMark dimension="shipment_outcome" /> : null}
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

/** Kết quả đơn theo quy tắc ĐÃ XÁC MINH CHỨNG TỪ — có thêm giá trị "Chưa xác minh". */
export function VerifiedOutcomeBadge({ outcome, className }: { outcome: VerifiedOutcome; className?: string }) {
  const tone =
    outcome === "DELIVERED" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
    : outcome === "UNVERIFIED" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
    : outcome === "RETURNED" || outcome === "RETURNED_BY_RULE" ? "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300"
    : outcome === "IN_TRANSIT" ? "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300"
    : "bg-muted text-muted-foreground";
  return (
    <span className={cn(base, tone, className)} title={dimensionTitle("shipment_outcome", VERIFIED_OUTCOME_LABEL[outcome])}>
      <DimensionMark dimension="shipment_outcome" />
      {VERIFIED_OUTCOME_LABEL[outcome]}
    </span>
  );
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
