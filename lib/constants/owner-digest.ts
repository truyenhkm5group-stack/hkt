import { vnDayOf } from "@/lib/constants/feed-freshness";
import {
  applyDecisions,
  groupByKind,
  OWNER_DECISION_KIND_SPEC,
  type DecoratedItem,
  type OwnerDecisionDatum,
  type OwnerDecisionKind,
  type RecommendationDecisionRow,
} from "@/lib/constants/owner-decisions";

/**
 * ═══════════ "CẦN ANH QUYẾT" ĐI TÌM NGƯỜI ĐỌC — MỘT TIN LARK MỖI NGÀY (Company OS · Agent L) ═══════════
 *
 * Tệp THUẦN: không đọc/ghi CSDL, không đọc đồng hồ thật — `now` luôn truyền vào (luật 50, 65). Đường
 * đọc hàng đợi, ghi sổ và gửi tin nằm ở `lib/alerts/owner-decision-digest.ts`.
 *
 * ─── KHI NÀO GỬI (chống đổ tin — cùng khuôn `decideShortageDigest`, luật 70) ───
 *
 *  · BẢN SÁNG — lượt đầu tiên trong khung giờ làm việc của mỗi NGÀY GIỜ VIỆT NAM, nếu hàng đợi còn dòng.
 *    Hàng đợi rỗng ⇒ KHÔNG gửi và ghi "đã xét hôm nay" (một tin "không có gì" mỗi sáng là cách nhanh
 *    nhất để nhóm tắt thông báo). Rỗng vì một nguồn ĐỌC HỎNG thì KHÔNG ghi — lượt sau đọc lại.
 *  · TIN THÊM TRONG NGÀY — CHỈ khi xuất hiện một dòng MỚI (khoá nguồn chưa có trong sổ hôm nay) thuộc
 *    loại GẤP TỰ NHIÊN (`OWNER_DIGEST_URGENT_KINDS`: yêu cầu duyệt, mẫu chờ duyệt — có một người đang
 *    đứng chờ chữ ký). Quảng cáo và tồn kho đổi theo giờ — báo mỗi lần chúng nhúc nhích là spam; chúng
 *    đợi bản sáng hôm sau. Hai tin thêm cách nhau ít nhất `minGapMinutes`; dòng chưa báo không mất, nó
 *    đi cùng tin kế tiếp.
 *  · Dòng đã BỎ QUA / đang HẸN NHẮC (dòng mới nhất của `recommendation_decisions`) không bao giờ vào tin
 *    — áp lại bằng CHÍNH `applyDecisions` của cockpit, không viết luật thứ hai.
 *
 * ─── TIN NÓI GÌ ───
 *
 * Số dòng theo loại + vài dòng đầu (CÁI GÌ + MỘT ô số liệu) + link mở `/cockpit`. KHÔNG in tiền ở bất kỳ
 * đâu trong tin (tinh thần luật 71: tin nhóm không in số tiền) — ô số liệu mang "₫" bị bỏ qua, và yêu
 * cầu duyệt chỉ in NHÓM, không in câu tóm tắt (câu ấy có thể chứa số tiền và mã nhân sự). Không có
 * thông tin cá nhân nào ngoài mã hàng: không email người xin, không tên khách.
 */

export const OWNER_DIGEST_CONFIG_KEY = "owner.digest";
/** Sổ chống gửi lại (settings). */
export const OWNER_DIGEST_LEDGER_KEY = "owner.digest.sent";

/** Bật/tắt — mặc định TẮT: gửi tin vào nhóm Quản lý là quyết định của chủ shop, không phải của một lần deploy. */
export type OwnerDigestConfig = { enabled: boolean };
export const DEFAULT_OWNER_DIGEST_CONFIG: OwnerDigestConfig = { enabled: false };

/** Loại GẤP TỰ NHIÊN — có người đang chờ một chữ ký. Chỉ những loại này được kích tin thêm trong ngày. */
export const OWNER_DIGEST_URGENT_KINDS: readonly OwnerDecisionKind[] = ["APPROVAL", "SAMPLE_REVIEW"];

