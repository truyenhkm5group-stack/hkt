/**
 * ═══════════ MẨU QUẢNG CÁO → BÀI VIẾT: PHẦN THUẦN ═══════════
 *
 * Chủ shop dán một Ad ID (hoặc một link xem trước `feed_demo_ad=…`), ERP hỏi Meta và trả về bài
 * viết mà mẩu đó quảng bá — kể cả BÀI ẨN (dark post) dựng bằng "Tạo quảng cáo", thứ không có trên
 * dòng thời gian của fanpage và không tra được bằng mắt.
 *
 * Tệp này là phần KHÔNG gọi mạng, KHÔNG đọc CSDL — client component import được (AGENTS.md mục 2).
 * Đường gọi Graph ở `lib/integrations/facebook/ad-post-resolver.ts`, đường ghi ở `ad-post-store.ts`.
 *
 * ─── BA ĐIỀU KHÔNG ĐƯỢC LÀM ───
 *
 *  1. KHÔNG ĐOÁN POST ID. Bài viết chỉ đến từ `effective_object_story_id` → `object_story_id` của
 *     creative do CHÍNH Meta trả. Không có hai trường đó ⇒ `POST_NOT_RESOLVED`, không dựng số.
 *  2. `feed_demo_ad` là ỨNG VIÊN AD ID, không phải Post ID. Nó chỉ đi vào bước tra như mọi Ad ID
 *     khác; bước tra nói nó là gì. Link chia sẻ `fb.me/adspreview/…` còn xa hơn: nó không mang mã
 *     nào, và Ad ID chỉ có khi Meta tự nói mẩu nào sở hữu đúng link đó (`preview_shareable_link`).
 *  3. KHÔNG LÀM MẤT PAGE ID. Chuỗi gốc `<page_id>_<post_id>` luôn được giữ nguyên cạnh hai phần đã
 *     tách: một Post ID trần không mở được bài và không nói bài thuộc fanpage nào.
 */

/** Trần số mã trong MỘT lượt tra. `getAdsByIds` gom 50 mã mỗi lời gọi Graph — trần kỹ thuật, không phải ngưỡng nghiệp vụ. */
export const META_AD_POST_BATCH_MAX = 50;

/** Mã mẩu quảng cáo Meta: toàn chữ số. Dải 120… dài 15–18 chữ số; nhận 5–25 để không chặn nhầm mã cũ. */
const AD_ID_RE = /^\d{5,25}$/;

/** Tên tham số URL có thể mang Ad ID. `feed_demo_ad` là link "Xem trước" của Trình quản lý quảng cáo. */
const AD_ID_URL_PARAMS = ["feed_demo_ad", "ad_id", "adid", "selected_ad_ids"] as const;

export type AdIdInput = { ok: true; adId: string; from: "PLAIN" | "URL_PARAM"; param?: string } | { ok: false; raw: string; reason: string };

/**
 * Một dòng người dán → một Ad ID, hoặc một lý do vì sao không phải.
 *
 * Nhận: số trần (kể cả có khoảng trắng / dấu chấm ngăn nghìn do copy), `act_…` bị từ chối (đó là
 * TÀI KHOẢN, không phải mẩu), và URL có `feed_demo_ad=` / `ad_id=` / `selected_ad_ids=` (chỉ khi đúng
 * MỘT mã). URL không mang tham số nào như vậy thì KHÔNG bóc bừa dãy số trong đường dẫn — một link
 * bài viết `/posts/123…` chứa số của BÀI, bóc ra rồi đem tra như Ad ID là đúng thứ điều 2 cấm.
 */
