import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { organizationDatabaseName } from "@/db";
import { memo } from "@/lib/cache";
import {
  BACKUP_STATUS_DIR_DEFAULT,
  HOME_BACKUP_TARGET,
  ORG_BACKUP_DATABASE_PATTERN,
  ORG_BACKUP_HOURLY_FILE,
  ORG_BACKUP_STATUS_SUBDIR,
  ORG_BACKUP_SUMMARY_FILE,
  UNPARSABLE,
  evaluateBackupHealth,
  type BackupHealth,
  type BackupStatusFiles,
  type BackupTarget,
} from "@/lib/constants/backup";
import { currentOrganization } from "@/lib/platform/context";

/**
 * Đọc tệp trạng thái mà `scripts/erp-backup.sh` ghi, rồi chấm bằng `evaluateBackupHealth()`.
 *
 * CHỈ ĐỌC, và chỉ đọc thư mục compose đã mount chỉ-đọc. Tệp không có ≠ tệp hỏng ≠ thư mục không có:
 * ba tình huống, ba câu trả lời (xem `BackupStatusFiles`). Gộp chúng làm "máy chưa mount" trông
 * y hệt "chưa từng sao lưu".
 *
 * ĐÍCH lấy từ `currentOrganization()` — ngữ cảnh do máy chủ xác minh, không bao giờ từ tham số của
 * trình duyệt. Tổ chức khác nhà chỉ đọc `orgs/<CSDL của chính nó>/`; không có ⇒ "chưa có bản sao",
 * KHÔNG BAO GIỜ rơi về lời khai của nhà.
 */
export function backupStatusDir(): string {
  return process.env.ERP_BACKUP_STATUS_DIR || BACKUP_STATUS_DIR_DEFAULT;
}

/** Đích sao lưu của một tổ chức. Cùng luật tên CSDL với lượt cấp tổ chức (`organizationDatabaseName`). */
export function backupTargetFor(org: { code: string; isHome: boolean }): BackupTarget {
  if (org.isHome) return HOME_BACKUP_TARGET;
  // Cùng khoá ghi đè với lib/platform/provision.ts: CSDL ở máy khác thì không nằm trên máy Postgres chung.
  const externalDatabase = Boolean((process.env[`ORG_DATABASE_URL__${org.code.toUpperCase().replace(/-/g, "_")}`] || "").trim());
  return { scope: "ORGANIZATION", database: organizationDatabaseName(org.code), externalDatabase };
}

async function docJson(tep: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(tep, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return UNPARSABLE;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return UNPARSABLE;
  }
}

export async function readBackupStatusFiles(dir = backupStatusDir(), target: BackupTarget = HOME_BACKUP_TARGET): Promise<BackupStatusFiles> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return { dirReadable: false };
  } catch {
    return { dirReadable: false };
  }
  if (target.scope === "ORGANIZATION") {
    // Tên CSDL thành một đoạn đường dẫn ⇒ chỉ nhận đúng mẫu script dùng. Tên khác (vd CSDL gốc không
    // phải `erp`) thì script không sao lưu nó — thư mục đọc được, nhưng không có lời khai nào.
    if (!ORG_BACKUP_DATABASE_PATTERN.test(target.database)) return { dirReadable: true };
    const goc = path.join(dir, ORG_BACKUP_STATUS_SUBDIR, target.database);
    const [lastRun, lastSuccess, lastDrill, lastHourly] = await Promise.all([
      docJson(path.join(goc, "last-run.json")),
      docJson(path.join(goc, "last-success.json")),
      docJson(path.join(goc, "last-drill.json")),
      docJson(path.join(goc, ORG_BACKUP_HOURLY_FILE)),
    ]);
    return { dirReadable: true, lastRun, lastSuccess, lastDrill, lastHourly };
  }
  const [lastRun, lastSuccess, lastDrill, orgSummary] = await Promise.all([
    docJson(path.join(dir, "last-run.json")),
    docJson(path.join(dir, "last-success.json")),
    docJson(path.join(dir, "last-drill.json")),
    docJson(path.join(dir, ORG_BACKUP_SUMMARY_FILE)),
  ]);
  return { dirReadable: true, lastRun, lastSuccess, lastDrill, orgSummary };
}

/** Tệp nhỏ trên đĩa cục bộ — memo ngắn chỉ để hai thẻ trên cùng một trang không đọc hai lần. */
export async function getBackupHealth(): Promise<BackupHealth> {
  const target = backupTargetFor(await currentOrganization());
  // `memo` đã tách đệm theo tổ chức; khoá vẫn mang tên CSDL để hai đích không bao giờ dùng chung một ô.
  const khoa = target.scope === "HOME" ? "backupHealth" : `backupHealth:${target.database}`;
  return memo(khoa, 30_000, async () => evaluateBackupHealth(await readBackupStatusFiles(backupStatusDir(), target), new Date(), target));
}
