/**
 * ═══════════ CÂU MẪU PHẢI NÓI ĐÚNG MÓN KHÁCH HỎI — HÀM THUẦN (P0 18/10/2026, ca «ThanhPhương», HSLC) ═══════════
 *
 * Khách hỏi «xin giá chả cá», bot gửi câu mẫu NEM HẢI SẢN (120.000 ₫ + ảnh nem) sau 0,3 giây. Không phải AI chọn sai: câu mẫu
 * «Nem hải sản tôm bề bề giá bao nhiêu» mang sẵn các cách hỏi «xin giá chả cá», «Báo giá chả cá thu?», «báo giá»… và khớp chữ
 * liền cả cụm (8 điểm) — cao hơn mọi cách hỏi của câu mẫu chả cá thu («Xin giá chả cá thu?» thiếu chữ «thu» nên không khớp).
 * Bước khớp chữ chỉ so CỤM TỪ, không hề biết câu mẫu nói về MÓN nào — một cách hỏi gắn nhầm câu mẫu là đủ để bán sai món.
 *
 * Luật (lõi, mọi tổ chức): MÓN KHÁCH ĐANG HỎI là món khách gọi tên ở tin MỚI NHẤT có gọi tên món trong lượt mua hiện tại
 * (bỏ mệnh đề từ chối — «không lấy nem» không phải đang hỏi nem); khách chưa gọi tên món nào thì lấy món của câu shop / page
 * vừa nói (tin tự động của page giới thiệu chả cá ⇒ «cho giá» là hỏi giá chả cá); món shop nói tới / mời SAU tin khách đó cũng là món
 * ĐANG BÀN (shop mời nem, khách «giá sao em» là hỏi giá nem — không khoá cứng vào món khách nói trước). MÓN CỦA CÂU MẪU = mã SKU trong chỗ trống
 * `{{giá:SKU}}` / `{{tồn:SKU}}` + tên món trong tiêu đề / câu trả lời. Câu mẫu nói về món KHÁC mọi món khách đang hỏi ⇒
 * không được trả lời câu đó (khớp chữ · AI chọn mã · công cụ `send_quick_reply`) — lượt rơi về bước sau (AI đọc hiểu / chatbot
 * đầy đủ), tức là tốn token chứ không bán sai món. Câu mẫu không gắn món nào (ship, địa chỉ, cảm ơn, menu chung) không bị ảnh hưởng.
 * Bán thêm món khác chỉ đi qua câu UPSELL và cửa sổ lời mời (`next-best-action.ts`), SAU khi đã trả lời đúng món khách hỏi.
 *
 * CHƯA XÁC ĐỊNH ĐƯỢC MÓN ⇒ câu mẫu GẮN MÓN không tự trả lời (chủ shop 18/10/2026): HSLC giữ 92 cụm chung («bao nhiêu 1kg», «xin
 * giá»…) trên 12 câu chả cá thu, nhưng chúng chỉ được khớp khi có CĂN CỨ món — chữ khách, câu page / shop / bot trong lượt, bình
 * luận đã chép sang, hoặc danh mục chỉ có MỘT món. Không có căn cứ ⇒ không mặc định món bán chạy: chatbot đầy đủ đọc ngữ cảnh và hỏi
 * đúng một câu ngắn. Đọc danh mục LỖI ⇒ bộ lọc ĐÓNG (`unavailableQuickReplyGuard`): không câu mẫu nào ngoài câu UPSELL được tự gửi
 * — lỗi không bao giờ được biến thành «không lọc».
 *
 * Nhận diện tên món (`productsNamedIn`) CHẶT HƠN `namedProductsIn` của giỏ: bỏ dấu thì «giá» = «giã», nên «xin giá chả cá» đủ hai từ
 * («chả» + «gia») của «Chả mực giã tay». Ở đây: từ ĐẦU của tên + từ PHÂN BIỆT đứng LIỀN SAU nó (bỏ qua từ chung của cả nhóm cùng từ
 * đầu) — «chả cá» ⇒ Chả cá thu, «chả mực» ⇒ Chả mực giã tay, «ruốc bông tôm» ⇒ Ruốc bông tôm; từ đầu chỉ một món có ⇒ đủ tự nó
 * («nem») — trừ từ đầu quá thông dụng («nước», «cá»…) cần thêm từ thứ hai. Nhận thiếu chỉ làm câu mẫu không bị lọc (như trước bản vá); nhận thừa chỉ làm câu mẫu bị loại (tốn token, không sai món).
 */
