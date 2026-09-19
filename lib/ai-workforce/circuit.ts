/**
 * CẦU DAO NHÀ CUNG CẤP — NHỚ GIỮA CÁC LƯỢT, VÀ TẮT MẶC ĐỊNH.
 *
 * ═══ NÓ GIẢI QUYẾT ĐÚNG MỘT VIỆC ═══
 *
 * `runModelStep()` xử lý một lượt hỏng rất đúng: leo nấc, rồi chuyển người. Nhưng nó KHÔNG NHỚ GÌ
 * giữa các lượt, nên ngày 17–19/09/2026 nó làm đúng như vậy 470 lần liên tiếp với một nhà cung cấp
 * đã hết hạn mức — mỗi lần một lượt gọi mạng chắc chắn hỏng, mỗi lần một khoảng chờ tính vào thời
 * gian trả lời khách. Tệp này là phần trí nhớ ấy, và chỉ là phần trí nhớ ấy.
 *
 * ═══ BA ĐIỀU NÓ KHÔNG ĐƯỢC LÀM ═══
 *
 * 1. **Không thay một lưới nghiệp vụ nào.** Cầu dao trả lời đúng một câu: *lượt tới có nên gọi
 *    nhà cung cấp này không*. Nó không đụng máy trạng thái, điều kiện lên đơn, chính sách rủi ro
 *    hay luật chuyển người. Đổi nhà cung cấp mà đổi luôn mức kiểm tra là biến một sự cố hạ tầng
 *    thành một lỗ hổng nghiệp vụ.
 *
 * 2. **Không rẽ nhánh theo tên nhà cung cấp.** Toàn bộ chính sách nằm ở `ERROR_POLICY`, khai theo
 *    NHÓM LỖI. Tệp này không có một chữ "openai", "anthropic" hay "google" nào.
 *
 * 3. **Không tự bật.** `AI_CIRCUIT_BREAKER_ENABLED` mặc định TẮT. Đang có một phiên soát chạy
 *    trên bản chạy thử; một cơ chế mới bắt đầu BỎ QUA các lượt gọi là thứ phải do người bật, sau
 *    khi đọc số, chứ không phải thứ tự có hiệu lực vì một lượt phát hành.
 *
 * ═══ TRÍ NHỚ Ở ĐÂU ═══
 *
 * Trong BỘ NHỚ TIẾN TRÌNH, không phải CSDL. Cố ý: cầu dao là một phán đoán ngắn hạn về sức khoẻ
 * ngay lúc này, và ghi nó vào CSDL sẽ dựng ra một trạng thái sống lâu hơn sự thật mà nó mô tả —
 * khởi động lại container thì nên dò lại từ đầu, chứ không nên kế thừa một cánh cửa đóng từ hôm
 * qua. Con số để ĐỌC LẠI về sau thì đã có sẵn ở `ai_model_calls`, nơi mọi lượt gọi đều được ghi.
 */
import { aiEnv } from "@/lib/ai-workforce/config";
import {
  ERROR_POLICY,
  circuitOpen,
  probeAfterFor,
  type CircuitState,
  type ProviderErrorKind,
  type ProviderHealth,
} from "@/lib/constants/provider-health";

/** Số đo của một nhà cung cấp — đúng những ô đặc tả đòi, không thêm ô nào không đo được. */
export type CircuitMetrics = {
  provider: string;
  health: ProviderHealth;
  /** Số lần cầu dao chuyển từ đóng sang mở. */
  opens: number;
  /** Số lượt gọi đã KHÔNG thực hiện vì cầu dao mở — đây là cái giá mà cầu dao tiết kiệm được. */
  skipped: number;
  /** Số lần đã thử dò lại sau khi hết thời gian chờ. */
  probes: number;
  /** Lần gần nhất nhà cung cấp này gọi được sau một quãng hỏng. `null` = chưa hồi phục lần nào. */
  recoveredAt: Date | null;
  openedAt: Date | null;
  probeAfter: Date | null;
  openedBy: ProviderErrorKind | null;
  /** Tổng số mili-giây đã ở trạng thái khác `HEALTHY`. */
  degradedMs: number;
};

type Entry = CircuitState & { opens: number; probes: number; recoveredAt: Date | null; degradedMs: number; degradedSince: Date | null };

const so = new Map<string, Entry>();

