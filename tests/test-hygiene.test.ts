import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * ═══════════ BÀI KIỂM ĐO MÃ NGUỒN, KHÔNG ĐO CÁI MÁY ĐANG CHẠY (AGENTS.md mục 65) ═══════════
 *
 * Mục 50 cấm ghim ngày tuyệt đối. Ngày 20/09/2026 cùng một LỚP lỗi ấy cắn thêm bốn lần nữa, chỉ
 * khác nguồn — và cả bốn đều xanh ở một nơi, đỏ ở nơi khác:
 *
 *   · kết thúc dòng (CRLF trên Windows vs LF ở CI)  — `cs-workqueue` ĐỎ trên máy, XANH ở CI;
 *   · dấu phân cách đường dẫn (Windows vs POSIX)    — `care-reopen`, `bank-ledger`;
 *   · sự CÓ MẶT của `GITHUB_TOKEN`                  — trần request 12 vs 3, khẳng định gõ lại số;
 *   · công cụ hệ điều hành (`flock`, `npm.cmd`)     — `ops-concurrency`, `tech-phase2a`.
 *
 * Vá từng ca là dạy cả hệ thống rằng lớp lỗi này chấp nhận được. Bài kiểm này quét CẢ LỚP ở mức
 * mã nguồn, để lần thứ năm đỏ ngay trên máy người viết thay vì ở CI của người khác.
 *
 * MỌI MIỄN TRỪ PHẢI KHAI KÈM LÝ DO. Một danh sách miễn trừ không có lý do là một danh sách không
 * ai dám xoá dòng nào.
 */

const goc = path.resolve(__dirname, "..");

function tepKiemThu(): string[] {
  return readdirSync(path.join(goc, "tests"))
    .filter((t) => t.endsWith(".ts"))
    .map((t) => `tests/${t}`);
}

