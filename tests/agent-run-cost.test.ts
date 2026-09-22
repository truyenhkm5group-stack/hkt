import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { congChiPhiLuot, docChiPhiLuot, nhanChiPhi, nhanTongChiPhi } from "@/lib/constants/agent-run-cost";

/**
 * ═══════════ TIỀN CỦA PHÒNG TECH AI PHẢI HIỆN RA MÀN HÌNH ═══════════
 *
 * ĐÃ CẮN THẬT 22/09/2026: chủ shop hết sạch tín dụng API và hỏi *"tiền đi đâu"*. Không ai trả lời
 * được — kể cả tôi. Agent chạy trên máy GitHub Actions nên không có mặt trong `ai_interactions`,
 * tức đúng thứ tiêu nhiều nhất lại là thứ duy nhất không hiện ở đâu.
 *
 * Tiền nay đã về `tech_agent_runs.metadata.chiPhi`. Nhưng **dữ liệu có mà không ai nhìn thấy thì
 * vẫn là không đo được**: lần sau chủ shop vẫn sẽ phát hiện bằng cách hết tiền.
 *
 * ─── LUẬT QUAN TRỌNG NHẤT Ở ĐÂY ───
 *
 * Bốn trong năm lượt chạy của TECH-3 KHÔNG có chi phí, vì chúng chạy TRƯỚC khi đường ghi tiền tồn
 * tại. In chúng thành `$0` là nói dối đúng theo hướng dễ chịu: nhìn vào thì tưởng phòng này miễn
 * phí. Chúng phải hiện ra là CHƯA ĐO ĐƯỢC (mục 42), và KHÔNG được backfill (mục 8.8).
 */

const goc = path.resolve(__dirname, "..");

export function testTienLuotChay() {
  /* ───────── ĐỌC: BA CA KHÁC NHAU, BA KẾT QUẢ KHÁC NHAU ───────── */
  const cu = docChiPhiLuot({ source: "EXTERNAL_INGEST" });
  assert.deepEqual(cu, { usd: null, soVong: null, coGhi: false }, "dòng CŨ không có khoá chiPhi ⇒ chưa đo được, và nói rõ là không có bản ghi");

  const rong = docChiPhiLuot({ chiPhi: null });
  assert.equal(rong.usd, null, "có khoá nhưng null ⇒ vẫn là chưa đo được");
  assert.equal(rong.coGhi, false, "…và đó cũng là 'không có bản ghi'");

  const co = docChiPhiLuot({ chiPhi: { usd: 0.0895, soVong: 8, vao: 1, ra: 2, demDoc: 3, demGhi: 4 } });
  assert.deepEqual(co, { usd: 0.0895, soVong: 8, coGhi: true }, "có số thì đọc ra số");

  /* Một lượt CÓ ghi nhưng KHÔNG định giá được (một vòng không tra được giá) vẫn là chưa đo được. */
  const khongGia = docChiPhiLuot({ chiPhi: { usd: null, soVong: 5 } });
  assert.equal(khongGia.usd, null);
  assert.equal(khongGia.soVong, 5, "nhưng số vòng vẫn đọc được — chưa biết TIỀN không có nghĩa là chưa biết gì cả");
  assert.equal(khongGia.coGhi, true, "và nó KHÁC dòng cũ: có bản ghi, chỉ là không định giá được");

  /* Dữ liệu rác không được làm sập màn hình. */
  for (const rac of [null, undefined, "x", 7, { chiPhi: "abc" }, { chiPhi: { usd: "nhiều" } }]) {
    assert.doesNotThrow(() => docChiPhiLuot(rac), `metadata lạ (${JSON.stringify(rac)}) không được ném lỗi`);
    assert.equal(docChiPhiLuot(rac).usd, null, "và phải rơi về CHƯA ĐO ĐƯỢC, không phải 0");
  }

  /* ───────── IN: `—` CHỨ KHÔNG PHẢI `$0` ───────── */
  assert.equal(nhanChiPhi(co), "$0.0895");
  assert.equal(nhanChiPhi(cu), "—", "chưa đo được in ra — , KHÔNG in $0");
  assert.equal(nhanChiPhi({ usd: 0, soVong: 0, coGhi: true }), "$0.0000", "0 THẬT vẫn in ra 0 — đó là một phép đo, không phải một chỗ trống");

  /* ───────── CỘNG: TỔNG THIẾU PHẢI TỰ KHAI LÀ THIẾU ───────── */
  const t = congChiPhiLuot([co, cu, co]);
  assert.equal(t.usd, 0.179, "cộng phần định giá được");
  assert.equal(t.chuaDoDuoc, 1, "và đếm riêng phần chưa đo được");
  assert.match(nhanTongChiPhi(t), /cận dưới/, "tổng thiếu PHẢI tự khai là cận dưới — cộng im lặng rồi in như tổng đủ là nói dối bằng phép cộng");
  assert.match(nhanTongChiPhi(t), /1\/3/, "và nói rõ thiếu mấy trên mấy");

  const du = congChiPhiLuot([co, co]);
  assert.equal(nhanTongChiPhi(du), "$0.1790", "đủ thì in gọn, không thêm chữ thừa");

  /* Toàn bộ chưa đo được: tổng là $0 nhưng PHẢI kèm cảnh báo, nếu không nó trông y như miễn phí. */
  const toanCu = congChiPhiLuot([cu, cu]);
  assert.match(nhanTongChiPhi(toanCu), /cận dưới/, "không lượt nào đo được thì càng phải nói ra");

  console.log("✓ Tiền lượt chạy: dòng cũ · có ghi mà không định giá được · có số — ba ca ra ba kết quả · `—` chứ không phải $0 · tổng thiếu tự khai là cận dưới");
}

/* ═════════════ QUÉT MÃ NGUỒN ═════════════ */

export function testTienLuotChayGuards() {
  const bo = (m: string) => m.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const trangViec = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/tasks/[id]/page.tsx"), "utf8"));
  const tongQuan = bo(readFileSync(path.join(goc, "app/(dashboard)/tech/page.tsx"), "utf8"));
  const truyVan = bo(readFileSync(path.join(goc, "lib/queries/tech.ts"), "utf8"));

  /* Màn hình phải ĐI QUA hàm in, không tự định dạng — nếu không, luật `—` chỉ đúng ở một chỗ. */
  assert.match(trangViec, /nhanChiPhi\(/, "trang việc phải in tiền qua hàm chung");
  assert.match(tongQuan, /nhanTongChiPhi\(/, "trang tổng quan phải in tổng qua hàm chung");

  /*
    TỔNG 24 GIỜ PHẢI ĐẾM RIÊNG PHẦN CHƯA ĐO ĐƯỢC.

    Thiếu vế này thì con số trên màn hình là một tổng thiếu trông như tổng đủ — và phòng Tech AI
    hiện ra như miễn phí, đúng lúc chủ shop cần biết nó tốn bao nhiêu.
  */
  assert.match(truyVan, /chuaDoDuoc24h/, "truy vấn phải đếm riêng số lượt chưa đo được");
  assert.match(truyVan, /filter \(where .* is null\)/, "và đếm bằng điều kiện NULL thật, không suy từ tổng");

  console.log("✓ Quét mã nguồn: hai màn hình đều in qua hàm chung · tổng 24 giờ đếm riêng phần chưa đo được");
}
