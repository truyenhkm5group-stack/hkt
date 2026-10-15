/*
  ops `address-reask-audit` — BOT CÓ HỎI LẠI ĐỊA CHỈ / PHƯỜNG SAU KHI KHÁCH ĐÃ GỬI ĐỊA CHỈ KHÔNG? ĐO TRÊN MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (P0 HSLC 15/10/2026): «Tuyet Nguyen Thi» gõ «230/20 Phan Huy Ích, P An Hội Tây, TP.HCM» + SĐT đầy đủ — phường MỚI có thật
  trong danh mục sau sáp nhập — mà bot bắt chọn giữa 6 phường của quận Gò Vấp cũ; «Lê Văn Dụ» («khu đô thị Xa La, Phúc La cũ, Hà Đông,
  Hà Nội») bị hỏi phường mới qua nhiều lượt. Script đo PHẠM VI lỗi trong N ngày — số TRƯỚC khi deploy bản sửa (nhánh
  `claude/address-ward-explicit`) và số SAU (`--since=<mốc deploy>`).

  Thước đo (ESTIMATED — đọc từ CHỮ tin khách / tin bot và `address_check` trong kết quả công cụ):
   · ĐÃ CHO ĐỊA CHỈ — tin khách đầu tiên (một dòng, cả tin, hoặc ghép với tin ngay trước) đọc được TỈNH + phần số nhà / đường. «Rõ»
     = bộ đọc tự điền được phường (EXACT / UNIQUE_FROM_OLD).
   · HỎI LẠI — sau mốc đó và TRƯỚC khi đơn lên, tin bot hỏi phường / xã, hỏi tỉnh, hoặc xin lại cả địa chỉ. Nguyên nhân (một hội thoại
     có thể mang nhiều):
       WARD_ALREADY_CLEAR   — khách ghi phường rõ (tự điền được) mà bot vẫn hỏi phường;
       TOOL_LINE_DEGRADED   — khách ghi rõ nhưng `address_check` của công cụ ra AMBIGUOUS / NOT_FOUND: dòng địa chỉ model chép vào
                              công cụ đã mất phường (gốc của ca «Tuyet Nguyen Thi»);
       WARD_LIST            — câu hỏi phường mang từ 5 chữ «phường / xã» trở lên (bắt khách chọn trong danh sách 4–6 phường);
       REPEAT_WARD_ASK      — hỏi phường lần thứ hai trở đi (gốc của ca «Lê Văn Dụ»);
       PROVINCE_REASK       — hỏi tỉnh / thành dù tin khách đã đọc được tỉnh;
       FULL_ADDRESS_REASK   — xin lại cả địa chỉ.
   · SỐ CÂU HỎI TỪ ĐỊA CHỈ TỚI ĐƠN — số tin bot có dấu «?» từ mốc khách cho địa chỉ tới kết quả công cụ đầu tiên có mã đơn (đơn nháp /
     đơn chốt). Trung bình + trung vị trên các hội thoại có cả hai mốc.

  BỘ NHẬN «CÂU HỎI PHƯỜNG» là BẢN SAO TỰ CHỨA của `lib/sales-chatbot/address-memory.ts::asksForWard` (bài kiểm so hai bản trên cùng
  câu mẫu): ops lấy script từ `main` nhưng `lib/` từ image ĐANG CHẠY, nên muốn đo TRƯỚC deploy thì script không được import tệp lib mới.
  Bộ đọc địa chỉ (`parseCustomerAddress`) là của image đang chạy — đo trước deploy là đo bằng bộ đọc CŨ (đúng cái bot đã dùng).

  arg: `<mã tổ chức> [--days=1..30] [--since=<ISO>]` (mặc định 7 ngày). `--since` = CHỈ đếm sự việc từ mốc đó (tin trước mốc vẫn được
  đọc). Kênh [ops:tom-tat] chỉ số đếm + tỷ lệ — KHÔNG họ tên, SĐT, địa chỉ, chữ tin, mã hội thoại. Mã hội thoại theo nguyên nhân chỉ ở
  phần MÃ HOÁ. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`, kiểm lại `default_transaction_read_only`); CSDL tổ chức mở bằng
  getDbForInspection (không migrate, không tạo) và script KHÔNG gọi hàm lib nào đọc `getDb()`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("address-reask-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, gte, inArray, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { canAutoFill, parseCustomerAddress } from "@/lib/address/customer-address";
import { foldVnText } from "@/lib/address/vn-address";
import { findOrganization } from "@/lib/platform/organizations";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

// ─────────────────────────── BẢN SAO TỰ CHỨA: CÂU HỎI PHƯỜNG / TỈNH / CẢ ĐỊA CHỈ ───────────────────────────

const WARD_ASK = [/(?:^| )(?:phuong|xa|thi tran)(?: (?:phuong|xa))? (?:nao|gi)(?: |$)/];
const WARD_ASK_Q = [
  /(?:^| )(?:xin|xac nhan|cho em biet|cho biet|bao|kiem tra|chon)(?: lai)?(?: giup)?(?: em| shop| minh| chi| anh)?(?: lai)?(?: (?:ten|dung))? (?:phuong|xa)(?: |$)/,
  /(?:^| )hay (?:phuong|xa) /,
  /(?:^| )dia gioi moi(?: |$)/,
];
const isQuestion = (sentence: string, folded: string) => sentence.includes("?") || /(?:^| )(?:khong|ko|chua|nao|gi)(?: (?:a|nhe|nha|a nhe|a nha))?$/.test(folded);
const FULL_ADDRESS_ASK = /(?:^| )(?:xin|gui|cho em|nhan)(?: lai)?(?: giup em)? (?:thong tin )?dia chi(?: |$)/;
/** Bản sao `NOT_A_REASK` (address-memory.ts): câu xin địa chỉ MỚI / KHÁC, câu kể «đã nhận địa chỉ» không phải câu hỏi lại. */
const NOT_A_REASK = /(?:^| )(?:moi|khac)(?: |$)|(?:^| )(?:da|vua) nhan(?: |$)|(?:^| )dia chi (?:nha|cong ty|co quan|cua hang|cho|truong|van phong|kho|xuong)(?: |$)/;
const PROVINCE_ASK = /(?:^| )(?:tinh|thanh pho)(?: (?:tinh|thanh pho))? (?:nao|gi)(?: |$)|(?:^| )(?:xin|xac nhan)(?: giup)?(?: em)?(?: lai)? (?:tinh|thanh pho)(?: |$)/;

