/**
 * ═══════════ QUY KẾT ĐƠN LANDING PAGE — ĐI BẰNG KHOÁ CHIẾN DỊCH, KHÔNG ĐOÁN TÊN ═══════════
 *
 * ─── VẤN ĐỀ NÀY GIẢI ───
 *
 * Đơn Messenger mang `page_id` nên `order_attributions` nói được ngay người phụ trách. Đơn LANDING
 * thì không: Pancake không gửi `page_id` cho chúng, nên cả 201 đơn landing (đo production
 * 15/09/2026) nằm trong nhóm `NO_PAGE` — doanh thu có thật, tiền quảng cáo có thật, mà không thuộc
 * về ai.
 *
 * Nhưng form landing CÓ tracking: mỗi dòng sheet mang `utm_source` (hoặc cột tương đương) là TÊN
 * CHIẾN DỊCH Facebook, và ở bố cục mới còn mang thẳng `ad_id` / `adset_id` dạng số. Đo production:
 *   · 371 dòng landing, 320 đã nối được sang đơn Pancake;
 *   · 321 dòng có chuỗi utm KHỚP TUYỆT ĐỐI một `ad_spends.campaign`;
 *   · trong đó 321 ra ĐÚNG MỘT tài khoản quảng cáo và ĐÚNG MỘT marketer;
 *   · 183 dòng có `ad_id` dạng số, nhưng chỉ 8 dòng có mặt trong `fb_ads` (sổ quảng cáo ERP mới
 *     phủ 147 mẩu) — nên `ad_id` là bậc MẠNH NHẤT nhưng chưa phải bậc PHỦ RỘNG NHẤT.
 *
 * ─── KHỚP TUYỆT ĐỐI KHÁC HẲN DÒ CHỮ ───
 *
 * `lib/constants/marketer-attribution.ts` cấm dò chữ trong `ad_spends.campaign` (`campaign ilike
 * '%QA4%'`), và lệnh cấm ấy còn nguyên giá trị: một mẩu chữ có thể trúng nhiều chiến dịch của
 * nhiều người. Ở đây KHÁC: chuỗi utm phải bằng ĐÚNG, từng ký tự, tên chiến dịch mà chính Facebook
 * đặt — đó là một KHOÁ, không phải một phỏng đoán. Và khoá ấy chỉ được dùng khi nó dẫn tới ĐÚNG
 * MỘT marketer; hai người cùng khai một chiến dịch là nhập nhằng, và nhập nhằng thì không quy kết.
 *
 * ─── BỐN THỨ ĐƯỢC QUYẾT, VÀ MỘT THỨ KHÔNG ───
 *
 * Quy kết landing nói được: TÀI KHOẢN QUẢNG CÁO · CHIẾN DỊCH · MARKETER · (đôi khi) FANPAGE.
 * Nó KHÔNG được đụng tới MÃ HÀNG của đơn: mã hàng đọc từ dòng hàng thật của đơn. Landing chạy
 * Q003 mà khách đặt Q004 thì đơn vẫn là Q004 — chênh lệch ấy được ĐÁNH DẤU để rà, không được sửa.
 */

/** Nguồn quy kết của một đơn. `PANCAKE_PAGE` = đường cũ (page_id của Pancake), không đổi. */
export const ATTRIBUTION_SOURCES = ["PANCAKE_PAGE", "LANDING_UTM"] as const;
export type AttributionSource = (typeof ATTRIBUTION_SOURCES)[number];

export const ATTRIBUTION_SOURCE_LABEL: Record<AttributionSource, string> = {
  PANCAKE_PAGE: "Fanpage (Pancake)",
  LANDING_UTM: "Landing / UTM",
};

/**
 * BẬC BẰNG CHỨNG, mạnh trước yếu sau. Mỗi bậc khai rõ nó dựa vào KHOÁ nào — không bậc nào dựa vào
 * sự "gần giống". Bậc yếu hơn chỉ được hỏi tới khi bậc mạnh hơn im lặng.
 */
export const LANDING_EVIDENCE_TIERS = ["AD_ID", "ADSET_ID", "CAMPAIGN_NAME"] as const;
export type LandingEvidenceTier = (typeof LANDING_EVIDENCE_TIERS)[number];

