import { lazy } from "react";

/** Settings tabs that are large and visited rarely; wrap usages in <Suspense>. */
export const AiTab = lazy(() => import("./ai/AiTab"));
export const SystemTab = lazy(() => import("./SystemTab"));
