import { vnEndOfDay, vnStartOfDay } from "@/lib/format";

/**
 * ═══════════ BỐN MỐC THỜI GIAN CỦA MỘT CA CARE — BỐN CÂU HỎI KHÁC NHAU ═══════════
 *
 * Bàn care đang có đúng một cái đồng hồ bấm được: `queueSince` (kiện vào hàng đợi lúc nào) qua các
 * rổ hạn xử lý. Bốn mốc dưới đây trả lời bốn câu hỏi mà rổ đó không trả lời được, và **không mốc
 * nào suy ra được mốc nào**:
 *
 *  1. `orderCreated`      — ĐƠN lên Pancake lúc nào.
 *  2. `carrierStageSince` — kiện ĐỔI sang trạng thái hiện tại lúc nào (mốc vào chặng).
 *  3. `carrierLastEvent`  — lần cuối ERP nghe được MỘT TIN nào đó từ Viettel Post.
 *  4. `erpLastTouch`      — lần cuối có NGƯỜI thao tác trên ca này trong ERP.
 *
 * ─── VÌ SAO (2) VÀ (3) PHẢI LÀ HAI BỘ LỌC, KHÔNG GỘP ───
 *
 * Đây là luật 54 của `AGENTS.md`, và kho mã này đã đo được cái giá của việc thiếu (2): 106 kiện
 * chưa bao giờ rời kho, 61.451.999 ₫ COD, mà **0/106 kiện im lặng quá ngưỡng** — vì Viettel Post
 * vẫn đều đặn gửi "phân công bưu tá", nên đồng hồ (3) cứ bị đặt lại trong khi kiện đứng yên.
 *
 * Một kiện có thể VỪA có tin sáng nay VỪA đứng nguyên một chỗ mười một ngày. Gộp hai mốc thành một
 * ô "cập nhật gần nhất" là làm mất đúng nhóm kiện đắt tiền nhất.
 *
 * ─── (4) KHÔNG ĐẾM GIAO VIỆC, CỐ Ý ───
 *
 * Cùng luật với `lib/queries/care-case-audit.ts` (mục 57): `ASSIGN` bị loại. Một trưởng nhóm bấm
 * giao 50 ca trong ba phút sẽ làm 50 ca trông như vừa được xử lý, và bộ lọc "chưa ai đụng tới từ
 * ba ngày nay" — đúng thứ bộ lọc này sinh ra để trả lời — sẽ trả về rỗng.
 *
 * Sự kiện của MÁY (`source = 'SYSTEM'`) cũng không tính: câu hỏi là "có NGƯỜI thao tác không".
 *
 * ─── `NULL` LÀ CHƯA BIẾT, VÀ NÓ KHÔNG ĐƯỢC BIẾN MẤT ───
 *
 * Mốc nào cũng có thể chưa có, và mỗi mốc thiếu vì một lý do khác nhau (xem `unknownLabel`). Lọc
 * theo một KHOẢNG NGÀY thì kiện chưa có mốc nằm NGOÀI khoảng đó — đúng, nhưng màn hình phải in ra
 * bao nhiêu kiện rơi khỏi bộ lọc vì lý do ấy (cùng luật với `carrier_handoff_at`, mục 41). Nên có
 * thêm một giá trị lọc riêng, `CARE_DATE_UNKNOWN`, để bấm thẳng vào nhóm chưa có mốc.
 *
 * ─── ĐỘ PHỦ THẬT CỦA TỪNG MỐC, ĐO TRÊN PRODUCTION 23/09/2026 ───
 *
 * Một bộ lọc chỉ đáng bày ra nếu nó thật sự có gì để lọc. Đo bằng ops `db-query` CHỈ ĐỌC trên
 * **445 vận đơn chưa kết thúc** (`shipments.is_final = false`):
 *
 *   mốc                     có mốc   thiếu   ghi chú
 *   orderCreated             437      8      vận đơn nhập từ tài khoản ĐVVC / chiều hoàn
 *   carrierStageSince        378     67      chưa chứng từ nào mang chặng hiện tại (85%)
 *   carrierLastEvent         444      1      gần như mọi kiện đều có ít nhất một tin
 *   erpLastTouch              49    396      **chỉ 11% số kiện từng có người thao tác**
 *
 * Hai điều con số này nói ra, và chúng dẫn tới hai việc khác nhau:
 *
 *  1. `carrierStageSince` phủ 85% ⇒ dùng được. 67 kiện còn lại KHÔNG được lùi về một mốc khác để
 *     lấp chỗ; màn hình đếm riêng và cho bấm vào xem (`CARE_DATE_UNKNOWN`).
 *  2. `erpLastTouch` thiếu ở 396/445 kiện ⇒ **rổ "chưa ai động vào" chính là rổ chủ đạo**, không
 *     phải một góc nhỏ. Con số ấy khớp với phép đo độc lập ở `lib/queries/care-case-audit.ts`
 *     (221/321 ca chưa ai động vào, 16/09/2026). Nên nếu một bản sau làm con số này ĐẸP LÊN đột
 *     ngột mà không có thêm hành động chăm sóc nào được ghi, thì thứ đã đổi là phép đếm — hãy
 *     kiểm `ASSIGN` và `source = 'SYSTEM'` có bị lọt vào không (mục 57).
 *
 * Mix dữ liệu đổi thì ĐO LẠI rồi sửa ở đây — đừng đoán, và đừng để một bộ lọc chết nằm lại trên
 * màn hình.
 *
 * Toàn bộ tệp này THUẦN: không đọc CSDL, không đọc `Date.now()`. Máy chủ và trình duyệt chạy cùng
 * một hàm ra cùng một kết quả.
 */

