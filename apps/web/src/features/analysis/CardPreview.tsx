import type { ReactNode } from "react";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { CARD_H, CARD_W } from "./card-size";

/** Reserve the same space for the image throughout the load. Keep loading status outside the image's role. */
export function CardPreview({ picture, children }: { picture?: { svg: string; label: string }; children?: ReactNode }) {
  return <div style={{ aspectRatio: `${CARD_W} / ${CARD_H}` }}
    className={cn("overflow-hidden rounded-md border-hairline border-lit-line [&>svg]:block [&>svg]:h-auto [&>svg]:w-full",
      !picture && "flex items-center justify-center p-4")}
    {...picture ? { role: "img", "aria-label": picture.label, dangerouslySetInnerHTML: { __html: picture.svg } } : { children }} />;
}

export function CardSkeleton({ waitFrom }: { waitFrom: number }) {
  return <RegionSkeleton shape="analysisCard" className="size-full" waitFrom={waitFrom} />;
}
