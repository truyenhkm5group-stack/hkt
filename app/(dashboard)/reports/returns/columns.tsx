"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Money } from "@/components/ui-bits";
import { SUCCESS_RATE_GOOD, SUCCESS_RATE_OK, successTone } from "@/lib/constants/returns";
import { formatNumber } from "@/lib/format";
import type { ReturnRateRow } from "@/lib/queries/return-rate";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TOOLTIP HAI LỚP ═══════════
 *
 * Lớp 1 — TÊN CỘT: chỉ số này nghĩa là gì, công thức, mốc thời gian, luật loại trừ.
 * Lớp 2 — TỪNG Ô: tử số / mẫu số / phép tính của CHÍNH dòng đó.
 *
 * Vì sao cần cả hai: tên cột trả lời "cột này đo cái gì", ô số trả lời "con số NÀY ở đâu ra".
 * Người đọc thấy 45.2% sẽ hỏi câu thứ hai, và nếu màn hình không trả lời thì họ tự đoán — thường
 * là đoán rằng mẫu số gồm cả đơn đang giao.
 */
const LOAI_TRU = "Loại khỏi bảng: vận đơn chiều về (…1P1), đơn 'shop huỷ lấy', đơn 'lấy không thành công', hàng tặng.";
const MOC = "Cohort lọc theo NGÀY ĐVVC TIẾP NHẬN KIỆN (mốc lấy hàng, hoặc sự kiện ĐVVC đầu tiên). Kiện chưa có chứng cứ tiếp nhận nằm ngoài cohort — không bị gán ngày tạo đơn.";

function head(title: string, tip: string) {
  const Head = () => (
    <span className="cursor-help border-b border-dotted border-muted-foreground/50" title={tip}>
      {title}
    </span>
  );
  Head.displayName = `Head(${title})`;
  return Head;
}

/**
 * Thanh tỷ lệ GIAO THÀNH CÔNG: xanh ≥ 70%, vàng ≥ 55%, đỏ dưới 55%.
 *
 * Ô số mang BREAKDOWN đầy đủ trong `title`: tử số, mẫu số, phép tính, và số đơn đang giao bị để
 * ngoài mẫu. Không có nó thì "100.0%" trên 2 vận đơn trông y hệt "100.0%" trên 200.
 */
function RateBar({ rate, row }: { rate: number | null; row: ReturnRateRow }) {
  if (rate === null) {
    return (
      <span className="text-xs text-muted-foreground" title={`Chưa vận đơn nào của mã này có kết quả cuối trong khoảng lọc — ${formatNumber(row.inTransit)} kiện vẫn đang đi. Không có mẫu số thì không có tỷ lệ; đây KHÔNG phải 0%.`}>
        chưa có kết quả
      </span>
    );
  }
  const ketThuc = row.delivered + row.returned;
  const width = Math.max(2, Math.min(100, rate));
  const giaiThich = `${formatNumber(row.delivered)} giao thành công ÷ ${formatNumber(ketThuc)} vận đơn ĐÃ KẾT THÚC (${formatNumber(row.delivered)} thành công + ${formatNumber(row.returned)} hoàn) = ${rate.toFixed(1)}%. ${formatNumber(row.inTransit)} kiện đang giao KHÔNG nằm trong mẫu số.${ketThuc < 20 ? ` Mẫu chỉ ${ketThuc} kiện — quá nhỏ để kết luận về mã hàng này.` : ""}`;
  return (
    <div className="flex min-w-[140px] items-center gap-2" title={giaiThich}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full", rate >= SUCCESS_RATE_GOOD ? "bg-emerald-500" : rate >= SUCCESS_RATE_OK ? "bg-amber-500" : "bg-rose-500")} style={{ width: `${width}%` }} />
      </div>
      <span className={cn("numeric w-14 text-right text-sm font-bold", successTone(rate))}>{rate.toFixed(1)}%</span>
      {/*
        MẪU BÉ PHẢI NÓI THÀNH LỜI, không chỉ nằm trong tooltip.

        Ảnh chụp bảng cho thấy mã Q004 hiện "100.0%" với một thanh xanh đầy — con số đó đứng trên
        ĐÚNG 2 vận đơn đã kết thúc. Một thanh xanh đầy là lời khẳng định mạnh; đứng trên 2 quan
        sát thì nó không đúng cũng không sai, nó chỉ chưa nói được gì.
      */}
      {ketThuc < 20 ? (
        <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" title={`Chỉ ${ketThuc} vận đơn đã kết thúc — chưa đủ để kết luận.`}>
          /{ketThuc}
        </span>
      ) : null}
    </div>
  );
}

