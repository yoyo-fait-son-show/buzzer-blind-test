// ============================================================
//  BUZZER BLIND TEST XXL — BBV
//  Serveur temps réel : inscriptions, buzz, temps de réaction,
//  points et classement général.
//  Lancement : npm install  puis  npm start
// ============================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

// ---------- Réglages (variables d'environnement) ----------
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_KEY = (process.env.ADMIN_KEY || randomCode(6)).trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'partie.json');
const MAX_TEAMS = parseInt(process.env.MAX_TEAMS || '600', 10);

// Tolérances de mesure
const MAX_BUZZ_AGE = 10000; // un buzz envoyé hors connexion reste valable 10 s
const FUTURE_SLACK = 80;    // un horodatage ne peut pas être dans le futur

// Joker
const JOKER_BONUS = 1;          // points du choix « +1 »
const MAX_JOKERS_PER_TEAM = 20; // garde-fou pour le bouton « donner un joker »
const JOKER_CHOICES = ['plus', 'defi'];
// Mot de passe joker : majuscules, accents, espaces et ponctuation ne comptent pas
const normPass = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Horloge serveur monotone (ms)
const now = () => performance.timeOrigin + performance.now();

function randomCode(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(n)) s += chars[b % chars.length];
  return s;
}
const isAdminKey = (k) => String(k || '').trim().toUpperCase() === ADMIN_KEY.toUpperCase();
const newId = () => crypto.randomBytes(5).toString('hex');
const newToken = () => crypto.randomBytes(18).toString('base64url');

// ---------- État de la partie ----------
const DEFAULT_SETTINGS = {
  title: 'BLIND TEST XXL — BBV',
  points: [10, 8, 6, 5, 4, 3, 2, 1],
  maxPlayers: 8,
  registrationOpen: true,
  boardHidden: false, // masque le classement sur les téléphones (finale à l'aveugle)
  jokerPassword: '',  // vide = pas de case « mot de passe joker » à l'inscription
  jokersOpen: true,   // les équipes peuvent utiliser leur joker (entre deux extraits)
};

let game = {
  phase: 'lobby',   // lobby | armed (musique) | open (buzzers ouverts) | closed (manche terminée)
  display: 'join',  // ce que montre l'écran projeté : join | round | board
  roundNo: 0,
  settings: { ...DEFAULT_SETTINGS },
  teams: {},        // id -> équipe (team.jokers = jetons encore disponibles)
  rounds: [],       // manches : { no, armedAt, t0, closedAt, entries: { teamId: entrée } }
  jokerUses: [],    // jokers utilisés : { id, teamId, choice: plus|defi, at, roundNo, status: pending|done|cancelled }
};

const tokens = new Map(); // token -> teamId
let totals = new Map();   // teamId -> { points, correct, bestTime }
let board = [];           // classement général trié

function currentRound() {
  return game.rounds.length ? game.rounds[game.rounds.length - 1] : null;
}

// ---------- Sauvegarde ----------
// 1) fichier partie.json sur le serveur (suffit si le serveur garde ses fichiers) ;
// 2) copie envoyée en continu à l'écran de régie, qui la garde dans son navigateur
//    et la renvoie automatiquement si l'hébergeur redémarre le serveur à vide.
const BOOT_ID = newId();
const BOOT_TIME = Date.now();
const RESTORE_WINDOW = 120000; // 2 min après un démarrage à vide
let loadedFromFile = false, restored = false;
let saveDirty = false, backupDirty = true;

