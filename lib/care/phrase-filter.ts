import { CARE_ATTEMPT_BANDS, CARE_COD_BANDS, CARE_SLA_BUCKET_LABEL, type CareAttemptBand, type CareCodBand, type CareSlaBucket } from "@/lib/care/filters";
import { CARE_REASON_LABEL, type CareReasonKey } from "@/lib/constants/care";
import { CARE_ROUND_BANDS, type CareRoundBand } from "@/lib/constants/care-rounds";
import { FOLLOW_UP_FILTER_LABEL, RESOLUTION_FILTER_LABEL, RESOLUTION_LABEL, type CareDecision, type FollowUpFilterKey, type ResolutionFilterKey } from "@/lib/constants/care-resolution";
import { CARRIER_SUBSTATES, CARRIER_SUBSTATE_LABEL, type CarrierSubstate } from "@/lib/constants/carrier-substate";

/**
 * ═══════════ LỌC BẰNG CÂU — DỊCH CÂU TIẾNG VIỆT THÀNH ĐÚNG NHỮNG BỘ LỌC ĐÃ CÓ ═══════════
 *
 * Người trực gõ "cod trên 1 triệu chưa ai nhận quá hạn" thay vì bấm ba chip. Hàm này KHÔNG phải
 * một bộ máy hiểu ngôn ngữ và không được giả vờ là một: nó chỉ nhận những CỤM TỪ khớp với một giá
 * trị lọc ĐÃ TỒN TẠI trên bàn care (dải COD, hạn, số lần phát hụt, số lượt xử lý, người nhận, trạng
 * thái ĐVVC, lý do care, kết quả, cái hẹn, mã/SĐT). Không có dải "trên 800K" thì câu "trên 800K"
 * là CHƯA HIỂU — nó được in ra, và KHÔNG áp gần đúng thành "≥ 1tr" hay "600K – 1tr". Đoán sai một
 * bộ lọc là giấu kiện khỏi người trực mà họ không biết.
 *
 * Luật:
 *  · gõ có dấu hay không dấu đều được (so trên chuỗi đã bỏ dấu);
 *  · phần không khớp luật nào → `unknown`, màn hình in "chưa hiểu", không áp;
 *  · hai giá trị cho CÙNG một chiều (vd "hụt 1 lần" và "hụt 2 lần") → giữ cái đầu, cái sau vào
 *    `conflicts` — bộ lọc của bàn care là MỘT giá trị mỗi chiều;
 *  · cụm vừa là tên trạng thái ĐVVC vừa là tên lý do care (vd "Chờ phát lại") được hiểu là ĐVVC
 *    báo, và nhãn chip nói rõ điều đó để người đọc gỡ được nếu ý họ khác.
 *
 * Hàm THUẦN: không đọc CSDL, không đọc giờ, chạy hai lần ra cùng kết quả.
 */

export type PhraseParam = "q" | "nguoi" | "lydo" | "dvvc" | "han" | "tien" | "hut" | "ketqua" | "hen" | "luot";

export type PhraseHit = { param: PhraseParam; value: string; label: string };

export type PhraseFilterResult = {
  /** Giá trị sẽ đặt lên đường dẫn — chỉ những chiều đã hiểu. */
  patch: Partial<Record<PhraseParam, string>>;
  understood: PhraseHit[];
  /** Từ còn lại không khớp luật nào — in ra, KHÔNG áp. */
  unknown: string[];
  /** Nhãn của những điều kiện bị bỏ vì trùng chiều với một điều kiện đứng trước. */
  conflicts: string[];
};

