import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/components/ui/copy-button";
import { Pre } from "@/components/ui/pre";
import { textClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * A code block's copy mark stands in the frame's top end corner, centred on the first line, and the code's first two
 * lines flow around it (a float), so it covers no letter and the lines under them keep the whole width. On a phone its
 * press reaches 44px past its 28px mark, into the frame's padding and the gap it keeps from those two lines.
 */
export const CODE_COPY = "relative float-end -me-1 -mt-1 ms-2 size-7 min-h-7 narrow:size-7 narrow:min-h-7 narrow:after:absolute narrow:after:-inset-2 narrow:after:content-['']";

/**
 * A code block's frame: the place's look (Markdown's page or note) as `className`; `ref` is the frame's, and so are the
 * `data-` marks its caller sets on it. What stands in it is its caller's: the code as written (CodeBlock), or a diff's
 * files and rows (DiffBlock).
 */
export function CodeFrame({ className, ref, children, ...marks }: { className?: string; ref?: Ref<HTMLDivElement>; children: ReactNode; [mark: `data-${string}`]: string | undefined }) {
  return <Pre asChild data-code-block="" className={cn("my-0 flow-root", className)}><div ref={ref} {...marks}>{children}</div></Pre>;
}

/** The copy mark of a code block: the text as written, whatever the frame draws of it. */
export function CodeCopy({ text, className }: { text: string; className?: string }) {
  const { t } = useTranslation("reader");
  return <CopyButton clip={() => textClip(text)} label={t("markdownBody.copyCode")} className={className} />;
}

/** Code in its frame with its copy mark: the text as written, the code's look as `codeClassName`. */
export function CodeBlock({ text, className, codeClassName }: { text: string; className?: string; codeClassName?: string }) {
  return <CodeFrame className={className}>
    <CodeCopy text={text} className={CODE_COPY} />
    <Pre className={cn("m-0 border-0 bg-transparent p-0", codeClassName)}>{text}</Pre>
  </CodeFrame>;
}
