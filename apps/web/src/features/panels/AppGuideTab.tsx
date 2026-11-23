import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { FieldHint } from "@/components/ui/field";
import { ReadFailure } from "@/components/ui/loadable";
import { Pre } from "@/components/ui/pre";
import { PROSE_MEASURE } from "@/components/ui/prose";
import { QrCode } from "@/components/ui/qr-code";
import { textClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { useDesktopApp } from "@/lib/desktop-app";
import { useMobileAccess } from "@/data/mobile-access";
import { useDialogStore } from "@/state/dialog-store";
import installEnDark from "./app-guide/install-en-dark.png";
import installEnLight from "./app-guide/install-en-light.png";
import installJaDark from "./app-guide/install-ja-dark.png";
import installJaLight from "./app-guide/install-ja-light.png";

/**
 * How to use alpacawork as an app, read on a computer: installing it from the browser there, opening it from a phone
 * (the VPN, the URL only an AI or a person at the server's PC can set up, then the phone's own install), and the
 * notifications either device registers for by itself.
 *
 * It is read as a page of prose, so it is set as the reader's Markdown is (MarkdownBody's page): a part's heading a step
 * over its text, a line above a heading and a quarter line under it, half a line between blocks, and lines that stop at
 * the prose measure. Room round a control or a picture stays on the 4px spacing.
 */
export function AppGuideTab() {
  return <div data-app-guide className="min-w-0 text-base [word-break:auto-phrase]">
    <DesktopApp />
    <PhoneAccess />
    <Notifications />
  </div>;
}

/** Chrome's address bar as it looks in the reader's language; its own light and dark follow the screen's. */
const defaultInstallCapture = { light: installEnLight, dark: installEnDark };
const installCaptures = new Map([
  ["en", defaultInstallCapture],
  ["ja", { light: installJaLight, dark: installJaDark }],
]);

/**
 * While the browser offers to install the page, the page's own button asks it; otherwise the browser's own Install is
 * the way in, so the page only shows where it is. An installed window has no address bar to point at.
 */
function DesktopApp() {
  const { t, i18n } = useTranslation("panels");
  const app = useDesktopApp();
  const capture = installCaptures.get(i18n.language) ?? defaultInstallCapture;
  return <Part id="app-guide-desktop" title={t("settings.apps.desktopTitle")}>
    {app?.kind === "installed" ? <p>{t("settings.apps.desktopInstalled")}</p> : app?.kind === "prompt" ? <>
      <p>{t("settings.apps.desktopPromptBody")}</p>
      <Button variant="outline" className="mt-3" onClick={() => void app.install()}>{t("settings.apps.desktopInstall")}</Button>
    </> : <>
      <p><Trans t={t} i18nKey="settings.apps.desktopBody" components={{ ui: <UiName /> }} /></p>
      {/* Drawn at half its pixels (a capture at twice the scale), and never wider than the tab. */}
      <div role="img" aria-label={t("settings.apps.desktopImage")} className="mt-3 w-fit max-w-full overflow-hidden rounded-sm border border-line">
        <img src={capture.light} alt="" width={418} height={44} className="block h-auto max-w-full dark:hidden" />
        <img src={capture.dark} alt="" width={418} height={44} loading="lazy" className="hidden h-auto max-w-full dark:block" />
      </div>
      <FieldHint className="mt-3"><Trans t={t} i18nKey="settings.apps.desktopOther" components={{ ui: <UiName /> }} /></FieldHint>
    </>}
  </Part>;
}

/** The command a person runs when they set the URL up without an AI; its placeholder is the same in every language. */
const PUBLIC_HOST_COMMAND = "alpacawork setup --yes --public-host <host>";

/** Only the running server's published URL can become a QR code; until it has one, the second step is how to get it. */
function PhoneAccess() {
  const { t } = useTranslation("panels");
  const connection = useMobileAccess();
  const checking = connection.isPending || connection.isFetching;
  const publicUrl = !connection.isError && connection.data?.status === "serving" ? connection.data.publicUrl : null;
  const unverified = connection.isError || connection.data && connection.data.status !== "serving";
  const prompt = t("settings.apps.askPrompt");
  return <Part id="app-guide-phone" title={t("settings.apps.phoneTitle")} note={t("settings.apps.phoneLead")} wide>
    <ol className="m-0 list-none p-0">
      <Step number={1} title={t("settings.apps.vpnTitle")}>
        <p>{t("settings.apps.vpnBody")}</p>
        <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="mt-type-close inline-block">{t("settings.apps.vpnLink")}</a>
        <FieldHint className="mt-type-close">{t("settings.apps.vpnWindows")}</FieldHint>
      </Step>
      <Step number={2} title={t("settings.apps.askTitle")}>
        {publicUrl ? <p>{t("settings.apps.askReady")}</p> : <>
          {checking ? <FieldHint role="status" className="mb-type-block">{t("settings.apps.checking")}</FieldHint>
            : unverified ? <div className="mb-type-block"><ReadFailure what={t("settings.apps.readError")} retry={() => void connection.refetch()} /></div>
            : null}
          <p>{t("settings.apps.askBody")}</p>
          <Pre data-ask-prompt className="mb-2 font-sans">{prompt}</Pre>
          <CopyButton words label={t("settings.apps.copyPrompt")} clip={() => textClip(prompt)} />
          <details className="mt-type-block text-sm text-muted">
            <summary className="w-fit cursor-pointer">{t("settings.apps.manualTitle")}</summary>
            <p className="mt-type-close">{t("settings.apps.manualBody")}</p>
            <Pre>{PUBLIC_HOST_COMMAND}</Pre>
            <p>{t("settings.apps.manualHost")}</p>
            <a href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer" className="mt-type-close inline-block">{t("settings.apps.manualLink")}</a>
          </details>
        </>}
      </Step>
      <Step number={3} title={t("settings.apps.installTitle")} wide>
        {/* The code stands beside the lines it is used with; where there is no room beside them, right under the line
            that says to scan it. The words keep the first column whether or not there is a code to stand beside them. */}
        <div className="grid grid-cols-[minmax(0,auto)_auto] justify-start gap-x-6 gap-y-3 narrow:grid-cols-1">
          <div className={cn("col-start-1", PROSE_MEASURE)}>
            {publicUrl ? <div data-mobile-url>
              <p>{t("settings.apps.openQr")}</p>
              <div className="mt-type-close flex min-w-0 items-start gap-1">
                <a href={publicUrl} target="_blank" rel="noreferrer" className="min-w-0 self-center [overflow-wrap:anywhere]">{publicUrl}</a>
                <CopyButton clip={() => textClip(publicUrl)} label={t("settings.apps.copyUrl")} className="shrink-0" />
              </div>
            </div> : <p>{t("settings.apps.openLater")}</p>}
          </div>
          {publicUrl && <QrCode value={publicUrl} label={t("settings.apps.qrLabel")} className="col-start-2 row-span-2 row-start-1 size-36 narrow:col-start-1 narrow:row-span-1 narrow:row-start-auto" />}
          <div className={cn("col-start-1", PROSE_MEASURE)}>
            <Platform title={t("settings.apps.installAndroid")}>
              <p><Trans t={t} i18nKey="settings.apps.installAndroidBody" components={{ ui: <UiName /> }} /></p>
            </Platform>
            <Platform title={t("settings.apps.installIos")}>
              <p><Trans t={t} i18nKey="settings.apps.installIosBody" components={{ ui: <UiName /> }} /></p>
              <p className="mt-type-close"><Trans t={t} i18nKey="settings.apps.installIosWebApp" components={{ ui: <UiName /> }} /></p>
            </Platform>
            <p className="mt-type-block">{t("settings.apps.openInstalled")}</p>
          </div>
        </div>
      </Step>
    </ol>
    {/* The measure is counted at the tab's own step, as the steps' is, so the note's lines end where theirs do. */}
    <div className={cn("mt-type-section", PROSE_MEASURE)}><FieldHint>{t("settings.apps.keepAwake")}</FieldHint></div>
  </Part>;
}

/** Each device registers for itself, in the same place: said once for both, with the way there on the device being read. */
function Notifications() {
  const { t } = useTranslation("panels");
  return <Part id="app-guide-notify" title={t("settings.apps.notifyTitle")}>
    <p><Trans t={t} i18nKey="settings.apps.notifyBody" components={{ ui: <UiName /> }} values={{
      settings: t("settings.title"), personal: t("settings.tabs.personal"),
      notifications: t("settings.personal.notifications"), subscribe: t("push.subscribe"),
    }} /></p>
    <Button variant="outline" className="mt-3"
      onClick={() => useDialogStore.getState().open("settings", { tab: "personal", focus: "notifications" })}>
      {t("settings.apps.notifyOpen")}
    </Button>
    <FieldHint className="mt-3">{t("settings.apps.notifyIos")}</FieldHint>
    <FieldHint className="mt-type-close">{t("settings.apps.notifyAway")}</FieldHint>
  </Part>;
}

/**
 * One of the tab's parts under its heading, parted from the one before by a line. Its own words stop at the prose
 * measure; the steps under it set theirs, since a step's words start further in.
 */
function Part({ id, title, note, wide = false, children }: { id: string; title: string; note?: string; wide?: boolean; children: ReactNode }) {
  return <section aria-labelledby={id} className="mt-6 border-t border-line pt-6 first:mt-0 first:border-t-0 first:pt-0">
    <h2 id={id} className="text-md font-semibold">{title}</h2>
    {note && <p className={cn("mt-type-close", PROSE_MEASURE)}>{note}</p>}
    <div className={cn(wide ? "mt-type-section" : ["mt-type-close", PROSE_MEASURE])}>{children}</div>
  </section>;
}

/** One phone's way to install, under its name; both stay shown, since the PC reading this cannot tell which phone the reader holds. */
function Platform({ title, children }: { title: string; children: ReactNode }) {
  return <section className="mt-type-block first:mt-0">
    <h4 className="font-medium">{title}</h4>
    <div className="mt-type-close">{children}</div>
  </section>;
}

/** A button or menu the reader presses, set in the pressed words' weight instead of quotation marks. */
function UiName({ children }: { children?: ReactNode }) {
  return <b className="font-semibold">{children}</b>;
}

/** A numbered step: its number stands on its title's line, and its words stop at the prose measure. `wide` lets a step lay a picture beside them. */
function Step({ number, title, wide = false, children }: { number: number; title: string; wide?: boolean; children: ReactNode }) {
  return <li className="mt-type-section flex min-w-0 gap-3 first:mt-0">
    <span aria-hidden="true" className="flex h-[1lh] w-6 shrink-0 items-center justify-center">
      <span className="flex size-6 items-center justify-center rounded-full border border-line text-sm font-medium tabular-nums">{number}</span>
    </span>
    <div className="min-w-0 flex-1">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className={cn("mt-type-close", !wide && PROSE_MEASURE)}>{children}</div>
    </div>
  </li>;
}