export function normalizeAdIdInput(raw: string): AdIdInput {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, raw: text, reason: "Ô trống." };
  if (/^act_/i.test(text)) return { ok: false, raw: text, reason: "Đây là mã TÀI KHOẢN quảng cáo (act_…), không phải mã mẩu quảng cáo." };

  if (/^https?:\/\//i.test(text) || /^(www\.|m\.)?(facebook|fb|business\.facebook|adsmanager\.facebook)\.com\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
      return { ok: false, raw: text, reason: "Không đọc được đường link." };
    }
    for (const param of AD_ID_URL_PARAMS) {
      const value = url.searchParams.get(param);
      if (value === null) continue;
      const ids = value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (ids.length !== 1) return { ok: false, raw: text, reason: `Tham số ${param} mang ${ids.length} mã — dán từng mã một, hoặc dùng ô nhiều mã.` };
      if (!AD_ID_RE.test(ids[0])) return { ok: false, raw: text, reason: `Tham số ${param} không phải một mã số hợp lệ.` };
      return { ok: true, adId: ids[0], from: "URL_PARAM", param };
    }
    return { ok: false, raw: text, reason: "Link không có feed_demo_ad / ad_id — không bóc số từ đường dẫn vì dễ lấy nhầm mã bài viết." };
  }

  // Số dán từ bảng tính hay mang khoảng trắng / dấu chấm / dấu phẩy ngăn nghìn.
  const digits = text.replace(/[\s.,]/g, "");
  if (AD_ID_RE.test(digits)) return { ok: true, adId: digits, from: "PLAIN" };
  if (/^\d+_\d+$/.test(digits)) return { ok: false, raw: text, reason: "Chuỗi dạng PAGE_ID_POST_ID là mã BÀI VIẾT, không phải Ad ID." };
  return { ok: false, raw: text, reason: "Không phải một mã quảng cáo (cần toàn chữ số)." };
}

// ─────────────────────────── LINK CHIA SẺ "XEM TRƯỚC QUẢNG CÁO" ───────────────────────────

/**
 * Hai loại link của hộp "Chia sẻ quảng cáo này" trong Trình quản lý quảng cáo: dòng "đăng nhập bằng
 * Facebook" và dòng "tài khoản Meta được quản lý". Mã rút gọn của HAI dòng thuộc hai không gian riêng
 * (đo 03/10/2026: mã của dòng Facebook ghép sau `/managedaccount/` không mở ra quảng cáo nào), nên
 * khoá so khớp phải mang cả LOẠI lẫn MÃ.
 */
export const AD_PREVIEW_AUDIENCES = ["FACEBOOK", "MANAGED_ACCOUNT"] as const;
export type AdPreviewAudience = (typeof AD_PREVIEW_AUDIENCES)[number];

export type AdPreviewLink = { url: string; audience: AdPreviewAudience; code: string; key: string };

const PREVIEW_CODE_RE = /^[A-Za-z0-9]{6,40}$/;

/**
 * `https://fb.me/adspreview/facebook/<mã>` (hoặc `/managedaccount/<mã>`) → loại + mã.
 *
 * Link này KHÔNG mang Ad ID: nó chuyển hướng tới một `encrypted_experience_id` đã mã hoá, và không
 * đăng nhập thì Facebook trả 400. ERP KHÔNG mở link, KHÔNG giải mã, KHÔNG cào trang — nó hỏi Meta
 * trường `preview_shareable_link` của từng mẩu rồi so khớp (`findAdsByPreviewLinks`).
 *
 * `allowBare`: dạng cũ `https://fb.me/<mã>` — chính mã đó, cùng đích với dạng `/adspreview/facebook/`
 * (đo 03/10/2026). Chỉ bật cho giá trị Meta trả về; người dán `fb.me/<chữ>` có thể là link rút gọn
 * của một fanpage, nên ô nhập chỉ nhận dạng có `/adspreview/`.
 */
export function parseAdPreviewLink(raw: string | null | undefined, opts: { allowBare?: boolean } = {}): AdPreviewLink | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/^(www\.)?fb\.me$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let audience: AdPreviewAudience;
  let code: string;
  if (parts.length === 3 && parts[0].toLowerCase() === "adspreview") {
    const kind = parts[1].toLowerCase();
    if (kind === "facebook") audience = "FACEBOOK";
    else if (kind === "managedaccount") audience = "MANAGED_ACCOUNT";
    else return null;
    code = parts[2];
  } else if (opts.allowBare && parts.length === 1) {
    audience = "FACEBOOK";
    code = parts[0];
  } else return null;
  if (!PREVIEW_CODE_RE.test(code)) return null;
  return { url: text, audience, code, key: `${audience}:${code}` };
}

