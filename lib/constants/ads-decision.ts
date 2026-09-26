/**
 * ───────────── NGƯỠNG RA QUYẾT ĐỊNH QUẢNG CÁO ─────────────
 *
 * MỘT nơi duy nhất giữ các con số quyết định SCALE / HOLD / WATCH / CUT. Không hard-code ở trang,
 * ở truy vấn hay ở kiểm thử — đúng luật AGENTS.md mục 3.4 (ngưỡng nghiệp vụ chỉ sửa tại một chỗ,
 * và chỉ khi chủ shop yêu cầu).
 *
 * Vì sao ngưỡng phải đứng TRƯỚC công thức: một khuyến nghị "CẮT" đưa ra trên 3 đơn không phải là
 * khuyến nghị, đó là tiếng ồn. Toàn bộ thiết kế dưới đây là để **từ chối kết luận** khi dữ liệu
 * chưa đủ, thay vì luôn luôn có ý kiến.
 */
export const ADS_DECISION_RULE = {
  /**
   * Tiền quảng cáo tối thiểu của một dòng trước khi được phép kết luận về TIỀN.
   * Dưới mức này, chênh lệch ROAS chỉ là may rủi của vài đơn.
   */
  minSpend: 300_000,
  /**
   * Số đơn ĐÃ KẾT THÚC (giao thành công + hoàn) tối thiểu để kết luận về tỷ lệ giao thành công.
   * Dưới mức này, GTC dao động quá mạnh: 2/3 đơn = 67%, mất đúng một đơn thành 33%.
   */
  minFinishedOrders: 10,
  /**
   * Tỷ lệ đơn đã kết thúc trên tổng đơn đã lên. Dưới mức này nghĩa là phần lớn đơn còn đang đi —
   * kết quả tiền của dòng này CHƯA ngã ngũ, và mọi con số lợi nhuận đang thiếu vế hoàn.
   *
   * Đây chính là "tiền đang treo ở nhóm chưa đủ dữ liệu": tiền đã tiêu thật, kết quả chưa biết.
   */
  minMaturity: 0.6,
  /**
   * Biên an toàn trên điểm hoà vốn để được khuyến nghị TĂNG NGÂN SÁCH.
   * 1,3 = ROAS thực đang cao hơn ROAS hoà vốn 30%; đủ chỗ cho sai số giá vốn và cước.
   */
  scaleAbove: 1.3,
  /** Dưới điểm hoà vốn quá mức này thì CẮT. 0,8 = đang lỗ hơn 20% so với hoà vốn. */
  cutBelow: 0.8,
  /**
   * Tỷ lệ giao thành công thấp — quảng cáo có thể vẫn ra đơn tốt, nhưng tiền chết ở khâu giao.
   * Đây là dấu hiệu "ads tốt nhưng hoàn cao": xử lý bằng chốt đơn / đóng gói / ĐVVC, KHÔNG phải
   * bằng cắt quảng cáo.
   */
  lowSuccessRate: 65,
} as const;

/**
 * ───────────── CĂN CỨ CỦA MỘT KHUYẾN NGHỊ ─────────────
 *
 * Cùng một chữ `CẮT` đứng trên hai căn cứ khác nhau KHÔNG phải cùng một kết luận, nên căn cứ phải
 * đi kèm khuyến nghị ở mọi nơi khuyến nghị đi tới: màn hình, sổ quyết định, và cổng ghi ngân sách.
 *
 * · `ACTUAL` — đủ đơn đã ngã ngũ; con số là SỐ ĐO.
 * · `PROJECTED` — phần lớn đơn còn đang sản xuất hoặc đang đi; con số là **lợi nhuận tạm tính**,
 *   dựng trên tỷ lệ giao thành công ƯỚC TÍNH của mã hàng (`lib/constants/delivery-rate.ts`).
 *
 * Đây là một NHÃN ĐỘ TIN CẬY, không phải một hành động — nó vuông góc với `AdsAction`, và gộp hai
 * thứ vào một danh sách (thêm `CUT_PROJECTED`, `SCALE_PROJECTED`…) sẽ nhân đôi mọi bảng chân lý.
 */
