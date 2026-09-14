import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { MapForm } from "@/app/(dashboard)/ai/ad-map/map-form";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { listAdMappings, listProductChoices, listUnmappedAdKeys } from "@/lib/queries/sales-ad-map";
import { PRODUCT_RESOLUTION_UNAVAILABLE } from "@/lib/constants/product-resolution";

export const metadata = { title: "Bản đồ quảng cáo → sản phẩm" };

export default async function AdMapPage() {
  await requirePermission("ai:view");
  const [daMap, chuaMap, choices] = await Promise.all([listAdMappings(), listUnmappedAdKeys(), listProductChoices()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bản đồ quảng cáo → sản phẩm"
        description="Khách bấm quảng cáo rồi nhắn “còn hàng không ạ”. Trỏ một lần ở đây, nhân sự AI nhận ra mẫu ở mọi hội thoại sau."
      />

      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold">Vì sao cần bảng này</h2>
        <p className="text-sm text-muted-foreground">
          Pancake KHÔNG trả về mã sản phẩm trong tin nhắn. Tín hiệu duy nhất có thật là mã quảng cáo khách đã bấm và câu
          quảng cáo đi kèm. Máy tự khớp được khi câu quảng cáo có tên mẫu; khi không, người trỏ một lần và máy dùng lại mãi.
        </p>
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {Object.entries(PRODUCT_RESOLUTION_UNAVAILABLE).map(([ten, lyDo]) => (
            <li key={ten}>
              <span className="font-medium">{ten}</span>: {lyDo}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">
          Chưa trỏ ({formatNumber(chuaMap.length)}) — xếp theo số hội thoại đang chờ
        </h2>
        {chuaMap.length === 0 ? (
          <p className="text-sm text-muted-foreground">Không có quảng cáo nào chưa trỏ.</p>
        ) : (
          <div className="space-y-4">
            {chuaMap.map((r) => (
              <div key={r.adKey} className="rounded-md border p-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <code className="font-mono text-xs">{r.adKey}</code>
                  <span className="text-muted-foreground">
                    {formatNumber(r.conversations)} hội thoại · {formatNumber(r.messages)} tin
                  </span>
                </div>
                {r.adDescription ? <p className="mb-2 line-clamp-2 text-xs text-muted-foreground">{r.adDescription}</p> : null}
                <MapForm pageId={r.pageId} adKey={r.adKey} keyKind={r.keyKind} current={null} choices={choices} />
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">Đã trỏ ({formatNumber(daMap.length)})</h2>
        {daMap.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có ánh xạ nào.</p>
        ) : (
          <div className="space-y-4">
            {daMap.map((r) => (
              <div key={`${r.pageId}-${r.adKey}`} className="rounded-md border p-3">
                <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  <code className="font-mono text-xs">{r.adKey}</code>
                  <span className="font-medium">
                    {r.productCode ? `${r.productCode} · ` : ""}
                    {r.productName || "(chưa trỏ)"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.source === "HUMAN" ? "người đặt" : "máy học"} · {formatNumber(r.conversations)} hội thoại
                  </span>
                </div>
                <MapForm pageId={r.pageId} adKey={r.adKey} keyKind={r.keyKind} current={r.productId} choices={choices} />
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
