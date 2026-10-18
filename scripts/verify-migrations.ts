/**
 * ═══════════ MIGRATION KHÔNG ĐƯỢC BỎ QUA TRONG IM LẶNG ═══════════
 *
 * Chạy SAU khi ứng dụng đã khởi động (migration tự áp lúc khởi động), TRÊN CHÍNH cơ sở dữ liệu
 * thật. Trả lời đúng một câu hỏi: **mọi mục trong sổ migration đã thực sự được áp chưa?**
 *
 * VÌ SAO KHÔNG BÀI KIỂM NÀO KHÁC BẮT ĐƯỢC:
 *
 * `drizzle` chỉ áp migration có mốc `when` MUỘN HƠN mốc lớn nhất đã áp. Một mục có mốc cũ hơn
 * sẽ bị bỏ qua **vĩnh viễn** — không lỗi, không cảnh báo. Mọi bài kiểm hiện có (kể cả
 * `scripts/bench/migration-verify.ts`) đều dựng cơ sở dữ liệu MỚI TỪ ĐẦU; từ CSDL trống thì
 * mọi migration đều áp theo thứ tự mảng bất kể mốc, nên lỗi này **không thể hiện ra**.
 * Nó chỉ hiện trên một cơ sở dữ liệu ĐÃ chạy — tức là chỉ trên production.
 *
 * ĐÃ XẢY RA HAI LẦN, 09/09/2026:
 *   - `0038_fb_ads_post_link` bị bỏ qua ⇒ `ERROR: column fa.post_id does not exist`, trang
 *     Quảng cáo lỗi trên production trong khi typecheck/test/build đều xanh.
 *   - `0041_shipment_return_leg_index` (mốc 1788940601682) vào kho SAU khi production đã áp
 *     `0042_bank_ledger` (mốc 1788945576898) ⇒ index sửa lỗi quét O(n²) sẽ không bao giờ được
 *     tạo, và bản phát hành hiệu năng vẫn báo deploy thành công.
 *
 * ═══ CSDL CỦA TỔ CHỨC KHÁCH (docs/platform/scale-plan.md, ngưỡng 0 · việc B) ═══
 *
 * CSDL tổ chức khách migrate LƯỜI — lần đầu một tiến trình mở nó. Không có bước này thì sau mỗi lần deploy, request đầu
 * tiên của MỖI khách gánh cả lượt migrate, và một tổ chức migrate hỏng chỉ lộ ra khi khách chạm vào. Nên sau khi kiểm CSDL
 * nhà, script MỞ lần lượt CSDL của mọi tổ chức khách đang `ACTIVE` (mở = migrate, điều phối theo CSDL — chạy cùng lúc với ứng
 * dụng vẫn an toàn: chỉ MỘT tiến trình chạy lượt migrate, tiến trình kia chờ và nhận kết quả) rồi đối chiếu sổ như với nhà. Tổ chức nào hỏng ⇒ in tên + lý do và mã thoát 1: người vận hành
 * thấy ở bước deploy, trước khách. Tổ chức đình chỉ / lưu trữ không mở (không ai dùng, không ai cần chờ) — tập tổ chức là
 * `fanOutOrganizationCodes` (vị ngữ `isOperationalOrganization`), KHÔNG một danh sách bỏ qua riêng: tổ chức ĐANG HOẠT ĐỘNG mà
 * migrate hỏng LUÔN làm bước kiểm đỏ. Tổ chức lưu trữ chỉ quay lại tập này qua lượt kích hoạt lại đã đối chiếu sổ (docs/tenant-lifecycle.md).
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/verify-migrations.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { cancelOrganizationMigration, getDb, getDbFor, organizationMigrationDegraded, type Db } from "@/db";
import { currentOrgMigrateHolder, readOrgMigrationStatus, setOrgMigrateRole } from "@/db/migrate";
import { describeOrgMigrateStatus, ORG_MIGRATE_HOLDER_MARGIN_MS, orgMigrateRunTimeoutMs, sameProcess, type OrgMigrateHolder, type OrgMigrateStatus } from "@/lib/constants/org-migrate-coordination";
import { fanOutOrganizationCodes, listOrganizations } from "@/lib/platform/organizations";

export type JournalEntry = { idx: number; tag: string; when: number };

/** Sổ migration của mã nguồn đang chạy (đọc từ thư mục làm việc — trong container là /app). */
export function readJournalEntries(file = "drizzle/meta/_journal.json"): JournalEntry[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { entries: JournalEntry[] }).entries;
}

/**
 * Đối chiếu sổ với MỘT CSDL. Trả số mục thiếu (0 = khớp). Dùng lại ở lượt KÍCH HOẠT LẠI tổ chức lưu trữ (scripts/org-lifecycle.ts):
 * tổ chức chỉ được bật lại khi CSDL của nó khớp sổ ĐÚNG như bước kiểm deploy đòi ở tổ chức đang chạy.
 */