export type DecisionBasis = "ACTUAL" | "PROJECTED";

export const DECISION_BASIS_LABEL: Record<DecisionBasis, string> = {
  ACTUAL: "Số thật",
  PROJECTED: "Tạm tính",
};

export const DECISION_BASIS_NOTE: Record<DecisionBasis, string> = {
  ACTUAL: "Đủ đơn đã ngã ngũ — doanh thu, giá vốn và lợi nhuận trên dòng này là số đo.",
  PROJECTED:
    "Phần lớn đơn còn đang sản xuất hoặc đang đi. Lợi nhuận ở đây là TẠM TÍNH: phần đang treo được cân theo tỷ lệ giao thành công ước tính của mã hàng. Khuyến nghị vì thế là tối ưu THEO KẾ HOẠCH — GTC thực về cao hơn thì càng tốt, thấp hơn là việc của khâu giao.",
};

/**
 * ═══════════ KẾT LUẬN MƯỢN CỦA MÃ HÀNG, KHI CHIẾN DỊCH KHÔNG TỰ KẾT LUẬN ĐƯỢC ═══════════
 *
 * Đo production 23/09/2026: shop chạy **619 chiến dịch trong một cửa sổ 14 ngày**, và trong nhóm
 * đủ tiền (≥ 300K) thì chiến dịch nhiều đơn nhất cũng chỉ có **3 đơn**. Cổng mẫu đòi 10, nên nó
 * không bao giờ mở — **45.726.057 ₫ (63% tiền quảng cáo) không nhận được một kết luận nào**.
 *
 * Cùng ngày, cùng dữ liệu, ở cấp MÃ HÀNG: 3/4 mã có khuyến nghị, phủ **99,8%** tiền.
 *
 * Bằng chứng tồn tại — chỉ là nó không tồn tại ở độ mịn CHIẾN DỊCH. Nên dòng chiến dịch không tự
 * kết luận được sẽ MƯỢN kết luận của mã hàng nó đang chạy, và nói rõ là mượn.
 *
 * ─── BA ĐIỀU KẾT LUẬN MƯỢN KHÔNG ĐƯỢC LÀM ───
 *
 *  1. **Không thay kết luận của chính dòng.** `action` vẫn là `INSUFFICIENT_DATA` — vì đó là sự
 *     thật về CHIẾN DỊCH này. Kết luận mượn là một trường RIÊNG.
 *  2. **Không phân biệt được chiến dịch tốt với chiến dịch xấu trong cùng một mã.** Nó nói về cả
 *     mã. Một chiến dịch dở nằm trong một mã lãi vẫn sẽ mượn chữ "còn dư địa" — và người đọc phải
 *     thấy được điều đó, nên nhãn luôn mang TÊN MÃ chứ không chỉ mang chữ.
 *  3. **Không mở đường cho bàn tay.** Cổng ghi ngân sách đọc `action` của chính dòng, và `action`
 *     không đổi. Máy vẫn không được tiêu tiền dựa trên bằng chứng của một thực thể khác.
 */
