import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { checkWritePath } from "@/lib/constants/agent-sandbox";
import { NEVER_WRITE, TEST_NEU_LAM_VI_DU, WRITE_GLOBS_BY_ROLE, writeGlobsForRole } from "@/lib/constants/agent-scopes";
import { demKhangDinh, kiemHangRaoBaiKiem, moTaViPham } from "@/lib/constants/agent-test-guard";
import { TECH_AGENT_ROLES } from "@/lib/constants/tech";

/**
 * ═══════════ NẤC 2 · PHẠM VI GHI THEO VAI, VÀ HAI HÀNG RÀO ĐI KÈM ═══════════
 *
 * Nấc 1 cho agent đúng một quyền ghi: `docs/`. Nấc 2 nới theo từng bước kiếm được, và mỗi bước
 * nới phải đi kèm hàng rào của chính bước ấy — nếu không, "nới dần" chỉ là "mở dần".
 *
 * Bài này khoá ba tính chất, và tính chất thứ hai là tính chất dễ mất nhất:
 *
 *   1. Vai lạ / chưa khai rơi về `docs/` — HẸP hơn, không bao giờ rộng hơn.
 *   2. `NEVER_WRITE` chặn TRƯỚC sổ vai, nên một dòng khai sai không mở được nó.
 *   3. Agent ghi được `tests/` thì không được làm xanh cổng bằng cách XOÁ khẳng định.
 */

const goc = path.resolve(__dirname, "..");

