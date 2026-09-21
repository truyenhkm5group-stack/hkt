import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DOC_NGAN_SACH, catTepChoVua } from "@/lib/constants/agent-read-budget";
import { AGENT_TOOLS } from "@/lib/agents/executor";

/**
 * ═══════════ NGÂN SÁCH ĐỌC TỆP — VÀ TIỀN KHÔNG ĐƯỢC BIẾN MẤT KHI LỜI GỌI HỎNG ═══════════
 *
 * ĐÃ CẮN THẬT, lượt chạy agent #22 — lần đầu vai QA chạy được:
 *
 *     ✗ FAILED
 *       lý do: 400 prompt is too long: 205.844 tokens > 200.000 maximum
 *       tiền: chưa gọi model lần nào.
 *
 * Hai lỗi trong bốn dòng ấy, và lỗi thứ hai nguy hiểm hơn lỗi thứ nhất:
 *
 *  1. `read_file` trả về NGUYÊN tệp, không trần. `run_command` thì đã cắt còn 4.000 ký tự cuối
 *     từ lâu — người viết trần ấy nghĩ tới một chiều và bỏ sót chiều kia. Vai DOCUMENTATION không
 *     bao giờ chạm tới (docs/ toàn tệp nhỏ); vai QA thì BẮT BUỘC đọc những tệp lớn nhất kho.
 *
 *  2. **"tiền: chưa gọi model lần nào" là một câu SAI.** Lượt đầu tiên chỉ có đề bài, không thể
 *     dài 205.844 token — nên model ĐÃ được gọi nhiều vòng và tiền ĐÃ tiêu. Ngoại lệ 400 ném
 *     thẳng ra ngoài vòng lặp và cuốn theo cả phép đo. Một bản báo cáo nói "chưa từng xảy ra" về
 *     thứ đã xảy ra thì còn tệ hơn một bản báo cáo nói "chưa biết".
 */

const goc = path.resolve(__dirname, "..");

export function testNganSachDocTep() {
  /* ───────── TỆP NHỎ ĐI QUA NGUYÊN VẸN ───────── */
  const nho = "x".repeat(1000);
  const a = catTepChoVua({ noiDung: nho, daDung: 0 });
  assert.ok(a.ok && !a.daCat, "tệp nhỏ không bị cắt");
  assert.ok(a.ok && a.noiDung === nho, "và về nguyên vẹn, không thêm bớt một ký tự");
  assert.ok(a.ok && a.daDungSau === 1000, "ngân sách trừ đúng số ký tự đã dùng");

  /* ───────── TỆP LỚN: GIỮ ĐẦU **VÀ** ĐUÔI ─────────
     Hình dạng tệp trong kho này: `import` ở đầu, danh sách đăng ký / lời gọi thật ở cuối. Cắt mỗi
     phần đầu thì agent thấy hết import mà không thấy chỗ phải thêm dòng của mình. */
  const dau = "DAU_TEP_IMPORT";
  const duoi = "CUOI_TEP_DANG_KY";
  const to = dau + "y".repeat(500_000) + duoi;
  const b = catTepChoVua({ noiDung: to, daDung: 0 });
  assert.ok(b.ok && b.daCat, "tệp lớn phải bị cắt");
  assert.ok(b.ok && b.noiDung.startsWith(dau), "phải giữ ĐẦU tệp");
  assert.ok(b.ok && b.noiDung.endsWith(duoi), "phải giữ ĐUÔI tệp");

  /*
    ───────── CẮT THÌ PHẢI NÓI LÀ ĐÃ CẮT ─────────

    Cắt im lặng còn tệ hơn lỗi 400: agent đọc nửa tệp mà TƯỞNG mình đọc cả tệp, rồi kết luận về
    phần nó chưa từng thấy — và kết luận ấy trông hợp lý y như thật.
  */
  assert.match(b.ok ? b.noiDung : "", /TỆP BỊ CẮT/, "phải có dấu cắt tường minh");
  assert.match(b.ok ? b.noiDung : "", /không có mặt/, "và nói rõ phần giữa KHÔNG có mặt");
  assert.ok(b.ok && b.noiDung.length <= DOC_NGAN_SACH.moiLan + 500, "phần đưa vào phải nằm trong trần một lần đọc (cộng câu ghi chú)");

  /* ───────── HẾT NGÂN SÁCH THÌ TỪ CHỐI, KHÔNG TRẢ CHUỖI RỖNG ─────────
     Trả rỗng thì agent tưởng tệp rỗng và đi tiếp; nó phải biết mình đang bị chặn vì lý do gì. */
  const het = catTepChoVua({ noiDung: "abc", daDung: DOC_NGAN_SACH.caLuot });
  assert.ok(!het.ok && het.ma === "HET_NGAN_SACH", "hết ngân sách ⇒ từ chối");
  assert.match(het.ok ? "" : het.ly, /finish|không đọc thêm/i, "và nói rõ phải làm gì tiếp");

  /* Sát trần: lần đọc cuối chỉ được lấy phần còn lại, không được vượt. */
  const sat = catTepChoVua({ noiDung: "z".repeat(100_000), daDung: DOC_NGAN_SACH.caLuot - 1_000 });
  assert.ok(sat.ok && sat.daDungSau <= DOC_NGAN_SACH.caLuot, "không lượt đọc nào được vượt trần cả lượt");

  /* ───────── TRẦN PHẢI ĐỦ NHỎ SO VỚI CỬA SỔ THẬT ─────────
     Cửa sổ 200.000 token ≈ 800.000 ký tự. Ngân sách phải chừa chỗ cho đề bài, kết quả lệnh và
     phần model tự viết — chứ không dùng hết. */
  assert.ok(DOC_NGAN_SACH.caLuot <= 400_000, "ngân sách đọc phải chừa chỗ cho phần còn lại của hội thoại");
  assert.ok(DOC_NGAN_SACH.moiLan < DOC_NGAN_SACH.caLuot, "trần một lần phải nhỏ hơn trần cả lượt");

  /*
    ───────── VÀ TRẦN PHẢI NHỎ HƠN TỆP LỚN NHẤT KHO ─────────

    Đây là vế giữ cho con số không cũ đi: ngày nào `tests/sync-fixtures.test.ts` vẫn lớn hơn trần
    một lần đọc thì luật này còn cần thiết. Đo từ ĐĨA, không gõ lại con số.
  */
  const boChay = statSync(path.join(goc, "tests/sync-fixtures.test.ts")).size;
  assert.ok(boChay > DOC_NGAN_SACH.moiLan, `bộ chạy chính (${boChay} ký tự) phải lớn hơn trần một lần đọc — nếu không, bài kiểm này đang đo một tình huống không còn tồn tại`);

  /* Agent phải ĐƯỢC BÁO có trần, nếu không nó sẽ đọc hết kho rồi mới biết. */
  const doc = AGENT_TOOLS.find((t) => t.name === "read_file");
  assert.ok(doc, "phải có công cụ read_file");
  assert.match(doc!.description ?? "", /ĐẦU \+ CUỐI|cắt|tổng/i, "mô tả công cụ phải nói rõ có trần đọc");

  console.log("✓ Ngân sách đọc tệp: tệp nhỏ nguyên vẹn · tệp lớn giữ ĐẦU+ĐUÔI kèm dấu cắt tường minh · hết ngân sách thì TỪ CHỐI chứ không trả rỗng · trần đo từ tệp lớn nhất kho");
}

