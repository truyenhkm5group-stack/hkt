import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, IntegrationError, num, sleep, str } from "@/lib/integrations/http";
import { assertHomeCredentials, ConnectorUnavailableError, perOrganizationClients } from "@/lib/platform/credentials";
import { maskFbSecrets } from "@/lib/constants/fb-token-scopes";
import { classifyMetaError, pickStoryFromCreative, type MetaAdPostError, type MetaGraphErrorInfo, type PostResolutionSource } from "@/lib/constants/meta-ad-post";

export type FbAdAccount = { id: string; accountId: string; name: string; currency: string; status: number; relation: "owned" | "client" };

export type FbAdAccountBilling = FbAdAccount & {
  disableReason: number;
  /** Dư nợ hiện tại theo đơn vị tiền tệ (đã chia offset minor unit) */
  balance: number;
  amountSpent: number;
  spendCap: number;
  fundingSource: string;
  isPrepay: boolean;
  nextBillDate: string;
  raw: Record<string, unknown>;
};

/** Tiền tệ không có đơn vị lẻ: Marketing API trả balance/amount_spent theo đơn vị nguyên (offset 1); còn lại theo cent (offset 100) */
const ZERO_DECIMAL_CURRENCIES = new Set(["VND", "JPY", "KRW", "CLP", "ISK", "PYG", "UGX", "XAF", "XOF", "RWF", "GNF", "KMF", "BIF", "DJF", "VUV", "XPF", "MGA"]);
export function fbMinorOffset(currency: string) {
  return ZERO_DECIMAL_CURRENCIES.has((currency || "").toUpperCase()) ? 1 : 100;
}

export type FbCampaignInsight = {
  accountId: string;
  campaignId: string;
  campaignName: string;
  date: string; // YYYY-MM-DD
  spend: number; // theo tiền tệ tài khoản
  impressions: number;
  clicks: number;
  messages: number;
  leads: number;
  purchases: number;
  purchaseValue: number;
  raw: Record<string, unknown>;
};

/**
 * Một dòng insights ở cấp MẨU QUẢNG CÁO. Mở rộng dòng cấp chiến dịch bằng đúng bốn trường định danh
 * — cố ý không đổi hình dạng phần còn lại, để hai cấp so sánh được với nhau bằng phép cộng.
 */
export type FbAdInsight = FbCampaignInsight & {
  adId: string;
  adName: string;
  adsetId: string;
  adsetName: string;
};

const THROTTLE_MS = 150;
let lastCallAt = 0;

/** Client Facebook Marketing API (chỉ đọc): tài khoản quảng cáo trong Business Manager và insights theo ngày × chiến dịch */
/** Nhóm quảng cáo (adset) — chỉ những trường cần để đi tiếp lên chiến dịch và tài khoản. */
export type FbAdsetInfo = {
  id: string;
  name: string;
  campaignId: string | null;
  accountId: string | null;
  status: string;
  missing: boolean;
  error?: string;
};

export type FbAdInfo = {
  id: string;
  name: string;
  adsetId: string | null;
  campaignId: string | null;
  campaignName: string;
  accountId: string | null;
  status: string;
  missing: boolean;
  error?: string;
  /** Bài viết mà mẩu quảng cáo này quảng bá (phần sau dấu gạch dưới của effective_object_story_id). */
  postId?: string | null;
  /** Chuỗi gốc "<page_id>_<post_id>" — giữ lại để truy nguyên. */
  storyId?: string | null;
  /** Creative của mẩu, và fanpage tách từ `storyId`. */
  creativeId?: string | null;
  pageId?: string | null;
  /** Hai trường thô của creative — `storyId` là trường đã DÙNG theo `pickStoryFromCreative`. */
  rawEffectiveObjectStoryId?: string | null;
  rawObjectStoryId?: string | null;
  postResolutionSource?: PostResolutionSource | null;
  /** Mã lỗi ổn định khi tra hỏng (`classifyMetaError`); `undefined` khi tra được. */
  errorCode?: MetaAdPostError;
  graphError?: MetaGraphErrorInfo;
  /** Lượt tra này CÓ đọc creative không. `false` ⇒ các trường bài viết là CHƯA BIẾT, không được ghi đè. */
  creativeRead?: boolean;
};

