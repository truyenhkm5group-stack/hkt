import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * ═══════════ LỚP TĂNG TỐC PHẢI ĐƯỢC NỐI VÀO, KHÔNG CHỈ TỒN TẠI ═══════════
 *
 * SỰ CỐ THẬT (10/09/2026). Bản P0.3 dựng `canonical_order_outcome` và hai biểu thức đọc nó —
 * `ORDER_OUTCOME_FAST`, `orderCogsFast()` — rồi nối vào đúng **2/25** tệp truy vấn. Phần còn lại
 * vẫn chạy biểu thức SỐNG (~2,4ms mỗi đơn × 2.433 đơn cho mỗi lần tính).
 *
 * Đo trên production bằng `perf-probe`:
 *
 *     getDashboardData    40.704ms
 *     ├ getFinancialTruth 11.429ms
 *     ├ getOperatingCost   4.607ms
 *     └ getControlTower       300ms
 *
 * và smoke trên hệ thống RẢNH: trang chủ **quá hạn 60 giây**, nuốt trọn ngân sách khiến 8 màn hình
 * còn lại không kịp kiểm. Bảng dẫn xuất vẫn đầy đủ và tươi — chỉ là không ai đọc nó.
 *
 * Đây là lần thứ SÁU trong hai ngày gặp cùng một lỗi thiết kế: thứ được dựng ra rồi không ai gọi
 * (job không có lịch · phép nối không canh grain · lá chắn chi phí canh sáu tệp · ranh giới ghi canh
 * 15 tệp · khung xương canh 21 tuyến · và đây).
 *
 * Bài kiểm này canh ĐƯỜNG TIỀN NÓNG: các tệp mà mọi trang đều đi qua phải đọc bảng dẫn xuất. Nó
 * cũng IN RA số tệp còn lại trên đường chậm, để phần chưa chuyển không nằm im trong tài liệu.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/fast-path-wiring.test.ts
 */

/**
 * Tệp BẮT BUỘC đọc bảng dẫn xuất. Đây là những nơi mọi trang đều đi qua, nên một lần tính lại ở đây
 * nhân lên thành chi phí của cả ứng dụng.
 */
const DUONG_TIEN_NONG = ["lib/queries/metrics.ts", "lib/queries/cost-engine.ts", "lib/queries/financial-truth.ts", "lib/queries/reports.ts"];

/**
 * Tệp ĐƯỢC PHÉP dùng biểu thức sống, và vì sao. Ba lý do hợp lệ:
 *  · nó ĐỊNH NGHĨA biểu thức, hoặc GHI bảng dẫn xuất (đọc bảng để ghi bảng là vòng tròn);
 *  · nó là bộ dò bất thường — phải nhìn sự thật hiện thời, không nhìn ảnh chụp;
 *  · nó đối chiếu bảng với biểu thức chuẩn, nên buộc phải chạy cả hai.
 */
const DUOC_DUNG_BAN_SONG: Record<string, string> = {
  "lib/queries/return-rate.ts": "nơi ĐỊNH NGHĨA ORDER_OUTCOME và bản _FAST",
  "lib/queries/cogs.ts": "nơi ĐỊNH NGHĨA ORDER_COGS và orderCogsFast",
  "lib/queries/canonical-outcome.ts": "bộ GHI bảng dẫn xuất — đọc bảng để ghi bảng là vòng tròn",
  "lib/queries/data-quality.ts": "bộ dò bất thường phải nhìn sự thật hiện thời, không nhìn ảnh chụp",
};

const SONG = /\$\{ORDER_OUTCOME\}|\$\{ORDER_COGS\}/;
const NHANH = /ORDER_OUTCOME_FAST|orderCogsFast|outcomeColumn|orderCogsColumn/;

