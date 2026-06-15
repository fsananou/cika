/* moteur.js — Port JavaScript du modèle « tontine SFD v2 » (crédit-relais + promesse).
 *
 * Fidèle au moteur Python (config.py / compte.py / fuite.py / moteur.py / pnl.py / promesse.py).
 * Nommage neutre : Operateur, SFD, Membre, Pool, FGE.
 *
 * Mécanique : crédit-relais (gagnant reçoit pot − bid, SFD avance, récup linéaire), prime de
 * garantie obligatoire ∝ avance (mode garanti), bid optionnel pour la position, fuite
 * conditionnelle post-encaissement, cascade de couverture FGE → tranche SFD → résiduel.
 * Modes : "nue" (sans garantie, sans bid) vs "garantie".
 */

// ---- RNG + normale ----
function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gaussian(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function erf(x) { const s = Math.sign(x), ax = Math.abs(x); const t = 1 / (1 + 0.3275911 * ax); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax); return s * y; }
function Phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function PhiInv(p) { p = Math.min(Math.max(p, 1e-12), 1 - 1e-12); const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00], b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01], c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00], d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]; const pl = 0.02425, ph = 1 - pl; let q, r; if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); } if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); } q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
function quantile(s, q) { if (!s.length) return 0; const pos = (s.length - 1) * q, b = Math.floor(pos), r = pos - b; return s[b + 1] !== undefined ? s[b] + r * (s[b + 1] - s[b]) : s[b]; }
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
// (le facteur de réduction de fuite des profils sûrs est exposé en paramètre : red_fuite_eligible)

// ---- Config par défaut (miroir de config.py, coût fixe = 0) ----
export const DEFAUTS = {
  // structure
  n_pools: 50, m_membres: 10, c: 100000, n_cycles: 2, k_max: 3,
  // produit : "nue" | "garantie"
  mode: "garantie", prime_facteur_prudence: 1.0,
  // compte / SFD
  r_sfd_annuel: 0.18,
  // enchère
  prime_operateur_taux: 0.015, rho_mensuel: 0.02, bid_bruit_sigma: 0.25, bid_plafond_frac_pot: 0.12,
  // MODÈLE À DEUX POPULATIONS : les premiers tours (N/2 + x) sont aux enchères (EMPRUNTEURS),
  // les suivants sont des ÉPARGNANTS servis dans l'ordre aléatoire, depuis le dépôt, rémunérés.
  deux_populations: true,
  // tours emprunteurs = round(M/2) + x. x est CLAMPÉ par boundsX(M) dans simulerRun pour
  // garantir au moins 1 emprunteur ET 1 épargnant : x ∈ [-round(M/2)+1, round(M/2)].
  x_tours_emprunteurs: 0,        // décalage par rapport à N/2 (0 = moitié/moitié)
  part_emprunteurs_declares: 0.55, // part de membres qui DÉCLARENT vouloir emprunter (DEMANDE de crédit)
  // rémunération des épargnants (puisée dans le surplus de bids + intérêts sur dépôts)
  part_bids_aux_epargnants: 0.40, // part des surplus de bids reversée aux épargnants
  r_depot_annuel: 0.05,          // intérêt que la SFD verse sur les dépôts (rémunère l'épargne)
  // préférences
  part_urgent: 0.20, part_modere: 0.50, part_epargnant: 0.30,
  urg_urgent: 1.60, urg_modere: 1.00, urg_epargnant: 0.55,
  // fuite
  p_fuite_base: 0.06, fuite_mult_tour_precoce: 1.8, charge_z_fuite: 0.35,
  taux_echec_friction: 0.03, prelevement_auto_efficacite: 0.7,
  // ARRÊT d'un membre NON encaisseur (cas 2, règle 5) : DISTINCT de la fuite. Proba MENSUELLE
  // qu'un membre n'ayant pas encore encaissé arrête. Il n'a rien reçu -> AUCUN trou sur les
  // avances ; son slot est marqué vacant et remplacé via la liste d'attente (A3).
  taux_arret_non_encaisseur: 0.01,
  // LISTE D'ATTENTE (règle 3) : R remplaçants scorés par pool. Une fuite/arrêt au mois t -> le
  // PROCHAIN remplaçant dispo entre au mois t+1, prend le PROCHAIN slot libre (pas celui du
  // fuyard), cotise dès t+1, sans droit aux tours passés. Liste épuisée = pas de remplacement.
  n_remplacants: 3,
  // couverture (3 étages)
  mitigation_active: true, acces_sequence_active: true, t_restreint: 3, part_avec_historique: 0.50,
  garantie_enchere_active: true, g_cotisations: 1,
  prime_active: true, fge_actif: true,
  tranche_sfd_active: true, plafond_tranche_sfd_frac: 0.15,
  // CAP SFD (skin in the game) exprimé en NOMBRE DE COTISATIONS, cumulé sur le pool : la SFD
  // accepte d'absorber jusqu'à cap_sfd_cotisations × c de pertes (avances de fuyards non
  // remboursées) après le FGE. Au-delà = rupture du dispositif (promesse cassée).
  cap_sfd_cotisations: 4,
  // FGE/tranche SFD isolés par pool (défaut) : la solidité d'un pool ne dépend que de lui-même.
  // true = mutualisés entre tous les pools (un pool sain peut renflouer un pool en fuite).
  fge_mutualise: false,
  // CYCLE 1 (règles internes) : les premiers tours sont réservés aux profils « éligibles enchère »
  // (bons scores), qui fuient moins. Les seuils et la réduction de fuite sont internes.
  // SÉVÉRITÉ DU SCORING — part_eligibles_enchere est l'OFFRE de crédit : la fraction du pool que
  // l'OPÉRATEUR AUTORISE à accéder aux tours emprunteurs. C'est DISTINCT de
  // part_emprunteurs_declares (la DEMANDE). Un membre est eligibleEnchere ssi il DÉCLARE emprunter
  // (demande) ET tombe dans la fraction autorisée par le scoring (offre) : eligibleEnchere =
  // candidatEmp(demande) × tirage<part_eligibles_enchere(offre). Sévérité basse = offre restreinte.
  part_eligibles_enchere: 0.55,  // OFFRE/sévérité : fraction des candidats-emprunteurs autorisée
  red_fuite_eligible: 0.33,      // les profils sûrs fuient à ce facteur du taux de base (0,33 = 3× moins)
  // CYCLE 1 — déclenchement de l'enchère (règle 4b) : l'enchère du tour ne s'ouvre que si les
  // cotisations collectées >= alpha*M*c. Sinon déclenchement FORCÉ sur le solde dispo (pas de gel).
  // (Le « délai 5 jours » du cadre réel n'est pas simulé en pas mensuel.)
  alpha_declenchement: 0.8,
  // CYCLE 1 — FGE pré-alimenté (règle 4c) : chaque emprunteur déclaré verse 1*c en prime de
  // démarrage, créditée au FGE AVANT le tour 1.
  prime_demarrage_actif: true,
  // risque
  pd_base_annuel: 0.08, pd_base_sigma: 0.04,
  secteurs: [["commerce", 0.30, 0.30], ["agriculture", 0.20, 0.45], ["transport", 0.15, 0.25], ["services", 0.20, 0.15], ["artisanat", 0.15, 0.20]],
  // stress
  comportemental_actif: false, choc_fuite: 0.0, bascule_urgents: 0.0,
  macro_actif: false, z_choc: 0.0, z_persistance: 0,
  // P&L : on expose le BRUT (revenus du mécanisme) ET le NET (brut − coûts de structure).
  // Coûts de structure PARAMÉTRABLES, défauts à 0 (P&L net = P&L brut tant que non renseignés) :
  //  - cout_acquisition_membre : one-shot par membre recruté (KYC, onboarding)
  //  - cout_ops_pool_mois       : coût opérationnel par pool et par mois (suivi, relances)
  //  - couts_fixes_mensuels     : frais fixes mensuels du dispositif (structure)
  cout_acquisition_membre: 0, cout_ops_pool_mois: 0, couts_fixes_mensuels: 0, cout_capital_annuel: 0.10,
  // plafond réglementaire BCEAO/UEMOA : le coût du crédit-relais annualisé ne doit pas dépasser ça.
  taux_usure_annuel: 0.24,
};

const rSfdMensuel = p => p.r_sfd_annuel / 12;

// Bornes admissibles de x (décalage des tours emprunteurs autour de round(M/2)) : garantir au
// moins 1 emprunteur (x >= -round(M/2)+1) ET au plus M tours emprunteurs (x <= round(M/2)).
// NB : seuilEmp = round(M/2)+x est en outre clampé à [1, M-1] dans simulerRun pour qu'il reste
// au moins 1 épargnant (sauf si deux_populations=false où tout le pool emprunte).
export function boundsX(M) {
  const h = Math.round(M / 2);
  return { min: -h + 1, max: h };
}

// ---- prime de garantie (∝ avance, décroît avec le tour) ----
export function primeGarantie(avance, duree, p_fuite, dureeMax, facteurPrudence) {
  if (avance <= 0) return 0;
  return facteurPrudence * p_fuite * (avance / 2) * (duree / Math.max(1, dureeMax));
}

// ---- proba de fuite mensuelle (depuis proba totale) ----
function probaFuite(pTotal, tEnc, m, z, moisRestants, chargeZ, multPrecoce, choc) {
  const frac = m > 1 ? (tEnc - 1) / (m - 1) : 0;
  const mult = multPrecoce + (1 - multPrecoce) * frac;
  let p = pTotal * mult;
  if (chargeZ > 0) { p = Math.min(Math.max(p, 1e-6), 1 - 1e-6); const logit = Math.log(p / (1 - p)) - chargeZ * z; p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit)))); }
  p = Math.min(Math.max(p + choc, 0), 1);
  const d = Math.max(1, moisRestants);
  return Math.min(Math.max(1 - Math.pow(1 - p, 1 / d), 0), 1);
}

