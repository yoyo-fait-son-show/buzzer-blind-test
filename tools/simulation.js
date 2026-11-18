// ============================================================
//  Simulation : N fausses équipes qui buzzent, pour répéter
//  la soirée avant le jour J.
//
//  node tools/simulation.js <adresse> [nombre]
//    ex. node tools/simulation.js https://mon-buzzer.onrender.com 300
//
//  Les fausses équipes s'inscrivent puis buzzent toutes seules pendant
//  l'extrait, chacune au bout d'un temps différent.
//  Après la répétition : Réglages > « Tout effacer ».
//
//  Options de test (développeur) :
//    --key=CODE      pilote aussi la régie automatiquement
//    --rounds=3      nombre d'extraits joués en mode automatique
//    --lag           simule une latence 4G irrégulière (montante et descendante)
// ============================================================
'use strict';
const WebSocket = require('ws');
const { performance } = require('perf_hooks');

const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };
const flag = (n) => args.includes(`--${n}`);
const base = (args.find((a) => !a.startsWith('--')) || 'http://localhost:3000').replace(/\/+$/, '');
const N = parseInt(args.filter((a) => !a.startsWith('--'))[1] || '300', 10);
const KEY = opt('key', null);
const ROUNDS = parseInt(opt('rounds', '3'), 10);
const LAG = flag('lag');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

const trueNow = () => performance.timeOrigin + performance.now(); // même horloge que le serveur si même machine
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
// Temps mis à reconnaître le morceau puis à taper (log-normale, ~1 à 12 s)
const humanReaction = () => Math.min(20000, Math.exp(rand(Math.log(900), Math.log(12000))));

const stats = { registered: 0, buzzes: 0, falseStarts: 0, syncErr: [], intended: new Map(), msgs: 0 };

function makeBot(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const sync = { samples: [], offset: 0, ready: false };
    let roundSeen = null, intended = null;
    const up = (o) => { const s = JSON.stringify(o); if (LAG) setTimeout(() => ws.readyState === 1 && ws.send(s), rand(30, 220)); else ws.send(s); };
    const ping = () => up({ type: 'ping', c: performance.now() });
    const handle = (m) => {
      stats.msgs++;
      if (m.type === 'pong') {
        const rtt = performance.now() - m.c;
        sync.samples.push({ rtt, off: m.s - (m.c + rtt / 2) });
        let best = sync.samples[0]; for (const s of sync.samples) if (s.rtt < best.rtt) best = s;
        sync.offset = best.off; sync.ready = true;
      } else if (m.type === 'registered') {
        stats.registered++; resolve(ws);
      } else if (m.type === 'state') {
        if (m.roundId && m.roundId !== roundSeen && (m.phase === 'armed' || m.phase === 'open')) {
          roundSeen = m.roundId;
          // 80 % des équipes trouvent et buzzent, les autres laissent passer
          intended = Math.random() < 0.8 ? humanReaction() : null;
        }
        if (m.phase === 'open' && m.t0 && typeof intended === 'number' && !m.my) {
          const target = m.t0 + intended; // heure serveur visée
          const id = m.roundId, want = intended; intended = 'sent';
          const wait = Math.max(0, target - (performance.now() + sync.offset));
          setTimeout(() => {
            const at = performance.now();
            const t = at + sync.offset;
            stats.syncErr.push(t - trueNow());
            stats.intended.set(`${m.roundNo}:${i}`, t - m.t0);
            stats.buzzes++;
            up({ type: 'buzz', round: id, t });
          }, wait);
        }
      }
    };
    ws.on('open', () => {
      up({ type: 'hello', role: 'player' });
      for (let k = 0; k < 6; k++) setTimeout(ping, k * 150);
      setInterval(ping, 8000);
      setTimeout(() => up({ type: 'register', name: `Équipe test ${String(i + 1).padStart(3, '0')}`, players: ['Joueur A', 'Joueur B', 'Joueur C'] }), 1000 + rand(0, 400));
    });
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (LAG) setTimeout(() => handle(m), rand(20, 120)); else handle(m); });
    ws.on('error', (e) => { console.error(`Équipe ${i + 1} : ${e.message}`); resolve(null); });
  });
}

