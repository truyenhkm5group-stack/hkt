import { ImapFlow } from "imapflow";
import { maskSecret, type SmtpCredentials } from "@/lib/integrations/gws-smtp/client";

/**
 * ═══════════ GOOGLE WORKSPACE — ĐỌC HỘP THƯ QUA IMAP (E3, cùng connector `gws-smtp`) ═══════════
 *
 * Đọc thư TRẢ LỜI về hộp thư Google Workspace đã nối ở E2 — CÙNG hộp thư + App Password (App Password của Workspace dùng được
 * cho IMAP), KHÔNG thêm credential nào. `imap.gmail.com:993`, TLS ngay từ đầu, thư viện `imapflow` (phần mở rộng của lựa chọn
 * Google Workspace chủ shop đã duyệt).
 *
 *  · CHỈ ĐỌC: mở INBOX ở chế độ `readOnly` — không đánh dấu đã đọc, không xoá, không di chuyển thư.
 *  · Bước 1 chỉ lấy TIÊU ĐỀ (Message-ID, In-Reply-To, References, From, Auto-Submitted…). Thân thư chỉ được tải khi thư đã được
 *    xác định là thư trả lời cho ERP (nối luồng hoặc khớp đúng một lead) — thư khác không bao giờ được tải nội dung.
 *  · Thân thư: chỉ phần text/plain (không có thì text/html bỏ thẻ), có trần byte; tệp đính kèm KHÔNG BAO GIỜ được tải, chỉ đếm.
 *  · Không log (`logger: false` — imapflow mặc định ghi log qua pino), câu lỗi đã che App Password.
 */

export const GWS_IMAP_HOST = "imap.gmail.com";
export const GWS_IMAP_PORT = 993;

export type InboundHeader = {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string | null;
  fromName: string | null;
  subject: string;
  autoSubmitted: string | null;
  /** `Precedence: bulk / junk / list / auto_reply` và `X-Autoreply` / `X-Autorespond` — dấu hiệu thư tự động kiểu cũ. */
  autoHint: string | null;
  date: Date | null;
};

export type InboundBody = { text: string; attachments: number };

/** Phần nhỏ ERP cần từ một hộp thư — bài kiểm tiêm bản giả, không mở socket. */
export interface MailboxReader {
  open(): Promise<{ uidValidity: string; uidNext: number }>;
  /** Tiêu đề của thư có UID > `afterUid`, tăng dần, tối đa `limit` thư. */
  headersAfter(afterUid: number, limit: number): Promise<InboundHeader[]>;
  /** UID nhỏ nhất của thư nhận từ ngày `since` (lượt đầu) — không có ⇒ `null`. */
  firstUidSince(since: Date): Promise<number | null>;
  /** Thân chữ của MỘT thư, trần `maxBytes`; đính kèm chỉ đếm, không tải. */
  body(uid: number, maxBytes: number): Promise<InboundBody>;
  close(): Promise<void>;
}
export type MailboxReaderFactory = (creds: SmtpCredentials) => MailboxReader;

/** Đọc vài tiêu đề từ khối tiêu đề thô (gấp dòng theo RFC 5322). HÀM THUẦN. */
export function parseHeaderBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!(k in out)) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

/** `<a@x> <b@y>` ⇒ ["<a@x>", "<b@y>"]. HÀM THUẦN. */
export function messageIdList(v: string | null | undefined): string[] {
  return (v ?? "").match(/<[^<>\s]+>/g) ?? [];
}

