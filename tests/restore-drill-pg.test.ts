/**
 * ═══════════ DIỄN TẬP KHÔI PHỤC TỔ CHỨC TRÊN POSTGRES THẬT — PHẦN KIỂM ĐƯỢC KHÔNG CẦN POSTGRES ═══════════
 *
 * Lượt chạy thật (`scripts/restore-drill-pg.ts`) cần một máy Postgres dùng một lần + pg_dump, nên nó chạy ở workflow
 * `.github/workflows/restore-drill.yml` (service container), không trong `npm test`. Bài này khoá những thứ đo được từ
 * mã nguồn, để lượt chạy thật không thể xanh vì một lý do sai:
 *
 *  1. TÊN — mã tổ chức diễn tập bắt buộc `drill-`; CSDL tạm không bao giờ bắt đầu bằng `erp_org_` (sao lưu đêm sẽ dump
 *     nó như một tổ chức thật); hai hằng mẫu KHỚP ĐÚNG mẫu của `erp-backup.sh` (không gõ lại).
 *  2. HÀNG RÀO XOÁ — lệnh DROP chỉ nhận đúng hai tên của lượt; `erp`, `postgres`, một `erp_org_*` thật, một tên có dấu
 *     nháy đều NÉM.
 *  3. HÀNG RÀO MÔI TRƯỜNG — thiếu lời khẳng định, máy không phải localhost, nhà không tên `erp`, nhà ĐÃ có bảng, máy đã có
 *     tổ chức khác ⇒ mỗi thứ tự từ chối.
 *  4. LỆNH — argv createdb / pg_dump / pg_restore dựng lại ĐÚNG chuỗi trong `erp-backup.sh` và runbook mục 7.
 *  5. PHÁN QUYẾT — bằng chứng đạt ⇒ đạt; phá từng vế ⇒ một câu hỏng nói đúng vế đó (phép so không mù).
 *  6. WORKFLOW — không secret, không SSH / VPS, chỉ chạy tay, cùng ảnh Postgres với production, không nằm trong cổng deploy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_DRILL_ORG_CODE,
  DRILL_SEEDED_TABLES,
  DUMP_CORE_TABLES,
  ORG_DATABASE_PATTERN,
  TEMP_DATABASE_PATTERN,
  TEMP_DATABASE_PREFIX,
  assertDropAllowed,
  createdbArgs,
  diffSnapshots,
  drillNames,
  dumpArgs,
  judgeDrillEnvironment,
  judgePgRestoreDrill,
  missingCoreTables,
  restoreArgs,
  type AppEvidence,
  type DbSnapshot,
  type PgDrillEvidence,
} from "@/lib/platform/restore-drill-pg";

const doc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const WORKFLOW = ".github/workflows/restore-drill.yml";

/* ═════════════ 1 · TÊN ═════════════ */

