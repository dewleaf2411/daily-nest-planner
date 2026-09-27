import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Leaf, ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";

export const Route = createFileRoute("/auth")({
  component: AuthPage,
  head: () => ({
    meta: [
      { title: "Sign in — DaySized" },
      { name: "description", content: "Sign in to DaySized to plan your day, gently." },
    ],
  }),
});

function AuthPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If already signed in, go straight to /plan.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/plan", replace: true });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) navigate({ to: "/plan", replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [navigate]);

  const onGoogle = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin + "/plan",
      });
      if (result.error) {
        setError(result.error.message || "Sign in failed. Please try again.");
        setLoading(false);
        return;
      }
      if (result.redirected) return; // browser redirect in progress
      navigate({ to: "/plan", replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
      setLoading(false);
    }
  };

  return (
    <main className="relative min-h-screen w-full overflow-hidden flex items-center justify-center px-4 py-16">
      <div aria-hidden className="pointer-events-none absolute -left-16 top-24 hidden md:block opacity-40">
        <Leaf className="h-72 w-72 text-primary/20 -rotate-12" strokeWidth={0.6} />
      </div>
      <div aria-hidden className="pointer-events-none absolute -right-16 bottom-10 hidden md:block opacity-30">
        <Leaf className="h-64 w-64 text-primary/20 rotate-45" strokeWidth={0.6} />
      </div>

      <div className="relative w-full max-w-md">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition mb-8"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>

        <div className="rounded-2xl border border-border bg-card/90 backdrop-blur-sm shadow-[0_1px_2px_rgba(0,0,0,0.03),0_20px_50px_-24px_rgba(30,60,45,0.18)] p-8 sm:p-10">
          <div className="flex flex-col items-center text-center">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary text-primary">
              <Leaf className="h-6 w-6" strokeWidth={1.5} />
            </div>
            <h1
              style={{ fontFamily: "var(--font-serif)" }}
              className="mt-5 text-4xl leading-tight text-foreground"
            >
              Welcome to DaySized
            </h1>
            <p className="mt-3 text-sm text-muted-foreground max-w-xs">
              Sign in to plan your day, gently.
            </p>
          </div>

          <button
            type="button"
            onClick={onGoogle}
            disabled={loading}
            className="mt-8 w-full inline-flex items-center justify-center gap-3 rounded-full border border-border bg-background px-5 py-3.5 text-sm font-medium text-foreground hover:bg-secondary/60 transition disabled:opacity-60"
          >
            <GoogleIcon />
            {loading ? "Signing in…" : "Continue with Google"}
          </button>

          {error && (
            <p className="mt-4 text-sm text-priority-high-fg text-center">{error}</p>
          )}

          <p className="mt-8 text-xs text-muted-foreground text-center leading-relaxed">
            By continuing you agree to a calm, honest planning experience.
          </p>
        </div>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.5 29.3 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.3-.3-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.5 29.3 4.5 24 4.5 16.1 4.5 9.3 8.9 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 43.5c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.2-7.2 2.2-5.2 0-9.6-3.3-11.2-8l-6.5 5C9.2 39 16 43.5 24 43.5z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2c-.4.4 6.6-4.8 6.6-14.8 0-1.2-.1-2.3-.4-3.5z"/>
    </svg>
  );
}
