/**
 * SOẠN CÂU TRẢ LỜI CHO HÀNG TEST — chỉ bằng dữ kiện ĐÃ KHAI của chính mẫu test.
 *
 * Mục tiêu của hàng test KHÔNG phải chốt nhiều đơn nhất, mà là trả lời khách tử tế và đo xem thị
 * trường có muốn mẫu này không. Vì vậy nó có bộ luật riêng, không dùng chung với hàng thắng.
 *
 * LUẬT KHÔNG ĐƯỢC PHÁ, và đây là toàn bộ lý do tệp này tồn tại: THIẾU DỮ KIỆN THÌ NÓI CHƯA CÓ,
 * TUYỆT ĐỐI KHÔNG MƯỢN CỦA MÃ WIN. Mượn giá của mẫu thắng để trả lời về một mẫu khác là báo sai
 * giá một mặt hàng khác — khách nhớ con số ấy, và shop phải chịu nó.
 *
 * HÀM THUẦN: không đọc CSDL, không gọi mô hình. Gọi lại bao nhiêu lần cũng ra một câu.
 */
import { formatVND } from "@/lib/format";
import type { TestReplyPolicy } from "@/lib/constants/fanpage-sales";

/** Dữ kiện đã khai của một mẫu test. `null` / rỗng = CHƯA KHAI, không phải "không có". */
export type TestFacts = {
  testCode: string;
  name: string;
  price: number | null;
  colors: string[];
  material: string;
  shippingPolicy: string;
  /** Có bảng số đo riêng của mẫu test hay không. KHÔNG bao giờ lấy bảng của mẫu thắng. */
  hasSizeProfile: boolean;
  approvedFacts: string[];
  policy: TestReplyPolicy;
};

export type TestIntent = "PRICE" | "COLOR" | "SIZE" | "MATERIAL" | "SHIPPING" | "BUY" | "OTHER";

export type TestReply = {
  /** ANSWER = trả lời được · ASK = trả lời rồi hỏi thêm · HANDOFF = phải chuyển người. */
  action: "ANSWER" | "ASK" | "HANDOFF";
  handoffReason: "TEST_DATA_MISSING" | "TEST_READY_TO_BUY" | "TEST_AI_DISABLED" | null;
  text: string;
  /** Trường đã dùng để soạn câu — đọc lại được, khỏi phải đoán máy lấy số ở đâu. */
  used: string[];
  /** Trường THIẾU khiến câu trả lời phải né. Đây là danh sách việc cần khai thêm. */
  missing: string[];
};

/** Nhận ra khách đang hỏi gì. Luật từ khoá, không gọi mô hình. */
export function testIntentOf(text: string): TestIntent {
  const t = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
  if (/(bao nhieu|gia|nhieu tien|may tien)/.test(t)) return "PRICE";
  if (/(mau gi|co mau|mau nao|mau sac)/.test(t)) return "COLOR";
  if (/(size|sz|mac size|so do|cao|nang|kg|m[0-9])/.test(t)) return "SIZE";
  if (/(chat lieu|vai|co gian|day hay mong)/.test(t)) return "MATERIAL";
  if (/(ship|giao hang|phi van chuyen|bao lau)/.test(t)) return "SHIPPING";
  if (/(mua|dat|chot|lay mot|lay 1|order)/.test(t)) return "BUY";
  return "OTHER";
}

/** Câu hỏi thu tín hiệu, chỉ thêm khi được phép — đây là mục tiêu thật của hàng test. */
function hoiThem(f: TestFacts): string {
  if (!f.policy.allowCollectPreference) return "";
  return f.colors.length
    ? ` Chị thích màu ${f.colors.join(" hay ")} ạ?`
    : " Chị thích kiểu này không để em ghi nhận giúp chị ạ?";
}

