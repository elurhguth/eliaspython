"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { api } from "@/lib/api";
import { Button, Field, Input, Logo, Spinner } from "@/components/ui";

export default function LoginPage() {
  const [status, setStatus] = useState<{ setupRequired: boolean; user: unknown; passkeysAvailable: boolean } | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<typeof status>("/api/auth/status").then((s) => {
      if (s?.user) location.href = "/";
      else setStatus(s);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (status?.setupRequired && password !== password2) return setError("Lösenorden matchar inte");
    setBusy(true);
    try {
      await api.post(status?.setupRequired ? "/api/auth/setup" : "/api/auth/login", { username, password });
      location.href = "/";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function passkey() {
    setError("");
    setBusy(true);
    try {
      const options = await api.post<any>("/api/auth/passkey/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await api.post("/api/auth/passkey/login/verify", { response });
      location.href = "/";
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={56} />
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">{status.setupRequired ? "Välkommen till Crew" : "Logga in"}</h1>
          <p className="mt-1.5 text-sm text-muted">
            {status.setupRequired ? "Skapa ditt konto. Det här blir den enda inloggningen till din instans." : "Ditt team väntar."}
          </p>
        </div>
        <form onSubmit={submit} className="space-y-3 rounded-3xl border border-line bg-panel p-5">
          <Field label="Användarnamn">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <Field label="Lösenord" hint={status.setupRequired ? "Minst 10 tecken." : undefined}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={status.setupRequired ? "new-password" : "current-password"}
              required
            />
          </Field>
          {status.setupRequired && (
            <Field label="Upprepa lösenord">
              <Input type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required />
            </Field>
          )}
          {error && <div className="text-sm text-danger">{error}</div>}
          <Button variant="primary" className="w-full" disabled={busy}>
            {status.setupRequired ? "Skapa konto" : "Logga in"}
          </Button>
          {!status.setupRequired && status.passkeysAvailable && (
            <Button type="button" variant="subtle" className="w-full" onClick={passkey} disabled={busy}>
              <KeyRound size={15} /> Logga in med passkey
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}