/**
 * ═══════════ TIỀN KHÔNG THUỘC MÃ NÀO: HAI THỨ KHÁC HẲN NHAU, KHÔNG PHẢI MỘT ═══════════
 *
 * `resolveCampaign()` phân biệt được `test` (tên chiến dịch mang chữ TEST, hoặc người khai tay) với
 * `none` (không khớp mã nào và cũng không phải test). Nhưng `ad_spends` chỉ lưu `product_id`, nên
 * cả hai cùng thành `NULL` — và xuống tới bảng quyết định chúng đội chung một chữ "chưa đủ dữ liệu".
 *
 * Đo production 23/09/2026 trên kỳ chuẩn, 387 chiến dịch không nối được về mã (11.165.022 ₫):
 *
 *     318 dòng · 7.457.012 ₫ (66,8%)  tên mang chữ TEST  ⇒ CHI PHÍ TEST, đúng như nó là
 *      62 dòng · 3.617.087 ₫ (32,4%)  không test, không mã ⇒ CHƯA PHÂN LOẠI, cần người
 *       7 dòng ·    90.923 ₫  (0,8%)  tên CÓ mã mà không nối được ⇒ bộ ghép trượt
 *
 * Gộp ba thứ ấy lại sinh ra một lời khuyên sai mà tôi đã suýt đưa: *"khai mã cho 387 chiến dịch"* —
 * tức bảo người ta gán mã hàng cho 318 chiến dịch test, một việc bịa đặt.
 *
 * ─── CHI PHÍ TEST KHÔNG ĐƯỢC CHẤM BẰNG ROAS ───
 *
 * Nó không thiếu dữ liệu; nó có một câu hỏi KHÁC: *"tháng này đốt bao nhiêu vào test, và có cái nào
 * ra được thành mã bán không"*. Đòi nó đạt điểm hoà vốn như một chiến dịch bán hàng là đo sai thứ.
 *
 * ─── VÌ SAO ĐỌC RA LÚC XEM, KHÔNG THÊM CỘT ───
 *
 * Phân loại là hàm của LUẬT (`ads.campaignMap`, bí danh, sổ mã hàng) chứ không phải một sự kiện đã
 * xảy ra. Người sửa bảng ghép thì câu trả lời phải đổi NGAY — cùng lý lẽ đã áp cho kết cục ca chăm
 * sóc (mục 56) và cho phân loại đợt care (mục 62). Thêm cột là mời một lượt backfill và một con số
 * cũ đi phục vụ luật mới.
 */
export type AdsSpendClass = "PRODUCT" | "TEST" | "UNCLASSIFIED" | "EXCLUDED";

export const ADS_SPEND_CLASS_LABEL: Record<AdsSpendClass, string> = {
  PRODUCT: "Bán hàng",
  TEST: "Chi phí test",
  UNCLASSIFIED: "Chưa phân loại",
  EXCLUDED: "Đã loại khỏi phép tính",
};

export const ADS_SPEND_CLASS_HINT: Record<AdsSpendClass, string> = {
  PRODUCT: "Chiến dịch chạy cho một mã hàng cụ thể — chấm được bằng ROAS và điểm hoà vốn.",
  TEST: "Chi phí thử fanpage / mẫu quảng cáo mới, KHÔNG thuộc mã hàng nào — gồm chiến dịch tên có chữ TEST, chiến dịch khai tay là test, và chiến dịch mà tên CHƯA có mã hàng (chủ shop chốt 26/09/2026). Đặt mã hàng vào tên chiến dịch thì lượt đồng bộ kế tiếp tự ghép lại cho mọi ngày. Đòi nó đạt hoà vốn như một chiến dịch bán hàng là đo sai thứ.",
  UNCLASSIFIED:
    "Không nhận ra mã hàng trong tên, và cũng không khai là test. ERP KHÔNG đoán — đây là việc cần người: khai mã cho chiến dịch, hoặc đánh dấu nó là chi phí test, ở màn Chi phí quảng cáo.",
  EXCLUDED: "Người đã khai loại chiến dịch này khỏi phép tính.",
};

/**
 * Phân loại SUY RA từ nguồn ghép của `resolveCampaign` — không phải một danh sách thứ hai.
 *
 * ─── CHIẾN DỊCH CHƯA ĐẶT MÃ TRONG TÊN LÀ CHI PHÍ TEST (chủ shop chốt 26/09/2026) ───
 *
 * *"Mã chiến dịch nào không đặt tên thì cứ cho vào test cho đến khi có tên thì sync và mapping
 * lại."* Bản trước tách `none` (không nhận ra mã, không khai test) ra `UNCLASSIFIED` — "việc cần
 * người". Đo production 26/09/2026: 8,0 triệu ₫ tháng 9 rơi vào nhóm ấy, toàn chiến dịch mang tên
 * fanpage (Phương Dung, LAVIE, Em xinh…) mà không mang mã hàng — tức đúng là tiền thử fanpage /
 * mẫu mới. Nay chúng là TEST cho tới khi tên có mã; đổi tên xong, lượt đồng bộ kế tiếp tự ghép lại
 * mã hàng cho MỌI ngày của chiến dịch (`reapplyAdsMapping` đọc tên MỚI NHẤT).
 *
 * `UNCLASSIFIED` vẫn còn trong kiểu vì màn hình và `inheritVerdict` đọc nó, nhưng hàm này không
 * còn trả ra nó.
 */
