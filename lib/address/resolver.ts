/**
 * ═══════════ THANG ÁNH XẠ ĐỊA CHỈ GIAO — HÀM THUẦN (address-resolver-ladder PR-B · chủ shop chốt 22/10/2026 · AGENTS 3.12b) ═══════════
 *
 * Chữ địa chỉ khách gửi (đơn đã chốt, cờ «địa chỉ chưa ghép» còn mở) ⇒ tỉnh + xã / phường MỚI của DANH MỤC ERP. Bậc theo thứ tự, DỪNG ở
 * bậc đầu tiên CHẮC:
 *   (a) TEXT   — lib/address trên chữ đã GHÉP mọi tin khách (`raw.addressText` + dòng địa chỉ của đơn);
 *   (b) C360   — địa chỉ ĐÃ XÁC MINH trước đó của chính khách, cùng tổ chức, cùng nơi giao (`sameDeliveryPlace`);
 *   (c) PLACES — Google Places của CHÍNH tổ chức: địa chỉ Google trả về đọc LẠI bằng danh mục ERP (gồm bản đồ địa giới cũ → mới).
 * CHẮC = (1) một bậc trỏ ĐÚNG MỘT xã đọc chắc (`EXACT` / từ xã cũ không bị chia), hoặc (2) GIAO các tập ứng viên của những bậc ĐỘC LẬP
 * (xã cũ bị chia ⇒ vài xã mới) còn đúng MỘT xã — hai nguồn nói cùng một nơi. Luôn đúng tỉnh của đơn khi đơn đã đọc được tỉnh.
 * Không chắc ⇒ KHÔNG CHẮC (ứng viên đã thu hẹp) hoặc KHÔNG RA ⇒ nhân viên kiểm nội bộ, không bao giờ hỏi khách. Không bịa tên đơn vị hành
 * chính: mọi ứng viên là tên trong danh mục. Không đọc CSDL, không gọi mạng, không đọc đồng hồ (nơi gọi đưa kết quả Places vào).
 */
import { canAutoFill, customerStatedAddresses, parseCustomerAddress, sameDeliveryPlace, wardFromCustomerWords } from "@/lib/address/customer-address";

export const RESOLVER_SOURCES = ["TEXT", "C360", "PLACES"] as const;
export type ResolverSource = (typeof RESOLVER_SOURCES)[number];
/** `exact` = bộ đọc chắc đúng xã này; `false` = một trong vài xã mới của một xã cũ bị chia. */
export type ResolverCandidate = { province: string; provinceCode: number; ward: string; source: ResolverSource; exact: boolean };
export type ResolverStatus = "SURE" | "UNSURE" | "NONE";
export type ResolverVerdict = { status: ResolverStatus; source: ResolverSource | null; pick: ResolverCandidate | null; candidates: ResolverCandidate[]; reason: string };
export type ResolverInput = {
  /** Chữ địa chỉ nguyên văn khách gửi (cũ ⇒ mới). */
  lines: readonly string[];
  /** Dòng địa chỉ đang lưu trên đơn. */
  recipient: { address: string; province: string };
  /** Địa chỉ đã xác minh của chính khách (C360). */
  verified?: readonly { address: string; province: string; ward: string }[];
  /** Địa chỉ dạng chữ của các kết quả Google Places (`formattedAddress`); `null` / vắng = bậc không chạy. */
  places?: readonly (string | null)[] | null;
};

/** Đọc một dòng thành ứng viên của danh mục: chắc ⇒ một; xã cũ bị chia ⇒ các xã mới (không chắc); không đọc được ⇒ rỗng. HÀM THUẦN. */
function candidatesOf(text: string, source: ResolverSource, province = ""): ResolverCandidate[] {
  const a = parseCustomerAddress(text, province);
  if (!a.province || a.provinceCode === null) return [];
  if (canAutoFill(a) && a.ward) return [{ province: a.province, provinceCode: a.provinceCode, ward: a.ward, source, exact: true }];
  return a.confidence === "AMBIGUOUS" ? a.candidates.map((ward) => ({ province: a.province!, provinceCode: a.provinceCode!, ward, source, exact: false })) : [];
}

const keyOf = (c: Pick<ResolverCandidate, "provinceCode" | "ward">) => `${c.provinceCode}|${c.ward}`;

function uniq(cands: readonly ResolverCandidate[]): ResolverCandidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => (seen.has(keyOf(c)) ? false : (seen.add(keyOf(c)), true)));
}

/** (a) Ứng viên từ chữ khách đã ghép + dòng địa chỉ của đơn. HÀM THUẦN. */
export function textCandidates(input: Pick<ResolverInput, "lines" | "recipient">): ResolverCandidate[] {
  const out: ResolverCandidate[] = [];
  const lines = input.lines.map((l) => l.trim()).filter(Boolean);
  out.push(...candidatesOf(input.recipient.address, "TEXT", input.recipient.province));
  const stated = wardFromCustomerWords(parseCustomerAddress(input.recipient.address, input.recipient.province), input.recipient.address, lines);
  if (stated) out.push({ province: stated.province, provinceCode: stated.provinceCode, ward: stated.ward, source: "TEXT", exact: true });
  for (const s of customerStatedAddresses(lines))
    if (s.ward && s.province && s.provinceCode !== null && sameDeliveryPlace(input.recipient.address, `${s.street}, ${s.ward}, ${s.province}`)) out.push({ province: s.province, provinceCode: s.provinceCode, ward: s.ward, source: "TEXT", exact: true });
  if (lines.length) out.push(...candidatesOf(lines.join(", "), "TEXT", input.recipient.province));
  return preferExact(out);
}