// ---- profils sectoriels (charge Vasicek) ----
function tirerProfils(rng, n, p) {
  const noms = p.secteurs.map(s => s[0]); let parts = p.secteurs.map(s => s[1]); const sp = parts.reduce((a, b) => a + b, 0); parts = parts.map(x => x / sp);
  const cum = []; let acc = 0; for (const x of parts) { acc += x; cum.push(acc); }
  const charges = {}; p.secteurs.forEach(s => charges[s[0]] = s[2]);
  const out = [];
  for (let i = 0; i < n; i++) { const r = rng(); let si = 0; while (si < cum.length - 1 && r > cum[si]) si++; const sec = noms[si]; let pa = Math.min(Math.max(p.pd_base_annuel + gaussian(rng) * p.pd_base_sigma, 0.005), 0.60); const pm = 1 - Math.pow(1 - pa, 1 / 12); out.push({ secteur: sec, rho: charges[sec], seuil: PhiInv(pm) }); }
  return out;
}
function composerPools(rng, profils, m, kMax) {
  const n = profils.length, nP = Math.floor(n / m); const pools = Array.from({ length: nP }, () => []); const cnt = Array.from({ length: nP }, () => ({}));
  const parts = {}; profils.forEach(pr => parts[pr.secteur] = (parts[pr.secteur] || 0) + 1);
  const ordre = profils.map((_, i) => i).sort((i, j) => { const pi = parts[profils[i].secteur], pj = parts[profils[j].secteur]; if (pi !== pj) return pj - pi; return profils[j].rho - profils[i].rho; });
  for (const i of ordre) { const sec = profils[i].secteur; const ouverts = []; for (let pp = 0; pp < nP; pp++) if (pools[pp].length < m) ouverts.push(pp); if (!ouverts.length) continue; const conf = ouverts.filter(pp => (cnt[pp][sec] || 0) < kMax); let pc = conf.length ? conf.reduce((b, pp) => pools[pp].length < pools[b].length ? pp : b, conf[0]) : ouverts.reduce((b, pp) => (cnt[pp][sec] || 0) < (cnt[b][sec] || 0) ? pp : b, ouverts[0]); pools[pc].push(i); cnt[pc][sec] = (cnt[pc][sec] || 0) + 1; }
  return pools.filter(pl => pl.length === m);
}
function pdCond(seuil, rho, z) { return Phi((seuil - Math.sqrt(rho) * z) / Math.sqrt(Math.max(1e-9, 1 - rho))); }
function tirerZ(rng, p, etat) { if (!p.macro_actif || p.z_choc === 0) return gaussian(rng); if (p.z_persistance > 0 && etat.restant > 0) { etat.restant--; return etat.courant; } const z = p.z_choc + gaussian(rng) * 0.6; if (p.z_persistance > 0) { etat.courant = z; etat.restant = p.z_persistance - 1; } return z; }