/** Bỏ thẻ HTML thô (chỉ khi thư không có phần text/plain). HÀM THUẦN. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

type StructNode = { part?: string; type: string; disposition?: string; childNodes?: StructNode[] };

/** Chọn phần chữ để đọc; đếm đính kèm. HÀM THUẦN. */
export function pickTextPart(root: StructNode | undefined): { part: string | null; html: boolean; attachments: number } {
  let plain: string | null = null;
  let html: string | null = null;
  let attachments = 0;
  const walk = (n: StructNode | undefined) => {
    if (!n) return;
    if (n.childNodes?.length) return n.childNodes.forEach(walk);
    const isAttachment = (n.disposition ?? "").toLowerCase() === "attachment";
    const t = n.type.toLowerCase();
    if (isAttachment || (!t.startsWith("text/") && !t.startsWith("multipart/"))) {
      attachments++;
      return;
    }
    if (t === "text/plain" && plain === null) plain = n.part ?? "1";
    else if (t === "text/html" && html === null) html = n.part ?? "1";
  };
  walk(root);
  return plain !== null ? { part: plain, html: false, attachments } : { part: html, html: html !== null, attachments };
}

async function readStream(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream as AsyncIterable<Buffer | string>) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    chunks.push(b);
    size += b.length;
    if (size >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Bộ đọc thật bằng imapflow. Mỗi lượt job mở MỘT kết nối và đóng nó ở `close()`. */
export const imapflowReader: MailboxReaderFactory = (creds) => {
  const client = new ImapFlow({ host: GWS_IMAP_HOST, port: GWS_IMAP_PORT, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000, tls: { servername: GWS_IMAP_HOST, minVersion: "TLSv1.2" } });
  let opened = false;
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new Error(maskSecret(e instanceof Error ? e.message : String(e), creds.pass).slice(0, 300));
    }
  };
  return {
    open: () =>
      wrap(async () => {
        await client.connect();
        const box = await client.mailboxOpen("INBOX", { readOnly: true });
        opened = true;
        return { uidValidity: String(box.uidValidity), uidNext: box.uidNext };
      }),
    headersAfter: (afterUid, limit) =>
      wrap(async () => {
        const out: InboundHeader[] = [];
        for await (const m of client.fetch(`${afterUid + 1}:*`, { uid: true, envelope: true, headers: ["in-reply-to", "references", "auto-submitted", "precedence", "x-autoreply", "x-autorespond"] }, { uid: true })) {
          if (m.uid <= afterUid) continue; // IMAP: «N:*» với N lớn hơn UID lớn nhất vẫn trả thư cuối
          const h = parseHeaderBlock(m.headers ? m.headers.toString("utf8") : "");
          const from = m.envelope?.from?.[0];
          out.push({
            uid: m.uid,
            messageId: m.envelope?.messageId ?? null,
            inReplyTo: m.envelope?.inReplyTo ?? h["in-reply-to"] ?? null,
            references: messageIdList(h.references),
            from: from?.address ?? null,
            fromName: from?.name ?? null,
            subject: m.envelope?.subject ?? "",
            autoSubmitted: h["auto-submitted"] ?? null,
            autoHint: h["x-autoreply"] || h["x-autorespond"] ? "x-autoreply" : /^(bulk|junk|list|auto_reply)$/i.test(h.precedence ?? "") ? `precedence:${h.precedence}` : null,
            date: m.envelope?.date ? new Date(m.envelope.date) : null,
          });
        }
        return out.sort((a, b) => a.uid - b.uid).slice(0, limit);
      }),
    firstUidSince: (since) =>
      wrap(async () => {
        const uids = await client.search({ since }, { uid: true });
        return uids && uids.length ? Math.min(...uids) : null;
      }),
    body: (uid, maxBytes) =>
      wrap(async () => {
        const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        const pick = pickTextPart(msg ? (msg.bodyStructure as StructNode | undefined) : undefined);
        if (!pick.part) return { text: "", attachments: pick.attachments };
        const dl = await client.download(String(uid), pick.part, { uid: true, maxBytes });
        const raw = "content" in dl && dl.content ? await readStream(dl.content, maxBytes) : "";
        return { text: pick.html ? htmlToText(raw) : raw, attachments: pick.attachments };
      }),
    close: async () => {
      try {
        if (opened) await client.logout();
        else client.close();
      } catch {
        client.close();
      }
    },
  };
};
