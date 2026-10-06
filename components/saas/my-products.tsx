import { StatusPill } from "@/components/saas/console-bits";
import { SectionCard } from "@/components/ui-bits";
import { FEATURE_SPEC, isFeatureKey } from "@/lib/pricing/features";
import type { MyProducts } from "@/lib/saas/portal";

/** Cổng khách — sản phẩm đã thuê, tình trạng, khả năng và tính năng đang có hiệu lực. Không chi phí, không token. */
export function MyProductsSection({ view }: { view: MyProducts }) {
  return (
    <SectionCard title="Sản phẩm của tôi" description={view.account ? `${view.account.name} · ${view.account.type} · ${view.account.billing} · workspace ${view.workspace.name}` : `Workspace ${view.workspace.name}`}>
      {view.products.length === 0 ? (
        <p className="text-sm text-muted-foreground">Workspace chưa có thuê bao sản phẩm nào — liên hệ người vận hành.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {view.products.map((p) => (
            <div key={p.key} className="rounded-xl border border-hairline p-3">
              <div className="flex items-center justify-between gap-2">
                <b>{p.name}</b>
                <StatusPill tone={p.grantsUse ? "good" : "bad"}>{p.status ?? "—"}</StatusPill>
              </div>
              <ul className="mt-2 space-y-0.5 text-xs">
                {p.capabilities.map((c) => (
                  <li key={c.label} className={c.on ? "" : "text-muted-foreground line-through"}>
                    {c.label}
                  </li>
                ))}
              </ul>
              {p.features.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {p.features.map((f) => (
                    <StatusPill key={f.key} tone={f.effective ? "good" : "muted"}>
                      {isFeatureKey(f.key) ? FEATURE_SPEC[f.key].label : f.key}
                    </StatusPill>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
