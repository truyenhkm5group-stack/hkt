/**
 * ═══════════ DIỄN TẬP KHÔI PHỤC MỘT TỔ CHỨC TRÊN POSTGRES THẬT — PHẦN THUẦN (launch-gates C) ═══════════
 *
 * `scripts/restore-drill-pg.ts` dựng MỘT tổ chức thử trên một máy Postgres TẠM (service container của GitHub Actions,
 * hoặc một cụm `initdb` dùng một lần trên máy lập trình), tuỳ biến nó, SAO LƯU bằng đúng lệnh của `erp-backup.sh`, PHÁ
 * rồi `DROP DATABASE`, KHÔI PHỤC theo đúng runbook `docs/backup-restore.md` mục 7, rồi so và CHẠY THẬT tổ chức đã
 * khôi phục qua mã ứng dụng. Tệp này KHÔNG đọc / ghi CSDL và KHÔNG chạy lệnh nào: nó giữ
 *
 *  1. TÊN — tổ chức diễn tập luôn mang tiền tố `drill-`, CSDL tạm không bao giờ bắt đầu bằng `erp_org_`;
 *  2. HÀNG RÀO — lệnh xoá CSDL chỉ nhận ĐÚNG hai tên của lượt diễn tập; môi trường không phải máy tạm thì từ chối;
 *  3. LỆNH — argv của createdb / pg_dump / pg_restore, khoá bằng bài kiểm với `erp-backup.sh` và runbook;
 *  4. PHÁN QUYẾT — bằng chứng của ba tiến trình ⇒ ĐẠT hay KHÔNG, và nếu không thì vì sao, từng vế một.
 *
 * Tách khỏi kịch bản để bài kiểm đột biến được từng vế (tests/restore-drill-pg.test.ts): một phép so luôn-đúng — ví dụ
 * quên kiểm "bản đã phá KHÁC bản gốc" — làm diễn tập xanh mà không chứng minh gì.
 */

/** Tổ chức diễn tập: tiền tố `drill-` là hàng rào đầu tiên — không mã tổ chức thật nào của khách mang nó. */
export const DRILL_ORG_CODE_PATTERN = /^drill-[a-z0-9]([a-z0-9-]{0,22}[a-z0-9])?$/;
export const DEFAULT_DRILL_ORG_CODE = "drill-ws";

/** Cùng mẫu với `MAU_CSDL_TO_CHUC` của `scripts/erp-backup.sh` — tên CSDL tổ chức mà sao lưu đêm nhìn thấy. */
export const ORG_DATABASE_PATTERN = /^erp_org_[a-z0-9_]+$/;
/** Cùng tiền tố / mẫu với `TIEN_TO_CSDL_TAM` / `MAU_CSDL_TAM` của `scripts/erp-backup.sh` và runbook mục 7. */
export const TEMP_DATABASE_PREFIX = "tam_khoiphuc_";
export const TEMP_DATABASE_PATTERN = /^tam_khoiphuc_[a-z0-9_]+$/;
/** CSDL nhà của máy tạm. `erp-backup.sh` chỉ thấy `erp_org_*` khi nhà tên `erp` — lệch tên là diễn tập một thứ khác. */
export const DRILL_HOME_DATABASE = "erp";
/** Biến bắt buộc: người chạy KHẲNG ĐỊNH máy Postgres này là máy dùng một lần. */
export const DRILL_EPHEMERAL_ACK_ENV = "ERP_RESTORE_DRILL_EPHEMERAL";

/** Máy chủ chấp nhận: chỉ vòng lặp nội bộ (service container của Actions map cổng ra localhost). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type DrillNames = { orgCode: string; orgDatabase: string; tempDatabase: string };

/**
 * Mã tổ chức diễn tập ⇒ tên CSDL tổ chức + tên CSDL tạm. NÉM khi mã không phải mã diễn tập hoặc tên dẫn xuất không
 * qua hai hàng rào độc lập (mẫu tạm, và "không khớp mẫu tổ chức") — không bao giờ đoán.
 */
