import type { HealthState } from "@/lib/queries/integration-health";

/**
 * ───────────── SAO LƯU: ERP ĐỌC LỜI KHAI CỦA `scripts/erp-backup.sh` ─────────────
 *
 * Sao lưu chạy BÊN NGOÀI ứng dụng (cron hệ thống trên VPS — container không có quyền docker để
 * `pg_dump` hay đọc volume của bot). Script ghi trạng thái máy đọc được vào `/root/backups/status`,
 * compose mount thư mục ấy CHỈ-ĐỌC vào container `app`, và tệp này chấm nó.
 *
 * VÌ SAO KHÔNG GHI VÀO `sync_runs`: CSDL chết là đúng lúc cần biết bản sao lưu gần nhất ở đâu, và
 * một sổ nằm TRONG thứ nó sao lưu thì mất cùng lúc với nó. Tệp trên đĩa của máy chủ thì không.
 *
 * ─── KHÔNG CÓ BẰNG CHỨNG THÌ KHÔNG ĐƯỢC NÓI "KHOẺ" ───
 *
 * `HEALTHY` chỉ khi ĐỦ cả năm vế: bản CSDL thành công trong {@link BACKUP_MAX_AGE_HOURS} giờ · lượt
 * gần nhất không hỏng · có bản NGOÀI MÁY · dữ liệu bot chat được sao lưu · đã DIỄN TẬP KHÔI PHỤC
 * đạt trong {@link BACKUP_DRILL_MAX_AGE_DAYS} ngày. Một bản sao lưu nằm trên chính cái máy nó bảo vệ,
 * hoặc chưa từng khôi phục thử, là một lời hứa — không phải một bản sao lưu.
 *
 * Mức dùng lại NGUYÊN bốn mức của `integration-health.ts`: hai thang đo cho cùng một câu hỏi là
 * hai cách để chúng nói khác nhau.
 *
 * Số bản giữ lại và lịch KHÔNG khai ở đây: chúng thuộc về script (khai đúng một chỗ, ở đầu
 * `scripts/erp-backup.sh`) và script GHI chúng vào tệp trạng thái — màn hình in lại lời khai đó,
 * không gõ lại con số thứ hai.
 *
 * ─── SAO LƯU CỦA AI — MỖI TỔ CHỨC CHỈ THẤY LỜI KHAI CỦA CHÍNH CSDL MÌNH (Phase 11) ───
 *
 * Nền tảng SILO: nhà ở CSDL `erp` (tệp `status/last-*.json`, kind `backup`), tổ chức khác ở
 * `erp_org_<mã>` (tệp `status/orgs/<csdl>/last-*.json`, kind `org-backup`, mang tên CSDL). Trước
 * Phase 11 mọi tổ chức đọc CÙNG thư mục — tổ chức B thấy "sao lưu tốt" của VNX trong khi CSDL của B
 * không có bản sao nào. Nên phép chấm luôn đi kèm ĐÍCH ({@link BackupTarget}): tệp của CSDL khác
 * (hoặc của nhà) KHÔNG BAO GIỜ làm căn cứ cho một tổ chức, kể cả khi bị đặt nhầm vào thư mục của nó.
 * Tổ chức khác không có bot chat (vế 4 bỏ), và diễn tập tự động mới phủ CSDL nhà — vế 5 của tổ
 * chức vì thế nói thẳng "chưa diễn tập", không mượn lượt diễn tập của nhà.
 */

/** Bản thành công gần nhất cũ hơn chừng này ⇒ `DOWN`. Lịch là hằng ngày; 36 giờ chừa một lần hỏng. */
export const BACKUP_MAX_AGE_HOURS = 36;

/** Diễn tập khôi phục cũ hơn chừng này ⇒ chưa chứng minh bản HIỆN TẠI còn khôi phục được. Nhịp: mỗi tháng. */
export const BACKUP_DRILL_MAX_AGE_DAYS = 35;

