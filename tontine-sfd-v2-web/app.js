import { DEFAUTS, monteCarlo, decompositionCout } from './moteur.js';

const fmt = x => Math.round(x).toLocaleString('fr-FR');
const fmtM = x => Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1e3) + 'k';
const pct = x => (x * 100).toFixed(x * 100 < 1 && x > 0 ? 1 : 0) + '%';
const $ = id => document.getElementById(id);

// config maître unique (tous les paramètres) + nb de runs
let PARAMS = { ...DEFAUTS, _runs: 80 };

// ---- navigation : 2 onglets ----
document.querySelectorAll('.niv-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.niv-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const niv = b.dataset.niv;
  $('vue-simulation').hidden = (niv !== 'simulation');
  $('vue-doc').hidden = (niv !== 'doc');
}));

// ============ SCHÉMA DE TOUS LES PARAMÈTRES ============
const SCHEMA = [
  { grp: '📐 Structure du cercle', desc: "La taille et la durée des pools.", items: [
    { k: 'n_pools', nom: 'Nombre de pools', d: "Combien de cercles tournent en parallèle (échelle du portefeuille).", t: 'range', min: 10, max: 100, step: 10 },
    { k: 'm_membres', nom: 'Membres par pool', d: "Taille d'un cercle. Détermine le pot = (M−1)×cotisation.", t: 'range', min: 6, max: 15, step: 1 },
    { k: 'c', nom: 'Cotisation mensuelle', d: "Ce que chaque membre verse chaque mois (XOF).", t: 'range', min: 25000, max: 200000, step: 25000, fmt: 'k' },
    { k: 'n_cycles', nom: 'Nombre de cycles', d: "Durée de vie du produit = M × cycles mois.", t: 'range', min: 1, max: 4, step: 1 },
    { k: 'k_max', nom: 'Max même secteur / pool', d: "Diversification : au plus K membres du même secteur par pool (limite la corrélation).", t: 'range', min: 1, max: 6, step: 1 },
  ]},
  { grp: '🔀 Deux populations', desc: "Sépare emprunteurs (enchères, début) et épargnants (fin, rémunérés).", items: [
    { k: 'deux_populations', nom: 'Modèle deux populations', d: "Les premiers tours = emprunteurs (enchères) ; les derniers = épargnants (servis du plus sûr au moins sûr, rémunérés).", t: 'bool' },
    { k: 'x_tours_emprunteurs', nom: 'Décalage x (tours emprunteurs)', d: "Nombre de tours empruntables = N/2 + x. Plus haut = plus d'emprunteurs, plus de revenu, moins d'épargnants.", t: 'range', min: -3, max: 4, step: 1 },
    { k: 'part_emprunteurs_declares', nom: 'Part candidats-emprunteurs', d: "Part de membres qui déclarent vouloir emprunter ET sont jugés fiables (accès précoce).", t: 'range', min: 0.2, max: 0.9, step: 0.05, fmt: 'pct' },
    { k: 'part_bids_aux_epargnants', nom: 'Part des bids aux épargnants', d: "Fraction du surplus d'enchères reversée aux épargnants (leur rémunération).", t: 'range', min: 0, max: 0.8, step: 0.05, fmt: 'pct' },
    { k: 'r_depot_annuel', nom: 'Rémunération des dépôts', d: "Taux annuel que la SFD verse sur les dépôts (rémunère l'épargne).", t: 'range', min: 0, max: 0.10, step: 0.01, fmt: 'pct' },
  ]},
  { grp: '⚙️ Produit & mécanisme', desc: "Type de tontine et structure du coût.", items: [
    { k: 'mode', nom: 'Type de tontine', d: "Nue : sans garantie ni frais. Garantie : prime + couverture.", t: 'mode' },
    { k: 'prime_facteur_prudence', nom: 'Prudence de la prime', d: "1× = actuariel juste. >1 = prime majorée, plus robuste au stress (mais plus chère).", t: 'range', min: 0.8, max: 2.5, step: 0.1, fmt: 'x' },
    { k: 'prime_operateur_taux', nom: 'Marge Opérateur', d: "Marge de la plateforme, en % du pot, prélevée sur chaque encaissement.", t: 'range', min: 0, max: 0.04, step: 0.005, fmt: 'pct' },
    { k: 'r_sfd_annuel', nom: 'Taux SFD (avances)', d: "Taux annuel des avances de la SFD (intérêts du crédit-relais).", t: 'range', min: 0.06, max: 0.30, step: 0.02, fmt: 'pct' },
    { k: 'rho_mensuel', nom: 'Valeur-temps (ρ)', d: "Combien un membre pressé valorise l'accès anticipé → niveau des bids.", t: 'range', min: 0.005, max: 0.05, step: 0.005, fmt: 'pct' },
    { k: 'bid_plafond_frac_pot', nom: 'Plafond du surplus de bid', d: "Limite du surplus payé pour passer devant (compétitivité / usure).", t: 'range', min: 0.04, max: 0.25, step: 0.02, fmt: 'pct' },
  ]},
  { grp: '👥 Préférences de liquidité', desc: "Qui est pressé, qui est patient.", items: [
    { k: 'part_urgent', nom: 'Part d\'urgents', d: "Membres qui veulent leur argent tôt (bident le plus).", t: 'range', min: 0, max: 0.6, step: 0.05, fmt: 'pct' },
    { k: 'part_epargnant', nom: 'Part d\'épargnants', d: "Membres patients qui attendent (reçoivent gratuitement).", t: 'range', min: 0, max: 0.8, step: 0.05, fmt: 'pct' },
  ]},
  { grp: '🚪 Fuite & défaillance', desc: "Le risque que le modèle doit couvrir.", items: [
    { k: 'p_fuite_base', nom: 'Taux de fuite', d: "% des bénéficiaires qui disparaissent après avoir encaissé.", t: 'range', min: 0.02, max: 0.30, step: 0.02, fmt: 'pct' },
    { k: 'fuite_mult_tour_precoce', nom: 'Tentation tour précoce', d: "Multiplicateur de fuite au tour 1 (prendre tôt = plus tentant de fuir).", t: 'range', min: 1, max: 3, step: 0.2, fmt: 'x' },
    { k: 'charge_z_fuite', nom: 'Sensibilité macro', d: "À quel point un choc économique augmente les fuites (corrélation).", t: 'range', min: 0, max: 0.8, step: 0.05 },
    { k: 'taux_echec_friction', nom: 'Échec de prélèvement', d: "% de cotisations qui échouent temporairement (récupérable).", t: 'range', min: 0, max: 0.15, step: 0.01, fmt: 'pct' },
  ]},
  { grp: '🛡️ Couverture (3 étages)', desc: "Comment le trou d'une fuite est absorbé.", items: [
    { k: 'mitigation_active', nom: 'Mitigations', d: "Activer accès séquencé + garantie d'enchère + prélèvement auto.", t: 'bool' },
    { k: 't_restreint', nom: 'Tours réservés (historique)', d: "Les N premiers tours réservés aux membres avec historique.", t: 'range', min: 0, max: 5, step: 1 },
    { k: 'g_cotisations', nom: 'Consignation pour bider tôt', d: "Garantie (en nb de cotisations) saisie si fuite.", t: 'range', min: 0, max: 3, step: 1 },
    { k: 'fge_actif', nom: 'FGE (fonds de garantie)', d: "Le fonds endogène (primes + saisies) qui absorbe en premier.", t: 'bool' },
    { k: 'tranche_sfd_active', nom: 'Tranche SFD', d: "La SFD absorbe après le FGE (sa peau dans le jeu).", t: 'bool' },
    { k: 'plafond_tranche_sfd_frac', nom: 'Plafond tranche SFD', d: "Jusqu'où la SFD couvre, en % des avances. Au-delà = résiduel.", t: 'range', min: 0.01, max: 0.15, step: 0.01, fmt: 'pct' },
  ]},
  { grp: '🌩️ Stress', desc: "Tester le modèle en conditions dégradées.", items: [
    { k: 'comportemental_actif', nom: 'Stress comportemental', d: "Plus de fuites et plus de membres pressés.", t: 'bool' },
    { k: 'choc_fuite', nom: 'Choc de fuite', d: "Points de fuite ajoutés en stress comportemental.", t: 'range', min: 0, max: 0.15, step: 0.01, fmt: 'pct' },
    { k: 'bascule_urgents', nom: 'Bascule vers urgents', d: "Part de patients qui deviennent pressés sous stress.", t: 'range', min: 0, max: 0.6, step: 0.05, fmt: 'pct' },
    { k: 'macro_actif', nom: 'Stress macro', d: "Choc économique systémique (fuites corrélées).", t: 'bool' },
    { k: 'z_choc', nom: 'Sévérité du choc macro', d: "Ampleur du choc (négatif = mauvaise conjoncture).", t: 'range', min: -4, max: 0, step: 0.5 },
    { k: 'z_persistance', nom: 'Durée du choc (mois)', d: "Combien de mois le choc macro persiste.", t: 'range', min: 0, max: 8, step: 1 },
  ]},
];