export function generateTestReply(intent: TestIntent, f: TestFacts): TestReply {
  if (!f.policy.aiReplyEnabled) {
    return { action: "HANDOFF", handoffReason: "TEST_AI_DISABLED", text: "", used: [], missing: [] };
  }

  switch (intent) {
    case "PRICE": {
      // Chưa khai giá ⇒ KHÔNG báo giá. Không có đường nào lấy giá của mẫu thắng ra đây.
      if (f.price === null || !f.policy.allowQuotePrice) {
        return {
          action: "HANDOFF",
          handoffReason: "TEST_DATA_MISSING",
          text: "Dạ mẫu này bên em đang chạy thử nên giá em chưa chốt được ạ. Chị chờ em một chút, em nhờ bạn phụ trách báo giá chính xác cho chị nhé.",
          used: [],
          missing: ["giá test"],
        };
      }
      return {
        action: "ASK",
        handoffReason: null,
        text: `Dạ mẫu này bên em đang có giá ${formatVND(f.price)} chị nhé.${hoiThem(f)}`,
        used: ["giá test"],
        missing: [],
      };
    }

    case "COLOR": {
      if (!f.colors.length) {
        return {
          action: "HANDOFF",
          handoffReason: "TEST_DATA_MISSING",
          text: "Dạ mẫu này bên em mới ra nên em chưa có đủ thông tin màu ạ. Chị chờ em hỏi lại bạn phụ trách rồi báo chị ngay nhé.",
          used: [],
          missing: ["màu"],
        };
      }
      return {
        action: "ASK",
        handoffReason: null,
        text: `Dạ mẫu này bên em đang có ${f.colors.join(", ")} ạ. Chị thích màu nào để em ghi nhận giúp chị?`,
        used: ["màu"],
        missing: [],
      };
    }

    case "SIZE": {
      // ĐIỂM DỄ SAI NHẤT. Mẫu test chưa có bảng số đo mà vẫn trả lời một con số là đoán trên cơ
      // thể một người thật — và nếu lấy bảng của mẫu thắng thì còn tệ hơn: đúng bảng, sai mẫu.
      if (!f.hasSizeProfile) {
        return {
          action: "HANDOFF",
          handoffReason: "TEST_DATA_MISSING",
          text: "Dạ mẫu này đang chạy thử nên em chưa có bảng số đo chuẩn để tư vấn size cho chị ạ. Em nhờ bạn phụ trách xem số đo rồi tư vấn chính xác cho chị nhé, tránh chị mặc không vừa.",
          used: [],
          missing: ["bảng số đo của mẫu test"],
        };
      }
      return {
        action: "ASK",
        handoffReason: null,
        text: "Dạ chị cho em xin chiều cao và cân nặng để em tra bảng size của mẫu này giúp chị ạ.",
        used: ["bảng số đo của mẫu test"],
        missing: [],
      };
    }

    case "MATERIAL": {
      if (!f.material) {
        return {
          action: "HANDOFF",
          handoffReason: "TEST_DATA_MISSING",
          text: "Dạ mẫu này bên em đang chạy thử, phần chất liệu em chưa có thông tin chính thức ạ. Em nhờ bạn phụ trách trả lời chị cho chuẩn nhé.",
          used: [],
          missing: ["chất liệu"],
        };
      }
      return { action: "ANSWER", handoffReason: null, text: `Dạ mẫu này chất liệu ${f.material} ạ.${hoiThem(f)}`, used: ["chất liệu"], missing: [] };
    }

    case "SHIPPING": {
      if (!f.shippingPolicy) {
        return {
          action: "HANDOFF",
          handoffReason: "TEST_DATA_MISSING",
          text: "Dạ phần giao hàng của mẫu này em chưa có thông tin chính thức ạ, em nhờ bạn phụ trách báo lại chị nhé.",
          used: [],
          missing: ["chính sách giao hàng"],
        };
      }
      return { action: "ANSWER", handoffReason: null, text: `Dạ ${f.shippingPolicy} ạ.`, used: ["chính sách giao hàng"], missing: [] };
    }

    case "BUY": {
      // Khách muốn mua mà mẫu chưa lên đơn được ⇒ CHUYỂN NGƯỜI. Tuyệt đối không đổi sang mã WIN
      // để "cho xong đơn" — đó là bán cho khách một mặt hàng khác thứ họ vừa hỏi.
      if (!f.policy.allowAutoOrderCreate) {
        return {
          action: "HANDOFF",
          handoffReason: "TEST_READY_TO_BUY",
          text: "Dạ em cảm ơn chị ạ. Mẫu này bên em đang chạy thử nên em nhờ bạn phụ trách chốt đơn trực tiếp với chị để chắc chắn nhất nhé.",
          used: [],
          missing: f.price === null ? ["giá test"] : [],
        };
      }
      return { action: "ANSWER", handoffReason: null, text: "Dạ chị cho em xin tên, số điện thoại và địa chỉ để em ghi nhận giúp chị ạ.", used: [], missing: [] };
    }

    default: {
      const co = [f.name ? `mẫu ${f.name}` : "", f.material, f.colors.length ? f.colors.join(", ") : ""].filter(Boolean);
      return {
        action: co.length ? "ASK" : "HANDOFF",
        handoffReason: co.length ? null : "TEST_DATA_MISSING",
        text: co.length
          ? `Dạ ${co[0]} bên em đang chạy thử ạ.${hoiThem(f)}`
          : "Dạ chị chờ em một chút, em nhờ bạn phụ trách hỗ trợ chị ngay ạ.",
        used: co.length ? ["tên mẫu"] : [],
        missing: co.length ? [] : ["tên mẫu", "chất liệu", "màu"],
      };
    }
  }
}
