# VideoPlayer refactor smoke checklist

After changes to `VideoPlayer.tsx` / `useShakaDash` / overlays:

1. Local library file play (progressive `/api/videos/.../stream`)
2. DASH stream preview before download (Watch preview / Download page)
3. Mini-player expand / close / resize
4. Theater mode toggle (desktop)
5. Captions on / off with a multi-track video
6. Cast button still mounts (Chromecast / AirPlay affordances present)

No Playwright in this program — manual LAN smoke is the gate.
