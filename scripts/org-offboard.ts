/*
  ops `org-offboard` — XOÁ MỘT WORKSPACE TỰ ĐĂNG KÝ (quyết định của chủ shop 08/10/2026: các cửa hàng trước đây tự đăng ký bị xoá hết để
  họ đăng ký lại từ đầu khi hệ thống sẵn sàng; nhà và tổ chức người vận hành tạo — gồm khách thật — TUYỆT ĐỐI không đụng).

  Ba chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thiếu / thừa ⇒ lỗi cách dùng (mã 64), không đoán:
   · (rỗng)                              CHẠY THỬ MỌI tổ chức (CHỈ ĐỌC — Postgres ép, hỏi lại trước khi đọc): loại (NHÀ · TỰ ĐĂNG KÝ ·
                                         NGƯỜI VẬN HÀNH TẠO · CHƯA XÁC MINH), chứng cứ, số dòng sẽ xoá / giữ theo bảng, CSDL, sổ tiền, page
                                         Meta, kết nối đang bật, phán quyết + lý do từ chối. Kèm mốc sao lưu / PITR gần nhất.
   · `<mã>`                              CHẠY THỬ MỘT tổ chức, chi tiết hơn (phần mã hoá: tài khoản thương mại, CSDL tổ chức, sổ AI).
   · `<mã> --apply --confirm=<mã> --created-before=<ISO> [--allow-active] [--wait=<giây>]`
                                         XOÁ — chỉ khi: không phải nhà · brand khác NULL · có chứng cứ TỰ đăng ký và không dấu hiệu người
                                         vận hành · không một dòng tiền thật (cả hoá đơn MỞ / phiếu nạp còn hạn) · `--confirm` ĐÚNG mã · tổ
                                         chức TẠO trước `--created-before` (bắt buộc — «cửa hàng TRƯỚC ĐÂY» phải là một mốc khai rõ). Tổ chức
                                         có đơn / kết nối / page đang bật (hoặc CSDL không đọc được) cần thêm `--allow-active`. Tiền đếm lại
                                         ngay trước DROP và trong giao dịch xoá — tiền về giữa chừng ⇒ DỪNG (mã 66). Thứ tự + lý do:
                                         lib/platform/offboard.ts. `--wait` = trần chờ kết nối của ứng dụng tự rã (mặc định 60, tối đa 600).

  Sao lưu: script KHÔNG chặn vì thiếu bản sao (chủ shop đã quyết) — nó IN mốc sao lưu gần nhất của nhà + của CSDL tổ chức (tệp trạng thái
  của scripts/erp-backup.sh, mount chỉ-đọc ở /erp-backup-status) và PITR của cụm erp-db (pg_stat_archiver — cụm chứa cả CSDL tổ chức);
  không đọc được ⇒ in CẢNH BÁO. Khuyến nghị: chạy ops `backup` ngay trước lượt `--apply`.

  Cả lượt chạy trong `ma_hoa_ket_qua`: dòng `[ops:tom-tat] ` (log công khai — kho PUBLIC) chỉ mang mã tổ chức, loại, số đếm, phán quyết;
  không tên cửa hàng, email, SĐT, mã page.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-offboard.ts"));
const CO_GHI = ARGS.includes("--apply");
if (CHAY_THANG && !CO_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDbForInspection, getPlatformDb, isPglite, type Db } from "@/db";
import { evaluateBackupHealth, HOME_BACKUP_TARGET, type BackupHealth } from "@/lib/constants/backup";
import { pageTokensForOffboard } from "@/lib/connectors/service";
import { messengerApp, unsubscribePage } from "@/lib/integrations/messenger/graph";
import { listOrganizations } from "@/lib/platform/organizations";
import { applyOffboard, OFFBOARD_CONNECTION_WAIT_MS, offboardPlanLines, planOffboard, type OffboardDeps } from "@/lib/platform/offboard";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { backupStatusDir, backupTargetFor, readBackupStatusFiles } from "@/lib/queries/backup-status";
import { MESSENGER_CONNECTOR } from "@/lib/sales-chatbot/messenger";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export type OffboardArgs =
  | { ok: true; mode: "LIST" }
  | { ok: true; mode: "PLAN"; code: string }
  | { ok: true; mode: "APPLY"; code: string; confirm: string; createdBefore: Date; allowActive: boolean; waitMs: number }
  | { ok: false; error: string };

/** Ô arg ⇒ chế độ. Thông điệp lỗi KHÔNG lặp lại giá trị đã gõ. */
export function parseOffboardArgs(args: readonly string[]): OffboardArgs {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (positional.length > 1) return { ok: false, error: "chỉ nhận MỘT mã tổ chức mỗi lượt" };
  const known = (f: string) => f === "--apply" || f === "--allow-active" || f.startsWith("--confirm=") || f.startsWith("--wait=") || f.startsWith("--created-before=");
  if (flags.some((f) => !known(f))) return { ok: false, error: "cờ lạ — chỉ nhận --apply, --confirm=<mã>, --created-before=<ISO>, --allow-active, --wait=<giây>" };
  if (new Set(flags.map((f) => f.split("=")[0])).size !== flags.length) return { ok: false, error: "mỗi cờ chỉ một lần" };
  const apply = flags.includes("--apply");
  const confirm = flags.find((f) => f.startsWith("--confirm="))?.slice("--confirm=".length);
  const waitRaw = flags.find((f) => f.startsWith("--wait="))?.slice("--wait=".length);
  const beforeRaw = flags.find((f) => f.startsWith("--created-before="))?.slice("--created-before=".length);
  const allowActive = flags.includes("--allow-active");
  if (!positional.length) {
    if (flags.length) return { ok: false, error: "cờ chỉ đi cùng MỘT mã tổ chức" };
    return { ok: true, mode: "LIST" };
  }
  const code = positional[0];
  if (!ORGANIZATION_CODE_PATTERN.test(code)) return { ok: false, error: "mã tổ chức không đúng dạng (chữ thường, số, gạch ngang; bắt đầu bằng chữ)" };
  if (!apply) {
    if (confirm !== undefined || waitRaw !== undefined || beforeRaw !== undefined || allowActive) return { ok: false, error: "--confirm / --created-before / --allow-active / --wait chỉ đi cùng --apply" };
    return { ok: true, mode: "PLAN", code };
  }
  if (confirm === undefined || confirm === "") return { ok: false, error: "--apply bắt buộc --confirm=<mã tổ chức>" };
  if (beforeRaw === undefined) return { ok: false, error: "--apply bắt buộc --created-before=<ISO> (chỉ xoá tổ chức tạo TRƯỚC mốc này)" };
  const createdBefore = new Date(beforeRaw);
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(beforeRaw) || Number.isNaN(createdBefore.getTime())) return { ok: false, error: "--created-before phải là mốc ISO, ví dụ 2026-10-08T00:00:00Z" };
  let waitMs = OFFBOARD_CONNECTION_WAIT_MS;
  if (waitRaw !== undefined) {
    if (!/^\d{1,3}$/.test(waitRaw) || Number(waitRaw) > 600) return { ok: false, error: "--wait phải là số giây 0–600" };
    waitMs = Number(waitRaw) * 1000;
  }
  return { ok: true, mode: "APPLY", code, confirm, createdBefore, allowActive, waitMs };
}

