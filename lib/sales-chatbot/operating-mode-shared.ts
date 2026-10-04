/**
 * ═══════════ CHẾ ĐỘ VẬN HÀNH CỦA BOT BÁN HÀNG — HÀM THUẦN, DÙNG ĐƯỢC Ở CLIENT ═══════════
 *
 * Lộ trình pilot (docs/productization/19_HSLC_PILOT.md): QUAN SÁT → COPILOT → THỬ NGHIỆM AI vs NGƯỜI → TỰ ĐỘNG. Một cổng
 * DUY NHẤT (`replyGate`) quyết định cho MỌI kênh có người trả lời song song (fanpage qua Pancake, Messenger, Zalo): gọi nó
 * ngay TRƯỚC lượt AI. Trang chat web không có người ở đầu kia nên luôn TỰ ĐỘNG.
 *
 *  · OBSERVE — bot KHÔNG gọi AI, không nói gì: người của shop trả lời như trước khi có bot. Tin khách + câu của page vẫn
 *    vào lịch sử hội thoại ⇒ đó là đường nền (baseline) của người, và là nguồn cho «Phát lại hội thoại cũ».
 *  · COPILOT — bot soạn câu ở hội thoại BÓNG (kênh thử, không gửi), lưu làm GỢI Ý; khi câu thật của page tới, máy đo người
 *    đã dùng lại gợi ý tới đâu (giống hệt · sửa · khác hẳn · không ai trả lời).
 *  · EXPERIMENT — mỗi hội thoại vào MỘT nhánh, tất định theo băm (khoá thử nghiệm + hội thoại): nhánh AI = tự động, nhánh
 *    HUMAN = quan sát. Nhánh được GHIM vào hội thoại ở lượt đầu: đổi tỷ lệ giữa chừng không chuyển hội thoại đang chạy sang
 *    nhánh kia (nếu không, hai nhóm đem so không còn là hai nhóm).
 *  · AUTOPILOT — như trước nay: bot trả lời (mặc định khi bot đang bật — không đổi hành vi của shop nào).
 */

export const OPERATING_MODES = ["OBSERVE", "COPILOT", "EXPERIMENT", "AUTOPILOT"] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export const OPERATING_MODE_LABEL: Record<OperatingMode, string> = {
  OBSERVE: "Quan sát — người trả lời, bot im",
  COPILOT: "Copilot — bot soạn gợi ý, người gửi",
  EXPERIMENT: "Thử nghiệm AI vs Người — chia hội thoại",
  AUTOPILOT: "Tự động — bot trả lời",
};

export const OPERATING_MODE_SETTING_KEY = "ai.salesChatbot.mode";

export type ModeConfig = {
  mode: OperatingMode;
  /** % hội thoại vào nhánh AI khi THỬ NGHIỆM (0–100). Tỷ lệ là quyết định của chủ shop — không có số "đúng" trong mã. */
  aiSharePct: number;
  /** Khoá thử nghiệm: đổi khoá = bắt đầu thử nghiệm mới (hội thoại được chia lại); giữ khoá = nhánh đã ghim giữ nguyên. */
  experimentKey: string;
  updatedAt: string | null;
  updatedByEmail: string | null;
};

export const DEFAULT_MODE_CONFIG: ModeConfig = { mode: "AUTOPILOT", aiSharePct: 50, experimentKey: "e1", updatedAt: null, updatedByEmail: null };

export function parseModeConfig(raw: unknown): ModeConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_MODE_CONFIG;
  const v = raw as Record<string, unknown>;
  const mode = (OPERATING_MODES as readonly string[]).includes(String(v.mode)) ? (v.mode as OperatingMode) : DEFAULT_MODE_CONFIG.mode;
  const share = Number(v.aiSharePct);
  const key = typeof v.experimentKey === "string" && /^[a-z0-9-]{1,40}$/.test(v.experimentKey) ? v.experimentKey : DEFAULT_MODE_CONFIG.experimentKey;
  return {
    mode,
    aiSharePct: Number.isInteger(share) && share >= 0 && share <= 100 ? share : DEFAULT_MODE_CONFIG.aiSharePct,
    experimentKey: key,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
    updatedByEmail: typeof v.updatedByEmail === "string" ? v.updatedByEmail : null,
  };
}

