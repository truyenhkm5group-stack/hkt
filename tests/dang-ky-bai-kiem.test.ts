import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { KHE_DANG_KY_AGENT, SO_BAI_AGENT_TOI_THIEU } from "@/lib/constants/agent-test-registry";
import { NEVER_WRITE } from "@/lib/constants/agent-scopes";
import { dungPromptHeThong } from "@/lib/constants/agent-system-prompt";

/**
 * ═══════════ BÀI KIỂM KHÔNG ĐƯỢC ĐĂNG KÝ THÌ KHÔNG BAO GIỜ CHẠY ═══════════
 *
 * Kho này không tự tìm tệp kiểm thử: mỗi bài phải được `import` và GỌI, cuối cùng đều quy về
 * `tests/sync-fixtures.test.ts`. Cách ấy đúng — nó làm thứ tự chạy và việc dọn dữ liệu đọc được ở
 * một chỗ — nhưng nó để lại một cái bẫy IM LẶNG: một tệp `*.test.ts` không ai gọi vẫn nằm trong
 * kho, vẫn được `typecheck` và `lint` soi, vẫn trông y như một bài kiểm đang bảo vệ điều gì đó.
 *
 * Nó chỉ không chạy.
 *
 * Hôm nay kho sạch — đo 22/09/2026: **202 tệp, 0 mồ côi** — nên luật này không làm đỏ gì. Nó dựng
 * ở đây vì hai lý do đã có số đo, không phải vì lo xa:
 *
 *  · Cùng buổi hôm qua, HAI bộ gác lộ ra là chưa từng chạy được một lần nào (một byte BACKSPACE
 *    lọt vào biểu thức chính quy). Một bài kiểm không chạy trông giống hệt một bài kiểm đang chạy.
 *  · Lượt chạy agent #23: vai QA viết xong một bài kiểm nhưng KHÔNG đăng ký được (bộ chạy chính
 *    nằm trong `NEVER_WRITE`). Nếu ai đó sửa giúp nó lỗi kiểu dữ liệu, cả bốn cổng sẽ XANH — và
 *    PR ấy mang một bài kiểm chưa từng chạy một lần nào.
 */

const goc = path.resolve(__dirname, "..");

/** Các tệp `*.test.ts` mà tệp này `import` — chỉ tính import nội bộ trong `tests/`. */
function phuThuoc(ten: string, tatCa: string[]): string[] {
  const src = readFileSync(path.join(goc, "tests", ten), "utf8");
  const ra = [...src.matchAll(/from\s+"\.\/([A-Za-z0-9._-]+?)(?:\.test)?"/g)]
    .map((m) => `${m[1]}.test.ts`)
    .filter((x) => tatCa.includes(x));
  return [...new Set(ra)];
}

export function testKhongCoBaiKiemMoCoi() {
  const tatCa = readdirSync(path.join(goc, "tests")).filter((f) => f.endsWith(".test.ts"));
  const goc0 = "sync-fixtures.test.ts";
  assert.ok(tatCa.includes(goc0), "phải có bộ chạy chính");

  /* Lan từ bộ chạy chính ra: tệp nào KHÔNG tới được là tệp không ai gọi. */
  const toiDuoc = new Set([goc0]);
  const hangDoi = [goc0];
  while (hangDoi.length) {
    const cur = hangDoi.pop()!;
    for (const d of phuThuoc(cur, tatCa)) {
      if (!toiDuoc.has(d)) {
        toiDuoc.add(d);
        hangDoi.push(d);
      }
    }
  }

  const moCoi = tatCa.filter((f) => !toiDuoc.has(f)).sort();
  assert.deepEqual(
    moCoi,
    [],
    `tệp kiểm thử KHÔNG ai gọi — nó nằm trong kho, được typecheck và lint soi, trông y như một bài kiểm đang bảo vệ điều gì đó, và nó không chạy: ${moCoi.join(", ")}`,
  );

  console.log(`✓ Không có bài kiểm mồ côi: ${tatCa.length} tệp, tất cả đều với tới được từ bộ chạy chính`);
}

