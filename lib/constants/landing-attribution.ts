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
export const LANDING_EVIDENCE_TIERS = ["AD_ID", "ADSET_ID", "CAMPAIGN_ID", "CAMPAIGN_NAME"] as const;
export type LandingEvidenceTier = (typeof LANDING_EVIDENCE_TIERS)[number];

export const LANDING_EVIDENCE_LABEL: Record<LandingEvidenceTier, string> = {
  AD_ID: "ad_id khớp sổ quảng cáo",
  ADSET_ID: "adset_id khớp sổ nhóm quảng cáo (tra thẳng từ Meta)",
  CAMPAIGN_ID: "campaign_id khớp tuyệt đối bảng chi tiêu",
  CAMPAIGN_NAME: "tên chiến dịch khớp tuyệt đối bảng chi tiêu",
};

/**
 * VÌ SAO MỘT ĐƠN LANDING CHƯA QUY KẾT ĐƯỢC — MỖI LÝ DO MỘT VIỆC PHẢI LÀM KHÁC NHAU.
 *
 * Gộp tất cả thành một `NO_MATCH` chung là cách chắc chắn nhất để không ai sửa gì: "không khớp"
 * không nói được phải đi lấy dữ liệu nào. Đo production 15/09/2026, 31 đơn `NO_MATCH` hoá ra là
 * BA nguyên nhân hoàn toàn khác nhau — 29 đơn vì ERP chưa tra nhóm quảng cáo, 1 đơn vì tên chiến
 * dịch không có trong bảng chi tiêu, 1 đơn vì khách vào thẳng chứ không qua quảng cáo nào.
 */
export const LANDING_GAP_REASONS = [
  "NO_TRACKING",
  "NO_AD_SOURCE",
  "META_ADSET_NOT_SYNCED",
  "META_AD_NOT_SYNCED",
  "CAMPAIGN_NOT_SYNCED",
  "AD_ACCOUNT_UNRESOLVED",
  "HISTORICAL_OWNER_UNKNOWN",
  "AMBIGUOUS_MARKETER",
  "NO_MARKETER_DECLARED",
  "NO_MATCH",
] as const;
export type LandingGapReason = (typeof LANDING_GAP_REASONS)[number];

export const LANDING_GAP_LABEL: Record<LandingGapReason, string> = {
  NO_TRACKING: "Dòng landing không có ô tracking nào",
  NO_AD_SOURCE: "Khách vào thẳng — không qua quảng cáo nào",
  META_ADSET_NOT_SYNCED: "Nhóm quảng cáo chưa được tra về ERP",
  META_AD_NOT_SYNCED: "Mẩu quảng cáo chưa được tra về ERP",
  CAMPAIGN_NOT_SYNCED: "Chiến dịch chưa có trong bảng chi tiêu",
  AD_ACCOUNT_UNRESOLVED: "Tra được nhóm/chiến dịch nhưng không biết tài khoản quảng cáo nào",
  HISTORICAL_OWNER_UNKNOWN: "Chiến dịch từng đổi người phụ trách — không chứng minh được ai phụ trách TẠI MỐC ĐƠN",
  AMBIGUOUS_MARKETER: "Chiến dịch đang mang nhiều marketer — nhập nhằng",
  NO_MARKETER_DECLARED: "Chiến dịch khớp rồi nhưng chưa ai khai người phụ trách",
  NO_MATCH: "Tracking có, nhưng không khớp thực thể Meta nào ERP biết",
};