function applyState(raw) {
  game = { ...game, ...raw, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) } };
  // Sauvegardes d'avant le joker : pas de jetons, pas d'historique
  game.jokerUses = Array.isArray(raw.jokerUses) ? raw.jokerUses : [];
  for (const t of Object.values(game.teams)) if (!(t.jokers >= 0)) t.jokers = 0;
  if (game.phase === 'armed' || game.phase === 'open') {
    game.phase = 'closed';
    const r = currentRound();
    if (r && !r.closedAt) r.closedAt = now();
  }
  tokens.clear();
  for (const t of Object.values(game.teams)) if (!t.removed) tokens.set(t.token, t.id);
}
function load() {
  try {
    applyState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    loadedFromFile = true;
    console.log(`Partie rechargée : ${Object.keys(game.teams).length} équipes, ${game.rounds.length} extraits.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Lecture de la sauvegarde impossible :', e.message);
  }
}
// Le serveur vient de démarrer sans sauvegarde : on laisse le temps à la régie de restaurer
function restoreWindowOpen() {
  return !loadedFromFile && !restored && Date.now() - BOOT_TIME < RESTORE_WINDOW;
}
function restoreFrom(data) {
  if (!data || typeof data !== 'object' || typeof data.teams !== 'object' || !Array.isArray(data.rounds)) throw new Error('Sauvegarde invalide');
  // On garde les équipes inscrites depuis le redémarrage
  const since = Object.values(game.teams).filter((t) => !data.teams[t.id]);
  const sinceIds = new Set(since.map((t) => t.id));
  const sinceUses = game.jokerUses.filter((u) => sinceIds.has(u.teamId));
  applyState({ ...data, teams: { ...data.teams } });
  for (const t of since) { game.teams[t.id] = t; if (!t.removed) tokens.set(t.token, t.id); }
  game.jokerUses.push(...sinceUses);
  restored = true;
  recomputeTotals();
  for (const ws of sockets) ws.lastJson = null;
  markDirty();
}
function save() {
  if (!saveDirty) return;
  saveDirty = false;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(game), (err) => {
    if (err) return console.error('Sauvegarde impossible :', err.message);
    fs.rename(tmp, DATA_FILE, () => {});
  });
}
setInterval(save, 2000);

// ---------- Calculs : rangs, points, classement ----------
function pointsFor(rank) {
  const p = game.settings.points;
  if (!p.length) return 0;
  return p[Math.min(rank, p.length) - 1];
}

// Entrées d'une manche triées par temps de réaction (faux départs exclus)
function rankedEntries(round) {
  const valid = [];
  for (const e of Object.values(round.entries)) {
    if (e.state === 'valid' && game.teams[e.teamId] && !game.teams[e.teamId].removed) valid.push(e);
  }
  valid.sort((a, b) => a.reaction - b.reaction || a.recvAt - b.recvAt);
  valid.forEach((e, i) => { e.rank = i + 1; });
  return valid;
}

function recomputeTotals() {
  totals = new Map();
  for (const id of Object.keys(game.teams)) totals.set(id, { points: 0, correct: 0, bestTime: null, bonus: 0 });
  for (const r of game.rounds) {
    for (const e of rankedEntries(r)) {
      if (e.verdict !== 'ok') continue;
      const t = totals.get(e.teamId);
      if (!t) continue;
      t.points += pointsFor(e.rank);
      t.correct += 1;
      if (t.bestTime === null || e.reaction < t.bestTime) t.bestTime = e.reaction;
    }
  }
  // Joker « +1 » validé par la régie
  for (const u of game.jokerUses) {
    if (u.choice !== 'plus' || u.status !== 'done') continue;
    const t = totals.get(u.teamId);
    if (!t) continue;
    t.points += JOKER_BONUS;
    t.bonus += JOKER_BONUS;
  }
  const list = Object.values(game.teams).filter((t) => !t.removed).map((t) => ({ team: t, ...totals.get(t.id) }));
  list.sort((a, b) =>
    b.points - a.points ||
    b.correct - a.correct ||
    (a.bestTime ?? Infinity) - (b.bestTime ?? Infinity) ||
    a.team.createdAt - b.team.createdAt);
  // Rang « sportif » : les ex æquo partagent la même place
  let prevKey = null, prevRank = 0;
  list.forEach((x, i) => {
    const key = `${x.points}|${x.correct}|${x.bestTime}`;
    x.rank = key === prevKey ? prevRank : i + 1;
    x.tied = false;
    prevKey = key; prevRank = x.rank;
  });
  for (let i = 0; i < list.length; i++) {
    if ((i > 0 && list[i - 1].rank === list[i].rank) || (i < list.length - 1 && list[i + 1].rank === list[i].rank)) list[i].tied = true;
  }
  board = list;
}

// ---------- Connexions ----------
const sockets = new Set();

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

let dirty = true;
function markDirty() { dirty = true; saveDirty = true; backupDirty = true; }

function sendBackup(ws) {
  send(ws, JSON.stringify({ type: 'backup', bootId: BOOT_ID, savedAt: Date.now(), data: game }));
}
// Pas pendant que les buzzers sont ouverts : priorité au temps réel
setInterval(() => {
  if (!backupDirty || game.phase === 'open') return;
  backupDirty = false;
  for (const ws of sockets) if (ws.role === 'screen' && ws.isAdmin) sendBackup(ws);
}, 5000);

function onlineTeamIds() {
  const s = new Set();
  for (const ws of sockets) if (ws.role === 'player' && ws.teamId) s.add(ws.teamId);
  return s;
}

function lanUrl() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${PORT}`;
    }
  }
  return `http://localhost:${PORT}`;
}

