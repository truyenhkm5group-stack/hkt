import { sql, type SQL } from "drizzle-orm";
import { getDbFor, getPlatformDb, releaseOrganizationDb, type Db } from "@/db";
import { orgBillingStanding } from "@/lib/billing/standing";
import type { BillingStandingKind } from "@/lib/billing/rules";
import { parseBackupRun, UNPARSABLE, type BackupDrillResult, type BackupOffsiteState, type BackupRunResult, type BackupStatusFiles, type BackupTarget } from "@/lib/constants/backup";
import { archiveProtectionOf } from "@/lib/constants/org-archive-protection";
import { acceptanceWorkspaceOf } from "@/lib/constants/saas-acceptance-registry";
import { platformAudit } from "@/lib/platform/audit";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { planOffboard, type OffboardKind } from "@/lib/platform/offboard";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { backupStatusDir, backupTargetFor, readBackupStatusFiles } from "@/lib/queries/backup-status";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ LƯU TRỮ / KÍCH HOẠT LẠI MỘT TỔ CHỨC — KHÔNG XOÁ GÌ, MẶC ĐỊNH CHẠY THỬ ═══════════
 *
 * Quyết định của chủ shop 17/10/2026: các workspace THỬ không dùng (`qa`, `test-shop`, `q-store`) được LƯU TRỮ, không xoá. Tổ chức
 * nhà, khách HSLC, `vnx` và workspace nghiệm thu SaaS giữ nguyên ACTIVE. Ba chiều trạng thái tách rời (docs/tenant-lifecycle.md):
 *  · VẬN HÀNH  — `platform_organizations.status` (cột duy nhất công cụ này đổi): ACTIVE | SUSPENDED ⇒ ARCHIVED ⇒ ĐÚNG trạng thái cũ.
 *  · THƯƠNG MẠI — thuê bao / hoá đơn / Số dư AI: công cụ này chỉ ĐỌC để từ chối khi còn nghĩa vụ tiền; không đổi gói, không huỷ hoá đơn.
 *  · TRIỂN KHAI — sổ migration / DEGRADED_MIGRATION của CSDL tổ chức: tổ chức lưu trữ ĐỨNG NGOÀI migration (`getDbFor` từ chối mở nó,
 *    bộ lập lịch + bước kiểm deploy chỉ đi tổ chức `isOperationalOrganization`), nên sổ của nó tụt lại là ĐÚNG — lượt kích hoạt lại
 *    phải migrate + đối chiếu sổ khớp TRƯỚC khi bật.
 *
 * ─── ĐIỀU KIỆN LƯU TRỮ ───
 *  1. không phải nhà, không nằm trong sổ bảo vệ (`ARCHIVE_PROTECTED_ORGS` — vnx, mọi tổ chức HSLC — từ chối THEO MÃ), không phải
 *     workspace nghiệm thu SaaS (`acceptanceWorkspaceOf`);
 *  2. đang ACTIVE hoặc SUSPENDED. `SETUP_FAILED` bị từ chối: tổ chức dựng dở mà lưu trữ rồi kích hoạt lại sẽ quay về một trạng thái
 *     không ai muốn — sửa / chạy lại việc dựng trước;
 *  3. KHÔNG còn nghĩa vụ tiền nào (`OBLIGATION_LABEL`): hoá đơn MỞ · phiếu nạp còn hạn · Số dư AI tiền mặt > 0 · kỳ thuê bao ĐÃ TRẢ
 *     chưa hết · khoản tiền về chưa ai xử lý. Tiền đã thu xong (hoá đơn đã trả, kỳ đã qua) không chặn — lưu trữ không xoá dòng nào;
 *  4. bản sao lưu CSDL của chính tổ chức: kết quả OK, đã đẩy NGOÀI MÁY, xong trong `ARCHIVE_BACKUP_MAX_AGE_HOURS` giờ;
 *  5. diễn tập khôi phục CSDL của chính tổ chức (`last-drill.json`: kind restore-drill · scope ORGANIZATION · đúng tên CSDL) kết quả
 *     OK, xong trong `ARCHIVE_DRILL_MAX_AGE_HOURS` giờ. Đọc lời khai CHUNG — không đòi diễn tập chạy trên VPS (lượt diễn tập ngoài máy
 *     ghi cùng hình dạng, có thể kèm trường `site`). SKIPPED / FAILED / CSDL khác ⇒ TỪ CHỐI.
 *  Mốc ở TƯƠNG LAI quá `FUTURE_TOLERANCE_MS` (đồng hồ lệch, tệp sửa tay) KHÔNG phải "mới" — bị từ chối như lời khai không đọc được.
 *
 * ─── VÌ SAO NGƯỠNG ĐỘ MỚI CỦA DIỄN TẬP LÀ 72 GIỜ MÀ KHÔNG ĐÒI "MỚI HƠN MỌI LƯỢT GHI" ───
 * ERP không có mốc "lượt ghi cuối" đáng tin cho một CSDL tổ chức (mỗi bảng một cột thời gian, job nền cũng ghi), và đoán nó bằng một
 * truy vấn gần đúng là đúng thứ luật 20 cấm. Thay vào đó điều kiện được dựng sao cho không cần nó: lưu trữ KHÔNG xoá một byte — CSDL
 * sống ở nguyên chỗ, và `scripts/erp-backup.sh` vẫn sao lưu mọi CSDL `erp_org_*` bất kể trạng thái. Nên diễn tập ở đây không phải
 * "bản sao DUY NHẤT phải chứa mọi lượt ghi" mà là bằng chứng rằng ĐƯỜNG sao lưu của CHÍNH CSDL này khôi phục được (định dạng, kích
 * cỡ, bảng); độ mới của DỮ LIỆU do vế 4 (≤ 26 giờ, ngoài máy) gánh. 72 giờ đủ chặt để lượt diễn tập phải được chạy CHO lượt lưu trữ
 * này (lịch tự động là luân phiên mỗi Chủ nhật, 35 ngày mới vàng), đủ rộng để không bắt người vận hành chạy lại trong cùng một giờ.
 * Muốn chặt hơn: ĐÌNH CHỈ tổ chức trước (không còn lượt ghi nào), rồi sao lưu + diễn tập, rồi lưu trữ.
 *
 * ─── THỨ TỰ KHI GHI (lưu trữ) ───
 *  1. đọc lại mọi điều kiện trên dữ liệu MỚI; nhật ký nền tảng `ORG_ARCHIVE` (`archive:start`, CHỈ số đếm — không tên / email / SĐT);
 *  2. MỘT giao dịch: khoá dòng tổ chức, đếm lại nghĩa vụ tiền + đọc lại trạng thái (đổi giữa chừng ⇒ hoàn tác), `status = 'ARCHIVED'`;
 *  3. xoá đệm sổ + năng lực của tiến trình này, đóng handle CSDL tổ chức; tiến trình ứng dụng thôi phục vụ trong ≤ 10 giây (đệm sổ);
 *  4. `archive:done` mang `before.status` = TRẠNG THÁI CŨ — đó là thứ lượt kích hoạt lại khôi phục. Không tới được `done` (từ chối giữa
 *     chừng HAY lỗi bất kỳ) ⇒ luôn có `archive:stopped` kèm lớp lỗi. KHÔNG DROP, KHÔNG xoá dòng, KHÔNG gỡ webhook Meta (tin tới của page
 *     thuộc tổ chức không hoạt động bị bỏ qua với HTTP 200 — `resolvePageOrganization`; gỡ đăng ký sẽ làm lượt kích hoạt lại mất kênh).
 *
 * ─── KÍCH HOẠT LẠI ───
 *  ARCHIVED ⇒ mở CSDL qua ĐÚNG đường migrate của ứng dụng (`getDbFor(…, { reactivation: true })` — lối DUY NHẤT qua chốt lưu trữ),
 *  đối chiếu sổ migration bằng CHÍNH `checkDb` của bước kiểm deploy (tiêm từ script), và CHỈ KHI KHỚP mới đổi trạng thái — về ĐÚNG
 *  trạng thái trước khi lưu trữ (đọc từ `archive:done` gần nhất): tổ chức bị công tắc khẩn ĐÌNH CHỈ trước khi lưu trữ thì quay về
 *  SUSPENDED, không lặng lẽ được mở lại. Không đọc được trạng thái cũ ⇒ SUSPENDED (phía HẸP HƠN) và nói ra. Không khớp / hết giờ /
 *  DEGRADED ⇒ VẪN ARCHIVED. Trong suốt lượt migrate tổ chức còn ARCHIVED ⇒ không phiên, webhook hay job nào chạm vào nó.
 *
 * Chỉ script vận hành gọi (scripts/org-lifecycle.ts) — không server action, không trang.
 */

