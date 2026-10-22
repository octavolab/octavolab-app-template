import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Enrollment, type Me } from "../lib/api";
import { useI18n } from "../i18n";
import { Button, Card, ErrorAlert, Field, Icon, Notice, PageHeader } from "../components/ui";
import { Qr } from "../components/Qr";

/** Formats the base32 secret in groups of 4 for manual entry. */
const grouped = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

export function SecurityView({ me, onChanged, onAuthError }: { me: Me; onChanged: () => void; onAuthError: (e: unknown) => boolean }) {
  const { t } = useI18n();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [issuer, setIssuer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function start() {
    setBusy(true); setError(null);
    try { const e = await api<Enrollment>("/auth/2fa/enroll", { method: "POST" }); setEnrollment(e); setIssuer(e.issuer); }
    catch (e) { if (!onAuthError(e)) setError(e); } finally { setBusy(false); }
  }

  if (codes) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={t("securityTitle")} />
        <RecoveryCodes codes={codes} issuer={issuer} onDone={() => { setCodes(null); setEnrollment(null); onChanged(); }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("securityTitle")} subtitle={t("securitySubtitle")} />
      {me.mfaEnrollmentRequired && <Notice tone="warning" className="mb-4">{t("securityRequired")}</Notice>}
      {Boolean(error) && <ErrorAlert className="mb-4" error={error} />}

      {me.mfaEnabled ? (
        <div className="space-y-4">
          <Notice tone="success"><span className="flex items-center gap-2 font-medium"><Icon name="shield" />{t("mfaStatusOn")}</span></Notice>
          <Regenerate onCodes={(c) => { setIssuer(t("brand")); setCodes(c); }} onAuthError={onAuthError} />
        </div>
      ) : enrollment ? (
        <Enroll enrollment={enrollment} onActivated={(c) => setCodes(c)} onAuthError={onAuthError} />
      ) : (
        <Card className="flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-3 text-sm text-ink-800 dark:text-ink-100">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100"><Icon name="shield" /></span>
            {t("mfaStatusOff")}
          </p>
          <Button busy={busy} onClick={() => void start()}>{busy ? t("mfaStarting") : t("mfaStart")}</Button>
        </Card>
      )}
    </div>
  );
}

function Enroll({ enrollment, onActivated, onAuthError }: { enrollment: Enrollment; onActivated: (codes: string[]) => void; onAuthError: (e: unknown) => boolean }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  async function activate(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api<{ mfaEnabled: true; recoveryCodes: string[] }>("/auth/2fa/activate", { method: "POST", body: { code } });
      onActivated(res.recoveryCodes);
    } catch (err) { if (!onAuthError(err)) setError(err); setCode(""); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card className="p-6">
        <h2 ref={ref} tabIndex={-1} className="flex items-center gap-2 text-base font-semibold text-ink-950 dark:text-white"><StepDot n={1} />{t("mfaStep1")}</h2>
        <p className="mt-2 text-sm text-ink-700 dark:text-ink-200">{t("mfaStep1Body")}</p>
        <div className="mt-5 flex justify-center rounded-2xl bg-ink-50 p-4 dark:bg-ink-800">
          <Qr value={enrollment.otpauthUri} label={t("mfaQrAlt", { issuer: enrollment.issuer })} />
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer rounded-md font-medium text-brand-700 dark:text-brand-300">{t("mfaManual")}</summary>
          <div className="mt-3 flex items-center gap-2">
            <span className="sr-only">{t("mfaSecretLabel")}</span>
            <code className="flex-1 break-all rounded-lg bg-ink-100 px-3 py-2 font-mono text-sm text-ink-900 dark:bg-ink-800 dark:text-ink-50">{grouped(enrollment.secret)}</code>
            <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(enrollment.secret).then(() => setCopied(true)); }}>
              <Icon name={copied ? "check" : "copy"} className="size-4" />{copied ? t("copied") : t("copy")}
            </Button>
          </div>
        </details>
      </Card>
      <Card className="p-6">
        <h2 className="flex items-center gap-2 text-base font-semibold text-ink-950 dark:text-white"><StepDot n={2} />{t("mfaStep2")}</h2>
        <p className="mt-2 text-sm text-ink-700 dark:text-ink-200">{t("mfaStep2Body")}</p>
        <form onSubmit={activate} noValidate className="mt-5 space-y-4">
          {Boolean(error) && <ErrorAlert error={error} />}
          <Field label={t("mfaCode")} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            className="[&_input]:text-center [&_input]:text-2xl [&_input]:tracking-[0.5em]" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          <Button type="submit" size="lg" className="w-full" busy={busy} disabled={code.length !== 6}>{busy ? t("mfaActivating") : t("mfaActivate")}</Button>
        </form>
      </Card>
    </div>
  );
}

