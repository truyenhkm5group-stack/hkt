import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recommendSize, resolveSizeRule, type SizeRule } from "@/lib/constants/size-engine";

/**
 * ═══════════ BẢNG SỐ ĐO THẬT CỦA SHOP — KHOÁ PHÉP RÃ MA TRẬN ═══════════
 *
 * Bảng nam chủ shop gửi là một MA TRẬN 6 dải chiều cao × 9 cột cân nặng. Máy gợi ý size khớp theo
 * KHOẢNG CHỮ NHẬT cho mỗi dòng, nên ma trận phải rã thành ô rồi GỘP NGANG các ô liền nhau cùng
 * size trong cùng một dải chiều cao.
 *
 * PHÉP GỘP ẤY LÀM BẰNG TAY, và đó là chỗ dễ sai nhất trong cả việc này: gộp lố một cột là một
 * dải cân nặng lĩnh nhầm size, và không có gì trong hệ thống phát hiện ra — máy vẫn trả `OK`, vẫn
 * rất tự tin, và cái sai chỉ lộ ra khi khách mặc không vừa.
 *
 * Nên bài kiểm này viết lại ma trận theo ĐÚNG hình chủ shop gửi, ở dạng TỪNG Ô, rồi dò từng ô một
 * qua chính máy gợi ý. Nó không kiểm được tôi có đọc đúng ảnh hay không — việc đó chỉ chủ shop
 * xác nhận được — nhưng nó khoá chặt phần biến đổi từ ma trận sang khoảng.
 */

const HET_SIZE = "HẾT SIZE";

/** Điểm dò nằm GIỮA mỗi dải, để một lỗi lệch một đơn vị ở hai đầu không lọt qua vì may. */
const CAO = [155, 164, 171, 176, 179, 183];
const NANG = [56, 66, 71, 75, 80, 85, 90, 96, 101];

/** Ma trận đúng như ảnh: hàng = dải chiều cao, cột = dải cân nặng. */
const MA_TRAN: string[][] = [
  // Dưới 1m60
  ["XS", "M", "M", "L", "XL", HET_SIZE, HET_SIZE, HET_SIZE, HET_SIZE],
  // 1m60–1m68
  ["XS", "S", "M", "L", "L", "XL", "XL", HET_SIZE, HET_SIZE],
  // 1m69–1m74
  ["XS", "S", "S", "M", "L", "XL", "XL", HET_SIZE, HET_SIZE],
  // 1m75–1m77
  ["S", "M", "M", "M", "M", "L", "XL", "XL", HET_SIZE],
  // 1m78–1m80
  ["M", "M", "M", "M", "L", "L", "XL", "XL", "XL"],
  // 1m80–1m85
  ["M", "L", "L", "L", "L", "L", "L", "XL", "XL"],
];

function loadRules(): { version: string; rules: SizeRule[] } {
  // Tách rồi nối lại bằng "/" — `path.sep` là "\\" trên Windows và "/" ở CI, và một khoá tra cứu
  // mang dấu phân cách của hệ điều hành thì không bao giờ khớp (AGENTS.md §65).
  const p = path.join(process.cwd(), "scripts", "size-rules.json").split(path.sep).join("/");
  return JSON.parse(readFileSync(p, "utf8")) as { version: string; rules: SizeRule[] };
}

