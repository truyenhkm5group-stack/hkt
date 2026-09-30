import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { AD_BOT_SOURCE_LABEL, AD_BOT_STATE_LABEL, AD_BOT_WINDOW_DAYS, type AdBotLine } from "@/lib/constants/chatbot-ad-bots";
import { SCALE_DRAFT_STATUS_LABEL, VARIANT_STATUS_LABEL, type ScaleDraftStatus, type VariantStatus } from "@/lib/constants/creative-loop";
import { formatDateTime, formatNumber } from "@/lib/format";
import { getBotAdStatus, loadAdBotLines } from "@/lib/integrations/chatbot/ad-bots";
import { AdBotEditor, AdBotsGlobalControls } from "@/app/(dashboard)/chatbot/ad-bots/ad-bot-controls";

export const metadata = { title: "Bot riêng theo quảng cáo" };
export const dynamic = "force-dynamic";

const VIDEO_STATUS_LABEL: Record<string, string> = { ACTIVE: "Đang chạy", PAUSED: "Đã tắt", STOPPED: "Đã dừng" };

function statusLabel(l: AdBotLine): string {
  if (l.source === "CREATIVE_TEST") return VARIANT_STATUS_LABEL[l.status as VariantStatus] ?? l.status;
  if (l.source === "CREATIVE_SCALE") return SCALE_DRAFT_STATUS_LABEL[l.status as ScaleDraftStatus] ?? l.status;
  return VIDEO_STATUS_LABEL[l.status] ?? l.status;
}

const RUNNING = new Set(["LIVE", "ACTIVE"]);

/**
 * Bot chat riêng cho từng camp test: khách bấm quảng cáo nào thì bot tư vấn đúng mẫu của quảng cáo đó, theo
 * hướng dẫn riêng của camp. Danh sách đọc từ Thư viện Media / scale / video (không gõ lại); người chỉ bật-tắt,
 * gắn mã cho quảng cáo chưa gắn và viết hướng dẫn. Luật: `lib/constants/chatbot-ad-bots.ts`.
 */
