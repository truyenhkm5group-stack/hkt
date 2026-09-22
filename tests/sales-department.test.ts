import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { SALES_STAGES, type SalesStage } from "@/lib/constants/sales-agent";
import {
  FUNNEL_BEYOND_REACH,
  FUNNEL_LAST_STEP,
  SALES_FUNNEL,
  funnelStep,
  reachedOrder,
} from "@/lib/constants/sales-ai-funnel";
import {
  AUTONOMY_GATES,
  AUTONOMY_RUNGS,
  DEMOTION_TRIGGERS,
  RUNG_REQUIREMENTS,
  evaluateAutonomy,
  rungBelow,
  type AutonomyReading,
} from "@/lib/constants/sales-autonomy";
import { COST_UNKNOWN_REASON, salesFunnel, salesUnitEconomics } from "@/lib/queries/sales-economics";
import { setSettingJson } from "@/lib/settings";

/** Số đo "mọi thứ đều đẹp" — từng phép thử chỉ đổi ĐÚNG một chiều so với nền này. */
function readingOk(patch: Partial<AutonomyReading> = {}): AutonomyReading {
  return {
    sample: 500,
    humanGraded: 120,
    fabrications: 0,
    usableRate: 0.95,
    unpricedCalls: 0,
    costCapHit: false,
    hardLimitsConsistent: true,
    ...patch,
  };
}