const fmt0 = x => Math.round(x).toLocaleString('fr-FR');
function fmtParam(v, f) {
  if (f === 'k') return fmt0(v);
  if (f === 'pct') return (v * 100).toFixed(1).replace(/\.0$/, '') + '%';
  if (f === 'x') return v.toFixed(1) + '×';
  return (typeof v === 'number' && v % 1 !== 0) ? v.toFixed(2) : v;
}

// ---- presets de scénario (ajustent les paramètres de stress) ----
const PRESETS = {
  nominal: { comportemental_actif: false, choc_fuite: 0, bascule_urgents: 0, macro_actif: false, z_choc: 0, z_persistance: 0, part_urgent: 0.20, part_epargnant: 0.30, rho_mensuel: 0.02 },
  comportemental: { comportemental_actif: true, choc_fuite: 0.06, bascule_urgents: 0.30, macro_actif: false, z_choc: 0, z_persistance: 0 },
  macro: { comportemental_actif: false, choc_fuite: 0, bascule_urgents: 0, macro_actif: true, z_choc: -2.5, z_persistance: 4 },
  combine: { comportemental_actif: true, choc_fuite: 0.06, bascule_urgents: 0.30, macro_actif: true, z_choc: -2.5, z_persistance: 4 },
  bids_faibles: { part_urgent: 0.05, part_epargnant: 0.70, rho_mensuel: 0.01, comportemental_actif: false, macro_actif: false },
};

