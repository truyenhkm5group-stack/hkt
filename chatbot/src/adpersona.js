/**
 * BOT RIENG CHO TUNG CAMP TEST — phan THUAN (khong doc/ghi tep, khong goi mang).
 *
 * Khach bam quang cao "INBOX NGAY" cua mot mau test -> hoi thoai Pancake mang ID quang cao (ad_id).
 * ERP biet ad_id do la camp test nao, dang test MAU nao (Thu vien Media: creative_variants.fb_ad_id ->
 * product) va chu shop dan gi rieng cho camp do; ERP day danh sach "bot theo quang cao" sang bot
 * (PUT /api/erp/ad-bots). Tep nay:
 *   1. doc ad_id tu hoi thoai / tin nhan Pancake (nhieu hinh dang, doc phong thu);
 *   2. kiem tra + chuan hoa danh sach ERP gui sang;
 *   3. chon bot cua quang cao GAN NHAT ma khach bam;
 *   4. dung khoi prompt rieng cho camp.
 *
 * Ba luat:
 *  - Bot rieng chi DINH HUONG mau (mau mac dinh, khoi prompt). GIA van chi lay tu bang gia / danh muc
 *    POS nhu cu — noi dung quang cao dua vao prompt bi CHE so tien, vi chot chan gia coi moi so tien
 *    trong prompt la gia hop le (mot quang cao cu ghi "499K" khong duoc thanh giay phep bao 499K).
 *  - ad_id la chuoi TOAN CHU SO (xem lib/constants/ads-identity.ts). Chuoi khac bi bo, khong doan.
 *  - Khong co bot cho ad_id nao -> hanh vi cu y nguyen (khong khoi nao duoc them).
 */

export const MAX_AD_BOTS = 2000;
const AD_ID_RE = /^\d{6,25}$/;
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

function adIdOf(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") {
    const s = String(v).trim();
    return AD_ID_RE.test(s) ? s : "";
  }
  if (typeof v === "object") return adIdOf(v.ad_id ?? v.adId ?? v.id);
  return "";
}

function tsOf(v) {
  const t = v && typeof v === "object" ? Date.parse(v.inserted_at || v.updated_at || v.created_at || "") : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * Moi ad_id doc duoc, CU -> MOI (phan tu cuoi = quang cao khach bam gan nhat).
 * Doc tu: conversation.ad_ids / conversation.ads / conversation.ad_id, va (neu co) goi tin nhan:
 * data.ad_ids / data.ads, messages[].ad_id, messages[].referral.ad_id, attachments[].ad_id|payload.ad_id.
 */
export function extractAdIds(conversation, messagesData) {
  const out = [];
  const push = (list) => {
    const withTs = list.map((x, i) => ({ id: adIdOf(x), t: tsOf(x), i })).filter((x) => x.id);
    // Co moc thoi gian thi xep theo moc; khong co thi giu thu tu Pancake tra (them vao cuoi = moi hon).
    if (withTs.every((x) => x.t !== null)) withTs.sort((a, b) => a.t - b.t || a.i - b.i);
    for (const x of withTs) out.push(x.id);
  };
  const fromHolder = (h) => {
    if (!h || typeof h !== "object") return;
    if (Array.isArray(h.ad_ids)) push(h.ad_ids);
    if (Array.isArray(h.ads)) push(h.ads);
    if (h.ad_id != null) push([h.ad_id]);
  };
  fromHolder(conversation);
  fromHolder(messagesData);
  fromHolder(messagesData?.conversation);
  const msgs = Array.isArray(messagesData?.messages) ? messagesData.messages : [];
  const perMsg = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const cands = [m.ad_id, m.referral?.ad_id, m.message_referral?.ad_id];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) cands.push(a?.ad_id, a?.payload?.ad_id, a?.referral?.ad_id);
    for (const c of cands) {
      const id = adIdOf(c);
      if (id) perMsg.push({ id, inserted_at: m.inserted_at });
    }
  }
  push(perMsg.map((x) => ({ ad_id: x.id, inserted_at: x.inserted_at })));
  // Bo trung nhung giu lan xuat hien CUOI (moi nhat).
  const seen = new Set();
  const rev = [];
  for (let i = out.length - 1; i >= 0; i--) {
    if (seen.has(out[i])) continue;
    seen.add(out[i]);
    rev.push(out[i]);
  }
  return rev.reverse();
}

const clip = (v, n) =>
  String(v ?? "")
    .replace(/\s+\n/g, "\n")
    .trim()
    .slice(0, n);

