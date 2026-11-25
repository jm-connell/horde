# Install the desktop app

The desktop app is the simple way to run Horde on your own computer. You download one file, open it, and Horde appears in your Start menu, Launchpad or app grid like any other program. No terminal, no Docker.

It is the same Horde as the [Docker install](install-docker.md): the same server, the same web pages, the same accounts. Closing its window leaves it running in the background so downloads can finish. Docker is still the better choice for a home server or a NAS that is always on.

## Download

| Your computer | Download | Notes |
|---------------|----------|-------|
| Windows 10 or 11, 64-bit | [Horde-windows-x64-setup.exe](https://github.com/jm-connell/horde/releases/latest/download/Horde-windows-x64-setup.exe) | |
| Mac with Apple silicon (M1 or newer) | [Horde-mac-arm64.dmg](https://github.com/jm-connell/horde/releases/latest/download/Horde-mac-arm64.dmg) | A preview: it does not update itself yet. |
| Linux, 64-bit | [Horde-linux-x64.AppImage](https://github.com/jm-connell/horde/releases/latest/download/Horde-linux-x64.AppImage) | Docker is still the recommended Linux install. |

The file is about 300 MB. There is no build for Intel Macs or for Windows on ARM yet.

Horde's apps are **not signed**: signing costs money every year, and the project does not pay it yet. Your computer will therefore warn you the first time you open Horde. The warning is about the missing signature, not about something found in the file. The steps below get past it. If you would like to check that the file is the one the project built, see [Check the download](#check-the-download).

## Open it for the first time

=== "Windows"

    1. Double-click `Horde-windows-x64-setup.exe`.
    2. Windows shows **Windows protected your PC**. Click **More info**, then **Run anyway**.
    3. The installer runs without asking for an administrator password and installs Horde for your account only. Horde opens when it is done.

    If **Run anyway** does not appear, Windows' Smart App Control is on and blocks apps that are not signed. Horde cannot get past that; use the [Docker install](other-platforms.md#windows) instead, or turn Smart App Control off in Windows Security.

=== "macOS"

    1. Open `Horde-mac-arm64.dmg` and drag **Horde** onto **Applications**.
    2. Open **Horde** from Applications. The Mac says it cannot verify the app. Click **Done**.
    3. Open **System Settings → Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to the message about Horde. Enter your password or use Touch ID.
    4. Click **Open** when the Mac asks once more.

    Right-click **Open** no longer works for this on recent versions of macOS; the **Open Anyway** button is the way. You only do this once.

    The Mac app is a **preview**. It has no signature Apple knows, so it cannot update itself, and starting it at sign-in may not take effect.

=== "Linux"

    1. Make the file executable. In your file manager, open the file's **Properties → Permissions** and allow executing it as a program. Or in a terminal: `chmod +x Horde-linux-x64.AppImage`.
    2. Double-click it.

    The first time it runs, Horde adds itself to your app grid with its icon, so you can find it by searching "Horde" and pin it. If you move the file later, Horde fixes the entry the next time you start it.

    The AppImage needs nothing installed (no FUSE).

## First run

1. A **Welcome to Horde** window shows where videos will be saved, with **Change folder…** to pick another one, and a tick box **Start Horde when I sign in**. It is ticked to begin with. Horde keeps running in the background so downloads can finish, and you can quit it from its icon at any time. Click **Continue**.
2. Horde's window opens on the usual first page, where you create the **administrator account**. After that, follow [First run](first-run.md): the setup wizard and your first download.

The first time you close the window, Horde says it is still running and where to find it. Closing the window never stops Horde.

## The tray icon

Horde lives in the tray: the notification area next to the clock on Windows and Linux, the menu bar on a Mac. Click the icon (right-click on Windows and Linux) for the menu:

| Menu item | What it does |
|-----------|--------------|
| **Open Horde** | Opens the window. |
| **Open in browser** | Opens Horde in your normal browser. Use this to cast to a TV: casting does not work inside the app window. |
| *Idle*, or what it is doing | A line that reads for example "Downloading 2 videos". Not clickable. |
| **Start Horde when I sign in** | Starts Horde in the background after you sign in to your computer, waiting 30 seconds first so it does not slow the sign-in. It opens no window. It also shows up in Windows' Startup apps and the Mac's Login Items, and a choice made there is respected. |
| **Share on my home network** | Lets phones, TVs and other computers on your network open Horde. See [Share on your home network](#share-on-your-home-network). |
| **Open media folder** | Shows the folder your videos are saved in. |
| **Open logs** | Opens the log file, `horde.log`. You need it to [reset a forgotten password](#forgotten-password). |
| **Check for updates** | Checks now. It reads **Restart to update to 1.5.0** when an update is waiting, and **A new version is available** on a Mac. |
| **About Horde** | The version, the licence and where your files are. |
| **Quit Horde** | Stops Horde completely. If it is downloading, it asks first. |

If your Linux desktop shows no tray icon (GNOME has none by default), start Horde again from the app grid: it opens the window of the copy that is already running. The window's own menu has **Quit Horde**.

Starting Horde a second time never runs a second copy.

## Where things are kept

| | Windows | macOS | Linux |
|---|---|---|---|
| Program | `%LOCALAPPDATA%\Programs\Horde` | `/Applications/Horde.app` | the AppImage file |
| Data (database, settings, thumbnails, backups) | `%LOCALAPPDATA%\Horde\data` | `~/Library/Application Support/Horde/data` | `~/.local/share/horde/data` |
| Logs | `%LOCALAPPDATA%\Horde\logs` | `~/Library/Logs/Horde` | `~/.local/state/horde/logs` |
| Videos (to begin with) | `Videos\Horde` | `~/Movies/Horde` | `Videos/Horde` in your home folder |

On Linux the data and log folders follow `XDG_DATA_HOME` and `XDG_STATE_HOME` when you set them, and the videos go in your desktop's Videos folder. The data folder holds the database, so keep it on a local disk, not in a cloud-synced folder. The layout inside is the same as in Docker: see [Storage layout](../ops/storage-layout.md). The folder for videos is chosen on the welcome step; moving it from inside the app is not possible yet.

Horde listens on port **8686** of your computer, the same port the Docker guides use. If another program has it the first time, Horde picks a free port once and keeps using that one, so the address stays the same.

## Share on your home network

By default Horde answers only on the computer it runs on, so nobody else on your Wi-Fi can reach it. To watch from a phone or a TV, turn on **Share on my home network** in the tray menu.

- It is available only after you have created the administrator account, so a stranger on the network cannot take Horde over.
- Horde restarts, which takes a few seconds, and then shows the address other devices can open, such as `http://192.168.1.20:8686`.
- On Windows, a firewall prompt asks whether to let Horde through. Allow it on private networks.
- Everyone still signs in with a Horde account. See [Accounts](../ops/authentication.md).
- Horde is on the network only while the computer is on and Horde is running.

Turn it off in the same menu item. For access away from home, see [Remote access](../ops/remote-access.md).

## Updating

Windows and Linux update by themselves. Horde checks for a new version when it starts and every six hours, downloads it in the background, and installs it when you quit Horde or when Horde is idle: the window is closed, nothing is downloading or being processed, and no video has been played from it for 15 minutes. It tells you when it has updated. **Update now** in Settings → System → Updates works too.

A Mac does not update itself yet. Horde says a new version is available, and the menu item opens the download page. Download the new `.dmg`, drag Horde onto Applications again and replace the old one. Your library stays where it is.

Details: [Updating](updating.md#desktop-app).

If a new version does not start, Horde says so, offers **Open logs** and a link to the previous version, and your data folder holds the database backup made before the update. It does not go back by itself.

## Uninstall

- **Windows:** **Settings → Apps → Installed apps → Horde → Uninstall**. It asks whether to also delete Horde's data (the library database, settings and thumbnails). Your videos are never deleted.
- **macOS:** drag **Horde** from Applications to the Trash. To remove the data too, delete `~/Library/Application Support/Horde` and `~/Library/Logs/Horde`.
- **Linux:** delete the AppImage file. To remove the app grid entry, delete `~/.local/share/applications/horde.desktop`, and `~/.config/autostart/horde.desktop` if you used start at sign-in. To remove the data too, delete `~/.local/share/horde` and `~/.local/state/horde`.

Your videos stay in the media folder in every case.

## Forgotten password

Horde has no email. On the sign-in page choose **Forgot password?** and enter your username. Horde writes a one-time reset code to its log. Choose **Open logs** in the tray menu to open `horde.log`, find the line that starts `PASSWORD RESET CODE`, and type the code on the sign-in page. [Accounts and sign-in](../ops/authentication.md#forgot-your-password) has the details.

## Check the download

Every file on a release is listed with its checksum in `SHA256SUMS` on the [release page](https://github.com/jm-connell/horde/releases/latest), and has a build attestation that shows it was built by this project's workflow. With the [GitHub CLI](https://cli.github.com/):

```bash
gh attestation verify Horde-linux-x64.AppImage --repo jm-connell/horde
```

## What the desktop app does not do yet

- **Pause background work** from the tray, and waiting while the computer is on battery. Horde already runs thumbnails and similar work at low priority.
- **Cookies for YouTube from the app.** The helper that keeps YouTube downloads from hitting bot checks is included and starts with Horde. Cookies for age-restricted or members-only videos can only be set through environment variables for now. See [Troubleshooting](../ops/troubleshooting.md#bot-checks-youtube-blocks).
- **Signed apps.** That is why the first-open warnings exist, and why the Mac app cannot update itself.
- **Automatic return to the previous version** when an update fails.
- **Intel Macs and Windows on ARM.**
- **Changing the media folder** from the app after the first run.
- **Chromecast inside the app window.** Use **Open in browser** to cast.

Found a problem? Open an [issue on GitHub](https://github.com/jm-connell/horde/issues) and attach the end of `horde.log` (**Open logs**).
