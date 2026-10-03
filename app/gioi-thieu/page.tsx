import type { Metadata } from "next";
import {
  ArrowRight,
  Boxes,
  Check,
  Database,
  Factory,
  HeartHandshake,
  Landmark,
  ListChecks,
  Lock,
  Megaphone,
  MessagesSquare,
  PieChart,
  ShieldCheck,
  Sigma,
  Truck,
} from "lucide-react";
import { BrandGlyph, BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { formatNumber, formatVND } from "@/lib/format";
import { BUSINESS_TYPES, BUSINESS_TYPE_SPEC } from "@/lib/onboarding/shared";
import { getPublicSiteData, type PublicPlan, type PublicSiteData } from "@/lib/queries/public-site";

/**
 * TRANG GIỚI THIỆU CÔNG KHAI — mặt tiền của nền tảng ở tên miền gốc (`vnxcommerce.com`, xem lib/platform/site-host.ts).
 *
 * Mọi câu trên trang nói về thứ ERP ĐANG LÀM ĐƯỢC: không số liệu khách hàng bịa, không logo đối tác, không lời chứng
 * thực. Ngành hàng đọc từ `BUSINESS_TYPE_SPEC` (cùng danh sách trình hướng dẫn `/start` cho chọn), giá đọc từ
 * `platform_plans` — sửa ở `/platform` là trang này đổi theo, không ai phải nhớ sửa hai nơi.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { absolute: "VNXcommerce — Nền tảng vận hành cho shop bán hàng online" },
  description:
    "ERP cho shop bán hàng online: đơn hàng, vận đơn, COD, tồn kho, quảng cáo và lợi nhuận trên một sự thật. Kết luận đơn theo chứng từ đơn vị vận chuyển, tiền theo bảng kê, hàng hoàn chỉ vào kho khi kho đếm.",
  robots: { index: true, follow: true },
  openGraph: {
    title: "VNXcommerce — Nền tảng vận hành cho shop bán hàng online",
    description: "Đơn hàng, vận đơn, COD, tồn kho và lợi nhuận — nói cùng một sự thật.",
    type: "website",
    locale: "vi_VN",
  },
};

const NAV = [
  { href: "#giai-phap", label: "Giải pháp" },
  { href: "#nganh-hang", label: "Ngành hàng" },
  { href: "#bang-gia", label: "Bảng giá" },
  { href: "#trien-khai", label: "Triển khai" },
];

const PROBLEMS = [
  {
    title: "Dữ liệu mỗi nơi một số",
    body: "Đơn ở POS, trạng thái ở đơn vị vận chuyển, tiền quảng cáo ở Facebook, tiền về ở ngân hàng. Cuối tháng ngồi ghép tay và mỗi người ra một con số.",
  },
  {
    title: "“Giao thành công” chưa chắc là bán được",
    body: "Đơn vị vận chuyển ghi “phát thành công” cả cho chiều hoàn về shop. Đếm theo nhãn đó là đếm cả đơn hoàn vào doanh thu.",
  },
  {
    title: "Tiền COD treo không ai thấy",
    body: "Đơn đã giao nhưng chưa có bảng kê, tiền chưa về tài khoản. Không tách được “chưa có chứng từ” với “thu được 0đ”.",
  },
  {
    title: "Tồn kho ảo",
    body: "Hàng hoàn được cộng lại vào kho từ lúc đơn vị vận chuyển báo hoàn — trong khi kiện còn nằm trên đường, hoặc về tới nơi thì đã hỏng.",
  },
];

const CONNECTORS = ["Pancake POS", "Viettel Post", "Facebook Ads", "Sao kê ngân hàng", "Google Sheet", "Lark · Telegram"];

const MODULES = [
  { icon: Truck, title: "Đơn hàng & vận đơn", body: "Kết luận giao thành công / hoàn / huỷ theo chứng từ của đơn vị vận chuyển, cập nhật theo thời gian thực qua webhook." },
  { icon: HeartHandshake, title: "Chăm sóc kiện hàng", body: "Hàng đợi kiện giao chậm, chờ phát lại, có hạn xử lý theo phòng ban — tách rõ kiện được cứu nhờ đội ngũ với kiện tự đi tiếp." },
  { icon: Landmark, title: "Đối soát COD & ngân hàng", body: "Bảng kê COD và sao kê ngân hàng khớp về từng đơn. Nhập lại tệp bao nhiêu lần cũng không nhân đôi dòng tiền." },
  { icon: Boxes, title: "Sổ kho", body: "Tồn thực tế từ phiếu kho trừ hàng đã bàn giao vận chuyển. Hàng hoàn chỉ quay lại tồn khi kho lập phiếu với số đếm thực." },
  { icon: PieChart, title: "Lợi nhuận & phân bổ chi phí", body: "Mỗi khoản chi khai một căn cứ phân bổ và một nguồn duy nhất — không cộng trùng quảng cáo, giá vốn hay cước." },
  { icon: Megaphone, title: "Quảng cáo & marketer", body: "Chi tiêu quảng cáo đặt cạnh đơn giao thành công thật, theo chiến dịch, sản phẩm và từng marketer." },
  { icon: MessagesSquare, title: "Chatbot bán hàng", body: "Trả lời khách trên fanpage theo bảng giá và tồn kho của chính shop, lên đơn nháp để nhân viên duyệt." },
  { icon: ListChecks, title: "Công việc, KPI & OKR", body: "Một hàng đợi việc cho mỗi phòng, mục tiêu chỉ nối vào chỉ số đo được — chưa đo được thì nói là chưa đo được." },
  { icon: Factory, title: "Nhập hàng & sản xuất", body: "Nhà cung cấp, đơn mua, kế hoạch đặt xưởng và giá thành — nối thẳng với tốc độ bán và tồn kho." },
];

const STEPS = [
  { title: "Tạo tổ chức", body: "Tên doanh nghiệp, mã tổ chức và tài khoản quản trị đầu tiên." },
  { title: "Chọn ngành hàng", body: "Mẫu ngành và module phù hợp — xem trước từng thứ sẽ được cài, bỏ bớt được trước khi bấm." },
  { title: "Nối dữ liệu", body: "Kết nối các kênh đang dùng: POS, đơn vị vận chuyển, tài khoản quảng cáo, ngân hàng." },
  { title: "Mời đội ngũ", body: "Mỗi người một tài khoản, vai trò, phòng ban và phạm vi dữ liệu riêng." },
  { title: "Vận hành", body: "ERP của tổ chức chạy ở tên miền riêng, số liệu cập nhật mỗi ngày." },
];

const PRINCIPLES = [
  { icon: Sigma, title: "Một công thức cho mỗi con số", body: "Doanh thu, tỷ lệ giao thành công, lương và marketing đọc cùng một định nghĩa kết quả đơn — không màn hình nào tự tính lại." },
  { icon: ShieldCheck, title: "Chưa biết là chưa biết", body: "Thiếu chứng từ thì hiện “—” kèm lý do, không bao giờ in thành 0 ₫. Số ước tính luôn mang nhãn ước tính." },
  { icon: Lock, title: "Kỳ đã chốt không đổi", body: "Sửa công thức tháng sau không làm đổi số của kỳ đã chốt — báo cáo tháng trước vẫn là báo cáo tháng trước." },
  { icon: Database, title: "Dữ liệu tách riêng từng tổ chức", body: "Mỗi tổ chức một cơ sở dữ liệu riêng; quyền truy cập theo vai trò và phạm vi dữ liệu của từng người." },
];

function signupCopy(data: PublicSiteData): { label: string; note: string | null } {
  switch (data.signup) {
    case "open":
      return { label: "Đăng ký dùng thử", note: data.starterPlan ? `Tự tạo tổ chức trong vài bước — bắt đầu ở gói ${data.starterPlan.name}.` : "Tự tạo tổ chức trong vài bước." };
    case "invite":
      return { label: "Đăng ký bằng mã mời", note: "Nền tảng đang mở theo lời mời: cần mã mời để tạo tổ chức mới." };
    case "off":
      return { label: "Đăng ký", note: "Đăng ký tổ chức mới đang tạm đóng. Đã có tài khoản thì đăng nhập để vào ERP." };
    default:
      return { label: "Đăng ký", note: null };
  }
}

function limitLines(plan: PublicPlan): string[] {
  const lines: string[] = [];
  if (plan.users !== undefined) lines.push(plan.users === null ? "Không giới hạn người dùng" : `Tối đa ${formatNumber(plan.users)} người dùng`);
  if (plan.records !== undefined) lines.push(plan.records === null ? "Không giới hạn bản ghi tuỳ biến" : `${formatNumber(plan.records)} bản ghi tuỳ biến`);
  if (plan.storageMb !== undefined) {
    if (plan.storageMb === null) lines.push("Không giới hạn dung lượng tệp");
    else lines.push(plan.storageMb >= 1024 ? `${formatNumber(Math.round((plan.storageMb / 1024) * 10) / 10)} GB dung lượng tệp` : `${formatNumber(plan.storageMb)} MB dung lượng tệp`);
  }
  return lines;
}

function SectionHead({ eyebrow, title, body }: { eyebrow: string; title: string; body?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-bold leading-tight text-balance sm:text-3xl">{title}</h2>
      {body ? <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">{body}</p> : null}
    </div>
  );
}

/** Minh hoạ nguyên tắc ba chiều tách rời — chữ mô tả, KHÔNG số liệu: một con số ở đây sẽ là số bịa. */
function ThreeDimensionsCard() {
  const rows = [
    { dim: "Vận chuyển", source: "Chứng từ Viettel Post", evidence: "Phát thành công · chiều hoàn", verdict: "Đơn hoàn", tone: "bg-warning" },
    { dim: "Tiền", source: "Bảng kê COD", evidence: "Chưa có chứng từ", verdict: "Chưa xác minh — không phải 0 ₫", tone: "bg-info" },
    { dim: "Tồn kho", source: "Phiếu kho", evidence: "Chờ kho đếm hàng hoàn", verdict: "Chưa cộng lại vào tồn", tone: "bg-chart-3" },
  ];
  return (
    <div className="relative rounded-3xl bg-card p-5 text-card-foreground shadow-[var(--shadow-raised)] sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">Một đơn hàng, ba chiều</p>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">Minh hoạ</span>
      </div>
      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.dim} className="rounded-2xl bg-[var(--surface-sunken)] p-3.5">
            <div className="flex items-center gap-2">
              <span className={`size-2 shrink-0 rounded-full ${r.tone}`} />
              <span className="text-xs font-bold uppercase tracking-wide">{r.dim}</span>
              <span className="ml-auto truncate text-[11px] text-muted-foreground">{r.source}</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{r.evidence}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold">
              <ArrowRight className="size-3.5 shrink-0 text-brand" aria-hidden />
              {r.verdict}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">Không chiều nào được suy ra từ chiều kia: tiền về không chứng minh hàng tới tay khách, và đơn vị vận chuyển báo hoàn chưa có nghĩa hàng đã về kho.</p>
    </div>
  );
}