import { mentionText } from "@/lib/sales-chatbot/cart-commitment";
import { parsePlaceholders, type QuickReplyEntry } from "@/lib/sales-chatbot/quick-replies-shared";
import { foldVi } from "@/lib/sales-chatbot/text";

/** Một sản phẩm đang bán: tên (để nhận diện trong chữ) + mã SKU các mẫu mã (để đọc chỗ trống của câu mẫu). */
export type FocusProduct = { name: string; skus: readonly string[] };

/** Một dòng của lượt mua (cũ ⇒ mới): tin KHÁCH, hoặc câu SHOP / page / bot. */
export type FocusLine = { who: "CUSTOMER" | "SHOP"; text: string };

/**
 * Món đang bàn. `focus` = món khách gọi tên (hoặc, khách chưa gọi tên món nào, món của câu shop / page gần nhất); `offered` = món SHOP
 * nói tới / mời SAU tin khách gọi tên đó (review #p0-quick-reply-focus: shop mời nem, khách «giá sao em» là hỏi giá nem — khoá cứng vào
 * món khách nói trước là cùng lỗi theo chiều ngược lại); `declined` = món khách đã từ chối trong lượt. `source` = căn cứ của `focus`.
 */
export type ProductFocus = { focus: string[]; offered: string[]; declined: string[]; source: "CUSTOMER" | "SHOP" | "CATALOG" | "NONE" };

const uniq = (xs: readonly string[]) => [...new Set(xs)];
const PLACEHOLDER_STRIP_RE = /\{\{[^}]*\}\}/g;

/** Từ của tên món: bỏ mọi phần trong ngoặc («Ruốc bông (chà bông) tôm» ⇒ «ruoc bong tom»), bỏ số và đơn vị khối lượng. */
const nameTokens = (name: string) =>
  foldVi(name.replace(/\([^)]*\)/g, " "))
    .split(" ")
    .filter((w) => w && !/^\d/.test(w) && w !== "kg" && w !== "g");

/** Từ CÓ DẤU (chữ thường, NFC) — cùng ranh giới tách từ với `foldVi`, để so một từ đuôi mà «giá» không trùng «giã». */
const rawTokens = (s: string) =>
  s
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !/^\d/.test(w) && w !== "kg" && w !== "g");

/**
 * Từ CÓ DẤU của CHỮ cần đọc — KHÔNG lọc số / đơn vị, để thẳng hàng từng vị trí với `foldVi(text).split(" ")` (review: lọc «280k»,
 * «1kg» ở một bên làm hai dãy lệch độ dài ⇒ luật một từ đuôi tắt với MỌI câu có giá ⇒ cách hỏi đúng bị coi là gắn nhầm món).
 */
const rawWords = (s: string) =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * Từ đuôi quá thông dụng để làm CĂN CỨ gọi tên món: số đếm, bao bì, tính từ khen hàng, từ hay gặp trong câu chat, và — review #p0-quick-
 * reply-evidence — ngành hàng / tên shop («hải sản»: «Hải Sản Hạ Long xin chào» không gọi tên Nem hải sản), màu, cỡ, thời tiết («màu
 * trắng còn không» không gọi tên «Áo sơ mi trắng»; «trời nắng» không gọi tên «Cá thu một nắng»).
 */
