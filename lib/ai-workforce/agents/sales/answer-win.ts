/**
 * SOẠN CÂU TRẢ LỜI TỪ SỔ DỮ KIỆN — và chỉ từ đó.
 *
 * Mỗi câu ra khỏi đây đều truy được về một ô dữ liệu có người khai: hỏi giá thì lấy ô giá, hỏi
 * kiểm hàng thì lấy ô chính sách kiểm hàng. Ô trống ⇒ KHÔNG trả lời ⇒ chuyển người. Không nhánh
 * nào ở đây đi tìm một giá trị thay thế, và đó là toàn bộ điểm của tệp.
 *
 * ─── DỮ LIỆU LÀ SỰ THẬT · MÔ HÌNH CHỈ LÀ CÁCH NÓI ───
 *
 * Mô hình ngôn ngữ, khi bật, được phép diễn đạt lại câu ở đây cho tự nhiên hơn — đổi cách xưng hô,
 * ghép hai ý, bớt một chữ. Nó KHÔNG được thêm một dữ kiện nào: không con số mới, không cam kết
 * mới, không màu mới. Ranh giới ấy phân được vì mọi con số đi kèm `provenance`: câu nào mang một
 * con số không có trong danh sách ấy là câu mô hình tự nghĩ ra.
 *
 * HÀM THUẦN: không đọc CSDL, không gọi mô hình. Cùng dữ kiện thì cùng một câu, chạy bao nhiêu lần
 * cũng vậy — nên nó kiểm thử được, và nó là cái mốc để đối chiếu khi mô hình thật bật lên.
 */
import { formatVND } from "@/lib/format";
import { computeCapabilities, type SalesCapability, type SalesKnowledge } from "@/lib/constants/sales-capabilities";

export type WinIntent =
  | "PRICE" | "SHIPPING" | "COMBO" | "COLOR" | "SIZE" | "MATERIAL"
  | "COD" | "INSPECTION" | "DELIVERY" | "EXCHANGE" | "STOCK" | "BUY" | "OTHER";

/** Một mảnh dữ kiện đã dùng, kèm chỗ nó được lấy ra. Đây là thứ làm câu trả lời kiểm chứng được. */
export type Provenance = {
  field: string;
  /** Bảng.cột thật trong CSDL. */
  source: string;
  value: string;
};

export type SalesAnswer = {
  intent: WinIntent;
  /** ANSWER = trả lời xong · ASK = trả lời rồi hỏi tiếp · HANDOFF = máy không được trả lời. */
  action: "ANSWER" | "ASK" | "HANDOFF";
  text: string;
  /** Năng lực đã dùng (hoặc đã bị chặn). `null` = câu không thuộc năng lực nào. */
  capability: SalesCapability | null;
  provenance: Provenance[];
  /** Trường còn thiếu khiến máy phải né. Rỗng khi trả lời được. */
  missing: string[];
  humanReview: boolean;
};

/** Nhận ra khách hỏi gì. Luật từ khoá — KHÔNG gọi mô hình, vì hiểu sai câu hỏi là trả lời sai ô. */
export function winIntentOf(text: string): WinIntent {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
  // Thứ tự có ý nghĩa: câu "mua 2 cái bao nhiêu" vừa khớp COMBO vừa khớp PRICE — combo hẹp hơn.
  if (/(combo|2 cai|hai cai|2 chiec|lay 2|mua 2|set 2)/.test(t)) return "COMBO";
  if (/(doi tra|doi size|doi mau|tra hang|bao hanh)/.test(t)) return "EXCHANGE";
  if (/(kiem tra hang|kiem hang|xem hang|boc ra xem|dong kiem)/.test(t)) return "INSPECTION";
  if (/(cod|thanh toan|tra tien|chuyen khoan|nhan hang moi tra)/.test(t)) return "COD";
  if (/(bao lau|may ngay|khi nao nhan|giao trong|thoi gian giao)/.test(t)) return "DELIVERY";
  if (/(ship|phi van chuyen|phi giao|freeship|mien ship)/.test(t)) return "SHIPPING";
  if (/(bao nhieu|gia bao|nhieu tien|may tien|gia sao|gia the nao)/.test(t)) return "PRICE";
  if (/(mau gi|co mau|mau nao|mau sac|con mau)/.test(t)) return "COLOR";
  if (/(size|sz|mac size|so do|cao [0-9]|nang [0-9]|[0-9]+\s*kg|m[0-9]{2})/.test(t)) return "SIZE";
  if (/(chat lieu|vai gi|co gian|day hay mong|noi khong)/.test(t)) return "MATERIAL";
  if (/(con hang|con size|con mau nao khong|het hang)/.test(t)) return "STOCK";
  if (/(mua|dat|chot|lay mot|lay 1|order|ship cho em)/.test(t)) return "BUY";
  return "OTHER";
}

