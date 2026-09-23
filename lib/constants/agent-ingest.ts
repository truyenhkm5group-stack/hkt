/**
 * ═══════════ NHẬN SỔ LƯỢT CHẠY AGENT TỪ MÁY NGOÀI — HÀM THUẦN ═══════════
 *
 * ─── VÌ SAO CẦN ───
 *
 * Runner agent chạy trên máy GitHub Actions, và máy đó **không nối được** PostgreSQL production
 * (CSDL nằm sau mạng docker của VPS, không mở ra ngoài) — đó là ĐÚNG, và phương án B của chủ shop
 * giữ nguyên tính chất ấy: *mã chưa qua review không chạy cạnh CSDL production*. Hệ quả đo được:
 * `/tech/agents` hiện **12/12 vai "0 lượt chạy"** dù `agent-run.yml` đã chạy thành công nhiều lượt.
 *
 * Sổ và runner ở hai máy không nhìn thấy nhau. Cửa hẹp này là chỗ duy nhất chúng gặp nhau.
 *
 * ─── MỘT THAO TÁC, KHÔNG PHẢI BA ───
 *
 * Phác thảo ban đầu dự tính ba thao tác `start` · `heartbeat` · `finish` để `/tech` thấy agent
 * "đang chạy". Bản này cố ý **chỉ có `ingest`**: chép lại một lượt chạy **ĐÃ KẾT THÚC**. Ba lý do,
 * và lý do đầu là lý do thật:
 *
 *  1. **ERP không quan sát được lượt chạy đang diễn ra ở máy khác.** Một dòng `RUNNING` trên
 *     production sẽ là lời khai mà không ai kiểm được — và nếu máy Actions chết giữa chừng thì nó
 *     nằm lại vĩnh viễn, đúng loại mồ côi mà `agent-reaper` phải đi dọn. Mở một cửa để tự tạo ra
 *     việc cho cái chổi là ngược.
 *  2. **Ba thao tác là ba đường ghi trên một endpoint hướng ra Internet.** Một cửa chỉ nhận bản
 *     ghi đã đóng thì không có máy trạng thái nào để lạm dụng.
 *  3. Trạng thái `RUNNING` bị **từ chối thẳng** (xem `INGESTABLE_STATUSES`), nên lớp lỗi ấy không
 *     tồn tại thay vì được xử lý.
 *
 * "Thấy agent đang chạy" nếu thật sự cần thì đọc thẳng GitHub Actions — bên đang giữ sự thật.
 */

/** Trạng thái được phép chép về. `RUNNING` **không** nằm ở đây — xem khối trên. */
export const INGESTABLE_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"] as const;
export type IngestableStatus = (typeof INGESTABLE_STATUSES)[number];

export const AGENT_INGEST = {
  /**
   * Trần lượt gọi trong một cửa sổ, tính theo TOÀN CỬA chứ không theo IP: người gọi hợp lệ chỉ có
   * một (workflow `agent-run.yml`, có `concurrency` nên không chạy song song), và nó gọi ĐÚNG MỘT
   * lần cho mỗi lượt chạy agent. 60 lượt trong 15 phút là rộng gấp nhiều lần nhu cầu thật, nhưng
   * đủ chặn một vòng lặp chạy loạn.
   */
  maxPerWindow: 60,
  windowMs: 15 * 60_000,
  /**
   * Gói tin khai mốc báo cáo cũ hơn thế này bị từ chối.
   *
   * Nó KHÔNG phải hàng rào chính — khoá duy nhất `external_ref` mới là thứ chặn phát lại, vì một
   * gói tin chép lại sẽ mang đúng `external_ref` cũ và bị CSDL từ chối. Lớp này chỉ thu hẹp cửa sổ
   * cho gói tin **bị sửa** (đổi `external_ref` rồi gửi lại) — thứ vốn đã đòi phải có `CRON_SECRET`.
   *
   * 120 phút: lượt chạy agent có trần 60 phút, báo cáo gửi ngay sau đó, phần còn lại là dung sai
   * lệch đồng hồ giữa máy Actions và VPS.
   */
  maxAgeMinutes: 120,
  /** Thân gói tin lớn hơn thế này bị từ chối trước khi phân tích — không đọc thứ mình không định dùng. */
  maxBodyBytes: 64 * 1024,
  /** Số tệp đổi tối đa ghi lại. Một lượt chạy đổi nghìn tệp là chuyện phải xem, không phải chuyện phải lưu. */
  maxFilesChanged: 200,
} as const;

