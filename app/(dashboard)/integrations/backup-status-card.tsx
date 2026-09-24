import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { BACKUP_DRILL_MAX_AGE_DAYS, BACKUP_MAX_AGE_HOURS, formatBackupSize, type BackupRunRecord } from "@/lib/constants/backup";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { HEALTH_LABEL, HEALTH_TONE } from "@/lib/queries/integration-health";
import { getBackupHealth } from "@/lib/queries/backup-status";
import { cn } from "@/lib/utils";

const NHAN_KET_QUA: Record<BackupRunRecord["result"], string> = { OK: "đạt", PARTIAL: "một phần", FAILED: "THẤT BẠI" };
const NHAN_NGOAI_MAY: Record<BackupRunRecord["offsite"]["state"], string> = {
  OK: "đã đẩy và đọc lại kích thước",
  FAILED: "THẤT BẠI",
  NOT_CONFIGURED: "CHƯA CÓ BẢN SAO NGOÀI MÁY",
};

/**
 * ───────────── SAO LƯU DỮ LIỆU ─────────────
 *
 * Sao lưu chạy ngoài ứng dụng (cron trên VPS), nên thất bại của nó KHÔNG tự hiện ra ở đâu trong ERP
 * — trừ thẻ này. Mọi vế chưa đạt đều in ra, không chỉ vế xấu nhất: "chưa có bản ngoài máy" và
 * "chưa từng diễn tập" là hai việc khác nhau cho hai người khác nhau.
 */
export async function BackupStatusCard() {
  const b = await getBackupHealth();
  const s = b.lastSuccess;
  const r = b.lastRun;
  const d = b.lastDrill;
  return (
    <SectionCard
      id="sao-luu"
      title="Sao lưu dữ liệu"
      description={s?.schedule ? `Lịch: ${s.schedule}` : "Cron trên máy chủ — scripts/erp-backup.sh"}
      hint={`ĐẠT chỉ khi đủ năm vế: bản CSDL thành công trong ${BACKUP_MAX_AGE_HOURS} giờ · lượt gần nhất không hỏng · có bản NGOÀI MÁY · dữ liệu bot chat được sao lưu · diễn tập khôi phục đạt trong ${BACKUP_DRILL_MAX_AGE_DAYS} ngày. Chi tiết: docs/backup-restore.md · ops backup-status · ops restore-drill.`}
    >
      <div className="mb-3 flex flex-wrap items-start gap-2">
        <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap", HEALTH_TONE[b.state])}>{HEALTH_LABEL[b.state]}</span>
        <ul className="min-w-0 flex-1 space-y-0.5 text-[12px]">
          {b.issues.length ? (
            b.issues.map((i) => (
              <li key={i.text} className={i.state === "DOWN" ? "text-destructive" : i.state === "DEGRADED" ? "text-warning" : "text-muted-foreground"}>
                {i.text}
              </li>
            ))
          ) : (
            <li className="text-muted-foreground">{b.reason}</li>
          )}
        </ul>
      </div>
      <DescriptionList
        columns={3}
        items={[
          {
            label: "Bản CSDL thành công gần nhất",
            value: s ? `${formatTimeAgo(s.finishedAt)} · ${formatBackupSize(s.db.bytes)} · ${s.db.tableData ?? "—"} bảng` : "Chưa có",
          },
          {
            label: "Lượt gần nhất",
            value: r ? `${formatDateTime(r.finishedAt)} · ${NHAN_KET_QUA[r.result]} · ${r.trigger === "cron" ? "tự động" : "bấm tay"}` : "Chưa có",
          },
          { label: "Bản ngoài máy", value: s ? `${NHAN_NGOAI_MAY[s.offsite.state]}${s.offsite.remote ? ` (${s.offsite.remote})` : ""}` : "—" },
          { label: "Bot chat", value: s ? (s.chatbot.state === "OK" ? formatBackupSize(s.chatbot.bytes) : s.chatbot.state) : "—" },
          {
            label: "Giữ lại",
            value: s && s.retention.daily !== null ? `${s.retention.daily} bản ngày + ${s.retention.weekly ?? "—"} bản tuần + ${s.retention.manual ?? "—"} bản tay` : "—",
          },
          {
            label: "Diễn tập khôi phục",
            value: d ? `${formatTimeAgo(d.finishedAt)} · ${d.result === "OK" ? `đạt (${d.tables.length} bảng)` : d.result === "FAILED" ? "THẤT BẠI" : "không chạy"}` : "Chưa từng",
          },
        ]}
      />
    </SectionCard>
  );
}
