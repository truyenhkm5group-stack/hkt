import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AdsAction } from "@/lib/constants/ads-decision";
import {
  ACTION_FOR_DECISION,
  ADS_WRITE_LIMITS,
  ALLOW_ADS_WRITE_ON_PROJECTED_BASIS,
  MAX_ALLOWED_ADS_WRITE_MODE,
  clampAdsWriteMode,
} from "@/lib/constants/ads-write";
import { BRAKE_OFF, brakeState, gateAdsWrite, nextBudgetFor, planProductBudget, subjectFreshness, type GateInput, type PlanTarget } from "@/lib/marketing/ads-write-gate";
import type { Db } from "@/db";
import { schema } from "@/db";
import { eq, inArray } from "drizzle-orm";
import { brakeObservations } from "@/lib/integrations/facebook/ads-write";
import type { Stability } from "@/lib/marketing/decision-stability";

/**
 * ═══════════ BÀN TAY CỦA PHÒNG MARKETING — HÀNG RÀO PHẢI ĐÚNG TRƯỚC KHI CÓ TIỀN ĐI QUA ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md` mục 5.
 *
 * Khối này khoá bốn nhóm, và cả bốn đều là chỗ một cỗ máy tiêu tiền hỏng theo kiểu không ai thấy:
 *
 *  1. **CHỈ MỘT TỆP GỌI API GHI.** Kiểm ở mức MÃ NGUỒN, vì một lời hứa trong tài liệu không chặn
 *     được ai. Đây là bài kiểm quan trọng nhất của cả khối: nó là thứ làm cho câu *"chưa bật thì
 *     không đổi được ngân sách nào"* kiểm chứng được bằng cách đọc một tệp.
 *  2. **TRẦN CỨNG KHÔNG VƯỢT ĐƯỢC TỪ CẤU HÌNH.** Khai `AUTO` ở đâu cũng bị kẹp xuống.
 *  3. **BẢNG CHÂN LÝ CỦA CỔNG**, kể cả THỨ TỰ các chốt.
 *  4. **PHANH** — và nhất là cách nó xử lý lượt CHƯA ĐO ĐƯỢC.
 */

/** Không có tệp nào ngoài cửa ghi được phép nhắc tới API ghi của Facebook. */
const CUA_GHI = "lib/integrations/facebook/ads-write.ts";

function moiTepNguon(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p.split(path.sep).join("/"));
    }
  };
  for (const root of ["lib", "app", "scripts"]) walk(root);
  return out;
}

/** Bỏ chú thích trước khi quét: cái bẫy chú thích đã cắn năm lần trong kho này. */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const HEALTHY_STABILITY: Stability = {
  action: "CUT",
  heldDays: 5,
  flips: 0,
  missingDays: 0,
  staleDays: 0,
  ready: true,
  blocker: null,
  reason: "ổn định",
};

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    hardEnabled: true,
    mode: "COPILOT",
    confirmed: true,
    decision: "SCALE",
    basis: "ACTUAL",
    subject: { status: "ACTIVE", spendInWindowVnd: 2_000_000, spendAfterWindowVnd: 500_000 },
    level: "campaign",
    stability: { ...HEALTHY_STABILITY, action: "SCALE" },
    currentBudgetVnd: 1_000_000,
    nextBudgetVnd: 1_200_000,
    shiftedTodayVnd: 0,
    changesForCampaignToday: 0,
    brake: BRAKE_OFF,
    ...over,
  };
}

