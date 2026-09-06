import { AlertTriangle, CopyX, FileSpreadsheet, PackageCheck, Send, Undo2 } from "lucide-react";
import { LandingConfigForm } from "@/app/(dashboard)/landing/landing-config";
import { LandingTable } from "@/app/(dashboard)/landing/landing-table";
import { ImportButton } from "@/app/(dashboard)/landing/import-button";
import { AutoRefresh } from "@/app/(dashboard)/landing/auto-refresh";
import { DataTableToolbar } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { can, requirePermission } from "@/lib/auth/session";
import { LANDING_STATUS_LABEL, LANDING_STATUSES, type LandingStatus } from "@/lib/constants/landing";
import { OUTCOME_LABEL, type OrderOutcome } from "@/lib/constants/returns";
import { formatNumber } from "@/lib/format";
import { loadLandingConfig } from "@/lib/landing/sheet";
import { LANDING_POS_LABEL, landingSummary, listLandingOrders, listLandingProductOptions, listVariantOptions, type LandingPosState } from "@/lib/queries/landing";
import { param, resolvePeriod, type SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

const OUTCOMES: (OrderOutcome | "NONE")[] = ["NONE", "NOT_SHIPPED", "IN_TRANSIT", "DELIVERED", "RETURNED", "RETURNED_BY_RULE", "CANCELLED"];
const FLAGS = [
  { value: "DUP", label: "Trùng SĐT" },
  { value: "RISK", label: "Khách rủi ro" },
  { value: "NO_VARIANT", label: "Chưa ghép mẫu mã" },
  { value: "PUSH_ERROR", label: "Gửi POS lỗi" },
  { value: "MISSING_INFO", label: "Thiếu địa chỉ / size (cần chăm sóc)" },
];

const split = <T extends string>(v: string | null, allowed: readonly T[]): T[] => (v ? (v.split(",").filter((x) => (allowed as readonly string[]).includes(x)) as T[]) : []);

export default async function LandingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const raw = await searchParams;
  const user = await requirePermission("landing:view");
  const canManage = can(user, "landing:manage");
  const canConfig = can(user, "landing:config");
  const period = resolvePeriod(raw, "30d");
  const filters = {
    q: param(raw, "q") ?? undefined,
    status: split(param(raw, "status"), LANDING_STATUSES),
    outcome: split(param(raw, "outcome"), OUTCOMES),
    flag: split(param(raw, "flag"), ["DUP", "RISK", "NO_VARIANT", "PUSH_ERROR", "MISSING_INFO"] as const),
    pos: split(param(raw, "pos"), ["HAS", "DRAFT", "NONE"] as const) as LandingPosState[],
    product: (param(raw, "product") ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean),
    period,
  };
  const [rows, summary, variants, config, productOptions] = await Promise.all([listLandingOrders(filters), landingSummary(period), canManage ? listVariantOptions() : Promise.resolve([]), loadLandingConfig(), listLandingProductOptions(period)]);
  const delivered = summary.byOutcome.DELIVERED;
  const returned = summary.byOutcome.RETURNED + summary.byOutcome.RETURNED_BY_RULE;
  const finished = delivered + returned;

  return (
    <div className="space-y-5">
      <AutoRefresh seconds={30} />
      <PageHeader
        eyebrow="Vận hành"
        title="Đơn landing page"
        description={`${period.label} · ${formatNumber(summary.total)} đơn từ Google Sheet · đồng bộ gần như tức thời (đọc sheet mỗi phút, tự làm mới trang)${summary.lastImportAt ? ` · dòng mới nhất ${summary.lastImportAt.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}` : ""}. Trạng thái giao / hoàn / huỷ lấy từ đơn Pancake đã ghép (theo SĐT hoặc sau khi gửi POS), kết quả đơn ưu tiên Viettel Post.`}
        actions={canManage ? <ImportButton configured={Boolean(config.sheetUrl)} /> : null}
      />

      <LandingConfigForm config={config} canWrite={canConfig} />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Mới về · chưa xử lý" value={formatNumber(summary.byStatus.NEW)} note={`đã xác nhận ${formatNumber(summary.byStatus.CONFIRMED)} · huỷ ${formatNumber(summary.byStatus.CANCELLED)}`} icon={FileSpreadsheet} tone="blue" />
        <MetricCard label="Đã gửi POS / có đơn Pancake" value={formatNumber(summary.total - summary.byOutcome.NONE)} note={`gửi POS ${formatNumber(summary.byStatus.PUSHED)} · chưa gửi ĐVVC ${formatNumber(summary.byOutcome.NOT_SHIPPED)} · đang giao ${formatNumber(summary.byOutcome.IN_TRANSIT)}`} icon={Send} tone="primary" />
        <MetricCard label="Giao thành công" value={formatNumber(delivered)} note={finished ? `${((delivered / finished) * 100).toFixed(1)}% số đơn đã kết thúc` : "chưa có đơn kết thúc"} icon={PackageCheck} tone="green" />
        <MetricCard label="Hoàn / huỷ" value={`${formatNumber(returned)} / ${formatNumber(summary.byOutcome.CANCELLED)}`} note={finished ? `tỷ lệ hoàn ${((returned / finished) * 100).toFixed(1)}%` : "—"} icon={Undo2} tone="rose" />
        <MetricCard label="Cần chú ý" value={formatNumber(summary.duplicates + summary.risky + summary.missingInfo)} note={`thiếu địa chỉ / size ${formatNumber(summary.missingInfo)} · trùng SĐT ${formatNumber(summary.duplicates)} · khách rủi ro ${formatNumber(summary.risky)} · chưa ghép mẫu mã ${formatNumber(summary.noVariant)} · gửi POS lỗi ${formatNumber(summary.pushErrors)}`} icon={AlertTriangle} tone="amber" />
      </section>

      <DataTableToolbar
        searchPlaceholder="Tên, SĐT, sản phẩm, địa chỉ…"
        period={{ defaultKey: "30d" }}
        facets={[
          { key: "product", label: "Mã hàng", options: productOptions.map((p) => ({ value: p.code, label: `${p.code} · ${formatNumber(p.count)} đơn (POS ${formatNumber(p.withPos)})` })) },
          { key: "pos", label: "Đơn POS", options: (["HAS", "DRAFT", "NONE"] as LandingPosState[]).map((v) => ({ value: v, label: LANDING_POS_LABEL[v] })) },
          { key: "status", label: "Trạng thái ERP", options: LANDING_STATUSES.map((s) => ({ value: s, label: LANDING_STATUS_LABEL[s as LandingStatus] })) },
          { key: "outcome", label: "Kết quả đơn", options: OUTCOMES.map((v) => ({ value: v, label: v === "NONE" ? "Chưa có đơn Pancake" : OUTCOME_LABEL[v] })) },
          { key: "flag", label: "Cảnh báo", options: FLAGS },
        ]}
        resultLabel={`${formatNumber(rows.length)} đơn phù hợp${rows.length >= 300 ? " (hiển thị 300 dòng đầu, thu hẹp bộ lọc để xem tiếp)" : ""}`}
      />

      {!config.sheetUrl ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <CopyX className="mt-0.5 size-4 shrink-0" />
          <span>Chưa cấu hình link Google Sheet. Bấm “Cấu hình sheet” ở trên, dán link sheet (đã chia sẻ “Bất kỳ ai có liên kết – Người xem”), ERP sẽ tự dò cột và đọc mỗi phút.</span>
        </div>
      ) : null}

      <LandingTable rows={rows} variants={variants} canManage={canManage} />
    </div>
  );
}