/** Nơi compose mount `${ERP_BACKUP_DIR:-/root/backups}/status` CHỈ-ĐỌC (docker-compose.prod.yml). */
export const BACKUP_STATUS_DIR_DEFAULT = "/erp-backup-status";

/** Thư mục con của thư mục trạng thái chứa lời khai từng CSDL tổ chức — khớp `STATUS_TO_CHUC` của script. */
export const ORG_BACKUP_STATUS_SUBDIR = "orgs";
/** Tệp tổng hợp các CSDL tổ chức của lượt gần nhất — khớp script (`orgs-last-run.json`). */
export const ORG_BACKUP_SUMMARY_FILE = "orgs-last-run.json";
/** Tên CSDL được phép làm một đoạn đường dẫn — chặt như `MAU_CSDL_TO_CHUC` của script, không hơn. */
export const ORG_BACKUP_DATABASE_PATTERN = /^erp_org_[a-z0-9_]+$/;

export type BackupRunResult = "OK" | "PARTIAL" | "FAILED";
export type BackupOffsiteState = "NOT_CONFIGURED" | "OK" | "FAILED";
/** `NOT_APPLICABLE`: CSDL tổ chức khác nhà — bot chat là volume của nhà, không thuộc tổ chức nào khác. */
export type BackupBotState = "OK" | "FAILED" | "NOT_FOUND" | "NOT_RUN" | "NOT_APPLICABLE";
export type BackupDrillResult = "OK" | "FAILED" | "SKIPPED";

/** Đích của một phép chấm: CSDL nhà, hay CSDL của MỘT tổ chức khác (tên CSDL Postgres). */
export type BackupTarget =
  | { scope: "HOME" }
  | {
      scope: "ORGANIZATION";
      database: string;
      /** Tổ chức khai `ORG_DATABASE_URL__<MÃ>` — CSDL ở máy khác, script trên erp-db không với tới. */
      externalDatabase?: boolean;
    };
export const HOME_BACKUP_TARGET: BackupTarget = { scope: "HOME" };

export type BackupRunRecord = {
  scope: "HOME" | "ORGANIZATION";
  /** Tên CSDL tổ chức (`erp_org_…`); `null` với bản của nhà. */
  database: string | null;
  result: BackupRunResult;
  trigger: string;
  startedAt: Date | null;
  finishedAt: Date;
  reason: string | null;
  freeMbBefore: number | null;
  needMb: number | null;
  db: { file: string | null; bytes: number | null; tableData: number | null };
  chatbot: { state: BackupBotState; bytes: number | null; reason: string | null };
  offsite: { state: BackupOffsiteState; remote: string | null; reason: string | null };
  retention: { daily: number | null; weekly: number | null; manual: number | null };
  schedule: string | null;
};

export type BackupDrillRecord = {
  /** CSDL đã diễn tập; `null` = CSDL nhà (lượt diễn tập của script không ghi trường này). */
  database: string | null;
  result: BackupDrillResult;
  finishedAt: Date;
  reason: string | null;
  dumpFile: string | null;
  tables: { name: string; restored: number | null; live: number | null }[];
};

/** Tổng hợp lượt sao lưu CSDL tổ chức khác (`status/orgs-last-run.json`) — chỉ màn hình của NHÀ đọc. */
export type OrgBackupSummary = {
  finishedAt: Date;
  /** Có ⇒ không liệt kê được CSDL tổ chức: CHƯA BIẾT có ai bị bỏ sót, không phải "không có ai". */
  listError: string | null;
  organizations: { database: string; result: BackupRunResult; reason: string | null }[];
  /** Tổ chức có trong sổ nhưng không có CSDL trên erp-db — script KHÔNG sao lưu được. */
  missingDatabases: string[];
};