export function spendClassOf(source: "manual" | "alias" | "auto" | "test" | "none", productId: string | null, excluded: boolean): AdsSpendClass {
  if (excluded) return "EXCLUDED";
  if (productId) return "PRODUCT";
  // `manual` mà không có mã = người khai tay "đây là chi phí test"; `test` = tên có chữ TEST;
  // `none` = tên chưa có mã hàng ⇒ cũng là test, tới khi tên có mã.
  void source;
  return "TEST";
}

export type InheritedVerdict = {
  productKey: string;
  productName: string;
  action: AdsAction;
  reason: string;
};

/**
 * ═══════════ BẢNG VẼ BAO NHIÊU DÒNG — VÀ VÌ SAO KHÔNG VẼ HẾT ═══════════
 *
 * Đo production 23/09/2026: `/ads` 18,4 s · **6.768 kB**. `perf-audit` theo từng khối cho thấy dữ liệu
 * thô của bảng quyết định chỉ 902 KB cho 742 dòng — phần còn lại của 6,7 MB là HTML: bảng là client
 * component nên nhận và VẼ đủ 742 dòng, mỗi dòng nhiều ô hai tầng, nhãn và chú thích. Trong khi hơn
 * 600 dòng trong số ấy là "chưa đủ dữ liệu".
 *
 * Nên máy chủ chỉ gửi xuống những dòng cần đọc: MỌI dòng có kết luận thật (không bao giờ bị cắt),
 * rồi lấp tới `ADS_TABLE_ROW_CAP` bằng các dòng còn lại theo đúng thứ tự bảng vốn có (động tới
 * nhiều tiền hơn đứng trước). Không dòng nào biến mất: bảng in số dòng đang ẩn, số tiền của chúng,
 * và một lối "Hiện tất cả".
 *
 * Đây là con số HIỂN THỊ, không phải ngưỡng nghiệp vụ: sổ quyết định, hàng đợi `/work` và mọi con số
 * tổng vẫn đọc đủ từng dòng.
 */
export const ADS_TABLE_ROW_CAP = 80;

/** Dòng có kết luận THẬT — không bao giờ bị cắt khỏi bảng. */
export function isConclusive(action: AdsAction): boolean {
  return action !== "INSUFFICIENT_DATA" && action !== "NO_SPEND_DATA";
}

/**
 * Chọn dòng để VẼ. Hàm THUẦN, giữ nguyên thứ tự đầu vào. `all` = vẽ hết.
 *
 * Trần chỉ áp lên dòng CHƯA có kết luận. Dòng có kết luận luôn được giữ, không tính vào trần: một
 * ngày có 100 dòng cần hành động thì cả 100 phải hiện, dù vượt trần hiển thị — cắt một khuyến nghị
 * CẮT khỏi màn hình là đúng thứ bảng này sinh ra để chặn.
 */
