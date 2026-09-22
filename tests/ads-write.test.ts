import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AdsAction } from "@/lib/constants/ads-decision";
import {
  ACTION_FOR_DECISION,
  ADS_WRITE_LIMITS,
  MAX_ALLOWED_ADS_WRITE_MODE,
  clampAdsWriteMode,
} from "@/lib/constants/ads-write";
import { BRAKE_OFF, brakeState, gateAdsWrite, type GateInput } from "@/lib/marketing/ads-write-gate";
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
    { name: "chưa chín", over: { stability: { ...HEALTHY_STABILITY, action: "SCALE", ready: false, blocker: "YOUNG", reason: "mới giữ 1 ngày" } }, denial: "NOT_STABLE" },
    { name: "chưa ai bấm", over: { confirmed: false }, denial: "NOT_CONFIRMED" },
    { name: "chiến dịch đã đổi hôm nay", over: { changesForCampaignToday: 1 }, denial: "CAMPAIGN_RATE_LIMIT" },
    { name: "vượt biên độ một lần", over: { nextBudgetVnd: 1_400_000 }, denial: "STEP_TOO_BIG" },
    { name: "chưa đọc được ngân sách hiện tại", over: { currentBudgetVnd: null }, denial: "STEP_TOO_BIG" },
    { name: "dưới sàn ngân sách", over: { currentBudgetVnd: 60_000, nextBudgetVnd: 45_000 }, denial: "BELOW_MIN_BUDGET" },
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
