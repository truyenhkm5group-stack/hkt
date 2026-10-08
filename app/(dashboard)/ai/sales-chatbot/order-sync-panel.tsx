"use client";

import Link from "next/link";
import { useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/ui-bits";
import { saveOrderSyncAction } from "@/lib/actions/sales-chatbot";
import { formatDateTime } from "@/lib/format";
import { ORDER_SYNC_OUTCOME_LABEL } from "@/lib/sales-chatbot/order-sync-shared";
import type { OrderSyncView } from "@/lib/sales-chatbot/order-sync";

/**
 * ĐỒNG BỘ ĐƠN TỪ FANPAGE — công tắc RIÊNG, tách khỏi bật / tắt bot (chủ shop HSLC 03/10/2026). Hai trạng thái in cạnh nhau để
 * người đọc thấy ngay: tắt bot KHÔNG dừng ghi đơn. Không `router.refresh()` sau action — action đã `revalidatePath`.
 */
/** `shell`: vỏ Chốt Đơn — chỉ đổi CHỮ (không «ERP» / chữ kỹ thuật), câu của ERP giữ nguyên từng ký tự. */
export function OrderSyncPanel({ view, manage, shell = false }: { view: OrderSyncView; manage: boolean; shell?: boolean }) {
  const [pending, start] = useTransition();
  const on = view.config.enabled;
  return (
    <SectionCard
      title="Đồng bộ đơn từ fanpage"
      description={`${on ? "ĐANG BẬT" : "Đang tắt"} · ${view.createdLast7Days} đơn ghi trong 7 ngày · chatbot trả lời khách: ${view.botEnabled ? "đang bật" : "đang tắt"}`}
      hint={`Nhân viên chốt đơn với khách trên fanpage ⇒ ${shell ? "Chốt Đơn" : "ERP"} tự lên đơn «Mới» (khoảng 2 phút sau khi hội thoại yên) để nhân viên kiểm rồi chốt. Chạy với hội thoại do NGƯỜI phụ trách: khi bot tắt, hoặc khi hội thoại đã chuyển nhân viên. Bot đang bật và đang trả lời thì bot tự lên đơn. Khách cũ không gửi lại SĐT / địa chỉ ⇒ lấy theo đơn trước của chính khách và ghi rõ trong đơn. Mỗi hội thoại đọc lại tốn một lượt AI của shop.`}
    >
      <div className="space-y-3 text-sm" data-testid="order-sync-panel">
        <label className="flex items-center gap-2">
          <Switch
            checked={on}
            disabled={!manage || pending}
            aria-label="Bật đồng bộ đơn từ fanpage"
            onCheckedChange={(v) =>
              start(async () => {
                const r = await saveOrderSyncAction(v);
                if ("error" in r) toast.error(r.error);
                else toast.success(r.message);
              })
            }
          />
          <span>
            Ghi đơn nhân viên chốt trên fanpage vào {shell ? "Chốt Đơn" : "ERP"} — <b>không phụ thuộc</b> bật / tắt chatbot
          </span>
        </label>
        {on && !view.channelActive ? <p className="text-xs text-amber-700 dark:text-amber-400">Chưa nối kênh nhắn tin nào (Facebook trực tiếp hoặc Pancake) — chưa có tin nào để đọc.</p> : null}
        {view.recent.length ? (
          <ul className="divide-y text-xs" data-testid="order-sync-recent">
            {view.recent.map((r) => (
              <li key={r.conversationId} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                <span className="min-w-0 flex-1">
                  <b className={r.outcome === "ERROR" ? "text-destructive" : undefined}>{ORDER_SYNC_OUTCOME_LABEL[r.outcome]}</b> · {r.result}
                </span>
                <span className="flex items-center gap-3 text-muted-foreground">
                  {r.orderId ? (
                    <Link href={`/orders/${encodeURIComponent(r.orderId)}`} className="underline underline-offset-2">
                      Mở đơn
                    </Link>
                  ) : null}
                  {formatDateTime(r.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : on ? (
          <p className="text-xs text-muted-foreground">Chưa đọc hội thoại nào kể từ lúc bật.</p>
        ) : null}
      </div>
    </SectionCard>
  );
}
