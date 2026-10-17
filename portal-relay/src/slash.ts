/**
 * Slash commands — in-Discord relay administration (issue #8-adjacent UX):
 * grant/revoke channel access, manage access roles, mint single-use invites,
 * diagnose effective capabilities, and force a persona resync — all from the
 * channel where the question arises, with live propagation (#5) making every
 * mutation reach connected agents in ~1s, no restart.
 *
 * This module is deliberately discord.js-free (same decoupling as admin/):
 * DiscordBot normalizes interactions into SlashInvocation/AutocompleteRequest
 * and renders SlashReply; everything here is pure logic over the stores, so
 * it unit-tests without a Discord client.
 *
 * Authorization: Discord Manage-Server in the invoking guild OR a configured
 * superadmin. Commands are additionally registered with a Manage-Server
 * default visibility so non-admins don't see them — that's UX, not the gate;
 * the server-side check here is the gate. Every invocation (including denied
 * ones) is audited.
 */
import type { Capability } from '@animalabs/portal-protocol';
import type { AccessRole, PersonaIdentity } from './config.js';
import { roleGrantsAccess, type PermissionsStore } from './permissions.js';
import { LEVEL_CAPS, capsLabel, contributingRoles, removeFromGuild } from './access.js';
import type { InviteStore } from './invites.js';
import type { AuditLog } from './admin/audit.js';

// ── Wire-neutral shapes (DiscordBot ⇄ handler) ──

export interface SlashInvoker {
  id: string;
  name: string;
  /** Discord Manage-Server permission in the invoking guild. */
  hasManageGuild: boolean;
}

export interface SlashInvocation {
  command: string;
  guildId: string;
  /** The channel the command acts on. Run inside a thread, this is the
   *  thread's PARENT: Portal checks a thread's access on its parent channel,
   *  so a grant stored under the thread's own id would grant nothing. */
  channelId: string;
  /** Channel display name, for reply text. */
  channelName: string;
  /** Set when the command was run inside a thread (see channelId). */
  thread?: { id: string; name: string };
  invoker: SlashInvoker;
  options: Record<string, string | undefined>;
}

/** Where a slash command acts, from where it was run: a thread acts on its
 *  parent channel (see SlashInvocation.channelId). discord.js-free so it can
 *  be tested; discord-bot.ts supplies the channel facts. */
export function slashTarget(where: {
  channelId: string;
  name?: string | null;
  isThread: boolean;
  parentId?: string | null;
  parentName?: string | null;
}): Pick<SlashInvocation, 'channelId' | 'channelName' | 'thread'> {
  if (where.isThread && where.parentId) {
    return {
      channelId: where.parentId,
      channelName: where.parentName || where.parentId,
      thread: { id: where.channelId, name: where.name || where.channelId },
    };
  }
  return { channelId: where.channelId, channelName: where.name || where.channelId };
}

/** "#channel", or — run in a thread — "#parent (thread "x" takes its access)". */
function placeLabel(inv: SlashInvocation): string {
  return inv.thread
    ? `#${inv.channelName} (the channel thread "${inv.thread.name}" is in — threads take their channel's access)`
    : `#${inv.channelName}`;
}

export interface AutocompleteRequest {
  command: string;
  guildId: string;
  channelId: string;
  /** Autocomplete is gated like execution — an unauthorized user typing in a
   *  visible option field must not be able to enumerate personas/roles. */
  invoker: SlashInvoker;
  option: string;
  /** What the user has typed so far in the focused option. */
  partial: string;
  /** Values of the other (already filled) options. */
  options: Record<string, string | undefined>;
}

export interface SlashChoice {
  name: string;
  value: string;
}

/** Option metadata DiscordBot maps onto Discord's command schema. All options
 *  are strings; `choices` and `autocomplete` are mutually exclusive. */
export interface SlashOptionDef {
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: string[];
}

export interface SlashCommandDef {
  name: string;
  description: string;
  options: SlashOptionDef[];
}

