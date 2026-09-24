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
 * ảnh). Video, băng chuyền (carousel — `child_attachments` có phần tử), mẫu động, `template_data`
 * đều bị trả lỗi: đổi một băng chuyền thành một ảnh đơn là đoán hình dạng quảng cáo thay người dựng,
 * và quảng cáo khác hình dạng với mẫu thì số đo của nó không so được với các mẫu cùng lô.
 */

export type StorySpecContent = {
  /** Fanpage đứng tên bài — lấy từ cấu hình, KHÔNG từ mẩu mẫu. */
  pageId: string;
  /** `image_hash` Facebook trả về sau khi tải ảnh của mẫu lên. */
  imageHash: string;
  primaryText: string;
  headline: string;
};

export type StorySpecResult = { ok: true; kind: "link_data" | "photo_data"; spec: Record<string, unknown> } | { ok: false; error: string };

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

export function buildObjectStorySpec(template: unknown, content: StorySpecContent): StorySpecResult {
  if (!content.pageId.trim()) return { ok: false, error: "Chưa khai fanpage đứng tên bài quảng cáo." };
  if (!content.imageHash.trim()) return { ok: false, error: "Chưa có image_hash của ảnh mẫu." };
  if (!content.primaryText.trim()) return { ok: false, error: "Mẫu chưa có câu chữ." };
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
