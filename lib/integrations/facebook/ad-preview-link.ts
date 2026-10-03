/**
 * ═══════════ LINK CHIA SẺ XEM TRƯỚC → AD ID ═══════════
 *
 * Hộp "Chia sẻ quảng cáo này" của Trình quản lý quảng cáo cho ra `https://fb.me/adspreview/facebook/<mã>`.
 * Link đó KHÔNG mang Ad ID — nó chuyển hướng tới một `encrypted_experience_id` đã mã hoá, và không đăng
 * nhập thì Facebook trả 400 (đo 03/10/2026). ERP không mở link, không giải mã, không cào trang.
 *
 * Đường duy nhất có căn cứ: Meta khai trên MỖI mẩu quảng cáo trường `preview_shareable_link`. Bộ dò hỏi
 * trường đó cho các mẩu của từng tài khoản quảng cáo (`act_<id>/ads`, 100 mẩu một trang), so theo khoá
 * (loại link, mã) và dừng ngay khi đã thấy đủ. Mẩu nào Meta nói mang đúng link ấy thì đó là Ad ID — rồi
 * Ad ID đi tiếp đường tra bài viết có sẵn (`resolveAdPosts`), không có lối tắt nào khác.
 *
 * Không thấy KHÔNG phải "link sai": có thể đã dò chưa hết (trần mỗi lượt), có tài khoản không đọc được,
 * hoặc mẩu còn là bản nháp (Meta không trả bản nháp qua API). Câu trả lời phải nói đúng ca nào.
 *
 * Tệp này không đọc/ghi CSDL. Graph được truyền vào qua `PreviewLinkGraph` để kiểm thử dựng bản giả.
 */
import { ConnectorUnavailableError } from "@/lib/platform/credentials";
import { graphErrorInfo } from "@/lib/integrations/facebook/client";
import { classifyMetaError, META_AD_POST_ERROR_LABEL, parseAdPreviewLink, type AdPreviewLink, type MetaAdPostError } from "@/lib/constants/meta-ad-post";

/** Một trang mẩu của một tài khoản: Ad ID + `preview_shareable_link` Meta trả (có thể rỗng). */
export type AdPreviewLinkPage = { adId: string; link: string }[];

export type PreviewLinkGraph = {
  adPreviewLinkPages(accountId: string): AsyncIterable<AdPreviewLinkPage>;
};

/**
 * Trần số mẩu dò trong MỘT lượt. Mỗi trang 100 mẩu là một lời gọi Graph, nên 5.000 mẩu ≈ 50 lời gọi —
 * trần KỸ THUẬT để một cú bấm không đốt hạn mức dùng chung với job đồng bộ chi tiêu, không phải ngưỡng
 * nghiệp vụ. Chạm trần thì nói ra (`capped`), không báo "không tìm thấy".
 */
export const PREVIEW_LINK_SCAN_MAX_ADS = 5000;

/** Lỗi của CẢ KẾT NỐI: dò tiếp tài khoản sau cũng hỏng như thế. */
const CONNECTION_ERRORS: ReadonlySet<MetaAdPostError> = new Set(["TOKEN_EXPIRED", "MISSING_PERMISSION", "META_RATE_LIMIT"]);

export type PreviewLinkMatch = { link: AdPreviewLink; adId: string | null; accountId: string | null; reason: string | null };

export type PreviewLinkScan = {
  matches: PreviewLinkMatch[];
  scannedAds: number;
  scannedAccounts: number;
  totalAccounts: number;
  /** Dừng vì chạm trần mỗi lượt — còn tài khoản / trang CHƯA dò. */
  capped: boolean;
  /** Tài khoản đọc hỏng (mã ổn định) — một tài khoản hết quyền không kéo cả lượt xuống. */
  accountErrors: { accountId: string; error: MetaAdPostError }[];
  /** Lỗi của cả kết nối làm lượt dò dừng giữa chừng. */
  fatal: MetaAdPostError | null;
  /** Meta trả `preview_shareable_link` ở hình dạng nào — rỗng hết thì "không thấy" là chuyện của token, không phải của link. */
  linkForms: { facebook: number; managedAccount: number; empty: number; other: number };
};

/**
 * Dò Ad ID cho các link chia sẻ. `accountIds` theo thứ tự ưu tiên (tài khoản đang hoạt động trước) —
 * mẩu đang chạy nằm ở đó, nên lượt dò thường dừng sớm.
 */
