// CIKA scoring + population-simulation engine
// Port of rosca_score_engine.py (Python/numpy) to vanilla JS.
//
// Public API (window.CIKA):
//   computeScoreSingle(vals, params)  — single-member scorer (Stage 1)
//   simulatePopulation(pop, macro, params, opts) — full population sim (Stage 2)
//
// All randomness goes through a seeded Mulberry32 PRNG so results are
// reproducible across runs for the same seed.

(function (root) {
  'use strict';

  // ─── Math helpers ───────────────────────────────────────────────────────
  const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const sigmoid = x => 1 / (1 + Math.exp(-clip(x, -30, 30)));
  const log1pSafe = x => Math.log1p(Math.max(0, x));
  const logit = p => {
    const pc = clip(p, 1e-6, 1 - 1e-6);
    return Math.log(pc / (1 - pc));
  };

  // ─── Seeded PRNG (Mulberry32) ───────────────────────────────────────────
  function makeRNG(seed) {
    let s = (seed >>> 0) || 1;
    function nextU32() {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return (t ^ (t >>> 14)) >>> 0;
    }
    const random = () => nextU32() / 4294967296;
    return {
      random,
      // Uniform integer in [lo, hi] inclusive
      integers: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
      uniform: (lo, hi) => lo + random() * (hi - lo),
      // Box–Muller standard normal
      standardNormal: () => {
        const u1 = Math.max(random(), 1e-12);
        const u2 = random();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      },
      normal: (mu, sigma) => {
        const u1 = Math.max(random(), 1e-12);
        const u2 = random();
        return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      },
      lognormal: (mu, sigma) => {
        const u1 = Math.max(random(), 1e-12);
        const u2 = random();
        return Math.exp(mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
      },
      // Beta via two Gamma draws (Marsaglia–Tsang for shape ≥ 1; Johnk for shape < 1)
      beta(a, b) { return betaSample(this, a, b); },
      // Fisher–Yates permutation of [1..n]
      permutation(n) {
        const arr = Array.from({ length: n }, (_, i) => i + 1);
        for (let i = n - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
      },
      // Simple deterministic hash → 31-bit unsigned for sub-seeding
      subSeed(base, label) {
        let h = 2166136261 >>> 0;
        const s = String(label);
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619) >>> 0;
        }
        return ((base + h) >>> 0) & 0x7fffffff;
      },
    };
  }

  // Gamma(shape, 1) via Marsaglia–Tsang for shape >= 1, Johnk's for shape < 1
  function gammaSample(rng, shape) {
    if (shape < 1) {
      // Boost: G(a) = G(a+1) * U^(1/a)
      const g = gammaSample(rng, shape + 1);
      const u = Math.max(rng.random(), 1e-12);
      return g * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = rng.standardNormal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rng.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function betaSample(rng, a, b) {
    const x = gammaSample(rng, a);
    const y = gammaSample(rng, b);
    return x / (x + y);
  }

  function betaParams(mean, conc) {
    const m = clip(mean, 1e-4, 1 - 1e-4);
    const c = Math.max(conc, 0.5);
    return [m * c, (1 - m) * c];
  }

  // ─── Score parameters (defaults from ScoreParams) ───────────────────────
  const DEFAULT_SCORE_PARAMS = {
    a: 0.80, c_otr: 0.85, k_otr: 12.0, a_al: 0.70, a_ls: 0.60,
    c_rc: 0.70, k_rc: 10.0,
    a_slip: 0.80,
    k_rules: 12.0, a_san: 0.60,
    q0: 0.50, k_q: 10.0, v_ref: 0.10, a_v: 0.80,
    w_rep: 5.0, w_cent: 4.0, w_endf: 3.0, w_ends: 3.0,
    gamma_rep: 0.30, w_unverified: 1.0, gov_star_penalty: 0.40,
    lambda_stack: 0.15, alpha_macro: 0.0,
  };

  const DEFAULT_POP_PARAMS = {
    n_groups: 20,
    group_size_min: 6,
    group_size_max: 20,
    rtype_bidding_prob: 0.50,
    rules_prob: 0.75,
    san_rate_min: 0.10,
    san_rate_max: 1.20,
    num_cycles_min: 1,
    num_cycles_max: 3,
    p_ontime_mean: 0.80,
    p_ontime_conc: 9.0,
    dlate_lognorm_mu: 1.6,
    dlate_lognorm_sigma: 0.8,
    post_slip_mean: 0.08,
    post_slip_conc: 8.0,
    bid_agg_mean: 0.22,
    bid_agg_conc: 7.0,
    bid_vol_min: 0.02,
    bid_vol_max: 0.30,
    p_rep: 0.45,
    p_cent: 0.30,
    p_endf: 0.25,
    p_ends: 0.15,
    p_sure_none: 0.40,
    p_sure_weak: 0.35,
    p_prior_default: 0.10,
    p_payment_verified: 0.85,
    p_pay_ver_conc: 8.0,
    p_star_topology: 0.15,
    p_multi_group: 0.20,
    n_extra_groups_max: 2,
  };

  const DEFAULT_MACRO = {
    stress_level: 0.0,
    within_group_corr: 0.20,
    shock_windows: [],   // [[t0, t1, severity], ...]
  };

  // ─── Single-member score (used both standalone and inside population) ────
  // Inputs: scored "row" with all meeting-derived statistics already computed.
  function computeScoreFromRow(row, params) {
    const P = { ...DEFAULT_SCORE_PARAMS, ...(params || {}) };

    // Apply credit-stacking haircut later — first compute pillars.
    const otr = row.otr;
    const al = row.al;
    const ls = row.ls;
    const rc = row.rc;
    const tdec = row.tdec ? 1 : 0;
    const rules = row.rules ? 1 : 0;
    const slip = row.slip ? 1 : 0;
    const san6 = row.san6;
    const sure_str = row.sure_str;
    const star_topology = !!row.star_topology;
    const prior_default = !!row.prior_default;
    const extra_groups = row.extra_groups | 0;
    const aord = row.aord;
    const n = row.n;
    const rtype = row.rtype;

    // pdis
    const S_otr = 18.0 * sigmoid(P.k_otr * (otr - P.c_otr));
    const S_al  = 6.0 * Math.exp(-P.a_al * log1pSafe(al));
    const S_ls  = 8.0 * Math.exp(-P.a_ls * Math.max(0, ls - 1));
    const S_rc  = 7.0 * sigmoid(P.k_rc * (rc - P.c_rc));
    let s_pdis = Math.min(35.0, (35.0 / 39.0) * (S_otr + S_al + S_ls + S_rc));
    if (extra_groups > 0 && P.lambda_stack > 0) {
      s_pdis *= Math.max(0, 1 - P.lambda_stack * extra_groups);
    }

    // ordr
    const ratio = aord / Math.max(1, n);
    let b_ord, bucket;
    if (ratio <= 1/3)      { b_ord = 0.3; bucket = 'early'; }
    else if (ratio <= 2/3) { b_ord = 0.6; bucket = 'mid'; }
    else                    { b_ord = 1.0; bucket = 'late'; }
    let s_ordr = tdec ? 15.0 * b_ord * (1.0 - P.a_slip * slip) : 15.0 * b_ord;

    // gov
    const S_rules = 5.0 * sigmoid(P.k_rules * (rules - 0.5));
    const S_san   = 6.0 * Math.exp(-P.a_san * san6);
    const S_sure  = ({ none: 0.0, weak: 3.0, strong: 6.0 })[sure_str] ?? 0.0;
    let s_gov = (20.0 / 17.0) * (S_rules + S_san + S_sure);
    if (star_topology) s_gov *= (1.0 - P.gov_star_penalty);

    // liq (bidding only)
    let s_liq = 0.0;
    if (rtype === 'bidding' && row.bid_q_rank != null) {
      const q_rank = row.bid_q_rank;
      const iqr    = row.bid_iqr || 0;
      const S_lvl  = 6.0 * (1.0 - sigmoid(P.k_q * (q_rank - P.q0)));
      const S_vol  = 6.0 * Math.exp(-P.a_v * log1pSafe(iqr / P.v_ref));
      s_liq = (15.0 / 12.0) * (S_lvl + S_vol);
    }

    // soc
    let s_soc = P.w_rep  * (row.rep   ? 1 : 0)
              + P.w_cent * (row.cent  ? 1 : 0)
              + P.w_endf * (row.end_f ? 1 : 0)
              + P.w_ends * (row.end_s ? 1 : 0);
    if (prior_default) s_soc *= P.gamma_rep;

    let score = s_pdis + s_ordr + s_gov + s_liq + s_soc;
    const defaulted = !!row.defaulted;
    if (defaulted) {
      score = 0; s_pdis = s_ordr = s_gov = s_liq = s_soc = 0;
    }
    return { score, s_pdis, s_ordr, s_gov, s_liq, s_soc, bucket, defaulted };
  }

  // Single-member scorer for the form UI (Stage 1 path).
  // Translates form values into a row, computes verification adjustment to otr.
  function computeScoreSingle(v, params) {
    const P = { ...DEFAULT_SCORE_PARAMS, ...(params || {}) };
    const otr_in = +v.otr;
    const ont_verified_share = +v.p_verified;
    const otr_verified = otr_in * ont_verified_share;
    const otr = otr_verified + P.w_unverified * (otr_in - otr_verified);
    return computeScoreFromRow({
      otr, al: +v.al, ls: +v.ls, rc: +v.rc,
      tdec: v.rtype === 'bidding' ? 1 : 0,
      rules: v.rules ? 1 : 0,
      slip: v.slip ? 1 : 0,
      san6: +v.san6,
      sure_str: v.sure,
      star_topology: !!v.star_topology,
      prior_default: !!v.prior_default,
      extra_groups: +v.extra_groups | 0,
      aord: +v.aord,
      n: +v.n_meetings,
      rtype: v.rtype,
      bid_q_rank: v.rtype === 'bidding' ? +v.q_rank : null,
      bid_iqr: +v.bid_iqr,
      rep: !!v.rep, cent: !!v.cent, end_f: !!v.end_f, end_s: !!v.end_s,
      defaulted: !!v.defaulted_flag,
    }, P);
  }

  // ─── Population simulation ──────────────────────────────────────────────
  function simulatePopulation(popIn, macroIn, paramsIn, opts) {
    const pop    = { ...DEFAULT_POP_PARAMS, ...(popIn || {}) };
    const macro  = { ...DEFAULT_MACRO, ...(macroIn || {}) };
    const params = { ...DEFAULT_SCORE_PARAMS, ...(paramsIn || {}) };
    const seed   = opts && opts.seed != null ? opts.seed : 42;
    const K_min  = opts && opts.K_min != null ? opts.K_min : 6;
    const streakThreshold = opts && opts.streak_threshold != null ? opts.streak_threshold : 3;
    const onProgress = opts && opts.onProgress;

    const masterRng = makeRNG(seed);

    const members = [];
    const summary = {
      n_members: 0,
      n_defaulted: 0,
      mean_score: 0,
      median_score: 0,
      mean_p_ontime_raw: 0,
      bidding_share: 0,
    };

    let scoreSum = 0;
    let pOnSum = 0;
    let biddingCount = 0;

    for (let g = 0; g < pop.n_groups; g++) {
      const gid = 'G' + String(g + 1).padStart(2, '0');

      // Group structure
      const n = masterRng.integers(pop.group_size_min, pop.group_size_max);
      const rtype = masterRng.random() < pop.rtype_bidding_prob ? 'bidding' : 'random';
      const rules = masterRng.random() < pop.rules_prob;
      const san_rate = masterRng.uniform(pop.san_rate_min, pop.san_rate_max);
      const num_cycles = masterRng.integers(pop.num_cycles_min, pop.num_cycles_max);
      const aord_list = masterRng.permutation(n);
      const star_topology = masterRng.random() < pop.p_star_topology;

      const [a_otr, b_otr]   = betaParams(pop.p_ontime_mean, pop.p_ontime_conc);
      const [a_slip, b_slip] = betaParams(pop.post_slip_mean, pop.post_slip_conc);
      const [a_bid, b_bid]   = betaParams(pop.bid_agg_mean, pop.bid_agg_conc);
      const [a_ver, b_ver]   = betaParams(pop.p_payment_verified, pop.p_pay_ver_conc);

      const meetings_per_cycle = Math.max(K_min, n);
      const total_meetings = meetings_per_cycle * num_cycles;

      // Group-shock RNG: one shock per meeting, shared by all members in this group.
      const rngGroup = makeRNG(masterRng.subSeed(seed, gid));
      const groupShocks = new Float64Array(total_meetings);
      for (let i = 0; i < total_meetings; i++) groupShocks[i] = rngGroup.standardNormal();

      const corr = clip(macro.within_group_corr, 0, 1);
      const sqrtCorr = Math.sqrt(corr);
      const sqrt1mc = Math.sqrt(Math.max(0, 1 - corr));
      const stressShift = macro.stress_level * 1.5;

      // Pre-pass: collect per-member bid discounts to compute group-relative q_rank later
      const memberBuffers = [];

      for (let m = 0; m < n; m++) {
        const mid = `${gid}_M${String(m + 1).padStart(2, '0')}`;
        const aord = aord_list[m];

        // Member profile draws
        const p_ontime_raw  = clip(masterRng.beta(a_otr, b_otr), 0.01, 0.99);
        const dlate_mu      = clip(masterRng.lognormal(pop.dlate_lognorm_mu, pop.dlate_lognorm_sigma), 1.0, 60.0);
        const post_slip     = clip(masterRng.beta(a_slip, b_slip), 0.0, 1.0);
        const bid_agg       = clip(masterRng.beta(a_bid, b_bid), 0.0, 0.99);
        const bid_vol       = masterRng.uniform(pop.bid_vol_min, pop.bid_vol_max);
        const rep   = masterRng.random() < pop.p_rep;
        const cent  = masterRng.random() < pop.p_cent;
        const endf  = masterRng.random() < pop.p_endf;
        const ends  = masterRng.random() < pop.p_ends;
        const r_sure = masterRng.random();
        let sure_str;
        if (r_sure < pop.p_sure_none) sure_str = 'none';
        else if (r_sure < pop.p_sure_none + pop.p_sure_weak) sure_str = 'weak';
        else sure_str = 'strong';
        const prior_default = masterRng.random() < pop.p_prior_default;
        const verification_rate = clip(masterRng.beta(a_ver, b_ver), 0.0, 1.0);
        const extra_groups = masterRng.random() < pop.p_multi_group
          ? masterRng.integers(1, Math.max(2, pop.n_extra_groups_max))
          : 0;

        // True PD (logistic from raw inputs) — used only for benchmark tab later
        const sure_val = ({ none: 0, weak: 0.5, strong: 1 })[sure_str];
        const social_z = (Number(rep) + Number(cent) + Number(endf) + Number(ends)) / 4;
        const logit_pd = (
          -3.50
          + 3.00 * (1 - p_ontime_raw)
          + 1.50 * bid_agg
          + 1.20 * post_slip
          + 1.50 * macro.stress_level
          - 0.60 * social_z
          - 0.50 * sure_val
          + masterRng.normal(0, 0.30)
        );
        const true_pd = sigmoid(logit_pd);

        // Per-member meeting simulation
        const rngMember = makeRNG(masterRng.subSeed(seed, mid));
        const idioShocks = new Float64Array(total_meetings);
        for (let i = 0; i < total_meetings; i++) idioShocks[i] = rngMember.standardNormal();

        const ont = new Int8Array(total_meetings);
        const dlate = new Float64Array(total_meetings);
        let allocFlatFirst = aord - 1;  // first-cycle allocation index (0-based)

        // Recency weights for pillars
        const aRec = params.a;
        const ms = total_meetings;
        let weightSum = 0;
        const w = new Float64Array(ms);
        for (let i = 0; i < ms; i++) {
          w[i] = Math.pow(aRec, ms - (i + 1));
          weightSum += w[i];
        }
        if (weightSum === 0) weightSum = 1;

        let sumOnW = 0;
        let sumAlW = 0;
        let sumRcW = 0;
        let curLateStreak = 0;
        let maxLateStreak = 0;
        let san6Roll = 0;
        const san6Window = new Int8Array(6);
        let san6Idx = 0;
        let san6FinalCount = 0;
        let lateAfterAllocStreak = 0;
        let hasDefault = false;

        // For slip detection (2 consecutive late after first-cycle allocation)
        let slipFound = 0;
        let prevPostAllocLate = -1;

        for (let i = 0; i < total_meetings; i++) {
          const cid = Math.floor(i / meetings_per_cycle);
          const allocFlat = cid * meetings_per_cycle + (aord - 1);
          const isPost = i > allocFlat;
          let p_raw = p_ontime_raw * (isPost ? (1 - 0.5 * post_slip) : 1);
          p_raw = clip(p_raw, 1e-6, 1 - 1e-6);
          const logitBase = Math.log(p_raw / (1 - p_raw)) - stressShift;
          const agg = (sqrtCorr * groupShocks[i] + sqrt1mc * idioShocks[i]) * 0.40;
          let p_eff = sigmoid(logitBase + agg);
          // Shock windows (1-based meeting numbers)
          for (const sw of macro.shock_windows) {
            if (i + 1 >= sw[0] && i + 1 <= sw[1]) p_eff *= sw[2];
          }
          p_eff = clip(p_eff, 0.01, 0.99);

          const onTime = rngMember.random() < p_eff ? 1 : 0;
          ont[i] = onTime;
          if (onTime === 0) {
            const raw = rngMember.lognormal(Math.log(Math.max(dlate_mu, 1)), 0.8);
            dlate[i] = Math.max(1, Math.round(raw));
          }

          // Sanctions flag (per meeting) and rolling san6
          const san = rngMember.random() < san_rate / 6 ? 1 : 0;
          san6Roll -= san6Window[san6Idx];
          san6Window[san6Idx] = san;
          san6Roll += san;
          san6Idx = (san6Idx + 1) % 6;
          // Capture final san6 value at the last meeting (matches Python tail-window)
          if (i === total_meetings - 1) san6FinalCount = san6Roll;

          // Pillar accumulators using recency-weighted otr, al, rc
          // Verification: we'll apply later using overall verification share
          sumOnW += w[i] * onTime;
          sumAlW += w[i] * Math.max(0, dlate[i]);
          sumRcW += w[i] * (dlate[i] > 0 && dlate[i] < 7 ? 1 : 0);

          // Max late streak
          if (onTime === 0) {
            curLateStreak += 1;
            if (curLateStreak > maxLateStreak) maxLateStreak = curLateStreak;
          } else curLateStreak = 0;

          // Default detection: streak_threshold consecutive late after first-cycle alloc
          if (i > allocFlatFirst) {
            if (onTime === 0) {
              lateAfterAllocStreak += 1;
              if (lateAfterAllocStreak >= streakThreshold) hasDefault = true;
            } else lateAfterAllocStreak = 0;
          }

          // Slip: any 2 consecutive late meetings post-allocation (any cycle)
          if (isPost) {
            if (onTime === 0 && prevPostAllocLate === 0) slipFound = 1;
            prevPostAllocLate = onTime;
          }
        }

        // Effective otr after verification down-weighting
        // (approximation: assume verification share applies uniformly to on-time payments)
        const otr_raw = sumOnW / weightSum;
        const otr_verified = otr_raw * verification_rate;
        const otr_eff = otr_verified + params.w_unverified * (otr_raw - otr_verified);

        const row = {
          mid, gid,
          n, aord, rtype, rules,
          num_cycles,
          true_pd, p_ontime_raw,
          otr: otr_eff,
          al: sumAlW / weightSum,
          ls: maxLateStreak,
          rc: sumRcW / weightSum,
          tdec: 1,            // matches Python: adate <= T_i always
          slip: slipFound,
          san6: san6FinalCount,
          sure_str,
          rep, cent, end_f: endf, end_s: ends,
          prior_default, star_topology, extra_groups,
          verification_rate, dlate_mu, post_slip, bid_agg, bid_vol,
          defaulted: hasDefault,
        };

        memberBuffers.push(row);
      }

      // Compute group-relative q_rank for bidding members
      // (proxy: rank each member's bid_aggressiveness within group; lower = aggressive = lower q_rank)
      if (rtype === 'bidding') {
        const sorted = memberBuffers.slice().sort((x, y) => x.bid_agg - y.bid_agg);
        const ranks = new Map();
        sorted.forEach((r, i) => ranks.set(r.mid, sorted.length > 1 ? i / (sorted.length - 1) : 0.5));
        for (const row of memberBuffers) {
          row.bid_q_rank = ranks.get(row.mid);
          row.bid_iqr = row.bid_vol;   // approximation: per-member bid volatility ≈ IQR proxy
        }
      } else {
        for (const row of memberBuffers) {
          row.bid_q_rank = 0.5;
          row.bid_iqr = 0;
        }
      }

      // Score every member in this group
      for (const row of memberBuffers) {
        const sc = computeScoreFromRow(row, params);
        Object.assign(row, sc);
        members.push(row);
        scoreSum += row.score;
        pOnSum   += row.p_ontime_raw;
        if (row.rtype === 'bidding') biddingCount += 1;
        if (row.defaulted) summary.n_defaulted += 1;
      }

      if (onProgress && (g % Math.max(1, (pop.n_groups / 20) | 0) === 0)) {
        onProgress((g + 1) / pop.n_groups);
      }
    }

    summary.n_members = members.length;
    summary.mean_score = members.length ? scoreSum / members.length : 0;
    summary.mean_p_ontime_raw = members.length ? pOnSum / members.length : 0;
    summary.bidding_share = members.length ? biddingCount / members.length : 0;
    summary.default_rate = members.length ? summary.n_defaulted / members.length : 0;
    // Median
    const sortedScores = members.map(r => r.score).sort((a, b) => a - b);
    summary.median_score = sortedScores.length
      ? sortedScores[Math.floor(sortedScores.length / 2)]
      : 0;

    if (onProgress) onProgress(1);
    return { members, summary };
  }

  // ─── Validation / PD* fitting helpers ───────────────────────────────────

  // Spearman rank correlation (NaN if n < 3)
  function spearman(xs, ys) {
    const n = xs.length;
    if (n < 3) return NaN;
    const rank = arr => {
      const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      const r = new Array(n);
      let i = 0;
      while (i < n) {
        let j = i;
        while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
        const avg = (i + j) / 2 + 1;  // 1-based average rank for ties
        for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
        i = j + 1;
      }
      return r;
    };
    const rx = rank(xs), ry = rank(ys);
    const mx = rx.reduce((a, b) => a + b, 0) / n;
    const my = ry.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      const a = rx[i] - mx, b = ry[i] - my;
      num += a * b; dx += a * a; dy += b * b;
    }
    return num / (Math.sqrt(dx * dy) || 1);
  }

  // AUC via the Mann–Whitney U formulation: O(n log n)
  function rocAuc(yTrue, yScore) {
    const n = yTrue.length;
    const pos = []; const neg = [];
    for (let i = 0; i < n; i++) (yTrue[i] ? pos : neg).push(yScore[i]);
    if (!pos.length || !neg.length) return NaN;
    // Compute average rank of positives in the combined sorted list
    const combined = yScore.map((s, i) => [s, yTrue[i]]).sort((a, b) => a[0] - b[0]);
    // assign ranks with ties (average rank)
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && combined[j + 1][0] === combined[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[k] = avg;
      i = j + 1;
    }
    let sumRankPos = 0;
    for (let k = 0; k < n; k++) if (combined[k][1]) sumRankPos += ranks[k];
    const nPos = pos.length, nNeg = neg.length;
    return (sumRankPos - nPos * (nPos + 1) / 2) / (nPos * nNeg);
  }

  function brierScore(yTrue, yProb) {
    const n = yTrue.length;
    if (!n) return NaN;
    let s = 0;
    for (let i = 0; i < n; i++) s += (yProb[i] - yTrue[i]) ** 2;
    return s / n;
  }

  // ─── Logistic regression on raw behavioural features ────────────────────
  //
  // Mirrors fit_logistic_pd_star: features are the raw observable variables
  // that *feed into* the score (not the pillars themselves).
  // Implementation: gradient descent on logistic loss with L2 regularization.
  function fitLogisticPDStar(members, opts) {
    opts = opts || {};
    const lr        = opts.lr        ?? 0.05;
    const lambda    = opts.lambda    ?? 1e-3;
    const maxIter   = opts.maxIter   ?? 500;
    const tol       = opts.tol       ?? 1e-6;
    const minEvents = opts.minEvents ?? 10;

    // Features: raw variables only — never pillars
    const featNames = [
      'otr', 'al', 'ls', 'rc', 'slip', 'san6',
      'p_ontime_raw',
      'extra_groups',
      'aord_ratio',           // aord/n
      'prior_default',
      'star_topology',
      'verification_rate',
    ];

    const n = members.length;
    const events = members.reduce((s, m) => s + (m.defaulted ? 1 : 0), 0);
    if (events < minEvents || events === n) {
      return { ok: false, reason: `Only ${events} defaults in ${n} members — need at least ${minEvents} and at most ${n - 1}.` };
    }

    // Build feature matrix
    const X = new Array(n);
    const y = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      const m = members[i];
      X[i] = [
        m.otr ?? 0, m.al ?? 0, m.ls ?? 0, m.rc ?? 0,
        m.slip ? 1 : 0, m.san6 ?? 0,
        m.p_ontime_raw ?? 0,
        m.extra_groups ?? 0,
        (m.aord ?? 0) / Math.max(1, m.n ?? 1),
        m.prior_default ? 1 : 0,
        m.star_topology ? 1 : 0,
        m.verification_rate ?? 0,
      ];
      y[i] = m.defaulted ? 1 : 0;
    }

    // Standardize features
    const F = featNames.length;
    const mean = new Float64Array(F);
    const std  = new Float64Array(F);
    for (let j = 0; j < F; j++) {
      let s = 0; for (let i = 0; i < n; i++) s += X[i][j];
      mean[j] = s / n;
    }
    for (let j = 0; j < F; j++) {
      let s = 0; for (let i = 0; i < n; i++) { const d = X[i][j] - mean[j]; s += d * d; }
      std[j] = Math.sqrt(s / n) || 1;
    }
    const Xs = X.map(row => row.map((v, j) => (v - mean[j]) / std[j]));

    // Initialize weights
    let w = new Float64Array(F);
    let b = Math.log(events / (n - events)); // intercept ≈ logit of base rate

    let prevLoss = Infinity;
    for (let iter = 0; iter < maxIter; iter++) {
      const gw = new Float64Array(F);
      let gb = 0;
      let loss = 0;
      for (let i = 0; i < n; i++) {
        let z = b;
        const xi = Xs[i];
        for (let j = 0; j < F; j++) z += w[j] * xi[j];
        const p = sigmoid(z);
        const err = p - y[i];
        gb += err;
        for (let j = 0; j < F; j++) gw[j] += err * xi[j];
        // logistic loss
        const eps = 1e-12;
        loss += -(y[i] * Math.log(p + eps) + (1 - y[i]) * Math.log(1 - p + eps));
      }
      // L2 regularization (don't penalize intercept)
      for (let j = 0; j < F; j++) { gw[j] = gw[j] / n + lambda * w[j]; }
      gb /= n;
      loss = loss / n + 0.5 * lambda * w.reduce((s, v) => s + v * v, 0);

      // Update
      for (let j = 0; j < F; j++) w[j] -= lr * gw[j];
      b -= lr * gb;

      if (Math.abs(prevLoss - loss) < tol) break;
      prevLoss = loss;
    }

    // Predict pd_star for all members
    const pdStar = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let z = b;
      const xi = Xs[i];
      for (let j = 0; j < F; j++) z += w[j] * xi[j];
      pdStar[i] = sigmoid(z);
    }

    return {
      ok: true,
      featureNames: featNames,
      weights: Array.from(w),
      intercept: b,
      mean: Array.from(mean),
      std: Array.from(std),
      pdStar,
      finalLoss: prevLoss,
    };
  }

  function computeValidation(members, pdStar) {
    const n = members.length;
    if (!n || !pdStar) return null;
    const scores = members.map(m => m.score);
    const defaulted = members.map(m => m.defaulted ? 1 : 0);
    const nDef = defaulted.reduce((s, v) => s + v, 0);

    // Spearman rho: score vs (1 - pd_star)  → positive when score ranks safety
    const oneMinusPd = Array.from(pdStar, p => 1 - p);
    const rho = spearman(scores, oneMinusPd);

    // Score gap (non-def mean − def mean)
    let sumDef = 0, sumNon = 0, nNon = 0;
    for (let i = 0; i < n; i++) {
      if (defaulted[i]) sumDef += scores[i];
      else { sumNon += scores[i]; nNon += 1; }
    }
    const meanDef = nDef ? sumDef / nDef : NaN;
    const meanNon = nNon ? sumNon / nNon : NaN;
    const gap = meanNon - meanDef;

    // AUC of score vs default (higher score should mean LESS likely to default → invert)
    const auc = nDef > 0 && nDef < n
      ? rocAuc(defaulted, scores.map(s => -s))
      : NaN;

    // Brier on a normalized score (0..1 → predicted prob of default)
    const smin = Math.min(...scores), smax = Math.max(...scores);
    const yProb = scores.map(s => 1 - (s - smin) / (smax - smin + 1e-9));
    const brier = nDef > 0 ? brierScore(defaulted, yProb) : NaN;

    // PD* quintile means
    const sorted = members.map((m, i) => [pdStar[i], scores[i]]).sort((a, b) => a[0] - b[0]);
    const q = 5;
    const quintiles = [];
    for (let i = 0; i < q; i++) {
      const lo = Math.floor((i * sorted.length) / q);
      const hi = Math.floor(((i + 1) * sorted.length) / q);
      const slice = sorted.slice(lo, hi);
      const mean = slice.reduce((s, v) => s + v[1], 0) / (slice.length || 1);
      const var_ = slice.reduce((s, v) => s + (v[1] - mean) ** 2, 0) / (slice.length || 1);
      quintiles.push({ q: `Q${i + 1}`, mean, std: Math.sqrt(var_), count: slice.length });
    }

    return {
      n_members: n, n_defaulted: nDef, default_rate: nDef / n,
      spearman_rho: rho,
      score_gap: gap, score_mean_defaulted: meanDef, score_mean_non_defaulted: meanNon,
      auc, brier,
      pd_star_mean: pdStar.reduce((s, v) => s + v, 0) / n,
      quintiles,
    };
  }

  // ─── Monte Carlo PD* re-simulation ──────────────────────────────────────
  //
  // Mirrors compute_pd_star_mc:
  //  - Re-draws each group's per-meeting payment outcomes nRuns times.
  //  - Counts how many runs trigger the post-allocation default streak.
  //  - Profile (p_ontime_raw, aord, post_slip, etc.) is held FIXED to what
  //    simulatePopulation already sampled — only the meeting RNG differs.
  //
  // The members array must come from a prior simulatePopulation() call so we
  // have access to the per-member profile fields (p_ontime_raw, aord, n,
  // num_cycles is reconstructed from group sizes, post_slip).
  //
  // Returns { pdStar: Float64Array, defaultCount: Int32Array }.
  function monteCarloPDStar(members, opts) {
    opts = opts || {};
    const nRuns           = opts.nRuns           ?? 200;
    const seed            = opts.seed            ?? 42;
    const K_min           = opts.K_min           ?? 6;
    const streakThreshold = opts.streak_threshold ?? 3;
    const corr            = opts.within_group_corr ?? 0.2;
    const stress          = opts.stress_level     ?? 0.0;
    const shockWindows    = opts.shock_windows   ?? [];
    const onProgress      = opts.onProgress;

    const sqrtCorr = Math.sqrt(clip(corr, 0, 1));
    const sqrt1mc  = Math.sqrt(Math.max(0, 1 - clip(corr, 0, 1)));
    const stressShift = stress * 1.5;

    const N = members.length;
    const pdStar       = new Float64Array(N);
    const defaultCount = new Int32Array(N);

    // Group members by gid to reuse per-meeting group shocks
    const byGid = new Map();
    for (let i = 0; i < N; i++) {
      const gid = members[i].gid;
      if (!byGid.has(gid)) byGid.set(gid, []);
      byGid.get(gid).push(i);
    }

    const masterRng = makeRNG(seed);
    let groupIdx = 0;
    const totalGroups = byGid.size;

    for (const [gid, idxs] of byGid) {
      // Group meta: take n & num_cycles from any member in this group
      // (all members in a group share the same structural params).
      const sample = members[idxs[0]];
      const n = sample.n;
      // We didn't store num_cycles per member; assume default num_cycles range.
      // The Python sim picks once per group; conservatively use 1 cycle here
      // unless members hint otherwise via meeting count. Since we discarded the
      // raw meeting count, default to 1 — same default Python uses when
      // num_cycles_min=num_cycles_max=1.
      const numCycles = sample.num_cycles || 1;
      const meetingsPerCycle = Math.max(K_min, n);
      const totalMeetings = meetingsPerCycle * numCycles;

      // Group-level shocks: (nRuns, totalMeetings), shared by all members in group
      const rngGroup = makeRNG(masterRng.subSeed(seed, gid));
      const groupShocks = new Float64Array(nRuns * totalMeetings);
      for (let r = 0; r < nRuns; r++) {
        for (let m = 0; m < totalMeetings; m++) {
          groupShocks[r * totalMeetings + m] = rngGroup.standardNormal();
        }
      }

      for (const memberIdx of idxs) {
        const profile = members[memberIdx];
        const rngMem = makeRNG(masterRng.subSeed(seed, profile.mid));
        const aord = profile.aord;
        const postSlip = profile.post_slip ?? 0;

        // Per-meeting baseline p_raw (post-payout slip applied per cycle)
        const pRawM = new Float64Array(totalMeetings);
        for (let i = 0; i < totalMeetings; i++) pRawM[i] = profile.p_ontime_raw;
        for (let cid = 1; cid <= numCycles; cid++) {
          const allocIdx = (cid - 1) * meetingsPerCycle + (aord - 1);
          const cycleEnd = cid * meetingsPerCycle;
          if (allocIdx + 1 < cycleEnd) {
            const factor = 1 - 0.5 * postSlip;
            for (let i = allocIdx + 1; i < cycleEnd; i++) pRawM[i] *= factor;
          }
        }
        const logitBase = new Float64Array(totalMeetings);
        for (let i = 0; i < totalMeetings; i++) {
          const p = clip(pRawM[i], 1e-6, 1 - 1e-6);
          logitBase[i] = Math.log(p / (1 - p)) - stressShift;
        }

        const firstAllocIdx = aord - 1;
        const postStart = firstAllocIdx + 1;
        const k = streakThreshold;
        let runDefaults = 0;

        for (let r = 0; r < nRuns; r++) {
          // Generate payment outcomes for this run
          let consecLate = 0;
          let hasStreak = false;
          for (let i = 0; i < totalMeetings; i++) {
            const idio = rngMem.standardNormal();
            const agg = (sqrtCorr * groupShocks[r * totalMeetings + i] + sqrt1mc * idio) * 0.40;
            let pEff = sigmoid(logitBase[i] + agg);
            for (const sw of shockWindows) {
              if (i + 1 >= sw[0] && i + 1 <= sw[1]) pEff *= sw[2];
            }
            pEff = clip(pEff, 0.01, 0.99);
            const onTime = rngMem.random() < pEff;
            if (i >= postStart && !hasStreak) {
              if (!onTime) {
                consecLate += 1;
                if (consecLate >= k) hasStreak = true;
              } else consecLate = 0;
            }
          }
          if (hasStreak) runDefaults += 1;
        }
        defaultCount[memberIdx] = runDefaults;
        pdStar[memberIdx] = runDefaults / nRuns;
      }

      groupIdx += 1;
      if (onProgress && groupIdx % Math.max(1, (totalGroups / 20) | 0) === 0) {
        onProgress(groupIdx / totalGroups);
      }
    }

    if (onProgress) onProgress(1);
    return { pdStar, defaultCount };
  }

  function membersToCsv(members) {
    if (!members || !members.length) return '';
    const keys = [
      'mid', 'gid', 'rtype', 'n', 'aord', 'true_pd', 'pd_star', 'pd_star_mc',
      'score', 's_pdis', 's_ordr', 's_gov', 's_liq', 's_soc',
      'defaulted', 'otr', 'al', 'ls', 'rc', 'slip', 'san6',
      'p_ontime_raw', 'extra_groups', 'prior_default', 'star_topology',
      'verification_rate', 'sure_str', 'rep', 'cent', 'end_f', 'end_s',
    ];
    const esc = v => {
      if (v === true) return '1'; if (v === false) return '0';
      if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
      const s = String(v ?? '');
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = keys.join(',');
    const rows = members.map(m => keys.map(k => esc(m[k])).join(','));
    return head + '\n' + rows.join('\n');
  }

  root.CIKA = {
    computeScoreSingle,
    computeScoreFromRow,
    simulatePopulation,
    fitLogisticPDStar,
    monteCarloPDStar,
    computeValidation,
    spearman, rocAuc, brierScore,
    membersToCsv,
    DEFAULT_SCORE_PARAMS,
    DEFAULT_POP_PARAMS,
    DEFAULT_MACRO,
  };
})(typeof window !== 'undefined' ? window : globalThis);
