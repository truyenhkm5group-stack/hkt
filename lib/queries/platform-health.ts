import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDbFor, getDbForInspection, type Db } from "@/db";
import { PLATFORM_MODULES, moduleDependencyErrors, type ModuleDependencyError } from "@/lib/constants/platform-modules";
import { getModuleRows } from "@/lib/platform/capabilities";
import { FALLBACK_HOME_CODE, listOrganizations } from "@/lib/platform/organizations";
import type { Organization } from "@/lib/platform/types";
import { buildModuleView } from "@/lib/queries/platform-modules";

/**
 * ═══════════ SỨC KHOẺ NỀN TẢNG — "MÁY QUÉT DỮ LIỆU VÔ CHỦ" CỦA MÔ HÌNH SILO ═══════════
 *
 * Mô hình dùng chung một CSDL cần máy quét tìm dòng thiếu `organization_id`. Mô hình SILO không có
 * cột ấy (mỗi tổ chức một CSDL — target-architecture P1), nên "dữ liệu vô chủ" mang ba hình dạng khác,
 * và trang này kiểm đúng ba hình dạng đó:
 *
 *  1. CSDL của tổ chức MỞ ĐƯỢC không — tổ chức có dòng trong sổ mà không có CSDL là tổ chức treo.
 *  2. CSDL ấy đã áp ĐỦ bộ migration chưa — thiếu migration là một tổ chức chạy lược đồ khác mã nguồn.
 *  3. Bốn bảng `platform_*` trong CSDL tổ chức KHÔNG PHẢI NHÀ phải RỖNG (P3: cùng bộ migration nên
 *     bảng có mặt ở mọi CSDL, nhưng chỉ bản ở CSDL nhà là thật). Một dòng ở đó là cấu hình không ai
 *     đọc — tệ hơn, trông như cấu hình thật với người mở CSDL bằng tay.
 *
 * Cộng hai lỗi CẤU HÌNH đọc từ mặt phẳng điều khiển: module khai bật mà thiếu phụ thuộc
 * (`moduleDependencyErrors`), và dòng module mang khoá không có trong sổ.
 *
 * ─── KHÔNG ĐOÁN ───
 *
 * Mọi con số đo không được là `null` KÈM LÝ DO (`note`), không bao giờ 0 (AGENTS.md mục 42). Mở một
 * CSDL tổ chức lần đầu trong tiến trình sẽ TỰ ÁP migration (`db/index.ts`) — nên "migration đủ" sau
 * khi mở nói rằng lượt áp đã thành công, và lượt áp hỏng hiện ra thành "không kết nối được" kèm lỗi.
 */

export const PLATFORM_TABLES = ["platform_organizations", "platform_organization_modules", "platform_flag_overrides", "platform_audit_log"] as const;

export type OrgHealth = {
  code: string;
  name: string;
  status: Organization["status"];
  isHome: boolean;
  templateKey: string | null;
  moduleDefault: Organization["moduleDefault"];
  /** `null` = chưa đọc được cấu hình. */
  enabledModules: number | null;
  totalModules: number;
  dependencyErrors: ModuleDependencyError[];
  unknownModuleKeys: string[];
  /** `null` = chưa đo (xem `connectNote`). */
  connected: boolean | null;
  connectNote: string | null;
  migrationsApplied: number | null;
  migrationsExpected: number | null;
  migrationsNote: string | null;
  /** Số dòng mỗi bảng `platform_*` trong CSDL tổ chức. `null` với tổ chức nhà (bảng thật) hoặc khi chưa đo. */
  platformTables: { table: string; rows: number | null }[] | null;
  platformTablesNote: string | null;
  /** Những điều sai, mỗi điều một câu. Rỗng ⇔ không phát hiện gì (KHÔNG có nghĩa là mọi thứ đã đo — xem các `note`). */
  problems: string[];
};

