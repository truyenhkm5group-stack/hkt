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
import { factsFor, type ApprovedFact, type FactCategory } from "@/lib/constants/approved-facts";
import { computeCapabilities, type CapabilityState, type SalesCapability, type SalesKnowledge, type SalesPermissions } from "@/lib/constants/sales-capabilities";
import { branchSentence, EMPTY_SALES_POLICY, type SalesPolicy } from "@/lib/constants/sales-policy";
import { MEASUREMENT_LABEL, recommendSize, type BodyMeasurements, type SizeRule } from "@/lib/constants/size-engine";
import type { SellabilityAnswer } from "@/lib/queries/sellability";

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
  /** Trường DỮ LIỆU còn thiếu khiến máy phải né. Rỗng khi trả lời được. */
  missing: string[];
  /** QUYỀN đang chặn. Rỗng khi không bị chặn. Tách khỏi `missing` — hai loại "không" khác nhau. */
  blockedBy: string;
  humanReview: boolean;
};

/**
 * Nhận ra khách hỏi gì. Luật từ khoá — KHÔNG gọi mô hình, vì hiểu sai câu hỏi là trả lời sai ô.
 *
 * ─── HAI PHÉP TÁCH LÀM TRƯỚC MỌI THỨ KHÁC ───
 *
 * ① ĐỘNG TỪ MUA có mặt mà KHÔNG có từ hỏi giá ⇒ khách đang CHỐT, không hỏi. "Chốt cho chị 2 cái"
 *    và "Mua 2 cái bao nhiêu" chỉ khác nhau ở chỗ ấy, và đọc nhầm cái thứ nhất thành câu hỏi giá
 *    là báo giá cho một người vừa nói họ mua rồi.
 * ② "CÒN KHÔNG" là câu hỏi TỒN, dù trong câu có chữ "size" hay tên màu. "Màu đỏ size L còn không"
 *    hỏi về hàng, không xin tư vấn size.
 *
 * Bản trước xét COMBO trước tiên nên nuốt mất cả hai — "2 cái" khớp COMBO bất kể phần còn lại của
 * câu nói gì.
 */
