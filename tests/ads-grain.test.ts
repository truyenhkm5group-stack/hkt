import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AD_GRAIN_TOLERANCE_VND, AD_SPEND_GRAIN_LABEL, decideGrain, type AdSpendGrain } from "@/lib/constants/ads-grain";
import { ADS_DIMENSION_HAS_SPEND, type AdsDimension } from "@/lib/constants/ads-decision";

/**
 * ═══════════ HẠT CHI TIÊU QUẢNG CÁO — CHỖ NGUY HIỂM NHẤT CỦA CẢ BỘ ĐỒNG BỘ ═══════════
 *
 * Đặc tả: `docs/ads-measurement-audit-2026-09-22.md` mục 4.
 *
 * `ad_spends` là nguồn thẩm quyền của tiền quảng cáo ở mọi báo cáo lợi nhuận, lương và marketer
 * (AGENTS.md mục 15). Để dòng cấp MẨU nằm cạnh dòng cấp CHIẾN DỊCH của **cùng một ngày** là nhân
 * đôi toàn bộ chi phí quảng cáo của ngày ấy — làm sai lợi nhuận và lương cùng một lúc, và sai theo
 * hướng ĐẸP LÊN ở bảng chi phí nên rất khó bị phát hiện bằng mắt.
 *
 * Ba nhóm được khoá ở đây:
 *
 *  ① BẢNG CHÂN LÝ CỦA CỔNG ĐỐI CHIẾU — hàm thuần, kiểm được bằng ba con số.
 *  ② ĐƯỜNG GHI phải có đủ ba lớp giữ, kiểm ở mức MÃ NGUỒN (một lời hứa trong tài liệu không chặn
 *    được ai, và lỗi này chỉ lộ ra ở bảng lợi nhuận vài tuần sau).
 *  ③ DÒNG GÕ TAY không bao giờ bị đường ghi xoá.
 */

const SYNC = "lib/integrations/facebook/sync.ts";