export const LANDING_EVIDENCE_LABEL: Record<LandingEvidenceTier, string> = {
  AD_ID: "ad_id khớp sổ quảng cáo",
  ADSET_ID: "adset_id khớp sổ quảng cáo",
  CAMPAIGN_NAME: "tên chiến dịch khớp tuyệt đối bảng chi tiêu",
};

/** Vì sao một đơn landing vẫn chưa quy kết được. Mỗi lý do một cách sửa khác nhau. */
export const LANDING_GAP_REASONS = ["NO_TRACKING", "NO_MATCH", "AMBIGUOUS_MARKETER", "NO_MARKETER_DECLARED"] as const;
export type LandingGapReason = (typeof LANDING_GAP_REASONS)[number];

export const LANDING_GAP_LABEL: Record<LandingGapReason, string> = {
  NO_TRACKING: "Dòng landing không có ô tracking nào",
  NO_MATCH: "Tracking có, nhưng không khớp mẩu quảng cáo / chiến dịch nào trong ERP",
  AMBIGUOUS_MARKETER: "Chiến dịch đang mang nhiều marketer — nhập nhằng",
  NO_MARKETER_DECLARED: "Chiến dịch khớp rồi nhưng chưa ai khai người phụ trách",
};

export const LANDING_GAP_FIX: Record<LandingGapReason, string> = {
  NO_TRACKING: "Form landing chưa gửi utm/ad_id cho những dòng này. Bổ sung tham số tracking vào link chạy quảng cáo; đơn cũ không cứu được từ ERP.",
  NO_MATCH: "Chạy đồng bộ Facebook (job facebook-ads / facebook-ad-index) để bảng chi tiêu và sổ quảng cáo có chiến dịch ấy, rồi chạy lại đối soát.",
  AMBIGUOUS_MARKETER: "Vào Quảng cáo → Ghép chiến dịch với marketer, chọn một người cho chiến dịch đó, rồi chạy lại đối soát.",
  NO_MARKETER_DECLARED: "Vào Quảng cáo → Ghép chiến dịch với marketer để khai người phụ trách, rồi chạy lại đối soát.",
};

/**
 * PHIÊN BẢN LUẬT. Đổi cách kết luận ⇒ tăng số này, để dòng cũ thành CŨ và TÌM RA ĐƯỢC.
 * Cùng tinh thần với `FANPAGE_ATTRIBUTION_RULE_VERSION`.
 */
export const LANDING_ATTRIBUTION_RULE_VERSION = 1;

/** Ô tracking đọc được từ một dòng landing, đã chuẩn hoá. Chuỗi rỗng = KHÔNG CÓ, không phải "". */
export type LandingTracking = {
  /** `ad_id` dạng số (Meta) nếu form có gửi. */
  adId: string | null;
  /** `adset_id` dạng số nếu form có gửi. */
  adsetId: string | null;
  /** Chuỗi utm mang TÊN CHIẾN DỊCH (utm_source hoặc cột tương đương). */
  campaignName: string | null;
  /** Tên chiến dịch Meta ở ô utm_campaign — giữ để người đọc đối chiếu, KHÔNG dùng làm khoá. */
  utmCampaign: string | null;
  /** Link landing đầy đủ, giữ nguyên để truy nguyên. */
  landingUrl: string | null;
};

/** Một mẩu quảng cáo trong sổ ERP, đủ để trả lời chiến dịch / TKQC / fanpage. */
export type AdRecord = {
  adId: string;
  adsetId: string | null;
  campaignId: string | null;
  accountId: string | null;
  /** `<page_id>_<post_id>` của Facebook — nửa đầu là fanpage đã chạy mẩu này. */
  storyId: string | null;
};

/** Một tên chiến dịch trong bảng chi tiêu, đã gộp để biết nó có DUY NHẤT hay không. */
export type CampaignRecord = {
  campaignName: string;
  campaignIds: string[];
  accountIds: string[];
  marketerIds: string[];
};