const PERSONA = (description: string): SlashOptionDef => ({
  name: 'persona',
  description,
  required: true,
  autocomplete: true,
});

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'add',
    description: 'Grant a persona access to this channel',
    options: [
      PERSONA('Persona to grant access to'),
      {
        name: 'level',
        description: 'read = view+history; write = +send/react/attach; full = +manage (default)',
        choices: ['read', 'write', 'full'],
      },
    ],
  },
  {
    name: 'remove',
    description: 'Remove a persona’s direct grant for this channel',
    options: [PERSONA('Persona to remove from this channel')],
  },
  {
    name: 'list',
    description: 'List identities with access to this channel',
    options: [],
  },
  {
    name: 'add-role',
    description: 'Assign a portal access role to a persona',
    options: [
      PERSONA('Persona to assign the role to'),
      { name: 'role', description: 'Access role from the catalog', required: true, autocomplete: true },
    ],
  },
  {
    name: 'remove-role',
    description: 'Remove a portal access role from a persona',
    options: [
      PERSONA('Persona to remove the role from'),
      { name: 'role', description: 'Access role the persona holds', required: true, autocomplete: true },
    ],
  },
  {
    name: 'invite',
    description: 'Mint a single-use enrollment invite granting access roles, plus access to this channel',
    options: [
      { name: 'role', description: 'Access role the new persona will hold', required: true, autocomplete: true },
      { name: 'role2', description: 'Additional access role', autocomplete: true },
      { name: 'role3', description: 'Additional access role', autocomplete: true },
      { name: 'label', description: 'Human label for the invite (who is this for?)' },
      {
        name: 'level',
        description: 'Access to THIS channel on top of roles: read; write = +send/react/attach (default); full = +manage',
        choices: ['read', 'write', 'full'],
      },
    ],
  },
  {
    name: 'ban',
    description: 'Strip a persona’s access in this guild (roles + direct grants)',
    options: [PERSONA('Persona to strip of all access in this guild')],
  },
  {
    name: 'caps',
    description: 'Show a persona’s effective capabilities in this channel, and why',
    options: [PERSONA('Persona to inspect')],
  },
  {
    name: 'resync',
    description: 'Re-push the full channel/rights set to a connected persona',
    options: [PERSONA('Persona to resync')],
  },
];

// ── Capability presets ──

// The presets and their labels live in access.ts (the admin panel speaks
// them too); importers of LEVEL_CAPS from here keep working.
export { LEVEL_CAPS };

// ── Handler ──

export interface SlashDeps {
  identity: { get(id: string): PersonaIdentity | undefined; all(): PersonaIdentity[] };
  permissions: PermissionsStore;
  invites?: InviteStore;
  audit?: AuditLog;
  superadmins: string[];
  /** Per-guild operator delegates (PORTAL_GUILD_ADMINS) — honored like the
   *  admin panel does, in addition to live Discord Manage-Server. */
  guildAdmins: Record<string, string[]>;
  capsFor(personaId: string, channelId: string, guildId: string): Capability[];
  canAccessGuild(personaId: string, guildId: string): boolean;
  /** Re-push the full channel set to a persona; returns channels pushed. */
  resync(personaId: string): number;
  newInviteCode(): string;
  /** Whether the relay serves this guild (allow-listed). Commands linger in a
   *  guild until Discord drops them, and a joined-but-not-allowed guild is not
   *  one portal administers — so nothing runs there. */
  isGuildServed?(guildId: string): boolean;
}

export class SlashHandler {
  constructor(private deps: SlashDeps) {}

  handle(inv: SlashInvocation): string {
    if (this.deps.isGuildServed && !this.deps.isGuildServed(inv.guildId)) {
      return 'Portal is not enabled in this server.';
    }
    if (!this.authorized(inv.invoker, inv.guildId)) {
      this.audit(inv, 'authz.denied', undefined, false, { command: inv.command });
      return 'Not authorized: requires Manage Server here, or portal superadmin.';
    }
    try {
      switch (inv.command) {
        case 'add': return this.add(inv);
        case 'remove': return this.remove(inv);
        case 'list': return this.list(inv);
        case 'add-role': return this.addRole(inv);
        case 'remove-role': return this.removeRole(inv);
        case 'invite': return this.invite(inv);
        case 'ban': return this.ban(inv);
        case 'caps': return this.caps(inv);
        case 'resync': return this.resyncCmd(inv);
        default: return `Unknown command: ${inv.command}`;
      }
    } catch (err) {
      this.audit(inv, `slash.${inv.command}`, inv.options.persona, false, {
        error: (err as Error).message,
      });
      return `Failed: ${(err as Error).message}`;
    }
  }

