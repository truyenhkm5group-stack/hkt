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
