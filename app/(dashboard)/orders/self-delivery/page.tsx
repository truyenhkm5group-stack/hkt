import Link from "next/link";
import { notFound } from "next/navigation";
import { Settings2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { StatStrip } from "@/components/stat-tile";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { CARRIER_ADAPTERS } from "@/lib/carriers/registry";
import { ROUTE_HOLD_META, type RouteFix } from "@/lib/constants/shipping-routing";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { userPickOptions } from "@/lib/queries/users";
import { manualOrderGate, manualOrderOrgGate } from "@/lib/records/order-create";
import { routedOrders, ROUTED_ORDERS_MAX, type RoutedOrder } from "@/lib/shipping/routing";
import type { SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { RunShippingRouteButton } from "@/app/(dashboard)/orders/self-delivery/run-now-button";
import { SelfDeliveryBoard, type SelfDeliveryGroup } from "@/app/(dashboard)/orders/self-delivery/self-delivery-board";

export const metadata = { title: "Danh sách tự giao" };

const COURIER_VIEWS = { all: "Tất cả", me: "Của tôi", none: "Chưa giao cho ai" } as const;
type CourierView = keyof typeof COURIER_VIEWS;

function fixHref(fix: RouteFix, orderId: string): string {
  if (fix === "EDIT_ORDER") return `/orders/${encodeURIComponent(orderId)}/edit`;
  if (fix === "ROUTING") return "/orders/shipping-routes";
  if (fix === "CONNECTIONS") return "/settings/connections";
  if (fix === "PRODUCTS") return "/products";
  return `/orders/${encodeURIComponent(orderId)}`;
}

/**
 * DANH SÁCH TỰ GIAO (POS tự chủ P7 · lib/shipping/routing.ts). Đơn tạo tay «Đã xác nhận» được xếp tuyến LÚC XEM bằng ĐÚNG hàm
 * máy dùng: TỰ GIAO (nhóm theo xã / phường cho người đi giao) · ĐI HÃNG (máy tự tạo vận đơn khi công tắc bật) · GIỮ LẠI (kèm lý
 * do và lối sửa — không bao giờ đoán). «Đã giao» / «Không thành công» đi qua đúng hai lõi của trang đơn.
 */
export default async function SelfDeliveryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("ORDERS", "orders:read");
  if (decision.allow === "NONE") return <ScopeDenied title="Danh sách tự giao" reason={decision.reason} fix={decision.fix} />;
  // Tổ chức đồng bộ đơn (nhà) không có đơn tạo tay — trang không có nghĩa ở đó.
  if (!(await manualOrderOrgGate()).allowed) notFound();
  const raw = await searchParams;
  const view: CourierView = typeof raw.courier === "string" && raw.courier in COURIER_VIEWS ? (raw.courier as CourierView) : "all";
  const [{ rows, truncated, config, ready }, couriers, writeGate] = await Promise.all([routedOrders(), userPickOptions(), manualOrderGate(user)]);

  const self = rows.filter((r) => r.route.kind === "SELF").filter((r) => (view === "me" ? r.courierUserId === user.id : view === "none" ? !r.courierUserId : true));
  const carrier = rows.filter((r): r is RoutedOrder & { route: { kind: "CARRIER" } } => r.route.kind === "CARRIER");
  const holds = rows.filter((r) => r.route.kind === "HOLD");
  const shipped = rows.filter((r) => r.route.kind === "SHIPPED").length;
  const autoDue = carrier.filter((r) => r.route.kind === "CARRIER" && r.route.auto.ok).length;

  const groupsMap = new Map<string, SelfDeliveryGroup>();
  for (const r of self) {
    const key = `${r.province}|${r.ward}`;
    const g = groupsMap.get(key) ?? { key, ward: r.ward, province: r.province, rows: [] };
    g.rows.push({ id: r.id, code: r.code, receiverName: r.receiverName, phone: r.phone, address: r.address, ward: r.ward, province: r.province, toCollect: r.toCollect, items: r.items, note: r.note, courierUserId: r.courierUserId, courierName: r.courierName });
    groupsMap.set(key, g);
  }
  const groups = [...groupsMap.values()].sort((a, b) => a.province.localeCompare(b.province, "vi") || a.ward.localeCompare(b.ward, "vi"));
  const selfCash = self.reduce((s, r) => s + r.toCollect, 0);
  const carrierLabel = config.defaultCarrier ? CARRIER_ADAPTERS[config.defaultCarrier].label : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Giao vận"
        title="Danh sách tự giao"
        description="Đơn đã xác nhận, đã ghép tỉnh + xã: thuộc khu shop tự giao thì vào danh sách này, còn lại đi hãng mặc định. Đơn thiếu thông tin nằm ở «Giữ lại» kèm lối sửa."
        actions={
          <>
            {config.autoCreate && can(user, "shipments:manage") ? <RunShippingRouteButton due={autoDue} /> : null}
            <Button asChild variant="outline" size="sm">
              <Link href="/orders/shipping-routes">
                <Settings2 className="size-4" /> Cấu hình tuyến giao
              </Link>
            </Button>
          </>
        }
      />
      <StatStrip
        items={[
          { label: "Tự giao — chờ giao", value: formatNumber(self.length), note: `thu của khách ${formatVND(selfCash)}`, tone: "green" },
          { label: "Đi hãng — chưa có vận đơn", value: formatNumber(carrier.length), note: config.autoCreate ? `${formatNumber(autoDue)} đơn máy tạo ở lượt tới` : "tự tạo vận đơn đang tắt" },
          { label: "Giữ lại — cần người sửa", value: formatNumber(holds.length), tone: holds.length ? "amber" : undefined },
          { label: "Đã có vận đơn", value: formatNumber(shipped), note: "đang ở hãng, chờ kết quả giao" },
        ]}
      />
      {truncated ? <p className="text-[12.5px] font-medium text-amber-700 dark:text-amber-400">Shop có hơn {formatNumber(ROUTED_ORDERS_MAX)} đơn đã xác nhận chưa giao — trang chỉ xếp tuyến {formatNumber(ROUTED_ORDERS_MAX)} đơn cũ nhất.</p> : null}

      <SectionCard
        title="Tuyến giao đang áp dụng"
        description={
          <span>
            Khu tự giao: {config.selfAreas.length ? config.selfAreas.map((a) => (a.wards.length ? `${a.province} (${a.wards.length} xã / phường)` : `${a.province} (cả tỉnh)`)).join(" · ") : "chưa khai"} · Hãng mặc định: {carrierLabel ? `${carrierLabel}${config.defaultCarrier && !ready.has(config.defaultCarrier) ? " — CHƯA BẬT kết nối" : ""}` : "chưa chọn"} · Tự tạo vận đơn:{" "}
            {config.autoCreate ? `BẬT từ ${formatDateTime(config.autoSince)} (${config.serviceCode ? `dịch vụ ${config.serviceCode}` : "dịch vụ rẻ nhất"})` : "TẮT"}
          </span>
        }
      >
        <div className="flex flex-wrap gap-2 text-[12.5px] print:hidden">
          {(Object.keys(COURIER_VIEWS) as CourierView[]).map((k) => (
            <Link key={k} href={k === "all" ? "/orders/self-delivery" : `/orders/self-delivery?courier=${k}`} className={cn("rounded-full border px-3 py-1", view === k ? "border-primary bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted")}>
              {COURIER_VIEWS[k]}
            </Link>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={`Tự giao (${formatNumber(self.length)})`} description="Nhóm theo xã / phường để người giao đi một vòng. «Đã giao» ghi phiếu giao có ký nhận; tiền thu ghi bằng phiếu thu ở trang đơn.">
        {groups.length ? (
          <SelfDeliveryBoard groups={groups} couriers={couriers} canWrite={writeGate.allowed} />
        ) : (
          <EmptyState title={config.selfAreas.length ? "Không có đơn tự giao nào đang chờ" : "Chưa có khu tự giao"} description={config.selfAreas.length ? "Đơn mới xác nhận trong khu tự giao sẽ hiện ở đây." : "Khai tỉnh / xã shop tự giao ở «Cấu hình tuyến giao» — đơn thuộc khu đó sẽ vào danh sách này."} />
        )}
      </SectionCard>

      <SectionCard title={`Đi hãng — chưa có vận đơn (${formatNumber(carrier.length)})`} description={config.autoCreate ? "Máy tạo vận đơn ở hãng mặc định mỗi 5 phút (đơn xác nhận từ lúc bật). Đơn không tự tạo thì tạo tay ở trang đơn hoặc hàng loạt ở danh sách đơn." : "Tự tạo vận đơn đang tắt — tạo tay ở trang đơn hoặc hàng loạt ở danh sách đơn, hoặc bật ở «Cấu hình tuyến giao»."}>
        {carrier.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">Đơn</th>
                  <th className="px-2 py-1.5">Xã / phường · tỉnh</th>
                  <th className="px-2 py-1.5">Hãng</th>
                  <th className="px-2 py-1.5 text-right">Cân</th>
                  <th className="px-2 py-1.5">Máy tự tạo</th>
                </tr>
              </thead>
              <tbody>
                {carrier.map((r) =>
                  r.route.kind === "CARRIER" ? (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-2 py-2">
                        <Link href={`/orders/${encodeURIComponent(r.id)}`} className="font-medium text-primary hover:underline">
                          {r.code}
                        </Link>
                        <div className="text-muted-foreground">{r.receiverName}</div>
                      </td>
                      <td className="px-2 py-2">
                        {r.ward} · {r.province}
                      </td>
                      <td className="px-2 py-2">{CARRIER_ADAPTERS[r.route.carrier].label}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{formatNumber(r.route.weightGrams)} g</td>
                      <td className="px-2 py-2">{r.route.auto.ok ? <span className="text-emerald-700 dark:text-emerald-400">Lượt tới</span> : <span className="text-muted-foreground">{r.route.auto.why}</span>}</td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Không có đơn nào chờ tạo vận đơn" description="Đơn ngoài khu tự giao, đủ thông tin, sẽ hiện ở đây cho tới khi có vận đơn." />
        )}
      </SectionCard>

      <SectionCard title={`Giữ lại — cần người sửa (${formatNumber(holds.length)})`} description="Máy không đoán: thiếu tỉnh / xã, chưa chọn hãng, hãng chưa bật, mẫu mã chưa khai cân, hoặc hãng từ chối nhiều lần. Sửa xong đơn tự đi tiếp.">
        {holds.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-[12px] text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5">Đơn</th>
                  <th className="px-2 py-1.5">Địa chỉ</th>
                  <th className="px-2 py-1.5">Vì sao giữ lại</th>
                  <th className="px-2 py-1.5">Lối sửa</th>
                </tr>
              </thead>
              <tbody>
                {holds.map((r) =>
                  r.route.kind === "HOLD" ? (
                    <tr key={r.id} className="border-t align-top">
                      <td className="px-2 py-2">
                        <Link href={`/orders/${encodeURIComponent(r.id)}`} className="font-medium text-primary hover:underline">
                          {r.code}
                        </Link>
                        <div className="text-muted-foreground">{r.receiverName}</div>
                      </td>
                      <td className="max-w-[280px] px-2 py-2">
                        {r.address || "—"}
                        <div className="text-[12px] text-muted-foreground">{[r.ward, r.province].filter(Boolean).join(" · ") || "chưa có tỉnh / xã"}</div>
                      </td>
                      <td className="max-w-[320px] px-2 py-2">{r.route.reason}</td>
                      <td className="px-2 py-2">
                        <Link href={fixHref(ROUTE_HOLD_META[r.route.code].fix, r.id)} className="text-primary hover:underline">
                          {ROUTE_HOLD_META[r.route.code].fixLabel}
                        </Link>
                      </td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Không có đơn nào bị giữ lại" description="Mọi đơn đã xác nhận đều đã có tuyến giao." />
        )}
      </SectionCard>
    </div>
  );
}
