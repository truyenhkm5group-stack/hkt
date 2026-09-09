"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link, { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ───────────── TRẠNG THÁI "ĐANG TẢI" DÙNG CHUNG CHO CẢ ỨNG DỤNG ─────────────
 *
 * Vấn đề đã đo được: mọi thay đổi kỳ báo cáo / bộ lọc đều đi vòng lên máy chủ (`shallow: false`),
 * nhưng KHÔNG chỗ nào hiện trạng thái chờ. Người dùng bấm "Tháng trước", màn hình đứng im vài giây
 * rồi mới đổi số — không phân biệt được ĐANG TẢI với BỊ TREO.
 *
 * Ở đây chỉ có MỘT nguồn sự thật cho việc đó: một bộ đếm điều hướng đang chạy. Mọi nơi gây điều
 * hướng (kỳ báo cáo, bộ lọc, tìm kiếm, phân trang, sắp xếp, menu bên) đều báo vào đây, và:
 *   · thanh tiến trình trên đỉnh trang hiện ra;
 *   · các khối số liệu mờ đi nhưng VẪN GIỮ SỐ CŨ (không nháy về 0, không màn hình trắng);
 *   · nhãn "Đang cập nhật báo cáo…" hiện cạnh tiêu đề.
 *
 * NGƯỠNG 180 ms: phản hồi nhanh hơn thế thì KHÔNG hiện gì cả. Một thanh loading nháy 80 ms làm
 * giao diện trông giật, tệ hơn là không có.
 */

const SHOW_AFTER_MS = 180;

type Store = { pending: number; listeners: Set<() => void> };
const StoreContext = React.createContext<Store | null>(null);

/**
 * Không có provider (trang ngoài nhóm bảng điều khiển, ví dụ trang in) thì các hook dưới đây im
 * lặng thay vì ném lỗi: thiếu thanh tiến trình là mất một tiện ích, còn ném lỗi là hỏng cả trang.
 */
function useStore() {
  return React.useContext(StoreContext);
}

function notify(store: Store) {
  for (const listen of store.listeners) listen();
}

/** Số điều hướng đang chạy (0 = rảnh). Đăng ký lại khi đổi để component vẽ lại. */
export function useNavPending() {
  const store = useStore();
  return React.useSyncExternalStore(
    React.useCallback(
      (onChange: () => void) => {
        if (!store) return () => {};
        store.listeners.add(onChange);
        return () => store.listeners.delete(onChange);
      },
      [store],
    ),
    () => (store ? store.pending > 0 : false),
    () => false,
  );
}

/**
 * Dùng thay cho `React.useTransition` ở mọi chỗ gây điều hướng: vừa có `pending` tại chỗ (để nút
 * vừa bấm tự hiện trạng thái chờ) vừa báo lên thanh tiến trình chung.
 */
export function useNavTransition(): [boolean, React.TransitionStartFunction] {
  const store = useStore();
  const [pending, startTransition] = React.useTransition();
  const counted = React.useRef(false);
  React.useEffect(() => {
    if (!store || pending === counted.current) return;
    counted.current = pending;
    store.pending = Math.max(0, store.pending + (pending ? 1 : -1));
    notify(store);
    return () => {
      // Component bị gỡ giữa lúc đang chờ → trả lại bộ đếm, nếu không thanh tiến trình kẹt mãi.
      if (counted.current) {
        counted.current = false;
        store.pending = Math.max(0, store.pending - 1);
        notify(store);
      }
    };
  }, [pending, store]);
  return [pending, startTransition];
}

export function NavProgressProvider({ children }: { children: React.ReactNode }) {
  const store = React.useMemo<Store>(() => ({ pending: 0, listeners: new Set() }), []);
  return (
    <StoreContext.Provider value={store}>
      {children}
      <NavProgressBar />
    </StoreContext.Provider>
  );
}

/**
 * Thanh tiến trình mảnh trên đỉnh trang. Không đo được tiến độ thật của một lần dựng lại trang trên
 * máy chủ, nên nó bò dần tới 90% rồi đợi — đúng nghĩa "đang chạy, chưa xong", không hứa hẹn sai.
 */
