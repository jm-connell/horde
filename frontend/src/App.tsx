import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { applyPageId } from "./customCss";
import Library from "./pages/Library";
import {
  Account,
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
import AppFooter from "./components/AppFooter";
import BackgroundEffect from "./components/BackgroundEffect";
import LoadingIndicator from "./components/LoadingIndicator";
import OverlayScrollThumb from "./components/OverlayScrollThumb";
import { PlaybackProvider } from "./context/PlaybackContext";
import { DownloadProvider } from "./context/DownloadContext";
import OfflineUnlockSetup from "./components/OfflineUnlockSetup";
import { ConfirmProvider } from "./context/ConfirmContext";
import { ReauthProvider } from "./context/ReauthContext";
import { ToastProvider } from "./context/ToastContext";
import { SearchProvider } from "./context/SearchContext";
import { HomeResetProvider } from "./context/HomeResetContext";
import { HelpChatHost, HelpChatProvider } from "./context/HelpChatContext";
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

/** Users moved from Settings to Account settings; keep old links working. */
function SettingsRoute() {
  const [params] = useSearchParams();
  if (params.get("tab") === "users") return <Navigate to="/account" replace />;
  return <Settings />;
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
            <Route path="/settings" element={<SettingsRoute />} />
            <Route path="/account" element={<Account />} />
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
      <AppFooter />
      <HelpChatHost />
    </div>
  );
}

/**
 * Everything below the sign-in gate belongs to one account: the query cache
 * (watch history, downloads, permissions) and the providers that hold state
 * derived from it. A different user gets a new client and a remounted subtree
 * in the same commit, so nothing rendered or observed can read the previous
 * user's data; the old client is cleared when it is dropped.
 */
function UserScope({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new user must get a new client even though the factory does not read the id
  const queryClient = useMemo(() => createQueryClient(), [userId]);
  useEffect(() => () => queryClient.clear(), [queryClient]);
  // Promoted or demoted in place: what the server answers depends on the role
  // (members get trimmed settings and status), so nothing cached under the
  // old one may be shown. A layout effect, so it runs before the screens'
  // own effects read the cache in the same commit.
  const role = user
    ? `${user.is_admin}:${[...user.permissions].sort().join(",")}`
    : "";
  const lastRole = useRef(role);
  useLayoutEffect(() => {
    if (lastRole.current === role) return;
    lastRole.current = role;
    void queryClient.invalidateQueries();
  }, [role, queryClient]);
  return (
    <QueryClientProvider key={userId ?? "anon"} client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

export default function App() {
  return (
    <ErrorBoundary scope="app" fullPage>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <ReauthProvider>
              <AuthGate>
                <UserScope>
                  <DownloadProvider>
                    <SearchProvider>
                      <HomeResetProvider>
                        <PlaybackProvider>
                          <HelpChatProvider>
                            <AppShell />
                            <OfflineUnlockSetup />
                            <OverlayScrollThumb viewport />
                          </HelpChatProvider>
                        </PlaybackProvider>
                      </HomeResetProvider>
                    </SearchProvider>
                  </DownloadProvider>
                </UserScope>
              </AuthGate>
            </ReauthProvider>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