export type PlatformHealth = {
  checkedAt: string;
  migrationsExpected: number | null;
  journalNote: string | null;
  /** Sai ở mức SỔ TỔ CHỨC (không thuộc riêng tổ chức nào) — vd không đúng một dòng tổ chức nhà. */
  registryProblems: string[];
  organizations: OrgHealth[];
};

/**
 * Hai cách mở CSDL tổ chức để đo:
 *  · `APP` (mặc định, trang `/platform`) — `getDbFor`: mở lần đầu là tự migrate + dọn bản sao `platform_*`,
 *    đúng như ứng dụng sẽ làm khi người của tổ chức ấy đăng nhập.
 *  · `READ_ONLY` (CLI `npm run platform:diagnostics`) — `getDbForInspection`: không migrate, không dọn,
 *    máy chủ ép chỉ đọc. Số migration và số dòng `platform_*` là của CSDL ĐÚNG NHƯ ĐANG CÓ.
 */
export type HealthMode = "APP" | "READ_ONLY";

/**
 * Sổ tổ chức phải có ĐÚNG MỘT dòng tổ chức nhà. Chỉ mục duy nhất một phần của 0152 cấm hai dòng; KHÔNG
 * dòng nào thì `listOrganizations()` tự dựng bản sẵn (mã `home`) để app không sập — trang vẫn chạy,
 * nhưng đó là tình trạng phải có người biết (bảng chưa có, hoặc dòng nhà bị xoá tay).
 */
export function homeRowProblems(orgs: readonly Pick<Organization, "id" | "code" | "isHome">[]): string[] {
  const homes = orgs.filter((o) => o.isHome);
  if (homes.length > 1) return [`Sổ tổ chức có ${homes.length} dòng tổ chức nhà (${homes.map((o) => o.code).join(", ")}) — phải đúng một.`];
  if (homes.length === 0) return ["Sổ tổ chức không có dòng tổ chức nhà nào — phải đúng một."];
  if (homes[0].code === FALLBACK_HOME_CODE && homes[0].id === "org-home") {
    return ["Sổ tổ chức không có dòng tổ chức nhà (bảng platform_organizations chưa có hoặc dòng nhà đã mất) — ứng dụng đang chạy bằng bản dựng sẵn."];
  }
  return [];
}

function errorText(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } } | null;
  const text = e?.cause?.message ?? e?.message ?? String(error);
  // Chuỗi kết nối có thể lọt vào câu lỗi của driver — che phần mật khẩu trước khi in (kho mã PUBLIC).
  return text.replace(/\/\/[^@\s/]+@/g, "//***@").slice(0, 240);
}