const TAIL_STOP = new Set([
  ...["một", "hai", "ba", "bốn", "năm", "loại", "hộp", "gói", "túi", "chai", "lít", "size", "nhà", "làm", "ngon", "đặc", "biệt", "truyền", "thống", "nguyên", "chất", "tay", "cơm", "biển", "hải", "sản", "tươi", "sạch", "khô", "mới", "to", "nhỏ", "lớn", "thơm", "cay", "ngọt", "giòn", "hàng", "chính", "hãng", "set", "combo", "vị", "kèm", "quà", "cao", "cấp", "và", "với", "của", "cho"],
  ...["trắng", "đen", "đỏ", "xanh", "vàng", "hồng", "tím", "nâu", "xám", "kem", "cam", "ghi", "bạc", "màu", "sọc", "kẻ", "hoa"],
  ...["vừa", "nhẹ", "dày", "mỏng", "dài", "ngắn", "rộng", "xl", "xxl", "m", "l", "s"],
  ...["nắng", "mưa", "lạnh", "nóng", "gió", "mát"],
  ...["shop", "tiệm", "quán", "cửa", "việt", "nam", "hà", "nội", "long", "hạ", "sài", "gòn"],
  ...["phẩm", "món", "mẫu", "riêng", "đồ"],
]);
/**
 * Từ CÁCH CHẾ BIẾN — CHỈ chặn luật MỘT từ đuôi («chả cá thu giã tay» không gọi tên «Chả mực giã tay»). KHÔNG đưa vào danh sách xét từ
 * PHÂN BIỆT của cặp từ / tiền tố tên (review config-guard): với «Chả cá hấp» cạnh «Chả cá thu», «hấp» CHÍNH LÀ từ phân biệt — chặn nó thì
 * cả tên đầy đủ «chả cá hấp» cũng không còn nhận ra, câu mẫu chả cá hấp thành câu chung và được trả lời cho «chả cá thu giá sao».
 */
const COOK_WORDS = new Set(["giã", "chiên", "hấp", "nướng", "luộc", "rán", "xay", "sấy", "rim", "kho", "hun", "khói", "ướp", "tẩm", "sống", "chín", "đông", "lạnh"]);
/** Cùng danh sách, BỎ DẤU (cho cặp từ đuôi so bỏ dấu) + «gia» vì bỏ dấu thì «giá» ≡ «giã». */
const TAIL_STOP_FOLD = new Set([...[...TAIL_STOP].map((w) => foldVi(w)), "gia"]);

/**
 * Từ ĐẦU quá thông dụng để một mình gọi tên món dù danh mục chỉ có một món mang nó («ship nước ngoài», «chả cá luộc nước sôi» không gọi
 * tên «Nước mắm…»; «chả cá thu» không gọi tên «Cá thu một nắng» nhờ luật lồng nhau bên dưới) ⇒ cần thêm từ thứ hai của tên đứng liền.
 */
const GENERIC_HEADS = new Set([
  ...["nuoc", "ca", "banh", "tra", "bot", "dau", "muoi", "sot", "hat", "rau", "thit", "com", "xoi", "che", "sua", "kem", "mam", "bo", "ga", "do", "set", "combo", "goi", "hop", "tui", "ao", "quan", "vay", "dam", "giay", "dep", "mu", "kinh", "son"],
  // Từ CHỈ CHUNG một món hàng (review #902, CI đỏ thật: «còn hàng không» gọi tên «Hàng riêng …» vì đó là món duy nhất bắt đầu bằng
  // «hàng»): «hàng», «sản phẩm», «món», «mẫu», «loại», «đặc sản» không bao giờ tự mình là tên món.
  ...["hang", "san", "pham", "mon", "mau", "loai", "dac"],
]);
/** Từ chỉ CHUNG một món hàng có thể đứng nối nhau ở đầu tên («sản phẩm», «đặc sản», «mẫu hàng») — bỏ qua cả cụm rồi mới đòi từ riêng. */
const GENERIC_ITEM_WORDS = new Set(["hang", "san", "pham", "mon", "mau", "loai", "dac"]);

