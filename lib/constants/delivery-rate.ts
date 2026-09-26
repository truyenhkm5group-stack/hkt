/**
 * ═══════════ THANG BẬC TỶ LỆ GIAO THÀNH CÔNG CỦA MỘT MÃ HÀNG ═══════════
 *
 * MỘT hàm THUẦN trả lời đúng một câu hỏi: *"mã này, trong kỳ này, bao nhiêu phần trăm đơn tới được
 * tay khách?"* — và nó nói luôn CĂN CỨ nào đã trả lời (`source`), vì một con số đo được và một con
 * số giả định trông y hệt nhau khi in cùng cỡ chữ.
 *
 * ─── VÌ SAO NÓ PHẢI RỜI KHỎI `profit-nominal.ts` ───
 *
 * Thang bậc này do chủ shop chốt ngày 21/09/2026 và tới 22/09/2026 nó chỉ sống trong thân vòng lặp
 * dựng dòng của Báo cáo lợi nhuận danh nghĩa. Báo cáo Hiệu quả marketing theo ngày cần ĐÚNG thang
 * bậc ấy — chép sang là dựng bậc thứ hai, và hai bậc thì có ngày chúng trả lời khác nhau về cùng
 * một mã trong khi cả hai màn hình đều nói "tỷ lệ giao thành công".
 *
 * ═══════════ MÃ CHƯA CHÍN KHÔNG ĐƯỢC MƯỢN TỶ LỆ NỀN CỦA TOÀN SHOP ═══════════
 *
 * Chủ shop chốt 23/09/2026, sau khi ô "TL GTC ƯT" của Đầm Q005 in **35,9%** trong khi chính mã ấy
 * đã giao thành công **5/6** đơn đã kết thúc.
 *
 * Nguyên nhân gốc: bậc `projected` chỉ đòi **một** đơn của chính mã đi tới kết cục, mà Q005 có 6 —
 * đủ lọt cổng, không đủ để nói lên điều gì. 99/105 đơn còn đang chạy, và mỗi đơn ấy được cân bằng
 * xác suất học TOÀN SHOP (`MIN_CELL_SAMPLE` = 10 quan sát mỗi ô, Q005 không đạt ở bất kỳ ô nào nên
 * hai bậc theo mã hàng đều rỗng). Tử số vì thế là **5 + 99 × 0,33**, trong đó 0,33 là tỷ lệ nền
 * của shop.
 *
 * Và "tỷ lệ nền của shop" là một cái tên lịch sự cho **tỷ lệ của Đầm Q002**. Đếm theo đơn ĐÃ KẾT
 * THÚC — tức trọng số thật trong tập học — ngày 23/09/2026:
 *
 *     Q002  1.159 đơn (62,0% tập học)  GTC 26,7%      ← một mình quyết định tỷ lệ nền
 *     Q003    474 đơn (25,4%)          GTC 42,8%
 *     Q004    126 đơn ( 6,7%)          GTC 55,6%
 *     Q001     71 đơn ( 3,8%)          GTC 46,5%
 *     X001     33 đơn ( 1,8%)          GTC 39,4%
 *     Q005      6 đơn ( 0,3%)          GTC 83,3%
 *     ─────────────────────────────────────────
 *     gộp   1.869 đơn                  GTC 33,9%   (trung vị các mã: 42,8% — lệch 9 điểm)
 *
 * Một mã hỏng kéo tụt dự tính của mọi mã mới. Đó là điều chủ shop từ chối, và từ chối đúng.
 *
 * Tệ hơn: thang bậc cũ đi NGƯỢC CHIỀU BẰNG CHỨNG. Cùng một ảnh chụp màn hình hôm ấy, **Q006** có
 * 0 đơn kết thúc — không một mẩu dữ liệu nào — và in **55,0%** (tỷ lệ khai ở Giả định); **Q005** có
 * 5/6 đơn giao được và in **35,9%**. Mã có bằng chứng tốt bị chấm thấp hơn mã không có bằng chứng.
 *
 * ─── SÁU BẬC, XẾP THEO ĐỘ MẠNH CỦA CĂN CỨ ───
 *
 *   1. `override` GIỮ VĨNH VIỄN — chủ shop gõ tay và khai rõ là giữ kể cả khi mã đã chín. Đây là
 *                    một QUYẾT ĐỊNH, không phải ước lượng, nên nó thắng mọi số đo.
 *   2. `projected` — hợp đồng `PROJECTED_GTC_V4`: mỗi đơn đang chạy cân theo xác suất của CHÍNH
 *                    trạng thái ĐVVC nó đang ở. Đòi HAI điều kiện, không phải một:
 *                      (a) mã ĐÃ CHÍN — số đơn của chính mã đi tới kết cục đạt `matureMinFinished`;
 *                      (b) TỬ SỐ CHỦ YẾU LÀ CỦA CHÍNH MÃ — phần đi mượn không quá `MAX_BORROWED_SHARE`.
 *                    Vế (b) là chỗ hai bản vá trước đều trượt. Cổng đầu tiên là "ít nhất MỘT đơn";
 *                    nó chặn đúng một ca (0 đơn, đo 21/09/2026: Q005 in 37,5% khi `giao 0 · hoàn 0 ·
 *                    đang giao 62`) rồi thả lọt mọi ca 1–9 đơn. Cổng thứ hai nâng lên 10 đơn; đo
 *                    lại chiều 23/09/2026, Q005 vừa chạm 10 đơn kết thúc (giao 8 · hoàn 2) là lập
 *                    tức quay về bậc này và in **36,2%** — vì `MIN_CELL_SAMPLE` đòi 10 quan sát cho
 *                    MỖI ô (trạng thái × tuổi kiện), mà 10 đơn kết thúc không đủ cho một ô nào, nên
 *                    94 đơn đang chạy vẫn cân bằng xác suất toàn shop. Tử số 37,6 có 29,6 đi mượn —
 *                    **79%**. Đếm đơn không trả lời được câu hỏi này; chỉ đếm CHÍNH TỬ SỐ mới trả
 *                    lời được.
 *   3. `history`   — tỷ lệ hoàn thật của mã trong `returnRateWindowDays` ngày gần nhất, khi số đơn
 *                    đã kết thúc đạt `minFinishedOrders` (ngưỡng RIÊNG, cao hơn: một tỷ lệ thô
 *                    không có mô hình đỡ nên nó đòi nhiều bằng chứng hơn).
 *   4. `override` TẠM TỚI KHI CHÍN — chủ shop đặt tay cho một mã mới. Nó NHƯỜNG CHỖ cho bậc 2/3
 *                    ngay khi mã đủ chín (chủ shop chốt 23/09/2026: *"tự chuyển sang số đo khi đủ
 *                    chín"*), nên nó không bao giờ hoá thành một con số bị bỏ quên.
 *   5. `blended`   — mã đã có ít nhất một đơn kết thúc nhưng bậc 2 không nhận, vì MỘT TRONG HAI lý
 *                    do: chưa chín (`IMMATURE`), hoặc chín rồi mà tử số chủ yếu đi mượn
 *                    (`MOSTLY_BORROWED`). Cả hai đều dẫn tới cùng một phép: **co ngót** giữa số đo
 *                    của CHÍNH MÃ và mốc neo, KHÔNG BAO GIỜ là tỷ lệ nền của shop. Màn hình phải in
 *                    ĐÚNG lý do — "đợi thêm đơn" và "mô hình chưa biết gì về mã này" là hai việc
 *                    phải làm khác nhau. Xem `blendDeliveryRate`.
 *   6. `default`   — tỷ lệ khai ở Giả định (`defaultReturnRate`). YẾU NHẤT, và là bậc duy nhất
 *                    không có một quan sát nào của chính mã đứng sau.
 *
 * Không có bậc thứ bảy và KHÔNG có nhánh nào trả về "—" cho một mã đang bán: chủ shop chốt
 * 21/09/2026 rằng một ô trống không giúp ra quyết định nào. Nhưng `source` phải đi kèm con số tới
 * tận màn hình, vì bậc 4 · 5 · 6 KHÔNG phải số đo — chúng không được tô màu và không được xếp hạng.
 */

