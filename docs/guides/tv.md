# Watch on your TV

Horde has no TV app of its own. There are four ways to get a video onto the big screen; pick by what your TV is.

| Your TV setup | Use | How |
|---------------|-----|-----|
| Chromecast or Google TV, Android TV, a TV with Chromecast built in | **Cast** from Chrome (desktop or Android) or the installed app | The Cast button in the player. See below for AV1. |
| Apple TV, or a TV with AirPlay | **AirPlay** from Safari (iPhone, iPad, Mac) | The AirPlay button in the player. |
| Jellyfin, Kodi or Plex already on the TV | **Media-server files** | Point the media server at Horde's media folder and turn on [media-server files](media-servers.md); the videos then show up there with titles, dates and thumbnails, as a show per channel. |
| A TV with a decent web browser, or a PC/console plugged in | **The web app** | Open `http://<server>:8686` in the TV's browser. Keyboard shortcuts and theater mode work as on a computer. |

Whichever you use, watch progress is saved to your account, so your phone or computer picks up where the TV left off (with Cast, Horde saves the position the TV reports every few seconds).

## Cast and AV1

YouTube's high-resolution video is AV1, and most Chromecasts and many TVs cannot decode it. When a video has an **H.264 copy**, Horde casts that copy instead of the original. Copies exist when Settings → Library → **Playback compatibility** is **AV1 + H.264 copy** (or one of the H.264 modes, which store H.264 to begin with); a single video also gets one when a device asks for it. If casting fails on AV1 videos, switch to **AV1 + H.264 copy**: the setup wizard picks it for you when you say a TV will be watching ([Playback compatibility](downloads.md#compatibility-codecs)).

## Casting needs a reachable address

The TV fetches the video from Horde itself, not through your phone. Use an address the TV can reach: the server's LAN IP (`http://192.168.1.20:8686`) works; `localhost` and a Tailscale-only name do not, unless the TV is on Tailscale too.
