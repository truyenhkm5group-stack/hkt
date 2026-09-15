/**
 * THU TÍN HIỆU THỊ TRƯỜNG TỪ HỘI THOẠI HÀNG TEST.
 *
 * Mục tiêu của một mẫu đang test KHÔNG phải chốt nhiều đơn nhất, mà là trả lời khách tử tế và đo
 * xem thị trường có muốn mẫu này không. Phần "đo" ấy chính là tệp này — không có nó thì mỗi lượt
 * test để lại đúng một thứ: vài hội thoại không ai đọc lại.
 *
 * ─── CHỈ GHI ĐIỀU QUAN SÁT ĐƯỢC, VÀ CHỈ NÂNG ───
 *
 * `null` là CHƯA THẤY, không phải "không". Khách hỏi giá ở tin thứ nhất rồi hỏi màu ở tin thứ hai
 * thì tin thứ hai KHÔNG được hạ `askedPrice` về `false` — mỗi tin chỉ nói được điều nó thấy, không
 * nói được điều nó không thấy. Vì vậy phép ghi ở đây chỉ NÂNG `null → true`, không bao giờ ngược
 * lại, và không bao giờ ghi `false` cho một ô chưa quan sát được.
 *
 * ─── MÔ HÌNH KHÔNG QUYẾT Ở ĐÂY ───
 *
 * Toàn bộ là luật từ khoá, hàm thuần. Một tín hiệu sai vì mô hình đoán nhầm sẽ đi thẳng vào báo
 * cáo R&D và thành căn cứ để quyết có sản xuất mẫu ấy hay không — đắt hơn nhiều so với việc bỏ sót
 * một tín hiệu.
 */
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { extractMeasurements } from "@/lib/ai-workforce/agents/sales/extract-slots";

export type TestSignal = {
  customerInterest?: boolean;
  purchaseIntent?: boolean;
  askedPrice?: boolean;
  priceObjection?: boolean;
  requestedColor?: string;
  requestedSize?: string;
  heightCm?: number;
  weightKg?: number;
  materialQuestion?: boolean;
  sizeQuestion?: boolean;
  shippingQuestion?: boolean;
  likedDesign?: boolean;
  dislikedDesign?: boolean;
  readyToBuy?: boolean;
  objectionCategory?: string;
};

const MAU = ["đỏ", "đỏ đô", "đen", "nâu", "trắng", "xanh", "be", "kem", "hồng", "vàng", "xám", "tím"];
const SIZE = ["s", "m", "l", "xl", "xxl", "2xl", "3xl", "freesize"];

function bo(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
}

/** Rút tín hiệu từ MỘT tin của khách. Chỉ trả về ô thật sự quan sát được. */
export function extractTestSignals(text: string): TestSignal {
  const raw = text.toLowerCase();
  const t = bo(text);
  const s: TestSignal = {};

  if (/(bao nhieu|gia bao|nhieu tien|may tien|gia sao)/.test(t)) { s.askedPrice = true; s.customerInterest = true; }
  if (/(dat hang|chot|lay 1|lay mot|mua|order|ship cho em|cho em dat)/.test(t)) { s.purchaseIntent = true; s.readyToBuy = true; s.customerInterest = true; }
  if (/(dat qua|mac qua|sao dat the|giam duoc khong|bot chut|re hon)/.test(t)) { s.priceObjection = true; s.objectionCategory = "GIÁ"; }
  if (/(chat lieu|vai gi|co gian|day hay mong|noi khong)/.test(t)) { s.materialQuestion = true; s.customerInterest = true; }
  if (/(size|so do|mac size|cao [0-9]|nang [0-9]|[0-9]+\s*kg)/.test(t)) { s.sizeQuestion = true; s.customerInterest = true; }
  if (/(ship|giao hang|phi van chuyen|bao lau|may ngay)/.test(t)) { s.shippingQuestion = true; s.customerInterest = true; }
  if (/(dep qua|thich mau|xinh qua|ung|dep the|iu thich)/.test(t)) { s.likedDesign = true; s.customerInterest = true; }
  if (/(xau|khong thich|khong hop|nhin chan|kieu nay khong)/.test(t)) { s.dislikedDesign = true; }

  // Màu / size khách NÊU TÊN — đây là dữ liệu quý nhất của một lượt test: thị trường tự nói nó
  // muốn màu nào, mà không ai phải đi hỏi.
  const mau = MAU.filter((m) => raw.includes(m)).sort((a, b) => b.length - a.length)[0];
  if (mau) { s.requestedColor = mau; s.customerInterest = true; }
  const msz = t.match(/\b(size|sz)\s*(s|m|l|xl|xxl|2xl|3xl|freesize)\b/);
  if (msz && SIZE.includes(msz[2])) s.requestedSize = msz[2].toUpperCase();

  // Số đo dùng CHUNG bộ bóc với máy gợi ý size (`extract-slots.ts`). Hai bộ luật bóc số đo song
  // song là hai cách hiểu khác nhau về cùng một câu khách, và cái lệch sẽ lộ ra ở chỗ tệ nhất:
  // báo cáo R&D nói một đằng, lời tư vấn size nói một nẻo.
  const sd = extractMeasurements(text);
  if (typeof sd.heightCm === "number") s.heightCm = sd.heightCm;
  if (typeof sd.weightKg === "number") s.weightKg = sd.weightKg;

  return s;
}

