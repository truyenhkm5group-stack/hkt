/**
 * ═══════════ LOG CỦA KHO PUBLIC KHÔNG ĐƯỢC CHỨA DỮ LIỆU KHÁCH HÀNG ═══════════
 *
 * Sự cố 24/09/2026 (docs/security-2026-09-24-ops-log-leak.md): workflow "Vận hành ERP trên VPS"
 *
 *  · in nguyên văn ô "arg" của MỌI thao tác (JSON lương, sao kê ngân hàng, cấu hình kèm URL
 *    webhook, câu SQL) vào log — mà kho này PUBLIC;
 *  · in THẲNG kết quả `db-query` (SĐT, tên, địa chỉ khách) ra log;
 *  · chạy `db-query` bằng `erp` — SUPERUSER — với một cờ chỉ-đọc đặt ở shell máy chủ mà
 *    `docker compose exec` không bao giờ chuyển vào container;
 *  · ghép ô "arg" vào `sh -c "…"`, nên một dấu nháy là đủ để chạy lệnh thứ hai.
 *
 * Bài này khoá từng hàng rào ở mức mã nguồn, và CHẠY THẬT ba thứ chạy được mà không cần máy chủ:
 * tệp role chỉ đọc trên Postgres (PGlite), hàm mã hoá kết quả dưới bash + openssl, và hàm tách
 * ô arg dưới bash. Thiếu bash/openssl trên LINUX là ĐỎ; nền khác in "CHƯA ĐO ĐƯỢC" (AGENTS.md mục 65).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const THU_MUC = ".github/workflows";
const doc = (t: string) => readFileSync(path.join(THU_MUC, t), "utf8").replace(/\r\n/g, "\n");
const OPS = "ops-vps.yml";
const CHUNG_CHI = "deploy/ops-result-recipient.crt";
const SQL_ROLE = "scripts/ops-erp-ro-role.sql";

/** Bỏ dòng chú thích shell/YAML: một câu GIẢI THÍCH về `$ARG` không phải là một lần dùng `$ARG`. */
const boChuThich = (src: string) =>
  src
    .split("\n")
    .map((d) => (/^\s*#/.test(d) ? "" : d))
    .join("\n");

/** Thân script SSH của job `ops` (từ `script: |` tới hết khối), đã bỏ chú thích, bỏ thụt 12. */
function scriptOps(): string {
  const src = doc(OPS);
  const i = src.indexOf("          script: |\n");
  assert.ok(i > 0, "không tìm thấy script SSH của job ops");
  const j = src.indexOf("\n      - name: Lấy kết quả ĐÃ MÃ HOÁ", i);
  assert.ok(j > i, "không tìm thấy bước lấy bản mã ngay sau script SSH của job ops");
  return boChuThich(src.slice(i, j))
    .split("\n")
    .map((d) => d.replace(/^ {12}/, ""))
    .join("\n");
}

/** Nhánh `case "$ACTION"` → thân (đến `;;` đóng nhánh ở cùng thụt lề). */
function cacNhanh(script: string): Map<string, string> {
  const m = new Map<string, string>();
  const re = /^ {2}([a-z0-9-]+)\)\n([\s\S]*?)(?=^ {2}[a-z0-9*-]+\)\n|^esac)/gm;
  for (const x of script.matchAll(re)) m.set(x[1]!, x[2]!);
  assert.ok(m.size > 40, `đọc hụt nhánh case (chỉ thấy ${m.size})`);
  return m;
}

/** Thân một hàm shell `ten() { … }` ở đầu dòng (thụt 0), tới dòng `}` đầu tiên ở thụt 0. */
function hamShell(script: string, ten: string): string {
  const i = script.indexOf(`\n${ten}() {\n`);
  assert.ok(i >= 0, `script SSH phải định nghĩa hàm \`${ten}\``);
  const j = script.indexOf("\n}\n", i + 1);
  assert.ok(j > i, `không tìm thấy dấu đóng của hàm \`${ten}\``);
  return script.slice(i + 1, j + 3);
}

/* ═════════════ (a) KHÔNG DÒNG NÀO IN NỘI DUNG Ô "arg" ═════════════ */

