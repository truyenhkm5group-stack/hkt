import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, IntegrationError, num, sleep, str } from "@/lib/integrations/http";

export type FbAdAccount = { id: string; accountId: string; name: string; currency: string; status: number; relation: "owned" | "client" };

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

const THROTTLE_MS = 150;
let lastCallAt = 0;

/** Client Facebook Marketing API (chỉ đọc): tài khoản quảng cáo trong Business Manager và insights theo ngày × chiến dịch */
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

  /** Insights theo ngày × chiến dịch trong khoảng [since, until] (YYYY-MM-DD, giờ tài khoản) */
  async campaignInsights(accountId: string, since: string, until: string): Promise<FbCampaignInsight[]> {
    const rows: FbCampaignInsight[] = [];
    const params = {
      level: "campaign",
      fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,date_start,date_stop",
      time_increment: 1,
      time_range: { since, until },
      limit: 500,
    };
    for await (const item of this.paginate(`act_${accountId}/insights`, params)) {
      const actions = asArray(item.actions).map(asRecord);
      const values = asArray(item.action_values).map(asRecord);
      const sumActions = (list: Record<string, unknown>[], test: (type: string) => boolean) => list.filter((a) => test(str(a.action_type))).reduce((s, a) => s + num(a.value), 0);
      rows.push({
        accountId,
        campaignId: str(item.campaign_id),
        campaignName: str(item.campaign_name),
        date: str(item.date_start).slice(0, 10),
        spend: num(item.spend),
        impressions: Math.round(num(item.impressions)),
        clicks: Math.round(num(item.clicks)),
        messages: Math.round(sumActions(actions, (t) => /messaging_conversation_started|total_messaging_connection|messaging_first_reply/.test(t))),
        leads: Math.round(sumActions(actions, (t) => t === "lead" || t === "onsite_conversion.lead_grouped" || /^offsite_conversion\.fb_pixel_lead$/.test(t))),
        purchases: Math.round(sumActions(actions, (t) => /^(omni_purchase|purchase|onsite_web_purchase|offsite_conversion\.fb_pixel_purchase|onsite_conversion\.purchase)$/.test(t))),
        purchaseValue: sumActions(values, (t) => /^(omni_purchase|purchase|onsite_web_purchase|offsite_conversion\.fb_pixel_purchase|onsite_conversion\.purchase)$/.test(t)),
        raw: item,
      });
    }
    return rows;
  }
}

let cached: FacebookAdsClient | null = null;
export function getFacebookAdsClient() {
  if (!cached) cached = new FacebookAdsClient();
  return cached;
}