function testTen() {
  const n = drillNames(DEFAULT_DRILL_ORG_CODE);
  assert.deepEqual(n, { orgCode: "drill-ws", orgDatabase: "erp_org_drill_ws", tempDatabase: "tam_khoiphuc_drill_ws" });
  assert.equal(drillNames("drill-a-b2").tempDatabase, "tam_khoiphuc_drill_a_b2");
  for (const sai of ["vnx", "bp-a", "drill-", "drill", "Drill-ws", "drill_ws", "drill-ws-", "x-drill-ws", "drill-ws;drop", `drill-${"a".repeat(30)}`]) {
    assert.throws(() => drillNames(sai), /không phải mã tổ chức diễn tập/, `«${sai}» không được là mã diễn tập`);
  }
  for (const code of ["drill-ws", "drill-a", "drill-0-9"]) {
    const x = drillNames(code);
    assert.ok(ORG_DATABASE_PATTERN.test(x.orgDatabase) && x.orgDatabase.startsWith("erp_org_drill_"), code);
    assert.ok(TEMP_DATABASE_PATTERN.test(x.tempDatabase) && !x.tempDatabase.startsWith("erp_org_") && !ORG_DATABASE_PATTERN.test(x.tempDatabase), `${code}: tên tạm qua hai hàng rào`);
  }

  // Mẫu tên ĐỌC TỪ erp-backup.sh — lệch là diễn tập đặt tên theo một luật khác luật sao lưu đêm.
  const sh = doc("scripts/erp-backup.sh");
  const bien = (ten: string) => {
    const m = new RegExp(`^${ten}=['"]([^'"]+)['"]`, "m").exec(sh);
    assert.ok(m, `erp-backup.sh phải khai ${ten}`);
    return m[1];
  };
  assert.equal(ORG_DATABASE_PATTERN.source, bien("MAU_CSDL_TO_CHUC"), "mẫu CSDL tổ chức = MAU_CSDL_TO_CHUC");
  assert.equal(TEMP_DATABASE_PATTERN.source, bien("MAU_CSDL_TAM"), "mẫu CSDL tạm = MAU_CSDL_TAM");
  assert.equal(TEMP_DATABASE_PREFIX, bien("TIEN_TO_CSDL_TAM"), "tiền tố CSDL tạm = TIEN_TO_CSDL_TAM");
  assert.deepEqual([...DUMP_CORE_TABLES], bien("BANG_LOI_TO_CHUC").split(/\s+/), "bảng lõi của mục lục = BANG_LOI_TO_CHUC");
  console.log("✓ Diễn tập Postgres · tên: mã drill-* ⇒ erp_org_drill_* + tam_khoiphuc_drill_* · mẫu khớp erp-backup.sh");
}

/* ═════════════ 2 · HÀNG RÀO XOÁ ═════════════ */

function testHangRaoXoa() {
  const n = drillNames("drill-ws");
  assert.doesNotThrow(() => assertDropAllowed("erp_org_drill_ws", n));
  assert.doesNotThrow(() => assertDropAllowed("tam_khoiphuc_drill_ws", n));
  for (const sai of ["erp", "postgres", "template0", "template1", "erp_org_vnx", "erp_org_bp_a", "erp_org_drill_khac", "tam_khoiphuc_bp_a", "tam_khoiphuc_drill_khac", "hong_drill_ws_20260929", 'erp_org_drill_ws"; drop database erp; --', "ERP_ORG_DRILL_WS", ""]) {
    assert.throws(() => assertDropAllowed(sai, n), /TỪ CHỐI xoá CSDL/, `không bao giờ xoá «${sai}»`);
  }
  // Bằng chứng giả mạo tên (không dẫn xuất từ mã drill) cũng không mở được hàng rào.
  const gia = { orgCode: "vnx", orgDatabase: "erp", tempDatabase: "erp_org_vnx" };
  assert.throws(() => assertDropAllowed("erp", gia), /TỪ CHỐI/);
  assert.throws(() => assertDropAllowed("erp_org_vnx", gia), /TỪ CHỐI/);
  console.log("✓ Diễn tập Postgres · DROP chỉ nhận đúng hai CSDL của lượt; erp / erp_org_* thật / tên có nháy đều bị từ chối");
}

/* ═════════════ 3 · HÀNG RÀO MÔI TRƯỜNG ═════════════ */

function testMoiTruong() {
  const n = drillNames("drill-ws");
  const tot = { host: "localhost", database: "erp", ack: "1", publicTablesBefore: 0, orgDatabases: [] as string[] };
  assert.deepEqual(judgeDrillEnvironment(tot, n), [], "máy tạm mới tinh ⇒ được chạy");
  assert.deepEqual(judgeDrillEnvironment({ ...tot, host: "127.0.0.1", orgDatabases: ["erp_org_drill_ws"] }, n), [], "CSDL của chính lượt diễn tập không tính là tổ chức khác");
  const hong: [Partial<typeof tot>, RegExp][] = [
    [{ ack: undefined }, /ERP_RESTORE_DRILL_EPHEMERAL/],
    [{ ack: "true" }, /ERP_RESTORE_DRILL_EPHEMERAL/],
    [{ host: "db" }, /vòng lặp nội bộ/],
    [{ host: "erp.vnxcommerce.com" }, /vòng lặp nội bộ/],
    [{ database: "erp_prod" }, /phải tên «erp»/],
    [{ publicTablesBefore: 186 }, /MỚI TINH/],
    [{ publicTablesBefore: 1 }, /MỚI TINH/],
    [{ orgDatabases: ["erp_org_khach_a"] }, /tổ chức khác/],
  ];
  for (const [doi, re] of hong) {
    const r = judgeDrillEnvironment({ ...tot, ...doi }, n);
    assert.equal(r.length, 1, `${JSON.stringify(doi)}: đúng một lý do`);
    assert.match(r[0], re, JSON.stringify(doi));
  }
  console.log("✓ Diễn tập Postgres · môi trường: 5 hàng rào độc lập (khẳng định, localhost, tên nhà, nhà trống, không tổ chức khác)");
}

