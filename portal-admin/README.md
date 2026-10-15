# portal-admin

The static admin-panel SPA for portal (PORTAL-RFC-005). Dependency-free: plain
HTML + vanilla JS + CSS, no build step, no npm. It is a pure client of the
relay's admin HTTP API — **all** authorization is enforced server-side.

```
portal-admin/
├── index.html        app shell + login + right-side detail drawer + token modal
├── app.js            API client, resource tabs, dense tables, all mutations
├── styles.css        self-contained styling (dense, dark/light, CSP-clean)
├── Caddyfile.example reverse-proxy + static-serve vhost
└── README.md
```

## Information architecture

**Resource-first**, built for scale (dozens → low hundreds of personas, the whole
point being to beat Discord's 50-bot limit). Top-level tabs are *resources*, with
the guild as a persistent **scope** in the header — not a gate you pass first.

- **Personas** — the one place for a persona (portal's only kind of speaker).
  The table (avatar · name · id · access roles · direct grants?) lists the
  personas with access in the selected guild; super-admins can switch it to
  **All personas** (with each one's guild count). Click a row → a right-side
  **drawer**:
  - *Access in <guild>* — assign/revoke access roles (the primary mechanism),
    claim an invite for the persona, and its direct grants in this guild;
  - *(super-admin)* Profile picture, *Access in every guild* (where it can act,
    what each access role confers, its direct grants everywhere) and **Token**
    (rotate / revoke) — a token authenticates a persona everywhere, so it is
    not a per-guild action.

  "Grant access by id" reaches a persona that has no access yet. (The former
  *Identities* tab was the same personas, globally; it is folded in here.)
- **Invites** *(guild-scoped)* — mint (roles or a channel/mirror scope + `mode`),
  list, revoke. Search + pagination.
- **Access roles** *(read guild-scoped, authoring global/super-admin)* — the named
  access-role catalog. It is **global** (shared across guilds); only super-admins
  may create/delete.
- **Audit** *(guild-scoped)* — every mutation, newest first.

**Scope control:** if you administer exactly one guild it's shown as a fixed
label; otherwise it's a selector. Super-admins also get an "other guild id…"
entry (they may act in any guild).

## How it fits together

```
browser ──HTTPS──▶ Caddy ──┬─ /          → static assets (this dir)
                           └─ /admin/*    → reverse_proxy 127.0.0.1:8791 (relay admin API)
```

The browser holds only an httpOnly session cookie (set by the OAuth flow); the
SPA never sees a token. Every mutating request carries the `X-CSRF-Token` header
read from `GET /admin/me`.

## Deploy

1. **Copy the assets** to the box that runs Caddy, e.g. `/srv/portal-admin`.

2. **Configure Caddy.** Start from `Caddyfile.example`: set your hostname and
   point `root` at the asset directory. It serves `/` statically and proxies
   `/admin/*` to the relay on `127.0.0.1:8791`. (Keep the `handle /admin/*` block
   before the static handler.)

3. **Register a Discord OAuth app** (Discord Developer Portal → your app →
   OAuth2):
   - Add a redirect URI exactly matching what the relay is configured with, e.g.
     `https://portal-admin.example.com/admin/callback`.
   - Scopes used by the flow: `identify guilds` (the relay requests these).
   - Note the **Client ID** and **Client Secret**.

4. **Configure the relay** (admin API) with these env vars and restart it:

   ```sh
   PORTAL_ADMIN_ENABLED=true
   PORTAL_ADMIN_PORT=8791                 # localhost bind; Caddy proxies to it
   PORTAL_OAUTH_CLIENT_ID=<discord client id>
   PORTAL_OAUTH_CLIENT_SECRET=<discord client secret>
   PORTAL_OAUTH_REDIRECT_URI=https://portal-admin.example.com/admin/callback
   PORTAL_ADMIN_POST_LOGIN_URL=/          # where to land after login (the SPA)
   PORTAL_SUPERADMINS=<discord user id>,<discord user id>
   PORTAL_ADMIN_AUDIT=/var/lib/portal/audit.jsonl
   # optional: PORTAL_ADMIN_SESSION_TTL_MS=1800000
   ```

   For **local dev** without TLS, also set `PORTAL_ADMIN_COOKIE_INSECURE=true` so
   the session cookie is sent over plain http. (See `portal-relay/scripts/
   admin-dev.mjs` for a no-bot local harness.)

## Who can do what

- **Guild-admins** (Discord `ADMINISTRATOR` / `MANAGE_GUILD` / owner of a guild):
  manage invites, personas' access roles, and per-guild direct grants — scoped to guilds
  they administer. They express access by mirroring their own Discord roles or
  picking channels. A guild-admin's tool for "remove an agent from my guild" is
  revoking its guild-scoped roles/grants.
- **Super-admins** (in `PORTAL_SUPERADMINS`): all of the above in **any** guild,
  plus authoring the global access-role catalog (Access roles tab) and, on
  Personas, the *All personas* view, profile pictures and **token lifecycle**
  (rotate/revoke).

## API contract (what the SPA expects)

Lists accept `?q=&limit=&offset=` and return `{ items…, total, limit, offset }`.

- `GET /admin/me` → `{user, isSuper, guilds:[{id,name}], csrf}`; `POST /admin/logout`
- `GET /admin/g/:gid/personas` → `{personas:[{id,displayName,roles,hasOverride}], total,limit,offset}`
- `GET /admin/g/:gid/personas/:id` → `{id,displayName,roles,guildPolicy}`
- `POST/DELETE /admin/g/:gid/personas/:id/roles[/:role]`; `PUT/DELETE …/grants`; `POST …/claim`
- `GET/POST /admin/g/:gid/invites`, `DELETE …/invites/:code`
- `GET /admin/g/:gid/roles` → `{catalog, discordRoles, canAuthor}`; `GET …/channels`; `GET …/audit`
- `POST/DELETE /admin/roles[/:name]` *(super-admin, global)*
- `GET /admin/personas` → `{personas:[{id,displayName,roles,guildCount}], total,…}` *(super-admin)*
- `GET /admin/personas/:id` → `{id,displayName,roles,guilds}`; `POST /admin/personas/:id/token` *(super-admin)*

## Notes

- Rotated tokens are shown exactly once — copy and deliver out-of-band.
- No client-side authz: a guild-admin hitting another guild gets a `403`, surfaced
  inline. Token endpoints return `403` for non-super-admins.
- Keyboard: `/` focuses the active search box, `Esc` closes the drawer.