// ---- simulation d'un run (portefeuille) ----
export function simulerRun(p, graine) {
  const rng = mulberry32(graine);
  const m = p.m_membres, totalTours = m * p.n_cycles, vie = totalTours;
  const pot = (m - 1) * p.c, rSfd = rSfdMensuel(p);
  const profils = tirerProfils(rng, p.n_pools * m, p);
  const poolsIdx = composerPools(rng, profils, m, p.k_max);
  const nPools = poolsIdx.length;
  const etatZ = {}; const zMois = []; for (let t = 0; t < totalTours; t++) zMois.push(tirerZ(rng, p, etatZ));

  function pref() { const r = rng(); if (r < p.part_urgent) return ["urgent", p.urg_urgent]; if (r < p.part_urgent + p.part_modere) return ["modere", p.urg_modere]; return ["epargnant", p.urg_epargnant]; }
  // seuil emprunteurs / épargnants : round(M/2) + x, x clampé par boundsX(M) (A2). Le seuilEmp est
  // ensuite borné à [1, m-1] en deux-populations pour qu'il reste au moins 1 emprunteur ET 1 épargnant.
  const bx = boundsX(m);
  const xClamp = Math.min(bx.max, Math.max(bx.min, p.x_tours_emprunteurs || 0));
  const seuilEmp = p.deux_populations
    ? Math.min(m - 1, Math.max(1, Math.round(m / 2) + xClamp))
    : m;
  const rDepotMensuel = Math.pow(1 + (p.r_depot_annuel || 0), 1 / 12) - 1;  // mensualisation composée
  // SCORING CYCLE 1 (A4a) : seuil PD décroissant linéairement de P90 (tour 1) à P50 (tour seuilEmp).
  // mb.seuil = seuil Vasicek déjà tiré (seuil bas = PD basse = plus fiable). Seuls les membres sous
  // le seuil PD du tour accèdent à l'enchère de ce tour, au cycle 1.
  const pools = []; const comptes = [];
  for (let pid = 0; pid < nPools; pid++) {
    const membres = poolsIdx[pid].map((gi, i) => {
      const pr = profils[gi]; let [tp, urg] = pref();
      if (p.comportemental_actif && (tp === "modere" || tp === "epargnant") && rng() < p.bascule_urgents) { tp = "urgent"; urg = p.urg_urgent; }
      const aHist = rng() < p.part_avec_historique;
      // DEMANDE : le membre DÉCLARE vouloir emprunter (accès précoce). + filtre de fiabilité (aHist).
      const declareEmp = rng() < p.part_emprunteurs_declares;
      const candidatEmp = p.deux_populations ? (declareEmp && aHist) : true; // accès phase emprunteurs
      // OFFRE × DEMANDE (A1) : eligibleEnchere ssi le membre DÉCLARE emprunter (demande) ET tombe
      // dans la fraction part_eligibles_enchere que l'OPÉRATEUR AUTORISE (offre/sévérité du scoring).
      const eligibleEnchere = candidatEmp && rng() < p.part_eligibles_enchere;
      return { i, seuil: pr.seuil, rho: pr.rho, type: tp, urg, aHist, candidatEmp, eligibleEnchere, declareEmp, estEpargnant: false, aEncaisse: false, tEnc: null, aFui: false, vacant: false, consign: 0, cotise: 0, recu: 0, remun: 0, estRempl: false, filtreScore: false };
    });
    // P90->P50 du seuil PD du pool, pour le scoring d'accès au cycle 1 (A4a)
    const seuilsTri = membres.map(mb => mb.seuil).slice().sort((a, b) => a - b);
    pools.push(membres);
    comptes.push({ prets: [], decaisseCumule: 0, depot: 0, fge: 0, trancheUtil: 0, rompu: false, trou: 0,
                   absorbeSfdPic: 0, absorbeFgePic: 0, absorbeSfd: 0,
                   // A3 : liste d'attente — R remplaçants scorés par pool, et entrées différées (t+1).
                   remplDispo: Math.max(0, p.n_remplacants | 0), entreesEnAttente: [], listeEpuisee: false,
                   nbRemplacements: 0, seuilsTri });
  }

  // FGE et tranche SFD : ISOLÉS par pool (défaut) ou MUTUALISÉS entre pools.
  // Isolé = la solidité d'un pool ne dépend QUE de lui-même (cadre « 1 pool »).
  const mutu = !!p.fge_mutualise;
  let fgeGlob = 0, trancheGlob = 0;
  const getFge = pid => mutu ? fgeGlob : comptes[pid].fge;
  const addFge = (pid, x) => { if (mutu) fgeGlob += x; else comptes[pid].fge += x; };
  const getTranche = pid => mutu ? trancheGlob : comptes[pid].trancheUtil;
  const addTranche = (pid, x) => { if (mutu) trancheGlob += x; else comptes[pid].trancheUtil += x; };
  // assiette du plafond de tranche SFD : portefeuille entier si mutualisé, sinon le pool seul
  const assietteTranche = pid => mutu ? comptes.reduce((s, c) => s + c.decaisseCumule, 0) : comptes[pid].decaisseCumule;

  let fgeProvisions = 0, fgeSaisies = 0;
  let primes = 0, surplusEnchere = 0, interetsSfd = 0, avanceCumulee = 0;
  let couvertFge = 0, couvertSfd = 0, residuel = 0, perteSfd = 0, nFuites = 0, nGratuits = 0;
  let coutTour1 = 0, continuiteOk = true;
  let remunEpargnants = 0, interetsDepots = 0;
  // A3 — LOGS remplacement / liste d'attente
  let nbRemplacements = 0, perteNetteAvantRemplacement = 0, perteNetteApresRemplacement = 0;
  const exposMois = new Array(totalTours).fill(0);
  const chocFuite = p.comportemental_actif ? p.choc_fuite : 0;

  // --- RÈGLES CYCLE 1 (internes) ---
  // Au 1er cycle, on réserve l'enchère aux profils SÛRS tant qu'il en reste de disponibles : tour 1
  // les sûrs, tour 2 les sûrs restants, etc. Quand ils ont tous encaissé, la liste filtrée se vide
  // et l'enchère s'ouvre à tous (repli). Les sûrs fuient red_fuite_eligible × moins.
  // suivi de la courbe de vulnérabilité du CYCLE 1 (par tour) : expo nette, FGE dispo, vulnérabilité
  const vulnCycle1 = []; // [{tour, expoNette, fgeDispo, vuln, alerte}]
  let tours_fge_insuffisant = 0;
  let tours_declench_force = 0;       // A4b : tours où collecte < alpha*M*c (déclenchement forcé)
  let tours_fge_sous_perte_max = 0;   // A4c : décaissements où solde FGE < perte max possible du tour

  // A4c — FGE PRÉ-ALIMENTÉ : chaque emprunteur déclaré verse 1*c en prime de démarrage, créditée
  // au FGE AVANT le tour 1. On loggera le solde FGE à chaque décaissement (vulnCycle1).
  if (p.prime_demarrage_actif) {
    for (let pid = 0; pid < nPools; pid++) {
      let nEmpDecl = 0; for (const mb of pools[pid]) if (mb.declareEmp) nEmpDecl++;
      const dem = nEmpDecl * p.c; if (dem > 0) { addFge(pid, dem); fgeProvisions += dem; }
    }
  }

  for (let t = 1; t <= totalTours; t++) {
    const z = zMois[t - 1], slot = (t - 1) % m;
    if (slot === 0) for (const mb of pools.flat()) if (!mb.aFui) mb.aEncaisse = false;

    for (let pid = 0; pid < nPools; pid++) {
      const membres = pools[pid], cpt = comptes[pid];
      // 0. REMPLACEMENTS différés (A3) : une fuite/arrêt au tour t-1 a programmé l'entrée d'un
      // remplaçant au tour t. Il prend le PROCHAIN slot disponible (pas celui du fuyard), cotise
      // dès maintenant, SANS droit aux tours passés ni rattrapage. Réutilise un membre marqué vacant.
      if (cpt.entreesEnAttente.length) {
        for (const ent of cpt.entreesEnAttente) {
          const slotVacant = membres.find(mb => mb.vacant);
          if (!slotVacant) continue;       // pas de place libre (ne devrait pas arriver)
          slotVacant.vacant = false; slotVacant.aFui = false; slotVacant.aEncaisse = false;
          slotVacant.tEnc = null; slotVacant.cotise = 0; slotVacant.recu = 0; slotVacant.consign = 0;
          slotVacant.estEpargnant = false; slotVacant.estRempl = true; slotVacant.filtreScore = false;
          // remplaçant scoré : pas d'accès enchère au cycle 1 (entre après le démarrage) -> épargnant.
          slotVacant.candidatEmp = (ent.type === 'emprunteur');
          slotVacant.declareEmp = (ent.type === 'emprunteur');
          slotVacant.eligibleEnchere = false;
          cpt.nbRemplacements++; nbRemplacements++;
        }
        cpt.entreesEnAttente = [];
      }
      const cycle1 = (t <= m); // premier cycle (le scoring P90->P50 ne s'applique qu'ici)
      // 1a. CAS 1 (A3) — fuite d'un encaisseur : il part avec le crédit-relais (avance non amortie
      // pr.restant). PERTE NETTE de remplacement = pr.restant − cotisations futures d'un remplaçant
      // (t+1..vie) + c (gap du mois t), plancher 0. Si liste épuisée : pr.restant + cotis. futures
      // manquantes (pas de remplacement). Cette perte nette passe dans la cascade FGE->cap SFD->résiduel.
      for (const mb of membres) {
        if (mb.aEncaisse && !mb.aFui && !cpt.rompu) {
          const moisR = Math.max(1, vie - mb.tEnc);
          const baseFuite = p.p_fuite_base * (mb.filtreScore ? (p.red_fuite_eligible ?? 0.33) : 1);
          const pf = probaFuite(baseFuite, mb.tEnc, m, z, moisR, p.charge_z_fuite, p.fuite_mult_tour_precoce, chocFuite);
          if (rng() < pf) {
            nFuites++;
            let principalRestant = 0;
            for (const pr of cpt.prets) if (pr.membre === mb.i && pr.actif && pr.restant > 1e-9) { pr.actif = false; principalRestant += pr.restant; }
            if (p.garantie_enchere_active && mb.consign > 0) { addFge(pid, mb.consign); fgeSaisies += mb.consign; mb.consign = 0; }
            perteNetteAvantRemplacement += principalRestant;   // perte brute = principal restant
            // cotisations futures d'un remplaçant entrant à t+1 : c × (vie - t) (mois t+1..vie)
            const cotisFutures = p.c * Math.max(0, vie - t);
            let perteNette;
            const disponible = cpt.remplDispo > 0;
            if (disponible) {
              cpt.remplDispo--;
              // entrée du remplaçant au tour suivant (prend le prochain slot libre)
              cpt.entreesEnAttente.push({ type: 'epargnant', tEntree: t + 1 });
              // PERTE NETTE = principal restant − cotisations futures du remplaçant + c (gap mois t)
              perteNette = Math.max(0, principalRestant - cotisFutures + p.c);
            } else {
              cpt.listeEpuisee = true;
              // liste épuisée : pas de remplacement -> perte = principal + cotisations futures manquantes
              perteNette = principalRestant + cotisFutures;
            }
            perteNetteApresRemplacement += perteNette;
            // CASCADE sur la perte nette : FGE -> cap SFD -> résiduel (rupture)
            let trou = perteNette;
            const parFge = p.fge_actif ? Math.min(getFge(pid), trou) : 0; addFge(pid, -parFge); trou -= parFge; couvertFge += parFge;
            const capSfd = (p.cap_sfd_cotisations || 0) * p.c;
            const dispoSfd = Math.max(0, capSfd - (cpt.absorbeSfd || 0));
            const parSfd = Math.min(dispoSfd, trou); cpt.absorbeSfd = (cpt.absorbeSfd || 0) + parSfd; trou -= parSfd; couvertSfd += parSfd; perteSfd += parSfd;
            if (trou > 1e-9) { residuel += trou; continuiteOk = false; comptes[pid].casse = true; cpt.rompu = true; }
            mb.aFui = true; mb.vacant = true;
          }
        }
      }
      // 1b. CAS 2 (A5) — arrêt d'un NON-encaisseur : DISTINCT de la fuite. Il n'a rien reçu -> AUCUN
      // trou sur les avances. Remboursé de ses cotisations ; slot vacant, remplacé via la liste (A3).
      if ((p.taux_arret_non_encaisseur || 0) > 0) {
        for (const mb of membres) {
          if (!mb.aEncaisse && !mb.aFui && !mb.vacant && !cpt.rompu && rng() < p.taux_arret_non_encaisseur) {
            cpt.depot = Math.max(0, cpt.depot - mb.cotise);
            mb.aFui = true; mb.vacant = true;
            if (cpt.remplDispo > 0) { cpt.remplDispo--; cpt.entreesEnAttente.push({ type: 'emprunteur', tEntree: t + 1 }); }
            else cpt.listeEpuisee = true;
          }
        }
      }
      // intérêts sur le dépôt : portent sur le solde DÉJÀ là (mois précédent), AVANT la cotisation
      // du tour — on ne rémunère pas l'argent qui vient d'entrer (pas d'intérêt au tour 1).
      if (rDepotMensuel > 0 && cpt.depot > 0) { const it = cpt.depot * rDepotMensuel; cpt.depot += it; interetsDepots += it; }
      // 2. collecte des cotisations -> alimente le dépôt commun.
      // TOUT LE MONDE cotise c chaque mois (encaisseurs compris) ; seuls les fuyards non remplacés manquent.
      const actifs = membres.filter(mb => !mb.aFui);
      let potColl = 0;
      for (const mb of actifs) { let taux = p.taux_echec_friction; if (p.mitigation_active) taux *= (1 - p.prelevement_auto_efficacite); const versé = (rng() < taux ? p.c * 0.9 : p.c); potColl += versé; cpt.depot += versé; mb.cotise += p.c; }

      const dureePret = Math.max(1, m - (slot + 1));
      const phaseEmprunteur = !p.deux_populations || (slot < seuilEmp);

      // A4b — DÉCLENCHEMENT : l'enchère ne s'ouvre que si les cotisations collectées >= alpha*M*c.
      // Sinon, déclenchement FORCÉ sur le solde disponible (pas de gel). Le « délai 5 jours » du
      // cadre réel n'est pas simulé en pas mensuel. On loggue mais on n'empêche jamais le service.
      const seuilDeclench = (p.alpha_declenchement ?? 0.8) * m * p.c;
      // collecté ce mois (potColl) comme proxy de la collecte du tour. Déclenchement FORCÉ si en deçà :
      // on sert quand même (le crédit-relais est porté par la SFD, pas par le dépôt), on logge juste.
      if (phaseEmprunteur && !cpt.rompu && potColl < seuilDeclench) tours_declench_force++;

      // 3. attribution + 4. décaissement — sauf si le pool est ROMPU (dispositif arrêté).
      let gagnant = null, bideur = false, bidSurplusWtp = 0;
      if (cpt.rompu) {
        // pool rompu : on ne sert plus, on ne décaisse plus ; on laisse juste tourner les flux passifs.
      } else if (phaseEmprunteur) {
        // --- PHASE EMPRUNTEURS : enchère, avance SFD, crédit-relais, prime + risque de fuite ---
        // candidats préférés (population emprunteur déclarée) ; repli anti-gel sur tout non-encaisseur
        const nonEnc = actifs.filter(mb => !mb.aEncaisse);
        let elig = nonEnc.filter(mb => !p.deux_populations || mb.candidatEmp);
        if (!elig.length) elig = nonEnc;                 // jamais de gel : on attribue toujours
        // RÈGLE CYCLE 1 (A4a) : accès filtré par scoring décroissant. Seuil PD S_t de P90 (tour 1)
        // à P50 (tour seuilEmp), décroissant linéairement avec slot. Seuls les membres SOUS le
        // seuil PD (donc au-dessus en fiabilité) accèdent. Repli anti-gel si le filtre vide la liste.
        const filtreActif = cycle1;
        if (filtreActif) {
          const tri = cpt.seuilsTri;
          const denom = Math.max(1, seuilEmp - 1);
          const frac = Math.min(1, Math.max(0, slot / denom));   // 0 au tour 1 -> 1 au dernier tour emprunteur
          const qScore = 0.90 - (0.90 - 0.50) * frac;            // P90 -> P50
          const sCut = quantile(tri, qScore);                    // seuil PD du tour
          const e = elig.filter(mb => mb.seuil <= sCut + 1e-12);
          if (e.length) elig = e;
          else { const e2 = elig.filter(mb => mb.eligibleEnchere); if (e2.length) elig = e2; }
        }
        // l'enchère se déclenche toujours (déclenchement forcé sur solde si collecte < alpha*M*c)
        let eligBid = elig;
        if (p.mode === "garantie" && p.mitigation_active && p.acces_sequence_active && slot < p.t_restreint) eligBid = eligBid.filter(mb => mb.aHist);
        if (p.mode === "garantie") {
          let best = null, bestW = -1; for (const mb of eligBid) { const mg = Math.max(0, (m - 1) - slot); const wtp = p.rho_mensuel * mg * pot * mb.urg * Math.exp(gaussian(rng) * p.bid_bruit_sigma); if (wtp > bestW) { bestW = wtp; best = mb; } }
          if (best && bestW > 0.01 * pot) { gagnant = best; bideur = true; bidSurplusWtp = bestW; if (p.mitigation_active && p.garantie_enchere_active && slot < p.t_restreint && gagnant.consign === 0) gagnant.consign = p.g_cotisations * p.c; }
          else if (elig.length) { gagnant = elig.reduce((b, mb) => mb.i < b.i ? mb : b, elig[0]); }
        } else if (elig.length) gagnant = elig.reduce((b, mb) => mb.i < b.i ? mb : b, elig[0]);
        if (gagnant) {
          const avance = Math.max(0, pot - gagnant.cotise);
          let bid = 0, net = pot;
          if (p.mode === "garantie") {
            const primeGar = p.prime_active ? primeGarantie(avance, dureePret, p.p_fuite_base, m - 1, p.prime_facteur_prudence) : 0;
            const interets = pot * rSfd * dureePret, margeOp = p.prime_operateur_taux * pot;
            const coutObl = interets + primeGar + margeOp;
            const bidSurplusPlaf = Math.min(bidSurplusWtp, p.bid_plafond_frac_pot * pot);
            let surplus = bideur ? Math.max(0, Math.min(bidSurplusPlaf - coutObl, p.bid_plafond_frac_pot * pot)) : 0;
            bid = coutObl + surplus; net = Math.max(0, pot - bid);
            interetsSfd += interets; primes += margeOp; fgeProvisions += primeGar; addFge(pid, primeGar); avanceCumulee += net;
            // le surplus de bid : une part aux épargnants (rémunération), le reste à l'Opérateur
            const partEp = (p.deux_populations ? p.part_bids_aux_epargnants : 0) * surplus;
            surplusEnchere += (surplus - partEp);
            cpt.depot += partEp; remunEpargnants += partEp;  // alimente la rémunération épargnants
          } else { bid = 0; net = pot; avanceCumulee += pot; }
          cpt.prets.push({ membre: gagnant.i, restant: net, mensualite: net / dureePret, actif: true, tOctroi: t }); cpt.decaisseCumule += net;
          gagnant.aEncaisse = true; gagnant.tEnc = t; gagnant.recu += net;
          // A4c — FLAG : au cycle 1, on signale les décaissements où le solde FGE est inférieur à la
          // perte max possible du tour suivant (≈ le net qu'on vient d'avancer, exposé à une fuite).
          if (cycle1 && p.fge_actif && getFge(pid) < net - 1e-9) tours_fge_sous_perte_max++;
          // HYPOTHÈSE : un membre sélectionné par le filtre de score (meilleur profil) fuit moins.
          if (filtreActif) gagnant.filtreScore = true;
          if (!bideur) nGratuits++;
          if (t === 1 && coutTour1 === 0) coutTour1 = bid;
        }
      } else {
        // --- PHASE ÉPARGNANTS : servis DU PLUS SÛR AU MOINS SÛR (le moins fiable attend la fin,
        // quand il a déjà tout épargné → plus rien à fuir). Rémunération égale pour tous. ---
        const eparg = actifs.filter(mb => !mb.aEncaisse);
        if (eparg.length) {
          if (p.deux_populations) {
            // score de fiabilité : historique d'abord, puis risque de fuite croissant (rho/seuil).
            // on sert le PLUS sûr ; le moins sûr est repoussé vers la fin.
            eparg.sort((a, b) => {
              if (a.aHist !== b.aHist) return a.aHist ? -1 : 1;   // historiques d'abord
              return a.seuil - b.seuil;   // seuil bas = PD basse = plus fiable, servi avant
            });
            gagnant = eparg[0];
          } else {
            gagnant = eparg[Math.floor(rng() * eparg.length)];
          }
          gagnant.estEpargnant = true; gagnant.aEncaisse = true; gagnant.tEnc = t;
          // servi depuis le dépôt ; si insuffisant, le complément passe par FGE -> cap SFD -> rupture.
          const pris = Math.min(Math.max(cpt.depot, 0), pot); cpt.depot -= pris;
          let manque = pot - pris;
          if (manque > 1e-9) {
            const parFge = p.fge_actif ? Math.min(getFge(pid), manque) : 0; addFge(pid, -parFge); manque -= parFge; couvertFge += parFge;
            const capSfd = (p.cap_sfd_cotisations || 0) * p.c;
            const dispoSfd = Math.max(0, capSfd - (cpt.absorbeSfd || 0));
            const parSfd = Math.min(dispoSfd, manque); cpt.absorbeSfd = (cpt.absorbeSfd || 0) + parSfd; manque -= parSfd; couvertSfd += parSfd; perteSfd += parSfd;
            if (manque > 1e-9) { residuel += manque; continuiteOk = false; comptes[pid].casse = true; cpt.rompu = true; }
          }
          gagnant.recu += pot;
        }
      }
      // 5. récupération des prêts : la mensualité amortit l'avance SFD (pr.restant) — pas le mois
      // de l'octroi (1er prélèvement le tour suivant). Plus tard la fuite coûte moins (restant petit).
      for (const pr of cpt.prets) if (pr.actif && pr.restant > 1e-9 && pr.tOctroi < t) { const pa = Math.min(pr.mensualite, pr.restant); pr.restant -= pa; cpt.depot += pa; }
      exposMois[t - 1] += cpt.prets.filter(pr => pr.actif).reduce((s, pr) => s + pr.restant, 0);
    }
    // --- COURBE DE VULNÉRABILITÉ CYCLE 1 (FGE en constitution), RAMENÉE À UN POOL ---
    // Tout est exprimé PAR POOL pour que la lecture ne dépende pas du nombre de pools :
    // couverture moyenne d'un pool (FGE + tranche SFD dispo) face à la pire fuite d'un pool.
    if (t <= m) {
      const expoNette = exposMois[t - 1] / nPools;          // encours moyen par pool
      // pire fuite d'un pool : la plus grosse avance en cours, mesurée pool par pool puis moyennée
      let perteMaxParPool = 0;
      let fgeDispoTot = 0, capDispoTot = 0;
      const capSfd = (p.cap_sfd_cotisations || 0) * p.c;   // cap SFD par pool (skin in the game)
      for (let pid = 0; pid < nPools; pid++) {
        let pmax = 0; for (const pr of comptes[pid].prets) if (pr.actif && pr.restant > pmax) pmax = pr.restant;
        perteMaxParPool += pmax / nPools;
        fgeDispoTot += getFge(pid);
        capDispoTot += Math.max(0, capSfd - (comptes[pid].absorbeSfd || 0));
      }
      // en mutualisé, getFge renvoie le global pour chaque pid -> on corrige par /nPools
      const fgeDispo = (mutu ? fgeGlob : fgeDispoTot) / nPools;
      const capDispo = capDispoTot / nPools;
      const couvertureDispo = fgeDispo + capDispo;
      const perteMax = perteMaxParPool;
      const alerte = couvertureDispo < perteMax;  // une seule fuite épuiserait la couverture d'un pool
      if (alerte) tours_fge_insuffisant++;
      vulnCycle1.push({ tour: t, expoNette, fgeDispo, couvertureDispo, perteMax, vuln: Math.max(0, perteMax - couvertureDispo), alerte });
    }
  }

  const nMembres = nPools * m, mois = totalTours;
  // rémunération des épargnants = part des bids reversée + intérêts sur dépôts, répartie
  // ÉGALEMENT entre les épargnants servis. (déjà dans le dépôt via remunEpargnants/interetsDepots
  // pour la trésorerie ; ici on calcule le rendement distribué par tête)
  const totalRemun = remunEpargnants + interetsDepots;
  const nEpargnants = pools.flat().filter(mb => mb.estEpargnant).length;
  const remunParEpargnant = nEpargnants ? totalRemun / nEpargnants : 0;

  // P&L Opérateur — A6 : on expose le BRUT (revenus du mécanisme) ET le NET (− coûts de structure).
  const revenus = primes + surplusEnchere;
  const coutAcq = p.cout_acquisition_membre * nMembres, coutOps = p.cout_ops_pool_mois * nPools * mois;
  const coutsFixes = p.couts_fixes_mensuels * mois;
  const pnlBrut = revenus;                                   // revenus bruts du mécanisme
  const pnlNet = revenus - (coutAcq + coutOps + coutsFixes); // net des coûts de structure
  const pnlOp = pnlNet;                                      // champ historique = P&L net
  const margePool = nPools ? (revenus - coutAcq - coutOps) / nPools : 0;     // net/pool (hors fixes)
  const pnlBrutPool = nPools ? revenus / nPools : 0;
  const pnlNetPool = nPools ? pnlNet / nPools : 0;
  const breakEven = coutsFixes <= 0 ? (margePool > 1e-9 ? 0 : Infinity) : (margePool > 1e-9 ? coutsFixes / margePool : Infinity);

  // continuité PAR POOL : fraction des pools qui tiennent leur promesse (indépendant du nb de pools)
  const poolsCasses = comptes.filter(c => c.casse).length;
  const tauxContinuitePool = nPools ? 1 - poolsCasses / nPools : 1;
  const nPoolsListeEpuisee = comptes.filter(c => c.listeEpuisee).length;

  return {
    nPools, nFuites, continuiteOk, residuel, perteSfd, coutTour1, nGratuits,
    poolsCasses, tauxContinuitePool,
    couvertFge, couvertSfd, fgeProvisions, fgeSaisies, primes, surplusEnchere, interetsSfd, avanceCumulee,
    remunEpargnants: totalRemun, remunParEpargnant, nEpargnants, interetsDepots,
    expoMois: exposMois, expoMax: Math.max(...exposMois),
    pnlOp, pnlBrut, pnlNet, pnlBrutPool, pnlNetPool, margePool, breakEven, revenus, coutAcq, coutOps, coutsFixes, seuilEmp,
    vulnCycle1, tours_fge_insuffisant, tours_declench_force, tours_fge_sous_perte_max,
    // A3 — logs remplacement / liste d'attente
    nbRemplacements, nPoolsListeEpuisee,
    perteNetteAvantRemplacement, perteNetteApresRemplacement,
  };
}

