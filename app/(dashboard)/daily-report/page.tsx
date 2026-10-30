import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { DailyReportConfigForm } from "@/app/(dashboard)/daily-report/config-form";
import { can, requirePermission } from "@/lib/auth/session";
import { AI_STATUS_LABEL, factText } from "@/lib/constants/daily-report";
import { readDailyReportConfig } from "@/lib/daily-report/service";
import { formatDate, formatDateTime } from "@/lib/format";
import { listDailyReports } from "@/lib/queries/daily-report";
import { cn } from "@/lib/utils";

export const metadata = { title: "Báo cáo ngày" };

/**
 * BÁO CÁO CEO HẰNG NGÀY (ai-daily-report · docs/tech/ai-daily-report.md) — các bản đã lưu (BẤT BIẾN: đọc ảnh chụp, không tính lại).
 * Mỗi bản = khối số MÁY gom bằng các hàm báo cáo sẵn có + lời AI đã qua hàng rào số. Quyền xem: approvals:decide; cấu hình:
 * settings:manage. Mặc định TẮT.
 */
export default async function DailyReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("approvals:decide");
  const [{ rows, unavailable }, cfg] = await Promise.all([listDailyReports(), readDailyReportConfig()]);
  const raw = (await searchParams).d;
  const picked = (typeof raw === "string" ? rows.find((r) => r.reportDate === raw) : null) ?? rows[0] ?? null;
  const canEdit = can(user, "settings:manage");
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Ban điều hành"
        title="Báo cáo ngày"
        description={cfg.on ? `Đang bật · tạo bản của hôm qua từ ${cfg.hourVn} giờ · ${cfg.maxCostUsdPerDay === null ? "không gọi AI (chưa khai trần chi phí)" : `trần AI ${cfg.maxCostUsdPerDay} USD / ngày`}` : "Đang tắt (mặc định)"}
        hint="Máy gom số bằng chính các hàm báo cáo của ERP; AI chỉ viết lời từ khối số đó, và mọi con số trong lời AI phải có trong khối số — có số bịa thì lời bị chặn, bản chỉ còn khối số. «—» = chưa đo được, không phải 0. Bản đã tạo không sửa được. Tin gửi vào nhóm báo vận hành đã cấu hình (nếu có)."
      />
      {canEdit ? (
        <SectionCard title="Cấu hình">
          <DailyReportConfigForm current={cfg} />
        </SectionCard>
      ) : null}
      {unavailable ? (
        <EmptyState title="CSDL chưa áp 0266" description="Lược đồ của tổ chức chưa cập nhật xong (migration 0266 — báo cáo ngày). Trang hiện khi lượt cập nhật hoàn tất." />
      ) : !picked ? (
        <EmptyState title="Chưa có bản báo cáo nào" description={cfg.on ? "Bản đầu tiên được tạo vào giờ đã chọn, cho số của hôm qua." : "Bật báo cáo ngày ở phần Cấu hình (cần quyền settings:manage)."} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(260px,0.6fr)]">
          <SectionCard title={`Ngày ${formatDate(picked.reportDate)}`} description={`Tạo lúc ${formatDateTime(picked.createdAt)} · ${AI_STATUS_LABEL[picked.aiStatus]}${picked.model ? ` · ${picked.model}` : ""}${picked.costUsd === null ? "" : ` · $${picked.costUsd.toFixed(4)}`}`}>
            <div className="space-y-4 text-sm" data-daily-report={picked.reportDate}>
              {picked.aiStatus === "OK" && picked.summary ? (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <p>{picked.summary}</p>
                  <ul className="mt-2 list-disc pl-5">
                    {picked.highlights.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">Lời do AI viết từ khối số bên dưới; mọi con số đã được đối chiếu với khối số.</p>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {AI_STATUS_LABEL[picked.aiStatus]}
                  {picked.aiNote ? `: ${picked.aiNote}` : ""}
                </p>
              )}
              {picked.facts.sections.map((s) => (
                <div key={s.key}>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</h3>
                  <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
                    {s.facts.map((f) => (
                      <div key={f.key} className="contents">
                        <dt>{f.label}</dt>
                        <dd className={cn("text-right font-medium tabular-nums", f.value === null && "text-muted-foreground")} title={f.value === null ? f.missing : undefined}>
                          {factText(f)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title={`Các bản đã lưu (${rows.length})`} padded={false}>
            <div className="overflow-x-auto">
              <ul className="divide-y text-sm">
                {rows.map((r) => (
                  <li key={r.id}>
                    <Link href={`/daily-report?d=${r.reportDate}`} className={cn("flex justify-between px-4 py-2 hover:bg-muted", r.id === picked.id && "bg-muted font-semibold")}>
                      <span>{formatDate(r.reportDate)}</span>
                      <span className="text-xs text-muted-foreground">{r.aiStatus === "OK" ? "có lời AI" : AI_STATUS_LABEL[r.aiStatus]}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
