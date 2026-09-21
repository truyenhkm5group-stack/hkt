import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sep } from "node:path";
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  clampColumnWidth,
  parseStoredWidths,
  resizedWidths,
  tableConfigKey,
  wrapModeFor,
} from "@/lib/table/column-resize";

/**
 * ═══════ KÉO RỘNG CỘT: THU HẸP LÀ XUỐNG DÒNG, KHÔNG BAO GIỜ LÀ CẮT CHỮ ═══════
 *
 * Toàn bộ tính năng đứng trên một lời hứa: kéo cột hẹp lại thì nội dung DỒN XUỐNG DÒNG chứ không
 * mất đi. Lời hứa ấy được giữ bằng hai thứ, và bài kiểm này khoá cả hai:
 *
 *   1. BỀ RỘNG ĐẶT Ở `<col>`, bảng giữ `table-layout: auto` ⇒ trình duyệt lấy
 *      `max(bề rộng khai, min-content)` và KHÔNG BAO GIỜ thu cột xuống dưới nội dung.
 *      Đổi sang `table-layout: fixed` là lật ngược điều đó: bề rộng khai thắng, chữ bị cắt thật.
 *   2. LUẬT XUỐNG DÒNG cho `min-content` một giá trị hợp lý — số thì không gãy, chữ thì gãy ở
 *      khoảng trắng chứ không gãy giữa từ.
 */
/**
 * Mọi tệp `.tsx` dưới một thư mục, kèm đường dẫn ĐÃ CHUẨN HOÁ dấu phân cách.
 *
 * `path.sep` là `\` trên Windows và `/` trên Linux; một thông điệp lỗi mang dấu này còn dùng
 * được, nhưng một KHOÁ TRA CỨU thì không — đó là lớp lỗi "xanh ở đây, đỏ ở CI" mà AGENTS.md §65
 * đã liệt kê. Chuẩn hoá ngay tại chỗ đọc để không nơi nào phải nhớ.
 */
function docTatCaTsx(goc: URL): [string, string][] {
  const ra: [string, string][] = [];
  const di = (thuMuc: URL, tien: string) => {
    for (const muc of readdirSync(thuMuc, { withFileTypes: true })) {
      if (muc.name === "node_modules" || muc.name.startsWith(".")) continue;
      const duong = tien ? `${tien}/${muc.name}` : muc.name;
      if (muc.isDirectory()) di(new URL(`${muc.name}/`, thuMuc), duong);
      else if (muc.name.endsWith(".tsx")) ra.push([duong.split(sep).join("/"), readFileSync(new URL(muc.name, thuMuc), "utf8").replace(/\r/g, "")]);
    }
  };
  di(goc, "");
  return ra;
}