export const returnRateColumns: ColumnDef<ReturnRateRow, unknown>[] = [
  {
    id: "sku",
    header: "Mã hàng",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {r.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" />
          ) : (
            <div className="size-10 shrink-0 rounded-md border bg-muted" />
          )}
          <div className="min-w-0">
            <div className="truncate font-semibold">{r.sku || "(không có SKU)"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {r.productName}
              {r.variationDetail ? ` · ${r.variationDetail}` : ""}
            </div>
          </div>
        </div>
      );
    },
  },
  {
    id: "shipped",
    header: head("Đã gửi", `Số vận đơn bán hàng gốc mà ĐVVC đã tiếp nhận trong khoảng lọc. ${MOC} ${LOAI_TRU}`),
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="numeric" title={`${formatNumber(row.original.shipped)} vận đơn của mã này được ĐVVC tiếp nhận trong khoảng lọc. Tách ra: ${formatNumber(row.original.delivered)} giao thành công · ${formatNumber(row.original.returned)} không thành công · ${formatNumber(row.original.inTransit)} đang giao.`}>
        {formatNumber(row.original.shipped)}
      </span>
    ),
  },
  {
    id: "delivered",
    header: head(
      "Giao thành công (COD > 100K)",
      `Kết quả cuối là GIAO THÀNH CÔNG theo hợp đồng ORDER_OUTCOME: có chứng từ ĐVVC phát thành công VÀ tiền thực thu (hoặc chuyển khoản trước) trên 100.000đ. "Giao thành công một phần" KHÔNG tính. Tiền không phải chứng cứ logistics — nó chỉ tham gia qua chính hợp đồng này. ${MOC}`,
    ),
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="numeric font-semibold text-emerald-700 dark:text-emerald-400" title={`${formatNumber(row.original.delivered)} / ${formatNumber(row.original.shipped)} vận đơn đã gửi của mã này.`}>
        {formatNumber(row.original.delivered)}
      </span>
    ),
  },
  {
    id: "returned",
    header: head(
      "Không thành công (hoàn)",
      `Kết quả cuối là HOÀN. Gồm cả kiện ĐVVC ghi "phát thành công" nhưng tiền thực thu dưới 100.000đ — khách chỉ trả phí xem hàng, hàng quay về shop. ${MOC}`,
    ),
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <span className="numeric font-semibold text-rose-600 dark:text-rose-400">{formatNumber(row.original.returned)}</span>
        {row.original.returnedByRule ? <div className="text-[10.5px] text-muted-foreground">{formatNumber(row.original.returnedByRule)} giao nhưng COD 50K–100K</div> : null}
      </div>
    ),
  },
  {
    id: "inTransit",
    header: head("Đang giao", `Chưa có kết quả cuối tại thời điểm mở báo cáo. KHÔNG nằm trong mẫu số của tỷ lệ giao thành công — chưa biết thì không đếm về phía nào. ${MOC}`),
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="numeric text-muted-foreground">
        {formatNumber(row.original.inTransit)}
        {row.original.failed ? <span className="ml-1 rounded bg-amber-50 px-1 text-[10.5px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" title="Giao thất bại, chờ phát lại">↻ {formatNumber(row.original.failed)}</span> : null}
      </span>
    ),
  },
  {
    id: "successRate",
    header: head(
      "Tỷ lệ giao thành công (đã kết thúc)",
      "Giao thành công ÷ (giao thành công + không thành công). Đơn ĐANG GIAO không nằm ở mẫu số: đưa vào sẽ kéo tỷ lệ xuống chỉ vì hàng chưa tới nơi, và tỷ lệ sẽ tự đổi mỗi ngày mà không ai làm gì.",
    ),
    cell: ({ row }) => <RateBar rate={row.original.successRate} row={row.original} />,
  },
  /*
    ═══ "DỰ KIẾN (TÍNH CẢ CHỜ PHÁT LẠI)" ĐÃ BỊ GỠ KHỎI BẢNG ═══

    Công thức cũ:
      dự kiến = 100 − (hoàn + chờ_phát_lại × p) ÷ (đã_kết_thúc + chờ_phát_lại) × 100
    với `p` = `failedToReturnRate()`, tỷ lệ kiện từng phát hỏng rồi thành hoàn, HỌC TỪ LỊCH SỬ.

    Đo `p` trên production 13/09/2026: 173 kiện từng phát hỏng · 67 thành hoàn · 38 giao được ·
    50 còn treo. Tức `p ≈ 63,8%` trên mẫu 105 kiện đã ngã ngũ.

    Con số đó có thật, nhưng nó là tỷ lệ CỦA CẢ SHOP áp cho TỪNG MÃ HÀNG. Mã Q004 có 1 kiện chờ
    phát lại thì nó nhận 63,8% của toàn shop, không phải tỷ lệ của chính nó — và bảng in kết quả
    ra cạnh một con số đo thật, cùng cỡ chữ, cùng màu. Người đọc không có cách nào biết cột này
    là ước tính còn cột bên cạnh là số đếm.

    Đúng luật "không để một metric heuristic trông như business truth": GỠ khỏi bảng mặc định.
    Hàm `failedToReturnRate()` và trường `expectedSuccessRate` GIỮ NGUYÊN — trang Kịch bản dùng
    chúng đúng chỗ (ở đó nó được gọi tên là giả định và có ô chỉnh tay).
  */
  {
    id: "lostRevenue",
    header: "Doanh thu không thành công",
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <Money value={row.original.lostRevenue} className={row.original.lostRevenue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground"} />
        <div className="text-[10.5px] text-muted-foreground">{formatNumber(row.original.returnedQty)} sp</div>
      </div>
    ),
  },
];
