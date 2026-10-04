import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { apiUsageSummary, suppressionList } from "@/lib/queries/wholesale";
import { SEARCH_PROVINCES } from "@/lib/wholesale/areas";
import { PLACES_SKU_LABEL, type PlacesSku } from "@/lib/wholesale/config";
import { LEAD_PROVIDER_CATALOG } from "@/lib/wholesale/providers";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { ConfigForm } from "@/app/(dashboard)/wholesale/settings/config-form";
import { SuppressionTable } from "@/app/(dashboard)/wholesale/settings/suppression-table";

export const metadata = { title: "Cấu hình săn khách sỉ" };

export default async function WholesaleSettingsPage() {
  const user = await requirePermission("wholesale:config");
  const [cfg, usage, suppressions] = await Promise.all([getLeadHunterConfig(), apiUsageSummary(), suppressionList()]);
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Cấu hình & chi phí API"
        description="Trần chi tiêu, đơn giá Google, vùng phục vụ, ngưỡng hạng, lời chào — và danh sách KHÔNG LIÊN HỆ."
        hint="Khoá Google Places nằm ở Cài đặt → Kết nối (mã hoá trong CSDL của tổ chức, không bao giờ xuống trình duyệt). Chạm trần ngày / tháng ⇒ mọi chiến dịch tự tạm dừng và chủ shop nhận thông báo; trần ngày tự mở lại từ 0 giờ hôm sau."
      />
      <WholesaleNav user={user} active="settings" />

      <SectionCard title="Cấu hình">
        <ConfigForm initial={cfg} provinces={SEARCH_PROVINCES.map((p) => ({ key: p.key, label: p.label }))} />
      </SectionCard>

      <SectionCard title="Chi phí API tháng này theo loại lượt gọi" description="Ước tính theo đơn giá đã khai — hoá đơn Google Cloud mới là số thật (chưa trừ hạn mức miễn phí).">
        {usage.bySku.length ? (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="py-1 text-left font-medium">Loại</th>
                <th className="py-1 text-right font-medium">Lượt</th>
                <th className="py-1 text-right font-medium">Kết quả</th>
                <th className="py-1 text-right font-medium">Lead mới</th>
                <th className="py-1 text-right font-medium">TB ms</th>
                <th className="py-1 text-right font-medium">Chi phí (US$)</th>
              </tr>
            </thead>
            <tbody>
              {usage.bySku.map((r) => (
                <tr key={`${r.sku}-${r.method}`} className="border-b last:border-0">
                  <td className="py-1">{r.sku ? (PLACES_SKU_LABEL[r.sku as PlacesSku] ?? r.sku) : r.method}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(r.calls)}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(r.results)}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(r.newCount)}</td>
                  <td className="py-1 text-right tabular-nums">{formatNumber(r.avgMs)}</td>
                  <td className="py-1 text-right tabular-nums">{(r.micros / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 3 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="Chưa có lượt gọi nào tháng này" />
        )}
        {usage.byDay.length ? <p className="mt-2 text-xs text-muted-foreground">30 ngày: {usage.byDay.map((d) => `${d.day.slice(5)} ${formatNumber(d.calls)} lượt / ${(d.micros / 1e6).toFixed(2)}$`).join(" · ")}</p> : null}
      </SectionCard>

      <SectionCard title="Lỗi API gần đây">
        {usage.errors.length ? (
          <ul className="space-y-1 text-xs">
            {usage.errors.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="text-muted-foreground">{formatDateTime(e.at)}</span> · {e.method} · HTTP {e.status ?? "—"} · {e.query ?? ""} — {e.error}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Không có lỗi trong 30 ngày.</p>
        )}
      </SectionCard>

      <SectionCard title="Danh sách không liên hệ" description="Khách từ chối liên hệ ⇒ SĐT, tên miền, địa điểm vào đây; không chiến dịch / hàng đợi nào đưa lại. Gỡ cần lý do và ghi nhật ký.">
        <SuppressionTable rows={suppressions.map((s) => ({ id: s.id, kind: s.kind, value: s.value, reason: s.reason, by: s.createdByName, at: s.createdAt.toISOString(), leadId: s.leadId }))} />
      </SectionCard>

      <SectionCard title="Nguồn lead & tuân thủ">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {LEAD_PROVIDER_CATALOG.map((p) => (
            <li key={p.key}>
              <b>{p.label}</b> — {p.role === "DISCOVERY" ? "tìm doanh nghiệp" : p.role === "ENRICHMENT" ? "bổ sung liên hệ" : "nhập tay"}
              {p.billable ? " · tính tiền theo lượt" : " · miễn phí"}
              {p.googleSourced ? ` · dữ liệu Google: lưu tối đa ${cfg.googleRetentionDays} ngày rồi tự xoá (giữ Place ID), lead đang chăm được làm mới trước hạn` : " · dữ liệu của tổ chức"}
            </li>
          ))}
          <li>Xuất CSV chỉ gồm dữ liệu của tổ chức + Place ID + link Google Maps — không xuất nội dung Google.</li>
          <li>Đọc website: chỉ trang công khai, tôn trọng robots.txt, không đăng nhập / vượt captcha, lưu URL nguồn của từng phát hiện.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