/** Lỗi của cả kết nối — gặp ở một mã là biết mọi mã sau cũng hỏng như thế. */
const CONNECTION_FATAL: ReadonlySet<MetaAdPostError> = new Set(["TOKEN_EXPIRED", "MISSING_PERMISSION", "META_RATE_LIMIT"]);

/** Một nút Graph đọc theo mã: có nút · Graph trả lời nhưng không có mã đó · lỗi (đã bóc, đã che). */
export type GraphNodeResult = { kind: "node"; node: Record<string, unknown> } | { kind: "absent" } | { kind: "error"; error: MetaGraphErrorInfo };

/**
 * Lỗi bất kỳ → hình dạng lỗi Graph, ĐÃ CHE. `IntegrationError.body` mang phong bì `{ error: {...} }`
 * nguyên văn của Graph; chỉ bóc đúng sáu trường cần để phân loại và gỡ lỗi. URL (mang token trong
 * query) không bao giờ được chép vào đây.
 */
export function graphErrorInfo(error: unknown): MetaGraphErrorInfo {
  const body = error instanceof IntegrationError ? asRecord(error.body) : {};
  const fb = asRecord(body.error);
  const raw = str(fb.error_user_msg) || str(fb.message) || (error instanceof Error ? error.message : String(error));
  return {
    httpStatus: error instanceof IntegrationError ? error.status : null,
    code: fb.code === undefined ? null : num(fb.code),
    subcode: fb.error_subcode === undefined ? null : num(fb.error_subcode),
    type: str(fb.type),
    message: maskFbSecrets(raw).slice(0, 500),
    fbtraceId: str(fb.fbtrace_id),
  };
}

export class FacebookAdsClient {
  constructor(
    private readonly accessToken = env.facebook.accessToken,
    private readonly businessId = env.facebook.businessId,
    private readonly version = env.facebook.apiVersion,
  ) {
    if (!this.accessToken) throw new IntegrationError("Facebook: chưa cấu hình FACEBOOK_ACCESS_TOKEN", 400);
    if (!this.businessId) throw new IntegrationError("Facebook: chưa cấu hình FACEBOOK_BUSINESS_ID", 400);
  }

  get business() {
    return this.businessId;
  }

