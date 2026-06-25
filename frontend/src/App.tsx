import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api";
import Library from "./pages/Library";
import Download from "./pages/Download";
import Review from "./pages/Review";
import Watch from "./pages/Watch";

function TopNav() {
  const [reviewCount, setReviewCount] = useState(0);

  useEffect(() => {
    let active = true;
    const poll = () =>
      api
        .listReview()
        .then((items) => active && setReviewCount(items.length))
        .catch(() => undefined);
    poll();
    const id = setInterval(poll, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
      isActive
        ? "bg-accent/15 text-accent"
        : "text-gray-400 hover:text-gray-100 hover:bg-ink-800"
    }`;

  return (
    <header className="sticky top-0 z-20 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center gap-2 px-6 py-3">
        <NavLink to="/" className="mr-4 flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-accent">
            HORDE
          </span>
        </NavLink>
        <nav className="flex items-center gap-1">
          <NavLink to="/" end className={linkClass}>
            Library
          </NavLink>
          <NavLink to="/download" className={linkClass}>
            Download
          </NavLink>
          <NavLink to="/review" className={linkClass}>
            <span className="flex items-center gap-2">
              Review
              {reviewCount > 0 && (
                <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-ink-950">
                  {reviewCount}
                </span>
              )}
            </span>
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <div className="min-h-full">
      <TopNav />
      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/download" element={<Download />} />
          <Route path="/review" element={<Review />} />
          <Route path="/watch/:id" element={<Watch />} />
        </Routes>
      </main>
    </div>
  );
}
