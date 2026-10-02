import { TouchpointForm } from "@/components/reorder/reorder-forms";
import { SectionCard } from "@/components/ui-bits";
import { can, type SessionUser } from "@/lib/auth/session";
import { REORDER_STATUS_LABEL, TOUCH_KIND_LABEL, TOUCH_OUTCOME_LABEL, type TouchKind, type TouchOutcome } from "@/lib/constants/reorder";
import { formatDate, formatDateTime } from "@/lib/format";
import { loadReorderBoard, recentTouchpoints } from "@/lib/queries/reorder";

/** Khung MUA LẠI & LIÊN HỆ trên trang một khách (0189): chu kỳ, ngày dự kiến mua lại, năm lượt liên hệ gần nhất. */
export async function CustomerReorderSection({ user, customerId }: { user: SessionUser; customerId: string }) {
  const [board, touches] = await Promise.all([loadReorderBoard({ customerIds: [customerId] }), recentTouchpoints(customerId)]);
  const r = board.rows[0] ?? null;
  return (
    <SectionCard
      id="reorder"
      title="Mua lại & liên hệ"
      description={
        r
          ? `${REORDER_STATUS_LABEL[r.status]}${r.expectedOn ? ` · dự kiến mua lại ${formatDate(r.expectedOn)}` : ""}${r.cycleDays ? ` · chu kỳ ${r.cycleDays} ngày (${r.cycleSource === "OWN" ? "của khách" : "mặc định"})` : ""}`
          : "Chưa có đơn đã chốt — chưa tính được lúc mua lại"
      }
    >
      <div className="space-y-3 text-sm" data-customer-reorder={r?.status ?? "NONE"}>
        {touches.length ? (
          <ul className="space-y-1 text-xs">
            {touches.map((t) => (
              <li key={t.id}>
                {formatDateTime(t.at)} · {TOUCH_KIND_LABEL[t.kind as TouchKind] ?? t.kind} · {TOUCH_OUTCOME_LABEL[t.outcome as TouchOutcome] ?? t.outcome}
                {t.nextContactOn ? ` · hẹn ${formatDate(t.nextContactOn)}` : ""}
                {t.userName ? ` · ${t.userName}` : ""}
                {t.note ? <span className="text-muted-foreground"> — {t.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">Chưa ghi lượt liên hệ nào.</p>
        )}
        {can(user, "customers:write") ? <TouchpointForm customerId={customerId} /> : null}
      </div>
    </SectionCard>
  );
}