/**
 * Các món được GỌI TÊN trong chữ (xem đầu tệp). Mỗi lần khớp là một ĐOẠN từ (kéo dài tới hết các từ liền sau còn thuộc tên); món mà
 * mọi đoạn của nó nằm GỌN trong đoạn dài hơn của món khác thì bỏ («chả cá thu» chứa «cá thu» của «Cá thu một nắng»). HÀM THUẦN.
 */
export function productsNamedIn(text: string, names: readonly string[]): string[] {
  const said = foldVi(text).split(" ").filter(Boolean);
  if (!said.length) return [];
  const toks = uniq(names).map((n) => ({ n, t: nameTokens(n) })).filter((x) => x.t.length);
  const rawSaid = rawWords(text);
  const rawCount = new Map<string, number>();
  for (const { n } of toks) for (const w of new Set(rawTokens(n))) rawCount.set(w, (rawCount.get(w) ?? 0) + 1);
  const foldCount = new Map<string, number>();
  for (const { t } of toks) for (const w of new Set(t)) foldCount.set(w, (foldCount.get(w) ?? 0) + 1);
  // Từ PHÂN BIỆT: chỉ một món trong danh mục mang nó, và không thuộc danh sách thông dụng.
  const discriminates = (w: string) => !TAIL_STOP_FOLD.has(w) && foldCount.get(w) === 1;
  const hits: { n: string; spans: [number, number][] }[] = [];
  for (const { n, t } of toks) {
    const group = toks.filter((x) => x.t[0] === t[0]);
    const inName = new Set(t);
    // Từ chung của cả nhóm cùng từ đầu («bong» của hai loại ruốc bông) được bỏ qua; từ ngay sau đó phải là từ RIÊNG của món này.
    const shared = new Set(t.filter((w) => group.every((x) => x.t.includes(w))));
    const own = new Set(t.filter((w) => !shared.has(w) && group.filter((x) => x.t.includes(w)).length === 1));
    const spans: [number, number][] = [];
    for (let i = 0; i < said.length; i++) {
      if (said[i] !== t[0]) continue;
      let j: number;
      if (group.length === 1) {
        if (GENERIC_HEADS.has(t[0]) && t.length > 1) {
          // Mọi từ CHUNG đầu tên («sản phẩm», «hàng») phải khớp liền, rồi thêm TỪ RIÊNG đầu tiên của tên («Sản phẩm Y» cần «sản phẩm y»).
          let q = 1;
          while (q < t.length && GENERIC_ITEM_WORDS.has(t[q])) q++;
          const need = Math.min(q + 1, t.length);
          if (!t.slice(0, need).every((w, x) => said[i + x] === w)) continue;
          j = i + need - 1;
        } else j = i;
      } else {
        j = i + 1;
        while (j < said.length && shared.has(said[j])) j++;
        if (!(j < said.length && own.has(said[j]))) {
          // TIỀN TỐ tên đầy đủ (review config-guard): «chả cá thu» / «chả cá hấp» cạnh nhau — «cá» không riêng món nào nên luật trên
          // trượt; khách gõ liền ≥ 2 từ ĐẦU của tên và đúng MỘT món trong nhóm có tiền tố ấy ⇒ gọi tên món đó.
          let k = 0;
          while (i + k < said.length && k < t.length && said[i + k] === t[k]) k++;
          const sameStart = group.filter((x) => k <= x.t.length && x.t.slice(0, k).every((w, q) => w === t[q]));
          if (k < 2 || sameStart.length !== 1) continue;
          j = i + k - 1;
        }
      }
      while (j + 1 < said.length && inName.has(said[j + 1])) j++;
      spans.push([i, j]);
    }
    // Gọi bằng PHẦN ĐUÔI của tên, bỏ từ đầu («món mực giã đó» = Chả mực giã tay, «tôm bề bề» = Nem hải sản tôm bề bề): ít nhất HAI từ
    // LIỀN NHAU đúng thứ tự trong tên, VÀ trong đoạn có ít nhất một từ PHÂN BIỆT (review: «hải sản» là ngành hàng / tên shop, không phải
    // tên Nem; «cá cơm», «truyền thống», «nguyên chất» cũng vậy). Một từ đuôi đứng một mình không đủ («giá» ≡ «giã» khi bỏ dấu).
    if (!spans.length) {
      for (let i = 0; i + 1 < said.length; i++) {
        for (let k = 1; k + 1 < t.length; k++) {
          if (said[i] !== t[k] || said[i + 1] !== t[k + 1]) continue;
          let j = i + 1;
          while (j + 1 < said.length && k + (j - i) + 1 < t.length && said[j + 1] === t[k + (j - i) + 1]) j++;
          if (said.slice(i, j + 1).some(discriminates)) spans.push([i, j]);
        }
      }
    }
    // MỘT từ đuôi CÓ DẤU, chỉ một món trong danh mục mang nó, không phải từ thông dụng («món mực nhà mình» = Chả mực giã tay, «mắm»
    // = Nước mắm…). So CÓ DẤU nên «giá» không bao giờ thành «giã»; khách gõ không dấu thì không nhận (chỉ tốn token, không sai món).
    if (!spans.length && rawSaid.length === said.length) {
      // Đủ dài (≥ 3 chữ cái) để không phải một âm tiết đệm / cỡ áo.
      const one = new Set(rawTokens(n).slice(1).filter((w) => [...w].length >= 3 && !TAIL_STOP.has(w) && !COOK_WORDS.has(w) && rawCount.get(w) === 1));
      rawSaid.forEach((w, i) => {
        if (one.has(w)) spans.push([i, i]);
      });
    }
    if (spans.length) hits.push({ n, spans });
  }
  const inside = (a: [number, number], b: [number, number]) => b[0] <= a[0] && a[1] <= b[1] && b[1] - b[0] > a[1] - a[0];
  return hits.filter((h) => !h.spans.every((sp) => hits.some((o) => o !== h && o.spans.some((os) => inside(sp, os))))).map((h) => h.n);
}

