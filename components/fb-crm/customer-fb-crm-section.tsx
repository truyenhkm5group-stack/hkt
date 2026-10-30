import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import { FB_CONNECTION_STATUS_LABEL, FB_CONNECTION_STATUS_TONE, FB_CONNECTION_STATUSES, FB_EVENT_KIND_LABEL, FB_EVENT_KINDS, FB_URL_SOURCE_LABEL, type FbConnectionStatus, type FbEventKind } from "@/lib/constants/fb-crm";
import { formatDate, formatDateTime } from "@/lib/format";
import { fbCrmCustomerPanel, fbCrmEnabled } from "@/lib/queries/fb-crm";
import { cn } from "@/lib/utils";

const KIND_SET = new Set<string>(FB_EVENT_KINDS);
const STATUS_SET = new Set<string>(FB_CONNECTION_STATUSES);

/** Giá trị «từ → tới» của một dòng nhật ký, đọc được bằng mắt (trạng thái ra nhãn tiếng Việt; mã người / link giữ nguyên ngắn gọn). */
function valueText(kind: string, v: string | null): string {
  if (v === null || v === "") return "—";
  if (kind === "STATUS_CHANGED" || kind === "CONSENT_RECORDED") return STATUS_SET.has(v) ? FB_CONNECTION_STATUS_LABEL[v as FbConnectionStatus] : v;
  if (kind === "DNC_SET" || kind === "DNC_CLEARED") return v === "true" ? "có" : "không";
  if (kind === "OWNER_CHANGED") return "đổi người";
  return v;
}

/**
 * Khối «Facebook CRM» trên Customer 360 (lát 2): trạng thái kết bạn · link (kèm NGUỒN) · NV phụ trách · ngày hẹn · vài dòng nhật ký gần
 * nhất · nút sang /customers/facebook-crm?c=<mã> để làm thao tác. Cờ tổ chức `fbCrm.enabled` tắt ⇒ không dựng gì. Chỉ đọc.
 */
export async function CustomerFbCrmSection({ customerId }: { customerId: string }) {
  if (!(await fbCrmEnabled())) return null;
  const panel = await fbCrmCustomerPanel(customerId);
  const href = `/customers/facebook-crm?c=${encodeURIComponent(customerId)}`;
  return (
    <SectionCard
      id="facebook-crm"
      title="Facebook CRM"
      description={panel ? `${FB_CONNECTION_STATUS_LABEL[panel.connectionStatus]}${panel.doNotContact ? " · KHÔNG LIÊN HỆ" : ""}` : "CSDL chưa áp 0262 — chưa đọc được"}
      actions={
        <Link href={href} className="text-xs font-semibold text-primary hover:underline">
          Mở trên Facebook CRM
        </Link>
      }
    >
      {panel ? (
        <div className="space-y-3 text-sm" data-customer-fb-crm={panel.connectionStatus}>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={cn("rounded px-1.5 py-0.5 font-semibold", FB_CONNECTION_STATUS_TONE[panel.connectionStatus])}>{FB_CONNECTION_STATUS_LABEL[panel.connectionStatus]}</span>
            {panel.doNotContact ? <span className="font-semibold text-rose-700 dark:text-rose-400" title={panel.doNotContactReason ?? ""}>Không liên hệ{panel.doNotContactReason ? `: ${panel.doNotContactReason}` : ""}</span> : null}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Link Facebook</dt>
            <dd>
              {panel.fbProfileUrl ? (
                <>
                  <a href={panel.fbProfileUrl} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
                    {panel.fbProfileUrl.replace(/^https:\/\/www\./, "")}
                  </a>{" "}
                  <span className="text-muted-foreground">· {FB_URL_SOURCE_LABEL[panel.fbUrlSource]}</span>
                </>
              ) : (
                <span className="text-muted-foreground">Chưa có link Facebook</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Phụ trách</dt>
            <dd>{panel.careOwnerName ?? <span className="text-muted-foreground">Chưa ai</span>}</dd>
            <dt className="text-muted-foreground">Hẹn chăm sóc</dt>
            <dd>{panel.nextCareOn ? formatDate(panel.nextCareOn) : <span className="text-muted-foreground">Chưa hẹn</span>}</dd>
          </dl>
          {panel.events.length ? (
            <ul className="space-y-1 border-t border-hairline pt-2 text-xs">
              {panel.events.map((e, i) => (
                <li key={`${e.createdAt.toISOString()}-${i}`}>
                  {formatDateTime(e.createdAt)} · {KIND_SET.has(e.kind) ? FB_EVENT_KIND_LABEL[e.kind as FbEventKind] : e.kind}
                  {e.kind === "NEXT_CARE_SET" || e.kind === "STATUS_CHANGED" ? ` · ${valueText(e.kind, e.fromValue)} → ${valueText(e.kind, e.toValue)}` : ""}
                  {e.actorName ? ` · ${e.actorName}` : " · máy"}
                  {e.note ? <span className="text-muted-foreground"> — {e.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Chưa có thao tác nào trên Facebook CRM cho khách này.</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Lược đồ của tổ chức chưa cập nhật xong (migration 0262). Khối này hiện khi lượt cập nhật hoàn tất.</p>
      )}
    </SectionCard>
  );
}
