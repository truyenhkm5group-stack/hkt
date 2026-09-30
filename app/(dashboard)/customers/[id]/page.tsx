import Link from "next/link";
import { notFound } from "next/navigation";
import { Boxes, CircleDollarSign, ExternalLink, MapPin, PackageCheck, Phone, RotateCcw, ShoppingBag, Truck, User } from "lucide-react";
import { CopyButton, JsonViewer } from "@/components/misc";
import { ReverseRelationsCard } from "@/components/objects/reverse-relations-card";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { CodStatusBadge, OrderStageBadge, ShipmentStageBadge, SourceBadge } from "@/components/status-badge";
import { ModuleSyncButton } from "@/components/module-sync-button";
import { DescriptionList, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatDateTime, formatNumber, formatTimeAgo, formatVND, pct } from "@/lib/format";
import { getCustomerDetail } from "@/lib/queries/customers";
import { cn } from "@/lib/utils";
import { requirePermission, type SessionUser } from "@/lib/auth/session";
import { CustomerProfileForm } from "@/app/(dashboard)/customers/[id]/customer-profile-form";
import { objectDef } from "@/lib/constants/object-registry";
import { isManualOrderId } from "@/lib/constants/manual-orders";
import { manualPaymentStates } from "@/lib/queries/order-payments";
import { ManualPaymentStatusText } from "@/app/(dashboard)/orders/payment-status";
import { MetadataError } from "@/lib/metadata/errors";
import { listFields } from "@/lib/metadata/fields";
import { getPublishedForm } from "@/lib/metadata/forms";
import { canEditField, customFileNames, getCustomValues } from "@/lib/metadata/values";
import { userPickOptions } from "@/lib/queries/users";
import { getBrandCopy } from "@/lib/branding/service";
import { moduleOn } from "@/lib/platform-ui/module-visibility";
import { customerBasicsGate } from "@/lib/records/customer-create";

export const metadata = { title: "Hồ sơ khách hàng" };

const GENDER_LABEL: Record<string, string> = { male: "Nam", female: "Nữ", nam: "Nam", nu: "Nữ", "nữ": "Nữ", other: "Khác" };

type AddressRecord = { full_name?: string; phone_number?: string; full_address?: string; address?: string; province_name?: string; district_name?: string; commune_name?: string };

function parseAddresses(value: unknown): AddressRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is AddressRecord => Boolean(v) && typeof v === "object");
}

function addressText(a: AddressRecord) {
  return a.full_address || [a.address, a.commune_name, a.district_name, a.province_name].filter(Boolean).join(", ");
}

/**
 * Dữ liệu khối "Hồ sơ bổ sung" (form `profile` đã xuất bản — M7/M8). `null` ⇒ KHÔNG hiện khối: tổ chức
 * chưa có field custom nào VÀ chưa xuất bản form (tổ chức nhà không thấy một khối trống), hoặc lớp
 * metadata từ chối đọc (module / năng lực) — trang khách vẫn đứng nguyên.
 */
