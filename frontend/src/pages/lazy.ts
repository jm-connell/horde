import { lazy } from "react";

/**
 * Route-level code splitting. Library stays in the main bundle because it is
 * the landing page; everything else loads on first visit. Wrap usages in
 * <Suspense>.
 */
export const History = lazy(() => import("./History"));
export const Download = lazy(() => import("./Download"));
export const Import = lazy(() => import("./Import"));
export const Watch = lazy(() => import("./Watch"));
export const Settings = lazy(() => import("./Settings"));
export const Account = lazy(() => import("./Account"));
export const Setup = lazy(() => import("./Setup"));
export const Playlists = lazy(() => import("./Playlists"));
export const Ask = lazy(() => import("./Ask"));
export const OfflinePage = lazy(() => import("./Offline"));
export const NotFound = lazy(() => import("./NotFound"));
