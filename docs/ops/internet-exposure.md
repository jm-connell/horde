# Internet exposure checklist

Horde is built for your own network, and the simplest safe way to use it from elsewhere is a VPN. This page is for the other case: you want to reach it from a phone on mobile data, or share it with family, through a public name and a login. It can be done; this is how to do it properly.

## Should you? {#should-you}

Prefer **a VPN** ([Tailscale or WireGuard](remote-access.md#tailscale)) when you can. Nothing is published, there is nothing to attack, and Chromecast still works on your LAN. Publish Horde only if that does not fit, and then do **all** of the following. The *Security* card in **Settings → System** shows which of them are in place (see [below](#checklist-card)).

## The list {#list}

1. **TLS in front** ([HTTPS](#tls)). Never send passwords over plain HTTP across the internet.
2. **Trust the proxy, and only the proxy** ([`HORDE_TRUST_PROXY=1`](#proxy)), with Horde reachable only through it.
3. **List your public name** ([`HORDE_ALLOWED_HOSTS`](#hosts)).
4. **Two-step sign-in required of everyone** (*Settings → System → Security → Require two-step sign-in → Everyone*, see [below](#two-step)).
5. **Strong, unique passwords.** Horde enforces a minimum of 8 characters and nothing else: use a password manager and 16 or more.
6. **Keep updating** ([updates](#updates)).
7. **No `HORDE_AUTH_DISABLED`** ([why](#no-auth)) and **no `HORDE_ALLOW_PRIVATE_URLS`** ([why](#private-urls)).

## HTTPS {#tls}

Terminate TLS on a reverse proxy on the same host (or Docker network) and publish Horde only to it: `127.0.0.1:8686:8080` in Compose (see [Compose bind tip](remote-access.md#compose-bind-tip)). Once a request arrives over HTTPS Horde marks the session cookie `Secure` and sends `Strict-Transport-Security: max-age=31536000` (one year; no `includeSubDomains`, no `preload`). Browsers then refuse to use the name over plain HTTP, so only switch this on when you mean to keep HTTPS working.

### Caddy

Caddy fetches and renews the certificate by itself:

```caddyfile
horde.example.com {
        encode zstd gzip
        reverse_proxy 127.0.0.1:8686
}
```

Caddy passes the original `Host`, and sets `X-Forwarded-For` and `X-Forwarded-Proto` itself. If Caddy runs in the Compose network use `reverse_proxy horde:8080`.

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name horde.example.com;

    ssl_certificate     /etc/letsencrypt/live/horde.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/horde.example.com/privkey.pem;

    # Uploads and imports can be large (HORDE_MAX_UPLOAD_GB).
    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:8686;
        proxy_set_header Host              $host;
        # $proxy_add_x_forwarded_for APPENDS the peer address: Horde reads the
        # right-most entry, never what the client claimed.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Live progress and AI replies are event streams.
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}

server {
    listen 80;
    server_name horde.example.com;
    return 301 https://$host$request_uri;
}
```

## The proxy: `HORDE_TRUST_PROXY=1` {#proxy}

Without it every visitor looks like the proxy's own address, so all sign-in attempts share one throttle, and Horde cannot tell the request was HTTPS. With it, Horde takes the client address from `X-Forwarded-For` (counted from the right; `HORDE_TRUSTED_PROXY_HOPS` if there are several proxies) and HTTPS from `X-Forwarded-Proto`. Set it **only** when a proxy you control is the only way to reach the port, and that proxy sets or appends these headers. See [Behind a reverse proxy](authentication.md#behind-a-reverse-proxy).

## Allowed hosts: `HORDE_ALLOWED_HOSTS` {#hosts}

```text
HORDE_ALLOWED_HOSTS=horde.example.com
```

Requests for any other `Host` get HTTP 400, which stops an attacker's name from pointing at your server (DNS rebinding). Do not use `*` on an exposed server. Details: [Allowed hosts](security.md#allowed-hosts).

## Two-step sign-in {#two-step}

Passwords leak and get guessed; a code from an authenticator app on your phone makes either much less useful.

1. Each person sets it up in **Account settings → Two-step sign-in** (a QR code, then a first code, then ten single-use recovery codes to keep somewhere safe). See [Two-step sign-in](authentication.md#two-step-sign-in).
2. As administrator, set **Settings → System → Security → Require two-step sign-in** to **Everyone**. Accounts without it are taken to the setup screen at their next request and can do nothing else until it is done. *Administrators* limits that to admin accounts.

Keep the recovery codes: if you lose both the phone and the codes, run `docker exec -it horde python -m app.cli reset-2fa <username>` (or another administrator resets it under *Users*).

## Updates {#updates}

Turn on [update checks and, if you can, the **Update now** button](../getting-started/updating.md), and apply releases promptly. Security fixes ship as ordinary releases. CI audits Horde's dependencies and image daily; that only helps if you update.

## Sign-in must stay on {#no-auth}

`HORDE_AUTH_DISABLED=1` makes every request an administrator. It exists for a proxy that authenticates users itself. Never combine it with a public port, and do not rely on it without a proxy that you have tested cannot be bypassed.

## Do not allow private URLs {#private-urls}

`HORDE_ALLOW_PRIVATE_URLS=1` lets downloads and previews reach addresses on your own network. A signed-in user could then make the server fetch internal services. Leave it off.

## The Security card {#checklist-card}

**Settings → System → Security** (administrators) lists, computed by the server from what it can see: whether *this* page came over HTTPS, whether a proxy is forwarding without `HORDE_TRUST_PROXY`, whether `HORDE_ALLOWED_HOSTS` is `*`, whether two-step sign-in is required and which administrators lack it, `HORDE_AUTH_DISABLED`, `HORDE_ALLOW_PRIVATE_URLS` and whether an update is waiting. A tick means fine, a `!` means look at it. It is guidance, not a scanner: it cannot see your firewall, your certificate or your password strength.

## Hearing about attacks {#alerts}

Add a [notification](notifications.md) target. **Failed sign-ins** (on for new targets) tells you when ten wrong passwords or codes hit one account within an hour ("12 failed sign-ins in the last hour from 5 addresses"), at most once an hour per account. **Sign-in from a new device** (off by default) tells you every time an account signs in from a browser it has no session on. The sign-in throttle itself is described in [Passwords and sessions](authentication.md#passwords-and-sessions): back-off per address, a per-name slowdown, and after 50 failures against one name in a day, one attempt per ten seconds from anywhere.

## Remaining risks {#risks}

Be honest with yourself about what this does **not** fix:

- **A signed-in user can make the server fetch URLs.** Downloads, previews and playlist imports go through yt-dlp. Horde checks each URL before the call, but yt-dlp then resolves names and follows redirects itself, so a hostile redirect can still reach an internal address ([details](security.md#private-urls)). Do not create accounts for people you would not trust with a shell-like tool on that host.
- **Members are trusted not to be hostile.** They share the library and can see every video; a member with the `download` permission uses your bandwidth and disk, one with `use_ai` can spend your OpenRouter budget.
- **Cast links are bearer URLs.** A signed `?mt=` media link works without a login for 12 hours for one video; anyone who gets the URL can fetch that video.
- **The wiki is public.** `/wiki` and the interface files carry no data but are served without signing in.
- **The secrets live in `DATA_DIR`.** Session hashes, the signing key (`secret_key`) and each account's two-step secret are in the data folder and its backups. Protect them like the library itself.
- **A stolen session is a signed-in user.** Two-step sign-in protects the sign-in, not a cookie already issued. Use *Signed-in devices* to end sessions; changing the password ends them all.
- **Sign-in is a single-process, in-memory throttle.** A restart forgets the counters.
- **No email.** Password recovery needs the server log or the CLI, by design.

## Related

- [Remote access](remote-access.md)
- [Security](security.md)
- [Accounts and sign-in](authentication.md)
- [Security model](../design/no-auth.md)
- [Ports & networking](ports-networking.md)