// ---- JOURNAL DES FLUX d'UN pool (fidèle à simulerRun), pour la page Flux ----
// Émet une liste de mouvements horodatés (tour) avec le solde courant du dépôt commun et du FGE.
// Couvre : cotisations, enchère, avance SFD (crédit-relais), prime -> FGE, intérêts SFD,
// service épargnant, fuite + cascade de couverture (FGE -> tranche SFD -> résiduel) + remplacement.
export function journalPool(p, graine) {
  const rng = mulberry32(graine);
  const m = p.m_membres, totalTours = m * p.n_cycles, vie = totalTours;
  const pot = (m - 1) * p.c, rSfd = rSfdMensuel(p);
  const NOMS = ["Awa", "Koffi", "Mariam", "Ibrahim", "Fanta", "Sékou", "Aïcha", "Moussa", "Rama", "Yao", "Bintou", "Diallo", "Nana", "Oumar", "Salif"];
  const REMPL = ["Adjo", "Kossi", "Afia", "Komla", "Esi", "Kofi", "Ama", "Yaw", "Akos", "Kwame"];
  function pref() { const r = rng(); if (r < p.part_urgent) return ["urgent", p.urg_urgent]; if (r < p.part_urgent + p.part_modere) return ["modéré", p.urg_modere]; return ["épargnant", p.urg_epargnant]; }
  const profs = tirerProfils(rng, m, p);
  const membres = profs.map((pr, i) => {
    let [tp, urg] = pref();
    if (p.comportemental_actif && (tp === "modéré" || tp === "épargnant") && rng() < p.bascule_urgents) { tp = "urgent"; urg = p.urg_urgent; }
    const aHist = rng() < p.part_avec_historique;
    const declareEmp = rng() < p.part_emprunteurs_declares;
    const candidatEmp = p.deux_populations ? (declareEmp && aHist) : true;
    const eligibleEnchere = candidatEmp && rng() < p.part_eligibles_enchere;
    return { i, nom: NOMS[i % NOMS.length], seuil: pr.seuil, rho: pr.rho, type: tp, urg, aHist,
             candidatEmp, eligibleEnchere, declareEmp, estEpargnant: false,
             aEncaisse: false, tEnc: null, aFui: false, vacant: false, consign: 0, cotise: 0, recu: 0, remplacant: null };
    });
  const cpt = { prets: [], decaisseCumule: 0, depot: 0, rompu: false, trou: 0, absorbeSfd: 0,
                remplDispo: Math.max(0, p.n_remplacants | 0), entreesEnAttente: [], listeEpuisee: false };
  let fge = 0, trancheUtil = 0, nRempl = 0;
  const etatZ = {};
  const chocFuite = p.comportemental_actif ? p.choc_fuite : 0;
  const rDepotMensuel = Math.pow(1 + (p.r_depot_annuel || 0), 1 / 12) - 1;  // mensualisation composée
  const bx = boundsX(m);
  const xClamp = Math.min(bx.max, Math.max(bx.min, p.x_tours_emprunteurs || 0));
  const seuilEmp = p.deux_populations ? Math.min(m - 1, Math.max(1, Math.round(m / 2) + xClamp)) : m;
  // FGE pré-alimenté (A4c) : chaque emprunteur déclaré verse 1*c en prime de démarrage avant T1.
  if (p.prime_demarrage_actif) { let nE = 0; for (const mb of membres) if (mb.declareEmp) nE++; if (nE > 0) fge += nE * p.c; }

  const tours = []; // { tour, cycle, slot, phase, mouvements:[{acteur,type,libelle,montant,depot,fge}] }
  const flux = (arr, acteur, type, libelle, montant) => arr.push({ acteur, type, libelle, montant, depot: cpt.depot, fge });

  for (let t = 1; t <= totalTours; t++) {
    const z = tirerZ(rng, p, etatZ), slot = (t - 1) % m, cycle = Math.floor((t - 1) / m) + 1;
    if (slot === 0) for (const mb of membres) if (!mb.aFui) mb.aEncaisse = false;
    const mvt = [];

    // 0. REMPLACEMENTS différés (A3) : une fuite/arrêt au tour précédent a programmé l'entrée d'un
    // remplaçant ce tour. Il prend le PROCHAIN slot libre (pas celui du fuyard), cotise dès maintenant,
    // SANS droit aux tours passés ni rattrapage. Liste d'attente limitée (n_remplacants).
    if (cpt.entreesEnAttente.length) {
      for (const ent of cpt.entreesEnAttente) {
        const slotVacant = membres.find(mb => mb.vacant);
        if (!slotVacant) continue;
        const nom = REMPL[nRempl % REMPL.length]; nRempl++;
        const acces = ent.type === 'emprunteur' ? "avec droit d'enchère" : "en ÉPARGNANT (pas d'enchère ce cycle)";
        flux(mvt, nom, 'remplacement', `${nom} entre sur le prochain slot libre ${acces} (cotise dès ce mois, pas de droit aux tours passés)`, 0);
        slotVacant.aFui = false; slotVacant.vacant = false; slotVacant.aEncaisse = false; slotVacant.tEnc = null;
        slotVacant.cotise = 0; slotVacant.recu = 0; slotVacant.consign = 0; slotVacant.estEpargnant = false;
        slotVacant.nom = nom; slotVacant.filtreScore = false;
        slotVacant.candidatEmp = (ent.type === 'emprunteur'); slotVacant.declareEmp = (ent.type === 'emprunteur');
        slotVacant.eligibleEnchere = false;
      }
      cpt.entreesEnAttente = [];
    }

    // 1a. CAS 1 (A3) — fuite d'un encaisseur : il part avec le crédit-relais. PERTE NETTE de
    // remplacement = principal restant − cotisations futures du remplaçant (t+1..vie) + c (gap), >=0.
    // Liste épuisée : principal restant + cotisations futures manquantes (pas de remplacement).
    for (const mb of membres) {
      if (mb.aEncaisse && !mb.aFui && !cpt.rompu) {
        const moisR = Math.max(1, vie - mb.tEnc);
        const baseFuite = p.p_fuite_base * (mb.filtreScore ? (p.red_fuite_eligible ?? 0.33) : 1);
        const pf = probaFuite(baseFuite, mb.tEnc, m, z, moisR, p.charge_z_fuite, p.fuite_mult_tour_precoce, chocFuite);
        if (rng() < pf) {
          let principalRestant = 0; for (const pr of cpt.prets) if (pr.membre === mb.i && pr.actif && pr.restant > 1e-9) { pr.actif = false; principalRestant += pr.restant; }
          if (p.garantie_enchere_active && mb.consign > 0) { fge += mb.consign; flux(mvt, 'FGE', 'saisie', `garantie d'enchère de ${mb.nom} saisie → FGE`, mb.consign); mb.consign = 0; }
          const cotisFutures = p.c * Math.max(0, vie - t);
          let perteNette;
          if (cpt.remplDispo > 0) { cpt.remplDispo--; cpt.entreesEnAttente.push({ type: 'epargnant', tEntree: t + 1 }); perteNette = Math.max(0, principalRestant - cotisFutures + p.c); }
          else { cpt.listeEpuisee = true; perteNette = principalRestant + cotisFutures; }
          flux(mvt, mb.nom, 'fuite', `${mb.nom} (encaisseur, tour T${mb.tEnc}) fuit — perte nette de remplacement = ${Math.round(perteNette)} ; place vacante`, -perteNette);
          let trou = perteNette;
          const parFge = p.fge_actif ? Math.min(fge, trou) : 0; if (parFge > 0) { fge -= parFge; trou -= parFge; flux(mvt, 'FGE', 'couverture', `FGE absorbe la perte nette (première perte)`, -parFge); }
          const capSfd = (p.cap_sfd_cotisations || 0) * p.c; const dispoSfd = Math.max(0, capSfd - (cpt.absorbeSfd || 0)); const parSfd = Math.min(dispoSfd, trou); if (parSfd > 0) { cpt.absorbeSfd = (cpt.absorbeSfd || 0) + parSfd; trou -= parSfd; flux(mvt, 'SFD', 'couverture', `tranche SFD absorbe (skin in the game)`, -parSfd); }
          if (trou > 1e-9) { flux(mvt, '—', 'rupture', `dispositif arrêté : perte nette > FGE + cap SFD`, -trou); cpt.rompu = true; }
          mb.aFui = true; mb.vacant = true;
        }
      }
    }
    // 1b. CAS 2 (A5) — arrêt d'un NON-encaisseur : DISTINCT de la fuite, AUCUN trou (rien reçu).
    // Remboursé de ses cotisations ; slot vacant, remplacé via la liste (avec droit d'enchère).
    if ((p.taux_arret_non_encaisseur || 0) > 0) {
      for (const mb of membres) {
        if (!mb.aEncaisse && !mb.aFui && !mb.vacant && !cpt.rompu && rng() < p.taux_arret_non_encaisseur) {
          const rembourse = mb.cotise; cpt.depot = Math.max(0, cpt.depot - rembourse);
          flux(mvt, mb.nom, 'remboursement', `${mb.nom} (non-encaisseur) arrête — remboursé ; aucune perte sur avances ; place vacante`, -rembourse);
          mb.aFui = true; mb.vacant = true;
          if (cpt.remplDispo > 0) { cpt.remplDispo--; cpt.entreesEnAttente.push({ type: 'emprunteur', tEntree: t + 1 }); }
          else cpt.listeEpuisee = true;
        }
      }
    }

    // intérêts sur le dépôt : sur le solde DÉJÀ là (mois précédent), AVANT la cotisation du tour.
    // On ne rémunère pas l'argent qui vient d'entrer -> aucun intérêt au tour 1.
    if (rDepotMensuel > 0 && cpt.depot > 0) { const it = cpt.depot * rDepotMensuel; cpt.depot += it; flux(mvt, 'SFD', 'rémunération', `intérêts sur le dépôt du mois précédent (rémunération de l'épargne)`, it); }
    // 2. cotisations → dépôt commun. TOUT LE MONDE cotise c (encaisseurs compris) ; un fuyard non
    // remplacé manque (le compteur tombe à 9, puis remonte à 10 dès qu'il est remplacé).
    const actifs = membres.filter(mb => !mb.aFui);
    let potColl = 0, nCot = 0;
    for (const mb of actifs) { cpt.depot += p.c; potColl += p.c; mb.cotise += p.c; nCot++; }
    flux(mvt, 'Membres', 'cotisation', `${nCot} membres présents versent leur cotisation au dépôt`, nCot * p.c);

    const dureePret = Math.max(1, m - (slot + 1));
    const phaseEmprunteur = !p.deux_populations || (slot < seuilEmp);
    let phase = phaseEmprunteur ? 'emprunteur' : 'épargnant';

    // 3. attribution + décaissement — sauf si le pool est ROMPU (dispositif arrêté).
    if (cpt.rompu) {
      flux(mvt, '—', 'arrêt', `dispositif arrêté (pool rompu) : plus d'attribution ni de service`, 0);
    } else if (phaseEmprunteur) {
      const nonEnc = actifs.filter(mb => !mb.aEncaisse);
      let elig = nonEnc.filter(mb => !p.deux_populations || mb.candidatEmp);
      if (!elig.length) elig = nonEnc;                 // jamais de gel
      const cycle1 = t <= m;
      const filtreActif = cycle1;
      if (filtreActif) {
        // scoring P90->P50 sur mb.seuil (A4a), mirroir de simulerRun
        const tri = membres.map(mb => mb.seuil).slice().sort((a, b) => a - b);
        const frac = Math.min(1, Math.max(0, slot / Math.max(1, seuilEmp - 1)));
        const sCut = quantile(tri, 0.90 - 0.40 * frac);
        const e = elig.filter(mb => mb.seuil <= sCut + 1e-12);
        if (e.length) elig = e;
        else { const e2 = elig.filter(mb => mb.eligibleEnchere); if (e2.length) elig = e2; }
      }
      let eligBid = elig;  // l'enchère se déclenche toujours
      if (p.mode === 'garantie' && p.mitigation_active && p.acces_sequence_active && slot < p.t_restreint) eligBid = eligBid.filter(mb => mb.aHist);
      let gagnant = null, bideur = false, bidW = 0;
      if (p.mode === 'garantie') {
        let best = null, bestW = -1; for (const mb of eligBid) { const mg = Math.max(0, (m - 1) - slot); const wtp = p.rho_mensuel * mg * pot * mb.urg * Math.exp(gaussian(rng) * p.bid_bruit_sigma); if (wtp > bestW) { bestW = wtp; best = mb; } }
        if (best && bestW > 0.01 * pot) { gagnant = best; bideur = true; bidW = bestW; if (p.mitigation_active && p.garantie_enchere_active && slot < p.t_restreint && gagnant.consign === 0) gagnant.consign = p.g_cotisations * p.c; }
        else if (elig.length) gagnant = elig.reduce((b, mb) => mb.i < b.i ? mb : b, elig[0]);
      } else if (elig.length) gagnant = elig.reduce((b, mb) => mb.i < b.i ? mb : b, elig[0]);

      if (gagnant) {
        const avance = Math.max(0, pot - gagnant.cotise);
        let bid = 0, net = pot;
        if (p.mode === 'garantie') {
          const primeGar = p.prime_active ? primeGarantie(avance, dureePret, p.p_fuite_base, m - 1, p.prime_facteur_prudence) : 0;
          const interets = pot * rSfd * dureePret, margeOp = p.prime_operateur_taux * pot;
          const coutObl = interets + primeGar + margeOp;
          const bidPlaf = Math.min(bidW, p.bid_plafond_frac_pot * pot);
          const surplus = bideur ? Math.max(0, Math.min(bidPlaf - coutObl, p.bid_plafond_frac_pot * pot)) : 0;
          bid = coutObl + surplus; net = Math.max(0, pot - bid);
          if (bideur) flux(mvt, gagnant.nom, 'enchère', `${gagnant.nom} remporte l'enchère (bid = ${Math.round(bid)})`, 0);
          else flux(mvt, gagnant.nom, 'attribution', `${gagnant.nom} prend le tour (sans surenchère)`, 0);
          flux(mvt, 'SFD', 'avance', `la SFD avance le net à ${gagnant.nom} (crédit-relais sur ${dureePret} mois)`, net);
          cpt.prets.push({ membre: gagnant.i, restant: net, mensualite: net / dureePret, actif: true, tOctroi: t }); cpt.decaisseCumule += net;
          flux(mvt, 'SFD', 'intérêts', `intérêts du crédit-relais (retenus dans le bid)`, interets);
          if (primeGar > 0) { fge += primeGar; flux(mvt, 'FGE', 'prime', `prime de garantie de ${gagnant.nom} → FGE`, primeGar); }
          flux(mvt, 'Opérateur', 'marge', `marge Opérateur (retenue dans le bid)`, margeOp);
          if (surplus > 0) { const partEp = (p.deux_populations ? p.part_bids_aux_epargnants : 0) * surplus; if (partEp > 0) { cpt.depot += partEp; flux(mvt, 'Épargnants', 'rémunération', `part du surplus d'enchère reversée aux épargnants`, partEp); } flux(mvt, 'Opérateur', 'surplus', `surplus d'enchère conservé par l'Opérateur`, surplus - partEp); }
        } else {
          net = pot; cpt.prets.push({ membre: gagnant.i, restant: net, mensualite: net / dureePret, actif: true, tOctroi: t }); cpt.decaisseCumule += net;
          flux(mvt, gagnant.nom, 'attribution', `${gagnant.nom} prend le tour (tontine nue, sans frais)`, 0);
          flux(mvt, 'SFD', 'avance', `la SFD avance le pot à ${gagnant.nom}`, net);
        }
        gagnant.aEncaisse = true; gagnant.tEnc = t; gagnant.recu += net;
        if (filtreActif) gagnant.filtreScore = true;
      } else {
        flux(mvt, '—', 'gel', `aucune attribution ce tour (pas d'éligible)`, 0);
      }
    } else {
      // PHASE ÉPARGNANTS : servis du plus sûr au moins sûr, payés depuis le dépôt (complément via cascade)
      const eparg = actifs.filter(mb => !mb.aEncaisse);
      if (eparg.length) {
        let gagnant;
        if (p.deux_populations) { eparg.sort((a, b) => a.aHist !== b.aHist ? (a.aHist ? -1 : 1) : a.seuil - b.seuil); gagnant = eparg[0]; }
        else gagnant = eparg[Math.floor(rng() * eparg.length)];
        gagnant.estEpargnant = true; gagnant.aEncaisse = true; gagnant.tEnc = t;
        flux(mvt, gagnant.nom, 'service', `${gagnant.nom} (épargnant le plus sûr restant) reçoit le pot`, 0);
        // servi depuis le dépôt ; si insuffisant, le complément passe par FGE -> cap SFD -> rupture.
        const pris = Math.min(Math.max(cpt.depot, 0), pot); cpt.depot -= pris;
        flux(mvt, 'Dépôt', 'service', `pot payé depuis le dépôt`, -pris);
        let manque = pot - pris;
        if (manque > 1e-9) {
          const parFge = p.fge_actif ? Math.min(fge, manque) : 0; if (parFge > 0) { fge -= parFge; manque -= parFge; flux(mvt, 'FGE', 'couverture', `FGE complète le pot (première perte)`, -parFge); }
          const capSfd = (p.cap_sfd_cotisations || 0) * p.c; const dispoSfd = Math.max(0, capSfd - (cpt.absorbeSfd || 0)); const parSfd = Math.min(dispoSfd, manque); if (parSfd > 0) { cpt.absorbeSfd = (cpt.absorbeSfd || 0) + parSfd; manque -= parSfd; flux(mvt, 'SFD', 'couverture', `tranche SFD complète le pot (skin in the game)`, -parSfd); }
          if (manque > 1e-9) { flux(mvt, '—', 'rupture', `dispositif arrêté : pot non couvert > FGE + cap SFD`, -manque); cpt.rompu = true; }
        }
        gagnant.recu += pot;
      }
    }

    // 4. récupération des prêts : la SFD PRÉLÈVE la mensualité SUR le dépôt (rembourse sa créance) —
    // pas le mois de l'octroi (1er prélèvement le tour suivant). Cf. modèle unifié §3d.
    let recup = 0; for (const pr of cpt.prets) if (pr.actif && pr.restant > 1e-9 && pr.tOctroi < t) { const pa = Math.min(pr.mensualite, pr.restant); pr.restant -= pa; cpt.depot += pa; recup += pa; }
    if (recup > 0.5) flux(mvt, 'SFD', 'mensualité', `mensualités des crédits-relais : l'avance est amortie, le dépôt se reconstitue`, recup);

    const expo = cpt.prets.filter(pr => pr.actif).reduce((s, pr) => s + pr.restant, 0);
    tours.push({ tour: t, cycle, slot: slot + 1, phase, mvt, depot: cpt.depot, fge, expo });
  }
  return { m, pot, cycles: p.n_cycles, totalTours, tours, nRempl, listeEpuisee: cpt.listeEpuisee };
}

