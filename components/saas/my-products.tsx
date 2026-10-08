import { StatusPill } from "@/components/saas/console-bits";
import { SectionCard } from "@/components/ui-bits";
import { FEATURE_SPEC, isFeatureKey } from "@/lib/pricing/features";
import type { MyProducts } from "@/lib/saas/portal";

/**
 * Câu cho KHÁCH khi workspace chưa có thuê bao nào (luồng tự đăng ký nay mở thuê bao ngay lúc dựng — F-02; câu này chỉ còn cho
 * khoảnh khắc trước lượt sửa bù). Ngôn ngữ kinh doanh: không «workspace», không «người vận hành», không nhãn control plane.
 */
export const MY_PRODUCTS_CUSTOMER_EMPTY = "Gói dịch vụ của cửa hàng đang được thiết lập — tải lại trang sau ít phút. Vẫn thấy dòng này thì liên hệ bộ phận hỗ trợ.";

/** Cổng khách — sản phẩm đã thuê, tình trạng, khả năng và tính năng đang có hiệu lực. Không chi phí, không token. */
export function MyProductsSection({ view }: { view: MyProducts }) {
  const customer = view.audience === "CUSTOMER";
  // Khách: chỉ tên cửa hàng. Nhà: nhãn nội bộ đầy đủ (loại tài khoản · cách lập chứng từ) — DTO của khách vốn không mang chúng.
  const description = customer ? view.workspace.name : view.account ? `${view.account.name} · ${view.account.type} · ${view.account.billing} · workspace ${view.workspace.name}` : `Workspace ${view.workspace.name}`;
  return (
    <SectionCard title="Sản phẩm của tôi" description={description}>
      {view.products.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-my-products-empty>
          {customer ? MY_PRODUCTS_CUSTOMER_EMPTY : "Workspace chưa có thuê bao sản phẩm nào — liên hệ người vận hành."}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {view.products.map((p) => (
            <div key={p.key} className="rounded-xl border border-hairline p-3">
              <div className="flex items-center justify-between gap-2">
                <b>{p.name}</b>
                <StatusPill tone={p.grantsUse ? "good" : "bad"}>{p.status ?? "—"}</StatusPill>
              </div>
              {p.trialNote ? (
                <p className="mt-1 text-xs text-sky-800 dark:text-sky-300" data-my-products-trial>
                  {p.trialNote}
                </p>
              ) : null}
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