export type LandingAttribution = {
  resolved: boolean;
  tier: LandingEvidenceTier | null;
  gap: LandingGapReason | null;
  marketerId: string | null;
  adAccountId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  /** Fanpage suy ra TỪ QUẢNG CÁO — KHÁC hẳn `orders.page_id` của Pancake. `null` là hợp lệ. */
  pageId: string | null;
  /** Câu giải thích đọc được, đi kèm mọi kết luận. Không có căn cứ thì không có kết luận. */
  evidence: string;
};

const EMPTY: LandingAttribution = {
  resolved: false,
  tier: null,
  gap: null,
  marketerId: null,
  adAccountId: null,
  campaignId: null,
  adsetId: null,
  adId: null,
  pageId: null,
  evidence: "",
};

const NUMERIC_ID = /^[0-9]{10,25}$/;

/**
 * `<page_id>_<post_id>` → `page_id`. Chuỗi không đúng dạng ⇒ `null`, không đoán.
 *
 * Nửa sau chỉ cần LÀ SỐ, không cần dài: độ dài của post id không nói thêm gì về tính đúng đắn của
 * nửa đầu, mà đặt ngưỡng dài ở đó thì một story id hợp lệ bất thường sẽ im lặng rơi mất page.
 */
export function pageIdFromStoryId(storyId: string | null | undefined): string | null {
  const s = (storyId ?? "").trim();
  const m = /^([0-9]{5,25})_([0-9]{1,25})$/.exec(s);
  return m ? m[1] : null;
}

/**
 * KẾT LUẬN CHO MỘT ĐƠN LANDING — HÀM THUẦN.
 *
 * Không đọc CSDL: mọi thứ cần thiết đã nằm trong ba tham số, nên bài kiểm thử dựng được đúng ca
 * mình muốn và kết quả không phụ thuộc thứ tự chạy.
 *
 * `marketerOfCampaignId` là ánh xạ `campaign_id → marketer` mà bảng chi tiêu khai ĐÚNG MỘT người
 * (cùng luật với `CAMPAIGN_TO_MARKETER` của `lib/queries/order-marketer.ts`). Chiến dịch hai người
 * cùng khai KHÔNG có mặt trong ánh xạ ấy — và ở đây nó thành `AMBIGUOUS_MARKETER`, không thành một
 * lựa chọn bừa.
 */
