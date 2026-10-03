import type { Metadata } from "next";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  CircleDollarSign,
  HandCoins,
  LifeBuoy,
  Lock,
  PhoneCall,
  Repeat,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { BrandGlyph, BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { formatNumber, formatVND } from "@/lib/format";
import { BUSINESS_TYPES, BUSINESS_TYPE_SPEC, type BusinessType } from "@/lib/onboarding/shared";
import { getPublicSiteData, type PublicPlan, type PublicSiteData } from "@/lib/queries/public-site";

/**
 * TRANG GIỚI THIỆU CÔNG KHAI — mặt tiền của nền tảng ở tên miền gốc (`vnxcommerce.com`, xem lib/platform/site-host.ts).
 *
 * Viết cho CHỦ SHOP, không cho kỹ sư: tiếng Việt thường ngày, nói bằng tiền (lãi thật, đơn hoàn, tiền thu hộ, tiền quảng
 * cáo) thay vì bằng tên tính năng. Mỗi điểm mạnh trên trang là thứ một tổ chức MỚI tự đăng ký dùng được — không hứa thứ
 * chỉ tổ chức nhà có. Không số liệu khách hàng, logo hay lời chứng thực bịa; các bảng số là VÍ DỤ và mang nhãn ấy.
 * Ngành hàng đọc từ `BUSINESS_TYPES` (cùng danh sách `/start` cho chọn), giá đọc từ `platform_plans`.
 */

export const dynamic = "force-dynamic";

const TITLE = "VNXcommerce — Phần mềm quản lý bán hàng online: biết lãi thật từng đơn";
const DESCRIPTION =
  "Đơn hàng, vận chuyển, tiền thu hộ, chi phí và kho trên một chỗ. Biết lãi thật, chặn đơn lỗi, không để sót một đồng tiền thu hộ, trợ lý chat trả lời khách trên fanpage. Bắt đầu miễn phí.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", locale: "vi_VN" },
};

const NAV = [
  { href: "#loi-ich", label: "Lợi ích" },
  { href: "#so-sanh", label: "So sánh" },
  { href: "#nganh-hang", label: "Ngành hàng" },
  { href: "#bang-gia", label: "Bảng giá" },
  { href: "#hoi-dap", label: "Hỏi đáp" },
];

const PAINS = [
  "Doanh thu tháng nào cũng đẹp, mà tiền trong tài khoản không thấy đâu.",
  "Đơn hoàn về rồi mới biết — mất luôn tiền ship cả hai chiều.",
  "Bên vận chuyển báo “giao thành công”, tiền thu hộ về thiếu mà không ai đối chiếu.",
  "Tiền quảng cáo tăng đều, mà trừ hết chi phí không biết còn lãi hay đã lỗ.",
  "Kho báo còn hàng, khách đặt rồi mới biết hết size.",
  "Mỗi người một file Excel, cuối tháng cả tuần ngồi khớp số.",
];

type Tone = "good" | "bad" | "warn" | "muted";
type Visual = { heading: string; rows: { label: string; value: string; tone?: Tone }[]; foot?: string };
type Benefit = { icon: LucideIcon; tag: string; title: string; points: string[]; visual: Visual };

