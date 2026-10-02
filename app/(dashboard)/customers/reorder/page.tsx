import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { TouchpointForm, ReorderSettingForm } from "@/components/reorder/reorder-forms";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { REORDER_STATUS_LABEL, TOUCH_KIND_LABEL, TOUCH_OUTCOME_LABEL, type ReorderStatus } from "@/lib/constants/reorder";
import { formatDate, formatVND } from "@/lib/format";
import { loadReorderBoard, type ReorderRow } from "@/lib/queries/reorder";
import { manualOrderOrgGate } from "@/lib/records/order-create";
import { cn } from "@/lib/utils";

export const metadata = { title: "Nhắc mua lại" };

const VIEWS = {
  due: { label: "Cần gọi", statuses: ["DUE", "DUE_SOON"] },
  snoozed: { label: "Đã hẹn lại", statuses: ["SNOOZED"] },
  unknown: { label: "Chưa biết chu kỳ", statuses: ["UNKNOWN"] },
  all: { label: "Tất cả", statuses: ["DUE", "DUE_SOON", "NOT_DUE", "SNOOZED", "UNKNOWN", "DECLINED"] },
} as const satisfies Record<string, { label: string; statuses: readonly ReorderStatus[] }>;
type ViewKey = keyof typeof VIEWS;

const TONE: Record<ReorderStatus, string> = {
  DUE: "font-semibold text-rose-700 dark:text-rose-400",
  DUE_SOON: "text-amber-700 dark:text-amber-400",
  NOT_DUE: "text-muted-foreground",
  SNOOZED: "text-muted-foreground",
  UNKNOWN: "text-muted-foreground",
  DECLINED: "text-muted-foreground",
};

function whenText(r: ReorderRow): string {
  if (r.daysUntil === null || !r.expectedOn) return "—";
  if (r.daysUntil < 0) return `${formatDate(r.expectedOn)} (quá ${-r.daysUntil} ngày)`;
  if (r.daysUntil === 0) return `${formatDate(r.expectedOn)} (hôm nay)`;
  return `${formatDate(r.expectedOn)} (còn ${r.daysUntil} ngày)`;
}

/**
 * NHẮC MUA LẠI (0189 · docs/verticals/reorder-reminders.md) — khách sắp / đã tới lúc mua lại theo chu kỳ của CHÍNH họ (trung
 * vị khoảng cách giữa các lần mua) hoặc chu kỳ mặc định chủ shop khai. Chỉ tổ chức tạo đơn tay (tổ chức nhà có CRM riêng).
 */
export default async function ReorderPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("customers:view");
  if (!(await manualOrderOrgGate()).allowed) notFound();
  const raw = (await searchParams).view;
  const view: ViewKey = typeof raw === "string" && raw in VIEWS ? (raw as ViewKey) : "due";
  const board = await loadReorderBoard();
  const allowed = new Set<ReorderStatus>(VIEWS[view].statuses);
  const rows = board.rows.filter((r) => allowed.has(r.status));
  const canTouch = can(user, "customers:write");
  const c = board.counts;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Khách hàng"
        title="Nhắc mua lại"
        description={`${c.DUE} đến hạn · ${c.DUE_SOON} sắp tới hạn · ${c.SNOOZED} đã hẹn lại · ${c.UNKNOWN} chưa biết chu kỳ`}
        hint="Chu kỳ của khách = trung vị khoảng cách giữa các lần mua (đơn tạo tay đã chốt / đã giao). Khách mới mua một lần dùng chu kỳ mặc định của tổ chức — chưa khai thì «chưa biết», không đoán. Ghi liên hệ có hẹn ngày ⇒ khách rời danh sách gọi tới ngày hẹn; đặt đơn mới ⇒ chu kỳ tính lại."
      />
      {can(user, "settings:manage") ? (
        <SectionCard title="Cài đặt" description={board.setting.defaultCycleDays === null ? "Chưa khai chu kỳ mặc định" : `Chu kỳ mặc định ${board.setting.defaultCycleDays} ngày · nhắc trước ${board.setting.dueSoonDays} ngày`}>
          <ReorderSettingForm current={board.setting} />
        </SectionCard>
      ) : null}
      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Lọc">
        {(Object.keys(VIEWS) as ViewKey[]).map((k) => (
          <Link key={k} href={`/customers/reorder?view=${k}`} className={cn("rounded-full border px-3 py-1", k === view ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")} aria-current={k === view ? "page" : undefined}>
            {VIEWS[k].label}
          </Link>
        ))}
      </nav>
      <SectionCard padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="Không có khách nào trong nhóm này" description={view === "due" ? "Chưa khách nào tới lúc mua lại." : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-reorder-rows={view}>
              <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Khách</th>
                  <th className="px-4 py-2">Lần mua gần nhất</th>
                  <th className="px-4 py-2">Chu kỳ</th>
                  <th className="px-4 py-2">Dự kiến mua lại</th>
                  <th className="px-4 py-2">Liên hệ gần nhất</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.customerId} className="border-t border-hairline align-top" data-reorder-status={r.status}>
                    <td className="px-4 py-2">
                      <Link href={`/customers/${encodeURIComponent(r.customerId)}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      {r.phone ? (
                        <div className="text-xs">
                          <a href={`tel:${r.phone}`} className="text-primary hover:underline">
                            {r.phone}
                          </a>{" "}
                          ·{" "}
                          <a href={`https://zalo.me/${r.phone.replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                            Zalo
                          </a>
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      {r.lastOrderOn ? formatDate(r.lastOrderOn) : "—"}
                      {r.lastOrderId ? (
                        <div className="text-xs">
                          <Link href={`/orders/${encodeURIComponent(r.lastOrderId)}`} className="hover:underline">
                            {formatVND(r.lastOrderTotal)}
                          </Link>{" "}
                          · {r.orderDays} lần mua
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-xs">{r.cycleDays === null ? "Chưa biết" : `${r.cycleDays} ngày · ${r.cycleSource === "OWN" ? "của khách" : "mặc định"}`}</td>
                    <td className={cn("px-4 py-2", TONE[r.status])}>
                      {whenText(r)}
                      <div className="text-xs font-normal text-muted-foreground">{REORDER_STATUS_LABEL[r.status]}</div>
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {r.lastTouch ? (
                        <div className="mb-1">
                          {formatDate(r.lastTouch.on)} · {TOUCH_KIND_LABEL[r.lastTouch.kind]} · {TOUCH_OUTCOME_LABEL[r.lastTouch.outcome]}
                          {r.lastTouch.nextContactOn ? ` · hẹn ${formatDate(r.lastTouch.nextContactOn)}` : ""}
                          {r.lastTouch.userName ? ` · ${r.lastTouch.userName}` : ""}
                          {r.lastTouch.note ? <div className="text-muted-foreground">{r.lastTouch.note}</div> : null}
                        </div>
                      ) : (
                        <div className="mb-1 text-muted-foreground">Chưa liên hệ</div>
                      )}
                      {canTouch ? <TouchpointForm customerId={r.customerId} compact /> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
