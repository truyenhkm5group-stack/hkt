import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { memo } from "@/lib/cache";
import { BACKUP_STATUS_DIR_DEFAULT, UNPARSABLE, evaluateBackupHealth, type BackupHealth, type BackupStatusFiles } from "@/lib/constants/backup";

/**
 * Đọc tệp trạng thái mà `scripts/erp-backup.sh` ghi, rồi chấm bằng `evaluateBackupHealth()`.
 *
 * CHỈ ĐỌC, và chỉ đọc thư mục compose đã mount chỉ-đọc. Tệp không có ≠ tệp hỏng ≠ thư mục không có:
 * ba tình huống, ba câu trả lời (xem `BackupStatusFiles`). Gộp chúng làm "máy chưa mount" trông
 * y hệt "chưa từng sao lưu".
 */
export function backupStatusDir(): string {
  return process.env.ERP_BACKUP_STATUS_DIR || BACKUP_STATUS_DIR_DEFAULT;
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

export async function readBackupStatusFiles(dir = backupStatusDir()): Promise<BackupStatusFiles> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return { dirReadable: false };
  } catch {
    return { dirReadable: false };
  }
  const [lastRun, lastSuccess, lastDrill] = await Promise.all([
    docJson(path.join(dir, "last-run.json")),
    docJson(path.join(dir, "last-success.json")),
    docJson(path.join(dir, "last-drill.json")),
  ]);
  return { dirReadable: true, lastRun, lastSuccess, lastDrill };
}

/** Tệp nhỏ trên đĩa cục bộ — memo ngắn chỉ để hai thẻ trên cùng một trang không đọc hai lần. */
export async function getBackupHealth(): Promise<BackupHealth> {
  return memo("backupHealth", 30_000, async () => evaluateBackupHealth(await readBackupStatusFiles(), new Date()));
}