/* ═════════════ 4 · LỆNH = lệnh của sao lưu đêm và runbook ═════════════ */

function testLenh() {
  const sh = doc("scripts/erp-backup.sh");
  const cau = (argv: string[], thay: Record<string, string>) => argv.map((a) => thay[a] ?? a).join(" ");
  assert.ok(sh.includes(`docker exec "$DB_CONTAINER" ${cau(dumpArgs("X"), { X: '"$csdl"' })} >`), "pg_dump của diễn tập = lệnh dump tổ chức của erp-backup.sh");
  assert.ok(sh.includes(`${cau(restoreArgs("X"), { X: '"$tam"' })} /drill/ban.dump`), "pg_restore của diễn tập = cờ của restore-drill-org trong erp-backup.sh");
  const rb = doc("docs/backup-restore.md");
  assert.ok(rb.includes(`docker exec -i erp-db ${cau(createdbArgs("X"), { X: "tam_khoiphuc_<mã>" })}\n`), "createdb = runbook mục 7");
  assert.ok(rb.includes(`docker exec -i erp-db ${cau(restoreArgs("X"), { X: "tam_khoiphuc_<mã>" })} < `), "pg_restore = runbook mục 7");
  assert.deepEqual(dumpArgs("erp_org_drill_ws"), ["pg_dump", "-U", "erp", "-d", "erp_org_drill_ws", "-Fc"]);

  const toc = [
    "3456; 0 16390 TABLE DATA public users erp",
    "3457; 0 16400 TABLE DATA public settings erp",
    "3458; 0 16500 TABLE DATA drizzle __drizzle_migrations erp",
  ].join("\n");
  assert.deepEqual(missingCoreTables(`${toc}\n`), [], "đủ ba bảng lõi");
  assert.deepEqual(missingCoreTables(toc.split("\n").slice(1).join("\n") + "\n"), ["public.users"], "thiếu users ⇒ nói đúng tên");
  assert.deepEqual(missingCoreTables("3456; 0 16390 TABLE DATA public users_archive erp\n"), [...DUMP_CORE_TABLES], "users_archive không phải users (so cả dấu cách sau tên)");
  console.log("✓ Diễn tập Postgres · createdb / pg_dump / pg_restore = đúng chuỗi của erp-backup.sh và runbook mục 7");
}

/* ═════════════ 5 · SO + PHÁN QUYẾT ═════════════ */

function snap(over: Partial<Record<string, { rows: number; hash: string }>> = {}): DbSnapshot {
  const tables: DbSnapshot["tables"] = {};
  for (const t of DRILL_SEEDED_TABLES) tables[t] = { rows: 3, hash: `h-${t}` };
  tables["public.orders"] = { rows: 0, hash: "rong" };
  for (const [k, v] of Object.entries(over)) if (v) tables[k] = v;
  return { tables, sequences: { "public.some_seq": "7" } };
}

