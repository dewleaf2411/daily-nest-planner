import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "@tanstack/react-router";
import { LogOut, Settings } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface Profile {
  name: string;
  email: string;
  avatarUrl: string | null;
}

export function ProfileMenu() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.auth.getUser();
      const u = data.user;
      if (!u) {
        setProfile(null);
        return;
      }
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      const fallbackName =
        (meta.full_name as string) || (meta.name as string) || u.email?.split("@")[0] || "You";
      const { data: prof } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", u.id)
        .maybeSingle();
      const preferred = (prof?.display_name as string | null | undefined)?.trim();
      setProfile({
        name: preferred && preferred.length > 0 ? preferred : fallbackName,
        email: u.email ?? "",
        avatarUrl: (meta.avatar_url as string) || (meta.picture as string) || null,
      });
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  if (!profile) return null;

  const initials = profile.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-border bg-card/80 backdrop-blur-sm pl-1 pr-3 py-1 hover:bg-secondary/60 transition"
      >
        {profile.avatarUrl ? (
          <img
            src={profile.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="h-8 w-8 rounded-full object-cover"
          />
        ) : (
          <span className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-primary text-xs font-medium">
            {initials || "U"}
          </span>
        )}
        <span className="hidden sm:inline text-sm text-foreground max-w-[140px] truncate">
          {profile.name}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-64 rounded-xl border border-border bg-card shadow-lg overflow-hidden z-50">
          <div className="p-4 flex items-center gap-3 border-b border-border">
            {profile.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <span className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-primary text-sm font-medium">
                {initials || "U"}
              </span>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{profile.name}</p>
              {profile.email && (
                <p className="text-xs text-muted-foreground truncate">{profile.email}</p>
              )}
            </div>
          </div>
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-foreground hover:bg-secondary/60 transition"
          >
            <Settings className="h-4 w-4" />
            Profile & Settings
          </Link>
          <button
            type="button"
            onClick={signOut}
            className="w-full flex items-center gap-2 px-4 py-3 text-sm text-foreground hover:bg-secondary/60 transition border-t border-border"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
