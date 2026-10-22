import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type LoginResponse } from "../lib/api";
import { useI18n } from "../i18n";
import { Button, ErrorAlert, Field, Icon } from "../components/ui";

type Signed = Exclude<LoginResponse, { mfaRequired: true }>;

export function LoginView({ onSignedIn, notice }: { onSignedIn: (r: Signed) => void; notice?: string | undefined }) {
  const { t } = useI18n();
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => { (step === "mfa" ? codeRef : emailRef).current?.focus(); }, [step, useRecovery]);

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api<LoginResponse>("/auth/login", { method: "POST", body: { email: email.trim(), password } });
      if ("mfaRequired" in res) { setStep("mfa"); setCode(""); setPassword(""); }
      else onSignedIn(res);
    } catch (err) { setError(err); } finally { setBusy(false); }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    const value = code.trim();
    setBusy(true); setError(null);
    try {
      const res = await api<Signed>("/auth/login/mfa", { method: "POST", body: useRecovery ? { recoveryCode: value } : { code: value.replace(/\s/g, "") } });
      onSignedIn(res);
    } catch (err) {
      // The pending-2FA cookie lives 5 minutes; when it expires the only way forward is the password again.
      if (err instanceof ApiError && err.code === "MFA_CHALLENGE_INVALID") { setStep("password"); }
      setError(err);
    } finally { setBusy(false); }
  }

  return (
    <div className="grid min-h-[calc(100dvh-4rem)] lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-ink-950 p-12 text-white lg:flex lg:flex-col lg:justify-between" aria-label={t("brandTagline")}>
        <div aria-hidden="true" className="pointer-events-none absolute -left-24 -top-24 size-[28rem] rounded-full bg-brand-600/40 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 right-0 size-[24rem] rounded-full bg-sun-500/25 blur-3xl" />
        <p className="relative text-sm font-semibold uppercase tracking-[0.2em] text-brand-200">{t("brand")}</p>
        <div className="relative max-w-md">
          <p className="text-4xl font-bold leading-tight tracking-tight">{t("loginHeroTitle")}</p>
          <p className="mt-4 text-base text-ink-200">{t("loginHeroBody")}</p>
          <ul className="mt-8 space-y-3 text-sm">
            {(["loginHeroPoint1", "loginHeroPoint2", "loginHeroPoint3"] as const).map((k) => (
              <li key={k} className="flex items-center gap-3"><span className="grid size-7 place-items-center rounded-full bg-white/10 text-sun-400"><Icon name="check" className="size-4" /></span>{t(k)}</li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-ink-300">{t("brandTagline")}</p>
      </aside>

      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 grid size-12 place-items-center rounded-2xl bg-brand-700 text-white shadow-lg shadow-brand-700/30 dark:bg-brand-500 dark:text-ink-950"><Icon name={step === "mfa" ? "shield" : "lock"} className="size-6" /></div>
          {step === "password" ? (
            <form onSubmit={submitPassword} noValidate aria-labelledby="login-title" className="space-y-5">
              <div>
                <h1 id="login-title" className="text-2xl font-bold tracking-tight text-ink-950 dark:text-white">{t("loginTitle")}</h1>
                <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{t("loginSubtitle")}</p>
              </div>
              {notice && !error && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950/60 dark:text-amber-100">{notice}</p>}
              {Boolean(error) && <ErrorAlert error={error} />}
              <Field ref={emailRef} label={t("email")} type="email" name="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <Field label={t("password")} type={showPw ? "text" : "password"} name="password" autoComplete="current-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
                trailing={<button type="button" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t("hidePassword") : t("showPassword")} aria-pressed={showPw} className="grid size-10 place-items-center rounded-lg text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"><Icon name={showPw ? "eyeOff" : "eye"} /></button>} />
              <Button type="submit" size="lg" className="w-full" busy={busy} disabled={!email || password.length < 8}>{busy ? t("signingIn") : t("signIn")}</Button>
            </form>
          ) : (
            <form onSubmit={submitCode} noValidate aria-labelledby="mfa-title" className="space-y-5">
              <div>
                <h1 id="mfa-title" className="text-2xl font-bold tracking-tight text-ink-950 dark:text-white">{t("mfaTitle")}</h1>
                <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{useRecovery ? t("mfaRecoveryHint") : t("mfaSubtitle")}</p>
              </div>
              {Boolean(error) && <ErrorAlert error={error} />}
              {useRecovery ? (
                <Field ref={codeRef} key="recovery" label={t("mfaRecoveryCode")} name="recoveryCode" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} maxLength={24} value={code} onChange={(e) => setCode(e.target.value)} />
              ) : (
                <Field ref={codeRef} key="totp" label={t("mfaCode")} name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={code}
                  className="[&_input]:text-center [&_input]:text-2xl [&_input]:tracking-[0.5em] [&_input]:tabular" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              )}
              <Button type="submit" size="lg" className="w-full" busy={busy} disabled={useRecovery ? code.trim().length < 10 : code.length !== 6}>{busy ? t("verifying") : t("verify")}</Button>
              <div className="flex flex-col gap-1 text-sm sm:flex-row sm:justify-between">
                <button type="button" className="rounded-md py-1 text-left font-medium text-brand-700 underline-offset-4 hover:underline dark:text-brand-300" onClick={() => { setUseRecovery((v) => !v); setCode(""); setError(null); }}>
                  {useRecovery ? t("mfaUseTotp") : t("mfaUseRecovery")}
                </button>
                <button type="button" className="rounded-md py-1 text-left text-ink-600 underline-offset-4 hover:underline dark:text-ink-300" onClick={() => { setStep("password"); setError(null); }}>{t("backToLogin")}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
