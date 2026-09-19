import { Card } from "@/components/ui/card";
import { formatVND } from "@/lib/format";
import { ORDER_DRAFT_WARNING_LABEL, type OrderDraft } from "@/lib/constants/order-draft";
import { cn } from "@/lib/utils";

/**
 * XEM TRƯỚC BẢN NHÁP ĐƠN — nhìn thấy thứ SẼ đi vào đơn, trước khi có đơn nào.
 *
 * Màn hình này KHÔNG có nút tạo đơn, và đó không phải vì nấc quyền hạn đang thấp: nó là màn hình
 * QUAN SÁT một lượt chạy đã xong. Đường tạo đơn duy nhất trong kho mã là công cụ
 * `order.create_draft`, và nó đi qua cổng công cụ với `AI_ALLOW_ORDER_CREATE` ghim CẤM.
 *
 * Ô tiền trống in `—`, không in `0 ₫`: một bản nháp nói "0 đồng" cho một đơn chưa ai định giá là
 * lời nói dối nguy hiểm nhất màn hình này có thể nói (AGENTS.md mục 42).
 */
function Dong({ label, value, missing }: { label: string; value: string; missing?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-right text-sm", missing && "font-semibold text-rose-700 dark:text-rose-300")}>{value}</span>
    </div>
  );
}

export function OrderDraftCard({ draft }: { draft: OrderDraft }) {
  const thieu = new Set(draft.missing.map((m) => m.key));
  const chua = (v: string) => v || "—";

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">11 · Bản nháp đơn (XEM TRƯỚC — không tạo đơn)</h2>
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-[11.5px] font-semibold",
            draft.ready
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
          )}
        >
          {draft.ready ? "ĐỦ ĐIỀU KIỆN LÊN ĐƠN" : "CHƯA ĐỦ ĐIỀU KIỆN"}
        </span>
      </div>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <div>
          <Dong label="Khách" value={chua(draft.customerName)} />
          <Dong label="Số điện thoại" value={chua(draft.phone)} missing={thieu.has("PHONE")} />
          <Dong label="Địa chỉ" value={chua(draft.address)} missing={thieu.has("ADDRESS")} />
          <Dong label="Tỉnh / thành" value={chua(draft.province)} />
          <Dong label="Nguồn" value={`${chua(draft.sourcePageId)} · ${chua(draft.sourceConversationId)}`} />
        </div>
        <div>
          <Dong label="Mã hàng" value={chua(draft.productCode)} />
          <Dong label="Sản phẩm" value={chua(draft.productName)} />
          <Dong label="Mẫu mã (SKU)" value={chua(draft.sku || draft.variantLabel)} missing={thieu.has("VARIANT")} />
          <Dong label="Màu · size" value={`${chua(draft.color)} · ${chua(draft.size)}`} />
          <Dong label="Số lượng" value={String(draft.quantity)} missing={thieu.has("QUANTITY")} />
        </div>
      </div>

      <div className="grid gap-x-6 sm:grid-cols-2">
        <div>
          <Dong label="Đơn giá đang khai" value={formatVND(draft.unitPrice)} />
          <Dong label="Phí ship đang khai" value={formatVND(draft.shippingFee)} />
        </div>
        <div>
          {/*
            TỔNG là con số MÁY CHỦ đã tính, không phải đơn giá × số lượng tính lại ở đây. Hai công
            thức tiền thì sớm muộn nói hai số, và lúc ấy không ai biết số nào đã được đọc cho khách.
          */}
          <Dong label="TỔNG (máy chủ tính)" value={formatVND(draft.total)} missing={thieu.has("PRICE")} />
          <Dong label="Thu hộ khi giao (COD)" value={formatVND(draft.codAmount)} />
        </div>
      </div>

      {draft.codPolicy ? <p className="text-xs text-muted-foreground">Chính sách thu hộ: {draft.codPolicy}</p> : null}

      {draft.missing.length ? (
        <div className="rounded-lg border border-rose-500/40 bg-rose-50/60 p-2.5 dark:bg-rose-950/20">
          <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">Còn thiếu để lên đơn ({draft.missing.length})</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {draft.missing.map((m) => (
              <li key={m.key}>· {m.label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.warnings.length ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-50/60 p-2.5 dark:bg-amber-950/20">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">Cần đọc kỹ ({draft.warnings.length})</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {draft.warnings.map((w) => (
              <li key={w}>· {ORDER_DRAFT_WARNING_LABEL[w]}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[11px] text-muted-foreground">
        Bản nháp này KHÔNG được gửi đi đâu và KHÔNG tạo đơn. &quot;Đủ điều kiện&quot; đòi CẢ HAI vế: đủ năm điều kiện máy chủ VÀ
        khách đã xác nhận đúng bản chốt đã gửi — đủ dữ liệu không phải là đã chốt.
      </p>
    </Card>
  );
}
