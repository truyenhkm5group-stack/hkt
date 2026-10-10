import Link from "next/link";
import { SectionCard } from "@/components/ui-bits";
import type { CustomerHealthLevel } from "@/lib/constants/customer-health";
import { TENANT_VALUE_METRIC_BY_KEY, TENANT_VALUE_WINDOWS } from "@/lib/constants/tenant-value-metrics";
import { formatDate, formatDateTime } from "@/lib/format";
import type { TenantValueDetail } from "@/lib/saas/tenant-value-read";
import { TENANT_VALUE_DETAIL_KEYS, type CellView } from "@/lib/saas/tenant-value-view";
import { cn } from "@/lib/utils";

/**
 * KHỐI «GIÁ TRỊ & KINH TẾ ĐƠN VỊ» — trang một khách. Thành phần máy chủ nhận ẢNH CHỤP đã đọc (`readTenantValueDetail`): ba cửa sổ
 * 7 / 30 / 90 ngày cạnh nhau + dải 30 ngày mức sức khoẻ. Không mở CSDL của khách; danh sách đơn ↔ hội thoại chỉ đọc sống khi người
 * vận hành BẤM sang tuyến riêng `attributed-orders`. Không tô màu đạt / không đạt (chưa có đích); màu của dải là MỨC sức khoẻ.
 */

const DOT: Record<CustomerHealthLevel, string> = {
  CRITICAL: "bg-rose-500",
  NEEDS_ATTENTION: "bg-amber-500",
  UNKNOWN: "bg-slate-400",
  HEALTHY: "bg-emerald-500",
  INACTIVE: "bg-transparent ring-1 ring-muted-foreground/40",
};

function Cell({ c }: { c: CellView | undefined }) {
  if (!c) return <span className="text-muted-foreground" title="Chưa có ảnh của cửa sổ này">—</span>;
  return (
    <span title={c.hint} className={cn("numeric whitespace-nowrap", c.state !== "VALUE" && "text-muted-foreground")} data-cell-state={c.state}>
      {c.text}
      {c.estimated && c.state === "VALUE" ? <span className="ml-0.5 text-[10px] text-muted-foreground">ƯT</span> : null}
      {c.provisional ? (
        <a href={c.provisional === "?" ? "/platform/saas#quyet-dinh-tam" : `/platform/saas#decision-${c.provisional}`} className="ml-1 rounded border border-dashed border-hairline px-1 text-[10px] text-muted-foreground hover:text-foreground">
          tạm{c.provisional === "?" ? "" : `·${c.provisional}`}
        </a>
      ) : null}
    </span>
  );
}

export function TenantValueDetailSection({ detail, accountCode, workspaces }: { detail: TenantValueDetail; accountCode: string; workspaces: { code: string; name: string }[] }) {
  return (
    <SectionCard
      id="gia-tri-kinh-te"
      title="Giá trị & kinh tế đơn vị"
      description="Đọc ảnh chụp mỗi ngày (job alerts của nhà) — không mở CSDL của khách khi mở trang"
      hint={
        <div className="space-y-1.5 text-xs leading-5">
          <p>Mỗi cột là ảnh MỚI NHẤT của một cửa sổ. Số chín dần theo kết cục đơn — không phải số của kỳ đã chốt. Bội số chỉ có ở cửa sổ 90 ngày (D12).</p>
          <p>«—» chưa biết (rê chuột xem thiếu gì) · «N/A» không áp dụng · «≥ / ≤» cận dưới / cận trên · «ƯT» ước tính · «tạm» quyết định chủ shop chưa chốt.</p>
        </div>
      }
      padded={false}
    >
      <div className="divide-y divide-hairline">
        {detail.orgs.map((o) => {
          const name = workspaces.find((w) => w.code === o.orgCode)?.name ?? o.orgCode;
          const anyWindow = TENANT_VALUE_WINDOWS.some((w) => o.windows[w]);
          return (
            <div key={o.orgCode} className="space-y-3 px-4 py-4 md:px-5" data-value-org={o.orgCode}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {name} <span className="text-xs font-normal text-muted-foreground">({o.orgCode})</span>
                </h3>
                <Link href={`/platform/customers/${encodeURIComponent(accountCode)}/attributed-orders?org=${encodeURIComponent(o.orgCode)}&w=30`} className="text-xs font-medium text-primary hover:underline" data-drill-link>
                  Xem từng đơn ↔ hội thoại (đọc sống) →
                </Link>
              </div>

              {/* Dải 30 ngày mức sức khoẻ — ngày chưa chụp là ô rỗng (chưa đo), không phải «khoẻ». */}
              <div>
                <div className="flex flex-wrap items-center gap-[3px]" aria-label="Mức sức khoẻ 30 ngày" data-health-strip>
                  {o.strip.map((d) => (
                    <span
                      key={d.day}
                      title={d.health ? `${formatDate(d.day)}: ${d.health.levelLabel} · rời bỏ ${d.health.churn.label}\n${d.health.reasons.map((r) => r.label).join(" · ")}` : `${formatDate(d.day)}: chưa có ảnh sức khoẻ`}
                      className={cn("size-3 rounded-sm", d.health ? DOT[d.health.level] : "border border-dashed border-hairline")}
                    />
                  ))}
                </div>
                <p className="mt-1 text-[11.5px] text-muted-foreground">
                  {o.latest ? (
                    <>
                      Gần nhất {formatDate(o.latest.day)}: <b className="text-foreground">{o.latest.levelLabel}</b> ({o.latest.reasons.map((r) => r.code).join(", ")}) · rời bỏ <b className="text-foreground">{o.latest.churn.label}</b> ({o.latest.churn.reasons.map((r) => r.code).join(", ")})
                      {o.latest.topIssue ? (
                        <>
                          {" "}
                          · vấn đề chính: {o.latest.topIssue.label}
                          {o.latest.topIssue.href ? (
                            <>
                              {" "}
                              <Link href={o.latest.topIssue.href} className="text-primary hover:underline">
                                {o.latest.topIssue.actionLabel} →
                              </Link>
                            </>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  ) : (
                    "Chưa có ảnh sức khoẻ nào trong 30 ngày."
                  )}
                </p>
              </div>

              {anyWindow ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm" data-value-windows>
                    <thead className="bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-1.5">Chỉ số</th>
                        {TENANT_VALUE_WINDOWS.map((w) => {
                          const v = o.windows[w];
                          return (
                            <th key={w} className="px-3 py-1.5 text-right" title={v ? `Ảnh ${formatDateTime(new Date(v.capturedAtMs))} · công thức ${v.formulaVersion}${v.sourceErrors.length ? `\nNguồn hỏng: ${v.sourceErrors.join(" · ")}` : ""}` : "Chưa có ảnh"}>
                              {w} ngày
                              {v && v.staleDays > 0 ? <div className="text-[10px] font-normal normal-case">ảnh {v.staleDays} ngày trước</div> : null}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {TENANT_VALUE_DETAIL_KEYS.map((k) => (
                        <tr key={k} className="border-t border-hairline">
                          <td className="px-3 py-1 text-[12.5px]">{TENANT_VALUE_METRIC_BY_KEY[k].label}</td>
                          {TENANT_VALUE_WINDOWS.map((w) => (
                            <td key={w} className="px-3 py-1 text-right text-[12.5px]">
                              <Cell c={o.windows[w]?.cells[k]} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Chưa có ảnh giá trị nào của workspace này — lượt chụp chạy ké job alerts của nhà mỗi ngày; trang không tự chụp.</p>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
