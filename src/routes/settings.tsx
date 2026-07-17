import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Leaf, ArrowLeft, Plus, Trash2, Pencil, Check, X, Loader2, Calendar, Shield, LogOut, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/settings")({
  component: SettingsRoute,
});

type PlanningMode = "school" | "weekend" | "custom";

interface Profile {
  display_name: string | null;
  default_available_until: string;
  default_planning_mode: PlanningMode;
}

interface Commitment {
  id: string;
  name: string;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  enabled: boolean;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function SettingsRoute() {
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);
  const [user, setUser] = useState<{ id: string; email: string; name: string; avatar: string | null } | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (!u) {
        navigate({ to: "/auth", replace: true });
        return;
      }
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      setUser({
        id: u.id,
        email: u.email ?? "",
        name: (meta.full_name as string) || (meta.name as string) || u.email?.split("@")[0] || "You",
        avatar: (meta.avatar_url as string) || (meta.picture as string) || null,
      });
      setChecked(true);
    });
  }, [navigate]);

  if (!checked || !user) {
    return (
      <main className="min-h-screen w-full grid place-items-center">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </main>
    );
  }

  return <SettingsPage user={user} />;
}

function SettingsPage({ user }: { user: { id: string; email: string; name: string; avatar: string | null } }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [availableUntil, setAvailableUntil] = useState("22:00");
  const [mode, setMode] = useState<PlanningMode>("custom");
  const [savingProfile, setSavingProfile] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const load = async () => {
      const [{ data: p }, { data: c }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        supabase.from("fixed_commitments").select("*").eq("user_id", user.id).order("created_at"),
      ]);
      const prof: Profile = {
        display_name: (p?.display_name as string) ?? null,
        default_available_until: (p?.default_available_until as string) ?? "22:00",
        default_planning_mode: ((p?.default_planning_mode as PlanningMode) ?? "custom"),
      };
      setProfile(prof);
      setDisplayName(prof.display_name ?? "");
      setAvailableUntil(prof.default_available_until);
      setMode(prof.default_planning_mode);
      setCommitments((c ?? []) as unknown as Commitment[]);
      setLoading(false);
    };
    load();
  }, [user.id]);

  const flash = (m: string) => {
    setStatus(m);
    window.setTimeout(() => setStatus((s) => (s === m ? null : s)), 2800);
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    const payload = {
      id: user.id,
      display_name: displayName.trim() || null,
      default_available_until: availableUntil,
      default_planning_mode: mode,
    };
    const { error } = await supabase.from("profiles").upsert(payload);
    setSavingProfile(false);
    if (error) {
      flash("Couldn't save. Please try again.");
      return;
    }
    setProfile({
      display_name: payload.display_name,
      default_available_until: payload.default_available_until,
      default_planning_mode: payload.default_planning_mode,
    });
    flash("Saved.");
  };

  const profileDirty =
    !profile ||
    (profile.display_name ?? "") !== displayName.trim() ||
    profile.default_available_until !== availableUntil ||
    profile.default_planning_mode !== mode;

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  const deleteAccount = async () => {
    // Best-effort: delete owned rows; cascades will handle profiles/commitments if account removed later.
    await supabase.from("fixed_commitments").delete().eq("user_id", user.id);
    await supabase.from("profiles").delete().eq("id", user.id);
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <main className="relative min-h-screen w-full overflow-hidden px-4 py-10 sm:py-14">
      <div aria-hidden className="pointer-events-none absolute -left-16 top-24 hidden md:block opacity-40">
        <Leaf className="h-72 w-72 text-primary/20 -rotate-12" strokeWidth={0.6} />
      </div>
      <div aria-hidden className="pointer-events-none absolute -right-20 bottom-16 hidden md:block opacity-40">
        <Leaf className="h-80 w-80 text-primary/20 rotate-45" strokeWidth={0.6} />
      </div>

      <div className="relative mx-auto max-w-2xl">
        <header className="mb-8 flex items-center justify-between">
          <Link
            to="/plan"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition"
          >
            <ArrowLeft className="h-4 w-4" /> Back to plan
          </Link>
          {status && <span className="text-xs text-muted-foreground">{status}</span>}
        </header>

        <h1 className="text-3xl font-semibold text-foreground mb-1">Profile & Settings</h1>
        <p className="text-sm text-muted-foreground mb-8">A calm space to shape how DailyNest plans your day.</p>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your settings…
          </div>
        ) : (
          <div className="space-y-6">
            {/* Account */}
            <Section title="Account">
              <div className="flex items-center gap-4 mb-5">
                {user.avatar ? (
                  <img src={user.avatar} alt="" referrerPolicy="no-referrer" className="h-14 w-14 rounded-full object-cover" />
                ) : (
                  <div className="h-14 w-14 rounded-full bg-secondary grid place-items-center text-primary font-medium">
                    {user.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{user.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                </div>
              </div>
              <Field label="Preferred display name">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder={user.name}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                />
              </Field>
            </Section>

            {/* Planning defaults */}
            <Section title="Planning defaults" subtitle="Optional — DailyNest has calm defaults.">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Default “Available until”">
                  <input
                    type="time"
                    value={availableUntil}
                    onChange={(e) => setAvailableUntil(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </Field>
                <Field label="Default planning mode">
                  <div className="flex flex-wrap gap-2">
                    {(["school", "weekend", "custom"] as PlanningMode[]).map((m) => (
                      <button
                        type="button"
                        key={m}
                        onClick={() => setMode(m)}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium border transition ${
                          mode === m
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-card text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {m === "school" ? "School Day" : m === "weekend" ? "Weekend" : "Custom"}
                      </button>
                    ))}
                  </div>
                </Field>
              </div>
            </Section>

            {profileDirty && (
              <div className="flex items-center justify-end">
                <button
                  onClick={saveProfile}
                  disabled={savingProfile}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition"
                >
                  {savingProfile && <Loader2 className="h-4 w-4 animate-spin" />}
                  Save changes
                </button>
              </div>
            )}

            {/* Commitments */}
            <CommitmentsSection
              userId={user.id}
              commitments={commitments}
              setCommitments={setCommitments}
              flash={flash}
            />

            {/* Calendar */}
            <Section title="Calendar connections">
              <div className="rounded-lg border border-dashed border-border p-4 flex items-start gap-3">
                <Calendar className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div>
                  <p className="text-sm text-foreground">Connect Google Calendar to automatically import fixed events.</p>
                  <p className="text-xs text-muted-foreground mt-1">Coming later.</p>
                </div>
              </div>
            </Section>

            {/* Privacy */}
            <Section title="Privacy">
              <div className="rounded-lg bg-secondary/40 p-4 flex items-start gap-3">
                <Shield className="h-5 w-5 text-primary mt-0.5" />
                <p className="text-sm text-foreground">
                  Your personal tasks, worries, stress, and planning details are private by default. DailyNest will not share
                  them unless you choose to.
                </p>
              </div>
            </Section>

            {/* Account actions */}
            <Section title="Account actions">
              <div className="flex flex-col gap-3">
                <button
                  onClick={signOut}
                  className="inline-flex items-center gap-2 self-start rounded-lg border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-secondary/60 transition"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>

                {!confirmDelete ? (
                  <button
                    onClick={() => setConfirmDelete(true)}
                    className="inline-flex items-center gap-2 self-start rounded-lg border border-destructive/40 bg-card px-4 py-2 text-sm text-destructive hover:bg-destructive/10 transition"
                  >
                    <Trash2 className="h-4 w-4" /> Delete account
                  </button>
                ) : (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-foreground">Delete your account?</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          This clears your profile and saved commitments and signs you out. This can't be undone.
                        </p>
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={deleteAccount}
                            className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
                          >
                            Yes, delete
                          </button>
                          <button
                            onClick={() => setConfirmDelete(false)}
                            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-secondary/60"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Section>
          </div>
        )}
      </div>
    </main>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card/80 backdrop-blur-sm p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function CommitmentsSection({
  userId,
  commitments,
  setCommitments,
  flash,
}: {
  userId: string;
  commitments: Commitment[];
  setCommitments: React.Dispatch<React.SetStateAction<Commitment[]>>;
  flash: (m: string) => void;
}) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<Omit<Commitment, "id">>({
    name: "",
    days_of_week: [],
    start_time: "09:00",
    end_time: "10:00",
    enabled: true,
  });

  const grouped = useMemo(() => {
    const map: Record<number, Commitment[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const c of commitments) {
      for (const d of c.days_of_week) if (map[d]) map[d].push(c);
    }
    return map;
  }, [commitments]);

  const beginNew = () => {
    setForm({ name: "", days_of_week: [], start_time: "09:00", end_time: "10:00", enabled: true });
    setEditing("new");
  };
  const beginEdit = (c: Commitment) => {
    setForm({ name: c.name, days_of_week: c.days_of_week, start_time: c.start_time, end_time: c.end_time, enabled: c.enabled });
    setEditing(c.id);
  };
  const cancel = () => setEditing(null);

  const save = async () => {
    if (!form.name.trim() || form.days_of_week.length === 0) {
      flash("Add a name and at least one day.");
      return;
    }
    if (form.end_time <= form.start_time) {
      flash("End time must be after start time.");
      return;
    }
    if (editing === "new") {
      const { data, error } = await supabase
        .from("fixed_commitments")
        .insert({ ...form, user_id: userId, name: form.name.trim() })
        .select()
        .single();
      if (error || !data) { flash("Couldn't save."); return; }
      setCommitments((prev) => [...prev, data as unknown as Commitment]);
    } else if (editing) {
      const { data, error } = await supabase
        .from("fixed_commitments")
        .update({ ...form, name: form.name.trim() })
        .eq("id", editing)
        .select()
        .single();
      if (error || !data) { flash("Couldn't save."); return; }
      setCommitments((prev) => prev.map((c) => (c.id === editing ? (data as unknown as Commitment) : c)));
    }
    setEditing(null);
    flash("Saved.");
  };

  const toggleEnabled = async (c: Commitment) => {
    const next = !c.enabled;
    setCommitments((prev) => prev.map((x) => (x.id === c.id ? { ...x, enabled: next } : x)));
    await supabase.from("fixed_commitments").update({ enabled: next }).eq("id", c.id);
  };

  const remove = async (id: string) => {
    setCommitments((prev) => prev.filter((c) => c.id !== id));
    await supabase.from("fixed_commitments").delete().eq("id", id);
    flash("Removed.");
  };

  const toggleDay = (d: number) => {
    setForm((f) => ({
      ...f,
      days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d].sort(),
    }));
  };

  return (
    <Section
      title="Weekly fixed commitments"
      subtitle="Class, practice, work — DailyNest will schedule around these."
    >
      {commitments.length === 0 && editing !== "new" && (
        <p className="text-sm text-muted-foreground mb-4">No commitments yet.</p>
      )}

      {commitments.length > 0 && (
        <div className="space-y-3 mb-4">
          {DAY_LABELS.map((label, d) => {
            const items = grouped[d];
            if (!items || items.length === 0) return null;
            return (
              <div key={d}>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">{DAY_LONG[d]}</p>
                <ul className="space-y-1.5">
                  {items.map((c) => (
                    <li
                      key={`${d}-${c.id}`}
                      className={`flex items-center gap-3 rounded-lg border border-border px-3 py-2 ${
                        c.enabled ? "bg-background" : "bg-secondary/30 opacity-70"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">{c.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {c.start_time} – {c.end_time}
                          {!c.enabled && " · Disabled"}
                        </p>
                      </div>
                      <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={c.enabled}
                          onChange={() => toggleEnabled(c)}
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        On
                      </label>
                      <button
                        onClick={() => beginEdit(c)}
                        className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                        aria-label="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => remove(c.id)}
                        className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {editing !== null ? (
        <div className="rounded-lg border border-border bg-background p-4 space-y-3">
          <Field label="Name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Math class"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </Field>
          <Field label="Days">
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((label, d) => (
                <button
                  type="button"
                  key={d}
                  onClick={() => toggleDay(d)}
                  className={`h-9 w-11 rounded-md text-xs font-medium border transition ${
                    form.days_of_week.includes(d)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <input
                type="time"
                value={form.start_time}
                onChange={(e) => setForm({ ...form, start_time: e.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </Field>
            <Field label="End">
              <input
                type="time"
                value={form.end_time}
                onChange={(e) => setForm({ ...form, end_time: e.target.value })}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
            </Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="h-4 w-4 accent-primary"
            />
            Enabled
          </label>
          <div className="flex gap-2 pt-1">
            <button
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Check className="h-4 w-4" /> Save
            </button>
            <button
              onClick={cancel}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-secondary/60"
            >
              <X className="h-4 w-4" /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={beginNew}
          className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 transition"
        >
          <Plus className="h-4 w-4" /> Add commitment
        </button>
      )}
    </Section>
  );
}