const BENEFITS: Benefit[] = [
  {
    icon: CircleDollarSign,
    tag: "Lãi thật",
    title: "Biết lãi thật — không phải doanh thu trên giấy",
    points: [
      "Doanh thu tính theo tiền đã về tài khoản, không theo số đơn chốt.",
      "Đơn hoàn, phí ship, giá vốn, tiền quảng cáo và mọi khoản chi đều được trừ; tiền thuê nhà, lương cố định chia đều theo ngày.",
      "Xem tỷ lệ giao thành công của từng sản phẩm để biết mẫu nào đáng bán tiếp.",
    ],
    visual: {
      heading: "Lãi lỗ tháng này",
      rows: [
        { label: "Tiền thật đã về", value: "Đã khớp", tone: "good" },
        { label: "Đơn hoàn, phí ship hai chiều", value: "Đã trừ", tone: "bad" },
        { label: "Đơn chưa có chứng từ tiền", value: "Chưa tính", tone: "muted" },
      ],
      foot: "Chưa có chứng từ thì không đoán",
    },
  },
  {
    icon: HandCoins,
    tag: "Tiền thu hộ",
    title: "Không để sót một đồng tiền thu hộ",
    points: [
      "Tải tệp bảng kê của bên vận chuyển và sao kê ngân hàng lên — phần mềm tự khớp từng đơn.",
      "Đơn đã giao mà tiền chưa về hiện thành danh sách để đòi, kèm số ngày chờ.",
      "Xem trước khi ghi; nhập lại tệp bao nhiêu lần cũng không bị cộng trùng tiền.",
    ],
    visual: {
      heading: "Đối chiếu tiền thu hộ",
      rows: [
        { label: "Đã về tài khoản", value: "Khớp bảng kê", tone: "good" },
        { label: "Đã giao, chưa có bảng kê", value: "Chờ 12 ngày", tone: "warn" },
        { label: "Về thiếu so với đơn", value: "Cần kiểm", tone: "bad" },
      ],
    },
  },
  {
    icon: PhoneCall,
    tag: "Giữ đơn",
    title: "Chặn đơn lỗi trước khi gửi, cứu kiện trước khi hoàn",
    points: [
      "Phát hiện đơn trùng — cùng số điện thoại, cùng món hàng — trước khi đóng gói nhầm hai kiện.",
      "Tải tệp danh sách vận đơn lên là biết kiện nào đang giao, đã giao, đang hoàn.",
      "Kiện chậm, kiện chờ phát lại vào danh sách cần gọi khách, có hạn xử lý và người phụ trách.",
    ],
    visual: {
      heading: "Việc cần làm hôm nay",
      rows: [
        { label: "Đơn trùng cùng số điện thoại", value: "Chặn lại", tone: "bad" },
        { label: "Kiện chờ phát lại", value: "Gọi khách", tone: "warn" },
        { label: "Đã gọi, khách nhận lại", value: "Đang giao", tone: "good" },
      ],
    },
  },
  {
    icon: Bot,
    tag: "Trợ lý chat",
    title: "Trợ lý chat trả lời khách trên fanpage cả lúc nửa đêm",
    points: [
      "Tư vấn theo đúng bảng giá và hàng còn trong kho của shop.",
      "Tự lên đơn nháp từ cuộc trò chuyện — nhân viên chỉ cần duyệt.",
      "Nhận ra khách cũ, gợi ý lại địa chỉ đã giao lần trước.",
    ],
    visual: {
      heading: "Tin nhắn fanpage · 23:48",
      rows: [
        { label: "Khách: \u201cMẫu này còn size M không?\u201d", value: "", tone: "muted" },
        { label: "Trợ lý: \u201cCòn ạ, em lên đơn cho chị nhé\u201d", value: "", tone: "good" },
        { label: "Đơn nháp chờ duyệt", value: "1 đơn", tone: "warn" },
      ],
    },
  },
  {
    icon: Boxes,
    tag: "Kho",
    title: "Kho không ảo — biết còn bao nhiêu hàng thật sự bán được",
    points: [
      "Tồn kho = hàng nhập trừ hàng đã giao cho bên vận chuyển, tự trừ không cần đếm tay.",
      "Hàng hoàn chỉ được cộng lại khi kho đếm thực tế — không còn \u201ctồn trên giấy\u201d.",
      "Báo thiếu size, gợi ý nhập thêm mẫu bán chạy hay xả mẫu nằm kho.",
    ],
    visual: {
      heading: "Tồn kho bán được",
      rows: [
        { label: "Đầm xoè D21 · size M", value: "Sắp hết", tone: "warn" },
        { label: "Đầm xoè D21 · size L", value: "Hết hàng", tone: "bad" },
        { label: "Hàng hoàn chờ kho đếm", value: "Chưa cộng tồn", tone: "muted" },
      ],
    },
  },
  {
    icon: Repeat,
    tag: "Khách cũ",
    title: "Bán lại cho khách cũ, không tốn thêm tiền quảng cáo",
    points: [
      "Danh sách khách tới hẹn mua lại, tính theo nhịp mua thật của từng người.",
      "Câu nhắn soạn sẵn, mở Zalo một chạm là gửi.",
      "Bán sỉ: bảng giá theo số lượng, hạn mức và công nợ của từng đại lý.",
    ],
    visual: {
      heading: "Khách tới hẹn mua lại",
      rows: [
        { label: "Chị Hoa · mua mỗi ~30 ngày", value: "Tới hẹn", tone: "warn" },
        { label: "Anh Tuấn · mua mỗi ~45 ngày", value: "Còn 5 ngày", tone: "muted" },
        { label: "Đã nhắn hôm qua", value: "Đã đặt lại", tone: "good" },
      ],
    },
  },
  {
    icon: Users,
    tag: "Đội ngũ",
    title: "Cả đội làm việc trên một con số",
    points: [
      "Tính lương, hoa hồng theo đơn giao thành công — công bằng, khỏi cãi.",
      "Đơn mới, đơn sửa, đơn huỷ báo ngay vào nhóm Zalo, Telegram hoặc Lark của shop.",
      "Mỗi người một tài khoản, chỉ thấy đúng phần việc được giao.",
    ],
    visual: {
      heading: "Nhóm Zalo của shop",
      rows: [
        { label: "Đơn mới · 2 áo sơ mi", value: "Vừa xong", tone: "good" },
        { label: "Đơn bị huỷ · khách đổi ý", value: "5 phút trước", tone: "bad" },
        { label: "Hoa hồng tháng này", value: "Đã chốt", tone: "muted" },
      ],
    },
  },
];

