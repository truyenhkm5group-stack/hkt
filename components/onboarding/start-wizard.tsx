"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Building2, Check, KeyRound, LayoutTemplate, Loader2, Puzzle, ScanEye, ShieldCheck, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkAdminAction, checkInviteAction, checkOrgAction, createOrganizationAction, previewSignupAction } from "@/lib/actions/onboarding";
import { PLAN_ACTION_LABEL, type PlanAction } from "@/lib/blueprints/types";
import { PRIVACY_POLICY, TERMS_OF_SERVICE } from "@/lib/constants/company";
import { ADMIN_PASSWORD_MIN, closeUnderDependencies, toggleModule, type BusinessType, type SignupPreview } from "@/lib/onboarding/shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ TRÌNH HƯỚNG DẪN `/start` (Phase 10 · §2) ═══════════
 *
 * Mỗi bước bấm "Tiếp" là một lượt hỏi MÁY CHỦ (server action) — trình duyệt chỉ giữ bản nháp và hiện lỗi. Lượt Tạo gửi
 * lại TOÀN BỘ bản nháp và máy chủ kiểm lại từ đầu: trạng thái ở đây là dữ liệu của client, không phải bằng chứng.
 * Mật khẩu chỉ rời trình duyệt ở bước kiểm quản trị và lượt Tạo.
 */

export type WizardModule = { key: string; label: string; description: string; dependsOn: string[] };
export type WizardTemplate = { key: string; name: string; description: string; industry: string | null; modules: string[] };
export type WizardBusinessType = { key: BusinessType; label: string; hint: string; templateKey: string | null; modules: string[] };

type Props = {
  mode: "invite" | "open" | "operator";
  initialInvite: string;
  businessTypes: WizardBusinessType[];
  templates: WizardTemplate[];
  modules: WizardModule[];
  coreLabels: string[];
  plans: { key: string; name: string }[];
};

type StepKey = "invite" | "org" | "admin" | "type" | "template" | "modules" | "preview";
const STEP_LABEL: Record<StepKey, { label: string; icon: typeof KeyRound }> = {
  invite: { label: "Mã mời", icon: KeyRound },
  org: { label: "Tổ chức", icon: Building2 },
  admin: { label: "Quản trị", icon: ShieldCheck },
  type: { label: "Loại hình", icon: Store },
  template: { label: "Mẫu", icon: LayoutTemplate },
  modules: { label: "Module", icon: Puzzle },
  preview: { label: "Xem trước", icon: ScanEye },
};

/** Tên ⇒ gợi ý mã: bỏ dấu tiếng Việt, chữ thường, gạch ngang. Người dùng sửa được. */
function suggestCode(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);
  return /^[a-z]/.test(base) ? base : base ? `o-${base}`.slice(0, 31) : "";
}