  private async get(pathOrUrl: string, params: Record<string, unknown> = {}) {
    // Credential môi trường là của tổ chức nhà — chặn TRƯỚC điều tiết nhịp và trước khi gửi (P12).
    await assertHomeCredentials("facebook");
    const wait = THROTTLE_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const url = pathOrUrl.startsWith("http") ? new URL(pathOrUrl) : new URL(`https://graph.facebook.com/${this.version}/${pathOrUrl.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    if (!url.searchParams.has("access_token")) url.searchParams.set("access_token", this.accessToken);
    const { body, status } = await fetchJson(url, {
      serviceName: "Facebook",
      timeoutMs: 90_000,
      retries: 3,
      // Facebook trả lỗi tạm (code 1, 2, 4, 17, 32, 613) với HTTP 400/500 → cho phép retry khi là lỗi quota
      isRetryableBody: (b) => {
        const code = num(asRecord(asRecord(b).error).code);
        return [1, 2, 4, 17, 32, 613].includes(code);
      },
    }).catch((error: unknown) => {
      if (error instanceof IntegrationError && error.body) {
        const fbError = asRecord(asRecord(error.body).error);
        const message = str(fbError.message);
        const code = num(fbError.code);
        if (message) throw new IntegrationError(`Facebook: ${message}${code ? ` (mã ${code})` : ""}`, code === 190 ? 401 : error.status, false, error.body);
      }
      throw error;
    });
    const record = asRecord(body);
    if (record.error) {
      const fbError = asRecord(record.error);
      throw new IntegrationError(`Facebook: ${str(fbError.message) || "lỗi không xác định"}${fbError.code ? ` (mã ${fbError.code})` : ""}`, num(fbError.code) === 190 ? 401 : status, false, body);
    }
    return record;
  }

  /** Duyệt hết các trang (paging.next) */
  private async *paginate(path: string, params: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
    let record = await this.get(path, params);
    for (;;) {
      for (const item of asArray(record.data)) yield asRecord(item);
      const next = str(asRecord(record.paging).next);
      if (!next) return;
      record = await this.get(next);
    }
  }

  async testConnection() {
    const me = await this.get("me", { fields: "id,name" });
    const business = await this.get(this.businessId, { fields: "id,name" }).catch(() => ({}) as Record<string, unknown>);
    const accounts = await this.listAdAccounts();
    return { ok: true, userName: str(me.name), userId: str(me.id), businessName: str(business.name), accounts };
  }

  /**
   * Token đang chạy mang những quyền gì — `GET /me/permissions`, CHỈ ĐỌC. Kết luận nằm ở hàm thuần
   * `assessFbScopes` (`lib/constants/fb-token-scopes.ts`); hàm này chỉ đổi hình dạng câu trả lời.
   */
  async getPermissions(): Promise<{ permission: string; status: string }[]> {
    const r = await this.get("me/permissions");
    return asArray(r.data)
      .map((x) => asRecord(x))
      .map((x) => ({ permission: str(x.permission), status: str(x.status) }))
      .filter((x) => x.permission);
  }

  /**
   * TOKEN NÀY CỦA ỨNG DỤNG NÀO — `GET /debug_token`, CHỈ ĐỌC (chủ shop 27/09/2026: Đăng camp báo "ứng dụng ở chế độ phát
   * triển" trong khi ứng dụng "ERP" đã Live ⇒ token thuộc một ứng dụng khác). Trả id + tên ứng dụng, loại token
   * (SYSTEM_USER / USER / PAGE), còn hiệu lực không. Không trả chế độ Live / Development — Graph API không cho đọc điều đó.
   */
  async tokenIdentity(): Promise<{ appId: string; appName: string; type: string; isValid: boolean; expiresAt: number | null }> {
    const r = await this.get("debug_token", { input_token: this.accessToken });
    const d = asRecord(r.data);
    const exp = num(d.expires_at);
    return { appId: str(d.app_id), appName: str(d.application), type: str(d.type), isValid: d.is_valid === true, expiresAt: exp > 0 ? exp : null };
  }

  /** Tất cả tài khoản quảng cáo của BM: sở hữu (owned) + được cấp quyền (client) */
  async listAdAccounts(): Promise<FbAdAccount[]> {
    const fields = "id,account_id,name,currency,account_status";
    const out = new Map<string, FbAdAccount>();
    for (const relation of ["owned", "client"] as const) {
      const edge = relation === "owned" ? "owned_ad_accounts" : "client_ad_accounts";
      try {
        for await (const item of this.paginate(`${this.businessId}/${edge}`, { fields, limit: 100 })) {
          const accountId = str(item.account_id) || str(item.id).replace(/^act_/, "");
          if (!accountId || out.has(accountId)) continue;
          out.set(accountId, { id: str(item.id) || `act_${accountId}`, accountId, name: str(item.name) || `act_${accountId}`, currency: str(item.currency) || "VND", status: num(item.account_status), relation });
        }
      } catch (error) {
        // Thiếu quyền business_management với một edge thì vẫn tiếp tục edge còn lại
        if (relation === "client" && out.size) continue;
        throw error;
      }
    }
    return [...out.values()];
  }

  /**
   * Tra thông tin quảng cáo theo ad_id (đơn Pancake ghi ad_id): adset, chiến dịch, tài khoản. Tối đa 50 id / lần gọi;
   * id không tra được (đã xoá / không có quyền) trả về missing.
   */
  async getAdsByIds(ids: string[]): Promise<FbAdInfo[]> {
    const out: FbAdInfo[] = [];
    const clean = [...new Set(ids.map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x)))];
    for (let i = 0; i < clean.length; i += 50) {
      const chunk = clean.slice(i, i + 50);
      let record: Record<string, unknown> = {};
      /**
       * `creative{effective_object_story_id}` cho biết mẩu quảng cáo này quảng bá BÀI VIẾT nào —
       * dạng "<page_id>_<post_id>". Đây là mắt xích để nối đơn chỉ có `post_id` (82% đơn) về chiến
       * dịch, thay vì chỉ nối được 46% đơn có sẵn `ad_id`.
       *
       * XIN THÊM MỘT CÁCH AN TOÀN: nếu token không đủ quyền đọc creative thì Graph API hỏng CẢ LÔ.
       * Nên hỏng là lùi về đúng danh sách trường cũ — mất phần nối mới, KHÔNG mất phần đang chạy.
       */
      const FIELDS_BASE = "id,name,adset_id,campaign_id,account_id,status,campaign{id,name}";
      /*
        Xin CẢ HAI trường bài viết của creative: `effective_object_story_id` là bài Meta thật sự phân
        phối (dark post của "Tạo quảng cáo" chỉ có trường này), `object_story_id` là dự phòng khi
        quảng cáo dùng bài có sẵn. Thứ tự ưu tiên nằm ở MỘT chỗ — `pickStoryFromCreative`.
      */
      const FIELDS_WITH_CREATIVE = `${FIELDS_BASE},creative{id,effective_object_story_id,object_story_id}`;
      // Lượt lùi về FIELDS_BASE KHÔNG đọc creative ⇒ "không có bài" ở lượt đó là CHƯA BIẾT, không phải "không có".
      let creativeRead = true;
      try {
        try {
          record = await this.get("", { ids: chunk.join(","), fields: FIELDS_WITH_CREATIVE });
        } catch {
          creativeRead = false;
          record = await this.get("", { ids: chunk.join(","), fields: FIELDS_BASE });
        }
      } catch (error) {
        // một id lỗi làm hỏng cả lô → tra từng id
        if (chunk.length > 1) {
          for (const [k, id] of chunk.entries()) {
            const one = await this.getAdsByIds([id]);
            out.push(...one);
            /*
              Token hết hạn / hết hạn mức ở một mã thì mọi mã sau cũng thế. Tra tiếp từng mã là 50 lời
              gọi hỏng cho mỗi lô, mỗi giờ — tự gây bão request đúng lúc kết nối đang có vấn đề.
            */
            const code = one[0]?.errorCode;
            if (code && CONNECTION_FATAL.has(code)) {
              for (const rest of [...chunk.slice(k + 1), ...clean.slice(i + 50)]) out.push({ ...one[0], id: rest });
              return out;
            }
          }
          continue;
        }
        const graphError = graphErrorInfo(error);
        out.push({ id: chunk[0], name: "", adsetId: null, campaignId: null, campaignName: "", accountId: null, status: "", missing: true, error: graphError.message, errorCode: classifyMetaError(graphError), graphError });
        continue;
      }
      for (const id of chunk) {
        const item = asRecord(record[id]);
        if (!str(item.id)) {
          out.push({ id, name: "", adsetId: null, campaignId: null, campaignName: "", accountId: null, status: "", missing: true, errorCode: "AD_NOT_FOUND" });
          continue;
        }
        const campaign = asRecord(item.campaign);
        const creative = asRecord(item.creative);
        const rawEffective = str(creative.effective_object_story_id) || null;
        const rawObject = str(creative.object_story_id) || null;
        // "<page_id>_<post_id>" → phần sau dấu gạch dưới là thứ Pancake ghi vào orders.post_id.
        const story = pickStoryFromCreative({ effectiveObjectStoryId: rawEffective, objectStoryId: rawObject });
        out.push({
          id,
          name: str(item.name),
          adsetId: str(item.adset_id) || null,
          campaignId: str(item.campaign_id) || str(campaign.id) || null,
          campaignName: str(campaign.name),
          accountId: str(item.account_id).replace(/^act_/, "") || null,
          status: str(item.status),
          missing: false,
          postId: story?.postId ?? null,
          storyId: story?.objectStoryId ?? null,
          creativeId: str(creative.id) || null,
          pageId: story?.pageId ?? null,
          rawEffectiveObjectStoryId: rawEffective,
          rawObjectStoryId: rawObject,
          postResolutionSource: story?.source ?? null,
          creativeRead,
        });
      }
    }
    return out;
  }

  /**
   * ĐỌC MỘT NÚT Graph theo mã, trả lỗi THÀNH GIÁ TRỊ thay vì ném — người gọi cần phân loại lỗi của
   * TỪNG mã (mẩu này hết quyền, mẩu kia không tồn tại), không phải một ngoại lệ cho cả lượt.
   * `ConnectorUnavailableError` (tổ chức không có token) vẫn NÉM: đó là lỗi của cả lượt.
   */
  async readNode(id: string, fields: string): Promise<GraphNodeResult> {
    try {
      const node = await this.get(id, { fields });
      return Object.keys(node).length ? { kind: "node", node } : { kind: "absent" };
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) throw error;
      return { kind: "error", error: graphErrorInfo(error) };
    }
  }

  /**
   * ĐỌC NHIỀU NÚT CÙNG BỘ TRƯỜNG — `GET /?ids=a,b,…` từng lô 50. Graph hỏng CẢ LÔ khi một mã lỗi,
   * nên lô hỏng thì đọc lại TỪNG mã: một mẩu hết quyền không được kéo 49 mẩu kia xuống theo.
   */
  async readNodes(ids: string[], fields: string): Promise<Map<string, GraphNodeResult>> {
    const out = new Map<string, GraphNodeResult>();
    const clean = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
    for (let i = 0; i < clean.length; i += 50) {
      const chunk = clean.slice(i, i + 50);
      let record: Record<string, unknown> | null = null;
      try {
        record = await this.get("", { ids: chunk.join(","), fields });
      } catch (error) {
        if (error instanceof ConnectorUnavailableError) throw error;
        if (chunk.length === 1) {
          out.set(chunk[0], { kind: "error", error: graphErrorInfo(error) });
          continue;
        }
      }
      if (record === null) {
        for (const [k, id] of chunk.entries()) {
          const one = await this.readNode(id, fields);
          out.set(id, one);
          // Lỗi của cả kết nối ở một mã ⇒ không gọi tiếp cho từng mã còn lại (xem getAdsByIds).
          if (one.kind === "error" && CONNECTION_FATAL.has(classifyMetaError(one.error))) {
            for (const rest of [...chunk.slice(k + 1), ...clean.slice(i + 50)]) out.set(rest, one);
            return out;
          }
        }
        continue;
      }
      for (const id of chunk) {
        const node = asRecord(record[id]);
        out.set(id, Object.keys(node).length ? { kind: "node", node } : { kind: "absent" });
      }
    }
    return out;
  }

  /**
   * Mã các mẩu thuộc MỘT chiến dịch hoặc nhóm quảng cáo (`/<id>/ads`) — cho link Trình quản lý có
   * `selected_campaign_ids` / `selected_adset_ids`. Dừng ở `max` + 1 để người gọi biết là còn nữa mà
   * không kéo hết. Lỗi NÉM lên: người gọi phân loại theo từng chiến dịch / nhóm.
   */
  async listAdIdsUnder(parentId: string, max: number): Promise<{ adIds: string[]; more: boolean }> {
    const adIds: string[] = [];
    for await (const item of this.paginate(`${parentId}/ads`, { fields: "id", limit: 100 })) {
      const id = str(item.id);
      if (!id) continue;
      if (adIds.length >= max) return { adIds, more: true };
      adIds.push(id);
    }
    return { adIds, more: false };
  }

  /**
   * TRA NHÓM QUẢNG CÁO THEO MÃ. Trả về chiến dịch cha và tài khoản — hai thứ cần để quy kết.
   *
   * Tách khỏi `getAdsByIds` vì nút adset KHÔNG có trường `adset_id`/`creative`: xin bộ trường của
   * mẩu quảng cáo trên một adset là Graph trả lỗi #100 và hỏng CẢ LÔ. Một lô hỏng vì một mã sai
   * kiểu thì tra từng mã, đúng cách `getAdsByIds` đã làm.
   */
  async getAdsetsByIds(ids: string[]): Promise<FbAdsetInfo[]> {
    const out: FbAdsetInfo[] = [];
    const clean = [...new Set(ids.map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x)))];
    for (let i = 0; i < clean.length; i += 50) {
      const chunk = clean.slice(i, i + 50);
      let record: Record<string, unknown> = {};
      try {
        record = await this.get("", { ids: chunk.join(","), fields: "id,name,campaign_id,account_id,status,effective_status" });
      } catch (error) {
        if (chunk.length > 1) {
          for (const id of chunk) out.push(...(await this.getAdsetsByIds([id])));
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        out.push({ id: chunk[0], name: "", campaignId: null, accountId: null, status: "", missing: true, error: message });
        continue;
      }
      for (const id of chunk) {
        const item = asRecord(record[id]);
        if (!str(item.id)) {
          out.push({ id, name: "", campaignId: null, accountId: null, status: "", missing: true });
          continue;
        }
        out.push({
          id,
          name: str(item.name),
          campaignId: str(item.campaign_id) || null,
          accountId: str(item.account_id).replace(/^act_/, "") || null,
          status: str(item.effective_status) || str(item.status),
          missing: false,
        });
      }
    }
    return out;
  }

  /**
   * ĐỌC nội dung quảng cáo (ảnh + câu chữ) của MỘT mẩu — cho việc nhập quảng cáo cũ của shop làm
   * nguồn ảnh của vòng mẫu (`lib/creative/import.ts`). Chỉ GET; trả nguyên bản ghi để hàm thuần
   * `pickOwnAdContent()` bóc, vì hình dạng `object_story_spec` đổi theo loại quảng cáo.
   */
  async getAdCreativeContent(adId: string): Promise<Record<string, unknown>> {
    if (!/^\d{5,}$/.test(adId.trim())) throw new IntegrationError(`Facebook: mã quảng cáo không hợp lệ (${adId})`, 400);
    return this.get(adId.trim(), { fields: "name,account_id,creative{id,image_url,image_hash,thumbnail_url,body,title,object_type,video_id,object_story_spec,asset_feed_spec}" });
  }

  /** ĐỌC địa chỉ ảnh gốc theo `image_hash` trong thư viện ảnh của tài khoản. Hash không tra được ⇒ vắng khỏi kết quả. */
  async getAdImageUrls(accountId: string, hashes: string[]): Promise<Record<string, string>> {
    const account = accountId.trim().replace(/^act_/, "");
    const clean = [...new Set(hashes.map((h) => h.trim()).filter(Boolean))];
    if (!/^\d{5,}$/.test(account) || clean.length === 0) return {};
    const out: Record<string, string> = {};
    for await (const item of this.paginate(`act_${account}/adimages`, { hashes: clean, fields: "hash,url" })) {
      const hash = str(item.hash);
      const url = str(item.url);
      if (hash && url) out[hash] = url;
    }
    return out;
  }

  /** Dư nợ, trạng thái, nguồn thanh toán của mọi tài khoản quảng cáo (để cảnh báo ngưỡng thanh toán) */
  async listAdAccountsBilling(): Promise<FbAdAccountBilling[]> {
    // Một số trường có thể không tồn tại ở phiên bản API / loại tài khoản → bỏ trường bị báo lỗi (#100) rồi thử lại
    let fieldList = ["id", "account_id", "name", "currency", "account_status", "disable_reason", "balance", "amount_spent", "spend_cap", "funding_source_details", "is_prepay_account", "next_bill_date"];
    const out = new Map<string, FbAdAccountBilling>();
    for (const relation of ["owned", "client"] as const) {
      const edge = relation === "owned" ? "owned_ad_accounts" : "client_ad_accounts";
      try {
        const items: Record<string, unknown>[] = [];
        for (let attempt = 0; attempt < 6; attempt++) {
          try {
            for await (const item of this.paginate(`${this.businessId}/${edge}`, { fields: fieldList.join(","), limit: 100 })) items.push(item);
            break;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const bad = /nonexisting field \(([a-z_]+)\)/i.exec(msg)?.[1];
            if (!bad || !fieldList.includes(bad) || ["id", "account_id", "balance"].includes(bad)) throw error;
            fieldList = fieldList.filter((f) => f !== bad);
            items.length = 0;
          }
        }
        for (const item of items) {
          const accountId = str(item.account_id) || str(item.id).replace(/^act_/, "");
          if (!accountId || out.has(accountId)) continue;
          const currency = str(item.currency) || "VND";
          const offset = fbMinorOffset(currency);
          const fs = asRecord(item.funding_source_details);
          out.set(accountId, {
            id: str(item.id) || `act_${accountId}`,
            accountId,
            name: str(item.name) || `act_${accountId}`,
            currency,
            status: num(item.account_status),
            relation,
            disableReason: num(item.disable_reason),
            balance: Math.round(num(item.balance) / offset),
            amountSpent: Math.round(num(item.amount_spent) / offset),
            spendCap: Math.round(num(item.spend_cap) / offset),
            fundingSource: str(fs.display_string, fs.type),
            isPrepay: Boolean(item.is_prepay_account),
            nextBillDate: str(item.next_bill_date),
            raw: item,
          });
        }
      } catch (error) {
        if (relation === "client" && out.size) continue;
        throw error;
      }
    }
    return [...out.values()];
  }

  /**
   * ───────────── MỘT BỘ ĐỌC INSIGHTS, HAI CẤP ─────────────
   *
   * Cấp `campaign` và cấp `ad` dùng CHUNG phép bóc `actions` / `action_values`. Viết hai lần là
   * mời hai con số "tin nhắn" khác nhau tồn tại song song, và khi chúng lệch thì không ai biết cái
   * nào đúng — đúng lớp lỗi mà `adsRatios()` đã phải đi dọn một lần ở báo cáo lợi nhuận.
   */
  private async insightItems(accountId: string, since: string, until: string, level: "campaign" | "ad", fields: string) {
    const items: Record<string, unknown>[] = [];
    const params = { level, fields: `${fields},spend,impressions,clicks,actions,action_values,date_start,date_stop`, time_increment: 1, time_range: { since, until }, limit: 500 };
    for await (const item of this.paginate(`act_${accountId}/insights`, params)) items.push(item);
    return items;
  }

  /**
   * Facebook trả nhiều `action_type` chồng nhau cho cùng một sự kiện (omni_purchase, purchase,
   * offsite_conversion.fb_pixel_purchase…): chỉ lấy MỘT loại theo thứ tự ưu tiên, không cộng dồn
   * để khỏi nhân đôi/nhân ba.
   */
  private static metricsOf(item: Record<string, unknown>) {
    const actions = asArray(item.actions).map(asRecord);
    const values = asArray(item.action_values).map(asRecord);
    const pick = (list: Record<string, unknown>[], patterns: RegExp[]) => {
      for (const pattern of patterns) {
        const found = list.filter((a) => pattern.test(str(a.action_type)));
        if (found.length) return found.reduce((sum, a) => sum + num(a.value), 0);
      }
      return 0;
    };
    const PURCHASE = [/^omni_purchase$/, /^purchase$/, /^offsite_conversion\.fb_pixel_purchase$/, /^onsite_web_purchase$/, /^onsite_conversion\.purchase$/];
    const MESSAGE = [/messaging_conversation_started_7d$/, /messaging_conversation_started/, /total_messaging_connection$/, /messaging_first_reply$/];
    const LEAD = [/^onsite_conversion\.lead_grouped$/, /^lead$/, /^offsite_conversion\.fb_pixel_lead$/];
    return {
      date: str(item.date_start).slice(0, 10),
      spend: num(item.spend),
      impressions: Math.round(num(item.impressions)),
      clicks: Math.round(num(item.clicks)),
      messages: Math.round(pick(actions, MESSAGE)),
      leads: Math.round(pick(actions, LEAD)),
      purchases: Math.round(pick(actions, PURCHASE)),
      purchaseValue: pick(values, PURCHASE),
    };
  }

  /** Insights theo ngày × chiến dịch trong khoảng [since, until] (YYYY-MM-DD, giờ tài khoản) */
  async campaignInsights(accountId: string, since: string, until: string): Promise<FbCampaignInsight[]> {
    const items = await this.insightItems(accountId, since, until, "campaign", "campaign_id,campaign_name");
    return items.map((item) => ({
      accountId,
      campaignId: str(item.campaign_id),
      campaignName: str(item.campaign_name),
      ...FacebookAdsClient.metricsOf(item),
      raw: item,
    }));
  }

  /**
   * ───────────── INSIGHTS THEO NGÀY × MẨU QUẢNG CÁO ─────────────
   *
   * Đây là cấp CHI TIẾT NHẤT mà Facebook trả tiền chi, và nó KHÔNG phải một phép phân bổ: mỗi mẩu
   * có số chi thật của nó, cộng lại đúng bằng số của chiến dịch. Nhờ vậy cấp nhóm và cấp chiến dịch
   * trở thành PHÉP CỘNG của cấp mẩu, thay vì ba con số rời nhau.
   *
   * Nó còn trả về cả cây `ad → adset → campaign` kèm TÊN cho mọi mẩu ĐÃ TIÊU TIỀN. Đo production
   * 22/09/2026: `fb_ads` chỉ có **185 dòng** trong khi 30 ngày có **1.096 chiến dịch** tiêu tiền —
   * vì bộ tra danh mục hiện tại chỉ hỏi những `ad_id` ĐÃ xuất hiện trong đơn, nên nó không bao giờ
   * biết một mẩu chưa đẻ ra đơn nào. Đường này lật ngược chiều ấy: đi từ TIỀN ra, không đi từ ĐƠN ra.
   */
  async adInsights(accountId: string, since: string, until: string): Promise<FbAdInsight[]> {
    const items = await this.insightItems(accountId, since, until, "ad", "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name");
    return items.map((item) => ({
      accountId,
      adId: str(item.ad_id),
      adName: str(item.ad_name),
      adsetId: str(item.adset_id),
      adsetName: str(item.adset_name),
      campaignId: str(item.campaign_id),
      campaignName: str(item.campaign_name),
      ...FacebookAdsClient.metricsOf(item),
      raw: item,
    }));
  }
}

/**
 * Một client cho MỖI tổ chức (R-04): nhà giữ đúng một instance như trước; tổ chức khác không có
 * System User token nào ⇒ `ConnectorUnavailableError` ngay tại getter, không dựng client từ token
 * môi trường của nhà.
 */
const clients = perOrganizationClients<FacebookAdsClient>({
  home: () => new FacebookAdsClient(),
  other: (organization) => {
    throw new ConnectorUnavailableError("facebook", organization);
  },
});
export function getFacebookAdsClient() {
  return clients.get();
}