export function resolveLandingAttribution(input: {
  tracking: LandingTracking;
  /** Tra theo `ad_id`. */
  adById: Map<string, AdRecord>;
  /** Tra theo `adset_id` — chỉ dùng khi adset ấy thuộc ĐÚNG MỘT chiến dịch. */
  adsByAdsetId: Map<string, AdRecord[]>;
  /** Tra theo TÊN chiến dịch, khớp tuyệt đối. */
  campaignByName: Map<string, CampaignRecord>;
  /** `campaign_id` → marketer, chỉ chiến dịch có ĐÚNG MỘT người khai. */
  marketerOfCampaignId: Map<string, string>;
  /** Fanpage ERP biết tới — page suy ra mà không có trong sổ thì KHÔNG gán. */
  knownPageIds: Set<string>;
}): LandingAttribution {
  const { tracking, adById, adsByAdsetId, campaignByName, marketerOfCampaignId, knownPageIds } = input;
  const adId = tracking.adId && NUMERIC_ID.test(tracking.adId) ? tracking.adId : null;
  const adsetId = tracking.adsetId && NUMERIC_ID.test(tracking.adsetId) ? tracking.adsetId : null;
  const campaignName = tracking.campaignName?.trim() || null;
  if (!adId && !adsetId && !campaignName) return { ...EMPTY, gap: "NO_TRACKING" };

  const pageOf = (ad: AdRecord | null): string | null => {
    const p = pageIdFromStoryId(ad?.storyId);
    return p && knownPageIds.has(p) ? p : null;
  };

  // ── BẬC 1: ad_id khớp sổ quảng cáo. Bằng chứng trực tiếp nhất: một mẩu quảng cáo cụ thể.
  const ad = adId ? (adById.get(adId) ?? null) : null;
  if (ad) {
    const marketerId = ad.campaignId ? (marketerOfCampaignId.get(ad.campaignId) ?? null) : null;
    return finish({
      tier: "AD_ID",
      marketerId,
      adAccountId: ad.accountId ?? null,
      campaignId: ad.campaignId ?? null,
      adsetId: ad.adsetId ?? adsetId,
      adId,
      pageId: pageOf(ad),
      evidence: `ad_id ${adId} khớp sổ quảng cáo → chiến dịch ${ad.campaignId ?? "?"} → TKQC ${ad.accountId ?? "?"}`,
    });
  }

  // ── BẬC 2: adset_id, CHỈ khi mọi mẩu trong adset ấy cùng một chiến dịch.
  const adsOfSet = adsetId ? (adsByAdsetId.get(adsetId) ?? []) : [];
  const campaignsOfSet = [...new Set(adsOfSet.map((a) => a.campaignId).filter((x): x is string => Boolean(x)))];
  if (adsetId && campaignsOfSet.length === 1) {
    const one = adsOfSet[0];
    const campaignId = campaignsOfSet[0];
    const accounts = [...new Set(adsOfSet.map((a) => a.accountId).filter((x): x is string => Boolean(x)))];
    const pages = [...new Set(adsOfSet.map((a) => pageOf(a)).filter((x): x is string => Boolean(x)))];
    return finish({
      tier: "ADSET_ID",
      marketerId: marketerOfCampaignId.get(campaignId) ?? null,
      adAccountId: accounts.length === 1 ? accounts[0] : null,
      campaignId,
      adsetId,
      adId: adId ?? (adsOfSet.length === 1 ? one.adId : null),
      pageId: pages.length === 1 ? pages[0] : null,
      evidence: `adset_id ${adsetId} khớp sổ quảng cáo, cả nhóm thuộc đúng một chiến dịch ${campaignId}`,
    });
  }

  // ── BẬC 3: TÊN chiến dịch khớp tuyệt đối bảng chi tiêu.
  const camp = campaignName ? (campaignByName.get(campaignName) ?? null) : null;
  if (camp) {
    const campaignId = camp.campaignIds.length === 1 ? camp.campaignIds[0] : null;
    const accountId = camp.accountIds.length === 1 ? camp.accountIds[0] : null;
    /*
      Marketer lấy theo TÊN chiến dịch chứ không bắt buộc qua `campaign_id`: một tên chiến dịch có
      thể trải trên nhiều `campaign_id` (Meta nhân bản chiến dịch giữ nguyên tên). Luật chống nhập
      nhằng vẫn y nguyên — chỉ kết luận khi cả cụm ấy khai ĐÚNG MỘT người.
    */
    const marketerId = camp.marketerIds.length === 1 ? camp.marketerIds[0] : null;
    return finish({
      tier: "CAMPAIGN_NAME",
      marketerId,
      adAccountId: accountId,
      campaignId,
      adsetId,
      adId,
      pageId: null,
      evidence: `tên chiến dịch "${campaignName}" khớp tuyệt đối bảng chi tiêu${campaignId ? ` → chiến dịch ${campaignId}` : " (tên trải trên nhiều chiến dịch)"}${accountId ? ` → TKQC ${accountId}` : ""}`,
      ambiguousMarketer: camp.marketerIds.length > 1,
    });
  }

  return { ...EMPTY, gap: "NO_MATCH", adId, adsetId };
}

function finish(v: {
  tier: LandingEvidenceTier;
  marketerId: string | null;
  adAccountId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  pageId: string | null;
  evidence: string;
  ambiguousMarketer?: boolean;
}): LandingAttribution {
  const gap: LandingGapReason | null = v.marketerId ? null : v.ambiguousMarketer ? "AMBIGUOUS_MARKETER" : "NO_MARKETER_DECLARED";
  return {
    resolved: Boolean(v.marketerId),
    tier: v.tier,
    gap,
    marketerId: v.marketerId,
    adAccountId: v.adAccountId,
    campaignId: v.campaignId,
    adsetId: v.adsetId,
    adId: v.adId,
    pageId: v.pageId,
    evidence: v.evidence,
  };
}
