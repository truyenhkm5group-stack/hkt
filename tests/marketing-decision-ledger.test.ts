import assert from "node:assert/strict";
import { ADS_DECISION_RULE, type AdsAction } from "@/lib/constants/ads-decision";
import {
  LEDGER_SETTLE_LAG_DAYS,
  DECISION_CLASS,
  DECISION_RULE_VERSION,
  DECISION_STABILITY,
  FLIP_WINDOW_DAYS,
  LEDGER_WINDOW_DAYS,
  dayDiff,
  decisionRuleSnapshot,
  ledgerPeriod,
  shiftDay,
  stabilityRuleOf,
  vnDay,
} from "@/lib/constants/marketing-decision-ledger";
import { NO_HISTORY, stabilityOf, type LedgerPoint } from "@/lib/marketing/decision-stability";

/**
 * ═══════════ SỔ QUYẾT ĐỊNH QUẢNG CÁO — TRÍ NHỚ PHẢI ĐÚNG THÌ MỚI DÙNG ĐƯỢC ═══════════
 *
 * Đặc tả: `docs/marketing-ai-department.md`.
 *
 * Khối này khoá ba nhóm, và cả ba đều là chỗ một cỗ máy tự chủ sẽ hỏng nếu sai:
 *
 *  1. **KỲ CHUẨN LÀ HÀM THUẦN** — hai lượt chạy cùng một `now` phải ra cùng một kỳ và cùng một
 *     ngày ghi sổ. Lệch một ngày là đẻ dòng thứ hai, và chuỗi "đã giữ N ngày" thành vô nghĩa.
 *
 *  2. **CHƯA ĐO KHÁC KHÔNG ĐỔI** (AGENTS.md mục 42) — ngày thiếu dòng CẮT chuỗi, sổ cũ hơn hôm nay
 *     là `STALE`, và không có dòng nào thì KHÔNG phải "ổn định".
 *
 *  3. **ĐỔI LUẬT LÀ CẮT CHUỖI** (mục 40) — cùng chữ `CUT` sinh ra bởi hai bộ ngưỡng khác nhau
 *     không phải cùng một kết luận.
 */

/** Dựng nhanh một chuỗi dòng sổ: ngày cuối là `lastDay`, đi lùi theo danh sách hành động. */
function points(lastDay: string, actions: AdsAction[], ruleVersion = DECISION_RULE_VERSION): LedgerPoint[] {
  return actions.map((action, i) => ({ decisionDay: shiftDay(lastDay, -(actions.length - 1 - i)), action, ruleVersion }));
}

