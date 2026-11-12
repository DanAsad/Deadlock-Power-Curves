import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router-dom";
import { useApi, type Meta } from "./api";
import { MetaContext, useSliceSearch } from "./filters";
import { AllCurves } from "./pages/AllCurves";
import { HeroDetail } from "./pages/HeroDetail";
import { HeroGrid } from "./pages/HeroGrid";
import { ScalingIndex } from "./pages/ScalingIndex";
import { ModelCheck } from "./pages/ModelCheck";
import { WinFactors } from "./pages/WinFactors";
import { WinProbability } from "./pages/WinProbability";
import "./styles.css";

// Sections. Phase 2 is already a route; it only needs its page and API router.
const SECTIONS = [
  { to: "/", label: "Heroes", end: true },
  { to: "/power-curves", label: "All power curves" },
  { to: "/scaling", label: "Scaling index" },
  { to: "/what-wins", label: "What wins games" },
  { to: "/model-check", label: "Model check" },
  { to: "/win-probability", label: "Win probability" },
];

function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(() => {
    try { return localStorage.getItem("theme"); } catch { return null; }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try { theme ? localStorage.setItem("theme", theme) : localStorage.removeItem("theme"); } catch { /* private mode */ }
  }, [theme]);
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <button className="theme-btn" onClick={() => setTheme(dark ? "light" : "dark")} aria-label="Toggle colour theme">
      {dark ? "☀ Light" : "☾ Dark"}
    </button>
  );
}

function Shell() {
  const meta = useApi<Meta>("meta");
  const search = useSliceSearch();
  return (
    <MetaContext.Provider value={meta.data}>
      <header className="header">
        <NavLink to={`/${search}`} className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={22} height={22} /> <span>Deadlock Power Curves</span>
        </NavLink>
        <nav className="nav">
          {SECTIONS.map((s) => (
            <NavLink key={s.to} to={`${s.to}${search}`} end={s.end}>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <ThemeToggle />
      </header>
      <main>
        {meta.error && (
          <p className="note">
            <span aria-hidden>⚠</span>
            <span>Can't reach the API ({meta.error}). Start it with <code>uvicorn api.main:app --reload</code>.</span>
          </p>
        )}
        <Routes>
          <Route path="/" element={<HeroGrid />} />
          <Route path="/heroes/:heroId" element={<HeroDetail />} />
          <Route path="/power-curves" element={<AllCurves />} />
          <Route path="/scaling" element={<ScalingIndex />} />
          <Route path="/what-wins" element={<WinFactors />} />
          <Route path="/model-check" element={<ModelCheck />} />
          <Route path="/win-probability" element={<WinProbability />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
        <footer className="muted small" style={{ marginTop: 48 }}>
          Data: <a href="https://deadlock-api.com">Deadlock API</a> public data lake
          {meta.data && <> · built {new Date(meta.data.generated_at).toLocaleString()} · last {meta.data.days} days</>}
          {" "}· Not affiliated with Valve.
        </footer>
      </main>
    </MetaContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}><Shell /></BrowserRouter>
  </StrictMode>,
);
