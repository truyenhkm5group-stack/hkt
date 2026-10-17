/*
  ops `org-lifecycle` — LƯU TRỮ / KÍCH HOẠT LẠI MỘT TỔ CHỨC (quyết định của chủ shop 17/10/2026: workspace THỬ không dùng — `qa`, `test-shop`,
  `q-store` — được LƯU TRỮ, KHÔNG XOÁ; nhà, khách HSLC, `vnx`, workspace nghiệm thu SaaS giữ ACTIVE). Lõi + lý do: lib/platform/org-lifecycle.ts,
  ba chiều trạng thái: docs/tenant-lifecycle.md.

  CẦN DEPLOY TRƯỚC: script lấy từ `main`, còn lib/ lấy từ image đang chạy — lõi lib/platform/org-lifecycle.ts + chốt lưu trữ của getDbFor phải
  đã lên image thì script mới nạp được.

  Bốn chế độ — ô arg chỉ nhận chữ / số / khoảng trắng / = : . _ , / @ + -; cờ lạ / thiếu / thừa ⇒ lỗi cách dùng (mã 64), không đoán:
   · (rỗng)                                         CHẠY THỬ MỌI tổ chức (CHỈ ĐỌC — Postgres ép, hỏi lại trước khi đọc): mỗi tổ chức BA chiều
                                                    trạng thái (vận hành · thương mại · triển khai), loại, nghĩa vụ tiền, sao lưu + diễn tập
                                                    gần nhất, phán quyết LƯU TRỮ ĐƯỢC / TỪ CHỐI (lý do).
   · `<mã>`                                         CHẠY THỬ MỘT tổ chức (như trên, kèm chi tiết ở phần mã hoá).
   · `<mã> --archive --apply --confirm=<mã>`        LƯU TRỮ: chỉ khi không nhà · không nghiệm thu · không nghĩa vụ tiền · bản sao lưu OK + ngoài máy
                                                    ≤ 26 giờ · diễn tập khôi phục OK ≤ 72 giờ của CHÍNH CSDL này. Không xoá, không DROP.
   · `<mã> --reactivate --apply --confirm=<mã> [--timeout=<giây>]`
                                                    KÍCH HOẠT LẠI tổ chức ARCHIVED: migrate + đối chiếu sổ migration bằng CHÍNH checkDb của bước
                                                    kiểm deploy (scripts/verify-migrations.ts), CHỈ KHỚP mới đặt ACTIVE; không khớp / hết giờ /
                                                    DEGRADED ⇒ VẪN ARCHIVED. `--timeout` = trần migrate (mặc định như bước kiểm, tối đa 900).
  `--archive` / `--reactivate` thiếu `--apply` ⇒ chạy thử MỘT tổ chức cho đúng hành động đó (chỉ đọc).

  Cả lượt chạy trong `ma_hoa_ket_qua`: dòng `[ops:tom-tat] ` (log công khai — kho PUBLIC) chỉ mang mã tổ chức, trạng thái, số đếm, mốc,
  phán quyết; không tên cửa hàng, email, SĐT, mã page, tên tệp sao lưu.

  Mã thoát: 0 xong / chạy thử · 64 cách dùng sai · 65 TỪ CHỐI · 66 đổi giữa chừng (tiền mới / trạng thái đổi) · 67 đối chiếu migration không
  đạt (vẫn ARCHIVED) · 70 lượt chạy thử mà kết nối không ở chế độ chỉ đọc.
*/
const ARGS = process.argv.slice(2);
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("org-lifecycle.ts"));
const CO_GHI = ARGS.includes("--apply");
if (CHAY_THANG && !CO_GHI) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { sql } from "drizzle-orm";
import { cancelOrganizationMigration, getDbForInspection, getPlatformDb, organizationMigrationDegraded, releaseOrganizationDb, type Db } from "@/db";
import { listOrganizations } from "@/lib/platform/organizations";
import { applyArchive, applyReactivate, lifecyclePlanLines, openForReactivation, planLifecycle, reactivateRefusals, type ReactivateVerify } from "@/lib/platform/org-lifecycle";
import { ORGANIZATION_CODE_PATTERN } from "@/lib/platform/types";
import { rowsOf } from "@/lib/sql-rows";
import { checkDb, readJournalEntries, verifyOrganizations, verifyOrgTimeoutMs } from "./verify-migrations";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export type LifecycleArgs =
  | { ok: true; mode: "LIST" }
  | { ok: true; mode: "PLAN"; code: string; action: "ARCHIVE" | "REACTIVATE" | null }
  | { ok: true; mode: "ARCHIVE"; code: string; confirm: string }
  | { ok: true; mode: "REACTIVATE"; code: string; confirm: string; timeoutMs: number | null }
  | { ok: false; error: string };

