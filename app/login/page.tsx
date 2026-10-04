import { redirect } from "next/navigation";
import { Bot, Hand, ShieldCheck, TrendingUp, Zap } from "lucide-react";
import { LoginForm } from "@/app/login/login-form";
import { BrandGlyph, BrandWordmark, ChotDonGlyph, ChotDonWordmark } from "@/components/brand";
import { hostBrand } from "@/lib/platform/host-brand";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { getSession } from "@/lib/auth/session";
import { loginShouldStay } from "@/lib/constants/session-revocation";
import { integrationStatus } from "@/lib/env";
import { HOST_NOT_FOUND_MESSAGE, hostOrganization } from "@/lib/platform/host-org";
import { listOrganizations } from "@/lib/platform/organizations";
import { enabledProviders } from "@/lib/auth/oauth";
import { signupMode } from "@/lib/onboarding/service";

export const dynamic = "force-dynamic";

/**
 * Ba lý do chọn — mỗi câu là thứ một cửa hàng MỚI tự đăng ký dùng được ngay (cùng tinh thần trang giới thiệu): chatbot AI
 * trả lời fanpage bằng giá / tồn của ERP, tự động hoá đơn — kho — khách, lãi thật theo đơn và chiến dịch.
 */
const USP = [
  { icon: Bot, title: "Chatbot AI chốt đơn thay bạn", text: "Trả lời khách, báo giá, lên đơn ngay trên fanpage — cả lúc bạn ngủ." },
  { icon: Zap, title: "Tự động từ đơn tới kho", text: "Đơn, tồn kho, khách hàng tự cập nhật — bớt việc tay, bớt người trực." },
  { icon: TrendingUp, title: "Thấy lãi thật, cắt chỗ đốt tiền", text: "Lợi nhuận từng đơn, từng chiến dịch quảng cáo — biết ngay khoản nào đang lỗ." },
] as const;

/**
 * Host «Chốt Đơn Tự Động»: khách của gói AI bán hàng — chỉ hứa điều trợ lý làm được ở tổ chức khách (lib/sales-chatbot),
 * không hứa lãi lỗ theo chiến dịch quảng cáo (cần ERP đầy đủ + đồng bộ quảng cáo).
 */
