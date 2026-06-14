import { DEFAUTS, monteCarlo, decompositionCout, journalPool } from './moteur.js?v=20';

// mode unitaire : quand la cotisation = 1, on lit les montants en multiples de cotisation (×c)
const unitaire = () => PARAMS && PARAMS.c === 1;
const fmtUnite = x => { const a = Math.abs(x); const s = a >= 100 ? Math.round(x).toLocaleString('fr-FR') : a >= 10 ? x.toFixed(1) : x.toFixed(2); return s + '×c'; };
const fmt = x => unitaire() ? fmtUnite(x) : Math.round(x).toLocaleString('fr-FR');
const fmtM = x => unitaire() ? fmtUnite(x) : (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1e3) + 'k');
const pct = x => (x * 100).toFixed(x * 100 < 1 && x > 0 ? 1 : 0) + '%';
const $ = id => document.getElementById(id);

// config maître unique (tous les paramètres) + nb de runs
let PARAMS = { ...DEFAUTS, _runs: 80 };

// ---- navigation : 2 onglets (Paramètres / Résultats) ----
function montrerOnglet(onglet) {
  document.querySelectorAll('#ongletSeg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.onglet === onglet));
  $('vue-parametres').hidden = (onglet !== 'parametres');
  $('vue-resultats').hidden = (onglet !== 'resultats');
  $('vue-flux').hidden = (onglet !== 'flux');
  if (onglet === 'flux') renderFlux();
}
document.querySelectorAll('#ongletSeg .seg-btn').forEach(b => b.addEventListener('click', () => montrerOnglet(b.dataset.onglet)));
function allerResultats() { montrerOnglet('resultats'); }

// ============ SCHÉMA DE TOUS LES PARAMÈTRES ============
const SCHEMA = [
  { grp: 'Structure du cercle', desc: "La taille et la durée des pools.", items: [
    { k: 'n_pools', nom: 'Nombre de pools', d: "Cercles en parallèle. 1 = vue unitaire (un seul pool) ; montez pour voir l'échelle du portefeuille.", t: 'range', min: 1, max: 100, step: 1 },
    { k: 'm_membres', nom: 'Membres par pool', d: "Taille d'un cercle. Détermine le pot = (M−1)×cotisation.", t: 'range', min: 6, max: 15, step: 1 },
    { k: 'c', nom: 'Cotisation mensuelle', d: "Ce que chaque membre verse chaque mois. Mettez 1 pour raisonner en unités (tout devient un multiple de la cotisation).", t: 'logrange', min: 1, max: 200000, fmt: 'k' },
    { k: 'n_cycles', nom: 'Nombre de cycles', d: "Durée de vie du produit = M × cycles mois.", t: 'range', min: 1, max: 4, step: 1 },
    { k: 'k_max', nom: 'Max même secteur / pool', d: "Diversification : au plus K membres du même secteur par pool (limite la corrélation).", t: 'range', min: 1, max: 6, step: 1 },
  ]},
  { grp: 'Deux populations', desc: "Sépare emprunteurs (enchères, début) et épargnants (fin, rémunérés).", items: [
    { k: 'deux_populations', nom: 'Modèle deux populations', d: "Les premiers tours = emprunteurs (enchères) ; les derniers = épargnants (servis du plus sûr au moins sûr, rémunérés).", t: 'bool' },
    { k: 'x_tours_emprunteurs', nom: 'Décalage x (tours emprunteurs)', d: "Nombre de tours empruntables = N/2 + x. Plus haut = plus d'emprunteurs, plus de revenu, moins d'épargnants.", t: 'range', min: -3, max: 4, step: 1 },
    { k: 'part_emprunteurs_declares', nom: 'Part candidats-emprunteurs', d: "Part de membres qui déclarent vouloir emprunter ET sont jugés fiables (accès précoce).", t: 'range', min: 0.2, max: 0.9, step: 0.05, fmt: 'pct' },
    { k: 'part_bids_aux_epargnants', nom: 'Part des bids aux épargnants', d: "Fraction du surplus d'enchères reversée aux épargnants (leur rémunération).", t: 'range', min: 0, max: 0.8, step: 0.05, fmt: 'pct' },
    { k: 'r_depot_annuel', nom: 'Rémunération des dépôts', d: "Taux annuel que la SFD verse sur les dépôts (rémunère l'épargne).", t: 'range', min: 0, max: 0.10, step: 0.01, fmt: 'pct' },
  ]},
  { grp: 'Produit & mécanisme', desc: "Type de tontine et structure du coût.", items: [
    { k: 'mode', nom: 'Type de tontine', d: "Nue : sans garantie ni frais. Garantie : prime + couverture.", t: 'mode' },
    { k: 'prime_facteur_prudence', nom: 'Prudence de la prime', d: "1× = actuariel juste. >1 = prime majorée, plus robuste au stress (mais plus chère).", t: 'range', min: 0.8, max: 2.5, step: 0.1, fmt: 'x' },
    { k: 'prime_operateur_taux', nom: 'Marge Opérateur', d: "Marge de la plateforme, en % du pot, prélevée sur chaque encaissement.", t: 'range', min: 0, max: 0.04, step: 0.005, fmt: 'pct' },
    { k: 'r_sfd_annuel', nom: 'Taux SFD (avances)', d: "Taux annuel des avances de la SFD (intérêts du crédit-relais).", t: 'range', min: 0.06, max: 0.30, step: 0.02, fmt: 'pct' },
    { k: 'rho_mensuel', nom: 'Valeur-temps (ρ)', d: "Combien un membre pressé valorise l'accès anticipé → niveau des bids.", t: 'range', min: 0.005, max: 0.05, step: 0.005, fmt: 'pct' },
    { k: 'bid_plafond_frac_pot', nom: 'Plafond du surplus de bid', d: "Limite du surplus payé pour passer devant (compétitivité / usure).", t: 'range', min: 0.04, max: 0.25, step: 0.02, fmt: 'pct' },
  ]},
  { grp: 'Préférences de liquidité', desc: "Qui est pressé, qui est patient.", items: [
    { k: 'part_urgent', nom: 'Part d\'urgents', d: "Membres qui veulent leur argent tôt (bident le plus).", t: 'range', min: 0, max: 0.6, step: 0.05, fmt: 'pct' },
    { k: 'part_epargnant', nom: 'Part d\'épargnants', d: "Membres patients qui attendent (reçoivent gratuitement).", t: 'range', min: 0, max: 0.8, step: 0.05, fmt: 'pct' },
  ]},
  { grp: 'Fuite & défaillance', desc: "Le risque que le modèle doit couvrir.", items: [
    { k: 'p_fuite_base', nom: 'Taux de fuite', d: "% des bénéficiaires qui disparaissent après avoir encaissé.", t: 'range', min: 0.02, max: 0.30, step: 0.02, fmt: 'pct' },
    { k: 'fuite_mult_tour_precoce', nom: 'Tentation tour précoce', d: "Multiplicateur de fuite au tour 1 (prendre tôt = plus tentant de fuir).", t: 'range', min: 1, max: 3, step: 0.2, fmt: 'x' },
    { k: 'charge_z_fuite', nom: 'Sensibilité macro', d: "À quel point un choc économique augmente les fuites (corrélation).", t: 'range', min: 0, max: 0.8, step: 0.05 },
    { k: 'taux_echec_friction', nom: 'Échec de prélèvement', d: "% de cotisations qui échouent temporairement (récupérable).", t: 'range', min: 0, max: 0.15, step: 0.01, fmt: 'pct' },
    { k: 'taux_arret_non_encaisseur', nom: 'Arrêt avant encaissement', d: "% de membres n'ayant pas encore encaissé qui arrêtent (cas 2) : ils sont remboursés, un remplaçant rattrape les tours passés. 0 = désactivé.", t: 'range', min: 0, max: 0.10, step: 0.01, fmt: 'pct' },
  ]},
  { grp: 'Couverture (3 étages)', desc: "Comment le trou d'une fuite est absorbé.", items: [
    { k: 'mitigation_active', nom: 'Mitigations', d: "Activer accès séquencé + garantie d'enchère + prélèvement auto.", t: 'bool' },
    { k: 't_restreint', nom: 'Tours réservés (historique)', d: "Les N premiers tours réservés aux membres avec historique.", t: 'range', min: 0, max: 5, step: 1 },
    { k: 'g_cotisations', nom: 'Consignation pour bider tôt', d: "Garantie (en nb de cotisations) saisie si fuite.", t: 'range', min: 0, max: 3, step: 1 },
    { k: 'fge_actif', nom: 'FGE (fonds de garantie)', d: "Le fonds endogène (primes + saisies) qui absorbe en premier.", t: 'bool' },
    { k: 'tranche_sfd_active', nom: 'Tranche SFD', d: "La SFD absorbe après le FGE (sa peau dans le jeu).", t: 'bool' },
    { k: 'plafond_tranche_sfd_frac', nom: 'Plafond tranche SFD', d: "Jusqu'où la SFD couvre, en % des avances. Au-delà = résiduel.", t: 'range', min: 0.01, max: 0.15, step: 0.01, fmt: 'pct' },
    { k: 'fge_mutualise', nom: 'FGE mutualisé entre pools', d: "Non = chaque pool autonome (la solidité ne dépend que du pool, cadre « 1 pool »). Oui = un pool sain peut renflouer un pool en fuite.", t: 'bool' },
  ]},
  { grp: 'Règles cycle 1', desc: "Le cycle 1 démarre FGE vide : accès filtré par score + seuil de déclenchement.", items: [
    { k: 'cycle1_scoring_actif', nom: 'Accès filtré par score', d: "Au cycle 1, n'autorise à emprunter tôt que les scores élevés (seuil décroissant du tour 1 à M/2).", t: 'bool' },
    { k: 'cycle1_pct_t1', nom: 'Seuil score tour 1', d: "Percentile minimal de score requis au tour 1 (ex. P90 = top 10%).", t: 'range', min: 0.5, max: 0.95, step: 0.05, fmt: 'pct' },
    { k: 'cycle1_pct_mid', nom: 'Seuil score tour M/2', d: "Percentile minimal au milieu du cycle (le seuil décroît jusque-là).", t: 'range', min: 0.3, max: 0.8, step: 0.05, fmt: 'pct' },
    { k: 'cycle1_reduction_fuite', nom: 'Réduction de fuite (sélectionnés)', d: "Hypothèse : un emprunteur passé par le filtre fuit dans cette proportion du taux de base (0,33 = fuit 3× moins). C'est ce qui rend le filtre protecteur.", t: 'range', min: 0.2, max: 1, step: 0.1, fmt: 'x' },
  ]},
  { grp: 'Stress', desc: "Tester le modèle en conditions dégradées.", items: [
    { k: 'comportemental_actif', nom: 'Stress comportemental', d: "Plus de fuites et plus de membres pressés.", t: 'bool' },
    { k: 'choc_fuite', nom: 'Choc de fuite', d: "Points de fuite ajoutés en stress comportemental.", t: 'range', min: 0, max: 0.15, step: 0.01, fmt: 'pct' },
    { k: 'bascule_urgents', nom: 'Bascule vers urgents', d: "Part de patients qui deviennent pressés sous stress.", t: 'range', min: 0, max: 0.6, step: 0.05, fmt: 'pct' },
    { k: 'macro_actif', nom: 'Stress macro', d: "Choc économique systémique (fuites corrélées).", t: 'bool' },
    { k: 'z_choc', nom: 'Sévérité du choc macro', d: "Ampleur du choc (négatif = mauvaise conjoncture).", t: 'range', min: -4, max: 0, step: 0.5 },
    { k: 'z_persistance', nom: 'Durée du choc (mois)', d: "Combien de mois le choc macro persiste.", t: 'range', min: 0, max: 8, step: 1 },
  ]},
];

const fmt0 = x => Math.round(x).toLocaleString('fr-FR');
// échelle logarithmique pour la cotisation : curseur 0..1000 <-> valeur [min,max], arrondie 1-2-5
const LOG_STEPS = 1000;
function logToVal(s, min, max) {
  const v = Math.exp(Math.log(min) + (s / LOG_STEPS) * (Math.log(max) - Math.log(min)));
  if (v < 10) return Math.max(min, Math.round(v));
  const pow = Math.pow(10, Math.floor(Math.log10(v))), m = v / pow;
  const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return Math.min(max, Math.round(nice * pow));
}
function valToLog(v, min, max) {
  return Math.round(LOG_STEPS * (Math.log(Math.max(min, v)) - Math.log(min)) / (Math.log(max) - Math.log(min)));
}
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
  else if (it.t === 'logrange') ctrl = `<div class="p-ctrl"><input type="range" id="px_${it.k}" min="0" max="${LOG_STEPS}" step="1" value="${valToLog(PARAMS[it.k], it.min, it.max)}"><span class="p-val" id="pv_${it.k}">${fmtParam(PARAMS[it.k], it.fmt)}</span></div>`;
  else if (it.t === 'bool') ctrl = `<div class="p-toggle" id="px_${it.k}"><button data-v="1" class="${PARAMS[it.k] ? 'on' : ''}">Oui</button><button data-v="0" class="${!PARAMS[it.k] ? 'on' : ''}">Non</button></div>`;
  else if (it.t === 'mode') ctrl = `<div class="p-toggle" id="px_${it.k}"><button data-v="garantie" class="${PARAMS[it.k] === 'garantie' ? 'on' : ''}">Garantie</button><button data-v="nue" class="${PARAMS[it.k] === 'nue' ? 'on' : ''}">Nue</button></div>`;
  return `<div class="param-row"><div><div class="p-nom">${it.nom}</div><div class="p-desc">${it.d}</div></div>${ctrl}</div>`;
}
function attachParam(it) {
  const el = $('px_' + it.k); if (!el) return;
  if (it.t === 'range') el.addEventListener('input', e => { PARAMS[it.k] = +e.target.value; $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); marquerModifie(); });
  else if (it.t === 'logrange') el.addEventListener('input', e => { PARAMS[it.k] = logToVal(+e.target.value, it.min, it.max); $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); marquerModifie(); });
  else el.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { el.querySelectorAll('button').forEach(b => b.classList.remove('on')); btn.classList.add('on'); PARAMS[it.k] = (it.t === 'mode') ? btn.dataset.v : (btn.dataset.v === '1'); marquerModifie(); }));
}
function syncParametres() { SCHEMA.flatMap(g => g.items).forEach(it => { const el = $('px_' + it.k); if (!el) return; if (it.t === 'range') { el.value = PARAMS[it.k]; $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); } else if (it.t === 'logrange') { el.value = valToLog(PARAMS[it.k], it.min, it.max); $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); } else { el.querySelectorAll('button').forEach(b => b.classList.toggle('on', (it.t === 'mode' ? b.dataset.v === PARAMS[it.k] : (b.dataset.v === '1') === !!PARAMS[it.k]))); } }); }
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
    renderCoutDecompo(PARAMS);
    renderFluxSfd(a, PARAMS);
    renderTableauScenarios();
    drawPnlDist(a);
    $('btnRun').textContent = 'Lancer';
    $('simStatus').textContent = 'calculé';
    allerResultats();
  }, 20);
}

