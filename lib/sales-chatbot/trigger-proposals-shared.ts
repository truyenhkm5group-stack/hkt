/**
 * ═══════════ ĐỀ XUẤT CÁCH HỎI CHO CÂU MẪU — PHẦN THUẦN (client import được) — Phần H, 21/10/2026 ═══════════
 *
 * Trước bản này lượt «tự nạp câu mẫu» GẮN THẲNG cách hỏi mới vào câu mẫu ĐANG HOẠT ĐỘNG: khách gõ đúng cụm đó là bot trả câu mẫu
 * ngay, không ai duyệt, không lịch sử, không gỡ riêng được (tiền lệ 18/10: «xin giá chả cá» vào câu NEM). Chủ shop chốt: máy không tự
 * bật từ khoá chưa qua kiểm định. Nên mỗi cách hỏi máy đề xuất là MỘT dòng ở sổ này (CSDL của chính cửa hàng, khoá `settings`):
 *  · PENDING — chưa có hiệu lực; người duyệt ⇒ APPROVED (gắn vào câu mẫu) hoặc REJECTED (máy không đề xuất lại cụm đó);
 *  · APPROVED gỡ được ⇒ REMOVED (cụm rời câu mẫu, dòng giữ làm lịch sử);
 *  · khoá = (câu mẫu, cụm đã gấp dấu) ⇒ chạy lại lượt học không đẻ dòng trùng.
 * Cách hỏi NGƯỜI gõ trong ô câu mẫu vẫn có hiệu lực ngay — người chính là người duyệt.
 */
import { foldVi } from "@/lib/sales-chatbot/text";

export const TRIGGER_PROPOSALS_KEY = "ai.salesChatbot.quickReplies.triggerProposals";
/** Trần số dòng giữ: quá trần ⇒ bỏ dòng ĐÃ QUYẾT cũ nhất trước, không bao giờ bỏ dòng đang chờ. */
export const TRIGGER_PROPOSAL_LIMIT = 300;

export const TRIGGER_PROPOSAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "REMOVED"] as const;
export type TriggerProposalStatus = (typeof TRIGGER_PROPOSAL_STATUSES)[number];
export type TriggerProposal = { id: string; entryId: string; entryTitle: string; trigger: string; at: string; by: string; status: TriggerProposalStatus; decidedAt: string | null; decidedBy: string | null };

export function triggerProposalId(entryId: string, trigger: string): string {
  return `${entryId}:${foldVi(trigger)}`;
}

export function parseTriggerProposals(raw: unknown): TriggerProposal[] {
  if (!Array.isArray(raw)) return [];
  const out: TriggerProposal[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const status = TRIGGER_PROPOSAL_STATUSES.find((s) => s === o.status);
    if (!status || typeof o.entryId !== "string" || typeof o.trigger !== "string" || !o.trigger.trim()) continue;
    out.push({
      id: triggerProposalId(o.entryId, o.trigger),
      entryId: o.entryId,
      entryTitle: String(o.entryTitle ?? ""),
      trigger: o.trigger,
      at: String(o.at ?? ""),
      by: String(o.by ?? ""),
      status,
      decidedAt: typeof o.decidedAt === "string" ? o.decidedAt : null,
      decidedBy: typeof o.decidedBy === "string" ? o.decidedBy : null,
    });
  }
  return out;
}

/**
 * Thêm đề xuất của máy cho MỘT câu mẫu. Bỏ cụm đã có trên câu mẫu, cụm đang chờ, cụm người đã BỎ (REJECTED — không đòi lại). HÀM THUẦN.
 */
export function addTriggerProposals(
  list: readonly TriggerProposal[],
  entry: { id: string; title: string; triggers: readonly string[] },
  proposed: readonly string[],
  meta: { by: string; at: string },
): { list: TriggerProposal[]; added: TriggerProposal[] } {
  const onEntry = new Set(entry.triggers.map((t) => foldVi(t)));
  const blocked = new Set(list.filter((p) => p.entryId === entry.id && (p.status === "PENDING" || p.status === "REJECTED")).map((p) => p.id));
  const added: TriggerProposal[] = [];
  for (const raw of proposed) {
    const trigger = raw.trim();
    const key = foldVi(trigger);
    const id = triggerProposalId(entry.id, trigger);
    if (!key || onEntry.has(key) || blocked.has(id)) continue;
    blocked.add(id);
    added.push({ id, entryId: entry.id, entryTitle: entry.title, trigger, at: meta.at, by: meta.by, status: "PENDING", decidedAt: null, decidedBy: null });
  }
  const kept = list.filter((p) => !added.some((a) => a.id === p.id));
  return { list: capTriggerProposals([...kept, ...added]), added };
}

/** Quá trần ⇒ bỏ dòng đã quyết cũ nhất trước; dòng PENDING không bao giờ bị bỏ. HÀM THUẦN. */
export function capTriggerProposals(list: readonly TriggerProposal[]): TriggerProposal[] {
  if (list.length <= TRIGGER_PROPOSAL_LIMIT) return [...list];
  const decided = list.filter((p) => p.status !== "PENDING").sort((a, b) => (a.decidedAt ?? a.at).localeCompare(b.decidedAt ?? b.at));
  const drop = new Set(decided.slice(0, list.length - TRIGGER_PROPOSAL_LIMIT).map((p) => p.id));
  return list.filter((p) => !drop.has(p.id));
}

export function pendingTriggerCount(list: readonly TriggerProposal[]): number {
  return list.filter((p) => p.status === "PENDING").length;
}