  private authorized(invoker: SlashInvoker, guildId: string): boolean {
    return (
      invoker.hasManageGuild ||
      this.isSuper(invoker) ||
      (this.deps.guildAdmins[guildId] ?? []).includes(invoker.id)
    );
  }

  private isSuper(invoker: SlashInvoker): boolean {
    return this.deps.superadmins.includes(invoker.id);
  }

  /** Why named roles that aren't live can't be used here, or null: names
   *  the catalog has never had, and names set aside when the relay loaded
   *  them, which it can't read until its operator fixes them. */
  private notLive(names: string[]): string | null {
    const p = this.deps.permissions;
    const absent = names.filter((n) => !p.getRole(n));
    const unknown = absent.filter((n) => !p.isQuarantined(n));
    const unreadable = absent.filter((n) => p.isQuarantined(n));
    const list = (ns: string[]) => ns.map((n) => `\`${n}\``).join(', ');
    const parts = [
      ...(unknown.length ? [`No such access role${unknown.length === 1 ? '' : 's'}: ${list(unknown)}.`] : []),
      ...(unreadable.length ? [`Access role${unreadable.length === 1 ? '' : 's'} ${list(unreadable)} can't be read (set aside when the relay loaded ${unreadable.length === 1 ? 'it' : 'them'}), so the relay's operator must fix ${unreadable.length === 1 ? 'it' : 'them'} first.`] : []),
    ];
    return parts.length ? parts.join(' ') : null;
  }

  /**
   * Guild containment for role grants (/add-role, /remove-role, /invite): a
   * guild's admin may only hand out (or take away) roles SCOPED TO THAT
   * GUILD; other guilds' roles are superadmin-only. Since 2026-07-31 roles
   * are guild-scoped in RESOLUTION too (scope:{all} = that guild only), so
   * this gate and the resolver agree. Autocomplete filters the same way, but
   * the filter is a hint; THIS is the gate.
   */
  private roleGrantableHere(role: AccessRole, inv: SlashInvocation): boolean {
    return this.isSuper(inv.invoker) || role.guildId === inv.guildId;
  }

  /** The role names a reply may list: all of them to a superadmin, only this
   *  guild's to anyone else (another guild's roles are not theirs to see). */
  private visibleRoles(roles: string[], inv: SlashInvocation): string[] {
    if (this.isSuper(inv.invoker)) return roles;
    return roles.filter((r) => this.deps.permissions.getRole(r)?.guildId === inv.guildId);
  }

  private audit(
    inv: SlashInvocation,
    action: string,
    target: string | undefined,
    ok: boolean,
    detail?: Record<string, unknown>,
  ): void {
    this.deps.audit?.append({
      actor: { id: inv.invoker.id, name: inv.invoker.name, kind: 'admin' },
      action,
      target,
      guildId: inv.guildId,
      ok,
      detail: { via: 'slash', channelId: inv.channelId, ...detail },
    });
  }

  /** Resolve the persona option or produce the error reply. */
  private target(inv: SlashInvocation): PersonaIdentity | string {
    const id = inv.options.persona ?? '';
    const persona = this.deps.identity.get(id);
    return persona ?? `No such persona: \`${id}\``;
  }

  // ── Commands ──

  private add(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const level = inv.options.level && LEVEL_CAPS[inv.options.level] ? inv.options.level : 'full';
    this.deps.permissions.liftBan(persona.id, inv.guildId); // an admin granting access here ends a /ban
    this.deps.permissions.setChannel(persona.id, inv.guildId, inv.channelId, LEVEL_CAPS[level]);
    const effective = this.deps.capsFor(persona.id, inv.channelId, inv.guildId);
    this.audit(inv, 'slash.add', persona.id, true, { level });
    return (
      `Granted **${persona.displayName}** (\`${persona.id}\`) ${level} access to ${placeLabel(inv)}.\n` +
      `Effective now: ${capsLabel(effective)}.`
    );
  }

