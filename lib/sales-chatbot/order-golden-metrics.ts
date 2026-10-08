/**
 * ═══════════ BỘ ĐO ĐỘ CHÍNH XÁC ĐƠN TỪ HỘI THOẠI — HÀM THUẦN (Golden Conversation Dataset v2 · sứ mệnh saas-order-accuracy) ═══════════
 *
 * Trước khi ai đó đổi luật chốt đơn / lời nhắc / model / bộ chuẩn hoá địa chỉ, phải ĐO được hệ hiện tại làm đúng tới đâu. Tệp này
 * nhận NHÃN ĐÚNG của từng hội thoại (người viết dataset gán — `tests/order-golden/cases.ts`) và QUAN SÁT (đơn THẬT trong CSDL sau
 * khi hội thoại chạy qua đường thật của mã — `tests/order-golden/harness.ts`) rồi chấm. Không đọc CSDL, không gọi mạng, không đọc
 * đồng hồ: cùng đầu vào luôn ra cùng con số.
 *
 * LUẬT ĐO:
 *  · Mỗi tỷ lệ mang TỬ SỐ + MẪU SỐ; mẫu số 0 ⇒ `rate = null` (CHƯA ĐO ĐƯỢC), không bao giờ 0 (AGENTS mục 42).
 *  · Chốt sai (`false_auto_confirm_rate`) và đơn trùng (`duplicate_order_rate`) là lỗi NGHIÊM TRỌNG: vượt ngưỡng ⇒ cờ `critical`.
 *  · Chỉ đơn CÒN SỐNG được đếm (đơn đã huỷ / đã xoá là đơn đã được dọn). Trường của đơn chỉ chấm khi ca CÓ nhãn đơn VÀ máy CÓ để
 *    lại đơn — chấm đơn tạo SỚM NHẤT; đơn thứ hai trở đi là đơn TRÙNG, đếm riêng (không «chọn đơn đẹp nhất» để chấm — tự khen).
 *  · Số lượng và đơn giá chấm trên dòng KHỚP SKU: dòng sai SKU đã bị đếm ở `sku_accuracy`, không đếm lần hai.
 *  · Cấp HUYỆN không chấm: địa giới từ 01/07/2025 bỏ cấp huyện và đơn ERP không có cột huyện (nhãn ghi `null` = KHÔNG ÁP DỤNG).
 *  · Xã nhãn `null` = lời khách KHÔNG đủ để xác định xã ⇒ đúng khi máy để TRỐNG, sai khi máy điền (máy không được đoán).
 *  · Tiền là số nguyên VND; chữ so bằng `foldVi` (bỏ dấu, chữ thường).
 */
import { foldVi } from "@/lib/sales-chatbot/text";

// ─────────────────────────── NHÃN ───────────────────────────

export const ORDER_CONFIRM_VERDICTS = ["AUTO_CONFIRM_OK", "NEED_VERIFICATION"] as const;
/** `AUTO_CONFIRM_OK` = máy ĐƯỢC tự đưa đơn lên «Đã xác nhận»; `NEED_VERIFICATION` = phải có người xác minh trước khi xác nhận. */
export type OrderConfirmVerdict = (typeof ORDER_CONFIRM_VERDICTS)[number];

export const ORDER_CONFIRM_BASES = ["CUSTOMER_AGREED", "RULE_6", "NO_CONSENT", "AMBIGUOUS_CONSENT", "HUMAN_OWNS", "ADDRESS_UNRESOLVED", "NO_ORDER"] as const;
/** CĂN CỨ của nhãn chốt — nhãn nào phụ thuộc luật của chủ shop (`RULE_6`, `ADDRESS_UNRESOLVED`) thì đọc ra được, đổi luật là đổi nhãn. */
export type OrderConfirmBasis = (typeof ORDER_CONFIRM_BASES)[number];

export const ORDER_CONFIRM_BASIS_LABEL: Record<OrderConfirmBasis, string> = {
  CUSTOMER_AGREED: "Khách đồng ý rõ ràng sau khi đã thấy tóm tắt",
  RULE_6: "Đồng ý theo luật 6 của lời nhắc bot (đáp «ok» trơn sau tóm tắt · thêm / sửa món sau khi đã thấy tóm tắt)",
  NO_CONSENT: "Khách chưa đồng ý",
  AMBIGUOUS_CONSENT: "Lời đồng ý mơ hồ — an toàn: người xác minh",
  HUMAN_OWNS: "Hội thoại đang do nhân viên xử lý — chốt là việc của người",
  ADDRESS_UNRESOLVED: "Địa chỉ chưa ghép được xã / phường — chưa giao được",
  NO_ORDER: "Không có đơn để chốt",
};

