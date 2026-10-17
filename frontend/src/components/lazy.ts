import { lazy } from "react";

/** Heavy, rarely used components: loaded the first time they are shown. */
export const ImageCropModal = lazy(() => import("./ImageCropModal"));
export const VideoAiPanel = lazy(() => import("./VideoAiPanel"));
