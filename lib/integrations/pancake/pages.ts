/**
 * Pancake Pages (chat) public API — đọc hội thoại, thẻ hội thoại và tin nhắn.
 * Base: https://pages.fm/api/v1 (bản public_api/v1 trả 406/HTML) · cần access token người dùng (PANCAKE_ACCESS_TOKEN);
 * mỗi page dùng page_access_token (sinh qua generate_page_access_token, cache trong tiến trình); nếu không sinh được thì dùng access_token trực tiếp.
 */
import { env } from "@/lib/env";
import { asArray, asRecord, fetchJson, IntegrationError, int, str } from "@/lib/integrations/http";

export type PancakePage = { id: string; name: string; platform: string };
export type PancakeConversation = { id: string; pageId: string; type: string; tags: string[]; customerName: string; customerId: string; phones: string[]; snippet: string; updatedAt: Date | null; raw: Record<string, unknown> };
export type PancakeMessage = { id: string; text: string; fromId: string; fromName: string; fromPage: boolean; insertedAt: Date | null; hasAttachment: boolean };

function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000);
  const s = str(value);
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export class PancakePagesClient {
  private pageTokens = new Map<string, string>();
  constructor(
    private readonly accessToken = env.pancake.pagesAccessToken,
    private readonly baseUrl = env.pancake.pagesBaseUrl,
  ) {}

  private async call(path: string, query: Record<string, string | number | undefined>, method = "GET"): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const { body, status, text } = await fetchJson(url, { method, headers: { accept: "*/*" }, serviceName: "Pancake Pages", timeoutMs: 30_000, retries: 2 });
    const rec = asRecord(body);
    if (!body || typeof body !== "object") throw new IntegrationError(`Pancake Pages: phản hồi không phải JSON (HTTP ${status}) — kiểm tra PANCAKE_PAGES_BASE_URL`, status, false, text.slice(0, 200));
    if (status >= 400 || rec.success === false) {
      throw new IntegrationError(`Pancake Pages: ${str(rec.message, rec.error, rec.reason) || `HTTP ${status}`}${rec.error_code ? ` (mã ${str(rec.error_code)})` : ""}`, status === 401 || status === 403 ? 401 : status, false, body);
    }
    return rec;
  }

  /** Danh sách page có quyền */
  async listPages(): Promise<PancakePage[]> {
    if (!this.accessToken) throw new IntegrationError("Chưa cấu hình PANCAKE_ACCESS_TOKEN", 400, false);
    const rec = await this.call("pages", { access_token: this.accessToken });
    const categorized = asRecord(rec.categorized);
    const list = [...asArray(categorized.activated), ...asArray(rec.pages), ...asArray(rec.data)];
    const seen = new Set<string>();
    return list
      .map(asRecord)
      .map((p) => ({ id: str(p.id, p.page_id), name: str(p.name, p.username), platform: str(p.platform, "facebook") }))
      .filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
  }

  /** page_access_token cho một page (sinh mới nếu chưa có) */
  async pageToken(pageId: string): Promise<{ key: "page_access_token" | "access_token"; value: string }> {
    const cached = this.pageTokens.get(pageId);
    if (cached) return { key: "page_access_token", value: cached };
    try {
      const rec = await this.call(`pages/${pageId}/generate_page_access_token`, { access_token: this.accessToken }, "POST");
      const token = str(rec.page_access_token, asRecord(rec.data).page_access_token);
      if (token) {
        this.pageTokens.set(pageId, token);
        return { key: "page_access_token", value: token };
      }
    } catch {
      // không sinh được page token → dùng access_token người dùng
    }
    return { key: "access_token", value: this.accessToken };
  }

  /** Hội thoại cập nhật trong khoảng thời gian (mới nhất trước), tối đa `limit` */
  async listConversations(pageId: string, since: Date, until: Date, limit = 200): Promise<PancakeConversation[]> {
    const token = await this.pageToken(pageId);
    const out: PancakeConversation[] = [];
    for (let pageNumber = 1; pageNumber <= 20 && out.length < limit; pageNumber++) {
      const rec = await this.call(`pages/${pageId}/conversations`, {
        [token.key]: token.value,
        since: Math.floor(since.getTime() / 1000),
        until: Math.floor(until.getTime() / 1000),
        page_number: pageNumber,
        page_size: 50,
        order_by: "updated_at",
      });
      const list = asArray(rec.conversations ?? asRecord(rec.data).conversations ?? rec.data).map(asRecord);
      if (!list.length) break;
      for (const c of list) {
        const customer = asRecord(asArray(c.customers)[0] ?? c.customer ?? c.from);
        const phones = [...asArray(c.recent_phone_numbers), ...asArray(customer.phone_numbers)].map((p) => str(asRecord(p).phone_number, p)).filter(Boolean);
        out.push({
          id: str(c.id, c.conversation_id),
          pageId,
          type: str(c.type),
          tags: asArray(c.tags).map((t) => str(asRecord(t).text, asRecord(t).name, t)).filter(Boolean),
          customerName: str(customer.name, asRecord(c.from).name),
          customerId: str(customer.id, customer.fb_id, asRecord(c.from).id),
          phones,
          snippet: str(c.snippet, c.last_message),
          updatedAt: toDate(c.updated_at ?? c.last_message_at ?? c.inserted_at),
          raw: c,
        });
      }
      if (list.length < 50) break;
    }
    return out.slice(0, limit);
  }

  /** Tin nhắn gần nhất của một hội thoại (tối đa ~50). API yêu cầu customer_id của khách trong hội thoại. */
  async listMessages(pageId: string, conversationId: string, customerId: string, count = 50): Promise<PancakeMessage[]> {
    const token = await this.pageToken(pageId);
    const rec = await this.call(`pages/${pageId}/conversations/${conversationId}/messages`, { [token.key]: token.value, customer_id: customerId, current_count: 0, page_size: count });
    const list = asArray(rec.messages ?? asRecord(rec.data).messages).map(asRecord);
    return list.map((m) => {
      const from = asRecord(m.from);
      const fromId = str(from.id, m.from_id);
      return {
        id: str(m.id, m.message_id),
        text: str(m.message, m.original_message, m.text),
        fromId,
        fromName: str(from.name),
        fromPage: fromId === pageId || Boolean(m.from_page) || str(m.type) === "page",
        insertedAt: toDate(m.inserted_at ?? m.created_time ?? m.created_at),
        hasAttachment: asArray(m.attachments).length > 0,
      };
    });
  }

  async testConnection() {
    const pages = await this.listPages();
    return { pages, tokenLength: this.accessToken.length, pageCount: int(pages.length) };
  }
}

let cached: PancakePagesClient | null = null;
export function getPancakePagesClient() {
  if (!cached) cached = new PancakePagesClient();
  return cached;
}