  private remove(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    this.deps.permissions.clearChannel(persona.id, inv.guildId, inv.channelId);
    const effective = this.deps.capsFor(persona.id, inv.channelId, inv.guildId);
    this.audit(inv, 'slash.remove', persona.id, true);
    if (effective.includes('VIEW_CHANNEL')) {
      const roles = this.contributingRoles(persona.id, inv.guildId, inv.channelId);
      return (
        `Removed **${persona.displayName}**’s direct grant for #${inv.channelName} — but they still ` +
        `have ${capsLabel(effective)} via role${roles.length === 1 ? '' : 's'}: ${roles.map((r) => `\`${r}\``).join(', ') || '(guild/persona default)'}.\n` +
        `Use \`/remove-role\` or \`/ban\` to take that away.`
      );
    }
    return `Removed **${persona.displayName}** (\`${persona.id}\`) from #${inv.channelName}. No remaining access.`;
  }

  private list(inv: SlashInvocation): string {
    const lines: string[] = [];
    for (const persona of this.deps.identity.all()) {
      const caps = this.deps.capsFor(persona.id, inv.channelId, inv.guildId);
      if (!caps.includes('VIEW_CHANNEL')) continue;
      lines.push(`• **${persona.displayName}** \`${persona.id}\` — ${capsLabel(caps)}${this.sourceNote(persona.id, inv)}`);
    }
    if (!lines.length) return `No identities have access to #${inv.channelName}.`;
    return `Identities with access to #${inv.channelName} (${lines.length}):\n${lines.join('\n')}`;
  }

  private addRole(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const name = inv.options.role ?? '';
    const role = this.deps.permissions.getRole(name);
    if (!role) return this.notLive([name])!;
    if (!this.roleGrantableHere(role, inv)) {
      this.audit(inv, 'slash.add-role', persona.id, false, { role: name, reason: 'guild-containment' });
      return `\`${name}\` is scoped to another guild — only a portal superadmin can assign it.`;
    }
    if (roleGrantsAccess(role)) this.deps.permissions.liftBan(persona.id, role.guildId); // an admin granting access there ends a /ban
    const roles = this.visibleRoles(this.deps.permissions.addPersonaRoles(persona.id, [name]), inv);
    this.audit(inv, 'slash.add-role', persona.id, true, { role: name });
    return `**${persona.displayName}** now holds \`${name}\` (roles here: ${roles.map((r) => `\`${r}\``).join(', ')}).`;
  }

  private removeRole(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const name = inv.options.role ?? '';
    if (!this.deps.permissions.getRoleNames(persona.id).includes(name)) {
      return `**${persona.displayName}** doesn’t hold \`${name}\`.`;
    }
    // Same containment as granting: removing another guild's (or a global)
    // role changes the persona's access OUTSIDE this admin's authority.
    // A role set aside at load is contained by the guild its entry names, and
    // one whose entry names no guild it can read is a superadmin's to remove,
    // as in the admin panel. A name the catalog has never had keeps no guild.
    const p = this.deps.permissions;
    const role = p.getRole(name);
    if (role && !this.roleGrantableHere(role, inv)) {
      this.audit(inv, 'slash.remove-role', persona.id, false, { role: name, reason: 'guild-containment' });
      return `\`${name}\` is scoped to another guild — only a portal superadmin can remove it.`;
    }
    if (!role && p.isQuarantined(name) && !this.isSuper(inv.invoker)) {
      const guildId = p.quarantinedGuildId(name);
      if (guildId === undefined) {
        this.audit(inv, 'slash.remove-role', persona.id, false, { role: name, reason: 'guild-unreadable' });
        return `\`${name}\` can't be read (set aside when the relay loaded it) and names no guild the relay can read, so only a portal superadmin can remove it.`;
      }
      if (guildId !== inv.guildId) {
        this.audit(inv, 'slash.remove-role', persona.id, false, { role: name, reason: 'guild-containment' });
        return `\`${name}\` is scoped to another guild — only a portal superadmin can remove it.`;
      }
    }
    const roles = this.visibleRoles(this.deps.permissions.removePersonaRole(persona.id, name), inv);
    this.audit(inv, 'slash.remove-role', persona.id, true, { role: name });
    return `Removed \`${name}\` from **${persona.displayName}** (remaining here: ${roles.map((r) => `\`${r}\``).join(', ') || 'none'}).`;
  }

  private invite(inv: SlashInvocation): string {
    if (!this.deps.invites) return 'Invites are not configured on this relay (PORTAL_INVITES).';
    const names = [inv.options.role, inv.options.role2, inv.options.role3].filter(
      (r): r is string => !!r,
    );
    const notLive = this.notLive(names);
    if (notLive) return notLive;
    // Guild containment: the invite's roles carry their own scope, so an
    // uncontained mint here would hand out cross-guild/fleet-wide access.
    const uncontained = names.filter((n) => !this.roleGrantableHere(this.deps.permissions.getRole(n)!, inv));
    if (uncontained.length) {
      this.audit(inv, 'slash.invite', undefined, false, { roles: names, reason: 'guild-containment' });
      return `Role${uncontained.length === 1 ? '' : 's'} ${uncontained.map((n) => `\`${n}\``).join(', ')} not scoped to this guild — only a portal superadmin can mint invites carrying them.`;
    }
    // The channel the command was run in is pinned as a direct grant on top of
    // the roles: "/invite here" should mean the new persona can talk HERE, even
    // when none of the roles happen to cover this channel. Same containment as
    // /add — the admin is authorized for this guild, and the grant is scoped to
    // exactly this channel in it.
    const level = inv.options.level && LEVEL_CAPS[inv.options.level] ? inv.options.level : 'write';
    const code = this.deps.newInviteCode();
    this.deps.invites.mint({
      code,
      label: inv.options.label ?? `slash-invite by ${inv.invoker.name}`,
      roles: [...new Set(names)],
      grant: { caps: LEVEL_CAPS[level], scope: { channels: [inv.channelId] } },
      guildId: inv.guildId,
      maxUses: 1,
    });
    this.audit(inv, 'slash.invite', code, true, {
      roles: names, label: inv.options.label, channelLevel: level,
      ...(inv.thread ? { ranInThread: inv.thread.id } : {}),
    });
    return (
      `Single-use invite minted (roles: ${names.map((n) => `\`${n}\``).join(', ')}; ` +
      `plus ${level} access to ${placeLabel(inv)}):\n\`${code}\`\n` +
      `This message is only visible to you — hand the code to the enrolling agent.`
    );
  }

  private ban(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    // The one removal the panel's "Remove from <guild>" makes too: this
    // guild's access roles off, its inline policy pinned to deny, the ban
    // recorded — and verified (access.ts removeFromGuild).
    const removed = removeFromGuild(this.deps.permissions, (p, g) => this.deps.canAccessGuild(p, g), persona.id, inv.guildId);
    const guildRoles = removed.rolesRemoved;
    const stillHasAccess = !removed.accessFullyRevoked;
    this.audit(inv, 'slash.ban', persona.id, !stillHasAccess, {
      rolesRemoved: guildRoles,
      accessFullyRevoked: !stillHasAccess,
    });
    const did =
      `Removed guild role${guildRoles.length === 1 ? '' : 's'} ` +
      `${guildRoles.map((r) => `\`${r}\``).join(', ') || '(none held)'} from ` +
      `**${persona.displayName}** (\`${persona.id}\`) and denied all direct grants here.`;
    if (stillHasAccess) {
      return (
        `${did}\n⚠️ **Access unexpectedly still resolves in this guild** — this should be ` +
        `impossible now that roles are guild-scoped; check permissions.json (invariant break, please report).`
      );
    }
    return `${did}\nNo remaining access in this guild.`;
  }

  private caps(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const caps = this.deps.capsFor(persona.id, inv.channelId, inv.guildId);
    const roles = this.contributingRoles(persona.id, inv.guildId, inv.channelId);
    const entry = this.deps.permissions.getEntry(persona.id);
    const guildPolicy = entry?.policy?.guilds?.[inv.guildId];
    const inline = guildPolicy?.channels?.[inv.channelId];
    const sources: string[] = [];
    if (roles.length) sources.push(`roles: ${roles.map((r) => `\`${r}\``).join(', ')}`);
    if (inline) sources.push(`direct grant (${capsLabel(inline)})`);
    else if (guildPolicy?.default?.length) sources.push(`guild default (${capsLabel(guildPolicy.default)})`);
    return (
      `**${persona.displayName}** (\`${persona.id}\`) in #${inv.channelName}:\n` +
      `Effective: ${capsLabel(caps)}${caps.length ? ` — ${caps.join(', ')}` : ''}\n` +
      `Via: ${sources.join(' + ') || 'nothing (no access)'}`
    );
  }

  private resyncCmd(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const pushed = this.deps.resync(persona.id);
    this.audit(inv, 'slash.resync', persona.id, true, { pushed });
    return `Re-pushed ${pushed} channels to **${persona.displayName}**’s stream (connected sessions apply them immediately; a fully-offline agent gets a fresh set at next identify anyway).`;
  }

  // ── Autocomplete ──

  autocomplete(req: AutocompleteRequest): SlashChoice[] {
    // Same gate as execution: a user who can see the command (e.g. after a
    // guild admin widened visibility in Integrations settings) but can't run
    // it must not be able to enumerate personas or the role catalog by typing.
    if (this.deps.isGuildServed && !this.deps.isGuildServed(req.guildId)) return [];
    if (!this.authorized(req.invoker, req.guildId)) return [];
    if (req.option === 'persona') return this.personaChoices(req);
    if (req.option === 'role' || req.option === 'role2' || req.option === 'role3') {
      return this.roleChoices(req);
    }
    return [];
  }

  /** Target dropdowns narrow to plausible targets: channel-access holders for
   *  remove/caps, guild-access holders for ban/resync/remove-role, everyone
   *  for add/add-role (the target typically lacks access there). */
  private personaChoices(req: AutocompleteRequest): SlashChoice[] {
    const q = req.partial.toLowerCase();
    const pool = this.deps.identity.all().filter((p) => {
      switch (req.command) {
        case 'remove':
        case 'caps':
          return this.deps.capsFor(p.id, req.channelId, req.guildId).includes('VIEW_CHANNEL');
        case 'ban':
        case 'resync':
        case 'remove-role':
          return this.deps.canAccessGuild(p.id, req.guildId);
        default:
          return true;
      }
    });
    return pool
      .filter((p) => !q || p.id.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q))
      .slice(0, 25)
      .map((p) => ({ name: `${p.displayName} (${p.id})`, value: p.id }));
  }

  /** Role dropdowns mirror the grant gate: this guild's roles only (a
   *  superadmin may still TYPE another guild's role — the gate exempts them);
   *  for remove-role, narrowed to what the (already chosen) persona holds. */
  private roleChoices(req: AutocompleteRequest): SlashChoice[] {
    const q = req.partial.toLowerCase();
    let names = Object.entries(this.deps.permissions.allRoles())
      .filter(([, role]: [string, AccessRole]) => role.guildId === req.guildId)
      .map(([name]) => name);
    if (req.command === 'remove-role' && req.options.persona) {
      const held = new Set(this.deps.permissions.getRoleNames(req.options.persona));
      names = names.filter((n) => held.has(n));
    }
    return names
      .filter((n) => !q || n.toLowerCase().includes(q))
      .slice(0, 25)
      .map((n) => ({ name: n, value: n }));
  }

  /** " (via roles: a, b)" / " (direct grant)" annotation for /list lines. */
  private sourceNote(personaId: string, inv: SlashInvocation): string {
    const roles = this.contributingRoles(personaId, inv.guildId, inv.channelId);
    const inline = !!this.deps.permissions.getEntry(personaId)?.policy?.guilds?.[inv.guildId]
      ?.channels?.[inv.channelId];
    const parts: string[] = [];
    if (roles.length) parts.push(`roles: ${roles.join(', ')}`);
    if (inline) parts.push('direct grant');
    return parts.length ? ` (via ${parts.join(' + ')})` : '';
  }

  private contributingRoles(personaId: string, guildId: string, channelId: string): string[] {
    return contributingRoles(this.deps.permissions, personaId, guildId, channelId);
  }
}
