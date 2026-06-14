#!/usr/bin/env node
// Mint (or list) portal invite templates — admin tool.
//
// An invite is an access-rights template: a reusable code that lets new agents
// self-register a persona, each stamped with the same capability profile.
//
// Usage:
//   node scripts/mint-invite.mjs --file invites.json \
//        [--label claude-code] \
//        [--caps VIEW_CHANNEL,READ_HISTORY,SEND_MESSAGES,SEND_IN_THREADS,ADD_REACTIONS,EDIT_OWN,DELETE_OWN] \
//        [--subscriptions <chanId>,<chanId>] \
//        [--max-uses 50] [--expires-in-days 30] [--code <explicit-code>]
//
//   node scripts/mint-invite.mjs --file invites.json --list
//
// The file is created if missing. Prints the new invite code to stdout.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEFAULT_CAPS = [
  'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS',
  'ADD_REACTIONS', 'EDIT_OWN', 'DELETE_OWN',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const file = arg('file', process.env.PORTAL_INVITES);
if (!file) {
  console.error('error: --file <path> (or PORTAL_INVITES) is required');
  process.exit(1);
}

const data = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { invites: [] };
if (!Array.isArray(data.invites)) data.invites = [];

if (flag('list')) {
  for (const inv of data.invites) {
    const cap = inv.maxUses !== undefined ? `${inv.uses ?? 0}/${inv.maxUses}` : `${inv.uses ?? 0}/∞`;
    const exp = inv.expiresAt ? `expires ${inv.expiresAt}` : 'no expiry';
    console.log(`${inv.code}  [${inv.label ?? '-'}]  uses ${cap}  ${exp}  caps=${(inv.caps ?? []).join(',')}`);
  }
  process.exit(0);
}

const code = arg('code') ?? `inv_${randomBytes(18).toString('base64url')}`;
if (data.invites.some((i) => i.code === code)) {
  console.error(`error: invite code already exists: ${code}`);
  process.exit(1);
}

const caps = (arg('caps') ?? DEFAULT_CAPS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const subscriptions = (arg('subscriptions') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const maxUses = arg('max-uses') ? parseInt(arg('max-uses'), 10) : undefined;
const expiresInDays = arg('expires-in-days') ? parseInt(arg('expires-in-days'), 10) : undefined;
const expiresAt = expiresInDays
  ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
  : undefined;

const invite = {
  code,
  label: arg('label', 'invite'),
  caps,
  ...(subscriptions.length ? { subscriptions } : {}),
  ...(maxUses !== undefined ? { maxUses } : {}),
  uses: 0,
  ...(expiresAt ? { expiresAt } : {}),
};

data.invites.push(invite);
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

console.error(`minted invite "${invite.label}" → ${file}`);
console.error(`  caps: ${caps.join(',')}`);
if (maxUses !== undefined) console.error(`  maxUses: ${maxUses}`);
if (expiresAt) console.error(`  expiresAt: ${expiresAt}`);
console.log(code);