/**
 * Ghi tín hiệu vào hội thoại — MỘT dòng cho mỗi hội thoại, mỗi tin làm nó đầy thêm.
 *
 * Phép gộp dùng `or` cho cờ và `coalesce(cũ, mới)` cho ô chữ / số: điều đã quan sát được không bao
 * giờ bị một tin sau xoá đi, và ô đã có giá trị thì giữ giá trị ĐẦU — khách nói "đỏ" rồi đổi ý sang
 * "đen" thì cả hai đều thật, nhưng cái đầu mới là cái quảng cáo đã kéo họ vào.
 */
export async function recordTestSignal(
  input: { conversationId: string; testProductId: string; runId: string | null; text: string },
  db: Db,
): Promise<TestSignal | null> {
  const s = extractTestSignals(input.text);
  if (!Object.keys(s).length) return null;

  await db
    .insert(schema.testMarketSignals)
    .values({
      testProductId: input.testProductId,
      conversationId: input.conversationId,
      runId: input.runId,
      customerInterest: s.customerInterest ?? null,
      purchaseIntent: s.purchaseIntent ?? null,
      askedPrice: s.askedPrice ?? null,
      priceObjection: s.priceObjection ?? null,
      requestedColor: s.requestedColor ?? "",
      requestedSize: s.requestedSize ?? "",
      heightCm: s.heightCm ?? null,
      weightKg: s.weightKg ?? null,
      materialQuestion: s.materialQuestion ?? null,
      sizeQuestion: s.sizeQuestion ?? null,
      shippingQuestion: s.shippingQuestion ?? null,
      likedDesign: s.likedDesign ?? null,
      dislikedDesign: s.dislikedDesign ?? null,
      readyToBuy: s.readyToBuy ?? null,
      objectionCategory: s.objectionCategory ?? "",
    })
    .onConflictDoUpdate({
      target: schema.testMarketSignals.conversationId,
      set: {
        customerInterest: sql`${schema.testMarketSignals.customerInterest} or excluded.customer_interest`,
        purchaseIntent: sql`${schema.testMarketSignals.purchaseIntent} or excluded.purchase_intent`,
        askedPrice: sql`${schema.testMarketSignals.askedPrice} or excluded.asked_price`,
        priceObjection: sql`${schema.testMarketSignals.priceObjection} or excluded.price_objection`,
        materialQuestion: sql`${schema.testMarketSignals.materialQuestion} or excluded.material_question`,
        sizeQuestion: sql`${schema.testMarketSignals.sizeQuestion} or excluded.size_question`,
        shippingQuestion: sql`${schema.testMarketSignals.shippingQuestion} or excluded.shipping_question`,
        likedDesign: sql`${schema.testMarketSignals.likedDesign} or excluded.liked_design`,
        dislikedDesign: sql`${schema.testMarketSignals.dislikedDesign} or excluded.disliked_design`,
        readyToBuy: sql`${schema.testMarketSignals.readyToBuy} or excluded.ready_to_buy`,
        requestedColor: sql`coalesce(nullif(${schema.testMarketSignals.requestedColor}, ''), excluded.requested_color)`,
        requestedSize: sql`coalesce(nullif(${schema.testMarketSignals.requestedSize}, ''), excluded.requested_size)`,
        heightCm: sql`coalesce(${schema.testMarketSignals.heightCm}, excluded.height_cm)`,
        weightKg: sql`coalesce(${schema.testMarketSignals.weightKg}, excluded.weight_kg)`,
        objectionCategory: sql`coalesce(nullif(${schema.testMarketSignals.objectionCategory}, ''), excluded.objection_category)`,
      },
    });
  return s;
}