export type DeliveryRateSource = "override" | "projected" | "blended" | "history" | "default";

/**
 * Bậc nào là SỐ ĐO của chính mã, bậc nào là quyết định / ước lượng. Dùng để quyết định có tô màu.
 *
 * `blended` đứng ở phía KHÔNG ĐO ĐƯỢC dù nó có dữ liệu thật của mã bên trong: hoặc mốc neo đang
 * nặng hơn số đo (mã chưa chín), hoặc mô hình đã thừa nhận phần lớn tử số của nó đi mượn
 * (`MOSTLY_BORROWED`). Cả hai trường hợp, tô màu nó là tô màu một thứ chưa ai đo.
 */
export const DELIVERY_RATE_MEASURED: Record<DeliveryRateSource, boolean> = {
  override: false,
  projected: true,
  blended: false,
  history: true,
  default: false,
};

export const DELIVERY_RATE_SOURCE_LABEL: Record<DeliveryRateSource, string> = {
  override: "Chủ shop đặt tay",
  projected: "Số đo theo từng đơn",
  blended: "Số đo của mã co ngót về tỷ lệ khai",
  history: "Lịch sử của mã",
  default: "Tỷ lệ khai ở Giả định",
};

/**
 * ═══════════ TRẦN CỦA PHẦN ĐI MƯỢN TRONG MỘT CON SỐ GỌI LÀ "SỐ ĐO" ═══════════
 *
 * Một nửa. Không phải một con số đẹp mà là ĐỊNH NGHĨA: nhãn `projected` đọc là *"số đo theo từng
 * đơn của chính mã"*, nên nó chỉ đúng khi phần lớn tử số thật sự đến từ mã đang xem. Quá nửa đi
 * mượn thì câu ấy sai, và một con số sai nhãn còn nguy hiểm hơn một ô trống — nó được tô màu, được
 * xếp hạng, và không ai đi kiểm lại.
 *
 * Cùng một ngưỡng với `blendDeliveryRate` (mốc neo nặng hơn một nửa thì bậc ấy cũng không được gọi
 * là số đo). Hai chỗ trả lời cùng một câu hỏi nên chúng dùng chung một lằn ranh.
 *
 * Đo production 23/09/2026 với ngưỡng này: chỉ Đầm Q005 đổi phe (79% mượn). Q004 mượn nhiều nhất
 * trong nhóm còn lại và vẫn dưới 25%, vì mã nào đã có vài trăm đơn kết thúc thì các ô theo mã của
 * nó đủ mẫu và bậc `PRODUCT_*` tự thắng.
 */