async function loadProfileBlock(user: SessionUser, customer: Record<string, unknown> & { id: string }, basicsEditable: boolean) {
  try {
    const [form, fields] = await Promise.all([getPublishedForm("customer", "profile"), listFields("customer")]);
    // Khách tạo tay sửa được thông tin cơ bản ⇒ khối luôn hiện, kể cả khi tổ chức chưa có field custom nào.
    if (!fields.custom.length && form.isDefault && !basicsEditable) return null;
    const obj = objectDef("customer")!;
    const [stored, users] = await Promise.all([getCustomValues("customer", [customer.id], user), fields.custom.some((f) => f.type === "user") ? userPickOptions() : Promise.resolve(undefined)]);
    const system = Object.fromEntries(fields.system.map((f) => [f.key, customer[f.column] ?? null]));
    const custom = stored.get(customer.id) ?? {};
    const fileIds = fields.custom.filter((f) => f.type === "file" && typeof custom[f.key] === "string").map((f) => String(custom[f.key]));
    const fileNames = fileIds.length ? await customFileNames("customer", customer.id, fileIds, user) : {};
    return {
      schema: form.schema,
      system: fields.system,
      custom: fields.custom,
      values: { system, custom },
      customEditable: fields.custom.filter((f) => canEditField(user, obj, f)).map((f) => f.key),
      users,
      fileNames,
      version: form.version,
    };
  } catch (error) {
    if (error instanceof MetadataError) return null;
    throw error;
  }
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("customers:view");
  const { id } = await params;
  const customer = await getCustomerDetail(id);
  if (!customer) notFound();
  // Thông tin cơ bản sửa được khi khách TẠO TAY ở tổ chức không bật Pancake (cùng cổng với action — pilot P1 #11).
  const [basics, copy] = await Promise.all([customerBasicsGate(user, customer), getBrandCopy(user)]);
  // Trạng thái thanh toán của đơn TẠO TAY theo chứng từ (order_payments) — khách chỉ có đơn đồng bộ ⇒ không chạy câu nào.
  const [profile, payStates] = await Promise.all([loadProfileBlock(user, customer, basics.allowed), manualPaymentStates(customer.orders)]);
  // Số đo "Hoàn / tỷ lệ hoàn" thuộc module Hàng hoàn — tổ chức không bật module ấy không thấy một ô 0% vô nghĩa.
  const showReturns = moduleOn(user, "returns");
  const { stats } = customer;
  const addresses = parseAddresses(customer.addresses);
  const phones = Array.from(new Set([customer.phone, ...customer.phones].filter((p): p is string => Boolean(p))));
  const successRate = pct(stats.succeed, stats.orders);
  const returnRate = pct(stats.returned, stats.orders);
  const fbUrl = customer.fbId ? `https://www.facebook.com/${customer.fbId}` : null;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Khách hàng · ${customer.level || (stats.orders >= 3 ? "Khách thân thiết" : stats.orders > 0 ? "Đã mua" : "Chưa có đơn")}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {customer.name || "Khách hàng"}
            {customer.isBlock ? <span className="rounded-md bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">Đã chặn</span> : null}
          </span>
        }
        description={`${phones[0] ? `${phones[0]} · ` : ""}${customer.province || "Chưa rõ tỉnh/TP"} · tạo ${formatDate(customer.insertedAt ?? customer.createdAt)} · đơn gần nhất ${stats.lastOrderAt ? formatTimeAgo(stats.lastOrderAt) : "chưa có"}`}
        actions={
          <>
            <ModuleSyncButton viewer={user} job="pancake-customers" label="Đồng bộ khách hàng" />
            {customer.conversationLink ? (
              <Button asChild variant="outline" size="sm">
                <a href={customer.conversationLink} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Mở hội thoại
                </a>
              </Button>
            ) : null}
          </>
        }
      />

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Số đơn" value={formatNumber(stats.orders)} note={stats.cancelled ? `${formatNumber(stats.cancelled)} đơn huỷ/xoá không tính` : "Không tính đơn huỷ/xoá"} icon={ShoppingBag} tone="blue" />
        <MetricCard label="Thành công" value={formatNumber(stats.succeed)} note={`Tỷ lệ ${successRate.toFixed(0)}% · ${formatVND(stats.successRevenue, { compact: true })}`} icon={PackageCheck} tone="green" />
        {showReturns ? <MetricCard label="Hoàn" value={formatNumber(stats.returned)} note={`Tỷ lệ hoàn ${returnRate.toFixed(0)}%`} icon={RotateCcw} tone={stats.returned > 0 ? "rose" : "slate"} /> : null}
        <MetricCard label="Tổng mua" value={formatVND(stats.amount, { compact: true })} note="Tiền hàng lên đơn, không tính đơn huỷ" icon={CircleDollarSign} tone="primary" />
        <MetricCard label="Trung bình mỗi đơn" value={formatVND(stats.aov, { compact: true })} note={stats.firstOrderAt ? `Mua lần đầu ${formatDate(stats.firstOrderAt)}` : "Chưa có đơn"} icon={Boxes} tone="amber" />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
        <div className="space-y-5">
          <SectionCard title={`Đơn hàng (${formatNumber(stats.allOrders)})`} description="Mới nhất trước · tối đa 100 đơn" actions={phones[0] ? <Link href={`/orders?q=${encodeURIComponent(phones[0])}&period=all`} className="text-xs font-semibold text-primary hover:underline">Tìm trong đơn hàng</Link> : null} padded={false}>
            {customer.orders.length ? (
              <div className="overflow-x-auto">
                <Table className="min-w-[600px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mã đơn</TableHead>
                      <TableHead>Sản phẩm</TableHead>
                      <TableHead>Trạng thái / vận đơn</TableHead>
                      <TableHead className="text-right">Tổng / COD</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customer.orders.map((o) => (
                      <TableRow key={o.id} className={cn((o.stage === "CANCELLED" || o.stage === "DELETED") && "opacity-60")}>
                        <TableCell>
                          <Link href={`/orders/${o.id}`} className="font-bold hover:text-primary hover:underline">#{o.systemId ?? o.id}</Link>
                          <div className="whitespace-nowrap text-[11px] text-muted-foreground">{formatDateTime(o.insertedAt)}</div>
                          <div className="mt-0.5"><SourceBadge source={o.source} className="px-1.5 text-[10px]" /></div>
                        </TableCell>
                        <TableCell className="max-w-[200px] text-xs text-muted-foreground">
                          <span className="block truncate" title={o.items.map((i) => `${i.productName}${i.variationDetail ? ` (${i.variationDetail})` : ""} ×${i.quantity}`).join(", ")}>
                            {o.items.map((i) => `${i.productName}${i.variationDetail ? ` (${i.variationDetail})` : ""} ×${i.quantity}`).join(", ") || "—"}
                            {o.itemsCount > o.items.length ? ` +${o.itemsCount - o.items.length}` : ""}
                          </span>
                          <span className="block text-[11px]">{formatNumber(o.totalQuantity)} sản phẩm</span>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <OrderStageBadge stage={o.stage} label={o.statusName || undefined} />
                            {o.shipment ? (
                              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                <Truck className="size-3.5" />
                                <span className="truncate">{o.shipment.carrier || "ĐVVC"}</span>
                                <ShipmentStageBadge stage={o.shipment.stage} className="px-1.5 text-[10px]" />
                              </div>
                            ) : (
                              <div className="text-[11px] text-muted-foreground">Chưa gửi ĐVVC</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Money value={o.totalPriceAfterDiscount} className="font-bold" />
                          {o.moneyToCollect > 0 ? (
                            <div className="mt-0.5 flex items-center justify-end gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                              {o.moneyToCollect !== o.totalPriceAfterDiscount ? <span>COD <Money value={o.moneyToCollect} /></span> : null}
                              {o.shipment ? <CodStatusBadge status={o.shipment.codStatus} className="px-1.5 text-[10px]" /> : <span>COD</span>}
                            </div>
                          ) : (
                            // Đơn tạo tay không có COD nào để đọc: "0 thu hộ" KHÔNG có nghĩa là đã thu (G-ORDER — tiền theo chứng từ).
                            <div className="mt-0.5 text-[11px] text-muted-foreground">{isManualOrderId(o.id) ? <ManualPaymentStatusText state={payStates.get(o.id)} className="text-[11px]" /> : "Đã thanh toán"}</div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">Khách hàng chưa có đơn nào trong ERP.</p>
            )}
          </SectionCard>

          <SectionCard title="Sản phẩm đã mua nhiều nhất" description="Theo số lượng, không tính đơn huỷ/xoá">
            {customer.topProducts.length ? (
              <ul className="divide-y">
                {customer.topProducts.map((p, i) => (
                  <li key={`${p.productId ?? p.productName}-${i}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-bold text-muted-foreground">{i + 1}</span>
                    {p.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
                    ) : (
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"><Boxes className="size-4" /></span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{p.productId ? <Link href={`/products/${p.productId}`} className="hover:text-primary hover:underline">{p.productName}</Link> : p.productName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {formatNumber(p.orders)} đơn{p.lastAt ? ` · gần nhất ${formatDate(p.lastAt)}` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="numeric text-sm font-bold">{formatNumber(p.quantity)} sp</p>
                      <p className="numeric text-xs text-muted-foreground">{formatVND(p.revenue, { compact: true })}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Chưa có dữ liệu mua hàng.</p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Hồ sơ">
            <div className="space-y-3 text-sm">
              <p className="flex items-center gap-2 font-semibold"><User className="size-4 text-muted-foreground" />{customer.name || "—"}</p>
              {phones.length ? (
                phones.map((phone) => (
                  <p key={phone} className="flex items-center gap-2"><Phone className="size-4 text-muted-foreground" /><span className="font-mono">{phone}</span> <CopyButton value={phone} /></p>
                ))
              ) : (
                <p className="flex items-center gap-2 text-muted-foreground"><Phone className="size-4" />Chưa có số điện thoại</p>
              )}
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span>{customer.address || "—"}</span></p>
            </div>
            <DescriptionList
              className="mt-4 border-t pt-4"
              columns={2}
              items={[
                { label: "Email", value: customer.emails.length ? customer.emails.join(", ") : "—" },
                { label: "Giới tính", value: customer.gender ? (GENDER_LABEL[customer.gender.toLowerCase()] ?? customer.gender) : "—" },
                { label: "Ngày sinh", value: formatDate(customer.dateOfBirth) },
                { label: "Hạng khách", value: customer.level || "—" },
                { label: "Điểm thưởng", value: formatNumber(customer.rewardPoint) },
                { label: "Tỉnh/TP", value: customer.province || "—" },
                { label: "Thẻ", value: customer.tags.length ? <span className="flex flex-wrap gap-1">{customer.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">{t}</span>)}</span> : "—", span: true },
                // Bốn dòng Pancake + Facebook/hội thoại là của tổ chức NHÀ (connector HOME_ONLY): tổ chức khác thấy mốc tạo /
                // sửa trên ERP thay vì năm ô "—" mang tên một hệ thống họ không dùng.
                ...(copy.isHome
                  ? [
                      { label: "Facebook", value: fbUrl ? <a href={fbUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">{customer.fbId}<ExternalLink className="size-3" /></a> : "—" },
                      { label: "Hội thoại", value: customer.conversationLink ? <a href={customer.conversationLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Mở trên Pancake<ExternalLink className="size-3" /></a> : "—" },
                      { label: "Mã Pancake", value: <span className="font-mono text-xs">{customer.pancakeId ?? "—"}</span> },
                      { label: "Đồng bộ", value: formatDateTime(customer.syncedAt) },
                      { label: "Tạo trên Pancake", value: formatDateTime(customer.insertedAt) },
                      { label: "Cập nhật Pancake", value: formatDateTime(customer.updatedAtExternal) },
                    ]
                  : [
                      { label: "Tạo trên ERP", value: formatDateTime(customer.createdAt) },
                      { label: "Sửa lần cuối", value: formatDateTime(customer.updatedAt) },
                    ]),
              ]}
            />
          </SectionCard>

          {profile ? (
            <SectionCard title="Hồ sơ bổ sung" description={profile.version ? `Form phiên bản ${profile.version}` : "Form mặc định"} hint={copy.text("customer.profileHint")}>
              <CustomerProfileForm recordId={customer.id} schema={profile.schema} system={profile.system} custom={profile.custom} values={profile.values} customEditable={profile.customEditable} users={profile.users} fileNames={profile.fileNames} syncedFromPancake={user.modules?.includes("connector_pancake") ?? true} basicsEditable={basics.allowed} />
            </SectionCard>
          ) : null}

          <ReverseRelationsCard objectKey="customer" recordId={customer.id} user={user} />

          <SectionCard title={`Địa chỉ (${formatNumber(addresses.length)})`} description={copy.text("customer.addressBook")} padded={false}>
            {addresses.length ? (
              <ul className="divide-y">
                {addresses.map((a, i) => (
                  <li key={i} className="px-5 py-3 text-sm">
                    <p className="font-medium">
                      {a.full_name || customer.name}
                      {a.phone_number ? <span className="ml-2 font-mono text-xs text-muted-foreground">{a.phone_number}</span> : null}
                      {i === 0 ? <span className="ml-2 rounded bg-primary/10 px-1 text-[10px] font-semibold text-primary">Mặc định</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">{addressText(a) || "—"}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted-foreground">{customer.address ? customer.address : "Chưa có địa chỉ."}</p>
            )}
          </SectionCard>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShoppingBag className="size-3.5" /> Số liệu Pancake: {formatNumber(customer.orderCount)} đơn · {formatVND(customer.purchasedAmount)} · cập nhật {formatDateTime(customer.updatedAtExternal ?? customer.syncedAt)}
          </div>
          <JsonViewer value={customer.raw ?? { id: customer.id, pancakeId: customer.pancakeId, name: customer.name, phones: customer.phones }} />
        </div>
      </div>
    </div>
  );
}