export function StartWizard({ mode, initialInvite, businessTypes, templates, modules, coreLabels, plans }: Props) {
  const steps = useMemo<StepKey[]>(() => (mode === "invite" ? ["invite", "org", "admin", "type", "template", "modules", "preview"] : ["org", "admin", "type", "template", "modules", "preview"]), [mode]);
  const [index, setIndex] = useState(0);
  const [invite, setInvite] = useState(initialInvite);
  const [org, setOrg] = useState({ name: "", code: "" });
  const [codeTouched, setCodeTouched] = useState(false);
  const [admin, setAdmin] = useState({ name: "", email: "", password: "", confirm: "" });
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [planKey, setPlanKey] = useState<string>(plans[0]?.key ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<SignupPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const step = steps[index];
  const labelOf = (k: string) => modules.find((m) => m.key === k)?.label ?? k;
  const templateOf = (k: string | null) => templates.find((t) => t.key === k) ?? null;

  const chooseTemplate = (key: string | null, typeModules: string[] = []) => {
    setTemplateKey(key);
    const t = templateOf(key);
    setSelected(closeUnderDependencies(t ? t.modules : typeModules).modules);
    setNotice(null);
    setPreview(null);
  };

  const go = (delta: number) => {
    setError(null);
    setIndex((i) => Math.min(steps.length - 1, Math.max(0, i + delta)));
  };

  const loadPreview = () =>
    start(async () => {
      setPreview(null);
      const r = await previewSignupAction({ invite: mode === "invite" ? invite : null, orgCode: org.code, plan: { businessType: businessType ?? "blank", templateKey, modules: selected }, planKey: mode === "operator" ? planKey : null });
      if ("error" in r) setError(r.error);
      else setPreview(r.preview);
    });

  const next = () =>
    start(async () => {
      setError(null);
      let r: { ok: true } | { error: string } = { ok: true };
      if (step === "invite") r = await checkInviteAction(invite);
      else if (step === "org") r = await checkOrgAction(org, mode === "invite" ? invite : null);
      else if (step === "admin") {
        if (admin.password !== admin.confirm) r = { error: "Hai lần nhập mật khẩu không khớp." };
        else r = await checkAdminAction({ name: admin.name, email: admin.email, password: admin.password });
      } else if (step === "type" && !businessType) r = { error: "Chọn một loại hình." };
      if ("error" in r) {
        setError(r.error);
        return;
      }
      const nextStep = steps[index + 1];
      setIndex(index + 1);
      if (nextStep === "preview") {
        const pr = await previewSignupAction({ invite: mode === "invite" ? invite : null, orgCode: org.code, plan: { businessType: businessType ?? "blank", templateKey, modules: selected }, planKey: mode === "operator" ? planKey : null });
        if ("error" in pr) setError(pr.error);
        else setPreview(pr.preview);
      }
    });

  const create = () =>
    start(async () => {
      setError(null);
      const r = await createOrganizationAction({
        invite: mode === "invite" ? invite : null,
        org,
        admin: { name: admin.name, email: admin.email, password: admin.password },
        plan: { businessType: businessType ?? "blank", templateKey, modules: selected },
        planKey: mode === "operator" ? planKey : null,
      });
      // Khách: máy chủ chuyển thẳng vào ERP mới (redirect) — tới được đây chỉ khi có lỗi hoặc là người vận hành.
      if (r && "error" in r) setError(r.error);
      else if (r?.operator) setDone(r.orgCode);
    });

  if (done) {
    return (
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Check className="size-5 text-emerald-600" /> Đã tạo tổ chức «{done}»
          </CardTitle>
          <CardDescription>Bạn đang tạo hộ khách với tư cách người vận hành — phiên của bạn không đổi. Gửi cho khách mã tổ chức và email quản trị để họ đăng nhập.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href={`/platform?org=${encodeURIComponent(done)}`}>Về Vận hành nền tảng</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="w-full max-w-3xl space-y-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Các bước">
        {steps.map((s, i) => {
          const Icon = STEP_LABEL[s].icon;
          return (
            <li key={s} className={cn("flex items-center gap-1 rounded-full px-2.5 py-1", i === index ? "bg-primary text-primary-foreground" : i < index ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
              <Icon className="size-3.5" aria-hidden />
              {i + 1}. {STEP_LABEL[s].label}
            </li>
          );
        })}
      </ol>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {mode === "operator" ? <p className="rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:bg-sky-950 dark:text-sky-100">Bạn đang tạo tổ chức cho khách với tư cách người vận hành nền tảng: không cần mã mời, và phiên của bạn không đổi sau khi tạo.</p> : null}

          {step === "invite" ? (
            <div className="space-y-2">
              <Label htmlFor="invite">Mã mời</Label>
              <Input id="invite" value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" spellCheck={false} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXX" autoFocus />
              <p className="text-xs text-muted-foreground">Mã do người vận hành nền tảng gửi. Mỗi mã dùng được một lần và có hạn.</p>
            </div>
          ) : null}

          {step === "org" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-name">Tên tổ chức</Label>
                <Input
                  id="org-name"
                  value={org.name}
                  autoFocus
                  onChange={(e) => {
                    const name = e.target.value;
                    setOrg((o) => ({ name, code: codeTouched ? o.code : suggestCode(name) }));
                  }}
                  placeholder="Bán sỉ Minh An"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-code">Mã tổ chức</Label>
                <Input
                  id="org-code"
                  value={org.code}
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(e) => {
                    setCodeTouched(true);
                    setOrg((o) => ({ ...o, code: e.target.value.toLowerCase() }));
                  }}
                  placeholder="minh-an"
                />
                <p className="text-xs text-muted-foreground">Dùng để đăng nhập (ô «Mã tổ chức»). Chữ thường không dấu, số, gạch ngang — không đổi được sau này.</p>
              </div>
            </div>
          ) : null}

          {step === "admin" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="admin-name">Họ tên quản trị</Label>
                <Input id="admin-name" value={admin.name} onChange={(e) => setAdmin((a) => ({ ...a, name: e.target.value }))} autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-email">Email</Label>
                <Input id="admin-email" type="email" autoComplete="username" value={admin.email} onChange={(e) => setAdmin((a) => ({ ...a, email: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-password">Mật khẩu (ít nhất {ADMIN_PASSWORD_MIN} ký tự)</Label>
                <Input id="admin-password" type="password" autoComplete="new-password" value={admin.password} onChange={(e) => setAdmin((a) => ({ ...a, password: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="admin-confirm">Nhập lại mật khẩu</Label>
                <Input id="admin-confirm" type="password" autoComplete="new-password" value={admin.confirm} onChange={(e) => setAdmin((a) => ({ ...a, confirm: e.target.value }))} />
              </div>
            </div>
          ) : null}

          {step === "type" ? (
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Loại hình">
              {businessTypes.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={businessType === t.key}
                  data-type={t.key}
                  onClick={() => {
                    setBusinessType(t.key);
                    chooseTemplate(t.templateKey, t.modules);
                  }}
                  className={cn("rounded-xl border p-3 text-left text-sm transition-colors", businessType === t.key ? "border-primary bg-primary/5" : "hover:bg-muted")}
                >
                  <span className="font-semibold">{t.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t.hint}</span>
                </button>
              ))}
            </div>
          ) : null}

          {step === "template" ? (
            <div className="space-y-2" role="radiogroup" aria-label="Mẫu">
              <p className="text-xs text-muted-foreground">Mẫu gợi ý theo loại hình — đổi được. Mẫu là một gói cấu hình (module, field, form, trang, luật ở NHÁP); không có dữ liệu mẫu nào.</p>
              {[...templates.map((t) => ({ key: t.key as string | null, name: t.name, description: t.description })), { key: null, name: "Bắt đầu trắng", description: "Không mẫu nào — chỉ bật module bạn tự chọn ở bước sau." }].map((t) => (
                <button
                  key={t.key ?? "blank"}
                  type="button"
                  role="radio"
                  aria-checked={templateKey === t.key}
                  data-template={t.key ?? "blank"}
                  onClick={() => chooseTemplate(t.key, businessTypes.find((b) => b.key === businessType)?.modules ?? [])}
                  className={cn("w-full rounded-xl border p-3 text-left text-sm transition-colors", templateKey === t.key ? "border-primary bg-primary/5" : "hover:bg-muted")}
                >
                  <span className="font-semibold">{t.name}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t.description}</span>
                </button>
              ))}
            </div>
          ) : null}

          {step === "modules" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Luôn bật: {coreLabels.join(", ")}. Bật một module thì những module nó cần tự bật theo; tắt thì những module đang cần nó tắt theo — dòng thông báo bên dưới nói rõ.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {modules.map((m) => {
                  const on = selected.includes(m.key);
                  return (
                    <label key={m.key} className={cn("flex cursor-pointer gap-2.5 rounded-xl border p-3 text-sm", on ? "border-primary/60 bg-primary/5" : "")} data-module={m.key}>
                      <Checkbox
                        checked={on}
                        onCheckedChange={(v) => {
                          const r = toggleModule(selected, m.key, v === true);
                          setSelected(r.modules);
                          setPreview(null);
                          setNotice(r.alsoOn.length ? `Bật «${m.label}» ⇒ bật thêm ${r.alsoOn.map(labelOf).join(", ")} (nó cần).` : r.alsoOff.length ? `Tắt «${m.label}» ⇒ tắt luôn ${r.alsoOff.map(labelOf).join(", ")} (đang cần nó).` : null);
                        }}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="font-medium">{m.label}</span>
                        <span className="block text-xs text-muted-foreground">{m.description}</span>
                        {m.dependsOn.length ? <span className="block text-[11px] text-muted-foreground">Cần: {m.dependsOn.map(labelOf).join(", ")}</span> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              {notice ? (
                <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  {notice}
                </p>
              ) : null}
              {plans.length ? (
                <div className="space-y-1">
                  <Label htmlFor="plan">Gói dịch vụ</Label>
                  <select id="plan" value={planKey} onChange={(e) => setPlanKey(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
                    {plans.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "preview" ? (
            preview ? (
              <div className="space-y-4 text-sm" data-preview-ok={preview.ok ? "1" : "0"}>
                <div>
                  <p className="font-semibold">
                    {org.name} <span className="font-mono text-xs text-muted-foreground">({org.code})</span> · {preview.blueprint.fromTemplate ? `mẫu «${preview.blueprint.name}»` : "bắt đầu trắng"} · gói «{preview.plan.name}»
                  </p>
                  <p className="text-xs text-muted-foreground">Quản trị đầu tiên: {admin.email}. Máy chưa ghi gì — dưới đây là đúng những thao tác sẽ chạy khi bạn bấm Tạo.</p>
                  <p className="text-xs text-muted-foreground">
                    Bằng việc bấm Tạo, bạn đồng ý với{" "}
                    <a href={TERMS_OF_SERVICE.path} target="_blank" rel="noopener" className="underline">
                      Điều khoản sử dụng
                    </a>{" "}
                    và{" "}
                    <a href={PRIVACY_POLICY.path} target="_blank" rel="noopener" className="underline">
                      Chính sách quyền riêng tư
                    </a>
                    .
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Module sẽ bật</p>
                  <div className="flex flex-wrap gap-1.5">
                    {preview.modules.map((m) => (
                      <span key={m.key} className="rounded-full bg-muted px-2 py-0.5 text-xs" title={m.autoAdded ? "Bật theo vì module khác cần" : undefined}>
                        {m.label}
                        {m.autoAdded ? " · tự bật" : ""}
                      </span>
                    ))}
                  </div>
                </div>
                {preview.steps.length ? (
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Thao tác</p>
                    <ul className="divide-y rounded-lg border">
                      {preview.steps.map((s) => (
                        <li key={`${s.kind}:${s.key}`} className="flex items-start justify-between gap-3 px-3 py-1.5">
                          <span>
                            <span className="text-xs text-muted-foreground">{s.kindLabel} · </span>
                            {s.label}
                            {s.reason ? <span className="block text-xs text-muted-foreground">{s.reason}</span> : null}
                          </span>
                          <span className={cn("shrink-0 text-xs", s.action === "BLOCKED" ? "font-semibold text-destructive" : "text-muted-foreground")}>{PLAN_ACTION_LABEL[s.action as PlanAction] ?? s.action}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {preview.dropped.length ? (
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phần của mẫu KHÔNG cài (vì bạn bỏ module)</p>
                    <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                      {preview.dropped.map((d) => (
                        <li key={`${d.kind}:${d.key}`}>
                          {d.label} — {d.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {[...preview.issues, ...preview.plan.over].length ? (
                  <ul role="alert" className="list-disc space-y-0.5 rounded-lg border border-destructive/40 bg-destructive/5 py-2 pl-7 pr-3 text-xs text-destructive">
                    {[...preview.issues, ...preview.plan.over].map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : pending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Đang lập kế hoạch…
              </p>
            ) : (
              <Button type="button" variant="outline" onClick={loadPreview}>
                Lập lại kế hoạch
              </Button>
            )
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={() => go(-1)} disabled={index === 0 || pending}>
              <ArrowLeft className="size-4" /> Quay lại
            </Button>
            {step === "preview" ? (
              <Button type="button" onClick={create} disabled={pending || !preview?.ok} data-action="create">
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Tạo tổ chức
              </Button>
            ) : (
              <Button type="button" onClick={next} disabled={pending || (step === "type" && !businessType)} data-action="next">
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Tiếp <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