// ─────────────────────────── SAO LƯU: IN, KHÔNG CHẶN ───────────────────────────

export type PitrFacts = { ok: true; lastArchivedAt: Date | null; failedCount: number } | { ok: false; reason: string };

/** Hàm THUẦN: dòng sao lưu. Không có bản / không đọc được ⇒ CẢNH BÁO, không bao giờ chặn (chủ shop đã quyết). */
export function backupLines(home: BackupHealth | null, org: BackupHealth | null, pitr: PitrFacts, now: Date, orgCode: string | null): string[] {
  const one = (label: string, h: BackupHealth | null) => {
    if (!h) return `${label}: không đọc được tệp trạng thái — CẢNH BÁO: không xác nhận được có bản sao lưu`;
    if (!h.lastSuccess) return `${label}: CHƯA CÓ bản sao lưu thành công nào — CẢNH BÁO (${h.reason})`;
    return `${label}: bản thành công gần nhất ${h.lastSuccess.finishedAt.toISOString()} (${h.ageHours === null ? "—" : `${Math.round(h.ageHours * 10) / 10} giờ trước`}) · ${h.state}`;
  };
  const out = [one("Sao lưu CSDL nhà", home)];
  if (orgCode) out.push(one(`Sao lưu CSDL tổ chức ${orgCode}`, org));
  if (!pitr.ok) out.push(`PITR cụm erp-db: không đọc được (${pitr.reason}) — CẢNH BÁO`);
  else if (!pitr.lastArchivedAt) out.push("PITR cụm erp-db: chưa lưu đoạn WAL nào — CẢNH BÁO");
  else out.push(`PITR cụm erp-db (gồm CSDL tổ chức): đoạn WAL gần nhất ${pitr.lastArchivedAt.toISOString()} (${Math.round((now.getTime() - pitr.lastArchivedAt.getTime()) / 60_000)} phút trước) · lỗi lưu ${pitr.failedCount}`);
  out.push("Khuyến nghị: chạy ops `backup` ngay trước lượt --apply (không bắt buộc).");
  return out;
}