/** Bản sao của `asksForWard` (lib/sales-chatbot/address-memory.ts). HÀM THUẦN. */
export function asksForWardCopy(sentence: string): boolean {
  const f = foldVnText(sentence);
  if (WARD_ASK.some((re) => re.test(f))) return true;
  return isQuestion(sentence, f) && WARD_ASK_Q.some((re) => re.test(f));
}

const sentencesOf = (text: string) => (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);

/** Một tin bot hỏi phần nào của địa chỉ (đọc từ chữ). `wardList` = câu hỏi phường mang ≥ 5 chữ «phường / xã» (danh sách). HÀM THUẦN. */
export function addressAsksIn(botText: string): { ward: boolean; wardList: boolean; province: boolean; full: boolean } {
  const ss = sentencesOf(botText);
  const wardSentences = ss.filter(asksForWardCopy);
  const wardList = wardSentences.some((s) => (foldVnText(s).match(/(?:^| )(?:phuong|xa) /g) ?? []).length >= 5);
  return {
    ward: wardSentences.length > 0,
    wardList,
    province: ss.some((s) => PROVINCE_ASK.test(foldVnText(s))),
    full: ss.some((s) => FULL_ADDRESS_ASK.test(foldVnText(s)) && !NOT_A_REASK.test(foldVnText(s))),
  };
}

// ─────────────────────────── ĐỊA CHỈ KHÁCH ĐÃ CHO ───────────────────────────

/** Tin khách (ghép với tin ngay trước) có trông như một địa chỉ giao: không là câu hỏi, đọc được tỉnh + số nhà / đường. HÀM THUẦN. */
export function addressGivenIn(text: string, previous: string | null): { clear: boolean; province: boolean } | null {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const cands = [...lines, lines.join(", "), ...(previous ? [`${previous.split(/\n+/).pop() ?? ""}, ${lines[0] ?? ""}`] : [])];
  let best: { clear: boolean; province: boolean } | null = null;
  for (const c of cands) {
    if (!c.trim() || c.includes("?")) continue;
    const a = parseCustomerAddress(c);
    if (!a.province || foldVnText(a.street).length < 3) continue;
    const clear = canAutoFill(a);
    if (clear) return { clear, province: true };
    best = best ?? { clear: false, province: true };
  }
  return best;
}

