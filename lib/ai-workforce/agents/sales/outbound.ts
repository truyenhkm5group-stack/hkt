/**
 * CỔNG GỬI TIN RA — chốt chặn cuối cùng trước khi bất cứ chữ nào tới tay khách.
 *
 * Cổng này là nơi DUY NHẤT trong mã nguồn gọi tới API gửi tin của Pancake cho nhân sự AI, nên chỉ
 * cần đọc một tệp là kiểm chứng được mọi lời khẳng định về "AI có nhắn khách không".
 *
 * BA LOẠI GỬI, BA CÔNG TẮC RIÊNG (`SEND_KINDS` ở `lib/constants/ai.ts`):
 *
 *   `AUTO`           — máy tự quyết và tự gửi. Đọc `allowAutoSend`, và CHỈ đọc nó.
 *   `HUMAN_APPROVED` — nhân viên đã đọc câu máy soạn rồi chủ động bấm gửi. Đọc
 *                      `allowHumanApprovedSend`, và phải kèm phiếu duyệt mang khoá tài khoản.
 *   `ROUNDTRIP_TEST` — một chuỗi CỐ ĐỊNH (không phải câu của mô hình) tới hội thoại trong danh
 *                      sách trắng, để chứng minh đường truyền hai chiều còn sống.
 *
 * VÌ SAO TÁCH: một cờ gộp "cho phép gửi tin" thì ngày mở nấc COPILOT để nhân viên bấm gửi cũng là
 * ngày mở luôn đường cho máy tự gửi. Hai việc ấy có hai mức rủi ro khác hẳn nhau. Sau khi tách,
 * câu "máy có tự nhắn khách được không" trả lời được bằng đúng MỘT biến môi trường.
 */
import { modeAtLeast, type AgentMode, type SendKind } from "@/lib/constants/ai";
import { getAiSettings, type AiSettings } from "@/lib/ai-workforce/config";
import { getAgent } from "@/lib/ai-workforce/registry";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

/** Tin kiểm thử vòng khép kín. TẤT ĐỊNH và nhận ra được — không bao giờ là câu của mô hình. */
export const ROUNDTRIP_TEST_MESSAGE = "[ERP] Kiểm tra đường truyền tin nhắn — tin tự động, chị bỏ qua giúp em ạ.";

export type SendDecision = { allowed: true; kind: SendKind; reason: string } | { allowed: false; reason: string };

export type SendRequest = {
  mode: AgentMode;
  conversationExternalId: string;
  text: string;
  /** Người đã cầm hội thoại chưa — cầm rồi thì MÁY tuyệt đối im lặng (người vẫn gửi được). */
  humanTakeover: boolean;
  /**
   * KHOÁ TÀI KHOẢN của người bấm gửi. Có khoá = phiếu duyệt của người; `undefined` = MÁY gửi.
   *
   * Là một KHOÁ chứ không phải một cờ `approved: true` có chủ ý: một cờ bool thì bất cứ nơi gọi
   * nào cũng đặt được, còn một khoá tài khoản thì phải lấy từ một phiên đăng nhập có thật. Job nền
   * không có phiên, nên không có khoá, nên không bao giờ đi được vào nhánh `HUMAN_APPROVED`.
   */
  approvedByUserId?: string | null;
};

/**
 * Có được gửi không. HÀM THUẦN — kiểm thử được mọi tổ hợp mà không cần mạng, không cần CSDL.
 */
