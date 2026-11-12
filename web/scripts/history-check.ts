// Manual check (needs the network, so it is not part of CI):
//   npx tsx scripts/history-check.ts
// Compares the browser's player-history factors, built from the players' public match
// histories, with the pipeline's values stored in the parity fixtures (built from the lake).
// They use different sources, so small differences are expected.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiMatch, Priors } from "../src/wp/features";
import { playerHistory } from "../src/wp/history";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "wp", "fixtures");
const read = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const priors: Priors = read(join(fx, "priors.json"));
for (const f of readdirSync(fx).filter((n) => /^\d+\.json$/.test(n))) {
  const { metadata, history } = read(join(fx, f)) as { metadata: ApiMatch; history: Record<string, number> };
  const start = typeof metadata.start_time === "number" ? metadata.start_time : Date.parse(metadata.start_time) / 1000;
  const got = await playerHistory(metadata.players.map((p) => ({ team: p.team === 0 || (p.team as unknown) === "Team0" ? 0 : 1, hero: p.hero_id, account: p.account_id })), start, priors);
  console.log(`${f}: ${got.loaded}/${got.players} histories loaded`);
  for (const k of Object.keys(history)) console.log(`   ${k.padEnd(16)} browser ${got.row[k].toFixed(3).padStart(9)}   pipeline ${history[k].toFixed(3).padStart(9)}`);
}
