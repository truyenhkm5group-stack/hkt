/**
 * ═══════════ CÔNG TẮC TẮT KHẨN CẤP ĐƯỜNG GHI QUẢNG CÁO ═══════════
 *
 * `ADS_WRITE_ENABLED` là chốt ngoài cùng, nhưng nó là BIẾN MÔI TRƯỜNG: muốn đóng phải sửa `.env` trên
 * VPS rồi deploy lại — 15–20 phút. Vòng mẫu chạy với tiền thật, và 15 phút là đủ để một vòng lặp
 * hỏng tạo xong cả lô nhóm quảng cáo. Công tắc này đóng đường ghi TRONG VÀI GIÂY, không cần deploy:
 * một dòng trong bảng `settings`, đọc lại NGAY TRƯỚC MỖI lời gọi ghi Facebook ở đúng một chỗ —
 * `graphPost()` trong `lib/integrations/facebook/ads-write.ts`.
 *
 * ─── NÓ CHỈ LÀM HẸP, KHÔNG BAO GIỜ NỚI ───
 *
 * Công tắc TẮT được đường ghi đang mở; nó KHÔNG mở được đường ghi đang đóng. `ADS_WRITE_ENABLED`
 * vẫn đọc thẳng từ `process.env` và không hợp nhất với `settings` (`tests/ads-write.test.ts` canh
 * điều đó) — ghi `{"killed": false}` vào CSDL khi env đang tắt là ghi vào hư không.
 *
 * ─── MỌI NHÁNH LỖI RƠI VỀ PHÍA HẸP HƠN (AGENTS.md mục 31) ───
 *
 *  · không có dòng                 ⇒ MỞ (chưa ai kéo công tắc — trạng thái bình thường)
 *  · `{"killed": false}`           ⇒ MỞ (người đã nhả công tắc, có dấu vết)
 *  · `{"killed": true}`            ⇒ ĐÓNG
 *  · không đọc được CSDL           ⇒ ĐÓNG — không biết công tắc đang ở đâu thì coi như đang kéo
 *  · JSON hỏng / `killed` lạ       ⇒ ĐÓNG — `"false"` (chuỗi), `0`, thiếu trường đều KHÔNG phải "mở"
 *
 * `getSettingJson()` KHÔNG dùng được ở đây: nó nuốt lỗi CSDL thành "không có dòng", tức biến
 * "không biết" thành "mở". Nơi đọc phải phân biệt hai thứ ấy — xem `readAdsKillSwitch()`.
 *
 * ─── KHI ĐÓNG, TẠM DỪNG VẪN ĐƯỢC ĐI — VÀ VÌ SAO ───
 *
 * Công tắc chặn MỌI lời gọi TẠO hoặc TĂNG chi: tải ảnh, tạo bài, tạo nhóm, tạo mẩu, đổi ngân sách
 * ngày (kể cả hạ — xem dưới), tiêu thêm. Lời gọi DUY NHẤT còn đi qua là TẠM DỪNG: đúng một trường
 * `status` với đúng giá trị `PAUSED`.
 *
 *  1. Người kéo công tắc khẩn cấp muốn TIỀN NGỪNG CHẢY. Nhóm test đã tạo vẫn đang tiêu tới `end_time`;
 *     luật tắt sớm của vòng mẫu là thứ duy nhất trong ERP dừng được chúng. Chặn cả tạm dừng là giữ
 *     tiền chảy đúng lúc người ta muốn nó dừng.
 *  2. Tạm dừng đảo ngược được bằng một cú bấm trong Ads Manager; tiền đã tiêu thì không.
 *  3. Phân loại đọc từ CHÍNH NỘI DUNG sẽ gửi đi, không từ một cờ nơi gọi khai: một lời gọi mang thêm
 *     bất kỳ trường nào khác (`daily_budget`, `lifetime_budget`, `status: "ACTIVE"`…) là bị chặn. Nơi
 *     gọi không nói dối được cổng này.
 *
 * HẠ ngân sách ngày cũng bị chặn dù nó làm giảm chi: cổng này không đọc được ngân sách hiện tại mà
 * không gọi Facebook, nên nó không tự kiểm được chiều — và một lỗi đơn vị (đồng ↔ xu) trông y hệt
 * một lượt "hạ". Muốn dừng tiền trong lúc khẩn cấp thì tạm dừng, đó là hành động có tên riêng.
 *
 * Muốn chặn cả tạm dừng (ví dụ nghi chính luật tắt đang tắt nhầm chiến dịch của marketer) thì đóng
 * chốt ngoài cùng `ADS_WRITE_ENABLED` — chậm hơn, nhưng chặn tuyệt đối.
 */