export type AdIdList = {
  adIds: string[];
  invalid: { raw: string; reason: string }[];
  duplicates: number;
  overflow: number;
  /** Link chia sẻ xem trước — chưa phải Ad ID; máy chủ dò Ad ID qua `preview_shareable_link`. */
  previewLinks: AdPreviewLink[];
};

/**
 * Ô "dán nhiều mã": mỗi dòng (hoặc cách nhau dấu phẩy / chấm phẩy / khoảng trắng) một mã. URL
 * không bị cắt theo khoảng trắng bên trong vì URL không chứa khoảng trắng. Trùng thì gộp; quá
 * `META_AD_POST_BATCH_MAX` thì phần thừa được ĐẾM và báo, không cắt im lặng. Link chia sẻ
 * `fb.me/adspreview/…` đi riêng vào `previewLinks` (cũng gộp trùng theo khoá).
 */
export function parseAdIdList(text: string, max = META_AD_POST_BATCH_MAX): AdIdList {
  const tokens = (text ?? "").split(/[\n\r,;\t ]+/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const adIds: string[] = [];
  const invalid: { raw: string; reason: string }[] = [];
  const previewLinks: AdPreviewLink[] = [];
  let duplicates = 0;
  let overflow = 0;
  for (const token of tokens) {
    const link = parseAdPreviewLink(token);
    if (link) {
      if (seen.has(link.key)) duplicates += 1;
      else {
        seen.add(link.key);
        previewLinks.push(link);
      }
      continue;
    }
    const r = normalizeAdIdInput(token);
    if (!r.ok) {
      invalid.push({ raw: r.raw, reason: r.reason });
      continue;
    }
    if (seen.has(r.adId)) {
      duplicates += 1;
      continue;
    }
    seen.add(r.adId);
    if (adIds.length >= max) overflow += 1;
    else adIds.push(r.adId);
  }
  return { adIds, invalid, duplicates, overflow, previewLinks };
}

export type ParsedStory = { objectStoryId: string; pageId: string; postId: string };

/**
 * `"<page_id>_<post_id>"` → hai phần, GIỮ chuỗi gốc. Chỉ nhận đúng hai khối số nối bằng MỘT gạch
 * dưới; mọi hình dạng khác trả `null` — không cố cứu (cùng tinh thần `pageIdFromStoryId`).
 */
export function parseObjectStoryId(raw: string | null | undefined): ParsedStory | null {
  const s = (raw ?? "").trim();
  const m = /^(\d{5,25})_(\d{1,25})$/.exec(s);
  return m ? { objectStoryId: s, pageId: m[1], postId: m[2] } : null;
}

/** Trường nào của creative đã cho ra bài viết — lưu để truy nguyên (mục 8.7). */
export const POST_RESOLUTION_SOURCES = ["EFFECTIVE_OBJECT_STORY_ID", "OBJECT_STORY_ID"] as const;
export type PostResolutionSource = (typeof POST_RESOLUTION_SOURCES)[number];

export const POST_RESOLUTION_SOURCE_LABEL: Record<PostResolutionSource, string> = {
  EFFECTIVE_OBJECT_STORY_ID: "effective_object_story_id",
  OBJECT_STORY_ID: "object_story_id (dự phòng)",
};

export type CreativeStoryFields = { effectiveObjectStoryId?: string | null; objectStoryId?: string | null };

/**
 * THỨ TỰ ƯU TIÊN DUY NHẤT: `effective_object_story_id` → `object_story_id`.
 *
 * `effective_…` là bài Meta THẬT SỰ phân phối (với quảng cáo dựng từ `object_story_spec` — tức dark
 * post của "Tạo quảng cáo" — chỉ trường này có giá trị). `object_story_id` là bài có sẵn khi quảng
 * cáo dùng "bài viết hiện có"; nó chỉ được dùng khi trường đầu vắng. Trường có mặt nhưng sai hình
 * dạng thì bỏ qua và thử trường sau — không bao giờ tách bừa.
 */
export function pickStoryFromCreative(creative: CreativeStoryFields | null | undefined): (ParsedStory & { source: PostResolutionSource }) | null {
  if (!creative) return null;
  const effective = parseObjectStoryId(creative.effectiveObjectStoryId);
  if (effective) return { ...effective, source: "EFFECTIVE_OBJECT_STORY_ID" };
  const plain = parseObjectStoryId(creative.objectStoryId);
  if (plain) return { ...plain, source: "OBJECT_STORY_ID" };
  return null;
}

/**
 * Link mở bài. `permalink_url` Meta trả là lời khai của nguồn; khi không đọc được (token thiếu quyền
 * trang) thì dựng `facebook.com/<page_id>_<post_id>` — ĐỊA CHỈ dựng từ hai mã THẬT, không phải một mã
 * đoán, và màn hình ghi rõ đó là link dựng. Link dựng KHÔNG được lưu vào `permalink_url`.
 */
export function postOpenUrl(story: { permalinkUrl?: string | null; objectStoryId?: string | null }): { url: string; constructed: boolean } | null {
  const permalink = (story.permalinkUrl ?? "").trim();
  if (/^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(permalink)) return { url: permalink, constructed: false };
  const parsed = parseObjectStoryId(story.objectStoryId);
  return parsed ? { url: `https://www.facebook.com/${parsed.objectStoryId}`, constructed: true } : null;
}

// ─────────────────────────── LỖI ───────────────────────────

export const META_AD_POST_ERRORS = [
  "INVALID_AD_ID",
  "AD_NOT_FOUND",
  "NO_ACCESS",
  "TOKEN_EXPIRED",
  "MISSING_PERMISSION",
  "CREATIVE_NOT_FOUND",
  "POST_NOT_RESOLVED",
  "META_RATE_LIMIT",
  "META_API_ERROR",
  "NOT_CONFIGURED",
] as const;
export type MetaAdPostError = (typeof META_AD_POST_ERRORS)[number];

/** Câu cho người đọc: nói điều gì đã xảy ra VÀ phải làm gì. Không bao giờ chứa token hay nguyên văn phản hồi Graph. */
export const META_AD_POST_ERROR_LABEL: Record<MetaAdPostError, string> = {
  INVALID_AD_ID: "Mã không hợp lệ — không phải một mẩu quảng cáo.",
  AD_NOT_FOUND: "Meta không tìm thấy mẩu quảng cáo này (có thể đã xoá, hoặc gõ sai mã).",
  NO_ACCESS: "Tài khoản Meta của ERP không đọc được quảng cáo này — hoặc mã không tồn tại, hoặc tài khoản quảng cáo chứa nó chưa được giao cho System User (Meta trả chung một lỗi cho hai trường hợp).",
  TOKEN_EXPIRED: "Kết nối Meta đã hết hạn hoặc bị thu hồi — cần cấp lại token System User (Kết nối dữ liệu → Facebook).",
  MISSING_PERMISSION: "Token Meta thiếu quyền ads_read — cấp thêm quyền cho System User rồi tạo lại token.",
  CREATIVE_NOT_FOUND: "Mẩu quảng cáo không có creative đọc được.",
  POST_NOT_RESOLVED: "Meta không trả bài viết nào cho creative này (không có effective_object_story_id lẫn object_story_id) — ERP không đoán Post ID.",
  META_RATE_LIMIT: "Meta đang giới hạn tần suất gọi — thử lại sau vài phút.",
  META_API_ERROR: "Meta trả lỗi không xác định — thử lại sau; nếu lặp lại, xem nhật ký máy chủ.",
  NOT_CONFIGURED: "Tổ chức này chưa có kết nối Meta (chưa cấu hình token System User).",
};

/**
 * Lỗi có thể hết khi thử lại — đường tự đồng bộ KHÔNG được coi chúng là "mẩu không tồn tại". Đánh
 * `missing = true` vì một lần hết hạn mức là để dòng đó nằm im 7 ngày và mất mối nối bài viết.
 */
export const TRANSIENT_META_ERRORS: ReadonlySet<MetaAdPostError> = new Set(["TOKEN_EXPIRED", "MISSING_PERMISSION", "META_RATE_LIMIT", "META_API_ERROR", "NOT_CONFIGURED"]);

/** Hình dạng lỗi Graph sau khi đã bóc khỏi phản hồi — KHÔNG mang token, KHÔNG mang URL. */
export type MetaGraphErrorInfo = {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  type: string;
  message: string;
  fbtraceId: string;
};

/** Mã Graph cho giới hạn tần suất: ứng dụng (4), người dùng (17), trang (32), tuỳ chỉnh (613), Marketing API (80000–80014). */
function isRateLimitCode(code: number | null) {
  return code !== null && ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014));
}

