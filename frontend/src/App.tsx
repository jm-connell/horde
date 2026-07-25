import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { useEffect, useRef } from "react";
import Library from "./pages/Library";
import History from "./pages/History";
import Download from "./pages/Download";
import Import from "./pages/Import";
import Watch from "./pages/Watch";
import Settings from "./pages/Settings";
import Playlists from "./pages/Playlists";
import PlaylistDetail from "./pages/PlaylistDetail";
import TopNav from "./components/TopNav";
import BackgroundEffect from "./components/BackgroundEffect";
import { PlaybackProvider } from "./context/PlaybackContext";
import { DownloadProvider } from "./context/DownloadContext";
import { ToastProvider } from "./context/ToastContext";
import { SearchProvider } from "./context/SearchContext";

/** Back-compat: /preview?url=&channel= → /watch?url=&channel= */
function PreviewRedirect() {
  const [params] = useSearchParams();
  const qs = new URLSearchParams();
  const url = params.get("url");
  const channel = params.get("channel");
  if (url) qs.set("url", url);
  if (channel) qs.set("channel", channel);
  const search = qs.toString();
  return <Navigate to={search ? `/watch?${search}` : "/"} replace />;
}

function AppRoutes() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    el.classList.remove("page-shell--animate");
    // Force reflow so the fade can restart on navigation.
    void el.offsetWidth;
    el.classList.add("page-shell--animate");
  }, [location.pathname]);

  return (
    <main
      ref={mainRef}
      className="page-shell relative z-10 mx-auto max-w-[1600px] px-3 py-6 md:px-6"
    >
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/history" element={<History />} />
        <Route path="/download" element={<Download />} />
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/playlists/:id" element={<PlaylistDetail />} />
        <Route path="/import" element={<Import />} />
        <Route path="/review" element={<Navigate to="/import" replace />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/watch/:id" element={<Watch />} />
        <Route path="/watch" element={<Watch />} />
        <Route path="/preview" element={<PreviewRedirect />} />
      </Routes>
    </main>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <DownloadProvider>
        <SearchProvider>
          <PlaybackProvider>
            <div className="relative min-h-full overflow-x-hidden">
              <BackgroundEffect />
              <TopNav />
              <AppRoutes />
            </div>
          </PlaybackProvider>
        </SearchProvider>
      </DownloadProvider>
    </ToastProvider>
  );
}