// ---- rendu des paramètres ----
function renderParametres() {
  $('paramGroupes').innerHTML = SCHEMA.map(g => `
    <details class="param-groupe" open>
      <summary>${g.grp}<span class="grp-desc">${g.desc}</span></summary>
      ${g.items.map(it => paramRow(it)).join('')}
    </details>`).join('');
  SCHEMA.flatMap(g => g.items).forEach(it => attachParam(it));
}
function paramRow(it) {
  let ctrl = '';
  if (it.t === 'range') ctrl = `<div class="p-ctrl"><input type="range" id="px_${it.k}" min="${it.min}" max="${it.max}" step="${it.step}" value="${PARAMS[it.k]}"><span class="p-val" id="pv_${it.k}">${fmtParam(PARAMS[it.k], it.fmt)}</span></div>`;
  else if (it.t === 'bool') ctrl = `<div class="p-toggle" id="px_${it.k}"><button data-v="1" class="${PARAMS[it.k] ? 'on' : ''}">Oui</button><button data-v="0" class="${!PARAMS[it.k] ? 'on' : ''}">Non</button></div>`;
  else if (it.t === 'mode') ctrl = `<div class="p-toggle" id="px_${it.k}"><button data-v="garantie" class="${PARAMS[it.k] === 'garantie' ? 'on' : ''}">Garantie</button><button data-v="nue" class="${PARAMS[it.k] === 'nue' ? 'on' : ''}">Nue</button></div>`;
  return `<div class="param-row"><div><div class="p-nom">${it.nom}</div><div class="p-desc">${it.d}</div></div>${ctrl}</div>`;
}
function attachParam(it) {
  const el = $('px_' + it.k); if (!el) return;
  if (it.t === 'range') el.addEventListener('input', e => { PARAMS[it.k] = +e.target.value; $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); marquerModifie(); });
  else el.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { el.querySelectorAll('button').forEach(b => b.classList.remove('on')); btn.classList.add('on'); PARAMS[it.k] = (it.t === 'mode') ? btn.dataset.v : (btn.dataset.v === '1'); marquerModifie(); }));
}
function syncParametres() { SCHEMA.flatMap(g => g.items).forEach(it => { const el = $('px_' + it.k); if (!el) return; if (it.t === 'range') { el.value = PARAMS[it.k]; $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); } else { el.querySelectorAll('button').forEach(b => b.classList.toggle('on', (it.t === 'mode' ? b.dataset.v === PARAMS[it.k] : (b.dataset.v === '1') === !!PARAMS[it.k]))); } }); }
function marquerModifie() { $('simStatus').textContent = '⟳ relancez pour voir l\'effet'; }

// presets
document.querySelectorAll('#presetSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#presetSeg .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  Object.assign(PARAMS, PRESETS[b.dataset.preset]);
  syncParametres(); lancer();
}));
$('btnReset').addEventListener('click', () => { PARAMS = { ...DEFAUTS, _runs: PARAMS._runs }; document.querySelectorAll('#presetSeg .seg-btn').forEach((x, i) => x.classList.toggle('active', i === 0)); syncParametres(); lancer(); });
$('btnRun').addEventListener('click', lancer);
$('c_runs').addEventListener('input', e => { PARAMS._runs = +e.target.value; $('o_runs').textContent = e.target.value; });