function Regenerate({ onCodes, onAuthError }: { onCodes: (c: string[]) => void; onAuthError: (e: unknown) => boolean }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onCodes((await api<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { method: "POST", body: { code } })).recoveryCodes); }
    catch (err) { if (!onAuthError(err)) setError(err); setCode(""); } finally { setBusy(false); }
  }
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-ink-950 dark:text-white">{t("recoveryRegenerate")}</h2>
      <p className="mt-1 text-sm text-ink-700 dark:text-ink-200">{t("recoveryRegenerateBody")}</p>
      <form onSubmit={submit} noValidate className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field className="flex-1" label={t("mfaCode")} name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        <Button type="submit" busy={busy} disabled={code.length !== 6}>{t("recoveryGenerate")}</Button>
      </form>
      {Boolean(error) && <ErrorAlert className="mt-4" error={error} />}
    </Card>
  );
}

function RecoveryCodes({ codes, issuer, onDone }: { codes: string[]; issuer: string; onDone: () => void }) {
  const { t, locale } = useI18n();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const text = () => `${t("recoveryFileHeader", { issuer, date: new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date()) })}\n\n${codes.join("\n")}\n`;

  function download() {
    const url = URL.createObjectURL(new Blob([text()], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${issuer.replace(/[^\w-]+/g, "-").toLowerCase() || "app"}-recovery-codes.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <Card className="p-6">
      <h2 ref={ref} tabIndex={-1} className="text-lg font-bold text-ink-950 dark:text-white">{t("recoveryTitle")}</h2>
      <p className="mt-1 text-sm text-ink-700 dark:text-ink-200">{t("recoveryBody")}</p>
      <ol className="mt-5 grid grid-cols-1 gap-2 rounded-2xl bg-ink-50 p-4 font-mono text-sm sm:grid-cols-2 dark:bg-ink-800" aria-label={t("recoveryTitle")} data-testid="recovery-codes">
        {codes.map((c) => <li key={c} className="rounded-lg bg-white px-3 py-2 text-center tracking-wider text-ink-950 ring-1 ring-ink-200 dark:bg-ink-900 dark:text-white dark:ring-ink-700">{c}</li>)}
      </ol>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(codes.join("\n")).then(() => setCopied(true)); }}>
          <Icon name={copied ? "check" : "copy"} className="size-4" />{copied ? t("copied") : t("recoveryCopy")}
        </Button>
        <Button variant="secondary" onClick={download}><Icon name="download" className="size-4" />{t("recoveryDownload")}</Button>
      </div>
      <label className="mt-6 flex items-start gap-3 text-sm text-ink-800 dark:text-ink-100">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-0.5 size-5 accent-brand-700" />
        {t("recoveryConfirm")}
      </label>
      <Button size="lg" className="mt-4 w-full sm:w-auto" disabled={!saved} onClick={onDone}>{t("recoveryDone")}</Button>
    </Card>
  );
}

function StepDot({ n }: { n: number }) {
  return <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-brand-700 text-xs font-bold text-white dark:bg-brand-500 dark:text-ink-950">{n}</span>;
}