/** Ô arg ⇒ chế độ. Thông điệp lỗi KHÔNG lặp lại giá trị đã gõ. */
export function parseLifecycleArgs(args: readonly string[]): LifecycleArgs {
  const positional = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (positional.length > 1) return { ok: false, error: "chỉ nhận MỘT mã tổ chức mỗi lượt" };
  const known = (f: string) => f === "--apply" || f === "--archive" || f === "--reactivate" || f.startsWith("--confirm=") || f.startsWith("--timeout=");
  if (flags.some((f) => !known(f))) return { ok: false, error: "cờ lạ — chỉ nhận --archive, --reactivate, --apply, --confirm=<mã>, --timeout=<giây>" };
  if (new Set(flags.map((f) => f.split("=")[0])).size !== flags.length) return { ok: false, error: "mỗi cờ chỉ một lần" };
  if (!positional.length) {
    if (flags.length) return { ok: false, error: "cờ chỉ đi cùng MỘT mã tổ chức" };
    return { ok: true, mode: "LIST" };
  }
  const code = positional[0];
  if (!ORGANIZATION_CODE_PATTERN.test(code)) return { ok: false, error: "mã tổ chức không đúng dạng (chữ thường, số, gạch ngang; bắt đầu bằng chữ)" };
  const archive = flags.includes("--archive");
  const reactivate = flags.includes("--reactivate");
  if (archive && reactivate) return { ok: false, error: "--archive và --reactivate không đi cùng nhau" };
  const apply = flags.includes("--apply");
  const confirm = flags.find((f) => f.startsWith("--confirm="))?.slice("--confirm=".length);
  const timeoutRaw = flags.find((f) => f.startsWith("--timeout="))?.slice("--timeout=".length);
  if (timeoutRaw !== undefined && !reactivate) return { ok: false, error: "--timeout chỉ đi cùng --reactivate" };
  if (!apply) {
    if (confirm !== undefined || timeoutRaw !== undefined) return { ok: false, error: "--confirm / --timeout chỉ đi cùng --apply" };
    return { ok: true, mode: "PLAN", code, action: archive ? "ARCHIVE" : reactivate ? "REACTIVATE" : null };
  }
  if (!archive && !reactivate) return { ok: false, error: "--apply phải kèm ĐÚNG MỘT hành động: --archive hoặc --reactivate" };
  if (confirm === undefined || confirm === "") return { ok: false, error: "--apply bắt buộc --confirm=<mã tổ chức>" };
  if (archive) return { ok: true, mode: "ARCHIVE", code, confirm };
  let timeoutMs: number | null = null;
  if (timeoutRaw !== undefined) {
    if (!/^\d{1,3}$/.test(timeoutRaw) || Number(timeoutRaw) < 10 || Number(timeoutRaw) > 900) return { ok: false, error: "--timeout phải là số giây 10–900" };
    timeoutMs = Number(timeoutRaw) * 1000;
  }
  return { ok: true, mode: "REACTIVATE", code, confirm, timeoutMs };
}

// ─────────────────────────── CHIỀU TRIỂN KHAI — CHỈ ĐỌC ───────────────────────────

/** Sổ migration của CSDL tổ chức so với mã nguồn, qua handle CHỈ ĐỌC (không migrate). Chỉ để in — chiều TRIỂN KHAI. */
async function deploymentState(code: string): Promise<string> {
  try {
    const db = await getDbForInspection({ code, isHome: false });
    const missing = await checkDb(`tổ chức «${code}» (chỉ đọc)`, db, readJournalEntries());
    return missing === 0 ? "khớp sổ migration" : `thiếu ${missing} migration`;
  } catch (e) {
    console.log(`Không đo được sổ migration của ${code}: ${errorText(e)}`);
    return "không đo được";
  } finally {
    await releaseOrganizationDb(code, { inspectionOnly: true }).catch(() => undefined);
  }
}

async function planOne(code: string, isHome: boolean): Promise<"ARCHIVABLE" | "OTHER" | "GONE"> {
  const plan = await planLifecycle(code);
  if (!plan) {
    tomTat(`${code} · không có tổ chức`);
    return "GONE";
  }
  const deployment = isHome ? "nhà — bước kiểm deploy đo riêng" : await deploymentState(code);
  for (const l of lifecyclePlanLines(plan, deployment)) tomTat(l);
  return plan.verdict === "ARCHIVABLE" ? "ARCHIVABLE" : "OTHER";
}