function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function testAdsGrain() {
  // ═══════════ ① BẢNG CHÂN LÝ CỦA CỔNG ĐỐI CHIẾU ═══════════

  const khop = decideGrain(1_000_000, 1_000_000, 12);
  assert.equal(khop.verdict, "AD_OK");
  assert.equal(khop.grain, "AD", "khớp thì mới được hạ hạt");
  assert.equal(khop.delta, 0);

  // Làm tròn từng dòng của Facebook: lệch trong dung sai vẫn là KHỚP.
  const lamTron = decideGrain(1_000_000, 1_000_000 + AD_GRAIN_TOLERANCE_VND - 1, 12);
  assert.equal(lamTron.grain, "AD", "lệch dưới dung sai là phép làm tròn, không phải tiền biến mất");

  /*
    LỆCH QUÁ DUNG SAI ⇒ LÙI VỀ HẠT CHIẾN DỊCH, KHÔNG PHẢI "GHI ĐẠI RỒI SỬA SAU".

    Nguyên tắc: thà một ngày ở hạt thô còn hơn một ngày sai tiền. Hạt chiến dịch vẫn cho TỔNG đúng,
    chỉ là không có chi tiết cấp mẩu — mất chi tiết thì nhìn thấy được, mất tiền thì không.
  */
  const lech = decideGrain(1_000_000, 700_000, 12);
  assert.equal(lech.verdict, "MISMATCH");
  assert.equal(lech.grain, "CAMPAIGN", "lệch thì PHẢI lùi về hạt chiến dịch");
  assert.equal(lech.delta, -300_000);
  assert.ok(lech.reason.includes("300.000"), "lý do phải in con số lệch, không nói chung chung");

  // Lệch theo chiều DƯƠNG cũng là lệch — cấp mẩu nhiều hơn cấp chiến dịch nghĩa là đang đếm đúp.
  assert.equal(decideGrain(1_000_000, 1_400_000, 12).grain, "CAMPAIGN", "cấp mẩu NHIỀU hơn cũng phải lùi — đó là hình dạng của phép cộng đúp");

  /*
    KHÔNG CÓ DÒNG NÀO Ở CẤP MẨU là câu trả lời thứ BA, không phải "lệch".

    Hai thứ ấy sửa ở hai chỗ khác nhau: một cái là Facebook không trả gì (quyền token, hoặc ngày ấy
    thật sự không mẩu nào chạy), cái kia là trả nhưng không cộng đủ. Gộp lại là đẩy người đọc đi
    sửa nhầm chỗ.
  */
  const khongCo = decideGrain(1_000_000, 0, 0);
  assert.equal(khongCo.verdict, "NO_AD_DATA");
  assert.equal(khongCo.grain, "CAMPAIGN");
  assert.notEqual(khongCo.verdict, "MISMATCH", "không có dữ liệu KHÁC với lệch — hai cách sửa khác nhau");

  // Ngày không tiêu đồng nào: không có gì để đối chiếu, và cũng không có gì để sai.
  assert.equal(decideGrain(0, 0, 0).verdict, "NO_AD_DATA");

  // Ba hạt đều phải có nhãn đọc được.
  for (const g of ["CAMPAIGN", "AD", "MANUAL"] as AdSpendGrain[]) assert.ok(AD_SPEND_GRAIN_LABEL[g], `hạt ${g} chưa có nhãn`);

  // ═══════════ ② ĐƯỜNG GHI CÓ ĐỦ BA LỚP GIỮ ═══════════

  const sync = boChuThich(readFileSync(SYNC, "utf8"));

  assert.ok(sync.includes("decideGrain("), `${SYNC} phải đi qua cổng đối chiếu — không được tự quyết hạt`);

  /*
    LỚP ② CỦA ĐƯỜNG GHI: dọn đúng thứ lượt này KHÔNG ghi ra.

    `notInArray` trên `external_key` là thứ vừa chuyển hạt sạch sẽ, vừa dọn dòng của mẩu đã bị xoá
    trên Facebook. Thiếu nó thì dòng hạt cũ NẰM LẠI cạnh dòng hạt mới — đúng hình dạng của phép
    cộng đúp mà cả bài kiểm này sinh ra để chặn.
  */
  assert.ok(sync.includes("notInArray"), `${SYNC} phải dọn dòng tự động không còn được báo — thiếu nó là để hai hạt nằm cạnh nhau trong một ngày`);

  /*
    LỚP ③: dòng GÕ TAY không bao giờ bị xoá.

    `external_key IS NULL` là định nghĩa của dòng nhập tay, và mệnh đề `isNotNull` trong phép xoá là
    thứ duy nhất giữ chúng lại. Mất nó thì mỗi lượt đồng bộ xoá sạch chi phí quảng cáo chủ shop gõ tay.
  */
  assert.ok(sync.includes("isNotNull(schema.adSpends.externalKey)"), `${SYNC} phải chừa dòng gõ tay ra khỏi phép xoá`);

  // Phép xoá phải bị RÀNG theo (nền tảng × tài khoản × ngày) — thiếu một vế là xoá lan sang ngày khác.
  for (const rang of ["eq(schema.adSpends.platform, PLATFORM)", "eq(schema.adSpends.accountId, account.accountId)", "eq(schema.adSpends.spendDate, vnStartOfDay(date))"]) {
    assert.ok(sync.includes(rang), `phép xoá thiếu ràng buộc ${rang} — nó sẽ xoá lan ra ngoài ngày đang ghi`);
  }

  /*
    CẤP MẨU HỎNG KHÔNG ĐƯỢC KÉO THEO CẢ LƯỢT ĐỒNG BỘ.

    Quyền token thiếu hay Facebook trả lỗi chỉ có nghĩa "hôm nay chưa có chi tiết cấp mẩu", không
    có nghĩa "chi tiêu quảng cáo hôm nay không tồn tại". Không có nhánh rơi về mảng rỗng thì một
    lỗi ở cấp mẩu sẽ làm MẤT TOÀN BỘ số liệu chi tiêu của tài khoản đó.
  */
  assert.ok(/fetchAdInsights\([\s\S]{0,400}\.catch\(/.test(sync), "lỗi ở cấp mẩu phải rơi về mảng rỗng, không được ném lên làm hỏng cả tài khoản");

  /*
    ─── PHÁN QUYẾT HẠT PHẢI NÓI RA ĐƯỢC, KHÔNG CHỈ GHI VÀO `ctx.log` ───

    Đo production 22/09/2026, lượt chạy đầu tiên sau khi hạ hạt: 19/35 chiến dịch của hôm ấy vẫn ở
    hạt CHIẾN DỊCH và KHÔNG AI TRA ĐƯỢC VÌ SAO. `runSyncJob` chỉ giữ 5 DÒNG CUỐI của `ctx.log`, và
    chỉ đổ chúng vào `sync_runs.error` khi lượt chạy có `warning` — với 7 tài khoản × 3 ngày thì lý
    do bị đẩy ra ngoài cửa sổ trước khi ai kịp đọc.

    Một cổng an toàn im lặng lùi về phía an toàn là một cổng KHÔNG SỬA ĐƯỢC.
  */
  assert.ok(sync.includes("ctx.summary.warning"), `${SYNC}: lùi hạt phải ra summary.warning (⇒ lượt chạy PARTIAL kèm lý do đọc được), không chỉ ra ctx.log`);
  /*
    ─── ĐẾM SỐ LẦN GÁN `detail`, KHÔNG CHỈ TÌM THẤY MỘT LẦN ───

    Bản trước của bài kiểm này hỏi "có dòng nào gán `detail` kèm chữ hạt MẨU không" và nó XANH —
    trong khi lần gán ấy bị một lần gán khác ở cuối hàm GHI ĐÈ, nên số liệu hạt không bao giờ tới
    được `sync_runs`. Đo production 22/09/2026 mới thấy: `detail` in đúng câu cũ suốt hai lượt chạy
    sau khi vá.

    Một bộ gác đúng mà vô dụng còn nguy hiểm hơn không có bộ gác: nó làm người ta thôi đi kiểm.
    Nên nay ràng buộc mạnh hơn: trong cả hàm chỉ được có ĐÚNG HAI lần gán `detail` — một câu mở đầu
    trước vòng lặp, và một câu cuối cùng; và câu CUỐI phải mang số liệu hạt.
  */
  const lanGanDetail = (sync.match(/ctx\.summary\.detail = /g) ?? []).length;
  assert.equal(lanGanDetail, 2, `${SYNC}: chỉ được gán summary.detail đúng 2 lần (mở đầu + kết luận), đang thấy ${lanGanDetail} — lần gán sau ghi đè lần trước và số liệu hạt biến mất`);
  const ganCuoi = sync.slice(sync.lastIndexOf("ctx.summary.detail = "));
  assert.ok(
    ganCuoi.split("\n")[0].includes("hạt MẨU"),
    `${SYNC}: LẦN GÁN CUỐI của summary.detail phải mang số (tài khoản × ngày) ở mỗi hạt — lần gán nào trước đó cũng bị nó ghi đè`,
  );

  // Sổ mẩu KHÔNG được ghi đè `post_id` — đó là mắt xích nối đơn về chiến dịch, do job khác điền.
  const capNhat = sync.slice(sync.indexOf("async function capNhatSoMauVaNhom"));
  assert.ok(!capNhat.includes("postId:"), "cập nhật sổ mẩu KHÔNG được đụng post_id — insights không trả nó, ghi NULL đè lên là xoá mắt xích nối đơn");

  // ═══════════ ③ BỐN CẤP NAY ĐỀU CÓ SỐ CHI ═══════════

  const caps: AdsDimension[] = ["campaign", "product", "adset", "ad"];
  for (const c of caps) assert.equal(ADS_DIMENSION_HAS_SPEND[c], true, `cấp ${c} phải có số chi sau khi hạ hạt`);

  console.log("  ✓ Hạt chi tiêu: cổng đối chiếu 3 phán quyết · lùi về hạt thô khi lệch · đường ghi dọn đúng phạm vi · chừa dòng gõ tay · không đụng post_id");
}
