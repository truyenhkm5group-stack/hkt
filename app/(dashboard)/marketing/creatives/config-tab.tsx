import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ConfigForm } from "@/app/(dashboard)/marketing/creatives/config-form";
import { SectionCard } from "@/components/ui-bits";
import { CREATIVE_WRITE_DENIAL_REASON } from "@/lib/constants/creative-loop";
import { formatDateTime, formatNumber } from "@/lib/format";
import { AdsKillSwitchCard } from "@/app/(dashboard)/marketing/creatives/kill-switch";
import { ADS_KILL_SOURCE_LABEL } from "@/lib/constants/ads-kill-switch";
import { adsWriteDisabledReason, readAdsKillSwitch } from "@/lib/integrations/facebook/ads-write";
import { creativeSourceCounts, listCreativeProductOptions, readCreativeConfig } from "@/lib/queries/creative-sources";
import { cn } from "@/lib/utils";

/**
 * `OK` · `BLOCK` (thiếu thì vòng KHÔNG đăng được) · `WARN` (chạy được nhưng máy sẽ không tự làm một
 * việc người ta có thể tưởng nó làm) · `UNKNOWN` (ERP không tự đo được — nói thẳng, không tô xanh).
 */
type Level = "OK" | "BLOCK" | "WARN" | "UNKNOWN";
type Check = { level: Level; label: string; detail: ReactNode };

const ICON: Record<Level, typeof CheckCircle2> = { OK: CheckCircle2, BLOCK: XCircle, WARN: CircleAlert, UNKNOWN: CircleHelp };
const TONE: Record<Level, string> = { OK: "text-success", BLOCK: "text-destructive", WARN: "text-warning", UNKNOWN: "text-muted-foreground" };

export async function ConfigTab({ canManage, canKill }: { canManage: boolean; canKill: boolean }) {
  const [state, counts, products, kill] = await Promise.all([readCreativeConfig(), creativeSourceCounts(), listCreativeProductOptions(), readAdsKillSwitch()]);
  const { config, problems } = state;
  const writeReason = adsWriteDisabledReason();
  const thieu = problems.filter((p) => p.field !== "rules");
  const luatHong = problems.filter((p) => p.field === "rules");

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
      level: kill.killed ? "BLOCK" : "OK",
      label: "Công tắc tắt khẩn cấp (settings ads.write.kill)",
      detail: kill.killed ? `${ADS_KILL_SOURCE_LABEL[kill.source]}. ${kill.reason ?? ""}` : `${ADS_KILL_SOURCE_LABEL[kill.source]} — đường ghi đi theo chốt env và phiếu duyệt.`,
    },
    {
      level: "UNKNOWN",
      label: "Token có quyền ads_management + tạo quảng cáo cho fanpage",
      detail: "ERP chưa tự kiểm được quyền của token — lượt đăng đầu tiên sẽ trả lời. Lúc dựng vòng mẫu (24/09/2026) token của shop mới có ads_read — xem docs/creative-loop.md §7.",
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
      level: config.enabled ? "OK" : "BLOCK",
      label: "Công tắc vòng mẫu",
      detail: config.enabled ? "Đang bật." : "Đang tắt — không lập lô mới. Job còn cần CREATIVE_LOOP_EVERY_MINUTES trên máy chủ.",
    },
  ];
  const chan = checks.filter((c) => c.level === "BLOCK").length;

  return (
    <div className="space-y-4">
      <AdsKillSwitchCard state={kill} canEngage={canKill} canRelease={canManage} />
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