export function rowsToRender<T extends { action: AdsAction }>(rows: T[], all: boolean, cap = ADS_TABLE_ROW_CAP): { shown: T[]; hidden: T[] } {
  if (all) return { shown: rows, hidden: [] };
  const coKetLuan = rows.filter((r) => isConclusive(r.action)).length;
  /*
    Bảng đã xếp dòng có kết luận lên đầu, nhưng hàm này KHÔNG dựa vào điều đó: nó giữ mọi dòng có
    kết luận dù chúng nằm ở đâu, rồi mới lấp chỗ trống bằng các dòng còn lại theo thứ tự cũ. Một ngày
    ai đó đổi phép sắp xếp thì khuyến nghị vẫn không rơi khỏi màn hình.
  */
  // Chỗ còn lại cho dòng CHƯA có kết luận — hết chỗ thì không lấp nữa, nhưng dòng có kết luận vẫn giữ.
  const conCho = Math.max(0, cap - coKetLuan);
  const shown: T[] = [];
  const hidden: T[] = [];
  let lap = 0;
  for (const r of rows) {
    if (isConclusive(r.action)) shown.push(r);
    else if (lap < conCho) {
      shown.push(r);
      lap += 1;
    } else hidden.push(r);
  }
  return { shown, hidden };
}

/**
 * Dòng ĐÃ CHÍN luôn phải được gửi xuống bảng, kể cả khi `rowsToRender` xếp nó vào phần ẩn.
 *
 * "Đã chín" đọc từ SỔ quyết định (giữ nguyên N ngày), còn `rowsToRender` giữ dòng theo kết luận
 * HÔM NAY — hai tập không trùng tuyệt đối. Nút Bàn tay chỉ hiện trên dòng đã chín, nên một dòng chín
 * bị ẩn là một nút bấm được mà không ai nhìn thấy (chủ shop báo 24/09/2026: "không thấy Bàn tay").
 * Thứ tự: phần đang hiện giữ nguyên, dòng chín bị ẩn nối vào cuối — không xáo lại bảng.
 */
export function keepRipeRows<T extends { key: string }>(r: { shown: T[]; hidden: T[] }, ripe: Set<string>): { shown: T[]; hidden: T[] } {
  return { shown: [...r.shown, ...r.hidden.filter((x) => ripe.has(x.key))], hidden: r.hidden.filter((x) => !ripe.has(x.key)) };
}

/** Hành động đề xuất cho một dòng. Thứ tự này cũng là thứ tự ưu tiên xử lý trên giao diện. */
export type AdsAction = "SCALE" | "HOLD" | "WATCH" | "CUT" | "FIX_DELIVERY" | "INSUFFICIENT_DATA" | "NO_SPEND_DATA";

export const ADS_ACTION_LABEL: Record<AdsAction, string> = {
  SCALE: "Tăng ngân sách",
  HOLD: "Giữ nguyên",
  WATCH: "Theo dõi",
  CUT: "Cắt",
  FIX_DELIVERY: "Sửa khâu giao",
  INSUFFICIENT_DATA: "Chưa đủ dữ liệu",
  NO_SPEND_DATA: "Không có số chi",
};

export const ADS_ACTION_HINT: Record<AdsAction, string> = {
  SCALE: `Lợi nhuận góp sau quảng cáo dương và ROAS đang cao hơn điểm hoà vốn ít nhất ${Math.round((ADS_DECISION_RULE.scaleAbove - 1) * 100)}%. Còn chỗ để tăng tiền.`,
  HOLD: "Có lãi nhưng biên mỏng: trên hoà vốn mà chưa đủ dày để tăng tiền. Giữ nguyên và tìm cách hạ giá vốn / tăng tỷ lệ giao thành công.",
  WATCH: "Đang quanh điểm hoà vốn. Chưa đáng cắt, nhưng cũng chưa kiếm được tiền — xem lại trong vài ngày tới.",
  CUT: `ROAS thấp hơn điểm hoà vốn quá ${Math.round((1 - ADS_DECISION_RULE.cutBelow) * 100)}%: càng chạy càng lỗ. Cắt hoặc làm lại từ đầu.`,
  FIX_DELIVERY: `Quảng cáo ra đơn tốt nhưng tỷ lệ giao thành công dưới ${ADS_DECISION_RULE.lowSuccessRate}%. Tiền mất ở khâu giao, không phải ở quảng cáo — cắt quảng cáo là chữa sai bệnh.`,
  INSUFFICIENT_DATA: `Chưa đủ căn cứ: cần ít nhất ${ADS_DECISION_RULE.minSpend.toLocaleString("vi-VN")}đ chi quảng cáo và ${ADS_DECISION_RULE.minFinishedOrders} đơn đã kết thúc. Kết luận lúc này là đoán.`,
  NO_SPEND_DATA:
    "Dòng này không có số chi quảng cáo trong kỳ. Hoặc mẩu/nhóm không tiêu đồng nào, hoặc kỳ đang xem rơi vào những ngày ERP mới chỉ có chi tiết ở cấp CHIẾN DỊCH (xem dòng độ phủ chi tiết ngay trên bảng). Không có tiền thì không có ROAS, không có lợi nhuận, và do đó không có khuyến nghị về tiền.",
};