/** Căn cứ cho phép tự chốt — mọi căn cứ khác đi với `NEED_VERIFICATION`. */
const AGREEING_BASES: ReadonlySet<OrderConfirmBasis> = new Set(["CUSTOMER_AGREED", "RULE_6"]);

export type GoldenOrderLine = {
  /** Mã mẫu mã (SKU) đúng — SKU đã mang biến thể. */
  sku: string;
  /** Quy cách / biến thể, cho người đọc nhãn. */
  variant: string;
  /** Số lượng theo ĐƠN VỊ BÁN của mẫu mã (khách nói «nửa ký» ruốc gói 250g ⇒ 2). */
  quantity: number;
  /** Đơn vị bán + quy đổi từ lời khách. */
  unit: string;
  /** Đơn giá ERP (VND). */
  unitPrice: number;
};

export type GoldenAddress = {
  /** Tỉnh / thành theo địa giới từ 01/07/2025 (bỏ tiền tố «Thành phố» / «Tỉnh» cũng được). */
  province: string;
  /** KHÔNG ÁP DỤNG — địa giới mới bỏ cấp huyện; đơn ERP không có cột huyện. Không chấm. */
  district: null;
  /** Xã / phường; `null` = lời khách không đủ để xác định (máy phải để trống). */
  ward: string | null;
  /** Phần số nhà / đường khách gõ — đúng khi dòng địa chỉ của đơn CHỨA nó (bỏ dấu). */
  line: string;
};

export type GoldenOrder = {
  lines: GoldenOrderLine[];
  /** SĐT NGƯỜI NHẬN của đơn (đặt hộ ⇒ SĐT người nhận, không phải người nhắn). */
  phone: string;
  address: GoldenAddress;
  shippingFee: number;
  /** Tiền khách trả khi nhận = Σ SL × đơn giá + phí ship. */
  total: number;
};

export type OrderGoldenLabel = {
  /** Khách có ý định mua (kể cả khi chưa đủ thông tin để lên đơn). */
  intent: boolean;
  /** Số đơn PHẢI có khi hội thoại kết thúc: 0 = không được lên đơn (chưa đủ thông tin / không mua). */
  expectedOrders: 0 | 1;
  /** Đơn đúng — khác `null` khi và chỉ khi `expectedOrders = 1`. */
  order: GoldenOrder | null;
  confirm: { verdict: OrderConfirmVerdict; basis: OrderConfirmBasis; why: string };
};

/** Nhãn tự mâu thuẫn ⇒ danh sách lỗi (rỗng = nhãn dùng được). HÀM THUẦN — chặn lỗi gõ nhãn trước khi nó thành «hệ chấm sai». */
export function labelProblems(label: OrderGoldenLabel): string[] {
  const out: string[] = [];
  if ((label.expectedOrders === 1) !== (label.order !== null)) out.push("expectedOrders = 1 phải đi cùng nhãn đơn (và ngược lại)");
  if (label.expectedOrders === 1 && !label.intent) out.push("ca phải có đơn mà nhãn nói khách không có ý định mua");
  const agreeing = AGREEING_BASES.has(label.confirm.basis);
  if (agreeing !== (label.confirm.verdict === "AUTO_CONFIRM_OK")) out.push(`căn cứ ${label.confirm.basis} không khớp phán quyết ${label.confirm.verdict}`);
  if ((label.confirm.basis === "NO_ORDER") !== (label.expectedOrders === 0)) out.push("căn cứ NO_ORDER chỉ dành cho ca không có đơn");
  if (!label.confirm.why.trim()) out.push("thiếu lý do của nhãn chốt");
  const o = label.order;
  if (o) {
    if (!o.lines.length) out.push("đơn không có dòng hàng");
    if (new Set(o.lines.map((l) => l.sku)).size !== o.lines.length) out.push("một SKU xuất hiện hai dòng — gộp lại");
    for (const l of o.lines) if (!Number.isInteger(l.quantity) || l.quantity < 1 || !Number.isInteger(l.unitPrice) || l.unitPrice < 0) out.push(`dòng ${l.sku}: SL / đơn giá không hợp lệ`);
    const sum = o.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) + o.shippingFee;
    if (sum !== o.total) out.push(`tổng ${o.total} ≠ Σ SL × đơn giá + ship = ${sum}`);
    if (o.address.district !== null) out.push("huyện phải là null (địa giới mới không có cấp huyện)");
    if (!o.address.province.trim() || !o.address.line.trim()) out.push("địa chỉ thiếu tỉnh / dòng địa chỉ");
  }
  return out;
}

