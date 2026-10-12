import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * ═══════════ CHẠY THỬ MIGRATION TRÊN BẢN SAO — ops `migration-rehearsal` ═══════════
 *
 * P0 12/10/2026: 0245 TIMEOUT ở câu UPDATE dẫn xuất trên tổ chức `qa`. scripts/erp-migration-rehearsal.sh đo root cause trên
 * BẢN SAO (bản dump mới nhất, container tạm) — không bao giờ trên erp-db. Bài này khoá:
 *   1. THAM SỐ (hàm thuần, chạy bash thật): mặc định đọc từ hằng số của script, cờ ghi / cờ lạ / số ngoài khoảng ⇒ mã 2,
 *      và câu lỗi KHÔNG lặp lại thứ người gõ.
 *   2. KỊCH BẢN psql: cắt câu ĐÚNG như drizzle (`--> statement-breakpoint`) trên chính tệp 0245, chế độ `ddl` chỉ bỏ câu
 *      ghi dữ liệu, trần statement_timeout của tệp được nâng và trần gốc được ghi lại.
 *   3. TÓM TẮT thời gian từng câu: định vị câu lỗi bằng SỐ DÒNG kịch bản, đánh dấu câu vượt trần GỐC.
 *   4. MÃ NGUỒN: bản sao đi qua ĐÚNG hàm khôi phục dùng chung với restore-drill-org, không lệnh nào vào erp-db ngoài
 *      `docker inspect`, kênh tóm tắt không mang mã hội thoại / page / luồng / chữ tin; ops mã hoá + làn DOC_NANG.
 *   5. CHẠY THẬT qua main với docker / free / df GIẢ: dựng container mang nhãn riêng, lệnh docker cuối là xoá container,
 *      không có bản / thiếu RAM / tham số sai ⇒ không dựng gì.
 *
 * Kỳ vọng dựng TỪ CHÍNH hằng số / tệp của kho (AGENTS.md mục 65), không gõ lại con số.
 * Đăng ký trong tests/sync-fixtures.test.ts (`testMigrationRehearsal`).
 */

const SCRIPT = "scripts/erp-migration-rehearsal.sh";
const MIG_0245 = "drizzle/0245_sales_chat_last_inbound.sql";
const docLF = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
/** Đường dẫn bash hiểu được trên cả Windows (Git Bash) lẫn Linux. */
const bashPath = (p: string) => path.resolve(p).split(path.sep).join("/");
const boChuThichShell = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

function hangSo(ten: string): number {
  const m = new RegExp(`^${ten}=(\\d+)`, "m").exec(docLF(SCRIPT));
  assert.ok(m, `${SCRIPT} phải khai hằng số ${ten}`);
  return Number(m[1]);
}

