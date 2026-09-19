/**
 * CHẠY LẠI MỘT CA HỒI QUY — dây chuyền THẬT, dữ liệu CHỤP SẴN.
 *
 * Tệp này không viết lại một bước nào của nhân sự bán hàng. Nó gọi đúng bốn hàm mà `runSalesTask`
 * gọi — `understandByRule` · `applyUnderstanding` · `checkContextualConfirmation` · `decide` — rồi
 * dựng câu bằng `renderTemplate`. Khác duy nhất: công cụ ERP không hỏi CSDL mà đọc từ kết quả đã
 * chụp trong ca.
 *
 * VÌ SAO KHÔNG GỌI MÔ HÌNH. Bậc luật là bậc TẤT ĐỊNH: cùng đầu vào ra cùng đầu ra, hôm nay và sáu
 * tháng nữa. Một bộ ca gọi mô hình thì mỗi lần chạy ra một kết quả hơi khác, và người đọc sẽ học
 * cách bỏ qua nó. Thứ bộ ca này đo là NGHIỆP VỤ — giữ đúng mẫu mã qua nhiều lượt, chuyển người
 * đúng lúc, không hứa thứ chưa biết — và cả ba đều nằm ở bậc luật.
 *
 * Mô hình vẫn được đo, nhưng ở chỗ khác: `/ai/review` chấm tay từng lượt THẬT, nơi có cả câu chữ.
 */
import { understandByRule, type Understanding } from "@/lib/ai-workforce/agents/sales/understand";
import { applyUnderstanding, type ToolRunner } from "@/lib/ai-workforce/agents/sales/pipeline";
import { checkContextualConfirmation } from "@/lib/ai-workforce/agents/sales/confirm";
import { decide } from "@/lib/ai-workforce/agents/sales/decide";
import { renderTemplate } from "@/lib/ai-workforce/agents/sales/generate";
import { parseSalesState, parseStage, type SalesState } from "@/lib/ai-workforce/agents/sales/state";
import {
  compareToExpectation,
  type RegressionCase,
  type RegressionCaseResult,
  type RegressionFinding,
} from "@/lib/constants/sales-regression";

/**
 * Công cụ ERP giả lập từ dữ liệu đã chụp.
 *
 * `undefined` (khoá vắng mặt) ≠ `null` (khoá khai là null). Vắng mặt nghĩa là ca này không chụp
 * công cụ ấy — trả `null` sẽ bị dây chuyền đọc thành CÔNG CỤ LỖI và mọi ca thiếu một ô sẽ hoá
 * thành "chuyển người vì lỗi công cụ", che mất điều ca muốn đo. Nên vắng mặt trả về một giá trị
 * TRUNG TÍNH, và chỉ `null` tường minh mới là lỗi.
 */
export function replayToolRunner(results: Record<string, unknown>): ToolRunner {
  const trungTinh: Record<string, unknown> = {
    "product.get_variants": { variants: [], sizes: [], colors: [], needsSize: false, needsColor: false },
    "pricing.get": { ambiguous: true, total: null, shippingFee: 0, unitPrice: null },
    "inventory.check": { stockKnown: false, available: null, canPromise: false },
    "size.recommend": { code: "SIZE_DATA_MISSING", size: null, reason: "ca hồi quy không chụp bảng số đo", needsHuman: true, missing: [], candidates: [] },
  };
  return async <T,>(name: string, _args: unknown): Promise<T | null> => {
    void _args;
    if (Object.hasOwn(results, name)) return results[name] as T | null;
    return (trungTinh[name] ?? null) as T | null;
  };
}

export type ReplayTurn = {
  text: string;
  sentAt: Date;
  understanding: Understanding;
  state: SalesState;
  action: string;
  stage: string;
  handoffReason: string | null;
  reply: string;
};

