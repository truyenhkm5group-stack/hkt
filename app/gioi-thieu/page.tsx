import type { Metadata } from "next";
import { Playfair_Display } from "next/font/google";
import type { LucideIcon } from "lucide-react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  BellRing,
  Bot,
  Boxes,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  Clock,
  Globe,
  GraduationCap,
  HandCoins,
  Hand,
  Menu,
  MessageCircle,
  MessagesSquare,
  NotebookPen,
  Package,
  Phone,
  Repeat,
  ScanSearch,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Tags,
  UserRound,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { BrandGlyph, BrandLockup } from "@/components/brand";
import { COMPANY, PRIVACY_POLICY, SERVICE_COMMITMENTS, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { TRIAL_DAYS } from "@/lib/billing/rules";
import { formatNumber, formatVND } from "@/lib/format";
import { BUSINESS_TYPES, BUSINESS_TYPE_SPEC, type BusinessType } from "@/lib/onboarding/shared";
import { getPublicSiteData, type PublicPlan, type PublicSiteData } from "@/lib/queries/public-site";

/**
 * TRANG GIỚI THIỆU CÔNG KHAI — mặt tiền của nền tảng ở tên miền gốc (`vnxcommerce.com`, xem lib/platform/site-host.ts).
 *
 * TRỌNG TÂM: nhân viên bán hàng AI (module `ai_sales`, `lib/sales-chatbot/`). Mọi năng lực in trên trang là thứ một cửa
 * hàng MỚI tự đăng ký dùng được — đã rà trên `main` 04/10/2026. Không nhắc những gì chỉ bot của tổ chức nhà có (`chatbot/`:
 * tin nhắn thoại, chặn đơn trùng, nhận SĐT qua nút chia sẻ), và không nhắc kết nối tự động chỉ tổ chức nhà có.
 * Không số liệu khách hàng, logo hay lời chứng thực bịa; hội thoại và bảng số là VÍ DỤ và mang nhãn ấy.
 * Ngành hàng đọc từ `BUSINESS_TYPES`, giá và hạn mức AI đọc từ `platform_plans`, số ngày dùng thử từ `TRIAL_DAYS`.
 *
 * Phong cách tham khảo weops.vn: nền sáng kẻ ô mờ, tiêu đề chữ có chân, nhãn mục viết hoa có gạch chân, các bước đánh số
 * trong vòng tròn, sơ đồ kiến trúc nối kênh → trợ lý → hệ thống.
 */

export const dynamic = "force-dynamic";

/** Phông tiêu đề — `next/font` tải LÚC BUILD và phục vụ từ chính máy chủ, trình duyệt không gọi Google Fonts. */
const display = Playfair_Display({ subsets: ["latin", "vietnamese"], weight: ["600", "700"], variable: "--font-display", display: "swap" });
const SERIF = "[font-family:var(--font-display),Georgia,serif]";

/** Khung nội dung — MỘT chỗ khai, tính bằng rem để giãn cùng tỷ lệ với `SITE_SCALE_CSS`. */
const WRAP = "mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10 2xl:px-14";

/**
 * MÀN RỘNG: phóng cả trang theo cỡ chữ gốc — chữ, khoảng cách và khung lớn cùng tỷ lệ. Thẻ `<style>` chỉ sống trên trang
 * này: mọi lối ra đều là liên kết tải lại trang.
 */
const SITE_SCALE_CSS =
  "@media (min-width:1800px){html{font-size:17px}}@media (min-width:2200px){html{font-size:18.5px}}@media (min-width:2500px){html{font-size:20px}}@media (min-width:3200px){html{font-size:24px}}";

/** Lưới kẻ ô mờ kiểu giấy kỹ thuật — ăn theo token `--hairline` nên đúng ở cả giao diện sáng lẫn tối. */
const GRID_STYLE: React.CSSProperties = {
  backgroundImage: "linear-gradient(to right, var(--hairline) 1px, transparent 1px), linear-gradient(to bottom, var(--hairline) 1px, transparent 1px)",
  backgroundSize: "44px 44px",
  maskImage: "radial-gradient(ellipse 80% 70% at 50% 40%, #000 35%, transparent 100%)",
  WebkitMaskImage: "radial-gradient(ellipse 80% 70% at 50% 40%, #000 35%, transparent 100%)",
};

const TITLE = "VNXcommerce — Nhân viên bán hàng AI trực fanpage 24/7, tự tư vấn và chốt đơn";
const DESCRIPTION =
  "Trợ lý AI trả lời khách trên fanpage trong vài giây bằng đúng giá và tồn kho của shop, xem ảnh khách gửi, chốt đơn khi khách đồng ý — rồi đơn chạy thẳng vào kho, tiền thu hộ và báo cáo lãi. Dùng thử miễn phí.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", locale: "vi_VN" },
};

const NAV = [
  { href: "#cach-hoat-dong", label: "Cách hoạt động" },
  { href: "#tro-ly-ai", label: "Trợ lý AI" },
  { href: "#he-thong", label: "Hệ thống" },
  { href: "#bang-gia", label: "Bảng giá" },
  { href: "#hoi-dap", label: "Hỏi đáp" },
];

const PROBLEMS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Clock, title: "Trả lời chậm là mất khách", text: "Khách hỏi ba shop cùng lúc. Ai trả lời trước, có giá, có size — người đó chốt đơn." },
  { icon: Users, title: "Trực tin nhắn tốn người", text: "Một nhân viên trực fanpage cả ngày lẫn đêm vẫn không kịp khi quảng cáo đang chạy mạnh." },
  { icon: CircleAlert, title: "Báo sai giá, sai tồn", text: "Nhớ nhầm giá, hứa còn hàng rồi hết — khách bực, đơn huỷ, hàng hoàn." },
  { icon: NotebookPen, title: "Chép đơn tay từ tin nhắn", text: "Chép số điện thoại, địa chỉ sang phần mềm — sai một số là mất một đơn." },
];

const STEPS_FLOW = [
  { title: "Đọc tin nhắn", text: "Tin nhắn fanpage, bình luận dưới quảng cáo, cả ảnh khách chụp gửi." },
  { title: "Tra kho thật", text: "Giá, size, màu, hàng còn, phí ship — đọc thẳng từ hệ thống của shop." },
  { title: "Chốt thông tin", text: "Hỏi số điện thoại, địa chỉ; gửi bản tóm tắt đơn để khách xác nhận." },
  { title: "Ghi vào hệ thống", text: "Kiểm lại giá và tồn, chốt đơn — đơn có mặt ngay ở kho và sổ sách." },
];

