import Link from "next/link";
import { shellAllows } from "@/lib/constants/saas-nav";
import { Download, Plus, ShieldAlert } from "lucide-react";
import { erpNativeView, loadAutoConfirmComplete, loadManualDeliveryFee, manualOrderGate } from "@/lib/records/order-create";
import { ErpNativeButton } from "@/app/(dashboard)/orders/erp-native-button";
import { AutoConfirmButton } from "@/app/(dashboard)/orders/auto-confirm-button";
import { DeliveryFeeButton } from "@/app/(dashboard)/orders/delivery-fee-button";
import { can } from "@/lib/auth/session";
import { OrdersTable } from "@/app/(dashboard)/orders/orders-table";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { ModuleSyncButton } from "@/components/module-sync-button";
import { Button } from "@/components/ui/button";
import { formatNumber, formatVND } from "@/lib/format";
import { listOrders, orderFacets, orderNeedsReviewCount, orderSummary, ORDER_SORTABLE } from "@/lib/queries/orders";
import { FULFILLMENT_BUCKET_LABEL, FULFILLMENT_BUCKET_ORDER } from "@/lib/constants/fulfillment-bucket";
import { parseListParams, type SearchParams } from "@/lib/search-params";
import { requireResource } from "@/lib/auth/scope-guard";
import { ScopeDenied } from "@/components/scope-denied";
import { applyStatusFacet, statusLabelOverrides } from "@/components/metadata/runtime-core";
import { objectDef } from "@/lib/constants/object-registry";
import { getListMetadata, getSystemStatusOptions, listCustomValuesFor } from "@/lib/queries/metadata-lists";
import { getBrandCopy } from "@/lib/branding/service";
import { bulkCarriers } from "@/lib/carriers/engine";
import { withDisplayVariation } from "@/lib/constants/experience-profile";
import { readDisplayProfile } from "@/lib/experience/profile";

export const metadata = { title: "Đơn hàng" };