export const MAX_BORROWED_SHARE = 0.5;

/** Thứ tự in ĐỘ PHỦ — mạnh nhất trước. Mọi bậc phải có mặt; kiểu `satisfies` chặn ở mức biên dịch. */
export const DELIVERY_RATE_SOURCES = ["projected", "history", "blended", "override", "default"] as const satisfies readonly DeliveryRateSource[];

/**
 * ═══════════ ĐỘ PHỦ DỰNG TỪ SỔ KHAI, KHÔNG GÕ TAY TỪNG BẬC ═══════════
 *
 * Ba màn hình (`/ads/daily`, khối khuyến nghị của `/ads`, và `scripts/marketing-calibrate.ts`)
 * từng gõ thẳng bốn bậc vào câu chữ. Ngày 23/09/2026 thang bậc có thêm `blended` và cả ba chỗ ấy
 * im lặng bỏ nó ra: dòng độ phủ in **6 mã trên tổng 7** — đo thật trên production ngay sau lượt
 * deploy đầu tiên của bậc mới.
 *
 * Một dòng độ phủ thiếu mất một bậc còn tệ hơn không có dòng nào: nó vẫn cộng ra một con số, chỉ
 * là con số ấy không bằng số mã đang chạy, và không ô nào nói rằng có gì đã bị bỏ ra ngoài.
 *
 * Nên câu chữ DẪN XUẤT từ `DELIVERY_RATE_SOURCES`. Hàm THUẦN; bậc 0 mã bị bỏ khỏi câu cho gọn,
 * nhưng `total` luôn cộng đủ MỌI bậc để nơi gọi đối chiếu được với số mã thật.
 */