const COMPARE: { topic: string; old: string; next: string }[] = [
  { topic: "Lãi lỗ", old: "Ước chừng theo doanh thu chốt đơn", next: "Tính theo tiền thật về tài khoản, trừ đủ mọi chi phí" },
  { topic: "Đơn lỗi", old: "Khách nhận hai kiện mới biết đơn trùng", next: "Đơn trùng bị chặn trước khi đóng gói" },
  { topic: "Tiền thu hộ", old: "Tin theo báo cáo của bên vận chuyển", next: "Khớp từng đơn với bảng kê và sao kê ngân hàng" },
  { topic: "Tin nhắn", old: "Nhân viên trực tin nhắn tới khuya", next: "Trợ lý chat trả lời, lên đơn nháp cả đêm" },
  { topic: "Kho", old: "Đếm tay, lệch số, tồn trên giấy", next: "Tự trừ khi giao hàng, hàng hoàn kho đếm mới cộng" },
  { topic: "Báo cáo", old: "Cả tuần ngồi khớp Excel", next: "Có sẵn, cả đội xem cùng một con số" },
];

const INDUSTRY_COPY: Partial<Record<BusinessType, { label: string; text: string }>> = {
  fashion: { label: "Thời trang", text: "Quần áo, phụ kiện: mẫu theo size và màu, hàng hoàn, đặt xưởng may." },
  ecommerce: { label: "Bán lẻ online", text: "Bán nhiều loại hàng qua mạng: đơn, khách, kho, vận chuyển." },
  food: { label: "Thực phẩm đóng gói", text: "Đặc sản, đồ ăn đóng gói giá cố định: quy cách, bảo quản, giữ hàng khi chốt." },
  seafood: { label: "Hải sản", text: "Bán lẻ và bán sỉ cho quán, đại lý: bảng giá sỉ, công nợ, nhắc khách mua lại." },
  spa: { label: "Spa, làm đẹp", text: "Đặt lịch theo kỹ thuật viên không trùng giờ, liệu trình nhiều buổi, nhắc lịch." },
  restaurant: { label: "Nhà hàng, quán ăn", text: "Thực đơn, đơn tại bàn, mang về, giao tận nơi; đặt bàn theo bàn còn trống." },
  wholesale: { label: "Bán sỉ, phân phối", text: "Đại lý mua số lượng lớn, trả sau theo hạn mức công nợ." },
  manufacturing: { label: "Sản xuất", text: "Nguyên liệu, đặt hàng, kế hoạch sản xuất và kho — bộ tính năng gợi ý sẵn." },
  service: { label: "Dịch vụ", text: "Khách hàng, chăm sóc khách, thu chi — bộ tính năng gợi ý sẵn." },
};

const STEPS = [
  { title: "Tạo tài khoản", text: "Tên cửa hàng, email và mật khẩu. Vài phút là xong." },
  { title: "Chọn ngành hàng", text: "Phần mềm dựng sẵn mẫu cho ngành của bạn; xem trước rồi mới cài." },
  { title: "Đưa dữ liệu vào", text: "Nhập sản phẩm từ Excel, kết nối fanpage, tải tệp vận chuyển và sao kê ngân hàng." },
  { title: "Mời nhân viên", text: "Mỗi người một tài khoản, chỉ thấy đúng phần việc của mình." },
];

