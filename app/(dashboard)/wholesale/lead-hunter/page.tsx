import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-tile";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { formatDate, formatNumber } from "@/lib/format";
import { apiUsageSummary, campaignProgressList, coverageByProvince } from "@/lib/queries/wholesale";
import { SEARCH_PROVINCES } from "@/lib/wholesale/areas";
import { ensureTemplateCampaign, hslcTemplateValues } from "@/lib/wholesale/campaigns";
import { DEFAULT_KEYWORD_GROUPS, microsToVnd } from "@/lib/wholesale/config";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { AutoRefresh } from "@/app/(dashboard)/wholesale/lead-hunter/auto-refresh";
import { CampaignForm } from "@/app/(dashboard)/wholesale/lead-hunter/campaign-form";
import { CampaignCard } from "@/app/(dashboard)/wholesale/lead-hunter/campaign-card";
import { CoverageTable } from "@/app/(dashboard)/wholesale/lead-hunter/coverage-table";
import { ImportForm } from "@/app/(dashboard)/wholesale/lead-hunter/import-form";

export const metadata = { title: "Săn khách sỉ" };

function usd(micros: number): string {
  return `${(micros / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} US$`;
}

export default async function LeadHunterPage() {
  const user = await requirePermission("wholesale:scan");
  // Dựng mẫu HSLC nếu chưa có (idempotent). CSDL chỉ đọc / lỗi ghi không được làm hỏng trang.
  await ensureTemplateCampaign().catch(() => undefined);
  const cfg = await getLeadHunterConfig();
  const [campaigns, coverage, usage, conn] = await Promise.all([campaignProgressList(), coverageByProvince(cfg), apiUsageSummary(), openActiveConnection("google-places")]);
  const running = campaigns.some((c) => c.status === "RUNNING");
  const template = hslcTemplateValues();
  const vnd = (m: number) => {
    const v = microsToVnd(m, cfg.usdToVnd);
    return v == null ? "—" : `≈ ${formatNumber(v)} ₫`;
  };
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Săn khách sỉ — chiến dịch quét"
        description="Tìm nhà hàng / quán / khách sạn / cửa hàng thực phẩm trên Google Places theo từ khoá × tỉnh × khu vực. Quét chạy nền, tự dừng khi chạm trần chi phí; lead mới chỉ vào hàng đợi khi người duyệt."
        hint="Quy trình: Tìm (Text Search, trường gọn) → khử trùng Place ID → lọc đóng cửa / sai nhóm / từ khoá loại trừ → lấy SĐT & website (Place Details) chỉ cho địa điểm qua lọc → chấm điểm → «Đủ điều kiện» → hàng đợi liên hệ."
        actions={<AutoRefresh active={running} seconds={10} />}
      />
      <WholesaleNav user={user} active="hunter" />

      {!conn.ok ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <b>Chưa bật kết nối Google Places.</b> {conn.reason} — vào <Link className="underline" href="/settings/connections">Cài đặt → Kết nối</Link>, mục «Google Places (tìm doanh nghiệp)», dán khoá API, bấm Kiểm tra rồi Bật. Chưa có kết nối thì chiến dịch bắt đầu được nhưng sẽ tự tạm dừng ở lượt quét đầu tiên. Nhập tệp CSV vẫn dùng được.
        </div>
      ) : null}

      <StatStrip
        columns={5}
        items={[
          { label: "Chi phí API hôm nay", value: usd(usage.todayMicros), note: `${vnd(usage.todayMicros)} · trần ${cfg.budget.dailyUsd} US$`, tone: usage.todayMicros >= cfg.budget.dailyUsd * 1e6 ? "rose" : "default" },
          { label: "Chi phí tháng này", value: usd(usage.monthMicros), note: `trần ${cfg.budget.monthlyUsd} US$`, tone: usage.monthMicros >= cfg.budget.monthlyUsd * 1e6 ? "rose" : "default" },
          { label: "Lượt gọi Google hôm nay", value: formatNumber(usage.callsToday), note: `trần ${formatNumber(cfg.budget.dailyRequestLimit)} lượt` },
          { label: "Lỗi API hôm nay", value: formatNumber(usage.errorsToday), tone: usage.errorsToday ? "amber" : "default" },
          { label: "Chiến dịch đang quét", value: formatNumber(campaigns.filter((c) => c.status === "RUNNING").length), href: "/wholesale/settings" },
        ]}
      />

      <SectionCard title="Chiến dịch" description="Mẫu «HSLC – Wholesale F&B Prospects» KHÔNG tự chạy — bấm «Dùng mẫu» để tạo bản nháp, xem trước rồi mới «Bắt đầu quét».">
        <div className="grid gap-3 lg:grid-cols-2">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} c={c} usdToVnd={cfg.usdToVnd} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Tạo chiến dịch mới" description="Bấm «Xem trước truy vấn» để thấy số truy vấn, truy vấn mẫu và chi phí ước tính trước khi lưu.">
        <CampaignForm
          provinces={SEARCH_PROVINCES.map((p) => ({ key: p.key, label: p.label, areas: p.areas.map((a) => ({ code: a.code, name: a.name })) }))}
          keywordGroups={DEFAULT_KEYWORD_GROUPS.map((g) => ({ key: g.key, label: g.label, keywords: [...g.keywords], enabled: g.enabled }))}
          defaults={{ name: `${template.name} · ${formatDate(new Date())}`, productFocus: template.productFocus, excludeKeywords: template.excludeKeywords.join(", "), targetSegments: [...template.targetSegments], maxLeads: template.maxLeads, discoveryTier: cfg.discoveryTier }}
        />
      </SectionCard>

      <SectionCard title="Độ phủ theo tỉnh / khu vực" description={`Tỉ lệ ô (từ khoá × khu vực) đã quét trong ${cfg.cellFreshDays} ngày gần nhất, trên bộ ${coverage.keywordCount} từ khoá mặc định. Ô còn mới không bị quét lại.`}>
        <CoverageTable provinces={coverage.provinces} />
      </SectionCard>

      <SectionCard title="Nhập lead từ tệp CSV" description="Danh bạ tự có, hội chợ, đối tác giới thiệu. Cột: Tên, SĐT, Địa chỉ, Tỉnh, Khu vực, Website, Email, Loại hình, Ghi chú (chỉ cột Tên là bắt buộc). Trùng SĐT / website / tên + địa chỉ với lead đã có ⇒ bỏ qua.">
        <ImportForm />
      </SectionCard>
    </div>
  );
}
