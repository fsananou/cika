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
  x_tours_emprunteurs: 0,        // décalage par rapport à N/2 (0 = moitié/moitié)
  part_emprunteurs_declares: 0.55, // part de membres qui DÉCLARENT vouloir emprunter (accès précoce)
  // rémunération des épargnants (puisée dans le surplus de bids + intérêts sur dépôts)
  part_bids_aux_epargnants: 0.40, // part des surplus de bids reversée aux épargnants
  r_depot_annuel: 0.05,          // intérêt que la SFD verse sur les dépôts (rémunère l'épargne)
  // préférences
  part_urgent: 0.20, part_modere: 0.50, part_epargnant: 0.30,
  urg_urgent: 1.60, urg_modere: 1.00, urg_epargnant: 0.55,
  // fuite
  p_fuite_base: 0.06, fuite_mult_tour_precoce: 1.8, charge_z_fuite: 0.35,
  taux_echec_friction: 0.03, prelevement_auto_efficacite: 0.7,
  // couverture (3 étages)
  mitigation_active: true, acces_sequence_active: true, t_restreint: 3, part_avec_historique: 0.50,
  garantie_enchere_active: true, g_cotisations: 1,
  prime_active: true, fge_actif: true,
  tranche_sfd_active: true, plafond_tranche_sfd_frac: 0.15,
  // FGE/tranche SFD isolés par pool (défaut) : la solidité d'un pool ne dépend que de lui-même.
  // true = mutualisés entre tous les pools (un pool sain peut renflouer un pool en fuite).
  fge_mutualise: false,
  // RÈGLES CYCLE 1 : accès filtré par score décroissant (P90 au tour 1 -> P50 au tour M/2),
  // seuil de déclenchement de l'enchère (alpha), suivi explicite du FGE en constitution.
  cycle1_scoring_actif: true,
  cycle1_pct_t1: 0.90,           // percentile de score requis au tour 1 (P90)
  cycle1_pct_mid: 0.50,          // percentile requis au tour M/2 (P50)
  cycle1_reduction_fuite: 0.50,  // un emprunteur passé par le filtre fuit 2× moins (meilleur profil)
  alpha_declenchement: 0.80,     // l'enchère ne s'ouvre que si cotisations >= alpha * M * c
  // risque
  pd_base_annuel: 0.08, pd_base_sigma: 0.04,
  secteurs: [["commerce", 0.30, 0.30], ["agriculture", 0.20, 0.45], ["transport", 0.15, 0.25], ["services", 0.20, 0.15], ["artisanat", 0.15, 0.20]],
  // stress
  comportemental_actif: false, choc_fuite: 0.0, bascule_urgents: 0.0,
  macro_actif: false, z_choc: 0.0, z_persistance: 0,
  // P&L BRUT : on n'inclut aucun coût (acquisition, ops, fixes). Les coûts relèvent de la
  // structure et du financement, hors du périmètre. Le P&L = revenus bruts du mécanisme.
  cout_acquisition_membre: 0, cout_ops_pool_mois: 0, couts_fixes_mensuels: 0, cout_capital_annuel: 0.10,
};

