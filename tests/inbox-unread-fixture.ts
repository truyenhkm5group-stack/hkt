/**
 * FIXTURE CỠ THẬT CỦA HỘP THƯ — dùng chung cho bài kiểm bất biến «chưa đọc» (`tests/inbox-unread-perf.test.ts`) và lượt đo tay.
 *
 * Hàm THUẦN: cùng hạt ⇒ cùng dữ liệu (mulberry32), mốc thời gian dựng TƯƠNG ĐỐI so với `t0` mà nơi gọi truyền vào (bài kiểm truyền
 * đồng hồ thật — AGENTS 50: không ghim ngày tuyệt đối). Phủ đủ các ca của đặc tả chủ shop 10/10/2026: chỉ khách · khách→bot ·
 * khách→NV · khách→page · chỉ bot · chỉ NV · chỉ page · nhiều tin khách · tin nhập lịch sử · bình luận · chat web · hội thoại dài ·
 * con trỏ riêng nằm GIỮA dòng tin (có tin khách tới sau con trỏ) · cột mốc `last_customer_at` cũ / trống · người có / không có con trỏ. Không tên / SĐT thật nào.
 */

export type FixtureSide = "C" | "BOT" | "STAFF" | "PAGE";
/** `page` (chỉ với PAGE): `SYSTEM` = chữ hệ thống của Facebook · `EMPTY` = tin không chữ — cả hai KHÔNG phải câu trả lời hợp lệ. */
export type FixtureMsg = { side: FixtureSide; at: number; imported?: boolean; comment?: boolean; note?: string | null; page?: "SYSTEM" | "EMPTY" };
export type FixtureConv = {
  key: string;
  kind: string;
  channel: "FANPAGE" | "WEB";
  msgs: FixtureMsg[];
  lastCustomerAt: number | null;
  lastBotAt: number | null;
  lastStaffAt: number | null;
  staffSeenAt: number | null;
  historyUntil: number | null;
  /** Con trỏ riêng của người xem thứ i (`null` = chưa có dòng `sales_chat_reads`) — trỏ vào MỐC của một tin khách có thật. */
  cursors: (number | null)[];
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const KINDS: [string, number][] = [
  ["C_BOT", 40],
  ["C_ONLY", 8],
  ["C_STAFF", 10],
  ["C_PAGE", 7],
  ["BOT_ONLY", 4],
  ["STAFF_ONLY", 2],
  ["PAGE_ONLY", 2],
  ["MANY_C", 7],
  ["IMPORTED", 5],
  ["COMMENT", 2],
  ["WEB", 5],
  ["LONG", 8],
  // Cột mốc `last_customer_at` CŨ / trống dù có tin khách sống (cổng của bản dò sổ chặn ở đây) — bản nhanh phải chặn y hệt.
  ["STALE_MARK", 2],
  // Tin phía page KHÔNG phải câu trả lời (chữ hệ thống «Bạn đang phản hồi bình luận…» / tin không chữ) — tin khách vẫn chưa xử lý.
  ["PAGE_SYSTEM", 2],
  ["PAGE_EMPTY", 1],
];

/** `viewers` = số người xem có thể mang con trỏ; tỉ lệ có con trỏ của từng người theo `cursorShare` (người cuối thường không có). */
export function buildInboxFixture(opts: { seed: number; conversations: number; t0: number; cursorShare: number[]; history?: { share: number; min: number; max: number } }): FixtureConv[] {
  const rnd = mulberry32(opts.seed);
  // Lịch sử nhập (tuỳ chọn — lượt đo «luồng dài»): RNG RIÊNG để bật / tắt không đổi phần còn lại của fixture.
  const hr = mulberry32(opts.seed ^ 0x5f3759df);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const total = KINDS.reduce((s, [, w]) => s + w, 0);
  const pickKind = () => {
    let x = rnd() * total;
    for (const [k, w] of KINDS) if ((x -= w) < 0) return k;
    return KINDS[0][0];
  };
  const out: FixtureConv[] = [];
  for (let i = 0; i < opts.conversations; i += 1) {
    const kind = pickKind();
    let t = opts.t0 - int(30 * 60_000, 60 * 86_400_000);
    const msgs: FixtureMsg[] = [];
    const push = (side: FixtureSide, extra: Partial<FixtureMsg> = {}) => {
      t += int(5_000, 2 * 3_600_000);
      msgs.push({ side, at: t, ...extra });
    };
    const turns = int(1, 6);
    switch (kind) {
      case "C_BOT":
        for (let k = 0; k < turns; k += 1) {
          push("C");
          if (rnd() < 0.3) push("C");
          push("BOT");
          if (rnd() < 0.4) push("BOT");
        }
        if (rnd() < 0.35) push("C"); // khách nhắn nối sau câu bot
        break;
      case "C_ONLY":
        for (let k = 0; k < int(1, 5); k += 1) push("C");
        break;
      case "C_STAFF":
        for (let k = 0; k < turns; k += 1) {
          push("C");
          push(rnd() < 0.5 ? "BOT" : "STAFF");
        }
        push("STAFF");
        break;
      case "C_PAGE":
        for (let k = 0; k < turns; k += 1) {
          push("C");
          push("PAGE");
        }
        break;
      case "BOT_ONLY":
        for (let k = 0; k < int(1, 3); k += 1) push("BOT");
        break;
      case "STAFF_ONLY":
        push("STAFF");
        break;
      case "PAGE_ONLY":
        for (let k = 0; k < int(1, 2); k += 1) push("PAGE");
        break;
      case "MANY_C":
        for (let k = 0; k < int(5, 15); k += 1) push("C", rnd() < 0.1 ? { note: "DEDUP" } : {});
        push("BOT");
        break;
      case "IMPORTED":
        for (let k = 0; k < int(3, 10); k += 1) push(rnd() < 0.5 ? "C" : "PAGE", { imported: true });
        if (rnd() < 0.6) {
          push("C");
          push("BOT");
        }
        break;
      case "COMMENT":
        push("C", { comment: true });
        push("BOT");
        if (rnd() < 0.5) push("C");
        break;
      case "WEB":
        for (let k = 0; k < turns; k += 1) {
          push("C");
          push("BOT");
        }
        if (rnd() < 0.4) push("C");
        break;
      case "STALE_MARK":
        push("C");
        push("BOT");
        push("C");
        break;
      case "PAGE_SYSTEM":
        push("C");
        push("PAGE", { page: "SYSTEM" });
        break;
      case "PAGE_EMPTY":
        push("C");
        push("PAGE", { page: "EMPTY" });
        if (rnd() < 0.3) push("BOT");
        break;
      case "LONG":
        for (let k = 0; k < int(30, 80); k += 1) push(rnd() < 0.45 ? "C" : rnd() < 0.8 ? "BOT" : rnd() < 0.5 ? "STAFF" : "PAGE");
        break;
    }
    if (opts.history && hr() < opts.history.share) {
      const n = opts.history.min + Math.floor(hr() * (opts.history.max - opts.history.min + 1));
      let h = (msgs[0]?.at ?? t) - n * 60_000 - 3_600_000;
      const past: FixtureMsg[] = [];
      for (let k = 0; k < n; k += 1) past.push({ side: hr() < 0.5 ? "C" : "PAGE", at: (h += 60_000), imported: true });
      msgs.unshift(...past);
    }
    const live = (s: FixtureSide) => msgs.filter((m) => m.side === s && !m.imported);
    const maxAt = (xs: FixtureMsg[]) => (xs.length ? Math.max(...xs.map((m) => m.at)) : null);
    const cust = live("C");
    const imported = msgs.filter((m) => m.imported);
    // Mốc khách cuối = tin khách sống cuối, đôi khi bị đẩy thêm bằng giờ xử lý (đúng lỗi cột mốc cũ).
    const lastC = maxAt(cust);
    const pushed = lastC === null ? null : lastC + (rnd() < 0.15 ? int(1_000, 600_000) : 0);
    const lastCustomerAt = kind === "STALE_MARK" && lastC !== null ? (rnd() < 0.5 ? null : lastC - 3 * 86_400_000) : pushed;
    const first = msgs.length ? msgs[0].at : opts.t0;
    const last = msgs.length ? msgs[msgs.length - 1].at : opts.t0;
    const staffSeenAt = rnd() < 0.55 ? first + Math.floor(rnd() * (last - first + 3_600_000)) : null;
    // Con trỏ riêng: mốc của MỘT tin khách có thật (lượt đọc tới tin khách cuối của payload lúc đó).
    const cursors = opts.cursorShare.map((share) => (cust.length && rnd() < share ? cust[Math.floor(rnd() * cust.length)].at : null));
    out.push({
      key: `fx-${opts.seed}-${i}`,
      kind,
      channel: kind === "WEB" ? "WEB" : "FANPAGE",
      msgs,
      lastCustomerAt,
      lastBotAt: maxAt(live("BOT")),
      lastStaffAt: maxAt(live("STAFF")),
      staffSeenAt,
      historyUntil: maxAt(imported),
      cursors,
    });
  }
  return out;
}
