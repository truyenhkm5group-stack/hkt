/**
 * ═══════════ TỶ GIÁ USD → VND THEO VIETCOMBANK ═══════════
 *
 * Chi phí mô hình do nhà cung cấp niêm yết bằng USD; sổ sách của shop là VND. Nhân hai thứ ấy với
 * nhau cần một tỷ giá, và `lib/constants/ai-model-pricing.ts` đã nói rõ từ đầu: tỷ giá là QUYẾT
 * ĐỊNH KINH DOANH, không được đoán. Chủ shop chốt (22/09/2026) lấy theo Vietcombank mỗi đầu ngày.
 *
 * ─── LẤY GIÁ BÁN, KHÔNG LẤY GIÁ MUA ───
 *
 * VCB niêm yết ba cột: mua tiền mặt · mua chuyển khoản · BÁN. Hoá đơn mô hình là một khoản shop
 * PHẢI TRẢ bằng USD, nên tỷ giá đúng là giá shop mua USD từ ngân hàng — tức cột BÁN. Lấy cột mua
 * sẽ báo chi phí thấp hơn thực tế khoảng 1–2%, đều đặn, về một phía.
 *
 * ─── KHÔNG LẤY ĐƯỢC THÌ GIỮ NGUYÊN GIÁ CŨ, KHÔNG VỀ 0 ───
 *
 * VCB đổi bố cục trang, mạng hỏng, hay ngày lễ không công bố — mọi nhánh lỗi đều phải giữ nguyên
 * bảng giá đang chạy. Một tỷ giá 0 làm mọi chi phí thành 0 ₫, và 0 ₫ ở đây là lời khẳng định
 * "không tốn gì", đúng thứ luật 42 cấm. Thà dùng tỷ giá hôm qua còn hơn một con số bịa.
 */

/** Nguồn công bố. XML công khai, không cần khoá. */
export const VCB_RATE_URL = "https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx";

export type VcbRate = {
  /** Số VND cho 1 USD, theo cột BÁN. */
  sellVnd: number;
  /** Ngày VCB ghi trên bản công bố (nguyên văn) — để biết có phải giá hôm nay không. */
  publishedAt: string;
  source: string;
};

/**
 * Đọc một số từ chuỗi VCB ("26,310.00" → 26310). Trả `null` khi không đọc ra số dương —
 * KHÔNG trả 0, vì 0 ở đây sẽ đi thẳng vào một phép nhân.
 */
export function parseVcbNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Bóc tỷ giá USD từ XML của VCB. HÀM THUẦN — tách khỏi phần gọi mạng để kiểm thử được bằng một
 * mẫu XML thật, không cần Internet (luật 65: bài kiểm không đo cái máy đang chạy).
 */
export function parseVcbXml(xml: string): VcbRate | null {
  // Thẻ <Exrate CurrencyCode="USD" Buy="..." Transfer="..." Sell="..." />
  const dong = /<Exrate\b[^>]*CurrencyCode="USD"[^>]*\/?>/i.exec(xml);
  if (!dong) return null;
  const sell = parseVcbNumber(/\bSell="([^"]+)"/i.exec(dong[0])?.[1]);
  if (!sell) return null;
  const ngay = /<DateTime>([^<]+)<\/DateTime>/i.exec(xml)?.[1]?.trim() ?? "";
  return { sellVnd: sell, publishedAt: ngay, source: "Vietcombank" };
}

/** Gọi VCB. Ném lỗi đọc được; người gọi quyết định giữ giá cũ. */
export async function fetchVcbRate(timeoutMs = 15_000): Promise<VcbRate> {
  // Trần thời gian tường minh: một job nền treo vô hạn vì một trang ngân hàng chậm sẽ giữ chỗ
  // trong bộ lập lịch và làm mọi job sau nó trượt giờ.
  const ac = new AbortController();
  const hen = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(VCB_RATE_URL, { headers: { Accept: "application/xml,text/xml,*/*" }, signal: ac.signal });
  } finally {
    clearTimeout(hen);
  }
  if (!res.ok) throw new Error(`Vietcombank trả HTTP ${res.status}`);
  const xml = await res.text();
  const rate = parseVcbXml(xml);
  if (!rate) throw new Error("Không tìm thấy dòng USD trong bản công bố của Vietcombank — có thể họ đã đổi bố cục");
  return rate;
}

/**
 * Phép thử kết nối, đúng hợp đồng mọi tích hợp trong ERP phải có (AGENTS.md mục 5).
 * KHÔNG ghi gì.
 */
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetchVcbRate();
    return { ok: true, detail: `1 USD = ${r.sellVnd.toLocaleString("vi-VN")} ₫ (bán) · công bố ${r.publishedAt || "không rõ ngày"}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