// ---- Monte Carlo ----
export function monteCarlo(p, nRuns, graineBase) {
  const acc = { pnlOp: [], pnlBrut: [], pnlNet: [], pnlNetPool: [], pnlBrutPool: [], continuite: [], residuel: [], perteSfd: [], expoMax: [], fuites: [], coutTour1: [], margePool: [], nGratuits: [],
                interetsSfd: [], primes: [], surplusEnchere: [], fgeProvisions: [], fgeSaisies: [], couvertFge: [], couvertSfd: [], avanceCumulee: [],
                remunEpargnants: [], remunParEpargnant: [], nEpargnants: [], interetsDepots: [],
                nbRemplacements: [], nPoolsListeEpuisee: [], perteNetteAvantRemplacement: [], perteNetteApresRemplacement: [] };
  let expoProfil = null, vulnProfil = null;
  const toursFgeInsuffisant = [];
  let poolsTot = 0, poolsCassesTot = 0, contPoolRuns = [];
  for (let i = 0; i < nRuns; i++) {
    const r = simulerRun(p, graineBase + i);
    toursFgeInsuffisant.push(r.tours_fge_insuffisant);
    // profil de vulnérabilité cycle 1 : moyenne par tour de l'expo nette, FGE dispo, vuln, % d'alertes
    if (r.vulnCycle1 && r.vulnCycle1.length) {
      if (!vulnProfil) vulnProfil = r.vulnCycle1.map(v => ({ tour: v.tour, expoNette: 0, fgeDispo: 0, couvertureDispo: 0, perteMax: 0, vuln: 0, partAlerte: 0 }));
      r.vulnCycle1.forEach((v, j) => {
        const a = vulnProfil[j]; if (!a) return;
        a.expoNette += v.expoNette / nRuns; a.fgeDispo += v.fgeDispo / nRuns;
        a.couvertureDispo += v.couvertureDispo / nRuns; a.perteMax += v.perteMax / nRuns;
        a.vuln += v.vuln / nRuns; a.partAlerte += (v.alerte ? 1 : 0) / nRuns;
      });
    }
    poolsTot += r.nPools; poolsCassesTot += r.poolsCasses; contPoolRuns.push(r.tauxContinuitePool);
    acc.pnlOp.push(r.pnlOp); acc.continuite.push(r.continuiteOk ? 1 : 0); acc.residuel.push(r.residuel);
    acc.perteSfd.push(r.perteSfd); acc.expoMax.push(r.expoMax); acc.fuites.push(r.nFuites);
    acc.coutTour1.push(r.coutTour1); acc.margePool.push(r.margePool); acc.nGratuits.push(r.nGratuits);
    acc.interetsSfd.push(r.interetsSfd); acc.primes.push(r.primes); acc.surplusEnchere.push(r.surplusEnchere);
    acc.fgeProvisions.push(r.fgeProvisions); acc.fgeSaisies.push(r.fgeSaisies);
    acc.couvertFge.push(r.couvertFge); acc.couvertSfd.push(r.couvertSfd); acc.avanceCumulee.push(r.avanceCumulee);
    acc.remunEpargnants.push(r.remunEpargnants); acc.remunParEpargnant.push(r.remunParEpargnant); acc.nEpargnants.push(r.nEpargnants); acc.interetsDepots.push(r.interetsDepots);
    acc.pnlBrut.push(r.pnlBrut); acc.pnlNet.push(r.pnlNet); acc.pnlNetPool.push(r.pnlNetPool); acc.pnlBrutPool.push(r.pnlBrutPool);
    acc.nbRemplacements.push(r.nbRemplacements); acc.nPoolsListeEpuisee.push(r.nPoolsListeEpuisee);
    acc.perteNetteAvantRemplacement.push(r.perteNetteAvantRemplacement); acc.perteNetteApresRemplacement.push(r.perteNetteApresRemplacement);
    if (!expoProfil) expoProfil = r.expoMois.map(() => 0);
    r.expoMois.forEach((v, j) => expoProfil[j] += v / nRuns);
  }
  const ag = {};
  for (const k of Object.keys(acc)) { const s = acc[k].slice().sort((a, b) => a - b); ag[k] = { moy: mean(acc[k]), p5: quantile(s, 0.05), p95: quantile(s, 0.95) }; }
  ag.taux_continuite = mean(acc.continuite);                         // proba qu'AUCUN pool ne casse (portefeuille)
  ag.p_promesse_cassee = acc.residuel.filter(x => x > 1e-6).length / nRuns;
  // PAR POOL (indépendant du nb de pools) : proba qu'un pool donné tienne sa promesse
  ag.taux_continuite_pool = mean(contPoolRuns);
  ag.p_pool_casse = poolsTot ? poolsCassesTot / poolsTot : 0;
  ag.expoProfil = expoProfil;
  ag.vulnProfil = vulnProfil;                              // courbe de vulnérabilité cycle 1 (moy par tour)
  ag.toursFgeInsuffisantMoy = mean(toursFgeInsuffisant);   // nb moyen de tours à découvert (cycle 1)
  ag._pertes = acc.perteSfd;
  ag._pnls = acc.pnlOp;
  return ag;
}