export async function testMarketingDecisionLedger() {
  // ═══════════ PHẦN A — KỲ CHUẨN ═══════════

  // Giờ Việt Nam: 2026-09-22T00:30+07 vẫn là ngày 22, dù UTC còn đang 21.
  assert.equal(vnDay(new Date("2026-09-21T17:30:00Z")), "2026-09-22", "vnDay phải cộng 7 giờ trước khi cắt ngày");
  assert.equal(vnDay(new Date("2026-09-21T16:59:59Z")), "2026-09-21");

  const a = ledgerPeriod(new Date("2026-09-22T03:00:00Z"));
  const b = ledgerPeriod(new Date("2026-09-22T03:00:00Z"));
  assert.deepEqual(a, b, "ledgerPeriod phải THUẦN — cùng now ra cùng kết quả");
  assert.equal(a.decisionDay, "2026-09-22");
  /*
    KỲ CHUẨN LÙI 15 NGÀY, KHÔNG KẾT THÚC Ở HÔM QUA.

    Đường cong độ chín đo trên production 22/09/2026: đơn tuổi 0–6 ngày mới ngã ngũ 8,2%, tuổi 7–13
    là 28,9%, phải tới tuổi 14–20 mới lên 83,5%. Cửa sổ "1–14 ngày tuổi" của bản đầu vì thế có độ
    chín ~18%, trong khi `decideAction` đòi 60% — và lượt ghi sổ đầu tiên cho 425/425 dòng cấp chiến
    dịch đều INSUFFICIENT_DATA.

    Kéo cửa sổ về gần hôm nay là làm sổ rỗng nghĩa; đó là lý do con số này không phải một lựa chọn
    thẩm mỹ.
  */
  assert.equal(a.period.toKey, "2026-09-07", "kỳ chuẩn phải kết thúc D−15 để cohort đủ chín");
  assert.equal(a.period.fromKey, "2026-08-25");
  assert.equal(dayDiff(a.period.toKey!, a.decisionDay), LEDGER_SETTLE_LAG_DAYS, "khoảng lùi phải đúng LEDGER_SETTLE_LAG_DAYS");
  assert.equal(dayDiff(a.period.fromKey!, a.period.toKey!) + 1, LEDGER_WINDOW_DAYS, "cửa sổ phải đúng LEDGER_WINDOW_DAYS ngày");

  // Hai lượt chạy khác giờ TRONG CÙNG NGÀY phải cho cùng một ngày ghi sổ — nếu không, khoá duy nhất
  // không cứu được và job chạy 30 phút/lần sẽ đẻ 48 dòng mỗi ngày.
  const sang = ledgerPeriod(new Date("2026-09-22T01:00:00Z"));
  const toi = ledgerPeriod(new Date("2026-09-22T15:00:00Z"));
  assert.equal(sang.decisionDay, toi.decisionDay, "mọi lượt chạy trong một ngày Việt Nam phải ghi vào cùng một dòng");

  // ═══════════ PHẦN B — PHIÊN BẢN LUẬT KHOÁ VỚI NGƯỠNG ═══════════

  /*
    BỘ NGƯỠNG ĐƯỢC CHÉP RA ĐÂY CÓ CHỦ Ý.

    Sửa một ngưỡng trong `ADS_DECISION_RULE` mà quên tăng `DECISION_RULE_VERSION` thì chuỗi trước và
    sau bản sửa sẽ nối liền nhau, và một khuyến nghị sinh ra bởi luật CŨ được đếm là "đã giữ 9 ngày"
    dưới luật MỚI. Bài kiểm này đỏ đúng vào lúc đó, và cách sửa nó là tăng phiên bản chứ không phải
    cập nhật con số dưới đây cho khớp.
  */
  const NGUONG_DA_KHOA = { minSpend: 300_000, minFinishedOrders: 10, minMaturity: 0.6, scaleAbove: 1.3, cutBelow: 0.8, lowSuccessRate: 65 };
  assert.deepEqual(
    { ...ADS_DECISION_RULE },
    NGUONG_DA_KHOA,
    `Ngưỡng quyết định đã đổi. Tăng DECISION_RULE_VERSION (đang là ${DECISION_RULE_VERSION}) rồi cập nhật bộ khoá này — đừng chỉ sửa con số cho bài kiểm xanh.`,
  );

  const snap = decisionRuleSnapshot();
  assert.equal(snap.version, DECISION_RULE_VERSION);
  assert.equal(snap.windowDays, LEDGER_WINDOW_DAYS);
  assert.equal(snap.settleLagDays, LEDGER_SETTLE_LAG_DAYS, "ảnh chụp phải mang cả khoảng lùi — đổi kỳ là đổi tập dữ liệu sinh ra kết luận");
  assert.equal(snap.cutBelow, ADS_DECISION_RULE.cutBelow, "ảnh chụp phải mang ĐÚNG ngưỡng đang chạy, không phải bản chép tay");

  // ═══════════ PHẦN C — HẠNG HÀNH ĐỘNG ═══════════

  // Mọi hành động phải được xếp hạng. Thêm một hành động mới mà quên khai là để nó rơi vào `undefined`,
  // và một dòng `undefined` sẽ vi phạm CHECK ở CSDL — nhưng chỉ vào lúc job chạy trên production.
  const MOI_HANH_DONG: AdsAction[] = ["SCALE", "HOLD", "WATCH", "CUT", "FIX_DELIVERY", "INSUFFICIENT_DATA", "NO_SPEND_DATA"];
  for (const act of MOI_HANH_DONG) {
    assert.ok(DECISION_CLASS[act], `Hành động ${act} chưa khai hạng trong DECISION_CLASS`);
    assert.ok(["ACTIONABLE", "NO_CHANGE", "NO_OPINION"].includes(DECISION_CLASS[act]), `${act}: hạng lạ`);
  }
  // Chỉ hạng ACTIONABLE mới có cổng độ bền, và mọi hạng ACTIONABLE đều phải có.
  for (const act of MOI_HANH_DONG) {
    const coCong = stabilityRuleOf(act) !== null;
    assert.equal(coCong, DECISION_CLASS[act] === "ACTIONABLE", `${act}: hạng và cổng độ bền không khớp nhau`);
  }
  assert.equal(DECISION_CLASS.INSUFFICIENT_DATA, "NO_OPINION", "chưa đủ dữ liệu KHÔNG được là một việc phải làm");

  // ═══════════ PHẦN D — ĐỘ BỀN ═══════════

  const HOM_NAY = "2026-09-22";

  // ── D1. Không có lịch sử ⇒ CHƯA ĐO, không phải "ổn định" và cũng không phải "mới" ──
  assert.deepEqual(stabilityOf([], HOM_NAY), NO_HISTORY);
  assert.equal(stabilityOf([], HOM_NAY).ready, false);
  assert.equal(stabilityOf([], HOM_NAY).heldDays, 0, "không có dòng nào thì heldDays là 0, không phải 1");

  // ── D2. Chuỗi liên tục, đủ dài, không đổi ý ⇒ được phép hành động ──
  const ben = stabilityOf(points(HOM_NAY, ["CUT", "CUT", "CUT", "CUT"]), HOM_NAY);
  assert.equal(ben.heldDays, 4);
  assert.equal(ben.flips, 0);
  assert.equal(ben.missingDays, 0);
  assert.equal(ben.staleDays, 0);
  assert.equal(ben.ready, true, ben.reason);
  assert.equal(ben.blocker, null);

  // ── D3. Mới giữ ít ngày hơn ngưỡng ⇒ YOUNG (tự khỏi theo thời gian) ──
  const non = stabilityOf(points(HOM_NAY, ["WATCH", "WATCH", "CUT", "CUT"]), HOM_NAY);
  assert.equal(non.heldDays, 2);
  assert.equal(non.ready, false);
  assert.equal(non.blocker, "YOUNG", non.reason);
  assert.ok(non.reason.includes(String(DECISION_STABILITY.CUT.minHeldDays)), "lý do phải nói rõ cần bao nhiêu ngày");

  // ── D4. Đổi ý quá nhiều lần ⇒ UNSTABLE, KỂ CẢ khi chuỗi hiện tại đã đủ dài ──
  /*
    ĐÂY LÀ CA QUAN TRỌNG NHẤT CỦA CẢ KHỐI.

    Cửa sổ 14 ngày LĂN nên hai ngày liên tiếp dùng chung 13/14 dữ liệu: "hôm nay giống hôm qua" gần
    như luôn đúng. Một cổng chỉ nhìn chuỗi liên tiếp sẽ mở sau đúng ba ngày cho một chiến dịch đang
    nhảy qua nhảy lại quanh điểm hoà vốn — tưởng là thận trọng, thực ra là tự động gật.
  */
  const nhay = stabilityOf(points(HOM_NAY, ["CUT", "WATCH", "CUT", "HOLD", "CUT", "CUT", "CUT"]), HOM_NAY);
  assert.equal(nhay.heldDays, 3, "chuỗi hiện tại vẫn đủ dài…");
  assert.ok(nhay.flips > DECISION_STABILITY.CUT.maxFlips, "…nhưng đã đổi ý quá nhiều lần");
  assert.equal(nhay.ready, false, nhay.reason);
  assert.equal(nhay.blocker, "UNSTABLE");

  // ── D5. Sổ chưa ghi tới hôm nay ⇒ STALE, và đó là việc phải đi sửa, không tự khỏi ──
  const cu = stabilityOf(points(shiftDay(HOM_NAY, -3), ["CUT", "CUT", "CUT", "CUT", "CUT"]), HOM_NAY);
  assert.equal(cu.staleDays, 3);
  assert.equal(cu.ready, false);
  assert.equal(cu.blocker, "STALE", "job không chạy nghĩa là ERP KHÔNG BIẾT, không phải 'không có gì đổi'");

  // ── D6. Thiếu một ngày ở giữa ⇒ chuỗi ĐỨT, không bắc cầu ──
  const thieu: LedgerPoint[] = [
    { decisionDay: shiftDay(HOM_NAY, -4), action: "CUT", ruleVersion: DECISION_RULE_VERSION },
    { decisionDay: shiftDay(HOM_NAY, -3), action: "CUT", ruleVersion: DECISION_RULE_VERSION },
    // -2 KHÔNG có dòng: job không chạy hôm ấy
    { decisionDay: shiftDay(HOM_NAY, -1), action: "CUT", ruleVersion: DECISION_RULE_VERSION },
    { decisionDay: HOM_NAY, action: "CUT", ruleVersion: DECISION_RULE_VERSION },
  ];
  const t = stabilityOf(thieu, HOM_NAY);
  assert.equal(t.heldDays, 2, "ngày thiếu phải CẮT chuỗi — nối qua nó là khẳng định một điều chưa đo");
  assert.equal(t.missingDays, 1);
  assert.equal(t.flips, 0, "thiếu ngày không phải đổi ý");
  assert.equal(t.ready, false);
  assert.equal(t.blocker, "YOUNG");

  // ── D7. Đổi phiên bản luật ⇒ RULE_CHANGED, và chuỗi đứt ở đúng chỗ đổi ──
  const doiLuat: LedgerPoint[] = [
    ...points(shiftDay(HOM_NAY, -3), ["CUT", "CUT", "CUT", "CUT"], DECISION_RULE_VERSION),
    ...points(HOM_NAY, ["CUT", "CUT", "CUT"], DECISION_RULE_VERSION + 1),
  ];
  const dl = stabilityOf(doiLuat, HOM_NAY);
  assert.equal(dl.heldDays, 3, "chuỗi không được nối qua ranh giới phiên bản luật");
  assert.equal(dl.ready, false);
  assert.equal(dl.blocker, "RULE_CHANGED", dl.reason);

  // ── D8. Hành động không dẫn tới việc gì ⇒ NOT_ACTIONABLE, phân biệt hẳn với "chưa đủ chín" ──
  const khongViec = stabilityOf(points(HOM_NAY, ["HOLD", "HOLD", "HOLD", "HOLD", "HOLD"]), HOM_NAY);
  assert.equal(khongViec.ready, false);
  assert.equal(khongViec.blocker, "NOT_ACTIONABLE", "giữ nguyên 5 ngày vẫn không phải một việc phải làm");

  // ── D9. Thứ tự đầu vào không được ảnh hưởng kết quả ──
  const xuoi = points(HOM_NAY, ["WATCH", "CUT", "CUT", "CUT"]);
  const nguoc = [...xuoi].reverse();
  assert.deepEqual(stabilityOf(nguoc, HOM_NAY), stabilityOf(xuoi, HOM_NAY), "hàm phải tự xếp thứ tự");

  // ── D10. Mục mới lập không bị tính là "thiếu cả cửa sổ" ──
  const moi = stabilityOf(points(HOM_NAY, ["CUT", "CUT"]), HOM_NAY);
  assert.equal(moi.missingDays, 0, `mục mới có 2 dòng không được coi là thiếu ${FLIP_WINDOW_DAYS - 2} ngày`);
  assert.equal(moi.blocker, "YOUNG");

  console.log("  ✓ Sổ quyết định quảng cáo: kỳ chuẩn thuần, chưa-đo ≠ không-đổi, đổi luật cắt chuỗi");
}
