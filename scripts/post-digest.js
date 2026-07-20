// Atmos Nairobi daily AQI digest - GitHub Actions poster, v1.1 (20 Jul 2026).
// Runs on GitHub's servers (see .github/workflows/daily-digest.yml).
// Pipeline: AirQo cohort recent -> Nairobi box -> freshness filter -> fixed
// template -> post to Bluesky. Logic mirrors projects/aqi-digest-bot/bot.js.
//
// SAFETY RAILS (do not remove):
// - Fixed template only; the script cannot compose free text.
// - Skips entirely if fewer than 5 usable stations.
// - Skips if the post somehow exceeds 300 characters.
// - Anomalies (>150 ug/m3) are logged, never posted.
// - Won't post twice in one day (checks logs/digest-log.txt).
// - Won't post before 2026-07-13 (the public launch date).
//
// v1.1 reliability fix: the AirQo fetch now retries with a timeout and tolerates
// a bad or non-JSON response instead of crashing the run. If AirQo stays
// unreachable it logs a clear SKIPPED line (audit trail) and exits cleanly,
// the same way scripts/snapshot.js already copes with this flaky endpoint.
//
// Secrets come from the environment (GitHub repo secrets), never this file:
//   AIRQO_TOKEN, BSKY_HANDLE (atmosnairobi.bsky.social), BSKY_APP_PASSWORD

const fs = require('fs');

const START_DATE = '2026-07-13';
const LOG_FILE = 'logs/digest-log.txt';

const API = (token) =>
  `https://api.airqo.net/api/v2/devices/measurements/cohorts/64ca6a59e2e198001ed21c96/recent?token=${token}&limit=500`;

const REF = [
  ['Mukuru Health Centre',-1.3319,36.7865],['Martin Luther Primary',-1.2982,36.8768],
  ['Westlands Primary',-1.2563,36.7926],['Mama Lucy Hospital',-1.2698,36.9001],
  ['Lavington Primary',-1.2789,36.7700],['Riruta Satellite',-1.2881,36.7363],
  ['Kware',-1.2179,36.9079],['Juja Road',-1.2772,36.8396],
  ['Uhuru Estate Buruburu',-1.2852,36.8675],['Kayole',-1.2795,36.9206],
  ['Bahati',-1.2882,36.8675],['Cheleta Runda',-1.2180,36.8213],
  ['Kasarani',-1.2286,36.9284],['Dandora area',-1.2737,36.8859],
  ['Mbagathi Way',-1.3085,36.7971],['Ushirika Dandora',-1.2440,36.9086],
  ['St Marys Karen',-1.3239,36.7160],['Nairobi West',-1.3043,36.8212],
  ['Marurui',-1.2068,36.8665],['Visa Oshwal Parklands',-1.2569,36.8102],
  ['Kayole 1',-1.2630,36.9241],['Karura',-1.2481,36.8452],
  ['St Georges',-1.2790,36.7953],['Nairobi River School',-1.2742,36.8795],
  ['Kihumbuini Kangemi',-1.2615,36.7482],['Manyatta',-1.2842,37.0241],
  ['Supaloaf Umoja',-1.2710,36.8973],['Njiru',-1.2458,36.9366],
  ['Githurai',-1.1976,36.9140],['Mihango',-1.2745,36.9538],
  ['Drumvale',-1.2930,37.0416],['Kiwanja Kahawa',-1.1654,36.9244],
  ['Huruma',-1.2551,36.8763],['Uhuru Gardens',-1.3230,36.8839],
  ['Woodley',-1.3116,36.7792],['Langata Rd',-1.3130,36.8144],
  ['Tumaini Donholm',-1.2806,36.9003],['Mutuini Dagoretti',-1.2985,36.6904],
  ['Kabete Vetlab',-1.2680,36.7215],['Maua',-1.2550,36.9523],
  ['Valley Bridge Mathare',-1.2516,36.8733],['Lower Kabete',-1.2380,36.7428],
  ['CBD',-1.2864,36.8172],
];

const inNairobi = (la, ln) =>
  la != null && ln != null && la > -1.55 && la < -1.05 && ln > 36.55 && ln < 37.15;