export const ORG_LIFECYCLE_SCRIPT_LABEL = "script:org-lifecycle";
export const ARCHIVE_REASON = "Lưu trữ workspace THỬ không dùng — dữ liệu giữ nguyên, không tham gia migration / job / webhook — quyết định chủ shop 17/10/2026 (ops org-lifecycle)";
export const REACTIVATE_REASON = "Kích hoạt lại tổ chức đã lưu trữ — chỉ đổi trạng thái sau khi migrate + đối chiếu sổ migration khớp, về đúng trạng thái trước khi lưu trữ (ops org-lifecycle)";
/** Bản sao lưu CSDL tổ chức phải xong trong chừng này giờ (lượt đêm + lượt mỗi giờ ⇒ bình thường < 1 giờ; 26 = một đêm + biên). */
export const ARCHIVE_BACKUP_MAX_AGE_HOURS = 26;
/** Diễn tập khôi phục CSDL tổ chức phải xong trong chừng này giờ — lý do ở đầu tệp. */
export const ARCHIVE_DRILL_MAX_AGE_HOURS = 72;
/** Mốc trong lời khai được phép đi TRƯỚC đồng hồ máy chừng này (lệch đồng hồ giữa máy chạy sao lưu và ứng dụng); quá ⇒ không tin. */
export const FUTURE_TOLERANCE_MS = 5 * 60_000;
/** Trạng thái được phép lưu trữ — cũng là tập trạng thái mà kích hoạt lại khôi phục được. */
export const ARCHIVABLE_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type RestorableStatus = (typeof ARCHIVABLE_STATUSES)[number];

export type ObligationKey = "OPEN_INVOICE" | "PENDING_TOPUP" | "AI_CASH_BALANCE" | "PREPAID_PERIOD" | "UNRESOLVED_PAYMENT";
export const OBLIGATION_LABEL: Record<ObligationKey, string> = {
  OPEN_INVOICE: "hoá đơn còn MỞ (khách còn nợ / còn nhận tiền được)",
  PENDING_TOPUP: "phiếu nạp Số dư AI còn hạn (còn nhận tiền được)",
  AI_CASH_BALANCE: "Số dư AI TIỀN MẶT còn dương (shop đang giữ tiền của khách)",
  PREPAID_PERIOD: "kỳ thuê bao ĐÃ TRẢ chưa hết (shop còn nợ khách thời gian dịch vụ)",
  UNRESOLVED_PAYMENT: "khoản tiền về chưa ai xử lý (lệch / giữ lại / không khớp hoá đơn)",
};
/** `rows` = số dòng chứng cứ; `amountVnd` = tổng tiền khi đọc được (`null` = không áp dụng / chưa biết, không phải 0). */
export type Obligation = { key: ObligationKey; rows: number; amountVnd: number | null };

type EvidenceState = "OK" | "MISSING" | "UNREADABLE" | "WRONG_TARGET" | "NOT_MOUNTED" | "FUTURE";
export type BackupEvidence = {
  state: EvidenceState;
  result: BackupRunResult | null;
  offsite: BackupOffsiteState | null;
  finishedAt: Date | null;
  ageHours: number | null;
};
export type DrillEvidence = {
  state: EvidenceState;
  result: BackupDrillResult | null;
  finishedAt: Date | null;
  ageHours: number | null;
  /** Trường tuỳ chọn của lời khai (nơi chạy diễn tập) — đã LỌC ký tự, chỉ để in, không tham gia phán quyết. */
  site: string | null;
};

