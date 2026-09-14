import { InfoHint } from "@/components/info-hint";
import { CONFIDENCE_LABEL, CONFIDENCE_TONE, type ProbabilityConfidence } from "@/lib/constants/projected-delivery";
import { formatNumber } from "@/lib/format";
import type { BacktestSummary } from "@/lib/queries/projected-delivery";
import { cn } from "@/lib/utils";

/**
 * NHÃN TIN CẬY ĐỨNG CẠNH MỌI CON SỐ "ƯỚC TÍNH" — dùng chung cho trang hiệu quả theo mã và bảng lợi
 * nhuận, để hai trang không tự đặt hai cách nói.
 *
 * Gọn: một huy hiệu + số vận đơn đã thử ngược; phần giải thích (lệch, Brier, độ phủ, các tháng đã
 * thử) nằm trong dấu ⓘ. Không có prose trong dòng bảng.
 *
 * `INSUFFICIENT_DATA` KHÔNG phải "mô hình sai" — nó là "chưa thử được vì chưa đủ kiện đã kết thúc".
 * Nhãn và màu phải để người đọc phân biệt hai chuyện đó.
 */
export function ProjectionConfidence({ backtest, error, className }: { backtest: BacktestSummary | null; error?: string | null; className?: string }) {
  if (error) {
    return (
      <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300", className)} title={error}>
        lỗi thử ngược
      </span>
    );
  }
  if (!backtest) return null;
  const c: ProbabilityConfidence = backtest.confidence;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-semibold", CONFIDENCE_TONE[c])}>
        {CONFIDENCE_LABEL[c]}
        {backtest.n ? ` · n=${formatNumber(backtest.n)}` : ""}
      </span>
      <InfoHint label="Mô hình này đã được thử ngược thế nào">
        <div className="space-y-1 text-[12px]">
          <p className="font-semibold">Thử ngược mô hình ước tính</p>
          <p>
            Lấy vận đơn <b>đã kết thúc</b> của {backtest.months.length ? backtest.months.join(", ") : "các tháng gần đây"}, chụp trạng thái ĐVVC ở các mốc 1·3·5·7·10 ngày sau khi ĐVVC nhận (chỉ
            bằng sự kiện có <b>trước</b> mốc đó), cho mô hình <b>học từ dữ liệu trước tháng ấy</b> đoán, rồi so với kết quả thật theo <code>ORDER_OUTCOME</code>.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <b>{formatNumber(backtest.n)}</b> vận đơn được chấm{backtest.coverage !== null ? ` · dự báo được ${backtest.coverage}% ảnh chụp` : ""}
            </li>
            <li>
              Lệch hệ thống <b>{backtest.bias === null ? "—" : `${backtest.bias > 0 ? "+" : ""}${(backtest.bias * 100).toFixed(1)} điểm`}</b>
              {backtest.bias !== null ? (backtest.bias > 0 ? " (mô hình lạc quan hơn thực tế)" : backtest.bias < 0 ? " (mô hình dè dặt hơn thực tế)" : "") : ""}
            </li>
            <li>
              Brier <b>{backtest.brier ?? "—"}</b> · sai số tuyệt đối <b>{backtest.mae ?? "—"}</b> (0 = hoàn hảo, 0,25 = như tung đồng xu)
            </li>
          </ul>
          <p className="text-muted-foreground">
            {c === "INSUFFICIENT_DATA"
              ? "Chưa đủ vận đơn đã kết thúc để thử ngược — con số ước tính chưa được kiểm chứng, không phải sai."
              : c === "LOW"
                ? "Mẫu nhỏ hoặc lệch lớn: đọc con số ước tính như một gợi ý, chưa phải căn cứ quyết định."
                : "Ngưỡng: tin cậy cao = ≥100 kiện, |lệch| ≤ 3 điểm, hiệu chuẩn 0,8–1,2; vừa = ≥30 kiện, |lệch| ≤ 7 điểm."}
          </p>
        </div>
      </InfoHint>
    </span>
  );
}