/** Tham chiếu tới NỘI DUNG của ARG — `${#ARG}` (độ dài) thì không tính. */
const THAM_CHIEU_ARG = /\$ARG\b|\$\{ARG(?!\w)(?!#)[^}]*\}/;

export function testKhongInArg() {
  const s = scriptOps();
  const pham: string[] = [];
  for (const dong of s.split("\n")) {
    if (!THAM_CHIEU_ARG.test(dong)) continue;
    // In ra log = echo/printf KHÔNG đổ vào một đường ống (`printf … "$ARG" | lệnh` là đưa vào stdin).
    const inRa = /\b(echo|printf)\b/.test(dong) && !/\b(echo|printf)\b[^|]*\|/.test(dong);
    if (inRa) pham.push(dong.trim());
  }
  assert.deepEqual(pham, [], `Dòng in NỘI DUNG ô "arg" ra log công khai — chỉ được in độ dài \${#ARG}:\n${pham.join("\n")}`);
  assert.ok(!/^\s*set -[a-z]*x/m.test(s), "script SSH không được bật `set -x`: xtrace in mọi biến đã mở rộng, kể cả ô arg");
  assert.match(s, /phân loại: action=\$ACTION arg=\(\$\{#ARG\} ký tự/, "dòng phân loại khoá phải in ĐỘ DÀI ô arg, không in nội dung");
  console.log("✓ Log ops không in nội dung ô arg: 0 dòng echo/printf mang $ARG · không set -x · dòng phân loại in độ dài");
}

/* ═════════════ (a') KHỐI `env:` CỦA BƯỚC SSH IN `ARG:` ⇒ PHẢI CHE TRƯỚC ═════════════ */

/** Thân `run:` của bước "Che ô arg trong log" trong job `ops`. */
function buocChe(): { thuTu: string[]; than: string } {
  const src = doc(OPS);
  const iJob = src.indexOf("\n  ops:\n");
  const iHet = src.indexOf("\n  agent-env:\n");
  assert.ok(iJob > 0 && iHet > iJob, "không tìm thấy job ops");
  const job = boChuThich(src.slice(iJob, iHet));
  const thuTu = [...job.matchAll(/^ {6}- (?:name: (.+)|uses: (\S+))$/gm)].map((m) => (m[1] ?? m[2])!.trim());
  const i = job.indexOf("- name: Che ô arg trong log");
  assert.ok(i > 0, "job ops phải có bước `Che ô arg trong log`");
  const j = job.indexOf("\n      - ", i + 1);
  return { thuTu, than: job.slice(i, j) };
}

export function testCheArgTruocMoiBuoc() {
  const { thuTu, than } = buocChe();
  assert.equal(thuTu[0], "Che ô arg trong log", `bước che ô arg phải là bước ĐẦU TIÊN của job ops — thấy: ${thuTu.join(" → ")}`);
  assert.match(than, /::add-mask::/, "bước che phải đăng ký ::add-mask::");
  assert.match(than, /\$GITHUB_EVENT_PATH/, "bước che phải đọc ô arg từ tệp sự kiện");
  assert.ok(!/\$\{\{\s*inputs\./.test(than), "bước che KHÔNG được nội suy ${{ inputs.* }} (tiêm lệnh)");
  assert.ok(!/^\s{8}env:/m.test(than), "bước che KHÔNG được khai env: — khối env của nó in ra TRƯỚC khi kịp che");
  assert.match(than, /%25/, "`%` trong giá trị phải mã hoá %25 — runner giải mã dữ liệu lệnh workflow");
  console.log(`✓ Ô arg được che bằng ::add-mask:: ở bước ĐẦU TIÊN (${thuTu.length} bước), đọc từ tệp sự kiện, không env, không nội suy`);
}

/** Chạy thật thân bước che dưới bash + jq với một tệp sự kiện giả. */
export function testCheArgChayThat() {
  if (!coLenh("bash", ["--version"]) || !coLenh("jq", ["--version"])) {
    assert.notEqual(process.platform, "linux", "Linux (máy Actions) PHẢI có bash + jq — thiếu thì bước che ô arg không được đo");
    console.log(`⚠ Bước che ô arg: CHƯA ĐO ĐƯỢC trên ${process.platform} (thiếu bash/jq).`);
    return;
  }
  const { than } = buocChe();
  const kichBan = than
    .split("\n")
    .slice(than.split("\n").findIndex((d) => /^\s*run: \|/.test(d)) + 1)
    .map((d) => d.replace(/^ {10}/, ""))
    .join("\n");
  const tmp = mkdtempSync(path.join(tmpdir(), "ops-che-arg-"));
  try {
    const chay = (arg: string) => {
      const ev = path.join(tmp, "ev.json");
      writeFileSync(ev, JSON.stringify({ inputs: { arg } }));
      writeFileSync(path.join(tmp, "che.sh"), kichBan);
      return execFileSync("bash", [path.join(tmp, "che.sh")], { encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: ev } });
    };
    const sql = "select name, phone\nfrom customers where phone = '0912345678'\n\n  and note like '50%'";
    const ra = chay(sql);
    const mat = ra.split("\n").filter((d) => d.startsWith("::add-mask::"));
    assert.equal(mat.length, 3, `mỗi dòng khác rỗng của ô arg phải có một mặt nạ, thấy:\n${ra}`);
    assert.ok(mat.includes("::add-mask::  and note like '50%25'"), `% phải mã hoá %25 và giữ nguyên dòng:\n${ra}`);
    const khongPhaiMat = ra.split("\n").filter((d) => !d.startsWith("::add-mask::"));
    assert.ok(!khongPhaiMat.some((d) => d.includes("0912345678") || d.includes("customers")), `ngoài lệnh ::add-mask:: không dòng nào được in nội dung ô arg:\n${ra}`);
    assert.equal(chay("--from=2026-09-01 --apply").includes("::add-mask::"), false, "ô chỉ gồm cờ vô hại thì không che — log còn đọc được");
    for (const x of ["PKE1512546011", "0912345678", "khach@vi.du", '{"a":1}', "một dòng\nhai dòng"]) {
      assert.ok(chay(x).includes("::add-mask::"), `ô arg ${JSON.stringify(x)} PHẢI được che`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("✓ Bước che chạy thật (bash + jq): SQL nhiều dòng ⇒ một mặt nạ mỗi dòng, % mã hoá %25 · cờ vô hại không che · SĐT/mã vận đơn/email/JSON/nhiều dòng luôn che");
}

/* ═════════════ (c) KHÔNG `sh -c "…$ARG…"` · $ARG KHÔNG NGOẶC KÉP CHỈ SAU PHÉP SOÁT ═════════════ */

/**
 * Vị trí các tham chiếu `$ARG` / `${ARG…}` KHÔNG đứng ngay sau dấu `"`. Luật cố ý hẹp hơn ngữ
 * pháp shell: dạng ngoặc kép hợp lệ duy nhất trong tệp này là `"$ARG"` / `"${ARG:-…}"`, nên
 * mọi dạng khác (`$ARG` trần, `"--x=$ARG"`) đều phải đi qua phép soát — một bộ phân tích
 * ngoặc đầy đủ sẽ trượt ở `"$(echo "…")"` lồng nhau, còn luật hẹp thì không.
 */
function argNgoaiNgoacKep(dong: string): number[] {
  const kq: number[] = [];
  for (const m of dong.matchAll(/\$ARG\b|\$\{ARG(?!\w)/g)) {
    if (dong[m.index! - 1] !== '"') kq.push(m.index!);
  }
  return kq;
}

export function testKhongChenLenh() {
  const s = scriptOps();

  // Mọi `sh -c "…"` có chữ ARG bên trong là một shell thứ hai đọc lại ô người gõ.
  const shc = s.split("\n").filter((d) => /\bsh -c\s+"[^"]*\bARG\b/.test(d));
  assert.deepEqual(shc, [], `Không được ghép ô arg vào \`sh -c "…"\` — truyền argv (chay_voi_arg) hoặc \`docker exec -e\`:\n${shc.join("\n")}`);

  // $ARG không ngoặc kép (để TÁCH thành nhiều cờ) chỉ hợp lệ SAU một phép soát ký tự.
  const nhanh = cacNhanh(s);
  const soat = (than: string) => /\bkiem_arg\b/.test(than) || /case "\$ARG" in\s*\n\s*\*\[!/.test(than);
  const pham: string[] = [];
  for (const [ten, than] of nhanh) {
    for (const dong of than.split("\n")) {
      if (!argNgoaiNgoacKep(dong).length) continue;
      const truoc = than.slice(0, than.indexOf(dong));
      if (!soat(truoc)) pham.push(`${ten}: ${dong.trim()}`);
    }
  }
  const tach = hamShell(s, "chay_voi_arg");
  assert.match(tach, /^\s*kiem_arg\s*$/m, "chay_voi_arg phải gọi kiem_arg TRƯỚC khi tách ô arg");
  assert.ok(tach.indexOf("kiem_arg") < tach.indexOf('"$@" $ARG'), "chay_voi_arg: soát TRƯỚC, tách SAU");
  assert.match(tach, /set -f/, "chay_voi_arg phải tắt glob trước khi tách — `*` trong ô arg không được nở thành tên tệp trên máy chủ");
  const kiem = hamShell(s, "kiem_arg");
  assert.match(kiem, /case "\$ARG" in\s*\n\s*\*\[!A-Za-z0-9\\ =:\._,\/@\+-\]\*\)/, "kiem_arg phải là danh sách ký tự CHO PHÉP, đóng");
  assert.match(kiem, /exit \d+/, "kiem_arg: sai thì DỪNG, không chạy tiếp");
  assert.deepEqual(pham, [], `$ARG không ngoặc kép mà không có phép soát ký tự đứng trước:\n${pham.join("\n")}`);

  // Ngoài hai hàm và các nhánh có soát, không chỗ nào khác được dùng $ARG trần.
  const ngoaiNhanh = s.slice(0, s.indexOf('case "$ACTION" in'));
  const tranNgoai = ngoaiNhanh
    .split("\n")
    .filter((d) => argNgoaiNgoacKep(d).length)
    .filter((d) => d.trim() !== '"$@" $ARG || _rc=$?');
  assert.deepEqual(tranNgoai, [], `$ARG trần ngoài hàm chay_voi_arg:\n${tranNgoai.join("\n")}`);

  console.log(`✓ Chống chèn lệnh: 0 \`sh -c "…$ARG…"\` · $ARG trần chỉ sau danh sách ký tự cho phép · ${nhanh.size} nhánh đã quét`);
}

/* ═════════════ (b) db-query: erp_ro, không `\`, kết quả chỉ đi dạng mã hoá ═════════════ */

export function testDbQueryChiDocVaMaHoa() {
  const s = scriptOps();
  const nhanh = cacNhanh(s);
  const q = nhanh.get("db-query");
  assert.ok(q, "phải có nhánh db-query");

  const psql = q!.split("\n").filter((d) => /\bpsql\b/.test(d));
  const chay = psql.filter((d) => /"\$ARG"/.test(d));
  assert.equal(chay.length, 1, "db-query phải có đúng MỘT lệnh psql nhận câu SQL của người gõ");
  assert.match(chay[0]!, /-U erp_ro\b/, "câu SQL của người gõ phải chạy bằng role chỉ đọc erp_ro");
  assert.match(chay[0]!, /\|\s*ma_hoa_ket_qua\b/, "kết quả db-query phải đi qua ma_hoa_ket_qua — không in ra log");
  assert.match(chay[0]!, /\bpsql -X\b/, "psql phải bỏ qua psqlrc (-X)");
  for (const d of psql.filter((x) => /-U erp\b(?!_)/.test(x))) {
    assert.ok(!/"\$ARG"/.test(d), `lệnh chạy bằng role erp (superuser) không được nhận ô arg: ${d.trim()}`);
    assert.match(d, /\$SQL_RO/, `role erp chỉ được dùng để dựng erp_ro từ ${SQL_ROLE}: ${d.trim()}`);
  }
  assert.ok(!/PGOPTIONS/.test(q!), "PGOPTIONS ở shell máy chủ KHÔNG vào được container — đừng dựa vào nó");
  assert.match(q!, /case "\$ARG" in\s*\n\s*\*\\\\\*\)/, "db-query phải từ chối dấu `\\` (lệnh meta của psql: `\\!` chạy shell)");
  assert.match(q!, /fetch_script ops-erp-ro-role\.sql/, `db-query phải dựng role từ ${SQL_ROLE}`);
  assert.match(q!, /không bao giờ lùi về role erp/, "tải tệp role hỏng thì DỪNG — không lùi về superuser");
  assert.ok(q!.indexOf("OPS_RESULT_CERT_B64") < q!.indexOf("fetch_script ops-erp-ro-role.sql"), "thiếu chứng chỉ thì dừng TRƯỚC khi đụng CSDL");

  const sql = readFileSync(SQL_ROLE, "utf8");
  const sqlKhongChuThich = sql.replace(/--[^\n]*/g, "");
  assert.ok(!/GRANT\s+pg_/i.test(sqlKhongChuThich), "erp_ro không được nhận role dựng sẵn nào (pg_read_all_data đọc được pg_authid)");
  const dsQuyen = [...sqlKhongChuThich.matchAll(/GRANT\s+([A-Za-z ,]+?)\s+ON\b/gi)].map((m) => m[1]!.trim().toUpperCase());
  assert.ok(dsQuyen.length >= 3, `đọc hụt các lệnh GRANT trong ${SQL_ROLE}`);
  for (const q of dsQuyen) assert.ok(q === "SELECT" || q === "USAGE", `erp_ro chỉ được nhận SELECT / USAGE, thấy "GRANT ${q} ON"`);
  console.log("✓ db-query: psql -X -U erp_ro · role erp chỉ dựng erp_ro · từ chối `\\` · không PGOPTIONS · kết quả qua ma_hoa_ket_qua");
}

/* ═════════════ DANH SÁCH MÃ HOÁ KHỚP HAI CHIỀU · FAIL-CLOSED · HIỆN VẬT 1 NGÀY ═════════════ */

export function testDanhSachMaHoa() {
  const src = doc(OPS);
  const s = scriptOps();
  const m = /^ {2}OPS_THAO_TAC_MA_HOA: "([^"]+)"$/m.exec(src);
  assert.ok(m, "phải khai OPS_THAO_TAC_MA_HOA ở env mức workflow");
  const khai = new Set(m![1]!.trim().split(/\s+/));

  const nhanh = cacNhanh(s);
  const goi = new Set([...nhanh].filter(([, than]) => /\bma_hoa_ket_qua\b/.test(than)).map(([ten]) => ten));
  assert.deepEqual([...khai].sort(), [...goi].sort(), "OPS_THAO_TAC_MA_HOA phải KHỚP đúng các nhánh gọi ma_hoa_ket_qua — lệch một bên là hoặc thiếu chứng chỉ, hoặc bản mã không ai lấy về");
  for (const a of ["db-query", "vtp-debug", "phone-probe"]) assert.ok(khai.has(a), `${a} trả dữ liệu khách hàng — phải nằm trong danh sách mã hoá`);

  // Trong nhánh mã hoá, MỌI lệnh chạy thật phải đi qua ma_hoa_ket_qua (lệnh `cat > …` chép script thì không in gì).
  for (const a of goi) {
    const lenh = nhanh
      .get(a)!
      .split("\n")
      .filter((d) => /\bnpx tsx\b|\bpsql\b.*erp_ro/.test(d));
    assert.ok(lenh.length > 0, `${a}: không đọc được lệnh chạy`);
    for (const d of lenh) assert.match(d, /\bma_hoa_ket_qua\b/, `${a}: lệnh in kết quả KHÔNG qua ma_hoa_ket_qua: ${d.trim()}`);
  }

  // Log ứng dụng đi qua che_log (email, IP, SĐT), không chỉ che khoá webhook như bản cũ.
  for (const a of ["logs", "verify"]) {
    const than = nhanh.get(a)!;
    const dongLog = than.split("\n").filter((d) => /\$C logs\b/.test(d) || /^\s*\|/.test(d));
    assert.ok(dongLog.length > 0, `${a}: không đọc được lệnh đọc log`);
    assert.match(than, /\|\s*che_log\b/, `${a}: log ứng dụng phải đi qua che_log trước khi in`);
    assert.ok(!/sed -E 's\/\(pk\|vtp\)/.test(than), `${a}: không tự che riêng — dùng che_log (một chỗ để sửa)`);
  }

  // Hàm mã hoá: fail-closed, không bao giờ in bản rõ.
  const ham = hamShell(s, "ma_hoa_ket_qua");
  const iKiem = ham.indexOf('if [ -z "${OPS_RESULT_CERT_B64:-}" ]');
  assert.ok(iKiem > 0, "ma_hoa_ket_qua phải kiểm chứng chỉ trước");
  assert.ok(iKiem < ham.indexOf('"$@"'), "kiểm chứng chỉ phải đứng TRƯỚC khi chạy lệnh");
  const hetKiem = ham.slice(iKiem).search(/\n\s*fi\n/);
  assert.ok(hetKiem > 0, "không tìm thấy `fi` đóng phép kiểm chứng chỉ");
  assert.match(ham.slice(iKiem, iKiem + hetKiem), /exit \d+/, "không có chứng chỉ ⇒ DỪNG, không lùi về in bản rõ");
  assert.match(ham, /openssl cms -encrypt/, "mã hoá bằng openssl cms");
  assert.ok(!/\b(cat|tee|head|tail|less)\b[^\n]*ket-qua\.txt/.test(ham), "ma_hoa_ket_qua không được in bản rõ ket-qua.txt ra log");
  assert.match(ham, /rm -rf "\$_mh"/, "bản rõ phải bị xoá");

  // Phía máy Actions: thiếu chứng chỉ ⇒ đỏ; hiện vật giữ 1 ngày; không bao giờ đọc khoá riêng.
  const buocKiem = src.slice(src.indexOf("- name: Kiểm chứng chỉ người nhận"), src.indexOf("- uses: appleboy/ssh-action@", src.indexOf("- name: Kiểm chứng chỉ người nhận")));
  const khoiIf = (mo: RegExp) => {
    const i = buocKiem.search(mo);
    assert.ok(i > 0, `bước kiểm chứng chỉ thiếu phép kiểm ${mo}`);
    const j = buocKiem.slice(i).search(/\n\s*fi\n/);
    return buocKiem.slice(i, i + j);
  };
  assert.match(khoiIf(/if \[ ! -s "\$F" \]; then/), /\n\s*exit 1\s*$/, "bước kiểm chứng chỉ: thiếu tệp ⇒ exit 1");
  assert.match(khoiIf(/if grep -q "PRIVATE KEY"/), /\n\s*exit 1\s*$/, "bước kiểm chứng chỉ: tệp chứa khoá riêng ⇒ exit 1");
  assert.match(khoiIf(/if ! openssl x509/), /\n\s*exit 1\s*$/, "bước kiểm chứng chỉ: chứng chỉ hỏng / hết hạn ⇒ exit 1");
  assert.match(buocKiem, /sparse|F=deploy\/ops-result-recipient\.crt/, "bước kiểm đọc đúng tệp chứng chỉ trong kho");
  assert.match(src, /retention-days: 1\b/, "hiện vật bản mã chỉ giữ 1 ngày");
  assert.match(src, /name: ket-qua-ma-hoa-\$\{\{ github\.run_id \}\}/, "tên hiện vật phải mang run_id — người vận hành tải đúng lượt");
  if (existsSync(CHUNG_CHI)) {
    const pem = readFileSync(CHUNG_CHI, "utf8");
    assert.ok(!/PRIVATE KEY/.test(pem), `${CHUNG_CHI} CHỨA KHOÁ RIÊNG — thu hồi ngay, kho này PUBLIC`);
    assert.match(pem, /-----BEGIN CERTIFICATE-----/, `${CHUNG_CHI} phải là chứng chỉ X.509 (PEM)`);
  }
  for (const t of readdirSync("deploy")) {
    const noi = readFileSync(path.join("deploy", t), "utf8");
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(noi), `deploy/${t} chứa khoá riêng — kho này PUBLIC`);
  }
  console.log(`✓ Mã hoá: ${khai.size} thao tác khớp hai chiều · fail-closed ở cả máy Actions lẫn máy chủ · không in bản rõ · hiện vật 1 ngày`);
}

/* ═════════════ QUYỀN GITHUB_TOKEN · GHIM ACTION · (d) KHÔNG `${{ inputs.* }}` TRONG `run:` ═════════════ */

/** Các khối `run:` (inline hoặc `run: |`) của một workflow, kèm số dòng. */
function khoiRun(src: string): { dong: number; than: string }[] {
  const d = src.split("\n");
  const kq: { dong: number; than: string }[] = [];
  for (let i = 0; i < d.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(d[i]!);
    if (!m) continue;
    if (!/^[|>]/.test(m[2]!)) {
      kq.push({ dong: i + 1, than: m[2]! });
      continue;
    }
    const thut = m[1]!.length;
    const than: string[] = [];
    for (let k = i + 1; k < d.length; k += 1) {
      const x = d[k]!;
      if (x.trim() && x.length - x.trimStart().length <= thut) break;
      than.push(x);
    }
    kq.push({ dong: i + 1, than: than.join("\n") });
  }
  return kq;
}

/** Miễn trừ `${{ inputs.* }}` trong `run:` — mỗi dòng nói vì sao KHÔNG tiêm được. */
const INPUTS_TRONG_RUN_DA_KHAI: Record<string, string> = {
  "agent-identity-proof.yml":
    "`inputs.probe_merge` là type: boolean và biểu thức chỉ ra đúng một trong hai HẰNG chuỗi ('--probe-merge' | ''), không bao giờ ra chữ người gõ.",
};

export function testWorkflowKhongTiemInputs() {
  const pham: string[] = [];
  for (const t of readdirSync(THU_MUC).filter((f) => f.endsWith(".yml"))) {
    const src = boChuThich(doc(t));
    for (const r of khoiRun(src)) {
      if (!/\$\{\{\s*inputs\./.test(r.than)) continue;
      if (INPUTS_TRONG_RUN_DA_KHAI[t] && !/\$\{\{\s*inputs\.(?!probe_merge\b)/.test(r.than)) continue;
      pham.push(`${t}:${r.dong}`);
    }
  }
  assert.deepEqual(pham, [], `\`\${{ inputs.* }}\` nội suy THẲNG vào thân \`run:\` (chạy trước khi shell đọc script ⇒ tiêm lệnh). Chuyển sang \`env:\` rồi dùng "$VAR":\n${pham.join("\n")}`);

  const ar = boChuThich(doc("agent-run.yml"));
  assert.ok(!khoiRun(ar).some((r) => /\$\{\{\s*(inputs|github\.event)\./.test(r.than)), "agent-run.yml: không `${{ inputs.* }}` / `${{ github.event.* }}` trong run:");

  // Quyền token của ops: khai tường minh, chỉ đọc.
  const ops = doc(OPS);
  const quyen = /^permissions:\s*\n((?: {2}\S[^\n]*\n)+)/m.exec(ops)?.[1] ?? "";
  assert.match(quyen, /contents:\s*read/, "ops-vps.yml phải khai `permissions: contents: read`");
  assert.ok(!/:\s*write/.test(quyen), "ops-vps.yml: GITHUB_TOKEN không cần quyền GHI nào");
  assert.ok(!/^ {4}permissions:/m.test(ops), "không job nào của ops-vps.yml được nới quyền riêng");

  // appleboy/ssh-action cầm VPS_PASSWORD / VPS_SSH_KEY: ghim theo SHA, không theo thẻ dời được.
  let soGhim = 0;
  for (const t of readdirSync(THU_MUC).filter((f) => f.endsWith(".yml"))) {
    for (const x of doc(t).matchAll(/uses:\s*appleboy\/ssh-action@(\S+)(.*)$/gm)) {
      assert.match(x[1]!, /^[0-9a-f]{40}$/, `${t}: appleboy/ssh-action phải ghim theo SHA 40 ký tự, thấy @${x[1]}`);
      assert.match(x[2]!, /#\s*v\d/, `${t}: ghi thẻ tương ứng trong chú thích cạnh SHA`);
      soGhim += 1;
    }
  }
  assert.ok(soGhim >= 3, `phải thấy ít nhất 3 bước appleboy/ssh-action (ops, agent-env, deploy), thấy ${soGhim}`);
  console.log(`✓ Workflow: 0 \`\${{ inputs.* }}\` trong run: (1 miễn trừ boolean có lý do) · ops chỉ contents:read · ${soGhim} bước SSH ghim SHA`);
}

/* ═════════════ CHẠY THẬT: role erp_ro trên Postgres (PGlite) ═════════════ */

export async function testRoleChiDocChayThat() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const sql = readFileSync(SQL_ROLE, "utf8");
  const loi = async (cau: string) => {
    try {
      await db.exec(cau);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  try {
    await db.exec(`
      create table orders (id serial primary key, phone text, name text);
      insert into orders (phone, name) values ('0912345678', 'Khách A');
      create schema drizzle;
      create table drizzle.__drizzle_migrations (id int);
      create view v_orders as select * from orders;
    `);
    await db.exec(sql);
    await db.exec(sql); // idempotent: chạy lượt hai không lỗi
    await db.exec("create table tao_sau (x int)"); // bảng migration tạo SAU lượt dựng role

    const r = await db.query<{ rolsuper: boolean; rolcanlogin: boolean; rolconfig: string[] }>(
      "select rolsuper, rolcanlogin, rolconfig from pg_roles where rolname = 'erp_ro'",
    );
    assert.equal(r.rows.length, 1, "role erp_ro phải được tạo");
    assert.equal(r.rows[0]!.rolsuper, false, "erp_ro không được là superuser");
    assert.equal(r.rows[0]!.rolcanlogin, true, "erp_ro phải đăng nhập được (qua socket cục bộ)");
    assert.ok(r.rows[0]!.rolconfig.includes("default_transaction_read_only=on"), "mặc định phiên của erp_ro là chỉ đọc");
    assert.ok(r.rows[0]!.rolconfig.some((c) => c.startsWith("statement_timeout=")), "erp_ro có trần thời gian câu lệnh");

    await db.exec("set role erp_ro");
    const doc1 = await db.query<{ n: number }>("select count(*)::int as n from orders");
    assert.equal(doc1.rows[0]!.n, 1, "erp_ro ĐỌC được bảng nghiệp vụ");
    await db.exec("select * from v_orders; select * from drizzle.__drizzle_migrations; select * from tao_sau");

    // HÀNG RÀO THẬT: tắt cờ chỉ-đọc rồi ghi vẫn chết vì QUYỀN.
    for (const cau of [
      // Ghi rõ `id`: để mặc định `serial` thì lệnh chết vì thiếu quyền trên SEQUENCE — một lý do
      // khác — và bài kiểm xanh cả khi erp_ro lỡ được cấp INSERT (đột biến đã sống sót đúng như thế).
      "set default_transaction_read_only = off; insert into orders (id, phone) values (99, 'x')",
      "set default_transaction_read_only = off; update orders set phone = 'y'",
      "set default_transaction_read_only = off; delete from orders",
      "set default_transaction_read_only = off; truncate orders",
      "set default_transaction_read_only = off; create table t_moi (x int)",
      "set default_transaction_read_only = off; select nextval('orders_id_seq')",
    ]) {
      const m = await loi(cau);
      assert.ok(m && /permission denied/i.test(m), `erp_ro phải bị TỪ CHỐI vì quyền: "${cau}" → ${m ?? "CHẠY ĐƯỢC"}`);
    }
    for (const cau of ["select rolpassword from pg_authid", "select * from pg_shadow", "copy orders to program 'id'", "select pg_read_file('/etc/passwd')"]) {
      const m = await loi(cau);
      assert.ok(m && /permission denied/i.test(m), `erp_ro không được chạm "${cau}" → ${m ?? "CHẠY ĐƯỢC"}`);
    }
    await db.exec("reset role");
    const sau = await db.query<{ n: number }>("select count(*)::int as n from orders");
    assert.equal(sau.rows[0]!.n, 1, "không một dòng nào bị đổi");
  } finally {
    await db.close();
  }
  console.log("✓ erp_ro (PGlite thật): đọc được bảng + view + schema drizzle + bảng tạo sau · SET read_only=off; INSERT/UPDATE/DELETE/TRUNCATE/CREATE/nextval ⇒ permission denied · không đọc pg_authid · idempotent");
}

/* ═════════════ CHẠY THẬT: ma_hoa_ket_qua · chay_voi_arg · che_log dưới bash ═════════════ */

function coLenh(lenh: string, thamSo: string[]): boolean {
  try {
    execFileSync(lenh, thamSo, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Môi trường con cho bash/openssl: mang PATH của máy (để tìm được hai công cụ ấy) nhưng BỎ
 * `OPENSSL_CONF` — trên Windows biến này hay trỏ vào tệp cấu hình của phần mềm khác đã gỡ, và
 * openssl chết trước khi làm gì. Đó là dựng ĐẦU VÀO cho phép đo, không phải điều kiện của kết luận.
 */
function moiTruongSach(them: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...them };
  delete env.OPENSSL_CONF;
  return env;
}

/** Tệp bản rõ `ket-qua.txt` còn sót ở các chỗ `ma_hoa_ket_qua` có thể đặt nó. */
function banRoConSot(thuMucTam: string): string[] {
  const kq: string[] = [];
  for (const goc of ["/dev/shm", thuMucTam]) {
    if (!existsSync(goc)) continue;
    for (const d of readdirSync(goc)) {
      const f = path.join(goc, d, "ket-qua.txt");
      if (existsSync(f)) kq.push(f);
    }
  }
  return kq;
}

export function testHamShellChayThat() {
  if (!coLenh("bash", ["--version"]) || !coLenh("openssl", ["version"])) {
    assert.notEqual(process.platform, "linux", "Linux PHẢI có bash + openssl — thiếu thì hàm mã hoá không được đo");
    console.log(`⚠ Hàm mã hoá ops: CHƯA ĐO ĐƯỢC trên ${process.platform} (thiếu bash/openssl).`);
    return;
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "ops-lo-log-"));
  const p = (x: string) => path.join(tmp, x).split(path.sep).join("/");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes", "-subj", "/CN=kiem-thu-ops", "-keyout", p("k.key"), "-out", p("k.crt")], {
      stdio: "ignore",
      env: moiTruongSach({}),
    });
    const certB64 = readFileSync(p("k.crt")).toString("base64");

    const s = scriptOps();
    const ham = ["che_log", "kiem_arg", "chay_voi_arg", "ma_hoa_ket_qua"].map((t) => hamShell(s, t)).join("\n");
    const kich = p("ham.sh");
    writeFileSync(
      kich,
      ["#!/usr/bin/env bash", "set -e", `OPS_OUT_DIR=${JSON.stringify(p("out"))}`, 'RUN_ID="42"', 'ACTION="db-query"', ham, 'eval "$KICH_BAN"', ""].join("\n"),
    );
    mkdirSync(p("t"), { recursive: true });
    const chay = (kichBan: string, env: Record<string, string>, vao = "") => {
      try {
        const ra = execFileSync("bash", [kich], {
          input: vao, encoding: "utf8", stdio: "pipe", cwd: tmp,
          env: moiTruongSach({ KICH_BAN: kichBan, TMPDIR: p("t"), ...env }),
        });
        return { ma: 0, ra };
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { ma: x.status ?? 1, ra: String(x.stdout ?? "") + String(x.stderr ?? "") };
      }
    };

    // 1. Có chứng chỉ: kết quả có PII KHÔNG ra stdout, nằm trong bản mã, giải mã ra đúng.
    const PII = "0912345678 | Nguyễn Văn Khách | 12 Ngõ Huế";
    const lenhGia = `cat; printf '%s\\n' '${PII}' '(1 row)'; echo "psql:<stdin>:1: ERROR:  loi 'bi mat 0987654321' khach@vi.du" >&2; exit 3`;
    const r1 = chay(`ma_hoa_ket_qua bash -c "$LENH_GIA"`, { OPS_RESULT_CERT_B64: certB64, LENH_GIA: lenhGia, ARG: "x" }, "select 1;\n");
    assert.equal(r1.ma, 3, `mã thoát của lệnh phải đi qua nguyên vẹn:\n${r1.ra}`);
    for (const bi of ["0912345678", "Nguyễn Văn Khách", "select 1", "0987654321", "khach@vi.du", "bi mat"]) {
      assert.ok(!r1.ra.includes(bi), `log KHÔNG được chứa "${bi}":\n${r1.ra}`);
    }
    assert.match(r1.ra, /1 khối kết quả, tổng 1 dòng dữ liệu/, `log phải có SỐ DÒNG:\n${r1.ra}`);
    assert.match(r1.ra, /lỗi đầu tiên \(đã che\): psql:<stdin>:1: ERROR:/, `log phải có LOẠI lỗi đã che:\n${r1.ra}`);
    const banMa = p("out/42.p7m");
    assert.ok(existsSync(banMa), "bản mã phải nằm ở OPS_OUT_DIR/<run_id>.p7m");
    const ro = execFileSync("openssl", ["cms", "-decrypt", "-binary", "-inform", "DER", "-in", banMa, "-inkey", p("k.key")], { encoding: "utf8", env: moiTruongSach({}) });
    assert.ok(ro.includes(PII) && ro.includes("select 1;") && ro.includes("bi mat 0987654321"), `giải mã phải ra đủ kết quả + stdin + lỗi gốc:\n${ro}`);
    assert.deepEqual(banRoConSot(p("t")), [], "bản rõ phải bị xoá sau khi mã hoá");

    // 2. KHÔNG có chứng chỉ ⇒ từ chối, lệnh KHÔNG chạy, không có bản mã mới, không in bản rõ.
    rmSync(banMa);
    const dau = p("da-chay");
    const r2 = chay(`ma_hoa_ket_qua bash -c "$LENH_GIA"`, { OPS_RESULT_CERT_B64: "", ARG: "", LENH_GIA: `printf '%s\\n' '${PII}'; touch '${dau}'` });
    assert.notEqual(r2.ma, 0, "thiếu chứng chỉ phải DỪNG với mã lỗi");
    assert.ok(!existsSync(dau), "thiếu chứng chỉ thì lệnh KHÔNG được chạy");
    assert.ok(!r2.ra.includes("0912345678"), "thiếu chứng chỉ không được lùi về in bản rõ");
    assert.match(r2.ra, /docs\/ops-doc-ket-qua\.md/, "thông báo phải trỏ tới tài liệu");

    // 3. chay_voi_arg: tách cờ đúng; ký tự lạ ⇒ dừng, không chạy; không nở glob.
    const r3 = chay(`chay_voi_arg printf '[%s]'`, { ARG: "--from 2026-09-01 --to=2026-09-30 --apply" });
    assert.equal(r3.ra, "[--from][2026-09-01][--to=2026-09-30][--apply]", `tách cờ sai: ${r3.ra}`);
    for (const xau of ["x; touch PWN", "$(touch PWN)", "`touch PWN`", "a|b", "a&b", "a'b", 'a"b', "*", "a\nb", "a\\b"]) {
      const r = chay(`chay_voi_arg touch ${JSON.stringify(p("PWN2"))}`, { ARG: xau });
      assert.equal(r.ma, 64, `ô arg ${JSON.stringify(xau)} phải bị từ chối (exit 64), nhận ${r.ma}`);
      assert.ok(!existsSync(p("PWN2")) && !existsSync(p("PWN")), `ô arg ${JSON.stringify(xau)} không được chạy lệnh`);
      assert.ok(!r.ra.includes(xau.trim() || "@@"), `thông báo lỗi không được in lại nội dung ô arg ${JSON.stringify(xau)}`);
    }

    // 4. che_log: email, IP, SĐT, token trong URL, khoá webhook.
    const nhat = [
      "POST /api/webhooks/pancake/pk_0123456789abcdef0123456789abcdef from 203.113.7.9 user=ban.hang@shop.vn",
      "sdt 0912345678 va +84987654321, url https://x/y?access_token=EAAB123&page=2 ipv6 2001:db8:85a3::8a2e:370:7334",
    ].join("\n");
    const r4 = chay("printf '%s\\n' \"$NHAT\" | che_log", { NHAT: nhat, ARG: "" });
    for (const bi of ["0123456789abcdef", "203.113.7.9", "ban.hang@shop.vn", "0912345678", "84987654321", "EAAB123", "2001:db8:85a3", "370:7334"]) {
      assert.ok(!r4.ra.includes(bi), `che_log phải che "${bi}":\n${r4.ra}`);
    }
    assert.match(r4.ra, /page=2/, "che_log không được nuốt phần không nhạy cảm");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log("✓ Hàm shell chạy thật: bản rõ không ra log, bản mã giải được · thiếu chứng chỉ ⇒ dừng, lệnh không chạy · chay_voi_arg chặn 10 dạng chèn · che_log che email/IP/SĐT/token");
}

export async function testOpsLogLeak() {
  testKhongInArg();
  testCheArgTruocMoiBuoc();
  testCheArgChayThat();
  testKhongChenLenh();
  testDbQueryChiDocVaMaHoa();
  testDanhSachMaHoa();
  testWorkflowKhongTiemInputs();
  await testRoleChiDocChayThat();
  testHamShellChayThat();
}

if (process.argv[1] && process.argv[1].endsWith("ops-log-leak.test.ts")) {
  testOpsLogLeak().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