export function testAdsWrite() {
  // ═══════════ PHẦN A — CHỈ MỘT TỆP GỌI API GHI ═══════════

  const client = readFileSync("lib/integrations/facebook/client.ts", "utf8");
  /*
    `client.ts` PHẢI GIỮ NGUYÊN LÀ CHỈ-ĐỌC.

    Toàn bộ lời khẳng định của Nấc 3 đứng trên tính chất này. Ngày nào có người thêm một `method:
    "POST"` vào đây thì "cửa ghi duy nhất" thành hai cửa, và cửa thứ hai không có chốt cứng, không
    có sổ, không có trần.
  */
  for (const cam of ['method: "POST"', "method: 'POST'", "daily_budget", "lifetime_budget"]) {
    assert.ok(!boChuThich(client).includes(cam), `lib/integrations/facebook/client.ts phải giữ nguyên CHỈ-ĐỌC, nhưng có "${cam}". Mọi phép ghi đi qua ${CUA_GHI}.`);
  }

  const nhacToiGhi: string[] = [];
  for (const tep of moiTepNguon()) {
    if (tep === CUA_GHI) continue;
    const src = boChuThich(readFileSync(tep, "utf8"));
    // Dấu hiệu gọi thẳng Graph API để GHI: đụng tới graph.facebook.com kèm một trường chỉ có ở phép ghi.
    if (src.includes("graph.facebook.com") && (src.includes("daily_budget") || src.includes('"PAUSED"'))) nhacToiGhi.push(tep);
  }
  assert.deepEqual(nhacToiGhi, [], `Chỉ ${CUA_GHI} được gọi API ghi của Facebook. Tệp vi phạm: ${nhacToiGhi.join(", ")}`);

  /*
    CHỐT CỨNG PHẢI ĐỨNG NGAY TRONG LỜI GỌI MẠNG, không phải một lần ở đầu hàm.

    `assertAdsWriteAllowed()` nằm ở dòng đầu của `graphPost` để một đường gọi mới thêm sau này không
    lách được bằng cách bỏ qua hàm bọc ngoài.
  */
  const cuaGhi = readFileSync(CUA_GHI, "utf8");
  assert.ok(/async function graphPost[\s\S]{0,200}assertAdsWriteAllowed\(\)/.test(cuaGhi), "assertAdsWriteAllowed() phải được gọi ngay đầu graphPost, trước khi dựng request");
  assert.ok(boChuThich(cuaGhi).includes("retries: 0"), "lời gọi GHI không được tự thử lại — Graph API không nhận khoá chống trùng");

  /*
    MỖI BÀI MỘT CHIẾN DỊCH (chủ shop 25/09/2026, `docs/creative-loop.md` §5i) — HAI lời ghi mới, có chủ đích,
    và cả hai nằm TRONG cửa ghi, đi qua `graphPost`: tạo chiến dịch (luôn `status=PAUSED`, không trường ngân
    sách nào — tiền nằm ở NHÓM trọn đời) và bật đúng chiến dịch ấy (đúng một trường `status`). Danh sách cho
    phép được mở RỘNG đúng hai hàm này, không nới luật chung: không tệp nào khác được chạm Graph API ghi.
  */
  const ghi = boChuThich(cuaGhi);
  assert.ok(/export async function createTestCampaign[\s\S]{0,300}graphPost\(actPath\(accountId, "campaigns"\), testCampaignFields\(/.test(ghi), "tạo chiến dịch riêng phải đi qua graphPost với đúng testCampaignFields");
  assert.ok(/export async function activateTestCampaign[\s\S]{0,200}graphPost\(assertFbId\(campaignId, "id chiến dịch"\), \{ status: "ACTIVE" \}\)/.test(ghi), "bật chiến dịch riêng = đúng một trường status qua graphPost");
  const truongCd = ghi.slice(ghi.indexOf("export function testCampaignFields"), ghi.indexOf("export async function createTestCampaign"));
  assert.ok(truongCd.includes('status: "PAUSED"') && !truongCd.includes("daily_budget") && !truongCd.includes("lifetime_budget: String"), "chiến dịch riêng luôn tạo TẮT và không mang ngân sách");

  // Chốt ngoài cùng chỉ nhận ĐÚNG chuỗi "true": `1`, `yes`, `on` đều là CẤM.
  const envSrc = boChuThich(readFileSync("lib/env.ts", "utf8"));
  assert.ok(envSrc.includes('process.env.ADS_WRITE_ENABLED === "true"'), "ADS_WRITE_ENABLED phải đọc THẲNG từ process.env và chỉ nhận đúng chuỗi \"true\"");
  assert.ok(!envSrc.includes("ads.write.enabled"), "chốt ngoài cùng KHÔNG được hợp nhất với bảng settings — ghi vào CSDL phải là ghi vào hư không");

  // ═══════════ PHẦN B — TRẦN CỨNG CỦA NẤC QUYỀN ═══════════

  assert.equal(MAX_ALLOWED_ADS_WRITE_MODE, "COPILOT", "Chủ shop duyệt COPILOT và CHỈ COPILOT (22/09/2026). Nâng lên AUTO là một quyết định MỚI.");
  assert.equal(clampAdsWriteMode("AUTO"), "COPILOT", "khai AUTO ở env cũng phải bị kẹp xuống");
  assert.equal(clampAdsWriteMode("COPILOT"), "COPILOT");
  assert.equal(clampAdsWriteMode("OFF"), "OFF", "kẹp chỉ LÀM HẸP, không bao giờ nới ra");

  // Bước đề nghị phải THẤP HƠN trần: một cái trần bị chạm mỗi ngày thì không còn là trần.
  assert.ok(ADS_WRITE_LIMITS.proposeStepPct < ADS_WRITE_LIMITS.maxStepPct, "bước đề nghị mặc định phải thấp hơn trần biên độ");

  // Mọi khuyến nghị phải được khai có/không đẻ ra hành động. Thiếu một khoá là `undefined` lọt xuống cổng.
  const MOI_HANH_DONG: AdsAction[] = ["SCALE", "HOLD", "WATCH", "CUT", "FIX_DELIVERY", "INSUFFICIENT_DATA", "NO_SPEND_DATA"];
  for (const a of MOI_HANH_DONG) assert.ok(a in ACTION_FOR_DECISION, `Khuyến nghị ${a} chưa khai trong ACTION_FOR_DECISION`);
  assert.equal(ACTION_FOR_DECISION.FIX_DELIVERY, null, "sửa khâu giao KHÔNG được nối vào một nút đổi tiền — đó đúng là cái sai FIX_DELIVERY sinh ra để ngăn");
  assert.equal(ACTION_FOR_DECISION.INSUFFICIENT_DATA, null, "chưa đủ dữ liệu thì không có bàn tay");

  // ═══════════ PHẦN C — BẢNG CHÂN LÝ CỦA CỔNG ═══════════

  const ok = gateAdsWrite(input());
  assert.equal(ok.allow, true, "đủ điều kiện thì phải cho qua");
  assert.equal(ok.allow && ok.deltaVnd, 200_000);

  const truth: { name: string; over: Partial<GateInput>; denial: string }[] = [
    { name: "chốt cứng tắt", over: { hardEnabled: false }, denial: "HARD_DISABLED" },
    { name: "nấc OFF", over: { mode: "OFF" }, denial: "MODE_OFF" },
    { name: "phanh đang bật", over: { brake: { on: true, consecutiveWorse: 3, unmeasured: 0 } }, denial: "BRAKE_ON" },
    { name: "khuyến nghị không đẻ hành động", over: { decision: "HOLD" }, denial: "NO_ACTION_FOR_DECISION" },
    { name: "căn cứ là ước tính", over: { basis: "PROJECTED" }, denial: "BASIS_NOT_MEASURED" },
    { name: "chiến dịch đã tắt", over: { subject: { status: "PAUSED", spendInWindowVnd: 2_000_000, spendAfterWindowVnd: 0 } }, denial: "SUBJECT_NOT_RUNNING" },
    { name: "chiến dịch đã lưu trữ", over: { subject: { status: "ARCHIVED", spendInWindowVnd: 2_000_000, spendAfterWindowVnd: 0 } }, denial: "SUBJECT_NOT_RUNNING" },
    {
      name: "chiến dịch đã chạy lại",
      over: { subject: { status: "ACTIVE", spendInWindowVnd: 1_825_871, spendAfterWindowVnd: 4_439_115 } },
      denial: "SUBJECT_CHANGED",
    },
    { name: "không đọc được Facebook", over: { subject: { status: null, spendInWindowVnd: 2_000_000, spendAfterWindowVnd: 0 } }, denial: "SUBJECT_UNREADABLE" },
    { name: "không đọc được tiền sau kỳ", over: { subject: { status: "ACTIVE", spendInWindowVnd: 2_000_000, spendAfterWindowVnd: null } }, denial: "SUBJECT_UNREADABLE" },
    { name: "chưa chín", over: { stability: { ...HEALTHY_STABILITY, action: "SCALE", ready: false, blocker: "YOUNG", reason: "mới giữ 1 ngày" } }, denial: "NOT_STABLE" },
    { name: "chưa ai bấm", over: { confirmed: false }, denial: "NOT_CONFIRMED" },
    { name: "chiến dịch đã đổi hôm nay", over: { changesForCampaignToday: 1 }, denial: "CAMPAIGN_RATE_LIMIT" },
    { name: "vượt biên độ một lần", over: { nextBudgetVnd: 1_400_000 }, denial: "STEP_TOO_BIG" },
    { name: "chưa đọc được ngân sách hiện tại", over: { currentBudgetVnd: null }, denial: "STEP_TOO_BIG" },
    /*
      SÀN NGÂN SÁCH CANH CHO "CẮT" CẤP MÃ — hạ dần từng bước thì có ngày chạm sàn.

      Bản trước dựng ca này bằng một khuyến nghị TĂNG mà lại HẠ ngân sách (60K → 45K) — một tổ hợp
      vô nghĩa, và nay phép kiểm CHIỀU chặn nó trước khi tới sàn. Ở cấp chiến dịch, sàn vốn chỉ chạm
      được bằng đúng ca vô nghĩa ấy; nên kịch bản thật là CẮT cấp mã.
    */
    {
      name: "cắt cấp mã chạm sàn ngân sách",
      over: { level: "product", decision: "CUT", stability: { ...HEALTHY_STABILITY, action: "CUT" }, currentBudgetVnd: 60_000, nextBudgetVnd: 45_000 },
      denial: "BELOW_MIN_BUDGET",
    },
    // CHIỀU NGƯỢC: tăng mà hạ, hoặc cắt mà tăng — một lỗi ở đường tính, không để nó tiêu tiền.
    { name: "tăng mà lại hạ ngân sách", over: { currentBudgetVnd: 1_000_000, nextBudgetVnd: 900_000 }, denial: "DIRECTION_MISMATCH" },
    {
      name: "cắt cấp mã mà lại tăng ngân sách",
      over: { level: "product", decision: "CUT", stability: { ...HEALTHY_STABILITY, action: "CUT" }, currentBudgetVnd: 1_000_000, nextBudgetVnd: 1_100_000 },
      denial: "DIRECTION_MISMATCH",
    },
    { name: "tăng mà giữ nguyên ngân sách", over: { currentBudgetVnd: 1_000_000, nextBudgetVnd: 1_000_000 }, denial: "DIRECTION_MISMATCH" },
    { name: "vượt trần dịch chuyển ngày", over: { shiftedTodayVnd: ADS_WRITE_LIMITS.maxDailyShiftVnd }, denial: "DAILY_CAP" },
  ];
  for (const t of truth) {
    const r = gateAdsWrite(input(t.over));
    assert.equal(r.allow, false, `${t.name}: phải bị chặn`);
    assert.equal(!r.allow && r.denial, t.denial, `${t.name}: sai mã chặn`);
    assert.ok(!r.allow && r.reason.length > 10, `${t.name}: lý do phải đọc được, không phải một mã trống`);
  }

  /*
    ─── THỨ TỰ CÁC CHỐT LÀ MỘT PHẦN CỦA THIẾT KẾ ───

    Chốt cứng cấp môi trường phải thắng MỌI thứ khác. Nếu một ngày nào đó có người xếp nó xuống sau
    cổng độ bền thì ca dưới đây trả về `NOT_STABLE`, và câu trả lời cho *"có tổ hợp cấu hình nào lỡ
    đổi ngân sách thật không"* thôi là "không" mà thành "tuỳ".
  */
  const vuaTatVuaChuaChin = gateAdsWrite(input({ hardEnabled: false, confirmed: false, stability: { ...HEALTHY_STABILITY, ready: false, blocker: "YOUNG", reason: "non" } }));
  assert.equal(!vuaTatVuaChuaChin.allow && vuaTatVuaChuaChin.denial, "HARD_DISABLED", "chốt cứng phải đứng TRƯỚC mọi chốt khác");

  /*
    ─── CĂN CỨ ĐỨNG TRƯỚC ĐỘ BỀN ───

    Độ bền hỏi "khuyến nghị có giữ nguyên nhiều ngày không" — một câu hỏi về SỰ NHẤT QUÁN. Một giả
    định lặp lại mười ngày vẫn là một giả định: nó sẽ "chín" y như số đo chín. Nên nếu hai chốt đảo
    thứ tự, một dòng tạm tính đã chín sẽ đi qua bằng lối của cổng không dành cho nó.

    Bài kiểm này cũng là chỗ khoá chính sách: `ALLOW_ADS_WRITE_ON_PROJECTED_BASIS` mặc định TẮT, nên
    hôm nào có người bật nó thì dòng dưới đây đỏ và người ấy phải đọc lý do trước khi sửa.
  */
  assert.equal(ALLOW_ADS_WRITE_ON_PROJECTED_BASIS, false, "mặc định: máy KHÔNG được tự đổi tiền dựa trên một giả định — chỉ chủ shop mới bật được (AGENTS.md mục 7)");
  const uocTinhTruocDoBen = gateAdsWrite(input({ basis: "PROJECTED", stability: { ...HEALTHY_STABILITY, action: "SCALE", ready: false, blocker: "YOUNG", reason: "non" } }));
  assert.equal(!uocTinhTruocDoBen.allow && uocTinhTruocDoBen.denial, "BASIS_NOT_MEASURED", "căn cứ phải được hỏi TRƯỚC độ bền");
  // Và chốt cứng vẫn thắng cả căn cứ: thứ tự chỉ nới ra chứ không bao giờ siết vào.
  const tatVaUocTinh = gateAdsWrite(input({ hardEnabled: false, basis: "PROJECTED" }));
  assert.equal(!tatVaUocTinh.allow && tatVaUocTinh.denial, "HARD_DISABLED");

  /*
    ═══════════ KẾT LUẬN CÒN NÓI VỀ ĐÚNG CÁI MÀ NÚT NÀY SẼ TÁC ĐỘNG KHÔNG ═══════════

    Đo production 23/09/2026 trên 8 dòng có khuyến nghị hành động: 6/8 đã TẮT từ 05–09/09 (4 dòng
    trong số đó đang được khuyên TĂNG NGÂN SÁCH), và dòng cuối — dòng tôi đã định đưa chủ shop
    bấm, lần đầu bàn tay chạm vào tiền thật — khuyên CẮT trong khi chiến dịch đã CHẠY LẠI từ 20/09
    và tiêu 4.439.115 ₫ sau kỳ, gấp 2,43 lần 1.825.871 ₫ mà kết luận dựa vào.

    Không hàng rào nào trước đây hỏi câu này. Tất cả đều hỏi về KẾT LUẬN, không cái nào hỏi về
    CHIẾN DỊCH. Ca "đã chạy lại" ở bảng trên là đúng số của dòng ấy.
  */

  // RANH GIỚI LÀ 1,0 VÀ NÓ PHẢI ĐỨNG ĐÚNG CHỖ: bằng nhau vẫn được, vượt một đồng thì không.
  assert.equal(subjectFreshness({ status: "ACTIVE", spendInWindowVnd: 1_000_000, spendAfterWindowVnd: 1_000_000 }).ok, true, "tiền sau kỳ BẰNG tiền trong kỳ vẫn là cùng một lần chạy");
  assert.equal(subjectFreshness({ status: "ACTIVE", spendInWindowVnd: 1_000_000, spendAfterWindowVnd: 1_000_001 }).ok, false, "vượt một đồng là phần chưa ai đo đã lớn hơn phần sinh ra kết luận");

  /*
    CHƯA ĐỌC ĐƯỢC KHÁC VỚI KHÔNG CHI GÌ. `spendAfterWindowVnd = 0` là một chiến dịch đứng yên sau
    kỳ — hợp lệ. `null` là ERP không biết — phải chặn. Gộp `null` vào 0 là thả qua đúng lúc không
    biết gì (AGENTS.md mục 42).
  */
  assert.equal(subjectFreshness({ status: "ACTIVE", spendInWindowVnd: 1_000_000, spendAfterWindowVnd: 0 }).ok, true, "không chi gì sau kỳ là một sự thật, không phải một chỗ trống");
  assert.equal(subjectFreshness({ status: "ACTIVE", spendInWindowVnd: 1_000_000, spendAfterWindowVnd: null }).ok, false, "không biết đã chi gì sau kỳ thì không ghi");

  // CHIẾN DỊCH ĐỨNG TRƯỚC KẾT LUẬN: một chiến dịch đã tắt thì hỏi căn cứ hay độ bền là vô nghĩa.
  const tatVaUocTinhChuaChin = gateAdsWrite(
    input({
      subject: { status: "PAUSED", spendInWindowVnd: 2_000_000, spendAfterWindowVnd: 0 },
      basis: "PROJECTED",
      stability: { ...HEALTHY_STABILITY, action: "SCALE", ready: false, blocker: "YOUNG", reason: "non" },
    }),
  );
  assert.equal(!tatVaUocTinhChuaChin.allow && tatVaUocTinhChuaChin.denial, "SUBJECT_NOT_RUNNING", "trạng thái chiến dịch phải được hỏi TRƯỚC căn cứ và độ bền");
  // Nhưng chốt cứng vẫn thắng tất cả.
  const tatCungVaTat = gateAdsWrite(input({ hardEnabled: false, subject: { status: "PAUSED", spendInWindowVnd: 0, spendAfterWindowVnd: 0 } }));
  assert.equal(!tatCungVaTat.allow && tatCungVaTat.denial, "HARD_DISABLED");

  /*
    ═══════════ CẤP MÃ HÀNG: CÙNG MỘT CHỮ, HAI HÀNH ĐỘNG ═══════════

    Ở cấp chiến dịch CẮT = tạm dừng một chiến dịch. Ở cấp mã, giữ nghĩa ấy thì một cú bấm tắt MỌI
    quảng cáo của một mã — với Đầm Q002 (337 đơn trong kỳ) là tắt dòng doanh thu chính. Nên ở cấp
    mã, CẮT là HẠ NGÂN SÁCH DẦN, không bao giờ tạm dừng.
  */
  const catCapMa = gateAdsWrite(
    input({ level: "product", decision: "CUT", stability: { ...HEALTHY_STABILITY, action: "CUT" }, currentBudgetVnd: 1_000_000, nextBudgetVnd: 800_000 }),
  );
  assert.equal(catCapMa.allow, true, "cắt cấp mã hạ 20% phải qua được");
  assert.equal(catCapMa.allow && catCapMa.action, "SET_DAILY_BUDGET", "cắt cấp mã là HẠ NGÂN SÁCH — không bao giờ là tạm dừng");
  const catCapChienDich = gateAdsWrite(input({ decision: "CUT", stability: HEALTHY_STABILITY, currentBudgetVnd: null, nextBudgetVnd: null }));
  assert.equal(catCapChienDich.allow && catCapChienDich.action, "PAUSE_CAMPAIGN", "cắt cấp CHIẾN DỊCH vẫn là tạm dừng — hai cấp, hai nghĩa");

  /*
    "CHẠY LẠI" KHÔNG CÓ NGHĨA Ở CẤP MÃ. Chiến dịch nhận hành động theo mã thường là chiến dịch MỚI,
    chưa có đồng nào trong kỳ kết luận — so "sau kỳ > trong kỳ" ở đó luôn đúng và sẽ chặn mọi thứ
    vì một lý do sai. Nhưng "còn chạy không" thì VẪN hỏi ở cả hai cấp.
  */
  const moiToanh = { status: "ACTIVE", spendInWindowVnd: 0, spendAfterWindowVnd: 900_000 };
  assert.equal(subjectFreshness(moiToanh, "campaign").ok, false, "cấp chiến dịch: chiến dịch mới toanh là một lần chạy khác");
  assert.equal(subjectFreshness(moiToanh, "product").ok, true, "cấp mã: chiến dịch mới toanh CHÍNH LÀ cách mã tiếp tục chạy");
  assert.equal(subjectFreshness({ ...moiToanh, status: "PAUSED" }, "product").ok, false, "cấp mã vẫn phải hỏi Facebook chiến dịch còn chạy không");
  assert.equal(subjectFreshness({ ...moiToanh, status: null }, "product").ok, false, "không đọc được trạng thái thì không ghi, ở cấp nào cũng vậy");

  /*
    ═══════════ KẾ HOẠCH CẤP MÃ: TRẦN TRONG NGÀY CỘNG DỒN QUA CẢ LÔ ═══════════

    Đầm Q004 hôm nay có 12 chiến dịch đang chạy. Gọi `gateAdsWrite` 12 lần với CÙNG một
    `shiftedTodayVnd` thì mỗi chiến dịch đều tưởng mình là chiến dịch đầu tiên, và trần trong ngày
    thành trần × 12. Kỳ vọng dựng TỪ CHÍNH hằng số trần, không gõ lại con số (AGENTS.md mục 65).
  */
  const muoiHai: PlanTarget[] = Array.from({ length: 12 }, (_, k) => ({
    campaignId: `c${k}`,
    name: `Chiến dịch ${k}`,
    status: "ACTIVE",
    currentBudgetVnd: 1_000_000,
    changesToday: 0,
  }));
  const keHoach = planProductBudget({
    hardEnabled: true,
    mode: "COPILOT",
    confirmed: true,
    decision: "SCALE",
    basis: "ACTUAL",
    stability: { ...HEALTHY_STABILITY, action: "SCALE" },
    brake: BRAKE_OFF,
    shiftedTodayVnd: 0,
    targets: muoiHai,
  });
  const buoc = Math.round(1_000_000 * ADS_WRITE_LIMITS.proposeStepPct);
  const duocPhep = Math.floor(ADS_WRITE_LIMITS.maxDailyShiftVnd / buoc);
  assert.equal(keHoach.filter((r) => r.allow).length, duocPhep, `trần ${ADS_WRITE_LIMITS.maxDailyShiftVnd} ÷ bước ${buoc} = ${duocPhep} chiến dịch được đổi, không phải cả 12`);
  assert.ok(
    keHoach.filter((r) => !r.allow).every((r) => r.denial === "DAILY_CAP"),
    "phần vượt trần phải bị chặn vì TRẦN TRONG NGÀY — không vì lý do nào khác",
  );
  // Phần bị cắt là phần CUỐI danh sách — nơi gọi xếp theo tiền chi giảm dần nên đó là chiến dịch nhỏ nhất.
  assert.ok(keHoach.slice(0, duocPhep).every((r) => r.allow) && keHoach.slice(duocPhep).every((r) => !r.allow), "trần cắt ở ĐUÔI danh sách, không cắt lung tung");
  assert.ok(keHoach.every((r) => !r.allow || r.nextBudgetVnd === 1_000_000 + buoc), "TĂNG cấp mã = đúng một bước, lên trên");

  /*
    CHIẾN DỊCH ĐÃ TẮT BỊ LOẠI, VÀ KHÔNG CHIẾM CHỖ TRONG TRẦN. Một dòng bị chặn mà vẫn ăn vào trần
    thì mỗi chiến dịch đã tắt trong danh sách lại cướp mất phần của một chiến dịch đang chạy.
  */
  const coTat = planProductBudget({
    hardEnabled: true,
    mode: "COPILOT",
    confirmed: true,
    decision: "SCALE",
    basis: "ACTUAL",
    stability: { ...HEALTHY_STABILITY, action: "SCALE" },
    brake: BRAKE_OFF,
    shiftedTodayVnd: 0,
    targets: [{ ...muoiHai[0], status: "PAUSED" }, ...muoiHai.slice(1)],
  });
  assert.equal(coTat[0].denial, "SUBJECT_NOT_RUNNING");
  assert.equal(coTat.filter((r) => r.allow).length, duocPhep, "chiến dịch đã tắt không được ăn vào trần của chiến dịch đang chạy");

  // Đường ÁP dùng ĐÚNG con số đã khoá trong phiếu duyệt, không tự tính lại.
  const khoa = new Map([["c0", 1_150_000]]);
  const ap = planProductBudget({
    hardEnabled: true,
    mode: "COPILOT",
    confirmed: true,
    decision: "SCALE",
    basis: "ACTUAL",
    stability: { ...HEALTHY_STABILITY, action: "SCALE" },
    brake: BRAKE_OFF,
    shiftedTodayVnd: 0,
    targets: [muoiHai[0]],
    lockedNext: khoa,
  });
  assert.equal(ap[0].nextBudgetVnd, 1_150_000, "đường áp phải ghi đúng con số trong phiếu duyệt");

  // CẮT cấp mã = hạ đúng một bước.
  assert.equal(nextBudgetFor(1_000_000, "CUT"), 1_000_000 - buoc);
  assert.equal(nextBudgetFor(null, "SCALE"), null, "chưa biết ngân sách hiện tại thì không tính ngân sách mới");
  assert.equal(nextBudgetFor(1_000_000, "WATCH"), null, "khuyến nghị không có chiều thì không có ngân sách mới");

  // Lý do chặn phải mang SỐ của chính chiến dịch — cãi lại được, không chỉ đọc được.
  const chayLai = gateAdsWrite(input({ subject: { status: "ACTIVE", spendInWindowVnd: 1_825_871, spendAfterWindowVnd: 4_439_115 } }));
  assert.ok(!chayLai.allow && chayLai.reason.includes("2.43"), `lý do phải nói ra gấp bao nhiêu lần — "${!chayLai.allow ? chayLai.reason : ""}"`);

  // Phanh đứng TRƯỚC cổng độ bền: một luật đang sai thì khuyến nghị "đã chín" của nó cũng không đáng tin.
  const phanhTruocDoBen = gateAdsWrite(input({ brake: { on: true, consecutiveWorse: 3, unmeasured: 1 }, stability: { ...HEALTHY_STABILITY, ready: false, blocker: "YOUNG", reason: "non" } }));
  assert.equal(!phanhTruocDoBen.allow && phanhTruocDoBen.denial, "BRAKE_ON");

  // Tạm dừng KHÔNG đụng trần tiền — nó DỪNG tiền chảy chứ không tiêu thêm.
  const tamDung = gateAdsWrite(input({ decision: "CUT", stability: HEALTHY_STABILITY, shiftedTodayVnd: ADS_WRITE_LIMITS.maxDailyShiftVnd, nextBudgetVnd: null, currentBudgetVnd: null }));
  assert.equal(tamDung.allow, true, "tạm dừng phải qua được kể cả khi đã chạm trần dịch chuyển trong ngày");
  assert.equal(tamDung.allow && tamDung.action, "PAUSE_CAMPAIGN");
  assert.equal(tamDung.allow && tamDung.deltaVnd, 0);

  // ═══════════ PHẦN D — PHANH ═══════════

  const xau = (day: string, before: number, after: number | null) => ({ changedAt: day, profitBefore: before, profitAfter: after });

  assert.deepEqual(brakeState([]), BRAKE_OFF, "chưa có lượt nào thì phanh TẮT — bốn cái trần kia lo giai đoạn đầu");

  const baLanXau = brakeState([xau("2026-09-10", 100, 50), xau("2026-09-12", 90, 40), xau("2026-09-14", 80, 30)]);
  assert.equal(baLanXau.consecutiveWorse, 3);
  assert.equal(baLanXau.on, true, "ba lượt xấu liên tiếp phải bật phanh");

  const xenLanTot = brakeState([xau("2026-09-10", 100, 50), xau("2026-09-12", 90, 200), xau("2026-09-14", 80, 30)]);
  assert.equal(xenLanTot.consecutiveWorse, 1, "một lượt TỐT cắt chuỗi ngay");
  assert.equal(xenLanTot.on, false);

  /*
    ─── LƯỢT CHƯA ĐO ĐƯỢC BỊ BỎ QUA, VÀ ĐƯỢC ĐẾM RIÊNG ───

    Kết quả một lượt đổi chỉ ngã ngũ sau vài ngày, nên lượt MỚI NHẤT gần như luôn chưa đo được. Nếu
    nó CẮT chuỗi thì phanh gần như không bao giờ bật — nó sẽ che mọi lượt cũ đằng sau. Nhưng bỏ qua
    trong im lặng là nói dối, nên `unmeasured` phải đi kèm mọi lần trả về.
  */
  const conTreo = brakeState([xau("2026-09-10", 100, 50), xau("2026-09-12", 90, 40), xau("2026-09-14", 80, 30), xau("2026-09-20", 70, null)]);
  assert.equal(conTreo.unmeasured, 1, "lượt chưa đo được phải được ĐẾM RIÊNG, không biến mất");
  assert.equal(conTreo.consecutiveWorse, 3, "lượt chưa đo được KHÔNG cắt chuỗi — nếu cắt thì phanh không bao giờ bật");
  assert.equal(conTreo.on, true);

  // Thiếu vế TRƯỚC cũng là chưa đo được: không có mốc thì không nói được "xấu đi".
  const thieuMoc = brakeState([{ changedAt: "2026-09-14", profitBefore: null, profitAfter: 10 }]);
  assert.equal(thieuMoc.unmeasured, 1);
  assert.equal(thieuMoc.consecutiveWorse, 0);

  // Thứ tự đầu vào không được ảnh hưởng kết quả.
  const xuoi = [xau("2026-09-10", 100, 50), xau("2026-09-12", 90, 200)];
  assert.deepEqual(brakeState([...xuoi].reverse()), brakeState(xuoi), "hàm phải tự xếp theo ngày, mới nhất trước");

  console.log("  ✓ Bàn tay quảng cáo: một cửa ghi duy nhất · trần cứng kẹp AUTO · 11 ca chặn đúng thứ tự · phanh phân biệt xấu với chưa đo");
}


/**
 * ═══════════ PHANH ĐẾM QUYẾT ĐỊNH, KHÔNG ĐẾM DÒNG — VÀ ĐO ĐÚNG CẤP ═══════════
 *
 * Một cú bấm cấp mã ghi N dòng thay đổi (mỗi chiến dịch đang chạy một dòng), cùng `ledger_id`,
 * cùng ngày. Đầm Q004 có 12 chiến dịch đang chạy, nên nếu phanh đếm từng dòng thì chỉ MỘT quyết
 * định sai đã vượt ngưỡng phanh 3 lượt "xấu đi liên tiếp".
 *
 * Và phanh phải tra lợi nhuận "sau" trên CÙNG cấp với lợi nhuận "trước". Bài kiểm đặt một CÁI BẪY:
 * dòng sổ cấp CHIẾN DỊCH của c1 mang lợi nhuận rất ĐẸP (5 triệu). Phanh tra nhầm cấp sẽ thấy "tốt
 * lên" đúng lúc mã hàng thật ra đang "xấu đi" (1 triệu → 400 nghìn).
 *
 * Mốc ngày dựng TƯƠNG ĐỐI theo đồng hồ thật, cùng nhịp với `now()` mà truy vấn dùng (AGENTS.md mục 50).
 */
export async function testAdsBrakeByDecision(db: Db) {
  const L = schema.adsDecisionLedger;
  const C = schema.adsBudgetChanges;
  const ngay = (luiNgay: number) => new Date(Date.now() - luiNgay * 86_400_000).toISOString().slice(0, 10);
  const d0 = ngay(10);
  const d8 = ngay(2);
  const MA = "prod-phanh-kiem";
  const chung = { actionClass: "ACTIONABLE", periodFrom: d0, periodTo: d0, ruleVersion: 2, ruleSnapshot: {}, spendKnown: true };
  const idTruoc = "ledger-phanh-truoc";

  try {
    await db.insert(L).values([
      { id: idTruoc, decisionDay: d0, dimension: "product", entityKey: MA, action: "SCALE", profitAfterAds: 1_000_000, ...chung },
      { id: "ledger-phanh-sau", decisionDay: d8, dimension: "product", entityKey: MA, action: "SCALE", profitAfterAds: 400_000, ...chung },
      // BẪY: dòng cấp chiến dịch của c1, lợi nhuận rất đẹp.
      { id: "ledger-phanh-bay", decisionDay: d8, dimension: "campaign", entityKey: "c1-phanh", action: "SCALE", profitAfterAds: 5_000_000, ...chung },
    ]);
    await db.insert(C).values(
      ["c1-phanh", "c2-phanh", "c3-phanh"].map((campaignId) => ({
        changeDay: d0,
        campaignId,
        action: "SET_DAILY_BUDGET",
        outcome: "APPLIED",
        decision: "SCALE",
        ledgerId: idTruoc,
        profitBefore: 1_000_000,
        budgetBefore: 100_000,
        budgetAfter: 120_000,
        mode: "COPILOT",
      })),
    );

    const quanSat = (await brakeObservations(7, 50)).filter((o) => o.changedAt === d0 && o.profitBefore === 1_000_000);
    assert.equal(quanSat.length, 1, `MỘT quyết định cấp mã ghi 3 dòng phải thành ĐÚNG MỘT quan sát cho phanh — nhận ${quanSat.length}`);
    assert.equal(
      quanSat[0].profitAfter,
      400_000,
      "lợi nhuận 'sau' phải tra trên CÙNG cấp mã hàng (400 nghìn) — nếu ra 5 triệu là phanh đã tra nhầm dòng sổ cấp chiến dịch",
    );
  } finally {
    await db.delete(C).where(eq(C.ledgerId, idTruoc));
    await db.delete(L).where(inArray(L.id, [idTruoc, "ledger-phanh-sau", "ledger-phanh-bay"]));
  }
  console.log("✓ Phanh đếm QUYẾT ĐỊNH không đếm dòng (3 dòng cấp mã → 1 quan sát) · tra lợi nhuận 'sau' trên CÙNG cấp, không mắc bẫy dòng cấp chiến dịch");
}