/**
 * Chạy lại một ca và trả về kết quả từng lượt.
 *
 * `startedAt` do NƠI GỌI cấp. Mốc trong ca là số phút tương đối, nên ca không bao giờ già đi — và
 * `now` của mỗi lượt chính là mốc tin ấy, nên phép kiểm hạn bản chốt đơn đo đúng thứ nó phải đo.
 */
export async function replayCase(ca: RegressionCase, startedAt: Date): Promise<{ turns: ReplayTurn[] }> {
  const tool = replayToolRunner(ca.toolResults);
  let state = parseSalesState(ca.priorState);
  let stage = parseStage(ca.priorStage);
  const turns: ReplayTurn[] = [];

  for (const tin of ca.messages) {
    const sentAt = new Date(startedAt.getTime() + tin.minutesFromStart * 60_000);
    const understanding = understandByRule(tin.text);
    const applied = await applyUnderstanding(state, understanding, tool, null);
    state = applied.state;

    const confirmation = checkContextualConfirmation({ state, message: { text: tin.text, sentAt }, now: sentAt });
    const quyetDinh = decide({
      stage,
      state,
      understanding,
      confirmation,
      humanTakeover: ca.context.humanTakeover,
      orderCreated: ca.context.orderCreated,
      stale: ca.context.stale,
      toolFailed: applied.toolFailed,
      canPromiseStock: ca.context.canPromiseStock,
      sizeAdvice: applied.sizeAdvice,
    });
    stage = quyetDinh.stage;

    const reply = renderTemplate({
      action: quyetDinh.action,
      state,
      sizes: applied.sizes,
      colors: applied.colors,
      sizeAdvice: applied.sizeAdvice,
      stockKnown: applied.stockKnown,
      available: applied.available,
      shippingFee: applied.shippingFee,
      missing: quyetDinh.missing,
      reason: quyetDinh.reason,
    });

    turns.push({ text: tin.text, sentAt, understanding, state, action: quyetDinh.action, stage, handoffReason: quyetDinh.handoffReason, reply });
  }

  return { turns };
}

/**
 * Chạy một ca rồi CHẤM. Không bao giờ ném: một ca làm sập dây chuyền vẫn phải thành một dòng kết
 * quả đọc được, nếu không một lỗi hạ tầng sẽ giấu đi kết quả của mọi ca sau nó.
 */
export async function runRegressionCase(ca: RegressionCase, startedAt: Date): Promise<RegressionCaseResult> {
  const t0 = Date.now();
  try {
    const { turns } = await replayCase(ca, startedAt);
    if (!turns.length) {
      return {
        key: ca.key,
        title: ca.title,
        origin: ca.origin,
        passed: false,
        findings: [{ failure: "ERROR", field: "messages", expected: "≥ 1 tin của khách", actual: "0" }],
        turnsRun: 0,
        durationMs: Date.now() - t0,
      };
    }
    const cuoi = turns[turns.length - 1];
    const findings: RegressionFinding[] = compareToExpectation(ca.expected, {
      intents: cuoi.understanding.intents,
      stage: cuoi.stage as never,
      action: cuoi.action as never,
      handoffReason: cuoi.handoffReason as never,
      state: {
        size: cuoi.state.size,
        color: cuoi.state.color,
        phone: cuoi.state.phone,
        quantity: cuoi.state.quantity,
        purchaseIntent: cuoi.state.purchaseIntent,
        variantId: cuoi.state.variantId,
        productName: cuoi.state.productName,
      },
      reply: cuoi.reply,
    });
    return { key: ca.key, title: ca.title, origin: ca.origin, passed: findings.length === 0, findings, turnsRun: turns.length, durationMs: Date.now() - t0 };
  } catch (e) {
    return {
      key: ca.key,
      title: ca.title,
      origin: ca.origin,
      passed: false,
      findings: [{ failure: "ERROR", field: "pipeline", expected: "chạy hết ca", actual: e instanceof Error ? e.message : String(e) }],
      turnsRun: 0,
      durationMs: Date.now() - t0,
    };
  }
}