// ---- décomposition du coût membre par tour (déterministe, pour affichage) ----
export function decompositionCout(p) {
  const m = p.m_membres, pot = (m - 1) * p.c, rSfd = rSfdMensuel(p);
  const seuilEmp = p.deux_populations ? Math.max(0, Math.min(m, Math.round(m / 2) + p.x_tours_emprunteurs)) : m;
  const rows = [];
  for (let slot = 0; slot < m; slot++) {
    if (p.deux_populations && slot >= seuilEmp) {
      // ÉPARGNANT : ne paie RIEN. Reçoit le pot + une rémunération (bonus).
      rows.push({ tour: slot + 1, type: 'épargnant', interets: 0, prime: 0, marge: 0, total: 0, pot });
    } else {
      // EMPRUNTEUR : intérêts + prime + marge.
      const duree = Math.max(1, m - (slot + 1));
      const avance = Math.max(0, pot - slot * p.c);
      const interets = pot * rSfd * duree;
      const prime = (p.mode === 'garantie' && p.prime_active && avance > 0) ? primeGarantie(avance, duree, p.p_fuite_base, m - 1, p.prime_facteur_prudence) : 0;
      const marge = p.mode === 'garantie' ? p.prime_operateur_taux * pot : 0;
      rows.push({ tour: slot + 1, type: 'emprunteur', interets, prime, marge, total: interets + prime + marge, pot });
    }
  }
  return rows;
}

