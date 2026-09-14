import assert from "node:assert/strict";
import { clearMemo, memo } from "@/lib/cache";

/**
 * ═══════ MỘT LƯỢT TÍNH BỊ BỎ RƠI KHÔNG ĐƯỢC LÀM TREO NGƯỜI ĐỌC ═══════
 *
 * SỰ CỐ THẬT (10/09/2026, sau deploy #197). Trang chủ production treo đúng 60 giây, ba lượt đo liên
 * tiếp, trên một máy chủ RẢNH — `pg_stat_activity` không có truy vấn nào đang chạy. Mọi trang khác
 * vẫn 70–170ms, nên nhìn từ ngoài trông như một trang bị lỗi riêng.
 *
 * Nguyên nhân nằm ở cơ chế gộp lời gọi trùng khoá của `memo`: mục `inflight` không có trần thời
 * gian. Job giữ ấm chạy qua `POST /api/sync/dashboard-warm?wait=0` — máy chủ trả lời NGAY rồi bỏ
 * rơi công việc phía sau. Lượt tính bị bỏ rơi không bao giờ kết thúc ⇒ mục `inflight` nằm lại vĩnh
 * viễn ⇒ mọi người đọc sau đó chờ một lời hứa đã chết, cho tới khi khởi động lại ứng dụng.
 *
 * Đây là loại lỗi không bài kiểm đơn vị thông thường nào bắt được: mã đúng cú pháp, mọi kiểm thử
 * dùng hàm kết thúc bình thường đều xanh. Nó chỉ lộ ra khi có một lượt tính KHÔNG BAO GIỜ xong.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/memo-inflight.test.ts
 */
export async function testMemoInflight() {
  clearMemo();

  // ───────── 1. Gộp lời gọi vẫn phải hoạt động ─────────
  let dem = 0;
  const cham = async () => {
    dem += 1;
    await new Promise((r) => setTimeout(r, 30));
    return dem;
  };
  const [a, b] = await Promise.all([memo("gop", 60_000, cham), memo("gop", 60_000, cham)]);
  assert.equal(a, b, "hai lời gọi đồng thời cùng khoá phải dùng chung một lượt tính");
  assert.equal(dem, 1, "không được tính hai lần cho cùng một khoá");

  // ───────── 2. LƯỢT BỊ BỎ RƠI: người đọc sau KHÔNG được chờ mãi ─────────
  //
  // Mô phỏng đúng job giữ ấm bị cắt ngang: một hàm không bao giờ kết thúc, đúng như công việc bị bỏ
  // rơi sau khi máy chủ đã trả lời.
  const treoMaiMai = () => new Promise<number>(() => {});
  const boRoi = memo("bo-roi", 60_000, treoMaiMai);
  // Không await `boRoi` — nó sẽ không bao giờ xong, y như trên production.
  void boRoi.catch(() => {});

  // Trước khi hết trần: người đọc thứ hai vẫn gộp vào lượt đang chạy. Đó là hành vi ĐÚNG — chưa có
  // căn cứ nào nói lượt kia đã chết.
  const trongTran = await Promise.race([
    memo("bo-roi", 60_000, async () => "khong-nen-chay").then(() => "xong"),
    new Promise<string>((r) => setTimeout(() => r("van-cho"), 60)),
  ]);
  assert.equal(trongTran, "van-cho", "trong trần thời gian, người đọc thứ hai vẫn phải gộp vào lượt đang chạy");

  // ───────── 3. QUÁ TRẦN: phải tính lại, KHÔNG chờ lượt đã chết ─────────
  //
  // Hạ trần xuống mili giây thay vì chờ đủ 20 giây thật. Đây chính là điều production cần: một lượt
  // bị bỏ rơi phải mất quyền gộp, và người đọc tiếp theo tự tính lấy.
  const cu = process.env.MEMO_INFLIGHT_TIMEOUT_MS;
  process.env.MEMO_INFLIGHT_TIMEOUT_MS = "40";
  try {
    const chet = memo("da-chet", 60_000, treoMaiMai);
    void chet.catch(() => {});
    await new Promise((r) => setTimeout(r, 80));
    const cuuDuoc = await Promise.race([
      memo("da-chet", 60_000, async () => "tinh-lai-duoc"),
      new Promise<string>((r) => setTimeout(() => r("VAN-TREO"), 500)),
    ]);
    assert.equal(cuuDuoc, "tinh-lai-duoc", "quá trần mà vẫn chờ lượt đã chết ⇒ trang chủ treo tới khi khởi động lại ứng dụng");
  } finally {
    if (cu === undefined) delete process.env.MEMO_INFLIGHT_TIMEOUT_MS;
    else process.env.MEMO_INFLIGHT_TIMEOUT_MS = cu;
  }

  console.log("✓ Bộ đệm: gộp lời gọi trùng khoá vẫn tính một lần · trong trần vẫn gộp · QUÁ TRẦN thì tính lại thay vì chờ một lượt đã bị bỏ rơi vĩnh viễn");
}

if (process.argv[1] && /memo-inflight\.test\.ts$/.test(process.argv[1])) {
  void testMemoInflight();
}