export function canSend(request: SendRequest, settings: AiSettings): SendDecision {
  if (!settings.enabled) return { allowed: false, reason: "Nền tảng AI đang tắt" };
  if (!request.text.trim()) return { allowed: false, reason: "Không có nội dung để gửi" };

  const nguoiBam = Boolean(request.approvedByUserId);

  // TIN KIỂM THỬ: một chuỗi CỐ ĐỊNH, chỉ tới hội thoại trong danh sách trắng. Không mang một chữ
  // nào của mô hình, nên nó đứng riêng và không mở đường cho bất cứ câu nào khác.
  if (request.text === ROUNDTRIP_TEST_MESSAGE) {
    if (!settings.hardLimits.allowHumanApprovedSend) {
      return { allowed: false, reason: "AI_ALLOW_HUMAN_APPROVED_SEND=false — môi trường này cấm mọi tin rời khỏi ERP" };
    }
    return settings.testConversationIds.includes(request.conversationExternalId)
      ? { allowed: true, kind: "ROUNDTRIP_TEST", reason: "Tin kiểm thử tất định tới hội thoại trong danh sách trắng" }
      : { allowed: false, reason: "Hội thoại không nằm trong danh sách trắng kiểm thử" };
  }

  /*
    HAI NHÁNH, ĐỌC HAI CÔNG TẮC KHÁC NHAU — và đây là toàn bộ ý nghĩa của bản tách này.

    Nhánh NGƯỜI BẤM không bao giờ đọc `allowAutoSend`, nhánh MÁY TỰ GỬI không bao giờ đọc
    `allowHumanApprovedSend`. Nên bật một cái không thể vô tình mở cái kia.
  */
  if (nguoiBam) {
    if (!settings.hardLimits.allowHumanApprovedSend) {
      return { allowed: false, reason: "AI_ALLOW_HUMAN_APPROVED_SEND=false — môi trường này cấm cả tin do nhân viên bấm gửi" };
    }
    if (!modeAtLeast(request.mode, "COPILOT")) {
      return { allowed: false, reason: `Nấc ${request.mode}: câu do AI soạn chỉ là GỢI Ý, chưa tới nấc cho nhân viên bấm gửi` };
    }
    // Người đã cầm hội thoại KHÔNG chặn người bấm gửi: chính người ấy đang ngồi trả lời khách.
    return { allowed: true, kind: "HUMAN_APPROVED", reason: "Nhân viên đã duyệt và bấm gửi" };
  }

  if (!settings.hardLimits.allowAutoSend) {
    return { allowed: false, reason: "AI_ALLOW_AUTO_SEND=false — môi trường này cấm máy tự gửi tin" };
  }
  if (request.humanTakeover) return { allowed: false, reason: "Người đã tiếp nhận hội thoại — máy không gửi gì nữa" };
  // Không có phiếu duyệt của người ⇒ đây là MÁY tự gửi ⇒ phải tới nấc AUTO. Nấc COPILOT mà không
  // có khoá tài khoản nghĩa là một job nào đó đang cố gửi thay nhân viên: chặn.
  if (!modeAtLeast(request.mode, "AUTO")) {
    return { allowed: false, reason: `Nấc ${request.mode}: không có phiếu duyệt của người thì chỉ nấc AUTO mới được gửi` };
  }
  return { allowed: true, kind: "AUTO", reason: "Nấc AUTO cho phép máy tự gửi" };
}

export type SendOutcome = { sent: boolean; reason: string; messageId?: string; error?: string };

/**
 * CHỐT CHẶN CỨNG — nấc quyền hạn đọc lại từ CSDL, không nhận từ nơi gọi.
 *
 * `canSend()` là hàm thuần nên kiểm thử được, nhưng nó tin vào `request.mode` mà nơi gọi đưa
 * xuống. Chốt này bịt đúng lỗ hổng đó: dù một lỗi lập trình, một câu trả lời dị thường của mô
 * hình hay một lời gọi từ nơi khác có đặt `mode: "AUTO"`, con số quyết định vẫn là dòng trong
 * bảng `ai_agents` cộng với cấu hình `ai.config` — đọc lại NGAY TRƯỚC lời gọi mạng.
 *
 * Nói cách khác: muốn gửi được tin cho khách phải đổi DỮ LIỆU trong CSDL, không đổi được bằng
 * cách làm mô hình trả về một chuỗi khác.
 */
export async function assertOutboundAllowed(request: SendRequest, settings?: AiSettings): Promise<SendDecision> {
  const cfg = settings ?? (await getAiSettings());
  const agent = await getAgent("sales", cfg);
  if (!agent) return { allowed: false, reason: "Không tìm thấy nhân sự bán hàng trong sổ đăng ký" };
  // Nấc THẬT lấy từ CSDL; nấc do nơi gọi đưa xuống chỉ được dùng để LÀM HẸP thêm, không nới ra.
  const effective = modeAtLeast(request.mode, agent.mode) ? agent.mode : request.mode;
  const decision = canSend({ ...request, mode: effective }, cfg);
  if (decision.allowed) return decision;
  return decision;
}

/**
 * Gửi tin. Đây là nơi DUY NHẤT trong kho mã gọi API gửi tin của Pancake cho nhân sự AI, và nó
 * luôn đi qua `assertOutboundAllowed()` — nên chỉ cần đọc một hàm là kiểm chứng được lời khẳng
 * định "nấc chạy ngầm không gửi gì cho khách".
 */
export async function sendSalesMessage(request: SendRequest & { pageId: string; pancakeCustomerId: string }, settings?: AiSettings): Promise<SendOutcome> {
  const cfg = settings ?? (await getAiSettings());
  const decision = await assertOutboundAllowed(request, cfg);
  if (!decision.allowed) return { sent: false, reason: decision.reason };
  const client = getPancakePagesClient();
  const result = await client.sendMessage(request.pageId, request.conversationExternalId, request.pancakeCustomerId, request.text);
  if (!result.ok) return { sent: false, reason: decision.reason, error: result.error };
  return { sent: true, reason: decision.reason, messageId: result.id };
}