export type Arm = "AI" | "HUMAN";
/** Nhánh đã ghim vào `state.experiment` của hội thoại. */
export type PinnedArm = { key: string; arm: Arm; at: string };

export type ReplyGate = {
  /** Việc của lượt này: AUTOPILOT = gọi AI và gửi · COPILOT = soạn gợi ý, không gửi · OBSERVE = không gọi AI. */
  mode: "OBSERVE" | "COPILOT" | "AUTOPILOT";
  /** Nhánh thử nghiệm (chỉ khi EXPERIMENT). */
  arm: Arm | null;
  experimentKey: string | null;
  /** Lượt này mới ghim nhánh (nơi gọi phải ghi `state.experiment`). */
  pinNow: boolean;
};

/** FNV-1a 32-bit — băm tất định, rẻ, không cần crypto; chỉ để chia nhóm, không để bảo mật. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Nhánh của một hội thoại theo băm — 0–99 < tỷ lệ AI ⇒ AI. */
export function armFor(experimentKey: string, conversationKey: string, aiSharePct: number): Arm {
  return fnv1a(`${experimentKey}:${conversationKey}`) % 100 < aiSharePct ? "AI" : "HUMAN";
}

/** Cổng duy nhất. `pinned` = nhánh đã ghim của hội thoại (nếu có). HÀM THUẦN. */
export function replyGate(cfg: ModeConfig, conversationKey: string, pinned?: PinnedArm | null): ReplyGate {
  if (cfg.mode !== "EXPERIMENT") return { mode: cfg.mode, arm: null, experimentKey: null, pinNow: false };
  const keep = pinned && pinned.key === cfg.experimentKey ? pinned.arm : null;
  const arm = keep ?? armFor(cfg.experimentKey, conversationKey, cfg.aiSharePct);
  return { mode: arm === "AI" ? "AUTOPILOT" : "OBSERVE", arm, experimentKey: cfg.experimentKey, pinNow: !keep };
}

export function readPinnedArm(state: unknown): PinnedArm | null {
  const e = state && typeof state === "object" ? (state as Record<string, unknown>).experiment : null;
  if (!e || typeof e !== "object") return null;
  const v = e as Record<string, unknown>;
  return (v.arm === "AI" || v.arm === "HUMAN") && typeof v.key === "string" ? { key: v.key, arm: v.arm, at: typeof v.at === "string" ? v.at : "" } : null;
}

// ─────────────────────────── Đo Copilot: người dùng lại gợi ý tới đâu ───────────────────────────

export const COPILOT_VERDICTS = ["SAME", "EDITED", "DIFFERENT", "NO_REPLY"] as const;
export type CopilotVerdict = (typeof COPILOT_VERDICTS)[number];

export const COPILOT_VERDICT_LABEL: Record<CopilotVerdict, string> = { SAME: "Gửi gần như nguyên văn", EDITED: "Sửa rồi gửi", DIFFERENT: "Trả lời khác hẳn", NO_REPLY: "Không ai trả lời" };

/**
 * Ranh giới ĐỊNH NGHĨA phép đo (không phải đích đạt / không đạt): độ giống ≥ 0,9 = gần như nguyên văn (khác dấu câu, một
 * hai chữ); 0,5–0,9 = sửa; < 0,5 = khác hẳn. Màn hình luôn in kèm trung vị độ giống để người đọc không phải tin nhãn.
 */
export const COPILOT_SIMILARITY = { same: 0.9, edited: 0.5 } as const;
/** Không có câu thật của page trong chừng này giờ sau gợi ý ⇒ NO_REPLY. */
export const COPILOT_NO_REPLY_HOURS = 24;

function normalize(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/\[shop đã nhắn\]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Độ giống 0–1 = 1 − khoảng cách Levenshtein / độ dài lớn hơn (trên chuỗi đã chuẩn hoá, cắt 600 ký tự). */
export function similarity(a: string, b: string): number {
  const x = normalize(a).slice(0, 600);
  const y = normalize(b).slice(0, 600);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

export function copilotVerdict(sim: number | null): CopilotVerdict {
  if (sim === null) return "NO_REPLY";
  if (sim >= COPILOT_SIMILARITY.same) return "SAME";
  if (sim >= COPILOT_SIMILARITY.edited) return "EDITED";
  return "DIFFERENT";
}
