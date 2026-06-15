import { DEFAUTS, monteCarlo, decompositionCout, journalPool, optimiser, boundsX } from './moteur.js?v=20';

// mode unitaire : quand la cotisation = 1, on lit les montants en multiples de cotisation (×c)
const unitaire = () => PARAMS && PARAMS.c === 1;
const fmtUnite = x => { const a = Math.abs(x); const s = a >= 100 ? Math.round(x).toLocaleString('fr-FR') : a >= 10 ? x.toFixed(1) : x.toFixed(2); return s + '×c'; };
const fmt = x => unitaire() ? fmtUnite(x) : Math.round(x).toLocaleString('fr-FR');
const fmtM = x => unitaire() ? fmtUnite(x) : (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1e3) + 'k');
// page Flux : montants détaillés à 2 décimales (×c en mode unitaire, sinon valeur complète XOF)
const fmtFlux = x => unitaire() ? x.toFixed(2) + '×c' : x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = x => (x * 100).toFixed(x * 100 < 1 && x > 0 ? 1 : 0) + '%';
const $ = id => document.getElementById(id);

// config maître unique (tous les paramètres) + nb de runs.
// cap_pct_pot : levier synthétique (cap SFD en % du pot) converti en cap_sfd_cotisations avant
// chaque run via configRun() — cap_sfd_cotisations = cap_pct_pot × (M−1).
let PARAMS = { ...DEFAUTS, _runs: 80, cap_pct_pot: 0.15 };

// convertit le cap % du pot en cap_sfd_cotisations (ce que le moteur consomme)
function configRun(p) {
  const cfg = { ...p };
  if (typeof cfg.cap_pct_pot === 'number') cfg.cap_sfd_cotisations = cfg.cap_pct_pot * Math.max(1, cfg.m_membres - 1);
  return cfg;
}

