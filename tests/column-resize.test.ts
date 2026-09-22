import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { sep } from "node:path";
import {
  CLIP_FADE_PX,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  RESIZE_HANDLE_WIDTH,
  clampColumnWidth,
  clipFadeEdge,
  clipFadeMask,
  parseStoredWidths,
  resizedWidths,
  tableConfigKey,
} from "@/lib/table/column-resize";

/**
 * ═══════ KÉO RỘNG CỘT: THU HẸP ĐƯỢC TỚI SÁT, NHƯNG CHỈ ĐÚNG CỘT ĐÃ KÉO ═══════
 *
 * Lời hứa của tính năng ĐÃ ĐỔI (chủ shop yêu cầu 22/09/2026). Trước đây thu hẹp nghĩa là chữ dồn
 * xuống dòng và không mất chữ nào — một lời hứa trình duyệt tự giữ, nhưng nó cũng chặn luôn việc
 * kéo một cột sát lại để tạm bỏ qua nó. Lời hứa mới có ba vế, và bài kiểm này khoá cả ba:
 *
 *   1. KÉO ĐƯỢC TỚI SÁT. Sàn bằng bề rộng tay kéo + 3px, không phải một con số gõ tay: cột hẹp
 *      hơn tay kéo thì tay kéo tràn sang đè tay kéo của cột bên trái và người dùng mất lối ra.
 *   2. CHỈ CỘT ĐÃ KÉO MỚI CÓ BỀ RỘNG LƯU. `table-layout: fixed` lấy quyền nở-theo-nội-dung của
 *      MỌI cột, kể cả cột chưa ai chạm vào, nên quyền ấy phải được trả lại bằng một phép ĐO LẠI
 *      cho các cột còn lại. Không trả lại thì trang sau có số dài hơn là cắt im lặng.
 *   3. MÉP BỊ CẮT PHẢI NHÌN RA ĐƯỢC LÀ ĐÃ CẮT, và mặt nạ phải nằm ở đúng MÉP TRÀN — mép ấy do
 *      CHIỀU VIẾT quyết định, không phải `text-align` (đã đo, xem `clipFadeEdge`). Đặt nhầm mép
 *      là làm mờ khoảng trống, còn `1.307.9` cắt từ `1.307.910.998 ₫` vẫn hiện ra sắc nét như
 *      một con số đầy đủ.
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
  // ───────── SÀN KÉO: HAI MÉP GẦN CHẠM NHAU, NHƯNG KHÔNG CHÔN MẤT TAY KÉO ─────────
  //
  // Con số này phải DẪN XUẤT từ bề rộng tay kéo. Gõ tay một sàn nhỏ hơn tay kéo là dựng một cái
  // bẫy một chiều: cột thu về 6px thì tay kéo 9px của nó tràn sang đè lên tay kéo của cột bên
  // trái, và cột bên trái không kéo lại được nữa.
  assert.ok(MIN_COLUMN_WIDTH > RESIZE_HANDLE_WIDTH, "sàn phải rộng hơn tay kéo, nếu không tay kéo đè sang cột bên cạnh");
  assert.ok(MIN_COLUMN_WIDTH <= RESIZE_HANDLE_WIDTH + 4, "sàn phải sát tay kéo: đây là mức 'hai mép gần chạm nhau'");

  // ───────── KẸP BỀ RỘNG: CHƯA BIẾT KHÔNG ĐƯỢC HOÁ THÀNH MỘT CON SỐ (§42) ─────────
  assert.equal(clampColumnWidth(200), 200);
  assert.equal(clampColumnWidth(1), MIN_COLUMN_WIDTH, "kéo quá hẹp thì dừng ở sàn, không về 0");
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
  // Nút "Cột" ẩn một cột bằng `display: none`, và phép đo trả 0 cho cột đó. Với `table-layout:
  // fixed` cột ẩn KHÔNG tự biến mất — nó lấy đúng bề rộng đã khai. Kẹp số 0 lên sàn là ẩn 10 cột
  // thì được 120px khoảng trắng không ai giải thích nổi.
  assert.deepEqual(resizedWidths([120, 0, 90], 2, -30), [120, 0, 60], "cột đang ẩn (0) đi thẳng qua, không bị kẹp lên sàn");
  assert.deepEqual(resizedWidths([120, 0, 90], 1, 200), [120, 0, 90], "kéo một cột đang ẩn là một lượt không làm gì");

  /*
    ───────── MẶT NẠ NẰM Ở ĐÚNG MÉP TRÀN, VÀ MÉP ẤY KHÔNG PHẢI THỨ TRỰC GIÁC NÓI ─────────

    Trực giác: ô tiền canh phải giữ đuôi số sát mép phải ⇒ phần bị đẩy ra là phần ĐẦU ⇒ làm mờ mép
    TRÁI. Bản đầu viết đúng như vậy và nó SAI. ĐO TRÊN CHROME (22/09/2026, khối 40px chứa nội dung
    148px, `overflow: hidden`): với CẢ BA giá trị `left` · `right` · `center`, phần tràn là 108px ở
    mép PHẢI và 0px ở mép trái. `text-align` chỉ xếp dòng khi dòng còn VỪA.

    Nên câu hỏi duy nhất là CHIỀU VIẾT. Đặt nhầm mép thì mặt nạ chỉ làm mờ khoảng trống: trông vẫn
    "có làm gì đó", mà con số bị cắt vẫn hiện ra sắc nét như một con số đầy đủ.
  */
  assert.equal(clipFadeEdge("ltr"), "right", "chiều viết trái→phải thì nội dung tràn về mép PHẢI");
  assert.equal(clipFadeEdge("rtl"), "left");
  assert.equal(clipFadeEdge(""), "right", "không đọc được chiều viết thì theo mặc định của ERP (ltr)");
  assert.equal(clipFadeEdge(" LTR "), "right", "giá trị từ getComputedStyle không được tin là đã chuẩn hoá");
  assert.ok(clipFadeMask("right").includes("to left"), "làm mờ mép PHẢI = chuyển sắc chạy TỪ phải sang");
  assert.ok(clipFadeMask("left").includes("to right"));
  for (const canh of ["left", "right"] as const) {
    assert.ok(clipFadeMask(canh).includes(`${CLIP_FADE_PX}px`), "dải mờ phải lấy từ hằng số, không gõ lại con số");
  }
  // `px-2.5` = 10px mỗi bên. Dải mờ hẹp hơn thế thì nó chỉ phủ phần đệm và không chạm tới chữ —
  // nội dung bị cắt vẫn sắc nét, và cả hàng rào thứ ba thành trang trí.
  assert.ok(CLIP_FADE_PX > 10, "dải mờ phải ăn qua phần đệm của ô mới nói được điều gì");

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
  assert.notEqual(
    a,
    tableConfigKey("erp.colclip", "/reports", "t1", ["Mã hàng", "Đơn", "Doanh số"]),
    "bề rộng và 'cột nào được cắt' cũng là hai cấu hình, hai khoá",
  );
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
  // Mỗi khoá đọc ra ở đây là một cột ĐƯỢC PHÉP CẮT nội dung, nên rác không được thành một khoá.
  // `Number(null)` là 0: đọc bằng phép ép kiểu thì một giá trị `null` bật cắt cho một cột chưa ai kéo.
  assert.deepEqual(parseStoredWidths('{"0":null,"1":true}', 4), {}, "chỉ nhận SỐ: `null` không được hoá thành một bề rộng hợp lệ");

  // ───────── KHOÁ Ở MỨC MÃ NGUỒN ─────────
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

  assert.ok(!/line-?clamp/.test(src), "`line-clamp` cắt bớt SỐ DÒNG mà không có mép tràn nào để làm mờ — không ai biết mình đang thiếu gì");

  // ─── 1. CÁI LẬT LÀ CÓ CHỦ Ý, VÀ CHỈ LẬT KHI NGƯỜI DÙNG ĐÃ ĐẶT BỀ RỘNG ───
  assert.ok(src.includes("ensureColGroup"), "bề rộng phải đặt ở `<col>`, không đặt lên từng ô");
  assert.ok(
    /tableLayout = coDat \? "fixed" : ""/.test(src),
    "`fixed` là thứ duy nhất làm bề rộng khai thắng nội dung — và nó phải TẮT khi không còn bề rộng người đặt",
  );

  /*
    ─── 2. KHÔNG BAO GIỜ DI CHUYỂN MỘT NÚT DOM CỦA Ô ───

    Cách "gọn" là bọc nội dung ô vào một `<div>` có bề rộng px: `min-content` tụt xuống, bảng giữ
    `table-layout: auto`, và chỉ cột đã kéo bị cắt. Nhưng những ô ấy do React dựng — chuyển chúng
    sang một cha khác thì lượt kết xuất sau React gọi `td.removeChild(node)` với `node` đã nằm
    trong lớp bọc ⇒ `NotFoundError` ⇒ sập trang. 11 bảng của ERP nằm trong client component và ô
    của chúng có nhánh điều kiện, tức React CÓ thay con của ô khi sang trang.
  */
  for (const mau of [/\bcell\.(append|appendChild|insertBefore|removeChild|replaceChildren)\b/, /\bcell\.innerHTML\b/]) {
    assert.ok(!mau.test(src), "lớp này chỉ được ghi `style`: dựng lại con của một ô do React quản là `NotFoundError` ở lượt kết xuất sau");
  }

  // ─── 3. CỘT CHƯA AI KÉO PHẢI ĐƯỢC ĐO LẠI THEO NỘI DUNG ───
  assert.ok(
    /measureNatural\(table, soCot\)/.test(src),
    "`fixed` lấy quyền nở-theo-nội-dung của MỌI cột; không đo lại thì cột chưa ai chạm vào cũng cắt im lặng ở trang sau",
  );
  assert.ok(/rong\[i\] != null \? rong\[i\] : w/.test(src), "cột đã kéo giữ con số người đặt, cột còn lại lấy con số vừa đo");

  // ─── 4. MÉP BỊ CẮT PHẢI NHÌN RA ĐƯỢC LÀ ĐÃ CẮT ───
  assert.ok(/overflow = "hidden"/.test(src), "ở `fixed`, nội dung dài hơn cột TRÀN ĐÈ sang ô bên cạnh chứ không tự dừng lại");
  assert.ok(
    /span === 1 && daKeo\.has\(colIndex\)/.test(src),
    "mặt nạ chỉ đặt ở cột ĐÃ KÉO, và không đặt lên ô trải nhiều cột: bề rộng của ô ấy là tổng nhiều cột",
  );
  assert.ok(
    /clipFadeEdge\(getComputedStyle\(cell\)\.direction\)/.test(src),
    "mép làm mờ suy từ CHIỀU VIẾT, không phải `text-align` — đã đo: canh phải vẫn tràn sang phải",
  );
  for (const thuoc of ["mask-image", "-webkit-mask-image"]) {
    assert.ok(src.includes(`"${thuoc}"`), `thiếu \`${thuoc}\`: nội dung bị cắt mà không có dấu hiệu nào trên màn hình`);
  }

  // ─── 5. ĐANG KÉO THÌ KHÔNG ĐO LẠI ───
  //
  // Phép đo gỡ sạch bề rộng khai để đọc bề rộng tự nhiên. Chạy nó giữa lượt kéo là giật cột đang
  // cầm ra khỏi tay chuột.
  assert.ok(/if \(!table \|\| dragRef\.current\) return;/.test(src), "`doc()` phải bỏ qua khi đang có lượt kéo");

  // ───────── MÀN HÌNH CẢM ỨNG: KHÔNG DỰNG TAY KÉO ─────────
  //
  // Tay kéo rộng 9px, mang `touch-action: none`, và nằm ở mép phải của MỌI cột. Trên điện thoại /
  // máy tính bảng đó không phải một tính năng không dùng tới — nó CƯỚP thao tác vuốt: chạm trúng
  // rồi vuốt ngang sẽ ĐỔI BỀ RỘNG CỘT thay vì cuộn bảng, và người dùng không hiểu vì sao.
  assert.ok(/\(pointer:\s*fine\)/.test(src), "phải hỏi `(pointer: fine)` trước khi dựng tay kéo");
  assert.ok(/\(coConTro \? heads : \[\]\)\.map/.test(src), "không có con trỏ chính xác ⇒ KHÔNG dựng tay kéo nào");
  assert.ok(/touch-none/.test(src), "tay kéo vẫn phải chặn cuộn khi ĐANG kéo bằng bút cảm ứng");
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
    `✓ Kéo rộng cột: sàn ${MIN_COLUMN_WIDTH}px (tay kéo ${RESIZE_HANDLE_WIDTH}px) / trần ${MAX_COLUMN_WIDTH}px · chưa biết ⇒ null · chỉ ghi style, không dựng lại DOM của ô · cột chưa ai kéo được đo lại theo nội dung · mép tràn làm mờ ${CLIP_FADE_PX}px theo đúng chiều viết · ${soCap} bảng thô gắn đúng bảng có thật`,
  );
}

if (process.argv[1] && /column-resize\.test\.ts$/.test(process.argv[1])) {
  testColumnResize();
}