function moi(provider: string): Entry {
  return { provider, health: "HEALTHY", openedBy: null, openedAt: null, probeAfter: null, skipped: 0, opens: 0, probes: 0, recoveredAt: null, degradedMs: 0, degradedSince: null };
}

function lay(provider: string): Entry {
  const co = so.get(provider);
  if (co) return co;
  const m = moi(provider);
  so.set(provider, m);
  return m;
}

/** Cầu dao có đang được bật không. TẮT mặc định — xem chú thích đầu tệp. */
export function circuitEnabled(): boolean {
  return aiEnv.circuitBreakerEnabled;
}

/**
 * Lượt tới có nên BỎ QUA nhà cung cấp này không.
 *
 * Khi cầu dao TẮT, hàm này luôn trả `false` — nhưng phần ghi nhận bên dưới vẫn chạy, nên số đo
 * vẫn tích luỹ. Nhờ vậy có thể đọc "nếu bật thì nó đã bỏ qua bao nhiêu lượt" TRƯỚC khi bật, thay
 * vì phải bật lên mới biết.
 */
export function shouldSkip(provider: string, now = new Date()): boolean {
  const e = so.get(provider);
  if (!e) return false;
  const dangMo = circuitOpen(e, now);
  if (!dangMo) return false;
  e.skipped += 1;
  return circuitEnabled();
}

/** Đã tới lúc thử dò lại chưa (cầu dao từng mở, và đã hết thời gian chờ). */
export function isProbe(provider: string, now = new Date()): boolean {
  const e = so.get(provider);
  if (!e || e.openedBy === null) return false;
  return e.probeAfter !== null && now >= e.probeAfter;
}

/** Ghi nhận một lượt gọi THÀNH CÔNG — đóng cầu dao lại. */
export function recordSuccess(provider: string, now = new Date()): void {
  const e = lay(provider);
  const dangHong = e.openedBy !== null || e.health !== "HEALTHY";
  if (e.probeAfter !== null && now >= e.probeAfter) e.probes += 1;
  if (dangHong) {
    e.recoveredAt = now;
    if (e.degradedSince) e.degradedMs += now.getTime() - e.degradedSince.getTime();
    e.degradedSince = null;
  }
  e.health = "HEALTHY";
  e.openedBy = null;
  e.openedAt = null;
  e.probeAfter = null;
}

/**
 * Ghi nhận một lượt gọi HỎNG.
 *
 * Chính sách lấy nguyên từ `ERROR_POLICY` theo NHÓM LỖI. Tệp này không quyết định gì — nó chỉ nhớ.
 */
export function recordFailure(provider: string, kind: ProviderErrorKind, now = new Date()): void {
  const e = lay(provider);
  const policy = ERROR_POLICY[kind];
  if (e.health === "HEALTHY") e.degradedSince = now;
  e.health = policy.health;
  if (!policy.openCircuit) return;
  // Chỉ đếm là một lần MỞ khi nó đang đóng: một nhà cung cấp hỏng liên tục không được đếm thành
  // bốn trăm lần mở, nếu không con số "số lần mở" chỉ nói lại số lần hỏng.
  if (e.openedBy === null) {
    e.opens += 1;
    e.openedAt = now;
  }
  e.openedBy = kind;
  e.probeAfter = probeAfterFor(kind, now);
}

/** Số lần thử lại NGAY trong cùng một lượt, theo nhóm lỗi. */
export function retriesFor(kind: ProviderErrorKind): number {
  return ERROR_POLICY[kind].retries;
}

export function metricsFor(provider: string, now = new Date()): CircuitMetrics {
  const e = so.get(provider) ?? moi(provider);
  return {
    provider,
    health: e.health,
    opens: e.opens,
    skipped: e.skipped,
    probes: e.probes,
    recoveredAt: e.recoveredAt,
    openedAt: e.openedAt,
    probeAfter: e.probeAfter,
    openedBy: e.openedBy,
    // Cộng cả quãng ĐANG hỏng vào, nếu không con số chỉ nhúc nhích lúc hồi phục và đứng im trong
    // suốt sự cố — tức là vô dụng đúng lúc cần nhất.
    degradedMs: e.degradedMs + (e.degradedSince ? now.getTime() - e.degradedSince.getTime() : 0),
  };
}

export function allMetrics(now = new Date()): CircuitMetrics[] {
  return [...so.keys()].map((p) => metricsFor(p, now));
}

/** Chỉ dùng trong kiểm thử. */
export function resetCircuits(): void {
  so.clear();
}