/* ───────────── ĐỌC LỜI KHAI — sai hình dạng thì là KHÔNG ĐỌC ĐƯỢC, không phải "rỗng" ───────────── */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
/** Số nguyên không âm; mọi thứ khác là CHƯA BIẾT (`null`), không phải 0 (AGENTS.md mục 42). */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const date = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function parseBackupRun(raw: unknown): BackupRunRecord | null {
  if (!isObj(raw) || raw.schema !== 1 || (raw.kind !== "backup" && raw.kind !== "org-backup")) return null;
  const scope = raw.kind === "org-backup" ? "ORGANIZATION" : "HOME";
  const database = scope === "ORGANIZATION" ? str(raw.database) : null;
  // Lời khai của một tổ chức mà không nói CSDL nào thì không thuộc về ai — không phải căn cứ.
  if (scope === "ORGANIZATION" && !database) return null;
  const result = oneOf(raw.result, ["OK", "PARTIAL", "FAILED"] as const);
  const finishedAt = date(raw.finishedAt);
  if (!result || !finishedAt) return null;
  const db = isObj(raw.db) ? raw.db : {};
  const bot = isObj(raw.chatbot) ? raw.chatbot : {};
  const off = isObj(raw.offsite) ? raw.offsite : {};
  const ret = isObj(raw.retention) ? raw.retention : {};
  return {
    scope,
    database,
    result,
    trigger: str(raw.trigger) ?? "?",
    startedAt: date(raw.startedAt),
    finishedAt,
    reason: str(raw.reason),
    freeMbBefore: num(raw.freeMbBefore),
    needMb: num(raw.needMb),
    db: { file: str(db.file), bytes: num(db.bytes), tableData: num(db.tableData) },
    // Hình dạng lạ ⇒ xếp vào vế XẤU (NOT_RUN / FAILED), không bao giờ vào vế tốt.
    chatbot:
      scope === "ORGANIZATION"
        ? { state: "NOT_APPLICABLE", bytes: null, reason: null }
        : { state: oneOf(bot.state, ["OK", "FAILED", "NOT_FOUND", "NOT_RUN"] as const) ?? "NOT_RUN", bytes: num(bot.bytes), reason: str(bot.reason) },
    offsite: { state: oneOf(off.state, ["NOT_CONFIGURED", "OK", "FAILED"] as const) ?? "FAILED", remote: str(off.remote), reason: str(off.reason) },
    retention: { daily: num(ret.daily), weekly: num(ret.weekly), manual: num(ret.manual) },
    schedule: str(raw.schedule),
  };
}

export function parseBackupDrill(raw: unknown): BackupDrillRecord | null {
  if (!isObj(raw) || raw.schema !== 1 || raw.kind !== "restore-drill") return null;
  const result = oneOf(raw.result, ["OK", "FAILED", "SKIPPED"] as const);
  const finishedAt = date(raw.finishedAt);
  if (!result || !finishedAt) return null;
  const tables = Array.isArray(raw.tables)
    ? raw.tables.filter(isObj).map((t) => ({ name: str(t.name) ?? "?", restored: num(t.restored), live: num(t.live) }))
    : [];
  return { database: str(raw.database), result, finishedAt, reason: str(raw.reason), dumpFile: str(raw.dumpFile), tables };
}

export function parseOrgBackupSummary(raw: unknown): OrgBackupSummary | null {
  if (!isObj(raw) || raw.schema !== 1 || raw.kind !== "org-backup-summary") return null;
  const finishedAt = date(raw.finishedAt);
  if (!finishedAt) return null;
  const organizations = Array.isArray(raw.organizations)
    ? raw.organizations.filter(isObj).map((o) => ({
        database: str(o.database) ?? "?",
        // Kết quả lạ ⇒ vế XẤU.
        result: oneOf(o.result, ["OK", "PARTIAL", "FAILED"] as const) ?? "FAILED",
        reason: str(o.reason),
      }))
    : [];
  const missingDatabases = Array.isArray(raw.missingDatabases) ? raw.missingDatabases.map(str).filter((s): s is string => s !== null) : [];
  return { finishedAt, listError: str(raw.listError), organizations, missingDatabases };
}

