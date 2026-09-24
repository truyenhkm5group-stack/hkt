import { loadAlertConfig } from "@/lib/alerts/config";
import { sendLark, sendLarkCard } from "@/lib/alerts/lark";
import {
  EMPTY_DIGEST_LEDGER,
  SHORTAGE_DECISIONS_KEY,
  SHORTAGE_DIGEST_KEY,
  pruneShortageDecisions,
  type ShortageDecisionBook,
  buildShortageLarkCard,
  decideShortageDigest,
  shortageAsPostLines,
  type DigestReason,
  type ShortageDigestLedger,
} from "@/lib/constants/stock-shortage";
import { env } from "@/lib/env";
import { getStockShortage } from "@/lib/queries/stock-shortage";
import { getSettingJson, setSettingJson } from "@/lib/settings";

/**
 * ═══════════ GỬI BẢNG THIẾU HÀNG VÀO LARK ═══════════
 *
 * Chạy trong job `alerts` (10 phút/lần — KHÔNG thêm lịch mới cho bộ lập lịch). Khi nào gửi do hàm
 * thuần `decideShortageDigest` quyết; tệp này chỉ đọc, gửi, và ghi sổ chống gửi lại.
 *
 * Job này KHÔNG ghi vào bảng nghiệp vụ nào: không tạo lệnh sản xuất, không sửa tồn, không đổi đơn.
 * Thứ duy nhất nó ghi là sổ `inventory.shortage.lark` trong settings.
 *
 * Gửi hỏng thì KHÔNG ghi sổ phần "đã báo": lượt sau phải thử lại, không được im lặng bỏ qua cả ngày.
 */

export type ShortageDigestResult = {
  sent: DigestReason | null;
  via: "card" | "post" | null;
  variants: number;
  waitingOrders: number;
  skipped?: string;
  error?: string;
};

/**
 * TRẦN NHỊP TỰ ĐỘNG. Job `alerts` chạy 10 phút/lần VÀ sau mỗi đợt webhook (gộp 20 giây) — tức là
 * có lúc vài lần một phút. Bảng thiếu hàng đọc sổ kho TƯƠI (gộp toàn bộ dòng đơn), nên tính lại mỗi
 * đợt webhook là trả giá cho một câu trả lời gần như không đổi. Nút bấm tay (`force`) bỏ qua trần.
 */
const MIN_AUTO_INTERVAL_MS = 5 * 60_000;
const holder = globalThis as unknown as { __erpShortageDigestAt?: number };

function target(cfg: Awaited<ReturnType<typeof loadAlertConfig>>) {
  return cfg.larkInventoryWebhookUrl ? { url: cfg.larkInventoryWebhookUrl, secret: cfg.larkInventorySecret } : { url: cfg.larkWebhookUrl, secret: cfg.larkSecret };
}

function sameLedger(a: ShortageDigestLedger, b: ShortageDigestLedger) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `force` = người bấm "Gửi bảng thiếu hàng ngay": bỏ qua nhịp chống đổ tin, KHÔNG đánh dấu bảng
 * buổi sáng đã gửi (lượt sáng mai vẫn chạy), nhưng ghi mức thiếu đã báo để lượt tự động không lặp lại.
 */
export async function runStockShortageDigest(opts: { force?: boolean; now?: Date } = {}): Promise<ShortageDigestResult> {
  const now = opts.now ?? new Date();
  const cfg = await loadAlertConfig();
  if (!cfg.enabled.stockShortage && !opts.force) return { sent: null, via: null, variants: 0, waitingOrders: 0, skipped: "đã tắt trong cấu hình cảnh báo" };
  if (!opts.force && holder.__erpShortageDigestAt && now.getTime() - holder.__erpShortageDigestAt < MIN_AUTO_INTERVAL_MS) {
    return { sent: null, via: null, variants: 0, waitingOrders: 0, skipped: "vừa tính trong 5 phút qua" };
  }
  holder.__erpShortageDigestAt = now.getTime();
  const to = target(cfg);

  const snapshot = await getStockShortage({ fresh: true, urgentAfterHours: cfg.pendingHours, now });
  // Mẫu đã được người xác nhận "đã đặt" (trong mức thiếu lúc bấm) hoặc "không đặt nữa" KHÔNG tính
  // là đang thiếu với sổ chống gửi lại — nên khi "đã đặt" bị vượt, nó hiện ra như một mẫu MỚI và được báo.
  const current = Object.fromEntries(snapshot.variants.filter((v) => !v.muted).map((v) => [v.variantId, v.shortQty]));
  // "Đã đặt" / "sẽ đặt" gắn với một đợt thiếu: mẫu hết thiếu thì quyết định rơi. "Không đặt nữa" giữ.
  const book = await getSettingJson<ShortageDecisionBook>(SHORTAGE_DECISIONS_KEY, {});
  const pruned = pruneShortageDecisions(book, Object.fromEntries(snapshot.variants.map((v) => [v.variantId, v.shortQty])));
  if (pruned) await setSettingJson(SHORTAGE_DECISIONS_KEY, pruned);
  const prev = await getSettingJson<ShortageDigestLedger>(SHORTAGE_DIGEST_KEY, EMPTY_DIGEST_LEDGER);
  const decision = decideShortageDigest(prev, current, now);
  const base = { variants: snapshot.totals.variants, waitingOrders: snapshot.totals.waitingOrders };

  let reason: DigestReason | null = decision.send;
  let ledgerIfSent = decision.ledgerIfSent;
  if (opts.force) {
    reason = Object.keys(current).length ? "MORNING" : "CLEARED";
    ledgerIfSent = { morningDay: prev.morningDay, lastSentAt: now.toISOString(), lastShort: current };
  }

  const keepSkipped = async (why: string, error?: string): Promise<ShortageDigestResult> => {
    if (!sameLedger(prev, decision.ledgerIfSkipped)) await setSettingJson(SHORTAGE_DIGEST_KEY, decision.ledgerIfSkipped);
    return { sent: null, via: null, ...base, skipped: why, error };
  };

  if (!reason) return keepSkipped("không có gì mới để báo");
  if (!to.url) return keepSkipped("chưa cấu hình webhook Lark");

  const appUrl = env.appUrl.replace(/\/$/, "");
  const card = buildShortageLarkCard(snapshot, { appUrl, reason, changed: decision.changed });
  let via: ShortageDigestResult["via"] = "card";
  let r = await sendLarkCard(to.url, to.secret, card);
  if (!r.ok) {
    // Bản Lark cũ / nhóm không nhận thẻ có bảng ⇒ gửi cùng dữ liệu dạng văn bản, không bỏ tin.
    const post = shortageAsPostLines(snapshot, { appUrl, reason, changed: decision.changed });
    const fallback = await sendLark(to.url, to.secret, post.title, post.lines);
    via = "post";
    if (!fallback.ok) r = { ok: false, error: `thẻ: ${r.error ?? "?"} · văn bản: ${fallback.error ?? "?"}` };
    else r = fallback;
  }
  if (!r.ok) return keepSkipped("gửi hỏng", r.error);
  await setSettingJson(SHORTAGE_DIGEST_KEY, ledgerIfSent);
  return { sent: reason, via, ...base };
}
