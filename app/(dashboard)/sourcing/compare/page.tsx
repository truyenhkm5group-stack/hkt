import Link from "next/link";
import { Columns3 } from "lucide-react";
import { DataAge, OfferImage, TiersText } from "@/components/sourcing/offer-bits";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { SOURCING_COMPARE_MAX, SOURCING_COMPARE_QUANTITIES, SOURCING_PLATFORM_LABEL } from "@/lib/constants/sourcing";
import { getSourcingCompare, type SourcingCompareItem } from "@/lib/queries/sourcing";
import { safeHttpUrl } from "@/lib/sourcing/offer-url";
import { formatCny, formatHundredths, priceAtQty } from "@/lib/sourcing/price";
import type { SearchParams } from "@/lib/search-params";

export const metadata = { title: "So sánh mẫu nguồn" };

function idsOf(raw: SearchParams): string[] {
  const v = raw.ids;
  const s = Array.isArray(v) ? v.join(",") : (v ?? "");
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9-]{1,100}$/.test(x));
}

function PriceCell({ item, qty }: { item: SourcingCompareItem; qty: number }) {
  const l = item.latest;
  const p = priceAtQty(l?.tiers ?? null, qty, l?.moq ?? null);
  if (p.kind === "UNKNOWN") return <span className="text-muted-foreground">—</span>;
  if (p.kind === "BELOW_LOWEST_TIER") return <span className="text-xs text-muted-foreground">nguồn bán từ {p.lowestFrom} cái</span>;
  return (
    <span className="tabular-nums">
      {formatCny(p.priceFen)}
      <span className="ml-1 text-[11px] text-muted-foreground">(bậc ≥{p.tierFrom})</span>
      {p.belowMoq ? <span className="ml-1 rounded bg-amber-100 px-1 text-[11px] text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">dưới MOQ</span> : null}
    </span>
  );
}

/**
 * SO SÁNH 2–4 MẪU NGUỒN (SRC-3) từ lần chụp giá MỚI NHẤT của mỗi mẫu. Giá là nhân dân tệ / cái tại từng mốc số lượng
 * (`SOURCING_COMPARE_QUANTITIES`, chỉ để hiển thị). CHƯA có giá về Việt Nam và điểm — SRC-4 nối công thức vào đúng bảng này.
 * Không tô màu, không xếp hạng: số tay chưa đủ căn cứ để kết luận mẫu nào «tốt hơn».
 */