const CHOTDON_USP = [
  { icon: Bot, title: "Chatbot AI chốt đơn thay bạn", text: "Trả lời khách, báo giá, chốt đơn ngay trên fanpage — cả lúc bạn ngủ." },
  { icon: ShieldCheck, title: "Đúng giá, đúng hàng còn", text: "Giá, size, màu, tồn kho đọc từ sổ của shop — không báo bừa, không tự giảm giá." },
  { icon: Hand, title: "Biết lúc cần người", text: "Khiếu nại, đòi gặp người chuyển ngay cho nhân viên; nhân viên vào là trợ lý tự lùi." },
] as const;

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reason?: string; oauth?: string }> }) {
  const session = await getSession();
  const params = await searchParams;
  /*
    VÒNG LẶP CHUYỂN HƯỚNG — CÓ THẬT, KHÔNG PHẢI PHÒNG XA.

    `getSession()` chỉ kiểm CHỮ KÝ và HẠN; nó không biết gì về CSDL. Một phiên bị THU HỒI vẫn có
    cookie ký đúng và còn hạn, nên hàm này trả về một phiên trông hợp lệ. Đẩy người dùng vào trong
    thì trang đó gọi `requireUser()` → bị từ chối → đẩy ngược ra đây → lặp vô tận, trình duyệt báo
    ERR_TOO_MANY_REDIRECTS và người dùng không còn đường nào đăng nhập lại.

    `loginShouldStay()` giữ MỌI lý do từ chối ở lại trang này. Thêm một lý do mới thì thêm vào
    danh sách ở `lib/constants/session-revocation.ts`, không sửa điều kiện ở đây.
  */
  if (session && !loginShouldStay(params.reason)) redirect(safeNextPath(params.next));
  const status = integrationStatus();
  /*
    Ô "Mã tổ chức" chỉ hiện khi nền tảng THẬT SỰ có hơn một tổ chức đang hoạt động. Với một tổ chức
    (hôm nay) màn đăng nhập y hệt trước — không ai phải học thêm một ô không dùng tới. Chỉ đếm, không
    liệt kê: in danh sách tổ chức ra trang công khai là tự dâng sổ khách hàng của nền tảng.
  */
  /*
    TÊN MIỀN CON (0180): host `<slug>.<miền gốc>` GẮN CỨNG tổ chức đã xuất bản — không ô «Mã tổ chức», tiêu đề mang tên
    tổ chức. Tên miền con không trỏ tới ERP nào ⇒ nói thẳng, không hiện form (đăng nhập ở đây không có đích nào).
  */
  const host = await hostOrganization();
  if (host.slug && !host.org) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-xl font-semibold">Không tìm thấy ERP</h1>
          <p className="text-sm text-muted-foreground">{HOST_NOT_FOUND_MESSAGE}</p>
        </div>
      </div>
    );
  }
  const showOrgField = host.org ? false : (await listOrganizations()).filter((o) => o.status === "ACTIVE").length > 1;
  /*
    Trang này CÔNG KHAI và dùng chung cho mọi tổ chức. Khi nền tảng đã có tổ chức thứ hai, trạng thái cấu hình Pancake /
    Viettel Post là thông tin vận hành của RIÊNG tổ chức nhà (người lạ đọc được nhà đang nối gì), và gợi ý tên biến `.env`
    là chỉ dẫn cho người cài máy chủ, không phải cho khách. Một tổ chức (hôm nay) ⇒ trang y hệt trước.
  */
  // Host «Chốt Đơn Tự Động» (app.chotdontudong.com): KHÔNG BAO GIỜ in trạng thái kết nối của tổ chức nhà — người vào đây là
  // khách của sản phẩm AI bán hàng, không phải người cài máy chủ.
  const brand = host.org ? "vnx" : await hostBrand();
  const chotdon = brand === "chotdon";
  const homeOnly = !showOrgField && !host.org && !chotdon;

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="absolute -top-32 -right-32 size-96 rounded-full bg-brand/25 blur-3xl" />
        <div className="absolute -bottom-40 -left-20 size-[28rem] rounded-full bg-chart-2/20 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-2xl bg-brand text-white shadow-[0_16px_40px_-16px_var(--brand)]">
            {chotdon ? <ChotDonGlyph className="h-5" /> : <BrandGlyph className="h-4" />}
          </span>
          <div>
            {host.org ? (
              <span className="block text-xl font-bold text-brand-bright">{host.org.name}</span>
            ) : chotdon ? (
              <ChotDonWordmark className="block text-xl text-brand-bright" />
            ) : (
              <BrandWordmark className="block text-xl text-brand-bright" />
            )}
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sidebar-foreground/55">{chotdon ? "Nhân viên bán hàng AI" : "Hệ thống quản trị bán hàng"}</p>
          </div>
        </div>
        <div className="relative max-w-md space-y-6">
          <h1 className="text-3xl font-bold leading-tight">
            AI bán hàng 24/7 — <span className="text-brand-bright">chi phí giảm, lợi nhuận tăng.</span>
          </h1>
          {homeOnly ? null : (
            <ul className="space-y-4 text-sm leading-6 text-sidebar-foreground/80" data-login-usp>
              {(chotdon ? CHOTDON_USP : USP).map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/20 text-brand-bright">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span>
                    <span className="block font-semibold text-sidebar-foreground">{title}</span>
                    {text}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {homeOnly ? (
            <>
              <p className="text-sm leading-6 text-sidebar-foreground/70">
                Đồng bộ tự động từ Pancake POS và Viettel Post. Mọi thay đổi trạng thái giao hàng được cập nhật theo thời gian thực qua webhook.
              </p>
              <ul className="space-y-2 text-sm text-sidebar-foreground/80">
                <li className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${status.pancake ? "bg-success" : "bg-warning"}`} />
                  Pancake POS {status.pancake ? "đã cấu hình" : "chưa cấu hình API key"}
                </li>
                <li className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${status.viettelPost ? "bg-success" : "bg-warning"}`} />
                  Viettel Post {status.viettelPost ? "đã cấu hình" : "chưa cấu hình token"}
                </li>
              </ul>
            </>
          ) : null}
        </div>
        <p className="relative text-xs text-sidebar-foreground/50">{host.org ? `© ${new Date().getFullYear()} ${host.org.name}` : chotdon ? `© ${new Date().getFullYear()} Chốt Đơn Tự Động · một sản phẩm của VNXcommerce` : `© ${new Date().getFullYear()} VNXcommerce · Bán hàng tự động bằng AI`}</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <LoginForm
          next={params.next}
          reason={params.reason}
          oauth={params.oauth}
          showOrgField={showOrgField}
          showSetupHint={homeOnly}
          orgName={host.org?.name ?? null}
          brand={brand}
          providers={host.org ? { google: false, facebook: false } : enabledProviders()}
          signupOpen={!host.org && (await signupMode()) !== "off"}
        />
      </div>
    </div>
  );
}