/** Bỏ chú thích trước khi quét: một đoạn GIẢI THÍCH về cái bẫy không phải là cái bẫy. */
function boChuThich(ma: string): string {
  return ma.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* ═════════════ 1 · KẾT THÚC DÒNG GHIM Ở TẦNG KHO ═════════════ */

export function testKetThucDongGhimLF() {
  /*
    Vế QUAN TRỌNG NHẤT của cả bài, vì nó sửa ở đúng tầng: khi cây làm việc luôn là LF thì mọi bài
    kiểm quét mã nguồn — kể cả bài viết ngày mai — đo cùng một chuỗi byte trên mọi máy. Không có
    tệp này thì `core.autocrlf` của từng máy quyết định kết quả bài kiểm.
  */
  const ga = readFileSync(path.join(goc, ".gitattributes"), "utf8");
  assert.match(
    ga,
    /^\*\s+text=auto\s+eol=lf\s*$/m,
    ".gitattributes phải ghim LF cho toàn kho, ở một dòng KHÔNG bị chú thích — thiếu nó thì bài kiểm quét mã nguồn đo core.autocrlf của từng máy",
  );
}

/* ═════════════ 2 · ĐƯỜNG DẪN SO SÁNH PHẢI ĐƯỢC CHUẨN HOÁ ═════════════ */

export function testDuongDanChuanHoa() {
  /*
    `path.relative()` trả dấu phân cách CỦA NỀN. Dùng thẳng kết quả ấy làm khoá tra cứu hay giá
    trị so sánh thì cùng một commit cho hai kết quả trên hai máy.
  */
  const pham: string[] = [];
  for (const tep of tepKiemThu()) {
    const ma = boChuThich(readFileSync(path.join(goc, tep), "utf8"));
    for (const dong of ma.split("\n")) {
      if (!/path\.relative\(/.test(dong)) continue;
      if (dong.includes("split(path.sep)")) continue;
      pham.push(`${tep}: ${dong.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    pham,
    [],
    "path.relative() phải kèm .split(path.sep).join(/) — nếu không, khoá so sánh khác nhau giữa Windows và Linux",
  );
}

/* ═════════════ 2b · KHÔNG SO BẰNG VỚI MỘT MỐC ĐỌC LẠI ĐỒNG HỒ ═════════════ */

export function testKhongSoBangMocDocLaiDongHo() {
  /*
    ĐÃ ĐỎ THẬT Ở CI (20/09/2026, run 35519181971) trong khi máy người viết xanh.

        const t = (phut: number) => new Date(Date.now() - phut * 60_000);
        …
        assert.equal(x.firstFailureAt?.getTime(), t(60).getTime());

    `t(60)` được gọi HAI lần — một lần dựng dữ liệu, một lần trong khẳng định — và `Date.now()`
    nhích giữa hai lần. Bài kiểm XANH khi cả hai rơi cùng một mili giây, ĐỎ khi không. CI chậm hơn
    nên nó rơi vào phía bên kia thường xuyên hơn.

    ─── LUẬT HẸP, KHÔNG PHẢI LUẬT RỘNG ───

    Kho này có hơn mười lăm tệp định nghĩa helper kiểu `(h) => new Date(Date.now() - h * …)`, và
    ĐA SỐ VÔ HẠI: chúng chỉ GIEO dữ liệu, mỗi mốc gọi đúng một lần. Cấm cả lớp ấy là một cuộc
    refactor lớn để đổi lấy rất ít.

    Chỗ THẬT SỰ cắn là khi cùng một helper vừa gieo vừa được so BẰNG CHÍNH XÁC. Bộ gác này chỉ hỏi
    đúng câu đó, nên nó gần như không kêu nhầm — và nó KHÔNG đụng tới những phép kiểm tất định kiểu
    `assert.equal(f(k, moc).getTime(), f(k, moc).getTime())`, nơi `moc` là một giá trị đã ghim.
  */
  const pham: string[] = [];
  for (const tep of tepKiemThu()) {
    const ma = boChuThich(readFileSync(path.join(goc, tep), "utf8"));
    const ten = [...ma.matchAll(/const\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*new Date\(Date\.now\(\)/g)].map((m) => m[1]);
    for (const n of ten) {
      const re = new RegExp(String.raw`assert\.(?:equal|deepEqual)\([^\n]*\b` + n + String.raw`\([^)]*\)\.getTime\(\)`, "g");
      for (const m of ma.matchAll(re)) pham.push(`${tep}: ${m[0].trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(
    pham,
    [],
    "so BẰNG với một mốc dựng từ `Date.now()` ĐỌC LẠI lúc khẳng định là một flake: ghim một mốc `BAY_GIO` rồi dẫn xuất mọi mốc từ nó (AGENTS.md mục 50 · 65)",
  );
}

/* ═════════════ 3 · KHÔNG RẼ NHÁNH KHẲNG ĐỊNH THEO MÔI TRƯỜNG ═════════════ */

/** Miễn trừ — mỗi dòng nói RÕ vì sao đọc môi trường ở đó là đo MÃ NGUỒN chứ không đo máy. */
const DOC_MOI_TRUONG_DA_KHAI: Record<string, string> = {
  "tests/sync-fixtures.test.ts":
    "Bộ chạy chính: ĐẶT biến môi trường để dựng tình huống cho hàm đang kiểm (ví dụ xoá ERP_GITHUB_REPO để kiểm nhánh CHƯA CẤU HÌNH), rồi trả lại nguyên trạng. Đó là ĐẦU VÀO của phép kiểm, không phải điều kiện của kết luận.",
  "tests/tech-phase2a.test.ts":
    "Kiểm chính githubConfig(), thứ SINH RA từ biến môi trường — nên đọc biến ở đây là đọc đầu vào của cái đang đo. Kỳ vọng dựng từ prDetailBudget(githubConfig().auth), KHÔNG gõ lại con số.",
  "tests/tech-pr-projection.test.ts":
    "Cùng lý do: trần request phụ thuộc chế độ xác thực, và bài dựng kỳ vọng từ chính hàm khai trần đó.",
  "tests/ops-concurrency.test.ts":
    "Truyền biến xuống tiến trình bash con để dựng tình huống khoá — đầu vào của kịch bản đang đo; và dùng process.platform để nói CHƯA ĐO ĐƯỢC, không để bỏ qua một khẳng định.",
  "tests/test-hygiene.test.ts": "Chính bài này.",
  "tests/ai-incident-watch.test.ts":
    "Ép AI_PROVIDER=anthropic để resolveProviderName() có câu trả lời xác định, rồi trả lại nguyên trạng trong finally. Đó là ĐẦU VÀO của bộ canh đang đo (nó hỏi nhà cung cấp nào đang dùng), không phải điều kiện của kết luận.",
  "tests/agent-dispatch.test.ts":
    "Đặt ERP_GITHUB_DISPATCH_TOKEN / ERP_GITHUB_REPO để dựng ba tình huống (chưa khai khoá · đã khai · khoá thiếu quyền), rồi trả lại nguyên trạng trong finally. Đó là ĐẦU VÀO của cổng cấu hình đang đo, không phải điều kiện của kết luận.",
  "tests/setup-env.ts":
    "Tệp dựng môi trường của bộ kiểm thử: nó GHI DATABASE_URL trỏ vào CSDL dùng-một-lần của chính tiến trình này. Đó là việc của nó.",

  /* ───── ĐẶT biến để DỰNG TÌNH HUỐNG, rồi trả lại nguyên trạng — đầu vào, không phải điều kiện của kết luận ───── */
  "tests/agent-identity.test.ts":
    "Chụp lại rồi xoá ba biến danh tính agent để kiểm nhánh CHƯA CẤU HÌNH, sau đó khôi phục từng khoá (kể cả khoá vốn không tồn tại). Không khẳng định nào rẽ theo giá trị sẵn có của máy.",
  "tests/ai-copilot.test.ts":
    "Đặt OPENAI_API_KEY giả và xoá AI_PROVIDER để kiểm cách chọn nhà cung cấp. Khoá là chuỗi bịa, không phải khoá thật của máy.",
  "tests/memo-inflight.test.ts":
    "Đặt MEMO_INFLIGHT_TIMEOUT_MS = 40ms để cửa sổ gộp lời gọi đo được trong một bài kiểm; giữ giá trị cũ và trả lại sau.",
  "tests/tech-cto-proposal.test.ts":
    "Đặt ADMIN_PASSWORD để dựng tài khoản quản trị của tình huống, rồi trả lại giá trị cũ.",

  /* ───── ĐỌC biến, nhưng đọc ĐÚNG NGUỒN mà mã sản xuất đọc ───── */
  "tests/session-renewal.test.ts":
    "Ký token kiểm thử bằng AUTH_SECRET đọc qua ĐÚNG fallback của lib/env.ts (dev-secret-… khi chưa đặt). Đó là dựng kỳ vọng TỪ CÙNG MỘT NGUỒN với mã đang đo — gõ lại một khoá khác mới là đo sai.",
  "tests/session-revocation.test.ts":
    "Cùng lý do với session-renewal; nhánh production trả chuỗi rỗng đúng như lib/env.ts, nên bài kiểm không bao giờ ký bằng một khoá mà mã sản xuất không dùng.",

  /* ───── KHÔNG đọc biến nào cả — chỉ TÌM chuỗi đó trong mã nguồn ───── */
  "tests/payroll-reconcile-script.test.ts":
    "`src.indexOf('process.env.ERP_READ_ONLY = \"1\"')` là quét MÃ NGUỒN để đòi script bật cờ chỉ-đọc, không phải đọc môi trường. Bộ gác không tách được chuỗi trong dấu nháy nên khai ở đây.",
};

export function testKhongReNhanhTheoMoiTruong() {
  const pham: string[] = [];
  for (const tep of tepKiemThu()) {
    const ma = boChuThich(readFileSync(path.join(goc, tep), "utf8"));
    if (!/process\.env|process\.platform/.test(ma)) continue;
    if (DOC_MOI_TRUONG_DA_KHAI[tep]) continue;
    pham.push(tep);
  }
  assert.deepEqual(
    pham,
    [],
    "bài kiểm đọc process.env / process.platform phải khai vào DOC_MOI_TRUONG_DA_KHAI kèm lý do vì sao đó là đo MÃ NGUỒN chứ không đo máy (AGENTS.md mục 65)",
  );
}

/* ═════════════ 4 · CI CHẠY CẢ HAI NHÁNH XÁC THỰC, BẰNG TOKEN GIẢ ═════════════ */

export function testCiChayHaiCheDo() {
  const gates = readFileSync(path.join(goc, ".github/workflows/gates.yml"), "utf8");
  assert.equal(
    gates.split("run: npm test").length - 1,
    2,
    "gates.yml phải chạy npm test HAI lần: một lượt ẩn danh, một lượt có token — nhánh TOKEN đổi hành vi thật (trần request 12 vs 3)",
  );

  /*
    Lượt thứ hai khai token NGAY TRONG workflow, không lấy từ `secrets.*`: kho PUBLIC, bộ kiểm thử
    không gọi mạng thật (adapter GitHub bị tiêm `fetch` giả), nên thứ duy nhất cần là một chuỗi
    khác rỗng để rẽ nhánh. Đưa token thật vào CI là đổi một lớp kiểm lấy một lượt rò rỉ.
  */
  const i2 = gates.indexOf("Kiểm thử lần hai");
  assert.ok(i2 > 0, "không tìm thấy bước kiểm thử lượt hai trong gates.yml");
  const khoi = gates.slice(i2, i2 + 400);
  assert.match(khoi, /GITHUB_TOKEN:\s*"/, "lượt hai phải đặt GITHUB_TOKEN thành một chuỗi ghi thẳng");
  assert.ok(!khoi.includes("secrets."), "lượt hai KHÔNG được lấy token từ secrets — token phải GIẢ");
  assert.match(
    khoi,
    /GIA|FAKE|KHONG_CO_THAT/i,
    "token giả phải NHÌN LÀ BIẾT GIẢ, để không ai tưởng nó thật rồi đi thay bằng token thật",
  );

  /*
    Job phải giữ nguyên TÊN. Ruleset của `main` bắt buộc đúng check `gates / gates`; biến job thành
    matrix làm tên check thành `gates / gates (che-do)`, check bắt buộc không bao giờ xuất hiện, và
    MỌI pull request bị chặn vĩnh viễn.
  */
  assert.ok(
    !/\n\s*strategy:\s*\n\s*matrix:/.test(gates),
    "KHÔNG biến job gates thành matrix — tên check bắt buộc `gates / gates` sẽ biến mất và chặn mọi PR",
  );
}

/* ═════════════ 5 · THIẾU CÔNG CỤ PHẢI NÓI RA, KHÔNG BỎ QUA IM LẶNG ═════════════ */

export function testThieuCongCuNoiThang() {
  /*
    Một bài kiểm cần công cụ chỉ có trên nền triển khai thì được phép KHÔNG đo trên nền khác —
    nhưng phải NÓI RA, và phải ĐỎ nếu công cụ ấy biến mất khỏi chính nền triển khai. `return` sớm
    mà thiếu một trong hai vế là bỏ qua im lặng: ngày CI mất `flock`, bài kiểm vẫn xanh.
  */
  const ma = readFileSync(path.join(goc, "tests/ops-concurrency.test.ts"), "utf8");
  const iVe = ma.indexOf("if (!coFlock())");
  assert.ok(iVe > 0, "bài khoá ops phải kiểm sự có mặt của flock trước khi chạy");
  const khoi = ma.slice(iVe, ma.indexOf("return;", iVe));
  assert.ok(khoi.includes("linux"), "thiếu flock TRÊN LINUX phải ĐỎ — đó là nơi kịch bản này thật sự chạy");
  assert.match(khoi, /CHƯA ĐO ĐƯỢC/, "trên nền khác phải in CHƯA ĐO ĐƯỢC — một câu trung thực, không phải một dấu ✓");
  assert.ok(!khoi.includes("✓"), "nhánh không đo được KHÔNG được in dấu ✓");
}

/* ═════════════ 6 · KHÔNG ĐỔI TÍNH CHẤT BẢO MẬT ĐỂ LẤY MÀU XANH ═════════════ */

export function testKhongDoiHangRaoLayMauXanh() {
  /*
    `spawn("npm.cmd", { shell: false })` ném EINVAL trên Windows (Node chặn .cmd từ bản vá
    CVE-2024-27980). Lối thoát "dễ" là bật `shell: true` — và nó biến các ký tự nối lệnh từ chỗ
    KHÔNG BIỂU DIỄN ĐƯỢC ý nghĩa nào thành cú pháp thật. Đổi nhầm chiều.
  */
  /*
    QUÉT TRÊN MÃ ĐÃ BỎ CHÚ THÍCH.

    Bản đầu quét thẳng tệp và lập tức kêu nhầm chính khối chú thích GIẢI THÍCH vì sao không được
    bật `shell: true` — cùng cái bẫy mà `boChuThich` sinh ra để tránh. Một bộ gác kêu nhầm là một
    bộ gác người ta tắt đi.
  */
  const ws = boChuThich(readFileSync(path.join(goc, "lib/agents/workspace.ts"), "utf8"));
  assert.ok(ws.includes("shell: false"), "tiến trình con của agent phải chạy KHÔNG qua shell");
  assert.ok(
    !/shell:\s*true/.test(ws),
    "KHÔNG BAO GIỜ bật shell trong đường chạy agent — kể cả để một bài kiểm xanh trên máy lập trình viên",
  );
  assert.ok(
    !ws.includes("npm.cmd"),
    "không gọi bọc .cmd (EINVAL); gọi npm-cli.js bằng process.execPath để giữ shell: false",
  );
}

export function testTestHygiene() {
  testKetThucDongGhimLF();
  testDuongDanChuanHoa();
  testKhongSoBangMocDocLaiDongHo();
  testKhongReNhanhTheoMoiTruong();
  testCiChayHaiCheDo();
  testThieuCongCuNoiThang();
  testKhongDoiHangRaoLayMauXanh();
  console.log(
    "✓ Vệ sinh bài kiểm (mục 65): LF ghim ở tầng kho · đường dẫn chuẩn hoá · không so BẰNG với mốc đọc lại đồng hồ · mọi bài đọc môi trường đều có lý do · CI chạy 2 chế độ bằng token GIẢ · thiếu công cụ thì nói CHƯA ĐO ĐƯỢC chứ không ✓ · hàng rào agent không bị đổi để lấy màu xanh",
  );
}