export function testSizeRules() {
  const payload = loadRules();
  const nam = payload.rules.find((r) => r.version.startsWith("nam-"));
  const nu = payload.rules.find((r) => r.version.startsWith("nu-"));
  assert.ok(nam, "phải có bảng nam");
  assert.ok(nu, "phải có bảng nữ");

  // ═════════ 1. TỪNG Ô CỦA MA TRẬN NAM ═════════
  let oDung = 0;
  let oHetSize = 0;
  for (let i = 0; i < CAO.length; i += 1) {
    for (let j = 0; j < NANG.length; j += 1) {
      const mong = MA_TRAN[i][j];
      const ra = recommendSize(nam, { heightCm: CAO[i], weightKg: NANG[j] });
      const o = `cao ${CAO[i]} · nặng ${NANG[j]}`;
      if (mong === HET_SIZE) {
        // Ô HẾT SIZE KHÔNG được khai thành dòng. Máy phải nói "ngoài bảng" rồi chuyển người —
        // shop không có hàng cho số đo ấy, và câu đó do NGƯỜI nói, không phải máy chọn một size
        // gần đúng rồi gửi đi một kiện hàng không vừa.
        assert.equal(ra.code, "OUT_OF_RANGE", `${o}: ô HẾT SIZE phải ra OUT_OF_RANGE, nhận ${ra.code} → ${ra.size}`);
        oHetSize += 1;
      } else {
        assert.equal(ra.code, "OK", `${o}: phải kết luận được, nhận ${ra.code} (${ra.reason})`);
        assert.equal(ra.size, mong, `${o}: phải ra ${mong}, nhận ${ra.size}`);
        oDung += 1;
      }
    }
  }
  assert.equal(oDung + oHetSize, CAO.length * NANG.length, "phải dò hết mọi ô");

  /*
    ═════════ 2. HAI DẢI CHIỀU CAO DÍNH NHAU TẠI ĐÚNG 1m80 ═════════

    Ảnh viết "1m78--1m80" và "1m80---1m85", nên người cao đúng 180cm rơi vào CẢ HAI dải, và ở đó
    hai dải cho hai size khác nhau (70kg: M ở dải trên, L ở dải dưới).

    Máy trả AMBIGUOUS và chuyển người. Đó là hành vi ĐÚNG và phải giữ: tự chọn một bên là quyết
    định thay chủ shop về một cơ thể thật, dựa trên không gì cả. Bài kiểm khoá lại điều đó để
    không ai "sửa cho gọn" bằng cách lặng lẽ cắt một dải.
  */
  const oDinh = recommendSize(nam, { heightCm: 180, weightKg: 71 });
  assert.equal(oDinh.code, "AMBIGUOUS", "cao đúng 180 phải là CHƯA BIẾT, không được tự chọn một bên");
  assert.deepEqual([...oDinh.candidates].sort(), ["L", "M"], "phải nói rõ đang phân vân giữa hai size nào");

  // Ngoài đúng giá trị dính đó thì hai dải vẫn kết luận bình thường.
  assert.equal(recommendSize(nam, { heightCm: 179, weightKg: 71 }).size, "M");
  assert.equal(recommendSize(nam, { heightCm: 181, weightKg: 71 }).size, "L");

  // ═════════ 3. NGOÀI BẢNG ═════════
  assert.equal(recommendSize(nam, { heightCm: 190, weightKg: 70 }).code, "OUT_OF_RANGE", "cao hơn 1m85 chưa có trong bảng");
  assert.equal(recommendSize(nam, { heightCm: 170, weightKg: 45 }).code, "OUT_OF_RANGE", "nhẹ hơn 50kg chưa có trong bảng");
  assert.equal(recommendSize(nam, { heightCm: 170, weightKg: 120 }).code, "OUT_OF_RANGE", "nặng hơn 103kg chưa có trong bảng");

  // Thiếu chiều cao thì KHÔNG đoán — bảng nam dùng cả hai chiều.
  const thieuCao = recommendSize(nam, { weightKg: 70 });
  assert.equal(thieuCao.code, "MEASUREMENTS_MISSING", "bảng nam cần cả chiều cao — thiếu thì phải đi hỏi, không đoán");
  assert.deepEqual(thieuCao.missing, ["heightCm"]);

  /*
    ═════════ 4. BẢNG NỮ — CHỈ CÂN NẶNG ═════════

    Hai cột "Ngực" và "Eo" trong ảnh là THÔNG SỐ CỦA SẢN PHẨM (mỗi size một con số: M=85, L=90…),
    không phải khoảng số đo của người mặc. Khai chúng thành [85,85] sẽ bắt khách phải có vòng ngực
    đúng 85cm mới ra được size — gần như không ai khớp, và máy sẽ đòi một số đo mà nó không dùng
    để làm gì.
  */
  const dungChieu = (["bustCm", "waistCm", "hipCm", "heightCm"] as const).every((k) => nu.rows.every((r) => !r[k]));
  assert.ok(dungChieu, "bảng nữ chỉ được ràng buộc cân nặng — ngực/eo là thông số áo, không phải số đo người");
  assert.ok((nu.note ?? "").includes("85"), "thông số áo phải còn lại trong ghi chú để nhân viên tư vấn");

  assert.equal(recommendSize(nu, { weightKg: 45 }).size, "M");
  assert.equal(recommendSize(nu, { weightKg: 53 }).size, "L");
  assert.equal(recommendSize(nu, { weightKg: 60 }).size, "XL");
  assert.equal(recommendSize(nu, { weightKg: 67 }).size, "XXL");
  assert.equal(recommendSize(nu, { weightKg: 75 }).size, "3XL");

  // Chỉ cần cân nặng — KHÔNG được đòi thêm số đo mà bảng không dùng.
  assert.equal(recommendSize(nu, { weightKg: 45 }).code, "OK", "bảng nữ không được đòi chiều cao");

  /*
    Ảnh viết "40-50kg" rồi "50-56kg" rồi "56-63kg", nên 50 và 56 nằm trong HAI size cùng lúc.
    Giữ nguyên và để máy chuyển người: một người 50kg mặc M hay L là quyết định của shop.
  */
  for (const [kg, cap] of [[50, ["L", "M"]], [56, ["L", "XL"]]] as const) {
    const ra = recommendSize(nu, { weightKg: kg });
    assert.equal(ra.code, "AMBIGUOUS", `${kg}kg nằm trong hai size — phải chuyển người`);
    assert.deepEqual([...ra.candidates].sort(), [...cap].sort(), `${kg}kg phải nói rõ phân vân giữa ${cap.join(" và ")}`);
  }

  // Khe giữa hai bảng: 63→XL, 64→XXL. Không được có khoảng trống ở đây.
  assert.equal(recommendSize(nu, { weightKg: 63 }).size, "XL");
  assert.equal(recommendSize(nu, { weightKg: 64 }).size, "XXL");
  assert.equal(recommendSize(nu, { weightKg: 85 }).code, "OUT_OF_RANGE", "nặng hơn 79kg chưa có trong bảng nữ");

  /*
    ═════════ 5. PHẠM VI CHƯA KHAI THÌ BẢNG KHÔNG BAO GIỜ ĐƯỢC DÙNG ═════════

    Khoá còn là chỗ điền thì `resolveSizeRule` không khớp mẫu nào, máy tiếp tục trả
    SIZE_DATA_MISSING y như lúc chưa có bảng — và người khai sẽ tưởng đã xong. Bài kiểm giữ cho
    điều đó là một sự thật ĐƯỢC KHAI, không phải một bất ngờ.
  */
  const conChoDien = payload.rules.filter((r) => (r.key ?? "").includes("ĐIỀN"));
  for (const r of conChoDien) {
    assert.equal(
      resolveSizeRule(payload.rules, { family: "Q", productId: null, variantId: null }) === r,
      false,
      `bảng ${r.version} còn khoá giữ chỗ — không được vô tình khớp một nhóm hàng thật`,
    );
  }

  console.log(
    `✓ Bảng số đo thật: ma trận nam ${CAO.length}×${NANG.length} rã đúng từng ô (${oDung} ô có size · ${oHetSize} ô HẾT SIZE ⇒ chuyển người) · 1m80 dính hai dải ⇒ CHƯA BIẾT · bảng nữ chỉ ràng buộc cân nặng, 50kg và 56kg ⇒ CHƯA BIẾT`,
  );
}
