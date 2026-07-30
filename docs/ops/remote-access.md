# Remote access

Horde has **no login**. Anyone who can reach the URL can download, delete, change settings, and use any configured OpenRouter key. Keep the app on a trusted LAN, or put **your own** access control in front — do not publish host port **8686** raw to the public internet.

See [No authentication](../design/no-auth.md) and [Ports & networking](ports-networking.md).

```text
Preferred:  Client ──► Tailscale/VPN ──► Horde on LAN :8686

Optional:   Internet ──► Caddy (TLS + Basic Auth) ──► 127.0.0.1:8686
```

## Preferred: Tailscale / WireGuard {#tailscale}

Reach Horde as if you were on the LAN. No public port, no reverse proxy required.

1. Install [Tailscale](https://tailscale.com/) (or WireGuard) on the Docker / TrueNAS host that runs Horde, **or** use an existing subnet router that can reach that host.
2. Leave Compose publishing `8686:8080` on the LAN (or bind to a LAN IP only — see [Compose bind tip](#compose-bind-tip) below).
3. From a device on the same Tailnet, open `http://<tailscale-hostname-or-ip>:8686` (or your MagicDNS name).

Chromecast and similar receivers usually live on the home LAN, not on Tailscale. Prefer casting while you are on the same LAN as Horde; remote VPN access is for the browser UI and downloads admin.

WireGuard works the same way: join the LAN (or route to it), then use the Horde LAN URL. Horde does not need WireGuard-specific config.

## Public HTTPS: Caddy + HTTP Basic Auth {#caddy-basic-auth}

Use this only when you need a public hostname. Auth lives on **Caddy**, not inside Horde.

1. Bind Horde so the internet cannot hit it directly — e.g. publish `127.0.0.1:8686:8080` (see below) and put Caddy on the same host.
2. Generate a bcrypt hash for Basic Auth (`caddy hash-password`).
3. Example Caddyfile:

```caddyfile
horde.example.com {
        basicauth {
                # username + bcrypt hash from: caddy hash-password
                admin $2a$14$REPLACE_WITH_YOUR_HASH
        }
        reverse_proxy 127.0.0.1:8686
}
```

4. Point DNS for `horde.example.com` at the host; Caddy obtains TLS automatically when ports 80/443 are reachable.

!!! warning "Casting through Basic Auth"
    Chromecast (and similar) often cannot send HTTP Basic credentials when fetching media. Prefer [Tailscale / VPN](#tailscale) for day-to-day use, and keep casting on the LAN. Wide CORS assumes a trusted path — see [No authentication](../design/no-auth.md).

If Caddy runs in Docker on the same Compose network, `reverse_proxy horde:8080` instead of `127.0.0.1:8686`.

## SSO (Authelia, Authentik, Cloudflare Access)

Put your existing SSO / identity gateway in front of Horde the same way as Caddy: terminate TLS and auth on the gateway, then reverse-proxy to Horde on localhost or the Docker network.

Horde does not ship Authelia or Authentik configs. Follow their docs for a forward-auth or proxy-auth setup, then point the upstream at Horde. Examples of gateways people use: [Authelia](https://www.authelia.com/), [Authentik](https://goauthentik.io/), [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/).

## Compose bind tip

Default Compose publishes on all interfaces:

```yaml
ports:
  - "8686:8080"
```

To accept connections only from the host (so a local reverse proxy is the only ingress):

```yaml
ports:
  - "127.0.0.1:8686:8080"
```

To bind a LAN interface only, use that host IP instead of `127.0.0.1`. See [Ports & networking](ports-networking.md) and [Environment variables](environment.md).

## Do not expose these

| Service | Why |
|---------|-----|
| **Ollama** (`11434`) | Unauthenticated model API; keep on LAN / Docker network only |
| **bgutil-pot** | Internal POT helper for yt-dlp; no public role |
| **OpenRouter API key** | Lives in Horde settings / env — anyone who reaches Horde can use or change it |

Horde’s threat model is “trusted network or trusted gateway.” Auth belongs outside the app.

## Related

- [No authentication](../design/no-auth.md)
- [Ports & networking](ports-networking.md)
- [Updating](../getting-started/updating.md)
- [Troubleshooting](troubleshooting.md)
- [FAQ](../reference/faq.md)
