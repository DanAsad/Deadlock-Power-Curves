// Manual check of the live-broadcast reader against a real match in progress:
//   npx tsx scripts/stream-check.ts [match_id] [extra readings, 30 s apart]
// Without an id it takes a match from the API's featured list. Prints one reading, the
// model row and the win chance, plus the player-history factors. Needs the network.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newObjectiveEvents, streamRow, type PastLead, type Priors } from "../src/wp/features";
import { playerHistory } from "../src/wp/history";
import { predict, type WebModel } from "../src/wp/model";
import { readMatch } from "../src/wp/stream";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));
const priors: Priors = read("data/web/priors.json");
let model: WebModel;
try { model = read("data/web/win_model_stream.json"); } catch { model = read("data/web/win_model.json"); console.log("(stream model not exported yet: using the full model)"); }

let id = Number(process.argv[2]);
let listed: { net_worth_team_0: number; net_worth_team_1: number; start_time: number } | undefined;
if (!id) {
  const act = await (await fetch("https://api.deadlock-api.com/v1/matches/active")).json();
  const urls = await (await fetch("https://api.deadlock-api.com/v1/matches/live/urls")).json();
  const has = new Set(urls.map((u: { match_id: number }) => u.match_id));
  listed = act.filter((m: { game_mode: number; match_id: number; start_time: number }) => m.game_mode === 1 && has.has(m.match_id) && Date.now() / 1000 - m.start_time > 600)[0];
  id = (listed as unknown as { match_id: number }).match_id;
}
const t0 = Date.now();
const r = await readMatch(id, true);
console.log(`match ${id}: ${r.state}, clock ${(r.clockS / 60).toFixed(2)} min, ranked ${r.ranked}, ${r.players.length} players, read in ${Date.now() - t0} ms`);
if (listed) console.log(`  list: souls ${listed.net_worth_team_0}/${listed.net_worth_team_1}, age ${((Date.now() / 1000 - listed.start_time) / 60).toFixed(2)} min`);
for (const t of [0, 1]) console.log(`  team ${t}:`, r.players.filter((p) => p.team === t).map((p) => `${p.hero}:${p.souls}${p.alive ? "" : `(dead ${p.respawnS.toFixed(0)}s)`}`).join(" "));
console.log("  destroyed [objective id, owner]:", JSON.stringify(r.destroyed), "patron hp", r.patron);
const hist = await playerHistory(r.players.map((p) => ({ team: p.team, hero: p.hero, account: p.account })), Date.now() / 1000, priors);
console.log(`  history: ${hist.loaded}/${hist.players} players`, hist.row);
const row = streamRow(r, [], priors, hist.row);
console.log("  row:", Object.fromEntries(Object.entries(row).map(([k, v]) => [k, +v.toFixed(2)])));
console.log(`  win chance team 0: ${(predict(model, row) * 100).toFixed(1)}%  (without history ${(predict(model, streamRow(r, [], priors)) * 100).toFixed(1)}%)`);

// more readings, as the tracking panel takes them: momentum and objective events come from these
const past: PastLead[] = [{ clockS: r.clockS, souls: row.souls }];
let known = r.destroyed ?? [];
for (let i = 0; i < Number(process.argv[3] ?? 0); i++) {
  await new Promise((ok) => setTimeout(ok, 30000));
  const t = Date.now();
  const x = await readMatch(id, false);
  const xr = streamRow(x, past, priors, hist.row, known);
  const ev = x.destroyed ? newObjectiveEvents(known, x.destroyed, x.clockS) : [];
  if (x.destroyed) known = x.destroyed;
  past.push({ clockS: x.clockS, souls: xr.souls });
  console.log(`  +${i + 1}: ${x.state} clock ${(x.clockS / 60).toFixed(2)} | souls ${xr.souls} | momentum ${xr.momentum.toFixed(0)} | dead ${xr.enemies_dead} | ` +
    `win chance ${(predict(model, xr) * 100).toFixed(1)}% | ${Date.now() - t} ms${ev.length ? " | " + ev.map((e) => `${e.label} taken by team ${e.by}`).join(", ") : ""}`);
}
