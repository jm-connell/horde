export {
  ApiError,
  AUTH_REQUIRED_EVENT,
  CSRF_HEADER,
  PAGE_SIZE,
  PERMISSION_DENIED_EVENT,
  REAUTH_REQUIRED_EVENT,
  isOfflineError,
  offlineError,
  withCsrf,
} from "./api/client";
export type {
  ApiErrorField,
  ChatStreamOptions,
  Page,
  ReadOptions,
  ReauthRequestDetail,
} from "./api/client";
export { parseTrashEntryIds, trashEntryIdsOfError } from "./api/trash";
export type { DeleteResult } from "./api/trash";
export { OFFLINE_PROGRESS_EVENT } from "./api/videos";
export type { LibraryQuery } from "./api/videos";
export type {
  ChannelFeedQuery,
  ChannelQuery,
  ChannelTab,
} from "./api/channels";
export * from "./api/urls";

import { aiApi } from "./api/ai";
import { authApi } from "./api/auth";
import { channelsApi } from "./api/channels";
import { compatApi } from "./api/compat";
import { discoverApi } from "./api/discover";
import { downloadsApi } from "./api/downloads";
import { notificationsApi } from "./api/notifications";
import { playlistsApi } from "./api/playlists";
import { reviewApi } from "./api/review";
import { settingsApi } from "./api/settings";
import { systemApi } from "./api/system";
import { trashApi } from "./api/trash";
import { videosApi } from "./api/videos";

/** Every request the app makes, one method each, grouped by area in `./api/`. */
export const api = {
  ...authApi,
  ...videosApi,
  ...trashApi,
  ...channelsApi,
  ...settingsApi,
  ...aiApi,
  ...discoverApi,
  ...compatApi,
  ...systemApi,
  ...notificationsApi,
  ...reviewApi,
  ...downloadsApi,
  ...playlistsApi,
};
