/**
 * ═══════════ AD ID → CREATIVE → BÀI VIẾT (kể cả dark post) ═══════════
 *
 * Hỏi Meta Marketing API, không hỏi gì khác: không đọc link xem trước, không cào HTML, không mở
 * trình duyệt. Graph là nguồn sự thật duy nhất cho câu "mẩu này quảng bá bài nào" — kể cả bài ẩn mà
 * "Tạo quảng cáo" dựng từ `object_story_spec`, thứ không có trên dòng thời gian của fanpage.
 *
 * Luồng cho MỖI mã (lô 50 mã một lời gọi):
 *   1. `GET /?ids=…&fields=…,creative{id,effective_object_story_id,object_story_id}`
 *   2. mẩu đọc được nhưng phần mở rộng `creative{…}` hỏng ⇒ đọc lại mẩu với `creative` KHÔNG mở rộng
 *   3. creative có id mà thiếu cả hai trường bài ⇒ `GET /<creative_id>?fields=…` (dự phòng)
 *   4. `pickStoryFromCreative`: effective → object_story; không có ⇒ `POST_NOT_RESOLVED`, KHÔNG đoán
 *   5. bổ sung (không bắt buộc): tên fanpage, `permalink_url` — hỏng thì bỏ trống, không làm hỏng mã
 *
 * Mỗi mã có kết quả RIÊNG: một mẩu hết quyền không kéo cả lô xuống (mục 10 của yêu cầu).
 * Tệp này không đọc/ghi CSDL — tên fanpage của ERP được truyền vào qua `erpPageNames`.
 */
import type { GraphNodeResult } from "@/lib/integrations/facebook/client";
import { asRecord, str } from "@/lib/integrations/http";
import { isUsableAdId } from "@/lib/constants/ads-identity";
import {
  classifyMetaError,
  emptyResolution,
  META_AD_POST_ERROR_LABEL,
  pickStoryFromCreative,
  postOpenUrl,
  type AdPostResolution,
  type MetaAdPostError,
  type MetaGraphErrorInfo,
} from "@/lib/constants/meta-ad-post";

/** Cổng đọc Graph mà bộ tra cần — `FacebookAdsClient` thoả sẵn; kiểm thử truyền bản giả. */
export type MetaAdPostGraph = {
  readNodes(ids: string[], fields: string): Promise<Map<string, GraphNodeResult>>;
  readNode(id: string, fields: string): Promise<GraphNodeResult>;
};

const AD_BASE_FIELDS = "id,name,status,effective_status,account_id,adset_id,campaign_id,campaign{id,name}";
export const AD_POST_FIELDS = `${AD_BASE_FIELDS},creative{id,effective_object_story_id,object_story_id}`;
/** Không mở rộng creative — chỉ lấy `creative.id`, rồi đọc creative ở lời gọi riêng. */
export const AD_POST_FIELDS_FLAT = `${AD_BASE_FIELDS},creative`;
export const CREATIVE_STORY_FIELDS = "id,effective_object_story_id,object_story_id";

/** Lỗi của CẢ KẾT NỐI: thử lại cách khác cho mã này cũng vô ích. */
const CONNECTION_ERRORS: ReadonlySet<MetaAdPostError> = new Set(["TOKEN_EXPIRED", "META_RATE_LIMIT", "NOT_CONFIGURED"]);

function fail(r: AdPostResolution, error: MetaAdPostError, graphError: MetaGraphErrorInfo | null = null): AdPostResolution {
  return { ...r, ok: false, error, graphError, message: META_AD_POST_ERROR_LABEL[error] };
}

function fillAd(r: AdPostResolution, node: Record<string, unknown>): AdPostResolution {
  const campaign = asRecord(node.campaign);
  return {
    ...r,
    adFound: true,
    adName: str(node.name),
    adStatus: str(node.effective_status) || str(node.status),
    adAccountId: str(node.account_id).replace(/^act_/, "") || null,
    adsetId: str(node.adset_id) || null,
    campaignId: str(node.campaign_id) || str(campaign.id) || null,
    campaignName: str(campaign.name),
  };
}

