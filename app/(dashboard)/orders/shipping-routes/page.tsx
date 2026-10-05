import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui-bits";
import { adminProvinces } from "@/lib/address/vn-address";
import { can, requirePermission } from "@/lib/auth/session";
import { enabledCarriers } from "@/lib/carriers/engine";
import { formatDateTime } from "@/lib/format";
import { manualOrderOrgGate } from "@/lib/records/order-create";
import { loadShippingRouting } from "@/lib/shipping/routing";
import { RoutingForm } from "@/app/(dashboard)/orders/shipping-routes/routing-form";

export const metadata = { title: "Cấu hình tuyến giao" };

/**
 * CẤU HÌNH TUYẾN GIAO (POS tự chủ P7) — khu shop tự giao (tỉnh / xã theo địa giới mới) · hãng mặc định cho phần còn lại ·
 * công tắc «Tự tạo vận đơn» (mặc định TẮT). Ai xem đơn cũng đọc được; chỉ `settings:manage` lưu được (máy chủ chặn lại).
 */
export default async function ShippingRoutesPage() {
  const user = await requirePermission("orders:read");
  if (!(await manualOrderOrgGate()).allowed) notFound();
  const [config, carriers] = await Promise.all([loadShippingRouting(), enabledCarriers()]);
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Giao vận"
        title="Cấu hình tuyến giao"
        description="Đơn đã xác nhận, đã ghép tỉnh + xã đi tiếp sang giao hàng theo cấu hình này: khu tự giao vào «Danh sách tự giao», phần còn lại đi hãng mặc định."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/orders/self-delivery">
              <ArrowLeft className="size-4" /> Danh sách tự giao
            </Link>
          </Button>
        }
      />
      <SectionCard
        title="Tuyến giao của shop"
        description={config.autoCreate ? `Tự tạo vận đơn đang BẬT từ ${formatDateTime(config.autoSince)} — tắt rồi bật lại là một mốc mới.` : "Tự tạo vận đơn đang TẮT — đơn đi hãng chờ người tạo vận đơn (trang đơn hoặc hàng loạt)."}
      >
        <RoutingForm
          initial={{ selfAreas: config.selfAreas, defaultCarrier: config.defaultCarrier, autoCreate: config.autoCreate, serviceCode: config.serviceCode }}
          provinces={adminProvinces().map((p) => p.name)}
          carriers={carriers.map((c) => ({ key: c.key, label: c.label, ready: c.ready }))}
          canEdit={can(user, "settings:manage")}
        />
      </SectionCard>
    </div>
  );
}
