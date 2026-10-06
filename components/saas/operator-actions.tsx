"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addCostEntryAction,
  changeSubscriptionAction,
  createCustomerAction,
  finalizeStatementAction,
  moveWorkspaceAction,
  reconcileSubscriptionsAction,
  retryProvisioningAction,
  subscribeProductAction,
  updateAccountAction,
  voidCostEntryAction,
} from "@/lib/actions/saas";

/** Lý do tối thiểu — trùng `OPERATOR_REASON_MIN` của lõi (lib/saas/console.ts); lõi kiểm lại. */
const MIN = 5;
const key = (p: string) => `${p}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
const sel = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function SubscriptionButtons({ accountCode, subscriptionId, state, productName }: { accountCode: string; subscriptionId: string; state: string; productName: string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {state === "ACTIVE" ? (
        <ConfirmWithReason id={`pause-${subscriptionId}`} label="Tạm dừng" variant="outline" title={`Tạm dừng ${productName}?`} consequence="Thuê bao thôi mở năng lực của sản phẩm; module và dữ liệu giữ nguyên. Tiếp tục được bất cứ lúc nào." minReason={MIN} placeholder="Khách xin tạm nghỉ 1 tháng" run={(reason) => changeSubscriptionAction({ subscriptionId, action: "PAUSE", reason }, accountCode)} />
      ) : null}
      {state === "PAUSED" ? <ConfirmWithReason id={`resume-${subscriptionId}`} label="Tiếp tục" variant="outline" title={`Tiếp tục ${productName}?`} consequence="Thuê bao mở lại năng lực theo gói hiện tại." minReason={MIN} placeholder="Khách quay lại" run={(reason) => changeSubscriptionAction({ subscriptionId, action: "RESUME", reason }, accountCode)} /> : null}
      <ConfirmWithReason
        id={`cancel-${subscriptionId}`}
        label="Huỷ"
        variant="destructive"
        title={`Huỷ thuê bao ${productName}?`}
        consequence="Thuê bao chuyển ĐÃ HUỶ và module độc quyền của sản phẩm bị TẮT (dữ liệu không xoá — thuê lại là thấy lại). Lõi thương mại mà sản phẩm khác còn cần không bị tắt. Có job cấp phát + nhật ký."
        minReason={MIN}
        placeholder="Khách thôi dùng AI bán hàng từ tháng sau"
        run={(reason) => changeSubscriptionAction({ subscriptionId, action: "CANCEL", reason, idempotencyKey: key(`cancel-${subscriptionId}`) }, accountCode)}
      />
    </div>
  );
}

export function SubscribeProductForm({ accountCode, orgCode, products, plans }: { accountCode: string; orgCode: string; products: { key: string; name: string }[]; plans: { key: string; name: string }[] }) {
  const [productKey, setProduct] = useState(products[0]?.key ?? "");
  const [planKey, setPlan] = useState("");
  const idem = useMemo(() => key(`sub-${orgCode}`), [orgCode]);
  if (!products.length) return <p className="text-xs text-muted-foreground">Workspace đã thuê mọi sản phẩm trong danh mục.</p>;
  return (
    <ConfirmWithReason
      id={`subscribe-${orgCode}`}
      label="Thuê thêm sản phẩm…"
      variant="outline"
      title={`Thuê thêm sản phẩm cho ${orgCode}?`}
      consequence="Job cấp phát bật module của sản phẩm (đúng thứ tự phụ thuộc) rồi mở thuê bao. Gửi lại cùng yêu cầu không chạy hai lần."
      minReason={MIN}
      placeholder="Khách mua thêm ERP"
      run={(reason) => subscribeProductAction({ orgCode, productKey, planKey, idempotencyKey: idem, reason }, accountCode)}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`sp-${orgCode}`}>Sản phẩm</Label>
          <select id={`sp-${orgCode}`} className={sel} value={productKey} onChange={(e) => setProduct(e.target.value)}>
            {products.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`pl-${orgCode}`}>Gói</Label>
          <select id={`pl-${orgCode}`} className={sel} value={planKey} onChange={(e) => setPlan(e.target.value)}>
            <option value="">Theo gói của workspace (gộp)</option>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </ConfirmWithReason>
  );
}

export function RetryJobButton({ accountCode, jobId }: { accountCode: string; jobId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await retryProvisioningAction({ jobId }, accountCode);
          if ("error" in r) toast.error(r.error);
          else if (r.status === "SUCCEEDED") toast.success(r.message);
          else toast.error(r.message);
        })
      }
    >
      {pending ? "Đang chạy…" : "Chạy lại"}
    </Button>
  );
}

export function ReconcileButton({ accountCode, orgCode }: { accountCode: string; orgCode: string }) {
  return (
    <ConfirmWithReason
      id={`reconcile-${orgCode}`}
      label="Mở thuê bao còn thiếu"
      variant="outline"
      title="Mở thuê bao cho sản phẩm đang bật module?"
      consequence="Mở thuê bao (theo gói workspace) cho sản phẩm mà module đang bật nhưng chưa có thuê bao. Chỉ THÊM — không huỷ gì."
      minReason={MIN}
      placeholder="Module AI bán hàng bật tay trước khi có thuê bao"
      run={(reason) => reconcileSubscriptionsAction({ orgCode, reason }, accountCode)}
    />
  );
}

export function MoveWorkspaceForm({ accountCode, orgCode, accounts }: { accountCode: string; orgCode: string; accounts: { code: string; name: string }[] }) {
  const options = accounts.filter((a) => a.code !== accountCode);
  const [to, setTo] = useState(options[0]?.code ?? "");
  if (!options.length) return null;
  return (
    <ConfirmWithReason
      id={`move-${orgCode}`}
      label="Chuyển sang tài khoản khác…"
      variant="outline"
      title={`Chuyển workspace ${orgCode}?`}
      consequence="Workspace và thuê bao đang sống đi theo tài khoản đích (bên trả tiền mới). Thuê bao đã huỷ giữ tài khoản cũ. Đây là cách GỘP hai tài khoản — không bao giờ tự gộp theo tên."
      minReason={MIN}
      placeholder="Cùng một chủ doanh nghiệp — xác nhận qua Zalo"
      run={(reason) => moveWorkspaceAction({ orgCode, toAccountCode: to, reason }, accountCode)}
    >
      <select className={sel} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Tài khoản đích">
        {options.map((a) => (
          <option key={a.code} value={a.code}>
            {a.name} ({a.code})
          </option>
        ))}
      </select>
    </ConfirmWithReason>
  );
}

export function AccountEditForm({ account }: { account: { code: string; name: string; accountType: string; billingMode: string; status: string; legalName: string | null; taxCode: string | null; billingEmail: string | null } }) {
  const [f, setF] = useState({ name: account.name, accountType: account.accountType, billingMode: account.billingMode, status: account.status, legalName: account.legalName ?? "", taxCode: account.taxCode ?? "", billingEmail: account.billingEmail ?? "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <ConfirmWithReason
      id={`acct-${account.code}`}
      label="Sửa tài khoản…"
      variant="outline"
      title={`Sửa tài khoản ${account.name}?`}
      consequence="Loại tài khoản và cách lập chứng từ đổi cách dựng bảng kê từ kỳ chưa chốt; KHÔNG cấp hay bớt quyền nào. Kỳ đã chốt giữ nguyên."
      minReason={MIN}
      placeholder="Khách cung cấp MST để xuất hoá đơn"
      run={(reason) => updateAccountAction({ accountCode: account.code, ...f, reason })}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Tên</Label>
          <Input value={f.name} onChange={set("name")} />
        </div>
        <div className="space-y-1">
          <Label>Loại</Label>
          <select className={sel} value={f.accountType} onChange={set("accountType")}>
            <option value="EXTERNAL">Khách ngoài</option>
            <option value="INTERNAL">Nội bộ</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>Chứng từ</Label>
          <select className={sel} value={f.billingMode} onChange={set("billingMode")}>
            <option value="EXTERNAL_INVOICE">Hoá đơn khách</option>
            <option value="INTERNAL_CHARGEBACK">Chargeback nội bộ</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>Trạng thái</Label>
          <select className={sel} value={f.status} onChange={set("status")}>
            <option value="ACTIVE">Đang hoạt động</option>
            <option value="SUSPENDED">Tạm dừng</option>
            <option value="CLOSED">Đã đóng</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label>Tên pháp lý</Label>
          <Input value={f.legalName} onChange={set("legalName")} />
        </div>
        <div className="space-y-1">
          <Label>Mã số thuế</Label>
          <Input value={f.taxCode} onChange={set("taxCode")} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label>Email nhận chứng từ</Label>
          <Input value={f.billingEmail} onChange={set("billingEmail")} />
        </div>
      </div>
    </ConfirmWithReason>
  );
}

export function CostEntryForm({ periodMonth, accountCode, workspaces, products }: { periodMonth: string; accountCode?: string; workspaces: { code: string; name: string }[]; products: { key: string; name: string }[] }) {
  const [f, setF] = useState({ scope: workspaces.length ? "WORKSPACE" : "PLATFORM", orgCode: workspaces[0]?.code ?? "", productKey: products[0]?.key ?? "", category: "EXTERNAL_API", basis: "EQUAL_ACTIVE_WORKSPACES", amountVnd: "", description: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const basis = f.scope === "WORKSPACE" || f.scope === "ACCOUNT" ? "DIRECT" : f.basis;
  return (
    <ConfirmWithReason
      id={`cost-${accountCode ?? "platform"}`}
      label="Ghi khoản chi…"
      variant="outline"
      title="Ghi một khoản chi phí ngoài AI?"
      consequence="Khoản chi vào sổ chi phí của kỳ, chia theo CĂN CỨ đã chọn; biên gộp và bảng kê nội bộ tính lại ngay. Chi phí AI và khai hạ tầng / hỗ trợ nền theo tháng KHÔNG ghi ở đây (đã có nguồn riêng)."
      minReason={MIN}
      placeholder="Hoá đơn Zalo ZNS tháng 10"
      run={(reason) => addCostEntryAction({ periodMonth, category: f.category, scope: f.scope, productKey: f.productKey || undefined, accountCode: f.scope === "ACCOUNT" ? accountCode : undefined, orgCode: f.scope === "WORKSPACE" ? f.orgCode : undefined, basis, amountVnd: f.amountVnd, description: f.description, reason }, accountCode)}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Phạm vi</Label>
          <select className={sel} value={f.scope} onChange={set("scope")}>
            {workspaces.length ? <option value="WORKSPACE">Một workspace (trực tiếp)</option> : null}
            {accountCode ? <option value="ACCOUNT">Tài khoản này (trực tiếp)</option> : null}
            <option value="PRODUCT">Một sản phẩm (chia)</option>
            <option value="PLATFORM">Cả nền tảng (chia)</option>
          </select>
        </div>
        {f.scope === "WORKSPACE" ? (
          <div className="space-y-1">
            <Label>Workspace</Label>
            <select className={sel} value={f.orgCode} onChange={set("orgCode")}>
              {workspaces.map((w) => (
                <option key={w.code} value={w.code}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label>Sản phẩm</Label>
          <select className={sel} value={f.productKey} onChange={set("productKey")}>
            {f.scope === "PRODUCT" ? null : <option value="">(không gán)</option>}
            {products.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label>Hạng mục</Label>
          <select className={sel} value={f.category} onChange={set("category")}>
            <option value="EXTERNAL_API">API ngoài</option>
            <option value="MESSAGING">Tin nhắn / kênh</option>
            <option value="STORAGE">Lưu trữ / media</option>
            <option value="INFRA_DIRECT">Hạ tầng riêng</option>
            <option value="OTHER">Khác</option>
          </select>
        </div>
        {f.scope === "PRODUCT" || f.scope === "PLATFORM" ? (
          <div className="space-y-1">
            <Label>Căn cứ chia</Label>
            <select className={sel} value={f.basis} onChange={set("basis")}>
              <option value="EQUAL_ACTIVE_WORKSPACES">Chia đều workspace đang chạy</option>
              <option value="AI_COST_SHARE">Theo tỷ trọng chi phí AI</option>
            </select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label>Số tiền (VND)</Label>
          <Input inputMode="numeric" value={f.amountVnd} onChange={set("amountVnd")} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label>Mô tả</Label>
          <Input value={f.description} onChange={set("description")} />
        </div>
      </div>
    </ConfirmWithReason>
  );
}

export function VoidCostButton({ id, accountCode }: { id: string; accountCode?: string }) {
  return <ConfirmWithReason id={`void-${id}`} label="Huỷ" variant="outline" title="Huỷ khoản chi?" consequence="Dòng giữ lại làm lịch sử, đánh dấu huỷ kèm lý do; không còn tính vào kỳ." minReason={MIN} placeholder="Ghi nhầm số tiền" run={(reason) => voidCostEntryAction({ id, reason }, accountCode)} />;
}

export function FinalizeStatementButton({ accountCode, periodMonth }: { accountCode: string; periodMonth: string }) {
  return (
    <ConfirmWithReason
      id={`finalize-${accountCode}-${periodMonth}`}
      label={`Chốt kỳ ${periodMonth.slice(5, 7)}/${periodMonth.slice(0, 4)}…`}
      variant="outline"
      title="Chốt bảng kê kỳ này?"
      consequence="Bảng kê đóng băng ĐÚNG như đang tính (dòng, nguồn, số dòng chưa biết). Sửa công thức sau này KHÔNG đổi số kỳ đã chốt; không chốt lại được."
      minReason={MIN}
      placeholder="Đối chiếu xong với chủ shop"
      run={(reason) => finalizeStatementAction({ accountCode, periodMonth, reason })}
    />
  );
}

export function CreateCustomerForm({ plans, products, accounts }: { plans: { key: string; name: string; priceVnd: number | null }[]; products: { key: string; name: string }[]; accounts: { id: string; code: string; name: string }[] }) {
  const [f, setF] = useState({ accountId: "", accountName: "", accountCode: "", accountType: "EXTERNAL", workspaceCode: "", workspaceName: "", planKey: plans.find((p) => p.key === "trial")?.key ?? plans[0]?.key ?? "", brand: "", adminEmail: "", adminName: "" });
  const [chosen, setChosen] = useState<string[]>(products.slice(-1).map((p) => p.key));
  const [result, setResult] = useState<{ link: string | null; message: string } | null>(null);
  const idem = useMemo(() => key("create"), []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-3">
      <ConfirmWithReason
        id="create-customer"
        label="Tạo khách…"
        title="Tạo khách mới qua job cấp phát?"
        consequence="Tạo (hoặc dùng) tài khoản → workspace + CSDL riêng → bật module của sản phẩm → mở thuê bao → tài khoản quản trị. Mỗi bước có vết; hỏng giữa chừng thì «Chạy lại» ở trang khách. Quản trị nhận liên kết kích hoạt dùng một lần."
        minReason={MIN}
        placeholder="Khách ký hợp đồng dùng thử"
        run={async (reason) => {
          const r = await createCustomerAction({
            accountId: f.accountId || undefined,
            account: f.accountId ? undefined : { name: f.accountName || f.workspaceName, code: f.accountCode, accountType: f.accountType },
            workspace: { code: f.workspaceCode, name: f.workspaceName, planKey: f.planKey, brand: f.brand || null },
            products: chosen,
            admin: { email: f.adminEmail, name: f.adminName },
            idempotencyKey: idem,
            reason,
          });
          if ("ok" in r) setResult({ link: r.activationLink, message: r.message });
          return "ok" in r ? { ok: true, message: r.message } : r;
        }}
      >
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label>Tài khoản khách</Label>
            <select className={sel} value={f.accountId} onChange={set("accountId")}>
              <option value="">— Tài khoản mới —</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.code})
                </option>
              ))}
            </select>
          </div>
          {f.accountId ? null : (
            <>
              <div className="space-y-1">
                <Label>Tên khách</Label>
                <Input value={f.accountName} onChange={set("accountName")} placeholder="Hải Sản Làng Chài" />
              </div>
              <div className="space-y-1">
                <Label>Mã tài khoản (tuỳ chọn)</Label>
                <Input value={f.accountCode} onChange={set("accountCode")} placeholder="tự sinh từ tên" />
              </div>
              <div className="space-y-1">
                <Label>Loại</Label>
                <select className={sel} value={f.accountType} onChange={set("accountType")}>
                  <option value="EXTERNAL">Khách ngoài — hoá đơn</option>
                  <option value="INTERNAL">Nội bộ — chargeback</option>
                </select>
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label>Mã workspace</Label>
            <Input value={f.workspaceCode} onChange={set("workspaceCode")} placeholder="hslc-shop2" />
          </div>
          <div className="space-y-1">
            <Label>Tên workspace</Label>
            <Input value={f.workspaceName} onChange={set("workspaceName")} />
          </div>
          <div className="space-y-1">
            <Label>Gói</Label>
            <select className={sel} value={f.planKey} onChange={set("planKey")}>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                  {p.priceVnd ? ` — ${p.priceVnd.toLocaleString("vi-VN")} ₫` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Thương hiệu</Label>
            <select className={sel} value={f.brand} onChange={set("brand")}>
              <option value="">(mặc định)</option>
              <option value="vnx">VNX</option>
              <option value="chotdon">Chốt Đơn</option>
            </select>
          </div>
          <fieldset className="space-y-1 sm:col-span-2">
            <legend className="text-xs font-medium">Sản phẩm</legend>
            <div className="flex flex-wrap gap-3">
              {products.map((p) => (
                <label key={p.key} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={chosen.includes(p.key)} onChange={(e) => setChosen(e.target.checked ? [...chosen, p.key] : chosen.filter((k) => k !== p.key))} />
                  {p.name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1">
            <Label>Email quản trị</Label>
            <Input type="email" value={f.adminEmail} onChange={set("adminEmail")} />
          </div>
          <div className="space-y-1">
            <Label>Tên quản trị</Label>
            <Input value={f.adminName} onChange={set("adminName")} />
          </div>
        </div>
      </ConfirmWithReason>
      {result ? (
        <div className="rounded-lg border border-hairline bg-muted/30 px-3 py-2 text-xs">
          <p>{result.message}</p>
          {result.link ? (
            <p className="mt-1 break-all">
              Liên kết kích hoạt (dùng một lần, gửi riêng cho quản trị): <code>{result.link}</code>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