/** Bỏ chú thích trước khi quét — một khối GIẢI THÍCH về hàng rào không phải là hàng rào. */
function boChuThich(ma: string): string {
  return ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Đúng phép so mà `checkWritePath` dùng: mục kết thúc bằng `/` là tiền tố, còn lại là so BẰNG. */
function matchesNeverWrite(p: string): boolean {
  return NEVER_WRITE.some((g) => (g.endsWith("/") ? p.startsWith(g) : p === g));
}

/* ═════════════ 1 · PHẠM VI THEO VAI, MỌI NHÁNH LỖI RƠI VỀ PHÍA HẸP ═════════════ */

export function testPhamViTheoVai() {
  assert.deepEqual([...writeGlobsForRole("DOCUMENTATION")], ["docs/"], "vai tài liệu vẫn chỉ ghi docs/");
  assert.deepEqual([...writeGlobsForRole("QA")], ["docs/", "tests/"], "vai QA được nới sang tests/");

  /*
    MỌI NHÁNH LỖI RƠI VỀ PHÍA HẸP HƠN (cùng luật AGENTS.md mục 31). Một vai chưa khai, một chuỗi
    rác, hay `null` đều phải ra `docs/` — không bao giờ ra "toàn bộ cây".
  */
  for (const la of [null, undefined, "", "BACKEND", "KHONG_TON_TAI", "../", "*"]) {
    assert.deepEqual([...writeGlobsForRole(la)], ["docs/"], `vai "${String(la)}" phải rơi về docs/`);
  }

  /* Mọi vai trong sổ đều phải tra được, và không vai nào ra phạm vi rỗng (rỗng = không ghi được gì). */
  for (const r of TECH_AGENT_ROLES) {
    const g = writeGlobsForRole(r);
    assert.ok(g.length > 0, `vai ${r} phải có ít nhất một phạm vi ghi`);
  }

  /* Sổ khai không được chứa vai không tồn tại — gõ sai tên vai là một dòng khai vĩnh viễn vô hiệu. */
  for (const k of Object.keys(WRITE_GLOBS_BY_ROLE)) {
    assert.ok((TECH_AGENT_ROLES as readonly string[]).includes(k), `sổ phạm vi khai vai lạ: ${k}`);
  }
}

/* ═════════════ 2 · HÀNG RÀO TUYỆT ĐỐI CHẶN TRƯỚC SỔ VAI ═════════════ */

export function testHangRaoTuyetDoi() {
  /*
    PHẠM VI THỬ DỰNG TỪ CHÍNH `NEVER_WRITE` — không gõ tay một danh sách "rộng toang".

    Bản đầu của bài này gõ tay `["", "lib/", "db/", …]` và tự nhận là rộng toang. Nó KHÔNG rộng:
    `matches()` xử lý mục không kết thúc bằng `/` như một so sánh BẰNG, nên `""` không khớp gì cả,
    và `drizzle/`, `middleware.ts`, `AGENTS.md`, `package.json` không khớp mục nào. Bốn đường dẫn
    ấy khi đó bị chặn bởi `writeGlobs` chứ KHÔNG phải bởi `NEVER_WRITE` — bài kiểm xanh mà không
    đo đúng thứ nó nói. Đột biến "gỡ `NEVER_WRITE` đi" vì thế lọt qua.

    Dựng phạm vi từ chính `NEVER_WRITE` thì MỌI đường dẫn cấm đều khớp `writeGlobs`, nên thứ duy
    nhất còn có thể chặn chúng là hàng rào tuyệt đối. Và nó tự bám theo sổ: thêm một vùng cấm mới
    là tự động có một ca kiểm mới.
  */
  const phamViRongToang: readonly string[] = [...NEVER_WRITE];
  const cam = [
    "lib/actions/orders.ts",
    "lib/auth/session.ts",
    "db/schema.ts",
    "drizzle/0107_agent_run_external_ref.sql",
    ".github/workflows/gates.yml",
    "middleware.ts",
    "scripts/ai-check.ts",
    "lib/constants/agent-sandbox.ts",
    "lib/constants/agent-scopes.ts",
    "lib/constants/agent-test-guard.ts",
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    "next.config.ts",
    "db/migrate.ts",
    "lib/agents/runner.ts",
    "app/api/tech/agent-run/route.ts",
    "tests/sync-fixtures.test.ts",
    "tests/contract-order-outcome.test.ts",
    "tests/repo-integrity.test.ts",
    "tests/migration-journal.test.ts",
    "tests/migration-upgrade-path.test.ts",
    "tests/access-model.test.ts",
    "tests/cost-allocation.test.ts",
    "tests/product-notes.test.ts",
    "tests/care-reopen.test.ts",
    "tests/test-hygiene.test.ts",
    "tests/agent-scopes.test.ts",
  ];
  for (const f of cam) {
    assert.ok(matchesNeverWrite(f), `ca kiểm "${f}" phải nằm trong NEVER_WRITE, nếu không nó đang đo nhầm hàng rào`);
    const v = checkWritePath(f, phamViRongToang);
    assert.ok(!v.allowed, `${f} phải bị chặn NGAY CẢ khi phạm vi khai trùng đúng vùng cấm`);
  }
  /* Mọi vùng cấm trong sổ đều phải có ít nhất một ca kiểm — thêm vùng mà quên kiểm là vùng không ai đo. */
  for (const g of NEVER_WRITE) {
    assert.ok(cam.some((f) => f === g || f.startsWith(g)), `vùng cấm "${g}" chưa có ca kiểm nào`);
  }

  /*
    CHÍNH HÀNG RÀO PHẢI NẰM TRONG VÙNG CẤM. Một agent sửa được hàng rào của mình thì hàng rào chỉ
    còn là một lời đề nghị — và nó sẽ tự nới ở đúng lượt chạy mà ta cần nó chặn nhất.
  */
  for (const f of ["lib/constants/agent-sandbox.ts", "lib/constants/agent-scopes.ts", "lib/constants/agent-test-guard.ts"]) {
    assert.ok(NEVER_WRITE.some((g) => f === g || f.startsWith(g)), `${f} PHẢI nằm trong NEVER_WRITE`);
  }

  /* …và thứ được phép vẫn phải đi qua. Một hàng rào chặn tất cả là một hàng rào vô dụng. */
  assert.ok(checkWritePath("docs/ghi-chu.md", ["docs/"]).allowed, "docs/ vẫn ghi được");
  assert.ok(checkWritePath("tests/abc.test.ts", ["docs/", "tests/"]).allowed, "vai QA ghi được tests/");
  assert.ok(!checkWritePath("tests/abc.test.ts", ["docs/"]).allowed, "nhưng vai chỉ có docs/ thì không");

  /* Đi ngược ra ngoài cây vẫn bị chặn, kể cả khi ngụy trang bằng tiền tố hợp lệ. */
  for (const xau of ["docs/../lib/actions/x.ts", "../x.ts", "/etc/passwd", "~/x"]) {
    assert.ok(!checkWritePath(xau, ["docs/", "tests/"]).allowed, `"${xau}" phải bị chặn`);
  }
}

/* ═════════════ 3 · KHÔNG LÀM XANH CỔNG BẰNG CÁCH XOÁ KHẲNG ĐỊNH ═════════════ */

export function testHangRaoBaiKiem() {
  const ba = `assert.equal(1, 1);\nassert.ok(true);\nassert.deepEqual([], []);\n`;
  const hai = `assert.equal(1, 1);\nassert.ok(true);\n`;
  assert.equal(demKhangDinh(ba), 3);
  assert.equal(demKhangDinh(hai), 2);

  /*
    CHÚ THÍCH VÀ CHUỖI KHÔNG PHẢI KHẲNG ĐỊNH. Không bỏ chúng ra thì một agent chỉ cần viết thêm
    một dòng chú thích nhắc tới `assert.equal` là đủ bù cho một khẳng định vừa xoá.
  */
  assert.equal(demKhangDinh(`// assert.equal(1,1)\n/* assert.ok(x) */\nconst s = "assert.equal(9,9)";\n`), 0, "chú thích và chuỗi KHÔNG được tính là khẳng định");

  // ───────── Xoá bớt ⇒ KHÔNG ĐẠT, và nêu đúng tệp cùng đúng con số ─────────
  const xau = kiemHangRaoBaiKiem([{ path: "tests/a.test.ts", truoc: ba, sau: hai }]);
  assert.ok(!xau.ok, "xoá một khẳng định phải là KHÔNG ĐẠT");
  assert.ok(!xau.ok && xau.viPham[0].truoc === 3 && xau.viPham[0].sau === 2, "phải nêu đúng con số trước/sau");
  assert.match(moTaViPham(xau), /tests\/a\.test\.ts: 3 → 2/, "câu giải thích phải nêu đúng tệp và đúng con số");

  // ───────── Thêm vào / giữ nguyên / tệp mới ⇒ ĐẠT ─────────
  assert.ok(kiemHangRaoBaiKiem([{ path: "tests/a.test.ts", truoc: hai, sau: ba }]).ok, "thêm khẳng định thì đạt");
  assert.ok(kiemHangRaoBaiKiem([{ path: "tests/a.test.ts", truoc: ba, sau: ba }]).ok, "giữ nguyên thì đạt");
  assert.ok(kiemHangRaoBaiKiem([{ path: "tests/moi.test.ts", truoc: null, sau: ba }]).ok, "tệp mới không có gì để giảm");

  /*
    XOÁ CẢ TỆP là cách xoá khẳng định triệt để nhất — và là ca dễ lọt nhất, vì "tệp không còn" trông
    giống "không có gì để so".
  */
  const xoa = kiemHangRaoBaiKiem([{ path: "tests/a.test.ts", truoc: ba, sau: null }]);
  assert.ok(!xoa.ok, "xoá cả tệp kiểm thử phải là KHÔNG ĐẠT");
  assert.ok(!xoa.ok && xoa.viPham[0].sau === 0);

  /* Một tệp hỏng trong nhiều tệp vẫn phải làm cả lượt chạy KHÔNG ĐẠT. */
  const tron = kiemHangRaoBaiKiem([
    { path: "tests/a.test.ts", truoc: hai, sau: ba },
    { path: "tests/b.test.ts", truoc: ba, sau: hai },
  ]);
  assert.ok(!tron.ok, "thêm ở tệp này không bù được cho việc xoá ở tệp kia");
}

/* ═════════════ 4 · QUÉT MÃ NGUỒN ═════════════ */

/* ═════════════ 3b · BÀI KIỂM KHOÁ LUẬT PHẢI NẰM NGOÀI TẦM VỚI ═════════════ */

export function testBaiKiemKhoaLuatNgoaiTamVoi() {
  /*
    ───────── 3b.1 HAI ĐƯỜNG LÁCH MÀ BỘ ĐẾM KHẲNG ĐỊNH KHÔNG THẤY ─────────

    `kiemHangRaoBaiKiem()` đếm SỐ khẳng định, nên nó chặn được "xoá bớt" nhưng không thấy hai
    đường dưới đây. Bài kiểm dựng CẢ HAI trên chính cái hàm ấy — nếu một ngày nó tự phát hiện
    được thì hai dòng này đỏ, và đó là tin tốt cần biết.
  */
  const doiGiaTri = kiemHangRaoBaiKiem([
    { path: "tests/contract-order-outcome.test.ts", truoc: "assert.equal(outcome, 'RETURNED');", sau: "assert.equal(outcome, 'DELIVERED');" },
  ]);
  assert.ok(doiGiaTri.ok, "bộ đếm khẳng định KHÔNG thấy việc đổi giá trị kỳ vọng — đó là vì sao cần hàng rào đường dẫn");

  const xoaDongDangKy = kiemHangRaoBaiKiem([
    { path: "tests/sync-fixtures.test.ts", truoc: "  await testA();\n  await testB();", sau: "  await testA();" },
  ]);
  assert.ok(xoaDongDangKy.ok, "xoá một dòng ĐĂNG KÝ không đổi số khẳng định — cả một khối biến mất mà bộ đếm im lặng");

  /* …và hàng rào đường dẫn bịt đúng hai chỗ đó. */
  for (const f of ["tests/contract-order-outcome.test.ts", "tests/sync-fixtures.test.ts"]) {
    assert.ok(!checkWritePath(f, ["docs/", "tests/"]).allowed, `${f} phải ngoài tầm với của vai QA`);
  }
  /* Nhưng vai QA vẫn phải viết được bài kiểm MỚI — hàng rào chặn tất cả là hàng rào vô dụng. */
  assert.ok(checkWritePath("tests/mot-bai-moi.test.ts", ["docs/", "tests/"]).allowed, "vai QA vẫn viết được bài kiểm mới");

  /*
    ───────── 3b.2 CHỐNG TRÔI: SỔ ĐI THEO AGENTS.md, KHÔNG ĐI THEO TRÍ NHỚ ─────────

    Mọi tệp kiểm thử mà AGENTS.md NHẮC TÊN phải được xếp vào một trong hai chỗ: hàng rào tuyệt
    đối, hoặc danh sách "nêu làm ví dụ" kèm lý do. Thêm một luật mới có nhắc tên một bài kiểm mà
    quên xếp ⇒ dòng này đỏ ngay, thay vì bài ấy lặng lẽ nằm trong tầm với.
  */
  const luat = readFileSync(path.join(goc, "AGENTS.md"), "utf8");
  const duocNhac = [...new Set([...luat.matchAll(/tests\/[a-z0-9-]+\.test\.ts/g)].map((m) => m[0]))];
  assert.ok(duocNhac.length >= 10, `AGENTS.md phải nhắc tên ít nhất 10 bài kiểm, mới thấy ${duocNhac.length}`);
  const chuaXep = duocNhac.filter((f) => !matchesNeverWrite(f) && !TEST_NEU_LAM_VI_DU[f]);
  assert.deepEqual(chuaXep, [], "bài kiểm được AGENTS.md nhắc tên phải nằm trong NEVER_WRITE, hoặc khai ở TEST_NEU_LAM_VI_DU kèm lý do");

  /* Danh sách miễn trừ phải nêu lý do, và chỉ chứa tệp CÓ THẬT — mục trỏ vào hư không là mục không ai dám xoá. */
  for (const [f, vi] of Object.entries(TEST_NEU_LAM_VI_DU)) {
    assert.ok(vi.trim().length > 20, `miễn trừ "${f}" phải nêu lý do`);
    assert.ok(existsSync(path.join(goc, f)), `miễn trừ "${f}" trỏ vào tệp không còn tồn tại`);
    assert.ok(!matchesNeverWrite(f), `"${f}" vừa trong hàng rào vừa trong danh sách miễn trừ — hai chỗ nói hai điều khác nhau`);
  }

  /* Mọi mục kiểm thử TRONG hàng rào cũng phải trỏ vào tệp có thật, cùng lý do chống trôi. */
  for (const g of NEVER_WRITE.filter((x) => x.startsWith("tests/"))) {
    assert.ok(existsSync(path.join(goc, g)), `vùng cấm "${g}" không còn tồn tại — đổi tên thì phải sửa sổ, nếu không nó hết bảo vệ mà không ai biết`);
  }
}

export function testPhamViSourceGuards() {
  const sandbox = readFileSync(path.join(goc, "lib/constants/agent-sandbox.ts"), "utf8");
  const runner = readFileSync(path.join(goc, "lib/agents/runner.ts"), "utf8");
  const proof = readFileSync(path.join(goc, "scripts/agent-proof-report.ts"), "utf8");

  /*
    THỨ TỰ KIỂM LÀ MỘT TÍNH CHẤT BẢO MẬT, KHÔNG PHẢI MỘT CHI TIẾT CÀI ĐẶT.
    `NEVER_WRITE` phải đứng TRƯỚC phép so với `writeGlobs`; đảo lại thì một phạm vi khai rộng sẽ
    mở được vùng cấm, và không bài kiểm hành vi nào ở trên thấy được nếu ai đó chỉ đảo hai dòng.
  */
  /*
    QUÉT TRÊN MÃ ĐÃ BỎ CHÚ THÍCH.

    Bản đầu quét thẳng tệp và vì thế KHÔNG bắt được đột biến "gỡ hẳn dòng kiểm `NEVER_WRITE`":
    chuỗi ấy vẫn còn trong khối chú thích GIẢI THÍCH ngay bên trên, nên `indexOf` vẫn tìm thấy.
    Đây là lần thứ ba trong cùng một ngày cái bẫy này cắn — nên nó được ghi thẳng vào đây.
  */
  const sachSandbox = boChuThich(sandbox);
  const than = sachSandbox.slice(sachSandbox.indexOf("export function checkWritePath"));
  const iNever = than.indexOf("NEVER_WRITE");
  const iGlobs = than.indexOf("matches(p, writeGlobs)");
  assert.ok(iNever > 0 && iGlobs > 0, "checkWritePath phải kiểm cả NEVER_WRITE lẫn writeGlobs");
  assert.ok(iNever < iGlobs, "NEVER_WRITE phải được kiểm TRƯỚC writeGlobs");

  /* Runner đọc phạm vi TỪ VAI, không ghi cứng một hằng số. */
  assert.ok(boChuThich(runner).includes("writeGlobsForRole(agent.role)"), "runner phải lấy phạm vi ghi theo VAI của agent");
  assert.ok(!boChuThich(runner).includes("DOCUMENTATION_WRITE_GLOBS"), "runner KHÔNG được ghi cứng phạm vi của vai tài liệu cho mọi vai");

  /* Bước nghiệm thu phải chạy hàng rào bài kiểm — nới `tests/` mà quên nó là nới trần trụi. */
  assert.ok(boChuThich(proof).includes("kiemHangRaoBaiKiem"), "bước nghiệm thu phải kiểm việc làm yếu bộ kiểm thử");
  assert.ok(proof.includes('f.startsWith("tests/")'), "và phải xét đúng các tệp trong tests/");

  console.log(
    `✓ Nấc 2 (phạm vi theo vai): vai lạ rơi về docs/ · NEVER_WRITE chặn TRƯỚC sổ vai (${NEVER_WRITE.length} vùng cấm, gồm CHÍNH hàng rào và nơi thi hành nó) · xoá khẳng định hay xoá cả tệp kiểm thử đều KHÔNG ĐẠT · bài kiểm khoá luật ngoài tầm với (đổi giá trị kỳ vọng và xoá dòng đăng ký đều lọt bộ đếm)`,
  );
}