function appTot(): AppEvidence {
  return {
    recordsReadOk: true,
    relationsOk: true,
    fileOk: true,
    pagesResolved: 2,
    blocks: 9,
    blockErrors: [],
    navSlugs: ["cong-no-khach-hang", "hop-dong-dai-ly"],
    rerunExecuted: 0,
    runsBefore: 2,
    runsAfterRerun: 2,
    tasksBefore: 1,
    tasksAfterRerun: 1,
    newRecordWaiting: 1,
    sameKeyLarkOk: true,
    sameKeyAiOk: true,
    wrongKeyLarkRejected: true,
    wrongKeyAiRejected: true,
    wrongKeyFetchCalls: 0,
    loginAdminOk: true,
    loginRoleUserOk: true,
    loginWrongPasswordRejected: true,
    brandingOk: true,
    roleOk: true,
  };
}

function evTot(): PgDrillEvidence {
  return {
    names: drillNames("drill-ws"),
    before: snap(),
    broken: snap({ "public.custom_values": { rows: 0, hash: "rong" } }),
    droppedGone: true,
    after: snap(),
    controlPlaneBefore: "cp",
    controlPlaneAfter: "cp",
    blueprintBefore: "b".repeat(32),
    blueprintAfter: "b".repeat(32),
    dump: { exitCode: 0, bytes: 700_000, ms: 200, tocMissing: [] },
    restore: { createdbExit: 0, restoreExit: 0, restoreErrors: 0, renamedTo: "erp_org_drill_ws", ms: 1000 },
    app: appTot(),
  };
}

function testSoAnh() {
  assert.deepEqual(diffSnapshots(snap(), snap()), []);
  assert.deepEqual(diffSnapshots(snap(), snap({ "public.users": { rows: 2, hash: "x" } })), ["public.users: 3 → 2 dòng"]);
  assert.deepEqual(diffSnapshots(snap(), snap({ "public.users": { rows: 3, hash: "x" } })), ["public.users: cùng 3 dòng nhưng NỘI DUNG khác"], "cùng số dòng mà khác nội dung vẫn bị bắt");
  const thieu = snap();
  delete thieu.tables["public.orders"];
  assert.deepEqual(diffSnapshots(snap(), thieu), ["public.orders: bảng THIẾU sau khôi phục"], "bảng rỗng biến mất vẫn là lệch");
  assert.deepEqual(diffSnapshots(thieu, snap()), ["public.orders: bảng THỪA sau khôi phục"]);
  assert.deepEqual(diffSnapshots(snap(), { ...snap(), sequences: { "public.some_seq": "3" } }), ["sequence public.some_seq: 7 → 3"], "sequence lùi = id sẽ đụng nhau sau khôi phục");
  console.log("✓ Diễn tập Postgres · so ảnh: số dòng, nội dung cùng số dòng, bảng thiếu / thừa, sequence");
}