const CHANNELS: { icon: LucideIcon; label: string }[] = [
  { icon: MessageCircle, label: "Tin nhắn fanpage" },
  { icon: MessagesSquare, label: "Bình luận quảng cáo" },
  { icon: Globe, label: "Ô chat trên website" },
  { icon: Sparkles, label: "Trang chat riêng của shop" },
];

const SYSTEM_PARTS: { icon: LucideIcon; label: string }[] = [
  { icon: Tags, label: "Sản phẩm & bảng giá" },
  { icon: Boxes, label: "Tồn kho theo size, màu" },
  { icon: UserRound, label: "Khách hàng & lịch sử mua" },
  { icon: ShoppingBag, label: "Đơn hàng" },
  { icon: CircleDollarSign, label: "Báo cáo lãi thật" },
];

type Capability = { icon: LucideIcon; title: string; text: string; span?: string; visual?: "catalog" | "industries" };

const CAPABILITIES: Capability[] = [
  {
    icon: Tags,
    title: "Tư vấn đúng giá, đúng hàng còn",
    text: "Giá, size, màu, tồn kho và phí ship đọc thẳng từ hệ thống. Chưa có giá thì không báo bừa; không tự ý giảm giá ngoài bảng giá của shop.",
    span: "lg:col-span-2",
    visual: "catalog",
  },
  { icon: ScanSearch, title: "Nhìn được ảnh khách gửi", text: "Khách gửi ảnh chụp màn hình — trợ lý tìm đúng mẫu trong kho rồi hỏi lại cho chắc." },
  { icon: ShoppingBag, title: "Chốt đơn trọn vòng", text: "Lấy số điện thoại, địa chỉ, dùng sẵn tên Facebook; tóm tắt đơn và chỉ chốt khi khách đồng ý." },
  { icon: MessagesSquare, title: "Trả lời bình luận quảng cáo", text: "Nhắn riêng cho người bình luận, biết ngay họ hỏi sản phẩm của quảng cáo nào." },
  { icon: BellRing, title: "Nhắn lại khách im lặng", text: "Khách đọc rồi lặng im? Trợ lý nhắn lại sau 1 giờ, 6 giờ và 22 giờ." },
  { icon: Repeat, title: "Nhận ra khách cũ", text: "Gợi ý lại địa chỉ đã giao (che bớt số), mời mua lại, gợi ý mua kèm." },
  { icon: Hand, title: "Biết lúc cần người", text: "Khiếu nại, đòi gặp người, đơn sỉ ngoài bảng giá — chuyển ngay cho nhân viên. Nhân viên trả lời là trợ lý tự lùi lại." },
  { icon: GraduationCap, title: "Tự học mỗi ngày", text: "Soạn sổ tay bán hàng từ hội thoại cũ để chủ shop duyệt, rút bài học từ hội thoại thật mỗi 6 giờ." },
  { icon: Zap, title: "Không sót tin nào", text: "Tin bị rơi được quét lại và trả lời trong khoảng 5 phút. Chạy 24/7 hoặc theo giờ mở cửa." },
  {
    icon: CalendarCheck,
    title: "Đặt lịch, đặt bàn, báo giá sỉ",
    text: "Mỗi ngành một cách bán: trợ lý mời khách vào giờ còn trống, nhận đặt bàn theo số khách, báo giá theo số lượng.",
    span: "lg:col-span-2",
    visual: "industries",
  },
];

const SAFETY: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: ShieldCheck, title: "Không bịa giá", text: "Giá, hàng còn và phí ship chỉ lấy từ hệ thống. Không tự giảm giá ngoài bảng giá." },
  { icon: BadgeCheck, title: "Chốt khi khách đồng ý", text: "Gửi bản tóm tắt, chỉ chốt khi khách xác nhận — và kiểm lại giá, tồn ngay trước khi chốt." },
  { icon: Hand, title: "Người luôn cầm lái", text: "Ca khó tự chuyển cho nhân viên. Nhân viên nhắn là trợ lý im 30 phút; một nút để trả lại cho AI." },
  { icon: Wallet, title: "Chi phí AI hiện rõ", text: "Bảng điều khiển tính sẵn chi phí AI trên mỗi đơn chốt và mỗi số điện thoại thu được." },
];

const COMPARE: { topic: string; old: string; next: string }[] = [
  { topic: "Hiểu khách", old: "Chỉ hiểu từ khoá đã cài sẵn", next: "Hiểu câu nói tự nhiên, cả ảnh khách gửi" },
  { topic: "Giá & tồn kho", old: "Gõ tay vào kịch bản, dễ lệch", next: "Đọc thẳng từ kho, đúng size và màu" },
  { topic: "Chốt đơn", old: "Thu thông tin rồi chờ người nhập", next: "Tóm tắt, chốt khi khách đồng ý, đơn vào thẳng hệ thống" },
  { topic: "Khách im lặng", old: "Bỏ lửng", next: "Nhắn lại sau 1, 6 và 22 giờ" },
  { topic: "Ca khó", old: "Trả lời sai hoặc im lặng", next: "Chuyển cho nhân viên, nhân viên vào là trợ lý lùi" },
  { topic: "Học thêm", old: "Phải tự sửa kịch bản", next: "Rút bài học từ hội thoại thật mỗi 6 giờ" },
];

/** Trợ lý trong từng ngành — chỉ những ngành mà `lib/sales-chatbot` thật sự có công cụ riêng; ngành khác in câu chung. */
const INDUSTRY_COPY: Partial<Record<BusinessType, { label: string; text: string }>> = {
  fashion: { label: "Thời trang", text: "Tư vấn size, màu theo hàng còn; xem ảnh khách gửi để tìm đúng mẫu." },
  ecommerce: { label: "Bán lẻ online", text: "Trả lời giá, hàng còn, phí ship cho nhiều ngành hàng cùng lúc." },
  food: { label: "Thực phẩm đóng gói", text: "Báo giá theo quy cách, phí ship theo khu vực, chốt đơn ngay trong tin nhắn." },
  seafood: { label: "Hải sản", text: "Bán lẻ và báo giá sỉ theo số lượng cho quán, đại lý khi shop bật bảng giá sỉ." },
  spa: { label: "Spa, làm đẹp", text: "Chỉ mời khách vào giờ còn trống, đặt lịch theo kỹ thuật viên khi khách đồng ý." },
  restaurant: { label: "Nhà hàng, quán ăn", text: "Nhận đặt bàn theo số khách và bàn còn trống, gọi món theo thực đơn." },
  wholesale: { label: "Bán sỉ, phân phối", text: "Báo giá theo bậc số lượng; đơn sỉ ngoài bảng giá chuyển cho nhân viên." },
  manufacturing: { label: "Sản xuất", text: "Nguyên liệu, đặt hàng, kế hoạch sản xuất và kho — bộ tính năng gợi ý sẵn." },
  service: { label: "Dịch vụ", text: "Khách hàng, chăm sóc khách, thu chi — bộ tính năng gợi ý sẵn." },
};

