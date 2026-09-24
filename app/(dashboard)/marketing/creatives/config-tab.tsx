import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ConfigForm } from "@/app/(dashboard)/marketing/creatives/config-form";
import { SectionCard } from "@/components/ui-bits";
import { CREATIVE_WRITE_DENIAL_REASON, IMAGE_MODE_LABEL, IMAGE_QUALITY_LABEL, IMAGE_SIZE_LABEL, estimateImageUsd, imageModelBatchSupport } from "@/lib/constants/creative-loop";
import { formatDateTime, formatNumber } from "@/lib/format";
import { adsWriteDisabledReason } from "@/lib/integrations/facebook/ads-write";
import { creativeSourceCounts, listCreativeProductOptions, readCreativeConfig } from "@/lib/queries/creative-sources";
import { FB_WRITE_SCOPE } from "@/lib/constants/fb-token-scopes";
import { getFbTokenScopes } from "@/lib/queries/fb-token-scopes";
import { cn } from "@/lib/utils";

/**
 * `OK` · `BLOCK` (thiếu thì vòng KHÔNG đăng được) · `WARN` (chạy được nhưng máy sẽ không tự làm một
 * việc người ta có thể tưởng nó làm) · `UNKNOWN` (ERP không tự đo được — nói thẳng, không tô xanh).
 */
type Level = "OK" | "BLOCK" | "WARN" | "UNKNOWN";
type Check = { level: Level; label: string; detail: ReactNode };

const ICON: Record<Level, typeof CheckCircle2> = { OK: CheckCircle2, BLOCK: XCircle, WARN: CircleAlert, UNKNOWN: CircleHelp };
const TONE: Record<Level, string> = { OK: "text-success", BLOCK: "text-destructive", WARN: "text-warning", UNKNOWN: "text-muted-foreground" };