export function deliveryRateCoverageParts(coverage: Partial<Record<DeliveryRateSource, number>>): {
  parts: { source: DeliveryRateSource; label: string; count: number }[];
  total: number;
} {
  const parts = DELIVERY_RATE_SOURCES.map((source) => ({ source, label: DELIVERY_RATE_SOURCE_LABEL[source], count: coverage[source] ?? 0 }));
  return { parts: parts.filter((p) => p.count > 0), total: parts.reduce((a, p) => a + p.count, 0) };
}

/* ═══════════════════ GHI ĐÈ TAY: MỘT KÊNH, HAI TUỔI THỌ ═══════════════════ */

/**
 * Ghi đè sống bao lâu.
 *
 *  · `PERMANENT`     — giữ kể cả khi mã đã chín. Đây là nghĩa của MỌI dòng ghi đè đã có trong
 *                      `settings` trước 23/09/2026, nên số cũ đọc ra phải là mode này: đổi nghĩa
 *                      dữ liệu đang nằm sẵn trong CSDL là một lượt sửa ngầm (mục 8.8).
 *  · `UNTIL_MATURE`  — mặc định cho mã mới. Tự nhường cho số đo khi mã đạt `matureMinFinished`
 *                      đơn đã kết thúc của chính nó.
 */
export type DeliveryRateOverrideMode = "PERMANENT" | "UNTIL_MATURE";

export const OVERRIDE_MODE_LABEL: Record<DeliveryRateOverrideMode, string> = {
  PERMANENT: "Giữ kể cả khi mã đã chín",
  UNTIL_MATURE: "Tạm, tới khi mã đủ chín",
};

/** Ghi đè đã chuẩn hoá — dạng mà thang bậc và màn hình đọc. */
export type DeliveryRateOverride = {
  /** Tỷ lệ HOÀN (%). Lưu tỷ lệ hoàn chứ không phải GTC để không đổi nghĩa dữ liệu cũ. */
  returnRate: number;
  mode: DeliveryRateOverrideMode;
  /** Vì sao chủ shop đặt con số này. Rỗng với dòng cũ — không bịa ra một lý do chưa ai viết. */
  reason: string;
  /** ISO. `null` với dòng cũ. */
  setAt: string | null;
  /** Email người đặt. `null` với dòng cũ. */
  setBy: string | null;
};

/**
 * Dạng LƯU trong `settings`: số trần (dòng cũ) hoặc bản khai đầy đủ (dòng mới).
 *
 * Giữ nhánh số trần là cố ý — kho `settings` đang có những dòng như vậy và một lượt đọc không được
 * làm chúng biến mất hay đổi nghĩa.
 */
export type StoredDeliveryRateOverride =
  | number
  | {
      returnRate: number;
      mode?: DeliveryRateOverrideMode;
      reason?: string;
      setAt?: string | null;
      setBy?: string | null;
    };

const clampPct = (v: number) => Math.min(100, Math.max(0, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Đọc một dòng ghi đè về dạng chuẩn. `null` khi dòng không dùng được — KHÔNG đoán một giá trị. */
export function parseDeliveryRateOverride(raw: StoredDeliveryRateOverride | null | undefined): DeliveryRateOverride | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    return { returnRate: clampPct(raw), mode: "PERMANENT", reason: "", setAt: null, setBy: null };
  }
  if (typeof raw !== "object") return null;
  const rate = raw.returnRate;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  return {
    returnRate: clampPct(rate),
    mode: raw.mode === "PERMANENT" ? "PERMANENT" : "UNTIL_MATURE",
    reason: typeof raw.reason === "string" ? raw.reason : "",
    setAt: typeof raw.setAt === "string" ? raw.setAt : null,
    setBy: typeof raw.setBy === "string" ? raw.setBy : null,
  };
}

/* ═══════════════════ CO NGÓT ═══════════════════ */