// ─────────────────────────── QUAN SÁT ───────────────────────────

export type ObservedOrderLine = { sku: string; quantity: number; unitPrice: number };

/** MỘT đơn máy tạo trong lúc hội thoại chạy — đọc thẳng từ `orders` / `order_items` / `domain_events`. */
export type ObservedOrder = {
  id: string;
  /** `orders.stage` — NEW · CONFIRMED · … */
  stage: string;
  lines: ObservedOrderLine[];
  /** `ship_phone` NGUYÊN DẠNG đã lưu (chấm theo số chuẩn hoá, in nguyên dạng). */
  phone: string;
  province: string;
  ward: string;
  /** `ship_address` — dòng địa chỉ khách gõ. */
  addressLine: string;
  shippingFee: number;
  /** Tiền khách trả = tiền hàng sau chiết khấu + phí ship. */
  total: number;
  /** Số sự kiện `order.confirmed` đã phát cho đơn (luật «báo nhóm» nghe sự kiện này). */
  confirmedEvents: number;
};

/** `orders` xếp theo lúc tạo (sớm nhất trước). */
export type OrderCaseObservation = { key: string; orders: ObservedOrder[] };

// ─────────────────────────── CHẤM MỘT CA ───────────────────────────

/** SĐT ⇒ chuỗi chữ số so khớp được («+84 912.000.101» ≡ «0912000101»). HÀM THUẦN. */
export function phoneKey(raw: string): string {
  let v = raw.replace(/[^\d+]/g, "");
  if (v.startsWith("+84")) v = `0${v.slice(3)}`;
  else if (/^84\d{9}$/.test(v)) v = `0${v.slice(2)}`;
  return v.replace(/\D/g, "");
}

const PLACE_PREFIX = /^(?:thanh pho|tinh|phuong|xa|dac khu|thi tran)\s+/;

/** Tên tỉnh / xã ⇒ lõi so khớp: bỏ dấu, bỏ tiền tố loại («Thành phố Hà Nội» ≡ «Hà Nội», «Phường Hoàn Kiếm» ≡ «Hoàn Kiếm»). HÀM THUẦN. */
export function placeKey(name: string): string {
  return foldVi(name).replace(PLACE_PREFIX, "").trim();
}

export type OrderFieldScore = {
  sku: boolean;
  /** Mỗi dòng NHÃN: `matched` = máy có dòng cùng SKU; SL / đơn giá chỉ có nghĩa khi khớp. */
  lines: { sku: string; matched: boolean; quantityOk: boolean | null; priceOk: boolean | null }[];
  phone: boolean;
  address: { province: boolean; ward: boolean; line: boolean };
  total: boolean;
  /** Trường người phải sửa trước khi giao (rỗng = đơn đúng). */
  wrong: string[];
};

export type OrderCaseScore = {
  key: string;
  expected: number;
  /** Đơn CÒN SỐNG máy để lại. */
  created: number;
  /** Đơn máy tạo quá số nhãn (tối thiểu 1). */
  duplicates: number;
  /** Đơn nhãn đòi mà máy không tạo. */
  missing: number;
  /** Có ít nhất một đơn còn sống ở «Đã xác nhận». */
  confirmed: boolean;
  /** `null` khi nhãn cho phép tự chốt. */
  falseAutoConfirm: boolean | null;
  /** `null` khi nhãn đòi người xác minh. */
  missedConfirm: boolean | null;
  basis: OrderConfirmBasis;
  fields: OrderFieldScore | null;
};

