# Video player smoke checklist

After changes to `VideoPlayer.tsx`, `useShakaDash`, or player overlays, verify on your LAN:

1. Local library file play (progressive `/api/videos/.../stream`)
2. DASH stream preview before download (Watch preview / Download page)
3. Mini-player expand / close / resize
4. Theater mode toggle (desktop)
5. Captions on / off with a multi-track video
6. Cast button still mounts (Chromecast / AirPlay affordances present)

No Playwright coverage for these paths yet — manual smoke is the gate. See also [Player architecture](../design/player-architecture.md) and [Local development](../getting-started/local-dev.md) (automated tests).

## Related

- [Player architecture](../design/player-architecture.md)
- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
