import { AlertTriangle, CheckCircle2, CircleHelp, Timer, VolumeX } from "lucide-react";
import { WEBHOOK_MATCH_MIN_SAMPLE } from "@/lib/constants/webhook-gap";
import { WEBHOOK_LATENCY_MIN_SAMPLE } from "@/lib/constants/webhook-latency";
import type { WebhookHealth } from "@/lib/queries/vtp-webhook-health";
import { formatNumber, formatPercent, formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ NĂM CÂU HỎI VỀ WEBHOOK, KHÔNG PHẢI MỘT Ô "OK" ═══════════
 *
 * Webhook là nguồn tin DUY NHẤT cho 2.138/2.151 vận đơn của shop (đo 16/09/2026): tài khoản API
 * không đọc được chúng. Một nguồn duy nhất mà màn hình chỉ nói "OK" thì không ai sửa được gì khi
 * nó hỏng — vì bốn loại hỏng dưới đây sửa ở bốn chỗ khác nhau:
 *
 *   không nhận được   → cấu hình chuyển tiếp ở Pancake / Viettel Post
 *   nhận nhưng đã cũ  → hàng đợi gửi của ĐVVC dồn ứ; không sửa được ở đây, phải BIẾT mà đừng tin
 *   nhận mà đọc hỏng  → bảng mã trạng thái, mã nguồn xử lý
 *   sai thứ tự        → không phải lỗi; cao bất thường thì đường truyền đang dồn ứ
 *   rơi gói           → nhập tệp để vá, và nhập dày hơn
 *
 * Ô ĐỘ TRỄ ĐỨNG NGANG HÀNG VỚI Ô "CÓ ĐANG NHẬN", KHÔNG NẰM DƯỚI DẠNG CHÚ THÍCH. Ngày 21/09/2026
 * số gói vẫn bình thường nên ô trên xanh cả ngày, trong khi mọi gói đều nói chuyện của 28 phút
 * trước. Một ô xanh đứng một mình chính là thứ đã giấu sự cố ấy.
 */
export function VtpWebhookHealthPanel({ health }: { health: WebhookHealth }) {
  const tone =
    health.liveness === "SILENT"
      ? "border-destructive/40 bg-destructive/5"
      : health.liveness === "QUIET"
        ? "border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30"
        : health.liveness === "UNKNOWN"
          ? "border-muted bg-muted/30"
          : "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30";
  const Icon = health.liveness === "SILENT" ? VolumeX : health.liveness === "QUIET" ? AlertTriangle : health.liveness === "UNKNOWN" ? CircleHelp : CheckCircle2;
  const toneTre =
    health.latency === "STALLED"
      ? "border-destructive/40 bg-destructive/5"
      : health.latency === "LAGGING"
        ? "border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30"
        : health.latency === "UNKNOWN"
          ? "border-muted bg-muted/30"
          : "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30";
  const IconTre = health.latency === "STALLED" ? Timer : health.latency === "LAGGING" ? AlertTriangle : health.latency === "UNKNOWN" ? CircleHelp : CheckCircle2;

  return (
    <div className="mt-4 space-y-3">
      <div className={cn("flex items-start gap-3 rounded-lg border p-3", tone)}>
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="text-xs leading-5">
          <p className="font-medium text-foreground">
            15 phút qua {formatNumber(health.last15m)} gói · 1 giờ qua {formatNumber(health.last1h)} · 24 giờ qua {formatNumber(health.last24h)}
          </p>
          {/*
            NỀN SO SÁNH LẤY THEO ĐÚNG KHUNG GIỜ NÀY. Shop không nhận đơn lúc 3 giờ sáng, nên một
            ngưỡng phẳng sẽ hoặc hét mỗi đêm, hoặc câm cả ngày.
          */}
          <p className="mt-1 text-muted-foreground">{health.livenessNote}</p>
        </div>
      </div>

      <div className={cn("flex items-start gap-3 rounded-lg border p-3", toneTre)}>
        <IconTre className="mt-0.5 size-4 shrink-0" />
        <div className="text-xs leading-5">
          <p className="font-medium text-foreground">
            Độ trễ giờ qua:{" "}
            {health.latencyMedianSeconds === null || health.latencySample < WEBHOOK_LATENCY_MIN_SAMPLE ? (
              <span className="text-muted-foreground">chưa đủ mẫu ({formatNumber(health.latencySample)}/{WEBHOOK_LATENCY_MIN_SAMPLE} gói) — CHƯA BIẾT</span>
            ) : (
              <span className="numeric">{doDaiTre(health.latencyMedianSeconds)}</span>
            )}
            {health.latencyBaselineSeconds === null ? null : (
              <span className="text-muted-foreground"> · giờ này mọi hôm {doDaiTre(health.latencyBaselineSeconds)}</span>
            )}
            <span className="text-muted-foreground"> · {formatNumber(health.latencySample)} gói</span>
          </p>
          <p className="mt-1 text-muted-foreground">{health.latencyNote}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <O
          nhan="Đọc không được"
          so={formatNumber(health.parseFailed24h)}
          phu="gói tin ERP không đọc nổi trong 24h — lỗi định dạng, phải sửa mã"
          xau={health.parseFailed24h > 0}
        />
        <O
          nhan="Chưa ghép được vận đơn"
          so={formatNumber(health.unmatched24h)}
          phu="đọc được nhưng chưa có vận đơn tương ứng trong ERP — giữ nguyên để xử lý lại, tự hết khi đơn đồng bộ về"
        />
        <O
          nhan="ĐVVC gửi lại"
          so={health.duplicateRate24h === null ? "—" : formatPercent(health.duplicateRate24h * 100, 1)}
          phu={
            health.duplicateRate24h === null
              ? "chưa nhận gói nào trong 24h nên CHƯA BIẾT tỷ lệ — không phải 0%"
              : `${formatNumber(health.duplicate24h)} lần gửi lại / ${formatNumber(health.last24h)} gói. Viettel Post thử lại tối đa 5 lần; đây KHÔNG phải lỗi.`
          }
        />
        <O
          nhan="Tới sai thứ tự"
          so={formatNumber(health.outOfOrder24h)}
          phu="gói tin tới sau nhưng mang mốc ĐVVC cũ hơn. ERP xử lý đúng (mốc ĐVVC mới nhất thắng); cao bất thường là điềm báo đường truyền dồn ứ."
        />
      </div>

      {/*
        ═══ TỶ LỆ KHỚP — THỨ DUY NHẤT TRẢ LỜI ĐƯỢC "WEBHOOK CÓ RƠI KHÔNG" ═══

        ERP không thể tự biết mình đang thiếu một gói tin CHƯA TỪNG TỚI. Con số này chỉ lớn lên khi
        có người nhập tệp Viettel Post — một nguồn ĐỘC LẬP nói lại cùng những sự việc ấy.
      */}
      <div className="rounded-lg border p-3 text-xs">
        <p className="font-medium text-foreground">
          Tỷ lệ webhook nói đúng:{" "}
          {health.matchRate === null ? (
            <span className="text-muted-foreground">
              chưa đủ mẫu ({formatNumber(health.matchSample)}/{WEBHOOK_MATCH_MIN_SAMPLE} dòng đối chiếu) — CHƯA BIẾT, không phải 100%
            </span>
          ) : (
            <span className={cn("numeric", health.matchRate < 0.95 && "text-destructive")}>{formatPercent(health.matchRate * 100, 1)}</span>
          )}
        </p>
        <p className="mt-1 text-muted-foreground">
          Đo bằng tệp “Danh sách vận đơn” tải từ viettelpost.vn, 30 ngày gần nhất: {formatNumber(health.matchSample)} dòng ghép được về vận đơn ERP đã biết,{" "}
          {formatNumber(health.gaps30d)} lần ERP đi sau ĐVVC
          {health.gapCritical30d ? ` (${formatNumber(health.gapCritical30d)} lần chậm hơn ba ngày)` : ""}
          {health.lastGapAt ? ` · lần phát hiện gần nhất ${formatTimeAgo(health.lastGapAt)}` : ""}.
        </p>
        <p className="mt-1 text-muted-foreground">
          Con số này chỉ lớn lên khi có người nhập tệp. Không nhập tệp thì nó đứng yên — và ERP KHÔNG có cách nào khác để biết webhook đã rơi bao nhiêu.
        </p>
      </div>
    </div>
  );
}

function O({ nhan, so, phu, xau }: { nhan: string; so: string; phu: string; xau?: boolean }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-[13px] font-medium text-muted-foreground">{nhan}</p>
      <p className={cn("numeric mt-1 text-2xl font-bold", xau && "text-destructive")}>{so}</p>
      <p className="mt-1 text-[11.5px] leading-4 text-muted-foreground">{phu}</p>
    </div>
  );
}

/** Giây → câu chữ người đọc được. Dưới 90 giây thì giây, trên thì phút — không in "0,6 phút". */
function doDaiTre(giay: number): string {
  return giay < 90 ? `${Math.round(giay)} giây` : `${Math.round(giay / 60)} phút`;
}