const SHA_RE = /^[a-f0-9]{64}$/;
const money = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1000 && n <= 100_000_000 ? n : null;
};

/**
 * MAU TEST MOI (chua co tren POS): ten, ma tam, gia, chat vai, size, uu dai, mau + anh (khoa sha256 cua anh ERP gui).
 * Thieu ten / ma / gia / chat vai / mau nao -> null: bot khong ban mot mau ma no khong biet gia hay chat vai.
 */
export function normalizeTestProduct(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = String(raw.code ?? "").trim().toUpperCase();
  const colors = (Array.isArray(raw.colors) ? raw.colors : [])
    .map((c) => ({ color: clip(c?.color, 40), sha: String(c?.sha ?? "").toLowerCase() }))
    .filter((c) => c.color && SHA_RE.test(c.sha))
    .slice(0, 12);
  const t = {
    name: clip(raw.name, 120),
    code: CODE_RE.test(code) ? code : "",
    price: money(raw.price),
    shipFee: raw.shipFee === 0 ? 0 : money(raw.shipFee),
    comboPrice: money(raw.comboPrice),
    fabric: clip(raw.fabric, 400),
    sizes: clip(raw.sizes, 200),
    offer: clip(raw.offer, 300),
    colors,
  };
  if (!t.name || !t.code || !t.price || !t.fabric || !colors.length) return null;
  return t;
}

/** Kiem tra + chuan hoa mot bot ERP gui sang. Hong -> null (khong doan). */
export function normalizeAdBot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const adId = adIdOf(raw.adId);
  if (!adId) return null;
  const productCode = String(raw.productCode ?? "").trim();
  const bot = {
    adId,
    enabled: raw.enabled !== false,
    productCode: CODE_RE.test(productCode) ? productCode.toUpperCase() : "",
    productName: clip(raw.productName, 200),
    campaignName: clip(raw.campaignName, 200),
    adName: clip(raw.adName, 200),
    adCopy: clip(raw.adCopy, 600),
    instructions: clip(raw.instructions, 4000),
    source: clip(raw.source, 40),
    status: clip(raw.status, 40),
    test: normalizeTestProduct(raw.test),
  };
  // Mau test moi: ma tam cua mau test la ma mau cua camp
  if (bot.test) bot.productCode = bot.test.code;
  // Khong mau, khong huong dan -> khong co gi de noi rieng: bo, de hoi thoai chay nhu cu.
  if (!bot.productCode && !bot.instructions) return null;
  return bot;
}

/** Kiem tra ca goi ERP gui sang. Nem loi doc duoc neu hinh dang sai; tra ve { bots, skipped }. */
export function normalizeAdBotPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.bots)) throw new Error("Thieu truong bots (mang)");
  if (payload.bots.length > MAX_AD_BOTS) throw new Error(`Qua nhieu bot (${payload.bots.length} > ${MAX_AD_BOTS})`);
  const bots = {};
  let skipped = 0;
  for (const raw of payload.bots) {
    const b = normalizeAdBot(raw);
    if (!b) {
      skipped++;
      continue;
    }
    bots[b.adId] = b;
  }
  return { bots, skipped };
}

/** Bot cua quang cao khach bam GAN NHAT (dang bat). Khong co -> null. */
export function pickAdBot(adIds, bots) {
  const list = Array.isArray(adIds) ? adIds : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const b = bots?.[list[i]];
    if (b && b.enabled !== false) return b;
  }
  return null;
}

/** Che so tien trong noi dung quang cao: gia chi den tu bang gia (xem chu thich dau tep). */
export function maskMoney(text) {
  return String(text || "")
    .replace(/\d{1,3}(?:[.,\s]\d{3})+\s*(?:đ|₫|vnđ|vnd|đồng)?/giu, "[giá]")
    .replace(/\d+(?:[.,]\d+)?\s*(?:k|K|nghìn|ngàn|tr|triệu)(?![\p{L}])/gu, "[giá]")
    .replace(/\d{4,}\s*(?:đ|₫|vnđ|vnd|đồng)/giu, "[giá]");
}

const vnd = (n) => `${Number(n).toLocaleString("vi-VN")}đ`;