export const CARE_DATE_KEYS = ["orderCreated", "carrierStageSince", "carrierLastEvent", "erpLastTouch"] as const;
export type CareDateKey = (typeof CARE_DATE_KEYS)[number];

export type CareDateSpec = {
  /** Tham số trên URL. Tiếng Việt không dấu, ngắn — bộ lọc sống trên đường dẫn để gửi được cho đồng nghiệp. */
  param: string;
  label: string;
  /** Nhãn ngắn cho chip đang bật. */
  short: string;
  /** CÂU HỎI mốc này trả lời — in ra ⓘ, để không ai phải đoán hai mốc VTP khác nhau chỗ nào. */
  question: string;
  /** NGUỒN SỰ THẬT tới mức cột / biểu thức. Không có câu này thì con số không tra ngược được. */
  source: string;
  /** `null` ở mốc này nghĩa là gì. KHÔNG BAO GIỜ là "hôm nay" và không bao giờ là 0. */
  unknownLabel: string;
  unknownHint: string;
};

export const CARE_DATES = {
  orderCreated: {
    param: "ngaydon",
    label: "Ngày tạo đơn",
    short: "tạo đơn",
    question: "Đơn hàng lên Pancake lúc nào — mốc của ĐƠN, không phải của vận đơn.",
    source: "orders.inserted_at (Pancake trả UTC, mapper đã đổi; hiển thị theo giờ VN)",
    unknownLabel: "Vận đơn chưa ghép được với đơn",
    unknownHint:
      "Vận đơn nhập từ tài khoản Viettel Post và vận đơn chiều hoàn không có order_id — CHƯA BIẾT đơn nào, khác hẳn “đơn tạo hôm nay”.",
  },
  carrierStageSince: {
    param: "ngaytt",
    label: "Ngày đổi trạng thái (VTP)",
    short: "đổi trạng thái",
    question:
      "Kiện ĐỔI sang trạng thái đang hiển thị từ lúc nào. Mười tin “phân công bưu tá” liên tiếp KHÔNG làm mốc này nhảy — nó trả lời “kiện đứng yên ở đây từ bao giờ”.",
    source: "lib/constants/shipment-status-age.ts::STAGE_SINCE_SQL — sự kiện sớm nhất trong loạt liền kề cuối cùng mang đúng shipments.stage",
    unknownLabel: "Chưa có chứng từ nào mang chặng hiện tại",
    unknownHint:
      "Không lùi về ngày tạo vận đơn hay ngày tạo đơn để lấp chỗ — đó là mốc của ERP, không phải mốc kiện hàng vào chặng.",
  },
  carrierLastEvent: {
    param: "ngaytin",
    label: "Ngày VTP báo tin cuối",
    short: "tin VTP cuối",
    question:
      "Lần cuối ERP nghe được MỘT TIN nào đó từ Viettel Post, kể cả tin không đổi trạng thái. Đây là đồng hồ ĐỘ TƯƠI — nó trả lời “ERP có còn biết kiện ở đâu không”.",
    source: "max(shipment_events.occurred_at) — mốc của ĐVVC, không phải mốc ERP ghi dòng",
    unknownLabel: "Chưa có tin nào",
    unknownHint: "Vận đơn chưa có một sự kiện hành trình nào. Khác hẳn “vừa có tin 0 giờ trước”.",
  },
  erpLastTouch: {
    param: "ngaytd",
    label: "Ngày tác động cuối (ERP)",
    short: "tác động ERP",
    question:
      "Lần cuối có NGƯỜI thao tác trên ca này trong ERP: ghi hành động chăm sóc, đổi trạng thái, ghi note, gửi lệnh sang ĐVVC. Giao việc (ASSIGN) và thao tác của MÁY không tính.",
    source:
      "muộn nhất của care_actions.created_at và care_case_events.created_at (source <> 'SYSTEM' và action <> 'ASSIGN'), chỉ tính trong ĐỢT care đang hiển thị",
    unknownLabel: "Chưa ai động vào",
    unknownHint:
      "Đợt care này chưa có một thao tác nào của người. Thao tác của đợt TRƯỚC không được tính sang — một đợt mới là một việc mới (mục 59).",
  },
} as const satisfies Record<CareDateKey, CareDateSpec>;

