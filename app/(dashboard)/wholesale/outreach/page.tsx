import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { EmptyState } from "@/components/ui-bits";
import { requireResource } from "@/lib/auth/scope-guard";
import { can } from "@/lib/auth/session";
import { outreachQueue } from "@/lib/queries/wholesale";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { OUTREACH_AUTOMATION_LABEL } from "@/lib/wholesale/config";
import type { SearchParams } from "@/lib/search-params";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { OutreachBoard } from "@/app/(dashboard)/wholesale/outreach/outreach-board";

export const metadata = { title: "Hàng đợi liên hệ sỉ" };

export default async function WholesaleOutreachPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:work");
  if (decision.allow === "NONE") return <ScopeDenied title="Hàng đợi liên hệ sỉ" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const view = raw.view === "done" ? "done" : "open";
  const [rows, cfg] = await Promise.all([outreachQueue(decision, view === "done" ? ["DONE", "CANCELLED"] : ["DRAFT", "APPROVED", "SENT"]), getLeadHunterConfig()]);
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Hàng đợi liên hệ sỉ"
        description="Lời chào đã soạn chờ người duyệt → mở kênh (gọi / Zalo / SMS / email) và gửi bằng tay → bấm «Đã gửi» → ghi kết quả. ERP không tự gửi tin hàng loạt."
        hint={`Mức tự động hoá hiện tại: ${OUTREACH_AUTOMATION_LABEL[cfg.outreach.automationLevel]}. Đổi ở «Cấu hình & chi phí API».`}
      />
      <WholesaleNav user={user} active="outreach" />
      <div className="flex gap-3 text-sm">
        <a href="/wholesale/outreach" className={view === "open" ? "font-semibold" : "text-muted-foreground hover:underline"}>
          Đang chờ ({view === "open" ? rows.length : "…"})
        </a>
        <a href="/wholesale/outreach?view=done" className={view === "done" ? "font-semibold" : "text-muted-foreground hover:underline"}>
          Đã xong / đã huỷ
        </a>
      </div>
      {rows.length ? (
        <OutreachBoard rows={rows} readOnly={view === "done" || !can(user, "wholesale:work")} callScript={cfg.outreach.callScript.replace(/\{\{\s*ten_shop\s*\}\}/g, cfg.outreach.shopName)} />
      ) : (
        <EmptyState title={view === "done" ? "Chưa có liên hệ nào hoàn tất" : "Không có lời chào nào đang chờ"} description="Mở danh sách «Khách sỉ tiềm năng», chọn lead hạng A/B rồi bấm «Xếp hàng liên hệ»." />
      )}
    </div>
  );
}
