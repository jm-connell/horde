# Video player smoke checklist

After changes to `VideoPlayer.tsx`, `useShakaDash`, or player overlays, verify on your LAN:

1. Local library file play (progressive `/api/videos/.../stream`)
2. DASH stream preview before download (Watch preview / Download page)
3. Download-while-previewing handoff: playback continues from the library file (not a black spinner)
4. Mini-player expand / close / resize
5. Theater mode toggle (desktop)
6. Captions on / off with a multi-track video
7. Cast button still mounts (Chromecast / AirPlay affordances present)

No Playwright coverage for these paths yet — manual smoke is the gate after player changes. Automated CI covers API/library/queue/settings regressions and the production image build; it does **not** drive the browser player. See [Automated testing](../getting-started/testing.md) and [Local development](../getting-started/local-dev.md).

## Related

- [Player architecture](../design/player-architecture.md)
- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