export type RefusalCode =
  | "HOME"
  | "PROTECTED_ORG"
  | "ACCEPTANCE_WORKSPACE"
  | "STATUS_NOT_ARCHIVABLE"
  | "MONEY_OBLIGATION"
  | "EXTERNAL_DATABASE"
  | "BACKUP_NOT_MOUNTED"
  | "BACKUP_MISSING"
  | "BACKUP_UNREADABLE"
  | "BACKUP_NOT_OK"
  | "BACKUP_NOT_OFFSITE"
  | "BACKUP_STALE"
  | "DRILL_MISSING"
  | "DRILL_UNREADABLE"
  | "DRILL_NOT_OK"
  | "DRILL_STALE"
  | "NOT_ARCHIVED"
  | "CONFIRM_MISMATCH";
export type Refusal = { code: RefusalCode; text: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const hoursBetween = (a: Date, now: Date) => (now.getTime() - a.getTime()) / 3_600_000;
const inFuture = (a: Date, now: Date) => a.getTime() - now.getTime() > FUTURE_TOLERANCE_MS;
/** Nơi chạy diễn tập — chỉ giữ ký tự an toàn, tối đa 24; trống ⇒ `null`. Không bao giờ in nguyên văn một trường lời khai. */
const safeSite = (v: unknown): string | null => {
  const raw = str(v);
  if (!raw) return null;
  // Trông như tên CSDL / tệp sao lưu ⇒ không in (kho PUBLIC); còn lại chỉ giữ chữ, số, gạch — tối đa 24.
  if (/erp_org|dump|[\/]/i.test(raw)) return "(đã ẩn)";
  const s = raw.replace(/[^A-Za-z0-9-]/g, "").slice(0, 24);
  return s ? s : null;
};

/** Hàm THUẦN: lời khai `last-success.json` của CSDL tổ chức ⇒ bằng chứng sao lưu. Sai hình dạng / sai CSDL / mốc tương lai KHÔNG BAO GIỜ thành OK. */
export function backupEvidence(files: BackupStatusFiles, database: string, now: Date): BackupEvidence {
  const none = (state: EvidenceState): BackupEvidence => ({ state, result: null, offsite: null, finishedAt: null, ageHours: null });
  if (!files.dirReadable) return none("NOT_MOUNTED");
  if (files.lastSuccess === undefined) return none("MISSING");
  if (files.lastSuccess === UNPARSABLE) return none("UNREADABLE");
  const rec = parseBackupRun(files.lastSuccess);
  if (!rec) return none("UNREADABLE");
  if (rec.scope !== "ORGANIZATION" || rec.database !== database) return none("WRONG_TARGET");
  if (inFuture(rec.finishedAt, now)) return none("FUTURE");
  return { state: "OK", result: rec.result, offsite: rec.offsite.state, finishedAt: rec.finishedAt, ageHours: Math.max(0, hoursBetween(rec.finishedAt, now)) };
}

/**
 * Hàm THUẦN: lời khai `last-drill.json` ⇒ bằng chứng diễn tập. Đọc CHUNG cho mọi nơi chạy diễn tập: chỉ đòi `kind = restore-drill`,
 * `scope = ORGANIZATION`, `database` ĐÚNG tên CSDL, `result`, `finishedAt`; trường lạ (vd `site`) được chấp nhận và chỉ để in.
 * `reason` của lời khai KHÔNG được đọc ra: nó có thể mang tên tệp sao lưu và đi ra log công khai.
 */
export function drillEvidence(dirReadable: boolean, raw: unknown, database: string, now: Date): DrillEvidence {
  const none = (state: EvidenceState): DrillEvidence => ({ state, result: null, finishedAt: null, ageHours: null, site: null });
  if (!dirReadable) return none("NOT_MOUNTED");
  if (raw === undefined) return none("MISSING");
  if (!isObj(raw) || raw.schema !== 1 || raw.kind !== "restore-drill") return none("UNREADABLE");
  if (raw.scope !== "ORGANIZATION" || raw.database !== database) return none("WRONG_TARGET");
  const result = raw.result === "OK" || raw.result === "FAILED" || raw.result === "SKIPPED" ? raw.result : null;
  const fin = str(raw.finishedAt);
  const finishedAt = fin && !Number.isNaN(new Date(fin).getTime()) ? new Date(fin) : null;
  if (!result || !finishedAt) return none("UNREADABLE");
  if (inFuture(finishedAt, now)) return none("FUTURE");
  return { state: "OK", result, finishedAt, ageHours: Math.max(0, hoursBetween(finishedAt, now)), site: safeSite(raw.site) };
}

/** Hàm THUẦN: vì sao KHÔNG được lưu trữ. Rỗng ⇔ lưu trữ được (vẫn cần `--confirm` đúng mã). Tổ chức đã ARCHIVED xử lý riêng (không làm gì). */
export function archiveRefusals(p: {
  org: { code: string; isHome: boolean; status: string };
  acceptance: boolean;
  externalDatabase: boolean;
  obligations: readonly Obligation[];
  backup: BackupEvidence;
  drill: DrillEvidence;
  limits?: { backupHours?: number; drillHours?: number };
}): Refusal[] {
  const backupHours = p.limits?.backupHours ?? ARCHIVE_BACKUP_MAX_AGE_HOURS;
  const drillHours = p.limits?.drillHours ?? ARCHIVE_DRILL_MAX_AGE_HOURS;
  const out: Refusal[] = [];
  if (p.org.isHome) out.push({ code: "HOME", text: "tổ chức NHÀ — không bao giờ lưu trữ" });
  const protectedOrg = archiveProtectionOf(p.org.code);
  if (protectedOrg) out.push({ code: "PROTECTED_ORG", text: `nằm trong sổ bảo vệ (lib/constants/org-archive-protection.ts): ${protectedOrg.reason}` });
  if (p.acceptance) out.push({ code: "ACCEPTANCE_WORKSPACE", text: "workspace NGHIỆM THU SaaS (sổ khai saas-acceptance-registry) — phải giữ ACTIVE" });
  if (p.org.status !== "ARCHIVED" && !(ARCHIVABLE_STATUSES as readonly string[]).includes(p.org.status)) {
    out.push({ code: "STATUS_NOT_ARCHIVABLE", text: `tổ chức đang ${p.org.status} — chỉ lưu trữ tổ chức ACTIVE / SUSPENDED (dựng hỏng ⇒ sửa / chạy lại việc dựng trước, nếu không kích hoạt lại sẽ trả về một workspace dựng dở)` });
  }
  for (const o of p.obligations) {
    if (o.rows > 0) out.push({ code: "MONEY_OBLIGATION", text: `${OBLIGATION_LABEL[o.key]}: ${o.rows} dòng${o.amountVnd !== null ? ` · ${o.amountVnd.toLocaleString("vi-VN")} ₫` : ""} — xử lý xong nghĩa vụ tiền trước` });
  }
  if (p.externalDatabase) out.push({ code: "EXTERNAL_DATABASE", text: "CSDL ở máy khác (ORG_DATABASE_URL__…) — script sao lưu không phủ, không có bằng chứng" });
  const b = p.backup;
  if (b.state === "NOT_MOUNTED") out.push({ code: "BACKUP_NOT_MOUNTED", text: "không đọc được thư mục trạng thái sao lưu — không xác nhận được bản sao" });
  else if (b.state === "MISSING") out.push({ code: "BACKUP_MISSING", text: "CSDL tổ chức CHƯA có bản sao lưu thành công nào — chạy ops backup trước" });
  else if (b.state === "FUTURE") out.push({ code: "BACKUP_UNREADABLE", text: "lời khai sao lưu mang mốc ở TƯƠNG LAI (lệch đồng hồ / tệp sửa tay) — không coi là bản mới" });
  else if (b.state !== "OK") out.push({ code: "BACKUP_UNREADABLE", text: `lời khai sao lưu không đọc được (${b.state}) — không coi là có bản sao` });
  else {
    if (b.result !== "OK") out.push({ code: "BACKUP_NOT_OK", text: `bản sao lưu gần nhất kết quả ${b.result} — cần OK` });
    if (b.offsite !== "OK") out.push({ code: "BACKUP_NOT_OFFSITE", text: `bản sao lưu gần nhất chưa có bản NGOÀI MÁY (${b.offsite ?? "—"})` });
    if (b.ageHours === null || b.ageHours > backupHours) out.push({ code: "BACKUP_STALE", text: `bản sao lưu gần nhất cách đây ${b.ageHours === null ? "—" : Math.round(b.ageHours * 10) / 10} giờ — quá ${backupHours} giờ` });
  }
  const d = p.drill;
  if (d.state === "NOT_MOUNTED" || d.state === "MISSING") out.push({ code: "DRILL_MISSING", text: "CHƯA có diễn tập khôi phục CSDL của tổ chức này — chạy ops restore-drill-org <mã> trước" });
  else if (d.state === "FUTURE") out.push({ code: "DRILL_UNREADABLE", text: "lời khai diễn tập mang mốc ở TƯƠNG LAI (lệch đồng hồ / tệp sửa tay) — không coi là bằng chứng mới" });
  else if (d.state !== "OK") out.push({ code: "DRILL_UNREADABLE", text: `lời khai diễn tập không dùng được (${d.state === "WRONG_TARGET" ? "không phải CSDL của tổ chức này / không phải phạm vi ORGANIZATION" : "sai hình dạng"})` });
  else {
    if (d.result !== "OK") out.push({ code: "DRILL_NOT_OK", text: `diễn tập khôi phục gần nhất ${d.result === "SKIPPED" ? "KHÔNG CHẠY (SKIPPED)" : "THẤT BẠI"} — lý do ở ops backup-status, chạy lại ops restore-drill-org <mã>` });
    if (d.ageHours === null || d.ageHours > drillHours) out.push({ code: "DRILL_STALE", text: `diễn tập khôi phục gần nhất cách đây ${d.ageHours === null ? "—" : Math.round(d.ageHours)} giờ — quá ${drillHours} giờ` });
  }
  return out;
}

/** Hàm THUẦN: vì sao KHÔNG được kích hoạt lại (chưa tính lượt migrate + đối chiếu — đó là điều kiện thứ hai, chạy thật). */
export function reactivateRefusals(org: { isHome: boolean; status: string }): Refusal[] {
  const out: Refusal[] = [];
  if (org.isHome) out.push({ code: "HOME", text: "tổ chức NHÀ không có vòng đời lưu trữ" });
  if (org.status !== "ARCHIVED") out.push({ code: "NOT_ARCHIVED", text: `tổ chức đang ${org.status} — chỉ kích hoạt lại tổ chức ARCHIVED (đình chỉ ⇒ dùng công tắc ở /platform/org)` });
  return out;
}

/**
 * Hàm THUẦN: kích hoạt lại về trạng thái NÀO. Trạng thái cũ đọc được và thuộc `ARCHIVABLE_STATUSES` ⇒ đúng nó; mọi thứ khác (không có
 * nhật ký, chuỗi lạ) ⇒ SUSPENDED — phía HẸP HƠN, người vận hành bật lại bằng công tắc khi chắc chắn — và `fallback = true` để nói ra.
 */
export function restoreStatusFor(prior: string | null): { status: RestorableStatus; fallback: boolean } {
  if (prior !== null && (ARCHIVABLE_STATUSES as readonly string[]).includes(prior)) return { status: prior as RestorableStatus, fallback: false };
  return { status: "SUSPENDED", fallback: true };
}

export type ArchiveVerdict = "ALREADY_ARCHIVED" | "ARCHIVABLE" | "REFUSED";
export function archiveVerdict(status: string, refusals: readonly Refusal[]): ArchiveVerdict {
  if (status === "ARCHIVED") return "ALREADY_ARCHIVED";
  return refusals.length ? "REFUSED" : "ARCHIVABLE";
}

// ─────────────────────────── ĐỌC ───────────────────────────

type Exec = { execute: (q: SQL) => Promise<unknown> };

function one(rows: unknown): { n: number; v: number | null } {
  const [r] = rowsOf<{ n: number | string | null; v: number | string | null }>(rows);
  return { n: Number(r?.n ?? 0), v: r?.v === null || r?.v === undefined ? null : Number(r.v) };
}

/**
 * Đếm MỌI nghĩa vụ tiền còn mở của một tổ chức trên `exec` — gọi lúc lập kế hoạch VÀ trong giao dịch đổi trạng thái (sau khi khoá
 * dòng tổ chức), để tiền về giữa hai lượt vẫn bị bắt. Ngày "hôm nay" theo giờ Việt Nam (kỳ thuê bao là NGÀY VN, lib/billing/rules.ts).
 * Khoản tiền về được quy về tổ chức bằng CÙNG phép nối rộng của offboard: `org_code` HOẶC hoá đơn / phiếu nạp của tổ chức.
 */
export async function countObligations(exec: Exec, code: string): Promise<Obligation[]> {
  const open = one(await exec.execute(sql`select count(*)::int as n, coalesce(sum(amount_vnd), 0)::bigint as v from platform_invoices where org_code = ${code} and status = 'OPEN'`));
  const topup = one(await exec.execute(sql`select count(*)::int as n, coalesce(sum(amount_vnd), 0)::bigint as v from platform_payment_intents where org_code = ${code} and status = 'PENDING' and expires_at > now()`));
  const cash = one(await exec.execute(sql`select count(*)::int as n, coalesce(sum(amount_vnd), 0)::bigint as v from platform_ai_ledger_entries where org_code = ${code} and funds_class = 'CASH'`));
  const prepaid = one(await exec.execute(sql`select count(*)::int as n, null::bigint as v from platform_invoices where org_code = ${code} and status = 'PAID' and period_end >= (now() at time zone 'Asia/Ho_Chi_Minh')::date`));
  const unresolved = one(
    await exec.execute(
      sql`select count(*)::int as n, coalesce(sum(amount_vnd), 0)::bigint as v from platform_billing_payments
          where (org_code = ${code}
                 or invoice_id in (select id from platform_invoices where org_code = ${code})
                 or payment_intent_id in (select id from platform_payment_intents where org_code = ${code}))
            and outcome not in ('MATCHED', 'TOPUP_CREDITED') and resolved_at is null`,
    ),
  );
  const cashVnd = cash.v ?? 0;
  return [
    { key: "OPEN_INVOICE", rows: open.n, amountVnd: open.n ? open.v : null },
    { key: "PENDING_TOPUP", rows: topup.n, amountVnd: topup.n ? topup.v : null },
    // Số dư là TỔNG sổ cái — dương ⇒ một nghĩa vụ (đếm 1), bằng 0 / âm ⇒ không.
    { key: "AI_CASH_BALANCE", rows: cashVnd > 0 ? 1 : 0, amountVnd: cashVnd > 0 ? cashVnd : null },
    { key: "PREPAID_PERIOD", rows: prepaid.n, amountVnd: null },
    { key: "UNRESOLVED_PAYMENT", rows: unresolved.n, amountVnd: unresolved.n ? unresolved.v : null },
  ];
}

/** Chiều THƯƠNG MẠI còn mở — chỉ CẢNH BÁO, không chặn (thuê bao sản phẩm chưa kết thúc · thu phí còn bật). `null` = không đọc được. */
export type CommercialOpen = { liveProductSubscriptions: number | null; billingEnabled: boolean | null };

async function readCommercialOpen(exec: Exec, code: string): Promise<CommercialOpen> {
  let liveProductSubscriptions: number | null = null;
  let billingEnabled: boolean | null = null;
  try {
    liveProductSubscriptions = one(await exec.execute(sql`select count(*)::int as n, null::bigint as v from platform_product_subscriptions where org_code = ${code} and ended_at is null`)).n;
  } catch {
    liveProductSubscriptions = null;
  }
  try {
    const [r] = rowsOf<{ enabled: boolean }>(await exec.execute(sql`select billing_enabled as enabled from platform_subscriptions where org_code = ${code} limit 1`));
    billingEnabled = r ? Boolean(r.enabled) : false;
  } catch {
    billingEnabled = null;
  }
  return { liveProductSubscriptions, billingEnabled };
}

export type LifecyclePlan = {
  org: { id: string; code: string; status: string; isHome: boolean };
  kind: OffboardKind;
  acceptance: boolean;
  /** Chiều THƯƠNG MẠI, chỉ để in — `null` = không đọc được. */
  commercial: BillingStandingKind | null;
  commercialOpen: CommercialOpen;
  obligations: Obligation[];
  database: { name: string; external: boolean };
  backup: BackupEvidence;
  drill: DrillEvidence;
  activity: { readable: boolean; orders: number | null; activeConnections: number | null; activeChannelPages: number | null; messengerPages: number };
  refusals: Refusal[];
  verdict: ArchiveVerdict;
};

export type LifecycleDeps = {
  now?: () => Date;
  /** Đọc tệp trạng thái sao lưu của một đích — mặc định thư mục mount chỉ đọc của ứng dụng. */
  readBackupFiles?: (target: BackupTarget) => Promise<BackupStatusFiles>;
};

/**
 * KẾ HOẠCH vòng đời của một tổ chức — CHỈ ĐỌC (mặt phẳng điều khiển + tệp trạng thái sao lưu + đếm trong CSDL tổ chức qua handle
 * CHỈ ĐỌC của `planOffboard`, không migrate). `null` = không có tổ chức mã này. Đọc thẳng `platform_organizations` (không qua đệm sổ).
 */
export async function planLifecycle(code: string, deps: LifecycleDeps = {}): Promise<LifecyclePlan | null> {
  const now = deps.now?.() ?? new Date();
  const base = await planOffboard(code);
  if (!base) return null;
  const pdb = await getPlatformDb();
  const org = { id: base.org.id, code: base.org.code, status: base.org.status, isHome: base.org.isHome };
  const obligations = await countObligations(pdb, code);
  const commercialOpen = await readCommercialOpen(pdb, code);
  const target = backupTargetFor({ code, isHome: org.isHome });
  const files: BackupStatusFiles = org.isHome
    ? { dirReadable: false }
    : await (deps.readBackupFiles ?? ((t: BackupTarget) => readBackupStatusFiles(backupStatusDir(), t)))(target).catch((): BackupStatusFiles => ({ dirReadable: false }));
  const database = target.scope === "ORGANIZATION" ? { name: target.database, external: Boolean(target.externalDatabase) } : { name: "(CSDL nhà)", external: false };
  const backup = backupEvidence(files, database.name, now);
  const drill = drillEvidence(files.dirReadable, files.lastDrill, database.name, now);
  let commercial: BillingStandingKind | null = null;
  try {
    commercial = (await orgBillingStanding(org, now, { fresh: true })).kind;
  } catch {
    commercial = null;
  }
  const acceptance = acceptanceWorkspaceOf(code) !== null;
  const refusals = archiveRefusals({ org, acceptance, externalDatabase: database.external, obligations, backup, drill });
  return {
    org,
    kind: base.kind,
    acceptance,
    commercial,
    commercialOpen,
    obligations,
    database,
    backup,
    drill,
    activity: {
      readable: base.orgDb.readable,
      orders: base.orgDb.orders,
      activeConnections: base.orgDb.activeConnections === null ? null : base.orgDb.activeConnections.length,
      activeChannelPages: base.orgDb.activeChannelPages,
      messengerPages: base.messengerPageIds.length,
    },
    refusals,
    verdict: archiveVerdict(org.status, refusals),
  };
}

const KIND_LABEL: Record<OffboardKind, string> = { HOME: "NHÀ", SELF_SIGNUP: "TỰ ĐĂNG KÝ", OPERATOR_CREATED: "NGƯỜI VẬN HÀNH TẠO", UNVERIFIED: "CHƯA XÁC MINH" };
const VERDICT_LABEL: Record<ArchiveVerdict, string> = { ALREADY_ARCHIVED: "ĐÃ LƯU TRỮ (không làm gì)", ARCHIVABLE: "LƯU TRỮ ĐƯỢC (cần --archive --apply --confirm=<mã>)", REFUSED: "KHÔNG lưu trữ được" };

const age = (h: number | null) => (h === null ? "—" : h < 48 ? `${Math.round(h * 10) / 10} giờ` : `${Math.round(h / 24)} ngày`);

/**
 * Hàm THUẦN: dòng in của một kế hoạch — ra log CÔNG KHAI (kho PUBLIC): CHỈ mã tổ chức, trạng thái, loại, số đếm, mốc, phán quyết.
 * KHÔNG tên, email, SĐT, mã page, tên tệp sao lưu, lý do tự do của lời khai. `deployment` = chiều TRIỂN KHAI do script đo, `null` = chưa đo.
 */
export function lifecyclePlanLines(p: LifecyclePlan, deployment: string | null): string[] {
  const money = p.obligations.filter((o) => o.rows > 0);
  const b = p.backup;
  const d = p.drill;
  const co = p.commercialOpen;
  const commercialWarn =
    (co.liveProductSubscriptions ?? 0) > 0 || co.billingEnabled === true || co.liveProductSubscriptions === null || co.billingEnabled === null
      ? `${p.org.code} · CẢNH BÁO thương mại (không chặn — chiều riêng): thuê bao sản phẩm chưa kết thúc ${co.liveProductSubscriptions ?? "—"} · thu phí đang bật ${co.billingEnabled === null ? "—" : co.billingEnabled ? "CÓ" : "không"} — lưu trữ không đóng thuê bao, người vận hành tự quyết`
      : null;
  return [
    `${p.org.code} · VẬN HÀNH ${p.org.status} · THƯƠNG MẠI ${p.commercial ?? "—"} · TRIỂN KHAI ${deployment ?? "chưa đo"} · loại ${KIND_LABEL[p.kind]}${p.acceptance ? " · NGHIỆM THU SaaS" : ""}${archiveProtectionOf(p.org.code) ? " · ĐƯỢC BẢO VỆ" : ""}`,
    `${p.org.code} · nghĩa vụ tiền: ${money.length ? money.map((o) => `${o.key} ${o.rows}`).join(" · ") : "không"} · đơn ${p.activity.orders ?? "—"} · kết nối đang bật ${p.activity.activeConnections ?? "—"} · page kênh ${p.activity.activeChannelPages ?? "—"} · page Meta ${p.activity.messengerPages}`,
    ...(commercialWarn ? [commercialWarn] : []),
    `${p.org.code} · sao lưu: ${b.state === "OK" ? `${b.result} · ${age(b.ageHours)} trước · ngoài máy ${b.offsite}` : b.state} · diễn tập: ${d.state === "OK" ? `${d.result} · ${age(d.ageHours)} trước${d.site ? ` · nơi chạy ${d.site}` : ""}` : d.state}`,
    `${p.org.code} · ${VERDICT_LABEL[p.verdict]}${p.verdict === "REFUSED" ? ` — ${p.refusals.map((r) => r.code).join(", ")}` : ""}`,
    ...(p.verdict === "REFUSED" ? p.refusals.map((r) => `${p.org.code} · TỪ CHỐI [${r.code}]: ${r.text}`) : []),
  ];
}

// ─────────────────────────── GHI ───────────────────────────

export type ArchiveResult =
  | { outcome: "NOT_FOUND" | "NOOP"; lines: string[] }
  | { outcome: "REFUSED"; lines: string[]; refusals: Refusal[] }
  | { outcome: "CHANGED_DURING_RUN"; lines: string[] }
  | { outcome: "DONE"; lines: string[] };

class ChangedDuringRun extends Error {
  constructor(readonly why: string) {
    super(why);
    this.name = "ChangedDuringRun";
  }
}

/** Lớp lỗi để ghi nhật ký — tên lớp, KHÔNG câu lỗi (câu lỗi có thể mang dữ liệu). */
const errorClass = (e: unknown) => (e instanceof Error ? e.name || "Error" : typeof e);

/** Đọc trạng thái + khoá dòng tổ chức trong giao dịch. */
async function lockedStatus(tx: Exec, id: string): Promise<string | null> {
  const [r] = rowsOf<{ status: string }>(await tx.execute(sql`select status from platform_organizations where id = ${id} for update`));
  return r?.status ?? null;
}

/**
 * LƯU TRỮ một tổ chức. Mọi điều kiện đọc lại ngay trước khi ghi; nghĩa vụ tiền + trạng thái đọc lại thêm một lần TRONG giao dịch sau
 * khi khoá dòng tổ chức. Đã ARCHIVED ⇒ `NOOP` (chạy lại vô hại). Đã ghi `archive:start` mà không tới `archive:done` ⇒ LUÔN có
 * `archive:stopped` (kể cả khi một lỗi bất ngờ ném lên).
 */
export async function applyArchive(code: string, opts: { confirm: string | null }, deps: LifecycleDeps & { hook?: () => Promise<void> } = {}): Promise<ArchiveResult> {
  const plan = await planLifecycle(code, deps);
  if (!plan) return { outcome: "NOT_FOUND", lines: [`${code} · không có tổ chức`] };
  if (plan.verdict === "ALREADY_ARCHIVED") return { outcome: "NOOP", lines: [`${code} · đã ARCHIVED — không làm gì`] };
  const refusals = [...plan.refusals];
  if (opts.confirm !== code) refusals.push({ code: "CONFIRM_MISMATCH", text: `--confirm phải ĐÚNG mã tổ chức (${code})` });
  if (refusals.length) return { outcome: "REFUSED", lines: refusals.map((r) => `${code} · TỪ CHỐI: ${r.text}`), refusals };

  const prior = plan.org.status;
  const before = {
    status: prior,
    kind: plan.kind,
    commercial: plan.commercial,
    commercialOpen: plan.commercialOpen,
    obligations: Object.fromEntries(plan.obligations.map((o) => [o.key, o.rows])),
    backup: { result: plan.backup.result, offsite: plan.backup.offsite, finishedAt: plan.backup.finishedAt?.toISOString() ?? null },
    drill: { result: plan.drill.result, finishedAt: plan.drill.finishedAt?.toISOString() ?? null, site: plan.drill.site },
    activity: plan.activity,
  };
  await platformAudit({ action: "ORG_ARCHIVE", targetOrgCode: code, subject: "archive:start", before, after: { phase: "STARTED" }, reason: ARCHIVE_REASON, source: "SCRIPT", actor: null });
  const lines = [`${code} · đã ghi nhật ký nền tảng ORG_ARCHIVE (archive:start)`];
  let done = false;
  let stopped: Record<string, unknown> = { error: "UNKNOWN" };
  try {
    await deps.hook?.();
    const pdb = await getPlatformDb();
    try {
      await pdb.transaction(async (tx) => {
        const status = await lockedStatus(tx, plan.org.id);
        if (status !== prior) throw new ChangedDuringRun(`trạng thái đổi giữa chừng (${prior} → ${status ?? "không còn"})`);
        const late = (await countObligations(tx, code)).filter((o) => o.rows > 0);
        if (late.length) throw new ChangedDuringRun(`nghĩa vụ tiền mới xuất hiện: ${late.map((o) => `${o.key} ${o.rows}`).join(" · ")}`);
        await tx.execute(sql`update platform_organizations set status = 'ARCHIVED', updated_at = now() where id = ${plan.org.id}`);
      });
    } catch (error) {
      if (!(error instanceof ChangedDuringRun)) throw error;
      stopped = { error: error.name, why: error.why };
      lines.push(`${code} · DỪNG — ${error.why}. Đã HOÀN TÁC, trạng thái giữ nguyên ${prior}.`);
      return { outcome: "CHANGED_DURING_RUN", lines };
    }
    invalidateOrganizations();
    invalidateCapabilities(code);
    await releaseOrganizationDb(code);
    // `before.status` của dòng này là TRẠNG THÁI CŨ mà lượt kích hoạt lại khôi phục (`priorStatusFromAudit`).
    await platformAudit({ action: "ORG_ARCHIVE", targetOrgCode: code, subject: "archive:done", before: { status: prior }, after: { status: "ARCHIVED" }, reason: ARCHIVE_REASON, source: "SCRIPT", actor: null });
    done = true;
  } catch (error) {
    stopped = { error: errorClass(error) };
    throw error;
  } finally {
    if (!done) {
      await platformAudit({ action: "ORG_ARCHIVE", targetOrgCode: code, subject: "archive:stopped", before: { status: prior }, after: stopped, reason: ARCHIVE_REASON, source: "SCRIPT", actor: null }).catch(() => undefined);
    }
  }
  lines.push(`${code} · ${prior} → ARCHIVED · không xoá dữ liệu, không DROP · ứng dụng thôi phục vụ trong ≤ 10 giây (đệm sổ) · sao lưu đêm / mỗi giờ VẪN chạy cho CSDL này · kích hoạt lại sẽ về ${prior}`);
  if (plan.activity.messengerPages) lines.push(`${code} · ${plan.activity.messengerPages} page Meta vẫn trỏ về tổ chức — tin tới bị bỏ qua (HTTP 200, tổ chức không hoạt động); KHÔNG gỡ đăng ký để kích hoạt lại không mất kênh`);
  return { outcome: "DONE", lines };
}

/** Lối DUY NHẤT mở CSDL của một tổ chức ARCHIVED bằng đường migrate của ứng dụng — chỉ lượt kích hoạt lại gọi. */
export function openForReactivation(code: string): Promise<Db> {
  return getDbFor({ code, isHome: false }, { reactivation: true });
}

/** Trạng thái trước khi lưu trữ, đọc từ `archive:done` GẦN NHẤT của tổ chức. `null` = không có / không đọc được. */
export async function priorStatusFromAudit(exec: Exec, code: string): Promise<string | null> {
  try {
    const [r] = rowsOf<{ s: string | null }>(
      await exec.execute(sql`select before->>'status' as s from platform_audit_log where target_org_code = ${code} and action = 'ORG_ARCHIVE' and subject = 'archive:done' order by at desc, id desc limit 1`),
    );
    return r?.s ?? null;
  } catch {
    return null;
  }
}

export type ReactivateVerify = (code: string) => Promise<{ status: "OK" | "MISSING" | "DEGRADED" | "ERROR" | "TIMEOUT"; detail?: string }>;

export type ReactivateResult =
  | { outcome: "NOT_FOUND"; lines: string[] }
  | { outcome: "REFUSED"; lines: string[]; refusals: Refusal[] }
  | { outcome: "VERIFY_FAILED"; lines: string[]; detail: string | null }
  | { outcome: "CHANGED_DURING_RUN"; lines: string[] }
  | { outcome: "DONE"; lines: string[]; status: RestorableStatus; fallback: boolean };

/**
 * KÍCH HOẠT LẠI: tổ chức phải ARCHIVED; `verify` mở CSDL qua `openForReactivation` (migrate) và đối chiếu sổ migration như bước kiểm
 * deploy. Chỉ `OK` mới đổi trạng thái — về ĐÚNG trạng thái trước khi lưu trữ (`restoreStatusFor`) trong giao dịch, sau khi khoá dòng và
 * thấy vẫn ARCHIVED. Mọi kết quả khác ⇒ VẪN ARCHIVED. Đã ghi `reactivate:start` mà không tới `done` ⇒ LUÔN có `reactivate:stopped`.
 */
export async function applyReactivate(code: string, opts: { confirm: string | null }, deps: { verify: ReactivateVerify }): Promise<ReactivateResult> {
  const pdb = await getPlatformDb();
  const [row] = rowsOf<{ id: string; status: string; is_home: boolean }>(await pdb.execute(sql`select id, status, is_home from platform_organizations where code = ${code} limit 1`));
  if (!row) return { outcome: "NOT_FOUND", lines: [`${code} · không có tổ chức`] };
  const refusals = reactivateRefusals({ isHome: Boolean(row.is_home), status: row.status });
  if (opts.confirm !== code) refusals.push({ code: "CONFIRM_MISMATCH", text: `--confirm phải ĐÚNG mã tổ chức (${code})` });
  if (refusals.length) return { outcome: "REFUSED", lines: refusals.map((r) => `${code} · TỪ CHỐI: ${r.text}`), refusals };

  const prior = await priorStatusFromAudit(pdb, code);
  const target = restoreStatusFor(prior);
  await platformAudit({ action: "ORG_REACTIVATE", targetOrgCode: code, subject: "reactivate:start", before: { status: "ARCHIVED", prior }, after: { phase: "MIGRATE_VERIFY", target: target.status, fallback: target.fallback }, reason: REACTIVATE_REASON, source: "SCRIPT", actor: null });
  const lines = [`${code} · đã ghi nhật ký nền tảng ORG_REACTIVATE (reactivate:start) — migrate + đối chiếu sổ khi tổ chức VẪN ARCHIVED`];
  if (target.fallback) lines.push(`${code} · KHÔNG đọc được trạng thái trước khi lưu trữ (không có nhật ký archive:done hợp lệ) ⇒ nếu đối chiếu đạt sẽ về SUSPENDED (phía hẹp hơn) — bật lại bằng công tắc ở /platform/org khi chắc chắn`);
  let done = false;
  let stopped: Record<string, unknown> = { error: "UNKNOWN" };
  try {
    invalidateOrganizations();
    const v = await deps.verify(code).catch((e: unknown) => ({ status: "ERROR" as const, detail: e instanceof Error ? e.message : String(e) }));
    if (v.status !== "OK") {
      await releaseOrganizationDb(code);
      stopped = { verify: v.status };
      lines.push(`${code} · đối chiếu migration KHÔNG ĐẠT (${v.status}) — VẪN ARCHIVED, không phục vụ khách. Chi tiết ở phần mã hoá.`);
      return { outcome: "VERIFY_FAILED", lines, detail: v.detail?.slice(0, 500) ?? null };
    }
    try {
      await pdb.transaction(async (tx) => {
        const status = await lockedStatus(tx, row.id);
        if (status !== "ARCHIVED") throw new ChangedDuringRun(`trạng thái đổi giữa chừng (ARCHIVED → ${status ?? "không còn"})`);
        await tx.execute(sql`update platform_organizations set status = ${target.status}, updated_at = now() where id = ${row.id}`);
      });
    } catch (error) {
      if (!(error instanceof ChangedDuringRun)) throw error;
      stopped = { error: error.name, why: error.why };
      lines.push(`${code} · DỪNG — ${error.why}.`);
      return { outcome: "CHANGED_DURING_RUN", lines };
    }
    invalidateOrganizations();
    invalidateCapabilities(code);
    await releaseOrganizationDb(code);
    await platformAudit({ action: "ORG_REACTIVATE", targetOrgCode: code, subject: "reactivate:done", before: { status: "ARCHIVED", prior }, after: { status: target.status, fallback: target.fallback }, reason: REACTIVATE_REASON, source: "SCRIPT", actor: null });
    done = true;
  } catch (error) {
    stopped = { error: errorClass(error) };
    throw error;
  } finally {
    if (!done) {
      await platformAudit({ action: "ORG_REACTIVATE", targetOrgCode: code, subject: "reactivate:stopped", before: { status: "ARCHIVED", prior }, after: stopped, reason: REACTIVATE_REASON, source: "SCRIPT", actor: null }).catch(() => undefined);
    }
  }
  lines.push(
    target.status === "ACTIVE"
      ? `${code} · migration khớp sổ ⇒ ARCHIVED → ACTIVE · ứng dụng nhận tổ chức trong ≤ 10 giây (đệm sổ); bộ lập lịch + bước kiểm deploy đi lại tổ chức này`
      : `${code} · migration khớp sổ ⇒ ARCHIVED → SUSPENDED${target.fallback ? " (mặc định hẹp — không đọc được trạng thái cũ)" : " (đúng trạng thái trước khi lưu trữ)"} · vẫn KHÔNG phục vụ khách; bật bằng công tắc ở /platform/org`,
  );
  return { outcome: "DONE", lines, status: target.status, fallback: target.fallback };
}
