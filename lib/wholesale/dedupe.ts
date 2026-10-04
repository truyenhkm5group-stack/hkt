import { SHARED_WEBSITE_HOSTS } from "@/lib/wholesale/constants";
import { foldVietnamese } from "@/lib/wholesale/segments";

/**
 * ═══════════ KHOÁ KHỬ TRÙNG LEAD — HÀM THUẦN ═══════════
 *
 * Thứ tự khử trùng (đặc tả mục 4): Place ID → SĐT chuẩn hoá (`phone.ts`) → tên miền website → tên + địa chỉ chuẩn
 * hoá. Tệp này dựng hai khoá cuối. Mỗi khoá chỉ trả giá trị khi CHẮC — không chắc thì `null` (không gộp hai doanh nghiệp
 * khác nhau làm một chỉ vì cùng đăng trang Facebook hay cùng tên «Nhà hàng Hải Sản»).
 */

function hostOf(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** `https://www.NhaHangABC.vn/lien-he` ⇒ `nhahangabc.vn`. Host dùng chung (Facebook, Linktree…) ⇒ `null`. */
export function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = hostOf(url);
  if (!host || !host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const bare = host.replace(/^(www\d*|m)\./, "");
  if (SHARED_WEBSITE_HOSTS.some((h) => bare === h || bare.endsWith(`.${h}`))) return null;
  return bare;
}

/** Website là trang mạng xã hội — dùng để điền ô Facebook / Zalo thay vì ô website. */
export function socialKind(url: string | null | undefined): "FACEBOOK" | "ZALO" | null {
  const host = url ? hostOf(url) : null;
  if (!host) return null;
  const bare = host.replace(/^(www|m|web)\./, "");
  if (bare === "facebook.com" || bare === "fb.com" || bare === "fb.me") return "FACEBOOK";
  if (bare === "zalo.me" || bare === "oa.zalo.me") return "ZALO";
  return null;
}

/** Từ chung trong tên quán — bỏ đi để «Nhà hàng Hải Sản Biển Đông» và «Hải sản Biển Đông» ra cùng khoá. */
const NAME_STOPWORDS = new Set(["nha", "hang", "quan", "an", "cua", "hang", "cong", "ty", "tnhh", "restaurant", "the", "va", "and", "co", "so", "chi", "nhanh", "cn"]);

/**
 * Khoá tên + địa chỉ. Tên bỏ dấu + bỏ từ chung; địa chỉ chỉ lấy SỐ NHÀ + TÊN ĐƯỜNG đầu tiên (phần trước dấu phẩy đầu)
 * — đủ chặt để hai chi nhánh khác đường không bị gộp, đủ lỏng để hai cách viết cùng một địa chỉ gộp được.
 * Tên quá ngắn sau khi bỏ từ chung (< 4 ký tự) hoặc thiếu địa chỉ ⇒ `null`: không đủ chứng cứ để gộp.
 */
export function nameAddressKey(name: string | null | undefined, address: string | null | undefined): string | null {
  const n = foldVietnamese(name)
    .trim()
    .split(" ")
    .filter((w) => w && !NAME_STOPWORDS.has(w))
    .join(" ");
  if (n.replace(/\s/g, "").length < 4) return null;
  const firstPart = (address ?? "").split(",")[0] ?? "";
  const a = foldVietnamese(firstPart).trim();
  if (a.length < 4 || !/\d/.test(a)) return null; // không có số nhà ⇒ chưa đủ cụ thể
  return `${n}|${a}`;
}

/** Tên có dấu hiệu chuỗi / nhiều cơ sở: «chi nhánh», «CN2», «cơ sở 3», «… - 2». */
export function branchHint(name: string | null | undefined): boolean {
  const n = foldVietnamese(name);
  return / chi nhanh | cn ?\d+ | co so ?\d+ | branch /.test(n);
}