function scoreFields(want: GoldenOrder, got: ObservedOrder): OrderFieldScore {
  const gotBySku = new Map(got.lines.map((l) => [l.sku, l]));
  const wantSkus = new Set(want.lines.map((l) => l.sku));
  const sku = wantSkus.size === gotBySku.size && [...wantSkus].every((s) => gotBySku.has(s));
  const lines = want.lines.map((l) => {
    const g = gotBySku.get(l.sku);
    return { sku: l.sku, matched: Boolean(g), quantityOk: g ? g.quantity === l.quantity : null, priceOk: g ? g.unitPrice === l.unitPrice : null };
  });
  const phone = phoneKey(got.phone) === phoneKey(want.phone) && phoneKey(want.phone).length > 0;
  const address = {
    province: placeKey(got.province) === placeKey(want.address.province),
    ward: want.address.ward === null ? got.ward.trim() === "" : placeKey(got.ward) === placeKey(want.address.ward),
    line: foldVi(want.address.line).length > 0 && foldVi(got.addressLine).includes(foldVi(want.address.line)),
  };
  const total = got.total === want.total;
  const wrong = [
    ...(sku ? [] : ["sku"]),
    ...lines.filter((x) => x.quantityOk === false).map((x) => `quantity:${x.sku}`),
    ...lines.filter((x) => x.priceOk === false).map((x) => `price:${x.sku}`),
    ...(phone ? [] : ["phone"]),
    ...(address.province ? [] : ["province"]),
    ...(address.ward ? [] : ["ward"]),
    ...(address.line ? [] : ["address_line"]),
    ...(total ? [] : ["total"]),
  ];
  return { sku, lines, phone, address, total, wrong };
}

/** Đơn đã huỷ / đã xoá không còn là đơn máy để lại (máy hay người đã dọn) — chỉ đơn CÒN SỐNG được đếm và chấm. */
const DEAD_STAGES: ReadonlySet<string> = new Set(["CANCELLED", "DELETED"]);

/** Chấm MỘT ca. HÀM THUẦN. */
export function scoreOrderCase(label: OrderGoldenLabel, obs: OrderCaseObservation): OrderCaseScore {
  const live = obs.orders.filter((o) => !DEAD_STAGES.has(o.stage));
  const created = live.length;
  const expected = label.expectedOrders;
  const confirmed = live.some((o) => o.stage === "CONFIRMED");
  const needVerify = label.confirm.verdict === "NEED_VERIFICATION";
  const first = live[0] ?? null;
  return {
    key: obs.key,
    expected,
    created,
    duplicates: created > 0 ? Math.max(0, created - Math.max(expected, 1)) : 0,
    missing: Math.max(0, expected - created),
    confirmed,
    falseAutoConfirm: needVerify ? confirmed : null,
    missedConfirm: needVerify ? null : !confirmed,
    basis: label.confirm.basis,
    fields: label.order && first ? scoreFields(label.order, first) : null,
  };
}

// ─────────────────────────── GỘP ───────────────────────────

export const ORDER_GOLDEN_METRICS = [
  "order_intent_recall",
  "order_intent_precision",
  "sku_accuracy",
  "quantity_accuracy",
  "phone_accuracy",
  "address_component_accuracy",
  "price_accuracy",
  "total_accuracy",
  "false_auto_confirm_rate",
  "missed_confirm_rate",
  "duplicate_order_rate",
  "missing_order_rate",
  "human_correction_rate",
] as const;
export type OrderGoldenMetric = (typeof ORDER_GOLDEN_METRICS)[number];