export async function checkDb(label: string, db: Db, entries: readonly JournalEntry[]): Promise<number> {
  // `created_at` của drizzle chính là `when` trong sổ (miligiây). Đó là khoá để đối chiếu.
  const res = await db.execute(sql`select created_at from "drizzle"."__drizzle_migrations"`);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  const applied = new Set(rows.map((r) => Number(r.created_at)));

  const missing = entries.filter((e) => !applied.has(e.when));
  const appliedMax = applied.size ? Math.max(...applied) : 0;

  console.log(`[migrations] ${label}: sổ có ${entries.length} mục · CSDL đã áp ${applied.size} · mốc lớn nhất đã áp ${appliedMax}`);

  if (!missing.length) {
    console.log(`[migrations] ✓ ${label}: mọi mục trong sổ đều đã được áp.`);
    return 0;
  }

  console.error(`\n[migrations] ✗ ${label}: ${missing.length} MIGRATION CHƯA ĐƯỢC ÁP:`);
  for (const e of missing) {
    // Phân biệt hai nguyên nhân, vì cách sửa khác nhau hoàn toàn.
    const skippedForever = e.when < appliedMax;
    console.error(
      `  - ${e.tag} (mốc ${e.when})` +
        (skippedForever
          ? ` ⇒ BỊ BỎ QUA VĨNH VIỄN: mốc cũ hơn mốc đã áp (${appliedMax}). Sửa: nâng "when" của mục này lên lớn hơn ${appliedMax} trong drizzle/meta/_journal.json rồi deploy lại.`
          : " ⇒ chưa tới lượt hoặc migrator chưa chạy. Xem log khởi động của ứng dụng."),
    );
  }
  return missing.length;
}

/**
 * ═══ TRẦN THỜI GIAN MỖI TỔ CHỨC (sự cố 12/10/2026) VÀ CHỜ ĐÚNG LƯỢT ĐANG CHẠY (sự cố 18/10/2026) ═══
 *
 * 12/10: CSDL `qa` chạy câu dẫn xuất của 0245 tới trần 600 giây; script mở tổ chức TUẦN TỰ và chờ vô hạn ⇒ treo tới khi SSH của workflow
 * deploy hết giờ. Từ đó mỗi tổ chức có trần; quá trần ⇒ in ✗, HUỶ câu migration đang chạy CỦA CHÍNH TIẾN TRÌNH NÀY
 * (`cancelOrganizationMigration`), đi tiếp tổ chức sau, cuối cùng thoát 1 (install-vps.sh ghi MIGRATIONS_UNAPPLIED=1 rồi chạy tiếp smoke).
 *
 * 18/10: trần cũ (150 giây) được chọn «dài hơn trần chờ khoá 120 giây» để khi ứng dụng đang migrate thì bước kiểm nhận LOCK_BUSY — tức là
 * báo THỜI GIAN CHỜ CỦA CHÍNH NÓ thay cho kết quả lượt migrate thật đang chạy trong ứng dụng. Nay bước kiểm có vai trò VERIFY
 * (`setOrgMigrateRole`) và việc mở tổ chức đi qua `coordinateOrgMigration` (db/migrate.ts): thấy tiến trình khác đang migrate ⇒ CHỜ lượt đó
 * tới hạn tự khai + biên, rồi báo ĐÚNG kết quả của nó (OK · DEGRADED kèm lý do CỦA lượt đó · lỗi), ghi rõ AI chạy — không bao giờ chạy lượt
 * thứ hai. Vì vậy trần mỗi tổ chức DẪN XUẤT từ trần lượt (`orgMigrateRunTimeoutMs()` + 2 × biên): dù chính bước kiểm chạy lượt (bị tự huỷ
 * ở trần lượt) hay chờ lượt của người khác (tối đa hạn của họ + biên), trần này chỉ là lưới an toàn cuối. Ghi đè `VERIFY_ORG_MIGRATE_TIMEOUT_S`.
 *
 * NGÂN SÁCH TỔNG (`VERIFY_TOTAL_BUDGET_S`, mặc định 900 giây): chờ đúng lượt thật có thể dài tới trần lượt, nên nhiều tổ chức chậm cùng lúc
 * không được kéo bước kiểm quá giờ SSH của deploy (35 phút, gồm ~9 phút dựng). Hết ngân sách ⇒ tổ chức còn lại in «CHƯA KIỂM» và bước kiểm
 * ĐỎ — không bao giờ coi là khớp.
 */