export const OWNER_DIGEST_RULE = {
  /** Giờ VN bắt đầu gửi — CÙNG giờ bản tin sáng (`MORNING_BRIEF_HOUR_VN`, bài kiểm so hai hằng). */
  morningHourVN: 7,
  /** Từ giờ này (VN) tới sáng hôm sau: không nhắn; bản sáng hôm sau gom lại. */
  workEndVN: 22,
  /** Khoảng cách tối thiểu giữa hai tin trong ngày. */
  minGapMinutes: 30,
  /** Số dòng đầu mỗi loại và tổng số dòng in trong tin — phần còn lại mở `/cockpit`. */
  topPerKind: 2,
  maxTop: 8,
  /** Một lượt đang gửi giữ quyền gửi tối đa chừng này; quá hạn (máy chết giữa chừng) thì lượt sau lấy lại. */
  claimTtlMinutes: 5,
} as const;

export type OwnerDigestLedger = {
  /** Ngày VN đã XÉT bản sáng (gửi, hoặc xét thấy rỗng). */
  day: string | null;
  /** Khoá nguồn thuộc loại gấp đã báo trong ngày `day` — chỉ loại gấp mới kích tin thêm nên chỉ giữ chúng. */
  seen: string[];
  lastSentAt: string | null;
  /** Lượt đang gửi (chống hai lượt chạy song song cùng gửi). */
  claim: { token: string; at: string } | null;
};

export const EMPTY_OWNER_DIGEST_LEDGER: OwnerDigestLedger = { day: null, seen: [], lastSentAt: null, claim: null };

/** Đọc sổ đã lưu — dữ liệu lạ không làm sập job, rơi về sổ rỗng từng trường. */
export function parseOwnerDigestLedger(text: string | null | undefined): OwnerDigestLedger {
  if (!text) return EMPTY_OWNER_DIGEST_LEDGER;
  try {
    const v = JSON.parse(text) as Partial<OwnerDigestLedger> | null;
    if (!v || typeof v !== "object") return EMPTY_OWNER_DIGEST_LEDGER;
    const claim = v.claim && typeof v.claim.token === "string" && typeof v.claim.at === "string" ? { token: v.claim.token, at: v.claim.at } : null;
    return {
      day: typeof v.day === "string" ? v.day : null,
      seen: Array.isArray(v.seen) ? v.seen.filter((s): s is string => typeof s === "string") : [],
      lastSentAt: typeof v.lastSentAt === "string" ? v.lastSentAt : null,
      claim,
    };
  } catch {
    return EMPTY_OWNER_DIGEST_LEDGER;
  }
}

export type OwnerDigestReason = "MORNING" | "NEW_URGENT";
export type OwnerDigestSkip = "DISABLED" | "CLAIMED" | "OUTSIDE_HOURS" | "EMPTY" | "SOURCES_FAILED" | "NO_NEW_URGENT" | "GAP";

export const OWNER_DIGEST_SKIP_LABEL: Record<OwnerDigestSkip, string> = {
  DISABLED: "đang tắt ở trang Cảnh báo",
  CLAIMED: "một lượt khác đang gửi",
  OUTSIDE_HOURS: "ngoài giờ gửi",
  EMPTY: "hàng đợi rỗng — không gửi",
  SOURCES_FAILED: "hàng đợi rỗng vì nguồn đọc hỏng — lượt sau đọc lại",
  NO_NEW_URGENT: "không có dòng gấp nào mới",
  GAP: "vừa gửi — dòng mới đi cùng tin kế tiếp",
};

export type OwnerDigestLine = { text: string; href?: string }[];
export type OwnerDigestMessage = { title: string; lines: OwnerDigestLine[] };

export type OwnerDigestDecision = {
  send: boolean;
  reason: OwnerDigestReason | OwnerDigestSkip;
  message: OwnerDigestMessage | null;
  /** Gửi: sổ ghi SAU KHI gửi thành công. Không gửi: sổ ghi ngay (có thể bằng sổ cũ). Gửi hỏng: giữ sổ cũ. */
  nextState: OwnerDigestLedger;
  /** Khoá nguồn tin này nói tới (để kiểm thử / nhật ký). */
  keys: string[];
};

/**
 * Hàng đợi ở dạng tin cần — `OwnerDecisionQueue` của `getOwnerDecisionQueue` khớp cấu trúc này. Khai
 * cấu trúc thay vì import kiểu từ `lib/queries/*` để tệp thuần không kéo theo tầng truy vấn.
 */