/* ───────────── CHẤM ───────────── */

export type BackupIssue = { state: Exclude<HealthState, "HEALTHY">; text: string };

export type BackupHealth = {
  /** Đích đã chấm — màn hình dùng để nói "của CSDL nào", không suy lại từ phiên. */
  target: BackupTarget;
  state: HealthState;
  /** Câu của vế XẤU NHẤT — một ô màu không có câu giải thích là một ô không sửa được. */
  reason: string;
  /** MỌI vế chưa đạt, xấu nhất trước. Rỗng ⇔ `HEALTHY`. */
  issues: BackupIssue[];
  lastRun: BackupRunRecord | null;
  lastSuccess: BackupRunRecord | null;
  lastDrill: BackupDrillRecord | null;
  /** Tuổi bản thành công gần nhất, giờ. `null` = CHƯA CÓ bản nào. */
  ageHours: number | null;
  /**
   * CHỈ với đích nhà: tổng hợp CSDL tổ chức khác của lượt gần nhất. KHÔNG tham gia `state` — sao lưu
   * của VNX không "xấu đi" vì CSDL của khách khác hỏng; nó là một dòng riêng cho chủ nền tảng.
   */
  organizations: OrgBackupSummary | null;
};

export type BackupStatusFiles = {
  /** Thư mục trạng thái có tồn tại / đọc được không. `false` ⇒ máy này KHÔNG mount (dev · bản chạy thử). */
  dirReadable: boolean;
  /** Nội dung đã `JSON.parse`; `undefined` = tệp chưa có; chuỗi `"<unparsable>"` = có tệp mà hỏng. */
  lastRun?: unknown;
  lastSuccess?: unknown;
  lastDrill?: unknown;
  /** Chỉ với đích nhà: `orgs-last-run.json`. */
  orgSummary?: unknown;
};

export const UNPARSABLE = "<unparsable>";

const MUC: Record<HealthState, number> = { HEALTHY: 0, UNKNOWN: 1, DEGRADED: 2, DOWN: 3 };

/** Lời khai này có thuộc về đích đang chấm không. Nhà ⇔ kind `backup`; tổ chức ⇔ kind `org-backup` + ĐÚNG tên CSDL. */
function thuocVe(rec: { scope?: string; database: string | null }, target: BackupTarget): boolean {
  if (target.scope === "HOME") return rec.scope === undefined ? rec.database === null : rec.scope === "HOME";
  return rec.database === target.database && (rec.scope === undefined || rec.scope === "ORGANIZATION");
}

/**
 * Hàm THUẦN: cùng tệp + cùng mốc + cùng đích ⇒ cùng kết luận. Không đọc đĩa, không đọc đồng hồ.
 */