export default async function SourcingComparePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("sourcing:view");
  const ids = idsOf(await searchParams);
  const data = await getSourcingCompare(ids);
  const now = new Date();
  const header = <PageHeader eyebrow="Tìm hàng nguồn" title="So sánh mẫu" description={`Tối đa ${SOURCING_COMPARE_MAX} mẫu, đọc lần chụp giá mới nhất của mỗi mẫu. Giá tính bằng nhân dân tệ, chưa quy ra giá về Việt Nam.`} />;
  if (data.unavailable)
    return (
      <div className="space-y-5">
        {header}
        <p className="text-sm text-amber-700 dark:text-amber-300">CSDL của tổ chức chưa áp migration 0256 (kho mẫu nguồn).</p>
      </div>
    );
  const { items, missing } = data;
  const dropped = ids.length > SOURCING_COMPARE_MAX ? ids.length - SOURCING_COMPARE_MAX : 0;
  if (items.length < 2)
    return (
      <div className="space-y-5">
        {header}
        <EmptyState
          icon={Columns3}
          title="Chọn ít nhất 2 mẫu để so sánh"
          description={
            <>
              Vào <Link className="text-primary underline" href="/sourcing#kho-mau">Kho mẫu</Link>, tick 2–{SOURCING_COMPARE_MAX} mẫu rồi bấm «So sánh».
              {missing.length ? ` ${missing.length} mẫu trong link không còn trong kho.` : ""}
            </>
          }
        />
      </div>
    );

  const row = (label: string, render: (it: SourcingCompareItem) => React.ReactNode) => (
    <tr className="border-t align-top">
      <th scope="row" className="w-40 py-2 pr-3 text-left text-xs font-medium text-muted-foreground">
        {label}
      </th>
      {items.map((it) => (
        <td key={it.id} className="py-2 pr-3 text-sm">
          {render(it)}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="space-y-5">
      {header}
      {missing.length || dropped ? (
        <p className="text-xs text-muted-foreground">
          {missing.length ? `${missing.length} mẫu trong link không còn trong kho. ` : ""}
          {dropped ? `Chỉ lấy ${SOURCING_COMPARE_MAX} mẫu đầu, bỏ ${dropped}.` : ""}
        </p>
      ) : null}
      <SectionCard padded={false}>
        <div className="overflow-x-auto p-4">
          <table className="w-full min-w-[640px] table-fixed" data-sourcing-compare>
            <thead>
              <tr>
                <th className="w-40" />
                {items.map((it) => (
                  <th key={it.id} className="pb-2 pr-3 text-left align-top font-normal">
                    <div className="flex items-start gap-2">
                      <OfferImage src={it.imageUrl} alt={it.titleVi} size={56} />
                      <div className="min-w-0">
                        <Link className="font-semibold text-primary hover:underline" href={`/sourcing/offers/${it.id}`}>
                          {it.titleVi || "(chưa đặt tên)"}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {SOURCING_PLATFORM_LABEL[it.platform]}
                          {it.archived ? " · lưu trữ" : ""}
                        </div>
                      </div>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {row("Lần chụp giá", (it) => (it.latest ? <DataAge source={it.latest.source} asOf={it.latest.capturedAt} now={now} /> : <span className="text-muted-foreground">chưa chụp giá</span>))}
              {SOURCING_COMPARE_QUANTITIES.map((q) => (
                <tr key={q} className="border-t align-top">
                  <th scope="row" className="w-40 py-2 pr-3 text-left text-xs font-medium text-muted-foreground">
                    Giá / cái khi mua {q}
                  </th>
                  {items.map((it) => (
                    <td key={it.id} className="py-2 pr-3 text-sm">
                      <PriceCell item={it} qty={q} />
                    </td>
                  ))}
                </tr>
              ))}
              {row("MOQ", (it) => it.latest?.moq ?? "—")}
              {row("Mọi bậc giá", (it) => (it.latest ? <TiersText tiers={it.latest.tiers} className="text-xs" /> : "—"))}
              {row("Nhà cung cấp", (it) => it.supplier?.name || "—")}
              {row("Số năm trên nền tảng", (it) => it.supplier?.yearsOnPlatform ?? "—")}
              {row("Điểm đánh giá", (it) => (it.supplier?.ratingX100 == null ? "—" : `${formatHundredths(it.supplier.ratingX100)} / 5`))}
              {row("Tỷ lệ phản hồi", (it) => (it.supplier?.responseRateBp == null ? "—" : `${formatHundredths(it.supplier.responseRateBp)}%`))}
              {row("Đã xác minh", (it) => (it.supplier?.verified == null ? "—" : it.supplier.verified ? "có" : "không"))}
              {row("Gửi hàng từ", (it) => it.supplier?.shipFrom ?? "—")}
              {row("Số liệu nhà cung cấp", (it) => (it.supplier ? <DataAge source={it.supplier.factsSource} asOf={it.supplier.factsAsOf} now={now} /> : "—"))}
              {row("Link nguồn", (it) => {
                const href = safeHttpUrl(it.canonicalUrl);
                return href ? (
                  <a className="break-all text-xs text-primary underline" href={href} target="_blank" rel="noopener noreferrer">
                    mở trang nguồn
                  </a>
                ) : (
                  "—"
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <p className="text-xs text-muted-foreground">Chưa có giá về Việt Nam, chưa chấm điểm, không tô màu: số nhập tay chưa đủ căn cứ để kết luận mẫu nào tốt hơn. Bước sau (SRC-4) thêm giá về Việt Nam theo tham số đã khai.</p>
    </div>
  );
}