/**
 * ═══ CO NGÓT: SỐ ĐO CỦA CHÍNH MÃ, KÉO VỀ MỐC NEO THEO ĐÚNG CỠ MẪU CỦA NÓ ═══
 *
 *     mức = (n × tỷ lệ GTC thật của mã + k × mốc neo) / (n + k)
 *
 * `n` là số đơn CỦA CHÍNH MÃ đã đi tới kết cục. `k` là `matureMinFinished` — tức **mốc neo nặng
 * đúng bằng số đơn mà chủ shop coi là đủ để tin số đo của mã**. Lấy lại đúng ngưỡng đang chạy thay
 * vì gõ một con số thứ ba: ngưỡng chín và trọng số mốc neo là CÙNG MỘT câu hỏi ("bao nhiêu đơn thì
 * đủ tin mã này?"), nên chúng phải là cùng một con số, và đổi ngưỡng ở Giả định là cả hai đổi theo.
 *
 * Ba tính chất, và cả ba đều là lý do chọn công thức này:
 *
 *  · `n = 0` ⇒ đúng bằng mốc neo. Không có bước nhảy giữa "chưa có đơn nào" và "có đơn đầu tiên" —
 *    đây chính là chỗ thang bậc cũ gãy (Q006 in 55%, Q005 in 35,9%).
 *  · `n` tăng ⇒ trôi dần về số đo thật của mã. Mã tốt tự leo lên, mã xấu tự tụt xuống, không cần ai
 *    can thiệp.
 *  · Với mã CHƯA CHÍN thì `n < k`, nên **mốc neo giữ hơn 50% trọng số**. Mã đã chín mà rơi xuống đây
 *    vì `MOSTLY_BORROWED` thì `n >= k` và số đo của chính mã nặng hơn — đúng như nó phải thế, vì lúc
 *    ấy mã có thật sự nhiều bằng chứng, chỉ là mô hình theo trạng thái chưa dùng được. Cả hai đường
 *    đều KHÔNG được xếp vào nhóm "đo được": một bên mốc neo lấn, bên kia mô hình vừa tự nhận là
 *    chưa biết gì về mã này.
 *
 * ─── VÌ SAO KHÔNG DÙNG THẲNG SỐ ĐO CỦA MÃ (5/6 = 83,3%) ───
 *
 * Mẫu 6 đơn có khoảng tin cậy 95% là **43,6% – 97,0%** — rộng tới mức không quyết định được gì. Và
 * nó lệch LÊN TRÊN một cách có hệ thống: đơn giao được kết thúc nhanh hơn đơn hoàn nhiều (đo
 * 13/09/2026 — giao p50 2,8 ngày, hoàn p50 7,0 ngày), nên những đơn kết thúc SỚM NHẤT của một mã
 * mới gần như luôn là đơn giao được. Tin thẳng 5/6 là tin vào một mẫu lệch.
 *
 * Hàm THUẦN. Trả `null` khi không có số đo của chính mã — không có gì để co ngót thì không được
 * bịa ra một mức.
 */
export function blendDeliveryRate(input: {
  /** Tỷ lệ GTC THẬT (%) của chính mã trên đơn đã kết thúc. `null` = mã chưa có đơn nào kết thúc. */
  measuredDeliveryRate: number | null;
  /** Số đơn của chính mã đã đi tới kết cục. */
  finished: number;
  /** Mốc neo: tỷ lệ GTC (%) khai ở Giả định. */
  anchorDeliveryRate: number;
  /** Trọng số của mốc neo, tính bằng "số đơn ảo" — dùng `minFinishedOrders`. */
  anchorWeight: number;
}): number | null {
  const { measuredDeliveryRate: m, finished: n, anchorDeliveryRate: a, anchorWeight: k } = input;
  if (m === null || !Number.isFinite(m)) return null;
  if (!(n > 0)) return null;
  const w = Math.max(0, k);
  const mau = n + w;
  if (!(mau > 0)) return null;
  return clampPct((n * clampPct(m) + w * clampPct(a)) / mau);
}

