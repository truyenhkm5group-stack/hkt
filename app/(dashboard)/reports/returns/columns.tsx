"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Money } from "@/components/ui-bits";
import { CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";
import { CONFIDENCE_LABEL, type ProbabilityConfidence } from "@/lib/constants/projected-delivery";
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
 *
 * ═══════════ THỨ TỰ CỘT LÀ MỘT CÂU CHUYỆN, KHÔNG PHẢI MỘT DANH SÁCH ═══════════
 *
 * Chủ shop chốt 14/09/2026:
 *
 *   MÃ HÀNG → ĐÃ GỬI → GTC → KHÔNG THÀNH CÔNG → CHƯA KẾT THÚC → GTC THỰC TẾ → GTC ƯỚC TÍNH → DT THẤT BẠI
 *
 * Đọc trái sang phải là đúng thứ tự một người ra quyết định hỏi: gửi bao nhiêu → tới nơi bao nhiêu
 * → hỏng bao nhiêu → còn treo bao nhiêu → **tỷ lệ đã biết** → **tỷ lệ cuối cùng dự kiến** → mất bao
 * nhiêu tiền. Hai cột tỷ lệ đứng CẠNH NHAU là chủ ý: con số đã đo và con số dự báo phải so được
 * bằng mắt, và cột dự báo phải mang nhãn riêng để không ai đọc nhầm nó là số đếm.
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
    <div className="flex min-w-[128px] items-center gap-2" title={giaiThich}>
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

/**
 * Xác suất của từng trạng thái, do máy chủ bơm xuống.
 *
 * CỐ Ý là THAM SỐ của hàm dựng cột, không phải một biến mức mô-đun: biến mức mô-đun trong một
 * client component sống sót qua các lần điều hướng và sẽ phục vụ bảng xác suất của lần tải TRƯỚC
 * cho lần tải SAU — một ô ước tính đúng cấu trúc nhưng sai số liệu, kiểu sai khó thấy nhất.
 */
export type StateProb = { substate: string; label: string; p: number | null; sample: number; confidence: string };

/**
 * ═══════════ Ô "GTC ƯỚC TÍNH" PHẢI TỰ KHAI RA CẢ PHÉP TÍNH ═══════════
 *
 * Chủ shop yêu cầu tường minh (14/09/2026): hover vào một con số ước tính phải đọc được ĐÚNG bốn
 * thứ — đã gửi bao nhiêu, trong đó bao nhiêu đã ngã ngũ, phần chưa ngã ngũ tách theo trạng thái
 * ĐVVC kèm xác suất của từng trạng thái, và phép cộng ra con số cuối.
 *
 * Không có phần đó thì "47,0%" và "44,6%" trông y hệt nhau: một cái đo được, một cái dự báo.
 */
function giaiThichUocTinh(row: ReturnRateRow, probs: StateProb[]): string {
  const dong: string[] = [];
  dong.push(`Đã gửi: ${formatNumber(row.shipped)} đơn.`);
  dong.push(`Đã GTC ${formatNumber(row.delivered)} · đã hoàn ${formatNumber(row.returned)} · chưa kết thúc ${formatNumber(row.inTransit)}.`);
  const theoTrangThai = new Map(probs.map((x) => [x.substate, x]));
  if (row.inTransit > 0) {
    dong.push("Phần chưa kết thúc, tách theo trạng thái Viettel Post:");
    for (const [con, soDon] of Object.entries(row.activeByState)) {
      if (!soDon) continue;
      const x = theoTrangThai.get(con);
      const nhan = x?.label ?? CARRIER_SUBSTATE_LABEL[con as CarrierSubstate] ?? con;
      if (!x || x.p === null) {
        dong.push(`  · ${nhan}: ${formatNumber(soDon)} đơn — chưa đủ mẫu, NGOÀI phần ước tính`);
        continue;
      }
      dong.push(
        `  · ${nhan}: ${formatNumber(soDon)} đơn × P(GTC) ${(x.p * 100).toFixed(1)}% ≈ ${(soDon * x.p).toFixed(1)} đơn (học từ ${formatNumber(x.sample)} vận đơn · ${CONFIDENCE_LABEL[x.confidence as ProbabilityConfidence] ?? x.confidence})`,
      );
    }
  }
  const mauSo = row.projectedSent - row.unmodelledActive;
  dong.push(`Giao được dự kiến thêm: ${(row.projectedDelivered - row.delivered).toFixed(1)} đơn.`);
  dong.push(`Tổng giao được dự kiến: ${formatNumber(row.delivered)} + ${(row.projectedDelivered - row.delivered).toFixed(1)} = ${row.projectedDelivered.toFixed(1)} đơn.`);
  dong.push(`GTC ước tính = ${row.projectedDelivered.toFixed(1)} ÷ ${formatNumber(mauSo)} = ${row.expectedSuccessRate === null ? "chưa đo được" : `${row.expectedSuccessRate.toFixed(1)}%`}.`);
  if (row.unmodelledActive) {
    dong.push(`${formatNumber(row.unmodelledActive)} đơn ở trạng thái chưa đủ mẫu bị LOẠI khỏi cả tử số lẫn mẫu số — giữ chúng ở mẫu số mà không có gì ở tử số là ngầm coi P = 0 cho đúng nhóm mô hình vừa thừa nhận không biết gì.`);
  }
  dong.push("Đây là DỰ BÁO, không phải kết quả thực tế.");
  return dong.join("\n");
}

/** Dựng bộ cột. Nhận bảng xác suất để ô ước tính giải thích được chính nó. */
export function makeReturnRateColumns(probs: StateProb[]): ColumnDef<ReturnRateRow, unknown>[] {
  return [
    {
      id: "sku",
      header: "Mã hàng",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="flex min-w-[200px] items-center gap-2.5">
            {r.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.image} alt="" className="size-9 shrink-0 rounded-md border object-cover" loading="lazy" />
            ) : (
              <div className="size-9 shrink-0 rounded-md border bg-muted" />
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
        <span
          className="numeric"
          title={`${formatNumber(row.original.shipped)} vận đơn của mã này được ĐVVC tiếp nhận trong khoảng lọc. Tách ra: ${formatNumber(row.original.delivered)} giao thành công · ${formatNumber(row.original.returned)} không thành công · ${formatNumber(row.original.inTransit)} chưa kết thúc.`}
        >
          {formatNumber(row.original.shipped)}
        </span>
      ),
    },
    {
      id: "delivered",
      header: head(
        "GTC",
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
        "Không thành công",
        `Kết quả cuối là HOÀN. Gồm cả kiện ĐVVC ghi "phát thành công" nhưng tiền thực thu dưới 100.000đ — khách chỉ trả phí xem hàng, hàng quay về shop. ${MOC}`,
      ),
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <span className="numeric font-semibold text-rose-600 dark:text-rose-400">{formatNumber(row.original.returned)}</span>
          {row.original.returnedByRule ? <div className="text-[10.5px] text-muted-foreground">{formatNumber(row.original.returnedByRule)} thu 50K–100K</div> : null}
        </div>
      ),
    },
    {
      id: "inTransit",
      header: head(
        "Chưa kết thúc",
        `Chưa có kết quả cuối tại thời điểm mở báo cáo. KHÔNG nằm trong mẫu số của "GTC thực tế" — chưa biết thì không đếm về phía nào — nhưng ĐƯỢC cân theo xác suất ở cột "GTC ước tính". ${MOC}`,
      ),
      meta: { align: "right" },
      cell: ({ row }) => {
        const r = row.original;
        /*
          HAI NHÓM CHĂM SÓC ĐƯỢC GỌI TÊN NGAY TRÊN BẢNG, không giấu trong tooltip: đây là hai nhóm
          DUY NHẤT người trực can thiệp được, và chúng có triển vọng khác hẳn phần còn lại.
        */
        const choXuLy = r.activeByState.WAITING_PROCESSING ?? 0;
        const choPhatLai = r.activeByState.WAITING_REDELIVERY ?? 0;
        const chiTiet = Object.entries(r.activeByState)
          .filter(([, n]) => n)
          .map(([k, n]) => `${CARRIER_SUBSTATE_LABEL[k as CarrierSubstate] ?? k}: ${formatNumber(n as number)}`)
          .join(" · ");
        return (
          <div className="text-right" title={chiTiet || "Không còn đơn nào đang chạy."}>
            <span className="numeric text-muted-foreground">{formatNumber(r.inTransit)}</span>
            {choXuLy || choPhatLai ? (
              <div className="text-[10.5px] leading-4">
                {choXuLy ? (
                  <span className="mr-1 rounded bg-sky-50 px-1 font-semibold text-sky-700 dark:bg-sky-950/60 dark:text-sky-300" title="Chờ xử lý tại bưu cục">
                    ⏳ {formatNumber(choXuLy)}
                  </span>
                ) : null}
                {choPhatLai ? (
                  <span className="rounded bg-amber-50 px-1 font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" title="Giao thất bại, chờ phát lại">
                    ↻ {formatNumber(choPhatLai)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      id: "successRate",
      header: head(
        "GTC thực tế",
        "Giao thành công ÷ (giao thành công + không thành công). Đây là KẾT QUẢ ĐÃ XẢY RA của những vận đơn đã ngã ngũ. Đơn ĐANG GIAO không nằm ở mẫu số: đưa vào sẽ kéo tỷ lệ xuống chỉ vì hàng chưa tới nơi, và tỷ lệ sẽ tự đổi mỗi ngày mà không ai làm gì.",
      ),
      cell: ({ row }) => <RateBar rate={row.original.successRate} row={row.original} />,
    },
    {
      /*
        ═══ CỘT ƯỚC TÍNH QUAY LẠI BẢNG — LẦN NÀY CÓ NHÃN VÀ CÓ PHÉP TÍNH ═══

        Bản 13/09 GỠ cột "dự kiến" khỏi bảng, và lý do gỡ hoàn toàn đúng: công thức cũ áp MỘT tỷ lệ
        của cả shop cho từng mã, rồi in kết quả cạnh một con số đo thật, cùng cỡ chữ, cùng màu.
        Người đọc không có cách nào biết cột nào là ước tính.

        Ba thứ đã đổi nên nó được quay lại:
          1. con số đến từ `PROJECTED_GTC_V3` — mỗi đơn cân theo xác suất của CHÍNH trạng thái ĐVVC
             nó đang ở, điều kiện hoá theo mã hàng và tuổi kiện khi đủ mẫu;
          2. ô mang nhãn "ước tính", KHÔNG dùng thang màu đạt/không đạt của cột thực tế;
          3. hover ra đúng phép tính: từng trạng thái, từng xác suất, từng cỡ mẫu.

        Chưa đo được thì in "—", KHÔNG in 0% và KHÔNG mượn tỷ lệ của mã khác.
      */
      id: "expectedSuccessRate",
      header: head(
        "GTC ước tính",
        "Tỷ lệ GTC cuối cùng dự kiến của cohort Đã gửi. Các vận đơn chưa kết thúc được quy đổi theo xác suất đi đến DELIVERED dựa trên lịch sử chuyển trạng thái VTP. Đây là dự báo, không phải kết quả thực tế.",
      ),
      meta: { align: "right" },
      cell: ({ row }) => {
        const r = row.original;
        if (r.expectedSuccessRate === null) {
          return (
            <span className="cursor-help text-xs text-muted-foreground" title={giaiThichUocTinh(r, probs)}>
              — <span className="text-[10px]">chưa đo được</span>
            </span>
          );
        }
        const lech = r.successRate === null ? null : Math.round((r.expectedSuccessRate - r.successRate) * 10) / 10;
        return (
          <div className="text-right leading-tight" title={giaiThichUocTinh(r, probs)}>
            <span className="numeric cursor-help border-b border-dotted border-muted-foreground/50 text-sm font-semibold">{r.expectedSuccessRate.toFixed(1)}%</span>
            <div className="text-[10px] text-muted-foreground">
              ước tính
              {lech !== null ? (
                <span className={cn("ml-1", lech > 0 ? "text-emerald-600 dark:text-emerald-400" : lech < 0 ? "text-rose-600 dark:text-rose-400" : "")}>
                  {lech > 0 ? "+" : ""}
                  {lech.toFixed(1)}pp
                </span>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      id: "lostRevenue",
      header: head("Doanh thu thất bại", "Tổng giá trị dòng hàng của các đơn có kết quả cuối là HOÀN. Đây là doanh thu ĐÃ MẤT, không phải doanh thu treo."),
      meta: { align: "right" },
      cell: ({ row }) => (
        <div className="text-right">
          <Money value={row.original.lostRevenue} className={row.original.lostRevenue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground"} />
          <div className="text-[10.5px] text-muted-foreground">{formatNumber(row.original.returnedQty)} sp</div>
        </div>
      ),
    },
  ];
}
