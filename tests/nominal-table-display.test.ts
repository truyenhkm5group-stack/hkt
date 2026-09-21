import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ═══════ HAI LUẬT CỦA BẢNG LỢI NHUẬN DANH NGHĨA, KHOÁ Ở MỨC MÃ NGUỒN ═══════
 *
 * ─── LUẬT 1: CHƯA BIẾT GIÁ VỐN THÌ KHÔNG ĐƯỢC IN RA 0 ₫ (AGENTS.md §42) ───
 *
 * Bảng "Lợi nhuận theo tổng giá trị hàng nhập" từng in cột "Giá vốn ƯT (đối chiếu)" bằng `<Money>`
 * trần, trong khi CHÍNH DÒNG ĐÓ in "—" cho cột rủi ro tồn kho — cùng một chỗ trống, hai cách nói.
 * Đo production 21/09/2026 (kỳ Toàn bộ):
 *
 *     mã     sp bán ra   sp KHÔNG biết giá vốn   cột "Giá vốn ƯT" in ra
 *     Q004         205                     205                    0 ₫
 *     Q005         213                     213                    0 ₫
 *     Q006          74                      74                    0 ₫
 *
 * 492 sản phẩm không có một đồng giá vốn nào trong ERP, và dòng Tổng vẫn in 95.819.151 ₫ như thể
 * đã đủ. Một con số 0 trông y hệt một con số đã đo, nên chỗ trống phải đi qua `TienCoTheChuaBiet`.
 *
 * SỐ LƯỢNG thì NGƯỢC LẠI: nó vẫn đo được ở đúng những mã ấy. Nên cột số lượng KHÔNG được đeo cờ
 * `cogsKnown` — làm vậy là xoá một con số có thật vì một con số khác bị thiếu.
 *
 * ─── LUẬT 2: BẢNG KHÔNG ĐƯỢC RỘNG QUÁ MÀN HÌNH ───
 *
 * Màn hình 1440px trừ thanh điều hướng còn chừng 1.150px. Bảng chính từng khai `min-w-[1500px]`
 * và bảng hàng nhập `min-w-[1200px]`: cả hai luôn phải kéo ngang, và ngay khi kéo thì cột "Mã
 * hàng" trôi khỏi màn hình — từ đó mọi phép so sánh theo hàng làm bằng trí nhớ. Trần dưới đây
 * chặn việc thêm cột cho tới khi có người nghĩ lại cách trình bày.
 */
