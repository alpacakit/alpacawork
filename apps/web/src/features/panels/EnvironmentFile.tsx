import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { environmentFileSchema, type EnvironmentFile } from "@alpacawork/contract";
import { CopyButton } from "@/components/ui/copy-button";
import { Message } from "@/components/ui/message";
import { api, useWorkspaceInfo } from "@/data/queries";
import { textClip } from "@/lib/clipboard";

/**
 * What this server read of its environment file as it started: where the file is, whether it was read and which lines
 * set nothing. It changes only when the server restarts, so each opening of Settings reads it again.
 */
export function useEnvironmentFile() {
  const root = useWorkspaceInfo((info) => info.root);
  return useQuery({ queryKey: ["environment-file", root] as const, refetchOnMount: "always",
    queryFn: ({ signal }) => api.request("environment-file", environmentFileSchema, signal) });
}

/** Shown only while the file did not do all it says: why, by line number and never by the file's own text. */
export function EnvironmentFileProblems({ file }: { file: EnvironmentFile | undefined }) {
  const { t } = useTranslation("panels");
  if (!file || file.state === "absent" || file.state === "read" && !file.skipped.length) return null;
  const unread = { not_regular_file: t("environmentFile.unread.not_regular_file"), owner: t("environmentFile.unread.owner"),
    permissions: t("environmentFile.unread.permissions"), unreadable: t("environmentFile.unread.unreadable") };
  const skipped = { malformed: t("environmentFile.skipped.malformed"), reserved: t("environmentFile.skipped.reserved"),
    duplicate: t("environmentFile.skipped.duplicate") };
  const reasons = file.state === "read" ? file.skipped.map((each) => t("environmentFile.line", { line: each.line, reason: skipped[each.reason] }))
    : [unread[file.state]];
  return <Message data-environment-file-problems tone="caution" size="band" className="mb-4"
    title={t(file.state === "read" ? "environmentFile.partly" : "environmentFile.notRead")}
    description={<>
      {reasons.map((reason) => <span key={reason} className="block">{reason}</span>)}
      <span className="block">{t("environmentFile.fix", { path: file.path })}</span>
    </>} />;
}

/** Where the file is and what it did, in small muted type at the foot of Server settings: looked up, not set here. */
export function EnvironmentFileLine({ file }: { file: EnvironmentFile | undefined }) {
  const { t } = useTranslation("panels");
  if (!file) return null;
  return (
    <div data-environment-file className="mt-3 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-x-1">
        <span>{t("environmentFile.label")}</span>
        <span className="flex min-w-0 items-center gap-1">
          <span data-environment-file-path className="min-w-0 font-mono [overflow-wrap:anywhere]">{file.path}</span>
          <CopyButton clip={() => textClip(file.path)} label={t("settings.server.folderCopy")} className="size-6 min-h-6 flex-none narrow:size-11 narrow:min-h-11" />
        </span>
        <span data-environment-file-state>{file.state === "absent" ? t("environmentFile.absent")
          : file.state === "read" ? t("environmentFile.applied", { count: file.applied }) : t("environmentFile.refused")}</span>
      </div>
    </div>
  );
}