/** Khoi thong tin MAU TEST MOI — chi dung thong tin nay cho mau nay. */
export function testProductLines(t) {
  const gia = [`1 chiếc ${vnd(t.price)}${t.shipFee === 0 ? " (miễn phí ship)" : t.shipFee ? ` + ${vnd(t.shipFee)} phí ship` : ""}`];
  if (t.comboPrice) gia.push(`2 chiếc ${vnd(t.comboPrice)} (miễn phí ship, được chọn mỗi màu 1 chiếc)`);
  return [
    `- Khách bắt đầu nhắn tin sau khi bấm quảng cáo của MẪU MỚI **${t.name}** (mã ${t.code}). Mẫu này CHƯA có trong danh mục sản phẩm: khi nói về mẫu này CHỈ dùng thông tin dưới đây — bỏ qua giá, chất liệu, màu, số size ghi trong khối báo giá chung và hướng dẫn riêng của page (các phần đó là của mẫu khác). Khách chưa nói rõ mẫu nào ("mẫu này", "còn không", "giá sao") thì hiểu là hỏi đúng mẫu ${t.code}.`,
    `- Giá (chỉ được báo đúng các mức này, không giảm thêm): ${gia.join("; ")}.`,
    `- Chất vải: ${t.fabric}`,
    `- Màu đang có: ${t.colors.map((c) => c.color).join(", ")}. Gửi ảnh một màu bằng [[IMG:${t.code}:tên màu]], gửi ảnh mọi màu bằng [[IMG:${t.code}]]. Màu khác ngoài danh sách: nói rõ chưa có.`,
    t.sizes ? `- Size: ${t.sizes}. Tư vấn size theo bảng size chung của page như các mẫu nữ khác.` : `- Tư vấn size theo bảng size chung của page như các mẫu nữ khác.`,
    t.offer ? `- Ưu đãi của camp: ${t.offer}. Không hứa ưu đãi nào khác.` : `- Không hứa ưu đãi hay quà tặng nào ngoài giá ở trên.`,
    `- Kịch bản chốt đơn như bình thường; bản tóm tắt chốt đơn ghi đúng mã ${t.code}, tên mẫu, màu, size.`,
  ];
}

/** Khoi prompt rieng cho camp. */
export function adBotPromptBlock(bot) {
  if (!bot) return "";
  const ten = bot.campaignName || bot.adName || `quảng cáo ${bot.adId}`;
  const lines = [`## KHÁCH ĐẾN TỪ QUẢNG CÁO TEST — BOT RIÊNG CỦA CAMP "${ten}"`];
  if (bot.test) {
    lines.push(...testProductLines(bot.test));
  } else if (bot.productCode) {
    const mau = `${bot.productCode}${bot.productName ? ` — ${bot.productName}` : ""}`;
    lines.push(
      `- Khách bắt đầu nhắn tin sau khi bấm quảng cáo của mẫu **${mau}**. Khi khách chưa nói rõ mẫu nào ("mẫu này", "còn không", "giá sao", gửi ảnh quảng cáo), hiểu là khách đang hỏi ĐÚNG mẫu ${bot.productCode}: tư vấn, báo giá, gửi ảnh và lên đơn theo mẫu ${bot.productCode}.`,
      `- Không tự giới thiệu mẫu khác khi khách chưa hỏi. Khách chủ động hỏi mẫu khác thì tư vấn mẫu đó bình thường.`,
    );
  } else {
    lines.push(`- Khách bắt đầu nhắn tin sau khi bấm quảng cáo test này.`);
  }
  if (bot.adCopy) {
    lines.push(`- Nội dung quảng cáo khách đã xem (chỉ để hiểu khách đang nói tới điều gì; KHÔNG hứa ưu đãi hay mức giá nào ngoài bảng giá và hướng dẫn): "${maskMoney(bot.adCopy).replace(/"/g, "'")}"`);
  }
  if (bot.instructions) {
    lines.push(`- Hướng dẫn riêng của camp này (ưu tiên hơn hướng dẫn chung nếu mâu thuẫn):`, bot.instructions);
  }
  return `\n\n${lines.join("\n")}`;
}

/** Anh cua mau test theo tham chieu [[IMG:...]]: "MA" = moi mau, "MA:mau" / "MA mau" = mot mau. Khong khop -> null. */
export function testImageRefs(test, ref) {
  if (!test) return null;
  const phang = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/[\s_-]+/g, "");
  const raw = String(ref || "").trim();
  const m = raw.match(/^([^:\s]+)(?:[:\s]+(.+))?$/);
  if (!m || phang(m[1]) !== phang(test.code)) return null;
  const mau = m[2] ? phang(m[2]) : "";
  const list = mau ? test.colors.filter((c) => phang(c.color) === mau || phang(c.color).includes(mau) || mau.includes(phang(c.color))) : test.colors;
  return list.map((c) => `adimg:${c.sha}`);
}
