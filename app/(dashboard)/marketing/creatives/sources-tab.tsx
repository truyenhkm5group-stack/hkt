import { ExternalLink, ImageIcon, ImageOff, Info } from "lucide-react";
import { OwnAdImportDialog, PancakePhotoImportButton } from "@/app/(dashboard)/marketing/creatives/import-buttons";
import { SourceForm } from "@/app/(dashboard)/marketing/creatives/source-form";
import { SourceToggle } from "@/app/(dashboard)/marketing/creatives/source-toggle";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { UrlPagination } from "@/components/data-table/url-pagination";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import {
  CREATIVE_SOURCE_KINDS,
  CREATIVE_SOURCE_KIND_LABEL,
  CREATIVE_SOURCE_KIND_USE,
  GENE_KEYS,
  GENE_LABEL,
  GENE_VALUE_LABEL,
  OWN_AD_REASON_LABEL,
  PIXEL_SAFE_SOURCE_KINDS,
  type CreativeSourceKind,
} from "@/lib/constants/creative-loop";
import { formatNumber, formatTimeAgo, formatVND } from "@/lib/format";
import { creativeSourceCounts, listCreativeProductOptions, listCreativeSources, type CreativeSourceRow } from "@/lib/queries/creative-sources";
import type { ListParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

const KIND_TONE: Record<CreativeSourceKind, string> = {
  PRODUCT_PHOTO: "bg-success/15 text-success",
  OWN_AD: "bg-primary text-primary-foreground",
  MANUAL: "bg-muted text-muted-foreground",
  SPY: "bg-warning/15 text-warning",
  RND: "bg-primary/10 text-primary",
};

function GeneLine({ r }: { r: CreativeSourceRow }) {
  if (!r.visionAt) return <p className="text-[11.5px] italic text-muted-foreground">Chưa đọc gen — máy đọc ở lượt chạy kế tiếp</p>;
  const keys = GENE_KEYS.filter((k) => r.genes[k]);
  if (!keys.length) return <p className="text-[11.5px] text-muted-foreground">Đã đọc, không nhận ra gen nào trong từ vựng</p>;
  return (
    <div className="flex flex-wrap gap-1" title={r.visionSummary || undefined}>
      {keys.map((k) => (
        <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10.5px]">
          <span className="text-muted-foreground">{GENE_LABEL[k]}:</span> {GENE_VALUE_LABEL[r.genes[k] as string] ?? r.genes[k]}
        </span>
      ))}
    </div>
  );
}

/** Số đo của quảng cáo cũ (chụp lúc nhập): chi / tin nhắn · đơn · vì sao được chọn. */
function OwnAdLine({ r }: { r: CreativeSourceRow }) {
  const m = r.ownAd;
  if (!m) return null;
  return (
    <p className="text-[11.5px] text-muted-foreground" title={`Chi ${formatVND(m.spendVnd)} · ${formatNumber(m.messages)} tin nhắn · kỳ đo ${m.periodFrom ?? "—"} → ${m.periodTo ?? "—"} · mẩu ${r.fbAdId ?? "—"}`}>
      {m.reason ? <span className="font-semibold text-foreground">{OWN_AD_REASON_LABEL[m.reason]}</span> : null}
      {m.reason ? " · " : ""}Chi/tin <span className="tabular-nums text-foreground">{formatVND(m.costPerMessageVnd)}</span> · <span className="tabular-nums text-foreground">{formatNumber(m.bookedOrders)}</span> đơn
      {r.productId ? null : <span className="text-warning"> · chưa có mã hàng — chưa làm mẫu cha được</span>}
    </p>
  );
}