// ---- CADRAGE DU RISQUE (optimisation sous contrainte SFD exprimée en % du pot) ----
// Taux d'usure annualisé implicite du membre le plus exposé (tour 1), à partir d'un résultat
// monteCarlo `res` et des params `p`. pot = (M-1)*c ; d = M-1 mois de crédit au tour 1.
function tauxUsureConfig(res, p) {
  const m = p.m_membres, pot = (m - 1) * p.c, d = m - 1;
  if (pot <= 0) return 0;
  return (res.coutTour1.moy / pot) * (12 / Math.max(1, d));
}

// cadrageRisque(base, opts) : grid search sur les leviers de tontine sous contrainte SFD
// exprimée en % du pot (fracPot). Conversion : cap_sfd_cotisations = fracPot * (M-1).
// Analyse PAR POOL (n_pools forcé à 1). Retourne { rows, pareto, capMin[, tronque] }.
export function cadrageRisque(base, opts = {}) {
  const arrOr = (v, def) => (Array.isArray(v) && v.length ? v : [def]);
  const caps = arrOr(opts.caps, undefined).map(x => x === undefined ? null : x);
  const Ms = arrOr(opts.Ms, base.m_membres);
  const cs = arrOr(opts.cs, base.c);
  const durees = arrOr(opts.durees, base.n_cycles);
  const partsSurs = arrOr(opts.partsSurs, base.part_eligibles_enchere);
  const partsEpargnant = arrOr(opts.partsEpargnant, base.part_epargnant);
  const rDepots = arrOr(opts.rDepots, base.r_depot_annuel);
  const runs = opts.runs || 300;
  const cibles = Array.isArray(opts.cibles) ? opts.cibles : [];
  // CAP SFD : soit un MONTANT ABSOLU en XOF (opts.capAbs) — qui lie c et M car cap/perte ne se
  // simplifie plus — soit, à défaut, exprimé en % du pot (opts.caps). L'absolu est prioritaire.
  const capAbs = (typeof opts.capAbs === 'number' && opts.capAbs > 0) ? opts.capAbs : null;
  const capDefaut = base.cap_sfd_cotisations / Math.max(1, (base.m_membres - 1));
  const capsEff = capAbs ? [null] : caps.map(x => x === null ? capDefaut : x);

  const MAX_COMBOS = 2000;
  const total = capsEff.length * Ms.length * cs.length * durees.length * partsSurs.length * partsEpargnant.length * rDepots.length;
  let tronque = false;
  let budget = total;
  if (total > MAX_COMBOS) { tronque = true; budget = MAX_COMBOS; }

  const rows = [];
  let nFaites = 0;
  outer:
  for (const cap of capsEff) {
    for (const M of Ms) {
      for (const c of cs) {
        for (const duree of durees) {
          for (const partSurs of partsSurs) {
            for (const partEparg of partsEpargnant) {
              for (const rDepot of rDepots) {
                if (nFaites >= budget) break outer;
                nFaites++;
                const pot = (M - 1) * c;
                // cap en nombre de cotisations : depuis l'absolu (capAbs/c) ou depuis le % du pot
                const capCotis = capAbs ? (capAbs / c) : (cap * (M - 1));
                const capPotEff = capAbs ? (capAbs / pot) : cap;   // % équivalent du pot
                const cfg = { ...base, n_pools: 1, m_membres: M, c, n_cycles: duree,
                              part_eligibles_enchere: partSurs, part_epargnant: partEparg,
                              r_depot_annuel: rDepot, cap_sfd_cotisations: capCotis };
                try {
                  const res = monteCarlo(cfg, runs, 12345);
                  const usure = tauxUsureConfig(res, cfg);
                  rows.push({
                    capPot: capPotEff, capAbs: capAbs || (cap * pot), capCotis, M, c, duree, partSurs, partEparg, rDepot,
                    promesse: res.taux_continuite_pool,
                    residuel: res.residuel.moy,
                    perteSfd: res.perteSfd.moy,
                    pnlPool: res.margePool.moy,
                    remunEparg: res.remunParEpargnant.moy,
                    usure,
                    usureOk: usure <= base.taux_usure_annuel,
                  });
                } catch (e) {
                  // combinaison instable : on la saute sans casser le grid.
                }
              }
            }
          }
        }
      }
    }
  }

  // FRONTIÈRE DE PARETO : pour chaque valeur de capPot, la meilleure config (promesse max parmi
  // usureOk=true ; à défaut promesse max). Triée par capPot croissant.
  const parCap = new Map();
  for (const r of rows) {
    const k = r.capPot;
    if (!parCap.has(k)) parCap.set(k, []);
    parCap.get(k).push(r);
  }
  const pickBest = (list) => {
    const ok = list.filter(r => r.usureOk);
    const pool = ok.length ? ok : list;
    return pool.reduce((b, r) => r.promesse > b.promesse ? r : b, pool[0]);
  };
  const pareto = [...parCap.entries()]
    .map(([, list]) => pickBest(list))
    .filter(Boolean)
    .sort((a, b) => a.capPot - b.capPot);

  // capMin[cible] : plus petit capPot pour lequel au moins une config atteint promesse>=cible
  // avec usureOk. null si jamais atteint.
  const capMin = {};
  for (const cible of cibles) {
    const ok = rows.filter(r => r.usureOk && r.promesse >= cible).map(r => r.capPot);
    capMin[cible] = ok.length ? Math.min(...ok) : null;
  }

  const out = { rows, pareto, capMin };
  if (tronque) out.tronque = true;
  return out;
}

