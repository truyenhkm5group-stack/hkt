import { config } from "./config.js";
import { log } from "./logger.js";
import { store } from "./store.js";
import { settings } from "./settings.js";
import { generateReply } from "./ai.js";
import { missingOrderFields, isOrderSummaryReply } from "./bot.js";
import { sleep, parseTs, stripMarkdown, sortChrono } from "./util.js";

/**
 * Sales agent: BAM KHACH CHUA CHOT.
 *
 * Khac voi "Cham soc khach" (broadcast.js) gui 1 tin mau cho tat ca: agent nay doc lai TUNG hoi thoai,
 * phan loai khach dang dung o buoc nao (bang CODE, khong hoi AI), roi moi nho AI soan 1 tin bam RIENG
 * theo dung ngu canh cua khach do.
 *
 * Nguyen tac (bai hoc 2026-09-08): viec gi quan trong thi lam bang code.
 * - Phan loai giai doan: code.
 * - Dieu kien duoc phep nhan (im lang bao lau, bam lan thu may, gio yen tinh, da chot don chua): code.
 * - Chan gia sai / chot don / so tai khoan / tin trung lap: code kiem tra lai sau khi AI soan.
 * AI chi lo phan cau chu.
 */

/** Cac giai doan cua khach. follow=false nghia la KHONG bam (de nhan vien/bot thuong lo) */
export const STAGES = {
  refused: { label: "Khách từ chối", follow: false, hint: "" },
  ordered: { label: "Đã chốt đơn", follow: false, hint: "" },
  waiting: { label: "Đang chờ shop trả lời", follow: false, hint: "" },
  phone_no_order: {
    label: "Có SĐT nhưng chưa chốt",
    follow: true,
    weight: 100,
    hint: "Khách đã để lại số điện thoại nhưng hội thoại dừng lại, chưa chốt đơn. Hãy nhắc lại đúng mẫu/màu khách đã xem, xác nhận lại là shop vẫn giữ hàng, và hỏi một câu để khách chốt (ví dụ xác nhận size hoặc xác nhận địa chỉ nhận hàng). KHÔNG xin lại số điện thoại.",
  },
  objection: {
    label: "Chê giá / còn cân nhắc",
    follow: true,
    weight: 80,
    hint: "Khách có ý chê giá hoặc nói để suy nghĩ thêm rồi im. Hãy nhắn lại nhẹ nhàng, nhấn vào giá trị (chất vải, kiểm hàng trước khi thanh toán, đổi size) chứ KHÔNG tự giảm giá hay bịa ưu đãi mới, rồi hỏi khách còn băn khoăn điểm nào.",
  },
  size_no_phone: {
    label: "Đã cho số đo, chưa cho SĐT",
    follow: true,
    weight: 70,
    hint: "Khách đã cho chiều cao/cân nặng nên rất gần chốt, nhưng chưa để lại số điện thoại. Hãy nhắc lại size shop đã tư vấn cho khách và xin số điện thoại + địa chỉ để shop gửi hàng cho khách kiểm tra trước khi thanh toán.",
  },
  quoted_no_phone: {
    label: "Đã báo giá, chưa cho SĐT",
    follow: true,
    weight: 50,
    hint: "Shop đã báo giá nhưng khách chưa để lại thông tin. Hãy nhắn lại ngắn gọn, hỏi khách xem đã ưng màu nào chưa và xin chiều cao cân nặng để tư vấn size.",
  },
  viewed_only: {
    label: "Xem ảnh rồi im",
    follow: true,
    weight: 30,
    hint: "Shop đã gửi ảnh/thông tin nhưng khách chưa phản hồi gì thêm. Hãy nhắn một câu gợi mở nhẹ nhàng, hỏi khách thích mẫu nào trong số shop đã gửi.",
  },
  cold: {
    label: "Chỉ hỏi qua",
    follow: true,
    weight: 10,
    hint: "Khách mới hỏi qua rồi im. Hãy nhắn một câu chào lại thân thiện, nhắc shop vẫn còn hàng và hỏi khách đang tìm mẫu như thế nào.",
  },
};

const MOC_MAC_DINH = [20, 72, 168]; // gio im lang toi thieu cho lan bam 1, 2, 3 (~hom sau, 3 ngay, 1 tuan)