export function winIntentOf(text: string): WinIntent {
  const t = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");

  const hoiGia = /(bao nhieu|gia bao|gia sao|gia the nao|nhieu tien|may tien|\bgia\b)/.test(t);
  const dongTuMua = /(chot|dat hang|dat cho|mua|order|lay cho|\blay\b|minh lay|em lay|chi lay)/.test(t);
  const hoiCon = /(con khong|con ko|con hang|het hang|con k\b|co san khong|con size|con mau)/.test(t);

  if (hoiCon) return "STOCK";
  if (dongTuMua && !hoiGia) return "BUY";

  // Thứ tự còn lại: cái HẸP hơn đứng trước. "mua 2 cái bao nhiêu" vừa khớp COMBO vừa khớp PRICE.
  if (/(combo|2 cai|hai cai|2 chiec|lay 2|mua 2|set 2)/.test(t)) return "COMBO";
  if (/(doi tra|doi size|doi mau|tra hang|bao hanh|khong vua|ko vua|khong vua co doi)/.test(t)) return "EXCHANGE";
  if (/(kiem tra hang|kiem hang|xem hang|boc ra xem|dong kiem)/.test(t)) return "INSPECTION";
  if (/(cod|thanh toan|tra tien|chuyen khoan|nhan hang moi tra)/.test(t)) return "COD";
  if (/(bao lau|may ngay|khi nao nhan|giao trong|thoi gian giao|nhan duoc)/.test(t)) return "DELIVERY";
  if (/(ship|phi van chuyen|phi giao|freeship|mien ship)/.test(t)) return "SHIPPING";
  if (hoiGia) return "PRICE";
  if (/(mau gi|co mau|mau nao|mau sac)/.test(t)) return "COLOR";
  if (/(size|sz|mac size|so do|cao [0-9]|nang [0-9]|[0-9]+\s*kg|\beo\b|vong nguc|vong mong)/.test(t)) return "SIZE";
  if (/(chat lieu|vai gi|co gian|day hay mong|noi khong)/.test(t)) return "MATERIAL";
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

/**
 * Máy không trả lời câu này.
 *
 * Câu nói với KHÁCH giống nhau ở cả hai trường hợp — khách không cần biết chuyện nội bộ. Nhưng
 * phần ghi lại phải phân biệt: thiếu dữ liệu là VIỆC PHẢI LÀM, bị chặn quyền là QUYẾT ĐỊNH ĐANG CÓ
 * HIỆU LỰC. Gộp chúng vào một chữ "không" là xoá mất việc phải làm.
 */
function chan(intent: WinIntent, cap: SalesCapability | null, st: CapabilityState): SalesAnswer {
  return {
    intent,
    action: "HANDOFF",
    capability: cap,
    provenance: [],
    missing: st.missing,
    blockedBy: st.blockedBy,
    humanReview: true,
    text: `Dạ phần này em xin phép nhờ bạn phụ trách trả lời chị cho chính xác ạ, em chưa có thông tin chính thức để báo chị.`,
  };
}

/** Né vì một lý do không thuộc cổng năng lực (ví dụ tồn kho chưa biết). */
function neTranh(intent: WinIntent, missing: string[], text: string, provenance: Provenance[] = []): SalesAnswer {
  return { intent, action: "HANDOFF", capability: null, provenance, missing, blockedBy: "", humanReview: true, text };
}

/**
 * Trả lời một câu hỏi từ sổ dữ kiện.
 *
 * Bước đầu tiên LUÔN là hỏi cổng năng lực. Không có nhánh nào chạy trước nó, vì một nhánh chạy
 * trước cổng là một nhánh trả lời được khi dữ liệu còn trống — đúng thứ cổng sinh ra để chặn.
 */
export type AnswerContext = {
  origin?: KnowledgeOrigin;
  /** Bảng số đo đang áp — của CHÍNH mẫu này. `null` = chưa có ⇒ không tư vấn size. */
  sizeRule?: SizeRule | null;
  /** Số đo khách đã cung cấp trong hội thoại. Thiếu = hỏi thêm, không đoán. */
  body?: BodyMeasurements;
  /** Kết quả tra danh mục + sổ kho cho câu hỏi "còn không". */
  sellability?: SellabilityAnswer | null;
  policy?: SalesPolicy | null;
  facts?: ApprovedFact[] | null;
};

export function answerFromKnowledge(
  intent: WinIntent,
  k: SalesKnowledge,
  p: SalesPermissions,
  ctx: AnswerContext = {},
): SalesAnswer {
  const caps = computeCapabilities(k, p);
  const can = CAN_NANG_LUC[intent];
  const bang = BANG[ctx.origin ?? "FANPAGE"];
  if (can && !caps[can].on) return chan(intent, can, caps[can]);

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
      return { intent, action: "ANSWER", capability: can, provenance: p, missing: [], blockedBy: "", humanReview: false, text: t };
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
      return { intent, action: "ANSWER", capability: can, provenance: p, missing: [], blockedBy: "", humanReview: false, text: t };
    }

    case "COMBO": {
      const ds = (k.comboPricing ?? []).slice().sort((a, b) => a.quantity - b.quantity);
      const cau = ds.map((c) => `${c.quantity} chiếc ${formatVND(c.price)}${c.freeShipping ? " miễn phí ship" : ""}`).join(", ");
      return {
        intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ bên em có ${cau} chị ạ.`,
        provenance: [{ field: "giá combo", source: `${bang}.combo_pricing`, value: cau }],
      };
    }

    case "COLOR":
      return {
        intent, action: "ASK", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ mẫu này bên em đang có màu ${k.colors.join(", ")} ạ. Chị thích màu nào để em ghi lại giúp chị?`,
        provenance: [{ field: "màu đang bán", source: `${bang}.available_colors`, value: k.colors.join(", ") }],
      };

    case "SIZE": {
      /*
        ĐIỂM DỄ SAI NHẤT VÀ TỐN NHẤT.

        Có bảng số đo mới tới được đây (cổng năng lực đã chặn ở trên). Nhưng CÓ BẢNG vẫn chưa đủ:
        phải tra bảng, và phải chấp nhận ba câu trả lời không phải một size — thiếu số đo, rơi vào
        nhiều size, nằm ngoài bảng. Ba cái đó đều chuyển người.

        Máy KHÔNG tự nghĩ ra size ở bất kỳ nhánh nào; nó gọi `recommendSize()` của ERP và chỉ nói
        khi hàm ấy trả `OK`.
      */
      const kq = recommendSize(ctx.sizeRule ?? null, ctx.body ?? {});
      const nguon: Provenance[] = [
        { field: "bảng số đo", source: `settings["ai.sizeRules"] · bản ${kq.ruleVersion || "—"} · phạm vi ${kq.scope ?? "—"}`, value: `${k.sizeRuleCount} dòng` },
      ];
      if (kq.code === "OK") {
        /*
          NÂNG SIZE Ở RANH GIỚI PHẢI ĐƯỢC NÓI RA — Ở CẢ HAI ĐƯỜNG SINH CÂU CHỮ.

          `recommendSize()` nay chọn size lớn hơn khi số đo rơi đúng ranh giới (luật của chủ shop
          22/09/2026: thà rộng còn hơn chật). Đường này và `generate.ts::renderTemplate` là HAI
          nơi biến kết quả ấy thành câu chữ; vá một nơi thì nơi kia vẫn nói một size cụ thể mà
          giấu chuyện đã chọn hộ, và khách nhận một cái áo rộng không biết mình đổi được.
        */
        const text = kq.roundedUpFrom
          ? `Dạ số đo của chị nằm giữa size ${kq.roundedUpFrom} và ${kq.size} ạ. Em tư vấn size ${kq.size} cho chị mặc thoải mái — nếu chị thích mặc ôm thì em đổi sang ${kq.roundedUpFrom} giúp chị ạ.`
          : `Dạ với số đo của chị thì bên em tư vấn size ${kq.size} ạ.`;
        return {
          intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
          text,
          provenance: [
            ...nguon,
            {
              field: "kết quả tra bảng",
              source: "size-engine.recommendSize",
              value: kq.roundedUpFrom ? `${kq.size} (nâng từ ${kq.roundedUpFrom})` : (kq.size ?? ""),
            },
          ],
        };
      }
      if (kq.code === "MEASUREMENTS_MISSING") {
        // Hỏi ĐÚNG những số đo bảng thật sự dùng, không hỏi cho đủ bộ.
        return {
          intent, action: "ASK", capability: can, missing: [], blockedBy: "", humanReview: false,
          text: `Dạ chị cho em xin ${kq.missing.map((m) => MEASUREMENT_LABEL[m].replace(/ \(.*\)/, "").toLowerCase()).join(" và ")} để em tra bảng size giúp chị ạ.`,
          provenance: nguon,
        };
      }
      // AMBIGUOUS / OUT_OF_RANGE — bảng có nhưng không kết luận được. Chuyển người, KHÔNG chọn bừa
      // một trong các size khớp: mặc không vừa thì thành hàng hoàn.
      return {
        intent, action: "HANDOFF", capability: can, missing: [], blockedBy: "", humanReview: true,
        text:
          kq.code === "AMBIGUOUS"
            ? "Dạ số đo của chị nằm giữa hai size ạ. Em nhờ bạn phụ trách hỏi thêm chị thích mặc ôm hay rộng rồi tư vấn cho chuẩn nhé."
            : "Dạ số đo của chị nằm ngoài bảng size của mẫu này ạ. Em nhờ bạn phụ trách kiểm tra rồi tư vấn chính xác cho chị nhé.",
        provenance: [...nguon, { field: "kết quả tra bảng", source: "size-engine.recommendSize", value: `${kq.code}${kq.candidates.length ? ` (${kq.candidates.join("/")})` : ""}` }],
      };
    }

    case "MATERIAL":
      return {
        intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ mẫu này chất liệu ${k.material} chị ạ.`,
        provenance: [{ field: "chất liệu", source: `${bang}.material`, value: k.material }],
      };

    case "COD":
      return {
        intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ ${k.codPolicy} chị ạ.`,
        provenance: [{ field: "chính sách COD", source: `${bang}.cod_policy`, value: k.codPolicy }],
      };

    case "INSPECTION":
      return {
        intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ ${k.inspectionPolicy} chị ạ.`,
        provenance: [{ field: "chính sách kiểm hàng", source: `${bang}.inspection_policy`, value: k.inspectionPolicy }],
      };

    case "DELIVERY":
      return {
        intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ đơn của chị dự kiến ${k.deliveryEstimate} là tới ạ.`,
        provenance: [{ field: "thời gian giao", source: `${bang}.delivery_estimate`, value: k.deliveryEstimate }],
      };

    case "EXCHANGE": {
      // Trả lời theo TỪNG NHÁNH, không đọc lại một ô chữ chung. Khách hỏi đổi size thì trả lời
      // nhánh đổi size; nhánh ấy chưa khai thì CHỈ nó phải chuyển người.
      const pol = ctx.policy ?? EMPTY_SALES_POLICY;
      const cau = branchSentence("SIZE", pol.exchange.SIZE);
      if (!cau) return chan(intent, can, { status: "MISSING_DATA", on: false, missing: ["chính sách đổi size"], blockedBy: "", why: "" });
      const them = [branchSentence("COLOR", pol.exchange.COLOR), branchSentence("SHOP_FAULT", pol.shopFault)].filter(Boolean);
      return {
        intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ ${[cau, ...them].join(". ")} chị nhé.`,
        provenance: [{ field: "chính sách đổi trả", source: `${bang}.exchange_policy_json`, value: cau }],
      };
    }

    case "STOCK": {
      /*
        HAI CÂU HỎI, KHÔNG PHẢI MỘT.

        "Đang bán" là chuyện DANH MỤC — ERP luôn biết. "Còn hàng" là chuyện SỔ KHO, và chỉ biết khi
        mẫu mã đã có phiếu nhập (luật 10). Trả lời "còn ạ" chỉ vì mẫu mã tồn tại trong danh mục là
        lấy câu trả lời của câu thứ nhất gán cho câu thứ hai — khách chốt đơn, kho không có hàng.
      */
      const sl = ctx.sellability ?? null;
      if (!sl) {
        return neTranh(intent, ["tồn kho thực tế"], "Dạ chị chờ em kiểm tra hàng rồi báo lại chị ngay ạ.");
      }
      const nguon: Provenance[] = [
        { field: "tra danh mục + sổ kho", source: "product_variants + stock_receipts (luật 10)", value: `${sl.verdict}` },
      ];
      if (sl.verdict === "NOT_SELLING") {
        const con = [sl.listedColors.length ? `màu ${sl.listedColors.join(", ")}` : "", sl.listedSizes.length ? `size ${sl.listedSizes.join(", ")}` : ""].filter(Boolean);
        return {
          intent, action: "ASK", capability: can, missing: [], blockedBy: "", humanReview: false,
          text: con.length
            ? `Dạ tổ hợp chị hỏi bên em không có ạ. Mẫu này bên em đang bán ${con.join(", ")} — chị chọn giúp em ạ?`
            : "Dạ mẫu mã chị hỏi bên em không có ạ, chị chờ em kiểm tra lại giúp chị nhé.",
          provenance: nguon,
        };
      }
      if (sl.verdict === "SELLABLE") {
        return {
          intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
          text: `Dạ ${[sl.askedColor, sl.askedSize].filter(Boolean).join(" ") || "mẫu này"} bên em còn hàng ạ.`,
          provenance: [...nguon, { field: "sổ kho", source: "stock_receipts − đã xuất qua ĐVVC", value: sl.evidence }],
        };
      }
      if (sl.verdict === "OUT_OF_STOCK") {
        return {
          intent, action: "ANSWER", capability: can, missing: [], blockedBy: "", humanReview: false,
          text: `Dạ ${[sl.askedColor, sl.askedSize].filter(Boolean).join(" ") || "mẫu này"} bên em đang hết ạ, chị đổi giúp em màu/size khác được không ạ?`,
          provenance: nguon,
        };
      }
      /*
        UNKNOWN — nói được cái BIẾT (đang bán màu/size nào), im về cái KHÔNG BIẾT (còn bao nhiêu).

        KHÔNG HỎI LẠI THỨ KHÁCH VỪA NÓI. Khách viết "màu đỏ size L còn không" mà máy đáp "chị cho
        em xin size" thì nó vừa tự khai là không đọc câu của khách — và đó là ấn tượng đầu tiên
        khách có về cả con máy.
      */
      const daDu = Boolean(sl.askedColor && sl.askedSize);
      const conThieu = !sl.askedColor ? "màu" : !sl.askedSize ? "size" : "";
      return neTranh(
        intent,
        ["tồn kho thực tế"],
        daDu
          ? `Dạ ${sl.askedColor} size ${sl.askedSize} để em kiểm tra hàng còn rồi báo lại chị ngay nhé.`
          : sl.listedColors.length
            ? `Dạ mẫu này bên em đang bán màu ${sl.listedColors.join(", ")} ạ. Chị cho em xin ${conThieu || "màu và size"} để em kiểm tra hàng còn rồi báo lại chị ngay nhé.`
            : "Dạ chị chờ em kiểm tra hàng rồi báo lại chị ngay ạ.",
        [...nguon, { field: "vì sao chưa biết", source: "stock_receipts", value: sl.evidence }],
      );
    }

    case "BUY": {
      /*
        KHÁCH ĐÃ CHỐT — VÀ ĐÓ LÀ LÚC PHẢI CẨN THẬN NHẤT.

        Thu thông tin cho một mẫu mã shop không bán, hoặc một mẫu mã chưa biết còn hàng hay không,
        là hẹn giao một thứ có thể không tồn tại. Nên tra hàng TRƯỚC khi xin địa chỉ.
      */
      const sl = ctx.sellability ?? null;
      if (sl && sl.verdict === "NOT_SELLING") {
        const con = [sl.listedColors.length ? `màu ${sl.listedColors.join(", ")}` : "", sl.listedSizes.length ? `size ${sl.listedSizes.join(", ")}` : ""].filter(Boolean);
        return {
          intent, action: "ASK", capability: can, missing: [], blockedBy: "", humanReview: false,
          text: `Dạ ${[sl.askedColor, sl.askedSize].filter(Boolean).join(" ") || "mẫu mã này"} bên em không có ạ. Bên em đang bán ${con.join(", ")} — chị chọn giúp em rồi em ghi đơn ngay nhé.`,
          provenance: [{ field: "tra danh mục", source: "product_variants", value: sl.evidence }],
        };
      }
      if (sl && sl.verdict === "UNKNOWN") {
        return neTranh(
          intent,
          ["tồn kho thực tế"],
          "Dạ em ghi nhận rồi ạ. Em kiểm tra hàng còn rồi nhờ bạn phụ trách chốt đơn với chị ngay nhé.",
          [{ field: "vì sao chưa chốt được", source: "stock_receipts (luật 10)", value: sl.evidence }],
        );
      }
      // Thu thông tin ≠ lên đơn. Thu được thì thu; lên đơn là quyền tách riêng, và ở đây nó đang
      // bị chặn cứng cấp máy chủ — nói ra để người đọc bản ghi biết vì sao vẫn phải có người chốt.
      return {
        intent,
        action: "ASK",
        capability: can,
        missing: caps.CAN_CREATE_ORDER.missing,
        blockedBy: caps.CAN_CREATE_ORDER.blockedBy,
        humanReview: !caps.CAN_CREATE_ORDER.on,
        text: "Dạ chị cho em xin tên, số điện thoại và địa chỉ nhận hàng để em ghi nhận giúp chị ạ.",
        provenance: [{ field: "mã hàng", source: `${bang}.active_product_id`, value: k.code }],
      };
    }

    default: {
      /*
        CÂU NGOÀI KỊCH BẢN — chỗ mô hình thật hay bịa nhất.

        Chỉ được nói lại CÂU ĐÃ DUYỆT, và chỉ câu CÓ NGƯỜI ĐỨNG TÊN. Không có câu nào thì chuyển
        người, chứ không ghép tạm vài dữ kiện rời thành một câu nghe như biết.
      */
      const dung = factsFor(ctx.facts ?? null, [...NHOM_CHUNG]);
      if (!dung.length) return chan(intent, null, { status: "MISSING_DATA", on: false, missing: ["câu dữ kiện đã duyệt"], blockedBy: "", why: "" });
      return {
        intent, action: "ANSWER", capability: null, missing: [], blockedBy: "", humanReview: false,
        text: `Dạ ${dung[0].text} ạ.`,
        provenance: [{ field: "câu dữ kiện đã duyệt", source: `${bang}.approved_facts_json · duyệt bởi ${dung[0].approvedBy}`, value: dung[0].text }],
      };
    }
  }
}

/** Nhóm câu được dùng cho câu hỏi ngoài kịch bản. FAQ trước, rồi tới các nhóm mô tả sản phẩm. */
const NHOM_CHUNG: FactCategory[] = ["FAQ", "FIT", "CARE", "MATERIAL"];