function teamPublic(t) {
  return { id: t.id, name: t.name, players: t.players };
}

// ---------- Joker : résumé par équipe ----------
// teamId -> { pending: utilisation en attente, last: dernière utilisation validée, plus, defi }
function jokerSummary() {
  const m = new Map();
  for (const u of game.jokerUses) {
    let s = m.get(u.teamId);
    if (!s) { s = { pending: null, last: null, plus: 0, defi: 0 }; m.set(u.teamId, s); }
    if (u.status === 'pending') s.pending = u;
    else if (u.status === 'done') { s.last = u; s[u.choice] += 1; }
  }
  return m;
}
function jokerUsePublic(u) {
  const t = game.teams[u.teamId];
  return { id: u.id, teamId: u.teamId, name: t ? t.name : '?', choice: u.choice, status: u.status, at: u.at, roundNo: u.roundNo };
}
function jokerScreen() {
  const live = game.jokerUses.filter((u) => game.teams[u.teamId] && !game.teams[u.teamId].removed);
  const active = Object.values(game.teams).filter((t) => !t.removed);
  return {
    pending: live.filter((u) => u.status === 'pending').map(jokerUsePublic),
    history: live.filter((u) => u.status !== 'pending').slice(-300).reverse().map(jokerUsePublic),
    holders: active.filter((t) => t.jokers > 0).length,
    available: active.reduce((n, t) => n + (t.jokers || 0), 0),
    usedPlus: live.filter((u) => u.status === 'done' && u.choice === 'plus').length,
    usedDefi: live.filter((u) => u.status === 'done' && u.choice === 'defi').length,
    bonus: JOKER_BONUS,
  };
}

// État envoyé à l'écran projeté / régie (complet)
function screenState(jk) {
  const r = currentRound();
  const online = onlineTeamIds();
  let entries = [], falseStarts = 0, pending = 0;
  if (r) {
    entries = rankedEntries(r).map((e) => ({
      teamId: e.teamId,
      name: game.teams[e.teamId].name,
      players: game.teams[e.teamId].players,
      rank: e.rank,
      reaction: Math.round(e.reaction),
      verdict: e.verdict || null,
      pts: pointsFor(e.rank),
    }));
    for (const e of Object.values(r.entries)) {
      if (e.state === 'false') falseStarts++;
      if (e.state === 'pending') pending++;
    }
  }
  const active = Object.values(game.teams).filter((t) => !t.removed);
  return {
    type: 'state',
    phase: game.phase,
    display: game.display,
    roundNo: game.roundNo,
    t0: r && r.t0 ? r.t0 : null,
    settings: game.settings,
    teamsCount: active.length,
    onlineCount: online.size,
    entries,
    falseStarts,
    pending,
    board: board.map((x) => {
      const j = jk.get(x.team.id);
      return {
        rank: x.rank, tied: x.tied, teamId: x.team.id, name: x.team.name,
        players: x.team.players, points: x.points, correct: x.correct,
        bestTime: x.bestTime === null ? null : Math.round(x.bestTime),
        online: online.has(x.team.id),
        jokers: x.team.jokers || 0,
        jPlus: j ? j.plus : 0, jDefi: j ? j.defi : 0, jPending: !!(j && j.pending),
      };
    }),
    jokers: jokerScreen(),
    recent: active.sort((a, b) => b.createdAt - a.createdAt).slice(0, 14).map((t) => t.name),
    publicUrl: PUBLIC_URL,
    lanUrl: lanUrl(),
  };
}

