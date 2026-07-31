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
import type { PermissionsStore } from './permissions.js';
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
  channelId: string;
  /** Channel display name, for reply text. */
  channelName: string;
  invoker: SlashInvoker;
  options: Record<string, string | undefined>;
}

export interface AutocompleteRequest {
  command: string;
  guildId: string;
  channelId: string;
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

const IDENTITY = (description: string): SlashOptionDef => ({
  name: 'identity',
  description,
  required: true,
  autocomplete: true,
});

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    name: 'add',
    description: 'Grant an identity access to this channel',
    options: [
      IDENTITY('Persona to grant access to'),
      {
        name: 'level',
        description: 'read = view+history; write = +send/react/attach; full = +manage (default)',
        choices: ['read', 'write', 'full'],
      },
    ],
  },
  {
    name: 'remove',
    description: 'Remove an identity’s direct grant for this channel',
    options: [IDENTITY('Persona to remove from this channel')],
  },
  {
    name: 'list',
    description: 'List identities with access to this channel',
    options: [],
  },
  {
    name: 'add-role',
    description: 'Assign a portal access role to an identity',
    options: [
      IDENTITY('Persona to assign the role to'),
      { name: 'role', description: 'Access role from the catalog', required: true, autocomplete: true },
    ],
  },
  {
    name: 'remove-role',
    description: 'Remove a portal access role from an identity',
    options: [
      IDENTITY('Persona to remove the role from'),
      { name: 'role', description: 'Access role the persona holds', required: true, autocomplete: true },
    ],
  },
  {
    name: 'invite',
    description: 'Mint a single-use enrollment invite granting access roles',
    options: [
      { name: 'role', description: 'Access role the new persona will hold', required: true, autocomplete: true },
      { name: 'role2', description: 'Additional access role', autocomplete: true },
      { name: 'role3', description: 'Additional access role', autocomplete: true },
      { name: 'label', description: 'Human label for the invite (who is this for?)' },
    ],
  },
  {
    name: 'ban',
    description: 'Strip an identity’s access in this guild (roles + direct grants)',
    options: [IDENTITY('Persona to strip of all access in this guild')],
  },
  {
    name: 'caps',
    description: 'Show an identity’s effective capabilities in this channel, and why',
    options: [IDENTITY('Persona to inspect')],
  },
  {
    name: 'resync',
    description: 'Re-push the full channel/rights set to a connected identity',
    options: [IDENTITY('Persona to resync')],
  },
];

// ── Capability presets ──

const READ_CAPS: Capability[] = ['VIEW_CHANNEL', 'READ_HISTORY'];
const WRITE_CAPS: Capability[] = [
  ...READ_CAPS,
  'SEND_MESSAGES',
  'SEND_IN_THREADS',
  'CREATE_THREADS',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'EDIT_OWN',
  'DELETE_OWN',
];
const FULL_CAPS: Capability[] = [...WRITE_CAPS, 'MANAGE_MESSAGES'];
export const LEVEL_CAPS: Record<string, Capability[]> = {
  read: READ_CAPS,
  write: WRITE_CAPS,
  full: FULL_CAPS,
};

/** Render a caps set as its level name when it matches one, else the raw list. */
function capsLabel(caps: readonly Capability[]): string {
  const set = new Set(caps);
  for (const [level, levelCaps] of Object.entries(LEVEL_CAPS).reverse()) {
    if (levelCaps.length === set.size && levelCaps.every((c) => set.has(c))) return level;
  }
  return caps.join(', ') || 'none';
}

// ── Handler ──

export interface SlashDeps {
  identity: { get(id: string): PersonaIdentity | undefined; all(): PersonaIdentity[] };
  permissions: PermissionsStore;
  invites?: InviteStore;
  audit?: AuditLog;
  superadmins: string[];
  capsFor(personaId: string, channelId: string, guildId: string): Capability[];
  canAccessGuild(personaId: string, guildId: string): boolean;
  /** Re-push the full channel set to a persona; returns channels pushed. */
  resync(personaId: string): number;
  newInviteCode(): string;
}

export class SlashHandler {
  constructor(private deps: SlashDeps) {}

  handle(inv: SlashInvocation): string {
    if (!this.authorized(inv.invoker)) {
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
      this.audit(inv, `slash.${inv.command}`, inv.options.identity, false, {
        error: (err as Error).message,
      });
      return `Failed: ${(err as Error).message}`;
    }
  }

