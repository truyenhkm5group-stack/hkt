import { Trophy } from "lucide-react";
import { ExpandText } from "@/app/(dashboard)/marketing/creatives/creative-bits";
import { GeneChips, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { CopyButton } from "@/components/misc";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { getDb } from "@/db";
import { formatDate, formatNumber, formatVND } from "@/lib/format";
import { listLibrary, listLibraryProductOptions, readCurrentCreativeConfig } from "@/lib/queries/creative-loop";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ TAB THƯ VIỆN MẪU THẮNG ═══════════
 *
 * Mẫu đã vượt ngưỡng đơn chốt — chốt MỘT lần, không tự rơi ra. In cạnh nhau số đơn LÚC VÀO và số
 * đơn HIỆN TẠI: đơn bị huỷ về sau làm số hiện tại nhỏ đi, và người đọc phải thấy điều đó thay vì một
 * con số lặng lẽ đổi.
 *
 * BỘ LỌC (URL, qua nuqs của `DataTableToolbar`): `mau` = mã hàng mà creative quảng bá; kỳ
 * (`period` / `from` / `to`) lọc theo NGÀY VÀO THƯ VIỆN. Mặc định "toàn bộ" — thư viện là tài sản
 * tích luỹ, mở ra mà chỉ thấy tháng này là giấu mất mẫu thắng cũ.
 *
 * CHI / ĐƠN và DOANH THU LÊN ĐƠN đứng cạnh phán quyết làm BẰNG CHỨNG: mẫu vượt ngưỡng đơn mà chi / đơn
 * cao hơn biên của mã vẫn có thể là mẫu lỗ. Chúng KHÔNG đổi ngưỡng THẮNG (AGENTS.md mục 38) và không
 * được tô màu — ERP chưa có đích CPO nào cho creative.
 */
export async function LibraryTab({ productId, period }: { productId: string | null; period: Period }) {
  const db = await getDb();
  const [items, options, { config }] = await Promise.all([
    listLibrary(db, { productId, from: period.from, to: period.to }),
    listLibraryProductOptions(db),
    readCurrentCreativeConfig(db),
  ]);
  const filtered = Boolean(productId) || period.key !== "all";

  return (
    <SectionCard
      title="Thư viện mẫu thắng"
      description={`THẮNG = vượt ${formatNumber(config.winOrdersAbove)} đơn chốt (ngưỡng đọc từ cấu hình). Đơn quy về mẫu đi bằng ad_id, hoặc bằng bài viết khi bài chỉ thuộc đúng MỘT mẩu.`}
      hint="Đơn chốt = đơn không huỷ quy về mẩu QC bằng ORDER_AD_ID — cùng biểu thức với bảng quyết định /ads: ad_id Pancake gửi trước, không có thì bài viết của đơn nếu bài ấy chỉ do một mẩu chạy (bài nhiều mẩu cùng chạy thì KHÔNG nối). Đơn chưa nối được vẫn không được đếm, nên ngưỡng có thể đếm THIẾU, không đếm thừa. Giao / hoàn theo ORDER_OUTCOME — mẫu nhiều đơn mà hoàn cao vẫn là mẫu lỗ. Chi / đơn và doanh thu lên đơn là bằng chứng, không đổi ngưỡng thắng."
    >
      <div className="mb-3">
        <DataTableToolbar
          period={{ defaultKey: "all" }}
          facets={[{ key: "mau", label: "Mẫu", single: true, options: options.map((o) => ({ value: o.id, label: o.label, count: o.count })) }]}
          resultLabel={<>{formatNumber(items.length)} mẫu thắng</>}
        />
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={Trophy}
          title={filtered ? "Không có mẫu thắng nào khớp bộ lọc" : "Chưa có mẫu nào thắng"}
          description={
            filtered
              ? "Kỳ lọc theo NGÀY VÀO THƯ VIỆN. Bỏ bớt bộ lọc để xem lại toàn bộ."
              : `Mẫu vào thư viện khi đơn chốt quy về nó vượt ${formatNumber(config.winOrdersAbove)}. Máy chấm mỗi lượt chạy của vòng.`
          }
        />
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
                  <div title={`Đơn chốt hiện tại · giao thành công / hoàn. Theo đường quy kết: ${formatNumber(v.ordersDirect)} mang ad_id · ${formatNumber(v.ordersViaPost)} qua bài viết.`}>
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
                {/* BẰNG CHỨNG, không phải phán quyết: không tô màu, không ngưỡng. */}
                <p className="text-[11px] text-muted-foreground" title="Chi / đơn chốt và doanh thu lên đơn của các đơn quy về mẫu. Bằng chứng đi kèm phán quyết — không đổi ngưỡng THẮNG.">
                  Chi/đơn <span className="tabular-nums text-foreground">{formatVND(v.costPerOrderVnd)}</span> · DT lên đơn{" "}
                  <span className="tabular-nums text-foreground">{formatVND(v.bookedRevenueVnd)}</span>
                  {v.ordersViaPost > 0 ? <> · {formatNumber(v.ordersViaPost)} đơn qua bài viết</> : null}
                </p>
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
