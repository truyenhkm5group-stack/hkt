"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { NAV_TITLES } from "@/components/app-sidebar";
import { DYNAMIC_PAGE_PREFIX } from "@/lib/pages/nav";

/**
 * ĐƯỜNG QUAY LẠI CHO TRANG CHI TIẾT.
 *
 * Thanh bên cũ có breadcrumb "Đơn hàng / 48210" ở đầu trang. Thanh menu viên thuốc không còn chỗ cho
 * nó, nhưng người đang xem MỘT đơn vẫn cần một cú bấm để về danh sách — nên dòng này chỉ hiện ở
 * trang chi tiết (đường dẫn sâu hơn trang có mục menu), và không chiếm chỗ ở mọi trang khác.
 */
/**
 * Khu vực tự vẽ đường quay lại / lối ra của chính nó — không in dòng vị trí. Hộp thư khách (INBOX-V2-A): màn làm việc cao bằng
 * màn hình, đầu trang gọn; dòng «Chatbot bán hàng / inbox» in slug tiếng Anh và ăn ~30 px phía trên danh sách hội thoại, còn lối
 * về cấu hình chatbot đã là nút ⚙ cạnh ô tìm.
 */
const OWN_NAV_PREFIXES = ["/wholesale/mobile", "/ai/sales-chatbot/inbox"];

/**
 * Đoạn đường dẫn → chữ người đọc (chủ shop 09/10/2026: breadcrumb không dùng route kỹ thuật). Mã bản ghi (có chữ số / dạng
 * id) in «Chi tiết» — tiêu đề trang đã mang tên hoặc số của bản ghi, in lại mã thô «erp-b4ae…» chỉ là nhiễu.
 */
const SEGMENT_LABEL: Record<string, string> = { new: "Tạo mới", edit: "Sửa", import: "Nhập tệp", print: "In", history: "Lịch sử", settings: "Cài đặt" };

export function crumbLabel(segment: string): string {
  const s = decodeURIComponent(segment);
  if (SEGMENT_LABEL[s]) return SEGMENT_LABEL[s];
  // Mã bản ghi: có chữ số, hoặc chuỗi dài không dấu cách (uuid, id đồng bộ).
  if (/\d/.test(s) || (s.length > 20 && !/\s/.test(s))) return "Chi tiết";
  return s;
}

/** Khoá phiên (sessionStorage) giữ URL danh sách cuối cùng của từng mục menu — để «quay lại» giữ bộ lọc / trang / tìm kiếm. */
const LIST_KEY = (href: string) => `erp.crumb.list:${href}`;

/** `skip`: trang đứng trên thanh tám mục của vỏ app Chốt Đơn — là trang gốc, không phải trang chi tiết, nên không in đường quay lại. */
export function DetailCrumb({ skip = [] }: { skip?: readonly string[] }) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  /*
    GIỮ NGỮ CẢNH DANH SÁCH: đang ở một trang có mục menu (danh sách) thì nhớ URL đầy đủ (bộ lọc · trang · tìm kiếm); ở trang
    chi tiết thì nút quay lại dùng URL đó thay vì danh sách trống. Chỉ lưu trong phiên trình duyệt; lỗi bộ nhớ ⇒ về danh sách trần.
  */
  const [backHref, setBackHref] = useState<string | null>(null);
  const listHref = segments.length ? (NAV_TITLES[`/${segments.slice(0, 2).join("/")}`] ? `/${segments.slice(0, 2).join("/")}` : `/${segments[0]}`) : "/";
  useEffect(() => {
    try {
      if (NAV_TITLES[pathname]) window.sessionStorage.setItem(LIST_KEY(pathname), pathname + window.location.search);
      else setBackHref(window.sessionStorage.getItem(LIST_KEY(listHref)));
    } catch {
      setBackHref(null);
    }
  }, [pathname, listHref]);
  if (segments.length < 2) return null;
  if (skip.includes(pathname)) return null;
  // Trang tuỳ biến `/p/<slug>` (Phase 4) không phải trang chi tiết: không có trang `/p` trần để quay về, và trang
  // động tự in tên của nó. "/p" có trong NAV_TITLES chỉ để làm khoá đếm lượt mở.
  if (`/${segments[0]}` === DYNAMIC_PAGE_PREFIX) return null;
  // Màn điện thoại của sale sỉ tự có nút quay lại to bằng ngón tay — dòng vị trí in «queue» / mã lead chỉ chiếm chỗ.
  if (OWN_NAV_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  const twoLevel = `/${segments.slice(0, 2).join("/")}`;
  // Trang có mục menu riêng (vd /reports/returns) KHÔNG phải trang chi tiết.
  if (NAV_TITLES[twoLevel] && segments.length === 2) return null;
  const parentHref = listHref;
  const parentTitle = NAV_TITLES[parentHref];
  if (!parentTitle) return null;
  // «Chi tiết / Sửa» thay «demo-o-5209 / edit»; hai «Chi tiết» liền nhau gộp một.
  const detail = segments
    .slice(parentHref.split("/").length - 1)
    .map(crumbLabel)
    .filter((label, i, all) => i === 0 || label !== all[i - 1])
    .join(" / ");
  return (
    <nav aria-label="Vị trí" className="-mb-2 flex items-center gap-1 text-[13px] text-muted-foreground print:hidden">
      <Link href={backHref ?? parentHref} className="flex items-center gap-1 rounded-full px-2 py-1 font-medium hover:bg-card hover:text-foreground" title={backHref && backHref !== parentHref ? "Quay lại danh sách — giữ bộ lọc bạn đang dùng" : undefined}>
        <ChevronLeft className="size-4" aria-hidden />
        {parentTitle}
      </Link>
      <span aria-hidden>/</span>
      <span className="max-w-[240px] truncate px-1">{detail}</span>
    </nav>
  );
}