  private authorized(invoker: SlashInvoker): boolean {
    return invoker.hasManageGuild || this.deps.superadmins.includes(invoker.id);
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

  /** Resolve the identity option or produce the error reply. */
  private target(inv: SlashInvocation): PersonaIdentity | string {
    const id = inv.options.identity ?? '';
    const persona = this.deps.identity.get(id);
    return persona ?? `No such identity: \`${id}\``;
  }

  // ── Commands ──

  private add(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const level = inv.options.level && LEVEL_CAPS[inv.options.level] ? inv.options.level : 'full';
    this.deps.permissions.setChannel(persona.id, inv.guildId, inv.channelId, LEVEL_CAPS[level]);
    const effective = this.deps.capsFor(persona.id, inv.channelId, inv.guildId);
    this.audit(inv, 'slash.add', persona.id, true, { level });
    return (
      `Granted **${persona.displayName}** (\`${persona.id}\`) ${level} access to #${inv.channelName}.\n` +
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
    if (!role) return `No such access role: \`${name}\``;
    const roles = this.deps.permissions.addPersonaRoles(persona.id, [name]);
    this.audit(inv, 'slash.add-role', persona.id, true, { role: name });
    return `**${persona.displayName}** now holds \`${name}\` (all roles: ${roles.map((r) => `\`${r}\``).join(', ')}).`;
  }

  private removeRole(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    const name = inv.options.role ?? '';
    if (!this.deps.permissions.getRoleNames(persona.id).includes(name)) {
      return `**${persona.displayName}** doesn’t hold \`${name}\`.`;
    }
    const roles = this.deps.permissions.removePersonaRole(persona.id, name);
    this.audit(inv, 'slash.remove-role', persona.id, true, { role: name });
    return `Removed \`${name}\` from **${persona.displayName}** (remaining: ${roles.map((r) => `\`${r}\``).join(', ') || 'none'}).`;
  }

  private invite(inv: SlashInvocation): string {
    if (!this.deps.invites) return 'Invites are not configured on this relay (PORTAL_INVITES).';
    const names = [inv.options.role, inv.options.role2, inv.options.role3].filter(
      (r): r is string => !!r,
    );
    const unknown = names.filter((n) => !this.deps.permissions.getRole(n));
    if (unknown.length) return `No such access role${unknown.length === 1 ? '' : 's'}: ${unknown.map((n) => `\`${n}\``).join(', ')}`;
    const code = this.deps.newInviteCode();
    this.deps.invites.mint({
      code,
      label: inv.options.label ?? `slash-invite by ${inv.invoker.name}`,
      roles: [...new Set(names)],
      maxUses: 1,
    });
    this.audit(inv, 'slash.invite', code, true, { roles: names, label: inv.options.label });
    return (
      `Single-use invite minted (roles: ${names.map((n) => `\`${n}\``).join(', ')}):\n\`${code}\`\n` +
      `This message is only visible to you — hand the code to the enrolling agent.`
    );
  }

  private ban(inv: SlashInvocation): string {
    const persona = this.target(inv);
    if (typeof persona === 'string') return persona;
    // Guild-scoped access roles off, inline guild policy pinned to deny.
    const guildRoles = this.deps.permissions
      .getRoleNames(persona.id)
      .filter((name) => this.deps.permissions.getRole(name)?.guildId === inv.guildId);
    for (const name of guildRoles) this.deps.permissions.removePersonaRole(persona.id, name);
    this.deps.permissions.clearGuild(persona.id, inv.guildId);
    const residual = this.deps.permissions
      .getRoleNames(persona.id)
      .filter((name) => {
        const role = this.deps.permissions.getRole(name);
        return role && !role.guildId; // catalog roles without a guild binding could still apply
      });
    this.audit(inv, 'slash.ban', persona.id, true, { rolesRemoved: guildRoles });
    return (
      `Banned **${persona.displayName}** (\`${persona.id}\`) from this guild: ` +
      `removed role${guildRoles.length === 1 ? '' : 's'} ${guildRoles.map((r) => `\`${r}\``).join(', ') || '(none held)'} and denied all direct grants.` +
      (residual.length
        ? `\n⚠️ Still holds guild-unbound role${residual.length === 1 ? '' : 's'}: ${residual.map((r) => `\`${r}\``).join(', ')} — check their scope.`
        : '')
    );
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
    if (req.option === 'identity') return this.identityChoices(req);
    if (req.option === 'role' || req.option === 'role2' || req.option === 'role3') {
      return this.roleChoices(req);
    }
    return [];
  }

  /** Target dropdowns narrow to plausible targets: channel-access holders for
   *  remove/caps, guild-access holders for ban/resync/remove-role, everyone
   *  for add/add-role (the target typically lacks access there). */
  private identityChoices(req: AutocompleteRequest): SlashChoice[] {
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

  /** Role dropdowns: catalog roles usable in this guild; for remove-role,
   *  narrowed to what the (already chosen) persona actually holds. */
  private roleChoices(req: AutocompleteRequest): SlashChoice[] {
    const q = req.partial.toLowerCase();
    let names = Object.entries(this.deps.permissions.allRoles())
      .filter(([, role]: [string, AccessRole]) => !role.guildId || role.guildId === req.guildId)
      .map(([name]) => name);
    if (req.command === 'remove-role' && req.options.identity) {
      const held = new Set(this.deps.permissions.getRoleNames(req.options.identity));
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
    return this.deps.permissions.getRoleNames(personaId).filter((name) => {
      const role = this.deps.permissions.getRole(name);
      if (!role) return false;
      if (role.guildId && role.guildId !== guildId) return false;
      // A role contributes if removing everything else still leaves caps — cheap
      // approximation: does a synthetic entry with only this role see the channel?
      return this.deps.permissions
        .resolveForRoles([name], guildId, channelId)
        .has('VIEW_CHANNEL');
    });
  }
}