async function resolveOne(adId: string, first: GraphNodeResult | undefined, graph: MetaAdPostGraph, at: string): Promise<AdPostResolution> {
  let r = emptyResolution(adId, at);
  let result = first ?? ({ kind: "absent" } as GraphNodeResult);

  if (result.kind === "error") {
    const code = classifyMetaError(result.error);
    if (CONNECTION_ERRORS.has(code) || code === "INVALID_AD_ID") return fail(r, code, result.error);
    // Bước 2: phần mở rộng `creative{…}` có thể là thứ hỏng (thiếu quyền trên creative), không phải mẩu.
    const flat = await graph.readNode(adId, AD_POST_FIELDS_FLAT);
    if (flat.kind !== "node") return fail(r, code, result.error);
    result = flat;
  }
  if (result.kind === "absent") return fail(r, "AD_NOT_FOUND");

  r = fillAd(r, result.node);
  const creative = asRecord(result.node.creative);
  const creativeId = str(creative.id);
  if (!creativeId) return fail(r, "CREATIVE_NOT_FOUND");

  let rawEffective = str(creative.effective_object_story_id) || null;
  let rawObject = str(creative.object_story_id) || null;
  if (!rawEffective && !rawObject) {
    // Bước 3: đọc thẳng creative — một số phiên bản API không trả trường này trong phần mở rộng lồng.
    const c = await graph.readNode(creativeId, CREATIVE_STORY_FIELDS);
    if (c.kind === "error") {
      const code = classifyMetaError(c.error);
      return fail({ ...r, creativeId }, CONNECTION_ERRORS.has(code) ? code : "CREATIVE_NOT_FOUND", c.error);
    }
    if (c.kind === "absent") return fail({ ...r, creativeId }, "CREATIVE_NOT_FOUND");
    rawEffective = str(c.node.effective_object_story_id) || null;
    rawObject = str(c.node.object_story_id) || null;
  }

  r = { ...r, creativeId, rawEffectiveObjectStoryId: rawEffective, rawObjectStoryId: rawObject };
  const story = pickStoryFromCreative({ effectiveObjectStoryId: rawEffective, objectStoryId: rawObject });
  if (!story) return fail(r, "POST_NOT_RESOLVED");
  return { ...r, ok: true, error: null, message: "Đã tìm thấy bài viết.", pageId: story.pageId, postId: story.postId, objectStoryId: story.objectStoryId, resolutionSource: story.source };
}

export type ResolveAdPostsDeps = {
  graph: MetaAdPostGraph;
  /** Tên fanpage trong sổ `fanpages` của ERP — dùng khi Meta không cho đọc tên trang. */
  erpPageNames?: (pageIds: string[]) => Promise<Map<string, string>>;
  now?: () => Date;
};

/**
 * Tra một danh sách Ad ID (đã chuẩn hoá). Trả đúng MỘT kết quả cho mỗi mã, theo thứ tự đầu vào.
 * Chỉ ném khi cả kết nối không dùng được (`ConnectorUnavailableError`) — người gọi đổi nó thành
 * `NOT_CONFIGURED` cho mọi mã.
 */
export async function resolveAdPosts(adIds: string[], deps: ResolveAdPostsDeps): Promise<AdPostResolution[]> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const order = [...new Set(adIds.map((x) => x.trim()).filter(Boolean))];
  const valid = order.filter((id) => isUsableAdId(id));
  const nodes = valid.length ? await deps.graph.readNodes(valid, AD_POST_FIELDS) : new Map<string, GraphNodeResult>();

  const out: AdPostResolution[] = [];
  let connectionError: { code: MetaAdPostError; error: MetaGraphErrorInfo | null } | null = null;
  for (const id of order) {
    if (!isUsableAdId(id)) {
      out.push(fail(emptyResolution(id, at), "INVALID_AD_ID"));
      continue;
    }
    // Token hết hạn / bị giới hạn tần suất ở một mã thì mã sau cũng thế — không gọi thêm cho có.
    if (connectionError) {
      out.push(fail(emptyResolution(id, at), connectionError.code, connectionError.error));
      continue;
    }
    const r = await resolveOne(id, nodes.get(id), deps.graph, at);
    if (r.error && CONNECTION_ERRORS.has(r.error)) connectionError = { code: r.error, error: r.graphError };
    out.push(r);
  }

  // ── Bổ sung KHÔNG bắt buộc: tên fanpage và permalink. Hỏng thì để trống — không đổi kết luận.
  const found = out.filter((r) => r.ok && r.pageId && r.objectStoryId);
  if (!found.length || connectionError) return out;
  const pageIds = [...new Set(found.map((r) => r.pageId as string))];
  const storyIds = [...new Set(found.map((r) => r.objectStoryId as string))];
  const [pages, posts] = await Promise.all([
    deps.graph.readNodes(pageIds, "id,name").catch(() => new Map<string, GraphNodeResult>()),
    deps.graph.readNodes(storyIds, "id,permalink_url").catch(() => new Map<string, GraphNodeResult>()),
  ]);
  const metaNames = new Map<string, string>();
  for (const [id, res] of pages) if (res.kind === "node" && str(res.node.name)) metaNames.set(id, str(res.node.name));
  const thieuTen = pageIds.filter((id) => !metaNames.has(id));
  const erpNames = thieuTen.length && deps.erpPageNames ? await deps.erpPageNames(thieuTen).catch(() => new Map<string, string>()) : new Map<string, string>();

  return out.map((r) => {
    if (!r.ok || !r.pageId || !r.objectStoryId) return r;
    const post = posts.get(r.objectStoryId);
    const permalink = post?.kind === "node" ? str(post.node.permalink_url) : "";
    // Chỉ nhận permalink là link facebook.com THẬT (`postOpenUrl` từ chối mọi thứ khác).
    const verified = permalink && postOpenUrl({ permalinkUrl: permalink })?.constructed === false ? permalink : null;
    const metaName = metaNames.get(r.pageId);
    const erpName = erpNames.get(r.pageId);
    return {
      ...r,
      permalinkUrl: verified,
      pageName: metaName ?? erpName ?? null,
      pageNameSource: metaName ? "META" : erpName ? "ERP_FANPAGE" : null,
    };
  });
}