function kpiV(o, fmtf) { return `${fmtf(o.moy)} <span class="pp">[${fmtf(o.p5)}–${fmtf(o.p95)}]</span>`; }

function renderKPIs(a, p) {
  const pot = (p.m_membres - 1) * p.c;
  const np = Math.max(1, p.n_pools);
  const tcp = a.taux_continuite_pool ?? a.taux_continuite;
  const items = [
    { l: 'Promesse tenue / pool', v: pct(tcp), c: tcp >= 0.999 ? 'ok' : tcp >= 0.99 ? 'brand' : 'bad', s: 'tours servis dans un pool' },
    { l: 'P&L brut / pool', v: kpiV(a.margePool, fmtM), c: a.margePool.moy > 0 ? 'ok' : 'bad', s: 'primes + surplus, par pool' },
    { l: 'Risque SFD / pool', v: fmtM(a.perteSfd.moy / np), c: 'brand', s: 'avances non récupérées' },
    { l: 'Coût membre tour 1', v: pct(a.coutTour1.moy / pot), c: a.coutTour1.moy / pot < 0.2 ? 'ok' : 'brand', s: 'le dernier tour ≈ 0' },
    { l: 'Fuites / pool', v: (a.fuites.moy / np).toFixed(2), c: 'brand', s: 'bénéficiaires disparus' },
    { l: 'Rémunération épargnant', v: kpiV(a.remunParEpargnant, fmtM), c: 'ok', s: 'bonus du membre patient' },
    { l: 'Tours à découvert (cy.1)', v: (a.toursFgeInsuffisantMoy ?? 0).toFixed(1), c: (a.toursFgeInsuffisantMoy ?? 0) < 0.5 ? 'ok' : 'bad', s: 'couverture < pire fuite' },
    { l: 'P&L brut total', v: kpiV(a.pnlOp, fmtM), c: a.pnlOp.moy > 0 ? 'ok' : 'bad', s: `${np} pool${np > 1 ? 's' : ''}` },
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
    const np = Math.max(1, p.n_pools);
    const a = monteCarlo(p, Math.min(60, PARAMS._runs), 12345);
    const pot = (p.m_membres - 1) * p.c;
    return { s, nom: noms[s], cont: a.taux_continuite_pool ?? a.taux_continuite, pnl: a.margePool.moy, perte: a.perteSfd.moy / np, cout: a.coutTour1.moy / pot, fuites: a.fuites.moy / np };
  });
  $('tableauScen').innerHTML = `<table class="data"><thead><tr><th>Scénario</th><th>Promesse/pool</th><th>P&L/pool</th><th>Risque/pool</th><th>Coût T1</th><th>Fuites/pool</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.nom}</td><td class="${r.cont >= 0.999 ? 'g' : r.cont >= 0.99 ? '' : 'r'}">${pct(r.cont)}</td><td class="g">${fmtM(r.pnl)}</td><td>${fmtM(r.perte)}</td><td>${pct(r.cout)}</td><td>${r.fuites.toFixed(2)}</td></tr>`).join('')}</tbody></table>`;
}
function DEFAULTS_SANS_STRESS(base) { return { ...base, comportemental_actif: false, macro_actif: false, choc_fuite: 0, z_choc: 0, z_persistance: 0, bascule_urgents: 0 }; }

// ---- graphiques ----
function drawPnlDist(a) {
  const cv = $('pnlCanvas'); if (!cv) return; const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const data = (a._pnls || []); if (!data.length) return;
  const lo = Math.min(...data), hi = Math.max(...data), bins = 24, w = (hi - lo) / bins || 1, cnt = new Array(bins).fill(0);
  data.forEach(v => { let b = Math.floor((v - lo) / w); b = Math.max(0, Math.min(bins - 1, b)); cnt[b]++; });
  const mc = Math.max(...cnt), pad = 30, bw = (W - pad * 2) / bins;
  cnt.forEach((c, i) => { const x = pad + i * bw, h = (c / mc) * (H - 38); const mid = lo + (i + 0.5) * w; ctx.fillStyle = mid >= 0 ? '#059669' : '#dc2626'; ctx.fillRect(x, H - 20 - h, bw - 1, h); });
  ctx.fillStyle = '#9ca3af'; ctx.font = '11px Inter,sans-serif'; ctx.textAlign = 'left'; ctx.fillText(fmtM(lo), pad, H - 4); ctx.textAlign = 'right'; ctx.fillText(fmtM(hi), W - 4, H - 4); ctx.textAlign = 'center'; ctx.fillText('P&L brut', W / 2, H - 4);
}

// ---- courbe de vulnérabilité cycle 1 ----
// par tour : perte max d'une fuite unique (barres) vs couverture disponible (FGE + tranche SFD, ligne).
// un tour est "en alerte" (barre rouge) si une seule fuite épuiserait la couverture disponible.
// Démo de l'effet du filtre de score au cycle 1 : on balaie le taux de fuite et on compare,
// AVEC vs SANS filtre, le résiduel par pool (perte non couverte). Le filtre sélectionne les
// meilleurs profils, qui fuient moins -> moins de pertes. Toujours sur 1 pool isolé.
function drawFiltreDemo(p) {
  const cv = $('vulnCanvas'); if (!cv) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const fuites = [0.06, 0.12, 0.18, 0.25];
  const runs = Math.min(300, Math.max(120, p._runs * 2));
  const data = fuites.map(pf => {
    const base = { ...p, n_pools: 1, p_fuite_base: pf };
    const on = monteCarlo({ ...base, cycle1_scoring_actif: true }, runs, 12345);
    const off = monteCarlo({ ...base, cycle1_scoring_actif: false }, runs, 12345);
    return { pf, on: on.residuel.moy, off: off.residuel.moy };
  });
  const padL = 56, padR = 14, padB = 30, padT = 14;
  const mx = Math.max(...data.flatMap(d => [d.on, d.off]), 1);
  const n = data.length, plotW = W - padL - padR, plotH = H - padB - padT;
  const grp = plotW / n, bw = Math.min(34, grp * 0.3);
  const yb = v => padT + plotH - (v / mx) * plotH;
  ctx.strokeStyle = '#f3f4f6'; ctx.lineWidth = 1; ctx.fillStyle = '#9ca3af'; ctx.font = '10px Inter,sans-serif'; ctx.textAlign = 'right';
  for (let g = 0; g <= 4; g++) { const yy = padT + (g / 4) * plotH, val = mx * (1 - g / 4); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.fillText(fmtM(val), padL - 6, yy + 3); }
  data.forEach((d, i) => {
    const cx = padL + (i + 0.5) * grp;
    // sans filtre (rouge) à gauche, avec filtre (teal) à droite
    ctx.fillStyle = 'rgba(220,38,38,.80)'; ctx.fillRect(cx - bw - 3, yb(d.off), bw, padT + plotH - yb(d.off));
    ctx.fillStyle = '#0f4c4a'; ctx.fillRect(cx + 3, yb(d.on), bw, padT + plotH - yb(d.on));
    ctx.fillStyle = '#9ca3af'; ctx.textAlign = 'center'; ctx.font = '10px Inter,sans-serif'; ctx.fillText('fuite ' + Math.round(d.pf * 100) + '%', cx, H - 9);
  });
  const moyOff = data.reduce((s, d) => s + d.off, 0) / n, moyOn = data.reduce((s, d) => s + d.on, 0) / n;
  const gain = moyOff > 0 ? (1 - moyOn / moyOff) * 100 : 0;
  $('vulnLegende').innerHTML =
    `<span class="lg"><i class="sw" style="background:rgba(220,38,38,.80)"></i> sans filtre de score</span>` +
    `<span class="lg"><i class="sw" style="background:#0f4c4a"></i> avec filtre de score</span>` +
    `<span class="lg-note">Résiduel moyen par pool (perte non couverte) au cycle 1, selon le taux de fuite. Le filtre réduit la perte de ~${Math.round(gain)} % en moyenne ici : en réservant les premiers tours aux meilleurs profils (qui fuient ${Math.round((1 - (p.cycle1_reduction_fuite ?? 0.33)) * 100)} % de moins, par hypothèse), on évite les fuites précoces coûteuses quand le FGE est encore vide.</span>`;
}

// ---- page FLUX : déroulé d'un pool, tour par tour ----
let fluxGraine = 101;
const ACTEUR_CLS = { SFD: 'a-sfd', FGE: 'a-fge', Opérateur: 'a-op', Dépôt: 'a-depot', Épargnants: 'a-ep', Membres: 'a-mb', Groupe: 'a-mb' };
const TYPE_SIGNE = { fuite: 'neg', couverture: 'neg', résiduel: 'neg', remboursement: 'neg', service: 'pos', avance: 'pos', prime: 'pos', cotisation: 'pos', saisie: 'pos', recouvrement: 'pos', rémunération: 'pos', intérêts: 'pos', marge: 'pos', surplus: 'pos', rattrapage: 'pos', remplacement: 'pos' };

function renderFlux() {
  // démo : effet du filtre de score sur les pertes du cycle 1 (avec vs sans)
  drawFiltreDemo(PARAMS);

  const j = journalPool({ ...PARAMS }, fluxGraine);
  const nFuites = j.tours.reduce((s, tr) => s + tr.mvt.filter(m => m.type === 'fuite').length, 0);
  $('fluxResume').textContent = `Pool de ${j.m} membres · ${j.cycles} cycle${j.cycles > 1 ? 's' : ''} (${j.totalTours} tours) · pot = ${fmtM(j.pot)} · ${nFuites} fuite${nFuites !== 1 ? 's' : ''}, ${j.nRempl} remplacement${j.nRempl !== 1 ? 's' : ''}. Les flux suivent la mécanique exacte du moteur ; la fuite est tirée au hasard selon les paramètres.`;

  let html = '', cycleVu = 0;
  for (const tr of j.tours) {
    if (tr.cycle !== cycleVu) { cycleVu = tr.cycle; html += `<div class="flux-cycle">Cycle ${tr.cycle}</div>`; }
    const aFuite = tr.mvt.some(m => m.type === 'fuite');
    const lignes = tr.mvt.map(m => {
      const cls = ACTEUR_CLS[m.acteur] || 'a-mb';
      const signe = m.montant === 0 ? '' : (TYPE_SIGNE[m.type] === 'neg' || m.montant < 0 ? 'neg' : 'pos');
      const montant = m.montant === 0 ? '' : `<span class="flux-montant ${signe}">${m.montant > 0 ? '+' : ''}${fmtM(m.montant)}</span>`;
      return `<div class="flux-ligne"><span class="flux-acteur ${cls}">${m.acteur}</span><span class="flux-lib">${m.libelle}</span>${montant}</div>`;
    }).join('');
    html += `<div class="flux-tour${aFuite ? ' a-fuite' : ''}">
      <div class="flux-tour-hd"><span class="flux-t">Tour ${tr.tour}</span><span class="flux-phase ${tr.phase === 'emprunteur' ? 'ph-emp' : 'ph-ep'}">${tr.phase}</span>
        <span class="flux-soldes">dépôt ${fmtM(tr.depot)} · FGE ${fmtM(tr.fge)} · encours SFD ${fmtM(tr.expo)}</span></div>
      ${lignes}</div>`;
  }
  $('fluxJournal').innerHTML = html;
}
$('btnFluxReroll').addEventListener('click', () => { fluxGraine++; renderFlux(); });

// ---- init ----
PARAMS._runs = 80;
renderParametres();
$('o_runs').textContent = PARAMS._runs;
$('c_runs').value = PARAMS._runs;
lancer();
