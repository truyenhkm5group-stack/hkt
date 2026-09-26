/**
 * ═══════════ BÀI QUẢNG CÁO CỦA MỘT MẪU — CHÉP TỪ MẪU, CHỈ THAY BỐN THỨ ═══════════
 *
 * Hàm THUẦN: không đọc CSDL, không gọi mạng. Vào là `object_story_spec` của mẩu quảng cáo MẪU (người
 * dựng sẵn trong chiến dịch test) và nội dung của một mẫu đã duyệt; ra là `object_story_spec` mới.
 *
 * Máy chỉ thay: ẢNH (`image_hash`), CÂU CHỮ, TIÊU ĐỀ, và ÉP `page_id` về fanpage đã khai. Mọi thứ
 * còn lại — nút kêu gọi, đường dẫn, lời chào tin nhắn, tài khoản Instagram — chép NGUYÊN, vì đó là
 * những quyết định đòi phán đoán mà ERP không có dữ liệu để tự đưa ra (`docs/creative-loop.md` §2).
 *
 * ─── KIỂU MẪU LẠ THÌ TỪ CHỐI, KHÔNG ĐOÁN ───
 *
 * Chỉ hai kiểu được hỗ trợ: `link_data` (ảnh đơn kèm liên kết / nút nhắn tin) và `photo_data` (bài
 * ảnh). Video, băng chuyền (carousel — `child_attachments` có phần tử), `template_data`
 * đều bị trả lỗi: đổi một băng chuyền thành một ảnh đơn là đoán hình dạng quảng cáo thay người dựng,
 * và quảng cáo khác hình dạng với mẫu thì số đo của nó không so được với các mẫu cùng lô.
 *
 * ─── MẪU LÀ QUẢNG CÁO ĐỘNG (`asset_feed_spec`) — chủ shop 26/09/2026 ───
 *
 * Mẩu mẫu của shop là quảng cáo ĐỘNG (Facebook tự ghép ảnh / câu chữ), và "Đăng camp" dừng ở lỗi "mẩu mẫu không
 * được hỗ trợ". Quảng cáo động dạng ẢNH ĐƠN (`ad_formats` chỉ `SINGLE_IMAGE`, hoặc không khai) mang đúng những quyết
 * định người đã đưa ra: NÚT kêu gọi (`call_to_action_types`), ĐƯỜNG DẪN (`link_urls`), LỜI CHÀO tin nhắn
 * (`additional_data.page_welcome_message`), mô tả (`descriptions`). Máy dựng từ chúng MỘT `link_data` ảnh đơn: ảnh +
 * câu chữ + tiêu đề của mẫu, nút / đường dẫn / lời chào CHÉP của mẫu — không đoán thứ gì mẫu không nói. Nút nhắn tin
 * (`MESSAGE_PAGE`) không khai đường dẫn ⇒ đường dẫn Messenger chuẩn của Facebook. Mẫu động có video / băng chuyền /
 * nhiều nút / nhiều đường dẫn ⇒ vẫn từ chối (chọn một trong nhiều là đoán ý người dựng).
 */

export type StorySpecContent = {
  /** Fanpage đứng tên bài — lấy từ cấu hình, KHÔNG từ mẩu mẫu. */
  pageId: string;
  /** `image_hash` Facebook trả về sau khi tải ảnh của mẫu lên. */
  imageHash: string;
  primaryText: string;
  headline: string;
};

export type StorySpecResult = { ok: true; kind: "link_data" | "photo_data"; spec: Record<string, unknown>; fromAssetFeed?: boolean } | { ok: false; error: string };

/** Đường dẫn Facebook quy định cho quảng cáo "Gửi tin nhắn" (Click-to-Messenger) khi mẫu không khai đường dẫn nào. */
export const MESSENGER_DOC_LINK = "https://fb.com/messenger_doc/";

