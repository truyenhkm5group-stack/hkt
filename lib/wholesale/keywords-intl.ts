import { DEFAULT_KEYWORD_GROUPS, type KeywordGroup } from "@/lib/wholesale/config";
import type { LeadSegment } from "@/lib/wholesale/segments";

/**
 * ═══════════ TỪ KHOÁ KHÁCH SỈ QUỐC TẾ / B2B — THEO PHÂN KHÚC ═══════════
 *
 * Chủ shop chốt 27/10/2026: tìm khách sỉ nước ngoài cho hàng đặc sản đóng gói của HSLC. Mỗi nhóm = một phân khúc, khai
 * `segments` là nhóm khách (segments.ts) mà từ khoá ấy nhắm tới — form gợi ý đúng «nhóm khách mục tiêu» khi bật nhóm.
 *
 *  · Tiếng Anh (`en`) áp MỌI nước quốc tế (areas-intl.ts luôn có `en` trong `keywordLangs`), KHÔNG áp tỉnh trong nước.
 *  · Tiếng bản địa chỉ khai ở năm ngôn ngữ chắc nghĩa: Nhật (`ja`), Hàn (`ko`), Trung phồn thể (`zh-Hant`: Đài Loan +
 *    Hồng Kông), Đức (`de`), Pháp (`fr`). Không có tiếng Thái / Hà Lan / Mã Lai: không chắc nghĩa thì không khai — tiếng
 *    Anh vẫn quét được các nước ấy.
 *  · MỌI nhóm TẮT sẵn: quét tốn tiền, chủ shop tự bật đúng nhóm rồi xem trước chi phí (luật 23 — mẫu không tự kích hoạt).
 *  · «Chuỗi nhà hàng» và «chuỗi siêu thị» không có khoá nhóm khách riêng: chúng vào RESTAURANT / SUPERMARKET sẵn có.
 *
 * Tệp THUẦN, client-safe.
 */

export type IntlKeywordGroup = KeywordGroup & { lang: string; segments: readonly LeadSegment[] };

export const INTL_KEYWORD_GROUPS: readonly IntlKeywordGroup[] = [
  { key: "intl-seafood-importer", label: "QT · Nhập khẩu / bán sỉ hải sản", keywords: ["seafood importer", "seafood wholesaler", "frozen seafood distributor"], enabled: false, lang: "en", segments: ["SEAFOOD_IMPORTER"] },
  { key: "intl-asian-grocery", label: "QT · Bán sỉ / nhập khẩu thực phẩm châu Á", keywords: ["Asian grocery wholesale", "Asian food importer", "Vietnamese food wholesale"], enabled: false, lang: "en", segments: ["ASIAN_FOOD_WHOLESALE"] },
  { key: "intl-horeca", label: "QT · Nhà cung cấp HORECA / phân phối thực phẩm", keywords: ["HORECA supplier", "foodservice distributor", "restaurant supply"], enabled: false, lang: "en", segments: ["FOODSERVICE_DISTRIBUTOR"] },
  { key: "intl-restaurant-chain", label: "QT · Chuỗi nhà hàng Việt / châu Á", keywords: ["Vietnamese restaurant chain", "Asian restaurant group"], enabled: false, lang: "en", segments: ["RESTAURANT", "SEAFOOD_RESTAURANT"] },
  { key: "intl-supermarket", label: "QT · Chuỗi siêu thị châu Á (thu mua)", keywords: ["Asian supermarket chain", "Asian supermarket head office"], enabled: false, lang: "en", segments: ["SUPERMARKET"] },
  { key: "intl-private-label", label: "QT · Nhãn riêng / OEM thực phẩm", keywords: ["private label seafood", "private label food company"], enabled: false, lang: "en", segments: ["PRIVATE_LABEL_OEM"] },
  // ── Bản địa — mỗi chuỗi đã soát nghĩa: «bán sỉ hải sản», «bán sỉ thực phẩm / nguyên liệu», «nhập khẩu thực phẩm». ──
  { key: "intl-ja", label: "Nhật · 水産卸 / 食品卸 / 輸入食品卸", keywords: ["水産卸", "食品卸", "輸入食品 卸"], enabled: false, lang: "ja", segments: ["SEAFOOD_IMPORTER", "FOODSERVICE_DISTRIBUTOR", "ASIAN_FOOD_WHOLESALE"] },
  { key: "intl-ko", label: "Hàn · 수산물 도매 / 식자재 도매 / 수입식품", keywords: ["수산물 도매", "식자재 도매", "수입식품 도매"], enabled: false, lang: "ko", segments: ["SEAFOOD_IMPORTER", "FOODSERVICE_DISTRIBUTOR", "ASIAN_FOOD_WHOLESALE"] },
  { key: "intl-zh-hant", label: "Đài Loan / Hồng Kông · 海鮮批發 / 食品進口商", keywords: ["海鮮批發", "冷凍海鮮批發", "食品進口商"], enabled: false, lang: "zh-Hant", segments: ["SEAFOOD_IMPORTER", "ASIAN_FOOD_WHOLESALE"] },
  { key: "intl-de", label: "Đức · Fischgroßhandel / Asia Großhandel", keywords: ["Fischgroßhandel", "Asia Großhandel", "Gastro Großhandel"], enabled: false, lang: "de", segments: ["SEAFOOD_IMPORTER", "ASIAN_FOOD_WHOLESALE", "FOODSERVICE_DISTRIBUTOR"] },
  { key: "intl-fr", label: "Pháp · grossiste produits de la mer / asiatique", keywords: ["grossiste produits de la mer", "grossiste alimentaire asiatique", "fournisseur restauration"], enabled: false, lang: "fr", segments: ["SEAFOOD_IMPORTER", "ASIAN_FOOD_WHOLESALE", "FOODSERVICE_DISTRIBUTOR"] },
];

/** Mọi nhóm từ khoá form chiến dịch hiển thị: bộ trong nước (đặc tả mục 21) rồi bộ quốc tế. Khoá không trùng (có bài kiểm). */
export const ALL_KEYWORD_GROUPS: readonly KeywordGroup[] = [...DEFAULT_KEYWORD_GROUPS, ...INTL_KEYWORD_GROUPS];