export function evaluateBackupHealth(files: BackupStatusFiles, now: Date, target: BackupTarget = HOME_BACKUP_TARGET): BackupHealth {
  const toChuc = target.scope === "ORGANIZATION";
  const empty = { target, lastRun: null, lastSuccess: null, lastDrill: null, ageHours: null, organizations: null };
  if (!files.dirReadable) {
    const text =
      "ERP không đọc được thư mục trạng thái sao lưu — máy này không mount /root/backups/status (bình thường ở máy chạy thử / dev; trên máy chủ nghĩa là lượt deploy chưa gắn thư mục). Không có căn cứ để nói có hay không có bản sao lưu.";
    return { state: "UNKNOWN", reason: text, issues: [{ state: "UNKNOWN", text }], ...empty };
  }

  const issues: BackupIssue[] = [];
  if (target.scope === "ORGANIZATION" && target.externalDatabase) {
    issues.push({
      state: "DOWN",
      text: `CSDL của tổ chức này khai ở máy khác (ORG_DATABASE_URL__…) — sao lưu tự động chỉ phủ CSDL trên máy chủ Postgres chung, nên CSDL này KHÔNG được sao lưu tự động. Cần lịch sao lưu riêng (docs/platform/backup-recovery.md).`,
    });
  }
  const hong = (v: unknown) => v === UNPARSABLE;
  if (hong(files.lastRun) || hong(files.lastSuccess) || hong(files.lastDrill)) {
    issues.push({ state: "UNKNOWN", text: "Có tệp trạng thái sao lưu nhưng không đọc được (sai định dạng) — đọc bằng ops backup-status." });
  }
  const runRaw = files.lastRun === undefined || hong(files.lastRun) ? null : parseBackupRun(files.lastRun);
  const successRaw = files.lastSuccess === undefined || hong(files.lastSuccess) ? null : parseBackupRun(files.lastSuccess);
  const drillRaw = files.lastDrill === undefined || hong(files.lastDrill) ? null : parseBackupDrill(files.lastDrill);
  if ((files.lastRun !== undefined && !hong(files.lastRun) && !runRaw) || (files.lastSuccess !== undefined && !hong(files.lastSuccess) && !successRaw)) {
    issues.push({ state: "UNKNOWN", text: "Tệp trạng thái sao lưu không đúng hình dạng mong đợi (schema 1) — không dùng làm căn cứ." });
  }
  // Lời khai của CSDL KHÁC không bao giờ là căn cứ cho đích này — nói ra, rồi bỏ.
  const lastRun = runRaw && thuocVe(runRaw, target) ? runRaw : null;
  const lastSuccess = successRaw && thuocVe(successRaw, target) ? successRaw : null;
  const lastDrill = drillRaw && thuocVe(drillRaw, target) ? drillRaw : null;
  if ((runRaw && !lastRun) || (successRaw && !lastSuccess) || (drillRaw && !lastDrill)) {
    issues.push({ state: "UNKNOWN", text: "Có tệp trạng thái sao lưu của một CSDL KHÁC nằm ở chỗ của CSDL này — không dùng làm căn cứ." });
  }

  const ageHours = lastSuccess ? Math.max(0, (now.getTime() - lastSuccess.finishedAt.getTime()) / 3_600_000) : null;
  const cuaAi = target.scope === "ORGANIZATION" ? ` cho CSDL của tổ chức này (${target.database})` : "";

  // ─── Vế 1 · CÓ BẢN CSDL CÒN MỚI KHÔNG ───
  if (!lastSuccess) {
    issues.push({
      state: "DOWN",
      text:
        lastRun && lastRun.result === "FAILED"
          ? `Chưa có bản sao lưu thành công nào${cuaAi}; lượt gần nhất THẤT BẠI: ${lastRun.reason ?? "không rõ lý do"}`
          : toChuc
            ? `Chưa có bản sao lưu nào${cuaAi} — lịch tự động chạy lúc thấp điểm đêm; bản của tổ chức khác (kể cả tổ chức nhà) KHÔNG phủ CSDL này.`
            : "Chưa có bản sao lưu nào được ghi nhận — lịch tự động chạy lúc thấp điểm đêm; muốn có ngay thì chạy ops backup.",
    });
  } else if ((ageHours ?? 0) > BACKUP_MAX_AGE_HOURS) {
    issues.push({ state: "DOWN", text: `Bản sao lưu thành công gần nhất${cuaAi} cách đây ${Math.floor(ageHours ?? 0)} giờ (quá ${BACKUP_MAX_AGE_HOURS} giờ) — lịch hằng ngày đã không chạy được.` });
  }

  // ─── Vế 2 · LƯỢT GẦN NHẤT CÓ HỎNG KHÔNG ───
  if (lastRun && lastSuccess && lastRun.finishedAt.getTime() > lastSuccess.finishedAt.getTime() && lastRun.result === "FAILED") {
    issues.push({ state: "DEGRADED", text: `Lượt sao lưu gần nhất THẤT BẠI: ${lastRun.reason ?? "không rõ lý do"}` });
  }

  if (lastSuccess) {
    // ─── Vế 3 · BẢN NGOÀI MÁY ───
    if (lastSuccess.offsite.state === "NOT_CONFIGURED") {
      issues.push({ state: "DEGRADED", text: "CHƯA CÓ BẢN SAO NGOÀI MÁY — mọi bản sao lưu nằm trên chính VPS; hỏng ổ hay mất máy là mất cả dữ liệu lẫn bản sao lưu." });
    } else if (lastSuccess.offsite.state === "FAILED") {
      issues.push({ state: "DEGRADED", text: `Đẩy bản ngoài máy THẤT BẠI: ${lastSuccess.offsite.reason ?? "không rõ lý do"}` });
    }
    // ─── Vế 4 · DỮ LIỆU BOT CHAT — chỉ nhà có ───
    if (!toChuc && lastSuccess.chatbot.state !== "OK") {
      issues.push({ state: "DEGRADED", text: `Dữ liệu bot chat chưa được sao lưu (${lastSuccess.chatbot.state}): ${lastSuccess.chatbot.reason ?? "không rõ lý do"}` });
    }
  }

  // ─── Vế 5 · DIỄN TẬP KHÔI PHỤC ───
  if (!lastDrill) {
    issues.push({
      state: "DEGRADED",
      text: toChuc
        ? "Chưa diễn tập khôi phục CSDL của tổ chức này — ops restore-drill chỉ phủ CSDL nhà; chạy ops restore-drill-org với mã tổ chức (docs/backup-restore.md mục 8)."
        : "Chưa từng diễn tập khôi phục — chưa chứng minh được bản sao lưu dùng được (ops restore-drill).",
    });
  } else if (lastDrill.result === "FAILED") {
    issues.push({ state: "DOWN", text: `Diễn tập khôi phục gần nhất THẤT BẠI: ${lastDrill.reason ?? "không rõ lý do"} — bản sao lưu CHƯA chứng minh được là dùng được.` });
  } else {
    const drillDays = (now.getTime() - lastDrill.finishedAt.getTime()) / 86_400_000;
    if (lastDrill.result === "SKIPPED") {
      issues.push({ state: "DEGRADED", text: `Lượt diễn tập gần nhất KHÔNG chạy: ${lastDrill.reason ?? "không rõ lý do"}` });
    } else if (drillDays > BACKUP_DRILL_MAX_AGE_DAYS) {
      issues.push({ state: "DEGRADED", text: `Diễn tập khôi phục đạt gần nhất cách đây ${Math.floor(drillDays)} ngày (quá ${BACKUP_DRILL_MAX_AGE_DAYS} ngày).` });
    }
  }

  issues.sort((a, b) => MUC[b.state] - MUC[a.state]);
  const state: HealthState = issues.length ? issues[0].state : "HEALTHY";
  const reason = issues.length
    ? issues[0].text
    : toChuc
      ? `Bản CSDL của tổ chức cách đây ${Math.floor(ageHours ?? 0)} giờ · có bản ngoài máy · diễn tập khôi phục đạt.`
      : `Bản CSDL cách đây ${Math.floor(ageHours ?? 0)} giờ · có bản ngoài máy · diễn tập khôi phục đạt.`;
  const organizations =
    target.scope === "HOME" && files.orgSummary !== undefined && !hong(files.orgSummary) ? parseOrgBackupSummary(files.orgSummary) : null;
  return { target, state, reason, issues, lastRun, lastSuccess, lastDrill, ageHours, organizations };
}

/** Kích thước tệp để hiển thị. `null` ⇒ "—" (CHƯA BIẾT), không bao giờ "0 MB". */
export function formatBackupSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace(".", ",")} GB` : `${mb.toFixed(1).replace(".", ",")} MB`;
}