// ─────────────────────────── MỘT HỘI THOẠI ───────────────────────────

export type ReaskCause = "WARD_ALREADY_CLEAR" | "TOOL_LINE_DEGRADED" | "WARD_LIST" | "REPEAT_WARD_ASK" | "PROVINCE_REASK" | "FULL_ADDRESS_REASK";
export const REASK_CAUSES: readonly ReaskCause[] = ["WARD_ALREADY_CLEAR", "TOOL_LINE_DEGRADED", "WARD_LIST", "REPEAT_WARD_ASK", "PROVINCE_REASK", "FULL_ADDRESS_REASK"];
export type AuditMsg = { seq: number; role: string; at: Date; content: unknown };
export type ReaskVerdict = {
  /** Mốc tin khách cho địa chỉ (null = chưa bao giờ). */
  givenAt: Date | null;
  clear: boolean;
  /** Bot hỏi lại (sau mốc, trước khi đơn lên, trong kỳ đếm). */
  reasked: boolean;
  causes: ReaskCause[];
  /** Số tin bot có «?» từ mốc khách cho địa chỉ tới đơn đầu tiên; null = chưa có đơn sau mốc. */
  questionsToOrder: number | null;
};

type Block = { type?: unknown; text?: unknown; content?: unknown; isError?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
const textOf = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();
/** Tin «[Shop đã nhắn] …» là tin page / nhân viên chép vào lịch sử — không phải chữ bot. */
const SHOP_SAID_RE = /^\[Shop đã nhắn\]/;

/** Đi MỘT hội thoại theo thứ tự tin. `windowStart` = chỉ ĐẾM sự việc từ mốc đó. HÀM THUẦN. */
export function auditAddressReask(msgs: readonly AuditMsg[], windowStart: Date): ReaskVerdict {
  let givenAt: Date | null = null;
  let clear = false;
  let ordered = false;
  let questions = 0;
  let questionsToOrder: number | null = null;
  let wardAsks = 0;
  let prevCustomer: string | null = null;
  const causes = new Set<ReaskCause>();
  const counted = (at: Date) => at.getTime() >= windowStart.getTime();
  for (const m of [...msgs].sort((a, b) => a.seq - b.seq)) {
    const blocks = blocksOf(m.content);
    if (m.role === "user" && blocks.some((b) => b.type === "tool_result")) {
      for (const b of blocks.filter((x) => x.type === "tool_result" && x.isError !== true)) {
        let p: Record<string, unknown> | null = null;
        try {
          p = JSON.parse(String(b.content)) as Record<string, unknown>;
        } catch {
          p = null;
        }
        if (!p) continue;
        const chk = p.address_check as { status?: unknown } | undefined;
        if (givenAt && clear && !ordered && chk && (chk.status === "AMBIGUOUS" || chk.status === "NOT_FOUND") && counted(m.at)) causes.add("TOOL_LINE_DEGRADED");
        if (givenAt && !ordered && typeof p.order_code === "string") {
          ordered = true;
          questionsToOrder = questions;
        }
      }
      continue;
    }
    const text = textOf(m.content);
    if (!text) continue;
    if (m.role === "user") {
      if (!givenAt) {
        const g = addressGivenIn(text, prevCustomer);
        if (g) {
          givenAt = m.at;
          clear = g.clear;
        }
      } else if (!clear) {
        // Khách bổ sung sau đó (trả lời câu hỏi phường) ⇒ địa chỉ có thể đã rõ — từ đó hỏi phường là hỏi lại điều đã biết.
        const g = addressGivenIn(text, prevCustomer);
        if (g?.clear) clear = true;
      }
      prevCustomer = text;
      continue;
    }
    if (m.role !== "assistant" || SHOP_SAID_RE.test(text) || !givenAt || ordered) continue;
    if (text.includes("?")) questions += 1;
    const ask = addressAsksIn(text);
    if (ask.ward) wardAsks += 1;
    if (!counted(m.at)) continue;
    if (ask.ward && clear) causes.add("WARD_ALREADY_CLEAR");
    if (ask.wardList) causes.add("WARD_LIST");
    if (ask.ward && wardAsks >= 2) causes.add("REPEAT_WARD_ASK");
    if (ask.province) causes.add("PROVINCE_REASK");
    if (ask.full) causes.add("FULL_ADDRESS_REASK");
  }
  const list = REASK_CAUSES.filter((c) => causes.has(c));
  return { givenAt, clear, reasked: list.length > 0, causes: list, questionsToOrder };
}

// ─────────────────────────── CẢ TỔ CHỨC ───────────────────────────

export const REASK_AUDIT_DEFAULT_DAYS = 7;
export const REASK_AUDIT_MAX_DAYS = 30;
/** Trần hội thoại đọc — đủ cho một shop, có trần để không quét vô hạn. */
export const REASK_AUDIT_MAX_CONVERSATIONS = 5000;
/** Số mã hội thoại tối đa in cho mỗi nguyên nhân (phần MÃ HOÁ). */
export const REASK_AUDIT_LIST_CAP = 300;
const USAGE = `<mã tổ chức> [--days=1..${REASK_AUDIT_MAX_DAYS}] [--since=<ISO>]`;

export type ReaskAuditArgs = { code: string; days: number; since: Date | null };

/** Soát đối số. HÀM THUẦN. */
export function parseReaskAuditArgs(argv: readonly string[], now: Date = new Date()): ReaskAuditArgs | { error: string } {
  const bad = argv.find((a) => a.startsWith("--") && !/^--(days|since)=/.test(a));
  if (bad) return { error: `cờ lạ ${bad.slice(0, 20)}` };
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const raw = argv.find((a) => a.startsWith("--days="))?.slice(7);
  const days = raw === undefined ? REASK_AUDIT_DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > REASK_AUDIT_MAX_DAYS) return { error: `--days phải là số nguyên 1..${REASK_AUDIT_MAX_DAYS}` };
  const rawSince = argv.find((a) => a.startsWith("--since="))?.slice(8);
  let since: Date | null = null;
  if (rawSince !== undefined) {
    const t = /^\d{4}-\d{2}-\d{2}/.test(rawSince) ? Date.parse(rawSince) : NaN;
    if (!Number.isFinite(t)) return { error: "--since phải là mốc ISO (vd 2026-10-15T14:30:00+07:00)" };
    if (t > now.getTime()) return { error: "--since ở tương lai" };
    if (t < now.getTime() - REASK_AUDIT_MAX_DAYS * 86_400_000) return { error: `--since cũ hơn ${REASK_AUDIT_MAX_DAYS} ngày` };
    since = new Date(t);
  }
  return { code, days, since };
}

