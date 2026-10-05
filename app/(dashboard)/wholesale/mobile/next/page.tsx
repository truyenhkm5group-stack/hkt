import { redirect } from "next/navigation";
import { requireResource } from "@/lib/auth/scope-guard";
import { isMobileChip, nextLeadId, type MobileNextProps } from "@/lib/queries/wholesale-mobile";

export const metadata = { title: "Khách tiếp theo" };

/** «BẮT ĐẦU GỌI» / «Khách tiếp theo»: máy chọn khách nên gọi trước nhất trong chip đang mở rồi mở thẳng màn khách. */
export default async function WholesaleMobileNext({ searchParams }: MobileNextProps) {
  const { decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") redirect("/wholesale/mobile");
  const sp = await searchParams;
  const f = Array.isArray(sp.f) ? sp.f[0] : sp.f;
  const after = Array.isArray(sp.after) ? sp.after[0] : sp.after;
  const chip = isMobileChip(f) ? f : "call";
  const id = await nextLeadId(decision, chip, typeof after === "string" && after ? after : null);
  redirect(id ? `/wholesale/mobile/lead/${id}?f=${chip}` : `/wholesale/mobile/queue?f=${chip}&het=1`);
}