export async function ConfigTab({ canManage }: { canManage: boolean }) {
  const [state, counts, products, scopes] = await Promise.all([readCreativeConfig(), creativeSourceCounts(), listCreativeProductOptions(), getFbTokenScopes()]);
  const { config, problems } = state;
  const writeReason = adsWriteDisabledReason();
  const thieu = problems.filter((p) => p.field !== "rules");
  const luatHong = problems.filter((p) => p.field === "rules");
  // Giá ước tính đọc từ hợp đồng (`estimateImageUsd`) — không gõ lại con số nào.
  const oAnh = config.batchSize + config.extraCandidates;
  const giaAnh = estimateImageUsd(config.imageModel, config.imageQuality, config.imageSize, config.imageMode);
  const giaLo = Math.round(giaAnh * oAnh * 1000) / 1000;
  const giaVeNot = estimateImageUsd(config.imageModel, config.fallbackImageQuality, config.imageSize);
  const batchDoc = imageModelBatchSupport(config.imageModel);
  const usd = (n: number) => `${n.toLocaleString("vi-VN", { maximumFractionDigits: 3 })} USD`;

  const checks: Check[] = [
    {
      level: state.unreadable ? "BLOCK" : state.saved ? "OK" : "WARN",
      label: "Cấu hình đã lưu",
      detail: state.unreadable
        ? "Dòng cấu hình đã lưu KHÔNG đọc được (JSON hỏng) — máy đang dùng mặc định trong mã. Lưu lại bên dưới để ghi đè."
        : state.saved
          ? `Lưu lần cuối ${formatDateTime(state.updatedAt)}.`
          : "Chưa lưu lần nào — máy đang dùng mặc định trong mã nguồn.",
    },
    {
      level: thieu.length ? "BLOCK" : "OK",
      label: "Fanpage · tài khoản · chiến dịch test · mẩu mẫu",
      detail: thieu.length ? thieu.map((p) => p.message).join(" ") : "Đủ bốn trường máy cần để đăng.",
    },
    {
      level: writeReason ? "BLOCK" : "OK",
      label: "Đường ghi quảng cáo (máy chủ)",
      detail: writeReason ?? "Đang mở. Mọi lượt ghi vẫn phải qua phiếu duyệt lô (nấc COPILOT).",
    },
    {
      // Hỏi thẳng Facebook (`/me/permissions`). `UNKNOWN` khi không hỏi được — không tô đỏ oan, không tô xanh khống.
      level: scopes.state === "READY" ? "OK" : scopes.state === "MISSING" ? "BLOCK" : "UNKNOWN",
      label: `Token có quyền ${FB_WRITE_SCOPE}`,
      detail: (
        <>
          {scopes.reason}
          {scopes.granted.length ? ` Quyền đang có: ${scopes.granted.join(", ")}.` : ""}
          {scopes.declined.length ? ` Bị từ chối: ${scopes.declined.join(", ")}.` : ""}
        </>
      ),
    },
    {
      // Phân quyền TÀI SẢN trong Business Manager không nằm trong phạm vi token — Graph API `/me/permissions` không trả lời câu này.
      level: "UNKNOWN",
      label: "Fanpage đã giao quyền “Tạo quảng cáo” cho System User",
      detail: "ERP không đọc được phân quyền tài sản trong Business Manager — lượt đăng đầu tiên mới trả lời. Kiểm tay: Cài đặt doanh nghiệp → Người dùng hệ thống → Tài sản được chỉ định.",
    },
    {
      level: counts.productsWithPhoto ? "OK" : "BLOCK",
      label: "Ảnh sản phẩm thật",
      detail: counts.productsWithPhoto ? (
        <>
          {formatNumber(counts.productsWithPhoto)} mã có ảnh đang bật.{" "}
          <Link className="underline underline-offset-2" href="/marketing/creatives?loai=PRODUCT_PHOTO&bat=ON">
            Xem
          </Link>
        </>
      ) : (
        <>
          Chưa mã nào có ảnh sản phẩm thật — máy không dựng được lô nào.{" "}
          <Link className="underline underline-offset-2" href="/marketing/creatives">
            Tải ảnh ở tab Nguồn ảnh
          </Link>
        </>
      ),
    },
    {
      level: luatHong.length ? "BLOCK" : config.killRules.length ? "OK" : "WARN",
      label: "Luật tắt sớm",
      detail: luatHong.length
        ? luatHong.map((p) => p.message).join(" ")
        : config.killRules.length
          ? `${formatNumber(config.killRules.length)} luật.`
          : "Chưa khai — máy sẽ KHÔNG tự tắt mẫu nào; mỗi mẫu tiêu hết ngân sách test rồi tự dừng.",
    },
    {
      level: config.keepRules.length ? "OK" : "WARN",
      label: "Luật giữ",
      detail: config.keepRules.length ? `${formatNumber(config.keepRules.length)} luật.` : "Chưa khai — máy không kết luận mẫu nào hứa hẹn hay bị loại (chỉ THẮNG khi vượt ngưỡng đơn).",
    },
    {
      level: giaLo > config.imageDailyCapUsd || (config.imageMode === "BATCH" && batchDoc === false) ? "WARN" : "OK",
      label: `Sinh ảnh: ${config.imageModel} · ${IMAGE_QUALITY_LABEL[config.imageQuality].toLowerCase()} · ${IMAGE_SIZE_LABEL[config.imageSize]} · ${IMAGE_MODE_LABEL[config.imageMode]}`,
      detail: (
        <>
          Ước tính {usd(giaAnh)} / ảnh · một lô {formatNumber(oAnh)} ảnh ≈ {usd(giaLo)} / trần ngày {usd(config.imageDailyCapUsd)}
          {config.imageMode === "BATCH" ? ` · Batch chưa xong lúc ${config.batchFallbackHourVn}:00 thì vẽ nốt ở chất lượng ${IMAGE_QUALITY_LABEL[config.fallbackImageQuality].toLowerCase()} (${usd(giaVeNot)} / ảnh).` : "."}
          {config.imageMode === "BATCH" && batchDoc === false
            ? ` Trang mô hình của OpenAI (đọc 24/09/2026) ghi ${config.imageModel} KHÔNG hỗ trợ Batch — máy vẫn gửi thử, OpenAI từ chối thì vẽ ngay bằng gọi ngay ở chất lượng vẽ nốt.`
            : ""}
          {giaLo > config.imageDailyCapUsd ? " Một lô vượt trần ngày — chỉ số ô vừa trần được vẽ." : ""}
        </>
      ),
    },
    {
      level: config.enabled ? "OK" : "BLOCK",
      label: "Công tắc vòng mẫu",
      detail: config.enabled ? "Đang bật." : "Đang tắt — không lập lô mới. Job còn cần CREATIVE_LOOP_EVERY_MINUTES trên máy chủ.",
    },
  ];
  const chan = checks.filter((c) => c.level === "BLOCK").length;

  return (
    <div className="space-y-4">
      <SectionCard
        title="Còn thiếu gì để vòng chạy thật"
        description={chan ? `${formatNumber(chan)} điều kiện đang chặn — vòng chưa đăng được mẫu nào.` : "Không còn điều kiện nào chặn ở phía ERP."}
        hint={
          <>
            Mọi lượt ghi Facebook của vòng mẫu đi qua MỘT cửa ghi và cùng chốt cứng với bàn tay quảng cáo. Khi cổng từ chối vì cấu hình thiếu, lý do in ra là: “
            {CREATIVE_WRITE_DENIAL_REASON.CONFIG_INCOMPLETE}”
          </>
        }
      >
        <ul className="divide-y">
          {checks.map((c) => {
            const Icon = ICON[c.level];
            return (
              <li key={c.label} className="flex items-start gap-2.5 py-2 text-[13px]">
                <Icon className={cn("mt-0.5 size-4 shrink-0", TONE[c.level])} aria-label={c.level} />
                <div className="min-w-0">
                  <p className="font-medium">{c.label}</p>
                  <p className="text-[12.5px] text-muted-foreground">{c.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard title="Cấu hình" description="Trần cứng nằm trong mã nguồn; ở đây chỉ làm hẹp được.">
        <ConfigForm config={config} products={products} canManage={canManage} />
      </SectionCard>
    </div>
  );
}