/** «3/40 (7,5%)» · mẫu < 30 ⇒ «· mẫu nhỏ»; mẫu 0 ⇒ «CHƯA ĐO ĐƯỢC». HÀM THUẦN. */
export function rateText(n: number, d: number): string {
  if (!d) return "CHƯA ĐO ĐƯỢC (mẫu 0)";
  return `${n}/${d} (${((n / d) * 100).toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%)${d < 30 ? " · mẫu nhỏ" : ""}`;
}

/** Trung bình + trung vị (một chữ số thập phân); mẫu 0 ⇒ «CHƯA ĐO ĐƯỢC». HÀM THUẦN. */
export function meanMedianText(xs: readonly number[]): string {
  if (!xs.length) return "CHƯA ĐO ĐƯỢC (mẫu 0)";
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const f = (x: number) => x.toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `trung bình ${f(s.reduce((a, b) => a + b, 0) / s.length)} · trung vị ${f(mid)} (n=${s.length}${s.length < 30 ? " · mẫu nhỏ" : ""})`;
}

export type ReaskAuditResult = {
  conversations: number;
  given: number;
  clear: number;
  reaskConvs: string[];
  clearAskedWard: number;
  byCause: Record<ReaskCause, string[]>;
  questionsToOrder: number[];
};

const chunk = <T,>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Đọc hội thoại cập nhật từ `windowStart` + toàn bộ tin của chúng (chỉ ĐỌC), chấm từng hội thoại, in tóm tắt. */
export async function runAddressReaskAudit(db: Db, opts: { windowStart: Date; now: Date; label: string; convIds?: readonly string[] }): Promise<ReaskAuditResult> {
  const c = schema.salesChatConversations;
  const m = schema.salesChatMessages;
  const convRows = await db
    .select({ id: c.id })
    .from(c)
    .where(and(gte(c.updatedAt, opts.windowStart), ...(opts.convIds ? [inArray(c.id, [...opts.convIds])] : [])))
    .orderBy(sql`${c.updatedAt} desc`)
    .limit(REASK_AUDIT_MAX_CONVERSATIONS);
  const ids = convRows.map((r) => r.id);
  const byConv = new Map<string, AuditMsg[]>();
  for (const part of chunk(ids, 200)) {
    for (const r of await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(inArray(m.conversationId, part)).orderBy(asc(m.conversationId), asc(m.seq))) {
      byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), { seq: r.seq, role: r.role, at: r.at, content: r.content }]);
    }
  }
  const byCause = Object.fromEntries(REASK_CAUSES.map((k) => [k, [] as string[]])) as Record<ReaskCause, string[]>;
  const out: ReaskAuditResult = { conversations: ids.length, given: 0, clear: 0, reaskConvs: [], clearAskedWard: 0, byCause, questionsToOrder: [] };
  for (const id of ids) {
    const v = auditAddressReask(byConv.get(id) ?? [], opts.windowStart);
    if (!v.givenAt) continue;
    out.given += 1;
    if (v.clear) out.clear += 1;
    if (v.reasked) out.reaskConvs.push(id);
    if (v.causes.includes("WARD_ALREADY_CLEAR")) out.clearAskedWard += 1;
    for (const k of v.causes) byCause[k].push(id);
    if (v.questionsToOrder !== null) out.questionsToOrder.push(v.questionsToOrder);
  }
  const causeLine = REASK_CAUSES.map((k) => `${k} ${byCause[k].length}`).join(" · ");
  tomTat(`address-reask-audit ${opts.label}: ${out.conversations}${out.conversations >= REASK_AUDIT_MAX_CONVERSATIONS ? "+" : ""} hội thoại cập nhật trong kỳ · khách đã gửi địa chỉ ${out.given} · trong đó phường rõ (tự điền được) ${out.clear}`);
  tomTat(`HỎI LẠI ĐỊA CHỈ (ESTIMATED — đọc từ chữ + address_check): ${rateText(out.reaskConvs.length, out.given)} hội thoại đã gửi địa chỉ`);
  tomTat(`PHƯỜNG ĐÃ RÕ MÀ VẪN HỎI: ${rateText(out.clearAskedWard, out.clear)} hội thoại có phường rõ`);
  tomTat(`Nguyên nhân (hội thoại, một hội thoại có thể nhiều nhóm): ${causeLine}`);
  tomTat(`Số câu hỏi của bot từ lúc khách gửi địa chỉ tới khi đơn lên: ${meanMedianText(out.questionsToOrder)}`);
  tomTat("mã hội thoại theo từng nguyên nhân ở phần MÃ HOÁ");
  for (const k of REASK_CAUSES) console.log(`  ${k} (${byCause[k].length}, in ≤ ${REASK_AUDIT_LIST_CAP}): ${byCause[k].slice(0, REASK_AUDIT_LIST_CAP).join(" ") || "—"}`);
  return out;
}

async function thoat(code: number): Promise<never> {
  // Xả stdout RỒI mới thoát: stdout vào ống là ghi bất đồng bộ — `process.exit()` ngay sau console.log cắt mất khối tóm tắt cuối.
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}

async function main() {
  const now = new Date();
  const args = parseReaskAuditArgs(process.argv.slice(2), now);
  if ("error" in args) {
    tomTat(`address-reask-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    return thoat(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`address-reask-audit: DỪNG · không có tổ chức «${args.code}»`);
    return thoat(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("address-reask-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    return thoat(1);
  }
  const windowStart = args.since ?? new Date(now.getTime() - args.days * 86_400_000);
  await runAddressReaskAudit(db, { windowStart, now, label: args.since ? `từ ${args.since.toISOString()}` : `${args.days} ngày tới ${now.toISOString()}` });
  return thoat(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch(async (e) => {
    console.error("address-reask-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("address-reask-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    await thoat(1);
  });
}
