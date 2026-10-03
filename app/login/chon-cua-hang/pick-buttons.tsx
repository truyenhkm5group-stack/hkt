"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pickSocialOrgAction } from "@/lib/actions/oauth";

export function PickOrgButtons({ orgs }: { orgs: { code: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {orgs.map((o) => (
        <Button
          key={o.code}
          type="button"
          variant="outline"
          className="w-full justify-start"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await pickSocialOrgAction(o.code);
              if (r && "error" in r) setError(r.error);
            })
          }
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {o.name}
        </Button>
      ))}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