// ---- navigation : 2 onglets (Paramètres / Résultats) ----
function montrerOnglet(onglet) {
  document.querySelectorAll('#ongletSeg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.onglet === onglet));
  $('vue-parametres').hidden = (onglet !== 'parametres');
  $('vue-cadrage').hidden = (onglet !== 'cadrage');
  $('vue-resultats').hidden = (onglet !== 'resultats');
  $('vue-flux').hidden = (onglet !== 'flux');
  if (onglet === 'flux') renderFlux();
  if (onglet === 'cadrage') renderOptimisation();
}
document.querySelectorAll('#ongletSeg .seg-btn').forEach(b => b.addEventListener('click', () => montrerOnglet(b.dataset.onglet)));
function allerResultats() { montrerOnglet('resultats'); }

// ============ SCHÉMA DE TOUS LES PARAMÈTRES ============
const SCHEMA = [
  { grp: 'Structure du cercle', desc: "La taille et la durée des pools.", items: [
    { k: 'n_pools', nom: 'Nombre de pools', d: "Cercles en parallèle. 1 = vue unitaire (un seul pool) ; montez pour voir l'échelle du portefeuille.", t: 'range', min: 1, max: 100, step: 1 },
    { k: 'm_membres', nom: 'Membres par pool (M)', d: "Taille d'un cercle. Détermine le pot = (M−1)×cotisation.", t: 'range', min: 4, max: 20, step: 1 },
    { k: 'c', nom: 'Cotisation mensuelle', d: "Ce que chaque membre verse chaque mois. Mettez 1 pour raisonner en unités (tout devient un multiple de la cotisation).", t: 'logrange', min: 1, max: 100000, fmt: 'k' },
    { k: 'n_cycles', nom: 'Nombre de cycles', d: "Durée de vie du produit = M × cycles mois.", t: 'range', min: 1, max: 4, step: 1 },
    { k: 'k_max', nom: 'Max même secteur / pool', d: "Diversification : au plus K membres du même secteur par pool (limite la corrélation).", t: 'range', min: 1, max: 6, step: 1 },
  ]},
  { grp: 'Deux populations', desc: "Sépare emprunteurs (enchères, début) et épargnants (fin, rémunérés).", items: [
    { k: 'deux_populations', nom: 'Modèle deux populations', d: "Les premiers tours = emprunteurs (enchères) ; les derniers = épargnants (servis du plus sûr au moins sûr, rémunérés).", t: 'bool' },
    { k: 'x_tours_emprunteurs', nom: 'Décalage x (tours emprunteurs)', d: "Tours empruntables = round(M/2) + x. Les bornes min/max dépendent de M (boundsX). Plus haut = plus d'emprunteurs, plus de revenu, moins d'épargnants.", t: 'range', min: -3, max: 4, step: 1, dyn: 'x' },
    { k: 'part_emprunteurs_declares', nom: 'Part candidats-emprunteurs', d: "Part de membres qui déclarent vouloir emprunter ET sont jugés fiables (accès précoce).", t: 'range', min: 0.2, max: 0.9, step: 0.05, fmt: 'pct' },
    { k: 'part_bids_aux_epargnants', nom: 'Part des bids aux épargnants', d: "Fraction du surplus d'enchères reversée aux épargnants (leur rémunération).", t: 'range', min: 0, max: 0.8, step: 0.05, fmt: 'pct' },
    { k: 'r_depot_annuel', nom: 'Rémunération des dépôts', d: "Taux ANNUEL que la SFD verse sur les dépôts, mensualisé en composé ((1+r)^(1/12)−1). Rémunère l'épargne déjà déposée (pas l'argent du mois courant).", t: 'range', min: 0, max: 0.10, step: 0.01, fmt: 'pct' },
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
    { k: 'cap_pct_pot', nom: 'Cap SFD (% du pot)', d: "Skin in the game : la SFD absorbe jusqu'à ce % du pot en pertes par pool (après le FGE). Au-delà = rupture du dispositif.", t: 'range', min: 0, max: 0.50, step: 0.01, fmt: 'pct' },
    { k: 'fge_mutualise', nom: 'FGE mutualisé entre pools', d: "Non = chaque pool autonome (la solidité ne dépend que du pool, cadre « 1 pool »). Oui = un pool sain peut renflouer un pool en fuite.", t: 'bool' },
  ]},
  { grp: 'Profils & cycle 1', desc: "Les premiers tours du cycle 1 sont réservés (en interne) aux profils sûrs, servis tant qu'il en reste ; ils fuient moins.", items: [
    { k: 'part_eligibles_enchere', nom: 'Sévérité du scoring / offre de crédit', d: "Fraction du pool que l'Opérateur AUTORISE aux tours emprunteurs (offre de crédit, pas la demande). Sévérité basse = offre restreinte aux meilleurs profils, qui fuient moins. Le scoring peut se tromper : c'est une probabilité, pas une garantie.", t: 'range', min: 0.2, max: 1, step: 0.05, fmt: 'pct' },
    { k: 'red_fuite_eligible', nom: 'Fuite des profils sûrs', d: "Taux de fuite des profils sûrs, en proportion du taux de base (0,33 = ils fuient 3× moins). C'est ce qui rend la sélection protectrice.", t: 'range', min: 0.2, max: 1, step: 0.1, fmt: 'x' },
  ]},
  { grp: 'Coûts de structure', desc: "Charges du dispositif, déduites du P&L net (défaut 0 = net égal au brut).", items: [
    { k: 'cout_acquisition_membre', nom: "Coût d'acquisition / membre", d: "Coût one-shot par membre recruté (KYC, onboarding).", t: 'range', min: 0, max: 20000, step: 500, fmt: 'k' },
    { k: 'cout_ops_pool_mois', nom: 'Coût ops / pool / mois', d: "Coût opérationnel par pool et par mois (suivi, relances).", t: 'range', min: 0, max: 20000, step: 500, fmt: 'k' },
    { k: 'couts_fixes_mensuels', nom: 'Frais fixes mensuels', d: "Frais fixes mensuels du dispositif (structure), répartis sur les pools.", t: 'range', min: 0, max: 500000, step: 10000, fmt: 'k' },
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
const grpHtml = g => `
    <details class="param-groupe" open>
      <summary>${g.grp}<span class="grp-desc">${g.desc}</span></summary>
      ${g.items.map(it => paramRow(it)).join('')}
    </details>`;
function renderParametres() {
  // MODE 1 — exploration libre : TOUS les groupes (dont « Structure du cercle ») sur l'Exploration.
  $('paramGroupes').innerHTML = SCHEMA.map(grpHtml).join('');
  SCHEMA.flatMap(g => g.items).forEach(it => attachParam(it));
  majBornesX();
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
  if (it.t === 'range') el.addEventListener('input', e => { PARAMS[it.k] = +e.target.value; $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); if (it.k === 'm_membres') majBornesX(); marquerModifie(); });
  else if (it.t === 'logrange') el.addEventListener('input', e => { PARAMS[it.k] = logToVal(+e.target.value, it.min, it.max); $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); marquerModifie(); });
  else el.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { el.querySelectorAll('button').forEach(b => b.classList.remove('on')); btn.classList.add('on'); PARAMS[it.k] = (it.t === 'mode') ? btn.dataset.v : (btn.dataset.v === '1'); marquerModifie(); }));
}
// recalcule les bornes du curseur x (tours emprunteurs) selon M, via boundsX(M)
function majBornesX() {
  const el = $('px_x_tours_emprunteurs'); if (!el) return;
  const b = boundsX(PARAMS.m_membres);
  el.min = b.min; el.max = b.max;
  if (PARAMS.x_tours_emprunteurs < b.min) PARAMS.x_tours_emprunteurs = b.min;
  if (PARAMS.x_tours_emprunteurs > b.max) PARAMS.x_tours_emprunteurs = b.max;
  el.value = PARAMS.x_tours_emprunteurs;
  $('pv_x_tours_emprunteurs').textContent = fmtParam(PARAMS.x_tours_emprunteurs, undefined);
}
function syncParametres() { SCHEMA.flatMap(g => g.items).forEach(it => { const el = $('px_' + it.k); if (!el) return; if (it.t === 'range') { el.value = PARAMS[it.k]; $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); } else if (it.t === 'logrange') { el.value = valToLog(PARAMS[it.k], it.min, it.max); $('pv_' + it.k).textContent = fmtParam(PARAMS[it.k], it.fmt); } else { el.querySelectorAll('button').forEach(b => b.classList.toggle('on', (it.t === 'mode' ? b.dataset.v === PARAMS[it.k] : (b.dataset.v === '1') === !!PARAMS[it.k]))); } }); majBornesX(); majGardeFous(); }
function marquerModifie() { $('simStatus').textContent = '⟳ relancez pour voir l\'effet'; majGardeFous(); }