export type OwnerDigestQueue = {
  groups: readonly { items: readonly DecoratedItem[] }[];
  hidden: readonly DecoratedItem[];
  /** Loại người xem (ở đây: tài khoản máy của bản tin) được thấy. Dòng loại khác bị loại. */
  kinds: readonly OwnerDecisionKind[];
  failed: readonly { label: string }[];
};

export type OwnerDigestOptions = { enabled: boolean; appUrl: string };

function vnHour(at: Date): number {
  return new Date(at.getTime() + 7 * 3_600_000).getUTCHours();
}

/** Khung giờ gửi (VN) — runner dùng để khỏi đọc hàng đợi ngoài giờ. */
export function inOwnerDigestWindow(now: Date): boolean {
  const h = vnHour(now);
  return h >= OWNER_DIGEST_RULE.morningHourVN && h < OWNER_DIGEST_RULE.workEndVN;
}

/** Hôm nay đã xét bản sáng chưa — runner dùng để chỉ đọc loại gấp khi bản sáng đã xong. */
export function ownerDigestMorningDone(prev: OwnerDigestLedger | null, now: Date): boolean {
  return (prev ?? EMPTY_OWNER_DIGEST_LEDGER).day === vnDayOf(now);
}

/**
 * Tập dòng được vào tin: áp lại sổ phản ứng bằng `applyDecisions` (BỎ QUA ⇒ ẩn; HẸN NHẮC chưa tới ngày ⇒
 * ẩn; tới ngày ⇒ hiện lại) và lọc theo loại người xem được thấy. Hàng đợi thật đã áp một lần — áp lại
 * ở đây để tin tự đứng được và đúng theo `now` của CHÍNH lượt gửi.
 */
export function digestCandidates(queue: OwnerDigestQueue, now: Date): DecoratedItem[] {
  const pool = [...queue.groups.flatMap((g) => g.items), ...queue.hidden];
  const latest = new Map<string, RecommendationDecisionRow>();
  for (const it of pool) if (it.latest) latest.set(it.sourceKey, it.latest);
  const seen = new Set<string>();
  const unique = pool.filter((it) => (seen.has(it.sourceKey) ? false : (seen.add(it.sourceKey), true)));
  return applyDecisions(unique, latest, now).visible.filter((it) => queue.kinds.includes(it.kind));
}

/** Ô số liệu đầu tiên CÓ giá trị và KHÔNG phải tiền — tin nhóm không in tiền. */
export function digestChip(data: readonly OwnerDecisionDatum[]): OwnerDecisionDatum | null {
  return data.find((d) => d.value !== null && d.value !== "" && !d.value.includes("₫")) ?? null;
}

/** CÁI GÌ an toàn để in vào nhóm: yêu cầu duyệt chỉ in tên loại (câu tóm tắt có thể mang tiền / mã nhân sự). */
export function digestWhat(it: DecoratedItem): string {
  return it.kind === "APPROVAL" ? OWNER_DECISION_KIND_SPEC.APPROVAL.label : it.what;
}

function link(appUrl: string, path: string): string | undefined {
  const base = appUrl.replace(/\/$/, "");
  return base ? `${base}${path}` : undefined;
}

function cockpitPath(kind: OwnerDecisionKind | null): string {
  return kind ? `/cockpit?kind=${kind}` : "/cockpit";
}