/**
 * KHOÁ TỰ NHIÊN CỦA MỘT LƯỢT CHẠY NGOÀI.
 *
 * `provider:runId:attempt` — `attempt` nằm TRONG khoá vì chạy lại một workflow là một sự việc mới
 * đáng xem; gộp hai lần chạy thành một dòng là giấu mất đúng cái lần người ta quan tâm (cùng luật
 * với `tech_deployments`).
 *
 * Đây là thứ chặn phát lại, và nó chặn ở CSDL bằng một khoá duy nhất — không phải bằng một mệnh đề
 * `where not exists` trong mã, thứ luôn có cửa sổ đua giữa lúc đọc và lúc ghi.
 */
export function agentRunExternalRef(provider: string, runId: string | number, attempt: string | number): string {
  const p = String(provider).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  const r = String(runId).trim().replace(/[^0-9A-Za-z_-]+/g, "");
  /*
    `attempt` CHUẨN HOÁ VỀ SỐ, KHÔNG GIỮ SỐ 0 ĐỨNG ĐẦU.

    `"07"` và `"7"` là CÙNG MỘT lần chạy lại. Giữ nguyên câu chữ thì hai nơi gọi (hay một nơi gọi
    sau khi đổi cách đọc biến môi trường) dựng ra hai khoá khác nhau cho cùng một sự việc — và
    khoá duy nhất ở CSDL không cứu được, vì với nó đó là hai giá trị khác nhau. Bài kiểm thử tìm
    ra chỗ này trước khi nó thành một dòng sổ trùng.
  */
  const soLan = Number.parseInt(String(attempt).trim().replace(/[^0-9]+/g, ""), 10);
  const a = Number.isFinite(soLan) && soLan > 0 ? String(soLan) : "1";
  if (!p || !r) return "";
  return `${p}:${r}:${a}`;
}

/** Hình dạng khoá hợp lệ — dùng cho cả lược đồ đầu vào lẫn bài kiểm. */
export const EXTERNAL_REF_PATTERN = /^[a-z0-9_-]+:[0-9A-Za-z_-]+:[0-9]+$/;

/* ═════════════════ TRẦN LƯỢT GỌI — TRONG BỘ NHỚ, VÀ NÓI RÕ GIỚI HẠN ═════════════════ */

/**
 * Cùng hình dạng với `lib/auth/login-throttle.ts`: một `Map` trong tiến trình.
 *
 * GIỚI HẠN PHẢI BIẾT: nó mất sạch khi container khởi động lại, và không chia sẻ giữa nhiều tiến
 * trình. Với cửa này thì chấp nhận được — hàng rào thật là `CRON_SECRET` cộng khoá duy nhất; trần
 * lượt gọi chỉ để một vòng lặp chạy loạn không viết đầy sổ. Gọi nó là "chống tấn công" thì sai.
 */
const cua = new Map<string, number[]>();

export type IngestGate = { ok: true } | { ok: false; retryAfterSec: number };

export function ingestAllowed(key: string, now = Date.now()): IngestGate {
  const moc = (cua.get(key) ?? []).filter((t) => now - t < AGENT_INGEST.windowMs);
  cua.set(key, moc);
  if (moc.length < AGENT_INGEST.maxPerWindow) return { ok: true };
  const somNhat = Math.min(...moc);
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((AGENT_INGEST.windowMs - (now - somNhat)) / 1000)) };
}

export function recordIngest(key: string, now = Date.now()): void {
  const moc = (cua.get(key) ?? []).filter((t) => now - t < AGENT_INGEST.windowMs);
  moc.push(now);
  cua.set(key, moc);
}

/** CHỈ DÙNG CHO KIỂM THỬ. */
export function resetIngestThrottle(): void {
  cua.clear();
}

/**
 * Gói tin còn tươi không — HÀM THUẦN.
 *
 * Mốc ở TƯƠNG LAI được kẹp về 0 chứ không bị loại: lệch đồng hồ vài giây giữa hai máy là chuyện
 * bình thường, và loại một gói tin hợp lệ vì đồng hồ máy gửi nhanh hơn vài giây là tự gây sự cố
 * (cùng bài học AGENTS.md mục 64).
 */
export function reportIsFresh(reportedAt: Date, now = new Date()): boolean {
  const lech = now.getTime() - reportedAt.getTime();
  if (!Number.isFinite(lech)) return false;
  return Math.max(0, lech) <= AGENT_INGEST.maxAgeMinutes * 60_000;
}
