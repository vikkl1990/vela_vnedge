# Running the bot 24/7

The bot runs as a systemd service on an Ubuntu host. It is paper-trading only: `execution.mode`
is `paper` and `execution.allowProduction` is `false`, and production orders additionally require
`DELTA_LIVE=1` in the environment, which the unit does not set.

## Accounts and access

Every API route requires a signed-in account. There are three access levels:

| Level | May do |
|---|---|
| Backtest only | Read everything, run backtests and walk-forward validation |
| Backtest and trade | The above, plus trading, scanner changes and settings |
| Administrator | The above, plus creating accounts and setting what each may do |

Permission is decided on the server before any handler runs, and mutations are closed by default: a
route added later requires trade access until someone deliberately opens it. Hiding a button is a
courtesy, not the control.

On a new instance nobody can sign in. The first administrator is created from the dashboard, and
only from a browser on the server itself, which is what the SSH tunnel below gives you. After that,
add the rest from the Users page. Passwords are hashed with scrypt, sessions are opaque tokens
stored server side in an HttpOnly, SameSite=Strict cookie and last 12 hours, and changing a password
signs out every other session.

## The dashboard is still not exposed, on purpose

Authentication is not a reason to open a port. The service binds to `127.0.0.1` and the only port
open to the internet is SSH. Reach the dashboard through a tunnel from your own machine:

```
ssh -N -L 8788:127.0.0.1:8787 -i ~/.ssh/<key> ubuntu@<host>
```

Then open http://localhost:8788.

**Use a local port nothing else is on.** If you also run the bot on your own machine, it already
holds 8787, and a tunnel asking for the same number cannot bind it. SSH does not always fail loudly:
when the local server holds IPv4 only, the tunnel can still take IPv6, and `localhost:8787` then
resolves to whichever the browser picks. The result looks like the remote dashboard being down or
showing the wrong data. Forwarding to a free local port such as 8788 removes the ambiguity, and
anything answering there can only be the tunnel.

To check what holds a port: `lsof -nP -iTCP:8787 -sTCP:LISTEN`. Add `-o ExitOnForwardFailure=yes` to
the ssh command so a tunnel that cannot bind exits instead of sitting there half-connected.

Do not set `HOST=0.0.0.0` on a public machine. Accounts protect the API, but there is no TLS in
front of it, so passwords and session cookies would cross the network in the clear.

## Install

```
# Node (arm64; use node-v25.5.0-linux-x64.tar.xz on amd64)
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v25.5.0/node-v25.5.0-linux-arm64.tar.xz
sudo mkdir -p /opt/node && sudo tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
sudo ln -sf /opt/node/bin/node /usr/local/bin/node && sudo ln -sf /opt/node/bin/npm /usr/local/bin/npm

# code
sudo mkdir -p /opt/vnedge && sudo chown $USER:$USER /opt/vnedge
git clone https://github.com/vikkl1990/vela_vnedge.git /opt/vnedge
cd /opt/vnedge && npm install && npm run build
```

`data/config.json` is deliberately not in the repository: it is runtime state holding the tuned
fleet and exit policy. Copy it from a machine that already has one, or let the server write defaults
on first start and tune from the dashboard.

## Service

The unit lives at `/etc/systemd/system/vnedge.service`. It restarts on failure with a 10 second
delay, capped at 5 restarts per 5 minutes so a crash loop cannot hammer the exchange. It runs with
`ProtectSystem=strict` and can only write to `/opt/vnedge/data`.

```
sudo systemctl enable --now vnedge     # start, and start at boot
sudo systemctl restart vnedge          # after a git pull
systemctl status vnedge
journalctl -u vnedge -f
```

## Updating

```
cd /opt/vnedge && git pull && npm install && npm run build && sudo systemctl restart vnedge
```

Open positions survive a restart: they are stored in SQLite and reloaded on boot. Pending tape
entries are dropped by design, since their signal is stale by then.

## Logs and disk

The app writes its own rotating log to `data/logs/vnedge.log`. The service's stdout and stderr go to
`data/logs/vnedge.out` and `.err`, rotated daily and at 50 MB by `/etc/logrotate.d/vnedge`, seven
generations kept. Nightly database snapshots land in `data/backups`.

## Reaching the dashboard without a tunnel

nginx terminates TLS on 443 and proxies to the bot on loopback. The bot itself never listens on a
public address. The configuration lives at `/etc/nginx/sites-available/vnedge` and sets
`X-Forwarded-Proto https`, which is what makes the session cookie `Secure`. Server-sent events are
proxied unbuffered with a one hour read timeout, and `/api/auth/login` is rate limited at the edge
on top of the application's own throttle.

The certificate is self-signed with the server's IP in its subject alternative name, because a
public certificate authority will not issue for a bare IP address. Browsers therefore show a warning
the first time. Point a domain at the host and switch to a real certificate if you want that gone.

Opening the port is two separate firewalls, and both must allow it:

1. The host: `sudo iptables -L INPUT -n` should accept 80 and 443. Oracle's Ubuntu image already does.
2. The cloud: in the Oracle Cloud console, open the subnet's **Security List** (or the instance's
   Network Security Group) and add ingress rules for TCP 443 and 80 from `0.0.0.0/0`.

Until step 2 is done, connections to those ports time out rather than being refused, which is how
you tell a cloud rule from a host one: a host refusal comes back immediately.

Exposing the dashboard puts a login form on the public internet. The SSH tunnel remains the stricter
option and needs nothing open but 22.
