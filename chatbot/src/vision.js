import { config } from "./config.js";
import { catalog } from "./catalog.js";
import { generateReply } from "./ai.js";
import { fetchImageAsBase64 } from "./util.js";
import { log } from "./logger.js";

/**
 * Nhan dien anh khach gui: so voi anh that cua tung mau/mau sac trong POS.
 * Dung chung cho bot (truoc khi soan tra loi) va tro ly AI (identify_product_in_image).
 * @param {{mimeType:string,data:string}} image
 * @returns {Promise<{matched:boolean, code:string, color:string, confidence:string, text:string, comparedWith:number}>}
 */
export async function identifyProduct(image, { note = "" } = {}) {
  const refs = catalog.referenceImages(config.vision.referenceImages);
  if (!refs.length) return { matched: false, code: "", color: "", confidence: "thấp", text: "POS chưa có ảnh sản phẩm để so sánh", comparedWith: 0 };
  const images = [];
  const labels = [];
  for (const r of refs) {
    const img = await fetchImageAsBase64(r.url, { maxBytes: config.vision.maxBytes });
    if (!img) continue;
    images.push(img);
    labels.push(`Ảnh ${images.length}: ${r.label}`);
  }
  images.push(image);
  const codes = [...new Set(refs.map((r) => r.code))].join(", ");
  const sys = `Bạn là chuyên gia nhận diện sản phẩm thời trang. Các ảnh đầu là ảnh tham chiếu của shop (mỗi ảnh có nhãn mã + màu). Ảnh CUỐI CÙNG là ảnh cần nhận diện (ảnh khách gửi, có thể là ảnh chụp màn hình, ảnh chụp lại, ảnh quảng cáo). So sánh kiểu dáng (cổ, tay, eo, độ dài, chi tiết xếp ly/bèo/nút), họa tiết và màu sắc. Chỉ kết luận KHỚP khi kiểu dáng thực sự giống một mẫu tham chiếu; khác kiểu dáng thì là "Không khớp" dù cùng màu. Ảnh không phải sản phẩm thời trang (hóa đơn, chat, số đo, vật khác) → "Không khớp". Trả lời đúng định dạng 3 dòng:\nKết luận: <một trong: ${codes}> màu <màu> | hoặc: Không khớp mẫu nào\nĐộ tin cậy: cao/trung bình/thấp\nLý do: 1 câu`;
  const r = await generateReply(sys, [{ role: "user", text: `${labels.join("\n")}\nẢnh ${images.length}: ẢNH CẦN NHẬN DIỆN${note ? " (gợi ý: " + note + ")" : ""}`, images }], { model: config.vision.model, temperature: 0.1, maxOutputTokens: 300, thinkingBudget: -1 });
  const text = r.text.trim();
  const m = text.match(/Kết luận:\s*([A-Za-z0-9_\-\s]+?)\s*màu\s*([^\n|]+)/i);
  const none = /không khớp/i.test(text);
  const confidence = (text.match(/Độ tin cậy:\s*([^\n]+)/i)?.[1] || "thấp").trim().toLowerCase();
  const out = { matched: !none && !!m, code: m?.[1]?.trim() || "", color: m?.[2]?.trim() || "", confidence, text, comparedWith: labels.length };
  log.debug(`Nhan dien anh: ${JSON.stringify({ matched: out.matched, code: out.code, color: out.color, confidence })}`);
  return out;
}