export const ADS_ACTION_TONE: Record<AdsAction, string> = {
  SCALE: "text-emerald-600 dark:text-emerald-400",
  HOLD: "text-sky-600 dark:text-sky-400",
  WATCH: "text-amber-600 dark:text-amber-400",
  CUT: "text-rose-600 dark:text-rose-400",
  FIX_DELIVERY: "text-violet-600 dark:text-violet-400",
  INSUFFICIENT_DATA: "text-muted-foreground",
  NO_SPEND_DATA: "text-muted-foreground",
};

/** Thứ tự xếp: việc cần làm ngay đứng trước, phần không kết luận được xuống cuối. */
export const ADS_ACTION_ORDER: Record<AdsAction, number> = {
  CUT: 0,
  FIX_DELIVERY: 1,
  SCALE: 2,
  WATCH: 3,
  HOLD: 4,
  INSUFFICIENT_DATA: 5,
  NO_SPEND_DATA: 6,
};

/** Cấp phân tích. `spendKnown` là thuộc tính của DỮ LIỆU, không phải lựa chọn hiển thị. */
export type AdsDimension = "campaign" | "product" | "adset" | "ad";

export const ADS_DIMENSION_LABEL: Record<AdsDimension, string> = {
  campaign: "Chiến dịch",
  product: "Mã hàng",
  adset: "Nhóm quảng cáo",
  ad: "Mẩu quảng cáo",
};

/**
 * ───────────── CẤP NÀO CÓ SỐ CHI QUẢNG CÁO ─────────────
 *
 * CẢ BỐN, từ 22/09/2026. Trước đó `ad_spends` chỉ có hạt CHIẾN DỊCH × NGÀY nên hai cấp dưới mang
 * `NO_SPEND_DATA` — và chia đều tiền chiến dịch xuống chúng bị cấm, vì chia đều làm tổng khớp
 * trong khi từng dòng đều sai.
 *
 * Nay `ad_spends` ghi ở hạt MẨU × NGÀY, nên cấp nhóm và cấp chiến dịch là **PHÉP CỘNG** của cấp
 * mẩu chứ không phải phép chia. Đo trên production trước khi đổi (ops `ads-level-probe`, 30 ngày,
 * 7 tài khoản): Σ cấp mẩu = Σ cấp chiến dịch = **148.369.383 ₫**, lệch **0 ₫**, và **0** cặp
 * (tài khoản × ngày) lệch.
 *
 * ─── NHƯNG NGÀY CŨ VẪN Ở HẠT CHIẾN DỊCH ───
 *
 * Lượt đồng bộ chỉ chạm N ngày gần nhất, nên mọi ngày ngoài cửa sổ ấy mãi mãi không có chi tiết cấp
 * mẩu. Cờ này chỉ nói "cấp ấy CÓ THỂ có tiền"; **bao nhiêu phần của kỳ thật sự có** thì đọc ở
 * `AdsDecision.spendDetail`, và giao diện phải in ra. Bật cờ mà không in độ phủ là hứa một thứ chỉ
 * đúng với những kỳ gần đây.
 */
export const ADS_DIMENSION_HAS_SPEND: Record<AdsDimension, boolean> = {
  campaign: true,
  product: true,
  adset: true,
  ad: true,
};
