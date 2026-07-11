import { Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useRef } from "react";
import Library from "./pages/Library";
import History from "./pages/History";
import Download from "./pages/Download";
import Review from "./pages/Review";
import Watch from "./pages/Watch";
import Preview from "./pages/Preview";
import Settings from "./pages/Settings";
import Playlists from "./pages/Playlists";
import PlaylistDetail from "./pages/PlaylistDetail";
import TopNav from "./components/TopNav";
import BackgroundEffect from "./components/BackgroundEffect";
import { PlaybackProvider } from "./context/PlaybackContext";
import { DownloadProvider } from "./context/DownloadContext";
import { ToastProvider } from "./context/ToastContext";
import { SearchProvider } from "./context/SearchContext";

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
        <Route path="/review" element={<Review />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/watch/:id" element={<Watch />} />
        <Route path="/preview" element={<Preview />} />
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