export default async function OrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("ORDERS", "orders:read");
  // Phạm vi hẹp hơn thứ dữ liệu này biểu diễn được ⇒ TỪ CHỐI và nói rõ, không cho xem hết.
  if (decision.allow === "NONE") return <ScopeDenied title="Đơn hàng" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const params = parseListParams(raw, { defaultSort: "insertedAt", filterKeys: ["stage", "source", "carrier", "seller", "payment", "tag", "address", "fulfillment", "review"], sortable: ORDER_SORTABLE, defaultPeriod: "30d" });
  /*
    Danh sách theo metadata (M9, M10) — CHỈ HIỂN THỊ: thứ tự/ẩn cột có sẵn, cột custom, nhãn / thứ tự /
    ẩn-khỏi-bộ-lọc của `orders.stage`. Truy vấn nghiệp vụ, ORDER_OUTCOME và bộ lọc giữ nguyên — danh sách
    đơn KHÔNG nhận bộ lọc custom mặc định ở Phase 2.
  */
  const [{ rows, total, pageCount }, facets, summary, meta, stageOptions, , createGate, needsReview, displayProfile] = await Promise.all([listOrders(params), orderFacets(params), orderSummary(params), getListMetadata("order", "default", user), getSystemStatusOptions("order", "stage"), getBrandCopy(user), manualOrderGate(user), orderNeedsReviewCount(params), readDisplayProfile()]);
  // Hồ sơ ngành chỉ để đổi NHÃN chữ biến thể (shop thực phẩm: «Size: 1kg» ⇒ «Quy cách: 1kg») — đổi trên DỮ LIỆU ở đây rồi mới
  // truyền xuống bảng client, không truyền hàm qua ranh giới; lỗi đọc hồ sơ ⇒ in nguyên chữ đã lưu.
  const tableRows = rows.map((r) => ({ ...r, items: withDisplayVariation(r.items, displayProfile) }));
  // Phí giao đồng giá: chỉ tổ chức tạo đơn tay + người cấu hình được.
  const deliveryFee = createGate.allowed && can(user, "settings:manage") ? { fee: await loadManualDeliveryFee(), autoConfirm: await loadAutoConfirmComplete() } : null;
  // Tạo / in vận đơn hàng loạt (POS tự chủ): chỉ tổ chức tạo đơn tay + quyền vận đơn + hãng có kết nối đang bật.
  const carrierBulk = createGate.allowed ? await bulkCarriers(user) : [];
  // Shop đến từ Pancake (CSDL có đơn Pancake đã nhập): khung tuyên bố «Chuyển hẳn sang ERP» — ORDER_OUTCOME.md 11.3.
  const erpNative = can(user, "settings:manage") ? await erpNativeView(user) : null;
  const { customValues, userNames } = await listCustomValuesFor("order", meta, rows.map((r) => r.id), user);
  const stageLabels = statusLabelOverrides(objectDef("order")?.fields.find((f) => f.key === "stage")?.options ?? [], stageOptions);
  const stageFacet = applyStatusFacet(facets.stages, stageOptions, params.filters.stage ?? []);
  const exportQuery = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v ? [[k, v]] : []))).toString();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng"
        title="Đơn hàng"
        actions={
          <>
            {/* Đơn TẠO TAY (pilot P0 #3): chỉ khi tổ chức không đồng bộ đơn + có `orders:write` — cùng cổng với /orders/new. */}
            {createGate.allowed ? (
              <Button asChild size="sm">
                <Link href="/orders/new">
                  <Plus className="size-4" /> Tạo đơn hàng
                </Link>
              </Button>
            ) : null}
            {erpNative?.hasSyncedOrders ? <ErpNativeButton view={erpNative} /> : null}
            {deliveryFee ? <AutoConfirmButton enabled={deliveryFee.autoConfirm} /> : null}
            {deliveryFee ? <DeliveryFeeButton fee={deliveryFee.fee} /> : null}
            {/*
              LỐI VÀO DANH SÁCH SOÁT TRƯỚC KHI GỬI.

              Đặt ở đây chứ không thêm một mục menu mới: nó là một GÓC NHÌN của chính danh sách đơn
              (đơn còn trong kho, xếp theo khả năng hoàn), không phải một module riêng — cùng khuôn với
              "Bổ sung danh sách vận đơn" trên trang Đối soát COD.
            */}
            {shellAllows(user, "/orders/verify") ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/orders/verify">
                  <ShieldAlert className="size-4" /> Cần xác minh trước khi giao
                </Link>
              </Button>
            ) : null}
            <Button asChild variant="outline" size="sm">
              <a href={`/api/export/orders?${exportQuery}`}>
                <Download className="size-4" /> Xuất CSV
              </a>
            </Button>
            <ModuleSyncButton viewer={user} job="pancake-orders" label="Đồng bộ đơn" />
          </>
        }
      />
      {/*
        BỐN CON SỐ CỦA BỘ LỌC HIỆN TẠI, ĐỌC ĐƯỢC BẰNG MẮT LƯỚT.
        Trước đây cùng bốn số này nằm trong một câu chữ xám dưới tiêu đề — "1.234 đơn · doanh thu
        … · 900 giao thành công · COD …" — muốn lấy một số phải đọc cả câu. Dải ô cho mỗi số một
        chỗ đứng, và số đơn không còn bị nhắc lại lần nữa ở dòng kết quả bên dưới.
      */}
      <StatStrip
        items={[
          { label: "Đơn trong bộ lọc", value: formatNumber(summary.orders), note: `${formatNumber(summary.quantity)} sản phẩm${summary.cancelled ? ` · ${formatNumber(summary.cancelled)} đơn huỷ` : ""}` },
          { label: "Doanh thu lên đơn", value: formatVND(summary.revenue, { compact: true }) },
          { label: "Giao thành công", value: formatNumber(summary.success), tone: "green" },
          { label: "COD", value: formatVND(summary.cod, { compact: true }) },
        ]}
      />
      <DataTableToolbar
        searchPlaceholder="Mã đơn, SĐT, tên khách, mã vận đơn, SKU…"
        period={{ defaultKey: "30d" }}
        /*
          THỨ TỰ = ƯU TIÊN (chủ shop 09/10/2026: bộ lọc nhanh ≤ 4–5). Bốn bộ lọc đầu đứng ngoài; phần còn lại vào ngăn kéo
          «Bộ lọc khác», trên điện thoại tất cả vào một nút «Bộ lọc». Không bộ lọc nào bị bỏ.
        */
        facets={[
          { key: "stage", label: "Trạng thái", options: stageFacet },
          /*
            HAI BỘ LỌC TRẠNG THÁI ĐỨNG CẠNH NHAU, CÓ CHỦ ĐÍCH.

            "Trạng thái" là nhãn Pancake — do người bán bấm. "Hàng đang ở đâu" là kết luận từ chứng
            từ ĐVVC. Chênh lệch giữa hai cột chính là việc tồn đọng của khâu bàn giao, và nó chỉ
            nhìn thấy được khi cả hai cùng có mặt.
          */
          { key: "fulfillment", label: "Hàng đang ở đâu", options: FULFILLMENT_BUCKET_ORDER.map((b) => ({ value: b, label: FULFILLMENT_BUCKET_LABEL[b] })) },
          /*
            ĐƠN CẦN NGƯỜI KIỂM (chủ shop 08/10/2026): khách báo huỷ trong hội thoại · máy chốt khi địa chỉ chưa ghép được xã. Máy
            không tự huỷ / không tự bỏ qua — đơn nằm đây chờ người bấm «Xác nhận đơn» hoặc «Huỷ đơn».
          */
          ...(createGate.allowed || needsReview > 0 ? [{ key: "review", label: "Cần kiểm", options: [{ value: "flagged", label: `Cần người kiểm (${formatNumber(needsReview)})` }], single: true }] : []),
          { key: "payment", label: "Thanh toán", options: [{ value: "cod", label: "Thu hộ COD" }, { value: "prepaid", label: "Đã thanh toán trước" }], single: true },
          { key: "source", label: "Kênh bán", options: facets.sources },
          { key: "carrier", label: "Đơn vị vận chuyển", options: facets.carriers },
          { key: "address", label: "Địa chỉ", options: [{ value: "unnormalized", label: `Chưa chuẩn hoá · không giao được (${formatNumber(summary.unnormalizedAddress)})` }, { value: "normalized", label: "Đã chuẩn hoá" }], single: true },
          ...(facets.sellers.length ? [{ key: "seller", label: "Nhân viên", options: facets.sellers }] : []),
        ]}
        resultLabel={total === summary.orders + summary.cancelled ? undefined : `${formatNumber(total)} đơn phù hợp`}
      />
      <OrdersTable rows={tableRows} pageCount={pageCount} total={total} stageLabels={stageLabels} carrierBulk={carrierBulk} canDecide={createGate.allowed} meta={meta ? { listView: meta.schema, customFields: meta.customFields, customValues, userNames } : undefined} />
    </div>
  );
}