const SDT_RE = /(?<![0-9])(?:0|\+?84)[1-9][0-9]{7,9}(?![0-9])/;
const SO_DO_RE = /([1-2][0-9]{2}\s*cm|[3-9][0-9]\s*kg|1m[0-9]{2}|cao\s*1[.,]?[0-9]{2})/i;
const GIA_RE = /([0-9]{3}[.,][0-9]{3}|[0-9]{3}\s*k\b|[0-9]{3}\s*nghìn)/i;
const TU_CHOI_RE = /(không mua|ko mua|k mua|đừng nhắn|đừng gửi|không cần nữa|thôi không|hủy đơn|dừng lại|báo cáo|block|spam|phiền)/i;
const CHE_GIA_RE = /(đắt|mắc quá|mắc thế|cao quá|giảm giá|bớt|rẻ hơn|suy nghĩ|cân nhắc|để em xem|để mình xem|tính sau|khi nào cần)/i;

/** Gio hien tai theo gio Viet Nam (0-23) */
function gioVN(ms = Date.now()) {
  return Number(new Date(ms).toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }).slice(0, 2)) % 24;
}

/** Cai dat bam khach cua page, da chuan hoa */
export function followupConfig(pageId) {
  const p = settings.get(pageId);
  const moc = String(p.followupDelays || "")
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  return {
    enabled: !!p.followupEnabled,
    auto: !!p.followupAuto,
    maxTouches: Math.max(1, Math.min(5, Number(p.followupMaxTouches) || 3)),
    delays: moc.length ? moc : MOC_MAC_DINH,
    quietFrom: Number.isFinite(Number(p.followupQuietFrom)) && p.followupQuietFrom !== "" ? Number(p.followupQuietFrom) : 21,
    quietTo: Number.isFinite(Number(p.followupQuietTo)) && p.followupQuietTo !== "" ? Number(p.followupQuietTo) : 8,
    dailyLimit: Math.max(1, Number(p.followupDailyLimit) || 50),
    extra: String(p.followupExtra || "").trim(),
    stages: String(p.followupStages || "").trim(), // trong = moi giai doan follow=true
  };
}