async function admin() {
  const ws = new WebSocket(wsUrl);
  let st = null; const sync = { offset: 0, best: Infinity };
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'pong') { const rtt = performance.now() - m.c; if (rtt < sync.best) { sync.best = rtt; sync.offset = m.s - (m.c + rtt / 2); } }
    if (m.type === 'state') st = m;
    if (m.type === 'error') { console.error('Régie :', m.message); process.exit(1); }
  });
  ws.send(JSON.stringify({ type: 'hello', role: 'screen', key: KEY }));
  for (let k = 0; k < 6; k++) { ws.send(JSON.stringify({ type: 'ping', c: performance.now() })); await sleep(100); }
  const act = (action, extra = {}) => ws.send(JSON.stringify({ type: 'admin', action, t: performance.now() + sync.offset, ...extra }));
  return { act, get st() { return st; } };
}

(async () => {
  console.log(`Connexion de ${N} fausses équipes à ${base}${LAG ? ' (latence 4G simulée)' : ''}…`);
  const t0 = Date.now();
  const bots = [];
  for (let i = 0; i < N; i++) { bots.push(makeBot(i)); if (i % 25 === 24) await sleep(150); }
  await Promise.all(bots);
  console.log(`${stats.registered} équipes inscrites en ${((Date.now() - t0) / 1000).toFixed(1)} s.`);

  if (!KEY) { console.log('Les équipes buzzent toutes seules pendant chaque extrait. Ctrl+C pour arrêter.'); return; }

  const reg = await admin();
  await sleep(800);
  for (let r = 0; r < ROUNDS; r++) {
    reg.act('arm'); await sleep(22000);   // l'extrait tourne, les équipes buzzent pendant ce temps
    reg.act('close'); await sleep(1200);
    const s = reg.st;
    // Vérifie que le serveur a calculé les mêmes temps que ceux mesurés par les bots
    let maxDiff = 0;
    for (const e of s.entries) {
      const i = parseInt(e.name.match(/(\d+)$/)[1], 10) - 1;
      const want = stats.intended.get(`${s.roundNo}:${i}`);
      if (want !== undefined) maxDiff = Math.max(maxDiff, Math.abs(want - e.reaction));
    }
    const sorted = s.entries.every((e, k, a) => k === 0 || a[k - 1].reaction <= e.reaction);
    console.log(`Extrait ${s.roundNo} : ${s.entries.length} buzz, ${s.falseStarts} refusés, classement trié : ${sorted ? 'oui' : 'NON'}, écart max serveur/bots : ${maxDiff.toFixed(1)} ms`);
    if (s.entries.length >= 2) { reg.act('verdict', { roundNo: s.roundNo, teamId: s.entries[0].teamId, verdict: 'ko' }); reg.act('verdict', { roundNo: s.roundNo, teamId: s.entries[1].teamId, verdict: 'ok' }); }
    await sleep(600);
  }
  await sleep(800);
  const s = reg.st;
  const err = stats.syncErr.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => err[Math.min(err.length - 1, Math.floor(p * err.length))];
  console.log(`Erreur de synchro d'horloge (écart absolu) : médiane ${q(0.5).toFixed(1)} ms, 95 % < ${q(0.95).toFixed(1)} ms, max ${err[err.length - 1].toFixed(1)} ms`);
  console.log(`Top 3 du classement : ${s.board.slice(0, 3).map((x) => `${x.rank}. ${x.name} (${x.points} pts)`).join(' | ')}`);
  console.log(`Messages reçus par les bots : ${stats.msgs}`);
  process.exit(0);
})();
