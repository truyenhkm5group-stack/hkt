import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, IntegrationError, num, sleep, str } from "@/lib/integrations/http";

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
      // Facebook trả nhiều action_type chồng nhau cho cùng một sự kiện (omni_purchase, purchase, offsite_conversion.fb_pixel_purchase…):
      // chỉ lấy MỘT loại theo thứ tự ưu tiên, không cộng dồn để khỏi nhân đôi/nhân ba.
      const pick = (list: Record<string, unknown>[], patterns: RegExp[]) => {
        for (const pattern of patterns) {
          const found = list.filter((a) => pattern.test(str(a.action_type)));
          if (found.length) return found.reduce((s, a) => s + num(a.value), 0);
        }
        return 0;
      };
      const PURCHASE = [/^omni_purchase$/, /^purchase$/, /^offsite_conversion\.fb_pixel_purchase$/, /^onsite_web_purchase$/, /^onsite_conversion\.purchase$/];
      const MESSAGE = [/messaging_conversation_started_7d$/, /messaging_conversation_started/, /total_messaging_connection$/, /messaging_first_reply$/];
      const LEAD = [/^onsite_conversion\.lead_grouped$/, /^lead$/, /^offsite_conversion\.fb_pixel_lead$/];
      rows.push({
        accountId,
        campaignId: str(item.campaign_id),
        campaignName: str(item.campaign_name),
        date: str(item.date_start).slice(0, 10),
        spend: num(item.spend),
        impressions: Math.round(num(item.impressions)),
        clicks: Math.round(num(item.clicks)),
        messages: Math.round(pick(actions, MESSAGE)),
        leads: Math.round(pick(actions, LEAD)),
        purchases: Math.round(pick(actions, PURCHASE)),
        purchaseValue: pick(values, PURCHASE),
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
