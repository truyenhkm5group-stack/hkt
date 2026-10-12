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
 * nhà, script MỞ lần lượt CSDL của mọi tổ chức khách đang `ACTIVE` (mở = migrate, có khoá tư vấn theo CSDL — chạy cùng lúc
 * với ứng dụng vẫn an toàn) rồi đối chiếu sổ như với nhà. Tổ chức nào hỏng ⇒ in tên + lý do và mã thoát 1: người vận hành
 * thấy ở bước deploy, trước khách. Tổ chức đình chỉ / lưu trữ không mở (không ai dùng, không ai cần chờ).
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/verify-migrations.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { cancelOrganizationMigration, getDb, getDbFor, organizationMigrationDegraded, type Db } from "@/db";
import { fanOutOrganizationCodes, listOrganizations } from "@/lib/platform/organizations";

type JournalEntry = { idx: number; tag: string; when: number };

/** Đối chiếu sổ với MỘT CSDL. Trả số mục thiếu (0 = khớp). */
async function checkDb(label: string, db: Db, entries: readonly JournalEntry[]): Promise<number> {
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
 * ═══ TRẦN THỜI GIAN MỖI TỔ CHỨC (sự cố 12/10/2026) ═══
 *
 * Sau deploy #792, CSDL `qa` chạy câu dẫn xuất của 0245 tới trần 600 giây; script này mở tổ chức TUẦN TỰ và chờ vô hạn, nên treo tới
 * khi SSH của workflow deploy hết giờ ⇒ deploy đỏ mà smoke KHÔNG chạy, và các tổ chức đứng sau `qa` chưa được kiểm. Nay mỗi tổ chức
 * có trần (`VERIFY_ORG_MIGRATE_TIMEOUT_S`, mặc định 150 giây — DÀI HƠN trần chờ khoá migrate 120 giây, để khi ứng dụng đang cầm khoá
 * của tổ chức đó thì bước kiểm nhận LOCK_BUSY ⇒ DEGRADED_MIGRATION có lý do, thay vì một TIMEOUT không nói gì): quá trần ⇒ in ✗, HUỶ câu
 * migration đang chạy của chính tiến trình này
 * (`cancelOrganizationMigration`), ĐI TIẾP tổ chức sau, và cuối cùng thoát 1 — deploy vẫn đỏ đúng nghĩa (install-vps.sh ghi
 * MIGRATIONS_UNAPPLIED=1 rồi chạy tiếp smoke như mọi lần verify hỏng), chỉ là không treo.
 */
export const VERIFY_ORG_TIMEOUT_DEFAULT_S = 150;

/*
 * ═══ DEGRADED_MIGRATION (chủ shop 12/10/2026, «Serve with old schema») ═══
 * Tổ chức migrate hết giờ mà mọi migration còn thiếu nằm trong sổ tương thích được PHỤC VỤ bằng lược đồ cũ (db/index.ts). Với bước kiểm
 * đó KHÔNG phải «khớp»: in ✗ + lý do + migration còn thiếu, gom vào dòng «DEGRADED WORKSPACES», và thoát 1 — deploy đỏ đúng nghĩa tới khi
 * migration áp xong.
 */

export function verifyOrgTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const s = Number((env.VERIFY_ORG_MIGRATE_TIMEOUT_S || "").trim());
  return (Number.isFinite(s) && s > 0 ? s : VERIFY_ORG_TIMEOUT_DEFAULT_S) * 1000;
}

export type OrgVerifyStatus = "OK" | "MISSING" | "DEGRADED" | "ERROR" | "TIMEOUT";
export type OrgVerifyResult = { code: string; status: OrgVerifyStatus; seconds: number; detail?: string };

const HET_GIO = Symbol("het-gio");

/**
 * Mở + đối chiếu từng tổ chức, MỖI tổ chức một trần thời gian. Tiêm phụ thuộc (mở · đối chiếu · huỷ · ghi log) để bài kiểm chạy được
 * không cần Postgres. Một tổ chức hỏng / quá trần KHÔNG chặn tổ chức sau.
 */
export async function verifyOrganizations<T>(
  codes: readonly string[],
  deps: {
    open: (code: string) => Promise<T>;
    check: (code: string, db: T, openedSeconds: number) => Promise<number>;
    cancel: (code: string) => Promise<boolean>;
    /** Tổ chức đang phục vụ bằng lược đồ cũ sau lượt mở này — `null` = không. */
    degraded?: (code: string) => { reason: string; missing: readonly string[] } | null;
    timeoutMs: number;
    log?: (line: string) => void;
    error?: (line: string) => void;
  },
): Promise<OrgVerifyResult[]> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const error = deps.error ?? ((l: string) => console.error(l));
  const out: OrgVerifyResult[] = [];
  for (const code of codes) {
    const started = Date.now();
    const secs = () => (Date.now() - started) / 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hetGio = new Promise<typeof HET_GIO>((resolve) => {
      timer = setTimeout(() => resolve(HET_GIO), deps.timeoutMs);
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
        const detail = `quá ${Math.round(deps.timeoutMs / 1000)} giây chưa mở / migrate xong (migration chạy lâu, hoặc tiến trình khác đang giữ khoá migrate của tổ chức này)${sent ? " — đã gửi lệnh HUỶ câu migration đang chạy của bước kiểm" : ""}. Đi tiếp tổ chức sau.`;
        error(`[migrations] ✗ tổ chức «${code}»: ${detail}`);
        out.push({ code, status: "TIMEOUT", seconds: secs(), detail });
      } else {
        const dg = deps.degraded?.(code) ?? null;
        if (dg) {
          const detail = `DEGRADED_MIGRATION — đang phục vụ bằng LƯỢC ĐỒ CŨ, thiếu ${dg.missing.join(", ")}; lý do: ${dg.reason}`;
          error(`[migrations] ✗ tổ chức «${code}»: ${detail}`);
          out.push({ code, status: "DEGRADED", seconds: secs(), detail });
        } else {
          out.push({ code, status: r > 0 ? "MISSING" : "OK", seconds: secs() });
        }
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      error(`[migrations] ✗ tổ chức «${code}»: không mở / migrate được — ${detail}`);
      out.push({ code, status: "ERROR", seconds: secs(), detail });
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
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: JournalEntry[] };
  let failed = (await checkDb("nhà", await getDb(), journal.entries)) > 0;

  const codes = fanOutOrganizationCodes(await listOrganizations());
  const timeoutMs = verifyOrgTimeoutMs();
  if (codes.length) console.log(`[migrations] ${codes.length} tổ chức khách đang hoạt động — mở (và migrate) lần lượt từng CSDL, trần ${Math.round(timeoutMs / 1000)} giây mỗi tổ chức.`);
  const results = await verifyOrganizations(codes, {
    open: (code) => getDbFor({ code, isHome: false }),
    check: (code, db, openedSeconds) => checkDb(`tổ chức «${code}» (${openedSeconds.toFixed(1)} giây)`, db, journal.entries),
    cancel: (code) => cancelOrganizationMigration(code),
    degraded: (code) => organizationMigrationDegraded(code),
    timeoutMs,
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
