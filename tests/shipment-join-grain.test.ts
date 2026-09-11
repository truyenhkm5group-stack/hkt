/**
 * ═══════════ NỐI VẬN ĐƠN MÀ KHÔNG CANH GRAIN = CỘNG TIỀN HAI LẦN ═══════════
 *
 * SỰ CỐ THẬT (10/09/2026). Bản phát hành Phase 2 gỡ ràng buộc `UNIQUE(shipments.order_id)` để một đơn
 * được phép có nhiều lần gửi, và áp `PRIMARY_ATTEMPT` cho các đường tính tiền. Nhưng việc rà chỉ phủ
 * 14 tệp; **12 phép nối ở 9 tệp khác bị bỏ sót** — trong đó có Báo cáo lợi nhuận, danh sách Đơn hàng,
 * Dòng tiền, Hiệu suất nhân sự, CRM và tồn kho 30 ngày.
 *
 * Hậu quả nếu không sửa: ngày đầu tiên một đơn có hai lần gửi, doanh thu và số đơn của đơn đó bị cộng
 * hai lần — **im lặng, không lỗi, không cảnh báo**. Đúng loại sai nguy hiểm nhất: sai theo hướng dễ
 * chịu (lãi trông cao hơn thật), và không ai phát hiện cho tới lúc đối chiếu sổ sách.
 *
 * Trước Phase 2, thứ giữ mọi con số đúng KHÔNG phải là mã nguồn mà là ràng buộc CSDL. Gỡ nó ra thì
 * phải có thứ khác canh — và một lần rà bằng mắt không phải là thứ đó.
 *
 * Bài kiểm này đọc MÃ NGUỒN: mọi phép nối `orders → shipments` trong `lib/queries/*` và `lib/alerts/*`
 * phải hoặc kèm `PRIMARY_ATTEMPT`, hoặc nằm trong danh sách miễn trừ kèm lý do.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/shipment-join-grain.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Tệp được phép nối vận đơn KHÔNG canh, và vì sao. Mỗi dòng là một quyết định có chủ ý.
 *
 * Chỉ đúng hai lý do hợp lệ:
 *  · grain của chính nó LÀ vận đơn (trang Vận đơn, bảng dẫn xuất, luật đối soát đếm số lần gửi);
 *  · phép nối chỉ để kiểm tra CÓ / KHÔNG CÓ (`is null`), không cộng gì nên không nhân được.
 *
 * "Chưa kịp sửa" KHÔNG phải lý do hợp lệ.
 */
const MIEN_TRU: Record<string, string> = {
  "lib/queries/canonical-outcome.ts": "grain của bảng dẫn xuất ĐÚNG LÀ (đơn × vận đơn) — cố ý, để đối chiếu 1-1 với biểu thức chuẩn",
  "lib/queries/return-rate.ts": "nơi ĐỊNH NGHĨA PRIMARY_ATTEMPT và grain vận đơn của trang Vận đơn",
  "lib/queries/control-tower.ts": "luật đối soát: có luật cố ý ĐẾM số lần gửi của một đơn, có luật chỉ kiểm tra vắng mặt",
  "lib/queries/data-quality.ts": "cùng lý do với control-tower — dò bất thường trên từng vận đơn",
  "lib/queries/stock.ts": "sổ kho đo theo MỐC XUẤT KHO của từng vận đơn, và đã khử trùng bằng exists",
  // Grain ở đây là VIỆC CẦN XỬ LÝ, không phải đơn: mỗi việc trỏ tới đúng một đối tượng qua
  // `entity_id`, nên phép nối tra ra nhiều nhất một dòng đơn và một dòng vận đơn. Không có chỗ nào
  // để nhân lên — và cũng KHÔNG được thêm PRIMARY_ATTEMPT vào đây: việc gắn với lần gửi thứ hai
  // của một đơn là một việc có thật, lọc nó đi thì tiền của nó biến mất khỏi bảng điều hành.
  "lib/queries/stage-health.ts": "grain là VIỆC (notifications), nối theo entity_id nên mỗi việc ra đúng một dòng — không nhân được",
  // Bàn làm việc giao vận và báo cáo care đo theo KIỆN (mỗi lần gửi là một kiện phải care, kể cả
  // lần gửi thứ hai của cùng một đơn). Nối orders chỉ để lấy tên / SĐT khách, không cộng tiền theo đơn.
  "lib/queries/care-workbench.ts": "grain là KIỆN CẦN CARE — lần gửi thứ hai cũng là một kiện phải gọi; nối orders chỉ lấy tên/SĐT",
  "lib/queries/care-report.ts": "grain là KIỆN giao hụt / kiện có can thiệp; kết cục đọc theo SHIPMENT_DELIVERED của chính kiện đó",
};

