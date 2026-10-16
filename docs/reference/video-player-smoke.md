# Video player smoke checklist

After changes to `VideoPlayer.tsx`, `components/player/` (see [Frontend architecture](../architecture/frontend.md)), `useShakaDash`, or player overlays, verify on your LAN:

1. Local library file play (progressive `/api/videos/.../stream`)
2. DASH stream preview before download (Watch preview / Download page)
3. Download-while-previewing handoff: playback continues from the library file (not a black spinner)
4. Mini-player expand / close / resize
5. Theater mode toggle (desktop)
6. Captions on / off with a multi-track video
7. Cast button still mounts (Chromecast / AirPlay affordances present)

Playwright (`e2e/player.spec.ts`, `e2e/watch.spec.ts`) covers watch-page chrome, keyboard shortcuts, scrubbing, volume, speed, fullscreen, SponsorBlock skipping and the mini player with a short VP9 clip. It does not decode DASH, reparent the mini-player, or mount Cast. Manual smoke is still the gate for those paths. See [Automated testing](../getting-started/testing.md) and [Local development](../getting-started/local-dev.md).

## Related

- [Player architecture](../design/player-architecture.md)
- [Watching](../guides/watching.md)
- [Video player](../guides/player.md)