/** Năng lực mà mỗi loại câu hỏi phải có. `null` = không cần năng lực nào. */
const CAN_NANG_LUC: Record<WinIntent, SalesCapability | null> = {
  PRICE: "CAN_QUOTE_PRICE",
  SHIPPING: "CAN_QUOTE_SHIPPING",
  COMBO: "CAN_OFFER_COMBO",
  COLOR: "CAN_ADVISE_COLOR",
  SIZE: "CAN_ADVISE_SIZE",
  MATERIAL: "CAN_EXPLAIN_MATERIAL",
  COD: "CAN_EXPLAIN_COD",
  INSPECTION: "CAN_EXPLAIN_INSPECTION",
  DELIVERY: "CAN_EXPLAIN_DELIVERY",
  EXCHANGE: "CAN_EXPLAIN_EXCHANGE",
  BUY: "CAN_COLLECT_ORDER",
  STOCK: null,
  OTHER: null,
};

/** Nhãn nguồn — cùng một hình dạng dữ kiện nhưng hai bảng khác nhau, phải nói rõ bảng nào. */
export type KnowledgeOrigin = "FANPAGE" | "TEST_PRODUCT";
const BANG: Record<KnowledgeOrigin, string> = {
  FANPAGE: "fanpage_sales_profiles",
  TEST_PRODUCT: "test_product_profiles",
};

function neTranh(intent: WinIntent, cap: SalesCapability | null, missing: string[]): SalesAnswer {
  return {
    intent,
    action: "HANDOFF",
    capability: cap,
    provenance: [],
    missing,
    humanReview: true,
    text: `Dạ phần này em xin phép nhờ bạn phụ trách trả lời chị cho chính xác ạ, em chưa có thông tin chính thức để báo chị.`,
  };
}

/**
 * Trả lời một câu hỏi từ sổ dữ kiện.
 *
 * Bước đầu tiên LUÔN là hỏi cổng năng lực. Không có nhánh nào chạy trước nó, vì một nhánh chạy
 * trước cổng là một nhánh trả lời được khi dữ liệu còn trống — đúng thứ cổng sinh ra để chặn.
 */