function testPhanQuyet() {
  const tot = judgePgRestoreDrill(evTot());
  assert.deepEqual(tot, { ok: true, failures: [] }, `bằng chứng đạt ⇒ đạt: ${JSON.stringify(tot.failures)}`);

  const pha = (ten: string, doi: (e: PgDrillEvidence) => void, re: RegExp) => {
    const e = evTot();
    doi(e);
    const v = judgePgRestoreDrill(e);
    assert.equal(v.ok, false, `${ten}: phải KHÔNG ĐẠT`);
    assert.ok(v.failures.some((f) => re.test(f)), `${ten}: câu hỏng phải nói đúng vế — ${JSON.stringify(v.failures)}`);
  };
  const app = (doi: (a: AppEvidence) => void) => (e: PgDrillEvidence) => {
    if (e.app) doi(e.app);
  };
  pha("tên lạ", (e) => (e.names = { orgCode: "vnx", orgDatabase: "erp", tempDatabase: "erp_org_vnx" }), /không phải mã tổ chức diễn tập/);
  pha("tên lệch mã", (e) => (e.names = { ...e.names, tempDatabase: "tam_khoiphuc_khac" }), /không khớp tên dẫn xuất/);
  pha("ảnh trước rỗng", (e) => (e.before = snap({ "public.workflow_runs": { rows: 0, hash: "rong" } })), /thiếu dữ liệu ở bảng đã gieo: public\.workflow_runs/);
  pha("pg_dump hỏng", (e) => (e.dump.exitCode = 1), /pg_dump thoát 1/);
  pha("dump rỗng", (e) => (e.dump.bytes = 0), /Bản dump rỗng/);
  pha("mục lục thiếu", (e) => (e.dump.tocMissing = ["public.users"]), /Mục lục bản dump thiếu/);
  pha("phá mà không khác", (e) => (e.broken = snap()), /phép so mù/);
  pha("DROP không mất", (e) => (e.droppedGone = false), /VẪN còn|vẫn còn/i);
  pha("createdb hỏng", (e) => (e.restore.createdbExit = 1), /createdb thoát 1/);
  pha("pg_restore lỗi", (e) => (e.restore.restoreErrors = 2), /runbook nói DỪNG/);
  pha("đổi tên hỏng", (e) => (e.restore.renamedTo = ""), /đổi tên/);
  pha("khôi phục lệch", (e) => (e.after = snap({ "public.custom_files": { rows: 3, hash: "khac" } })), /KHÁC bản gốc.*custom_files/);
  pha("sequence lệch", (e) => (e.after = { ...snap(), sequences: {} }), /KHÁC bản gốc.*sequence/);
  pha("mặt phẳng điều khiển lệch", (e) => (e.controlPlaneAfter = "khac"), /mặt phẳng điều khiển/);
  pha("blueprint lệch", (e) => (e.blueprintAfter = "c".repeat(32)), /Blueprint xuất lại khác/);
  pha("blueprint rỗng cả hai", (e) => ((e.blueprintBefore = ""), (e.blueprintAfter = "")), /Blueprint xuất lại khác/);
  pha("không chạy thật", (e) => (e.app = null), /CHẠY THẬT/);
  pha("đọc bản ghi sai", app((a) => (a.recordsReadOk = false)), /bản ghi tuỳ biến/);
  pha("quan hệ sai", app((a) => (a.relationsOk = false)), /Quan hệ/);
  pha("tệp sai", app((a) => (a.fileOk = false)), /Tệp đính kèm/);
  pha("một trang", app((a) => (a.pagesResolved = 1)), /≥ 2 trang/);
  pha("lỗi khối", app((a) => (a.blockErrors = ["hop-dong-dai-ly/bang_hd: NOT_FOUND"])), /lỗi khối/);
  pha("menu mất", app((a) => (a.navSlugs = ["hop-dong-dai-ly"])), /Menu/);
  pha("chạy lại thực thi", app((a) => (a.rerunExecuted = 1)), /NHÂN ĐÔI/);
  pha("chạy lại thêm lượt", app((a) => (a.runsAfterRerun = 3)), /NHÂN ĐÔI/);
  pha("chạy lại thêm việc", app((a) => (a.tasksAfterRerun = 2)), /NHÂN ĐÔI/);
  pha("động cơ luật chết", app((a) => (a.newRecordWaiting = 0)), /động cơ luật/);
  pha("cùng khoá không giải", app((a) => (a.sameKeyAiOk = false)), /CÙNG khoá/);
  pha("khoá khác mở được", app((a) => (a.wrongKeyLarkRejected = false)), /fail closed/);
  pha("khoá khác vẫn gọi ra ngoài", app((a) => (a.wrongKeyFetchCalls = 1)), /gọi ra ngoài/);
  pha("không đăng nhập được", app((a) => (a.loginRoleUserOk = false)), /không đăng nhập được/);
  pha("sai mật khẩu lọt", app((a) => (a.loginWrongPasswordRejected = false)), /Sai mật khẩu/);
  pha("thương hiệu mất", app((a) => (a.brandingOk = false)), /Thương hiệu/);
  pha("vai trò mất", app((a) => (a.roleOk = false)), /Vai trò/);
  console.log("✓ Diễn tập Postgres · phán quyết: đạt ⇒ đạt; 34 đột biến ⇒ mỗi cái một câu hỏng đúng vế");
}

/* ═════════════ 6 · WORKFLOW ═════════════ */

