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
import { AiDraftSettings, AiDraftsPanel } from "@/app/(dashboard)/wholesale/outbox/ai-drafts-panel";
import { listAiDrafts } from "@/lib/queries/wholesale-email-ai-drafts";
import { emailEventLog, outboxRunStats } from "@/lib/queries/wholesale-activity";
import { ActivityLog, ProgressCard, ResultTiles } from "@/app/(dashboard)/wholesale/run-widgets";
import { TemplatesPanel } from "@/app/(dashboard)/wholesale/templates-panel";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { getEmailAiSettings } from "@/lib/wholesale/email-ai-draft";
import { SequencePanel, SequenceSettingsForm } from "@/app/(dashboard)/wholesale/outbox/sequence-panel";
import { loadSequenceBoard } from "@/lib/wholesale/email-sequence-core";

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
  const [settings, rows, counts, candidates, campaigns, aiDrafts, aiSettings, sequence, run, events, cfg] = await Promise.all([
    getEmailSettings(),
    listOutbox(decision, view),
    outboxCounts(decision),
    view === "open" ? emailOutreachCandidates(decision) : Promise.resolve([]),
    campaignOptions(),
    listAiDrafts(decision),
    getEmailAiSettings(),
    loadSequenceBoard(decision),
    outboxRunStats(decision),
    emailEventLog(decision, 30),
    getLeadHunterConfig(),
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

      {run ? (
        <>
          <ProgressCard title="Hộp thư đi hôm nay" p={run} unit="thư" note="đã xử lý (gửi · lỗi · chặn / giữ lại) / cả thư đã duyệt chờ gửi" />
          <ResultTiles
            ok={{ label: run.dryRun ? "Chạy thử (không rời ERP)" : "Đã gửi", value: run.success, of: run.processed }}
            fail={{ label: "Lỗi gửi", value: run.failed, of: run.processed }}
            skip={{ label: "Chặn / giữ lại", value: run.skipped, of: run.processed, hint: run.skippedReasons.map((x) => `${x.label} (${x.count})`).join(" · ") || undefined }}
          />
        </>
      ) : null}
      {/* CÀI ĐẶT GỬI — một hàng, đọc đúng cài đặt email đang có; sửa ở khung «Cấu hình & nút dừng» bên dưới. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs">
        <span>
          <b>Cài đặt gửi:</b> {EMAIL_MODE_LABEL[settings.mode]}
        </span>
        <span>Giới hạn: {settings.limits.perHour} thư / giờ · {settings.limits.perDay} thư / ngày · {settings.limits.perRecipientDomainPerDay} thư / tên miền / ngày</span>
        <span>Khung giờ gửi: chưa có trong cài đặt (máy gửi theo lượt 3 phút)</span>
        <span>Gửi thật: chỉ quản trị bật</span>
        <a href="#cai-dat-gui" className="ml-auto underline">
          Sửa cài đặt gửi
        </a>
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
          {view === "open" && !("unavailable" in sequence) ? (
            <SectionCard title="Lần nhắc đến hạn" description="Chuỗi thư theo dõi: thư nhắc khi khách chưa phản hồi sau số ngày đã khai. Dừng ngay khi khách trả lời, huỷ đăng ký, bounce cứng, bị chặn / không liên hệ, hoặc lead đã Thắng / Mất. Chỉ soạn NHÁP — không tự gửi.">
              <SequencePanel due={sequence.due} waiting={sequence.waiting} stopped={sequence.stopped} configured={sequence.configured} settings={sequence.settings} />
            </SectionCard>
          ) : null}
          {view === "open" ? (
            <SectionCard
              title="Nháp AI (chưa ở hộp thư đi)"
              description={`AI soạn từ dữ kiện thật (hồ sơ lead · bảng giá sỉ đang áp · báo giá đã gửi · lời khai của shop). Máy chặn số tiền lệch bảng giá, khẳng định chứng nhận / xuất khẩu / tồn / thời gian giao không có nguồn, và sai ngôn ngữ. Người sửa rồi mới đưa vào hộp thư đi. AI soạn email: ${aiSettings.enabled ? `BẬT (trần ${aiSettings.dailyMaxDrafts} nháp · ${aiSettings.dailyCostCapUsd} USD / ngày)` : "TẮT"}.`}
            >
              {"unavailable" in aiDrafts ? <p className="text-sm text-muted-foreground">CSDL chưa áp migration 0265 (nháp email AI).</p> : <AiDraftsPanel rows={aiDrafts.rows} stats={aiDrafts.stats} />}
            </SectionCard>
          ) : null}
          {list.length ? (
            <OutboxBoard rows={list} previews={previews} canBulk={isConfig} readOnly={view !== "open" && view !== "problem"} />
          ) : (
            <EmptyState title={view === "open" ? "Không có thư nào đang chờ" : "Chưa có thư nào ở mục này"} description="Soạn lời chào kênh «Email» cho lead ở hàng đợi liên hệ, rồi bấm «Đưa vào hộp thư đi»." />
          )}
          <SectionCard title="Mẫu nội dung" description="Câu mở Zalo, lời chào và các mẫu sao chép nhanh khi soạn thư tay. Thư nhắc của chuỗi theo dõi soạn từ cấu hình chuỗi bên dưới.">
            <TemplatesPanel zaloTemplate={cfg.outreach.zaloTemplate} openerTemplate={cfg.outreach.openerTemplate} extraTemplates={cfg.outreach.extraTemplates} canEdit={isConfig} />
          </SectionCard>
          <SectionCard title="Nhật ký hoạt động" description="Sự kiện thư (xếp gửi · đã gửi / chạy thử · chặn · trả về · trả lời) — mới nhất trên cùng. Email người nhận đã che.">
            <ActivityLog rows={events} empty="Chưa có sự kiện thư nào." />
          </SectionCard>
          <SectionCard id="cai-dat-gui" title="Cấu hình & nút dừng" description="Chế độ gửi, danh tính người gửi in ở chân thư, hạn mức, và nút dừng khẩn. Ai chăm lead cũng bấm DỪNG được; chỉ người cấu hình mở lại.">
            <EmailSettingsPanel settings={settings} campaigns={campaigns} canConfigure={isConfig} isOwner={user.role === "ADMIN"} liveAvailable={LIVE_EMAIL_ADAPTERS.length > 0} />
            {isConfig ? (
              <div className="mt-4 border-t pt-3">
                <div className="mb-2 text-sm font-semibold">AI soạn email (mặc định TẮT — bật phải khai trần nháp và chi phí / ngày)</div>
                <AiDraftSettings settings={aiSettings} />
              </div>
            ) : null}
            {isConfig && !("unavailable" in sequence) ? (
              <div className="mt-4 border-t pt-3">
                <div className="mb-2 text-sm font-semibold">Chuỗi thư nhắc (không có số mặc định — trống = không nhắc)</div>
                <SequenceSettingsForm settings={sequence.settings} />
              </div>
            ) : null}
          </SectionCard>
          <SectionCard title="Nước đã rà luật thư chào hàng" description={`${settings.allowedCountries.length ? `Đã rà: ${settings.allowedCountries.join(", ")}.` : "Chưa nước nào — mọi thư chỉ chạy thử."} Nước chưa rà ⇒ gửi thật nằm chờ «chưa rà luật nước X».`}>
            <EmailCountriesPanel allowed={settings.allowedCountries} choices={EMAIL_COUNTRY_CHOICES} canEdit={isConfig && user.role === "ADMIN"} />
          </SectionCard>
        </>
      )}
    </div>
  );
}
