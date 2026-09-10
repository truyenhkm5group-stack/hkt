"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { addIdeaImages, deleteIdea, deleteIdeaImage } from "@/lib/actions/ideas";
import { IDEA_MAX_IMAGES } from "@/lib/constants/ideas";
import { thuNhoAnh } from "@/lib/ideas/shrink-image";

/**
 * ═══════ SỬA SAI SÓT SAU KHI ĐĂNG ═══════
 *
 * Ba năng lực này đã có sẵn ở tầng hành động từ lâu — `addIdeaImages`, `deleteIdeaImage`,
 * `deleteIdea` — kèm đủ kiểm tra quyền. Nhưng KHÔNG có nút nào gọi tới chúng, nên trên thực tế
 * marketer đăng nhầm một ảnh là chịu, và quản lý bảo "thêm ảnh góc khác" thì không thêm được.
 *
 * Đó chính là thứ khiến màn hình này chưa dùng được thật: tạo thì được, sửa thì không.
 *
 * QUYỀN: tầng hành động đã tự kiểm (người đăng sửa được của mình, người duyệt sửa được của mọi
 * người). Ở đây chỉ ẩn/hiện nút cho gọn mắt — KHÔNG dựa vào việc ẩn nút để bảo vệ, vì ẩn nút không
 * phải là kiểm soát truy cập.
 */

export function ThemAnh({ ideaId, dangCo }: { ideaId: string; dangCo: number }) {
  const [dangTai, setDangTai] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const router = useRouter();
  const conLai = IDEA_MAX_IMAGES - dangCo;

  async function chon(files: FileList | null) {
    if (!files?.length) return;
    if (files.length > conLai) {
      toast.error(`Ý tưởng đang có ${dangCo} ảnh, chỉ thêm được ${conLai} ảnh nữa (tối đa ${IDEA_MAX_IMAGES})`);
      return;
    }
    setDangTai(true);
    try {
      // Thu nhỏ TRƯỚC khi gửi — cùng một hàm với form đăng mới, không có bản sao thứ hai.
      const anh = await Promise.all([...files].map(thuNhoAnh));
      const r = await addIdeaImages({ ideaId, images: anh.map((a) => ({ base64: a.base64, contentType: a.contentType })) });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã thêm ${r.added} ảnh`);
        router.refresh();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không xử lý được ảnh");
    } finally {
      setDangTai(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => chon(e.target.files)} />
      <Button type="button" variant="outline" size="sm" disabled={dangTai || conLai <= 0} onClick={() => input.current?.click()}>
        {dangTai ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
        {conLai <= 0 ? `Đủ ${IDEA_MAX_IMAGES} ảnh` : "Thêm ảnh"}
      </Button>
    </>
  );
}

/** Nút xoá một ảnh, đặt đè lên góc ảnh. Bấm nhầm thì thêm lại được, nên không hỏi lại. */
export function XoaAnh({ imageId }: { imageId: string }) {
  const [dangXoa, setDangXoa] = React.useState(false);
  const router = useRouter();
  return (
    <button
      type="button"
      title="Xoá ảnh này"
      disabled={dangXoa}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDangXoa(true);
        const r = await deleteIdeaImage({ imageId });
        setDangXoa(false);
        if ("error" in r) toast.error(r.error);
        else {
          toast.success("Đã xoá ảnh");
          router.refresh();
        }
      }}
      className="absolute right-1 top-1 rounded-md bg-background/90 p-1 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"
    >
      {dangXoa ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
    </button>
  );
}

/**
 * Xoá cả ý tưởng — HỎI LẠI, vì trao đổi và ảnh xoá theo và không lấy lại được.
 *
 * Xác nhận bằng cách bấm lần thứ hai thay vì hộp thoại: nó ở ngay trong luồng mắt, không che nội
 * dung, và tự huỷ sau vài giây nếu người dùng bỏ đi.
 */
export function XoaYTuong({ ideaId, soAnh, soTraoDoi }: { ideaId: string; soAnh: number; soTraoDoi: number }) {
  const [xacNhan, setXacNhan] = React.useState(false);
  const [dangXoa, setDangXoa] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    if (!xacNhan) return;
    const t = setTimeout(() => setXacNhan(false), 5000);
    return () => clearTimeout(t);
  }, [xacNhan]);

  if (!xacNhan) {
    return (
      <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-rose-600" onClick={() => setXacNhan(true)}>
        <Trash2 className="size-4" /> Xoá
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-2 py-1 dark:border-rose-900 dark:bg-rose-950/30">
      <span className="text-[11.5px] text-rose-800 dark:text-rose-200">
        Xoá luôn {soAnh} ảnh và {soTraoDoi} nhận xét?
      </span>
      <Button
        type="button"
        size="sm"
        variant="destructive"
        className="h-7"
        disabled={dangXoa}
        onClick={async () => {
          setDangXoa(true);
          const r = await deleteIdea({ id: ideaId });
          if ("error" in r) {
            setDangXoa(false);
            toast.error(r.error);
            return;
          }
          toast.success("Đã xoá ý tưởng");
          router.push("/ideas");
        }}
      >
        {dangXoa ? <Loader2 className="size-4 animate-spin" /> : "Xoá hẳn"}
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setXacNhan(false)}>
        Thôi
      </Button>
    </div>
  );
}