const PROMISES = [
  { icon: ShieldCheck, title: "Không biết thì nói không biết", text: "Chưa có chứng từ thì hiện “—” kèm lý do, không bao giờ ghi bừa thành 0 đồng." },
  { icon: TrendingUp, title: "Một cách tính cho mọi báo cáo", text: "Doanh thu, tỷ lệ giao thành công, lương thưởng, quảng cáo đều dùng chung một cách tính — không mỗi trang một số." },
  { icon: Lock, title: "Số tháng trước không tự đổi", text: "Tháng đã chốt là giữ nguyên. Sửa cách tính tháng sau không làm đổi báo cáo cũ." },
  { icon: BadgeCheck, title: "Dữ liệu shop nào shop nấy", text: "Mỗi cửa hàng một kho dữ liệu riêng; nhân viên chỉ thấy phần được giao." },
];

const FAQ = [
  { q: "Dữ liệu đưa vào phần mềm bằng cách nào?", a: "Sản phẩm nhập từ tệp Excel; đơn tạo ngay trên phần mềm hoặc do trợ lý chat lên đơn nháp từ fanpage; tệp danh sách vận đơn, bảng kê tiền thu hộ và sao kê ngân hàng thì tải lên để phần mềm tự khớp. Nhập lại tệp cũ không làm trùng số." },
  { q: "Bắt đầu có mất tiền không?", a: "Không. Cửa hàng tự đăng ký bắt đầu ở gói Dùng thử miễn phí, không cần thẻ ngân hàng. Khi cần thêm người dùng hay dung lượng thì chọn gói trả phí." },
  { q: "Có phải cài đặt gì không?", a: "Không. Phần mềm chạy trên trình duyệt, máy tính hay điện thoại đều dùng được." },
  { q: "Thanh toán gói trả phí thế nào?", a: "Chuyển khoản ngân hàng theo mã thanh toán phần mềm tạo sẵn. Tiền về, khớp mã là gói được gia hạn." },
  { q: "Trợ lý chat cần những gì?", a: "Fanpage của shop (kết nối qua Pancake) và tài khoản AI của chính shop — chi phí AI do shop kiểm soát. Trợ lý chỉ lên đơn nháp, nhân viên duyệt rồi mới thành đơn." },
  { q: "Dữ liệu của tôi có bị người khác xem được không?", a: "Không. Mỗi cửa hàng có kho dữ liệu riêng, tách hẳn khỏi cửa hàng khác. Trong cửa hàng, bạn quyết định nhân viên nào được xem phần nào." },
  { q: "Nhân viên mới có khó dùng không?", a: "Có sẵn trang Hướng dẫn sử dụng từng bước ngay trong phần mềm, mỗi người chỉ thấy bài dành cho phần việc của mình." },
];

function signupCopy(data: PublicSiteData): { label: string; short: string; note: string | null } {
  switch (data.signup) {
    case "open":
      return { label: "Dùng thử miễn phí", short: "Dùng thử miễn phí", note: "Tạo cửa hàng trong vài phút · Không cần thẻ ngân hàng" };
    case "invite":
      return { label: "Đăng ký bằng mã mời", short: "Đăng ký", note: "Đang mở theo lời mời: cần mã mời để tạo cửa hàng mới." };
    case "off":
      return { label: "Đăng ký", short: "Đăng ký", note: "Tạm ngừng nhận cửa hàng mới. Đã có tài khoản thì đăng nhập để dùng tiếp." };
    default:
      return { label: "Đăng ký", short: "Đăng ký", note: null };
  }
}

function limitLines(plan: PublicPlan): string[] {
  const lines: string[] = [];
  if (plan.users !== undefined) lines.push(plan.users === null ? "Không giới hạn người dùng" : `Tối đa ${formatNumber(plan.users)} người dùng`);
  if (plan.storageMb !== undefined) {
    if (plan.storageMb === null) lines.push("Không giới hạn dung lượng tệp");
    else lines.push(plan.storageMb >= 1024 ? `${formatNumber(Math.round((plan.storageMb / 1024) * 10) / 10)} GB lưu trữ tệp` : `${formatNumber(plan.storageMb)} MB lưu trữ tệp`);
  }
  if (plan.records !== undefined) lines.push(plan.records === null ? "Không giới hạn dữ liệu tự tạo" : `${formatNumber(plan.records)} dòng dữ liệu tự tạo`);
  return lines;
}

const TONE: Record<Tone, string> = {
  good: "bg-success/15 text-success",
  bad: "bg-destructive/12 text-destructive",
  warn: "bg-warning/20 text-foreground",
  muted: "bg-muted text-muted-foreground",
};