export default async function SitePage() {
  const data = await getPublicSiteData();
  const signup = signupCopy(data);
  const industries = BUSINESS_TYPES.filter((t) => t !== "blank").map((t) => ({ key: t, ...BUSINESS_TYPE_SPEC[t] }));
  const year = new Date().getFullYear();

  return (
    <div className="min-h-screen scroll-smooth bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <a href="#" aria-label="VNXcommerce — về đầu trang">
            <BrandLockup wordmarkClassName="text-base" />
          </a>
          <nav className="ml-6 hidden items-center gap-6 text-sm font-medium text-muted-foreground md:flex" aria-label="Mục lục trang">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-foreground">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href={data.loginUrl}>Đăng nhập</a>
            </Button>
            <Button asChild size="sm">
              <a href={data.signupUrl}>Đăng ký</a>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* ─── HERO ─── */}
        <section className="relative overflow-hidden bg-sidebar text-sidebar-foreground">
          <div className="pointer-events-none absolute -top-40 -right-32 size-[30rem] rounded-full bg-brand/25 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-48 -left-24 size-[28rem] rounded-full bg-chart-2/20 blur-3xl" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:py-24">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full bg-sidebar-accent px-3 py-1 text-xs font-semibold text-sidebar-foreground/80">
                <BrandGlyph className="h-2.5 text-brand-bright" />
                Nền tảng vận hành cho shop bán hàng online
              </p>
              <h1 className="mt-5 text-3xl font-bold leading-tight text-balance sm:text-4xl lg:text-5xl">
                Đơn hàng, vận đơn, COD và lợi nhuận — <span className="text-brand-bright">nói cùng một sự thật.</span>
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-sidebar-foreground/75">
                VNXcommerce gom dữ liệu từ POS, đơn vị vận chuyển, tài khoản quảng cáo và sao kê ngân hàng thành một ERP: biết đơn nào giao thành công thật, tiền nào đã về, hàng nào còn trong kho — và chỗ nào còn chưa biết.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="gap-2">
                  <a href={data.signupUrl}>
                    {signup.label}
                    <ArrowRight className="size-4" aria-hidden />
                  </a>
                </Button>
                <Button asChild size="lg" variant="outline" className="border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground">
                  <a href={data.loginUrl}>Đăng nhập ERP</a>
                </Button>
              </div>
              {signup.note ? <p className="mt-4 text-sm text-sidebar-foreground/60">{signup.note}</p> : null}
            </div>
            <ThreeDimensionsCard />
          </div>
        </section>

        {/* ─── VẤN ĐỀ ─── */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Vấn đề" title="Shop online mất tiền ở những chỗ không ai nhìn thấy" body="Không phải vì thiếu báo cáo — mà vì mỗi báo cáo đếm theo một nguồn khác nhau." />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PROBLEMS.map((p, i) => (
              <article key={p.title} className="rounded-3xl bg-card p-5 shadow-[var(--shadow-card)]">
                <span className="text-xs font-bold text-brand">0{i + 1}</span>
                <h3 className="mt-2 font-semibold leading-snug">{p.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{p.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ─── KẾT NỐI ─── */}
        <section className="bg-[var(--surface-sunken)]">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
            <SectionHead eyebrow="Kết nối" title="Không thay hệ thống bạn đang dùng — nối chúng lại" body="Nhân viên vẫn chốt đơn trên POS, vẫn gửi hàng qua đơn vị vận chuyển quen thuộc. ERP đọc từ đó và đặt mọi thứ cạnh nhau." />
            <ul className="mx-auto mt-8 flex max-w-3xl flex-wrap justify-center gap-2.5">
              {CONNECTORS.map((c) => (
                <li key={c} className="rounded-full bg-card px-4 py-2 text-sm font-medium shadow-[var(--shadow-card)]">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ─── GIẢI PHÁP ─── */}
        <section id="giai-phap" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Giải pháp" title="Một ERP cho cả vòng bán hàng" body="Bật đúng những module tổ chức cần; module nào chưa dùng thì tắt, không làm rối màn hình." />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m) => (
              <article key={m.title} className="rounded-3xl bg-card p-5 shadow-[var(--shadow-card)]">
                <span className="flex size-10 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                  <m.icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-4 font-semibold">{m.title}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{m.body}</p>
              </article>
            ))}
          </div>
        </section>

        {/* ─── NGÀNH HÀNG ─── */}
        <section id="nganh-hang" className="scroll-mt-20 bg-[var(--surface-sunken)]">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionHead eyebrow="Ngành hàng" title="Bắt đầu từ mẫu ngành, không từ trang trắng" body="Chọn ngành lúc đăng ký: ERP gợi ý sẵn mẫu dữ liệu và bộ module. Bạn xem trước và quyết định cài gì." />
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {industries.map((t) => (
                <article key={t.key} className="flex flex-col rounded-3xl bg-card p-5 shadow-[var(--shadow-card)]">
                  <h3 className="font-semibold">{t.label}</h3>
                  <p className="mt-2 flex-1 text-sm leading-6 text-muted-foreground">{t.hint}</p>
                  <p className="mt-4 text-xs font-semibold text-brand">{t.templateKey ? "Có mẫu ngành dựng sẵn" : "Bộ module gợi ý"}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ─── BẢNG GIÁ ─── (ẩn khi không đọc được gói nào: không bao giờ in giá đoán) */}
        {data.plans.length > 0 || data.starterPlan ? (
          <section id="bang-gia" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 sm:px-6 lg:py-20">
            <SectionHead eyebrow="Bảng giá" title="Trả theo tháng, đổi gói khi cần" body="Gia hạn bằng chuyển khoản theo mã thanh toán (VietQR). Giá chưa gồm chi phí kênh bên ngoài như phí vận chuyển hay tiền quảng cáo." />
            <div className={`mt-10 grid gap-4 sm:grid-cols-2 ${data.plans.length + (data.starterPlan ? 1 : 0) >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
              {data.starterPlan ? (
                <article className="flex flex-col rounded-3xl bg-card p-6 shadow-[var(--shadow-card)]">
                  <h3 className="font-semibold">{data.starterPlan.name}</h3>
                  <p className="mt-3 text-2xl font-bold">Gói khởi điểm</p>
                  <p className="mt-1 text-xs text-muted-foreground">Tổ chức tự đăng ký bắt đầu ở đây</p>
                  {data.starterPlan.description ? <p className="mt-4 text-sm leading-6 text-muted-foreground">{data.starterPlan.description}</p> : null}
                  <PlanLimits plan={data.starterPlan} />
                  <Button asChild variant="outline" className="mt-6">
                    <a href={data.signupUrl}>{signup.label}</a>
                  </Button>
                </article>
              ) : null}
              {data.plans.map((p, i) => {
                const featured = data.plans.length >= 3 && i === 1;
                return (
                  <article key={p.key} className={`relative flex flex-col rounded-3xl p-6 shadow-[var(--shadow-card)] ${featured ? "bg-sidebar text-sidebar-foreground" : "bg-card"}`}>
                    {featured ? <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-white">Phổ biến</span> : null}
                    <h3 className="font-semibold">{p.name}</h3>
                    <p className="mt-3 text-2xl font-bold">
                      {formatVND(p.priceVnd)}
                      <span className={`text-sm font-medium ${featured ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}> / tháng</span>
                    </p>
                    {p.description ? <p className={`mt-4 text-sm leading-6 ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{p.description}</p> : null}
                    <PlanLimits plan={p} inverted={featured} />
                    <Button asChild variant={featured ? "default" : "outline"} className="mt-6">
                      <a href={data.signupUrl}>Bắt đầu</a>
                    </Button>
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* ─── TRIỂN KHAI ─── */}
        <section id="trien-khai" className="scroll-mt-20 bg-[var(--surface-sunken)]">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
            <SectionHead eyebrow="Triển khai" title="Tự lên hệ thống, từng bước một" body="Không cần đợi đội triển khai: mỗi bước có xem trước, và không bước nào tự chạy khi bạn chưa bấm." />
            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {STEPS.map((s, i) => (
                <li key={s.title} className="rounded-3xl bg-card p-5 shadow-[var(--shadow-card)]">
                  <span className="flex size-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">{i + 1}</span>
                  <h3 className="mt-4 font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ─── NGUYÊN TẮC SỐ LIỆU ─── */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Nguyên tắc" title="Số liệu đủ tin để ra quyết định" body="Một con số sai mà trông hợp lý còn nguy hiểm hơn không có số. Bốn luật ERP không bao giờ phá:" />
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <article key={p.title} className="flex gap-4 rounded-3xl bg-card p-5 shadow-[var(--shadow-card)]">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent text-accent-foreground">
                  <p.icon className="size-5" aria-hidden />
                </span>
                <div>
                  <h3 className="font-semibold">{p.title}</h3>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{p.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ─── LỜI MỜI CUỐI ─── */}
        <section className="px-4 pb-16 sm:px-6 lg:pb-20">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-sidebar px-6 py-12 text-center text-sidebar-foreground sm:px-12">
            <div className="pointer-events-none absolute -top-24 left-1/2 size-80 -translate-x-1/2 rounded-full bg-brand/25 blur-3xl" />
            <h2 className="relative text-2xl font-bold text-balance sm:text-3xl">Sẵn sàng nhìn shop của bạn bằng số thật?</h2>
            <p className="relative mx-auto mt-3 max-w-xl text-sm leading-6 text-sidebar-foreground/70">{signup.note ?? "Tạo tổ chức của bạn hoặc đăng nhập vào ERP đang dùng."}</p>
            <div className="relative mt-7 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg" className="gap-2">
                <a href={data.signupUrl}>
                  {signup.label}
                  <ArrowRight className="size-4" aria-hidden />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground">
                <a href={data.loginUrl}>Đăng nhập</a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="space-y-2">
            <BrandLockup wordmarkClassName="text-base" />
            <p className="text-xs text-muted-foreground">© {year} VNXcommerce · Nền tảng vận hành cho shop bán hàng online</p>
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
            <a href={data.signupUrl} className="hover:text-foreground">
              Đăng ký
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function PlanLimits({ plan, inverted = false }: { plan: PublicPlan; inverted?: boolean }) {
  const lines = limitLines(plan);
  if (lines.length === 0) return null;
  return (
    <ul className="mt-5 flex-1 space-y-2 text-sm">
      {lines.map((l) => (
        <li key={l} className="flex items-start gap-2">
          <Check className={`mt-0.5 size-4 shrink-0 ${inverted ? "text-brand-bright" : "text-brand"}`} aria-hidden />
          <span>{l}</span>
        </li>
      ))}
    </ul>
  );
}