export function drillNames(orgCode: string): DrillNames {
  if (!DRILL_ORG_CODE_PATTERN.test(orgCode)) throw new Error(`Mã «${orgCode}» không phải mã tổ chức diễn tập (phải khớp ${DRILL_ORG_CODE_PATTERN}).`);
  const tail = orgCode.replace(/-/g, "_");
  const orgDatabase = `${DRILL_HOME_DATABASE}_org_${tail}`;
  const tempDatabase = `${TEMP_DATABASE_PREFIX}${tail}`;
  if (!ORG_DATABASE_PATTERN.test(orgDatabase) || !orgDatabase.startsWith("erp_org_drill_")) throw new Error(`Tên CSDL tổ chức «${orgDatabase}» không hợp lệ.`);
  if (!TEMP_DATABASE_PATTERN.test(tempDatabase) || ORG_DATABASE_PATTERN.test(tempDatabase) || tempDatabase.startsWith("erp_org_")) {
    throw new Error(`Tên CSDL tạm «${tempDatabase}» không qua hàng rào tên.`);
  }
  return { orgCode, orgDatabase, tempDatabase };
}

/**
 * Lệnh xoá / chấm dứt kết nối chỉ được nhắm vào ĐÚNG hai CSDL của lượt diễn tập. Mọi tên khác — `erp`, `postgres`,
 * `template*`, một `erp_org_*` thật, một chuỗi có dấu nháy — NÉM trước khi câu SQL nào được dựng.
 */
export function assertDropAllowed(name: string, names: DrillNames): void {
  const safe = /^[a-z0-9_]+$/.test(name);
  const ours = name === names.orgDatabase || name === names.tempDatabase;
  const drillOrg = ORG_DATABASE_PATTERN.test(name) && name.startsWith("erp_org_drill_");
  const drillTemp = TEMP_DATABASE_PATTERN.test(name) && name.startsWith(`${TEMP_DATABASE_PREFIX}drill_`);
  if (!safe || !ours || !(drillOrg || drillTemp)) throw new Error(`TỪ CHỐI xoá CSDL «${name}» — diễn tập chỉ được xoá ${names.orgDatabase} hoặc ${names.tempDatabase}.`);
}

export type DrillEnvironment = {
  /** Máy chủ trong DATABASE_URL. */
  host: string;
  /** Tên CSDL nhà trong DATABASE_URL. */
  database: string;
  /** Giá trị của `ERP_RESTORE_DRILL_EPHEMERAL`. */
  ack: string | undefined;
  /** Số bảng `public` của CSDL nhà TRƯỚC khi diễn tập migrate — máy tạm mới tinh là 0. */
  publicTablesBefore: number;
  /** Mọi CSDL `erp_org_%` đang có trên máy chủ (trước khi diễn tập tạo gì). */
  orgDatabases: readonly string[];
};

/**
 * Máy Postgres này có phải máy dùng một lần không. Trả DANH SÁCH lý do từ chối (rỗng = được chạy). Bốn hàng rào độc
 * lập, vì diễn tập này `DROP DATABASE`: một `.env` trỏ production, một đường hầm SSH mở cổng 5432 về máy, hay một cụm
 * lập trình đang có dữ liệu — mỗi thứ phải tự bị chặn, không dựa vào thứ khác.
 */
export function judgeDrillEnvironment(e: DrillEnvironment, names: DrillNames): string[] {
  const out: string[] = [];
  if ((e.ack ?? "").trim() !== "1") out.push(`Thiếu ${DRILL_EPHEMERAL_ACK_ENV}=1 — người chạy chưa khẳng định máy Postgres này là máy dùng một lần.`);
  if (!LOOPBACK_HOSTS.has(e.host.trim().toLowerCase())) out.push(`Máy chủ «${e.host}» không phải vòng lặp nội bộ — diễn tập chỉ chạy trên Postgres tạm ở localhost (service container / initdb).`);
  if (e.database !== DRILL_HOME_DATABASE) out.push(`CSDL nhà phải tên «${DRILL_HOME_DATABASE}» (sao lưu đêm chỉ thấy erp_org_* khi nhà tên erp), thấy «${e.database}».`);
  if (e.publicTablesBefore !== 0) out.push(`CSDL nhà đã có ${e.publicTablesBefore} bảng — diễn tập chỉ chạy trên máy MỚI TINH (production có ~190 bảng).`);
  const others = e.orgDatabases.filter((d) => d !== names.orgDatabase);
  if (others.length > 0) out.push(`Máy chủ đã có CSDL tổ chức khác: ${others.join(", ")} — không phải máy tạm.`);
  return out;
}

// ═══════════════════════════ LỆNH — ĐÚNG lệnh của sao lưu đêm và runbook ═══════════════════════════