export async function testSalesDepartment(db: Db) {
  // ═════════ 1. SỔ PHỄU PHẢI KHỚP SỔ GIAI ĐOẠN ═════════
  //
  // Hai sổ nói về cùng một thang bậc. Lệch nhau thì màn hình vẽ một phễu mà dây chuyền không bao
  // giờ đi qua — và không ai phát hiện ra, vì cả hai phía đều "đúng" theo sổ của mình.
  for (const b of SALES_FUNNEL) {
    assert.ok((SALES_STAGES as readonly string[]).includes(b.stage), `bậc ${b.stage} không có trong SALES_STAGES`);
  }
  const thuTu = SALES_FUNNEL.map((b) => b.order);
  assert.deepEqual(thuTu, [...thuTu].sort((a, b) => a - b), "phễu phải khai theo đúng thứ tự tăng dần");
  assert.deepEqual(thuTu, [...new Set(thuTu)], "hai bậc không được mang cùng một số thứ tự");
  assert.equal(FUNNEL_LAST_STEP, thuTu[thuTu.length - 1], "bậc cuối phải DẪN XUẤT, không gõ tay");

  // Mỗi bậc không phải AI_ALONE phải nói được ĐANG VƯỚNG GÌ — cụ thể tới mức sửa được.
  for (const b of SALES_FUNNEL) {
    if (b.autonomy === "AI_ALONE") assert.equal(b.blockedBy, "", `${b.stage}: AI tự đi được thì không được khai vướng mắc`);
    else assert.ok(b.blockedBy.length > 30, `${b.stage}: phải nói rõ đang vướng gì, không phải "cần thêm dữ liệu"`);
  }

  /*
    NHÁNH RẼ KHÔNG PHẢI MỘT BẬC.

    Đây là tính chất dễ mất nhất khi ai đó thêm một giai đoạn: `HUMAN_TAKEOVER` lọt vào phễu thì
    205 hội thoại người đã cầm (đo 22/09/2026) bỗng đọc ra thành "đã đi tới bậc N", và tỷ lệ đi
    tiếp của mọi bậc phía trên đều sai theo.
  */
  for (const nhanh of ["HUMAN_TAKEOVER", "LOST", "OBJECTION", "FOLLOW_UP"] as SalesStage[]) {
    assert.equal(funnelStep(nhanh), null, `${nhanh} là nhánh rẽ, không được nằm trên phễu`);
    assert.equal(reachedOrder(nhanh), null, `${nhanh} phải trả CHƯA BIẾT, không phải một con số bậc`);
  }

  // Trần cứng của nhà cung cấp phải đứng NGOÀI phễu, nếu không phễu không bao giờ chạm 100%.
  assert.equal(FUNNEL_BEYOND_REACH.autonomy, "HUMAN_ONLY");
  assert.ok(
    !SALES_FUNNEL.some((b) => b.stage === (FUNNEL_BEYOND_REACH.stage as SalesStage)),
    "chốt đơn trên POS không có API — không được khai như một bậc AI sẽ đạt tới",
  );
  assert.ok(FUNNEL_BEYOND_REACH.blockedBy.includes("update-order"), "phải nói đúng endpoint đang thiếu");

  // ═════════ 2. PHANH TỰ CHỦ ═════════
  //
  // Bất đối xứng là cả thiết kế: LÊN cần người bấm, XUỐNG máy tự làm. Mất tính chất này thì
  // "phòng tự vận hành" nghĩa là không ai dừng được nó đúng lúc cần dừng nhất.

  assert.equal(evaluateAutonomy("COPILOT", readingOk()).effective, "COPILOT", "số đo đẹp thì giữ nguyên nấc");
  assert.deepEqual(evaluateAutonomy("COPILOT", readingOk()).demotedBy, []);

  // Số đo đẹp KHÔNG tự nâng nấc — lên bậc là việc của người bấm.
  assert.equal(evaluateAutonomy("SHADOW", readingOk()).effective, "SHADOW", "số đo đẹp không được tự trao thêm quyền");

  // MỘT lượt bịa ⇒ tụt ngay, không đợi lượt thứ hai.
  const biaDat = evaluateAutonomy("AUTO", readingOk({ fabrications: 1 }));
  assert.equal(biaDat.effective, "COPILOT", "một câu bịa là một khách mất niềm tin — tụt ngay");
  assert.ok(biaDat.demotedBy.includes("FABRICATION"));

  // Tỷ lệ dùng được tồi TRÊN MẪU ĐỦ LỚN mới là bằng chứng.
  assert.deepEqual(
    evaluateAutonomy("COPILOT", readingOk({ usableRate: 0.1, sample: 5 })).demotedBy,
    [],
    "5 lượt tồi là xui, không phải bằng chứng — không được phanh vì nó",
  );
  assert.ok(
    evaluateAutonomy("COPILOT", readingOk({ usableRate: 0.1, sample: 50 })).demotedBy.includes("USABLE_RATE_FLOOR"),
    "50 lượt mà chỉ 10% dùng được thì đó là bằng chứng",
  );

  /*
    NGƯỠNG TỤT PHẢI LỎNG HƠN NGƯỠNG LÊN, nếu không hệ sẽ RUNG.

    Hai ngưỡng bằng nhau thì một tỷ lệ dao động quanh đúng con số ấy sẽ đẩy máy lên rồi tụt rồi
    lên — và mỗi lần đổi nấc là một lần đổi hành vi với khách THẬT.
  */
  const lenCopilot = RUNG_REQUIREMENTS.COPILOT;
  assert.ok(lenCopilot, "phải khai điều kiện lên nấc COPILOT");
  assert.ok(
    DEMOTION_TRIGGERS.usableRateFloor < lenCopilot.minUsableRate!,
    "sàn tụt phải THẤP HƠN ngưỡng lên — bằng nhau là hệ rung quanh một con số",
  );

  // SHADOW / OFF không chạm tới khách ⇒ không có gì để phanh.
  assert.deepEqual(
    evaluateAutonomy("SHADOW", readingOk({ fabrications: 9, usableRate: 0, sample: 999 })).demotedBy,
    [],
    "SHADOW không gửi gì cho ai — phanh nó là phanh đúng cái đang học miễn phí",
  );

  // Chi phí KHÔNG ĐO ĐƯỢC chỉ phanh AUTO. Ở COPILOT vẫn có người đọc từng tin.
  assert.ok(
    evaluateAutonomy("AUTO", readingOk({ unpricedCalls: 12 })).demotedBy.includes("COST_UNKNOWN"),
    "tự chạy mà chưa biết tốn bao nhiêu là ký séc trắng",
  );
  assert.deepEqual(
    evaluateAutonomy("COPILOT", readingOk({ unpricedCalls: 12 })).demotedBy,
    [],
    "ở COPILOT, chi phí chưa đo được là việc đi khai giá — không phải lý do dừng bán hàng",
  );

  // Chặn cứng lệch nấc khai ⇒ tin vào chặn cứng, và phải HIỆN RA.
  assert.ok(
    evaluateAutonomy("AUTO", readingOk({ hardLimitsConsistent: false })).demotedBy.includes("HARD_LIMIT_MISMATCH"),
  );

  // Tụt đúng MỘT nấc mỗi lần, và OFF là đáy.
  assert.equal(rungBelow("AUTO"), "COPILOT");
  assert.equal(rungBelow("COPILOT"), "SHADOW");
  assert.equal(rungBelow("OFF"), "OFF", "OFF không tụt được nữa");
  assert.equal(AUTONOMY_RUNGS[0], "OFF", "đáy thang phải là nấc an toàn nhất");

  // ═════════ 3. CỬA LÊN NẤC NÓI THIẾU GÌ, KHÔNG CHỈ NÓI KHÔNG ═════════
  const chuaDu = evaluateAutonomy("SHADOW", readingOk({ sample: 5, humanGraded: 0, usableRate: null }));
  assert.equal(chuaDu.nextRung, "COPILOT");
  assert.ok(chuaDu.blocking.length >= 2, "phải liệt kê TỪNG cổng còn thiếu, không gộp thành một chữ 'chưa đạt'");
  assert.ok(
    chuaDu.blocking.some((b) => b.includes("người chấm tay")),
    "chưa ai chấm tay là cổng phải nêu đích danh — nó là việc của người, không phải của máy",
  );
  // Mẫu số rỗng phải đọc ra CHƯA BIẾT, không phải 0% (luật 42).
  assert.ok(
    chuaDu.blocking.some((b) => b.includes("CHƯA BIẾT")),
    "chưa lượt nào được quyết định thì tỷ lệ là CHƯA BIẾT — 'đợi thêm' khác hẳn 'làm kém'",
  );

  // Sáu cổng, mỗi cổng một lý do tồn tại. Một cổng không giải thích được sẽ bị ai đó nới ra.
  assert.equal(AUTONOMY_GATES.length, 6);
  assert.deepEqual([...new Set(AUTONOMY_GATES.map((g) => g.key))].length, AUTONOMY_GATES.length, "khoá cổng phải duy nhất");
  for (const g of AUTONOMY_GATES) assert.ok(g.why.length > 40, `cổng ${g.key} phải nói được vì sao nó tồn tại`);

  // AUTO phải khắt khe hơn COPILOT ở MỌI chiều — không được có chiều nào dễ hơn.
  const auto = RUNG_REQUIREMENTS.AUTO!;
  assert.ok(auto.minSample > lenCopilot.minSample);
  assert.ok(auto.minHumanGraded > lenCopilot.minHumanGraded);
  assert.ok(auto.minUsableRate! > lenCopilot.minUsableRate!);
  assert.equal(auto.requireKnownCost, true, "nấc duy nhất không ai đọc trước khi gửi phải biết nó tốn bao nhiêu");

  // ═════════ 4. TIỀN: CHƯA BIẾT KHÔNG ĐƯỢC THÀNH 0 ═════════
  await setSettingJson(AI_CONFIG_KEY, {});

  // 4a. Chưa có lượt gọi mô hình nào ⇒ chưa có đơn ⇒ chi phí mỗi đơn là CHƯA BIẾT vì MẪU SỐ RỖNG.
  const kt0 = await salesUnitEconomics(30, db);
  assert.equal(kt0.costPerOrder, null, "chưa có đơn thì chi phí mỗi đơn KHÔNG tồn tại — không phải 0 ₫");
  assert.ok(kt0.costPerOrderUnknownBecause.length > 0, "phải nói được vì sao chưa biết");

  // 4b. Thêm một lượt gọi CHƯA ĐỊNH GIÁ ⇒ tử số mù ⇒ MỌI phép chia là CHƯA BIẾT, kể cả
  //     chi phí mỗi hội thoại (vốn có mẫu số khác rỗng).
  await db.insert(schema.aiModelCalls).values({
    provider: "erp:openai",
    model: "mo-hinh-chua-khai-gia-kt",
    tier: "ECONOMY",
    step: "understand",
    inputTokens: 100,
    outputTokens: 50,
    costVnd: null,
  });
  const ktMu = await salesUnitEconomics(30, db);
  assert.ok(ktMu.unpricedCalls > 0);
  assert.equal(ktMu.costPerConversation, null, "tử số mù thì mẫu số đẹp cũng không cứu được phép chia");
  assert.equal(ktMu.costPerOrderUnknownBecause, COST_UNKNOWN_REASON.UNPRICED, "phải phân biệt tử số mù với mẫu số rỗng");

  // 4c. Định giá xong mà vẫn chưa có đơn ⇒ lý do ĐỔI sang mẫu số rỗng. Hai lý do, hai việc khác nhau:
  //     một cái đi khai bảng giá, cái kia đi bán hàng.
  await db
    .update(schema.aiModelCalls)
    .set({ costVnd: 5_000, pricingVersion: "kiem-thu" })
    .where(eq(schema.aiModelCalls.model, "mo-hinh-chua-khai-gia-kt"));
  const ktCoGia = await salesUnitEconomics(30, db);
  assert.equal(ktCoGia.unpricedCalls, 0);
  assert.equal(ktCoGia.costPerOrderUnknownBecause, COST_UNKNOWN_REASON.NO_DENOMINATOR);
  assert.equal(ktCoGia.costPerOrder, null, "vẫn chưa có đơn — vẫn CHƯA BIẾT");
  assert.ok((ktCoGia.costPerConversation ?? 0) >= 0, "chi phí mỗi hội thoại thì tính được ngay khi có giá");

  await db.delete(schema.aiModelCalls).where(eq(schema.aiModelCalls.model, "mo-hinh-chua-khai-gia-kt"));

  // ═════════ 5. PHỄU ĐẾM NGƯỢC, VÀ NHÁNH RẼ ĐỨNG NGOÀI ═════════
  const phieu = await salesFunnel(3650, db);
  assert.equal(phieu.rows.length, SALES_FUNNEL.length);

  // `reached` phải KHÔNG TĂNG khi đi xuống — đó là định nghĩa của một cái phễu. Đếm xuôi thay vì
  // cộng dồn ngược sẽ tạo ra một cái phễu phình ra ở giữa, và không ai nhìn ra bằng mắt.
  for (let i = 1; i < phieu.rows.length; i += 1) {
    assert.ok(
      phieu.rows[i].reached <= phieu.rows[i - 1].reached,
      `bậc ${phieu.rows[i].order} không được có nhiều hội thoại hơn bậc trước — phễu không phình ra được`,
    );
  }

  // Hội thoại ở nhánh rẽ KHÔNG được cộng vào bất kỳ bậc nào của phễu.
  const tongNhanh = phieu.branches.reduce((s, b) => s + b.n, 0);
  const tongPheu = phieu.rows.reduce((s, r) => s + r.resting, 0);
  assert.equal(tongNhanh + tongPheu, phieu.conversations, "mọi hội thoại phải nằm ở ĐÚNG một phía: trên phễu hoặc ở nhánh rẽ");

  // Bậc cuối không có bậc sau ⇒ tỷ lệ đi tiếp là KHÔNG ÁP DỤNG, không phải 0%.
  assert.equal(phieu.rows[phieu.rows.length - 1].passRate, null, "bậc cuối không được mang một thất bại nó không có");

  console.log(
    `✓ Phòng Sales AI: phễu ${SALES_FUNNEL.length} bậc khớp sổ giai đoạn · nhánh rẽ đứng ngoài · chốt đơn POS khai là NGOÀI TẦM (không có API) · ${AUTONOMY_GATES.length} cổng tự chủ · phanh chỉ HẠ không NÂNG · sàn tụt lỏng hơn ngưỡng lên nên hệ không rung`,
  );
  console.log(
    "✓ Kinh tế đơn vị Sales AI: tử số mù và mẫu số rỗng là HAI lý do khác nhau, mỗi lý do một việc phải làm · không phép chia nào rơi về 0 ₫",
  );
}
