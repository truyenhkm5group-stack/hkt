/**
 * CỔNG GỬI TIN RA — chốt chặn cuối cùng trước khi bất cứ chữ nào tới tay khách.
 *
 * LUẬT CỦA GIAI ĐOẠN NÀY: **ở nấc SHADOW, không một câu do AI sinh ra được gửi cho khách.**
 * Không có cờ nào, không có tham số nào, không có nhánh nào mở được điều đó. Cổng này là nơi duy
 * nhất trong mã nguồn gọi tới API gửi tin của Pancake cho nhân sự AI, nên chỉ cần đọc một tệp là
 * kiểm chứng được lời khẳng định trên.
 *
 * Ngoại lệ DUY NHẤT, và nó không phải ngoại lệ của luật trên: một hội thoại được ghi tên trong
 * danh sách trắng có thể nhận một tin KIỂM THỬ TẤT ĐỊNH — chuỗi cố định dưới đây, không phải câu
 * do mô hình sinh ra — để kiểm chứng đường truyền hai chiều thật sự chạy.
 */
import { modeAtLeast, type AgentMode } from "@/lib/constants/ai";
import { getAiSettings, type AiSettings } from "@/lib/ai/config";
import { getAgent } from "@/lib/ai/registry";
import { getPancakePagesClient } from "@/lib/integrations/pancake/pages";

/** Tin kiểm thử vòng khép kín. TẤT ĐỊNH và nhận ra được — không bao giờ là câu của mô hình. */
export const ROUNDTRIP_TEST_MESSAGE = "[ERP] Kiểm tra đường truyền tin nhắn — tin tự động, chị bỏ qua giúp em ạ.";

export type SendDecision =
  | { allowed: true; kind: "AGENT_REPLY" | "ROUNDTRIP_TEST"; reason: string }
  | { allowed: false; reason: string };

export type SendRequest = {
  mode: AgentMode;
  conversationExternalId: string;
  text: string;
  /** Người đã cầm hội thoại chưa — cầm rồi thì máy tuyệt đối im lặng. */
  humanTakeover: boolean;
  /** Đã có phiếu duyệt của người cho tin này chưa (bắt buộc từ nấc COPILOT). */
  approved?: boolean;
};

/**
 * Có được gửi không. HÀM THUẦN — kiểm thử được mọi tổ hợp mà không cần mạng, không cần CSDL.
 */
export function canSend(request: SendRequest, settings: AiSettings): SendDecision {
  // CHẶN CỨNG TRƯỚC MỌI THỨ KHÁC. Công tắc này đọc từ biến môi trường và không có đường nào ghi đè
  // từ CSDL, nên nó đứng đầu hàng: không nấc quyền hạn nào, không phiếu duyệt nào, không danh sách
  // trắng nào đi vòng qua được. Trên bản chạy thử cắm vào page Pancake THẬT, đây là câu trả lời cho
  // "có tổ hợp cấu hình nào lỡ nhắn cho khách thật không".
  if (!settings.hardLimits.allowCustomerSend) {
    return { allowed: false, reason: "AI_ALLOW_CUSTOMER_SEND=false — môi trường này cấm mọi tin gửi tới khách" };
  }
  if (!settings.enabled) return { allowed: false, reason: "Nền tảng AI đang tắt" };
  if (request.humanTakeover) return { allowed: false, reason: "Người đã tiếp nhận hội thoại — máy không gửi gì nữa" };
  if (!request.text.trim()) return { allowed: false, reason: "Không có nội dung để gửi" };

  const whitelisted = settings.testConversationIds.includes(request.conversationExternalId);
  if (request.text === ROUNDTRIP_TEST_MESSAGE) {
    // Tin kiểm thử: CHỈ tới hội thoại trong danh sách trắng, không bao giờ tới khách thật.
    return whitelisted
      ? { allowed: true, kind: "ROUNDTRIP_TEST", reason: "Tin kiểm thử tất định tới hội thoại trong danh sách trắng" }
      : { allowed: false, reason: "Hội thoại không nằm trong danh sách trắng kiểm thử" };
  }

  // Đây là luật của giai đoạn: SHADOW không gửi câu do AI sinh ra, chấm hết.
  if (!modeAtLeast(request.mode, "COPILOT")) {
    return { allowed: false, reason: `Nấc ${request.mode}: câu do AI soạn chỉ là GỢI Ý cho nhân viên, không gửi cho khách` };
  }
  if (request.mode === "COPILOT" && !request.approved) {
    return { allowed: false, reason: "Nấc COPILOT: phải có người duyệt trước khi gửi" };
  }
  return { allowed: true, kind: "AGENT_REPLY", reason: `Nấc ${request.mode} cho phép gửi` };
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