export function testColumnResize() {
  // ───────── KẸP BỀ RỘNG: CHƯA BIẾT KHÔNG ĐƯỢC HOÁ THÀNH MỘT CON SỐ (§42) ─────────
  assert.equal(clampColumnWidth(200), 200);
  assert.equal(clampColumnWidth(10), MIN_COLUMN_WIDTH, "kéo quá hẹp thì dừng ở sàn, không về 0");
  assert.equal(clampColumnWidth(99_999), MAX_COLUMN_WIDTH, "kéo quá rộng thì dừng ở trần");
  assert.equal(clampColumnWidth(123.6), 124, "bề rộng là số nguyên px");
  for (const xau of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(clampColumnWidth(xau), null, `${String(xau)} là dấu vết của một phép tính hỏng, không phải một bề rộng`);
  }

  // ───────── KÉO MỘT CỘT CHỈ ĐỔI ĐÚNG CỘT ĐÓ ─────────
  const nen = [120, 200, 90, 300];
  const sau = resizedWidths(nen, 1, -60);
  assert.equal(sau[1], 140, "cột đang kéo đổi đúng bằng khoảng chuột đã đi");
  assert.deepEqual([sau[0], sau[2], sau[3]], [120, 90, 300], "ba cột còn lại KHÔNG được nhúc nhích");
  assert.deepEqual(resizedWidths(nen, 9, 50), nen.map((w) => w), "chỉ số ngoài bảng là một lượt không làm gì");
  // ỔN ĐỊNH: cùng nền + cùng khoảng ⇒ cùng kết quả. Kéo qua kéo lại không được trôi.
  assert.deepEqual(resizedWidths(nen, 1, -60), sau, "hàm thuần: chạy hai lần ra cùng một kết quả");
  assert.deepEqual(resizedWidths(nen, 0, -1000), [MIN_COLUMN_WIDTH, 200, 90, 300], "kéo mạnh tay vẫn dừng ở sàn");

  /*
    ───────── LUẬT XUỐNG DÒNG ─────────

    ĐÂY LÀ CHỖ ĐÃ SAI MỘT LẦN, VÀ SAI THEO KIỂU IM LẶNG. Bản đầu coi `whitespace-nowrap` là lời
    khai "ô này không được xuống dòng". Nhưng `components/ui/table.tsx` đặt lớp ấy MẶC ĐỊNH cho
    MỌI `<th>` và `<td>` của ERP — nên mọi ô đều rơi vào nhánh "nowrap", không cột nào hẹp lại
    được, và cả tính năng chỉ còn nới rộng được. Bảng vẫn chạy, không lỗi, chỉ là vô dụng.
  */
  assert.equal(
    wrapModeFor({ className: "px-2.5 py-2 whitespace-nowrap", containsNumeric: false }),
    "wrap",
    "`whitespace-nowrap` là MẶC ĐỊNH của mọi ô, không phải ý định của ô này — đọc nó thành ý định làm cả tính năng thành vô dụng",
  );
  assert.equal(wrapModeFor({ className: "numeric text-right", containsNumeric: false }), "nowrap", "ô số không bao giờ xuống dòng");
  assert.equal(
    wrapModeFor({ className: "text-right", containsNumeric: true }),
    "nowrap",
    "ô chứa <Money> (nó luôn phát lớp `numeric`) cũng là ô số",
  );
  assert.equal(wrapModeFor({ className: "font-medium", containsNumeric: false }), "wrap", "ô chữ xuống dòng được");
  assert.equal(wrapModeFor({ className: "numeric-ish", containsNumeric: false }), "wrap", "khớp nguyên từ, không khớp tiền tố");

  // ───────── KHOÁ LƯU: ĐỔI CỘT THÌ CẤU HÌNH CŨ KHÔNG ĐƯỢC ÁP NHẦM ─────────
  const a = tableConfigKey("erp.colw", "/reports", "t1", ["Mã hàng", "Đơn", "Doanh số"]);
  assert.equal(a, tableConfigKey("erp.colw", "/reports", "t1", ["Mã hàng", "Đơn", "Doanh số"]), "cùng bảng ⇒ cùng khoá");
  assert.notEqual(
    a,
    tableConfigKey("erp.colw", "/reports", "t1", ["Mã hàng", "Đơn", "Vận chuyển", "Doanh số"]),
    "chen thêm một cột ⇒ khoá đổi, để bề rộng của 'Doanh số' không bị áp cho 'Vận chuyển'",
  );
  assert.notEqual(a, tableConfigKey("erp.colw", "/reports", "t1", ["Đơn", "Mã hàng", "Doanh số"]), "đổi thứ tự cột ⇒ khoá đổi");
  assert.notEqual(a, tableConfigKey("erp.cols", "/reports", "t1", ["Mã hàng", "Đơn", "Doanh số"]), "bề rộng và ẩn/hiện là hai cấu hình, hai khoá");
  assert.equal(
    tableConfigKey("erp.colw", "/orders/0a9f3b21c4d5e6f70819", "t1", ["A"]),
    tableConfigKey("erp.colw", "/orders/ffffffffffffffffffff", "t1", ["A"]),
    "mã định danh trong đường dẫn được gộp lại: mọi đơn hàng dùng chung một cấu hình bảng",
  );

  // ───────── ĐỌC CẤU HÌNH ĐÃ LƯU: HỎNG THÌ VỀ MẶC ĐỊNH, KHÔNG NÉM LỖI LÊN MÀN HÌNH ─────────
  assert.deepEqual(parseStoredWidths(null, 4), {});
  assert.deepEqual(parseStoredWidths("{ không phải json", 4), {});
  assert.deepEqual(parseStoredWidths("[1,2,3]", 4), {}, "mảng không phải bản đồ cột → bề rộng");
  assert.deepEqual(parseStoredWidths('{"1":200}', 4), { 1: 200 });
  assert.deepEqual(parseStoredWidths('{"9":200}', 4), {}, "cột đã biến mất khỏi bảng thì bỏ qua, không dựng lại");
  assert.deepEqual(parseStoredWidths('{"0":5}', 4), { 0: MIN_COLUMN_WIDTH }, "giá trị cũ ngoài khoảng vẫn được kẹp về khoảng dùng được");
  assert.deepEqual(parseStoredWidths('{"0":"rộng"}', 4), {}, "giá trị không phải số bị bỏ, không hoá thành 0");

  // ───────── KHOÁ Ở MỨC MÃ NGUỒN: KHÔNG ĐƯỢC GIẤU NỘI DUNG ĐI ─────────
  //
  // Bốn cách "cho gọn" đều làm chữ biến mất mà người đọc không có cách nào biết mình đang thiếu
  // gì. Một bảng giấu nội dung tệ hơn một bảng phải cuộn ngang.
  //
  // Quét MÃ, không quét VĂN XUÔI: chính tệp ấy giải thích vì sao KHÔNG dùng `table-layout: fixed`,
  // nên một phép quét cả tệp sẽ bắt đúng câu giải thích và báo đỏ. Bỏ chú thích trước khi quét —
  // cùng bài học với `tests/nominal-table-display.test.ts`, chỉ khác chỗ vấp.
  const raw = readFileSync(new URL("../components/data-table/column-resize.tsx", import.meta.url), "utf8").replace(/\r/g, "");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  assert.ok(src.length > 1000 && src.length < raw.length, "phép bỏ chú thích phải bỏ được thứ gì đó mà vẫn còn mã để quét");
  for (const [mau, vi] of [
    [/table-?[Ll]ayout/, "`table-layout: fixed` làm bề rộng khai THẮNG nội dung — chữ bị cắt thật"],
    [/text-?[Oo]verflow|truncate/, "`text-overflow`/`truncate` là cắt chữ rồi chấm lửng"],
    [/line-?clamp/, "`line-clamp` cắt bớt số dòng"],
    [/overflow:\s*hidden|overflow-hidden/, "`overflow: hidden` cắt phần tràn ra"],
    [/overflow-?[Ww]rap:\s*"?anywhere/, "`anywhere` kéo `min-content` xuống một ký tự — cột thu được tới mức chữ thành một sợi dọc"],
  ] as const) {
    assert.ok(!mau.test(src), `components/data-table/column-resize.tsx: ${vi}`);
  }
  assert.ok(src.includes('overflowWrap = "break-word"'), "ô chữ phải gãy ở khoảng trắng bằng `break-word` — nó KHÔNG làm giảm min-content nên từ dài nhất vẫn nguyên vẹn");
  assert.ok(src.includes("ensureColGroup"), "bề rộng phải đặt ở `<col>`, không đặt lên từng ô");

  // ───────── BẢNG THÔ: THANH CÔNG CỤ PHẢI TRỎ VÀO MỘT BẢNG CÓ THẬT ─────────
  //
  // `<TableToolsFor tableId="x" />` tìm bảng bằng `document.getElementById`. Gõ sai một chữ, hay
  // đổi `id` của bảng mà quên đổi ở đây, thì thanh công cụ LẶNG LẼ không hiện — không lỗi, không
  // cảnh báo, chỉ là một tính năng biến mất ở đúng trang đó. Ghép cặp ở mức mã nguồn thay vì đợi
  // ai đó mở trang ra và nhận ra mình thiếu cái gì.
  const goc = new URL("../app/", import.meta.url);
  const tep = docTatCaTsx(goc);
  let soCap = 0;
  for (const [duongDan, noiDung] of tep) {
    const dungCu = [...noiDung.matchAll(/<TableToolsFor\s+tableId="([^"]+)"/g)].map((m) => m[1]);
    if (!dungCu.length) continue;
    const bang = new Set([...noiDung.matchAll(/<table\s+id="([^"]+)"/g)].map((m) => m[1]));
    for (const id of dungCu) {
      assert.ok(bang.has(id), `${duongDan}: <TableToolsFor tableId="${id}"> không có <table id="${id}"> nào trong cùng tệp`);
      soCap += 1;
    }
    // Hai bảng cùng `id` trong một trang thì `getElementById` chỉ thấy cái đầu.
    const trung = [...noiDung.matchAll(/<table\s+id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(trung).size, trung.length, `${duongDan}: có hai <table> trùng id`);
  }
  assert.ok(soCap >= 7, `phải có ít nhất 7 bảng thô đã gắn thanh công cụ, đang thấy ${soCap}`);

  console.log(
    `✓ Kéo rộng cột: sàn ${MIN_COLUMN_WIDTH}px / trần ${MAX_COLUMN_WIDTH}px · chưa biết ⇒ null · số không gãy, chữ gãy ở khoảng trắng · không cắt chữ ở bất kỳ đâu · đổi cột thì cấu hình cũ không áp nhầm · ${soCap} bảng thô gắn đúng bảng có thật`,
  );
}

if (process.argv[1] && /column-resize\.test\.ts$/.test(process.argv[1])) {
  testColumnResize();
}
