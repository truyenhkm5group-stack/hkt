import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { SaasConsoleNav, StatusPill } from "@/components/saas/console-bits";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatVND } from "@/lib/format";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { parseCommercial } from "@/lib/pricing/catalog";
import { FEATURE_SPEC } from "@/lib/pricing/features";
import { productDef } from "@/lib/saas/catalog";
import { loadProductsConsole } from "@/lib/saas/console";
import { SUBSCRIPTION_STATUS_LABEL } from "@/lib/saas/policy";
import { runningVersion } from "@/lib/version";
import { cn } from "@/lib/utils";

export const metadata = { title: "Sản phẩm" };

const th = "px-3 py-2";
const thead = "bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground";

/** MỘT SẢN PHẨM: khả năng → tính năng, gói phủ nó, khách đang thuê, dùng, chi phí, doanh thu gói riêng, bản đang chạy. */
export default async function SaasProductPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ ky?: string }> }) {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const [{ key }, { ky }] = await Promise.all([params, searchParams]);
  const product = productDef(key);
  if (!product) notFound();
  const r = await loadProductsConsole(user, ky);
  if ("error" in r) redirect("/?forbidden=1");
  const econ = r.products.find((p) => p.product.key === key)!;
  const plans = r.snap.plans.filter((p) => !p.productKeys || p.productKeys.includes(key));
  const rows = r.snap.customers.flatMap((c) => c.workspaces.flatMap((w) => w.subscriptions.filter((s) => s.productKey === key).map((s) => ({ c, w, s }))));
  const gp = econ.revenueVnd === null ? null : econ.revenueVnd - econ.aiCostVnd - econ.directCostVnd;
  const version = runningVersion();

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Sản phẩm SaaS" title={product.name} actions={<SaasConsoleNav active="/platform/products" />} description={product.description} />

      <SectionCard title="Kinh tế kỳ này">
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
          <div>
            <div className="text-[11px] uppercase text-muted-foreground">Khách · thuê bao</div>
            <div className="numeric text-lg font-bold">
              {formatNumber(econ.customers)} · {formatNumber(econ.liveSubscriptions)}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-muted-foreground">Doanh thu gói riêng</div>
            <div className="numeric text-lg font-bold">{formatVND(econ.revenueVnd)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-muted-foreground">Chi phí AI</div>
            <div className="numeric text-lg font-bold">{formatVND(econ.aiCostVnd)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-muted-foreground">Chi phí trực tiếp</div>
            <div className="numeric text-lg font-bold">{formatVND(econ.directCostVnd)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-muted-foreground">Lãi gộp gói riêng</div>
            <div className="numeric text-lg font-bold">{formatVND(gp)}</div>
          </div>
        </div>
        {econ.revenueNote ? <p className="mt-2 text-xs text-muted-foreground">{econ.revenueNote}. Biên theo khách xem ở trang Khách hàng.</p> : null}
      </SectionCard>

      <SectionCard title="Khả năng → tính năng">
        <ul className="space-y-2 text-sm">
          {product.capabilities.map((c) => (
            <li key={c.key}>
              <b>{c.label}</b> <span className="text-xs text-muted-foreground">· module {c.modules.join(", ")}</span>
              {c.features.length ? <div className="mt-0.5 flex flex-wrap gap-1">{c.features.map((f) => <StatusPill key={f} tone="muted">{FEATURE_SPEC[f].label}</StatusPill>)}</div> : null}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">Miền dữ liệu sản phẩm này là nguồn sự thật: {product.ownedDomains.join(" · ")}.</p>
      </SectionCard>

      <SectionCard title="Gói phủ sản phẩm" padded={false}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Gói</th>
              <th className={cn(th, "text-right")}>Giá / tháng</th>
              <th className={th}>Phạm vi</th>
              <th className={th}>Tính năng của sản phẩm trong gói</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => {
              const feats = parseCommercial(p.commercial).features;
              const mine = product.capabilities.flatMap((c) => c.features);
              return (
                <tr key={p.key} className="border-t border-hairline">
                  <td className={th}>{p.name}</td>
                  <td className={cn(th, "numeric text-right")}>{p.priceVnd === null ? "Không niêm yết" : formatVND(p.priceVnd)}</td>
                  <td className={cn(th, "text-xs")}>{p.productKeys ? p.productKeys.join(", ") : "gói gộp (mọi sản phẩm)"}</td>
                  <td className={cn(th, "text-xs")}>{mine.length === 0 ? "—" : feats === null ? "chưa khai (tạm cho dùng)" : `${mine.filter((f) => feats.includes(f)).length}/${mine.length}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="Khách đang thuê" padded={false}>
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Khách</th>
              <th className={th}>Workspace</th>
              <th className={th}>Gói</th>
              <th className={th}>Tình trạng</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ c, w, s }) => (
              <tr key={s.id} className="border-t border-hairline">
                <td className={th}>
                  <Link href={`/platform/customers/${c.account.code}`} className="text-primary hover:underline">
                    {c.account.name}
                  </Link>
                </td>
                <td className={cn(th, "text-xs")}>{w.code}</td>
                <td className={cn(th, "text-xs")}>{s.planName}</td>
                <td className={th}>
                  <StatusPill tone={s.status === "ACTIVE" ? "good" : s.status === "TRIAL" ? "info" : "bad"}>{SUBSCRIPTION_STATUS_LABEL[s.status]}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      <SectionCard title="Dùng kỳ này (cộng mọi khách)">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {econ.usage.map((u) => (
            <li key={u.metric}>
              {u.label}: <b className="numeric">{u.total === null ? "—" : u.unit === "USD" ? `$${u.total.toFixed(2)}` : formatNumber(u.total)}</b>
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Triển khai · sức khoẻ">
        <p className="text-sm">
          Bản đang chạy: <code>{version.commit ? version.commit.slice(0, 12) : "—"}</code> — cùng mã nguồn cho mọi khách. Sức khoẻ CSDL từng workspace ở{" "}
          <Link href="/platform" className="text-primary hover:underline">
            Vận hành nền tảng
          </Link>
          .
        </p>
      </SectionCard>
    </div>
  );
}