async function readOnlyGuard(pdb: Db): Promise<boolean> {
  const [ro] = rowsOf<Record<string, unknown>>(await pdb.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") === "on") return true;
  tomTat("DỪNG: kết nối CSDL nền tảng KHÔNG ở chế độ chỉ đọc — lượt chạy thử không đọc gì");
  return false;
}

/** Đối chiếu sổ migration cho lượt kích hoạt lại: ĐÚNG `verifyOrganizations` + `checkDb` của bước kiểm deploy, mở bằng lối kích hoạt lại. */
function reactivationVerify(timeoutMs: number | null): ReactivateVerify {
  return async (code) => {
    const entries = readJournalEntries();
    const [r] = await verifyOrganizations([code], {
      open: (c) => openForReactivation(c),
      check: (c, db, openedSeconds) => checkDb(`tổ chức «${c}» (kích hoạt lại, ${openedSeconds.toFixed(1)} giây)`, db, entries),
      cancel: (c) => cancelOrganizationMigration(c),
      degraded: (c) => organizationMigrationDegraded(c),
      timeoutMs: timeoutMs ?? verifyOrgTimeoutMs(),
    });
    return { status: r?.status ?? "ERROR", detail: r?.detail };
  };
}

async function main(): Promise<number> {
  const a = parseLifecycleArgs(ARGS);
  if (!a.ok) {
    tomTat(`Cách dùng sai: ${a.error} — arg: (rỗng) | <mã> [--archive|--reactivate] | <mã> --archive --apply --confirm=<mã> | <mã> --reactivate --apply --confirm=<mã> [--timeout=<giây>]`);
    return 64;
  }
  const pdb = await getPlatformDb();
  const ghi = a.mode === "ARCHIVE" || a.mode === "REACTIVATE";
  if (!ghi && !(await readOnlyGuard(pdb))) return 70;

  if (a.mode === "LIST") {
    tomTat("CHẠY THỬ mọi tổ chức — CHỈ ĐỌC, không ghi gì");
    const orgs = await listOrganizations();
    let archivable = 0;
    for (const o of orgs) if ((await planOne(o.code, o.isHome)) === "ARCHIVABLE") archivable += 1;
    tomTat(`Tổng: ${orgs.length} tổ chức · ${archivable} LƯU TRỮ ĐƯỢC · ${orgs.filter((o) => o.status === "ARCHIVED").length} đã lưu trữ`);
    return 0;
  }
  if (a.mode === "PLAN") {
    tomTat(`CHẠY THỬ ${a.code}${a.action ? ` (${a.action === "ARCHIVE" ? "lưu trữ" : "kích hoạt lại"})` : ""} — CHỈ ĐỌC, không ghi gì`);
    const org = (await listOrganizations()).find((o) => o.code === a.code);
    await planOne(a.code, org?.isHome ?? false);
    if (a.action === "REACTIVATE" && org) {
      const r = reactivateRefusals(org);
      tomTat(r.length ? `${a.code} · KHÔNG kích hoạt lại được — ${r.map((x) => x.text).join(" · ")}` : `${a.code} · KÍCH HOẠT LẠI ĐƯỢC: --apply sẽ migrate rồi đối chiếu sổ; chỉ khớp mới đặt ACTIVE`);
    }
    return 0;
  }
  if (a.mode === "ARCHIVE") {
    tomTat(`LƯU TRỮ ${a.code} — GHI (chỉ cột trạng thái + nhật ký nền tảng)`);
    const r = await applyArchive(a.code, { confirm: a.confirm });
    for (const l of r.lines) tomTat(l);
    if (r.outcome === "REFUSED" || r.outcome === "NOT_FOUND") return 65;
    if (r.outcome === "CHANGED_DURING_RUN") return 66;
    return 0;
  }
  tomTat(`KÍCH HOẠT LẠI ${a.code} — GHI (migrate CSDL tổ chức, rồi cột trạng thái + nhật ký nền tảng)`);
  const r = await applyReactivate(a.code, { confirm: a.confirm }, { verify: reactivationVerify(a.timeoutMs) });
  for (const l of r.lines) tomTat(l);
  if (r.outcome === "VERIFY_FAILED" && r.detail) console.log(`Chi tiết đối chiếu: ${r.detail}`);
  if (r.outcome === "REFUSED" || r.outcome === "NOT_FOUND") return 65;
  if (r.outcome === "CHANGED_DURING_RUN") return 66;
  if (r.outcome === "VERIFY_FAILED") return 67;
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