export default async function ChatbotAdBotsPage() {
  await requirePermission("cs:config");
  const [{ lines, config }, bot] = await Promise.all([loadAdBotLines(), getBotAdStatus()]);
  const seen = bot.reachable ? bot.seen : {};
  const known = new Set(lines.map((l) => l.adId));
  const unknownSeen = Object.entries(seen)
    .filter(([adId, s]) => !s.matched && !known.has(adId))
    .sort((a, b) => String(b[1].lastAt).localeCompare(String(a[1].lastAt)));
  const active = lines.filter((l) => l.state === "ACTIVE").length;
  const noProduct = lines.filter((l) => l.state === "NO_PRODUCT").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Bán hàng · bot chat"
        title="Bot riêng theo quảng cáo"
        description="Khách bấm quảng cáo test nào thì bot tư vấn đúng mẫu của quảng cáo đó, theo hướng dẫn riêng của camp. Giá vẫn lấy từ bảng giá của bot."
        hint={`Danh sách tự đọc từ Thư viện Media (camp test, scale) và quảng cáo video — camp còn chạy, hoặc dừng trong ${AD_BOT_WINDOW_DAYS} ngày. Camp mới tự có bot riêng sau lượt đồng bộ kế tiếp; bấm "Gửi lại sang bot" để gửi ngay.`}
        actions={<AdBotsGlobalControls enabled={config.enabled} />}
      />

      <SectionCard title="Tình trạng">
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          <li>
            Quảng cáo trong danh sách: <b>{formatNumber(lines.length)}</b> · có bot riêng: <b>{formatNumber(active)}</b>
            {noProduct ? (
              <>
                {" "}
                · <span className="text-amber-600">chưa gắn mã: {formatNumber(noProduct)}</span>
              </>
            ) : null}
          </li>
          <li>
            {bot.reachable ? (
              <>
                Bot chat đang giữ <b>{formatNumber(bot.count)}</b> bot riêng · gửi lần cuối {bot.syncedAt ? formatDateTime(bot.syncedAt) : "chưa từng"}
              </>
            ) : (
              <span className="text-destructive">Không đọc được bot chat: {bot.error}</span>
            )}
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Chat thử: mở{" "}
          <Link href="/chatbot" className="underline">
            Bot chat bán hàng
          </Link>{" "}
          → chọn page → tab Chat thử → chọn quảng cáo ở ô &quot;Giả lập khách bấm quảng cáo&quot;.
        </p>
      </SectionCard>

      {unknownSeen.length ? (
        <SectionCard title="Khách đến từ quảng cáo chưa có trong danh sách" description="Bot đã gặp các ID quảng cáo này nhưng ERP không biết chúng thuộc camp test nào (quảng cáo tạo tay ngoài Thư viện Media, hoặc camp cũ). Bot trả lời như bình thường.">
          <ul className="space-y-1 text-sm">
            {unknownSeen.slice(0, 30).map(([adId, s]) => (
              <li key={adId} className="font-mono text-xs">
                {adId} · {formatNumber(s.count)} lượt · lần cuối {s.lastAt ? formatDateTime(s.lastAt) : "—"}
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {lines.length === 0 ? (
        <EmptyState title="Chưa có quảng cáo test nào" description="Khi Thư viện Media đăng camp test lên Facebook, quảng cáo sẽ hiện ở đây kèm bot riêng." />
      ) : (
        <div className="space-y-3">
          {lines.map((l) => {
            const s = seen[l.adId];
            return (
              <SectionCard
                key={l.adId}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="break-all">{l.campaignName || l.adName || l.adId}</span>
                    <Badge variant={l.state === "ACTIVE" ? "default" : "outline"}>{AD_BOT_STATE_LABEL[l.state]}</Badge>
                  </span>
                }
                description={
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                    <span>{AD_BOT_SOURCE_LABEL[l.source]}</span>
                    <span className={RUNNING.has(l.status) ? "text-emerald-600" : undefined}>{statusLabel(l)}</span>
                    <span className="font-mono">ID QC {l.adId}</span>
                    <span>{l.effectiveCode ? `Mẫu ${l.effectiveCode}${l.productName && l.effectiveCode === (l.productCode ?? "").toUpperCase() ? ` · ${l.productName}` : ""}` : "Chưa gắn mã mẫu"}</span>
                    <span>{l.publishedAt ? `Lên từ ${formatDateTime(l.publishedAt)}` : ""}</span>
                    <span>{s ? `Bot đã gặp ${formatNumber(s.count)} lượt khách` : bot.reachable ? "Bot chưa gặp khách nào từ quảng cáo này" : ""}</span>
                  </span>
                }
              >
                {l.adCopy ? <p className="mb-3 line-clamp-2 text-xs text-muted-foreground">Nội dung QC: {l.adCopy}</p> : null}
                {l.override?.test ? (
                  <p className="text-sm">
                    Mẫu test mới <b>{l.override.test.name || "—"}</b> ({l.override.test.code || "chưa có mã tạm"}) · {l.override.test.colors.length} màu. Sửa ảnh, giá, chất vải và bật / tắt ở nút <b>Chat test</b> của camp trong{" "}
                    <Link href="/marketing/creatives" className="underline">
                      Thư viện Media · tab Đang chạy
                    </Link>
                    .
                  </p>
                ) : (
                  <AdBotEditor adId={l.adId} enabled={l.override?.enabled !== false} productCode={l.override?.productCode ?? ""} defaultCode={l.productCode ?? ""} instructions={l.override?.instructions ?? ""} />
                )}
                {l.override ? <p className="mt-2 text-xs text-muted-foreground">Sửa lần cuối: {l.override.updatedByName} · {formatDateTime(l.override.updatedAt)}</p> : null}
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
