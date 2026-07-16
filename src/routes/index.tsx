import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Leaf, ArrowRight, Sprout, Feather, Wind } from "lucide-react";
import heroBamboo from "@/assets/hero-bamboo.jpg";
import ripple from "@/assets/ripple.jpg";
import stones from "@/assets/stones.jpg";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () => ({
    meta: [
      { title: "DailyNest — A calm plan for real life" },
      { name: "description", content: "DailyNest turns the mess in your head into a realistic, kind day plan. Slow down, think clearly, move forward gently." },
      { property: "og:title", content: "DailyNest — A calm plan for real life" },
      { property: "og:description", content: "A quiet space to plan your day, so you can live with intention." },
    ],
  }),
});

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>("[data-reveal]");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function useScrollY() {
  const [y, setY] = useState(0);
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setY(window.scrollY));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return y;
}

function Landing() {
  useReveal();
  const y = useScrollY();
  const heroRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative min-h-screen text-foreground overflow-x-hidden">
      <style>{`
        [data-reveal]{opacity:0;transform:translateY(28px);transition:opacity 1.1s ease,transform 1.1s cubic-bezier(.2,.7,.2,1);}
        [data-reveal].is-visible{opacity:1;transform:none;}
        [data-reveal-delay="1"]{transition-delay:.15s}
        [data-reveal-delay="2"]{transition-delay:.3s}
        [data-reveal-delay="3"]{transition-delay:.45s}
        @keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
        .floaty{animation:floaty 6s ease-in-out infinite}
        @keyframes drift{0%{transform:translate3d(-5%,0,0)}100%{transform:translate3d(5%,0,0)}}
        .drift{animation:drift 22s ease-in-out infinite alternate}
        .grain::after{content:"";position:absolute;inset:0;pointer-events:none;opacity:.05;mix-blend-mode:overlay;background-image:radial-gradient(rgba(255,255,255,.6) 1px,transparent 1px);background-size:3px 3px}
      `}</style>

      {/* NAV */}
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/40 border-b border-white/5">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-primary/90 flex items-center justify-center">
              <Leaf className="w-5 h-5 text-primary-foreground" />
            </div>
            <span style={{ fontFamily: "var(--font-serif)" }} className="text-2xl">DailyNest</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-foreground/70">
            <a href="#philosophy" className="hover:text-foreground transition">Philosophy</a>
            <a href="#features" className="hover:text-foreground transition">Features</a>
            <a href="#preview" className="hover:text-foreground transition">A day inside</a>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/auth"
              className="hidden sm:inline-flex items-center rounded-full border border-white/20 text-white/90 hover:text-white hover:border-white/40 px-4 py-2 text-sm font-medium transition"
            >
              Sign in
            </Link>
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-5 py-2.5 text-sm font-medium hover:opacity-90 transition"
            >
              Get Started <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section ref={heroRef} className="relative min-h-[100dvh] w-full overflow-hidden">
        <div
          className="absolute inset-0 will-change-transform"
          style={{
            transform: `translate3d(0, ${y * 0.35}px, 0) scale(${1 + y * 0.0004})`,
          }}
        >
          <img src={heroBamboo} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/30 to-background" />
        </div>

        <div
          className="relative z-10 min-h-[100dvh] max-w-7xl mx-auto px-6 pt-40 pb-24 flex flex-col justify-start"
          style={{ opacity: Math.max(0, 1 - y / 500) }}
        >
          <p data-reveal className="text-xs tracking-[0.3em] uppercase text-white/70 mb-6">
            A calm plan for real life
          </p>
          <h1
            data-reveal
            data-reveal-delay="1"
            style={{ fontFamily: "var(--font-serif)" }}
            className="text-white text-6xl md:text-8xl leading-[1.05] max-w-4xl"
          >
            Plan your day,
            <br />
            live with peace.
            <br />
            <em className="text-white/80">Gently.</em>
          </h1>
          <p
            data-reveal
            data-reveal-delay="2"
            className="mt-8 max-w-md text-white/80 text-lg leading-relaxed"
          >
            DailyNest helps you create a plan that&apos;s realistic, personal, and
            pressure-free — so you can focus on what truly matters.
          </p>
          <div data-reveal data-reveal-delay="3" className="mt-10 flex items-center gap-3 text-white/70">
            <Sprout className="w-4 h-4" />
            <span className="text-sm italic" style={{ fontFamily: "var(--font-serif)" }}>
              Are you ready to feel in control again?
            </span>
          </div>
          <div data-reveal data-reveal-delay="3" className="mt-8">
            <Link
              to="/plan"
              className="group inline-flex items-center gap-3 rounded-full bg-primary text-primary-foreground px-8 py-4 text-base font-medium shadow-2xl hover:opacity-95 transition"
            >
              Get Started
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Link>
            <p className="mt-3 text-xs text-white/60">No credit card required</p>
          </div>
        </div>

        {/* scroll cue */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-10 text-white/60 text-xs flex flex-col items-center gap-2 floaty">
          <span className="tracking-[0.3em] uppercase">Scroll</span>
          <div className="w-px h-10 bg-white/40" />
        </div>
      </section>

      {/* PHILOSOPHY — parallax ripple */}
      <section id="philosophy" className="relative min-h-[90vh] overflow-hidden flex items-center">
        <div
          className="absolute inset-0"
          style={{ transform: `translate3d(0, ${(y - 600) * 0.15}px, 0)` }}
        >
          <img src={ripple} alt="" className="w-full h-full object-cover" loading="lazy" />
          <div className="absolute inset-0 bg-gradient-to-r from-background via-background/70 to-transparent" />
        </div>
        <div className="relative z-10 max-w-7xl mx-auto px-6 py-32 grid md:grid-cols-2 gap-12 items-center">
          <div>
            <p data-reveal className="text-xs tracking-[0.3em] uppercase text-foreground/60 mb-6">
              每 日 · 安 集
            </p>
            <h2
              data-reveal
              data-reveal-delay="1"
              style={{ fontFamily: "var(--font-serif)" }}
              className="text-5xl md:text-6xl leading-tight"
            >
              A quiet space to plan,
              <br />
              <em>so you can live with intention.</em>
            </h2>
            <p data-reveal data-reveal-delay="2" className="mt-8 text-lg text-foreground/70 max-w-lg leading-relaxed">
              DailyNest is more than a planner. It&apos;s a daily ritual that helps you
              slow down, think clearly, and move forward with calm.
            </p>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section id="features" className="relative py-32 bg-secondary/40">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-20">
            <p data-reveal className="text-xs tracking-[0.3em] uppercase text-foreground/60 mb-4">
              Why DailyNest
            </p>
            <h2
              data-reveal
              data-reveal-delay="1"
              style={{ fontFamily: "var(--font-serif)" }}
              className="text-5xl md:text-6xl"
            >
              Built to feel human.
            </h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: Leaf,
                title: "Realistic by design",
                text: "Plans that flex with you, not the other way around.",
              },
              {
                icon: Wind,
                title: "Simple & soothing",
                text: "A clean space to think, plan, and breathe.",
              },
              {
                icon: Feather,
                title: "Focus on what matters",
                text: "Prioritize what's important and let go of the rest.",
              },
            ].map((f, i) => (
              <div
                key={f.title}
                data-reveal
                data-reveal-delay={String(i + 1)}
                className="bg-card/80 backdrop-blur border border-border/60 rounded-3xl p-8 hover:shadow-xl transition-shadow"
              >
                <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                  <f.icon className="w-6 h-6 text-primary" />
                </div>
                <h3
                  style={{ fontFamily: "var(--font-serif)" }}
                  className="text-2xl mb-3"
                >
                  {f.title}
                </h3>
                <p className="text-foreground/70 leading-relaxed">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PREVIEW / MOCKUP */}
      <section id="preview" className="relative py-32 overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 grid md:grid-cols-2 gap-16 items-center">
          <div data-reveal className="relative">
            <div className="relative rounded-3xl overflow-hidden shadow-2xl border border-border/60 bg-card">
              <div className="p-5 border-b border-border/60 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-primary/90 flex items-center justify-center">
                    <Leaf className="w-4 h-4 text-primary-foreground" />
                  </div>
                  <span style={{ fontFamily: "var(--font-serif)" }} className="text-xl">Today</span>
                </div>
                <div className="flex gap-2 text-[10px]">
                  <span className="px-2 py-1 rounded-full bg-secondary">6 Tasks</span>
                  <span className="px-2 py-1 rounded-full bg-secondary">3 Focus</span>
                </div>
              </div>
              <div className="p-5 space-y-3">
                {[
                  { t: "6:20 – 6:50", n: "Organize computer files", tag: "Low" },
                  { t: "6:50 – 6:55", n: "Hydrate", tag: "Low" },
                  { t: "6:55 – 7:25", n: "Finish math homework", tag: "High" },
                  { t: "7:30 – 8:00", n: "Reply to important messages", tag: "High" },
                ].map((r) => (
                  <div key={r.n} className="flex items-center gap-4 p-3 rounded-xl border border-border/50 bg-background/60">
                    <span className="text-xs text-foreground/60 w-24 shrink-0">{r.t}</span>
                    <span className="text-sm flex-1">{r.n}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${r.tag === "High" ? "bg-priority-high text-priority-high-fg" : "bg-priority-low text-priority-low-fg"}`}>
                      {r.tag}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div>
            <p data-reveal className="text-xs tracking-[0.3em] uppercase text-foreground/60 mb-4">
              Plan with clarity
            </p>
            <h2
              data-reveal
              data-reveal-delay="1"
              style={{ fontFamily: "var(--font-serif)" }}
              className="text-5xl md:text-6xl leading-tight"
            >
              A day, beautifully organized.
            </h2>
            <p data-reveal data-reveal-delay="2" className="mt-6 text-lg text-foreground/70 leading-relaxed max-w-md">
              DailyNest brings structure to your day without the stress.
            </p>
            <p data-reveal data-reveal-delay="2" className="mt-3 text-foreground/60 italic" style={{ fontFamily: "var(--font-serif)" }}>
              See your plan. Stay focused. Feel at ease.
            </p>
          </div>
        </div>
      </section>

      {/* AFFIRMATION BANNER */}
      <section className="relative py-24 overflow-hidden">
        <div className="absolute inset-0">
          <img src={stones} alt="" className="w-full h-full object-cover" loading="lazy" />
          <div className="absolute inset-0 bg-primary/70" />
        </div>
        <div className="relative z-10 max-w-5xl mx-auto px-6 text-center text-primary-foreground">
          <h2
            data-reveal
            style={{ fontFamily: "var(--font-serif)" }}
            className="text-4xl md:text-5xl mb-10"
          >
            Less overwhelm. More clarity.
          </h2>
          <div className="grid md:grid-cols-3 gap-8 text-primary-foreground/90">
            {[
              "Take one calm step at a time.",
              "A gentle plan helps you stay on track.",
              "Peace of mind becomes your rhythm.",
            ].map((t, i) => (
              <p key={t} data-reveal data-reveal-delay={String(i + 1)} className="leading-relaxed">
                {t}
              </p>
            ))}
          </div>
        </div>
      </section>

      {/* FINAL CTA */}
      <section className="relative py-32">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2
            data-reveal
            style={{ fontFamily: "var(--font-serif)" }}
            className="text-5xl md:text-7xl leading-tight"
          >
            You don&apos;t need a perfect plan.
            <br />
            <em>You need a plan that supports you.</em>
          </h2>
          <p data-reveal data-reveal-delay="1" className="mt-8 text-foreground/70 text-lg">
            DailyNest is here for your real life.
          </p>
          <div data-reveal data-reveal-delay="2" className="mt-12 flex flex-col items-center gap-3">
            <Sprout className="w-5 h-5 text-primary" />
            <Link
              to="/plan"
              className="group inline-flex items-center gap-3 rounded-full bg-primary text-primary-foreground px-10 py-5 text-lg font-medium shadow-xl hover:opacity-95 transition"
            >
              Get Started
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Link>
            <p className="text-xs text-foreground/50">No credit card required</p>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8 text-center text-xs text-foreground/50">
        © {new Date().getFullYear()} DailyNest — Made gently.
      </footer>
    </div>
  );
}