async function readHealth(target: Parameters<typeof readBackupStatusFiles>[1]): Promise<BackupHealth | null> {
  try {
    const files = await readBackupStatusFiles(backupStatusDir(), target);
    return files.dirReadable ? evaluateBackupHealth(files, new Date(), target) : null;
  } catch {
    return null;
  }
}

async function readPitr(pdb: Db): Promise<PitrFacts> {
  if (isPglite()) return { ok: false, reason: "PGlite — không có PITR" };
  try {
    const [r] = rowsOf<{ at: Date | string | null; failed: number | string }>(await pdb.execute(sql`select last_archived_time as at, failed_count as failed from pg_stat_archiver`));
    return { ok: true, lastArchivedAt: r?.at ? new Date(r.at) : null, failedCount: Number(r?.failed ?? 0) };
  } catch (e) {
    return { ok: false, reason: errorText(e).slice(0, 120) };
  }
}

async function printBackup(pdb: Db, orgCode: string | null) {
  const home = await readHealth(HOME_BACKUP_TARGET);
  const org = orgCode ? await readHealth(backupTargetFor({ code: orgCode, isHome: false })) : null;
  for (const l of backupLines(home, org, await readPitr(pdb), new Date(), orgCode)) tomTat(l);
}

// ─────────────────────────── GỠ ĐĂNG KÝ WEBHOOK META (best effort) ───────────────────────────

/**
 * Gỡ app nền tảng khỏi các PAGE Facebook (Instagram đi theo page cha — bỏ qua) bằng token page đọc từ CSDL của tổ chức qua handle CHỈ ĐỌC
 * (`getDbForInspection` + `pageTokensForOffboard`) — KHÔNG cần tổ chức còn ACTIVE. ĐÚNG hàm `unsubscribePage` của nút «Gỡ page». Không có
 * app Meta / không có token / Meta từ chối ⇒ đếm «không» (⇒ «cần gỡ tay»), không chặn. Câu lỗi chỉ vào `note` (phần mã hoá).
 */