const BEHIND: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: CircleDollarSign, title: "Lãi thật", text: "Doanh thu theo tiền đã về; đơn hoàn, phí ship, giá vốn, quảng cáo trừ đủ." },
  { icon: HandCoins, title: "Tiền thu hộ", text: "Tải bảng kê và sao kê lên, phần mềm khớp từng đơn, chỉ ra khoản chưa về." },
  { icon: Boxes, title: "Kho không ảo", text: "Tự trừ khi giao hàng; hàng hoàn chỉ cộng lại khi kho đếm thực tế." },
  { icon: Repeat, title: "Khách cũ", text: "Danh sách khách tới hẹn mua lại, nhắn Zalo một chạm; bảng giá sỉ, công nợ." },
  { icon: Users, title: "Đội ngũ", text: "Lương, hoa hồng theo đơn giao thành công; mỗi người chỉ thấy phần việc của mình." },
];

const START_STEPS = [
  { title: "Tạo cửa hàng", text: "Năm ô: tên cửa hàng, ngành, số điện thoại, email, mật khẩu — hoặc một nút Google / Facebook." },
  { title: "Kết nối fanpage", text: "Dán mã trang và mã truy cập Pancake, chép đường dẫn nhận tin vào Pancake." },
  { title: "Bật trợ lý", text: "Một nút. AI có sẵn trong gói — không phải tự mua tài khoản AI." },
];

function faqs(): { q: string; a: string }[] {
  return [
    { q: "Trợ lý có báo sai giá không?", a: "Trợ lý chỉ báo giá, hàng còn và phí ship lấy từ hệ thống của shop. Sản phẩm chưa có giá thì trợ lý nói nhân viên sẽ báo sau, không tự đoán; không tự giảm giá ngoài bảng giá." },
    { q: "Trợ lý có tự chốt đơn không?", a: "Có. Trợ lý gửi bản tóm tắt đơn và chỉ chốt khi khách đồng ý, kiểm lại giá và hàng còn ngay trước khi chốt. Đơn chốt xong có mặt ngay trong hệ thống. Ca khó — khiếu nại, đòi gặp người, đơn sỉ ngoài bảng giá — được chuyển cho nhân viên." },
    { q: "Nhân viên muốn tự trả lời thì sao?", a: "Nhân viên nhắn vào cuộc trò chuyện là trợ lý tự im 30 phút. Muốn giao lại thì bấm “Trả lại cho AI”." },
    { q: "Cần những gì để chạy?", a: "Fanpage của shop kết nối qua Pancake. Mỗi gói có sẵn hạn mức AI hằng tháng; shop muốn dùng tài khoản AI riêng (Anthropic, OpenAI, Gemini) thì vẫn khai được." },
    { q: "Ngoài fanpage, trợ lý chạy ở đâu nữa?", a: "Ô chat gắn lên website của shop bằng một dòng mã, và trang chat riêng ở địa chỉ của cửa hàng sau khi xuất bản." },
    { q: "Dùng thử thế nào, có mất tiền không?", a: `${TRIAL_DAYS} ngày miễn phí, không cần thẻ ngân hàng. Hết hạn mà chưa chọn gói thì cửa hàng chuyển sang chỉ xem; dữ liệu được giữ ít nhất ${SERVICE_COMMITMENTS.retainAfterExpiryDays} ngày.` },
    { q: "Thanh toán gói trả phí thế nào?", a: `Chuyển khoản theo mã thanh toán phần mềm tạo sẵn; tiền về, khớp mã là gói được gia hạn. Lần thanh toán đầu tiên được hoàn 100% nếu yêu cầu trong ${SERVICE_COMMITMENTS.firstPaymentRefundDays} ngày.` },
    { q: "Dữ liệu của tôi có an toàn không?", a: "Mỗi cửa hàng có kho dữ liệu riêng, tách hẳn khỏi cửa hàng khác. Trong cửa hàng, bạn quyết định nhân viên nào được xem phần nào." },
  ];
}

function signupCopy(data: PublicSiteData): { label: string; short: string; tiny: string; note: string | null } {
  switch (data.signup) {
    case "open":
      return { label: `Dùng thử miễn phí ${TRIAL_DAYS} ngày`, short: "Dùng thử miễn phí", tiny: "Dùng thử", note: `${TRIAL_DAYS} ngày miễn phí · Không cần thẻ ngân hàng · Có sẵn AI` };
    case "invite":
      return { label: "Đăng ký bằng mã mời", short: "Đăng ký", tiny: "Đăng ký", note: "Đang mở theo lời mời: cần mã mời để tạo cửa hàng mới." };
    case "off":
      return { label: "Đăng ký", short: "Đăng ký", tiny: "Đăng ký", note: "Tạm ngừng nhận cửa hàng mới. Đã có tài khoản thì đăng nhập để dùng tiếp." };
    default:
      return { label: "Đăng ký", short: "Đăng ký", tiny: "Đăng ký", note: null };
  }
}

function limitLines(plan: PublicPlan): string[] {
  const lines: string[] = [];
  if (plan.aiIncluded) lines.push("Kèm hạn mức AI cho trợ lý chat");
  if (plan.users !== undefined) lines.push(plan.users === null ? "Không giới hạn người dùng" : `Tối đa ${formatNumber(plan.users)} người dùng`);
  if (plan.storageMb !== undefined) {
    if (plan.storageMb === null) lines.push("Không giới hạn dung lượng tệp");
    else lines.push(plan.storageMb >= 1024 ? `${formatNumber(Math.round((plan.storageMb / 1024) * 10) / 10)} GB lưu trữ tệp` : `${formatNumber(plan.storageMb)} MB lưu trữ tệp`);
  }
  if (plan.records !== undefined) lines.push(plan.records === null ? "Không giới hạn dữ liệu tự tạo" : `${formatNumber(plan.records)} dòng dữ liệu tự tạo`);
  return lines;
}

/** Số cột của bảng giá theo SỐ THẺ — gói mới thêm ở /platform không được rơi lẻ một hàng. */
const PLAN_GRID: Record<number, string> = { 1: "lg:grid-cols-1", 2: "lg:grid-cols-2", 3: "lg:grid-cols-3", 4: "lg:grid-cols-4", 5: "lg:grid-cols-3 xl:grid-cols-5" };

