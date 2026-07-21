// fetch-context.mjs — page fetch_history backwards from a message, dump to disk.
// Usage: node fetch-context.mjs <channelId> <beforeSnowflake> <targetTokens> <outDir>
import { PortalClient } from '@animalabs/portal-client';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [channelId, startBefore, targetTokensArg, outDir] = process.argv.slice(2);
const targetTokens = Number(targetTokensArg ?? 600_000);
mkdirSync(outDir, { recursive: true });

const credsName = process.env.PORTAL_CREDS_NAME ?? 'claude-code';
const creds = JSON.parse(readFileSync(join(homedir(), '.portal', `${credsName}.creds.json`), 'utf8'));
const client = new PortalClient({
  url: process.env.PORTAL_URL ?? 'wss://portal.animalabs.ai',
  token: creds.token,
  personaId: creds.personaId,
  rpcTimeoutMs: 30_000,
});

const estTokens = (s) => Math.ceil(s.length / 4); // chars/4 heuristic

function fmt(m) {
  const author = m.author?.displayName ?? m.author?.name ?? m.author?.username ?? m.author?.id ?? 'unknown';
  const ts = m.createdAt ?? '';
  let out = `[${ts}] ${author}:`;
  if (m.replyToId) out += ` (reply to ${m.replyToId})`;
  out += ` ${m.cleanContent ?? m.content ?? ''}`;
  if (m.attachments?.length) {
    out += '\n' + m.attachments.map((a) => `    [attachment: ${a.filename ?? a.name ?? a.url ?? 'file'}]`).join('\n');
  }
  if (m.reactions?.length) {
    out += `\n    [reactions: ${m.reactions.map((r) => `${r.emoji}×${r.count ?? r.actors?.length ?? 1}`).join(' ')}]`;
  }
  return out;
}

await client.connect();
console.error(`[fetch-context] connected as ${creds.personaId}`);

const rawPath = join(outDir, 'raw.jsonl');
writeFileSync(rawPath, '');

let before = startBefore;
let total = 0;
let tokens = 0;
let batches = []; // arrays of messages, newest batch first
let calls = 0;

while (tokens < targetTokens) {
  calls++;
  let res;
  try {
    res = await client.fetchHistory({ channelId, limit: 100, before });
  } catch (err) {
    console.error(`[fetch-context] fetch failed at before=${before}: ${err.message}`);
    break;
  }
  const msgs = (res.messages ?? []).slice();
  if (!msgs.length) {
    console.error('[fetch-context] reached start of channel history');
    break;
  }
  // sort ascending by snowflake to be order-agnostic
  msgs.sort((a, b) => (BigInt(a.nativeId) < BigInt(b.nativeId) ? -1 : 1));
  for (const m of msgs) appendFileSync(rawPath, JSON.stringify(m) + '\n');
  batches.push(msgs);
  total += msgs.length;
  tokens += msgs.reduce((acc, m) => acc + estTokens(fmt(m)) + 1, 0);
  before = msgs[0].nativeId; // oldest of this batch
  if (calls % 10 === 0 || tokens >= targetTokens) {
    console.error(`[fetch-context] ${total} msgs, ~${Math.round(tokens / 1000)}k tokens, cursor ${before} (${msgs[0].createdAt})`);
  }
}

// batches are newest→oldest; reverse for chronological transcript
batches.reverse();
const lines = [];
for (const msgs of batches) for (const m of msgs) lines.push(fmt(m));
const transcript = lines.join('\n');
writeFileSync(join(outDir, 'transcript.txt'), transcript + '\n');

const oldest = batches[0]?.[0];
const newestBatch = batches[batches.length - 1];
const newest = newestBatch?.[newestBatch.length - 1];
console.log(JSON.stringify({
  messages: total,
  estTokens: tokens,
  rpcCalls: calls,
  oldest: oldest ? { id: oldest.nativeId, at: oldest.createdAt } : null,
  newest: newest ? { id: newest.nativeId, at: newest.createdAt } : null,
  transcript: join(outDir, 'transcript.txt'),
  raw: rawPath,
  bytes: transcript.length,
}, null, 2));
client.close?.();
process.exit(0);