/**
 * Lỗi Graph → một mã ổn định. Đọc MÃ trước, câu chữ chỉ để tách những ca Graph dùng chung mã 100.
 *
 * · 190 → token hết hạn / bị thu hồi / sai.
 * · 10 và dải 200–299 → thiếu quyền (permission).
 * · 100 + subcode 33 → "không tồn tại HOẶC thiếu quyền" — Meta không tách hai ca, ERP cũng không
 *   bịa ra cách tách: gọi là `NO_ACCESS` và câu chữ nói rõ cả hai khả năng.
 * · 100 + "nonexisting field (creative)" → mã là một nút KHÁC (chiến dịch / nhóm) ⇒ `INVALID_AD_ID`.
 * · 803 → mã không tồn tại.
 */
export function classifyMetaError(info: Partial<MetaGraphErrorInfo> | null | undefined): MetaAdPostError {
  const code = info?.code ?? null;
  const subcode = info?.subcode ?? null;
  const message = (info?.message ?? "").toLowerCase();
  if (code === 190 || subcode === 463 || subcode === 467) return "TOKEN_EXPIRED";
  if (isRateLimitCode(code)) return "META_RATE_LIMIT";
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return "MISSING_PERMISSION";
  if (code === 803) return "AD_NOT_FOUND";
  if (code === 100) {
    if (/nonexisting field/.test(message) && /node type/.test(message)) return "INVALID_AD_ID";
    if (subcode === 33 || /does not exist|missing permissions/.test(message)) return "NO_ACCESS";
    return "META_API_ERROR";
  }
  if (info?.httpStatus === 429) return "META_RATE_LIMIT";
  return "META_API_ERROR";
}