export async function findAdsByPreviewLinks(
  links: AdPreviewLink[],
  deps: { graph: PreviewLinkGraph; accountIds: string[]; maxAds?: number },
): Promise<PreviewLinkScan> {
  const maxAds = deps.maxAds ?? PREVIEW_LINK_SCAN_MAX_ADS;
  const wanted = new Map(links.map((l) => [l.key, l]));
  const found = new Map<string, { adId: string; accountId: string }>();
  const accountErrors: PreviewLinkScan["accountErrors"] = [];
  let scannedAds = 0;
  let scannedAccounts = 0;
  let capped = false;
  let fatal: MetaAdPostError | null = null;
  const linkForms = { facebook: 0, managedAccount: 0, empty: 0, other: 0 };

  outer: for (const accountId of deps.accountIds) {
    if (found.size === wanted.size) break;
    if (scannedAds >= maxAds) {
      capped = true;
      break;
    }
    try {
      for await (const page of deps.graph.adPreviewLinkPages(accountId)) {
        for (const ad of page) {
          scannedAds += 1;
          const parsed = parseAdPreviewLink(ad.link, { allowBare: true });
          if (!ad.link) linkForms.empty += 1;
          else if (!parsed) linkForms.other += 1;
          else if (parsed.audience === "FACEBOOK") linkForms.facebook += 1;
          else linkForms.managedAccount += 1;
          if (parsed && wanted.has(parsed.key) && !found.has(parsed.key)) found.set(parsed.key, { adId: ad.adId, accountId });
        }
        if (found.size === wanted.size) {
          scannedAccounts += 1;
          break outer;
        }
        if (scannedAds >= maxAds) {
          // Trang cuối của tài khoản này có thể còn — không biết chắc thì coi là CHƯA dò hết.
          capped = true;
          scannedAccounts += 1;
          break outer;
        }
      }
      scannedAccounts += 1;
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) throw error;
      const code = classifyMetaError(graphErrorInfo(error));
      if (CONNECTION_ERRORS.has(code)) {
        fatal = code;
        break;
      }
      accountErrors.push({ accountId, error: code });
    }
  }

  const totalAccounts = deps.accountIds.length;
  const matches = links.map((link): PreviewLinkMatch => {
    const hit = found.get(link.key);
    if (hit) return { link, adId: hit.adId, accountId: hit.accountId, reason: null };
    return { link, adId: null, accountId: null, reason: notFoundReason(link, { scannedAds, scannedAccounts, totalAccounts, capped, accountErrors, fatal, linkForms }) };
  });
  return { matches, scannedAds, scannedAccounts, totalAccounts, capped, accountErrors, fatal, linkForms };
}

/** Câu cho người đọc: nói ĐÚNG vì sao chưa thấy, và việc phải làm. */
function notFoundReason(link: AdPreviewLink, s: Omit<PreviewLinkScan, "matches">): string {
  if (s.fatal) return `Dò dừng giữa chừng: ${META_AD_POST_ERROR_LABEL[s.fatal]}`;
  const where = `${s.scannedAds.toLocaleString("vi-VN")} mẩu ở ${s.scannedAccounts}/${s.totalAccounts} tài khoản quảng cáo`;
  if (s.scannedAds > 0 && s.linkForms.empty === s.scannedAds) return `Đã dò ${where} nhưng Meta không trả preview_shareable_link cho mẩu nào — token của ERP không đọc được trường này, nên link chia sẻ không dò được. Dán Ad ID thay cho link.`;
  if (s.capped) return `Đã dò ${where} (trần một lượt) mà chưa thấy — chưa dò hết, nên đây KHÔNG phải "không có". Mở quảng cáo trong Trình quản lý rồi dán Ad ID thay cho link.`;
  const parts = [`Đã dò hết ${where} mà Meta không trả mẩu nào mang link này`];
  if (s.accountErrors.length) parts.push(`${s.accountErrors.length} tài khoản không đọc được`);
  if (link.audience === "MANAGED_ACCOUNT") parts.push(`đây là link dòng "tài khoản Meta được quản lý" — thử link ở dòng "đăng nhập bằng Facebook"`);
  parts.push("quảng cáo còn là bản nháp hoặc thuộc tài khoản ERP chưa được cấp thì Meta không trả");
  return `${parts.join(" · ")}.`;
}