/** Nối `orders → shipments` ở mọi cách viết đang dùng trong kho (Drizzle builder và SQL thô). */
const NOI_VAN_DON = [
  /\.leftJoin\(\s*(?:schema\.)?s(?:hipments)?\s*,/g,
  /\.innerJoin\(\s*(?:schema\.)?s(?:hipments)?\s*,/g,
  /\bjoin\s+shipments\b/g,
];

const goc = path.resolve(__dirname, "..");

function quet(thuMuc: string): string[] {
  const day = path.join(goc, thuMuc);
  return fs
    .readdirSync(day)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${thuMuc}/${f}`);
}

export function testShipmentJoinGrain() {
  const tep = [...quet("lib/queries"), ...quet("lib/alerts")];
  assert.ok(tep.length > 20, `đọc hụt thư mục truy vấn (chỉ thấy ${tep.length} tệp)`);

  const thieuCanh: string[] = [];
  let coNoi = 0;

  for (const f of tep) {
    const src = fs.readFileSync(path.join(goc, f), "utf8");
    const soNoi = NOI_VAN_DON.reduce((n, re) => n + [...src.matchAll(re)].length, 0);
    if (!soNoi) continue;
    coNoi += 1;
    if (f in MIEN_TRU) continue;
    // Nối vận đơn CHỈ để kiểm tra vắng mặt thì không cộng gì, không nhân được.
    const chiKiemVangMat = /isNull\(\s*s\.id\s*\)|s\.id\s+is\s+null|\$\{s\.id\}\s+is\s+null/.test(src) && !/PRIMARY_ATTEMPT/.test(src);
    if (chiKiemVangMat) continue;
    if (!src.includes("PRIMARY_ATTEMPT")) thieuCanh.push(f);
  }

  assert.deepEqual(
    thieuCanh.sort(),
    [],
    `Nối vận đơn KHÔNG canh grain (đơn nhiều lần gửi sẽ bị cộng tiền nhiều lần):\n  ${thieuCanh.join("\n  ")}\n\n` +
      "Thêm PRIMARY_ATTEMPT vào điều kiện nối, hoặc khai vào MIEN_TRU kèm lý do vì sao grain vận đơn là đúng ở đó.",
  );

  // Danh sách miễn trừ phải sạch: khai cho tệp đã xoá hoặc đã hết nối là rác, và che mất ca thật.
  const thuaMienTru = Object.keys(MIEN_TRU).filter((f) => {
    if (!fs.existsSync(path.join(goc, f))) return true;
    const src = fs.readFileSync(path.join(goc, f), "utf8");
    return NOI_VAN_DON.every((re) => [...src.matchAll(re)].length === 0);
  });
  assert.deepEqual(thuaMienTru, [], `MIEN_TRU còn khai tệp không còn nối vận đơn: ${thuaMienTru.join(", ")}`);

  console.log(`✓ Grain phép nối vận đơn: ${coNoi} tệp có nối · ${Object.keys(MIEN_TRU).length} miễn trừ có lý do · 0 tệp cộng tiền theo số lần gửi`);
}

// Chạy được độc lập, và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /shipment-join-grain\.test\.ts$/.test(process.argv[1])) {
  try {
    testShipmentJoinGrain();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
