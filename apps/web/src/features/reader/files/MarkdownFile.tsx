import { useMemo } from "react";
import { Message } from "@/components/ui/message";
import { useTranslation } from "react-i18next";
import { Caret, DisclosureSummary } from "@/components/ui/caret";
import { Pre } from "@/components/ui/pre";
import { frontMatter } from "@/domain/front-matter";
import { MarkdownBody, type MarkdownTask } from "../MarkdownBody";

/** A file's metadata and body share the original file identity for relative links and images. */
export function MarkdownFile({ text, task, sourceFile, onFollow }: {
  text: string; task: MarkdownTask; sourceFile: string; onFollow: (id: string) => void;
}) {
  const { t } = useTranslation("reader");
  const result = useMemo(() => frontMatter(text), [text]);
  const issueText = {
    unclosed: t("frontMatter.unclosed"), invalid: t("frontMatter.invalid"),
    unsupported: t("frontMatter.unsupported"), limit: t("frontMatter.limit"),
  };
  return <div data-markdown-file>
    {result.kind === "parsed" && <div data-front-matter className="mb-type-block">
      {result.rows.length > 0 && <table aria-label={t("frontMatter.label")} className="w-full table-fixed border-collapse text-sm">
        <colgroup><col className="w-[28%]" /><col /></colgroup>
        <tbody>{result.rows.map((row, index) => <tr key={index}>
          <th scope="row" className="border border-line px-2 py-1 text-left align-top font-normal text-muted whitespace-pre-wrap [overflow-wrap:anywhere]">{row.key}</th>
          <td className="border border-line px-2 py-1 text-left align-top whitespace-pre-wrap [overflow-wrap:anywhere]">{row.value}</td>
        </tr>)}</tbody>
      </table>}
      <details key={text} className="group mt-type-close text-sm text-muted">
        <DisclosureSummary className="gap-1"><Caret className="group-open:rotate-90" />{t("frontMatter.source")}</DisclosureSummary>
        <Pre className="mt-type-close text-ink">{result.raw}</Pre>
      </details>
    </div>}
    {result.kind === "fallback" && <div data-front-matter-fallback className="mb-type-block">
      <Message size="line" tone="caution" className="mb-type-close" title={issueText[result.issue]} />
      <Pre>{result.raw}</Pre>
    </div>}
    <MarkdownBody text={result.body} task={task} sourceFile={sourceFile} onFollow={onFollow} />
  </div>;
}