/** Bỏ dòng chú thích YAML: một câu GIẢI THÍCH vì sao không có secret không phải một lần dùng secret. */
const boChuThich = (src: string) =>
  src
    .split("\n")
    .filter((d) => !/^\s*#/.test(d))
    .join("\n");

function testWorkflow() {
  const raw = doc(WORKFLOW);
  const y = boChuThich(raw);
  assert.ok(!/secrets\./.test(y), "không đọc secret nào — kho PUBLIC, máy Postgres là máy tạm");
  assert.ok(!/\bssh\b|appleboy|VPS_|scp\b/i.test(y), "không SSH, không chạm VPS");
  assert.ok(!/PLATFORM_SECRETS_KEY/.test(y), "khoá bí mật kết nối KHÔNG khai trong workflow — kịch bản tự sinh khoá GIẢ trong bộ nhớ");

  const on = /^on:\n((?:[ \t].*\n?)*)/m.exec(y)?.[1] ?? "";
  assert.match(on, /^ {2}workflow_dispatch:/m, "chạy tay");
  assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ["workflow_dispatch"], "CHỈ workflow_dispatch — lịch tự động là quyết định của chủ nền tảng (launch-gates C7)");

  const quyen = /^permissions:\s*\n((?: {2}\S[^\n]*\n)+)/m.exec(y)?.[1] ?? "";
  assert.match(quyen, /contents:\s*read/);
  assert.ok(!/:\s*write/.test(y), "không quyền GHI nào");

  // Cùng ảnh Postgres với erp-db production — đọc từ compose, không gõ lại.
  const compose = doc("docker-compose.prod.yml");
  const anhProd = /\n {2}db:\n(?: {4}.*\n)*? {4}image:\s*(\S+)/.exec(compose)?.[1];
  assert.ok(anhProd, "đọc được ảnh của dịch vụ db trong docker-compose.prod.yml");
  const anhDrill = /services:\n {6}postgres:\n {8}image:\s*(\S+)/.exec(y)?.[1];
  assert.equal(anhDrill, anhProd, "service container dùng ĐÚNG ảnh của erp-db production");

  assert.match(y, /ERP_RESTORE_DRILL_EPHEMERAL:\s*"1"/);
  assert.match(y, /DATABASE_URL:\s*postgres:\/\/erp:[^@\s]+@localhost:5432\/erp\s*$/m, "DATABASE_URL trỏ service container ở localhost, CSDL nhà `erp`");
  assert.match(y, /ERP_DRILL_PG_CONTAINER:\s*\$\{\{\s*job\.services\.postgres\.id\s*\}\}/, "createdb / pg_dump / pg_restore chạy trong container như trên VPS");
  assert.match(y, /run: npx tsx --tsconfig tsconfig\.json scripts\/restore-drill-pg\.ts /);
  assert.match(y, /uses: actions\/upload-artifact@v4[\s\S]*path: restore-drill-report\.json/, "báo cáo JSON thành artifact");
  assert.ok(!/\.dump\b/.test(y.split("upload-artifact")[1] ?? ""), "bản dump KHÔNG được tải lên");

  // Không chặn deploy: cổng và deploy không gọi diễn tập.
  for (const f of [".github/workflows/gates.yml", ".github/workflows/deploy-vps.yml", ".github/workflows/ci.yml"]) {
    assert.ok(!doc(f).includes("restore-drill-pg") && !doc(f).includes("restore-drill.yml"), `${f} không được gọi diễn tập — nó không chặn deploy`);
  }
  console.log("✓ Diễn tập Postgres · workflow: chỉ chạy tay, 0 secret, 0 SSH, cùng ảnh postgres với production, không chặn deploy");
}

export function testRestoreDrillPg() {
  testTen();
  testHangRaoXoa();
  testMoiTruong();
  testLenh();
  testSoAnh();
  testPhanQuyet();
  testWorkflow();
}

if (process.argv[1] && /restore-drill-pg\.test\.ts$/.test(process.argv[1])) {
  testRestoreDrillPg();
}