/** Món một câu mẫu nói tới: SKU trong chỗ trống + tên món trong tiêu đề / câu trả lời (KHÔNG đọc cách hỏi — đó là thứ cần kiểm). */
export function quickReplyCovers(entry: Pick<QuickReplyEntry, "title" | "answer">, products: readonly FocusProduct[]): string[] {
  const skus = new Set(parsePlaceholders(entry.answer).filter((h) => h.kind !== "ship" && h.sku).map((h) => h.sku.toUpperCase()));
  const bySku = products.filter((p) => p.skus.some((s) => skus.has(s.toUpperCase()))).map((p) => p.name);
  const byText = productsNamedIn(`${entry.title}\n${entry.answer.replace(PLACEHOLDER_STRIP_RE, " ")}`, products.map((p) => p.name));
  return uniq([...bySku, ...byText]);
}

/**
 * Món đang bàn từ các dòng của LƯỢT MUA hiện tại (cũ ⇒ mới; dòng cuối = tin khách hiện tại). Món được gọi tên trong mệnh đề từ chối vào
 * `declined`, trừ khi khách gọi tên lại nó ở mệnh đề không từ chối; món đã từ chối không bao giờ vào `focus` / `offered`.
 */
export function productFocusOf(lines: readonly FocusLine[], products: readonly FocusProduct[]): ProductFocus {
  const names = products.map((p) => p.name);
  if (!names.length) return { focus: [], offered: [], declined: [], source: "NONE" };
  const positive: string[] = [];
  const negative: string[] = [];
  let focus: string[] = [];
  const shopAfter: string[][] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const { who, text } = lines[i] ?? { who: "CUSTOMER", text: "" };
    if (!text.trim()) continue;
    if (who === "SHOP") {
      if (!focus.length) shopAfter.push(productsNamedIn(text, names));
      continue;
    }
    const said = productsNamedIn(mentionText([text]), names);
    positive.push(...said);
    negative.push(...productsNamedIn(text, names).filter((n) => !said.includes(n)));
    if (!focus.length && said.length) focus = said;
  }
  const declined = uniq(negative).filter((n) => !positive.includes(n));
  const keep = (xs: readonly string[]) => uniq(xs).filter((n) => !declined.includes(n));
  if (focus.length) {
    const f = uniq(focus);
    // CHỈ câu shop / page GẦN NHẤT có gọi tên món, và chỉ khi nó đưa ra đúng MỘT món mới (một lời mời cụ thể: «chị lấy thêm nem không
    // ạ?»). Đo production 18/10 (14 ngày, 2.865 tin được xét câu mẫu): cộng MỌI món mọi câu shop nhắc tới (bảng giá, menu, lời mời cũ)
    // đổi 1.933 quyết định sang AI trong khi chỉ 20 tin thật sự sai món — câu menu nhiều món không phải lời mời một món.
    const latest = keep(shopAfter.find((x) => keep(x).length) ?? []).filter((n) => !f.includes(n));
    return { focus: f, offered: latest.length === 1 ? latest : [], declined, source: "CUSTOMER" };
  }
  // Khách chưa gọi tên món nào trong lượt ⇒ câu shop / page GẦN NHẤT có gọi tên món.
  const shop = keep(shopAfter.find((x) => keep(x).length) ?? []);
  if (shop.length) return { focus: shop, offered: [], declined, source: "SHOP" };
  // Danh mục chỉ có MỘT món ⇒ câu hỏi chung không mơ hồ: món đó là căn cứ (trừ khi khách vừa từ chối nó).
  const only = keep(uniq(names));
  if (only.length === 1 && uniq(names).length === 1) return { focus: only, offered: [], declined, source: "CATALOG" };
  return { focus: [], offered: [], declined, source: "NONE" };
}

