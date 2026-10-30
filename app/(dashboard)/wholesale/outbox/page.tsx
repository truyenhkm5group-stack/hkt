import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { campaignOptions, emailOutreachCandidates, listOutbox, OUTBOX_VIEW_LABEL, OUTBOX_VIEWS, outboxCounts, type OutboxView } from "@/lib/queries/wholesale-email-outbox";
import type { SearchParams } from "@/lib/search-params";
import { EMAIL_MODE_LABEL, LIVE_EMAIL_ADAPTERS, senderIdentityMissing } from "@/lib/wholesale/email-constants";
import { previewEmailPolicies } from "@/lib/wholesale/email-outbox";
import { getEmailSettings } from "@/lib/wholesale/email-outbox-store";
import { cn } from "@/lib/utils";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { EmailCandidates, OutboxBoard } from "@/app/(dashboard)/wholesale/outbox/outbox-board";
import { EmailSettingsPanel } from "@/app/(dashboard)/wholesale/outbox/email-settings-panel";
import { EmailCountriesPanel } from "@/app/(dashboard)/wholesale/outbox/email-countries-panel";
import { EMAIL_COUNTRY_CHOICES } from "@/lib/wholesale/email-countries";

export const metadata = { title: "Hộp thư đi sỉ" };

const MODE_TONE = {
  OFF: "border-slate-300 bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200",
  DRY_RUN: "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  LIVE: "border-rose-400 bg-rose-50 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
} as const;

/**
 * HỘP THƯ ĐI BÁN SỈ (E1 · docs/verticals/wholesale-lead-hunter.md §4e). Thư email tới lead: soạn từ lời chào kênh EMAIL của hàng
 * đợi liên hệ → người duyệt → xếp gửi → job gửi qua cổng chính sách. Hôm nay chỉ CHẠY THỬ (chưa có nhà cung cấp email). Phạm vi
 * dữ liệu theo lead; quyền `wholesale:work` (soạn / duyệt từng thư), `wholesale:config` (chế độ, mở nút dừng, duyệt hàng loạt).
 */
export default async function WholesaleOutboxPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:work");
  if (decision.allow === "NONE") return <ScopeDenied title="Hộp thư đi sỉ" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const view: OutboxView = (OUTBOX_VIEWS as readonly string[]).includes(String(raw.view)) ? (raw.view as OutboxView) : "open";
  const [settings, rows, counts, candidates, campaigns] = await Promise.all([
    getEmailSettings(),
    listOutbox(decision, view),
    outboxCounts(decision),
    view === "open" ? emailOutreachCandidates(decision) : Promise.resolve([]),
    campaignOptions(),
  ]);
  const unavailable = "unavailable" in rows;
  const list = unavailable ? [] : rows;
  const previews = view === "open" && !unavailable ? await previewEmailPolicies(list.filter((r) => r.status === "DRAFT" || r.status === "APPROVED" || r.status === "QUEUED").map((r) => r.id)) : {};
  const missing = senderIdentityMissing(settings.sender);
  const isConfig = can(user, "wholesale:config");

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Hộp thư đi sỉ"
        description="Thư email tới khách sỉ: soạn từ lời chào kênh Email → người duyệt TỪNG thư → xếp gửi → máy gửi qua cổng chính sách (đồng ý · danh sách chặn · nút dừng · hạn mức). AI không bao giờ tự gửi."
        hint="Chưa có nhà cung cấp email (SES / Resend / Gmail) và tên miền gửi — chủ shop chọn. Trong lúc chờ, «Chạy thử» đi hết đường ống mà KHÔNG thư nào ra ngoài, và không đổi trạng thái liên hệ của lead."
      />
      <WholesaleNav user={user} active="outbox" />

      <div className={cn("rounded-lg border px-3 py-2 text-sm", MODE_TONE[settings.mode])} role="status">
        <b>Chế độ: {EMAIL_MODE_LABEL[settings.mode]}.</b>{" "}
        {settings.mode === "OFF" ? "Thư xếp gửi nằm chờ, không lượt nào chạy." : settings.mode === "DRY_RUN" ? "Thư «đã gửi» ở chế độ này mang mã dryrun-…, không rời ERP." : LIVE_EMAIL_ADAPTERS.length ? "Thư ĐƯỢC GỬI THẬT tới khách." : "Chưa có nhà cung cấp — cổng chặn mọi thư."}
        {settings.paused ? <span className="ml-2 font-semibold text-rose-700 dark:text-rose-300">NÚT DỪNG KHẨN ĐANG BẬT{settings.pausedReason ? `: ${settings.pausedReason}` : ""}.</span> : null}
        {missing.length ? <span className="ml-2">Thiếu danh tính người gửi ({missing.join(", ")}) — thư sẽ nằm chờ.</span> : null}
      </div>

      {unavailable ? (
        <EmptyState title="CSDL chưa áp migration 0264" description="Hộp thư đi email cần bảng mới — báo người vận hành áp migration rồi tải lại trang." />
      ) : (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            {OUTBOX_VIEWS.map((v) => (
              <a key={v} href={v === "open" ? "/wholesale/outbox" : `/wholesale/outbox?view=${v}`} className={v === view ? "font-semibold" : "text-muted-foreground hover:underline"}>
                {OUTBOX_VIEW_LABEL[v]} ({counts ? counts[v] : "…"})
              </a>
            ))}
          </div>
          {view === "open" && candidates.length ? <EmailCandidates rows={candidates} /> : null}
          {list.length ? (
            <OutboxBoard rows={list} previews={previews} canBulk={isConfig} readOnly={view !== "open" && view !== "problem"} />
          ) : (
            <EmptyState title={view === "open" ? "Không có thư nào đang chờ" : "Chưa có thư nào ở mục này"} description="Soạn lời chào kênh «Email» cho lead ở hàng đợi liên hệ, rồi bấm «Đưa vào hộp thư đi»." />
          )}
          <SectionCard title="Cấu hình & nút dừng" description="Chế độ gửi, danh tính người gửi in ở chân thư, hạn mức, và nút dừng khẩn. Ai chăm lead cũng bấm DỪNG được; chỉ người cấu hình mở lại.">
            <EmailSettingsPanel settings={settings} campaigns={campaigns} canConfigure={isConfig} isOwner={user.role === "ADMIN"} liveAvailable={LIVE_EMAIL_ADAPTERS.length > 0} />
          </SectionCard>
          <SectionCard title="Nước đã rà luật thư chào hàng" description={`${settings.allowedCountries.length ? `Đã rà: ${settings.allowedCountries.join(", ")}.` : "Chưa nước nào — mọi thư chỉ chạy thử."} Nước chưa rà ⇒ gửi thật nằm chờ «chưa rà luật nước X».`}>
            <EmailCountriesPanel allowed={settings.allowedCountries} choices={EMAIL_COUNTRY_CHOICES} canEdit={isConfig && user.role === "ADMIN"} />
          </SectionCard>
        </>
      )}
    </div>
  );
}