const UNSUPPORTED_KEYS = ["video_data", "template_data", "text_data"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Bản sao sâu qua JSON — `object_story_spec` là JSON thuần, và không được sửa vào đối tượng của nơi gọi. */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function unsupported(detail: string): StorySpecResult {
  return { ok: false, error: `Mẩu mẫu không được hỗ trợ: ${detail}. Vòng mẫu chỉ chép được bài ẢNH ĐƠN (link_data) hoặc bài ẢNH (photo_data) — máy không đoán hình dạng quảng cáo.` };
}

function texts(v: unknown, key: string): string[] {
  return Array.isArray(v) ? v.map((x) => (isRecord(x) && typeof x[key] === "string" ? (x[key] as string).trim() : "")).filter(Boolean) : [];
}

/**
 * Bài ảnh đơn dựng từ mẫu QUẢNG CÁO ĐỘNG — xem đầu tệp. `template` là `object_story_spec` đi kèm (thường chỉ có
 * `page_id` / tài khoản Instagram — chép nguyên phần ấy, bỏ mọi khối bài).
 */
function fromAssetFeed(template: unknown, feed: Record<string, unknown>, content: StorySpecContent): StorySpecResult {
  const formats = Array.isArray(feed.ad_formats) ? feed.ad_formats.filter((x): x is string => typeof x === "string") : [];
  const khac = formats.filter((f) => f !== "SINGLE_IMAGE" && f !== "AUTOMATIC_FORMAT");
  if (khac.length) return unsupported(`quảng cáo động dạng ${khac.join(", ")}`);
  if (Array.isArray(feed.videos) && feed.videos.length > 0 && !(Array.isArray(feed.images) && feed.images.length > 0)) return unsupported("quảng cáo động bằng video");
  const ctas = Array.isArray(feed.call_to_action_types) ? [...new Set(feed.call_to_action_types.filter((x): x is string => typeof x === "string" && x !== ""))] : [];
  if (ctas.length === 0) return unsupported("quảng cáo động không khai nút kêu gọi (call_to_action_types)");
  if (ctas.length > 1) return unsupported(`quảng cáo động có ${ctas.length} nút kêu gọi (${ctas.join(", ")}) — không chọn thay người dựng`);
  const cta = ctas[0];
  const links = [...new Set(texts(feed.link_urls, "website_url"))];
  if (links.length > 1) return unsupported(`quảng cáo động có ${links.length} đường dẫn — không chọn thay người dựng`);
  const link = links[0] ?? (cta === "MESSAGE_PAGE" ? MESSENGER_DOC_LINK : "");
  if (!link) return unsupported("quảng cáo động không khai đường dẫn (link_urls)");

  const base: Record<string, unknown> = isRecord(template) ? clone(template) : {};
  for (const k of ["link_data", "photo_data", "video_data", "template_data", "text_data"]) delete base[k];
  base.page_id = content.pageId;
  const linkData: Record<string, unknown> = {
    image_hash: content.imageHash,
    message: content.primaryText,
    name: content.headline,
    link,
    call_to_action: { type: cta, value: cta === "MESSAGE_PAGE" ? { app_destination: "MESSENGER" } : { link } },
  };
  const desc = texts(feed.descriptions, "text");
  if (desc.length === 1) linkData.description = desc[0];
  const extra = isRecord(feed.additional_data) ? feed.additional_data : null;
  if (extra && extra.page_welcome_message !== undefined && extra.page_welcome_message !== null) linkData.page_welcome_message = clone(extra.page_welcome_message);
  base.link_data = linkData;
  return { ok: true, kind: "link_data", spec: base, fromAssetFeed: true };
}

/**
 * `assetFeed` (tuỳ chọn): khối `asset_feed_spec` của bài mẫu. Có ⇒ bài mẫu là quảng cáo ĐỘNG ⇒ dựng bài ảnh đơn từ
 * nó (`fromAssetFeed`); vắng ⇒ chép `object_story_spec` như cũ.
 */
export function buildObjectStorySpec(template: unknown, content: StorySpecContent, assetFeed?: unknown): StorySpecResult {
  if (!content.pageId.trim()) return { ok: false, error: "Chưa khai fanpage đứng tên bài quảng cáo." };
  if (!content.imageHash.trim()) return { ok: false, error: "Chưa có image_hash của ảnh mẫu." };
  if (!content.primaryText.trim()) return { ok: false, error: "Mẫu chưa có câu chữ." };
  if (isRecord(assetFeed)) return fromAssetFeed(template, assetFeed, content);
  if (!isRecord(template)) return unsupported("không đọc được object_story_spec");

  for (const k of UNSUPPORTED_KEYS) if (template[k] !== undefined && template[k] !== null) return unsupported(`kiểu ${k}`);

  const hasLink = isRecord(template.link_data);
  const hasPhoto = isRecord(template.photo_data);
  if (hasLink && hasPhoto) return unsupported("vừa có link_data vừa có photo_data");

  const spec = clone(template);
  // Fanpage luôn là fanpage của cấu hình: một mẩu mẫu dựng nhầm trên fanpage khác không được kéo bài sang đó.
  spec.page_id = content.pageId;

  if (hasLink) {
    const link = spec.link_data as Record<string, unknown>;
    if (Array.isArray(link.child_attachments) && link.child_attachments.length > 0) return unsupported("băng chuyền (child_attachments)");
    // Ảnh CŨ của mẫu phải đi hết — để lại `picture`/`image_url` thì Facebook có thể hiện ảnh cũ thay ảnh mới.
    // `image_crops` gắn với kích thước của ảnh cũ, áp lên ảnh mới là cắt sai.
    for (const k of ["picture", "image_url", "child_attachments", "image_crops"]) delete link[k];
    link.image_hash = content.imageHash;
    link.message = content.primaryText;
    link.name = content.headline;
    return { ok: true, kind: "link_data", spec };
  }

  if (hasPhoto) {
    const photo = spec.photo_data as Record<string, unknown>;
    // Bài ảnh không có ô tiêu đề — tiêu đề không được nhét vào đâu khác cho "đủ".
    for (const k of ["url", "image_url", "picture"]) delete photo[k];
    photo.image_hash = content.imageHash;
    photo.caption = content.primaryText;
    return { ok: true, kind: "photo_data", spec };
  }

  return unsupported("không có link_data hay photo_data");
}