/** `erp-backup.sh::sao_luu_mot_to_chuc`: `pg_dump -U erp -d "$csdl" -Fc` (khoá bằng bài kiểm). */
export function dumpArgs(database: string): string[] {
  return ["pg_dump", "-U", "erp", "-d", database, "-Fc"];
}
/** `erp-backup.sh`: `pg_restore --list` — phép kiểm toàn vẹn ngay sau khi dump. */
export function listArgs(): string[] {
  return ["pg_restore", "--list"];
}
/** Runbook mục 7 bước 2: `createdb -U erp -O erp tam_khoiphuc_<mã>`. */
export function createdbArgs(tempDatabase: string): string[] {
  return ["createdb", "-U", "erp", "-O", "erp", tempDatabase];
}
/** Runbook mục 7 bước 2: `pg_restore -U erp -d tam_khoiphuc_<mã> --no-owner --no-privileges < bản.dump`. */
export function restoreArgs(tempDatabase: string): string[] {
  return ["pg_restore", "-U", "erp", "-d", tempDatabase, "--no-owner", "--no-privileges"];
}

/** Bảng lõi `erp-backup.sh` đòi có dữ liệu trong mục lục (`BANG_LOI_TO_CHUC`). */
export const DUMP_CORE_TABLES = ["public.users", "public.settings", "drizzle.__drizzle_migrations"] as const;

/** Bảng lõi THIẾU dữ liệu trong mục lục `pg_restore --list` — cùng phép so chuỗi với `bang_loi_thieu` của script. */
export function missingCoreTables(toc: string): string[] {
  return DUMP_CORE_TABLES.filter((t) => {
    const [schema, table] = t.split(".");
    return !toc.includes(` TABLE DATA ${schema} ${table} `);
  });
}

// ═══════════════════════════ ẢNH CHỤP + SO ═══════════════════════════

export type TableStat = { rows: number; hash: string };
/** Ảnh chụp MỘT CSDL: mọi bảng của `public` + `drizzle` (số dòng + băm nội dung không phụ thuộc thứ tự) + giá trị sequence. */
export type DbSnapshot = { tables: Record<string, TableStat>; sequences: Record<string, string | null> };

/** Khác biệt giữa hai ảnh chụp, mỗi dòng một câu đọc được. Rỗng = BẰNG NHAU. */
export function diffSnapshots(a: DbSnapshot, b: DbSnapshot): string[] {
  const out: string[] = [];
  const names = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const t of [...names].sort()) {
    const x = a.tables[t];
    const y = b.tables[t];
    if (!x) out.push(`${t}: bảng THỪA sau khôi phục`);
    else if (!y) out.push(`${t}: bảng THIẾU sau khôi phục`);
    else if (x.rows !== y.rows) out.push(`${t}: ${x.rows} → ${y.rows} dòng`);
    else if (x.hash !== y.hash) out.push(`${t}: cùng ${x.rows} dòng nhưng NỘI DUNG khác`);
  }
  const seqs = new Set([...Object.keys(a.sequences), ...Object.keys(b.sequences)]);
  for (const s of [...seqs].sort()) {
    if (!(s in a.sequences)) out.push(`sequence ${s}: THỪA sau khôi phục`);
    else if (!(s in b.sequences)) out.push(`sequence ${s}: THIẾU sau khôi phục`);
    else if (a.sequences[s] !== b.sequences[s]) out.push(`sequence ${s}: ${a.sequences[s]} → ${b.sequences[s]}`);
  }
  return out;
}

/**
 * Bảng mà kịch bản CHẮC CHẮN ghi vào CSDL tổ chức. Bảng nào ở đây rỗng trong ảnh "trước" ⇒ phần tuỳ biến không xảy ra
 * (hoặc ghi nhầm CSDL) và phép so "trước = sau" chỉ đang so hai cái rỗng — diễn tập KHÔNG đạt.
 */
export const DRILL_SEEDED_TABLES = [
  "public.meta_objects",
  "public.meta_custom_fields",
  "public.meta_forms",
  "public.meta_list_views",
  "public.meta_pages",
  "public.meta_status_overrides",
  "public.custom_records",
  "public.custom_values",
  "public.custom_files",
  "public.customers",
  "public.workflow_rules",
  "public.workflow_runs",
  "public.approval_requests",
  "public.work_items",
  "public.blueprint_installs",
  "public.blueprint_items",
  "public.org_connections",
  "public.access_roles",
  "public.users",
  "public.settings",
  "drizzle.__drizzle_migrations",
] as const;

// ═══════════════════════════ PHÁN QUYẾT ═══════════════════════════