/* ═════════════ KHE ĐĂNG KÝ CỦA AGENT ═════════════ */

export function testKheDangKyAgent() {
  const khe = readFileSync(path.join(goc, KHE_DANG_KY_AGENT), "utf8");
  const boChay = readFileSync(path.join(goc, "tests/sync-fixtures.test.ts"), "utf8");

  /*
    ───────── KHE PHẢI ĐƯỢC BỘ CHẠY CHÍNH GỌI ─────────
    Một khe không ai gọi thì mọi bài kiểm đăng ký vào đó đều im lặng — đúng cái bẫy mà luật mồ côi
    bên trên dựng ra để chặn, chỉ khác là nó ẩn sâu hơn một tầng.
  */
  /*
    KHỚP ĐÚNG LỜI GỌI, KHÔNG KHỚP DÒNG `import`.

    Bản đầu của khẳng định này tìm mỗi cái TÊN — và tên ấy có mặt ở dòng `import` nữa. Đột biến
    "xoá lời gọi, giữ import" SỐNG SÓT: khe không ai chạy mà bộ gác vẫn xanh. Cùng cái bẫy đã cắn
    ba lần trước trong kho này — một khẳng định khớp nhầm chỗ là một khẳng định không đo gì.
  */
  assert.match(boChay, /await\s+chayBaiKiemAgentTuDangKy\s*\(/, "bộ chạy chính phải GỌI khe đăng ký của agent, không chỉ import nó");
  assert.match(boChay, /from "\.\/agent-tu-dang-ky\.test"/, "và phải import đúng tệp khe");

  /*
    ───────── BỘ CHẠY CHÍNH VẪN KHOÁ, KHE THÌ MỞ ─────────
    Đây là toàn bộ ý nghĩa của cách chia này. Mất một trong hai vế là mất luôn lý do tồn tại của nó.
  */
  assert.ok(NEVER_WRITE.includes("tests/sync-fixtures.test.ts"), "bộ chạy chính PHẢI vẫn nằm trong NEVER_WRITE");
  assert.ok(!NEVER_WRITE.includes(KHE_DANG_KY_AGENT), "khe đăng ký KHÔNG được nằm trong NEVER_WRITE — nếu không, agent lại tắc như lượt #23");
  assert.ok(
    NEVER_WRITE.includes("lib/constants/agent-test-registry.ts"),
    "sàn phải nằm ngoài tầm với của agent — hạ được sàn thì bánh cóc không còn là bánh cóc",
  );

  /*
    ───────── BÁNH CÓC: SỐ BÀI ĐÃ ĐĂNG KÝ KHÔNG ĐƯỢC GIẢM ─────────
    Sàn chứ không phải số khớp chính xác: khớp chính xác thì THÊM một bài cũng đỏ, và luật sẽ bị
    tắt ngay lần dùng đầu tiên.
  */
  const than = khe.slice(khe.indexOf("export async function chayBaiKiemAgentTuDangKy"));
  const soGoi = [...than.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/await\s+[A-Za-z0-9_]+\s*\(/g)].length;
  assert.ok(
    soGoi >= SO_BAI_AGENT_TOI_THIEU,
    `khe đăng ký đang có ${soGoi} lời gọi, thấp hơn sàn ${SO_BAI_AGENT_TOI_THIEU} — một dòng đăng ký vừa bị xoá, và bài kiểm ấy nay im lặng`,
  );

  /*
    ───────── KHE CHỈ ĐỂ ĐĂNG KÝ, KHÔNG ĐỂ CHỨA LOGIC ─────────
    Mọi hàm được gọi ở đây phải tới từ một tệp `./*.test`. Không có luật này thì khe trở thành một
    chỗ để đặt mã không ai soi, ngay giữa thư mục kiểm thử.
  */
  const nhap = new Set([...khe.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/[A-Za-z0-9._-]+\.test"/g)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean)));
  const goi = [...than.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/await\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]);
  const la = goi.filter((g) => !nhap.has(g));
  assert.deepEqual(la, [], `khe đăng ký chỉ được gọi hàm import từ một tệp .test — thấy: ${la.join(", ")}`);

  console.log(`✓ Khe đăng ký agent: bộ chạy chính gọi đúng khe · bộ chạy chính vẫn khoá · sàn ngoài tầm agent · ${soGoi} bài đã đăng ký (sàn ${SO_BAI_AGENT_TOI_THIEU})`);
}

/* ═════════════ PROMPT HỆ THỐNG ĐI THEO VAI ═════════════ */

/**
 * Lần thứ TƯ cùng một lớp lỗi trong đúng một dây chuyền — nên lần này khoá ở mức mã nguồn.
 *
 *     trước #13   đề bài giấu NHÁNH và COMMIT NỀN
 *     #17         đề bài giấu PHẠM VI ĐỌC
 *     #21         workflow ghi cứng VAI và mẫu tên nhánh
 *     #23         prompt hệ thống ghi cứng NGHỀ
 *
 * Ở lượt #23, việc giao cho vai QA là viết một bài kiểm trong `tests/`, còn câu đầu tiên agent đọc
 * là *"Bạn là agent TÀI LIỆU… chỉ viết và sửa tài liệu trong thư mục docs/. Bạn KHÔNG sửa mã
 * nguồn."* Nó vẫn làm được việc — bằng cách làm TRÁI câu lệnh đầu tiên của chính mình.
 */
export function testPromptTheoVai() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const ex = bo(readFileSync(path.join(goc, "lib/agents/executor.ts"), "utf8"));

  assert.ok(!/const SYSTEM\s*=/.test(ex), "KHÔNG được có một prompt hệ thống CỐ ĐỊNH dùng chung cho mọi vai");
  assert.match(ex, /dungPromptHeThong\(job\.role\)/, "prompt phải dựng từ VAI của lượt chạy");

  /* Phạm vi ghi trong prompt phải lấy từ SỔ VAI, không gõ lại — nếu không, hai nơi sẽ nói hai điều. */
  const pr = bo(readFileSync(path.join(goc, "lib/constants/agent-system-prompt.ts"), "utf8"));
  assert.match(pr, /writeGlobsForRole\(/, "phạm vi ghi trong prompt phải đọc từ sổ vai");

  /* Vai QA phải được chỉ đúng chỗ đăng ký, nếu không nó lại tắc như lượt #23. */
  const qa = dungPromptHeThong("QA");
  assert.match(qa, /KIỂM THỬ/, "vai QA phải được giới thiệu đúng nghề");
  assert.ok(qa.includes(KHE_DANG_KY_AGENT), "prompt của vai QA phải chỉ rõ khe đăng ký");
  assert.match(qa, /tests\//, "và nói đúng phạm vi ghi của nó");
  assert.ok(!qa.includes("agent TÀI LIỆU"), "vai QA KHÔNG được giới thiệu là agent tài liệu");

  const doc = dungPromptHeThong("DOCUMENTATION");
  assert.match(doc, /TÀI LIỆU/, "vai tài liệu vẫn phải được giới thiệu đúng nghề của nó");
  assert.ok(!doc.includes(KHE_DANG_KY_AGENT), "vai tài liệu không cần biết khe đăng ký bài kiểm");

  /* Vai lạ rơi về đoạn MẶC ĐỊNH — không rơi vào nghề của một vai cụ thể. */
  const la = dungPromptHeThong("VAI_CHUA_CO");
  assert.ok(!la.includes("TÀI LIỆU") && !la.includes("KIỂM THỬ"), "vai lạ KHÔNG được nhận nghề của vai khác");

  console.log("✓ Prompt hệ thống theo vai: không còn chuỗi cố định · phạm vi ghi đọc từ sổ vai · QA được chỉ khe đăng ký · vai lạ rơi về mặc định");
}
