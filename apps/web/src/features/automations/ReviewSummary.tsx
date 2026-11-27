import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatLogTime } from "@/domain/time";
import type { Review } from "./shape";

/**
 * What an AI's look at a version found, in one line ("2 findings: the instruction takes all of the send-back's
 * words"), and opened, each finding with where it is. The same line wherever a version is shown: before turning it on,
 * and with its files after.
 */
export function ReviewSummary({ review }: { review: Review }) {
  const { t, i18n } = useTranslation("automations");
  const [open, setOpen] = useState(false);
  if (review.state === "running") return <span>{t("review.running")}</span>;
  if (review.state === "unavailable") return <span>{t("review.unavailable")}</span>;
  if (!review.findings.length) return <span>{t("review.ok")}</span>;
  // The count says how many must be fixed among them; the line is the first finding's title (one line by the server's
  // rule), a fix first; the review's own summary, of any length, is read opened.
  const must = review.findings.filter(finding => finding.level === "must");
  const first = must[0] ?? review.findings[0]!;
  return <span data-automation-review className="block">
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="min-w-0 truncate">{t("review.head", { count: review.findings.length })}{must.length > 0 && t("review.mustPart", { count: must.length })}
        {t("colon")}{first.title ?? first.text}</span>
      <Button variant="ref" data-automation-review-open aria-expanded={open} className="flex-none narrow:min-h-11" onClick={() => setOpen(!open)}>{t(open ? "review.close" : "review.open")}</Button></span>
    {open && <span className="mt-1 block">
      {review.summary && <span className="mb-1 block text-muted">{review.summary}</span>}
      {review.findings.map((finding, at) => <span key={at} className="mb-1 block">
        {t(finding.level === "must" ? "review.must" : "review.note", { text: finding.title ?? finding.text })}
        {finding.title && finding.text !== finding.title && <span className="block text-muted">{finding.text}</span>}
        <span className="ms-1 font-mono text-xs text-muted">{finding.file}{finding.line ? `:${finding.line}` : ""}</span></span>)}
      {review.model && review.at && <span className="block text-xs text-muted">{review.model}{t("join")}{formatLogTime(review.at, i18n.language)}</span>}
    </span>}
  </span>;
}
