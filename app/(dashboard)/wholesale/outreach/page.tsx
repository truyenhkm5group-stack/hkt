import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import Link from "next/link";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { outreachQueue } from "@/lib/queries/wholesale";
import { contactPlansFor } from "@/lib/wholesale/contact-plan-store";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { OUTREACH_AUTOMATION_LABEL } from "@/lib/wholesale/config";
import type { SearchParams } from "@/lib/search-params";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { OutreachBoard } from "@/app/(dashboard)/wholesale/outreach/outreach-board";
import { activityLog, outreachRunStats } from "@/lib/queries/wholesale-activity";
import { ActivityLog, ProgressCard, ResultTiles } from "@/app/(dashboard)/wholesale/run-widgets";
import { TemplatesPanel } from "@/app/(dashboard)/wholesale/templates-panel";

export const metadata = { title: "Hàng đợi liên hệ sỉ" };

export default async function WholesaleOutreachPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:work");
  if (decision.allow === "NONE") return <ScopeDenied title="Hàng đợi liên hệ sỉ" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const view = raw.view === "done" ? "done" : "open";
  const [rows, cfg, run, log] = await Promise.all([
    outreachQueue(decision, view === "done" ? ["DONE", "CANCELLED"] : ["DRAFT", "APPROVED", "SENT"]),
    getLeadHunterConfig(),
    outreachRunStats(decision),
    activityLog(decision, ["ZALO", "ZALO_OPENED", "CALL", "CALL_INITIATED", "OUTREACH"], 30),
  ]);
  const isConfig = can(user, "wholesale:config");
  const plans = Object.fromEntries(await contactPlansFor(rows.map((r) => r.leadId)));
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Hàng đợi liên hệ sỉ"
        description="Hai luồng: khách NƯỚC NGOÀI đi email, khách TRONG NƯỚC nhắn Zalo — chuyển sang email chỉ khi Zalo không gửi được. Duyệt → mở kênh và gửi bằng tay (email: đưa vào Hộp thư đi, vẫn chạy thử) → ghi kết quả. ERP không tự gửi tin hàng loạt."
      />
      <WholesaleNav user={user} active="outreach" />
      <ProgressCard title="Liên hệ hôm nay" p={run} unit="tin" note="đã gửi + sai số + đã huỷ / cả lời chào còn chờ duyệt · chờ gửi" />
      <ResultTiles
        ok={{ label: "Đã gửi", value: run.success, of: run.processed }}
        fail={{ label: "Sai số / không gửi được", value: run.failed, of: run.processed }}
        skip={{ label: "Đã huỷ", value: run.skipped, of: run.processed }}
      />
      {/* CÀI ĐẶT GỬI — một hàng, đọc đúng cấu hình đang có. Zalo không có hạn mức máy: người bấm mở từng khách. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs">
        <span>
          <b>Cài đặt gửi:</b> {OUTREACH_AUTOMATION_LABEL[cfg.outreach.automationLevel]}
        </span>
        <span>AI soạn lời chào: {cfg.outreach.useAi ? "bật" : "tắt"}</span>
        <span>Zalo: nhân viên bấm mở từng khách — ERP không tự gửi, không nhắn hàng loạt từ nick cá nhân</span>
        {isConfig ? (
          <Link href="/wholesale/settings" className="ml-auto underline">
            Sửa ở Cấu hình
          </Link>
        ) : null}
      </div>
      <div className="flex gap-3 text-sm">
        <a href="/wholesale/outreach" className={view === "open" ? "font-semibold" : "text-muted-foreground hover:underline"}>
          Đang chờ ({view === "open" ? rows.length : "…"})
        </a>
        <a href="/wholesale/outreach?view=done" className={view === "done" ? "font-semibold" : "text-muted-foreground hover:underline"}>
          Đã xong / đã huỷ
        </a>
      </div>
      {rows.length ? (
        <OutreachBoard rows={rows} plans={plans} readOnly={view === "done" || !can(user, "wholesale:work")} callScript={cfg.outreach.callScript.replace(/\{\{\s*ten_shop\s*\}\}/g, cfg.outreach.shopName)} />
      ) : (
        <EmptyState title={view === "done" ? "Chưa có liên hệ nào hoàn tất" : "Không có lời chào nào đang chờ"} description="Mở danh sách «Khách sỉ tiềm năng», chọn lead hạng A/B rồi bấm «Xếp hàng liên hệ»." />
      )}
      <SectionCard title="Mẫu nội dung" description="Câu mở Zalo, lời chào và các mẫu sao chép nhanh khi nhắn / gửi thư tay.">
        <TemplatesPanel zaloTemplate={cfg.outreach.zaloTemplate} openerTemplate={cfg.outreach.openerTemplate} extraTemplates={cfg.outreach.extraTemplates} canEdit={isConfig} />
      </SectionCard>
      <SectionCard title="Nhật ký hoạt động" description="Nhắn Zalo, gọi điện, lời chào — mới nhất trên cùng. SĐT và email đã che.">
        <ActivityLog rows={log} empty="Chưa có hoạt động liên hệ nào." />
      </SectionCard>
    </div>
  );
}
