import { config, loadSystemPrompt } from "./config.js";
import { catalog } from "./catalog.js";

/**
 * Ghep system prompt hoan chinh: thay {{SHOP_NAME}}, {{CATALOG}} + ngu canh hien tai.
 * Dung chung cho bot that va cac script test de ket qua giong nhau.
 */
export function renderSystemPrompt(template, { shopName, customerName, type = "INBOX", extraPrompt = "", commentMode = "public" } = {}) {
  const name = shopName || config.shopName || "shop";
  let prompt = template.replaceAll("{{SHOP_NAME}}", name);
  const catalogText = catalog.toPromptText();
  if (prompt.includes("{{CATALOG}}")) prompt = prompt.replaceAll("{{CATALOG}}", catalogText);
  else if (catalog.products.length) prompt += `\n\n## Danh mục sản phẩm (đồng bộ từ POS)\n${catalogText}`;
  if (extraPrompt && extraPrompt.trim()) {
    prompt += `\n\n## Hướng dẫn riêng cho page ${name} (ưu tiên hơn các mục trên nếu mâu thuẫn)\n${extraPrompt.trim()}`;
  }
  // Lam tron den gio de system prompt giong nhau giua cac lan goi -> Gemini cache prefix (giam ~75% gia phan input duoc cache)
  const d = new Date();
  const now = d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + ", khoảng " + d.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit" }).replace(/:\d\d$/, "") + "h";
  prompt += `\n\n## Ngữ cảnh hiện tại\n- Page đang chat: ${name}\n- Tên hiển thị của khách: ${customerName || "(không rõ)"}\n- Thời gian hiện tại: ${now}\n- Kênh: ${type === "INBOX" ? "tin nhắn riêng" : commentMode === "inbox" ? "khách vừa BÌNH LUẬN dưới bài viết; câu trả lời của bạn sẽ được gửi vào INBOX của khách (chỉ khách thấy). Hãy chào, nhắc mẫu khách hỏi, tư vấn/báo giá đầy đủ theo kịch bản như tin inbox đầu tiên và mời khách trả lời trong tin nhắn này." : "BÌNH LUẬN CÔNG KHAI dưới bài viết, mọi người đều đọc được. Trả lời 1–2 câu thân thiện, không xin số điện thoại/địa chỉ công khai, giá chỉ nêu ngắn gọn nếu khách hỏi, mời khách inbox để được tư vấn size và ưu đãi. Không gửi mã ảnh [[IMG]] trong bình luận."}`;
  return prompt;
}

/** Cho script: nap prompt tu file + catalog (dong bo POS neu co cau hinh) */
export async function buildStandalonePrompt({ customerName = "Khách test", refreshCatalog = true } = {}) {
  if (refreshCatalog && catalog.enabled) {
    try {
      await catalog.refresh();
    } catch (e) {
      console.log("(POS loi:", e.message, "- dung cache neu co)");
    }
  }
  const shopName = Object.values(config.pages)[0]?.name || config.shopName || "Shop";
  return renderSystemPrompt(loadSystemPrompt(), { shopName, customerName });
}
