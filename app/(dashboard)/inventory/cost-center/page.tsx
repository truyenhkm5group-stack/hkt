import { Calculator, CircleDashed, Layers, Tag } from "lucide-react";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { NavLink } from "@/components/nav-progress";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { can, requirePermission } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { formatNumber } from "@/lib/format";
import { getCostCenter } from "@/lib/queries/cost-center";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { CostCenterTable } from "./cost-center-table";

export const metadata = { title: "Trung tâm giá vốn" };

/**
 * ═══════════ TRUNG TÂM GIÁ VỐN ═══════════
 *
 * MỘT nơi đặt GIÁ VỐN KẾ HOẠCH (chủ shop chốt 13/10/2026, `docs/cost-center.md`). Mọi con số khác trên
 * trang là lời khai CHỈ ĐỌC của nguồn của nó; cột "đang áp dụng" là chính con số BCLN in ở hai chế độ
 * trong kỳ đang chọn, nên trang này và Báo cáo lợi nhuận không thể nói hai giá khác nhau.
 */
export default async function CostCenterPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("reports:nominal");
  const { decision } = await requireResource("REPORTS", "reports:nominal");
  // Giá vốn là số tổng hợp toàn shop — phạm vi hẹp phải TỪ CHỐI, như Báo cáo lợi nhuận.
  if (decision.allow === "NONE") return <ScopeDenied title="Trung tâm giá vốn" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const period = resolvePeriod(raw, "30d");
  const rows = await getCostCenter(period);
  const canWrite = can(user, "reports:assumptions");

  const coKeHoach = rows.filter((r) => r.planned).length;
  const dangBanChuaKeHoach = rows.filter((r) => !r.planned && (r.appliedActual?.qty ?? 0) > 0).length;
  const chiGiaBao = rows.filter((r) => !r.planned && r.marketerPrice !== null).length;
  const chuaBiet = rows.filter((r) => r.appliedActual?.basis === "UNKNOWN").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Trung tâm giá vốn"
        hint={
          <>
            <b>Nơi DUY NHẤT đặt giá vốn kế hoạch.</b> Nút bút trên Báo cáo lợi nhuận và nút &ldquo;Dùng làm giá ước tính&rdquo; của bảng giá thành ghi vào cùng một chỗ.
            Mỗi lần sửa là một dòng lịch sử có ngày hiệu lực, người sửa và lý do — không dòng nào bị xoá.
            <br />
            <br />
            <b>Giá thực tế</b> chỉ đến từ chứng từ: phiếu nhập kho (đơn giá trên phiếu). Giá SX xưởng và giá báo MKT là tham chiếu — không tự thành giá vốn.
            Phiếu nhập không bao giờ ghi đè giá kế hoạch, và giá kế hoạch không bao giờ sửa phiếu nhập.
          </>
        }
        actions={
          <NavLink href={`/reports?tab=nominal&gv=kehoach&period=${period.key}`} className="text-sm font-medium text-primary hover:underline">
            Mở BCLN theo giá kế hoạch →
          </NavLink>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Mã đã đặt giá kế hoạch" value={formatNumber(coKeHoach)} note={`trên ${formatNumber(rows.length)} mã có giá / có bán`} icon={Calculator} tone="primary" />
        <MetricCard label="Đang bán, chưa có giá kế hoạch" value={formatNumber(dangBanChuaKeHoach)} note="Chế độ kế hoạch đứng trên giá thật cho các mã này" icon={CircleDashed} tone={dangBanChuaKeHoach ? "amber" : "green"} />
        <MetricCard label="Chỉ có giá báo MKT (tham chiếu)" value={formatNumber(chiGiaBao)} note="Giá báo chỉ lấp chỗ trống ở chế độ thực tế, nhãn «Tạm tính»" icon={Tag} tone="slate" />
        <MetricCard label="Chưa biết giá vốn" value={formatNumber(chuaBiet)} note="Không phiếu nhập, không giá kế hoạch — BCLN in «—», không in 0 ₫" icon={Layers} tone={chuaBiet ? "rose" : "green"} />
      </section>

      <DataTableToolbar period={{ defaultKey: "30d" }} resultLabel={<span>Cột &ldquo;đang áp dụng&rdquo; = giá vốn / sp BCLN dùng trong kỳ {period.label.toLowerCase()}</span>} />

      <CostCenterTable rows={rows} canWrite={canWrite} period={{ key: period.key, from: period.fromKey, to: period.toKey, label: period.label }} />
    </div>
  );
}
