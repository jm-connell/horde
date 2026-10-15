import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Suspense, useEffect, useRef } from "react";
import { applyPageId } from "./customCss";
import Library from "./pages/Library";
import {
  Download,
  History,
  Import,
  NotFound,
  OfflinePage,
  Playlists,
  Settings,
  Setup,
  Watch,
} from "./pages/lazy";
import ErrorBoundary from "./components/ErrorBoundary";
import ConnectionTag from "./components/ConnectionTag";
import TopNav from "./components/TopNav";
import BackgroundEffect from "./components/BackgroundEffect";
import LoadingIndicator from "./components/LoadingIndicator";
import OverlayScrollThumb from "./components/OverlayScrollThumb";
import { PlaybackProvider } from "./context/PlaybackContext";
import { DownloadProvider } from "./context/DownloadContext";
import { ConfirmProvider } from "./context/ConfirmContext";
import { ToastProvider } from "./context/ToastContext";
import { SearchProvider } from "./context/SearchContext";
import { useSetupGate } from "./hooks/useSettings";
import { useOfflineQuotaToast } from "./hooks/useOfflineQuotaToast";
import { useServiceWorkerUpdate } from "./hooks/useServiceWorkerUpdate";

/** Back-compat: `/playlists/:id` → `/playlists?open=:id` */
function PlaylistOpenRedirect() {
  const { id } = useParams();
  return (
    <Navigate
      to={id ? `/playlists?open=${encodeURIComponent(id)}` : "/playlists"}
      replace
    />
  );
}

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
    applyPageId(location.pathname);
  }, [location.pathname]);

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
      data-horde="main"
      className="page-shell relative z-10 mx-auto max-w-[1920px] px-3 py-6 md:px-6"
    >
      {/* A render error stays inside <main> so the nav still works, and
          resets on navigation. Lazy routes suspend here until their chunk
          arrives (a failed chunk fetch throws into the boundary). */}
      <ErrorBoundary scope="route" resetKey={location.key}>
        <Suspense fallback={<LoadingIndicator label="Loading" />}>
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/history" element={<History />} />
            <Route path="/offline" element={<OfflinePage />} />
            <Route path="/download" element={<Download />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/playlists/:id" element={<PlaylistOpenRedirect />} />
            <Route path="/import" element={<Import />} />
            <Route path="/review" element={<Navigate to="/import" replace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/setup" element={<Navigate to="/" replace />} />
            <Route path="/watch/:id" element={<Watch />} />
            <Route path="/watch" element={<Watch />} />
            <Route path="/preview" element={<PreviewRedirect />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

function AppShell() {
  useServiceWorkerUpdate();
  useOfflineQuotaToast();
  const { ready, completed } = useSetupGate();

  if (!ready) {
    return (
      <div className="relative min-h-full overflow-x-hidden">
        <BackgroundEffect />
        {/* Boot can stall on a bad connection: surface the offline offer. */}
        <ConnectionTag floating />
        <LoadingIndicator label="Loading" />
      </div>
    );
  }

  if (!completed) {
    return (
      <div className="relative min-h-full overflow-x-hidden">
        <BackgroundEffect />
        <main className="relative z-10">
          <ErrorBoundary scope="setup">
            <Suspense fallback={<LoadingIndicator label="Loading" />}>
              <Routes>
                <Route path="/setup" element={<Setup />} />
                <Route path="*" element={<Navigate to="/setup" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    );
  }

  return (
    <div className="relative min-h-full overflow-x-hidden">
      <BackgroundEffect />
      <TopNav />
      <AppRoutes />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary scope="app" fullPage>
      <ToastProvider>
        <ConfirmProvider>
          <DownloadProvider>
            <SearchProvider>
              <PlaybackProvider>
                <AppShell />
                <OverlayScrollThumb viewport />
              </PlaybackProvider>
            </SearchProvider>
          </DownloadProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