// ============ SIMULATION + CHIFFRES ============
let dernier = null;
function lancer() {
  $('btnRun').textContent = 'Calcul…'; $('simStatus').textContent = '';
  setTimeout(() => {
    const a = monteCarlo({ ...PARAMS }, PARAMS._runs, 12345);
    dernier = a;
    renderKPIs(a, PARAMS);
    drawExpo(a, PARAMS);
    renderCoutDecompo(PARAMS);
    renderFluxSfd(a, PARAMS);
    renderTableauScenarios();
    drawPnlDist(a);
    $('btnRun').textContent = '▶ Lancer';
  }, 20);
}

function kpiV(o, fmtf) { return `${fmtf(o.moy)} <span class="pp">[${fmtf(o.p5)}–${fmtf(o.p95)}]</span>`; }

function renderKPIs(a, p) {
  const pot = (p.m_membres - 1) * p.c;
  const items = [
    { l: 'Promesse tenue', v: pct(a.taux_continuite), c: a.taux_continuite >= 0.999 ? 'ok' : 'bad', s: 'tous les tours servis' },
    { l: 'P&L brut Opérateur', v: kpiV(a.pnlOp, fmtM), c: a.pnlOp.moy > 0 ? 'ok' : 'bad', s: `${p.n_pools} pools · primes + surplus` },
    { l: 'Revenu / pool', v: kpiV(a.margePool, fmtM), c: 'brand', s: 'brut, hors coûts' },
    { l: 'Risque porté SFD', v: kpiV(a.perteSfd, fmtM), c: 'brand', s: 'avances non récupérées' },
    { l: 'Exposition SFD max', v: kpiV(a.expoMax, fmtM), c: 'brand', s: 'avances en cours (pic)' },
    { l: 'Coût membre tour 1', v: pct(a.coutTour1.moy / pot), c: a.coutTour1.moy / pot < 0.2 ? 'ok' : 'brand', s: 'le dernier tour ≈ 0' },
    { l: 'Fuites moyennes', v: kpiV(a.fuites, x => Math.round(x).toString()), c: 'brand', s: 'bénéficiaires disparus' },
    { l: 'Rémunération épargnant', v: kpiV(a.remunParEpargnant, fmtM), c: 'ok', s: 'bonus du membre patient' },
  ];
  $('kpiGrid').innerHTML = items.map(i => `<div class="kpi"><div class="lbl">${i.l}</div><div class="val ${i.c}">${i.v}</div><small>${i.s}</small></div>`).join('');
}

// décomposition du coût membre par tour (tableau)
function renderCoutDecompo(p) {
  const rows = decompositionCout(p);
  const tb = rows.map(r => {
    if (r.type === 'épargnant') {
      return `<tr class="eparg-row"><td>T${r.tour} <span class="tag-ep">épargnant</span></td><td colspan="4" class="muted">ne paie rien — reçoit le pot + une rémunération</td><td class="g">0%</td></tr>`;
    }
    return `<tr><td>T${r.tour} <span class="tag-emp">emprunteur</span></td><td>${fmt(r.interets)}</td><td>${fmt(r.prime)}</td><td>${fmt(r.marge)}</td><td><b>${fmt(r.total)}</b></td><td>${(r.total / r.pot * 100).toFixed(0)}%</td></tr>`;
  }).join('');
  $('coutDecompo').innerHTML = `<table class="data"><thead><tr><th>Tour</th><th>Intérêts SFD</th><th>Prime garantie</th><th>Marge Op.</th><th>Total payé</th><th>% pot</th></tr></thead><tbody>${tb}</tbody></table>`;
}

// flux SFD agrégés
function renderFluxSfd(a, p) {
  const lignes = [
    ['Avances totales (décaissées)', a.avanceCumulee.moy, 'la SFD avance le net aux gagnants'],
    ['Intérêts SFD perçus', a.interetsSfd.moy, 'le prix du crédit-relais'],
    ['Trou couvert par le FGE', a.couvertFge.moy, 'fonds endogène (primes + saisies)'],
    ['Trou couvert par la SFD', a.couvertSfd.moy, 'sa tranche junior — peau dans le jeu'],
    ['FGE alimenté (primes)', a.fgeProvisions.moy, 'primes de garantie collectées'],
    ['FGE alimenté (saisies)', a.fgeSaisies.moy, 'garanties d\'enchère des fuyards'],
  ];
  $('fluxSfd').innerHTML = `<table class="data"><tbody>${lignes.map(l => `<tr><td>${l[0]}</td><td class="num"><b>${fmtM(l[1])}</b></td><td class="muted">${l[2]}</td></tr>`).join('')}</tbody></table>`;
}