// État personnalisé envoyé à chaque téléphone
function playerState(teamId, shared) {
  const t = game.teams[teamId];
  if (!t || t.removed) return { type: 'kicked' };
  const r = currentRound();
  let my = null;
  if (r && r.entries[teamId]) {
    const e = r.entries[teamId];
    my = { state: e.state, reaction: e.state === 'valid' ? Math.round(e.reaction) : null, rank: e.rank || null, verdict: e.verdict || null, pts: e.state === 'valid' ? pointsFor(e.rank) : 0 };
  }
  const b = board.find((x) => x.team.id === teamId);
  // Classement masqué : ni le top, ni la place de l'équipe ne quittent le serveur.
  // Les points restent visibles, c'est la comparaison qui disparaît.
  const hidden = !!game.settings.boardHidden;
  // Joker : rien n'est envoyé aux équipes qui n'en ont jamais eu
  const j = shared.jokers.get(teamId);
  const joker = (t.jokers > 0 || j) ? {
    n: t.jokers || 0,
    open: !!game.settings.jokersOpen,
    pending: j && j.pending ? j.pending.choice : null,
    last: j && j.last ? j.last.choice : null,
    canUse: t.jokers > 0 && !(j && j.pending) && !!game.settings.jokersOpen && game.phase === 'closed',
  } : null;
  return {
    type: 'state',
    phase: game.phase,
    roundNo: game.roundNo,
    roundId: shared.roundId,
    t0: shared.t0,
    title: game.settings.title,
    boardHidden: hidden,
    me: { ...teamPublic(t), points: b ? b.points : 0, rank: hidden || !b ? null : b.rank, tied: !hidden && !!b && b.tied, total: board.length },
    my,
    buzzCount: shared.buzzCount,
    roundTop: shared.roundTop,
    top: hidden ? [] : shared.top,
    joker,
  };
}

function broadcast() {
  if (!dirty) return;
  dirty = false;
  const r = currentRound();
  const ranked = r ? rankedEntries(r) : [];
  const jk = jokerSummary();
  const shared = {
    jokers: jk,
    roundId: r ? r.id : null,
    t0: r && r.t0 && r.no === game.roundNo ? r.t0 : null,
    buzzCount: ranked.length,
    roundTop: game.phase === 'closed' ? ranked.slice(0, 3).map((e) => ({ rank: e.rank, name: game.teams[e.teamId].name, reaction: Math.round(e.reaction), verdict: e.verdict || null })) : [],
    top: board.filter((x) => x.points > 0).slice(0, 10).map((x) => ({ rank: x.rank, name: x.team.name, points: x.points })),
  };
  let screenJson = null;
  for (const ws of sockets) {
    if (ws.role === 'screen' && ws.isAdmin) {
      if (!screenJson) screenJson = JSON.stringify(screenState(jk));
      send(ws, screenJson);
    } else if (ws.role === 'player' && ws.teamId) {
      const json = JSON.stringify(playerState(ws.teamId, shared));
      if (json !== ws.lastJson) { ws.lastJson = json; send(ws, json); }
    } else if (ws.role === 'player' && !ws.teamId) {
      const json = JSON.stringify({ type: 'lobby', phase: game.phase, title: game.settings.title, registrationOpen: game.settings.registrationOpen, maxPlayers: game.settings.maxPlayers, jokerField: !!normPass(game.settings.jokerPassword) });
      if (json !== ws.lastJson) { ws.lastJson = json; send(ws, json); }
    }
  }
}
setInterval(broadcast, 200);

