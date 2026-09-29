import { DescriptionList, SectionCard } from "@/components/ui-bits";
import { BACKUP_DRILL_MAX_AGE_DAYS, BACKUP_MAX_AGE_HOURS, ORG_BACKUP_RPO_ALERT_HOURS, formatBackupSize, type BackupRunRecord } from "@/lib/constants/backup";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { HEALTH_LABEL, HEALTH_TONE } from "@/lib/queries/integration-health";
import { getBackupHealth } from "@/lib/queries/backup-status";
import { cn } from "@/lib/utils";

const NHAN_KET_QUA: Record<BackupRunRecord["result"], string> = { OK: "đạt", PARTIAL: "một phần", FAILED: "THẤT BẠI" };
/** Ai kích hoạt lượt: cron đêm, lượt MỖI GIỜ của CSDL tổ chức (`hourly-org`), hay người bấm (ops / tay). */
const nhanKichHoat = (trigger: string) => (trigger === "cron" ? "tự động (đêm)" : trigger === "hourly" ? "tự động (mỗi giờ)" : "bấm tay");
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
  const h = b.lastHourly;
  // Tổ chức khác nhà: thẻ nói về CSDL CỦA CHÍNH NÓ (erp_org_…), không bao giờ về bản của nhà.
  const toChuc = b.target.scope === "ORGANIZATION" ? b.target.database : null;
  const o = b.organizations;
  const hongToChuc = o ? o.organizations.filter((x) => x.result !== "OK") : [];
  return (
    <SectionCard
      id="sao-luu"
      title="Sao lưu dữ liệu"
      description={`${toChuc ? `CSDL của tổ chức này (${toChuc}) · ` : ""}${s?.schedule ? `Lịch: ${s.schedule}` : "Cron trên máy chủ — scripts/erp-backup.sh"}`}
      hint={
        toChuc
          ? `ĐẠT chỉ khi đủ bốn vế cho CSDL ${toChuc}: bản thành công trong ${BACKUP_MAX_AGE_HOURS} giờ (vàng khi quá ${ORG_BACKUP_RPO_ALERT_HOURS} giờ — mục tiêu RPO ≤ 1 giờ, sao lưu mỗi giờ) · lượt gần nhất không hỏng · có bản NGOÀI MÁY · diễn tập khôi phục đạt trong ${BACKUP_DRILL_MAX_AGE_DAYS} ngày. Bản sao của tổ chức khác không phủ CSDL này. Chi tiết: docs/platform/backup-recovery.md.`
          : `ĐẠT chỉ khi đủ năm vế: bản CSDL thành công trong ${BACKUP_MAX_AGE_HOURS} giờ · lượt gần nhất không hỏng · có bản NGOÀI MÁY · dữ liệu bot chat được sao lưu · diễn tập khôi phục đạt trong ${BACKUP_DRILL_MAX_AGE_DAYS} ngày. Chi tiết: docs/backup-restore.md · ops backup-status · ops restore-drill.`
      }
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
            value: r ? `${formatDateTime(r.finishedAt)} · ${NHAN_KET_QUA[r.result]} · ${nhanKichHoat(r.trigger)}` : "Chưa có",
          },
          // Chỉ CSDL tổ chức có lượt MỖI GIỜ; nhà giữ lịch đêm cho tới khi có PITR (docs/platform/backup-recovery.md §9).
          ...(toChuc
            ? [{ label: "Lượt mỗi giờ gần nhất", value: h ? `${formatDateTime(h.finishedAt)} · ${NHAN_KET_QUA[h.result]}` : "Chưa có" }]
            : []),
          { label: "Bản ngoài máy", value: s ? `${NHAN_NGOAI_MAY[s.offsite.state]}${s.offsite.remote ? ` (${s.offsite.remote})` : ""}` : "—" },
          {
            label: "Bot chat",
            value: toChuc ? "Không áp dụng (bot chat thuộc tổ chức nhà)" : s ? (s.chatbot.state === "OK" ? formatBackupSize(s.chatbot.bytes) : s.chatbot.state) : "—",
          },
          {
            label: "Giữ lại",
            value:
              s && s.retention.daily !== null
                ? `${s.retention.hourly !== null ? `${s.retention.hourly} bản giờ + ` : ""}${s.retention.daily} bản ngày + ${s.retention.weekly ?? "—"} bản tuần + ${s.retention.manual ?? "—"} bản tay`
                : "—",
          },
          {
            label: "Diễn tập khôi phục",
            value: d ? `${formatTimeAgo(d.finishedAt)} · ${d.result === "OK" ? `đạt (${d.tables.length} bảng)` : d.result === "FAILED" ? "THẤT BẠI" : "không chạy"}` : "Chưa từng",
          },
          // Chỉ màn hình của NHÀ (chủ nền tảng) thấy dòng này; nó không tham gia mức của thẻ.
          ...(o
            ? [
                {
                  label: "CSDL tổ chức khác (lượt gần nhất)",
                  value: `${formatDateTime(o.finishedAt)} · ${o.organizations.length} CSDL · ${
                    hongToChuc.length ? `HỎNG: ${hongToChuc.map((x) => x.database).join(", ")}` : "không CSDL nào hỏng"
                  }${o.listError ? " · KHÔNG liệt kê được CSDL tổ chức" : ""}${o.missingDatabases.length ? ` · không sao lưu được: ${o.missingDatabases.join(", ")}` : ""}`,
                },
              ]
            : []),
        ]}
      />
    </SectionCard>
  );
}