/** Khối hướng dẫn ngắn: mỗi loại nguồn DÙNG VÀO VIỆC GÌ (chủ shop 24/09/2026: "chưa hiểu logic dùng"). */
function SourcesGuide({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="flex gap-2.5 rounded-lg border bg-muted/30 p-3 text-[12.5px] leading-snug">
      <Info className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="space-y-1.5">
        <p>
          <b>Mỗi mẫu máy sinh = 1 ảnh sản phẩm thật (bắt buộc)</b> + tuỳ ô: một <b>mẫu cha</b> (mẫu thắng của vòng hoặc quảng cáo cũ của shop — máy giữ năm gen, đổi một) hoặc
          một <b>nguồn cảm hứng</b> (máy chỉ đọc thành mô tả chữ). Ảnh mới được máy đọc gen ở lượt chạy kế tiếp.
        </p>
        <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {CREATIVE_SOURCE_KINDS.map((k) => (
            <li key={k}>
              <span className="font-semibold">{CREATIVE_SOURCE_KIND_LABEL[k]}:</span> <span className="text-muted-foreground">{CREATIVE_SOURCE_KIND_USE[k]}</span>
            </li>
          ))}
        </ul>
        {canWrite ? (
          <p className="text-muted-foreground">
            Bắt đầu nhanh: <b>Nhập ảnh sản phẩm từ Pancake</b> (ảnh chính của mọi mã đang bán) → <b>Nhập mẫu thắng / mẫu tốt từ Facebook</b> (mẩu của shop có đơn vượt ngưỡng
            thắng hoặc chi / tin nhắn dưới 4.000đ). Ảnh tham khảo, đối thủ, R&D thì tải tay bằng “Thêm ảnh nguồn”.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export async function SourcesTab({ params, canWrite }: { params: ListParams; canWrite: boolean }) {
  const [list, counts, products] = await Promise.all([
    listCreativeSources({ kinds: params.filters.loai ?? [], active: params.filters.bat ?? [], q: params.q, page: params.page, pageSize: params.pageSize }),
    creativeSourceCounts(),
    canWrite ? listCreativeProductOptions() : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-4">
      <SourcesGuide canWrite={canWrite} />
      <StatStrip
        columns={3}
        items={[
          {
            label: "Mã có ảnh sản phẩm thật",
            value: formatNumber(counts.productsWithPhoto),
            note: "mã test được",
            tone: counts.productsWithPhoto ? "default" : "amber",
            hint: "Số mã hàng có ít nhất một ảnh sản phẩm thật ĐANG BẬT. Máy chỉ sinh mẫu cho mã có ảnh loại này — mã không có thì không vào lô.",
            href: "/marketing/creatives?loai=PRODUCT_PHOTO&bat=ON",
          },
          ...CREATIVE_SOURCE_KINDS.map((k) => ({
            label: CREATIVE_SOURCE_KIND_LABEL[k],
            value: formatNumber(counts.activeByKind[k]),
            note: "đang bật",
            href: `/marketing/creatives?loai=${k}&bat=ON`,
          })),
        ]}
      />

      <DataTableToolbar
        searchPlaceholder="Tiêu đề, ghi chú, mã hoặc tên sản phẩm…"
        facets={[
          { key: "loai", label: "Loại ảnh", options: CREATIVE_SOURCE_KINDS.map((k) => ({ value: k, label: CREATIVE_SOURCE_KIND_LABEL[k] })) },
          {
            key: "bat",
            label: "Trạng thái",
            options: [
              { value: "ON", label: "Đang dùng" },
              { value: "OFF", label: "Đã tắt" },
            ],
          },
        ]}
        resultLabel={<>{formatNumber(list.total)} ảnh nguồn</>}
      >
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <PancakePhotoImportButton />
            <OwnAdImportDialog />
            <SourceForm products={products} />
          </div>
        ) : null}
      </DataTableToolbar>

      {list.rows.length === 0 ? (
        <SectionCard>
          <EmptyState
            icon={ImageIcon}
            title={counts.total ? "Không có ảnh nguồn nào khớp bộ lọc" : "Chưa có ảnh nguồn nào"}
            description={
              counts.total
                ? "Bỏ bớt bộ lọc để xem lại toàn bộ."
                : canWrite
                  ? "Bắt đầu bằng ẢNH SẢN PHẨM THẬT của các mã muốn test (nút “Nhập ảnh sản phẩm từ Pancake”) — không có ảnh loại này thì máy không dựng được lô nào. Quảng cáo cũ của shop làm mẫu cha; ảnh đối thủ / R&D / tham khảo chỉ được đọc thành mô tả chữ."
                  : "Đội marketing chưa tải ảnh nguồn nào. Cần quyền “Ý tưởng: đăng & sửa” để thêm."
            }
          />
        </SectionCard>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {list.rows.map((r) => (
            <div key={r.id} className={cn("flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs", !r.active && "opacity-60")}>
              <div className="relative aspect-square w-full overflow-hidden bg-muted">
                {r.imageId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/creative/images/${r.imageId}`} alt={r.title || CREATIVE_SOURCE_KIND_LABEL[r.kind]} className="size-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex size-full flex-col items-center justify-center gap-1 text-[11.5px] text-muted-foreground">
                    <ImageOff className="size-7" />
                    {r.imagePurged ? "Điểm ảnh đã xoá" : "Không có ảnh"}
                  </div>
                )}
                <span className={cn("absolute left-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-semibold", KIND_TONE[r.kind])}>{CREATIVE_SOURCE_KIND_LABEL[r.kind]}</span>
                {!PIXEL_SAFE_SOURCE_KINDS.includes(r.kind) ? (
                  <span className="absolute bottom-2 left-2 rounded bg-background/85 px-1.5 py-0.5 text-[10.5px]" title="Điểm ảnh không bao giờ gửi sang máy sinh ảnh — chỉ gen + mô tả chữ">
                    Chỉ đọc thành mô tả
                  </span>
                ) : r.kind === "OWN_AD" ? (
                  <span className="absolute bottom-2 left-2 rounded bg-background/85 px-1.5 py-0.5 text-[10.5px]" title={CREATIVE_SOURCE_KIND_USE.OWN_AD}>
                    Mẫu cha + câu chữ đã bán được
                  </span>
                ) : null}
              </div>
              <div className="flex flex-1 flex-col gap-1.5 p-3">
                <p className="line-clamp-1 text-[13px] font-semibold leading-snug">{r.title || <span className="font-normal italic text-muted-foreground">Không tiêu đề</span>}</p>
                <p className="line-clamp-1 text-[12px] text-muted-foreground">
                  {r.productId ? (
                    <>
                      <span className="font-medium text-foreground">{r.productCode || "—"}</span> · {r.productName ?? "mã không còn trong danh mục"}
                    </>
                  ) : (
                    "Không gắn mã hàng"
                  )}
                </p>
                <OwnAdLine r={r} />
                <GeneLine r={r} />
                <div className="mt-auto flex items-center gap-2 pt-1.5 text-[11.5px] text-muted-foreground">
                  <span title="Số mẫu trong các lô đã dùng nguồn này làm ảnh gốc hoặc nguồn cảm hứng">
                    {r.uses ? `Dùng cho ${formatNumber(r.uses)} mẫu` : "Chưa dùng"}
                  </span>
                  {r.sourceUrl ? (
                    <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:text-foreground" title={r.sourceUrl}>
                      <ExternalLink className="size-3" /> nguồn
                    </a>
                  ) : null}
                  <span className="ml-auto" title={r.createdByName}>
                    {formatTimeAgo(r.createdAt)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t pt-1.5">
                  <SourceToggle key={`${r.id}-${r.active}`} id={r.id} active={r.active} canWrite={canWrite} />
                  <span className="truncate text-[11px] text-muted-foreground">{r.createdByName || "máy"}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <UrlPagination pageCount={list.pageCount} total={list.total} />
    </div>
  );
}
