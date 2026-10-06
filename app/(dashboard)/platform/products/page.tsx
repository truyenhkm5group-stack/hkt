import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SaasConsoleNav, StatusPill } from "@/components/saas/console-bits";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { loadProductsConsole } from "@/lib/saas/console";
import { SUBSCRIPTION_STATUS_LABEL, type EffectiveSubscriptionStatus } from "@/lib/saas/policy";

export const metadata = { title: "Sản phẩm SaaS" };

/** DANH MỤC SẢN PHẨM — mỗi sản phẩm một thẻ: khách, thuê bao theo tình trạng, chi phí AI, doanh thu gói riêng, dùng. */
export default async function SaasProductsPage({ searchParams }: { searchParams: Promise<{ ky?: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const { ky } = await searchParams;
  const r = await loadProductsConsole(user, ky);
  if ("error" in r) redirect("/?forbidden=1");
  const label = `${r.snap.periodMonth.slice(5, 7)}/${r.snap.periodMonth.slice(0, 4)}`;
  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Hệ thống" title="Sản phẩm SaaS" actions={<SaasConsoleNav active="/platform/products" />} description={`${r.products.length} sản phẩm trong danh mục · kỳ ${label}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        {r.products.map((p) => (
          <SectionCard
            key={p.product.key}
            title={p.product.name}
            description={p.product.description}
            actions={
              <Link href={`/platform/products/${p.product.key}`} className="text-sm text-primary hover:underline">
                Chi tiết →
              </Link>
            }
          >
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <div className="text-[11px] uppercase text-muted-foreground">Khách</div>
                <div className="numeric text-lg font-bold">{formatNumber(p.customers)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-muted-foreground">Thuê bao</div>
                <div className="numeric text-lg font-bold">{formatNumber(p.liveSubscriptions)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase text-muted-foreground">Chi phí AI</div>
                <div className="numeric text-lg font-bold">{formatVND(p.aiCostVnd)}</div>
              </div>
              <div title={p.revenueNote ?? undefined}>
                <div className="text-[11px] uppercase text-muted-foreground">Doanh thu gói riêng</div>
                <div className="numeric text-lg font-bold">{formatVND(p.revenueVnd)}</div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(p.byStatus).map(([s, n]) => (
                <StatusPill key={s} tone={s === "ACTIVE" ? "good" : s === "TRIAL" ? "info" : "bad"}>
                  {SUBSCRIPTION_STATUS_LABEL[s as EffectiveSubscriptionStatus]}: {n}
                </StatusPill>
              ))}
            </div>
            {p.revenueNote ? <p className="mt-2 text-xs text-muted-foreground">{p.revenueNote}</p> : null}
          </SectionCard>
        ))}
      </div>
    </div>
  );
}