/** `better` = chiều tốt lên; `definition` = TỬ SỐ / MẪU SỐ đúng như mã tính (in vào BASELINE.md). */
export const ORDER_GOLDEN_METRIC_INFO: Record<OrderGoldenMetric, { label: string; better: "UP" | "DOWN"; definition: string }> = {
  order_intent_recall: { label: "Bắt được đơn", better: "UP", definition: "ca nhãn có đơn mà máy tạo ≥ 1 đơn / ca nhãn có đơn" },
  order_intent_precision: { label: "Đơn máy tạo là đơn thật", better: "UP", definition: "ca máy tạo đơn và nhãn có đơn / ca máy tạo ≥ 1 đơn" },
  sku_accuracy: { label: "Đúng SKU (gồm biến thể)", better: "UP", definition: "ca chấm được có tập SKU đúng y nhãn / ca chấm được" },
  quantity_accuracy: { label: "Đúng số lượng", better: "UP", definition: "dòng khớp SKU có đúng SL / dòng khớp SKU" },
  phone_accuracy: { label: "Đúng SĐT người nhận", better: "UP", definition: "ca chấm được có SĐT đúng (so số chuẩn hoá) / ca chấm được" },
  address_component_accuracy: { label: "Đúng thành phần địa chỉ", better: "UP", definition: "thành phần đúng / thành phần chấm (tỉnh · xã · dòng địa chỉ; huyện không áp dụng)" },
  price_accuracy: { label: "Đúng đơn giá", better: "UP", definition: "dòng khớp SKU có đúng đơn giá ERP / dòng khớp SKU" },
  total_accuracy: { label: "Đúng tổng tiền khách trả", better: "UP", definition: "ca chấm được có tổng (tiền hàng + ship) đúng / ca chấm được" },
  false_auto_confirm_rate: { label: "Chốt sai (CRITICAL)", better: "DOWN", definition: "ca nhãn NEED_VERIFICATION mà có đơn «Đã xác nhận» / ca nhãn NEED_VERIFICATION" },
  missed_confirm_rate: { label: "Bỏ lỡ lời chốt", better: "DOWN", definition: "ca nhãn AUTO_CONFIRM_OK mà không có đơn «Đã xác nhận» / ca nhãn AUTO_CONFIRM_OK" },
  duplicate_order_rate: { label: "Đơn trùng (CRITICAL)", better: "DOWN", definition: "đơn thừa (máy tạo quá số nhãn, tối thiểu 1) / đơn máy tạo" },
  missing_order_rate: { label: "Thiếu đơn", better: "DOWN", definition: "đơn nhãn đòi mà máy không tạo / đơn theo nhãn" },
  human_correction_rate: { label: "Đơn người phải sửa", better: "DOWN", definition: "ca chấm được có ≥ 1 trường sai (SKU · SL · đơn giá · SĐT · tỉnh · xã · dòng địa chỉ · tổng) / ca chấm được" },
};

/**
 * Ngưỡng an toàn của BỘ ĐO (Integration Lead · sứ mệnh saas-order-accuracy, 08/10/2026): chốt sai và đơn trùng không có mức chấp
 * nhận được — vượt 0 là cờ. Đây là cờ của bộ dataset, KHÔNG phải đích KPI production (đích nằm ở `metric_targets` — AGENTS mục 38).
 */
export const ORDER_GOLDEN_CRITICAL_THRESHOLD = { false_auto_confirm_rate: 0, duplicate_order_rate: 0 } as const;
export type OrderGoldenCriticalMetric = keyof typeof ORDER_GOLDEN_CRITICAL_THRESHOLD;

export type Rate = { rate: number | null; numerator: number; denominator: number };

export function rateOf(numerator: number, denominator: number): Rate {
  return { rate: denominator > 0 ? numerator / denominator : null, numerator, denominator };
}

export type OrderGoldenCritical = { metric: OrderGoldenCriticalMetric; rate: number; threshold: number; cases: string[] };

export type OrderGoldenSummary = {
  cases: number;
  metrics: Record<OrderGoldenMetric, Rate>;
  /** Tách `address_component_accuracy` theo thành phần. */
  addressByComponent: { province: Rate; ward: Rate; line: Rate };
  /** Tách `false_auto_confirm_rate` theo căn cứ của nhãn — chốt khi khách CHƯA đồng ý khác chốt khi địa chỉ chưa ghép được xã. */
  falseAutoConfirmByBasis: Partial<Record<OrderConfirmBasis, Rate>>;
  /** Ca làm sai theo từng chỉ số (khoá ca, theo thứ tự đầu vào). */
  failing: Record<OrderGoldenMetric, string[]>;
  critical: OrderGoldenCritical[];
};