function SectionHead({ eyebrow, title, text, invert = false }: { eyebrow: string; title: React.ReactNode; text?: string; invert?: boolean }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className={`text-xs font-bold uppercase tracking-[0.2em] ${invert ? "text-brand-bright" : "text-brand"}`}>{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-extrabold leading-tight tracking-tight text-balance sm:text-4xl">{title}</h2>
      {text ? <p className={`mt-4 text-base leading-7 ${invert ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{text}</p> : null}
    </div>
  );
}

/** Khung "cửa sổ phần mềm" dùng chung cho mọi hình minh hoạ — chỉ là khung, nội dung là ví dụ. */
function MockWindow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card text-card-foreground shadow-[var(--shadow-raised)]">
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-[var(--surface-sunken)] px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-destructive/60" />
        <span className="size-2.5 rounded-full bg-warning/70" />
        <span className="size-2.5 rounded-full bg-success/60" />
        <span className="ml-3 truncate text-xs font-medium text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** Bảng "báo cáo sáng nay" ở phần đầu — VÍ DỤ minh hoạ cách đọc số, không phải số của khách nào. */
function HeroReport() {
  const lines = [
    { label: "Doanh thu đơn đã chốt", value: "48.600.000 ₫", tone: "" },
    { label: "Trừ đơn hoàn", value: "− 6.200.000 ₫", tone: "text-destructive" },
    { label: "Trừ tiền quảng cáo", value: "− 9.800.000 ₫", tone: "text-destructive" },
    { label: "Trừ giá vốn, phí ship", value: "− 19.400.000 ₫", tone: "text-destructive" },
  ];
  return (
    <div className="relative sm:pt-12 sm:pb-16">
      <MockWindow title="Tổng quan · số của hôm qua">
        <div className="p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Hôm qua lãi thật bao nhiêu?</p>
            <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">Ví dụ minh hoạ</span>
          </div>
          <ul className="mt-4 space-y-2.5 text-sm">
            {lines.map((l) => (
              <li key={l.label} className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{l.label}</span>
                <span className={`font-semibold tabular-nums ${l.tone}`}>{l.value}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-end justify-between gap-4 rounded-xl bg-success/10 px-4 py-3">
            <span className="text-sm font-semibold">Lãi thật</span>
            <span className="text-2xl font-extrabold tabular-nums text-success">13.200.000 ₫</span>
          </div>
        </div>
      </MockWindow>
      <div className="absolute bottom-0 -left-4 hidden w-60 rounded-2xl bg-card p-4 text-card-foreground shadow-[var(--shadow-raised)] sm:block lg:-left-10">
        <p className="flex items-center gap-2 text-xs font-bold text-destructive">
          <LifeBuoy className="size-4" aria-hidden /> Cần gọi ngay
        </p>
        <p className="mt-1 text-sm font-semibold">7 kiện giao chậm</p>
        <p className="text-xs text-muted-foreground">Gọi khách trước khi bị hoàn</p>
      </div>
      <div className="absolute top-0 -right-3 hidden w-56 rounded-2xl bg-card p-4 text-card-foreground shadow-[var(--shadow-raised)] sm:block">
        <p className="flex items-center gap-2 text-xs font-bold text-foreground">
          <HandCoins className="size-4 text-warning" aria-hidden /> Tiền chưa về
        </p>
        <p className="mt-1 text-sm font-semibold">3 đơn quá 10 ngày</p>
        <p className="text-xs text-muted-foreground">Đã giao, chưa có bảng kê</p>
      </div>
    </div>
  );
}

function BenefitVisual({ v }: { v: Visual }) {
  return (
    <MockWindow title={v.heading}>
      <ul className="divide-y divide-[var(--hairline)] px-5 py-2">
        {v.rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-4 py-3 text-sm">
            <span className="min-w-0">{r.label}</span>
            {r.value ? <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[r.tone ?? "muted"]}`}>{r.value}</span> : null}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-[var(--surface-sunken)] px-5 py-2.5 text-[11px] text-muted-foreground">
        <span>{v.foot ?? "Cập nhật tự động"}</span>
        <span>Ví dụ minh hoạ</span>
      </div>
    </MockWindow>
  );
}