/** Bốn mốc của MỘT kiện. `null` = CHƯA BIẾT, luôn luôn — không nơi nào được thay bằng 0 hay “hôm nay”. */
export type CareDates = Record<CareDateKey, Date | null>;

/** Giá trị lọc đặc biệt: CHỈ những kiện chưa có mốc này. */
export const CARE_DATE_UNKNOWN = "none";

/** Vì sao một chuỗi lọc không dùng được. Màn hình phải IN RA, không được im lặng bỏ qua. */
export const CARE_DATE_PROBLEMS = ["REVERSED", "MALFORMED"] as const;
export type CareDateProblem = (typeof CARE_DATE_PROBLEMS)[number];

export const CARE_DATE_PROBLEM_LABEL: Record<CareDateProblem, string> = {
  REVERSED: "Ngày “từ” đứng sau ngày “đến” — chưa lọc mốc này",
  MALFORMED: "Khoảng ngày không đọc được — chưa lọc mốc này",
};

export type CareDateFilter =
  | { kind: "UNKNOWN_ONLY" }
  | { kind: "RANGE"; fromKey: string; toKey: string; from: Date | null; to: Date | null }
  | { kind: "INVALID"; raw: string; problem: CareDateProblem };

const NGAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Giải mã giá trị thô trên URL. `null` = KHÔNG lọc chiều này.
 *
 * Dạng: `YYYY-MM-DD..YYYY-MM-DD`, hở một đầu cũng được (`..2026-09-20` / `2026-09-01..`), hoặc
 * `none` cho nhóm chưa có mốc.
 *
 * **Bộ sai thứ tự bị bỏ NGUYÊN CẢ CHIỀU và nói ra** (cùng luật với ngưỡng độ tươi, mục 54): đảo hộ
 * hai ô là đoán ý người nhập, còn im lặng bỏ qua là để họ tin vào một danh sách đã bị lọc bằng thứ
 * khác với thứ họ gõ.
 */
export function parseCareDateFilter(raw: string | null | undefined): CareDateFilter | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  if (v === CARE_DATE_UNKNOWN) return { kind: "UNKNOWN_ONLY" };
  if (!v.includes("..")) return { kind: "INVALID", raw: v, problem: "MALFORMED" };
  const [a = "", b = ""] = v.split("..", 2).map((x) => x.trim());
  const fromKey = a && NGAY.test(a) ? a : "";
  const toKey = b && NGAY.test(b) ? b : "";
  // Có chữ nhưng không phải ngày ⇒ HỎNG, không phải "không lọc": người dùng đã gõ một điều gì đó.
  if ((a && !fromKey) || (b && !toKey)) return { kind: "INVALID", raw: v, problem: "MALFORMED" };
  if (!fromKey && !toKey) return null;
  // So bằng chuỗi được vì `YYYY-MM-DD` xếp theo từ điển trùng với xếp theo thời gian.
  if (fromKey && toKey && fromKey > toKey) return { kind: "INVALID", raw: v, problem: "REVERSED" };
  return { kind: "RANGE", fromKey, toKey, from: fromKey ? vnStartOfDay(fromKey) : null, to: toKey ? vnEndOfDay(toKey) : null };
}

/** Dựng lại chuỗi URL từ hai ô ngày. Rỗng cả hai ⇒ chuỗi rỗng ⇒ không lọc. */
export function careDateValue(fromKey: string, toKey: string): string {
  return fromKey || toKey ? `${fromKey}..${toKey}` : "";
}

/**
 * Một mốc có lọt qua bộ lọc không.
 *
 * Hai quyết định khai thẳng:
 *  · Lọc theo KHOẢNG ⇒ kiện chưa có mốc KHÔNG lọt. Chưa biết không thể nằm trong một khoảng ngày,
 *    và cho nó lọt là khẳng định một điều chưa ai đọc được.
 *  · Bộ lọc HỎNG ⇒ KHÔNG lọc gì (trả `true`). Cắt bớt dữ liệu bằng một chuỗi không đọc được là
 *    cách chắc chắn nhất để giấu việc; màn hình in cảnh báo thay vì bảng im lặng ngắn đi.
 */
export function matchesCareDate(at: Date | null | undefined, f: CareDateFilter | null): boolean {
  if (!f) return true;
  if (f.kind === "INVALID") return true;
  if (f.kind === "UNKNOWN_ONLY") return !at;
  if (!at) return false;
  const t = at.getTime();
  if (!Number.isFinite(t)) return false;
  if (f.from && t < f.from.getTime()) return false;
  if (f.to && t > f.to.getTime()) return false;
  return true;
}
