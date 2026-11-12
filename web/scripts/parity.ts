// Parity test: the browser's row builder and model runner must give the same
// win chances as the pipeline for the fixture matches (web/src/wp/fixtures,
// written by `python -m pipeline.export_web --fixtures`).
//   npm run test:parity
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchRows, type ApiMatch, type Priors } from "../src/wp/features";
import { features, predict, type WebModel } from "../src/wp/model";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (p: string) => JSON.parse(readFileSync(p, "utf-8"));
const full: WebModel = read(join(root, "data", "web", "win_model.json"));
const live: WebModel = read(join(root, "data", "web", "win_model_live.json"));
const fx = join(root, "web", "src", "wp", "fixtures");
const priors: Priors = read(join(fx, "priors.json"));
const TOL = 0.005;                 // half a percentage point

let worst = 0, failed = false;
for (const f of readdirSync(fx).filter((n) => /^\d+\.json$/.test(n))) {
  const { metadata, expected } = read(join(fx, f)) as { metadata: ApiMatch; expected: { minute: number; p: number; p_live: number; features: Record<string, number> }[] };
  const got = matchRows(metadata, priors);
  if (got.length !== expected.length) { console.error(`${f}: ${got.length} minutes, expected ${expected.length}`); failed = true; continue; }
  let dMax = 0, dLive = 0, where = "";
  got.forEach((g, i) => {
    const e = expected[i];
    const dp = Math.abs(predict(full, g.row) - e.p), dl = Math.abs(predict(live, g.row) - e.p_live);
    if (dp > dMax) {
      dMax = dp;
      const x = features(full, g.row);
      const off = full.feats.map((name, k) => ({ name, got: x[k], want: e.features[name] }))
        .filter((v) => Math.abs(v.got - v.want) > 1e-3 * Math.max(1, Math.abs(v.want)));
      where = `minute ${e.minute}: ${off.slice(0, 6).map((v) => `${v.name} ${v.got.toFixed(3)} vs ${v.want}`).join("; ") || "features match"}`;
    }
    dLive = Math.max(dLive, dl);
  });
  worst = Math.max(worst, dMax, dLive);
  const ok = dMax <= TOL && dLive <= TOL;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${f}: ${got.length} minutes, max |dp| full ${dMax.toFixed(5)}, live ${dLive.toFixed(5)}${ok ? "" : ` (${where})`}`);
}
console.log(`worst difference ${worst.toFixed(5)} (tolerance ${TOL})`);
process.exit(failed ? 1 : 0);
