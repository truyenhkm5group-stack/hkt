import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { MapForm } from "@/app/(dashboard)/ai/ad-map/map-form";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { listAdMappings, listProductChoices, listUnmappedAdKeys } from "@/lib/queries/sales-ad-map";
import { PRODUCT_RESOLUTION_UNAVAILABLE } from "@/lib/constants/product-resolution";

export const metadata = { title: "Bản đồ quảng cáo → sản phẩm" };

/**
 * Ảnh quảng cáo. Dùng `<img>` thẳng chứ không qua `next/image`: đây là ảnh của Facebook CDN, đổi
 * theo từng quảng cáo và có hạn dùng — khai trước vào `next.config` là không thể. Ảnh hỏng thì ô
 * này biến mất và người vẫn trỏ được bằng câu quảng cáo bên cạnh.
 */
function AnhQuangCao({ url, alt }: { url: string; alt: string }) {
  if (!url) return <div className="flex h-32 w-32 shrink-0 items-center justify-center rounded-md border border-dashed text-[11px] text-muted-foreground">không có ảnh</div>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} loading="lazy" className="h-32 w-32 shrink-0 rounded-md border object-cover" />;
}

export default async function AdMapPage() {
  await requirePermission("ai:view");
  const [daMap, chuaMap, choices] = await Promise.all([listAdMappings(), listUnmappedAdKeys(), listProductChoices()]);
  const tongChoHoiThoai = chuaMap.reduce((s, r) => s + r.conversations, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bản đồ quảng cáo → sản phẩm"
        description="Khách bấm quảng cáo rồi nhắn “còn hàng không ạ”. Nhìn ảnh, chọn mẫu, bấm Lưu — một lần cho cả chiến dịch."
      />

      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold">Vì sao máy không tự trỏ được</h2>
        <p className="text-sm text-muted-foreground">
          Danh mục đặt tên sản phẩm bằng chính mã hàng (<span className="font-mono text-xs">Đầm Q004</span>,{" "}
          <span className="font-mono text-xs">ĐẦM Q005</span>), còn quảng cáo viết theo lối tiếp thị (“TINH KHÔI”, “ĐẦM ĐỎ
          ĐÔ”). Hai vốn từ ấy không giao nhau, nên mọi phép “khớp gần đúng” đều là đoán. Máy chỉ tự lưu khi nhân viên đã gõ
          đúng một mã hàng trong chính các hội thoại đến từ quảng cáo đó; còn lại để người nhìn ảnh và quyết.
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
        <h2 className="mb-1 text-sm font-semibold">
          Chờ bạn trỏ — {formatNumber(chuaMap.length)} quảng cáo, {formatNumber(tongChoHoiThoai)} hội thoại đang chờ
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">Xếp theo số hội thoại: trỏ cái trên cùng là được nhiều nhất.</p>
        {chuaMap.length === 0 ? (
          <p className="text-sm text-muted-foreground">Không còn quảng cáo nào chưa trỏ.</p>
        ) : (
          <div className="space-y-4">
            {chuaMap.map((r) => (
              <div key={r.adKey} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row">
                <AnhQuangCao url={r.mediaUrl} alt={`Quảng cáo ${r.adKey}`} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium">{formatNumber(r.conversations)} hội thoại đang chờ</p>
                  {r.adDescription ? <p className="line-clamp-3 text-sm text-muted-foreground">{r.adDescription}</p> : null}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <code className="font-mono">{r.adKey}</code>
                    {r.postUrl ? (
                      <a href={r.postUrl} target="_blank" rel="noopener noreferrer" className="underline">
                        mở bài viết gốc
                      </a>
                    ) : null}
                  </div>
                  <MapForm pageId={r.pageId} adKey={r.adKey} keyKind={r.keyKind} current={null} choices={choices} />
                </div>
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
              <div key={`${r.pageId}-${r.adKey}`} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row">
                <AnhQuangCao url={r.mediaUrl} alt={`Quảng cáo ${r.adKey}`} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium">
                    {r.productCode ? `${r.productCode} · ` : ""}
                    {r.productName || "(chưa trỏ)"}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {r.source === "HUMAN" ? "người đặt" : "máy xác định"} · {formatNumber(r.conversations)} hội thoại
                    </span>
                  </p>
                  {r.evidence ? <p className="text-xs text-muted-foreground">Căn cứ: {r.evidence}</p> : null}
                  <MapForm pageId={r.pageId} adKey={r.adKey} keyKind={r.keyKind} current={r.productId} choices={choices} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