export function verifyOrgTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const s = Number((env.VERIFY_ORG_MIGRATE_TIMEOUT_S || "").trim());
  return Number.isFinite(s) && s > 0 ? s * 1000 : orgMigrateRunTimeoutMs(env) + 2 * ORG_MIGRATE_HOLDER_MARGIN_MS;
}

export const VERIFY_TOTAL_BUDGET_DEFAULT_S = 900;
export function verifyTotalBudgetMs(env: Record<string, string | undefined> = process.env): number {
  const s = Number((env.VERIFY_TOTAL_BUDGET_S || "").trim());
  return (Number.isFinite(s) && s > 0 ? s : VERIFY_TOTAL_BUDGET_DEFAULT_S) * 1000;
}

/*
 * ═══ DEGRADED_MIGRATION (chủ shop 12/10/2026, «Serve with old schema») ═══
 * Tổ chức migrate hết giờ mà mọi migration còn thiếu nằm trong sổ tương thích được PHỤC VỤ bằng lược đồ cũ (db/index.ts). Với bước kiểm
 * đó KHÔNG phải «khớp»: in ✗ + lý do + migration còn thiếu, gom vào dòng «DEGRADED WORKSPACES», và thoát 1 — deploy đỏ đúng nghĩa tới khi
 * migration áp xong.
 */

export type OrgVerifyStatus = "OK" | "MISSING" | "DEGRADED" | "ERROR" | "TIMEOUT" | "NOT_CHECKED";
export type OrgVerifyResult = { code: string; status: OrgVerifyStatus; seconds: number; detail?: string; run?: string };

const HET_GIO = Symbol("het-gio");

/** Một dòng về LƯỢT MIGRATE gần nhất của tổ chức — ai chạy, trạng thái, bao lâu, lý do. HÀM THUẦN. */
export function runStatusLine(code: string, status: OrgMigrateStatus | null, self: OrgMigrateHolder | null, readError?: string | null): string {
  if (!status) return `[migrations]   «${code}» · lượt migrate: ${readError ? `chưa đọc được trạng thái (${readError})` : "chưa có lượt nào được ghi (không còn gì để áp từ khi có sổ trạng thái)"}`;
  const other = self !== null && !sameProcess(status.holder, self);
  return `[migrations]   «${code}» · lượt migrate: ${describeOrgMigrateStatus(status)}${other ? " — do tiến trình KHÁC chạy; bước kiểm chờ và nhận kết quả, không chạy lượt thứ hai" : ""}`;
}

/**
 * Mở + đối chiếu từng tổ chức, MỖI tổ chức một trần thời gian, cả lượt một ngân sách. Tiêm phụ thuộc (mở · đối chiếu · huỷ · trạng thái
 * lượt · ghi log · đồng hồ) để bài kiểm chạy được không cần Postgres. Một tổ chức hỏng / quá trần KHÔNG chặn tổ chức sau.
 */