function CtaButtons({ data, signup, center = false }: { data: PublicSiteData; signup: ReturnType<typeof signupCopy>; center?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${center ? "justify-center" : ""}`}>
      <Button asChild size="lg" className="h-12 gap-2 rounded-xl px-6 text-base shadow-[0_14px_30px_-12px_var(--brand)]">
        <a href={data.signupUrl}>
          {signup.label}
          <ArrowRight className="size-4" aria-hidden />
        </a>
      </Button>
      <Button asChild size="lg" variant="outline" className="h-12 rounded-xl border-sidebar-border bg-transparent px-6 text-base text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground">
        <a href={data.loginUrl}>Đăng nhập</a>
      </Button>
    </div>
  );
}

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
    <div className="min-h-screen scroll-smooth bg-background text-foreground">
      {/* ─── ĐẦU TRANG ─── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <a href="#" aria-label="VNXcommerce — về đầu trang">
            <BrandLockup wordmarkClassName="text-base" />
          </a>
          <nav className="ml-6 hidden items-center gap-6 text-sm font-medium text-muted-foreground lg:flex" aria-label="Mục lục trang">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-foreground">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href={data.loginUrl}>Đăng nhập</a>
            </Button>
            <Button asChild size="sm" className="rounded-lg">
              <a href={data.signupUrl}>{signup.short}</a>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* ─── PHẦN ĐẦU ─── */}
        <section className="relative overflow-hidden bg-sidebar text-sidebar-foreground">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{ backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)", backgroundSize: "22px 22px" }}
            aria-hidden
          />
          <div className="pointer-events-none absolute -top-48 -right-40 size-[36rem] rounded-full bg-brand/30 blur-3xl" aria-hidden />
          <div className="pointer-events-none absolute -bottom-56 -left-32 size-[30rem] rounded-full bg-chart-2/25 blur-3xl" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-4 pt-14 pb-20 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-20 lg:pb-28">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-sidebar-border bg-sidebar-accent/70 px-3 py-1 text-xs font-semibold text-sidebar-foreground/85">
                <Sparkles className="size-3.5 text-brand-bright" aria-hidden />
                Phần mềm quản lý cho shop bán hàng online
              </p>
              <h1 className="mt-6 text-[2rem] font-extrabold leading-[1.15] tracking-tight text-balance sm:text-5xl lg:text-[3.3rem]">
                Bán nhiều đơn chưa chắc đã lãi. <span className="text-brand-bright">Biết lãi thật từng đơn</span> mới giữ được tiền.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-sidebar-foreground/75">
                VNXcommerce đặt đơn hàng, vận chuyển, tiền thu hộ, chi phí và kho cạnh nhau. Mở phần mềm là biết ngay: lãi thật bao nhiêu, đơn nào có vấn đề, khoản tiền nào bên vận chuyển còn giữ.
              </p>
              <div className="mt-9">
                <CtaButtons data={data} signup={signup} />
              </div>
              {signup.note ? <p className="mt-4 text-sm text-sidebar-foreground/60">{signup.note}</p> : null}
              <ul className="mt-8 grid gap-2.5 text-sm text-sidebar-foreground/80 sm:grid-cols-3">
                {["Bắt đầu miễn phí", "Chạy trên trình duyệt", "Dữ liệu tách riêng"].map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <Check className="size-4 shrink-0 text-brand-bright" aria-hidden />
                    {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="lg:pl-6">
              <HeroReport />
            </div>
          </div>
        </section>

        {/* ─── NỖI ĐAU ─── */}
        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
          <SectionHead eyebrow="Có phải shop bạn đang thế này?" title="Tiền rò rỉ ở những chỗ không ai nhìn thấy" text="Không phải vì bạn bán kém — mà vì mỗi nơi giữ một con số, và không ai đặt chúng cạnh nhau." />
          <ul className="mx-auto mt-12 grid max-w-5xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PAINS.map((p) => (
              <li key={p} className="flex gap-3 rounded-2xl bg-card p-5 text-sm leading-6 shadow-[var(--shadow-card)]">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-destructive/12 text-destructive">
                  <X className="size-3.5" aria-hidden />
                </span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <p className="mt-10 text-center text-lg font-semibold text-balance">
            VNXcommerce sinh ra để bịt đúng những chỗ rò rỉ đó <ArrowRight className="inline size-5 text-brand" aria-hidden />
          </p>
        </section>

        {/* ─── LỢI ÍCH ─── */}
        <section id="loi-ich" className="scroll-mt-20 bg-[var(--surface-sunken)] py-20 lg:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHead
              eyebrow="Lợi ích"
              title={
                <>
                  Bảy cách VNXcommerce giúp shop <span className="text-brand">giữ thêm tiền</span>
                </>
              }
            />
            <div className="mt-14 space-y-16 lg:space-y-24">
              {BENEFITS.map((b, i) => (
                <article key={b.title} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16">
                  <div className={i % 2 === 1 ? "lg:order-2" : ""}>
                    <p className="inline-flex items-center gap-2 rounded-full bg-accent px-3 py-1 text-xs font-bold text-accent-foreground">
                      <b.icon className="size-3.5" aria-hidden />
                      {String(i + 1).padStart(2, "0")} · {b.tag}
                    </p>
                    <h3 className="mt-4 text-2xl font-extrabold leading-tight tracking-tight text-balance sm:text-3xl">{b.title}</h3>
                    <ul className="mt-6 space-y-3.5">
                      {b.points.map((pt) => (
                        <li key={pt} className="flex gap-3 text-base leading-7 text-muted-foreground">
                          <span className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-white">
                            <Check className="size-3" aria-hidden />
                          </span>
                          <span>{pt}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className={`mx-auto w-full max-w-md ${i % 2 === 1 ? "lg:order-1" : ""}`}>
                    <BenefitVisual v={b.visual} />
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── SO SÁNH ─── */}
        <section id="so-sanh" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6 lg:py-24">
          <SectionHead eyebrow="So sánh" title="Cách làm cũ và khi có VNXcommerce" />
          <div className="mx-auto mt-12 max-w-4xl overflow-hidden rounded-3xl bg-card shadow-[var(--shadow-card)]">
            <div className="hidden grid-cols-[9rem_1fr_1fr] gap-4 border-b border-border/60 bg-[var(--table-head)] px-6 py-3 text-xs font-bold uppercase tracking-wide text-muted-foreground sm:grid">
              <span />
              <span>Cách làm cũ</span>
              <span className="text-brand">Có VNXcommerce</span>
            </div>
            <ul className="divide-y divide-[var(--hairline)]">
              {COMPARE.map((c) => (
                <li key={c.topic} className="grid gap-2 px-6 py-4 sm:grid-cols-[9rem_1fr_1fr] sm:gap-4">
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
        </section>

        {/* ─── NGÀNH HÀNG ─── */}
        <section id="nganh-hang" className="scroll-mt-20 bg-[var(--surface-sunken)] py-20 lg:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHead eyebrow="Ngành hàng" title="Có sẵn mẫu cho ngành của bạn" text="Chọn ngành lúc đăng ký, phần mềm dựng sẵn danh mục và tính năng phù hợp. Không phải bắt đầu từ trang trắng." />
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {industries.map((t) => (
                <article key={t.key} className="rounded-2xl bg-card p-5 shadow-[var(--shadow-card)] transition-transform hover:-translate-y-0.5">
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

        {/* ─── BẢNG GIÁ ─── (ẩn khi không đọc được gói nào: không bao giờ in giá đoán) */}
        {planCount > 0 ? (
          <section id="bang-gia" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6 lg:py-24">
            <SectionHead eyebrow="Bảng giá" title="Bắt đầu miễn phí, lớn lên mới trả tiền" text="Trả theo tháng bằng chuyển khoản. Đổi gói bất cứ lúc nào." />
            <div className={`mt-12 grid gap-5 sm:grid-cols-2 ${planCount >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
              {data.starterPlan ? (
                <article className="flex flex-col rounded-3xl border-2 border-dashed border-brand/40 bg-card p-6 shadow-[var(--shadow-card)]">
                  <h3 className="font-bold">{data.starterPlan.name}</h3>
                  <p className="mt-3 text-3xl font-extrabold">Miễn phí</p>
                  <p className="mt-1 text-xs text-muted-foreground">Gói khởi đầu khi tự đăng ký</p>
                  <PlanLimits plan={data.starterPlan} />
                  <Button asChild className="mt-6 rounded-xl">
                    <a href={data.signupUrl}>{signup.label}</a>
                  </Button>
                </article>
              ) : null}
              {data.plans.map((p, i) => {
                const featured = data.plans.length >= 3 && i === 1;
                return (
                  <article key={p.key} className={`relative flex flex-col rounded-3xl p-6 shadow-[var(--shadow-card)] ${featured ? "bg-sidebar text-sidebar-foreground ring-2 ring-brand" : "bg-card"}`}>
                    {featured ? <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-white">Được chọn nhiều</span> : null}
                    <h3 className="font-bold">{p.name}</h3>
                    <p className="mt-3 flex flex-wrap items-baseline gap-x-1.5">
                      <span className="text-3xl font-extrabold whitespace-nowrap tabular-nums lg:text-[1.75rem] xl:text-3xl">{formatVND(p.priceVnd)}</span>
                      <span className={`text-sm font-medium whitespace-nowrap ${featured ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}>/ tháng</span>
                    </p>
                    {p.description ? <p className={`mt-3 text-sm leading-6 ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{p.description}</p> : null}
                    <PlanLimits plan={p} inverted={featured} />
                    <Button asChild variant={featured ? "default" : "outline"} className="mt-6 rounded-xl">
                      <a href={data.signupUrl}>Bắt đầu</a>
                    </Button>
                  </article>
                );
              })}
            </div>
            <p className="mt-6 text-center text-xs text-muted-foreground">Giá chưa gồm chi phí bên ngoài như phí vận chuyển hay tiền quảng cáo.</p>
          </section>
        ) : null}

        {/* ─── BẮT ĐẦU ─── */}
        <section className="bg-sidebar py-20 text-sidebar-foreground lg:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHead eyebrow="Bắt đầu" title="Bốn bước là chạy" text="Tự làm được, không cần chờ đội triển khai. Bước nào cũng xem trước được, không có gì tự chạy khi bạn chưa bấm." invert />
            <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-2xl border border-sidebar-border bg-sidebar-accent/60 p-6">
                  <span className="text-4xl font-extrabold tabular-nums text-brand-bright">{i + 1}</span>
                  <h3 className="mt-3 font-bold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-sidebar-foreground/70">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ─── CAM KẾT VỀ SỐ LIỆU ─── */}
        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
          <SectionHead eyebrow="Cam kết" title="Con số phải đủ tin để bạn dám quyết" text="Một con số sai mà trông hợp lý còn nguy hiểm hơn không có số. Bốn điều VNXcommerce không bao giờ làm khác:" />
          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {PROMISES.map((p) => (
              <article key={p.title} className="flex gap-4 rounded-2xl bg-card p-6 shadow-[var(--shadow-card)]">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground">
                  <p.icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h3 className="font-bold">{p.title}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{p.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ─── HỎI ĐÁP ─── */}
        <section id="hoi-dap" className="scroll-mt-20 bg-[var(--surface-sunken)] py-20 lg:py-24">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <SectionHead eyebrow="Hỏi đáp" title="Câu hỏi thường gặp" />
            <div className="mt-10 space-y-3">
              {FAQ.map((f) => (
                <details key={f.q} className="group rounded-2xl bg-card p-5 shadow-[var(--shadow-card)] [&_summary::-webkit-details-marker]:hidden">
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
        <section className="px-4 py-20 sm:px-6">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-sidebar px-6 py-14 text-center text-sidebar-foreground sm:px-12">
            <div className="pointer-events-none absolute -top-28 left-1/2 size-96 -translate-x-1/2 rounded-full bg-brand/30 blur-3xl" aria-hidden />
            <h2 className="relative text-2xl font-extrabold tracking-tight text-balance sm:text-4xl">Biết lãi thật từ sáng mai</h2>
            <p className="relative mx-auto mt-4 max-w-xl text-base leading-7 text-sidebar-foreground/70">{signup.note ?? "Tạo cửa hàng của bạn hoặc đăng nhập để dùng tiếp."}</p>
            <div className="relative mt-8">
              <CtaButtons data={data} signup={signup} center />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="space-y-2">
            <BrandLockup wordmarkClassName="text-base" />
            <p className="text-xs text-muted-foreground">© {year} VNXcommerce · Phần mềm quản lý cho shop bán hàng online</p>
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
          </nav>
        </div>
      </footer>
    </div>
  );
}

function PlanLimits({ plan, inverted = false }: { plan: PublicPlan; inverted?: boolean }) {
  const lines = limitLines(plan);
  if (lines.length === 0) return <div className="flex-1" />;
  return (
    <ul className="mt-5 flex-1 space-y-2.5 text-sm">
      {lines.map((l) => (
        <li key={l} className="flex items-start gap-2">
          <Check className={`mt-0.5 size-4 shrink-0 ${inverted ? "text-brand-bright" : "text-brand"}`} aria-hidden />
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}
