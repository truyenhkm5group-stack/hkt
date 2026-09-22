import assert from "node:assert/strict";
import { parseVcbNumber, parseVcbXml } from "@/lib/integrations/vcb/rate";
import { buildVndPricing, pricingVersionLabel } from "@/lib/constants/ai-model-pricing";

/**
 * ═══════════ ĐỌC TỶ GIÁ VIETCOMBANK ═══════════
 *
 * Bài kiểm chạy trên một MẪU XML CHÉP LẠI, không gọi mạng. Luật 65: bài kiểm đo mã nguồn, không
 * đo cái máy đang chạy — một bài gọi thẳng portal của ngân hàng sẽ đỏ vào ngày họ bảo trì, và
 * người ta sẽ đi tắt nó đi thay vì đọc thông điệp.
 */

/** Cắt từ bản công bố thật của VCB, giữ nguyên bố cục và dấu phẩy ngăn nghìn. */
const MAU = `<?xml version="1.0" encoding="UTF-8"?>
<ExrateList>
  <DateTime>22/09/2026 8:30:00 AM</DateTime>
  <Exrate CurrencyCode="AUD" CurrencyName="AUST.DOLLAR" Buy="16,800.00" Transfer="16,970.00" Sell="17,500.00" />
  <Exrate CurrencyCode="USD" CurrencyName="US DOLLAR" Buy="25,950.00" Transfer="25,980.00" Sell="26,310.00" />
  <Exrate CurrencyCode="EUR" CurrencyName="EURO" Buy="28,100.00" Transfer="28,380.00" Sell="29,600.00" />
</ExrateList>`;

export function testVcbRate() {
  const r = parseVcbXml(MAU);
  assert.ok(r, "phải đọc được dòng USD");

  /*
    LẤY CỘT BÁN, KHÔNG LẤY CỘT MUA.

    Hoá đơn mô hình là khoản shop PHẢI TRẢ bằng USD, nên tỷ giá đúng là giá shop mua USD từ ngân
    hàng — cột Sell. Lấy nhầm cột Buy (25.950) thì mọi chi phí bị báo thấp hơn thực tế khoảng
    1,4%, đều đặn, và luôn về một phía — kiểu sai không bao giờ tự lộ ra.
  */
  assert.equal(r.sellVnd, 26_310, "phải là cột Sell, không phải Buy (25.950) hay Transfer (25.980)");
  assert.equal(r.publishedAt, "22/09/2026 8:30:00 AM", "giữ nguyên ngày công bố để biết có phải giá hôm nay không");

  // Không được nhặt nhầm đồng tiền khác — AUD và EUR đứng ngay cạnh trong cùng bản công bố.
  assert.notEqual(r.sellVnd, 17_500);
  assert.notEqual(r.sellVnd, 29_600);

  /*
    MỌI NHÁNH KHÔNG ĐỌC ĐƯỢC ĐỀU PHẢI RA `null`, KHÔNG RA 0.

    Một số 0 lọt qua đây sẽ đi thẳng vào phép nhân đơn giá và biến mọi chi phí thành `0 ₫` — tức
    là một lời khẳng định "không tốn gì" (luật 42), chứ không phải một chỗ trống.
  */
  assert.equal(parseVcbNumber("0.00"), null, "0 không phải một tỷ giá hợp lệ");
  assert.equal(parseVcbNumber("-1"), null);
  assert.equal(parseVcbNumber(""), null);
  assert.equal(parseVcbNumber(undefined), null);
  assert.equal(parseVcbNumber("không có"), null);
  assert.equal(parseVcbNumber("26,310.00"), 26_310, "dấu phẩy ngăn nghìn phải đọc được");

  assert.equal(parseVcbXml("<ExrateList></ExrateList>"), null, "không có USD thì KHÔNG đoán");
  assert.equal(parseVcbXml("<html>bảo trì</html>"), null, "trang lỗi không được đọc thành một con số");
  assert.equal(
    parseVcbXml('<ExrateList><Exrate CurrencyCode="USD" Buy="25,950.00" /></ExrateList>'),
    null,
    "thiếu đúng cột Sell thì KHÔNG rơi về cột khác — thà chưa biết còn hơn sai cột",
  );

  /*
    TỶ GIÁ ĐI VÀO NHÃN PHIÊN BẢN BẢNG GIÁ.

    Đổi tỷ giá là ra con số khác trên cùng một lượt gọi mô hình. Hai kỳ mang nhãn khác nhau thì
    không ai vẽ nhầm một đường xu hướng qua chúng (cùng lý do luật 40 tách phiên bản nguồn khỏi
    phiên bản công thức).
  */
  assert.notEqual(pricingVersionLabel(26_310), pricingVersionLabel(25_900), "đổi tỷ giá phải đổi nhãn phiên bản");

  const gia = buildVndPricing(r.sellVnd);
  assert.ok(Object.keys(gia).length > 0, "phải quy được ít nhất một mô hình sang VND");
  for (const [model, g] of Object.entries(gia)) {
    assert.ok(g.inputVndPerMillion > 0, `${model}: đơn giá vào phải dương`);
    assert.ok(g.outputVndPerMillion > g.inputVndPerMillion, `${model}: token ra luôn đắt hơn token vào`);
  }

  // Tỷ giá vô lý KHÔNG được biến thành một bảng giá — hàm phải ném, không được trả bảng 0 đồng.
  assert.throws(() => buildVndPricing(0), /tỷ giá/i);
  assert.throws(() => buildVndPricing(Number.NaN), /tỷ giá/i);

  console.log(
    `✓ Tỷ giá Vietcombank: đọc đúng cột BÁN (26.310) giữa AUD/EUR đứng cạnh · mọi nhánh không đọc được ra null chứ không ra 0 · đổi tỷ giá là đổi nhãn phiên bản bảng giá`,
  );
}