/**
 * KHOẢNG TIN CẬY 95% CỦA MỘT TỶ LỆ, theo Wilson.
 *
 * Dùng Wilson chứ không phải công thức chuẩn tắc (`p ± 1,96 √(p(1−p)/n)`): với mẫu nhỏ hoặc `p` sát
 * 0 / 1, công thức chuẩn tắc cho cận nằm NGOÀI [0,1] — 5/6 đơn ra cận trên 113%, một con số không
 * tồn tại. Mẫu nhỏ chính là toàn bộ lý do bảng này tồn tại, nên chỗ này không được dùng xấp xỉ hỏng
 * đúng ở nơi nó được gọi nhiều nhất.
 *
 * Trả `null` khi `n = 0`: không quan sát nào thì không có khoảng, và một khoảng `0–100%` in ra
 * trông như một phép đo (§42 — chưa biết không được in thành một con số).
 *
 * Hàm THUẦN, đơn vị PHẦN TRĂM ở cả đầu vào lẫn đầu ra.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!(n > 0)) return null;
  const k = Math.min(Math.max(0, successes), n);
  const p = k / n;
  const z2 = z * z;
  const mau = 1 + z2 / n;
  const tam = (p + z2 / (2 * n)) / mau;
  const nua = (z / mau) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: clampPct((tam - nua) * 100), high: clampPct((tam + nua) * 100) };
}

/* ═══════════════════ THANG BẬC ═══════════════════ */

export type DeliveryRateInput = {
  /** Ghi đè của chủ shop cho mã này, đã chuẩn hoá. `null` = không có. */
  override?: DeliveryRateOverride | null;
  /** Tỷ lệ GIAO THÀNH CÔNG (%) của hợp đồng `PROJECTED_GTC_V4`. `null` = hợp đồng chưa kết luận được. */
  projectedDeliveryRate: number | null;
  /** Số đơn CỦA CHÍNH MÃ đã đi tới kết cục trong cohort mô hình. */
  projectedFinished: number;
  /**
   * Phần tử số dự báo đi MƯỢN của mã khác (xác suất bậc `GLOBAL_*`), và phần đến từ CHÍNH MÃ
   * (bậc `PRODUCT_*`). `null` = hợp đồng không nói được — khi ấy coi như KHÔNG kết luận được là
   * số đo, vì không chứng minh được điều ngược lại (rơi về phía HẸP HƠN).
   */
  projectedBorrowed?: number | null;
  projectedOwnWeight?: number | null;
  /**
   * Tỷ lệ GIAO THÀNH CÔNG (%) THẬT của chính mã trên `projectedFinished` đơn đó — `actualRate` của
   * hợp đồng. Đây là thứ được co ngót; nó KHÔNG chứa một chút xác suất mượn nào.
   */
  measuredDeliveryRate: number | null;
  /** Tỷ lệ HOÀN (%) lịch sử của mã. `null` = chưa đơn nào kết thúc trong cửa sổ. */
  historyReturnRate: number | null;
  historyFinished: number;
  /**
   * Ngưỡng của bậc `history`: bao nhiêu đơn đã kết thúc trong `returnRateWindowDays` thì tin TỶ LỆ
   * THÔ của mã. Chủ shop để 50 (chốt 22/09/2026) — một tỷ lệ thô không có gì đỡ nên nó đòi nhiều
   * bằng chứng hơn.
   */
  minFinishedOrders: number;
  /**
   * Ngưỡng ĐỦ CHÍN: bao nhiêu đơn đã kết thúc của chính mã thì cho bậc `projected` chạy. Cũng là
   * TRỌNG SỐ của mốc neo khi co ngót.
   *
   * CỐ Ý TÁCH KHỎI `minFinishedOrders`, dù cả hai đều đếm "đơn đã kết thúc của mã": chúng trả lời
   * hai câu hỏi khác nhau. `minFinishedOrders` hỏi *"đủ chưa để tin một TỶ LỆ THÔ?"*; ngưỡng này
   * hỏi *"đủ chưa để tin một mô hình có ĐIỀU KIỆN HOÁ theo trạng thái và tuổi kiện?"* — mô hình ấy
   * còn đọc được cả những đơn đang chạy, nên nó cần ít bằng chứng thô hơn. Gộp hai số làm một là
   * buộc chủ shop chọn một con số cho hai quyết định, và ngày 23/09/2026 họ chọn 10 cho câu thứ
   * hai trong khi câu thứ nhất đang là 50.
   */
  matureMinFinished: number;
  /** Tỷ lệ HOÀN (%) khai ở Giả định — mốc neo, và cũng là bậc cuối. */
  defaultReturnRate: number;
};