// ─────────────────────────── KẾT QUẢ ───────────────────────────

/**
 * Một mẩu đã tra. `ok: true` nghĩa là CÓ BÀI VIẾT; mẩu tra được mà không có bài là `ok: false` với
 * `POST_NOT_RESOLVED`, nhưng vẫn mang tên / chiến dịch / creative đã đọc được — mất những thứ đó chỉ
 * vì thiếu bài là vứt dữ liệu thật.
 */
export type AdPostResolution = {
  adId: string;
  ok: boolean;
  error: MetaAdPostError | null;
  /** Câu cho người đọc (đã che bí mật). */
  message: string;
  /** Lỗi Graph gốc (đã che) — để gỡ lỗi, không in lên màn hình chính. */
  graphError: MetaGraphErrorInfo | null;
  /** Meta đã trả nút mẩu quảng cáo (tên, chiến dịch đọc được) — kể cả khi chưa ra bài. */
  adFound: boolean;
  adName: string;
  adStatus: string;
  adAccountId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  campaignName: string;
  creativeId: string | null;
  pageId: string | null;
  postId: string | null;
  /** Chuỗi `<page_id>_<post_id>` đã DÙNG (theo `resolutionSource`). */
  objectStoryId: string | null;
  /** Hai trường thô của creative, giữ nguyên để truy nguyên. */
  rawEffectiveObjectStoryId: string | null;
  rawObjectStoryId: string | null;
  resolutionSource: PostResolutionSource | null;
  permalinkUrl: string | null;
  pageName: string | null;
  pageNameSource: "META" | "ERP_FANPAGE" | null;
  resolvedAt: string;
};

export function emptyResolution(adId: string, resolvedAt: string): AdPostResolution {
  return {
    adId,
    ok: false,
    error: null,
    message: "",
    graphError: null,
    adFound: false,
    adName: "",
    adStatus: "",
    adAccountId: null,
    adsetId: null,
    campaignId: null,
    campaignName: "",
    creativeId: null,
    pageId: null,
    postId: null,
    objectStoryId: null,
    rawEffectiveObjectStoryId: null,
    rawObjectStoryId: null,
    resolutionSource: null,
    permalinkUrl: null,
    pageName: null,
    pageNameSource: null,
    resolvedAt,
  };
}