type Ra = { ma: number; ra: string };
function chayBash(noiDung: string): Ra {
  const tmp = mkdtempSync(path.join(tmpdir(), "mig-dien-tap-"));
  const kich = path.join(tmp, "run.sh");
  writeFileSync(kich, noiDung);
  try {
    return { ma: 0, ra: execFileSync("bash", [kich], { stdio: "pipe", encoding: "utf8", maxBuffer: 1 << 24 }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { ma: err.status ?? 1, ra: String(err.stdout ?? "") + String(err.stderr ?? "") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Phần giữa hai mốc `@@TEN` trong đầu ra kịch bản. */
function phan(ra: string, ten: string): string {
  const dong = ra.split("\n");
  const i = dong.indexOf(`@@${ten}`);
  if (i < 0) return "";
  const ket = dong.findIndex((d, k) => k > i && d.startsWith("@@"));
  return dong.slice(i + 1, ket < 0 ? undefined : ket).join("\n").trim();
}

/** Nạp script (KHÔNG chạy main) trong một bash có thư mục tạm riêng. */
const dauKichBan = () => [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'T="$(mktemp -d)"',
  `export ERP_BACKUP_DIR="$T/backups" ERP_LOCK_DIR="$T/locks" ERP_DIR="${bashPath(".")}"`,
  `source "${bashPath(SCRIPT)}"`,
  "set +e",
];

/* ═════════════ 1 · THAM SỐ ═════════════ */

export function testMigRehearsalThamSo() {
  const ca = (thamSo: string) =>
    [
      `( mr_phan_tich_tham_so ${thamSo} ) > "$T/o" 2>&1; rc=$?; echo "@@MA"; echo "$rc"; echo "@@OUT"; cat "$T/o"`,
      `mr_phan_tich_tham_so ${thamSo} >/dev/null 2>&1 && { echo "@@BIEN"; echo "$MR_CSDL|$MR_TAM|$MR_TRAN|$MR_NGAN_SACH|$MR_MAU|$MR_EXPLAIN|$MR_CHI_MUC|$MR_JIT|$MR_ANALYZE|$MR_CHAN_DOAN|$MR_CHAY"; }`,
      'echo "@@HET"',
    ].join("\n");
  const chay = (thamSo: string) => chayBash([...dauKichBan(), ca(thamSo), 'rm -rf "$T"', ""].join("\n"));

  const md = chay("qa");
  assert.equal(phan(md.ra, "MA"), "0", `mặc định phải hợp lệ:\n${md.ra}`);
  const macDinh = [hangSo("MR_TRAN_MAC_DINH"), hangSo("MR_NGAN_SACH_MAC_DINH"), hangSo("MR_MAU_MAC_DINH"), hangSo("MR_EXPLAIN_MAC_DINH")];
  assert.equal(phan(md.ra, "BIEN"), `erp_org_qa|tam_khoiphuc_qa|${macDinh.join("|")}|0|0|1|1|1`, "mặc định = hằng số của script; không chỉ mục thử, không so JIT, có ANALYZE / chẩn đoán / chạy");

  const du = chay(`qa-b --candidate-index --compare-jit --timeout=${hangSo("MR_TRAN_TOI_THIEU")} --budget=0 --sample=${hangSo("MR_MAU_TOI_DA")} --explain=0 --no-analyze --skip-diagnose --skip-migrate`);
  assert.equal(phan(du.ra, "BIEN"), `erp_org_qa_b|tam_khoiphuc_qa_b|${hangSo("MR_TRAN_TOI_THIEU")}|0|${hangSo("MR_MAU_TOI_DA")}|0|1|1|0|0|0`, `mọi cờ đặt đúng biến:\n${du.ra}`);
  assert.equal(phan(chay("erp_org_qa").ra, "BIEN").split("|")[0], "erp_org_qa", "nhận cả tên CSDL erp_org_*");

  const sai: [string, string][] = [
    ["", "thiếu mã"],
    ["qa hslc", "hai mã"],
    ["--apply qa", "cờ ghi --apply"],
    ["qa --write", "cờ ghi --write"],
    ["qa --fix", "cờ ghi --fix"],
    [`qa --timeout=${hangSo("MR_TRAN_TOI_THIEU") - 1}`, "trần dưới tối thiểu"],
    [`qa --timeout=${hangSo("MR_TRAN_TOI_DA") + 1}`, "trần trên tối đa"],
    [`qa --budget=${hangSo("MR_NGAN_SACH_TOI_DA") + 1}`, "ngân sách quá"],
    ["qa --sample=0", "mẫu 0"],
    [`qa --explain=${hangSo("MR_EXPLAIN_TOI_DA") + 1}`, "explain quá"],
    ["qa --timeout=abc", "trần không phải số"],
    ["Qa9!", "mã sai dạng"],
    ["tam_khoiphuc_qa", "tên CSDL tạm không phải mã"],
  ];
  for (const [thamSo, vi] of sai) {
    const r = chay(thamSo);
    assert.equal(phan(r.ra, "MA"), "2", `${vi} (${thamSo}) phải thoát 2:\n${r.ra}`);
    assert.equal(phan(r.ra, "BIEN"), "", `${vi}: không đặt biến nào dùng được`);
  }
  // Câu lỗi chỉ nói ĐỘ DÀI — không lặp lại thứ người gõ (ô arg của ops đã che; script không được in lại nó).
  for (const xau of ["Qa9!", "--apply", "qa --dangerous-token-xyz"]) {
    const out = phan(chay(xau).ra, "OUT");
    const vet = xau.split(" ").at(-1)!;
    assert.ok(!out.includes(vet), `câu lỗi không được in lại tham số người gõ (${vet}):\n${out}`);
  }
  console.log(`✓ migration-rehearsal · tham số: mặc định từ hằng số (${macDinh.join(" / ")}) · 9 cờ đặt đúng biến · ${sai.length} ca sai ⇒ mã 2 · câu lỗi không in lại tham số`);
}

/* ═════════════ 2 · KỊCH BẢN psql CẮT CÂU NHƯ DRIZZLE ═════════════ */

/** Câu drizzle sẽ chạy: cắt theo `--> statement-breakpoint`, bỏ khối chỉ có chú thích / khoảng trắng. */
function cauDrizzle(sqlText: string): string[] {
  return sqlText.split("--> statement-breakpoint").filter((c) => c.split("\n").some((d) => d.trim() !== "" && !d.trim().startsWith("--")));
}

export function testMigRehearsalKichBan() {
  const tep0245 = docLF(MIG_0245);
  const cau = cauDrizzle(tep0245);
  const ghi = cau.filter((c) => /^(UPDATE|INSERT|DELETE|WITH|MERGE|COPY)\b/i.test(c.split("\n").map((d) => d.trim()).find((d) => d && !d.startsWith("--")) ?? ""));
  const tran = hangSo("MR_TRAN_MAC_DINH");
  const goc = /SET LOCAL statement_timeout = '(\d+)s'/.exec(tep0245)?.[1];
  assert.ok(goc, "0245 phải tự đặt trần statement_timeout — đó là trần bản sao nâng lên");
  const r = chayBash([
    ...dauKichBan(),
    `echo "@@FULL"; mr_dung_kich_ban full ${tran} "${bashPath(MIG_0245)}"`,
    `echo "@@DDL"; mr_dung_kich_ban ddl ${tran} "${bashPath(MIG_0245)}"`,
    `echo "@@NOI"; mr_dung_kich_ban full ${tran} "${bashPath("drizzle/0182_fanpage_chatbot.sql")}" | grep -c '^\\\\echo @@CAU '`,
    'echo "@@HET"', 'rm -rf "$T"', "",
  ].join("\n"));
  const full = phan(r.ra, "FULL");
  const ddl = phan(r.ra, "DDL");
  const nhanFull = full.split("\n").filter((d) => d.startsWith("\\echo @@CAU "));
  assert.equal(nhanFull.length, cau.length, `chế độ full phải có ĐÚNG ${cau.length} câu như drizzle cắt (thấy ${nhanFull.length})`);
  assert.deepEqual(nhanFull.map((d) => Number(d.split(" ")[3])), cau.map((_, i) => i + 1), "câu đánh số liên tục 1..n theo thứ tự tệp");
  assert.ok(nhanFull.every((d) => !/["']/.test(d)), "nhãn câu không mang dấu nháy — \\echo của psql tự đọc nháy");
  assert.ok(ghi.length >= 1, "0245 có câu dẫn xuất ghi dữ liệu");
  const boQua = ddl.split("\n").filter((d) => d.startsWith("\\echo @@BO_QUA "));
  assert.equal(boQua.length, ghi.length, "chế độ ddl bỏ ĐÚNG các câu ghi dữ liệu");
  assert.ok(boQua.every((d) => / UPDATE /.test(d)), "câu bị bỏ ở 0245 là câu UPDATE dẫn xuất");
  assert.equal(ddl.split("\n").filter((d) => d.startsWith("\\echo @@CAU ")).length, cau.length - ghi.length, "ddl giữ mọi câu DDL");
  assert.ok(!/^UPDATE "sales_chat_conversations" c SET/m.test(ddl), "ddl KHÔNG chứa câu UPDATE dẫn xuất");
  assert.match(full, /^UPDATE "sales_chat_conversations" c SET/m, "full chứa câu UPDATE dẫn xuất nguyên văn");
  assert.ok(full.includes(`\\echo @@TRAN_GOC 0245_sales_chat_last_inbound 2 ${goc}`), "trần GỐC của tệp được ghi lại");
  assert.ok(full.includes(`SET LOCAL statement_timeout = '${tran}s'`) && !full.includes(`statement_timeout = '${goc}s'`), "trần của tệp được nâng lên trần bản sao");
  // Thân hàm của #803 đi qua NGUYÊN VĂN — kịch bản đo đúng thứ production chạy.
  const than = /CREATE OR REPLACE FUNCTION "sales_chat_turn_unhandled_thread"[\s\S]*?\$\$ LANGUAGE sql STABLE;/.exec(tep0245)?.[0];
  assert.ok(than && full.includes(than), "thân sales_chat_turn_unhandled_thread phải đi qua nguyên văn");
  // Tệp có dấu cắt NGAY SAU câu trên cùng dòng (`…;--> statement-breakpoint`) vẫn cắt đúng.
  assert.equal(Number(phan(r.ra, "NOI")), cauDrizzle(docLF("drizzle/0182_fanpage_chatbot.sql")).length, "dấu cắt giữa dòng vẫn cắt đúng như drizzle");
  console.log(`✓ migration-rehearsal · kịch bản: 0245 = ${cau.length} câu như drizzle · ddl bỏ ${ghi.length} câu UPDATE dẫn xuất · trần ${goc} s → ${tran} s (trần gốc ghi lại) · thân hàm #803 nguyên văn · dấu cắt giữa dòng đúng`);
}

/* ═════════════ 3 · TÓM TẮT THỜI GIAN TỪNG CÂU ═════════════ */

export function testMigRehearsalTomTat() {
  const kb = [
    "\\set ON_ERROR_STOP 1", "\\timing on", "BEGIN;",
    "\\echo @@TRAN_GOC 0245_x 1 600",
    "\\echo @@CAU 0245_x 1 SET LOCAL statement_timeout 1200s", "SET LOCAL statement_timeout = '1200s';", ";",
    "\\echo @@CAU 0245_x 2 ALTER TABLE sales_chat_conversations", "ALTER TABLE x;", ";",
    "\\echo @@CAU 0245_x 3 UPDATE sales_chat_conversations c SET", "UPDATE x", "SET y = 1;", ";",
    "\\echo @@CAU 0245_x 4 CREATE TRIGGER t", "CREATE TRIGGER t;", ";",
    "ROLLBACK;",
  ].join("\n");
  const raDat = ["BEGIN", "Time: 0.2 ms", "@@TRAN_GOC 0245_x 1 600", "@@CAU 0245_x 1 SET LOCAL statement_timeout 1200s", "SET", "Time: 0.1 ms",
    "@@CAU 0245_x 2 ALTER TABLE sales_chat_conversations", "ALTER TABLE", "Time: 12.5 ms",
    "@@CAU 0245_x 3 UPDATE sales_chat_conversations c SET", "UPDATE 959", "Time: 700123.4 ms (11:40.123)",
    "@@CAU 0245_x 4 CREATE TRIGGER t", "CREATE TRIGGER", "Time: 1.0 ms", "ROLLBACK"].join("\n");
  // Lỗi tới TRƯỚC dòng đánh dấu trên luồng stdout (stderr không đệm) — định vị phải dựa vào SỐ DÒNG kịch bản.
  const dongUpdate = kb.split("\n").indexOf("SET y = 1;") + 1;
  const raLoi = [`psql:<stdin>:${dongUpdate}: ERROR:  canceling statement due to statement timeout`, "BEGIN", "@@TRAN_GOC 0245_x 1 600",
    "@@CAU 0245_x 1 SET LOCAL statement_timeout 1200s", "SET", "Time: 0.1 ms", "@@CAU 0245_x 2 ALTER TABLE sales_chat_conversations", "ALTER TABLE",
    "Time: 10 ms", "@@CAU 0245_x 3 UPDATE sales_chat_conversations c SET", "Time: 1200001.0 ms (20:00.001)"].join("\n");
  const r = chayBash([
    ...dauKichBan(),
    `cat > "$T/kb" <<'EOF'\n${kb}\nEOF`,
    `cat > "$T/dat" <<'EOF'\n${raDat}\nEOF`,
    `cat > "$T/loi" <<'EOF'\n${raLoi}\nEOF`,
    `printf 'BEGIN\\n@@CAU 0245_x 1 SET LOCAL statement_timeout 1200s\\nSET\\nTime: 0.1 ms\\n' > "$T/chet"`,
    'echo "@@DAT"; mr_tom_tat_chay "$T/kb" "$T/dat" "TRƯỚC" 0',
    'echo "@@LOI"; mr_tom_tat_chay "$T/kb" "$T/loi" "TRƯỚC" 3',
    'echo "@@CHET"; mr_tom_tat_chay "$T/kb" "$T/chet" "TRƯỚC" 137',
    'echo "@@HET"', 'rm -rf "$T"', "",
  ].join("\n"));
  const tt = (s: string) => s.split("\n").filter((d) => d.startsWith("[ops:tom-tat] "));
  const dat = tt(phan(r.ra, "DAT"));
  assert.ok(dat.some((d) => /TRƯỚC · 0245_x: 700\.1 s/.test(d)), `tổng theo migration:\n${dat.join("\n")}`);
  assert.ok(dat.some((d) => /chậm #1: 0245_x câu 3 \(UPDATE sales_chat_conversations c SET\) 700\.1 s · 959 dòng/.test(d)), "câu chậm nhất kèm số dòng UPDATE");
  assert.ok(dat.some((d) => /VƯỢT TRẦN PRODUCTION: 0245_x câu 3 .* 700\.1 s > 600 s/.test(d)), "câu vượt trần GỐC (600 s) bị đánh dấu");
  assert.ok(dat.some((d) => /xong 4 câu, 700\.1 s, không lỗi/.test(d)), "lượt đạt nói rõ số câu + tổng");
  assert.ok(!dat.some((d) => /chậm #\d: .*câu [124] /.test(d)), "câu < 1 s không vào danh sách chậm");
  const loi = tt(phan(r.ra, "LOI"));
  assert.ok(loi.some((d) => /LỖI ở 0245_x#3: hết trần statement_timeout/.test(d)), `câu lỗi định vị bằng số dòng kịch bản:\n${loi.join("\n")}`);
  assert.ok(!loi.some((d) => /không lỗi/.test(d)), "có ERROR thì không bao giờ in «không lỗi»");
  assert.ok(!r.ra.includes("canceling statement due to statement timeout") || !loi.some((d) => d.includes("canceling")), "kênh tóm tắt chỉ in LOẠI lỗi, không in câu lỗi");
  const chet = tt(phan(r.ra, "CHET"));
  assert.ok(chet.some((d) => /psql thoát 137 mà không có dòng ERROR/.test(d)) && !chet.some((d) => /không lỗi/.test(d)), "psql chết không có ERROR ⇒ nói ra, không «không lỗi»");
  console.log("✓ migration-rehearsal · tóm tắt: tổng / câu chậm kèm số dòng / VƯỢT TRẦN PRODUCTION theo trần gốc · lỗi định vị bằng số dòng kịch bản (không tin thứ tự trộn stderr) · psql chết ⇒ không nói «không lỗi»");
}

/* ═════════════ 4 · MÃ NGUỒN ═════════════ */

export function testMigRehearsalMaNguon() {
  const src = docLF(SCRIPT);
  const ma = boChuThichShell(src);
  const backup = docLF("scripts/erp-backup.sh");

  // Bản sao: ĐÚNG MỘT đường khôi phục, dùng chung với restore-drill-org.
  assert.match(ma, /source "\$THU_MUC_SCRIPT_MR\/erp-backup\.sh"/, "nạp erp-backup.sh để dùng lại hàm khôi phục, không chép");
  assert.match(ma, /dung_ban_sao_tam_to_chuc "\$MR_NHAN" "\$MR_TIEN_TO_CONTAINER" "\$MR_TAM" "\$ban"/, "bản sao đi qua dung_ban_sao_tam_to_chuc");
  assert.ok(!/\b(pg_restore|pg_dump|createdb|dropdb|docker run)\b/.test(ma.replace(/^MR_[A-Z_]+=.*$/gm, "")), "script không tự khôi phục / dump / dựng container — mọi thứ qua hàm dùng chung");
  assert.ok(!/alter database|alter system|alter role/i.test(ma), "không đổi cấu hình máy chủ nào");
  for (const dong of ma.split("\n").filter((d) => /\bdocker (exec|run|rm|ps|inspect|logs|cp|stop|kill|start|compose)\b/.test(d))) {
    assert.match(dong, /docker exec -i -e PGOPTIONS=[^\n]*"\$DRILL_TEN_TO_CHUC"/, `lệnh docker duy nhất của script là psql trong container TẠM: ${dong.trim()}`);
  }
  assert.ok(!/\$DB_CONTAINER/.test(ma), "script không nhắc tới erp-db (ảnh lấy bên trong hàm dùng chung)");
  const nhan = /^MR_NHAN="([^"]+)"/m.exec(src)?.[1];
  const nhanDienTap = /^NHAN_DIEN_TAP_TO_CHUC="([^"]+)"/m.exec(backup)?.[1];
  assert.ok(nhan && nhanDienTap && nhan !== nhanDienTap, "nhãn container riêng — dọn container sót của lượt này không xoá diễn tập khôi phục đang chạy");
  assert.ok(src.indexOf("trap mr_don EXIT") > src.indexOf('dung_ban_sao_tam_to_chuc "$MR_NHAN"'), "trap dọn của lượt (container + thư mục tạm) gài SAU khi hàm dùng chung đã gài trap của nó");
  assert.match(/mr_don\(\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "", /don_dien_tap_to_chuc/, "mr_don vẫn xoá container tạm");
  assert.ok(ma.indexOf("RAM_TOI_THIEU_DIEN_TAP_MB") > 0 && ma.indexOf("RAM_TOI_THIEU_DIEN_TAP_MB") < ma.indexOf('dung_ban_sao_tam_to_chuc "$MR_NHAN"'), "kiểm RAM TRƯỚC khi dựng container");
  assert.ok(ma.indexOf("mr_phan_tich_tham_so \"$@\"") < ma.indexOf("giu_khoa 8"), "soát tham số TRƯỚC khi xin khoá");
  // Không đọc CSDL sống để ước ổ đĩa (khác restore-drill-org): ước từ cỡ bản dump.
  assert.match(ma, /can=\$\(\( ban_mb \* MR_HE_SO_O_DIA \+ DU_TRU_O_DIA_MB \)\)/, "ổ đĩa ước từ cỡ bản dump");
  assert.ok(hangSo("MR_TRAN_TONG_GIAY") < 110 * 60, "trần tổng của lượt phải nằm dưới command_timeout 110 phút của ops-vps.yml");

  // Kênh tóm tắt: tiền tố khai MỘT chỗ; dòng TT| không mang mã hội thoại / page / luồng / chữ tin.
  assert.deepEqual(ma.match(/\[ops:tom-tat\] /g)?.length, 2,"tiền tố kênh tóm tắt chỉ ở MR_TIEN_TO_TT và bộ đổi TT| (mr_doi_tt)");
  // Phần IN RA của mỗi dòng TT|: `RAISE NOTICE 'TT|…', đối số…;` (tới dấu `;`), hoặc biểu thức `SELECT 'TT|' || …` cùng các
  // dòng nối `||` ngay sau nó. Điều kiện lọc (WHERE / FILTER) được phép nhắc cột — chỉ thứ được NỐI vào chuỗi in ra bị soát.
  const dongMa = ma.split("\n");
  const cauTT: string[] = [];
  for (let k = 0; k < dongMa.length; k += 1) {
    if (!dongMa[k].includes("'TT|")) continue;
    let khoi = dongMa[k];
    if (/RAISE NOTICE/.test(khoi)) {
      while (!/;\s*$/.test(khoi) && k + 1 < dongMa.length) khoi += `\n${dongMa[(k += 1)]}`;
    } else {
      while (k + 1 < dongMa.length && /^\s*\|\|/.test(dongMa[k + 1])) khoi += `\n${dongMa[(k += 1)]}`;
    }
    cauTT.push(khoi);
  }
  assert.ok(cauTT.length >= 15, `đọc hụt câu tóm tắt (${cauTT.length})`);
  const CAM = /\br\.(id|page_id|thread_id|seen)\b|\|\|\s*\(?\s*(c\.|i\.|p\.|s\.)?(id|page_id|thread_id|text|message_id|customer_\w+|visitor_key|seen)\b|most_common|histogram_bounds|\.text\b|\btext\s*\)/;
  for (const c of cauTT) assert.ok(!CAM.test(c), `dòng tóm tắt in một GIÁ TRỊ dữ liệu (mã / chữ tin): ${c.trim().slice(0, 200)}`);
  assert.ok(!/TT\|[^\n]*\$MR_CSDL|TT\|[^\n]*\$ten_ban|mr_tt [^\n]*\$(MR_CSDL|MR_MA|ten_ban)\b/.test(ma), "tên CSDL / mã tổ chức / tên tệp dump không ra kênh tóm tắt");

  // Hai vế của biến thể bám đúng chữ của 0245: neo không khớp thì phép đo vế mất nghĩa.
  const tep0245 = docLF(MIG_0245);
  assert.equal(tep0245.split('"sales_chat_inbound" p where').length - 1, 2, "neo vế tin mẫu chéo luồng xuất hiện 2 lần trong thân hàm (OTHER_APP + UNKNOWN)");
  assert.equal(tep0245.split('"sales_chat_inbound" s where').length - 1, 1, "neo vế UNKNOWN lồng xuất hiện 1 lần");
  // Chỉ mục thử băm ĐÚNG biểu thức hàm so sánh — #803 đổi cách chuẩn hoá chữ thì bài này đỏ, ứng viên phải đổi theo.
  assert.ok(tep0245.includes(`btrim(regexp_replace(p."text", '[[:space:]]+', ' ', 'g')) = btrim(regexp_replace(o."text", '[[:space:]]+', ' ', 'g'))`) && tep0245.includes("p.note = 'PAGE_REPLY'"), "vế tin mẫu của 0245 so bằng btrim(regexp_replace(text…)) trên PAGE_REPLY");
  const chiMuc = /^MR_CHI_MUC_THU="(.+)"$/m.exec(src)?.[1] ?? "";
  assert.match(chiMuc, /USING hash \(\(btrim\(regexp_replace\(\\"text\\", '\[\[:space:\]\]\+', ' ', 'g'\)\)\)\) WHERE \\"note\\" = 'PAGE_REPLY'/, "chỉ mục thử: băm đúng biểu thức + điều kiện PAGE_REPLY");
  assert.match(chiMuc, /CREATE INDEX IF NOT EXISTS/, "chỉ mục thử idempotent");
  assert.ok(!/^\s*CREATE INDEX/m.test(ma.replace(/^MR_CHI_MUC_THU=.*$/m, "")), "script không có CREATE INDEX nào ngoài ứng viên — và ứng viên chỉ chạy trong bản sao");

  // ops-vps.yml: thao tác riêng, MÃ HOÁ, làn DOC_NANG, lấy CẢ HAI tệp từ main khi bản đã deploy chưa có.
  const ops = docLF(".github/workflows/ops-vps.yml");
  const opts = ops.slice(ops.indexOf("        options:\n"), ops.indexOf("      days:"));
  assert.match(opts, /^ {10}- migration-rehearsal /m, "ops phải có thao tác migration-rehearsal");
  const lop = (ten: string) => (new RegExp(`^ +${ten}: ?"([^"]*)"|^ +${ten}="([^"]*)"`, "m").exec(ops)?.slice(1).find(Boolean) ?? "").split(/\s+/);
  assert.ok(lop("OPS_THAO_TAC_MA_HOA").includes("migration-rehearsal"), "kết quả MÃ HOÁ");
  assert.ok(lop("DOC_NANG").includes("migration-rehearsal"), "làn DOC_NANG — dựng một Postgres thứ hai trên máy 2 GB");
  const i = ops.indexOf("\n              migration-rehearsal)\n");
  assert.ok(i > 0, "không tìm thấy nhánh migration-rehearsal");
  const nhanh = boChuThichShell(ops.slice(i, ops.indexOf(";;", i) + 2));
  assert.match(nhanh, /kiem_arg/, "soát ký tự ô arg");
  assert.match(nhanh, /fetch_script erp-backup\.sh > "\$_dmr\/erp-backup\.sh"/, "lấy erp-backup.sh CÙNG thư mục khi bản đã deploy chưa có");
  assert.match(nhanh, /fetch_script erp-migration-rehearsal\.sh > "\$_dmr\/erp-migration-rehearsal\.sh"/);
  assert.match(nhanh, /ma_hoa_ket_qua chay_voi_arg env ERP_DIR=\/root\/erp bash "\$SR" ;;$/, "chạy qua ma_hoa_ket_qua + chay_voi_arg");
  console.log("✓ migration-rehearsal · mã nguồn: bản sao qua dung_ban_sao_tam_to_chuc (nhãn riêng, trap dọn), 0 lệnh vào erp-db, ổ ước từ bản dump · kênh tóm tắt không mang mã / chữ tin · neo biến thể + chỉ mục thử bám đúng chữ 0245 · ops mã hoá, DOC_NANG, lấy cả hai tệp");
}

/* ═════════════ 5 · CHẠY THẬT QUA main VỚI docker / free / df GIẢ ═════════════ */

function khung(lenh: string, truoc = ""): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'T="$(mktemp -d)"',
    'mkdir -p "$T/bin"',
    "cat > \"$T/bin/docker\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "$*" >> "$DOCKER_LOG"',
    'case "$1" in',
    "  inspect) case \"$*\" in *Config.Image*) echo postgres:16-alpine ;; esac ;;",
    "  ps) : ;;",
    "  run) echo id-gia ;;",
    '  logs) echo "PostgreSQL init process complete; ready for start up." ;;',
    "  rm) : ;;",
    "  exec)",
    '    case "$*" in',
    "      *pg_isready*) exit 0 ;;",
    '      *"pg_restore -U"*) : ;;',
    '      *" -i "*) vao="$(cat)"; case "$vao" in *__drizzle_migrations*) cat "$MOC_DA_AP" ;; esac ;;',
    "    esac ;;",
    "esac",
    "EOF",
    "cat > \"$T/bin/free\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "              total        used        free      shared  buff/cache   available"',
    'echo "Mem:           1900         800         300          10         800        ${STUB_RAM:-1200}"',
    "EOF",
    "cat > \"$T/bin/df\" <<'EOF'",
    "#!/usr/bin/env bash",
    'echo "Filesystem 1048576-blocks Used Available Capacity Mounted"',
    'echo "/dev/gia 40000 1 999999 1% /"',
    "EOF",
    'chmod +x "$T/bin/docker" "$T/bin/free" "$T/bin/df"',
    `export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log" MOC_DA_AP="$T/moc" ERP_BACKUP_DIR="$T/backups" ERP_LOCK_DIR="$T/locks" ERP_DIR="${bashPath(".")}"`,
    ': > "$DOCKER_LOG"',
    // Bản sao «dừng ở mục áp chót»: mọi mốc của sổ trừ mục cuối.
    `grep -o '"when": *[0-9]*' "${bashPath("drizzle/meta/_journal.json")}" | grep -o '[0-9]*$' | sed '$d' > "$MOC_DA_AP"`,
    `source "${bashPath(SCRIPT)}"`,
    "set +e",
    "giu_khoa() { return 0; }   # khoá: đo riêng bằng flock THẬT ở tests/backup.test.ts",
    'mkdir -p "$ERP_BACKUP_DIR/orgs/erp_org_qa/hourly" "$ERP_BACKUP_DIR/orgs/erp_org_hslc/daily"',
    'echo "PGDMP" > "$ERP_BACKUP_DIR/orgs/erp_org_qa/hourly/erp_org_qa-20261012-0247.dump"',
    truoc,
    `( set -e; ${lenh} ) > "$T/out" 2>&1; rc=$?`,
    'echo "@@EXIT"; echo "$rc"',
    'echo "@@OUT"; cat "$T/out"',
    'echo "@@DOCKER"; cat "$DOCKER_LOG"',
    'echo "@@HET"',
    'rm -rf "$T"',
    "",
  ].join("\n");
}

export function testMigRehearsalChayThat() {
  const ld = (ra: string) => phan(ra, "DOCKER").split("\n").filter(Boolean);
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string }[] };
  const cuoi = journal.entries.at(-1)!.tag;

  const dat = chayBash(khung("main_migration_rehearsal qa --budget=0 --explain=0"));
  assert.equal(phan(dat.ra, "EXIT"), "0", `lượt đo xong phải thoát 0:\n${dat.ra}`);
  const l = ld(dat.ra);
  const run = l.find((x) => x.startsWith("run "));
  assert.ok(run, "phải dựng container tạm");
  assert.match(run, /--label erp\.migration-rehearsal=1 --network none --memory 512m --memory-swap 512m/, "nhãn RIÊNG, không mạng, trần RAM");
  assert.match(run, /-e POSTGRES_DB=tam_khoiphuc_qa /, "CSDL tạm tên tam_khoiphuc_<mã>");
  assert.match(run, /erp_org_qa-20261012-0247\.dump:\/drill\/ban\.dump:ro/, "bản dump mới nhất của ĐÚNG tổ chức, chỉ đọc");
  const ten = /--name (erp-migration-rehearsal-\d+)/.exec(run)?.[1];
  assert.ok(ten, "tên container mang tiền tố riêng");
  assert.ok(l.some((x) => x.startsWith(`exec ${ten} pg_restore -U erp -d tam_khoiphuc_qa --no-owner --no-privileges`)), "pg_restore vào CSDL tạm qua hàm dùng chung");
  assert.ok(!l.some((x) => /^exec (-i )?(-e \S+ )?erp-db /.test(x)), "KHÔNG một lệnh exec nào vào erp-db");
  assert.deepEqual(l.filter((x) => /erp-db/.test(x)), ["inspect -f {{.Config.Image}} erp-db"], "erp-db chỉ bị hỏi tên ảnh");
  assert.ok(l.filter((x) => x.startsWith("exec -i ")).every((x) => x.includes(` ${ten} psql `)), "mọi psql chạy trong container tạm");
  assert.equal(l.at(-1), `rm -f -v ${ten}`, "lệnh docker cuối cùng là xoá container tạm (trap EXIT)");
  const out = phan(dat.ra, "OUT");
  assert.match(out, new RegExp(`\\[ops:tom-tat\\] sổ migration: .*còn thiếu 1: ${cuoi}`), `nhận ra đúng mục còn thiếu:\n${out}`);
  assert.match(out, /\[ops:tom-tat\] KẾT LUẬN: /, "luôn có dòng KẾT LUẬN");
  assert.ok(!out.split("\n").filter((d) => d.startsWith("[ops:tom-tat] ")).some((d) => /erp_org_qa|tam_khoiphuc/.test(d)), "kênh tóm tắt không mang tên CSDL");

  const khongBan = chayBash(khung("main_migration_rehearsal hslc"));
  assert.equal(phan(khongBan.ra, "EXIT"), "1", "không có bản dump ⇒ mã 1");
  assert.ok(!ld(khongBan.ra).some((x) => x.startsWith("run ")), "không có bản ⇒ không dựng container");

  const ram = chayBash(khung("STUB_RAM=300 main_migration_rehearsal qa"));
  assert.equal(phan(ram.ra, "EXIT"), "1", "thiếu RAM ⇒ mã 1");
  assert.ok(!ld(ram.ra).some((x) => x.startsWith("run ")), "thiếu RAM ⇒ không dựng container");

  for (const xau of ["", "qa --apply", "'qa;rm -rf /'"]) {
    const r = chayBash(khung(`main_migration_rehearsal ${xau}`));
    assert.equal(phan(r.ra, "EXIT"), "2", `tham số sai (${xau || "rỗng"}) ⇒ mã 2:\n${r.ra}`);
    assert.deepEqual(ld(r.ra), [], "tham số sai ⇒ 0 lệnh docker");
  }

  // Bản sao ĐÃ đủ migration ⇒ nói ra, không chạy gì thêm, vẫn xoá container.
  const du = chayBash(khung("main_migration_rehearsal qa", `grep -o '"when": *[0-9]*' "${bashPath("drizzle/meta/_journal.json")}" | grep -o '[0-9]*$' > "$MOC_DA_AP"`));
  assert.equal(phan(du.ra, "EXIT"), "0");
  assert.match(phan(du.ra, "OUT"), /KẾT LUẬN: bản sao không thiếu migration nào/);
  assert.match(ld(du.ra).at(-1) ?? "", /^rm -f -v erp-migration-rehearsal-\d+$/);
  console.log(`✓ migration-rehearsal · chạy thật qua main: container nhãn riêng (không mạng, 512m) · pg_restore qua hàm dùng chung · erp-db chỉ bị hỏi tên ảnh · nhận ra mục thiếu ${cuoi} · lệnh cuối xoá container · không bản / thiếu RAM / 3 tham số sai ⇒ không dựng gì · bản sao đủ migration ⇒ KẾT LUẬN rõ`);
}

export function testMigrationRehearsal() {
  testMigRehearsalThamSo();
  testMigRehearsalKichBan();
  testMigRehearsalTomTat();
  testMigRehearsalMaNguon();
  testMigRehearsalChayThat();
}