// ═══════════ KHỐI DỰNG ═══════════

function GridBackdrop() {
  return <div className="pointer-events-none absolute inset-0" style={GRID_STYLE} aria-hidden />;
}

function Eyebrow({ children, invert = false, center = true }: { children: React.ReactNode; invert?: boolean; center?: boolean }) {
  return (
    <div className={center ? "text-center" : ""}>
      <p className={`text-[11px] font-semibold uppercase tracking-[0.28em] ${invert ? "text-brand-bright" : "text-brand"}`}>{children}</p>
      <span className={`mt-3 block h-0.5 w-10 rounded-full ${invert ? "bg-brand-bright" : "bg-brand"} ${center ? "mx-auto" : ""}`} />
    </div>
  );
}

function SectionHead({ eyebrow, title, text, invert = false }: { eyebrow: string; title: React.ReactNode; text?: string; invert?: boolean }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <Eyebrow invert={invert}>{eyebrow}</Eyebrow>
      <h2 className={`${SERIF} mt-5 text-[clamp(1.75rem,1.1rem+2vw,3.1rem)] font-bold leading-[1.15] tracking-tight text-balance`}>{title}</h2>
      {text ? <p className={`mx-auto mt-4 max-w-2xl text-base leading-7 ${invert ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{text}</p> : null}
    </div>
  );
}

function Accent({ children, invert = false }: { children: React.ReactNode; invert?: boolean }) {
  return <span className={invert ? "text-brand-bright" : "text-brand"}>{children}</span>;
}

/** Nút chính kiểu viên thuốc có ô mũi tên — như weops. */
function PrimaryCta({ href, children, size = "lg" }: { href: string; children: React.ReactNode; size?: "lg" | "sm" }) {
  const big = size === "lg";
  return (
    <a
      href={href}
      className={`group inline-flex items-center gap-3 rounded-full bg-brand font-semibold text-white shadow-[0_14px_30px_-12px_var(--brand)] transition hover:brightness-110 ${big ? "py-1.5 pr-1.5 pl-6 text-base" : "py-1 pr-1 pl-4 text-sm"}`}
    >
      {children}
      <span className={`flex items-center justify-center rounded-full bg-white/20 transition group-hover:translate-x-0.5 ${big ? "size-9" : "size-7"}`}>
        <ArrowUpRight className={big ? "size-4" : "size-3.5"} aria-hidden />
      </span>
    </a>
  );
}

function TextLink({ href, children, invert = false }: { href: string; children: React.ReactNode; invert?: boolean }) {
  return (
    <a href={href} className={`group inline-flex items-center gap-1.5 text-base font-semibold ${invert ? "text-sidebar-foreground/85 hover:text-sidebar-foreground" : "text-foreground/80 hover:text-foreground"}`}>
      {children}
      <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden />
    </a>
  );
}

/** Hội thoại mẫu ở phần đầu — VÍ DỤ minh hoạ cách trợ lý làm việc, không phải hội thoại của khách nào. */
function ChatMock() {
  return (
    <div className="relative mx-auto w-full max-w-[26rem]">
      <div className="pointer-events-none absolute -inset-10 rounded-full bg-brand/15 blur-3xl" aria-hidden />
      <div className="relative overflow-hidden rounded-[2rem] border border-border/70 bg-card text-card-foreground shadow-[var(--shadow-raised)]">
        <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3.5">
          <span className="flex size-9 items-center justify-center rounded-full bg-brand text-white">
            <BrandGlyph className="h-3" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Trợ lý của Shop Mây</p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-success" /> Đang trực · trả lời trong vài giây
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Ví dụ minh hoạ</span>
        </div>
        <div className="space-y-3 bg-[var(--surface-sunken)] px-4 py-5 text-[13px] leading-5">
          <div className="flex max-w-[82%] flex-col gap-1.5">
            <div className="flex h-20 w-28 items-center justify-center rounded-2xl rounded-bl-md bg-gradient-to-br from-chart-4/40 to-brand/30 text-[10px] font-medium text-foreground/60">ảnh khách gửi</div>
            <p className="rounded-2xl rounded-tl-md bg-card px-3.5 py-2 shadow-[var(--shadow-card)]">Mẫu này còn size M không shop?</p>
          </div>
          <div className="ml-auto flex max-w-[86%] flex-col items-end gap-1.5">
            <p className="rounded-2xl rounded-tr-md bg-brand px-3.5 py-2 text-white">Dạ còn ạ! Đây là mẫu chị hỏi:</p>
            <div className="w-full rounded-2xl border border-border/70 bg-card p-2.5 shadow-[var(--shadow-card)]">
              <div className="flex gap-2.5">
                <div className="size-12 shrink-0 rounded-xl bg-gradient-to-br from-chart-4/50 to-brand/40" />
                <div className="min-w-0">
                  <p className="truncate font-semibold">Đầm xoè hoa nhí</p>
                  <p className="font-bold text-brand tabular-nums">389.000 ₫</p>
                  <p className="text-[11px] text-success">Size M · L còn hàng</p>
                </div>
              </div>
            </div>
          </div>
          <p className="max-w-[82%] rounded-2xl rounded-tl-md bg-card px-3.5 py-2 shadow-[var(--shadow-card)]">Lấy 1 cái M, giao 12 ngõ 5 Láng Hạ nha, sđt 0912 xxx xxx</p>
          <div className="ml-auto max-w-[86%] rounded-2xl rounded-tr-md bg-brand px-3.5 py-2.5 text-white">
            <p className="font-semibold">Em tóm tắt đơn ạ:</p>
            <p className="mt-1 text-white/90">Đầm xoè hoa nhí · M × 1 · 389.000 ₫</p>
            <p className="text-white/90">Phí ship 25.000 ₫ · Tổng 414.000 ₫</p>
            <p className="mt-1">Chị xác nhận giúp em nhé?</p>
          </div>
          <p className="w-fit rounded-2xl rounded-tl-md bg-card px-3.5 py-2 shadow-[var(--shadow-card)]">Ok em</p>
          <p className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-[11px] font-semibold text-success">
            <Check className="size-3.5" aria-hidden /> Đơn đã chốt · đã vào hệ thống
          </p>
        </div>
      </div>
      <div className="absolute top-24 -left-10 hidden rounded-2xl bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-raised)] sm:block lg:-left-28">
        <p className="flex items-center gap-2 text-xs font-bold">
          <Zap className="size-4 text-brand" aria-hidden /> Trực 24/7
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">kể cả lúc 2 giờ sáng</p>
      </div>
      <div className="absolute -right-8 bottom-6 hidden rounded-2xl bg-card px-4 py-3 text-card-foreground shadow-[var(--shadow-raised)] sm:block lg:-right-24">
        <p className="flex items-center gap-2 text-xs font-bold">
          <Package className="size-4 text-success" aria-hidden /> Giá & hàng còn
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">lấy thẳng từ kho của shop</p>
      </div>
    </div>
  );
}

function CatalogVisual() {
  const rows = [
    { name: "Đầm xoè hoa nhí", size: "S · M · L", price: "389.000 ₫", stock: "Còn hàng", tone: "text-success bg-success/12" },
    { name: "Áo sơ mi lụa", size: "M · L", price: "295.000 ₫", stock: "Sắp hết", tone: "bg-warning/20 text-foreground" },
    { name: "Quần ống rộng", size: "—", price: "Chưa có giá", stock: "Nhân viên báo", tone: "bg-muted text-muted-foreground" },
  ];
  return (
    <div className="mt-5 overflow-hidden rounded-2xl border border-border/60 bg-[var(--surface-sunken)]">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2 border-b border-[var(--hairline)] px-3 py-2.5 text-xs last:border-b-0 sm:gap-3 sm:px-4">
          <span className="min-w-0 flex-1 truncate font-medium">{r.name}</span>
          <span className="hidden w-20 text-muted-foreground sm:block">{r.size}</span>
          <span className="shrink-0 text-right font-semibold tabular-nums sm:w-24">{r.price}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold sm:w-24 ${r.tone}`}>{r.stock}</span>
        </div>
      ))}
    </div>
  );
}

