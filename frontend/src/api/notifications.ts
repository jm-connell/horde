import type {
  NotificationsConfig,
  NotificationTarget,
  NotificationTargetCreate,
  NotificationTargetDraft,
  NotificationTargetUpdate,
  NotificationTestResult,
} from "../types";
import { jsonInit, type ReadOptions, request } from "./client";

export const notificationsApi = {
  getNotifications(opts?: ReadOptions): Promise<NotificationsConfig> {
    return request<NotificationsConfig>("/api/notifications", opts);
  },

  createNotificationTarget(
    body: NotificationTargetCreate
  ): Promise<NotificationTarget> {
    return request<NotificationTarget>(
      "/api/notifications/targets",
      jsonInit("POST", body)
    );
  },

  updateNotificationTarget(
    id: string,
    body: NotificationTargetUpdate
  ): Promise<NotificationTarget> {
    return request<NotificationTarget>(
      `/api/notifications/targets/${encodeURIComponent(id)}`,
      jsonInit("PATCH", body)
    );
  },

  deleteNotificationTarget(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(
      `/api/notifications/targets/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  },

  /** Send a sample notification to a saved target. */
  testNotificationTarget(id: string): Promise<NotificationTestResult> {
    return request<NotificationTestResult>(
      `/api/notifications/targets/${encodeURIComponent(id)}/test`,
      { method: "POST" }
    );
  },

  /** Try a target before saving it (`id` borrows a saved target's token). */
  testNotificationDraft(
    body: NotificationTargetDraft
  ): Promise<NotificationTestResult> {
    return request<NotificationTestResult>(
      "/api/notifications/test",
      jsonInit("POST", body)
    );
  },
};