/* ═════════════ LỜI GỌI MODEL HỎNG: TIỀN VẪN PHẢI CÒN ═════════════ */

export function testLoiGoiHongVanGiuTien() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const ex = bo(readFileSync(path.join(goc, "lib/agents/executor.ts"), "utf8"));

  /*
    Lời gọi model phải nằm trong `try`, và nhánh `catch` phải TRẢ VỀ kèm `chotChiPhi()` — không
    được ném tiếp. Ném tiếp là đúng thứ đã xoá sạch phép đo tiền ở lượt #22.
  */
  const i = ex.indexOf("this.provider.complete(");
  assert.ok(i > 0, "phải có lời gọi model");
  const truoc = ex.slice(Math.max(0, i - 400), i);
  assert.match(truoc, /try\s*\{/, "lời gọi model phải nằm trong try");

  const sau = ex.slice(i, i + 700);
  assert.match(sau, /catch/, "phải có nhánh catch cho lời gọi model");
  assert.match(sau, /chiPhi:\s*chotChiPhi\(\)/, "nhánh lỗi phải trả về phép đo tiền đã cộng được — không được để ngoại lệ cuốn nó đi");
  assert.ok(!/catch\s*\([^)]*\)\s*\{\s*throw/.test(sau), "KHÔNG được ném tiếp: lượt #22 mất sạch số tiền đã tiêu vì đúng nước đi đó");

  /* Và `read_file` phải đi qua ngân sách, không đổ thẳng nội dung tệp vào hội thoại. */
  const j = ex.indexOf('call.name === "read_file"');
  assert.ok(j > 0, "phải có nhánh read_file");
  const khoi = ex.slice(j, j + 1200);
  assert.match(khoi, /catTepChoVua\(/, "read_file phải đi qua ngân sách");
  assert.ok(!/content:\s*r\.ok\s*\?\s*r\.content/.test(khoi), "KHÔNG được đổ nguyên nội dung tệp vào hội thoại");

  console.log("✓ Lời gọi model hỏng: có try/catch, trả về kèm phép đo tiền, không ném tiếp · read_file đi qua ngân sách");
}