export function testNominalTableDisplay() {
  const src = readFileSync(new URL("../app/(dashboard)/reports/nominal-tab.tsx", import.meta.url), "utf8");

  // ───────── LUẬT 1: ba khoản tiền CÓ THỂ CHƯA BIẾT không được đi qua `<Money>` trần ─────────
  //
  // Quét theo TỪNG LỜI GỌI `<Money ... />`, không cắt tệp theo chỉ số ký tự: cách cắt ấy phụ thuộc
  // kết thúc dòng và đã từng làm một bài kiểm khác đỏ trên Windows, xanh ở CI (AGENTS.md §65).
  const moneyCalls = src.match(/<Money\b[^>]*\/>/g) ?? [];
  assert.ok(moneyCalls.length > 10, "phải tìm thấy các lời gọi <Money> — nếu không, biểu thức quét đã lỗi thời");
  for (const field of ["expectedCogs", "inventoryRisk", "purchaseCost"]) {
    const viPham = moneyCalls.filter((c) => new RegExp(`\\b${field}\\b`).test(c));
    assert.equal(
      viPham.length,
      0,
      `\`${field}\` có thể CHƯA BIẾT nên phải in qua <TienCoTheChuaBiet>, không phải <Money> trần (§42). Vi phạm: ${viPham.join(" | ")}`,
    );
  }
  assert.ok(
    /function TienCoTheChuaBiet/.test(src) && /return <span className="text-muted-foreground" title={reason}>—<\/span>/.test(src),
    "ô tiền chưa biết phải in dấu gạch kèm lý do, không in 0 ₫",
  );

  // ───────── LUẬT 1b: SỐ LƯỢNG đo được thì vẫn in, kể cả khi tiền chưa biết ─────────
  // `\r` bị bỏ trước khi tách dòng: kho mã này từng có bài kiểm xanh ở CI (Linux) và đỏ trên
  // Windows vì đọc mã nguồn theo kết thúc dòng (AGENTS.md §65).
  const dong = src.replace(/\r/g, "").split("\n");
  const oSoLuong = dong.filter((l) => l.includes("formatNumber(") && l.includes("expectedQty"));
  assert.ok(
    oSoLuong.length >= 4,
    `số sản phẩm giao thành công ước tính phải hiện ở cả ba bảng (chính · theo ngày · hàng nhập), cả dòng lẻ lẫn dòng tổng — chỉ thấy ${oSoLuong.length} chỗ`,
  );
  const deoCo = oSoLuong.filter((l) => l.includes("cogsKnown"));
  assert.equal(
    deoCo.length,
    0,
    `số lượng KHÔNG được đeo cờ cogsKnown: mã chưa biết giá nhập vẫn đếm được sản phẩm đã giao. Vi phạm: ${deoCo.join(" | ")}`,
  );

  // ───────── LUẬT 1c: phép trừ chỉ in ra khi CẢ HAI vế đã biết ─────────
  assert.ok(
    /costKnown: r\.purchaseCostKnown && r\.cogsKnown/.test(src),
    "hiệu `hàng nhập − giá vốn đã giao` chỉ biết được khi cả hai vế biết; thiếu một vế là trừ đi một ẩn số",
  );
  // Và nó KHÔNG được kẹp về 0: bán nhiều hơn nhập trong kỳ là một việc phải làm, không phải lỗi.
  assert.ok(
    !/Math\.max\(\s*0\s*,\s*r\.purchaseQty - r\.expectedQty/.test(src),
    "phần còn lại âm phải hiện ra là âm — kẹp về 0 là giấu mất tồn đầu kỳ hoặc một phiếu nhập còn thiếu",
  );

  // ───────── LUẬT 1d: tồn theo SỔ KHO đứng cạnh phép trừ, và chưa có phiếu nhập thì là CHƯA BIẾT ─────────
  assert.ok(/function nhanSoKho/.test(src), "phép trừ phải in kèm tồn thật theo Sổ kho để đối chiếu");
  assert.ok(
    /if \(!r\.stockKnown\) return <span[^>]*>sổ kho —<\/span>/.test(src),
    "mã chưa có phiếu nhập nào ⇒ Sổ kho in '—', không in 0 (AGENTS.md §10)",
  );

  // ───────── LUẬT 2: trần bề rộng ─────────
  // Chỉ bề rộng THẬT của thẻ <Table>. Quét cả tệp sẽ bắt luôn hai con số cũ đang được nhắc trong
  // chú thích của `OKep` — bài kiểm khi đó đo văn xuôi chứ không đo bảng.
  const widths = [...src.matchAll(/<Table className="min-w-\[(\d+)px\]"/g)].map((m) => Number(m[1]));
  assert.ok(widths.length >= 4, `phải thấy đủ bốn bảng của tab, chỉ thấy ${widths.length}`);
  const TRAN = 1150;
  const qua = widths.filter((w) => w > TRAN);
  assert.equal(
    qua.length,
    0,
    `bảng rộng hơn ${TRAN}px buộc người dùng kéo ngang và làm trôi mất cột "Mã hàng": ${qua.join(", ")}px. Gộp cột lại (xem \`OKep\`) thay vì nới trần.`,
  );

  // ───────── LUẬT 2b: dòng "không có dữ liệu" phải trải ĐỦ số cột ─────────
  //
  // Gộp cột thì `colSpan` của dòng rỗng lệch theo, và lệch thì không ai thấy — bảng vẫn dựng
  // được, chỉ là ô chữ không nằm giữa. Đã dẫm vào đúng chỗ này khi hạ bảng chính từ 24 cột
  // xuống 12 mà để `colSpan={11}`.
  const khoiBang = src.split(/<Table className="min-w-\[\d+px\]"/).slice(1);
  assert.equal(khoiBang.length, widths.length, "số khối bảng phải khớp số bề rộng đã đọc");
  khoiBang.forEach((khoi, k) => {
    const than = khoi.slice(0, khoi.indexOf("</Table>"));
    const soCot = (than.match(/<TableHead[ >]/g) ?? []).length;
    // CHỈ dòng có ĐÚNG MỘT ô mới phải trải hết bảng. Dòng nhãn của bảng Marketer có `colSpan` rồi
    // còn thêm mấy ô số bên phải — ở đó `colSpan < số cột` mới là đúng.
    for (const dongRow of than.split("<TableRow").slice(1)) {
      // `<TableCell` có thể xuống dòng ngay sau tên thẻ khi thuộc tính nhiều — `\b` bắt được cả
      // ba kiểu xuống dòng / khoảng trắng / dấu đóng, còn một lớp ký tự gõ tay thì không.
      const het = dongRow.indexOf("</TableRow>");
      const khoi = het >= 0 ? dongRow.slice(0, het) : dongRow;
      const soO = (khoi.match(/<(?:TableCell|OKep)\b/g) ?? []).length;
      const cs = khoi.match(/colSpan=\{(\d+)\}/);
      if (soO !== 1 || !cs) continue;
      assert.equal(
        Number(cs[1]),
        soCot,
        `bảng ${widths[k]}px có ${soCot} cột nhưng dòng một-ô khai colSpan=${cs[1]} — dòng trống sẽ không trải hết bảng`,
      );
    }
  });

  console.log(`✓ Bảng lợi nhuận danh nghĩa: tiền chưa biết in "—" (không phải 0 ₫) · số lượng vẫn đo được · colSpan khớp số cột · 4 bảng đều ≤ ${TRAN}px (rộng nhất ${Math.max(...widths)}px)`);
}

if (process.argv[1] && /nominal-table-display\.test\.ts$/.test(process.argv[1])) {
  testNominalTableDisplay();
}