/** Dang trong khung gio yen tinh (khong lam phien khach) */
export function inQuietHours(cfg, ms = Date.now()) {
  const h = gioVN(ms);
  const a = cfg.quietFrom, b = cfg.quietTo;
  if (a === b) return false;
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * Phan loai khach dang o buoc nao - THUAN CODE, khong goi AI.
 * messages: da sortChrono (cu -> moi).
 */
export function classify(bot, pageId, messages, conv = {}) {
  const msgs = sortChrono(messages || []);
  const cua = (m) => (bot.isFromPage(m, pageId) ? "page" : "customer");
  const khach = msgs.filter((m) => cua(m) === "customer");
  const page = msgs.filter((m) => cua(m) === "page");
  const text = (m) => bot.messageText(m) || "";
  const loiKhach = khach.map(text).join("\n");
  const loiPage = page.map(text).join("\n");
  const cuoi = msgs[msgs.length - 1];

  const sig = {
    customerMsgs: khach.length,
    pageMsgs: page.length,
    lastBy: cuoi ? cua(cuoi) : "",
    lastCustomerAt: khach.length ? parseTs(khach[khach.length - 1].inserted_at) : 0,
    lastPageAt: page.length ? parseTs(page[page.length - 1].inserted_at) : 0,
    hasPhone: !!conv.has_phone || SDT_RE.test(loiKhach.replace(/[.\s-]/g, "")),
    gaveSize: SO_DO_RE.test(loiKhach),
    pageQuoted: GIA_RE.test(loiPage),
    pageSentImages: page.some((m) => (m.attachments || []).length > 0),
    refused: TU_CHOI_RE.test(loiKhach),
    objection: CHE_GIA_RE.test(loiKhach),
    closed: bot.orderClosedIn(pageId, msgs),
  };

  let stage = "cold";
  if (sig.refused) stage = "refused";
  else if (sig.closed) stage = "ordered";
  // Khach nhan cuoi ma page chua tra loi -> viec cua luoi an toan, agent khong xen vao
  else if (sig.lastBy === "customer") stage = "waiting";
  else if (sig.hasPhone) stage = "phone_no_order";
  else if (sig.objection) stage = "objection";
  else if (sig.gaveSize) stage = "size_no_phone";
  else if (sig.pageQuoted) stage = "quoted_no_phone";
  else if (sig.pageSentImages) stage = "viewed_only";

  return { stage, ...STAGES[stage], signals: sig };
}

/**
 * Hoi thoai nay co du dieu kien bam lan tiep theo khong - THUAN CODE.
 * Tra { ok, touch, reason }.
 */
export function eligible(cfg, stage, signals, convId, now = Date.now()) {
  const st = store.getFollowup(convId);
  if (st.stopped) return { ok: false, reason: "đã dừng bám khách này" };
  if (!STAGES[stage]?.follow) return { ok: false, reason: STAGES[stage]?.label || stage };
  if (cfg.stages && !cfg.stages.split(/[,|\s]+/).filter(Boolean).includes(stage)) return { ok: false, reason: "giai đoạn không được chọn" };
  const touch = (st.touches || 0) + 1;
  if (touch > cfg.maxTouches) return { ok: false, reason: `đã bám đủ ${cfg.maxTouches} lần` };
  const moc = cfg.delays[Math.min(touch, cfg.delays.length) - 1];
  // Moc tinh tu lan CUOI CUNG co tuong tac (khach nhan hoac shop nhan), lay moc muon hon
  const tuKhi = Math.max(signals.lastCustomerAt || 0, st.lastAt || 0);
  if (!tuKhi) return { ok: false, reason: "không rõ thời điểm khách nhắn cuối" };
  const gio = (now - tuKhi) / 3600e3;
  if (gio < moc) return { ok: false, reason: `mới im ${Math.round(gio)}h, mốc lần ${touch} là ${moc}h` };
  return { ok: true, touch, quietSince: Math.round(gio) };
}

export class SalesAgent {
  constructor() {
    this.jobs = new Map(); // pageId -> job
  }

  /** Quet hoi thoai cua page va phan loai. Doc tin nhan tung hoi thoai nen cham hon broadcast.scan */
  async scan(bot, pageId, { days = 30, max = 200, maxPages = 40, onlyEligible = false } = {}) {
    const client = bot.getClient(pageId);
    if (!client) throw new Error("Khong co page " + pageId);
    const cfg = followupConfig(pageId);
    const now = Date.now();
    const fromMs = now - days * 24 * 3600e3;
    const out = [];
    let last, scanned = 0, truncated = false;

    for (let i = 0; i < maxPages && out.length < max; i++) {
      const r = await client.getConversations({ type: "INBOX", order_by: "updated_at", last_conversation_id: last });
      const list = r.conversations || [];
      if (!list.length) break;
      scanned += list.length;
      let stop = false;
      for (const cv of list) {
        if (out.length >= max) {
          truncated = true;
          break;
        }
        const at = parseTs(cv.updated_at);
        if (at < fromMs) {
          stop = true;
          break;
        }
        if (bot.isPaused(cv.tags, pageId)) continue;
        // Khach nhan cuoi = dang cho tra loi, khong phai viec cua agent -> bo som, khoi ton 1 lan doc tin
        if (String(cv.last_sent_by?.id) !== String(pageId)) continue;
        let messages;
        try {
          messages = sortChrono((await client.getMessages(cv.id)).messages);
        } catch (e) {
          log.warn(`[${pageId}] Bam khach: khong doc duoc ${cv.id}: ${e.message}`);
          continue;
        }
        if (!messages.length) continue;
        const cls = classify(bot, pageId, messages, cv);
        const el = eligible(cfg, cls.stage, cls.signals, cv.id, now);
        if (onlyEligible && !el.ok) continue;
        const st = store.getFollowup(cv.id);
        out.push({
          id: cv.id,
          customer: cv.from?.name || "",
          updatedAt: cv.updated_at,
          stage: cls.stage,
          stageLabel: cls.label,
          weight: cls.weight || 0,
          eligible: el.ok,
          reason: el.reason || "",
          touch: el.touch || (st.touches || 0) + 1,
          touches: st.touches || 0,
          lastFollowupAt: st.lastAt ? new Date(st.lastAt).toISOString() : null,
          quietHours: Math.round((now - (cls.signals.lastCustomerAt || at)) / 3600e3),
          hasPhone: cls.signals.hasPhone,
        });
      }
      last = list[list.length - 1].id;
      if (stop || list.length < 60) break;
      if (i === maxPages - 1) truncated = true;
    }
    // Khach gia tri cao len truoc
    out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.weight - a.weight || b.quietHours - a.quietHours);
    return { total: out.length, eligible: out.filter((x) => x.eligible).length, conversations: out, scanned, truncated, days, scannedAt: new Date().toISOString() };
  }

  /**
   * Soan tin bam cho 1 hoi thoai (khong gui). Tra { text, stage, touch } hoac { skip, reason }.
   */
  async compose(bot, pageId, conversationId, { force = false } = {}) {
    const client = bot.getClient(pageId);
    if (!client) throw new Error("Khong co page " + pageId);
    const cfg = followupConfig(pageId);
    const eff = settings.effective(pageId);
    const data = await client.getMessages(conversationId);
    const messages = sortChrono(data.messages);
    if (!messages.length) return { skip: true, reason: "hội thoại trống" };
    if (data.is_banned) return { skip: true, reason: "khách đã chặn shop" };
    if (data.can_inbox === false) return { skip: true, reason: "ngoài cửa sổ nhắn tin của Facebook" };

    const cls = classify(bot, pageId, messages, { has_phone: data.has_phone });
    const el = eligible(cfg, cls.stage, cls.signals, conversationId);
    if (!el.ok && !force) return { skip: true, reason: el.reason, stage: cls.stage };
    const touch = el.touch || (store.getFollowup(conversationId).touches || 0) + 1;

    const customerName = String(data.conv_from?.name || "").trim();
    const xung = eff.customerTitle || "chị";
    const saleActive = bot.saleActiveIn(pageId, messages);
    const systemPrompt =
      bot.buildSystemPrompt(pageId, { customerName, type: "INBOX", commentMode: "off", saleActive }) +
      `

## NHIỆM VỤ LÚC NÀY: NHẮN CHỦ ĐỘNG BÁM KHÁCH (KHÔNG PHẢI TRẢ LỜI TIN MỚI)
- Khách KHÔNG vừa nhắn gì. Đây là lần bám thứ ${touch}, khách đã im khoảng ${el.quietSince || "?"} giờ.
- Tình huống: ${STAGES[cls.stage].hint}
- Viết ĐÚNG MỘT tin ngắn: 2–4 câu, dưới 320 ký tự, giọng nhân viên nhắn lại thật, có gọi ${xung}${customerName ? ` (tên khách: ${customerName})` : ""} và 1 icon.
- Bám vào đúng mẫu/màu/size khách đã quan tâm trong hội thoại ở trên. KHÔNG hỏi lại thông tin khách đã cho.
- Giá: chỉ được nhắc đúng con số đã có trong bảng giá ở trên. TUYỆT ĐỐI không tự giảm giá, không bịa ưu đãi mới, không hứa quà tặng.
- KHÔNG chốt đơn, KHÔNG gửi số tài khoản, KHÔNG đòi cọc, KHÔNG dùng markdown, KHÔNG gửi mã ảnh.
- KHÔNG lặp lại gần như nguyên văn tin shop đã gửi trước đó trong hội thoại.
- Kết thúc bằng MỘT câu hỏi dễ trả lời.
- Nếu xét thấy không còn gì hợp lý để nhắn (khách đã từ chối, đã mua, hoặc nhắn thêm sẽ làm phiền), hãy trả lời đúng hai chữ: BỎ QUA${cfg.extra ? `\n- Yêu cầu riêng của shop: ${cfg.extra}` : ""}`;

    // Khong kem anh: bam khach chi can chu, do anh se ton tien vision moi lan quet
    const history = await bot.buildHistory(messages.slice(-config.historyLimit), pageId, { maxImages: 0 });
    // Luot dau phai la cua khach (hoi thoai tao tu binh luan co the bat dau bang tin cua shop)
    while (history.length && history[0].role === "model") history.shift();
    history.push({
      role: "user",
      text: "[HỆ THỐNG – KHÔNG PHẢI TIN CỦA KHÁCH: hãy soạn tin nhắn chủ động theo mục \"NHIỆM VỤ LÚC NÀY\" ở trên. Chỉ trả về nội dung tin nhắn, không giải thích.]",
    });

    const daGui = messages
      .filter((m) => bot.isFromPage(m, pageId))
      .slice(-5)
      .map((m) => this._key(bot.messageText(m)));

    let text = "";
    let loi = "";
    for (let lan = 0; lan < 2; lan++) {
      const { text: raw } = await generateReply(lan === 0 ? systemPrompt : systemPrompt + `\n\n## SỬA LẠI\nBản nháp trước bị loại vì: ${loi}. Hãy viết lại cho đúng.`, history, {
        model: eff.model,
        temperature: lan === 0 ? eff.temperature : Math.min(1, (eff.temperature ?? 0.7) + 0.2),
      });
      const kq = this._guard(bot, pageId, raw, systemPrompt, saleActive, daGui);
      if (kq.ok) {
        text = kq.text;
        break;
      }
      loi = kq.reason;
      if (kq.fatal) return { skip: true, reason: kq.reason, stage: cls.stage };
      log.warn(`[${pageId}] Bám khách ${conversationId}: bản nháp ${lan + 1} bị loại (${kq.reason})`);
    }
    if (!text) return { skip: true, reason: "AI soạn không đạt: " + loi, stage: cls.stage };
    return { text, stage: cls.stage, stageLabel: STAGES[cls.stage].label, touch, customer: customerName };
  }

  /** Rut gon tin de so trung lap */
  _key(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-zà-ỹ0-9]/gi, "")
      .slice(0, 60);
  }

  /** Cac chot chan bang CODE tren cau AI vua soan */
  _guard(bot, pageId, raw, systemPrompt, saleActive, daGui) {
    let text = stripMarkdown(String(raw || "").replace(/\[\[HANDOFF\]\]/gi, "").replace(/\[\[IMG:[^\]]*\]\]/gi, "")).trim();
    if (!text) return { ok: false, reason: "AI trả lời rỗng" };
    if (/^\s*bỏ\s*qua\s*[.!]?\s*$/i.test(text)) return { ok: false, fatal: true, reason: "AI thấy không nên nhắn thêm" };
    if (text.length > 700) return { ok: false, reason: "tin quá dài (" + text.length + " ký tự)" };
    if (bot.isPaymentInfoReply(text)) return { ok: false, fatal: true, reason: "tin có số tài khoản / đòi cọc" };
    if (/chốt đơn|lên đơn/i.test(text) || isOrderSummaryReply(text, false) || missingOrderFields(text).length)
      return { ok: false, reason: "tin tự chốt đơn" };
    const ref = bot.priceReferenceFor(pageId, text, systemPrompt, saleActive, { type: "INBOX", commentMode: "off" });
    const sai = bot.findDisallowedPrices(text, ref.prompt);
    if (sai.length) return { ok: false, reason: "giá không có trong bảng giá: " + sai.join(", ") };
    if (daGui.includes(this._key(text))) return { ok: false, reason: "trùng tin shop đã gửi" };
    return { ok: true, text };
  }

  status(pageId) {
    const j = this.jobs.get(String(pageId));
    if (!j) return { running: false };
    const { ids, sent, skipped, failed, done, running, startedAt, current, errors, dryRun, perMinute, log: nhatKy } = j;
    return { running, total: ids.length, sent, skipped, failed, done, current, startedAt, dryRun, perMinute, errors: errors.slice(-10), log: nhatKy.slice(-20) };
  }

  stop(pageId) {
    const j = this.jobs.get(String(pageId));
    if (j) j.running = false;
    return this.status(pageId);
  }

  /** Bat dau bam hang loat (chay nen) */
  start(bot, pageId, { ids, perMinute = 6 }) {
    pageId = String(pageId);
    if (this.jobs.get(pageId)?.running) throw new Error("Page nay dang bam khach, hay dung truoc");
    if (!Array.isArray(ids) || !ids.length) throw new Error("Chua chon khach nao");
    // Chan o server, khong chi o giao dien: page phai duoc bat bam khach va bot phai dang bat
    if (!followupConfig(pageId).enabled) throw new Error('Page nay chua bat "Cho phep bam khach"');
    if (!settings.effective(pageId).enabled) throw new Error("Bot dang TAT tren page nay");
    const job = {
      ids: [...new Set(ids.map(String))],
      perMinute: Math.max(1, Math.min(30, Number(perMinute) || 6)),
      sent: 0, skipped: 0, failed: 0, done: 0,
      running: true, startedAt: Date.now(), current: "", errors: [], log: [],
      dryRun: settings.globalDryRun() || settings.effective(pageId).dryRun,
    };
    this.jobs.set(pageId, job);
    this._run(bot, pageId, job)
      .catch((e) => log.error(`[${pageId}] Bam khach loi: ${e.message}`))
      .finally(() => (job.running = false));
    return this.status(pageId);
  }

  async _run(bot, pageId, job) {
    const cfg = followupConfig(pageId);
    const gap = Math.round(60000 / job.perMinute);
    log.info(`[${pageId}] Bat dau bam ${job.ids.length} khach, ${job.perMinute} tin/phut${job.dryRun ? " (DRY RUN: chi log)" : ""}`);
    let guiHomNay = store.countFollowupToday(pageId);
    for (const cid of job.ids) {
      if (!job.running) break;
      job.current = cid;
      try {
        if (guiHomNay >= cfg.dailyLimit) {
          job.skipped++;
          job.log.push(`${cid}: chạm giới hạn ${cfg.dailyLimit} tin/ngày`);
          job.done++;
          continue;
        }
        if (inQuietHours(cfg)) {
          job.skipped++;
          job.log.push(`${cid}: đang trong giờ yên tĩnh ${cfg.quietFrom}h–${cfg.quietTo}h`);
          job.done++;
          continue;
        }
        const r = await this.compose(bot, pageId, cid);
        if (r.skip) {
          job.skipped++;
          job.log.push(`${cid}: bỏ qua (${r.reason})`);
        } else if (job.dryRun) {
          log.info(`[${pageId}] (DRY RUN) bam khach ${r.customer}: ${r.text.slice(0, 120)}`);
          job.sent++;
          job.log.push(`${cid} (${r.stageLabel}, lần ${r.touch}): ${r.text.slice(0, 120)}`);
        } else {
          await bot.sendComposed(pageId, cid, r.text);
          store.bumpFollowup(pageId, cid, r.stage);
          guiHomNay++;
          job.sent++;
          job.log.push(`${cid} (${r.stageLabel}, lần ${r.touch}): ${r.text.slice(0, 120)}`);
          store.bumpStat(pageId, "followup");
        }
      } catch (e) {
        job.failed++;
        job.errors.push(`${cid}: ${e.message}`);
        log.warn(`[${pageId}] Bam khach loi ${cid}: ${e.message}`);
      }
      job.done++;
      if (job.running && job.done < job.ids.length) await sleep(gap);
    }
    job.current = "";
    log.info(`[${pageId}] Bam khach xong: gui ${job.sent}, bo qua ${job.skipped}, loi ${job.failed}${job.running ? "" : " (da dung)"}`);
  }
}