const rSfdMensuel = p => p.r_sfd_annuel / 12;

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
  // seuil emprunteurs / épargnants : N/2 + x
  const seuilEmp = Math.max(0, Math.min(m, Math.round(m / 2) + (p.deux_populations ? p.x_tours_emprunteurs : m)));
  const rDepotMensuel = (p.r_depot_annuel || 0) / 12;
  const pools = []; const comptes = [];
  for (let pid = 0; pid < nPools; pid++) {
    const membres = poolsIdx[pid].map((gi, i) => {
      const pr = profils[gi]; let [tp, urg] = pref();
      if (p.comportemental_actif && (tp === "modere" || tp === "epargnant") && rng() < p.bascule_urgents) { tp = "urgent"; urg = p.urg_urgent; }
      const aHist = rng() < p.part_avec_historique;
      // profil déclaré : veut emprunter (accès précoce) OU épargner. + filtre de fiabilité (aHist).
      const declareEmp = rng() < p.part_emprunteurs_declares;
      const candidatEmp = p.deux_populations ? (declareEmp && aHist) : true; // accès phase emprunteurs
      return { i, seuil: pr.seuil, rho: pr.rho, type: tp, urg, aHist, candidatEmp, estEpargnant: false, aEncaisse: false, tEnc: null, aFui: false, consign: 0, cotise: 0, recu: 0, remun: 0 };
    });
    pools.push(membres); comptes.push({ prets: [], decaisseCumule: 0, depot: 0, fge: 0, trancheUtil: 0 });
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
  const exposMois = new Array(totalTours).fill(0);
  const chocFuite = p.comportemental_actif ? p.choc_fuite : 0;

  // --- RÈGLES CYCLE 1 ---
  // score de fiabilité par membre = -seuil (seuil bas = PD basse = plus fiable). Bonus historique.
  for (const membres of pools) for (const mb of membres) mb.score = -mb.seuil + (mb.aHist ? 0.5 : 0);
  // seuils de percentile par tour du cycle 1 : S_t décroît de pct_t1 (tour 0) à pct_mid (tour M/2)
  function seuilScorePool(membres, slot) {
    if (!p.cycle1_scoring_actif) return -Infinity;
    const mid = Math.max(1, Math.round(m / 2));
    if (slot >= mid) return -Infinity; // au-delà de M/2 : pas de seuil
    const frac = slot / mid; // 0 au tour 1 -> ~1 au tour M/2
    const pct = p.cycle1_pct_t1 + (p.cycle1_pct_mid - p.cycle1_pct_t1) * frac;
    const scores = membres.map(x => x.score).sort((a, b) => a - b);
    return quantile(scores, pct); // score minimal requis ce tour
  }
  // suivi de la courbe de vulnérabilité du CYCLE 1 (par tour) : expo nette, FGE dispo, vulnérabilité
  const vulnCycle1 = []; // [{tour, expoNette, fgeDispo, vuln, alerte}]
  let tours_fge_insuffisant = 0;

  for (let t = 1; t <= totalTours; t++) {
    const z = zMois[t - 1], slot = (t - 1) % m;
    if (slot === 0) for (const mb of pools.flat()) if (!mb.aFui) mb.aEncaisse = false;

    for (let pid = 0; pid < nPools; pid++) {
      const membres = pools[pid], cpt = comptes[pid];
      // 1. fuites
      for (const mb of membres) {
        if (mb.aEncaisse && !mb.aFui) {
          const moisR = Math.max(1, vie - mb.tEnc);
          const baseFuite = p.p_fuite_base * (mb.filtreScore ? (p.cycle1_reduction_fuite ?? 0.5) : 1);
          const pf = probaFuite(baseFuite, mb.tEnc, m, z, moisR, p.charge_z_fuite, p.fuite_mult_tour_precoce, chocFuite);
          if (rng() < pf) {
            mb.aFui = true; nFuites++;
            let trou = 0;
            for (const pr of cpt.prets) if (pr.membre === mb.i && pr.actif && pr.restant > 1e-9) { pr.actif = false; trou += pr.restant; }
            if (p.garantie_enchere_active && mb.consign > 0) { addFge(pid, mb.consign); fgeSaisies += mb.consign; mb.consign = 0; }
            let reste = trou;
            const pf2 = p.fge_actif ? Math.min(getFge(pid), reste) : 0; addFge(pid, -pf2); reste -= pf2; couvertFge += pf2;
            if (reste > 1e-9 && p.tranche_sfd_active) { const plaf = p.plafond_tranche_sfd_frac * Math.max(assietteTranche(pid), 1); const dispo = Math.max(0, plaf - getTranche(pid)); const ps = Math.min(dispo, reste); addTranche(pid, ps); reste -= ps; couvertSfd += ps; perteSfd += ps; }
            if (reste > 1e-9) { residuel += reste; continuiteOk = false; comptes[pid].casse = true; }
          }
        }
      }
      // 2. collecte des cotisations -> alimente le dépôt commun
      const actifs = membres.filter(mb => !mb.aFui);
      let potColl = 0;
      for (const mb of actifs) if (!mb.aEncaisse) { let taux = p.taux_echec_friction; if (p.mitigation_active) taux *= (1 - p.prelevement_auto_efficacite); const versé = (rng() < taux ? p.c * 0.9 : p.c); potColl += versé; cpt.depot += versé; mb.cotise += p.c; }
      // intérêts sur le dépôt (la SFD rémunère l'épargne déposée)
      if (rDepotMensuel > 0 && cpt.depot > 0) { const it = cpt.depot * rDepotMensuel; cpt.depot += it; interetsDepots += it; }

      const dureePret = Math.max(1, m - (slot + 1));
      const phaseEmprunteur = !p.deux_populations || (slot < seuilEmp);

      // 3. attribution + 4. décaissement
      let gagnant = null, bideur = false, bidSurplusWtp = 0;
      const cycle1 = (t <= m); // premier cycle
      if (phaseEmprunteur) {
        // --- PHASE EMPRUNTEURS : enchère, avance SFD, crédit-relais, prime + risque de fuite ---
        let elig = actifs.filter(mb => !mb.aEncaisse && (!p.deux_populations || mb.candidatEmp));
        // RÈGLE CYCLE 1.a : filtre par score décroissant (P90 -> P50)
        const filtreActif = cycle1 && p.cycle1_scoring_actif;
        if (filtreActif) {
          const sMin = seuilScorePool(membres, slot);
          elig = elig.filter(mb => mb.score >= sMin);
        }
        // RÈGLE CYCLE 1.b : seuil de déclenchement — l'enchère ne s'ouvre que si la collecte
        // du tour atteint alpha * M * c ; sinon, allocation sans enchère (déclenchement forcé).
        const enchereOuverte = !(cycle1 && p.cycle1_scoring_actif) || (potColl >= p.alpha_declenchement * m * p.c);
        let eligBid = enchereOuverte ? elig : [];
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
          cpt.prets.push({ membre: gagnant.i, restant: net, mensualite: net / dureePret, actif: true }); cpt.decaisseCumule += net;
          gagnant.aEncaisse = true; gagnant.tEnc = t; gagnant.recu += net;
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
          // servi depuis le dépôt ; si insuffisant, le complément passe par la CASCADE de
          // couverture (FGE -> tranche SFD), comme tout trou. La promesse tient tant que la
          // cascade tient.
          const pris = Math.min(cpt.depot, pot); cpt.depot -= pris;
          let complement = pot - pris;
          if (complement > 1e-9) {
            const pf = p.fge_actif ? Math.min(getFge(pid), complement) : 0; addFge(pid, -pf); complement -= pf; couvertFge += pf;
            if (complement > 1e-9 && p.tranche_sfd_active) { const plaf = p.plafond_tranche_sfd_frac * Math.max(assietteTranche(pid), 1); const dispo = Math.max(0, plaf - getTranche(pid)); const ps = Math.min(dispo, complement); addTranche(pid, ps); complement -= ps; couvertSfd += ps; perteSfd += ps; }
            if (complement > 1e-9) { residuel += complement; continuiteOk = false; comptes[pid].casse = true; }
          }
          gagnant.recu += pot;
        }
      }
      // 5. récupération des prêts (rembourse le dépôt)
      for (const pr of cpt.prets) if (pr.actif && pr.restant > 1e-9) { const pa = Math.min(pr.mensualite, pr.restant); pr.restant -= pa; cpt.depot += pa; }
      exposMois[t - 1] += cpt.prets.filter(pr => pr.actif).reduce((s, pr) => s + pr.restant, 0);
    }
    // --- COURBE DE VULNÉRABILITÉ CYCLE 1 (FGE en constitution), RAMENÉE À UN POOL ---
    // Tout est exprimé PAR POOL pour que la lecture ne dépende pas du nombre de pools :
    // couverture moyenne d'un pool (FGE + tranche SFD dispo) face à la pire fuite d'un pool.
    if (t <= m) {
      const expoNette = exposMois[t - 1] / nPools;          // encours moyen par pool
      // pire fuite d'un pool : la plus grosse avance en cours, mesurée pool par pool puis moyennée
      let perteMaxParPool = 0;
      let fgeDispoTot = 0, plafTrancheTot = 0;
      for (let pid = 0; pid < nPools; pid++) {
        let pmax = 0; for (const pr of comptes[pid].prets) if (pr.actif && pr.restant > pmax) pmax = pr.restant;
        perteMaxParPool += pmax / nPools;
        fgeDispoTot += getFge(pid);
        if (p.tranche_sfd_active) plafTrancheTot += Math.max(0, p.plafond_tranche_sfd_frac * Math.max(assietteTranche(pid), 1) - getTranche(pid));
      }
      // en mutualisé, getFge/getTranche renvoient le global pour chaque pid -> on corrige par /nPools
      const fgeDispo = (mutu ? fgeGlob : fgeDispoTot) / nPools;
      const plafTranche = (mutu ? (p.tranche_sfd_active ? Math.max(0, p.plafond_tranche_sfd_frac * Math.max(comptes.reduce((s, c) => s + c.decaisseCumule, 0), 1) - trancheGlob) : 0) : plafTrancheTot) / nPools;
      const couvertureDispo = fgeDispo + plafTranche;
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

  // P&L Opérateur (brut)
  const revenus = primes + surplusEnchere;
  const coutAcq = p.cout_acquisition_membre * nMembres, coutOps = p.cout_ops_pool_mois * nPools * mois;
  const coutsFixes = p.couts_fixes_mensuels * mois;
  const pnlOp = revenus - (coutAcq + coutOps + coutsFixes);
  const margePool = nPools ? (revenus - coutAcq - coutOps) / nPools : 0;
  const breakEven = coutsFixes <= 0 ? (margePool > 1e-9 ? 0 : Infinity) : (margePool > 1e-9 ? coutsFixes / margePool : Infinity);

  // continuité PAR POOL : fraction des pools qui tiennent leur promesse (indépendant du nb de pools)
  const poolsCasses = comptes.filter(c => c.casse).length;
  const tauxContinuitePool = nPools ? 1 - poolsCasses / nPools : 1;

  return {
    nPools, nFuites, continuiteOk, residuel, perteSfd, coutTour1, nGratuits,
    poolsCasses, tauxContinuitePool,
    couvertFge, couvertSfd, fgeProvisions, fgeSaisies, primes, surplusEnchere, interetsSfd, avanceCumulee,
    remunEpargnants: totalRemun, remunParEpargnant, nEpargnants, interetsDepots,
    expoMois: exposMois, expoMax: Math.max(...exposMois),
    pnlOp, margePool, breakEven, revenus, coutAcq, coutOps, seuilEmp,
    vulnCycle1, tours_fge_insuffisant,
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
    return { i, nom: NOMS[i % NOMS.length], seuil: pr.seuil, rho: pr.rho, type: tp, urg, aHist,
             candidatEmp: p.deux_populations ? (declareEmp && aHist) : true, estEpargnant: false,
             aEncaisse: false, tEnc: null, aFui: false, consign: 0, cotise: 0, recu: 0, remplacant: null };
    });
  membres.forEach(mb => mb.score = -mb.seuil + (mb.aHist ? 0.5 : 0));
  const cpt = { prets: [], decaisseCumule: 0, depot: 0 };
  let fge = 0, trancheUtil = 0, nRempl = 0;
  const etatZ = {};
  const chocFuite = p.comportemental_actif ? p.choc_fuite : 0;
  const rDepotMensuel = (p.r_depot_annuel || 0) / 12;
  const seuilEmp = Math.max(0, Math.min(m, Math.round(m / 2) + (p.deux_populations ? p.x_tours_emprunteurs : m)));

  function seuilScorePool(slot) {
    if (!p.cycle1_scoring_actif) return -Infinity;
    const mid = Math.max(1, Math.round(m / 2)); if (slot >= mid) return -Infinity;
    const frac = slot / mid, pct = p.cycle1_pct_t1 + (p.cycle1_pct_mid - p.cycle1_pct_t1) * frac;
    return quantile(membres.map(x => x.score).sort((a, b) => a - b), pct);
  }

  const tours = []; // { tour, cycle, slot, phase, mouvements:[{acteur,type,libelle,montant,depot,fge}] }
  const flux = (arr, acteur, type, libelle, montant) => arr.push({ acteur, type, libelle, montant, depot: cpt.depot, fge });

  for (let t = 1; t <= totalTours; t++) {
    const z = tirerZ(rng, p, etatZ), slot = (t - 1) % m, cycle = Math.floor((t - 1) / m) + 1;
    if (slot === 0) for (const mb of membres) if (!mb.aFui) mb.aEncaisse = false;
    const mvt = [];

    // 1. fuites (membres ayant encaissé) + cascade de couverture + remplacement
    for (const mb of membres) {
      if (mb.aEncaisse && !mb.aFui) {
        const moisR = Math.max(1, vie - mb.tEnc);
        const pf = probaFuite(p.p_fuite_base, mb.tEnc, m, z, moisR, p.charge_z_fuite, p.fuite_mult_tour_precoce, chocFuite);
        if (rng() < pf) {
          mb.aFui = true;
          let trou = 0; for (const pr of cpt.prets) if (pr.membre === mb.i && pr.actif && pr.restant > 1e-9) { pr.actif = false; trou += pr.restant; }
          flux(mvt, mb.nom, 'fuite', `${mb.nom} (encaissé T${mb.tEnc}) disparaît — avance non remboursée`, -trou);
          if (p.garantie_enchere_active && mb.consign > 0) { fge += mb.consign; flux(mvt, 'FGE', 'saisie', `garantie d'enchère de ${mb.nom} saisie → FGE`, mb.consign); mb.consign = 0; }
          if (p.mode === 'garantie') {
            let reste = trou;
            const pf2 = p.fge_actif ? Math.min(fge, reste) : 0; if (pf2 > 0) { fge -= pf2; reste -= pf2; flux(mvt, 'FGE', 'couverture', `FGE absorbe le trou (première perte)`, -pf2); }
            if (reste > 1e-9 && p.tranche_sfd_active) { const plaf = p.plafond_tranche_sfd_frac * Math.max(cpt.decaisseCumule, 1); const dispo = Math.max(0, plaf - trancheUtil); const ps = Math.min(dispo, reste); if (ps > 0) { trancheUtil += ps; reste -= ps; flux(mvt, 'SFD', 'couverture', `tranche junior SFD absorbe le reliquat (peau dans le jeu)`, -ps); } }
            if (reste > 1e-9) flux(mvt, '—', 'résiduel', `résiduel non couvert (promesse en tension)`, -reste);
          } else {
            flux(mvt, 'Groupe', 'résiduel', `tontine nue : le groupe subit la perte`, -trou);
          }
          // remplacement : un nouveau membre reprend le sous-compte et les cotisations restantes (règle de gestion)
          const nom = REMPL[nRempl % REMPL.length]; nRempl++;
          mb.remplacant = nom;
          flux(mvt, nom, 'remplacement', `${nom} remplace ${mb.nom} et reprend les cotisations à venir`, 0);
        }
      }
    }

    // 2. cotisations → dépôt commun
    const actifs = membres.filter(mb => !mb.aFui);
    let potColl = 0, nCot = 0;
    for (const mb of actifs) if (!mb.aEncaisse) { cpt.depot += p.c; potColl += p.c; mb.cotise += p.c; nCot++; }
    // les fuyards remplacés cotisent aussi (le remplaçant paie)
    for (const mb of membres) if (mb.aFui && mb.remplacant && !mb.aEncaisse) { cpt.depot += p.c; potColl += p.c; nCot++; }
    flux(mvt, 'Membres', 'cotisation', `${nCot} cotisations versées au dépôt commun`, nCot * p.c);
    if (rDepotMensuel > 0 && cpt.depot > 0) { const it = cpt.depot * rDepotMensuel; cpt.depot += it; flux(mvt, 'SFD', 'rémunération', `intérêts versés sur le dépôt (rémunération de l'épargne)`, it); }

    const dureePret = Math.max(1, m - (slot + 1));
    const phaseEmprunteur = !p.deux_populations || (slot < seuilEmp);
    let phase = phaseEmprunteur ? 'emprunteur' : 'épargnant';

    // 3. attribution + décaissement
    if (phaseEmprunteur) {
      let elig = actifs.filter(mb => !mb.aEncaisse && (!p.deux_populations || mb.candidatEmp));
      const cycle1 = t <= m;
      if (cycle1 && p.cycle1_scoring_actif) { const sMin = seuilScorePool(slot); elig = elig.filter(mb => mb.score >= sMin); }
      const enchereOuverte = !(cycle1 && p.cycle1_scoring_actif) || (potColl >= p.alpha_declenchement * m * p.c);
      let eligBid = enchereOuverte ? elig : [];
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
          cpt.prets.push({ membre: gagnant.i, restant: net, mensualite: net / dureePret, actif: true }); cpt.decaisseCumule += net;
          flux(mvt, 'SFD', 'intérêts', `intérêts du crédit-relais (retenus dans le bid)`, interets);
          if (primeGar > 0) { fge += primeGar; flux(mvt, 'FGE', 'prime', `prime de garantie de ${gagnant.nom} → FGE`, primeGar); }
          flux(mvt, 'Opérateur', 'marge', `marge Opérateur (retenue dans le bid)`, margeOp);
          if (surplus > 0) { const partEp = (p.deux_populations ? p.part_bids_aux_epargnants : 0) * surplus; if (partEp > 0) { cpt.depot += partEp; flux(mvt, 'Épargnants', 'rémunération', `part du surplus d'enchère reversée aux épargnants`, partEp); } flux(mvt, 'Opérateur', 'surplus', `surplus d'enchère conservé par l'Opérateur`, surplus - partEp); }
        } else {
          net = pot; cpt.prets.push({ membre: gagnant.i, restant: net, mensualite: net / dureePret, actif: true }); cpt.decaisseCumule += net;
          flux(mvt, gagnant.nom, 'attribution', `${gagnant.nom} prend le tour (tontine nue, sans frais)`, 0);
          flux(mvt, 'SFD', 'avance', `la SFD avance le pot à ${gagnant.nom}`, net);
        }
        gagnant.aEncaisse = true; gagnant.tEnc = t; gagnant.recu += net;
      } else {
        flux(mvt, '—', 'gel', `aucune attribution ce tour (enchère non déclenchée / pas d'éligible)`, 0);
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
        const pris = Math.min(cpt.depot, pot); cpt.depot -= pris; flux(mvt, 'Dépôt', 'service', `pot payé depuis le dépôt commun`, -pris);
        let complement = pot - pris;
        if (complement > 1e-9) {
          const pf = p.fge_actif ? Math.min(fge, complement) : 0; if (pf > 0) { fge -= pf; complement -= pf; flux(mvt, 'FGE', 'couverture', `complément couvert par le FGE`, -pf); }
          if (complement > 1e-9 && p.tranche_sfd_active) { const plaf = p.plafond_tranche_sfd_frac * Math.max(cpt.decaisseCumule, 1); const dispo = Math.max(0, plaf - trancheUtil); const ps = Math.min(dispo, complement); if (ps > 0) { trancheUtil += ps; complement -= ps; flux(mvt, 'SFD', 'couverture', `complément couvert par la tranche SFD`, -ps); } }
          if (complement > 1e-9) flux(mvt, '—', 'résiduel', `résiduel non couvert (promesse en tension)`, -complement);
        }
        gagnant.recu += pot;
      }
    }

    // 4. récupération des prêts (rembourse le dépôt)
    let recup = 0; for (const pr of cpt.prets) if (pr.actif && pr.restant > 1e-9) { const pa = Math.min(pr.mensualite, pr.restant); pr.restant -= pa; cpt.depot += pa; recup += pa; }
    if (recup > 0.5) flux(mvt, 'Dépôt', 'recouvrement', `mensualités des crédits-relais récupérées sur le dépôt`, recup);

    const expo = cpt.prets.filter(pr => pr.actif).reduce((s, pr) => s + pr.restant, 0);
    tours.push({ tour: t, cycle, slot: slot + 1, phase, mvt, depot: cpt.depot, fge, expo });
  }
  return { m, pot, cycles: p.n_cycles, totalTours, tours, nRempl };
}

// ---- Monte Carlo ----
export function monteCarlo(p, nRuns, graineBase) {
  const acc = { pnlOp: [], continuite: [], residuel: [], perteSfd: [], expoMax: [], fuites: [], coutTour1: [], margePool: [], nGratuits: [],
                interetsSfd: [], primes: [], surplusEnchere: [], fgeProvisions: [], fgeSaisies: [], couvertFge: [], couvertSfd: [], avanceCumulee: [],
                remunEpargnants: [], remunParEpargnant: [], nEpargnants: [], interetsDepots: [] };
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