/** Mọi món đang bàn: khách hỏi + shop vừa nói / mời sau đó. */
const onTable = (f: ProductFocus) => uniq([...f.focus, ...f.offered]);

/**
 * Câu mẫu có được gửi lúc này không (công cụ `send_quick_reply`): không gắn món nào ⇒ được; có món đang bàn ⇒ phải nói tới ít nhất một
 * món đó; CHƯA xác định được món nào ⇒ câu gắn món KHÔNG được (chủ shop 18/10/2026: không mặc định món bán chạy).
 */
export function fitsFocus(covers: readonly string[], f: ProductFocus): boolean {
  if (!covers.length) return true;
  const table = onTable(f);
  return table.length > 0 && covers.some((c) => table.includes(c));
}

/**
 * Câu mẫu có trả lời ĐỦ mọi món đang bàn không — cho bước câu mẫu THAY cả lượt trả lời (khớp chữ · AI chọn mã): khách hỏi «giá chả cá
 * với nem», hay shop vừa mời nem rồi khách hỏi «giá sao em», thì câu báo giá một món chỉ trả lời nửa câu (hoặc đoán) ⇒ không đủ, để
 * chatbot đầy đủ đọc ngữ cảnh. Chặt hơn `fitsFocus` (model gửi được hai câu mẫu, mỗi câu một món).
 */
export function answersFocus(covers: readonly string[], f: ProductFocus): boolean {
  if (!covers.length) return true;
  const table = onTable(f);
  return table.length > 0 && table.every((n) => covers.includes(n));
}

/** Bộ lọc dựng MỘT lần mỗi lượt: món đang bàn + phép thử từng câu mẫu (nhớ kết quả theo mã câu mẫu). `exemptIds` = câu UPSELL. */
type EntryKey = Pick<QuickReplyEntry, "id" | "title" | "answer">;
export type QuickReplyFocusGuard = { focus: ProductFocus; fits: (entry: EntryKey) => boolean; answers: (entry: EntryKey) => boolean; coversOf: (entry: EntryKey) => string[]; onTable: string[]; /** Đọc danh mục lỗi ⇒ bộ lọc ĐÓNG. */ unavailable?: true };