export type ResolvedDeliveryRate = {
  /** % giao thành công, luôn là một con số (0–100). */
  deliveryRate: number;
  /** % hoàn = 100 − `deliveryRate`. */
  returnRate: number;
  source: DeliveryRateSource;
  /** Số đơn đã kết thúc đứng sau con số này. 0 với bậc `default`. */
  finished: number;
  /**
   * Mã đã đủ chín để máy tự đo chưa — tức số đơn đã kết thúc của chính mã đạt `matureMinFinished`.
   * Màn hình dùng nó để tách bảng "mã mới" khỏi bảng chính, và để in "6/10 đơn" thay vì một lời
   * hứa mơ hồ về việc khi nào con số sẽ đổi.
   */
  mature: boolean;
  /** Số đơn đã kết thúc của chính mã trong cohort mô hình — vạch tiến tới ngưỡng chín. */
  ownFinished: number;
  /**
   * VÌ SAO rơi xuống bậc co ngót. `null` khi không ở bậc ấy.
   *  · `IMMATURE`        — chưa đủ đơn kết thúc. Việc phải làm: ĐỢI, hoặc đặt tay.
   *  · `MOSTLY_BORROWED` — đủ đơn rồi nhưng mô hình vẫn đang trả lời bằng số của mã khác. Việc
   *                        phải làm: KHÁC HẲN — đây là giới hạn của mô hình, không phải của thời gian.
   */
  blendReason: "IMMATURE" | "MOSTLY_BORROWED" | null;
  /** Phần đi mượn của tử số dự báo (0–1). `null` = chưa đo được. In cạnh mọi con số `projected`. */
  borrowedShare: number | null;
  /**
   * Tỷ lệ HOÀN NỀN — bậc `history` nếu đủ mẫu, không thì `default`. Đây là con số sẽ được dùng nếu
   * ghi đè tay và số đo đều vắng mặt; màn hình Giả định in nó để chủ shop thấy bậc lùi là bao nhiêu.
   * KHÔNG làm tròn: nó là đầu vào hiển thị, không phải kết luận.
   */
  baseReturnRate: number;
};

/**
 * Thang bậc, chạy đúng thứ tự trên. Trả về TỶ LỆ HOÀN lẫn TỶ LỆ GIAO để nơi gọi không phải tự lấy
 * phần bù — hai phép trừ ở hai tệp là hai cơ hội để một chỗ làm tròn khác chỗ kia.
 */
/**
 * Số đơn ĐÃ GIAO THẬT của mã, suy từ tỷ lệ đo được và số đơn đã kết thúc. Dùng để dựng mẫu số của
 * phần-đi-mượn mà không cần nơi gọi truyền thêm một trường nữa (hai đường truyền cùng một sự thật
 * là hai cơ hội để chúng lệch nhau).
 */
function deliveredOf(i: DeliveryRateInput): number {
  const n = Math.max(0, i.projectedFinished);
  if (!n || i.measuredDeliveryRate === null || !Number.isFinite(i.measuredDeliveryRate)) return 0;
  return (clampPct(i.measuredDeliveryRate) / 100) * n;
}