export type AppEvidence = {
  /** Bản ghi tuỳ biến đọc lại qua `getRecord` với đúng giá trị đã gieo. */
  recordsReadOk: boolean;
  /** Nhãn quan hệ (một + nhiều) và chiều ngược (`reverseRelations`) ra đúng bản ghi đã gieo. */
  relationsOk: boolean;
  /** Tệp đính kèm (bytea) mở lại ra đúng byte. */
  fileOk: boolean;
  /** Trang đã xuất bản: số trang phân giải, tổng khối, lỗi khối (mỗi dòng `slug/khối: mã`). */
  pagesResolved: number;
  blocks: number;
  blockErrors: string[];
  /** Menu: các slug trang có mục menu, đọc qua `listNavPages`. */
  navSlugs: string[];
  /** Luật: lượt `runWorkflows` đầu tiên sau khôi phục KHÔNG chạy lại việc đã chạy. */
  rerunExecuted: number;
  runsBefore: number;
  runsAfterRerun: number;
  tasksBefore: number;
  tasksAfterRerun: number;
  /** Bản ghi MỚI sau khôi phục ⇒ động cơ luật còn sống: đúng một lượt mới xin duyệt. */
  newRecordWaiting: number;
  /** Bí mật kết nối: CÙNG khoá giải ra đúng bản rõ; khoá KHÁC bị từ chối và không gọi ra ngoài. */
  sameKeyLarkOk: boolean;
  sameKeyAiOk: boolean;
  wrongKeyLarkRejected: boolean;
  wrongKeyAiRejected: boolean;
  wrongKeyFetchCalls: number;
  /** Đăng nhập người dùng của tổ chức qua `verifyLogin`. */
  loginAdminOk: boolean;
  loginRoleUserOk: boolean;
  loginWrongPasswordRejected: boolean;
  /** Thương hiệu + vai trò tuỳ chỉnh đọc lại được. */
  brandingOk: boolean;
  roleOk: boolean;
};

export type PgDrillEvidence = {
  names: DrillNames;
  /** Ảnh chụp CSDL tổ chức ngay trước khi dump (sau mọi tuỳ biến). */
  before: DbSnapshot;
  /** Ảnh chụp sau khi PHÁ (trước khi DROP) — phải KHÁC `before`, nếu không phép so là mù. */
  broken: DbSnapshot;
  /** CSDL tổ chức không còn trong `pg_database` sau `DROP DATABASE`. */
  droppedGone: boolean;
  /** Ảnh chụp sau khôi phục (trước khi mã ứng dụng chạm vào). */
  after: DbSnapshot;
  controlPlaneBefore: string;
  controlPlaneAfter: string;
  blueprintBefore: string;
  blueprintAfter: string;
  dump: { exitCode: number; bytes: number; ms: number; tocMissing: string[] };
  restore: { createdbExit: number; restoreExit: number; restoreErrors: number; renamedTo: string; ms: number };
  app: AppEvidence | null;
};

export type DrillVerdict = { ok: boolean; failures: string[] };