/** Đọc danh mục LỖI ⇒ bộ lọc ĐÓNG: chỉ câu UPSELL (cửa sổ lời mời riêng) còn đi được; mọi câu mẫu khác nhường chatbot đầy đủ. */
export function unavailableQuickReplyGuard(exemptIds: readonly string[] = []): QuickReplyFocusGuard {
  const exempt = new Set(exemptIds);
  return { focus: { focus: [], offered: [], declined: [], source: "NONE" }, onTable: [], coversOf: () => [], fits: (e) => exempt.has(e.id), answers: (e) => exempt.has(e.id), unavailable: true };
}

export function quickReplyFocusGuard(lines: readonly FocusLine[], products: readonly FocusProduct[], exemptIds: readonly string[] = []): QuickReplyFocusGuard {
  const focus = productFocusOf(lines, products);
  const memo = new Map<string, string[]>();
  const coversOf = (e: EntryKey) => {
    let c = memo.get(e.id);
    if (!c) memo.set(e.id, (c = quickReplyCovers(e, products)));
    return c;
  };
  // Câu UPSELL đi theo cửa sổ lời mời riêng (next-best-action.ts) ở mọi đường — cùng miễn trừ với công cụ `send_quick_reply`.
  const exempt = new Set(exemptIds);
  return {
    focus,
    onTable: onTable(focus),
    coversOf,
    fits: (e) => exempt.has(e.id) || fitsFocus(coversOf(e), focus),
    answers: (e) => exempt.has(e.id) || answersFocus(coversOf(e), focus),
  };
}

/**
 * KIỂM TĨNH cách hỏi (màn hình câu mẫu · ops `org-catalog`): cách hỏi gọi tên món mà câu mẫu KHÔNG nói tới — đúng lỗi của câu nem
 * mang «xin giá chả cá». Câu mẫu không gắn món nào thì không có xung đột (câu menu chung được phép mang «có chả mực không»).
 */
export function triggerProductConflicts(entry: Pick<QuickReplyEntry, "title" | "answer" | "triggers">, products: readonly FocusProduct[]): { trigger: string; names: string[] }[] {
  const covers = quickReplyCovers(entry, products);
  if (!covers.length) return [];
  const names = products.map((p) => p.name);
  return entry.triggers.map((trigger) => ({ trigger, names: productsNamedIn(trigger, names).filter((n) => !covers.includes(n)) })).filter((x) => x.names.length > 0);
}

/**
 * Cách hỏi ĐỀ XUẤT (tự nạp · nhập) còn giữ được cho một câu mẫu: bỏ cách hỏi gọi tên món mà câu mẫu không nói tới — đường tự nạp từng
 * thêm thẳng «xin giá chả cá» vào câu NEM (chủ shop 18/10/2026: «không cho cấu hình sai tự tái xuất hiện»). HÀM THUẦN.
 */
export function consistentTriggers(entry: Pick<QuickReplyEntry, "title" | "answer">, proposed: readonly string[], products: readonly FocusProduct[]): string[] {
  return proposed.filter((t) => triggerProductConflicts({ ...entry, triggers: [t] }, products).length === 0);
}

/** Câu lỗi đọc được cho người sửa câu mẫu — `null` khi cách hỏi và câu trả lời nói cùng món. HÀM THUẦN. */
export function productConsistencyError(entry: Pick<QuickReplyEntry, "title" | "answer" | "triggers">, products: readonly FocusProduct[]): string | null {
  const c = triggerProductConflicts(entry, products);
  if (!c.length) return null;
  const shown = c.slice(0, 3).map((x) => `«${x.trigger}» (gọi tên ${x.names.join(", ")})`).join(" · ");
  return `Cách hỏi ${shown}${c.length > 3 ? ` và ${c.length - 3} cách hỏi khác` : ""} nói về món mà câu trả lời không nhắc tới — bot sẽ báo sai món. Gỡ cách hỏi đó, hoặc thêm món ấy (kèm {{giá:SKU}}) vào câu trả lời.`;
}
