import type {
  AuthState,
  AuthUser,
  SecurityChecklist,
  TwoFactorSetup,
  TwoFactorStatus,
  PermissionInfo,
  UserAccount,
  DeviceSession,
  UserCreateInput,
  UserUpdateInput,
} from "../types";
import { jsonInit, type ReadOptions, request } from "./client";

export const authApi = {
  getAuthState(): Promise<AuthState> {
    return request<AuthState>("/api/auth/state");
  },

  login(username: string, password: string): Promise<{ user: AuthUser }> {
    return request("/api/auth/login", jsonInit("POST", { username, password }));
  },

  /** Second step of a two-step sign-in: the ticket from `totp_required` and a code. */
  loginTotp(pendingToken: string, code: string): Promise<{ user: AuthUser }> {
    return request(
      "/api/auth/login/totp",
      jsonInit("POST", { pending_token: pendingToken, code })
    );
  },

  /** Ask for a one-time reset code; the server writes it to its log. */
  forgotPassword(username: string): Promise<void> {
    return request<void>("/api/auth/forgot", jsonInit("POST", { username }));
  },

  /** Set a new password with a code from the server log; signs in. */
  resetPassword(
    username: string,
    code: string,
    newPassword: string
  ): Promise<{ user: AuthUser }> {
    return request(
      "/api/auth/reset",
      jsonInit("POST", { username, code, new_password: newPassword })
    );
  },

  bootstrapAdmin(
    username: string,
    password: string,
    shareDownloads = true
  ): Promise<{ user: AuthUser }> {
    return request(
      "/api/auth/bootstrap",
      jsonInit("POST", {
        username,
        password,
        share_downloads: shareDownloads,
      })
    );
  },

  /**
   * Whether other accounts on a device may see your downloads. Stopping needs
   * your password: devices use it to unlock your downloads with no connection.
   */
  setShareDownloads(
    shareDownloads: boolean,
    currentPassword?: string
  ): Promise<AuthUser> {
    return request<AuthUser>(
      "/api/auth/me",
      jsonInit("PATCH", {
        share_downloads: shareDownloads,
        current_password: currentPassword,
      })
    );
  },

  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" });
  },

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return request<void>(
      "/api/auth/password",
      jsonInit("POST", {
        current_password: currentPassword,
        new_password: newPassword,
      })
    );
  },

  /**
   * Prove your password (and a code, with two-step sign-in) again so the server
   * lets this browser do the sensitive administrator actions for a few minutes.
   */
  reauthenticate(password: string, code = ""): Promise<void> {
    return request<void>(
      "/api/auth/reauth",
      jsonInit("POST", { password, code })
    );
  },

  /** Confirm your own password with the server (rejects with `wrong_password`). */
  verifyPassword(password: string): Promise<void> {
    return request<void>(
      "/api/auth/verify-password",
      jsonInit("POST", { password })
    );
  },

  getTwoFactor(): Promise<TwoFactorStatus> {
    return request<TwoFactorStatus>("/api/auth/2fa");
  },

  /** Start setting up two-step sign-in: a new secret and its QR code. */
  startTwoFactor(currentPassword: string): Promise<TwoFactorSetup> {
    return request<TwoFactorSetup>(
      "/api/auth/2fa/setup",
      jsonInit("POST", { current_password: currentPassword })
    );
  },

  /** Turn it on with a current code; returns the recovery codes (once). */
  async confirmTwoFactor(code: string): Promise<string[]> {
    const res = await request<{ recovery_codes: string[] }>(
      "/api/auth/2fa/confirm",
      jsonInit("POST", { code })
    );
    return res.recovery_codes;
  },

  disableTwoFactor(currentPassword: string, code: string): Promise<void> {
    return request<void>(
      "/api/auth/2fa/disable",
      jsonInit("POST", { current_password: currentPassword, code })
    );
  },

  async newRecoveryCodes(
    currentPassword: string,
    code: string
  ): Promise<string[]> {
    const res = await request<{ recovery_codes: string[] }>(
      "/api/auth/2fa/recovery-codes",
      jsonInit("POST", { current_password: currentPassword, code })
    );
    return res.recovery_codes;
  },

  /** Administrators: take two-step sign-in off another account (signs them out). */
  resetUserTwoFactor(userId: number): Promise<void> {
    return request<void>(`/api/users/${userId}/two-factor`, {
      method: "DELETE",
    });
  },

  getSecurityChecklist(opts?: ReadOptions): Promise<SecurityChecklist> {
    return request<SecurityChecklist>("/api/system/security-checklist", opts);
  },

  /** Your signed-in browsers, most recently active first. */
  async listSessions(): Promise<DeviceSession[]> {
    const res = await request<{ items: DeviceSession[] }>("/api/auth/sessions");
    return res.items;
  },

  revokeSession(id: number): Promise<void> {
    return request<void>(`/api/auth/sessions/${id}`, { method: "DELETE" });
  },

  /** Sign out everywhere except this browser. */
  revokeOtherSessions(): Promise<void> {
    return request<void>("/api/auth/sessions/revoke-others", {
      method: "POST",
    });
  },

  /** Set your own profile picture; returns your account with the new version. */
  uploadAvatar(file: File): Promise<AuthUser> {
    const form = new FormData();
    form.append("file", file);
    return request<AuthUser>("/api/auth/avatar", {
      method: "POST",
      body: form,
    });
  },

  removeAvatar(): Promise<AuthUser> {
    return request<AuthUser>("/api/auth/avatar", { method: "DELETE" });
  },

  listUsers(): Promise<UserAccount[]> {
    return request<UserAccount[]>("/api/users");
  },

  listPermissions(): Promise<PermissionInfo[]> {
    return request<PermissionInfo[]>("/api/users/permissions");
  },

  createUser(input: UserCreateInput): Promise<UserAccount> {
    return request<UserAccount>("/api/users", jsonInit("POST", input));
  },

  updateUser(id: number, input: UserUpdateInput): Promise<UserAccount> {
    return request<UserAccount>(`/api/users/${id}`, jsonInit("PATCH", input));
  },

  async listUserSessions(userId: number): Promise<DeviceSession[]> {
    const res = await request<{ items: DeviceSession[] }>(
      `/api/users/${userId}/sessions`
    );
    return res.items;
  },

  revokeUserSession(userId: number, id: number): Promise<void> {
    return request<void>(`/api/users/${userId}/sessions/${id}`, {
      method: "DELETE",
    });
  },

  /** Sign a user out of every browser. */
  revokeAllUserSessions(userId: number): Promise<void> {
    return request<void>(`/api/users/${userId}/sessions`, {
      method: "DELETE",
    });
  },

  deleteUser(id: number): Promise<void> {
    return request<void>(`/api/users/${id}`, { method: "DELETE" });
  },
};