// ---------- Logique de jeu ----------
function clean(s, max) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function register(ws, msg) {
  if (!game.settings.registrationOpen) return send(ws, { type: 'error', code: 'closed', message: 'Les inscriptions sont fermées.' });
  ws.regAttempts = (ws.regAttempts || 0) + 1;
  if (ws.regAttempts > 15) return send(ws, { type: 'error', code: 'rate', message: 'Trop de tentatives, recharge la page.' });
  const name = clean(msg.name, 30);
  if (name.length < 2) return send(ws, { type: 'error', code: 'name', message: 'Le nom d\'équipe doit faire au moins 2 caractères.' });
  const lower = name.toLocaleLowerCase('fr');
  const active = Object.values(game.teams).filter((t) => !t.removed);
  if (active.some((t) => t.name.toLocaleLowerCase('fr') === lower)) return send(ws, { type: 'error', code: 'name', message: 'Ce nom d\'équipe est déjà pris, trouve autre chose !' });
  if (active.length >= MAX_TEAMS) return send(ws, { type: 'error', code: 'full', message: 'Le nombre maximum d\'équipes est atteint.' });
  const players = (Array.isArray(msg.players) ? msg.players : []).map((p) => clean(p, 24)).filter(Boolean).slice(0, game.settings.maxPlayers);
  if (!players.length) return send(ws, { type: 'error', code: 'players', message: 'Ajoute au moins un joueur.' });
  // Mot de passe joker facultatif : bon = un jeton, mauvais = tant pis (l'équipe est inscrite quand même)
  const typed = normPass(String(msg.jokerPassword ?? '').slice(0, 60));
  const want = normPass(game.settings.jokerPassword);
  const joker = typed ? (!!want && typed === want) : null; // null = case laissée vide
  const team = { id: newId(), token: newToken(), name, players, createdAt: now(), removed: false, jokers: joker ? 1 : 0, jokerByPassword: !!joker };
  game.teams[team.id] = team;
  tokens.set(team.token, team.id);
  ws.teamId = team.id;
  ws.lastJson = null;
  recomputeTotals();
  markDirty();
  send(ws, { type: 'registered', token: team.token, team: teamPublic(team), joker });
}

// Une équipe utilise un jeton : « +1 » (validé ensuite par la régie) ou « défi »
function useJoker(ws, msg) {
  const team = game.teams[ws.teamId];
  if (!team || team.removed) return;
  if (!JOKER_CHOICES.includes(msg.choice)) return;
  const refuse = (message) => send(ws, { type: 'jokerError', message });
  if (!(team.jokers > 0)) return refuse('Tu n\'as plus de joker.');
  if (!game.settings.jokersOpen) return refuse('Les jokers sont fermés pour le moment.');
  if (game.phase !== 'closed') return refuse('Le joker s\'utilise entre deux extraits.');
  if (game.jokerUses.some((u) => u.teamId === team.id && u.status === 'pending')) return refuse('Ton joker est déjà en attente.');
  team.jokers -= 1;
  game.jokerUses.push({ id: newId(), teamId: team.id, choice: msg.choice, at: Date.now(), roundNo: game.roundNo, status: 'pending' });
  markDirty();
}

// Rend un jeton à l'équipe (joker annulé, scores remis à zéro…)
function giveBackJoker(teamId) {
  const t = game.teams[teamId];
  if (t) t.jokers = Math.min(MAX_JOKERS_PER_TEAM, (t.jokers || 0) + 1);
}

// Chrono compté depuis le lancement de l'extrait : tout buzz est valable,
// il n'y a plus de faux départ. Math.max évite un temps négatif si l'horloge
// du téléphone est très légèrement en avance sur celle du serveur.
function decideEntry(round, e) {
  const ref = round.t0 === null || round.t0 === undefined ? round.armedAt : round.t0;
  e.state = 'valid';
  e.reaction = Math.max(0, e.t - ref);
}