export function ownerDigestMessage(items: readonly DecoratedItem[], ctx: { reason: OwnerDigestReason; now: Date; appUrl: string; failed: readonly { label: string }[] }): OwnerDigestMessage {
  const [, thang, ngay] = vnDayOf(ctx.now).split("-");
  const groups = groupByKind(items);
  const title =
    ctx.reason === "MORNING" ? `🧭 Cần anh quyết · sáng ${ngay}/${thang} · ${items.length} việc` : `🧭 Cần anh quyết · ${items.length} việc mới đang chờ chữ ký`;

  const lines: OwnerDigestLine[] = [];
  for (const g of groups) lines.push([{ text: `• ${OWNER_DECISION_KIND_SPEC[g.kind].label}: ${g.count}`, href: link(ctx.appUrl, cockpitPath(g.kind)) }]);

  const top: DecoratedItem[] = [];
  for (const g of groups) for (const it of g.items.slice(0, OWNER_DIGEST_RULE.topPerKind)) if (top.length < OWNER_DIGEST_RULE.maxTop) top.push(it);
  if (top.length) {
    lines.push([{ text: ctx.reason === "MORNING" ? "Đáng xem trước:" : "Mới:" }]);
    for (const it of top) {
      const chip = digestChip(it.data);
      lines.push([{ text: `– ${digestWhat(it)}${chip ? ` · ${chip.label}: ${chip.value}` : ""}`, href: link(ctx.appUrl, cockpitPath(it.kind)) }]);
    }
  }
  const more = items.length - top.length;
  if (more > 0) lines.push([{ text: `… và ${more} việc nữa trên trang Cần anh quyết.` }]);

  // Nguồn đọc hỏng ⇒ con số trên THIẾU phần của nó — phải nói ra, không để trông như đủ.
  if (ctx.failed.length) lines.push([{ text: `⚠️ Chưa đọc được: ${ctx.failed.map((f) => f.label).join(", ")} — số trên THIẾU phần của các nguồn này.` }]);

  const open = link(ctx.appUrl, "/cockpit");
  if (open) lines.push([{ text: "Mở Cần anh quyết", href: open }]);
  return { title, lines };
}

/**
 * QUYẾT ĐỊNH MỘT LƯỢT. Thuần, ổn định: cùng đầu vào ⇒ cùng kết quả (chạy lại cùng phút không gửi lần hai
 * vì sổ đã ghi ở lượt trước).
 */
export function decideOwnerDecisionDigest(prev: OwnerDigestLedger | null, queue: OwnerDigestQueue, now: Date, opts: OwnerDigestOptions): OwnerDigestDecision {
  const p = prev ?? EMPTY_OWNER_DIGEST_LEDGER;
  const skip = (reason: OwnerDigestSkip, nextState: OwnerDigestLedger = p): OwnerDigestDecision => ({ send: false, reason, message: null, nextState, keys: [] });

  if (!opts.enabled) return skip("DISABLED");
  if (p.claim && now.getTime() - new Date(p.claim.at).getTime() < OWNER_DIGEST_RULE.claimTtlMinutes * 60_000) return skip("CLAIMED");
  if (!inOwnerDigestWindow(now)) return skip("OUTSIDE_HOURS");

  const today = vnDayOf(now);
  const items = digestCandidates(queue, now);
  const urgentKeys = (list: readonly DecoratedItem[]) => list.filter((it) => OWNER_DIGEST_URGENT_KINDS.includes(it.kind)).map((it) => it.sourceKey);
  const sentAt = now.toISOString();

  // ─── BẢN SÁNG ───
  if (p.day !== today) {
    if (!items.length) return queue.failed.length ? skip("SOURCES_FAILED") : skip("EMPTY", { ...p, day: today, seen: [] });
    return {
      send: true,
      reason: "MORNING",
      message: ownerDigestMessage(items, { reason: "MORNING", now, appUrl: opts.appUrl, failed: queue.failed }),
      nextState: { day: today, seen: urgentKeys(items).sort(), lastSentAt: sentAt, claim: null },
      keys: items.map((it) => it.sourceKey),
    };
  }

  // ─── TIN THÊM TRONG NGÀY: chỉ dòng GẤP và MỚI ───
  const seen = new Set(p.seen);
  const fresh = items.filter((it) => OWNER_DIGEST_URGENT_KINDS.includes(it.kind) && !seen.has(it.sourceKey));
  if (!fresh.length) return skip("NO_NEW_URGENT");
  const gapOk = !p.lastSentAt || now.getTime() - new Date(p.lastSentAt).getTime() >= OWNER_DIGEST_RULE.minGapMinutes * 60_000;
  if (!gapOk) return skip("GAP");
  return {
    send: true,
    reason: "NEW_URGENT",
    message: ownerDigestMessage(fresh, { reason: "NEW_URGENT", now, appUrl: opts.appUrl, failed: [] }),
    nextState: { day: today, seen: [...new Set([...p.seen, ...fresh.map((it) => it.sourceKey)])].sort(), lastSentAt: sentAt, claim: null },
    keys: fresh.map((it) => it.sourceKey),
  };
}
