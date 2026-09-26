import type { ModelState } from "@/lib/constants/model-lifecycle";

/**
 * ═══════════ MẪU CHƯA CÓ MÃ — MÃ TẠM DO MÁY CẤP ═══════════
 *
 * Chủ shop 26/09/2026: "tạo topic sản xuất cho những mẫu mới test (chưa lên mã, chưa có tên mã), nếu
 * win thì mới chốt lên mã". Sổ mẫu (`product_models.code`) bắt buộc có mã — một dòng không ai gọi được
 * tên — nên mẫu chưa có mã nhận một MÃ TẠM dạng `TEST-260926-01` (ngày giờ Việt Nam + số thứ tự trong
 * ngày). Khi mẫu thắng, người chốt MÃ CHÍNH THỨC (`Q012`…) — đổi đúng dòng ấy, nên topic / giá thành /
 * mẫu thử / lịch sử vòng đời đã gắn vào mẫu đi theo nguyên vẹn; lần đồng bộ sổ sau tự nối sản phẩm
 * Pancake mang mã mới vào đúng dòng này (`planModelRegistry` khớp theo mã).
 *
 * Tệp THUẦN — client import được.
 *
 * Mã tạm là một TIỀN TỐ DÀNH RIÊNG: đăng ký tay một mã bắt đầu bằng `TEST-` bị từ chối, nếu không
 * người gõ tay sẽ đẻ ra một dòng trông như mã tạm mà không qua đường cấp số.
 */
export const PROVISIONAL_CODE_PREFIX = "TEST-";

/** `TEST-YYMMDD-NN` (NN ≥ 2 chữ số — ngày thứ 100 vẫn đọc được `TEST-260926-100`). */
export const PROVISIONAL_CODE_PATTERN = /^TEST-\d{6}-\d{2,}$/;
/**
 * CÙNG khuôn ấy viết cho Postgres (`~`) — bộ lọc danh sách mẫu dùng nó. Hai bản phải nói cùng một điều:
 * `tests/production-topic-files.test.ts` chạy cả hai trên cùng bộ mã rồi so từng mã.
 */
export const PROVISIONAL_CODE_PG_REGEX = "^TEST-[0-9]{6}-[0-9]{2,}$";

/** Mã có mang tiền tố dành riêng không (dùng để chặn đăng ký tay và chốt mã chính thức). */
export function hasProvisionalPrefix(code: string): boolean {
  return code.toUpperCase().startsWith(PROVISIONAL_CODE_PREFIX);
}

/**
 * Mẫu đang mang mã tạm = mã đúng khuôn VÀ do người đăng ký VÀ chưa nối sản phẩm / thiết kế nào. Đủ ba vế
 * mới tính: một sản phẩm Pancake tình cờ mang mã `TEST-…` đi vào sổ bằng đường ĐỒNG BỘ (`SYNC`) — đó là
 * mã thật của nó, không phải mã tạm để đổi.
 */
export function isProvisionalModel(m: { code: string; registeredBy: string; productId: string | null; designConceptId: string | null }): boolean {
  return m.registeredBy === "USER" && PROVISIONAL_CODE_PATTERN.test(m.code) && m.productId === null && m.designConceptId === null;
}

/** `yymmdd` theo giờ Việt Nam (UTC+7, không đổi giờ mùa). */
export function vnDayStamp(at: Date): string {
  const vn = new Date(at.getTime() + 7 * 3_600_000);
  const yy = String(vn.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(vn.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/** Tiền tố của mọi mã tạm cấp trong ngày `at` (giờ VN) — `TEST-260926-`. */
export function provisionalDayPrefix(at: Date): string {
  return `${PROVISIONAL_CODE_PREFIX}${vnDayStamp(at)}-`;
}

/**
 * Số thứ tự kế tiếp trong ngày, từ các mã tạm ĐÃ CÓ cùng ngày. Lấy LỚN NHẤT + 1 chứ không phải đếm + 1:
 * một mã giữa chừng đã được chốt sang mã chính thức thì đếm sẽ cấp lại đúng số của mã còn lại.
 */
export function nextProvisionalCode(at: Date, existingCodes: readonly string[]): string {
  const prefix = provisionalDayPrefix(at);
  let max = 0;
  for (const c of existingCodes) {
    if (!c.startsWith(prefix)) continue;
    const n = Number(c.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

/**
 * Trạng thái người khai được lúc đăng ký mẫu chưa có mã từ biểu mẫu mở topic. Chỉ các chặng TRƯỚC thắng:
 * mẫu đã thắng thì đã đến lúc lên mã, không có lý do gì để mang mã tạm. Mặc định `ADS_TESTING` vì đó là
 * đúng tình huống chủ shop tả ("mẫu mới test").
 */
export const PROVISIONAL_START_STATES = ["ADS_TESTING", "CREATIVE", "IDEA"] as const satisfies readonly ModelState[];
export type ProvisionalStartState = (typeof PROVISIONAL_START_STATES)[number];
export const PROVISIONAL_DEFAULT_STATE: ProvisionalStartState = "ADS_TESTING";

/** Tên gọi tạm tối thiểu — không có mã thì TÊN là thứ duy nhất để người khác nhận ra mẫu. */
export const PROVISIONAL_NAME_MIN = 3;
