import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { Building2 } from "lucide-react";
import { QuickStart } from "@/components/onboarding/quick-start";
import { StartWizard, type WizardBusinessType, type WizardModule, type WizardTemplate } from "@/components/onboarding/start-wizard";
import { enabledProviders, readOAuthToken, SOCIAL_SIGNUP_COOKIE, type SocialProfile } from "@/lib/auth/oauth";
import { getCurrentUser } from "@/lib/auth/session";
import { BLUEPRINT_TEMPLATES } from "@/lib/blueprints/templates";
import { initialQuickBusinessType } from "@/lib/onboarding/quick-shared";
import { hostBrand } from "@/lib/platform/host-brand";
import { moduleDef } from "@/lib/constants/platform-modules";
import { listPlans } from "@/lib/entitlements/check";
import { signupMode } from "@/lib/onboarding/service";
import { BUSINESS_TYPE_SPEC, BUSINESS_TYPES, CORE_MODULES, SELECTABLE_MODULES } from "@/lib/onboarding/shared";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Tạo cửa hàng" }, description: "Tạo cửa hàng mới trên nền tảng ERP — khoảng 1 phút.", robots: { index: false, follow: false } };

/**
 * `/start` — TẠO TỔ CHỨC TỰ PHỤC VỤ (Phase 10 · §1–§2). Ngoài nhóm dashboard, không cần phiên.
 *
 * Chế độ đọc ở MÁY CHỦ mỗi lượt dựng = min(trần `PLATFORM_SIGNUP_MODE`, cài đặt ở `/platform`) — docs/platform/
 * launch-gates.md mục B. `off` (mặc định, production) ⇒ trang tĩnh "chưa mở đăng ký", HTTP 200, không in gì về nền tảng
 * hay tổ chức nào. Người vận hành nền tảng (phiên tổ chức nhà + `platform:operate`) luôn dùng được trang này để tạo hộ
 * khách — cùng luồng, không cần cờ. Trang không in gì của tổ chức nhà (tên, thương hiệu, số liệu).
 */
export default async function StartPage({ searchParams }: { searchParams: Promise<{ invite?: string; "day-du"?: string; nganh?: string }> }) {
  const mode = await signupMode();
  const user = await getCurrentUser();
  const operator = Boolean(user && !platformOperatorDenial(user));
  const flow: "invite" | "open" | "operator" | null = operator ? "operator" : mode === "off" ? null : mode;

  if (!flow) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <Building2 className="size-6" />
          </span>
          <h1 className="text-xl font-bold">Chưa mở đăng ký</h1>
          <p className="text-sm text-muted-foreground">Nền tảng hiện chưa nhận đăng ký tổ chức mới.</p>
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            Đăng nhập
          </Link>
        </div>
      </main>
    );
  }

  const params = await searchParams;
  /*
    ĐĂNG KÝ NHANH (docs/platform/quick-start.md) là cửa MẶC ĐỊNH của khách: một màn hình, máy tự chọn mã / mẫu / module.
    Trình hướng dẫn đầy đủ (chọn mẫu, module, xem trước từng thao tác) còn nguyên ở `?day-du=1` và luôn là cửa của người
    vận hành nền tảng (tạo hộ khách, chọn gói).
  */
  if (flow !== "operator" && params["day-du"] !== "1") {
    const social = await readOAuthToken<SocialProfile>("erp-social-signup", (await cookies()).get(SOCIAL_SIGNUP_COOKIE)?.value);
    return (
      <main className="flex min-h-screen items-start justify-center p-4 pt-10 sm:pt-16">
        <QuickStart
          needInvite={flow === "invite"}
          initialInvite={typeof params.invite === "string" ? params.invite.slice(0, 80) : ""}
          providers={enabledProviders()}
          social={social ? { provider: social.provider, email: social.email, name: social.name } : null}
          initialBusinessType={initialQuickBusinessType(params.nganh, await hostBrand())}
        />
      </main>
    );
  }
  const businessTypes: WizardBusinessType[] = BUSINESS_TYPES.map((k) => ({ key: k, ...BUSINESS_TYPE_SPEC[k] }));
  const templates: WizardTemplate[] = BLUEPRINT_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description, industry: t.industry, modules: t.modules.filter((m) => SELECTABLE_MODULES.includes(m)) }));
  const modules: WizardModule[] = SELECTABLE_MODULES.map((k) => {
    const d = moduleDef(k)!;
    return { key: k, label: d.label, description: d.description, dependsOn: d.dependsOn.filter((x) => SELECTABLE_MODULES.includes(x)) };
  });
  const plans = flow === "operator" ? (await listPlans()).map((p) => ({ key: p.key, name: p.name })) : [];

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 p-4 pt-10 sm:p-8 sm:pt-14">
      <div className="w-full max-w-3xl space-y-1">
        <h1 className="text-2xl font-bold">Tạo tổ chức mới</h1>
        <p className="text-sm text-muted-foreground">Mỗi tổ chức có cơ sở dữ liệu riêng. Chọn loại hình và mẫu, xem trước từng thao tác, rồi mới tạo.</p>
      </div>
      <StartWizard
        mode={flow}
        initialInvite={typeof params.invite === "string" ? params.invite.slice(0, 80) : ""}
        businessTypes={businessTypes}
        templates={templates}
        modules={modules}
        coreLabels={CORE_MODULES.map((k) => moduleDef(k)?.label ?? k)}
        plans={plans}
      />
    </main>
  );
}