export function resolveDeliveryRate(i: DeliveryRateInput): ResolvedDeliveryRate {
  const nguongChin = Math.max(1, i.matureMinFinished);
  const nguongLichSu = Math.max(1, i.minFinishedOrders);
  const ownFinished = Math.max(0, i.projectedFinished);
  /*
    CHÍN theo ĐÚNG hai cửa sổ mà hai bậc đo dùng, và không trộn chúng: cohort của kỳ (hợp đồng) và
    90 ngày gần nhất (lịch sử) đếm hai tập đơn khác nhau, nên cộng hai con số lại là đếm trùng.
  */
  const chinTheoDuBao = ownFinished >= nguongChin;
  const chinTheoLichSu = i.historyFinished >= nguongLichSu;
  const mature = chinTheoDuBao || chinTheoLichSu;

  const baseReturnRate = i.historyReturnRate !== null && chinTheoLichSu ? i.historyReturnRate : i.defaultReturnRate;

  /*
    PHẦN ĐI MƯỢN của tử số dự báo. Tử số = đơn đã giao THẬT + phần của chính mã + phần mượn; hai
    vế đầu đều là bằng chứng của mã đang xem, nên mẫu số của tỷ lệ này là cả ba.

    Hợp đồng không nói được (`null`) ⇒ coi như 1 (mượn hết): mọi nhánh lỗi phải rơi về phía HẸP
    HƠN, và ở đây "hẹp hơn" nghĩa là KHÔNG dán nhãn số đo cho thứ chưa chứng minh được.
  */
  const muon = i.projectedBorrowed;
  const cuaMinh = i.projectedOwnWeight;
  const tuSo = ownFinished > 0 || (muon ?? 0) > 0 || (cuaMinh ?? 0) > 0 ? deliveredOf(i) + (cuaMinh ?? 0) + (muon ?? 0) : 0;
  const borrowedShare = muon === undefined || muon === null ? null : tuSo > 0 ? Math.min(1, muon / tuSo) : 0;
  const tuSoChuYeuDiMuon = borrowedShare === null ? true : borrowedShare > MAX_BORROWED_SHARE;

  const ra = (returnRate: number, source: DeliveryRateSource, finished: number, blendReason: ResolvedDeliveryRate["blendReason"] = null): ResolvedDeliveryRate => {
    const rr = round1(clampPct(returnRate));
    return { deliveryRate: round1(100 - rr), returnRate: rr, source, finished, mature, ownFinished, baseReturnRate, blendReason, borrowedShare };
  };

  const ov = i.override ?? null;

  // ── 1. Ghi đè GIỮ VĨNH VIỄN: thắng mọi số đo ──
  if (ov && ov.mode === "PERMANENT") return ra(ov.returnRate, "override", 0);

  /*
    ── 2. Mã ĐÃ CHÍN **VÀ** tử số chủ yếu là của chính nó: máy tự đo ──

    Vế thứ hai không phải một phép kiểm tra thêm cho chắc: thiếu nó thì Q005 vừa chạm 10 đơn kết
    thúc là lập tức in lại 36,2% — đúng con số chủ shop đã bác bỏ, chỉ khác là lần này nó mang nhãn
    "số đo theo từng đơn" và được tô màu.
  */
  if (chinTheoDuBao && i.projectedDeliveryRate !== null && !tuSoChuYeuDiMuon) return ra(100 - i.projectedDeliveryRate, "projected", ownFinished);
  if (chinTheoLichSu && i.historyReturnRate !== null) return ra(i.historyReturnRate, "history", i.historyFinished);

  // ── 3. Mã CHƯA CHÍN: chủ shop đã đặt tay thì nghe chủ shop ──
  if (ov) return ra(ov.returnRate, "override", ownFinished);

  // ── 4. Mã CHƯA CHÍN mà đã có kết cục: co ngót về mốc neo, KHÔNG mượn tỷ lệ nền toàn shop ──
  const coNgot = blendDeliveryRate({
    measuredDeliveryRate: i.measuredDeliveryRate,
    finished: ownFinished,
    anchorDeliveryRate: 100 - i.defaultReturnRate,
    anchorWeight: nguongChin,
  });
  if (coNgot !== null) return ra(100 - coNgot, "blended", ownFinished, chinTheoDuBao ? "MOSTLY_BORROWED" : "IMMATURE");

  // ── 5. Chưa một quan sát nào của chính mã ──
  return ra(i.defaultReturnRate, "default", 0);
}
