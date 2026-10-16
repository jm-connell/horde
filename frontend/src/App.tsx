import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Suspense, useEffect, useRef, useState } from "react";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
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
import RequirePermission from "./components/auth/RequirePermission";
import { AuthGate, AuthProvider, useAuth } from "./context/AuthContext";
import { createQueryClient } from "./queries/client";

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
            <Route
              path="/download"
              element={
                <RequirePermission permission="download">
                  <Download />
                </RequirePermission>
              }
            />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/playlists/:id" element={<PlaylistOpenRedirect />} />
            <Route
              path="/import"
              element={
                <RequirePermission permission="download">
                  <Import />
                </RequirePermission>
              }
            />
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
  const { isAdmin } = useAuth();

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

  if (!completed && !isAdmin) {
    return (
      <div className="relative min-h-full overflow-x-hidden">
        <BackgroundEffect />
        <main className="relative z-10 mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="mb-2 text-xl font-semibold text-gray-100">
            Setup isn’t finished
          </h1>
          <p className="text-sm text-gray-400">
            An administrator needs to finish setting up Horde before it can be
            used. Please ask them, then reload this page.
          </p>
        </main>
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

/**
 * Cached answers belong to the signed-in account (watch history, permissions),
 * so a different user, or none, starts from an empty cache.
 */
function ClearCacheOnUserChange() {
  const queryClient = useQueryClient();
  const userId = useAuth().user?.id ?? null;
  const previous = useRef(userId);
  useEffect(() => {
    if (previous.current === userId) return;
    previous.current = userId;
    queryClient.clear();
  }, [userId, queryClient]);
  return null;
}

export default function App() {
  const [queryClient] = useState(createQueryClient);
  return (
    <ErrorBoundary scope="app" fullPage>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <ClearCacheOnUserChange />
              <AuthGate>
                <DownloadProvider>
                  <SearchProvider>
                    <PlaybackProvider>
                      <AppShell />
                      <OverlayScrollThumb viewport />
                    </PlaybackProvider>
                  </SearchProvider>
                </DownloadProvider>
              </AuthGate>
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
