// The welcome step before the first start, and the one-time notice when the
// window is first closed. Native dialogs: no page, so no preload to secure.
import { Notification, dialog } from "electron";

const WHERE =
  process.platform === "darwin"
    ? "in the menu bar at the top of the screen"
    : "next to the clock";

export interface Welcome {
  mediaDir: string;
  startAtSignIn: boolean;
}

/** Ask where videos go and whether to start at sign-in. */
export async function welcome(
  mediaDir: string,
  canStartAtSignIn: boolean
): Promise<Welcome> {
  let folder = mediaDir;
  let startAtSignIn = canStartAtSignIn;
  for (;;) {
    const background = canStartAtSignIn
      ? `Horde keeps running in the background so downloads can finish. ` +
        `You'll find it ${WHERE}. Quit it there any time.`
      : `Horde keeps running in the background so downloads can finish. ` +
        `Open Horde again to get back to it, and quit it from its menu.`;
    const { response, checkboxChecked } = await dialog.showMessageBox({
      type: "none",
      title: "Welcome to Horde",
      message: "Welcome to Horde",
      detail: `Videos are saved to:\n${folder}\n\n${background}`,
      buttons: ["Continue", "Change folder…"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      ...(canStartAtSignIn
        ? {
            checkboxLabel: "Start Horde when I sign in",
            checkboxChecked: startAtSignIn,
          }
        : {}),
    });
    if (canStartAtSignIn) startAtSignIn = checkboxChecked;
    if (response === 0) return { mediaDir: folder, startAtSignIn };
    const picked = await dialog.showOpenDialog({
      title: "Where should Horde save videos?",
      defaultPath: folder,
      properties: ["openDirectory", "createDirectory"],
    });
    if (!picked.canceled && picked.filePaths[0]) folder = picked.filePaths[0];
  }
}

/** Shown once, the first time the window is closed. */
export function closeNotice(): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: "Horde is still running",
    body: `Open or quit it from the icon ${WHERE}.`,
  }).show();
}

export function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}
