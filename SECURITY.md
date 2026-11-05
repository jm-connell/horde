# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: **Security → Report a vulnerability** on
[this repository](https://github.com/jm-connell/horde/security/advisories/new).
Include the Horde version (Settings → System → Updates), how it is deployed
(behind a reverse proxy, `HORDE_AUTH_DISABLED`, exposed to the internet or not)
and the steps to reproduce.

You should hear back within a week. A fix ships as a new release; the advisory
is published once a fixed release is out.

## Supported versions

Only the newest release gets security fixes. `update.sh` and **Update now**
move to it.

## Scope

Horde is designed for a home network or VPN (see
[Security](https://jm-connell.github.io/horde/ops/security/) and the
[internet exposure checklist](https://jm-connell.github.io/horde/ops/internet-exposure/)).
Reports are welcome either way, but these are by design and not
vulnerabilities:

- With `HORDE_AUTH_DISABLED=1`, anyone who reaches the port is an
  administrator: the reverse proxy in front decides who gets in.
- Anyone who can read the container's log can reset any password (the
  "Forgot password" code is written there on purpose).
- Members can see every video in the shared library.
