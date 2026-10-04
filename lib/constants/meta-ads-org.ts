/**
 * ═══════════ QUẢNG CÁO FACEBOOK CỦA TỔ CHỨC KHÁCH — HẰNG SỐ VÀ HÀM THUẦN ═══════════
 *
 * Kết nối «meta-ads-org» (lib/connectors/registry.ts): token System User của Business Manager CỦA tổ chức + danh sách tài
 * khoản quảng cáo họ khai. Tệp THUẦN, không đọc CSDL, không đọc biến môi trường — dùng chung cho hàm kiểm tra kết nối
 * (lib/connectors/testers.ts), client Graph (lib/integrations/facebook/client.ts) và job đồng bộ
 * (lib/marketing/meta-ads-org.ts), để ba nơi đọc ô «adAccountIds» theo ĐÚNG MỘT luật.
 */

export const META_ADS_ORG_CONNECTOR = "meta-ads-org";

/** Trần số tài khoản một kết nối được khai — khớp `pattern` của ô cài đặt trong sổ connector. */
export const META_ADS_ORG_MAX_ACCOUNTS = 20;

/** Token System User của Meta: bắt đầu «EAA», chỉ chữ và số. Sai dạng ⇒ không gọi mạng. */
export const META_SYSTEM_USER_TOKEN_PATTERN = /^EAA[A-Za-z0-9]{30,1000}$/;

/**
 * Số ngày kéo lùi của job `ads-spend-org`: lượt THƯỜNG 3 ngày (như `facebook-ads` của nhà — Facebook còn điều chỉnh số
 * của vài ngày gần nhất); lượt ĐẦU TIÊN của một tổ chức (chưa có dòng chi tiêu tự động nào) kéo 30 ngày, để bảng
 * Hiệu quả quảng cáo không bắt đầu từ một màn hình gần như trống. Chạy tay với `days=N` vẫn ghi đè cả hai.
 */
export const META_ADS_ORG_DEFAULT_DAYS = 3;
export const META_ADS_ORG_FIRST_RUN_DAYS = 30;

/** Mã tài khoản quảng cáo: «act_123…» hoặc «123…» ⇒ phần số. Chuỗi lạ ⇒ `null` (không đoán). */
export function normalizeAdAccountId(raw: string): string | null {
  const m = /^\s*(?:act_)?([0-9]{5,20})\s*$/.exec(raw);
  return m ? m[1] : null;
}

/** Ô «adAccountIds» (phân tách bằng dấu phẩy / chấm phẩy / khoảng trắng) ⇒ mã số, bỏ trùng, giữ thứ tự; phần lạ nằm ở `invalid`. */
export function parseAdAccountIds(raw: string | undefined | null): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(/[\s,;]+/).filter(Boolean)) {
    const id = normalizeAdAccountId(part);
    if (!id) invalid.push(part.slice(0, 40));
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, invalid };
}

/** `account_status` của Graph API ⇒ chữ cho người đọc. Mã lạ ⇒ in nguyên mã, không đoán. */
export function adAccountStatusLabel(status: number): string {
  const labels: Record<number, string> = {
    1: "đang hoạt động",
    2: "bị vô hiệu hoá",
    3: "chưa thanh toán",
    7: "đang xét duyệt rủi ro",
    8: "chờ thanh toán",
    9: "trong thời gian ân hạn",
    100: "chờ đóng",
    101: "đã đóng",
  };
  return labels[status] ?? `trạng thái ${status}`;
}

/**
 * ═══════════ ĐĂNG QUẢNG CÁO BẰNG TOKEN CỦA TỔ CHỨC (chủ nền tảng chốt 04/10/2026 — Hải Sản Làng Chài) ═══════════
 *
 * Đường GHI Graph của tổ chức khách mở khi ĐỦ cả bốn: chốt máy chủ `ADS_WRITE_ENABLED` (chung) · kết nối «meta-ads-org»
 * đang bật · công tắc RIÊNG của tổ chức dưới đây do quản trị của chính tổ chức bật · công tắc khẩn cấp không kéo. Công tắc
 * nằm trong CSDL của tổ chức (`settings`), giá trị phải ĐÚNG `{ enabled: true }` — chuỗi "true", số 1, JSON hỏng hay lỗi
 * đọc đều là TẮT: ở đây "không biết" phải thành ĐÓNG, vì mở nhầm là tiêu tiền thật của khách.
 */
export const META_ADS_ORG_WRITE_KEY = "ads.write.org";

export function parseOrgAdsWrite(raw: unknown): { enabled: boolean } {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { enabled: false };
    }
  }
  return { enabled: !!v && typeof v === "object" && (v as Record<string, unknown>).enabled === true };
}

/**
 * Lời gọi Graph của tổ chức nhắm vào một TÀI KHOẢN QUẢNG CÁO (`act_<id>/…`) thì tài khoản đó phải nằm trong danh sách
 * tổ chức đã khai ở kết nối — token System User có thể được giao nhiều tài khoản hơn thứ shop muốn ERP chạm vào. `null`
 * = được; chuỗi = lý do chặn. Đường dẫn không bắt đầu bằng `act_` (id nhóm / chiến dịch / page) đi qua: Graph tự từ
 * chối id ngoài quyền của token. Hàm THUẦN.
 */
export function orgAccountPathProblem(path: string, adAccountIds: readonly string[]): string | null {
  const m = /^\/?act_([0-9]+)(?:\/|$)/.exec(path);
  if (!m) return null;
  return adAccountIds.includes(m[1]) ? null : `tài khoản quảng cáo act_${m[1]} không nằm trong danh sách tổ chức đã khai ở kết nối «Quảng cáo Facebook (Meta) của tổ chức» — ERP không chạm vào tài khoản ấy.`;
}