function firstInt(result: unknown, field: string): number | null {
  const rows = (result as { rows?: Record<string, unknown>[] }).rows ?? (result as Record<string, unknown>[]);
  const value = Array.isArray(rows) ? rows[0]?.[field] : undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Số mục trong sổ migration của MÃ NGUỒN đang chạy. */
export function readJournalCount(): { count: number | null; note: string | null } {
  try {
    const journal = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8")) as { entries?: unknown[] };
    if (!Array.isArray(journal.entries)) return { count: null, note: "Tệp drizzle/meta/_journal.json không có mảng entries." };
    return { count: journal.entries.length, note: null };
  } catch (error) {
    return { count: null, note: `Không đọc được drizzle/meta/_journal.json: ${errorText(error)}` };
  }
}

async function countMigrations(db: Db): Promise<{ n: number | null; note: string | null }> {
  try {
    return { n: firstInt(await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`), "n"), note: null };
  } catch (error) {
    return { n: null, note: `Không đọc được drizzle.__drizzle_migrations: ${errorText(error)}` };
  }
}

async function countPlatformTables(db: Db): Promise<{ table: string; rows: number | null; note: string | null }[]> {
  const out: { table: string; rows: number | null; note: string | null }[] = [];
  for (const table of PLATFORM_TABLES) {
    try {
      // Tên bảng lấy từ hằng số trong mã, không từ đầu vào — nội suy an toàn.
      out.push({ table, rows: firstInt(await db.execute(sql.raw(`select count(*)::int as n from ${table}`)), "n"), note: null });
    } catch (error) {
      out.push({ table, rows: null, note: errorText(error) });
    }
  }
  return out;
}

async function checkOrganization(org: Organization, expected: number | null, mode: HealthMode): Promise<OrgHealth> {
  const { rows } = await getModuleRows(org.code);
  const view = buildModuleView(org, rows);
  const health: OrgHealth = {
    code: org.code,
    name: org.name,
    status: org.status,
    isHome: org.isHome,
    templateKey: org.templateKey,
    moduleDefault: org.moduleDefault,
    enabledModules: view.enabledCount,
    totalModules: view.total,
    dependencyErrors: moduleDependencyErrors(org, rows),
    unknownModuleKeys: view.unknownKeys,
    connected: null,
    connectNote: null,
    migrationsApplied: null,
    migrationsExpected: expected,
    migrationsNote: null,
    platformTables: null,
    platformTablesNote: org.isHome ? "Tổ chức nhà: đây là mặt phẳng điều khiển thật, không kiểm rỗng." : null,
    problems: [],
  };
  for (const e of health.dependencyErrors) health.problems.push(e.message);
  if (health.unknownModuleKeys.length) health.problems.push(`Dòng module mang khoá không có trong sổ: ${health.unknownModuleKeys.join(", ")} (bộ phân giải bỏ qua).`);

  let db: Db;
  try {
    db = mode === "READ_ONLY" ? await getDbForInspection(org) : await getDbFor(org);
    await db.execute(sql`select 1`);
    health.connected = true;
  } catch (error) {
    health.connected = false;
    health.connectNote = errorText(error);
    health.migrationsNote = "Chưa đo — không mở được CSDL.";
    if (!org.isHome) health.platformTablesNote = "Chưa đo — không mở được CSDL.";
    health.problems.push(`Không mở được CSDL của tổ chức: ${health.connectNote}`);
    return health;
  }

  const mig = await countMigrations(db);
  health.migrationsApplied = mig.n;
  health.migrationsNote = mig.note;
  if (mig.n !== null && expected !== null && mig.n < expected) health.problems.push(`CSDL mới áp ${mig.n}/${expected} migration của mã nguồn.`);
  if (mig.n !== null && expected !== null && mig.n > expected) health.problems.push(`CSDL đã áp ${mig.n} migration, NHIỀU hơn ${expected} mục của mã nguồn đang chạy — mã cũ hơn CSDL?`);

  if (!org.isHome) {
    const tables = await countPlatformTables(db);
    health.platformTables = tables.map(({ table, rows: n }) => ({ table, rows: n }));
    const unreadable = tables.filter((t) => t.rows === null);
    if (unreadable.length) health.platformTablesNote = `Chưa đo được ${unreadable.map((t) => t.table).join(", ")}: ${unreadable[0].note}`;
    const dirty = tables.filter((t) => t.rows !== null && t.rows > 0);
    for (const t of dirty) health.problems.push(`${t.table} trong CSDL tổ chức có ${t.rows} dòng — phải rỗng (chỉ bản ở CSDL nhà là thật).`);
  }
  return health;
}

/** Sức khoẻ mọi tổ chức. Một tổ chức hỏng không làm hỏng bảng — lỗi của nó nằm trong dòng của nó. */
export async function getPlatformHealth(opts: { mode?: HealthMode } = {}): Promise<PlatformHealth> {
  const mode = opts.mode ?? "APP";
  const journal = readJournalCount();
  const orgs = await listOrganizations();
  const sorted = [...orgs].sort((a, b) => Number(b.isHome) - Number(a.isHome) || a.code.localeCompare(b.code));
  const organizations: OrgHealth[] = [];
  // Tuần tự, không song song: mỗi CSDL tổ chức mở lần đầu là một lượt migrate có khoá — mở hàng loạt
  // cùng lúc là tự dựng một cơn bão kết nối vào máy chủ Postgres đang phục vụ tổ chức nhà.
  for (const org of sorted) {
    try {
      organizations.push(await checkOrganization(org, journal.count, mode));
    } catch (error) {
      const why = `Không đọc được cấu hình của tổ chức: ${errorText(error)}`;
      organizations.push({
        code: org.code,
        name: org.name,
        status: org.status,
        isHome: org.isHome,
        templateKey: org.templateKey,
        moduleDefault: org.moduleDefault,
        enabledModules: null,
        totalModules: PLATFORM_MODULES.length,
        dependencyErrors: [],
        unknownModuleKeys: [],
        connected: null,
        connectNote: why,
        migrationsApplied: null,
        migrationsExpected: journal.count,
        migrationsNote: "Chưa đo.",
        platformTables: null,
        platformTablesNote: "Chưa đo.",
        problems: [why],
      });
    }
  }
  return { checkedAt: new Date().toISOString(), migrationsExpected: journal.count, journalNote: journal.note, registryProblems: homeRowProblems(orgs), organizations };
}

// ═══════════ TÓM TẮT CHO CLI — THUẦN ═══════════

export type DiagnosticsRow = {
  code: string;
  home: boolean;
  status: string;
  connection: string;
  migrations: string;
  platformTables: string;
  unknownModuleKeys: string;
  dependencyErrors: string;
};

export type DiagnosticsSummary = {
  rows: DiagnosticsRow[];
  problems: string[];
  /** Thứ CHƯA ĐO ĐƯỢC — không phải lỗi, cũng không phải "ổn" (AGENTS.md mục 42, 65). */
  unmeasured: string[];
  /** 0 = đo đủ và sạch · 1 = có vấn đề · 2 = không vấn đề nào nhưng còn chỗ chưa đo được. */
  exitCode: 0 | 1 | 2;
};

/**
 * Bảng của `npm run platform:diagnostics`. Ô chưa đo in `—` kèm lý do ở phần "chưa đo", KHÔNG in `0`
 * hay `✓`: một lượt chẩn đoán không mở được CSDL không được trông giống một lượt sạch.
 */
export function summarizeHealth(health: PlatformHealth): DiagnosticsSummary {
  const problems: string[] = [...health.registryProblems];
  const unmeasured: string[] = [];
  if (health.journalNote) unmeasured.push(`sổ migration của mã nguồn: ${health.journalNote}`);
  const rows = health.organizations.map((o): DiagnosticsRow => {
    for (const p of o.problems) problems.push(`[${o.code}] ${p}`);
    if (o.connected === null) unmeasured.push(`[${o.code}] kết nối: ${o.connectNote ?? "chưa đo"}`);
    if (o.connected && o.migrationsApplied === null) unmeasured.push(`[${o.code}] migration: ${o.migrationsNote ?? "chưa đo"}`);
    if (o.connected && !o.isHome && o.platformTables?.some((t) => t.rows === null)) unmeasured.push(`[${o.code}] bảng platform_*: ${o.platformTablesNote ?? "chưa đo"}`);
    const dirty = (o.platformTables ?? []).filter((t) => t.rows !== null && t.rows > 0);
    return {
      code: o.code,
      home: o.isHome,
      status: o.status,
      connection: o.connected === null ? "—" : o.connected ? "mở được" : "KHÔNG mở được",
      migrations: `${o.migrationsApplied ?? "—"}/${o.migrationsExpected ?? "—"}`,
      platformTables: o.isHome ? "n/a (nhà)" : o.platformTables === null ? "—" : dirty.length ? `CÓ DÒNG: ${dirty.map((t) => `${t.table}=${t.rows}`).join(", ")}` : o.platformTables.some((t) => t.rows === null) ? "—" : "rỗng",
      unknownModuleKeys: o.unknownModuleKeys.length ? o.unknownModuleKeys.join(", ") : "không",
      dependencyErrors: o.dependencyErrors.length ? o.dependencyErrors.map((e) => e.key).join(", ") : "không",
    };
  });
  return { rows, problems, unmeasured, exitCode: problems.length ? 1 : unmeasured.length ? 2 : 0 };
}