export function judgePgRestoreDrill(ev: PgDrillEvidence): DrillVerdict {
  const f: string[] = [];
  const { names } = ev;

  // Tên: không bao giờ khôi phục vào một tên mà sao lưu đêm sẽ coi là tổ chức thật.
  try {
    const n = drillNames(names.orgCode);
    if (n.orgDatabase !== names.orgDatabase || n.tempDatabase !== names.tempDatabase) f.push("Tên CSDL của bằng chứng không khớp tên dẫn xuất từ mã tổ chức diễn tập.");
  } catch (e) {
    f.push(e instanceof Error ? e.message : String(e));
  }

  // Ảnh "trước" phải có thật — bảng đã gieo có dòng.
  const emptySeeded = DRILL_SEEDED_TABLES.filter((t) => (ev.before.tables[t]?.rows ?? 0) === 0);
  if (emptySeeded.length > 0) f.push(`Ảnh "trước" thiếu dữ liệu ở bảng đã gieo: ${emptySeeded.join(", ")} — phép so trước/sau sẽ so hai cái rỗng.`);

  // Sao lưu.
  if (ev.dump.exitCode !== 0) f.push(`pg_dump thoát ${ev.dump.exitCode}.`);
  if (!(ev.dump.bytes > 0)) f.push("Bản dump rỗng.");
  if (ev.dump.tocMissing.length > 0) f.push(`Mục lục bản dump thiếu dữ liệu bảng lõi: ${ev.dump.tocMissing.join(", ")} (cùng phép kiểm của erp-backup.sh).`);

  // Phá: phải thật sự khác, và CSDL phải thật sự mất.
  if (diffSnapshots(ev.before, ev.broken).length === 0) f.push("Bản đã PHÁ vẫn BẰNG bản gốc — phép so mù, không chứng minh được khôi phục.");
  if (!ev.droppedGone) f.push("CSDL tổ chức vẫn còn sau DROP DATABASE — khôi phục có thể chỉ là mở lại CSDL cũ.");

  // Khôi phục.
  if (ev.restore.createdbExit !== 0) f.push(`createdb thoát ${ev.restore.createdbExit}.`);
  if (ev.restore.restoreExit !== 0 || ev.restore.restoreErrors > 0) f.push(`pg_restore thoát ${ev.restore.restoreExit} với ${ev.restore.restoreErrors} dòng lỗi — runbook nói DỪNG.`);
  if (ev.restore.renamedTo !== names.orgDatabase) f.push(`CSDL tạm đổi tên thành «${ev.restore.renamedTo}», không phải ${names.orgDatabase}.`);

  // So.
  const d = diffSnapshots(ev.before, ev.after);
  if (d.length > 0) f.push(`CSDL khôi phục KHÁC bản gốc (${d.length} chỗ): ${d.slice(0, 8).join(" · ")}${d.length > 8 ? " · …" : ""}`);
  if (ev.controlPlaneBefore !== ev.controlPlaneAfter) f.push("Dòng mặt phẳng điều khiển của tổ chức (sổ + module) khác trước diễn tập.");
  if (!ev.blueprintBefore || ev.blueprintBefore !== ev.blueprintAfter) f.push(`Blueprint xuất lại khác bản trước (${ev.blueprintBefore || "—"} → ${ev.blueprintAfter || "—"}).`);

  // Chạy thật.
  const a = ev.app;
  if (!a) {
    f.push("Không có bằng chứng CHẠY THẬT — tệp tồn tại chưa phải tổ chức chạy được.");
    return { ok: false, failures: f };
  }
  if (!a.recordsReadOk) f.push("Không đọc lại được bản ghi tuỳ biến với đúng giá trị đã gieo.");
  if (!a.relationsOk) f.push("Quan hệ (một / nhiều / chiều ngược) không ra đúng bản ghi đã gieo.");
  if (!a.fileOk) f.push("Tệp đính kèm không mở lại ra đúng byte.");
  if (a.pagesResolved < 2 || a.blocks === 0) f.push(`Chỉ phân giải được ${a.pagesResolved} trang / ${a.blocks} khối — cần ≥ 2 trang đã xuất bản.`);
  if (a.blockErrors.length > 0) f.push(`Trang có lỗi khối: ${a.blockErrors.join(" · ")}`);
  if (a.navSlugs.length < 2) f.push(`Menu chỉ còn ${a.navSlugs.length} mục trang.`);
  if (a.rerunExecuted !== 0 || a.runsAfterRerun !== a.runsBefore || a.tasksAfterRerun !== a.tasksBefore) {
    f.push(`Chạy luật lại sau khôi phục đã NHÂN ĐÔI việc: thực thi ${a.rerunExecuted}, lượt ${a.runsBefore} → ${a.runsAfterRerun}, việc ${a.tasksBefore} → ${a.tasksAfterRerun}.`);
  }
  if (a.newRecordWaiting !== 1) f.push(`Bản ghi mới sau khôi phục sinh ${a.newRecordWaiting} lượt xin duyệt (phải đúng 1) — động cơ luật không chạy trên CSDL khôi phục.`);
  if (!a.sameKeyLarkOk || !a.sameKeyAiOk) f.push("CÙNG khoá mà không giải ra đúng bí mật kết nối.");
  if (!a.wrongKeyLarkRejected || !a.wrongKeyAiRejected) f.push("Khoá KHÁC vẫn mở được bí mật — không fail closed.");
  if (a.wrongKeyFetchCalls !== 0) f.push(`Khoá KHÁC mà vẫn gọi ra ngoài ${a.wrongKeyFetchCalls} lần.`);
  if (!a.loginAdminOk || !a.loginRoleUserOk) f.push("Người dùng của tổ chức không đăng nhập được sau khôi phục.");
  if (!a.loginWrongPasswordRejected) f.push("Sai mật khẩu vẫn đăng nhập được.");
  if (!a.brandingOk) f.push("Thương hiệu của tổ chức không đọc lại được.");
  if (!a.roleOk) f.push("Vai trò tuỳ chỉnh / gán vai trò không đọc lại được.");
  return { ok: f.length === 0, failures: f };
}
