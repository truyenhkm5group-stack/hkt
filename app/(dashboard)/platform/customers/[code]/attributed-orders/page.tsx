import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SaasConsoleNav } from "@/components/saas/console-bits";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { OUTCOME_LABEL } from "@/lib/constants/returns";
import { TENANT_VALUE_WINDOWS } from "@/lib/constants/tenant-value-metrics";
import { formatDateTime, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { ATTRIBUTION_OVERLAY_LABEL, ORDER_ATTRIBUTION_LABEL, type AttributionOverlay, type OrderAttribution } from "@/lib/sales-chatbot/attribution-shared";
import { loadAttributedOrdersAsOperator, parseDrillFilter, type DrillFilter } from "@/lib/saas/tenant-value-drill";
import { cn } from "@/lib/utils";

export const metadata = { title: "Đơn ↔ hội thoại · Giá trị khách hàng" };

const FILTERS: { key: DrillFilter; label: string }[] = [
  { key: null, label: "Tất cả" },
  { key: "AI_ONLY", label: "AI tự chốt" },
  { key: "AI_ASSISTED", label: "AI góp công" },
  { key: "HUMAN_ONLY", label: "Người bán" },
  { key: "UNATTRIBUTED", label: "Chưa quy kết" },
  { key: "AI_RECOVERED", label: ATTRIBUTION_OVERLAY_LABEL.AI_RECOVERED },
  { key: "AI_UPSELL", label: ATTRIBUTION_OVERLAY_LABEL.AI_UPSELL },
];

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * DRILL-DOWN ĐƠN ↔ HỘI THOẠI của MỘT workspace — tuyến RIÊNG, chỉ tới khi người vận hành bấm từ khối «Giá trị & kinh tế đơn vị».
 * Đây là chỗ DUY NHẤT của Trung tâm giá trị đọc SỐNG CSDL tổ chức (qua `listAttributedOrders`, cùng tập + cùng luật với tổng trong
 * ảnh chụp); trang danh sách và trang một khách chỉ đọc ảnh chụp. Không PII: mã đơn, mã hội thoại, nhãn, kết cục, số tiền.
 */
export default async function AttributedOrdersPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const orgCode = one(sp.org) ?? "";
  const days = Number(one(sp.w) ?? 30);
  const page = Math.max(1, Math.trunc(Number(one(sp.page) ?? 1)) || 1);
  const filter = parseDrillFilter(one(sp.nhan));
  if (!orgCode) notFound();
  const r = await loadAttributedOrdersAsOperator(user, { accountCode: code, orgCode, days, page, filter });
  if (!r) notFound();

  const href = (over: { w?: number; page?: number; nhan?: DrillFilter }) => {
    const q = new URLSearchParams({ org: orgCode, w: String(over.w ?? (r.ok ? r.value.days : 30)) });
    const f = over.nhan === undefined ? filter : over.nhan;
    if (f) q.set("nhan", f);
    if (over.page && over.page > 1) q.set("page", String(over.page));
    return `?${q.toString()}`;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Giá trị khách hàng"
        title={`Đơn ↔ hội thoại · ${orgCode}`}
        description="Đọc sống CSDL của workspace — chỉ mã đơn, mã hội thoại, nhãn quy kết, kết cục, số tiền (không tên, SĐT, nội dung)"
        actions={<SaasConsoleNav active="/platform/customers" />}
      />
      <Link href={`/platform/customers/${encodeURIComponent(code)}#gia-tri-kinh-te`} className="text-sm text-primary hover:underline">
        ← Về khách {code}
      </Link>

      {!r.ok ? (
        <EmptyState title="Chưa đọc được đơn" description={r.error} />
      ) : (
        <SectionCard
          title={`${r.value.total} đơn chốt trong ${r.value.days} ngày${filter ? ` · ${FILTERS.find((f) => f.key === filter)?.label ?? ""}` : ""}`}
          description="Tập = đơn có order.confirmed trong kỳ (mốc chốt) — cùng tập với tổng quy kết trong ảnh chụp. Doanh thu đã giao theo ORDER_OUTCOME, là DANH NGHĨA."
          padded={false}
          actions={
            <nav className="flex items-center gap-1 text-xs" aria-label="Cửa sổ">
              {TENANT_VALUE_WINDOWS.map((w) => (
                <Link key={w} href={href({ w, page: 1 })} className={cn("rounded-md border px-2 py-1", w === r.value.days ? "border-primary bg-primary/10 font-semibold text-primary" : "border-hairline hover:bg-muted")}>
                  {w} ngày
                </Link>
              ))}
            </nav>
          }
        >
          <div className="flex flex-wrap gap-1.5 border-b border-hairline px-4 py-2 text-xs">
            {FILTERS.map((f) => (
              <Link key={f.key ?? "all"} href={href({ nhan: f.key, page: 1 })} className={cn("rounded-full border px-2 py-0.5", f.key === filter ? "border-primary bg-primary/10 font-semibold text-primary" : "border-hairline hover:bg-muted")}>
                {f.label}
              </Link>
            ))}
          </div>
          {r.value.rows.length === 0 ? (
            <EmptyState title="Không có đơn nào" className="m-4" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm" data-drill-table>
                <thead className="bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Mốc chốt</th>
                    <th className="px-3 py-2">Đơn · hội thoại</th>
                    <th className="px-3 py-2">Quy kết</th>
                    <th className="px-3 py-2">Kết cục</th>
                    <th className="px-3 py-2 text-right">Giá trị đơn</th>
                    <th className="px-3 py-2 text-right">Đã giao</th>
                  </tr>
                </thead>
                <tbody>
                  {r.value.rows.map((x) => (
                    <tr key={x.orderId} className="border-t border-hairline align-top">
                      <td className="px-3 py-1.5 text-xs">{x.confirmedAtMs === null ? "—" : formatDateTime(new Date(x.confirmedAtMs))}</td>
                      <td className="px-3 py-1.5 text-xs">
                        <div className="font-mono">{x.orderId}</div>
                        <div className="font-mono text-muted-foreground">{x.conversationId}</div>
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        <div>{x.attribution ? ORDER_ATTRIBUTION_LABEL[x.attribution as OrderAttribution] : <span className="text-muted-foreground" title="Đơn trước ngày bật sổ sự kiện hoặc thiếu chứng cứ — CHƯA BIẾT, không phải người bán">Chưa quy kết</span>}</div>
                        {x.overlays.length ? <div className="text-muted-foreground">{x.overlays.map((o) => ATTRIBUTION_OVERLAY_LABEL[o as AttributionOverlay]).join(" · ")}</div> : null}
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {OUTCOME_LABEL[x.outcome]}
                        {x.pending ? <div className="text-muted-foreground">chưa ngã ngũ</div> : null}
                      </td>
                      <td className="numeric px-3 py-1.5 text-right">{formatVND(x.valueVnd)}</td>
                      <td className="numeric px-3 py-1.5 text-right">
                        {x.pending ? <span className="text-muted-foreground" title="Đơn chưa ngã ngũ — chưa có doanh thu đã giao (chưa biết, không phải 0)">—</span> : formatVND(x.deliveredRevenueVnd)}
                        {x.upsell ? <div className="text-[11px] text-muted-foreground">bán thêm {formatVND(x.upsell.amountVnd)}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-between px-4 py-2 text-xs">
            <span className="text-muted-foreground">
              Trang {r.value.page}/{r.value.pageCount}
            </span>
            <span className="flex gap-2">
              {r.value.page > 1 ? (
                <Link href={href({ page: r.value.page - 1 })} className="rounded border border-hairline px-2 py-0.5 hover:bg-muted">
                  ← Trước
                </Link>
              ) : null}
              {r.value.page < r.value.pageCount ? (
                <Link href={href({ page: r.value.page + 1 })} className="rounded border border-hairline px-2 py-0.5 hover:bg-muted">
                  Sau →
                </Link>
              ) : null}
            </span>
          </div>
        </SectionCard>
      )}
    </div>
  );
}