export const LANDING_GAP_FIX: Record<LandingGapReason, string> = {
  NO_TRACKING: "Form landing chưa gửi utm/ad_id cho những dòng này. Bổ sung tham số tracking vào link chạy quảng cáo; đơn cũ không cứu được từ ERP.",
  NO_AD_SOURCE: "Không phải lỗi dữ liệu: đơn này vốn không sinh ra từ một mẩu quảng cáo nào. Doanh thu của nó thuộc kênh landing trực tiếp, không thuộc marketer nào.",
  META_ADSET_NOT_SYNCED: "Chạy job facebook-adset-index để tra nhóm quảng cáo ấy về ERP, rồi chạy lại đối soát.",
  META_AD_NOT_SYNCED: "Chạy job facebook-ad-index để tra mẩu quảng cáo ấy về ERP, rồi chạy lại đối soát.",
  CAMPAIGN_NOT_SYNCED: "Chiến dịch chưa có dòng chi tiêu nào trong kỳ đã đồng bộ. Chạy facebook-ads với days đủ dài để phủ ngày chạy chiến dịch, rồi đối soát lại.",
  AD_ACCOUNT_UNRESOLVED: "Token hiện tại không đọc được tài khoản quảng cáo của thực thể này. Kiểm tra quyền của System User trong Business Manager.",
  HISTORICAL_OWNER_UNKNOWN: "Bảng chi tiêu ghi nhiều marketer cho chiến dịch này ở các thời điểm khác nhau. Khai rõ ai phụ trách trong khoảng nào ở Quảng cáo → Ghép chiến dịch, rồi đối soát lại.",
  AMBIGUOUS_MARKETER: "Vào Quảng cáo → Ghép chiến dịch với marketer, chọn một người cho chiến dịch đó, rồi chạy lại đối soát.",
  NO_MARKETER_DECLARED: "Vào Quảng cáo → Ghép chiến dịch với marketer để khai người phụ trách, rồi chạy lại đối soát.",
  NO_MATCH: "Chạy đồng bộ Facebook (facebook-ads · facebook-ad-index · facebook-adset-index) rồi đối soát lại. Còn treo sau đó nghĩa là Meta không còn trả dữ liệu cho mã ấy.",
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
  /**
   * MÃ SỐ META ĐỌC ĐƯỢC TỪ CHÍNH LINK LANDING (`utm_id` · `utm_term` · `utm_content`).
   *
   * Meta điền sẵn ba tham số này bằng `{{campaign.id}}` / `{{adset.id}}` / `{{ad.id}}`. Thứ tự
   * của chúng KHÔNG được giả định: mỗi mã đem tra lần lượt ở sổ mẩu quảng cáo → sổ nhóm → bảng
   * chi tiêu, và chỉ nhận khi khớp TUYỆT ĐỐI. Khớp ở đâu thì nó là loại ấy — suy ra từ dữ liệu,
   * không từ tên tham số.
   */
  urlIds: string[];
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

/** Một nhóm quảng cáo đã tra thẳng từ Meta (`fb_adsets`) — mắt xích adset → chiến dịch. */
export type AdsetRecord = {
  adsetId: string;
  campaignId: string | null;
  accountId: string | null;
  missing: boolean;
};

/** Một chiến dịch trong bảng chi tiêu, tra theo `campaign_id`. */
export type CampaignByIdRecord = {
  campaignId: string;
  campaignName: string;
  accountIds: string[];
  marketerIds: string[];
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

/** Những chuỗi mà form landing ghi khi KHÔNG có nguồn quảng cáo nào. */
const DIRECT_TRAFFIC = new Set(["(trực tiếp)", "(direct)", "direct", "trực tiếp"]);

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
  /** Sổ nhóm quảng cáo tra thẳng từ Meta (`fb_adsets`) — mắt xích adset → chiến dịch. */
  adsetById: Map<string, AdsetRecord>;
  /** Tra chiến dịch theo `campaign_id` trong bảng chi tiêu. */
  campaignById: Map<string, CampaignByIdRecord>;
  /** Tra theo TÊN chiến dịch, khớp tuyệt đối. */
  campaignByName: Map<string, CampaignRecord>;
  /** `campaign_id` → marketer, chỉ chiến dịch có ĐÚNG MỘT người khai. */
  marketerOfCampaignId: Map<string, string>;
  /** Fanpage ERP biết tới — page suy ra mà không có trong sổ thì KHÔNG gán. */
  knownPageIds: Set<string>;
}): LandingAttribution {
  const { tracking, adById, adsByAdsetId, adsetById, campaignById, campaignByName, marketerOfCampaignId, knownPageIds } = input;
  const adId = tracking.adId && NUMERIC_ID.test(tracking.adId) ? tracking.adId : null;
  /*
    Ô "tên chiến dịch" có thể chứa MỘT MÃ SỐ.

    Form landing đổi bố cục giữa chừng: bản mới ghi thẳng `adset_id` vào `utm_source`, chỗ trước
    đó là tên chiến dịch. Đo production 15/09/2026: 29 đơn treo, 10 mã, Graph khai cả 10 là ADSET.
    Coi một dãy 18 chữ số là "tên chiến dịch" thì nó không bao giờ khớp cái gì — nên ở đây nó được
    đọc đúng bản chất: một MÃ, đem đi tra như mọi mã khác.
  */
  const nameIsId = tracking.campaignName && NUMERIC_ID.test(tracking.campaignName.trim()) ? tracking.campaignName.trim() : null;
  const urlIds = (tracking.urlIds ?? []).filter((x) => NUMERIC_ID.test(x));
  const adsetId = (tracking.adsetId && NUMERIC_ID.test(tracking.adsetId) ? tracking.adsetId : null) ?? nameIsId;
  const campaignName = nameIsId ? null : tracking.campaignName?.trim() || null;
  if (!adId && !adsetId && !campaignName && !urlIds.length) return { ...EMPTY, gap: "NO_TRACKING" };
  /*
    "(trực tiếp)" là lời khai của chính form: khách vào thẳng, không qua quảng cáo nào. Đó KHÔNG
    phải một chỗ trống phải đi lấp — nó là câu trả lời, và câu trả lời ấy là "không thuộc ai".
  */
  if (!adId && !adsetId && campaignName && DIRECT_TRAFFIC.has(campaignName.toLowerCase())) return { ...EMPTY, gap: "NO_AD_SOURCE" };

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

  /*
    ── BẬC 2b: adset_id tra thẳng từ Meta (`fb_adsets`) → chiến dịch cha → bảng chi tiêu.

    Đây là mắt xích đã thiếu: `fb_ads` chỉ chứa mẩu quảng cáo mà ĐƠN PANCAKE tham chiếu, còn đơn
    landing thì Pancake không gửi `ad_id` — nên adset của chúng không bao giờ có mặt ở đó. Tra
    thẳng theo mã giải đúng chuyện ấy, kể cả với nhóm đã tắt.
  */
  const adset = adsetId ? (adsetById.get(adsetId) ?? null) : null;
  if (adset && !adset.missing) {
    if (!adset.campaignId) return { ...EMPTY, gap: "AD_ACCOUNT_UNRESOLVED", adsetId, adId, adAccountId: adset.accountId };
    const camp = campaignById.get(adset.campaignId) ?? null;
    if (!camp) {
      // Tra được nhóm và biết chiến dịch cha, nhưng chiến dịch ấy chưa có dòng chi tiêu nào ⇒
      // không có chỗ nào khai người phụ trách. Lỗ hổng NÀY khác hẳn "không khớp gì cả".
      return { ...EMPTY, gap: "CAMPAIGN_NOT_SYNCED", adsetId, adId, campaignId: adset.campaignId, adAccountId: adset.accountId };
    }
    const marketerId = camp.marketerIds.length === 1 ? camp.marketerIds[0] : null;
    return finish({
      tier: "ADSET_ID",
      marketerId,
      adAccountId: adset.accountId ?? (camp.accountIds.length === 1 ? camp.accountIds[0] : null),
      campaignId: adset.campaignId,
      adsetId,
      adId,
      pageId: null,
      evidence: `adset_id ${adsetId} tra từ Meta → chiến dịch ${adset.campaignId} ("${camp.campaignName}") → TKQC ${adset.accountId ?? "?"}`,
      ambiguousMarketer: camp.marketerIds.length > 1,
    });
  }

  // ── BẬC 2c: chính mã ấy là một `campaign_id` có trong bảng chi tiêu.
  const campDirect = adsetId ? (campaignById.get(adsetId) ?? null) : null;
  if (campDirect) {
    const marketerId = campDirect.marketerIds.length === 1 ? campDirect.marketerIds[0] : null;
    return finish({
      tier: "CAMPAIGN_ID",
      marketerId,
      adAccountId: campDirect.accountIds.length === 1 ? campDirect.accountIds[0] : null,
      campaignId: adsetId,
      adsetId: null,
      adId,
      pageId: null,
      evidence: `campaign_id ${adsetId} khớp tuyệt đối bảng chi tiêu ("${campDirect.campaignName}")`,
      ambiguousMarketer: campDirect.marketerIds.length > 1,
    });
  }

  /*
    Mã có, tra rồi, mà Meta không trả được gì: đây là "chưa tra về ERP" hay "Meta không còn dữ
    liệu"? Dòng `fb_adsets` với `missing = true` chính là lời khai đã hỏi và bị từ chối; chưa có
    dòng nào thì đơn giản là CHƯA HỎI.
  */
  if (adsetId) {
    return { ...EMPTY, gap: adset?.missing ? "NO_MATCH" : "META_ADSET_NOT_SYNCED", adsetId, adId };
  }
  if (adId) return { ...EMPTY, gap: "META_AD_NOT_SYNCED", adId, adsetId };

  /*
    ── BẬC 2d: MÃ SỐ NẰM NGAY TRONG LINK LANDING.

    Meta điền sẵn `utm_id` / `utm_term` / `utm_content` bằng id chiến dịch / nhóm / mẩu. Thứ tự
    không được giả định — mỗi mã đem tra LẦN LƯỢT ở ba sổ, khớp ở đâu thì nó là loại ấy. Đây vẫn
    là khớp TUYỆT ĐỐI trên một khoá, không phải đoán.
  */
  for (const mid of urlIds) {
    const adFromUrl = adById.get(mid);
    if (adFromUrl) {
      const marketerId = adFromUrl.campaignId ? (marketerOfCampaignId.get(adFromUrl.campaignId) ?? null) : null;
      return finish({
        tier: "AD_ID",
        marketerId,
        adAccountId: adFromUrl.accountId ?? null,
        campaignId: adFromUrl.campaignId ?? null,
        adsetId: adFromUrl.adsetId ?? adsetId,
        adId: mid,
        pageId: pageOf(adFromUrl),
        evidence: `ad_id ${mid} đọc từ link landing, khớp sổ quảng cáo → chiến dịch ${adFromUrl.campaignId ?? "?"}`,
      });
    }
    const adsetFromUrl = adsetById.get(mid);
    if (adsetFromUrl && !adsetFromUrl.missing && adsetFromUrl.campaignId) {
      const camp = campaignById.get(adsetFromUrl.campaignId);
      if (camp) {
        return finish({
          tier: "ADSET_ID",
          marketerId: camp.marketerIds.length === 1 ? camp.marketerIds[0] : null,
          adAccountId: adsetFromUrl.accountId ?? null,
          campaignId: adsetFromUrl.campaignId,
          adsetId: mid,
          adId,
          pageId: null,
          evidence: `adset_id ${mid} đọc từ link landing → chiến dịch ${adsetFromUrl.campaignId} ("${camp.campaignName}")`,
          ambiguousMarketer: camp.marketerIds.length > 1,
        });
      }
    }
    const campFromUrl = campaignById.get(mid);
    if (campFromUrl) {
      return finish({
        tier: "CAMPAIGN_ID",
        marketerId: campFromUrl.marketerIds.length === 1 ? campFromUrl.marketerIds[0] : null,
        adAccountId: campFromUrl.accountIds.length === 1 ? campFromUrl.accountIds[0] : null,
        campaignId: mid,
        adsetId,
        adId,
        pageId: null,
        evidence: `campaign_id ${mid} đọc từ link landing, khớp tuyệt đối bảng chi tiêu ("${campFromUrl.campaignName}")`,
        ambiguousMarketer: campFromUrl.marketerIds.length > 1,
      });
    }
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

  return { ...EMPTY, gap: "CAMPAIGN_NOT_SYNCED", adId, adsetId };
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
  // Ghi chú: nhập nhằng THEO THỜI GIAN (một chiến dịch đổi người giữa chừng) cũng rơi vào
  // `AMBIGUOUS_MARKETER` — cùng một hệ quả, và cách sửa đều là khai rõ ai phụ trách khoảng nào.
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