function buzz(ws, msg) {
  const team = game.teams[ws.teamId];
  if (!team || team.removed) return;
  const r = currentRound();
  if (!r || msg.round !== r.id) return;            // buzz d'une ancienne manche
  if (r.entries[team.id]) return;                  // un seul buzz par manche
  if (game.phase !== 'armed' && game.phase !== 'open' && game.phase !== 'closed') return;

  const recv = now();
  // Heure du tap (horloge serveur, mesurée par le téléphone synchronisé).
  // Garde-fous : pas dans le futur, pas trop ancienne.
  let t = typeof msg.t === 'number' && isFinite(msg.t) ? msg.t : recv;
  if (t > recv + FUTURE_SLACK) t = recv;
  if (t < recv - MAX_BUZZ_AGE) return;
  if (game.phase === 'closed' && (!r.closedAt || t > r.closedAt)) return; // trop tard

  const e = { teamId: team.id, t, recvAt: recv, state: 'pending', reaction: null, verdict: null };
  r.entries[team.id] = e;
  decideEntry(r, e);
  markDirty();
}

function adminAction(ws, msg) {
  const r = currentRound();
  const a = msg.action;
  const tClient = typeof msg.t === 'number' && isFinite(msg.t) ? msg.t : null;
  const recv = now();
  const tSafe = tClient !== null && tClient <= recv + FUTURE_SLACK && tClient >= recv - 3000 ? tClient : recv;

  switch (a) {
    case 'arm': // lancer l'extrait : les buzzers sont ouverts tout de suite
      if (game.phase === 'armed' || game.phase === 'open') return;
      game.roundNo += 1;
      game.rounds.push({ id: newId(), no: game.roundNo, armedAt: recv, t0: recv, closedAt: null, entries: {} });
      game.phase = 'open';
      game.display = 'round';
      break;
    case 'stop':  // ancienne régie encore en cache : « stop » ferme les buzzers
    case 'close': // stopper l'extrait : plus de buzz possible
      if (!r || (game.phase !== 'open' && game.phase !== 'armed')) return;
      if (r.t0 === null || r.t0 === undefined) r.t0 = r.armedAt;
      r.closedAt = tSafe;
      game.phase = 'closed';
      // Buzz partis avant la fermeture mais arrivés après : acceptés par buzz()
      for (const e of Object.values(r.entries)) if (e.t > r.closedAt) delete r.entries[e.teamId];
      for (const e of Object.values(r.entries)) decideEntry(r, e);
      break;
    case 'cancelRound':
      if (!r) return;
      game.rounds.pop();
      game.roundNo = Math.max(0, game.roundNo - 1);
      game.phase = game.rounds.length ? 'closed' : 'lobby';
      recomputeTotals();
      break;
    case 'verdict': {
      const round = game.rounds.find((x) => x.no === msg.roundNo) || r;
      if (!round) return;
      const e = round.entries[msg.teamId];
      if (!e || e.state !== 'valid') return;
      e.verdict = msg.verdict === 'ok' || msg.verdict === 'ko' ? msg.verdict : null;
      recomputeTotals();
      break;
    }
    case 'display':
      if (['join', 'round', 'board'].includes(msg.view)) game.display = msg.view;
      break;
    case 'settings': {
      const s = msg.settings || {};
      if (typeof s.title === 'string') game.settings.title = clean(s.title, 60) || DEFAULT_SETTINGS.title;
      if (Array.isArray(s.points)) {
        const p = s.points.map((x) => Math.max(0, Math.min(1000, Math.round(Number(x))))).filter((x) => isFinite(x)).slice(0, 50);
        if (p.length) game.settings.points = p;
      }
      if (s.maxPlayers) game.settings.maxPlayers = Math.max(1, Math.min(20, parseInt(s.maxPlayers, 10) || 8));
      if (typeof s.registrationOpen === 'boolean') game.settings.registrationOpen = s.registrationOpen;
      if (typeof s.boardHidden === 'boolean') game.settings.boardHidden = s.boardHidden;
      if (typeof s.jokerPassword === 'string') game.settings.jokerPassword = clean(s.jokerPassword, 40);
      if (typeof s.jokersOpen === 'boolean') game.settings.jokersOpen = s.jokersOpen;
      recomputeTotals();
      break;
    }
    // ----- Joker -----
    case 'jokerResolve': { // ok : valider (+1 compté / défi fait) · sinon : annuler et rendre le jeton
      const u = game.jokerUses.find((x) => x.id === msg.useId);
      if (!u) return;
      if (msg.ok) {
        if (u.status !== 'pending') return;
        u.status = 'done';
      } else {
        if (u.status === 'cancelled') return;
        u.status = 'cancelled';
        giveBackJoker(u.teamId);
      }
      u.resolvedAt = Date.now();
      recomputeTotals();
      break;
    }
    case 'jokerResolveAll': { // tout valider d'un coup (filtré par choix si précisé)
      const choice = JOKER_CHOICES.includes(msg.choice) ? msg.choice : null;
      for (const u of game.jokerUses) {
        const t = game.teams[u.teamId];
        if (u.status === 'pending' && t && !t.removed && (!choice || u.choice === choice)) { u.status = 'done'; u.resolvedAt = Date.now(); }
      }
      recomputeTotals();
      break;
    }
    case 'jokerGive': {
      const t = game.teams[msg.teamId];
      if (!t || t.removed) return;
      giveBackJoker(t.id);
      break;
    }
    case 'jokerGiveAll': {
      for (const t of Object.values(game.teams)) if (!t.removed) giveBackJoker(t.id);
      break;
    }
    case 'jokerTake': {
      const t = game.teams[msg.teamId];
      if (!t || !(t.jokers > 0)) return;
      t.jokers -= 1;
      break;
    }
    case 'renameTeam': {
      const t = game.teams[msg.teamId];
      const name = clean(msg.name, 30);
      if (t && name.length >= 2) t.name = name;
      recomputeTotals();
      break;
    }
    case 'removeTeam': {
      const t = game.teams[msg.teamId];
      if (!t) return;
      t.removed = true;
      tokens.delete(t.token);
      for (const s of sockets) if (s.teamId === t.id) { send(s, { type: 'kicked' }); s.teamId = null; s.lastJson = null; }
      recomputeTotals();
      break;
    }
    case 'resetScores': // garde les équipes, efface les manches ; les jokers utilisés sont rendus
      for (const u of game.jokerUses) if (u.status !== 'cancelled') giveBackJoker(u.teamId);
      game.jokerUses = [];
      game.rounds = []; game.roundNo = 0; game.phase = 'lobby'; game.display = 'join';
      recomputeTotals();
      break;
    case 'resetAll': // nouvelle soirée : tout effacer
      for (const s of sockets) if (s.role === 'player' && s.teamId) { send(s, { type: 'kicked' }); s.teamId = null; s.lastJson = null; }
      game.teams = {}; game.rounds = []; game.roundNo = 0; game.phase = 'lobby'; game.display = 'join'; game.jokerUses = [];
      tokens.clear();
      recomputeTotals();
      break;
    default:
      return;
  }
  markDirty();
}