// ---- GARDE-FOUS (mode 1) : avertissements non bloquants au-dessus du bouton Lancer ----
// Pré-vérifiables sans run : éligibles enchère < 1, plus d'épargnant. Post-run (depuis le dernier
// monteCarlo) : usure tour 1 > 24%, perte résiduelle non nulle.
let dernierPourGardeFous = null;
function majGardeFous() {
  const host = $('exploGardeFous'); if (!host) return;
  const M = PARAMS.m_membres, pe = PARAMS.part_eligibles_enchere;
  const seuilEmp = PARAMS.deux_populations ? Math.max(1, Math.min(M, Math.round(M / 2) + PARAMS.x_tours_emprunteurs)) : M;
  const av = [];
  // pré-run (calculables sans simulation)
  if (M * pe < 1) av.push({ g: 'warn', t: 'Moins d\'1 emprunteur éligible', d: `M × sévérité = ${(M * pe).toFixed(2)} < 1 : aucun candidat n'est autorisé aux tours emprunteurs.` });
  if (PARAMS.deux_populations && seuilEmp >= M) av.push({ g: 'bad', t: 'Aucun épargnant', d: `tours emprunteurs (${seuilEmp}) ≥ M (${M}) : il ne reste personne pour la population épargnante (x trop élevé).` });
  // post-run (depuis le dernier résultat, valable uniquement si les leviers structurels
  // n'ont pas changé depuis le dernier calcul — sinon ces deux garde-fous sont en attente)
  const postFrais = dernierPourGardeFous && dernierPourGardeFous.cle === cleStruct(PARAMS);
  if (postFrais) {
    const d = dernierPourGardeFous;
    const usure1 = d.usureTour1;
    if (usure1 != null && usure1 > 0.24) av.push({ g: 'bad', t: 'Usure tour 1 > 24% — non conforme BCEAO/UEMOA', d: `coût du crédit-relais annualisé au tour 1 ≈ ${(usure1 * 100).toFixed(1)}% (> 24%).` });
    if (d.residuelMoy != null && d.residuelMoy > 1e-6) av.push({ g: 'bad', t: 'Perte résiduelle non nulle — promesse menacée', d: `résiduel moyen / pool ≈ ${fmtM(d.residuelMoy)} (perte sèche non couverte).` });
  }
  host.hidden = false;
  if (!av.length) {
    // aucun garde-fou : encart vert discret. Précise si l'usure/résiduel restent à vérifier.
    const note = postFrais ? 'usure tour 1 et perte résiduelle conformes au dernier calcul.' : 'lancez pour vérifier l\'usure tour 1 et la perte résiduelle.';
    host.innerHTML = `<div class="gf-item gf-ok"><span class="gf-t">Config valide</span><span class="gf-d">${note}</span></div>`;
    return;
  }
  host.innerHTML = `<div class="gf-titre">Avertissements</div>` + av.map(a =>
    `<div class="gf-item gf-${a.g}"><span class="gf-t">${a.t}</span><span class="gf-d">${a.d}</span></div>`).join('');
}
// usure annualisée au tour 1, formule du moteur (tauxUsureConfig) appliquée à un résultat monteCarlo :
// (coutTour1.moy / pot) × 12 / (M−1).
function usureTour1(res, p) {
  const pot = (p.m_membres - 1) * p.c; if (pot <= 0) return null;
  return (res.coutTour1.moy / pot) * (12 / Math.max(1, p.m_membres - 1));
}

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
    // mémorise les indicateurs post-run pour les garde-fous (usure tour 1, résiduel),
    // attachés aux leviers structurels courants (M, c, x, sévérité, fuite, cap).
    dernierPourGardeFous = {
      usureTour1: usureTour1(a, PARAMS),
      residuelMoy: a.residuel.moy,
      cle: cleStruct(PARAMS),
    };
    renderKPIs(a, PARAMS);
    renderCoutDecompo(PARAMS);
    renderFluxSfd(a, PARAMS);
    renderTableauScenarios();
    drawPnlDist(a);
    majGardeFous();
    $('btnRun').textContent = 'Lancer';
    $('simStatus').textContent = 'calculé';
    allerResultats();
  }, 20);
}
// signature des leviers structurels : si l'un change, les indicateurs post-run ne s'appliquent plus
function cleStruct(p) { return [p.m_membres, p.c, p.x_tours_emprunteurs, p.part_eligibles_enchere, p.p_fuite_base, p.cap_pct_pot, p.n_cycles, p.deux_populations].join('|'); }

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
// Démo de l'effet de la sélection au cycle 1 : on balaie le taux de fuite et on compare le résiduel
// par pool AVEC la part de profils éligibles courante vs SANS sélection (aucun éligible réservé).
// Réserver les premiers tours aux bons profils (qui fuient moins) réduit les pertes. 1 pool isolé.
function drawFiltreDemo(p) {
  const cv = $('vulnCanvas'); if (!cv) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const fuites = [0.06, 0.12, 0.18, 0.25];
  const runs = Math.min(300, Math.max(120, p._runs * 2));
  const data = fuites.map(pf => {
    const base = { ...p, n_pools: 1, p_fuite_base: pf };
    const on = monteCarlo({ ...base }, runs, 12345);                       // profils sûrs servis tôt (fuient moins)
    const off = monteCarlo({ ...base, red_fuite_eligible: 1 }, runs, 12345); // même compo, mais sûrs ne fuient pas moins
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
  const facteur = (p.red_fuite_eligible ?? 0.33);
  $('vulnLegende').innerHTML =
    `<span class="lg"><i class="sw" style="background:rgba(220,38,38,.80)"></i> profils sûrs fuient autant que les autres</span>` +
    `<span class="lg"><i class="sw" style="background:#0f4c4a"></i> profils sûrs fuient ${facteur < 1 ? (1 / facteur).toFixed(1) + '×' : ''} moins (réservés aux 1ers tours)</span>` +
    `<span class="lg-note">Résiduel moyen par pool (moyenne Monte Carlo), selon le taux de fuite. Réserver les premiers tours du cycle 1 aux profils sûrs — qui fuient moins — réduit la perte de ~${Math.round(gain)} % en moyenne : on évite les fuites précoces coûteuses quand le FGE est encore vide.</span>`;
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
  $('fluxResume').textContent = `Pool de ${j.m} membres · ${j.cycles} cycle${j.cycles > 1 ? 's' : ''} (${j.totalTours} tours) · pot = ${fmtFlux(j.pot)} · ${nFuites} fuite${nFuites !== 1 ? 's' : ''}, ${j.nRempl} remplacement${j.nRempl !== 1 ? 's' : ''}. Les flux suivent la mécanique exacte du moteur ; la fuite est tirée au hasard selon les paramètres.`;

  let html = '', cycleVu = 0;
  for (const tr of j.tours) {
    if (tr.cycle !== cycleVu) { cycleVu = tr.cycle; html += `<div class="flux-cycle">Cycle ${tr.cycle}</div>`; }
    const aFuite = tr.mvt.some(m => m.type === 'fuite');
    const lignes = tr.mvt.map(m => {
      const cls = ACTEUR_CLS[m.acteur] || 'a-mb';
      const signe = m.montant === 0 ? '' : (TYPE_SIGNE[m.type] === 'neg' || m.montant < 0 ? 'neg' : 'pos');
      const montant = m.montant === 0 ? '' : `<span class="flux-montant ${signe}">${m.montant > 0 ? '+' : ''}${fmtFlux(m.montant)}</span>`;
      return `<div class="flux-ligne"><span class="flux-acteur ${cls}">${m.acteur}</span><span class="flux-lib">${m.libelle}</span>${montant}</div>`;
    }).join('');
    html += `<div class="flux-tour${aFuite ? ' a-fuite' : ''}">
      <div class="flux-tour-hd"><span class="flux-t">Tour ${tr.tour}</span><span class="flux-phase ${tr.phase === 'emprunteur' ? 'ph-emp' : 'ph-ep'}">${tr.phase}</span>
        <span class="flux-soldes">dépôt ${fmtFlux(tr.depot)} · FGE ${fmtFlux(tr.fge)} · encours SFD ${fmtFlux(tr.expo)}</span></div>
      ${lignes}</div>`;
  }
  $('fluxJournal').innerHTML = html;
}
$('btnFluxReroll').addEventListener('click', () => { fluxGraine++; renderFlux(); });

// ============ MODE 2 — OPTIMISATION PAR SEGMENT ============
// Trois segments de population, caractérisés par leur taux de fuite. Pour chaque segment,
// l'optimiseur (moteur) balaie une grille (M, x, n_cycles, sévérité) et retient la config qui
// maximise le P&L net/pool sous contraintes (promesse>=99%, usure<=24%, résiduel/pot<=0,5%),
// puis évalue sa robustesse et propose une config recommandée (marge>=50%).
const SEGMENTS = [
  { id: 'salaries',   nom: 'Salariés formels',       p_fuite: 0.04, c: 50000 },
  { id: 'commercants', nom: 'Commerçants / informel', p_fuite: 0.08, c: 50000 },
  { id: 'primo',      nom: 'Primo-accédants',        p_fuite: 0.12, c: 50000 },
];
// grille de recherche (informative + reflète les défauts du moteur optimiser())
const GRILLE_OPT = { Ms: [4, 6, 8, 10, 12, 15, 20], xs: [-2, -1, 0, 1, 2, 3], cycles: [1, 2, 3, 4], severites: [0.3, 0.5, 0.7, 1.0] };
const RUNS_OPT = 150;
let resOptParSeg = {};   // id segment -> { seg, sortie } du dernier calcul

function renderOptimisation() {
  // panneau « espace de recherche » (affiché une fois)
  const esp = $('optEspace');
  if (esp && !esp.dataset.rendu) {
    esp.dataset.rendu = '1';
    esp.innerHTML = `
      <div class="opt-grille-ligne"><span class="lbl">Taille M</span><span class="val">${GRILLE_OPT.Ms.join(', ')}</span></div>
      <div class="opt-grille-ligne"><span class="lbl">Décalage x</span><span class="val">${GRILLE_OPT.xs.join(', ')} <span class="hint">(borné par boundsX(M))</span></span></div>
      <div class="opt-grille-ligne"><span class="lbl">Cycles</span><span class="val">${GRILLE_OPT.cycles.join(', ')}</span></div>
      <div class="opt-grille-ligne"><span class="lbl">Sévérité du scoring</span><span class="val">${GRILLE_OPT.severites.map(s => (s * 100) + '%').join(', ')}</span></div>
      <div class="opt-grille-ligne"><span class="lbl">Cotisation c (par segment)</span><span class="val">${SEGMENTS.map(s => fmtM(s.c)).join(' · ')}</span></div>
      <div class="opt-grille-ligne"><span class="lbl">Runs Monte Carlo</span><span class="val">${RUNS_OPT} (balayage) · 1000 (finales)</span></div>
      <div class="opt-grille-ligne"><span class="lbl">Paramètres SFD</span><span class="val">taux avances 18% · rémun. dépôts 5% · cap 15% du pot</span></div>`;
  }
  // cartes de segments (rendues une fois, mises à jour à la demande)
  const host = $('segCards');
  if (host && !host.dataset.rendu) {
    host.dataset.rendu = '1';
    host.innerHTML = SEGMENTS.map(s => `
      <div class="seg-card" id="segc_${s.id}">
        <div class="seg-card-hd">
          <div>
            <div class="seg-card-nom">${s.nom}</div>
            <div class="seg-card-sub">taux de fuite ${(s.p_fuite * 100).toFixed(0)}% · cotisation ${fmtM(s.c)}</div>
          </div>
          <button class="btn big seg-opt-btn" data-seg="${s.id}">Optimiser ce segment</button>
        </div>
        <div class="seg-card-body" id="segb_${s.id}"><p class="muted">Cliquez « Optimiser ce segment » pour lancer la recherche (≈ 15–20 s).</p></div>
      </div>`).join('');
    host.querySelectorAll('.seg-opt-btn').forEach(b => b.addEventListener('click', () => optimiserSegment(b.dataset.seg)));
  }
}

function optimiserSegment(id) {
  const seg = SEGMENTS.find(s => s.id === id); if (!seg) return;
  const btn = document.querySelector(`.seg-opt-btn[data-seg="${id}"]`);
  if (btn) { btn.textContent = 'Calcul…'; btn.disabled = true; }
  setTimeout(() => {
    const r = optimiser({ ...PARAMS }, { segments: [{ nom: seg.nom, p_fuite: seg.p_fuite, c: seg.c }], runs: RUNS_OPT });
    const sortie = r.segments[0];
    resOptParSeg[id] = { seg, sortie };
    renderSegResultat(id);
    if (btn) { btn.textContent = 'Relancer'; btn.disabled = false; }
  }, 20);
}

// formate une config (optimale ou recommandée) en grille de KPI
function cfgMetrics(seg, x, extra = []) {
  const pot = (x.M - 1) * seg.c;
  const kpis = [
    ['Taille M', '' + x.M],
    ['Décalage x', (x.x >= 0 ? '+' : '') + x.x],
    ['Cycles', '' + x.n_cycles],
    ['Sévérité', (x.severite * 100).toFixed(0) + '%'],
    ['Promesse / pool', `<span class="${x.promesse >= 0.99 ? 'ok' : x.promesse >= 0.95 ? '' : 'bad'}">${(x.promesse * 100).toFixed(1)}%</span>`],
    ['Perte résiduelle / pot', `<span class="${x.residuelPot <= 0.005 ? 'ok' : 'bad'}">${(x.residuelPot * 100).toFixed(2)}%</span>`],
    ['Usure (≤24%)', `<span class="${x.usure <= 0.24 ? 'ok' : 'bad'}">${(x.usure * 100).toFixed(1)}%</span>`],
    ['P&L net / pool', `<span class="${x.pnlNet > 0 ? 'ok' : 'bad'}">${fmtM(x.pnlNet)}</span>`],
    ['Rémun. épargnant', fmtM(x.remunEparg)],
    ...extra,
  ];
  return `<div class="cfg-grid2">${kpis.map(k => `<div class="cfg-kpi"><span class="lbl">${k[0]}</span><span class="val">${k[1]}</span></div>`).join('')}</div>`;
}

function renderSegResultat(id) {
  const o = resOptParSeg[id]; if (!o) return;
  const { seg, sortie } = o;
  const host = $('segb_' + id);
  let html = '';

  // ---- config OPTIMALE ----
  if (!sortie.faisable || !sortie.optimale) {
    html += `<div class="seg-bloc"><div class="cfg-titre">Configuration optimale</div>
      <p class="seg-echec">Aucune configuration ne satisfait les contraintes (promesse ≥ 99 %, usure ≤ 24 %, perte/pot ≤ 0,5 %) pour ce segment.</p></div>`;
    $('segb_' + id).innerHTML = html;
    return;
  }
  const opt = sortie.optimale;
  html += `<div class="seg-bloc"><div class="cfg-titre">Configuration optimale <span class="hint">maximise le P&amp;L net/pool</span></div>
    ${cfgMetrics(seg, opt)}
    <div class="seg-pont"><button class="btn ghost pont-btn" data-seg="${id}" data-cfg="optimale">Charger dans l'exploration manuelle →</button></div></div>`;

  // ---- ROBUSTESSE ----
  const marge = sortie.marge_securite;
  const margeTxt = marge == null ? 'n/d' : '≥ ' + Math.round(marge * 100) + '%';
  const margeCls = (marge != null && marge >= 0.5) ? 'ok' : 'bad';
  const ruptTxt = sortie.p_fuite_rupture == null ? 'aucune rupture observée sur le balayage (jusqu\'à +100 %)' : `fuite de rupture ≈ ${(sortie.p_fuite_rupture * 100).toFixed(1)}%`;
  html += `<div class="seg-bloc"><div class="cfg-titre">Robustesse <span class="hint">promesse vs taux de fuite</span></div>
    <canvas class="rob-canvas" id="robc_${id}" width="520" height="150"></canvas>
    <div class="rob-meta"><span>${ruptTxt}</span><span class="rob-marge ${margeCls}">marge de sécurité ${margeTxt}</span></div></div>`;

  // ---- config RECOMMANDÉE ----
  if (sortie.recommandee) {
    const rec = sortie.recommandee;
    const extra = [['Marge de sécurité', `<span class="ok">${Math.round(rec.marge_securite * 100)}%</span>`]];
    html += `<div class="seg-bloc"><div class="cfg-titre">Configuration recommandée <span class="hint">robuste, marge ≥ 50 %</span></div>
      ${cfgMetrics(seg, rec, extra)}
      <div class="seg-pont"><button class="btn ghost pont-btn" data-seg="${id}" data-cfg="recommandee">Charger dans l'exploration manuelle →</button></div></div>`;
  } else {
    html += `<div class="seg-bloc"><div class="cfg-titre">Configuration recommandée</div>
      <p class="seg-echec">Aucune config robuste à marge ≥ 50 % — ne pas pitcher cette config, elle casse au premier choc.</p></div>`;
  }

  host.innerHTML = html;
  // graphe robustesse
  drawRobustesse(id, sortie.robustesse, seg.p_fuite);
  // pont
  host.querySelectorAll('.pont-btn').forEach(b => b.addEventListener('click', () => chargerDansExploration(b.dataset.seg, b.dataset.cfg)));
}

// mini-graphe : promesse (y, 0–100%) vs p_fuite (x) sur le balayage de robustesse[]
function drawRobustesse(id, pts, pfBase) {
  const cv = $('robc_' + id); if (!cv || !pts || !pts.length) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height; ctx.clearRect(0, 0, W, H);
  const padL = 40, padR = 12, padT = 12, padB = 24;
  const xs = pts.map(p => p.p_fuite), ys = pts.map(p => p.promesse);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(0.9, Math.min(...ys)), ymax = 1;
  const px = v => padL + (xmax > xmin ? (v - xmin) / (xmax - xmin) : 0.5) * (W - padL - padR);
  const py = v => padT + (1 - (v - ymin) / (ymax - ymin)) * (H - padT - padB);
  // grille + axes
  ctx.strokeStyle = '#f3f4f6'; ctx.fillStyle = '#9ca3af'; ctx.font = '10px Inter,sans-serif'; ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let g = 0; g <= 2; g++) { const yv = ymin + g / 2 * (ymax - ymin); const yy = py(yv); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke(); ctx.fillText((yv * 100).toFixed(0) + '%', padL - 5, yy + 3); }
  // seuil 99%
  if (0.99 >= ymin) { const y99 = py(0.99); ctx.strokeStyle = '#dc2626'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(padL, y99); ctx.lineTo(W - padR, y99); ctx.stroke(); ctx.setLineDash([]); }
  // courbe promesse
  ctx.strokeStyle = 'var(--acc)'; ctx.strokeStyle = '#0f4c4a'; ctx.lineWidth = 2; ctx.beginPath();
  pts.forEach((p, i) => { const X = px(p.p_fuite), Y = py(p.promesse); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.stroke();
  ctx.fillStyle = '#0f4c4a'; pts.forEach(p => { ctx.beginPath(); ctx.arc(px(p.p_fuite), py(p.promesse), 2.5, 0, 2 * Math.PI); ctx.fill(); });
  // marqueur p_fuite du segment
  ctx.strokeStyle = '#9ca3af'; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(px(pfBase), padT); ctx.lineTo(px(pfBase), H - padB); ctx.stroke(); ctx.setLineDash([]);
  // labels x (min/max et base)
  ctx.fillStyle = '#9ca3af'; ctx.textAlign = 'left'; ctx.fillText((xmin * 100).toFixed(0) + '%', padL, H - 8);
  ctx.textAlign = 'right'; ctx.fillText((xmax * 100).toFixed(0) + '%', W - padR, H - 8);
  ctx.textAlign = 'center'; ctx.fillText('taux de fuite', W / 2, H - 8);
}

// ============ LE PONT : mode 2 -> mode 1 ============
// Injecte la config (optimale | recommandée) d'un segment dans PARAMS, met à jour les curseurs,
// bascule sur l'Exploration et affiche un bandeau de rappel.
function chargerDansExploration(id, quelle) {
  const o = resOptParSeg[id]; if (!o) return;
  const cfg = quelle === 'recommandee' ? o.sortie.recommandee : o.sortie.optimale;
  if (!cfg) return;
  const seg = o.seg;
  // injection des leviers de la config (les paramètres SFD négociés restent par défaut)
  PARAMS.m_membres = cfg.M;
  majBornesX();   // recale les bornes de x sur le nouveau M avant d'imposer x
  PARAMS.x_tours_emprunteurs = cfg.x;
  PARAMS.n_cycles = cfg.n_cycles;
  PARAMS.part_eligibles_enchere = cfg.severite;
  PARAMS.p_fuite_base = seg.p_fuite;
  PARAMS.c = seg.c;
  PARAMS.deux_populations = true;   // le modèle d'optimisation suppose deux populations
  syncParametres();   // reflète tout dans les curseurs + recalcule garde-fous
  // bandeau de rappel (config issue de l'optimisation)
  const bd = $('exploBandeau'), tx = $('exploBandeauTxt');
  if (bd && tx) {
    tx.innerHTML = `Config issue de l'optimisation — segment <b>${seg.nom}</b>, taux de fuite = ${(seg.p_fuite * 100).toFixed(0)}% (config ${quelle === 'recommandee' ? 'recommandée' : 'optimale'}). Lancez telle quelle ou ajustez.`;
    bd.hidden = false;
  }
  montrerOnglet('parametres');
}
$('exploBandeauX') && $('exploBandeauX').addEventListener('click', () => { $('exploBandeau').hidden = true; });

// ---- init ----
PARAMS._runs = 80;
renderParametres();
renderOptimisation();   // peuple l'onglet Optimisation (espace de recherche + cartes segments)
majGardeFous();         // encart garde-fous initial (avant tout run)
$('o_runs').textContent = PARAMS._runs;
$('c_runs').value = PARAMS._runs;
lancer();