/** (b) Ứng viên từ địa chỉ đã xác minh của chính khách — chỉ khi CÙNG nơi giao với dòng của đơn. HÀM THUẦN. */
export function c360Candidates(input: Pick<ResolverInput, "recipient" | "verified">): ResolverCandidate[] {
  const out: ResolverCandidate[] = [];
  for (const v of input.verified ?? []) if (v.ward.trim() && sameDeliveryPlace(input.recipient.address, v.address)) out.push(...candidatesOf(`${v.ward}, ${v.province}`, "C360"));
  return preferExact(out);
}

/** (c) Ứng viên từ địa chỉ Google trả về, đọc lại bằng danh mục ERP — Google không bao giờ tự đặt tên đơn vị hành chính. HÀM THUẦN. */
export function placesCandidates(places: readonly (string | null)[]): ResolverCandidate[] {
  const out: ResolverCandidate[] = [];
  for (const p of places) {
    const text = (p ?? "").replace(/,?\s*(?:Việt Nam|Vietnam|VN)\s*$/iu, "").replace(/\b\d{5,6}\b/g, " ").trim();
    if (text) out.push(...candidatesOf(text, "PLACES"));
  }
  return preferExact(out);
}

/** Trong một bậc: có ứng viên đọc CHẮC thì chỉ giữ chúng (ứng viên của xã cũ bị chia chỉ là phương án khi không có gì chắc). HÀM THUẦN. */
function preferExact(cands: readonly ResolverCandidate[]): ResolverCandidate[] {
  const exact = cands.filter((c) => c.exact);
  return uniq(exact.length ? exact : cands);
}

/** Một bậc CHẮC khi mọi ứng viên đọc chắc trỏ đúng một xã (đúng tỉnh của đơn khi đơn đã đọc được tỉnh). HÀM THUẦN. */
export function decideTier(cands: readonly ResolverCandidate[], provinceCode: number | null): { status: ResolverStatus; pick: ResolverCandidate | null; kept: ResolverCandidate[] } {
  const kept = uniq(provinceCode === null ? cands : cands.filter((c) => c.provinceCode === provinceCode));
  if (!kept.length) return { status: "NONE", pick: null, kept };
  return kept.length === 1 && kept[0].exact ? { status: "SURE", pick: kept[0], kept } : { status: "UNSURE", pick: null, kept };
}

/** Chạy thang, dừng ở bậc đầu tiên CHẮC; không bậc nào chắc ⇒ thử GIAO các bậc độc lập. HÀM THUẦN. */
export function resolveAddress(input: ResolverInput): ResolverVerdict {
  const provinceCode = parseCustomerAddress(input.recipient.address, input.recipient.province).provinceCode;
  const tiers: [ResolverSource, () => ResolverCandidate[]][] = [
    ["TEXT", () => textCandidates(input)],
    ["C360", () => c360Candidates(input)],
    ["PLACES", () => (input.places ? placesCandidates(input.places) : [])],
  ];
  const seen: { source: ResolverSource; kept: ResolverCandidate[] }[] = [];
  for (const [source, run] of tiers) {
    if (source === "PLACES" && !input.places) break;
    const d = decideTier(run(), provinceCode);
    if (d.status === "SURE" && d.pick) return { status: "SURE", source, pick: d.pick, candidates: d.kept, reason: `${source}: một xã duy nhất ${d.pick.ward}, ${d.pick.province}` };
    if (d.kept.length) seen.push({ source, kept: d.kept });
    // GIAO hai nguồn ĐỘC LẬP còn đúng một xã ⇒ chắc (vd chữ khách «phường Khương Trung cũ» ∩ địa chỉ Google ⇒ một xã mới).
    if (seen.length >= 2) {
      const inter = seen.slice(1).reduce((acc, t) => acc.filter((c) => t.kept.some((x) => keyOf(x) === keyOf(c))), seen[0].kept);
      if (inter.length === 1) {
        const pick = { ...inter[0], source, exact: true };
        return { status: "SURE", source, pick, candidates: inter, reason: `${seen.map((t) => t.source).join(" ∩ ")}: giao còn đúng một xã ${pick.ward}, ${pick.province}` };
      }
    }
  }
  const cands = uniq(seen.flatMap((t) => t.kept));
  if (cands.length) return { status: "UNSURE", source: null, pick: null, candidates: cands, reason: `${cands.length} ứng viên (${seen.map((t) => t.source).join(" · ")}) — nhân viên chọn` };
  return { status: "NONE", source: null, pick: null, candidates: [], reason: input.places ? "không bậc nào ra xã của danh mục" : "chữ khách + địa chỉ đã xác minh không ra xã; chưa tra Google" };
}
