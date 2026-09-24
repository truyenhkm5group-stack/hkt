import { Trophy } from "lucide-react";
import { ExpandText } from "@/app/(dashboard)/marketing/creatives/creative-bits";
import { GeneChips, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { CopyButton } from "@/components/misc";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { listLibrary, readCurrentCreativeConfig } from "@/lib/queries/creative-loop";

/**
 * ═══════════ TAB THƯ VIỆN MẪU THẮNG ═══════════
 *
 * Mẫu đã vượt ngưỡng đơn chốt — chốt MỘT lần, không tự rơi ra. In cạnh nhau số đơn LÚC VÀO và số
 * đơn HIỆN TẠI: đơn bị huỷ về sau làm số hiện tại nhỏ đi, và người đọc phải thấy điều đó thay vì một
 * con số lặng lẽ đổi.
 */
export async function LibraryTab() {
  const db = await getDb();
  const [items, { config }] = await Promise.all([listLibrary(db), readCurrentCreativeConfig(db)]);

  return (
    <SectionCard
      title="Thư viện mẫu thắng"
      description={`THẮNG = vượt ${formatNumber(config.winOrdersAbove)} đơn chốt (ngưỡng đọc từ cấu hình). Đơn quy về mẫu đi bằng ad_id nên có thể đếm THIẾU.`}
      hint="Đơn chốt = đơn Pancake mang ad_id của mẩu QC, không huỷ. Pancake gửi ad_id cho khoảng 72,6% đơn có nguồn Facebook (đo 22/09/2026), nên ngưỡng đang đếm THIẾU chứ không đếm thừa. Giao / hoàn theo ORDER_OUTCOME — mẫu nhiều đơn mà hoàn cao vẫn là mẫu lỗ."
    >
      {items.length === 0 ? (
        <EmptyState icon={Trophy} title="Chưa có mẫu nào thắng" description={`Mẫu vào thư viện khi đơn chốt quy về nó vượt ${formatNumber(config.winOrdersAbove)}. Máy chấm mỗi lượt chạy của vòng.`} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((v) => (
            <div key={v.id} className="flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs">
              <VariantImage imageId={v.imageId} available={v.imageAvailable} alt={v.headline || `Mẫu #${v.slot}`} className="aspect-square w-full" />
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="line-clamp-2 text-[13.5px] font-semibold leading-snug">{v.headline || <span className="font-normal italic text-muted-foreground">Không tiêu đề</span>}</p>
                  <span className="shrink-0 text-[11px] text-muted-foreground">vào {formatDate(v.libraryAt)}</span>
                </div>
                <p className="line-clamp-1 text-[11.5px] text-muted-foreground">
                  Lô {formatDate(v.batchDay)} · #{v.slot} · {v.productName ?? v.productId ?? "—"}
                </p>
                <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/40 p-2 text-center text-[11px]">
                  <div title="Số đơn chốt lúc mẫu vào thư viện">
                    <div className="numeric text-[13px] font-bold">{formatNumber(v.libraryOrders)}</div>
                    <div className="text-muted-foreground">lúc vào</div>
                  </div>
                  <div title="Đơn chốt hiện tại · giao thành công / hoàn">
                    <div className="numeric text-[13px] font-bold">{formatNumber(v.bookedOrders)}</div>
                    <div className="text-muted-foreground">
                      chốt · {formatNumber(v.deliveredOrders)}/{formatNumber(v.returnedOrders)}
                    </div>
                  </div>
                  <div className="col-span-2" title="Chi cấp mẩu QC từ ngày chạy">
                    <div className="numeric text-[13px] font-bold">{formatVND(v.spendVnd)}</div>
                    <div className="text-muted-foreground">đã chi</div>
                  </div>
                </div>
                <GeneChips genes={v.genes} />
                <ExpandText text={v.primaryText} lines={4} />
                <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-2">
                  <CopyButton value={v.primaryText} what="câu chữ" label="Sao chép câu chữ" />
                  {v.headline ? <CopyButton value={v.headline} what="tiêu đề" label="Sao chép tiêu đề" /> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