function NavProgressBar() {
  const pending = useNavPending();
  const [visible, setVisible] = React.useState(false);
  const [width, setWidth] = React.useState(0);

  React.useEffect(() => {
    if (!pending) {
      if (!visible) return;
      setWidth(100);
      const t = setTimeout(() => {
        setVisible(false);
        setWidth(0);
      }, 260);
      return () => clearTimeout(t);
    }
    const show = setTimeout(() => {
      setVisible(true);
      setWidth(12);
    }, SHOW_AFTER_MS);
    const creep = setInterval(() => setWidth((w) => (w >= 90 ? 90 : w + Math.max(0.6, (90 - w) / 12))), 220);
    return () => {
      clearTimeout(show);
      clearInterval(creep);
    };
    // `visible` cố ý không nằm trong danh sách phụ thuộc: nó chỉ dùng để biết có cần chạy hoạt ảnh kết thúc không.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5" aria-hidden>
      <div
        className="h-full bg-brand-bright shadow-[0_0_8px_var(--brand-bright)] transition-[width] duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/**
 * Nhãn "đang cập nhật" đặt cạnh tiêu đề trang hoặc tiêu đề khối. Chỉ hiện sau ngưỡng, và chỉ khi
 * thật sự có điều hướng đang chạy.
 */
export function RefreshingBadge({ label = "Đang cập nhật báo cáo…", className }: { label?: string; className?: string }) {
  const pending = useNavPending();
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    if (!pending) {
      setShow(false);
      return;
    }
    const t = setTimeout(() => setShow(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [pending]);
  if (!show) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary", className)}
    >
      <Loader2 className="size-3 animate-spin" />
      {label}
    </span>
  );
}

/**
 * Bọc vùng SỐ LIỆU của trang. Trong lúc chờ dữ liệu mới, nội dung cũ VẪN HIỆN nhưng mờ đi và không
 * bấm được — người dùng vẫn đọc được số của kỳ trước thay vì nhìn màn hình trắng, và biết chắc là
 * số đang hiển thị chưa phải số mới.
 */
export function StaleWhileRefreshing({
  children,
  className,
  asChild = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** Gắn lớp mờ vào chính phần tử con thay vì bọc thêm một `<div>` (giữ nguyên bố cục flex/grid). */
  asChild?: boolean;
}) {
  const pending = useNavPending();
  const [dim, setDim] = React.useState(false);
  React.useEffect(() => {
    if (!pending) {
      setDim(false);
      return;
    }
    const t = setTimeout(() => setDim(true), SHOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [pending]);
  const classes = cn("transition-opacity duration-200", dim && "pointer-events-none opacity-55", className);
  if (asChild && React.isValidElement<{ className?: string }>(children)) {
    return React.cloneElement(children, {
      className: cn(children.props.className, classes),
      ...({ "aria-busy": dim || undefined } as Record<string, unknown>),
    });
  }
  return (
    <div className={classes} aria-busy={dim || undefined}>
      {children}
    </div>
  );
}

/**
 * Chấm chờ trong một mục menu đang được mở. Dùng `useLinkStatus` của Next: chỉ sáng đúng mục vừa
 * bấm, nên người dùng thấy ngay là đã bấm trúng và hệ thống đang chạy.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-sidebar-foreground/60" aria-label="Đang mở" />;
}

/**
 * Báo cho thanh tiến trình biết một điều hướng bằng `<Link>` đang chạy. Đặt bên trong `<Link>`;
 * không vẽ gì cả, chỉ nối `useLinkStatus` vào bộ đếm chung.
 */
export function LinkProgressReporter() {
  const { pending } = useLinkStatus();
  const store = useStore();
  React.useEffect(() => {
    if (!pending || !store) return;
    store.pending += 1;
    notify(store);
    return () => {
      store.pending = Math.max(0, store.pending - 1);
      notify(store);
    };
  }, [pending, store]);
  return null;
}

/**
 * Liên kết dạng TAB (tab báo cáo, tab cấp xem…). Giống `<Link>` nhưng tự báo trạng thái chờ lên
 * thanh tiến trình chung và hiện chấm xoay ngay trên chính tab vừa bấm — không có nó thì bấm tab
 * xong màn hình đứng im, đúng thứ người dùng phàn nàn.
 */
export function NavLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <Link href={href} className={className}>
      {children}
      <TabPending />
      <LinkProgressReporter />
    </Link>
  );
}

function TabPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2 className="size-3.5 shrink-0 animate-spin" aria-label="Đang mở" />;
}

/**
 * Khi URL đã đổi xong thì mọi điều hướng coi như kết thúc. Cần chốt chặn này vì `useLinkStatus`
 * của một `<Link>` bị gỡ khỏi cây (menu vẽ lại sau khi đổi trang) có thể không kịp trả bộ đếm.
 */
export function NavProgressReset() {
  const store = useStore();
  const pathname = usePathname();
  const search = useSearchParams();
  React.useEffect(() => {
    if (!store || store.pending === 0) return;
    store.pending = 0;
    notify(store);
  }, [pathname, search, store]);
  return null;
}
