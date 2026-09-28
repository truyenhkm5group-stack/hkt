/**
 * ═══════════ DIỄN TẬP KHÔI PHỤC CẤU HÌNH MỘT TỔ CHỨC (Commercial readiness C) ═══════════
 *
 * `tests/org-export.test.ts` đã chứng minh vòng tròn A → tệp → B TRỐNG (mã KHÁC) trong MỘT tiến trình. Bài này phủ phần
 * nó không phủ được và không lặp lại phần nó đã phủ:
 *
 *  1. PHÁN QUYẾT (`judgeConfigRestoreDrill`) — hàm thuần: bằng chứng ĐẠT ⇒ đạt; phá từng vế ⇒ đúng một câu hỏng nói
 *     đúng vế đó. Không có phần này thì một phép so luôn-đúng làm diễn tập xanh mà không chứng minh gì.
 *  2. PHẠM VI khai báo khớp mã nguồn: bảng mặt phẳng điều khiển = đúng các bảng `platform_*` trong lược đồ = đúng các
 *     bảng `migrateOrganizationDb` dọn khỏi CSDL tổ chức; bảng cấu hình tổ chức đều có trong lược đồ, không bảng nào là
 *     `platform_*`.
 *  3. CHẠY THẬT `scripts/restore-drill-org-config.ts` (ba tiến trình, PGlite riêng): cùng MÃ tổ chức, CSDL bị XOÁ
 *     giữa hai bước, cài lại từ tệp ⇒ ĐẠT; thư mục dữ liệu được dọn. Đây là thứ một tiến trình duy nhất không làm được:
 *     `db/index.ts` đệm handle theo mã, nên "cấp lại cùng mã" trong cùng tiến trình chỉ mở lại CSDL cũ.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  CONTROL_PLANE_TABLES,
  DRILL_WRITTEN_TABLES,
  ORG_CONFIG_TABLES,
  blueprintLeaks,
  judgeConfigRestoreDrill,
  type RestoreEvidence,
  type SourceEvidence,
} from "@/lib/blueprints/restore-drill";

const SCRIPT = path.join("scripts", "restore-drill-org-config.ts");

function nguonTot(): SourceEvidence {
  const orgRows = Object.fromEntries(ORG_CONFIG_TABLES.map((t) => [t, (DRILL_WRITTEN_TABLES as readonly string[]).includes(t) ? 3 : 0])) as SourceEvidence["orgRows"];
  return {
    orgCode: "dt-x",
    contentHash: "a".repeat(32),
    fileSha256: "f".repeat(64),
    fileBytes: 1000,
    valid: true,
    counts: { modules: 8, pages: 2, workflows: 2 },
    omitted: 0,
    lossy: 0,
    customRecords: 1,
    orgRows,
    homeDelta: Object.fromEntries(ORG_CONFIG_TABLES.map((t) => [t, 0])) as SourceEvidence["homeDelta"],
    controlPlaneRowsInOrg: Object.fromEntries(CONTROL_PLANE_TABLES.map((t) => [t, 0])) as SourceEvidence["controlPlaneRowsInOrg"],
    registryDeltaInHome: 7,
    orgTableCount: 185,
    homeTableCount: 185,
  };
}

function khoiPhucTot(): RestoreEvidence {
  return {
    orgCode: "dt-x",
    orgDatabaseGone: true,
    registryGone: true,
    fileSha256: "f".repeat(64),
    emptyContentHash: "e".repeat(32),
    customRecordsBefore: 0,
    planOk: true,
    conflicts: 0,
    blocked: 0,
    installOk: true,
    installErrors: [],
    contentHash: "a".repeat(32),
    valid: true,
    counts: { pages: 2, modules: 8, workflows: 2 },
    customRecordsAfter: 0,
    reinstallWrites: 0,
    leaks: [],
  };
}

function testPhanQuyet() {
  const goc = judgeConfigRestoreDrill(nguonTot(), khoiPhucTot());
  assert.deepEqual(goc, { ok: true, failures: [] }, "bằng chứng đủ ⇒ ĐẠT (thứ tự khoá của counts không làm lệch)");

  // Mỗi đột biến phá ĐÚNG một vế ⇒ KHÔNG ĐẠT, và câu hỏng nói đúng vế đó.
  const dotBien: [string, (s: SourceEvidence, r: RestoreEvidence) => void, RegExp][] = [
    ["băm sau khôi phục lệch", (_s, r) => (r.contentHash = "b".repeat(32)), /Băm nội dung sau khôi phục/],
    ["tổ chức trống đã cùng băm (phép so mù)", (_s, r) => (r.emptyContentHash = "a".repeat(32)), /phép so băm mù/],
    ["CSDL chưa mất", (_s, r) => (r.orgDatabaseGone = false), /VẪN CÒN lúc khôi phục/],
    ["sổ tổ chức chưa mất", (_s, r) => (r.registryGone = false), /Dòng sổ tổ chức VẪN CÒN/],
    ["tệp bị đổi giữa hai bước", (_s, r) => (r.fileSha256 = "0".repeat(64)), /sha256 lệch/],
    ["cài thất bại", (_s, r) => ((r.installOk = false), (r.installErrors = ["x: y"])), /Cài từ tệp THẤT BẠI: x: y/],
    ["kế hoạch có xung đột", (_s, r) => (r.conflicts = 2), /2 XUNG ĐỘT/],
    ["kế hoạch có bước bị chặn", (_s, r) => (r.blocked = 1), /1 bước BỊ CHẶN/],
    ["cài lại chưa hội tụ", (_s, r) => (r.reinstallWrites = 3), /còn 3 mục phải ghi/],
    ["gói mang dữ liệu", (_s, r) => (r.customRecordsAfter = 1), /gói cấu hình đã mang DỮ LIỆU/],
    ["gói rò", (_s, r) => (r.leaks = ["có email: a@b.cd"]), /Gói rò: có email/],
    ["số mục lệch", (_s, r) => (r.counts = { ...r.counts, pages: 1 }), /Số mục theo loại lệch/],
    ["tổ chức cấp lại không trống", (_s, r) => (r.customRecordsBefore = 4), /không trống: 4 bản ghi/],
    ["nguồn không có dữ liệu để thử", (s) => (s.customRecords = 0), /chưa được thử/],
    ["bảng cấu hình rỗng ở CSDL tổ chức", (s) => (s.orgRows.meta_pages = 0), /Bảng meta_pages RỖNG/],
    ["cấu hình rò sang CSDL nhà", (s) => (s.homeDelta.workflow_rules = 2), /ghi 2 dòng vào bảng workflow_rules của CSDL NHÀ/],
    ["không đếm được ở nhà ⇒ CHƯA BIẾT, không phải 0", (s) => (s.homeDelta.settings = null), /CHƯA BIẾT cấu hình có rò sang nhà/],
    ["mặt phẳng điều khiển trong CSDL tổ chức", (s) => (s.controlPlaneRowsInOrg.platform_organizations = 1), /1 dòng platform_organizations/],
    ["sổ tổ chức không ở nhà", (s) => (s.registryDeltaInHome = 0), /mặt phẳng điều khiển đi theo bản sao của nhà/],
    ["hai lược đồ khác nhau", (s) => (s.orgTableCount = 184), /cùng một lược đồ/],
    ["gói nguồn không hợp lệ", (s) => (s.valid = false), /KHÔNG qua validateBlueprint/],
  ];
  for (const [ten, pha, mau] of dotBien) {
    const s = nguonTot();
    const r = khoiPhucTot();
    pha(s, r);
    const v = judgeConfigRestoreDrill(s, r);
    assert.equal(v.ok, false, `đột biến «${ten}» phải làm diễn tập KHÔNG ĐẠT`);
    assert.ok(v.failures.some((f) => mau.test(f)), `đột biến «${ten}»: câu hỏng phải nói đúng vế — nhận ${JSON.stringify(v.failures)}`);
  }

  // Bộ quét rò (dùng chung với tests/org-export.test.ts).
  assert.deepEqual(blueprintLeaks({ a: "sạch" }, ["bi-mat"]), []);
  assert.equal(blueprintLeaks({ a: "x bi-mat y", b: "qt@to-chuc.vn", c: "0e8f1c2a-1b2c-4d5e-8f9a-0b1c2d3e4f5a" }, ["bi-mat"]).length, 3);
  console.log(`✓ Diễn tập khôi phục cấu hình · phán quyết: bằng chứng đủ ⇒ ĐẠT · ${dotBien.length} đột biến, mỗi cái ⇒ KHÔNG ĐẠT với đúng câu hỏng · bộ quét rò chung`);
}

function testPhamViKhopMaNguon() {
  const schema = readFileSync("db/schema.ts", "utf8");
  const bang = [...schema.matchAll(/pgTable\(\s*"([a-z_0-9]+)"/g)].map((m) => m[1]);
  const platform = bang.filter((b) => b.startsWith("platform_")).sort();
  assert.deepEqual([...CONTROL_PLANE_TABLES].sort(), platform, "CONTROL_PLANE_TABLES phải là ĐÚNG các bảng platform_* của lược đồ — thêm bảng mặt phẳng điều khiển thì khai ở đây");
  const migrate = readFileSync("db/migrate.ts", "utf8");
  const iOrg = migrate.indexOf("export async function migrateOrganizationDb");
  const donDep = [...migrate.slice(iOrg).matchAll(/delete from (platform_[a-z_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(donDep, platform, "migrateOrganizationDb phải dọn ĐÚNG mọi bảng platform_* khỏi CSDL tổ chức — bảng nào sót thì bản dump tổ chức mang theo một bản sao nói dối của sổ");
  for (const t of ORG_CONFIG_TABLES) {
    assert.ok(bang.includes(t), `bảng cấu hình ${t} không có trong db/schema.ts`);
    assert.ok(!t.startsWith("platform_"), `${t} là mặt phẳng điều khiển, không phải cấu hình tổ chức`);
  }
  for (const t of DRILL_WRITTEN_TABLES) assert.ok((ORG_CONFIG_TABLES as readonly string[]).includes(t));

  // Kịch bản: không đọc .env, CSDL là PGlite riêng, tiến trình con không qua shell.
  const src = readFileSync(SCRIPT, "utf8");
  assert.ok(!/dotenv/.test(src), "kịch bản diễn tập KHÔNG được nạp .env — một .env trỏ production biến diễn tập thành tổ chức mới trên production");
  assert.match(src, /DATABASE_URL: `pglite:\/\/\$\{dataDir\}`/, "điều phối đặt DATABASE_URL về PGlite riêng của lượt diễn tập");
  assert.match(src, /shell: false/);
  assert.ok(!/shell:\s*true/.test(src));
  console.log(`✓ Diễn tập khôi phục cấu hình · phạm vi: ${platform.length} bảng platform_* = CONTROL_PLANE_TABLES = đúng các bảng migrateOrganizationDb dọn · ${ORG_CONFIG_TABLES.length} bảng cấu hình tổ chức đều có trong lược đồ · kịch bản không đọc .env, PGlite riêng, không shell`);
}

function testChayThat() {
  const truoc = new Set(existsSync("data") ? readdirSync("data") : []);
  const cli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  // Môi trường thừa kế nguyên: điều phối TỰ đặt DATABASE_URL về PGlite riêng của lượt, bất kể máy đang khai gì.
  const r = spawnSync(process.execPath, [cli, "--tsconfig", "tsconfig.json", SCRIPT, "--ma=dt-kiem"], { encoding: "utf8", shell: false, timeout: 600_000, maxBuffer: 1 << 24 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `diễn tập phải ĐẠT:\n${out.slice(-3000)}`);
  assert.match(out, /KẾT QUẢ: ĐẠT/);
  assert.match(out, /2\/3 MẤT: đã xoá CSDL tổ chức/, "CSDL tổ chức phải bị xoá THẬT giữa hai bước");
  assert.match(out, /CSDL cũ đã mất/);
  const nguon = /Băm nội dung — NGUỒN\s+([0-9a-f]{32})/.exec(out)?.[1];
  const sau = /Băm nội dung — SAU KHÔI PHỤC\s+([0-9a-f]{32})/.exec(out)?.[1];
  const trong = /Băm nội dung — tổ chức TRỐNG\s+([0-9a-f]{32})/.exec(out)?.[1];
  assert.ok(nguon && sau && trong, `báo cáo phải in ba băm:\n${out.slice(-2000)}`);
  assert.equal(sau, nguon, "băm sau khôi phục = băm nguồn");
  assert.notEqual(trong, nguon, "tổ chức trống KHÁC nguồn — phép so không mù");
  const sau2 = new Set(existsSync("data") ? readdirSync("data") : []);
  const sot = [...sau2].filter((d) => !truoc.has(d) && /restore-drill/.test(d));
  assert.deepEqual(sot, [], "diễn tập phải dọn thư mục PGlite + tệp gói của nó");
  console.log(`✓ Diễn tập khôi phục cấu hình · CHẠY THẬT (3 tiến trình, PGlite riêng): cùng mã, CSDL + sổ bị xoá giữa hai bước ⇒ cài lại từ tệp, băm ${sau} = nguồn, tổ chức trống ${trong} khác nguồn · dọn sạch`);
}

export function testRestoreDrillConfig() {
  testPhanQuyet();
  testPhamViKhopMaNguon();
  testChayThat();
}