async function unsubscribeMetaReal(code: string, pageIds: readonly string[]): Promise<{ ok: number; failed: number; note: string | null }> {
  const app = messengerApp();
  if (!app) return { ok: 0, failed: pageIds.length, note: "máy chủ không khai app Meta" };
  const db = await getDbForInspection({ code, isHome: false });
  const { tokens, instagram } = await pageTokensForOffboard(db, code, MESSENGER_CONNECTOR);
  let ok = 0;
  let failed = 0;
  const notes: string[] = [];
  for (const id of pageIds) {
    if (instagram.has(id)) continue;
    const token = tokens.get(id);
    if (!token) {
      failed += 1;
      notes.push(`${id}: không có token`);
      continue;
    }
    const r = await unsubscribePage(app, id, token);
    if (r.ok) ok += 1;
    else {
      failed += 1;
      notes.push(`${id}: ${r.error}`);
    }
  }
  return { ok, failed, note: [instagram.size ? `${instagram.size} tài khoản Instagram đi theo page cha` : "", ...notes].filter(Boolean).join(" · ") || null };
}

// ─────────────────────────── BA CHẾ ĐỘ ───────────────────────────

async function readOnlyGuard(pdb: Db): Promise<boolean> {
  const [ro] = rowsOf<Record<string, unknown>>(await pdb.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") === "on") return true;
  tomTat("DỪNG: kết nối CSDL nền tảng KHÔNG ở chế độ chỉ đọc — lượt chạy thử không đọc gì");
  return false;
}

async function planOne(code: string, detail: boolean): Promise<"GONE" | "OK" | "REFUSED"> {
  const plan = await planOffboard(code);
  if (!plan) {
    tomTat(`${code} · không có tổ chức`);
    return "GONE";
  }
  const lines = offboardPlanLines(plan);
  for (const l of lines.summary) tomTat(l);
  if (detail) for (const l of lines.detail) console.log(l);
  return plan.refusals.length ? "REFUSED" : "OK";
}

async function main(): Promise<number> {
  const a = parseOffboardArgs(ARGS);
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: (rỗng) | <mã> | <mã> --apply --confirm=<mã> --created-before=<ISO> [--allow-active] [--wait=<giây>]`);
    return 64;
  }
  const pdb = await getPlatformDb();
  if (a.mode !== "APPLY" && !(await readOnlyGuard(pdb))) return 70;

  if (a.mode === "LIST") {
    tomTat("CHẠY THỬ mọi tổ chức — CHỈ ĐỌC, không ghi gì");
    const orgs = await listOrganizations();
    let ok = 0;
    for (const o of orgs) if ((await planOne(o.code, false)) === "OK") ok += 1;
    tomTat(`Tổng: ${orgs.length} tổ chức · ${ok} XOÁ ĐƯỢC · ${orgs.length - ok} KHÔNG xoá`);
    await printBackup(pdb, null);
    return 0;
  }
  if (a.mode === "PLAN") {
    tomTat(`CHẠY THỬ ${a.code} — CHỈ ĐỌC, không ghi gì`);
    await planOne(a.code, true);
    await printBackup(pdb, a.code);
    return 0;
  }

  tomTat(`XOÁ ${a.code} — GHI`);
  await printBackup(pdb, a.code);
  const deps: OffboardDeps = { unsubscribeMeta: unsubscribeMetaReal, connectionWaitMs: a.waitMs };
  const r = await applyOffboard(a.code, { confirm: a.confirm, createdBefore: a.createdBefore, allowActive: a.allowActive }, deps);
  for (const l of r.lines) tomTat(l);
  for (const l of r.detail) console.log(l);
  if (r.outcome === "REFUSED") return 65;
  if (r.outcome === "MONEY_ARRIVED") return 66;
  if (r.outcome === "WAITING_CONNECTIONS") return 75;
  if (r.outcome === "DONE" && Object.values(r.remaining).some((n) => n > 0)) return 1;
  return 0;
}

if (CHAY_THANG) {
  main()
    .then((rc) => process.exit(rc))
    .catch((e) => {
      // Câu lỗi có thể mang dữ liệu ⇒ chỉ ở phần MÃ HOÁ; log công khai chỉ biết là có lỗi.
      console.log(`LỖI: ${errorText(e)}`);
      tomTat("LỖI — chi tiết trong phần mã hoá");
      process.exit(1);
    });
}