export function answerFromKnowledge(intent: WinIntent, k: SalesKnowledge, origin: KnowledgeOrigin = "FANPAGE"): SalesAnswer {
  const caps = computeCapabilities(k);
  const can = CAN_NANG_LUC[intent];
  const bang = BANG[origin];
  if (can && !caps[can].on) return neTranh(intent, can, caps[can].missing);

  switch (intent) {
    case "PRICE": {
      const p: Provenance[] = [{ field: "giá bán", source: `${bang}.unit_price`, value: formatVND(k.unitPrice) }];
      let t = `Dạ mẫu này bên em ${formatVND(k.unitPrice)} chị ạ`;
      if (caps.CAN_QUOTE_SHIPPING.on) {
        t += `, phí ship ${formatVND(k.shippingFee)}`;
        p.push({ field: "phí ship", source: `${bang}.shipping_fee`, value: formatVND(k.shippingFee) });
      }
      t += ".";
      // Chào combo là đường tăng giá trị đơn — nhưng chỉ khi có giá combo THẬT.
      const c2 = k.comboPricing?.find((c) => c.quantity === 2);
      if (caps.CAN_OFFER_COMBO.on && c2) {
        t += ` Nếu chị lấy 2 chiếc thì còn ${formatVND(c2.price)}${c2.freeShipping ? " và được miễn phí ship" : ""} ạ.`;
        p.push({ field: "giá combo 2", source: `${bang}.combo_pricing`, value: formatVND(c2.price) });
      }
      return { intent, action: "ANSWER", capability: can, provenance: p, missing: [], humanReview: false, text: t };
    }

    case "SHIPPING": {
      const p: Provenance[] = [{ field: "phí ship", source: `${bang}.shipping_fee`, value: formatVND(k.shippingFee) }];
      let t = `Dạ phí ship là ${formatVND(k.shippingFee)} chị ạ.`;
      const c2 = k.comboPricing?.find((c) => c.quantity === 2 && c.freeShipping);
      if (c2) {
        t += ` Chị lấy 2 chiếc thì bên em miễn phí ship ạ.`;
        p.push({ field: "miễn ship theo combo", source: `${bang}.combo_pricing`, value: "combo 2 miễn ship" });
      } else if (k.freeShipFrom !== null) {
        t += ` Đơn từ ${formatVND(k.freeShipFrom)} là bên em miễn phí ship ạ.`;
        p.push({ field: "ngưỡng miễn ship", source: `${bang}.free_ship_from`, value: formatVND(k.freeShipFrom) });
      }
      return { intent, action: "ANSWER", capability: can, provenance: p, missing: [], humanReview: false, text: t };
    }

    case "COMBO": {
      const ds = (k.comboPricing ?? []).slice().sort((a, b) => a.quantity - b.quantity);
      const cau = ds.map((c) => `${c.quantity} chiếc ${formatVND(c.price)}${c.freeShipping ? " miễn phí ship" : ""}`).join(", ");
      return {
        intent, action: "ANSWER", capability: can, missing: [], humanReview: false,
        text: `Dạ bên em có ${cau} chị ạ.`,
        provenance: [{ field: "giá combo", source: `${bang}.combo_pricing`, value: cau }],
      };
    }

    case "COLOR":
      return {
        intent, action: "ASK", capability: can, missing: [], humanReview: false,
        text: `Dạ mẫu này bên em đang có màu ${k.colors.join(", ")} ạ. Chị thích màu nào để em ghi lại giúp chị?`,
        provenance: [{ field: "màu đang bán", source: `${bang}.available_colors`, value: k.colors.join(", ") }],
      };

    case "SIZE":
      // Có bảng số đo mới tới được đây — và ngay cả khi có, máy vẫn phải HỎI số đo trước, vì bảng
      // tra theo cao/nặng chứ không tra theo cảm giác.
      return {
        intent, action: "ASK", capability: can, missing: [], humanReview: false,
        text: "Dạ chị cho em xin chiều cao và cân nặng, em tra bảng size rồi tư vấn chính xác cho chị ạ.",
        provenance: [{ field: "bảng số đo", source: "sales_size_profiles.rules", value: `${k.sizeRuleCount} dòng` }],
      };

    case "MATERIAL":
      return {
        intent, action: "ANSWER", capability: can, missing: [], humanReview: false,
        text: `Dạ mẫu này chất liệu ${k.material} chị ạ.`,
        provenance: [{ field: "chất liệu", source: `${bang}.material`, value: k.material }],
      };

    case "COD":
      return {
        intent, action: "ANSWER", capability: can, missing: [], humanReview: false,
        text: `Dạ ${k.codPolicy} chị ạ.`,
        provenance: [{ field: "chính sách COD", source: `${bang}.cod_policy`, value: k.codPolicy }],
      };

    case "INSPECTION":
      return {
        intent, action: "ANSWER", capability: can, missing: [], humanReview: false,
        text: `Dạ ${k.inspectionPolicy} chị ạ.`,
        provenance: [{ field: "chính sách kiểm hàng", source: `${bang}.inspection_policy`, value: k.inspectionPolicy }],
      };

    case "DELIVERY":
      return {
        intent, action: "ANSWER", capability: can, missing: [], humanReview: false,
        text: `Dạ đơn của chị dự kiến ${k.deliveryEstimate} là tới ạ.`,
        provenance: [{ field: "thời gian giao", source: `${bang}.delivery_estimate`, value: k.deliveryEstimate }],
      };

    case "EXCHANGE":
      return {
        intent, action: "ANSWER", capability: can, missing: [], humanReview: false,
        text: `Dạ ${k.exchangePolicy} chị ạ.`,
        provenance: [{ field: "chính sách đổi trả", source: `${bang}.exchange_policy`, value: k.exchangePolicy }],
      };

    case "STOCK":
      // CÒN HÀNG HAY KHÔNG là câu hỏi về TỒN KHO, và tồn kho đi theo phiếu kho (luật 10) — sổ dữ
      // kiện bán hàng không biết điều đó. Trả lời "còn ạ" từ đây là hứa bằng một thứ không đo.
      return {
        intent, action: "HANDOFF", capability: null, missing: ["tồn kho thực tế"], humanReview: true,
        provenance: k.colors.length ? [{ field: "màu đang bán", source: `${bang}.available_colors`, value: k.colors.join(", ") }] : [],
        text: k.colors.length
          ? `Dạ mẫu này bên em đang bán màu ${k.colors.join(", ")} ạ. Chị cho em xin size để em kiểm tra hàng còn rồi báo lại chị ngay nhé.`
          : "Dạ chị chờ em kiểm tra hàng rồi báo lại chị ngay ạ.",
      };

    case "BUY":
      // Thu thông tin ≠ lên đơn. Thu được thì thu, còn lên đơn là quyền tách riêng ở nấc quyền hạn.
      return {
        intent,
        action: "ASK",
        capability: can,
        missing: caps.CAN_CREATE_ORDER.on ? [] : caps.CAN_CREATE_ORDER.missing,
        humanReview: !caps.CAN_CREATE_ORDER.on,
        text: "Dạ chị cho em xin tên, số điện thoại và địa chỉ nhận hàng để em ghi nhận giúp chị ạ.",
        provenance: [{ field: "mã hàng", source: `${bang}.active_product_id`, value: k.code }],
      };

    default: {
      /*
        CÂU NGOÀI KỊCH BẢN — chỗ mô hình thật hay bịa nhất.

        Chỉ được nói lại CÂU ĐÃ DUYỆT. Không có câu nào đã duyệt thì chuyển người, chứ không ghép
        tạm vài dữ kiện rời thành một câu nghe như biết.
      */
      if (!k.approvedFacts.length) return neTranh(intent, null, ["câu dữ kiện đã duyệt"]);
      return {
        intent, action: "ANSWER", capability: null, missing: [], humanReview: false,
        text: `Dạ ${k.approvedFacts[0]} ạ.`,
        provenance: [{ field: "câu dữ kiện đã duyệt", source: `${bang}.approved_facts`, value: k.approvedFacts[0] }],
      };
    }
  }
}