export function testFastPathWiring() {
  const tep = readdirSync("lib/queries")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `lib/queries/${f}`);
  assert.ok(tep.length > 40, `đọc hụt lib/queries (chỉ thấy ${tep.length} tệp)`);

  const thieu: string[] = [];
  const conChamCoLyDo: string[] = [];
  const conChamChuaChuyen: string[] = [];

  for (const f of tep) {
    const src = readFileSync(f, "utf8");
    const dungSong = SONG.test(src);
    const dungNhanh = NHANH.test(src);
    if (DUONG_TIEN_NONG.includes(f) && !dungNhanh) thieu.push(f);
    if (!dungSong) continue;
    if (f in DUOC_DUNG_BAN_SONG) conChamCoLyDo.push(f);
    else if (!DUONG_TIEN_NONG.includes(f)) conChamChuaChuyen.push(f);
  }

  assert.deepEqual(
    thieu.sort(),
    [],
    `ĐƯỜNG TIỀN NÓNG còn tính lại kết quả đơn thay vì đọc bảng dẫn xuất: ${thieu.join(", ")}.\n` +
      "Dùng ORDER_OUTCOME_FAST / orderCogsFast() — kết quả KHÔNG đổi (coalesce(bảng, biểu thức chuẩn)), chỉ đổi lúc nào nó được tính.",
  );

  // Đường tiền nóng cũng KHÔNG được để sót một biểu thức sống lẫn vào giữa các biểu thức nhanh:
  // một cột chậm trong cùng câu lệnh kéo cả câu về tốc độ cũ.
  for (const f of DUONG_TIEN_NONG) {
    const src = readFileSync(f, "utf8");
    if (f === "lib/queries/financial-truth.ts" || f === "lib/queries/reports.ts") continue; // còn dùng cho phần đối chiếu, xem mục dưới
    assert.equal(SONG.test(src), false, `${f}: còn sót biểu thức SỐNG lẫn giữa các biểu thức nhanh — một cột chậm kéo cả câu lệnh về tốc độ cũ`);
  }

  /**
   * MIỄN TRỪ KHÔNG ĐƯỢC QUÁ RỘNG — đây là chỗ lỗi 40 giây chui qua.
   *
   * `return-rate.ts` được miễn với lý do "nơi định nghĩa", và đúng là vậy. Nhưng cùng tệp đó còn
   * chứa các VỊ NGỮ DẪN XUẤT dùng ở khắp nơi, trong đó `RETURN_PENDING_WAREHOUSE` nằm trong sáu bộ
   * lọc của truy vấn sổ kho chạy trên 2.495 dòng hàng. Nó dùng bản SỐNG, và miễn trừ cả tệp khiến
   * không lá chắn nào thấy.
   *
   * Nên kiểm riêng: vị ngữ dẫn xuất phải dùng bản nhanh, dù ở trong tệp được miễn.
   */
  const VI_NGU_DAN_XUAT = ["RETURN_PENDING_WAREHOUSE", "SHIPMENT_DELIVERED", "SHIPMENT_RETURNED"];
  const srcRr = readFileSync("lib/queries/return-rate.ts", "utf8");
  for (const ten of VI_NGU_DAN_XUAT) {
    const dong = srcRr.split(/\r?\n/).find((l) => l.includes(`export const ${ten} =`));
    assert.ok(dong, `không tìm thấy vị ngữ ${ten} — đổi tên thì phải cập nhật lá chắn`);
    assert.equal(
      /\$\{ORDER_OUTCOME\}/.test(dong ?? ""),
      false,
      `${ten} dùng biểu thức SỐNG. Vị ngữ dẫn xuất phải đọc bảng dẫn xuất kể cả khi nằm trong tệp được miễn — đây đúng là chỗ lỗi 40 giây của trang chủ chui qua.`,
    );
  }

  // Danh sách miễn trừ phải sạch.
  const thuaMienTru = Object.keys(DUOC_DUNG_BAN_SONG).filter((f) => !SONG.test(readFileSync(f, "utf8")));
  assert.deepEqual(thuaMienTru, [], `DUOC_DUNG_BAN_SONG còn khai tệp không còn dùng bản sống: ${thuaMienTru.join(", ")}`);

  console.log(
    `✓ Nối lớp tăng tốc: ${DUONG_TIEN_NONG.length} tệp đường tiền nóng đọc bảng dẫn xuất · ${conChamCoLyDo.length} tệp dùng bản sống có lý do` +
      (conChamChuaChuyen.length ? ` · ${conChamChuaChuyen.length} tệp CHƯA chuyển: ${conChamChuaChuyen.map((f) => f.replace("lib/queries/", "")).join(", ")}` : ""),
  );
}

// Chạy được độc lập, và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /fast-path-wiring\.test\.ts$/.test(process.argv[1])) {
  try {
    testFastPathWiring();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