function IndustryChips() {
  const chips = ["Spa · đặt lịch theo giờ trống", "Nhà hàng · đặt bàn, gọi món", "Hải sản · báo giá sỉ theo số lượng", "Thời trang · tư vấn size, màu"];
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {chips.map((c) => (
        <span key={c} className="rounded-full border border-border/70 bg-[var(--surface-sunken)] px-3 py-1.5 text-xs font-medium">
          {c}
        </span>
      ))}
    </div>
  );
}

function PlanLimits({ plan, inverted = false }: { plan: PublicPlan; inverted?: boolean }) {
  const lines = limitLines(plan);
  if (lines.length === 0) return <div className="flex-1" />;
  return (
    <ul className="mt-5 flex-1 space-y-2.5 text-sm">
      {lines.map((l, i) => (
        <li key={l} className={`flex items-start gap-2 ${plan.aiIncluded && i === 0 ? "font-semibold" : ""}`}>
          {plan.aiIncluded && i === 0 ? (
            <Bot className={`mt-0.5 size-4 shrink-0 ${inverted ? "text-brand-bright" : "text-brand"}`} aria-hidden />
          ) : (
            <Check className={`mt-0.5 size-4 shrink-0 ${inverted ? "text-brand-bright" : "text-brand"}`} aria-hidden />
          )}
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}

// ═══════════ TRANG ═══════════

export default async function SitePage() {
  const data = await getPublicSiteData();
  const signup = signupCopy(data);
  const industries = BUSINESS_TYPES.filter((t) => t !== "blank").map((t) => ({
    key: t,
    label: INDUSTRY_COPY[t]?.label ?? BUSINESS_TYPE_SPEC[t].label,
    text: INDUSTRY_COPY[t]?.text ?? BUSINESS_TYPE_SPEC[t].hint,
  }));
  const planCount = data.plans.length + (data.starterPlan ? 1 : 0);
  const year = new Date().getFullYear();

  return (
    <div className={`${display.variable} min-h-screen scroll-smooth bg-card text-foreground`}>
      <style>{SITE_SCALE_CSS}</style>

      {/* ─── ĐẦU TRANG ─── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-card/85 backdrop-blur-md">
        <div className={`${WRAP} flex h-16 items-center gap-3`}>
          <a href="#" aria-label="VNXcommerce — về đầu trang">
            <BrandLockup wordmarkClassName="text-base" />
          </a>
          <nav className="ml-8 hidden items-center gap-7 text-sm font-medium text-foreground/70 lg:flex" aria-label="Mục lục trang">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-foreground">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 sm:gap-4">
            <a href={`tel:${COMPANY.phoneHref}`} className="hidden items-center gap-1.5 text-sm font-medium text-foreground/70 hover:text-foreground xl:inline-flex">
              <Phone className="size-4" aria-hidden /> {COMPANY.phone}
            </a>
            <a href={data.loginUrl} className="hidden text-sm font-semibold text-foreground/80 hover:text-foreground sm:inline">
              Đăng nhập
            </a>
            <a href={data.signupUrl} className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_24px_-12px_var(--brand)] hover:brightness-110">
              <span className="sm:hidden">{signup.tiny}</span>
              <span className="hidden sm:inline">{signup.short}</span>
            </a>
            <details className="relative lg:hidden">
              <summary className="flex size-9 cursor-pointer list-none items-center justify-center rounded-full border border-border/70 bg-card [&::-webkit-details-marker]:hidden" aria-label="Mục lục">
                <Menu className="size-5" aria-hidden />
              </summary>
              <nav className="absolute top-11 right-0 z-50 w-60 rounded-2xl bg-card p-2 text-card-foreground shadow-[var(--shadow-raised)]" aria-label="Mục lục trang">
                {NAV.map((n) => (
                  <a key={n.href} href={n.href} className="block rounded-xl px-3 py-2.5 text-sm font-medium hover:bg-muted">
                    {n.label}
                  </a>
                ))}
                <a href={data.loginUrl} className="mt-1 block rounded-xl border-t border-border/60 px-3 py-2.5 text-sm font-semibold text-brand hover:bg-muted">
                  Đăng nhập
                </a>
                <a href={`tel:${COMPANY.phoneHref}`} className="block rounded-xl px-3 py-2.5 text-sm font-medium hover:bg-muted">
                  Gọi tư vấn · {COMPANY.phone}
                </a>
              </nav>
            </details>
          </div>
        </div>
      </header>

      <main>
        {/* ─── PHẦN ĐẦU ─── */}
        <section className="relative flex min-h-[calc(100svh-4rem)] items-center overflow-hidden">
          <GridBackdrop />
          <div className="pointer-events-none absolute -top-40 right-[-10%] size-[34rem] rounded-full bg-brand/10 blur-3xl" aria-hidden />
          <div className={`relative ${WRAP} grid items-center gap-14 py-14 lg:grid-cols-[1.08fr_1fr] lg:gap-16 lg:py-16`}>
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-brand/8 px-3.5 py-1.5 text-xs font-semibold text-brand">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-brand" />
                </span>
                Nhân viên bán hàng AI cho fanpage
              </p>
              <h1 className={`${SERIF} mt-6 text-[clamp(2.25rem,1.2rem+3.2vw,4.4rem)] font-bold leading-[1.08] tracking-tight text-balance`}>
                Trợ lý AI trực fanpage 24/7, <Accent>tự tư vấn và chốt đơn</Accent> cho shop.
              </h1>
              <span className="mt-6 block h-0.5 w-14 rounded-full bg-brand" />
              <p className="mt-6 max-w-2xl text-[clamp(1rem,0.9rem+0.4vw,1.2rem)] leading-[1.75] text-muted-foreground">
                Trả lời khách trong vài giây bằng đúng giá và tồn kho của shop, xem được ảnh khách gửi, lấy số điện thoại – địa chỉ, chốt đơn khi khách đồng ý. Rồi đơn chạy thẳng vào kho, tiền thu hộ và báo cáo lãi.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
                <PrimaryCta href={data.signupUrl}>{signup.label}</PrimaryCta>
                <TextLink href="#cach-hoat-dong">Xem trợ lý làm việc</TextLink>
              </div>
              {signup.note ? <p className="mt-4 text-sm text-muted-foreground">{signup.note}</p> : null}
              <ul className="mt-8 flex flex-col gap-2.5 text-sm text-foreground/80 sm:flex-row sm:flex-wrap sm:gap-x-7">
                {["AI có sẵn trong gói", "Cài trong 3 bước", "Đơn vào thẳng kho & sổ sách"].map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <Check className="size-4 shrink-0 text-brand" aria-hidden />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="px-2 sm:px-8 lg:px-0">
              <ChatMock />
            </div>
          </div>
        </section>

        {/* ─── VẤN ĐỀ ─── */}
        <section className="relative overflow-hidden border-t border-border/50 bg-background py-20 lg:py-28">
          <GridBackdrop />
          <div className={`relative ${WRAP}`}>
            <SectionHead
              eyebrow="Vấn đề"
              title={
                <>
                  Khách nhắn lúc 11 giờ đêm. <Accent>Sáng ra, họ đã mua chỗ khác.</Accent>
                </>
              }
              text="Bán qua fanpage là cuộc đua trả lời. Thua ở tin nhắn thì quảng cáo đắt đến mấy cũng không ra đơn."
            />
            <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
              {PROBLEMS.map((p) => (
                <div key={p.title} className="text-center">
                  <p.icon className="mx-auto size-8 text-brand" strokeWidth={1.5} aria-hidden />
                  <h3 className="mt-4 text-lg font-bold">{p.title}</h3>
                  <p className="mx-auto mt-2 max-w-xs text-sm leading-6 text-muted-foreground">{p.text}</p>
                </div>
              ))}
            </div>
            <p className="mt-14 text-center text-base text-muted-foreground">
              Trả lời chậm là mất đơn. <strong className="text-foreground">VNXcommerce đặt một nhân viên AI vào đúng chỗ đó.</strong>
            </p>
          </div>
        </section>

        {/* ─── CÁCH HOẠT ĐỘNG ─── */}
        <section id="cach-hoat-dong" className="scroll-mt-20 py-20 lg:py-28">
          <div className={WRAP}>
            <SectionHead
              eyebrow="Cách trợ lý làm việc"
              title={
                <>
                  Từ tin nhắn đầu tiên <Accent>tới đơn đã chốt</Accent>
                </>
              }
            />
            <ol className="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
              {STEPS_FLOW.map((s, i) => (
                <li key={s.title} className="relative">
                  <div className="flex items-center gap-4">
                    <span className={`${SERIF} flex size-16 shrink-0 items-center justify-center rounded-full bg-brand text-2xl font-bold text-white shadow-[0_14px_30px_-12px_var(--brand)]`}>
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h3 className={`${SERIF} text-2xl font-bold leading-tight`}>{s.title}</h3>
                    {i < STEPS_FLOW.length - 1 ? <ChevronRight className="ml-auto hidden size-6 shrink-0 text-brand/50 lg:block" aria-hidden /> : null}
                  </div>
                  <p className="mt-4 max-w-xs text-sm leading-6 text-muted-foreground">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ─── KIẾN TRÚC: KÊNH → TRỢ LÝ → HỆ THỐNG ─── */}
        <section className="relative overflow-hidden border-y border-border/50 bg-background py-20 lg:py-28">
          <GridBackdrop />
          <div className={`relative ${WRAP}`}>
            <SectionHead
              eyebrow="Không chỉ là chatbot"
              title={
                <>
                  Một nhân viên bán hàng <Accent>nối thẳng vào kho và sổ sách</Accent>
                </>
              }
              text="Chatbot thường chỉ biết trả lời. Trợ lý của VNXcommerce đứng trên cùng dữ liệu với cả hệ thống: câu trả lời đúng với kho, và đơn chốt xong là có mặt ở mọi báo cáo."
            />
            <div className="mx-auto mt-14 grid max-w-6xl items-center gap-6 rounded-[2rem] border border-border/70 bg-card p-6 shadow-[var(--shadow-raised)] sm:p-10 lg:grid-cols-[1fr_auto_1.1fr_auto_1fr]">
              <div>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Kênh khách nhắn</p>
                <ul className="space-y-2.5">
                  {CHANNELS.map((c) => (
                    <li key={c.label} className="flex items-center gap-3 rounded-xl border border-border/70 bg-[var(--surface-sunken)] px-3.5 py-2.5 text-sm font-medium">
                      <c.icon className="size-4 shrink-0 text-brand" aria-hidden />
                      {c.label}
                    </li>
                  ))}
                </ul>
              </div>
              <ArrowRight className="mx-auto hidden size-6 text-brand/60 lg:block" aria-hidden />
              <ArrowDown className="mx-auto size-6 text-brand/60 lg:hidden" aria-hidden />
              <div className="relative rounded-[1.75rem] bg-sidebar p-6 text-center text-sidebar-foreground shadow-[0_24px_60px_-24px_var(--brand)]">
                <div className="pointer-events-none absolute inset-0 rounded-[1.75rem] bg-gradient-to-b from-brand/25 to-transparent" aria-hidden />
                <span className="relative mx-auto flex size-14 items-center justify-center rounded-2xl bg-brand text-white">
                  <Bot className="size-7" aria-hidden />
                </span>
                <p className={`${SERIF} relative mt-4 text-2xl font-bold`}>Trợ lý AI bán hàng</p>
                <div className="relative mt-4 flex flex-wrap justify-center gap-1.5">
                  {["Tư vấn", "Chốt đơn", "Chăm khách", "Gọi người khi cần"].map((t) => (
                    <span key={t} className="rounded-full bg-sidebar-accent px-2.5 py-1 text-[11px] font-semibold text-sidebar-foreground/85">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <ArrowRight className="mx-auto hidden size-6 text-brand/60 lg:block" aria-hidden />
              <ArrowDown className="mx-auto size-6 text-brand/60 lg:hidden" aria-hidden />
              <div>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">Hệ thống của shop</p>
                <ul className="space-y-2.5">
                  {SYSTEM_PARTS.map((c) => (
                    <li key={c.label} className="flex items-center gap-3 rounded-xl border border-border/70 bg-[var(--surface-sunken)] px-3.5 py-2.5 text-sm font-medium">
                      <c.icon className="size-4 shrink-0 text-success" aria-hidden />
                      {c.label}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ─── NĂNG LỰC ─── */}
        <section id="tro-ly-ai" className="scroll-mt-20 py-20 lg:py-28">
          <div className={WRAP}>
            <SectionHead
              eyebrow="Năng lực của trợ lý"
              title={
                <>
                  Mười việc trợ lý <Accent>làm thay bạn</Accent> mỗi ngày
                </>
              }
            />
            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CAPABILITIES.map((c) => (
                <article key={c.title} className={`group min-w-0 rounded-3xl border border-border/70 bg-card p-6 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-raised)] ${c.span ?? ""}`}>
                  <span className="flex size-11 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                    <c.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-lg font-bold">{c.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{c.text}</p>
                  {c.visual === "catalog" ? <CatalogVisual /> : null}
                  {c.visual === "industries" ? <IndustryChips /> : null}
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── YÊN TÂM GIAO VIỆC ─── */}
        <section className="relative overflow-hidden bg-sidebar py-20 text-sidebar-foreground lg:py-28">
          <div className="pointer-events-none absolute -top-40 left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-brand/20 blur-3xl" aria-hidden />
          <div className={`relative ${WRAP}`}>
            <SectionHead
              eyebrow="Yên tâm giao việc"
              title={
                <>
                  Trợ lý biết <Accent invert>giới hạn của mình</Accent>
                </>
              }
              text="Một nhân viên giỏi không phải người trả lời được mọi thứ, mà là người biết lúc nào phải gọi chủ."
              invert
            />
            <div className="mt-14 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {SAFETY.map((s) => (
                <article key={s.title} className="rounded-3xl border border-sidebar-border bg-sidebar-accent/60 p-6">
                  <s.icon className="size-7 text-brand-bright" strokeWidth={1.6} aria-hidden />
                  <h3 className="mt-4 text-lg font-bold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-sidebar-foreground/70">{s.text}</p>
                </article>
              ))}
            </div>
            <p className="mt-10 text-center text-sm text-sidebar-foreground/60">Tuỳ chỉnh tên trợ lý, lời chào, giọng nói (thân thiện · chuyên nghiệp · ngắn gọn) và giờ làm việc.</p>
          </div>
        </section>

        {/* ─── SO SÁNH ─── */}
        <section className="py-20 lg:py-28">
          <div className={WRAP}>
            <SectionHead eyebrow="So sánh" title="Chatbot kịch bản và trợ lý AI của VNXcommerce" />
            <div className="mx-auto mt-12 max-w-5xl overflow-hidden rounded-3xl border border-border/70 bg-card">
              <div className="hidden grid-cols-[10rem_1fr_1fr] gap-4 border-b border-border/60 bg-[var(--surface-sunken)] px-6 py-3.5 text-xs font-bold uppercase tracking-wide text-muted-foreground sm:grid">
                <span />
                <span>Chatbot kịch bản</span>
                <span className="text-brand">Trợ lý AI VNXcommerce</span>
              </div>
              <ul className="divide-y divide-[var(--hairline)]">
                {COMPARE.map((c) => (
                  <li key={c.topic} className="grid gap-2 px-6 py-4 sm:grid-cols-[10rem_1fr_1fr] sm:gap-4">
                    <span className="font-semibold">{c.topic}</span>
                    <span className="flex gap-2 text-sm text-muted-foreground">
                      <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                      {c.old}
                    </span>
                    <span className="flex gap-2 text-sm font-medium">
                      <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                      {c.next}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ─── NGÀNH HÀNG ─── */}
        <section className="relative overflow-hidden border-y border-border/50 bg-background py-20 lg:py-28">
          <GridBackdrop />
          <div className={`relative ${WRAP}`}>
            <SectionHead eyebrow="Ngành hàng" title="Trợ lý bán đúng kiểu ngành của bạn" text="Chọn ngành lúc đăng ký: phần mềm dựng sẵn danh mục, tính năng và cách trợ lý trả lời khách." />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {industries.map((t) => (
                <article key={t.key} className="rounded-2xl border border-border/70 bg-card p-5 transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-card)]">
                  <h3 className="flex items-center gap-2 font-bold">
                    <BrandGlyph className="h-2.5 text-brand" />
                    {t.label}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{t.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── PHÍA SAU TRỢ LÝ: HỆ THỐNG QUẢN LÝ ─── */}
        <section id="he-thong" className="scroll-mt-20 py-20 lg:py-28">
          <div className={WRAP}>
            <SectionHead
              eyebrow="Phía sau trợ lý"
              title={
                <>
                  Và cả một hệ thống quản lý <Accent>biết lãi thật</Accent>
                </>
              }
              text="Đơn trợ lý chốt không nằm trong một hộp chat riêng — nó đi tiếp vào kho, tiền thu hộ và báo cáo, như mọi đơn khác."
            />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {BEHIND.map((b) => (
                <article key={b.title} className="rounded-3xl border border-border/70 bg-card p-6">
                  <b.icon className="size-6 text-brand" strokeWidth={1.7} aria-hidden />
                  <h3 className="mt-4 font-bold">{b.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{b.text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── BẢNG GIÁ ─── (ẩn khi không đọc được gói nào: không bao giờ in giá đoán) */}
        {planCount > 0 ? (
          <section id="bang-gia" className="relative scroll-mt-20 overflow-hidden border-t border-border/50 bg-background py-20 lg:py-28">
            <GridBackdrop />
            <div className={`relative ${WRAP}`}>
              <SectionHead eyebrow="Bảng giá" title={<>Dùng thử {TRIAL_DAYS} ngày, <Accent>lớn lên mới trả tiền</Accent></>} text="Mỗi gói đều kèm hạn mức AI cho trợ lý chat. Trả theo tháng bằng chuyển khoản, đổi gói bất cứ lúc nào." />
              <div className={`mt-12 grid gap-5 sm:grid-cols-2 ${PLAN_GRID[Math.min(planCount, 5)] ?? "lg:grid-cols-3"}`}>
                {data.starterPlan ? (
                  <article className="flex flex-col rounded-3xl border-2 border-dashed border-brand/40 bg-card p-6">
                    <h3 className="font-bold">{data.starterPlan.name}</h3>
                    <p className={`${SERIF} mt-3 text-3xl font-bold`}>Miễn phí</p>
                    <p className="mt-1 text-xs text-muted-foreground">{TRIAL_DAYS} ngày đầu khi tự đăng ký</p>
                    <PlanLimits plan={data.starterPlan} />
                    <a href={data.signupUrl} className="mt-6 rounded-full bg-brand px-4 py-2.5 text-center text-sm font-semibold text-white hover:brightness-110">
                      {signup.short}
                    </a>
                  </article>
                ) : null}
                {data.plans.map((p, i) => {
                  const featured = data.plans.length >= 3 && i === 1;
                  return (
                    <article key={p.key} className={`relative flex flex-col rounded-3xl p-6 ${featured ? "bg-sidebar text-sidebar-foreground ring-2 ring-brand" : "border border-border/70 bg-card"}`}>
                      {featured ? <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-white">Được chọn nhiều</span> : null}
                      <h3 className="font-bold">{p.name}</h3>
                      <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5">
                        <span className="text-3xl font-extrabold tracking-tight whitespace-nowrap tabular-nums lg:text-[1.7rem] xl:text-[1.85rem]">{formatVND(p.priceVnd)}</span>
                        <span className={`text-sm font-medium whitespace-nowrap ${featured ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}>/ tháng</span>
                      </p>
                      {p.yearlyFreeMonths > 0 ? (
                        <p className={`mt-2 inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ${featured ? "bg-brand/25 text-brand-bright" : "bg-success/12 text-success"}`}>
                          Trả 12 tháng, tặng {p.yearlyFreeMonths} tháng
                        </p>
                      ) : null}
                      {p.description ? <p className={`mt-3 text-sm leading-6 ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{p.description}</p> : null}
                      <PlanLimits plan={p} inverted={featured} />
                      <a
                        href={data.signupUrl}
                        className={`mt-6 rounded-full px-4 py-2.5 text-center text-sm font-semibold ${featured ? "bg-brand text-white hover:brightness-110" : "border border-border bg-card hover:bg-muted"}`}
                      >
                        Bắt đầu
                      </a>
                    </article>
                  );
                })}
              </div>
              <p className="mt-6 text-center text-xs text-muted-foreground">
                Giá chưa gồm chi phí bên ngoài như phí vận chuyển hay tiền quảng cáo. Lần thanh toán đầu tiên được hoàn 100% nếu yêu cầu trong {SERVICE_COMMITMENTS.firstPaymentRefundDays} ngày.
              </p>
            </div>
          </section>
        ) : null}

        {/* ─── BẮT ĐẦU ─── */}
        <section className="py-20 lg:py-28">
          <div className={WRAP}>
            <SectionHead
              eyebrow="Bắt đầu"
              title={
                <>
                  Ba bước, <Accent>trợ lý vào việc</Accent>
                </>
              }
              text="Tự làm được, không cần chờ đội triển khai."
            />
            <ol className="mx-auto mt-14 grid max-w-6xl gap-5 md:grid-cols-3">
              {START_STEPS.map((s, i) => (
                <li key={s.title} className="relative rounded-3xl border border-border/70 bg-card p-7">
                  <span className={`${SERIF} text-5xl font-bold text-brand/25 tabular-nums`}>{String(i + 1).padStart(2, "0")}</span>
                  <h3 className={`${SERIF} mt-2 text-2xl font-bold`}>{s.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ─── HỎI ĐÁP ─── */}
        <section id="hoi-dap" className="relative scroll-mt-20 overflow-hidden border-t border-border/50 bg-background py-20 lg:py-28">
          <GridBackdrop />
          <div className="relative mx-auto w-full max-w-3xl px-4 sm:px-6">
            <SectionHead eyebrow="Hỏi đáp" title="Câu hỏi thường gặp" />
            <div className="mt-10 space-y-3">
              {faqs().map((f) => (
                <details key={f.q} className="group rounded-2xl border border-border/70 bg-card p-5 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                    {f.q}
                    <ChevronDown className="size-5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                  </summary>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ─── LỜI MỜI CUỐI ─── */}
        <section className={`${WRAP} py-20`}>
          <div className="relative overflow-hidden rounded-[2rem] bg-sidebar px-6 py-16 text-center text-sidebar-foreground sm:px-12 lg:py-20">
            <div className="pointer-events-none absolute -top-28 left-1/2 size-[30rem] -translate-x-1/2 rounded-full bg-brand/30 blur-3xl" aria-hidden />
            <h2 className={`${SERIF} relative text-[clamp(1.75rem,1.1rem+2vw,3.1rem)] font-bold leading-tight tracking-tight text-balance`}>
              Tối nay, để trợ lý <Accent invert>trực fanpage thay bạn</Accent>
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-base leading-7 text-sidebar-foreground/70">{signup.note ?? "Tạo cửa hàng của bạn hoặc đăng nhập để dùng tiếp."}</p>
            <div className="relative mt-9 flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
              <PrimaryCta href={data.signupUrl}>{signup.label}</PrimaryCta>
              <TextLink href={`tel:${COMPANY.phoneHref}`} invert>
                Gọi tư vấn {COMPANY.phone}
              </TextLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60 bg-background">
        <div className={`${WRAP} flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between`}>
          <div className="space-y-2">
            <BrandLockup wordmarkClassName="text-base" />
            <p className="text-xs text-muted-foreground">© {year} VNXcommerce · Nhân viên bán hàng AI và hệ thống quản lý cho shop online</p>
            <p className="text-xs text-muted-foreground">
              {COMPANY.name} · MST {COMPANY.taxCode} · {COMPANY.email} · {COMPANY.phone}
            </p>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground" aria-label="Liên kết chân trang">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="hover:text-foreground">
                {n.label}
              </a>
            ))}
            <a href={data.loginUrl} className="hover:text-foreground">
              Đăng nhập
            </a>
            <a href={data.signupUrl} className="font-semibold text-brand hover:text-foreground">
              {signup.short}
            </a>
            <a href={TERMS_OF_SERVICE.path} className="hover:text-foreground">
              Điều khoản sử dụng
            </a>
            <a href={PRIVACY_POLICY.path} className="hover:text-foreground">
              Chính sách quyền riêng tư
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
