import { sleep } from "./util.js";
import { log } from "./logger.js";

const V1 = "https://pages.fm/api/public_api/v1";
const V2 = "https://pages.fm/api/public_api/v2";
const USER_API = "https://pages.fm/api/v1";

/**
 * Client goi Pancake Public API cho 1 page.
 * Tai lieu: https://developer.pancake.biz/
 * - Token truyen qua query `page_access_token` (khong co header Authorization)
 * - Gioi han 5 request / giay / page -> throttle 220ms giua cac request
 */
export class PancakeClient {
  constructor(pageId, pageAccessToken) {
    if (!pageId || !pageAccessToken) throw new Error("PancakeClient can pageId va pageAccessToken");
    this.pageId = String(pageId);
    this.token = pageAccessToken;
    this._last = 0;
    this._chain = Promise.resolve();
  }

  _throttled(fn) {
    const run = async () => {
      const wait = 220 - (Date.now() - this._last);
      if (wait > 0) await sleep(wait);
      this._last = Date.now();
      return fn();
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async _request(method, url, { query = {}, body, retries = 3 } = {}) {
    const u = new URL(url);
    u.searchParams.set("page_access_token", this.token);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await this._throttled(() =>
        fetch(u, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          // Khong de request treo vo han (Pancake loi "An error occurred" 2026-09-16): qua 30s thi bo, vong poll di tiep
          signal: AbortSignal.timeout(30000),
        })
      );
      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt <= retries) {
          const backoff = 500 * 2 ** attempt;
          log.warn(`Pancake ${method} ${u.pathname} -> ${res.status}, thu lai sau ${backoff}ms`);
          await sleep(backoff);
          continue;
        }
      }
      if (!res.ok || data?.success === false) {
        const msg = data?.message || data?.error || data?.raw || res.statusText;
        throw new Error(`Pancake API ${method} ${u.pathname} loi ${res.status}: ${msg}`);
      }
      return data;
    }
  }

  /** 60 hoi thoai moi nhat. type: ["INBOX"] | ["COMMENT"] ... */
  getConversations(params = {}) {
    return this._request("GET", `${V2}/pages/${this.pageId}/conversations`, { query: params });
  }

  /** Tin nhan trong hoi thoai (moi nhat -> cu nhat), kem ho so khach hang */
  getMessages(conversationId, { current_count } = {}) {
    return this._request(
      "GET",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { query: { current_count } }
    );
  }

  /**
   * Gui tin nhan inbox. Tra ve { success, id }
   * - message: text  HOAC  contentIds: [id tu uploadContent]  (KHONG dung ca 2 cung luc)
   */
  sendInbox(conversationId, message, { senderId, replyMessageId, contentIds } = {}) {
    const body = { action: "reply_inbox" };
    if (contentIds?.length) body.content_ids = contentIds;
    else body.message = message;
    if (senderId) body.sender_id = senderId;
    if (replyMessageId) body.reply_message_id = replyMessageId;
    return this._request(
      "POST",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body }
    );
  }

  /** Tra loi 1 binh luan */
  replyComment(conversationId, messageId, message, { senderId } = {}) {
    const body = { action: "reply_comment", message_id: messageId, message };
    if (senderId) body.sender_id = senderId;
    return this._request(
      "POST",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body }
    );
  }

  /**
   * Nhan tin rieng (Private Reply) tu 1 binh luan FB/IG -> tin di thang vao Messenger cua nguoi binh luan.
   * Pancake chi nhan action "private_replies" (khong phai "private_reply"), bat buoc post_id + message_id + from_id + message.
   * - postId: id bai viet; hoi thoai binh luan co id dang `{post_id}_{comment_id}` nen khong truyen thi tu tach ra
   * - fromId: id nguoi binh luan (message.from.id)
   */
  privateReply(conversationId, messageId, message, { senderId, postId, fromId } = {}) {
    const post = postId || String(conversationId).split("_")[0];
    if (!fromId) throw new Error("private_replies can from_id (id nguoi binh luan)");
    const body = { action: "private_replies", post_id: String(post), message_id: String(messageId), from_id: String(fromId), message };
    if (senderId) body.sender_id = senderId;
    return this._request(
      "POST",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body }
    );
  }

  addTag(conversationId, tagId) {
    return this._request(
      "POST",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/tags`,
      { body: { action: "add", tag_id: String(tagId) } }
    );
  }

  removeTag(conversationId, tagId) {
    return this._request(
      "POST",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/tags`,
      { body: { action: "remove", tag_id: String(tagId) } }
    );
  }

  markRead(conversationId) {
    return this._request(
      "POST",
      `${V1}/pages/${this.pageId}/conversations/${encodeURIComponent(conversationId)}/read`
    );
  }

  /** Upload anh/video len page -> { id, attachment_type } de gui bang content_ids */
  async uploadContent(buffer, filename = "image.jpg", mimeType = "image/jpeg") {
    const u = new URL(`${V1}/pages/${this.pageId}/upload_contents`);
    u.searchParams.set("page_access_token", this.token);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const res = await this._throttled(() => fetch(u, { method: "POST", body: form }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false || !data.id) {
      throw new Error(`Pancake upload_contents loi ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
    }
    return data;
  }

  getTags() {
    return this._request("GET", `${V1}/pages/${this.pageId}/tags`);
  }

  getUsers() {
    return this._request("GET", `${V1}/pages/${this.pageId}/users`);
  }
}

/** Liet ke page cua tai khoan (dung User Access Token, lay o Account -> Personal Settings) */
export async function listPages(userAccessToken) {
  const u = new URL(`${USER_API}/pages`);
  u.searchParams.set("access_token", userAccessToken);
  const res = await fetch(u);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pancake list pages loi ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

/** Sinh page_access_token bang User Access Token cua admin page */
export async function generatePageAccessToken(userAccessToken, pageId) {
  const u = new URL(`${USER_API}/pages/${pageId}/generate_page_access_token`);
  u.searchParams.set("access_token", userAccessToken);
  u.searchParams.set("page_id", pageId);
  const res = await fetch(u, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pancake generate token loi ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