// ---- OPTIMISATION (mode 2) ----
// Pour chaque SEGMENT (population avec son p_fuite et son c), balaie la grille (M, x, n_cycles,
// sévérité) sous les CONTRAINTES promesse>=0.99, usure<=0.24, residuel/pot<=0.005, et MAXIMISE
// pnlNet/pool. Calcule en plus une analyse de ROBUSTESSE (balayage de p_fuite -> p_fuite_rupture,
// marge_securite) et une config RECOMMANDÉE qui maximise pnlNet sous marge_securite>=0.50.
// Retour : { segments: [ { nom, p_fuite, optimale, robustesse, p_fuite_rupture, marge_securite,
//                          recommandee }, ... ], _log }.
export function optimiser(base, opts = {}) {
  const segments = Array.isArray(opts.segments) && opts.segments.length ? opts.segments : [
    { nom: 'salariés formels', p_fuite: 0.04, c: 50000 },
    { nom: 'commerçants/informel', p_fuite: 0.08, c: 50000 },
    { nom: 'primo-accédants', p_fuite: 0.12, c: 50000 },
  ];
  const Ms = opts.Ms || [4, 6, 8, 10, 12, 15, 20];
  const xs = opts.xs || [-2, -1, 0, 1, 2, 3];
  const cyclesArr = opts.cycles || [1, 2, 3, 4];
  const severites = opts.severites || [0.3, 0.5, 0.7, 1.0];
  const runsGrille0 = opts.runs || 250;
  const runsFinal = 1000;

  // Fixes SFD non optimisés (cap exprimé en % du pot -> nombre de cotisations)
  const fixesSfd = (M) => ({ r_sfd_annuel: 0.18, r_depot_annuel: 0.05, cap_sfd_cotisations: 0.15 * (M - 1) });

  const CONTR = { promesse: 0.99, usure: 0.24, residuelPot: 0.005 };
  const MARGE_MIN = 0.50;

  // borne du nombre total d'évaluations : grille admissible (x dans boundsX) × segments
  let cellesGrille = 0;
  for (const M of Ms) { const b = boundsX(M); for (const x of xs) { if (x < b.min || x > b.max) continue; cellesGrille += cyclesArr.length * severites.length; } }
  const totalEval = cellesGrille * segments.length;
  let runsGrille = runsGrille0;
  const log = [];
  if (totalEval > 3000) { runsGrille = 150; log.push(`grille=${totalEval} évaluations > 3000 -> runs balayage réduits à 150 (finales restent à 1000)`); }

  // évalue une config pour un segment donné (renvoie les métriques) ; n_pools=1
  const evalConfig = (seg, M, x, ncyc, sev, runs, graine = 12345) => {
    const cfg = { ...base, ...fixesSfd(M), n_pools: 1, m_membres: M, c: seg.c, n_cycles: ncyc,
                  x_tours_emprunteurs: x, part_eligibles_enchere: sev, p_fuite_base: seg.p_fuite };
    const res = monteCarlo(cfg, runs, graine);
    const usure = tauxUsureConfig(res, cfg);
    const pot = (M - 1) * seg.c;
    return {
      M, x, n_cycles: ncyc, severite: sev,
      promesse: res.taux_continuite_pool,
      residuelPot: pot > 0 ? res.residuel.moy / pot : 0,
      perteSfd: res.perteSfd.moy,
      usure,
      pnlNet: res.pnlNetPool.moy,
      remunEparg: res.remunParEpargnant.moy,
    };
  };
  const faisable = (r) => r.promesse >= CONTR.promesse - 1e-9 && r.usure <= CONTR.usure + 1e-9 && r.residuelPot <= CONTR.residuelPot + 1e-9;

  // robustesse : balayage de p_fuite de -50% à +100% (7 points) autour de p_fuite_segment
  const balayagePfuite = (seg, cfgDesc, runs) => {
    const pts = [];
    const facteurs = [0.5, 0.6667, 0.8333, 1.0, 1.3333, 1.6667, 2.0];
    for (const f of facteurs) {
      const pf = seg.p_fuite * f;
      const r = evalConfig({ ...seg, p_fuite: pf }, cfgDesc.M, cfgDesc.x, cfgDesc.n_cycles, cfgDesc.severite, runs, 4242);
      pts.push({ p_fuite: pf, promesse: r.promesse, residuelPot: r.residuelPot });
    }
    // p_fuite_rupture : premier point où promesse passe sous 0.99, interpolé linéairement
    let rupture = null;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.promesse >= CONTR.promesse && b.promesse < CONTR.promesse) {
        const frac = (CONTR.promesse - a.promesse) / (b.promesse - a.promesse);
        rupture = a.p_fuite + frac * (b.p_fuite - a.p_fuite);
        break;
      }
    }
    // cas : déjà sous le seuil au point le plus bas -> rupture en deçà du balayage (prend le 1er point)
    if (rupture === null && pts[0].promesse < CONTR.promesse) rupture = pts[0].p_fuite;
    // robuste sur toute la plage : promesse >= 0.99 jusqu'au point le plus haut (+100%) -> pas de
    // rupture observée ; la marge est alors >= +100% (borne inférieure = facteur max testé − 1).
    const robusteSurPlage = rupture === null && pts[pts.length - 1].promesse >= CONTR.promesse;
    return { pts, rupture, robusteSurPlage, facteurMax: facteurs[facteurs.length - 1] };
  };

  const sortie = [];
  for (const seg of segments) {
    // 1) balayage de grille
    const evals = [];
    for (const M of Ms) {
      const b = boundsX(M);
      for (const x of xs) {
        if (x < b.min || x > b.max) continue;
        for (const ncyc of cyclesArr) {
          for (const sev of severites) {
            evals.push(evalConfig(seg, M, x, ncyc, sev, runsGrille));
          }
        }
      }
    }
    const faisables = evals.filter(faisable);
    // 2) candidats triés par pnlNet (grille). On RE-SCREENE au finale (1000 runs) en descendant la
    // liste : on évite de retenir une config qui n'était faisable que par bruit MC à faible nombre
    // de runs (frontière). On garde la 1re config dont la mesure 1000-runs reste faisable.
    const candidatsGrille = faisables.slice().sort((a, b) => b.pnlNet - a.pnlNet);
    let optimale = null, opt1000 = null;
    for (const cand of candidatsGrille.slice(0, 8)) {     // re-screen au plus le top 8 (coût borné)
      const f1000 = evalConfig(seg, cand.M, cand.x, cand.n_cycles, cand.severite, runsFinal);
      if (faisable(f1000)) { optimale = cand; opt1000 = f1000; break; }
    }
    // repli : aucune confirmée à 1000 runs -> on garde la meilleure faisable-grille (signalée).
    if (!optimale && faisables.length) {
      optimale = candidatsGrille[0];
      opt1000 = evalConfig(seg, optimale.M, optimale.x, optimale.n_cycles, optimale.severite, runsFinal);
      log.push(`segment « ${seg.nom} » : meilleure config faisable-grille NON confirmée à ${runsFinal} runs (bruit MC près de la frontière) — reportée à titre indicatif`);
    }

    if (!optimale) {
      log.push(`segment « ${seg.nom} » (p_fuite=${seg.p_fuite}) : AUCUNE config ne satisfait les 3 contraintes`);
      sortie.push({ nom: seg.nom, p_fuite: seg.p_fuite, optimale: null, faisable: false,
                    robustesse: [], p_fuite_rupture: null, marge_securite: null, recommandee: null });
      continue;
    }

    // 4) robustesse autour de la config optimale. Marge : rupture détectée -> (rupture−pf)/pf ;
    // robuste sur toute la plage (jamais sous 0.99 jusqu'à +100%) -> marge >= facteurMax−1 (borne inf).
    const rob = balayagePfuite(seg, optimale, runsGrille);
    const rupture = rob.rupture;
    const marge = rupture != null
      ? (rupture - seg.p_fuite) / seg.p_fuite
      : (rob.robusteSurPlage ? (rob.facteurMax - 1) : null);

    // 5) recommandée : max pnlNet sous marge_securite>=0.50, évaluée sur le TOP 5 par pnlNet
    const top5 = faisables.slice().sort((a, b) => b.pnlNet - a.pnlNet).slice(0, 5);
    let recommandee = null;
    for (const cand of top5) {
      const rb = balayagePfuite(seg, cand, runsGrille);
      const rup = rb.rupture;
      const mg = rup != null
        ? (rup - seg.p_fuite) / seg.p_fuite
        : (rb.robusteSurPlage ? (rb.facteurMax - 1) : -Infinity); // null sans robustesse confirmée -> exclu
      if (mg >= MARGE_MIN && (!recommandee || cand.pnlNet > recommandee.pnlNet)) {
        recommandee = { ...cand, marge_securite: mg, p_fuite_rupture: rup };
      }
    }

    sortie.push({
      nom: seg.nom, p_fuite: seg.p_fuite, faisable: true,
      optimale: { ...optimale, ...opt1000 },   // métriques recalées à 1000 runs
      robustesse: rob.pts,
      p_fuite_rupture: rupture,
      marge_securite: marge,
      recommandee,
    });
  }

  return { segments: sortie, _log: log };
}