export const salesAgent = new SalesAgent();

/**
 * Chay tu dong: moi FOLLOWUP_INTERVAL_MIN phut quet cac page da bat "followupAuto" va bam nhung khach du dieu kien.
 */
export function startSalesAgent(bot) {
  const phut = Number(config.followupIntervalMin || 0);
  if (!phut) {
    log.info("Bam khach tu dong: TAT (FOLLOWUP_INTERVAL_MIN=0)");
    return () => {};
  }
  let stopped = false;
  (async () => {
    log.info(`Bam khach tu dong: BAT, quet moi ${phut} phut (page phai bat "Tu dong bam khach")`);
    await sleep(60000); // cho bot khoi dong xong
    while (!stopped) {
      for (const pageId of bot.clients.keys()) {
        if (stopped) break;
        const cfg = followupConfig(pageId);
        const eff = settings.effective(pageId);
        if (!cfg.enabled || !cfg.auto || !eff.enabled) continue;
        if (inQuietHours(cfg)) continue;
        if (salesAgent.jobs.get(String(pageId))?.running) continue;
        if (store.countFollowupToday(pageId) >= cfg.dailyLimit) continue;
        try {
          const r = await salesAgent.scan(bot, pageId, { days: 30, max: 60, onlyEligible: true });
          const ids = r.conversations.slice(0, cfg.dailyLimit - store.countFollowupToday(pageId)).map((c) => c.id);
          if (!ids.length) continue;
          log.info(`[${pageId}] Bam khach tu dong: ${ids.length} khach du dieu kien`);
          salesAgent.start(bot, pageId, { ids, perMinute: 4 });
        } catch (e) {
          log.warn(`[${pageId}] Bam khach tu dong loi: ${e.message}`);
        }
      }
      await sleep(phut * 60000);
    }
  })();
  return () => {
    stopped = true;
  };
}