const areaName = (la, ln) => {
  let best = null, bd = Infinity;
  for (const [name, rla, rln] of REF) {
    const d = (la - rla) ** 2 + (ln - rln) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return bd < 0.00035 ? best : la.toFixed(2) + ',' + ln.toFixed(2); // ~2km
};

const tip = (mean) =>
  mean > 55 ? 'Everyone: cut back outdoor exertion today.'
  : mean > 35 ? 'Kids with asthma: limit time outside.'
  : mean > 15 ? 'Sensitive groups: take it easy outdoors.'
  : 'A good day for outdoor play.';

// Resilient fetch: retries with a per-attempt timeout, and turns a non-ok or
// non-JSON response into a clear error instead of crashing on .json(). This is
// the whole point of v1.1 - a single AirQo hiccup no longer kills the post.
async function fetchJson(url, fetchFn = fetch, tries = 4, timeoutMs = 40000) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.text();
      try {
        return JSON.parse(body);
      } catch (_) {
        throw new Error('non-JSON response: ' + body.slice(0, 60).replace(/\s+/g, ' '));
      }
    } catch (e) {
      lastErr = e;
      if (i < tries) await new Promise((res) => setTimeout(res, 20000));
    }
  }
  throw lastErr;
}

async function buildDigest(token, fetchFn = fetch) {
  let j;
  try {
    j = await fetchJson(API(token), fetchFn);
  } catch (e) {
    return { ok: false, reason: 'AirQo unreachable after retries: ' + e.message };
  }
  const rows = (j.measurements || [])
    .filter((x) => x.deviceDetails && x.pm2_5 && x.pm2_5.value != null
      && inNairobi(x.deviceDetails.latitude, x.deviceDetails.longitude))
    .map((x) => ({
      area: areaName(x.deviceDetails.latitude, x.deviceDetails.longitude),
      v: x.pm2_5.value,
      t: x.time,
    }));
  const fresh = rows.filter((r) => (Date.now() - new Date(r.t)) / 3.6e6 < 24);
  const use = fresh.length >= 8 ? fresh : rows;
  if (use.length < 5) return { ok: false, reason: 'too few stations (' + use.length + ')' };
  const mean = use.reduce((a, b) => a + b.v, 0) / use.length;
  const sorted = use.slice().sort((a, b) => b.v - a.v);
  const worst = sorted[0], best = sorted[sorted.length - 1];
  const post =
    `Nairobi air today: PM2.5 averages ${mean.toFixed(0)} ug/m3 across ` +
    `${use.length} stations, ${(mean / 15).toFixed(1)}x the WHO daily guideline. ` +
    `Highest: ${worst.area} (${worst.v.toFixed(0)}). Lowest: ${best.area} ` +
    `(${best.v.toFixed(0)}). ${tip(mean)} Data: AirQo`;
  const anomalies = sorted.filter((r) => r.v > 150).map((r) => r.area + ' ' + r.v.toFixed(0));
  return { ok: true, post, stations: use.length, anomalies };
}

async function postToBluesky(handle, appPassword, text) {
  const s = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  }).then((r) => r.json());
  if (!s.accessJwt) throw new Error('Bluesky login failed: ' + JSON.stringify(s).slice(0, 200));
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.accessJwt },
    body: JSON.stringify({
      repo: s.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        langs: ['en'],
      },
    }),
  }).then((r) => r.json());
  if (!res.uri) throw new Error('Bluesky post failed: ' + JSON.stringify(res).slice(0, 200));
  return res.uri;
}

// EAT = UTC+3, no DST.
const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

async function main() {
  const today = todayEAT();
  const log = (line) => {
    fs.mkdirSync('logs', { recursive: true });
    fs.appendFileSync(LOG_FILE, `${today} ${new Date().toISOString().slice(11, 16)}Z ${line}\n`);
    console.log(line);
  };

  if (today < START_DATE) { console.log(`Before launch date ${START_DATE}; not posting.`); return; }

  const prior = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  if (prior.split('\n').some((l) => l.startsWith(today) && l.includes('POSTED'))) {
    console.log('Already posted today; skipping.'); return;
  }

  const d = await buildDigest(process.env.AIRQO_TOKEN);
  if (!d.ok) { log(`SKIPPED: ${d.reason}`); return; }
  if (d.post.length > 300) { log(`SKIPPED: post too long (${d.post.length} chars)`); return; }
  if (d.anomalies.length) log(`ANOMALY (logged, never posted): ${d.anomalies.join('; ')}`);

  const uri = await postToBluesky(process.env.BSKY_HANDLE, process.env.BSKY_APP_PASSWORD, d.post);
  log(`POSTED (${d.stations} stations) ${uri} :: ${d.post}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