// ---------- HTTP ----------
const pages = {
  '/': path.join(__dirname, 'public', 'joueur.html'),
  '/ecran': path.join(__dirname, 'public', 'ecran.html'),
};

function csvCell(v) {
  const s = String(v ?? '');
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (pages[url.pathname]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(pages[url.pathname]).pipe(res);
    }
    if (url.pathname === '/qr.svg') {
      const data = (url.searchParams.get('u') || '').slice(0, 300);
      const svg = await QRCode.toString(data || 'https://example.com', { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      return res.end(svg);
    }
    if (url.pathname === '/export.csv') {
      if (!isAdminKey(url.searchParams.get('key'))) { res.writeHead(403); return res.end('Code régie invalide'); }
      const jk = jokerSummary();
      const rows = [['Rang', 'Équipe', 'Points', 'Bonnes réponses', 'Meilleur temps (s)', 'Bonus joker', 'Défis joker', 'Jokers restants', 'Joueurs']];
      for (const x of board) {
        const j = jk.get(x.team.id);
        rows.push([x.rank, x.team.name, x.points, x.correct, x.bestTime === null ? '' : (x.bestTime / 1000).toFixed(3).replace('.', ','), x.bonus || 0, j ? j.defi : 0, x.team.jokers || 0, x.team.players.join(', ')]);
      }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="classement-blind-test.csv"' });
      return res.end('﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\n'));
    }
    const font = url.pathname.match(/^\/fonts\/([a-z0-9.-]+\.(woff2|css))$/);
    if (font && fs.existsSync(path.join(__dirname, 'public', 'fonts', font[1]))) {
      res.writeHead(200, { 'Content-Type': font[2] === 'css' ? 'text/css; charset=utf-8' : 'font/woff2', 'Cache-Control': 'public, max-age=604800' });
      return fs.createReadStream(path.join(__dirname, 'public', 'fonts', font[1])).pipe(res);
    }
    if (url.pathname === '/restore' && req.method === 'POST') {
      if (!isAdminKey(url.searchParams.get('key'))) { res.writeHead(403); return res.end('Code régie invalide'); }
      let body = '', size = 0;
      req.setEncoding('utf8');
      req.on('data', (c) => { size += c.length; if (size > 20e6) req.destroy(); else body += c; });
      req.on('end', () => {
        try {
          restoreFrom(JSON.parse(body));
          console.log(`Partie restaurée depuis la régie : ${Object.keys(game.teams).length} équipes, ${game.rounds.length} extraits.`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, teams: Object.values(game.teams).filter((t) => !t.removed).length, rounds: game.rounds.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Page introuvable');
  } catch (e) {
    res.writeHead(500); res.end('Erreur');
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });

wss.on('connection', (ws) => {
  ws.role = null; ws.teamId = null; ws.isAdmin = false; ws.alive = true; ws.badKeys = 0;
  sockets.add(ws);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('close', () => { sockets.delete(ws); markDirty(); });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    // Synchronisation d'horloge : réponse immédiate
    if (msg.type === 'ping') return send(ws, { type: 'pong', c: msg.c, s: now() });

    if (msg.type === 'hello') {
      if (msg.role === 'screen') {
        ws.role = 'screen';
        if (isAdminKey(msg.key)) {
          ws.isAdmin = true;
          send(ws, { type: 'admin_ok', bootId: BOOT_ID, restorable: restoreWindowOpen() });
          if (!restoreWindowOpen()) sendBackup(ws);
        } else {
          ws.badKeys++;
          send(ws, { type: 'error', code: 'bad_key', message: 'Code régie incorrect.' });
          if (ws.badKeys > 5) ws.close();
        }
      } else {
        ws.role = 'player';
        const id = msg.token && tokens.get(msg.token);
        ws.teamId = id || null;
        ws.lastJson = null;
        // Jeton inconnu juste après un redémarrage : le téléphone patiente pendant la restauration
        send(ws, { type: 'welcome', team: id ? teamPublic(game.teams[id]) : null, wait: !id && !!msg.token && restoreWindowOpen() });
      }
      markDirty();
      return;
    }
    if (ws.role === 'player') {
      if (msg.type === 'register' && !ws.teamId) return register(ws, msg);
      if (msg.type === 'buzz' && ws.teamId) return buzz(ws, msg);
      if (msg.type === 'joker' && ws.teamId) return useJoker(ws, msg);
      if (msg.type === 'logout') { ws.teamId = null; ws.lastJson = null; markDirty(); return; }
    }
    if (ws.role === 'screen' && ws.isAdmin && msg.type === 'admin') return adminAction(ws, msg);
  });
});

// Détection des connexions mortes
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.alive) { ws.terminate(); sockets.delete(ws); markDirty(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch {}
  }
}, 20000);

load();
recomputeTotals();

server.listen(PORT, () => {
  const base = PUBLIC_URL || lanUrl();
  console.log('');
  console.log('  🎵  BUZZER BLIND TEST XXL — prêt !');
  console.log(`  📱  Page joueurs  : ${base}/`);
  console.log(`  🖥️   Écran projeté : ${base}/ecran`);
  console.log(`  🔑  Code régie    : ${ADMIN_KEY}${process.env.ADMIN_KEY ? '' : '   (aléatoire — fixe-le avec ADMIN_KEY)'}`);
  console.log('');
});

process.on('SIGTERM', () => { saveDirty = true; save(); setTimeout(() => process.exit(0), 300); });
process.on('SIGINT', () => { saveDirty = true; save(); setTimeout(() => process.exit(0), 300); });