// tableau comparatif des 5 scénarios
function renderTableauScenarios() {
  const noms = { nominal: 'Nominal', comportemental: 'Comportemental', macro: 'Macro', combine: 'Combiné', bids_faibles: 'Bids faibles' };
  const base = { ...PARAMS };
  const rows = Object.keys(PRESETS).map(s => {
    const p = { ...DEFAULTS_SANS_STRESS(base), ...PRESETS[s] };
    const a = monteCarlo(p, Math.min(60, PARAMS._runs), 12345);
    const pot = (p.m_membres - 1) * p.c;
    return { s, nom: noms[s], cont: a.taux_continuite, pnl: a.pnlOp.moy, perte: a.perteSfd.moy, cout: a.coutTour1.moy / pot, fuites: a.fuites.moy };
  });
  $('tableauScen').innerHTML = `<table class="data"><thead><tr><th>Scénario</th><th>Promesse</th><th>P&L brut</th><th>Risque SFD</th><th>Coût T1</th><th>Fuites</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.nom}</td><td class="${r.cont >= 0.999 ? 'g' : 'r'}">${pct(r.cont)}</td><td class="g">${fmtM(r.pnl)}</td><td>${fmtM(r.perte)}</td><td>${pct(r.cout)}</td><td>${Math.round(r.fuites)}</td></tr>`).join('')}</tbody></table>`;
}
function DEFAULTS_SANS_STRESS(base) { return { ...base, comportemental_actif: false, macro_actif: false, choc_fuite: 0, z_choc: 0, z_persistance: 0, bascule_urgents: 0 }; }

// ---- graphiques ----
function drawExpo(a, p) {
  const cv = $('expoCanvas'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const prof = a.expoProfil; if (!prof) return;
  const mx = Math.max(...prof, 1), pad = 40;
  const xs = i => pad + (i / (prof.length - 1)) * (W - pad - 8), ys = v => H - 22 - (v / mx) * (H - 36);
  ctx.beginPath(); ctx.moveTo(xs(0), ys(0)); prof.forEach((v, i) => ctx.lineTo(xs(i), ys(v))); ctx.lineTo(xs(prof.length - 1), ys(0)); ctx.closePath(); ctx.fillStyle = 'rgba(15,76,74,.12)'; ctx.fill();
  ctx.strokeStyle = '#0f4c4a'; ctx.lineWidth = 2; ctx.beginPath(); prof.forEach((v, i) => i ? ctx.lineTo(xs(i), ys(v)) : ctx.moveTo(xs(i), ys(v))); ctx.stroke();
  ctx.fillStyle = '#5b6b87'; ctx.font = '11px sans-serif'; ctx.fillText(fmtM(mx), 4, 14); ctx.fillText('0', 4, H - 22); ctx.textAlign = 'center'; ctx.fillText('mois →', W / 2, H - 4);
}
function drawPnlDist(a) {
  const cv = $('pnlCanvas'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const data = (a._pnls || []).map(x => x / 1e6); if (!data.length) return;
  const lo = Math.min(...data), hi = Math.max(...data), bins = 24, w = (hi - lo) / bins || 1, cnt = new Array(bins).fill(0);
  data.forEach(v => { let b = Math.floor((v - lo) / w); b = Math.max(0, Math.min(bins - 1, b)); cnt[b]++; });
  const mc = Math.max(...cnt), pad = 30, bw = (W - pad * 2) / bins;
  cnt.forEach((c, i) => { const x = pad + i * bw, h = (c / mc) * (H - 38); const mid = lo + (i + 0.5) * w; ctx.fillStyle = mid >= 0 ? '#15803d' : '#b91c1c'; ctx.fillRect(x, H - 20 - h, bw - 1, h); });
  ctx.fillStyle = '#5b6b87'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(lo.toFixed(0) + 'M', pad, H - 4); ctx.textAlign = 'right'; ctx.fillText(hi.toFixed(0) + 'M', W - 4, H - 4); ctx.textAlign = 'center'; ctx.fillText('P&L brut →', W / 2, H - 4);
}

// ---- init ----
PARAMS._runs = 80;
renderParametres();
$('o_runs').textContent = PARAMS._runs;
$('c_runs').value = PARAMS._runs;
lancer();