/** Bỏ dấu tiếng Việt, về chữ thường. "Đ" → "d". */
export function khongDau(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

const codLabel = (k: CareCodBand) => `COD ${CARE_COD_BANDS.find((b) => b.key === k)!.label}`;
const hutLabel = (k: CareAttemptBand) => CARE_ATTEMPT_BANDS.find((b) => b.key === k)!.label;
const luotLabel = (k: CareRoundBand) => CARE_ROUND_BANDS.find((b) => b.key === k)!.label;
const hanLabel = (k: CareSlaBucket) => `Hạn: ${CARE_SLA_BUCKET_LABEL[k]}`;
const henLabel = (k: FollowUpFilterKey) => `Hẹn: ${FOLLOW_UP_FILTER_LABEL[k]}`;
const ketquaLabel = (k: ResolutionFilterKey) => `Kết quả: ${RESOLUTION_FILTER_LABEL[k]}`;

type Rule = { re: RegExp; hit: (m: RegExpMatchArray) => PhraseHit };

const TIEN = "(?:k|nghin|ngan)?";
const TRIEU = "(?:tr|trieu|m)";

/** Luật cố định. Thứ tự QUAN TRỌNG: cụm dài / cụ thể đứng trước cụm ngắn chứa nó. */
const FIXED_RULES: Rule[] = [
  // ── COD: chỉ đúng năm dải đang có ──
  { re: /\b(?:khong thu ho|khong co cod|khong cod|cod\s*(?:=|bang)?\s*0)(?![\d.,])/g, hit: () => ({ param: "tien", value: "0", label: codLabel("0") }) },
  { re: new RegExp(`\\b(?:cod\\s*)?(?:tu\\s*)?500\\s*${TIEN}\\s*(?:den|toi|-)\\s*600\\s*${TIEN}(?![\\w])`, "g"), hit: () => ({ param: "tien", value: "500-600", label: codLabel("500-600") }) },
  { re: new RegExp(`\\b(?:cod\\s*)?(?:tu\\s*)?600\\s*${TIEN}\\s*(?:den|toi|-)\\s*1\\s*${TRIEU}(?![\\w])`, "g"), hit: () => ({ param: "tien", value: "600-1m", label: codLabel("600-1m") }) },
  { re: new RegExp(`(?:\\bcod\\s*)?(?:\\btu|\\btren|>=|≥|>)\\s*1\\s*${TRIEU}(?![\\w])`, "g"), hit: () => ({ param: "tien", value: "gte1m", label: codLabel("gte1m") }) },
  { re: new RegExp(`(?:\\bcod\\s*)?(?:\\bduoi|<)\\s*500\\s*${TIEN}(?![\\w])`, "g"), hit: () => ({ param: "tien", value: "lt500", label: codLabel("lt500") }) },

  // ── HẠN XỬ LÝ ──
  { re: /\bsap (?:qua|het|tre) han\b/g, hit: () => ({ param: "han", value: "soon", label: hanLabel("soon") }) },
  { re: /\b(?:qua han|vo sla|tre han|vo han)\b/g, hit: () => ({ param: "han", value: "breached", label: hanLabel("breached") }) },
  { re: /\b(?:trong han|con han)\b/g, hit: () => ({ param: "han", value: "ok", label: hanLabel("ok") }) },

  // ── CÁI HẸN (hẹn ≠ hạn) ──
  { re: /\bqua hen\b/g, hit: () => ({ param: "hen", value: "overdue", label: henLabel("overdue") }) },
  { re: /\b(?:hen|den han) hom nay\b/g, hit: () => ({ param: "hen", value: "today", label: henLabel("today") }) },
  { re: /\bhen (?:ngay )?mai\b/g, hit: () => ({ param: "hen", value: "tomorrow", label: henLabel("tomorrow") }) },
  { re: /\bhen xa hon\b/g, hit: () => ({ param: "hen", value: "later", label: henLabel("later") }) },
  { re: /\bchua (?:co )?hen\b/g, hit: () => ({ param: "hen", value: "none", label: henLabel("none") }) },

  // ── NGƯỜI NHẬN ──
  { re: /\b(?:chua (?:co )?ai nhan|chua co nguoi nhan|chua giao cho ai|khong ai nhan)\b/g, hit: () => ({ param: "nguoi", value: "none", label: "Chưa ai nhận" }) },

  // ── SỐ LƯỢT ĐÃ XỬ LÝ ──
  { re: /\b(?:chua (?:duoc )?xu ly lan nao|chua ai (?:cham|dong vao|xu ly))\b/g, hit: () => ({ param: "luot", value: "0", label: luotLabel("0") }) },
  { re: /\bda xu ly (?:3|ba) luot(?: tro len)?\b/g, hit: () => ({ param: "luot", value: "3plus", label: luotLabel("3plus") }) },
  { re: /\bda xu ly (?:2|hai) luot\b/g, hit: () => ({ param: "luot", value: "2", label: luotLabel("2") }) },
  { re: /\bda xu ly (?:1|mot) luot\b/g, hit: () => ({ param: "luot", value: "1", label: luotLabel("1") }) },

  // ── SỐ LẦN PHÁT HỤT ──
  { re: /\bchua (?:phat )?hut(?: lan nao)?\b/g, hit: () => ({ param: "hut", value: "0", label: hutLabel("0") }) },
  { re: /\b(?:phat )?hut (?:(?:3|ba) lan(?: tro len)?|(?:>=|≥|tu) ?3(?: lan)?(?: tro len)?)/g, hit: () => ({ param: "hut", value: "3plus", label: hutLabel("3plus") }) },
  { re: /\b(?:phat )?hut (?:2|hai) lan\b/g, hit: () => ({ param: "hut", value: "2", label: hutLabel("2") }) },
  { re: /\b(?:phat )?hut (?:1|mot) lan\b/g, hit: () => ({ param: "hut", value: "1", label: hutLabel("1") }) },

  // ── KẾT QUẢ CASE: "chưa quyết định" là duy nhất; ba quyết định phải có chữ "kết quả" đứng trước,
  //    vì "đã hoàn" một mình là tên một trạng thái ĐVVC, không phải quyết định của đội. ──
  { re: /\bchua quyet dinh\b/g, hit: () => ({ param: "ketqua", value: "none", label: ketquaLabel("none") }) },
  ...(Object.keys(RESOLUTION_LABEL) as CareDecision[]).map(
    (k): Rule => ({ re: new RegExp(`\\bket qua:? ${khongDau(RESOLUTION_LABEL[k])}\\b`, "g"), hit: () => ({ param: "ketqua", value: k, label: ketquaLabel(k) }) }),
  ),
];

/** Tên trạng thái ĐVVC — đọc thẳng từ sổ nhãn, không gõ lại. Dài trước ngắn. */
const SUBSTATE_RULES: Rule[] = CARRIER_SUBSTATES.filter((s) => s !== "UNKNOWN")
  .map((s) => ({ s, name: khongDau(CARRIER_SUBSTATE_LABEL[s]).replace(/\s*\/\s*/g, " ") }))
  .sort((a, b) => b.name.length - a.name.length)
  .map(({ s, name }): Rule => ({ re: new RegExp(`\\b${name.replace(/\s+/g, "\\s*\\/?\\s*")}\\b`, "g"), hit: () => ({ param: "dvvc", value: s, label: `ĐVVC báo: ${CARRIER_SUBSTATE_LABEL[s as CarrierSubstate]}` }) }));

/** Lý do care — chỉ những tên KHÔNG trùng tên một trạng thái ĐVVC (trùng thì luật ĐVVC đã nhận). */
const SUBSTATE_NAMES = new Set(CARRIER_SUBSTATES.map((s) => khongDau(CARRIER_SUBSTATE_LABEL[s])));
const REASON_RULES: Rule[] = (Object.keys(CARE_REASON_LABEL) as CareReasonKey[])
  .filter((k) => k !== "CARE_TODAY" && !SUBSTATE_NAMES.has(khongDau(CARE_REASON_LABEL[k])))
  .map((k) => ({ k, name: khongDau(CARE_REASON_LABEL[k]).replace(/\s*\/\s*/g, " / ") }))
  .sort((a, b) => b.name.length - a.name.length)
  .map(({ k, name }): Rule => ({ re: new RegExp(`\\b${name.replace(/\s*\/\s*/g, "\\s*(?:\\/|va|hoac)?\\s*").replace(/\s+/g, "\\s+")}\\b`, "g"), hit: () => ({ param: "lydo", value: k, label: `Vì sao: ${CARE_REASON_LABEL[k]}` }) }));

/** Từ nối không mang nghĩa lọc — bỏ đi trước khi kết luận "chưa hiểu". */
const STOPWORDS = new Set(["kien", "don", "hang", "van", "cac", "nhung", "co", "dang", "la", "va", "voi", "cua", "nao", "loc", "xem", "hien", "tim", "cho", "toi", "minh", "ma", "bi", "da", "can", "o", "tat", "ca", "cod", "tien", "thu", "ho", "trang", "thai", "dvvc", "vtp", "hoac"]);

export function parsePhraseFilter(input: string): PhraseFilterResult {
  const understood: PhraseHit[] = [];
  const conflicts: string[] = [];
  const patch: Partial<Record<PhraseParam, string>> = {};
  const take = (h: PhraseHit) => {
    const truoc = patch[h.param];
    if (truoc === undefined) {
      patch[h.param] = h.value;
      understood.push(h);
    } else if (truoc !== h.value) {
      conflicts.push(h.label);
    }
  };

  // Chữ trong ngoặc kép là TÌM THEO CHỮ, nguyên văn (giữ dấu) — lấy ra trước khi bỏ dấu.
  let raw = input.replace(/["“”]([^"“”]+)["“”]/g, (_, q: string) => {
    take({ param: "q", value: q.trim(), label: `Tìm: “${q.trim()}”` });
    return " ";
  });
  // Mã vận đơn / SĐT (dãy ≥ 8 chữ số) cũng là tìm theo chữ.
  raw = raw.replace(/(?<![\d.,])\d{8,}(?![\d.,])/g, (so) => {
    take({ param: "q", value: so, label: `Tìm: ${so}` });
    return " ";
  });

  let t = ` ${khongDau(raw).replace(/\s+/g, " ")} `;
  /*
    "Giữ cái đầu" nghĩa là đầu trong CÂU, không phải đầu trong danh sách luật. Nên gom mọi cụm khớp
    kèm VỊ TRÍ trước, rồi mới xét theo thứ tự xuất hiện. Cụm đã khớp được thay bằng CÙNG SỐ khoảng
    trắng để vị trí các cụm còn lại không xê dịch, và để luật sau không khớp lại vào chữ đã dùng.
  */
  const khop: { at: number; hit: PhraseHit }[] = [];
  for (const rule of [...FIXED_RULES, ...SUBSTATE_RULES, ...REASON_RULES]) {
    for (const m of t.matchAll(rule.re)) khop.push({ at: m.index ?? 0, hit: rule.hit(m) });
    t = t.replace(rule.re, (m) => " ".repeat(m.length));
  }
  for (const { hit } of khop.sort((a, b) => a.at - b.at)) take(hit);

  const unknown = t
    .split(/[\s,.;:+&|/]+/)
    .map((w) => w.replace(/^[-–]+|[-–]+$/g, ""))
    .filter((w) => w && !STOPWORDS.has(w));
  return { patch, understood, unknown, conflicts };
}

/** Những câu mẫu hiện trong ô nhập — mỗi câu phải được `parsePhraseFilter` hiểu TRỌN (có kiểm thử). */
export const PHRASE_EXAMPLES = ["cod trên 1 triệu chưa ai nhận", "quá hạn chờ phát lại", "hụt 2 lần chưa xử lý lần nào", "quá hẹn"];