/** Khoá trong bảng `settings`. KHÔNG đổi: ops `set-setting` và tài liệu vận hành đã dùng nó. */
export const ADS_WRITE_KILL_KEY = "ads.write.kill";

/** Kết quả đọc thô dòng `settings`. `ok: false` = KHÔNG đọc được (lỗi CSDL), khác hẳn "không có dòng". */
export type AdsKillSwitchRead = { ok: true; value: string | null } | { ok: false; error: string };

export type AdsKillSwitchSource = "UNSET" | "RELEASED" | "ENGAGED" | "UNREADABLE" | "MALFORMED";

export type AdsKillSwitchState = {
  killed: boolean;
  source: AdsKillSwitchSource;
  /** Lý do người kéo/nhả ghi lại, hoặc lý do máy coi là đóng (đọc lỗi, dữ liệu hỏng). */
  reason: string | null;
  /** Ai kéo/nhả — ảnh chụp email do MÁY CHỦ ghi, chỉ để người đọc. */
  by: string | null;
  /** ISO — lúc kéo/nhả. */
  at: string | null;
};

export const ADS_KILL_SOURCE_LABEL: Record<AdsKillSwitchSource, string> = {
  UNSET: "Chưa ai kéo công tắc",
  RELEASED: "Đã nhả công tắc",
  ENGAGED: "ĐANG KÉO công tắc khẩn cấp",
  UNREADABLE: "Không đọc được công tắc — coi như ĐANG KÉO",
  MALFORMED: "Dữ liệu công tắc hỏng — coi như ĐANG KÉO",
};

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 500) : null;
}

/** Hàm THUẦN: dòng `settings` (hoặc lỗi đọc) ⇒ trạng thái công tắc. Mọi nhánh lạ rơi về ĐÓNG. */
export function parseAdsKillSwitch(read: AdsKillSwitchRead): AdsKillSwitchState {
  if (!read.ok) return { killed: true, source: "UNREADABLE", reason: `Không đọc được bảng settings: ${read.error}`.slice(0, 500), by: null, at: null };
  if (read.value === null) return { killed: false, source: "UNSET", reason: null, by: null, at: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch {
    return { killed: true, source: "MALFORMED", reason: "Giá trị không phải JSON.", by: null, at: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { killed: true, source: "MALFORMED", reason: "Giá trị không phải một đối tượng JSON.", by: null, at: null };
  const rec = parsed as Record<string, unknown>;
  const meta = { reason: text(rec.reason), by: text(rec.by), at: text(rec.at) };
  if (rec.killed === false) return { killed: false, source: "RELEASED", ...meta };
  if (rec.killed === true) return { killed: true, source: "ENGAGED", ...meta, reason: meta.reason ?? "Không ghi lý do." };
  return { killed: true, source: "MALFORMED", ...meta, reason: `Trường "killed" phải là true/false, đang là ${JSON.stringify(rec.killed ?? null)}.` };
}

/**
 * Lời gọi ghi này CHỈ làm giảm chi không — tức đúng một trường `status` = `PAUSED`.
 *
 * Đọc từ chính các trường sẽ gửi lên Graph API. `access_token` không phải trường của phép ghi nên
 * nơi gọi truyền `fields` TRƯỚC khi gắn token.
 */
export function isSpendReducingWrite(fields: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(fields);
  return keys.length === 1 && keys[0] === "status" && fields.status === "PAUSED";
}

export type KillSwitchVerdict = { allow: true } | { allow: false; reason: string };

/** Hàm THUẦN: công tắc + nội dung lời gọi ⇒ cho đi hay chặn. */
export function killSwitchVerdict(state: AdsKillSwitchState, fields: Readonly<Record<string, string>>): KillSwitchVerdict {
  if (!state.killed) return { allow: true };
  if (isSpendReducingWrite(fields)) return { allow: true };
  const who = state.by ? ` · ${state.by}` : "";
  const when = state.at ? ` · ${state.at}` : "";
  return { allow: false, reason: `${ADS_KILL_SOURCE_LABEL[state.source]} (${ADS_WRITE_KILL_KEY})${who}${when}: ${state.reason ?? ""}`.trim() };
}