export async function verifyOrganizations<T>(
  codes: readonly string[],
  deps: {
    open: (code: string) => Promise<T>;
    check: (code: string, db: T, openedSeconds: number) => Promise<number>;
    cancel: (code: string) => Promise<boolean>;
    /** Tổ chức đang phục vụ bằng lược đồ cũ sau lượt mở này — `null` = không. */
    degraded?: (code: string) => { reason: string; missing: readonly string[] } | null;
    /** Trạng thái bền của lượt migrate gần nhất (CSDL nhà) — in kèm mọi kết quả. */
    runStatus?: (code: string) => Promise<{ status: OrgMigrateStatus | null; error: string | null }>;
    self?: OrgMigrateHolder;
    timeoutMs: number;
    budgetMs?: number;
    now?: () => number;
    log?: (line: string) => void;
    error?: (line: string) => void;
  },
): Promise<OrgVerifyResult[]> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const now = deps.now ?? Date.now;
  const begun = now();
  const out: OrgVerifyResult[] = [];
  const describeRun = async (code: string): Promise<string | undefined> => {
    if (!deps.runStatus) return undefined;
    const r = await deps.runStatus(code).catch((e: unknown) => ({ status: null, error: e instanceof Error ? e.message : String(e) }));
    const line = runStatusLine(code, r.status, deps.self ?? null, r.error);
    log(line);
    return line;
  };
  for (const code of codes) {
    const left = deps.budgetMs === undefined ? deps.timeoutMs : deps.budgetMs - (now() - begun);
    if (left <= 0) {
      const detail = `CHƯA KIỂM — hết ngân sách ${Math.round((deps.budgetMs ?? 0) / 1000)} giây của bước kiểm (các tổ chức trước đã dùng hết khi chờ lượt migrate thật). Không phải «khớp».`;
      error(`[migrations] ✗ tổ chức «${code}»: ${detail}`);
      out.push({ code, status: "NOT_CHECKED", seconds: 0, detail });
      continue;
    }
    const timeoutMs = Math.min(deps.timeoutMs, left);
    const started = Date.now();
    const secs = () => (Date.now() - started) / 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hetGio = new Promise<typeof HET_GIO>((resolve) => {
      timer = setTimeout(() => resolve(HET_GIO), timeoutMs);
    });
    const work = (async () => {
      const db = await deps.open(code);
      return deps.check(code, db, secs());
    })();
    try {
      const r = await Promise.race([work, hetGio]);
      if (r === HET_GIO) {
        // Lời hứa `work` vẫn có người nghe (Promise.race đã gắn) — nó hỏng muộn sau lệnh huỷ cũng không thành lỗi không ai bắt.
        work.catch(() => undefined);
        const sent = await deps.cancel(code).catch(() => false);
        const detail = `quá ${Math.round(timeoutMs / 1000)} giây chưa mở / migrate xong${sent ? " — đã gửi lệnh HUỶ câu migration đang chạy của chính bước kiểm" : " — bước kiểm không chạy lượt nào để huỷ (xem dòng «lượt migrate»: ai đang chạy, hạn tới đâu)"}. Đi tiếp tổ chức sau.`;
        error(`[migrations] ✗ tổ chức «${code}»: ${detail}`);
        out.push({ code, status: "TIMEOUT", seconds: secs(), detail, run: await describeRun(code) });
      } else {
        const dg = deps.degraded?.(code) ?? null;
        if (dg) {
          const detail = `DEGRADED_MIGRATION — đang phục vụ bằng LƯỢC ĐỒ CŨ, thiếu ${dg.missing.join(", ")}; lý do: ${dg.reason}`;
          error(`[migrations] ✗ tổ chức «${code}»: ${detail}`);
          out.push({ code, status: "DEGRADED", seconds: secs(), detail, run: await describeRun(code) });
        } else {
          out.push({ code, status: r > 0 ? "MISSING" : "OK", seconds: secs(), run: await describeRun(code) });
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      error(`[migrations] ✗ tổ chức «${code}»: không mở / migrate được — ${detail}`);
      out.push({ code, status: "ERROR", seconds: secs(), detail, run: await describeRun(code) });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const hong = out.filter((r) => r.status !== "OK");
  if (codes.length) log(`[migrations] tổ chức khách: ${out.length - hong.length}/${out.length} khớp${hong.length ? ` · hỏng: ${hong.map((r) => `${r.code} (${r.status})`).join(", ")}` : ""}`);
  const dgList = out.filter((r) => r.status === "DEGRADED");
  if (dgList.length) error(`[migrations] DEGRADED WORKSPACES: ${dgList.map((r) => r.code).join(", ")} — phục vụ bằng lược đồ cũ, migration CHƯA xong (lib/constants/migration-serve-compat.ts).`);
  return out;
}

async function main() {
  // Vai trò của tiến trình TRƯỚC khi mở tổ chức nào: lượt migrate do bước kiểm chạy được ghi là VERIFY, và khi ứng dụng đang migrate thì
  // bước kiểm CHỜ tới hạn tự khai của ứng dụng (không bị trần chờ ngắn của ứng dụng cắt ngang).
  setOrgMigrateRole("VERIFY");
  const journal = { entries: readJournalEntries() };
  let failed = (await checkDb("nhà", await getDb(), journal.entries)) > 0;

  const codes = fanOutOrganizationCodes(await listOrganizations());
  const timeoutMs = verifyOrgTimeoutMs();
  const budgetMs = verifyTotalBudgetMs();
  if (codes.length) {
    console.log(
      `[migrations] ${codes.length} tổ chức khách đang hoạt động — mở (và migrate, hoặc CHỜ lượt đang chạy của tiến trình khác) lần lượt từng CSDL, ` +
        `trần ${Math.round(timeoutMs / 1000)} giây mỗi tổ chức · ngân sách ${Math.round(budgetMs / 1000)} giây cả lượt · trần một lượt migrate ${Math.round(orgMigrateRunTimeoutMs() / 1000)} giây.`,
    );
  }
  const results = await verifyOrganizations(codes, {
    open: (code) => getDbFor({ code, isHome: false }),
    check: (code, db, openedSeconds) => checkDb(`tổ chức «${code}» (${openedSeconds.toFixed(1)} giây)`, db, journal.entries),
    cancel: (code) => cancelOrganizationMigration(code),
    degraded: (code) => organizationMigrationDegraded(code),
    runStatus: (code) => readOrgMigrationStatus(code),
    self: currentOrgMigrateHolder(),
    timeoutMs,
    budgetMs,
  });
  if (results.some((r) => r.status !== "OK")) failed = true;

  if (failed) process.exit(1);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("verify-migrations.ts"));
if (CHAY_THANG) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[migrations] Không kiểm được:", error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