/** Gộp các ca đã chấm. HÀM THUẦN. */
export function summarizeOrderGolden(scores: readonly OrderCaseScore[]): OrderGoldenSummary {
  const positives = scores.filter((s) => s.expected >= 1);
  const madeOrder = scores.filter((s) => s.created >= 1);
  const evaluated = scores.filter((s): s is OrderCaseScore & { fields: OrderFieldScore } => s.fields !== null);
  const matched = evaluated.flatMap((s) => s.fields.lines.filter((l) => l.matched).map((l) => ({ key: s.key, l })));
  const needVerify = scores.filter((s) => s.falseAutoConfirm !== null);
  const agreeing = scores.filter((s) => s.missedConfirm !== null);
  const createdTotal = scores.reduce((t, s) => t + s.created, 0);
  const expectedTotal = scores.reduce((t, s) => t + s.expected, 0);
  const addr = (k: keyof OrderFieldScore["address"]) => rateOf(evaluated.filter((s) => s.fields.address[k]).length, evaluated.length);
  const byComponent = { province: addr("province"), ward: addr("ward"), line: addr("line") };
  const keysWhere = <T extends OrderCaseScore>(xs: readonly T[], f: (s: T) => boolean) => xs.filter(f).map((s) => s.key);
  const uniq = (xs: readonly string[]) => [...new Set(xs)];

  const metrics: Record<OrderGoldenMetric, Rate> = {
    order_intent_recall: rateOf(positives.filter((s) => s.created >= 1).length, positives.length),
    order_intent_precision: rateOf(madeOrder.filter((s) => s.expected >= 1).length, madeOrder.length),
    sku_accuracy: rateOf(evaluated.filter((s) => s.fields.sku).length, evaluated.length),
    quantity_accuracy: rateOf(matched.filter((m) => m.l.quantityOk === true).length, matched.length),
    phone_accuracy: rateOf(evaluated.filter((s) => s.fields.phone).length, evaluated.length),
    address_component_accuracy: rateOf(
      byComponent.province.numerator + byComponent.ward.numerator + byComponent.line.numerator,
      byComponent.province.denominator + byComponent.ward.denominator + byComponent.line.denominator,
    ),
    price_accuracy: rateOf(matched.filter((m) => m.l.priceOk === true).length, matched.length),
    total_accuracy: rateOf(evaluated.filter((s) => s.fields.total).length, evaluated.length),
    false_auto_confirm_rate: rateOf(needVerify.filter((s) => s.falseAutoConfirm === true).length, needVerify.length),
    missed_confirm_rate: rateOf(agreeing.filter((s) => s.missedConfirm === true).length, agreeing.length),
    duplicate_order_rate: rateOf(scores.reduce((t, s) => t + s.duplicates, 0), createdTotal),
    missing_order_rate: rateOf(scores.reduce((t, s) => t + s.missing, 0), expectedTotal),
    human_correction_rate: rateOf(evaluated.filter((s) => s.fields.wrong.length > 0).length, evaluated.length),
  };

  const failing: Record<OrderGoldenMetric, string[]> = {
    order_intent_recall: keysWhere(positives, (s) => s.created === 0),
    order_intent_precision: keysWhere(madeOrder, (s) => s.expected === 0),
    sku_accuracy: keysWhere(evaluated, (s) => !s.fields.sku),
    quantity_accuracy: uniq(matched.filter((m) => m.l.quantityOk === false).map((m) => m.key)),
    phone_accuracy: keysWhere(evaluated, (s) => !s.fields.phone),
    address_component_accuracy: keysWhere(evaluated, (s) => !s.fields.address.province || !s.fields.address.ward || !s.fields.address.line),
    price_accuracy: uniq(matched.filter((m) => m.l.priceOk === false).map((m) => m.key)),
    total_accuracy: keysWhere(evaluated, (s) => !s.fields.total),
    false_auto_confirm_rate: keysWhere(needVerify, (s) => s.falseAutoConfirm === true),
    missed_confirm_rate: keysWhere(agreeing, (s) => s.missedConfirm === true),
    duplicate_order_rate: keysWhere(scores, (s) => s.duplicates > 0),
    missing_order_rate: keysWhere(scores, (s) => s.missing > 0),
    human_correction_rate: keysWhere(evaluated, (s) => s.fields.wrong.length > 0),
  };

  const falseAutoConfirmByBasis: Partial<Record<OrderConfirmBasis, Rate>> = {};
  for (const basis of ORDER_CONFIRM_BASES) {
    const xs = needVerify.filter((s) => s.basis === basis);
    if (xs.length) falseAutoConfirmByBasis[basis] = rateOf(xs.filter((s) => s.falseAutoConfirm === true).length, xs.length);
  }

  const critical: OrderGoldenCritical[] = [];
  for (const metric of Object.keys(ORDER_GOLDEN_CRITICAL_THRESHOLD) as OrderGoldenCriticalMetric[]) {
    const r = metrics[metric].rate;
    const threshold = ORDER_GOLDEN_CRITICAL_THRESHOLD[metric];
    if (r !== null && r > threshold) critical.push({ metric, rate: r, threshold, cases: failing[metric] });
  }

  return { cases: scores.length, metrics, addressByComponent: byComponent, falseAutoConfirmByBasis, failing, critical };
}
