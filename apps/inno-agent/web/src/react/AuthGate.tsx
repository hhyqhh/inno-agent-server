import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	getAuthSession,
	signIn,
	signUp,
	UNAUTHORIZED_EVENT,
	type AuthSessionResponse,
} from "../api/auth.js";
import { terminalStore } from "../stores/terminal-store.js";
import { sessionsStore } from "../stores/sessions-store.js";

export function AuthGate({ children }: { children: ReactNode }) {
	const { t } = useTranslation();
	const [session, setSession] = useState<AuthSessionResponse | null>(null);
	const [loadError, setLoadError] = useState("");
	const [registering, setRegistering] = useState(false);
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		let active = true;
		getAuthSession()
			.then((value) => { if (active) setSession(value); })
			.catch((err) => { if (active) setLoadError(err instanceof Error ? err.message : String(err)); });
		const expired = () => setSession((current) => current ? { ...current, user: null } : current);
		window.addEventListener(UNAUTHORIZED_EVENT, expired);
		return () => {
			active = false;
			window.removeEventListener(UNAUTHORIZED_EVENT, expired);
		};
	}, []);

	if (loadError) {
		return (
			<main className="flex h-full items-center justify-center bg-[var(--inno-chat-bg)] p-6 text-[var(--inno-text)]">
				<div className="text-center">
					<p role="alert" className="text-sm text-[var(--inno-danger)]">{loadError}</p>
					<button type="button" className="inno-primary-button mt-4 rounded-md px-4 py-2 text-sm text-white" onClick={() => window.location.reload()}>
						{t("auth.retry")}
					</button>
				</div>
			</main>
		);
	}
	if (!session) return <main className="h-full bg-[var(--inno-chat-bg)]" aria-label={t("auth.loading")} />;
	if (session.mode === "local" || session.user) {
		terminalStore.setHostTerminalDisabled(session.mode === "better-auth");
		sessionsStore.durableEnabled = session.durableEnabled === true;
		return children;
	}

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setSubmitting(true);
		setError("");
		try {
			if (registering) await signUp(name, email, password);
			else await signIn(email, password);
			setSession(await getAuthSession());
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<main className="flex h-full items-center justify-center bg-[var(--inno-chat-bg)] p-6 text-[var(--inno-text)]">
			<section className="w-full max-w-sm rounded-2xl border border-[var(--inno-border)] bg-[var(--inno-surface)] p-7 shadow-lg">
				<div className="mb-6 text-center">
					<div className="text-xl font-semibold">Inno Agent</div>
					<h1 className="mt-2 text-sm text-[var(--inno-text-muted)]">
						{registering ? t("auth.createAccount") : t("auth.welcomeBack")}
					</h1>
				</div>
				<form className="space-y-4" onSubmit={(event) => void submit(event)}>
					{registering ? (
						<label className="block text-xs font-medium">
							{t("auth.name")}
							<input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-chat-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--inno-accent)]" />
						</label>
					) : null}
					<label className="block text-xs font-medium">
						{t("auth.email")}
						<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-chat-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--inno-accent)]" />
					</label>
					<label className="block text-xs font-medium">
						{t("auth.password")}
						<input required minLength={8} type="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 w-full rounded-lg border border-[var(--inno-border)] bg-[var(--inno-chat-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--inno-accent)]" />
					</label>
					{error ? <p role="alert" className="text-xs text-[var(--inno-danger)]">{error}</p> : null}
					<button disabled={submitting} type="submit" className="inno-primary-button w-full rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
						{submitting ? t("auth.submitting") : registering ? t("auth.signUp") : t("auth.signIn")}
					</button>
				</form>
				{session.allowSignUp ? (
					<button type="button" className="mt-5 w-full text-center text-xs text-[var(--inno-accent)]" onClick={() => { setRegistering((value) => !value); setError(""); }}>
						{registering ? t("auth.haveAccount") : t("auth.needAccount")}
					</button>
				) : null}
			</section>
		</main>
	);
}
