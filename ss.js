'use strict';
// ════════════════════════════════════════════════════════════════════════
//  Savant Spotlight — shared engine for control.html + display.html
//  · live data: MLB StatsAPI (roster, free agents, stat lines) + Baseball Savant
//    (league leaderboards per season, every pitch for one player from Statcast search)
//  · view renderers: percentile card, arsenal, movement, locations, velocity, count mix,
//    spray chart, hot zones, launch fan, bat tracking
//  · relay transport (Jomboy Cloudflare relay + BroadcastChannel)
//  Nothing ships with the app — both pages fetch the same tables, so the wire only
//  carries a player id, a view and its options.
// ════════════════════════════════════════════════════════════════════════
const SS = (() => {
  const API = 'https://statsapi.mlb.com/api/v1';
  const SAV = 'https://baseballsavant.mlb.com';
  const HUB_DEFAULT = 'https://jomboy-relay.jomboymedia.workers.dev';
  // through April the new season has barely any Statcast on it
  const SEASON = (() => { const d = new Date(); return d.getMonth() + 1 < 5 ? d.getFullYear() - 1 : d.getFullYear(); })();
  const FIRST_YEAR = 2015;

  // same frame as 5-Tool: host cams cover the left/right of the video window
  const SAFE_DEFAULT = { l: 400, t: 48, r: 1520, b: 895 };
  const CAMS = { top: 230, bottom: 805, video: { l: 165, t: 41, r: 1750, b: 901 } };

  // ── teams ──
  const TEAMS = {
    108:['LAA','#BA0021','Angels'],109:['ARI','#A71930','D-backs'],110:['BAL','#DF4601','Orioles'],111:['BOS','#BD3039','Red Sox'],
    112:['CHC','#0E3386','Cubs'],113:['CIN','#C6011F','Reds'],114:['CLE','#0C2340','Guardians'],115:['COL','#33006F','Rockies'],
    116:['DET','#0C2340','Tigers'],117:['HOU','#002D62','Astros'],118:['KC','#004687','Royals'],119:['LAD','#005A9C','Dodgers'],
    120:['WSH','#AB0003','Nationals'],121:['NYM','#002D72','Mets'],133:['ATH','#003831','Athletics'],134:['PIT','#27251F','Pirates'],
    135:['SD','#2F241D','Padres'],136:['SEA','#0C2C56','Mariners'],137:['SF','#27251F','Giants'],138:['STL','#C41E3A','Cardinals'],
    139:['TB','#092C5C','Rays'],140:['TEX','#003278','Rangers'],141:['TOR','#134A8E','Blue Jays'],142:['MIN','#002B5C','Twins'],
    143:['PHI','#E81828','Phillies'],144:['ATL','#13274F','Braves'],145:['CWS','#27251F','White Sox'],146:['MIA','#00A3E0','Marlins'],
    147:['NYY','#0C2340','Yankees'],158:['MIL','#12284B','Brewers'],
  };
  const team = id => TEAMS[id] ? { id, abbr: TEAMS[id][0], color: TEAMS[id][1], name: TEAMS[id][2] } : null;
  const logo = id => `https://www.mlbstatic.com/team-logos/team-cap-on-dark/${id}.svg`;
  const headshot = (id, w = 426) => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:silo:current.png/w_${w},q_auto:best/v1/people/${id}/headshot/silo/current`;

  // ── fetch helpers ──
  const getJSON = async (url, ms = 15000) => { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(r.status); return r.json(); };
  async function csv(url, ms = 20000) {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(r.status);
    const text = (await r.text()).replace(/^﻿/, '');
    // quoted fields can hold commas — Savant's first header is literally "last_name, first_name"
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
  }
  const num = v => v === '' || v == null || isNaN(+v) ? null : +v;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const f0 = v => v == null ? '—' : Math.round(v);
  const f1 = v => v == null ? '—' : (+v).toFixed(1);
  const f3 = v => v == null ? '—' : (+v).toFixed(3).replace(/^0/, '').replace(/^-0/, '-');
  // percentile of v within a list (0–100), the way Savant ranks
  function rankPct(arr, v, lowerIsBetter) {
    if (v == null || !arr || arr.length < 10) return null;
    let below = 0, eq = 0;
    for (const x of arr) { if (x < v) below++; else if (x === v) eq++; }
    const p = (below + eq / 2) / arr.length * 100;
    return Math.round(lowerIsBetter ? 100 - p : p);
  }

  // ── Savant percentile colours (blue = poor, grey = average, red = great) ──
  function pctColor(p) {
    const lo = [50, 98, 175], mid = [190, 190, 190], hi = [214, 41, 57];
    const t = clamp(p, 0, 100) / 100;
    const [A, B, f] = t < .5 ? [lo, mid, t / .5] : [mid, hi, (t - .5) / .5];
    return `rgb(${A.map((c, i) => Math.round(c + (B[i] - c) * f)).join(',')})`;
  }
  // Savant's pitch palette
  const PITCH_COLOR = {
    FF: '#d22d49', SI: '#fe9d00', FC: '#933f2c', SL: '#c3bd0e', ST: '#ddb33a', SV: '#93afd4', CU: '#00d1ed', KC: '#6236cd',
    CS: '#0068ff', CH: '#1dbe3a', FS: '#3bacac', FO: '#55ccab', SC: '#60db33', KN: '#3c44cd', EP: '#888888', FA: '#d22d49',
  };
  const pitchColor = t => PITCH_COLOR[t] || '#9f9f9f';
  const PITCH_SHORT = {
    FF: '4-SEAM', SI: 'SINKER', FC: 'CUTTER', SL: 'SLIDER', ST: 'SWEEPER', SV: 'SLURVE', CU: 'CURVE', KC: 'KNUCKLE CURVE',
    CS: 'SLOW CURVE', CH: 'CHANGEUP', FS: 'SPLITTER', FO: 'FORKBALL', SC: 'SCREWBALL', KN: 'KNUCKLEBALL', EP: 'EEPHUS',
  };

  // ── the card: which rows a Savant percentile card shows, and where the real value lives ──
  const FMT = {
    three: f3, one: f1, int: f0, era: v => v == null ? '—' : (+v).toFixed(2),
    pct1: v => v == null ? '—' : (+v).toFixed(1) + '%', mph: v => v == null ? '—' : (+v).toFixed(1),
    ft: v => v == null ? '—' : (+v).toFixed(1) + ' ft', fts: v => v == null ? '—' : (+v).toFixed(1), rpm: v => v == null ? '—' : Math.round(v),
  };
  const BAT_ROWS = [
    { k: 'xwoba', lab: 'xwOBA', val: 'xwoba', f: 'three' },
    { k: 'xba', lab: 'xBA', val: 'xba', f: 'three' },
    { k: 'xslg', lab: 'xSLG', val: 'xslg', f: 'three' },
    { k: 'exit_velocity', lab: 'Avg Exit Velo', val: 'exit_velocity_avg', f: 'mph' },
    { k: 'brl_percent', lab: 'Barrel %', val: 'barrel_batted_rate', f: 'pct1' },
    { k: 'hard_hit_percent', lab: 'Hard-Hit %', val: 'hard_hit_percent', f: 'pct1' },
    { k: 'bat_speed', lab: 'Bat Speed', val: 'avg_swing_speed', f: 'mph' },
    { k: 'squared_up_rate', lab: 'Squared-Up %', val: 'squared_up_contact', f: 'pct1' },
    { k: 'chase_percent', lab: 'Chase %', val: 'oz_swing_percent', f: 'pct1' },
    { k: 'whiff_percent', lab: 'Whiff %', val: 'whiff_percent', f: 'pct1' },
    { k: 'k_percent', lab: 'K %', val: 'k_percent', f: 'pct1' },
    { k: 'bb_percent', lab: 'BB %', val: 'bb_percent', f: 'pct1' },
    { k: 'sprint_speed', lab: 'Sprint Speed', val: 'sprint_speed', f: 'fts' },
    { k: 'oaa', lab: 'Outs Above Avg', val: 'oaa_val', f: 'int' },
    { k: 'arm_strength', lab: 'Arm Strength', val: 'arm_val', f: 'mph' },
    { k: 'swing_length', lab: 'Swing Length', val: 'avg_swing_length', f: 'ft' },
  ];
  const PIT_ROWS = [
    { k: 'xera', lab: 'xERA', val: 'xera', f: 'era' },
    { k: 'xwoba', lab: 'xwOBA', val: 'xwoba', f: 'three' },
    { k: 'xba', lab: 'xBA', val: 'xba', f: 'three' },
    { k: 'xslg', lab: 'xSLG', val: 'xslg', f: 'three' },
    { k: 'fb_velocity', lab: 'Fastball Velo', val: 'fastball_avg_speed', f: 'mph' },
    { k: 'fb_spin', lab: 'Fastball Spin', val: 'fastball_avg_spin', f: 'rpm' },
    { k: 'curve_spin', lab: 'Curve Spin', val: null, f: 'rpm' },
    { k: 'k_percent', lab: 'K %', val: 'k_percent', f: 'pct1' },
    { k: 'bb_percent', lab: 'BB %', val: 'bb_percent', f: 'pct1' },
    { k: 'whiff_percent', lab: 'Whiff %', val: 'whiff_percent', f: 'pct1' },
    { k: 'chase_percent', lab: 'Chase %', val: 'oz_swing_percent', f: 'pct1' },
    { k: 'exit_velocity', lab: 'Avg Exit Velo', val: 'exit_velocity_avg', f: 'mph' },
    { k: 'brl_percent', lab: 'Barrel %', val: 'barrel_batted_rate', f: 'pct1' },
    { k: 'hard_hit_percent', lab: 'Hard-Hit %', val: 'hard_hit_percent', f: 'pct1' },
  ];
  const ROWS = { bat: BAT_ROWS, pit: PIT_ROWS };

  // ════════════════════════════════════════════════════════════════════
  //  LEAGUE TABLES — one set per season, shared by every view
  // ════════════════════════════════════════════════════════════════════
  const BAT_SEL = 'pa,ab,batting_avg,on_base_percent,slg_percent,home_run,xba,xslg,xwoba,exit_velocity_avg,launch_angle_avg,sweet_spot_percent,' +
    'barrel_batted_rate,hard_hit_percent,k_percent,bb_percent,whiff_percent,oz_swing_percent,avg_swing_speed,avg_swing_length,squared_up_contact,' +
    'blasts_contact,fast_swing_rate,attack_angle,pull_percent,straightaway_percent,opposite_percent';
  const PIT_SEL = 'p_formatted_ip,p_era,p_game,pa,xba,xslg,xwoba,xera,k_percent,bb_percent,whiff_percent,oz_swing_percent,barrel_batted_rate,' +
    'exit_velocity_avg,hard_hit_percent,fastball_avg_speed,fastball_avg_spin,arm_angle,groundballs_percent';
  const LG = {};
  function league(y) {
    if (LG[y]) return LG[y];
    const job = (async () => {
      const u = [
        `/leaderboard/percentile-rankings?type=batter&year=${y}&min=q&csv=true`,
        `/leaderboard/percentile-rankings?type=pitcher&year=${y}&min=q&csv=true`,
        `/leaderboard/custom?year=${y}&type=batter&min=1&selections=${BAT_SEL}&csv=true`,
        `/leaderboard/custom?year=${y}&type=pitcher&min=1&selections=${PIT_SEL}&csv=true`,
        `/leaderboard/pitch-arsenal-stats?type=pitcher&pitchType=&year=${y}&team=&min=10&csv=true`,
        `/leaderboard/sprint_speed?year=${y}&position=&team=&min=5&csv=true`,
        `/leaderboard/arm-strength?type=player&year=${y}&minThrows=25&pos=&team=&csv=true`,
        `/leaderboard/outs_above_average?type=Fielder&startYear=${y}&endYear=${y}&split=no&team=&range=year&min=1&pos=&roles=&viz=hide&csv=true`,
        `/leaderboard/bat-tracking/swing-path-attack-angle?type=batter&year=${y}&min=q&csv=true`,
      ];
      const [pb, pp, vb, vp, ars, spd, arm, oaa, sw] = await Promise.all(u.map(x => csv(SAV + x, 25000).catch(() => [])));
      const L = { y, bat: {}, pit: {}, ars: {}, dist: {}, swingAll: {} };
      const seed = (t, id) => L[t][id] || (L[t][id] = { pct: {}, val: {}, swing: null });
      const pctInto = (rows, t) => rows.forEach(r => {
        const id = +r.player_id; if (!id) return;
        const o = seed(t, id);
        for (const k in r) if (!['player_name', 'player_id', 'year'].includes(k)) { const v = num(r[k]); if (v != null) o.pct[k] = v; }
      });
      pctInto(pb, 'bat'); pctInto(pp, 'pit');
      const valInto = (rows, t) => rows.forEach(r => {
        const id = +r.player_id; if (!id) return;
        const o = seed(t, id);
        for (const k in r) if (!['last_name, first_name', 'player_id', 'year'].includes(k)) o.val[k] = num(r[k]) ?? (r[k] || null);
      });
      valInto(vb, 'bat'); valInto(vp, 'pit');
      spd.forEach(r => { const o = L.bat[+r.player_id]; if (o) o.val.sprint_speed = num(r.sprint_speed); });
      arm.forEach(r => { const o = L.bat[+r.player_id]; if (o) o.val.arm_val = num(r.arm_overall); });
      oaa.forEach(r => { const o = L.bat[+r.player_id]; if (o) o.val.oaa_val = num(r.outs_above_average); });
      sw.forEach(r => {
        const o = L.bat[+r.id]; if (!o) return;
        o.swing = { aa: num(r.attack_angle), dir: num(r.attack_direction), tilt: num(r.swing_tilt), ideal: num(r.ideal_attack_angle_rate),
          speed: num(r.avg_bat_speed), side: r.side };
      });
      // league spreads for the numbers Savant doesn't rank for us
      const spread = (t, key) => Object.values(L[t]).map(o => o.val[key]).filter(v => typeof v === 'number');
      L.spread = {
        blasts: spread('bat', 'blasts_contact'), fast: spread('bat', 'fast_swing_rate'), aa: Object.values(L.bat).map(o => o.swing?.aa).filter(v => v != null),
        ideal: Object.values(L.bat).map(o => o.swing?.ideal).filter(v => v != null),
      };
      // pitch-by-pitch arsenal results, plus each pitch type's league spread so a whiff rate can be ranked
      for (const r of ars) {
        const id = +r.player_id; if (!id) continue;
        const a = { pt: r.pitch_type, name: r.pitch_name, n: num(r.pitches), usage: num(r.pitch_usage), whiff: num(r.whiff_percent), putaway: num(r.put_away),
          xwoba: num(r.est_woba), rv100: num(r.run_value_per_100), rv: num(r.run_value), k: num(r.k_percent), hh: num(r.hard_hit_percent) };
        (L.ars[id] = L.ars[id] || []).push(a);
        if ((a.n || 0) >= 150) {
          const d = L.dist[a.pt] = L.dist[a.pt] || { whiff: [], putaway: [], xwoba: [], rv100: [] };
          for (const k of ['whiff', 'putaway', 'xwoba', 'rv100']) if (a[k] != null) d[k].push(a[k]);
        }
      }
      return L;
    })();
    LG[y] = job;
    // don't cache an outage for the rest of the show
    job.then(L => { if (!Object.keys(L.bat).length && !Object.keys(L.pit).length) delete LG[y]; }, () => delete LG[y]);
    return job;
  }
  const leagueRec = (L, role, id) => (L && L[role][id]) || { pct: {}, val: {}, swing: null };
  // Savant's card only ranks qualified players, so a part-timer (Judge at 285 PA) gets two bars.
  // His real numbers are on the custom leaderboard: rank those against the qualified pool, and flag it.
  const MIN_SAMPLE = { bat: 100, pit: 80 };   // PA / batters faced
  function qualPool(L, role, r) {
    const Q = L.qual = L.qual || {}, key = role + r.k;
    if (Q[key]) return Q[key];
    const pairs = Object.values(L[role]).filter(o => o.pct[r.k] != null && typeof o.val[r.val] === 'number').map(o => [o.val[r.val], o.pct[r.k]]);
    pairs.sort((a, b) => a[0] - b[0]);
    const h = pairs.length >> 1, lo = mean(pairs.slice(0, h).map(x => x[1])), hi = mean(pairs.slice(h).map(x => x[1]));
    return Q[key] = { vals: pairs.map(x => x[0]), lowerIsBetter: lo > hi };
  }
  function cardRows(L, role, id) {
    const me = leagueRec(L, role, id), big = (me.val.pa || 0) >= MIN_SAMPLE[role];
    return ROWS[role].map(r => {
      if (me.pct[r.k] != null) return { r, p: Math.round(me.pct[r.k]) };
      if (!big || !r.val || typeof me.val[r.val] !== 'number') return null;
      const q = qualPool(L, role, r), p = rankPct(q.vals, me.val[r.val], q.lowerIsBetter);
      return p == null ? null : { r, p, est: true };
    }).filter(Boolean);
  }
  const cardCount = (L, role, id) => L ? cardRows(L, role, id).length : 0;

  // ════════════════════════════════════════════════════════════════════
  //  PLAYERS — every big leaguer this season, plus the free-agent feed
  // ════════════════════════════════════════════════════════════════════
  const DB = { season: SEASON, players: {}, ready: null };
  const isPitcherPos = pos => ['P', 'SP', 'RP'].includes(pos);
  function addPerson(p) {
    const pos = p.primaryPosition?.abbreviation || '';
    const old = DB.players[p.id] || {};
    const rec = Object.assign(old, {
      id: p.id, name: (p.fullName || old.name || '').replace(/ (Sr|Jr)\.$/, m => m === ' Jr.' ? m : ''), pos: pos || old.pos || '',
      age: p.currentAge ?? old.age, bats: p.batSide?.code || old.bats, throws: p.pitchHand?.code || old.throws, num: p.primaryNumber || old.num,
      teamId: p.currentTeam?.id ?? old.teamId ?? null,
    });
    rec.two = rec.pos === 'TWP';
    rec.role = isPitcherPos(rec.pos) || p.primaryPosition?.type === 'Pitcher' ? 'pit' : 'bat';
    DB.players[p.id] = rec;
    return rec;
  }
  function load(onStatus = () => {}) {
    DB.ready = (async () => {
      onStatus('Loading players…');
      const fields = 'people,id,fullName,currentTeam,primaryPosition,abbreviation,type,batSide,code,pitchHand,currentAge,primaryNumber';
      const [pl, fa] = await Promise.all([
        getJSON(`${API}/sports/1/players?season=${SEASON}&fields=${fields}`).catch(() => ({ people: [] })),
        getJSON(`${API}/people/freeAgents?season=${SEASON}`).catch(() => ({ freeAgents: [] })),
        league(SEASON).catch(() => null),
      ]);
      (pl.people || []).forEach(addPerson);
      for (const f of fa.freeAgents || []) {
        if (/minor/i.test(f.notes || '')) continue;
        let rec = DB.players[f.player.id];
        if (!rec) rec = addPerson({ id: f.player.id, fullName: f.player.fullName, primaryPosition: f.position });
        rec.fa = { from: f.originalTeam?.id || null, to: f.newTeam?.id || null, declared: f.dateDeclared || null };
        if (isPitcherPos(f.position?.abbreviation)) rec.role = 'pit';
      }
      onStatus('');
      return DB;
    })();
    return DB.ready;
  }
  const people = {};
  async function ensure(id) {
    if (DB.players[id]?.age != null || DB.players[id]?.full) return DB.players[id];
    if (!people[id]) people[id] = getJSON(`${API}/people/${id}?hydrate=currentTeam`).then(d => {
      const p = d.people?.[0]; if (!p) return DB.players[id] || null;
      const r = addPerson(p); r.full = true; return r;
    }).catch(() => { delete people[id]; return DB.players[id] || null; });
    return people[id];
  }
  async function search(q) {
    const d = await getJSON(`${API}/people/search?names=${encodeURIComponent(q)}&sportIds=1`).catch(() => ({ people: [] }));
    return (d.people || []).slice(0, 15).map(addPerson);
  }

  // ── stat lines (StatsAPI), season + career ──
  const LINES = {};
  const pickSplit = s => s && s.splits && (s.splits.find(x => !x.team) || s.splits[0]);
  function lines(id, role, y) {
    const k = `${id}|${role}|${y}`;
    if (!LINES[k]) LINES[k] = getJSON(`${API}/people/${id}?hydrate=stats(group=[${role === 'pit' ? 'pitching' : 'hitting'}],type=[season,career,sabermetrics],season=${y})`)
      .then(d => {
        const out = {};
        for (const s of d.people?.[0]?.stats || []) out[s.type.displayName] = pickSplit(s)?.stat || null;
        return out;
      }).catch(() => { delete LINES[k]; return {}; });
    return LINES[k];
  }
  const LINE_COLS = {
    pit: [['W-L', s => s.wins != null ? `${s.wins}-${s.losses}` : null], ['ERA', 'era'], ['G', 'gamesPlayed'], ['GS', 'gamesStarted'], ['IP', 'inningsPitched'],
      ['SO', 'strikeOuts'], ['BB', 'baseOnBalls'], ['WHIP', 'whip'], ['SV', 'saves'], ['FIP', (s, x) => x?.fip != null ? x.fip.toFixed(2) : null, 1], ['WAR', (s, x) => x?.war != null ? x.war.toFixed(1) : null, 1]],
    bat: [['G', 'gamesPlayed'], ['PA', 'plateAppearances'], ['AVG', 'avg'], ['OBP', 'obp'], ['SLG', 'slg'], ['OPS', 'ops'], ['HR', 'homeRuns'], ['RBI', 'rbi'], ['SB', 'stolenBases'],
      ['wRC+', (s, x) => x?.wRcPlus != null ? Math.round(x.wRcPlus) : null, 1], ['WAR', (s, x) => x?.war != null ? x.war.toFixed(1) : null, 1]],
  };
  function linesHTML(L, role, y) {
    const cols = LINE_COLS[role];
    const cell = (s, x, c, saberOnly) => {
      if (!s) return '<td class="dim">—</td>';
      if (saberOnly && !x) return '<td class="dim">—</td>';
      const v = typeof c[1] === 'function' ? c[1](s, x) : s[c[1]];
      return v == null || v === '' ? '<td class="dim">—</td>' : `<td>${esc(v)}</td>`;
    };
    const row = (label, s, x) => `<tr><td class="rl">${label}</td>${cols.map(c => cell(s, x, c, c[2])).join('')}</tr>`;
    if (!L.season && !L.career) return `<div class="none">No ${y} MLB stats</div>`;
    return `<table><tr><th class="rl"></th>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>` +
      row(String(y), L.season, L.sabermetrics) + row('CAREER', L.career, null) + '</table>';
  }

  // ── season by season + career (StatsAPI). WAR only comes one season per call, so career WAR is their sum ──
  const CAREER = {};
  function careerData(id, role) {
    const k = id + '|' + role;
    if (CAREER[k]) return CAREER[k];
    const g = role === 'pit' ? 'pitching' : 'hitting';
    CAREER[k] = (async () => {
      const d = await getJSON(`${API}/people/${id}?hydrate=stats(group=[${g}],type=[yearByYear,career])`);
      const by = {}; let total = null;
      for (const s of d.people?.[0]?.stats || []) {
        if (s.type.displayName === 'career') total = pickSplit(s)?.stat || null;
        if (s.type.displayName !== 'yearByYear') continue;
        for (const sp of s.splits) {
          const y = +sp.season, cur = by[y];
          // a traded season has one row per club plus a combined row with no team — the combined row wins
          const ab = sp.team ? team(sp.team.id)?.abbr || sp.team.abbreviation || '' : null;
          const tms = cur ? cur.tms : [];
          if (ab && !tms.includes(ab)) tms.push(ab);
          if (!sp.team || !cur) by[y] = Object.assign(cur || {}, { y, st: !sp.team || !cur ? sp.stat : cur.st, combined: !sp.team || cur?.combined, tms });
          by[y].tm = tms.length > 2 ? `${tms.length} TEAMS` : tms.join('/') || `${sp.numTeams || 2} TEAMS`;
        }
      }
      const years = Object.values(by).sort((a, b) => a.y - b.y);
      await Promise.all(years.map(r => getJSON(`${API}/people/${id}/stats?stats=sabermetrics&group=${g}&season=${r.y}`)
        .then(x => { const st = pickSplit(x.stats?.[0])?.stat; r.war = st?.war ?? null; r.fip = st?.fip ?? null; r.wrc = st?.wRcPlus ?? null; }).catch(() => {})));
      const wars = years.map(r => r.war).filter(v => v != null);
      return { years, total, war: wars.length ? wars.reduce((a, b) => a + b, 0) : null };
    })().catch(e => { delete CAREER[k]; throw e; });
    return CAREER[k];
  }
  // every stat the Stats graphic, the year table and the tale of the tape can show
  const ipNum = v => { const n = num(v); if (n == null) return null; const w = Math.trunc(n); return w + Math.round((n - w) * 10) / 3; };
  const ipFmt = v => { const w = Math.trunc(v + 1e-9); return `${w}.${Math.round((v - w) * 3)}`; };
  const STAT = {
    wl:   { lab: 'W-L', get: s => s.wins != null ? `${s.wins}-${s.losses}` : null },
    era:  { lab: 'ERA', get: s => num(s.era), fmt: v => v.toFixed(2), dir: -1, rate: 1 },
    g:    { lab: 'G', get: s => s.gamesPlayed },
    gs:   { lab: 'GS', get: s => s.gamesStarted },
    ip:   { lab: 'IP', get: s => ipNum(s.inningsPitched), fmt: ipFmt, dir: 1 },
    so:   { lab: 'SO', get: s => s.strikeOuts, dir: 1 },
    bbp:  { lab: 'BB', get: s => s.baseOnBalls },
    whip: { lab: 'WHIP', get: s => num(s.whip), fmt: v => v.toFixed(2), dir: -1, rate: 1 },
    k9:   { lab: 'K/9', get: s => num(s.strikeoutsPer9Inn), fmt: v => v.toFixed(1), dir: 1, rate: 1 },
    bb9:  { lab: 'BB/9', get: s => num(s.walksPer9Inn), fmt: v => v.toFixed(1), dir: -1, rate: 1 },
    sv:   { lab: 'SV', get: s => s.saves, dir: 1 },
    pa:   { lab: 'PA', get: s => s.plateAppearances },
    avg:  { lab: 'AVG', get: s => num(s.avg), fmt: f3, dir: 1, rate: 1 },
    obp:  { lab: 'OBP', get: s => num(s.obp), fmt: f3, dir: 1, rate: 1 },
    slg:  { lab: 'SLG', get: s => num(s.slg), fmt: f3, dir: 1, rate: 1 },
    ops:  { lab: 'OPS', get: s => num(s.ops), fmt: f3, dir: 1, rate: 1 },
    h:    { lab: 'H', get: s => s.hits, dir: 1 },
    hr:   { lab: 'HR', get: s => s.homeRuns, dir: 1 },
    rbi:  { lab: 'RBI', get: s => s.rbi, dir: 1 },
    sb:   { lab: 'SB', get: s => s.stolenBases, dir: 1 },
    war:  { lab: 'WAR', war: 1, fmt: v => v.toFixed(1), dir: 1 },
  };
  const statVal = (k, st, war) => { if (STAT[k].war) return war ?? null; if (!st) return null; const v = STAT[k].get(st); return v === undefined ? null : v; };
  const statFmt = (k, v) => v == null ? '—' : STAT[k].fmt ? STAT[k].fmt(v) : String(v);
  const closer = CD => (num(CD?.total?.saves) || 0) >= 20;
  const TILE_KEYS = (role, CD) => role === 'pit' ? ['wl', 'era', 'g', closer(CD) ? 'sv' : 'gs', 'ip', 'so', 'whip', 'k9', 'bb9', 'war'] : ['g', 'avg', 'obp', 'slg', 'ops', 'h', 'hr', 'rbi', 'sb', 'war'];
  const YEAR_KEYS = { pit: ['wl', 'era', 'g', 'gs', 'ip', 'so', 'bbp', 'whip', 'war'], bat: ['g', 'pa', 'avg', 'obp', 'slg', 'ops', 'hr', 'rbi', 'sb', 'war'] };
  const YEAR_KEYS_NARROW = { pit: ['era', 'ip', 'so', 'whip', 'war'], bat: ['avg', 'ops', 'hr', 'sb', 'war'] };
  // rate stats only count toward a career best in a real season
  const fullSeason = (role, st) => role === 'pit' ? (ipNum(st?.inningsPitched) || 0) >= 40 : (st?.plateAppearances || 0) >= 200;
  function careerBest(role, CD, k) {
    const S = STAT[k]; if (!S.dir || !CD || CD.years.length < 3) return null;
    let best = null;
    for (const r of CD.years) {
      if (S.rate && !fullSeason(role, r.st)) continue;
      const v = statVal(k, r.st, r.war); if (v == null) continue;
      if (best == null || (S.dir > 0 ? v > best : v < best)) best = v;
    }
    return best;
  }

  // ════════════════════════════════════════════════════════════════════
  //  EVERY PITCH — Statcast search for one player and season (~1–2MB, cached)
  // ════════════════════════════════════════════════════════════════════
  const PITCHES = {};
  function pitches(id, role, y) {
    const k = `${id}|${role}|${y}`;
    if (PITCHES[k]) return PITCHES[k];
    const who = role === 'pit' ? 'pitcher' : 'batter';
    const url = `${SAV}/statcast_search/csv?hfGT=R%7C&hfSea=${y}%7C&player_type=${who}&${who}s_lookup%5B%5D=${id}&type=details&all=true`;
    PITCHES[k] = csv(url, 60000).then(rows => rows.filter(r => r.pitch_type && r.pitch_type !== 'PO').map(r => ({
      pt: r.pitch_type, pn: r.pitch_name, v: num(r.release_speed), hb: num(r.pfx_x), ivb: num(r.pfx_z), px: num(r.plate_x), pz: num(r.plate_z),
      top: num(r.sz_top), bot: num(r.sz_bot), d: r.description, ev: r.events, st: r.stand, th: r.p_throws, b: +r.balls, s: +r.strikes,
      spin: num(r.release_spin_rate), arm: num(r.arm_angle), ext: num(r.release_extension), ls: num(r.launch_speed), la: num(r.launch_angle),
      hx: num(r.hc_x), hy: num(r.hc_y), bb: r.bb_type, xw: num(r.estimated_woba_using_speedangle), wv: num(r.woba_value), wd: num(r.woba_denom),
      z: num(r.zone), lsa: num(r.launch_speed_angle), dist: num(r.hit_distance_sc),
    }))).catch(e => { delete PITCHES[k]; throw e; });
    return PITCHES[k];
  }
  const SWINGS = new Set(['swinging_strike', 'swinging_strike_blocked', 'foul', 'foul_tip', 'hit_into_play', 'foul_bunt', 'missed_bunt', 'bunt_foul_tip']);
  const WHIFFS = new Set(['swinging_strike', 'swinging_strike_blocked', 'missed_bunt']);
  const HITS = new Set(['single', 'double', 'triple', 'home_run']);
  const NON_AB = new Set(['walk', 'intent_walk', 'hit_by_pitch', 'sac_fly', 'sac_bunt', 'sac_fly_double_play', 'catcher_interf', 'truncated_pa']);
  // the opponent-hand filter: batter side for a pitcher, pitcher hand for a hitter
  const sideFilter = (P, role, side) => !side || side === 'all' ? P : P.filter(q => (role === 'pit' ? q.st : q.th) === side);
  const sideText = (role, side) => !side || side === 'all' ? '' : role === 'pit' ? `VS ${side}HB` : `VS ${side}HP`;

  // one row per pitch type, most-used first
  function mix(P, minShare = 0.01) {
    const by = {};
    for (const q of P) (by[q.pt] = by[q.pt] || []).push(q);
    return Object.entries(by).map(([pt, a]) => {
      const sw = a.filter(q => SWINGS.has(q.d)).length, wh = a.filter(q => WHIFFS.has(q.d)).length;
      const vs = a.map(q => q.v).filter(v => v != null);
      return { pt, name: a[0].pn || pt, n: a.length, share: a.length / P.length, list: a,
        v: mean(vs), vmax: vs.length ? Math.max(...vs) : null, spin: mean(a.map(q => q.spin).filter(v => v != null)),
        hb: mean(a.map(q => q.hb).filter(v => v != null)), ivb: mean(a.map(q => q.ivb).filter(v => v != null)),
        whiff: sw ? wh / sw * 100 : null };
    }).filter(m => m.share >= minShare).sort((a, b) => b.n - a.n);
  }

  // ════════════════════════════════════════════════════════════════════
  //  VIEW RENDERERS — each returns markup sized to the body box (W×H px)
  // ════════════════════════════════════════════════════════════════════
  let uid = 0;
  const empty = (msg, small) => `<div class="empty">${esc(msg)}${small ? `<small>${esc(small)}</small>` : ''}</div>`;
  const svgOpen = (W, H, x = 0) => `<svg class="chart" style="left:${x}px" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  const txt = (x, y, s, cls, anchor = 'middle', extra = '') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}" text-anchor="${anchor}" ${extra}>${s}</text>`;
  const delay = (i, step, cap = 1400) => `style="animation-delay:${Math.min(cap, i * step)}ms"`;

  // ── percentile card ──
  function vCard(c) {
    const rows = cardRows(c.L, c.role, c.p.id);
    if (!rows.length) return empty(`No ${c.y} percentile card`, 'Savant only ranks qualified players — try another season.');
    const limit = c.limit || rows.length;
    const show = rows.slice(0, limit);
    const cols = c.W > 860 && show.length > 8 ? 2 : 1;
    const per = Math.ceil(show.length / cols);
    const hasEst = show.some(x => x.est);
    const rh = (c.H - 32 - (hasEst ? 18 : 0)) / Math.max(per, 6);
    const fs = clamp(rh * .44, 17, 26), bd = clamp(rh * .74, 30, 46);
    const lw = cols === 2 ? 190 : clamp(c.W * .34, 150, 210);
    return `<div class="pc" style="${hasEst ? 'bottom:34px;' : ''}grid-template-rows:repeat(${per}, ${rh.toFixed(1)}px);grid-template-columns:repeat(${cols},1fr);--fs:${fs.toFixed(1)}px;--bd:${bd.toFixed(0)}px;--lw:${lw}px;--vw:${cols === 2 ? 88 : 80}px">` +
      show.map(({ r, p, est }, i) => {
        const w = clamp(p, 1, 100), col = pctColor(p);
        const v = r.val ? FMT[r.f](c.me.val[r.val] ?? null) : '';
        return `<div class="pr${est ? ' est' : ''}" style="--i:${i}"><div class="pl">${esc(r.lab)}${est ? '<sup>*</sup>' : ''}</div><div class="pt"><i class="pf" style="width:${w}%;background:${col}"></i>` +
          `<b class="pb" style="left:${w}%;background:${col}">${p}</b></div><div class="pv">${esc(v === '—' ? '' : v)}</div></div>`;
      }).join('') + '</div>' +
      (hasEst ? `<div class="estnote">* below Savant's qualifier — his number ranked against qualified ${c.role === 'pit' ? 'pitchers' : 'hitters'}</div>` : '');
  }

  // ── pitch arsenal table ──
  function vArsenal(c) {
    const M = mix(c.P, 0.015);
    if (!M.length) return empty(`No ${c.y} pitches on record`);
    const ars = {}; for (const a of c.L.ars[c.p.id] || []) ars[a.pt] = a;
    const hand = c.P[0]?.th === 'L' ? 1 : -1;      // pfx_x is catcher's view; this turns it into arm side +
    const rh = clamp((c.H - 60) / M.length, 54, 92);
    const pill = (v, pt, key, fmt, lowerBetter) => {
      if (v == null) return '<div>—</div>';
      const p = rankPct(c.L.dist[pt]?.[key], v, lowerBetter);
      return `<div><span class="pill" style="background:${p == null ? '#8996a3' : pctColor(p)}">${fmt(v)}</span></div>`;
    };
    // half width (compare) keeps the five columns that matter most
    const narrow = c.W < 800;
    const head = narrow ? ['PITCH', 'USAGE', 'MPH', 'WHIFF %', 'RV /100'] : ['PITCH', 'USAGE', 'MPH', 'SPIN', 'IVB', 'ARM-SIDE HB', 'WHIFF %', 'PUT AWAY %', 'xwOBA', 'RUN VALUE /100'];
    let h = `<div class="ars" style="grid-auto-rows:${rh.toFixed(1)}px;grid-template-rows:38px${narrow ? ';grid-template-columns:200px 1fr repeat(3, 78px);inset:14px 12px' : ''}">` +
      head.map((t, i) => `<div class="h${i < 2 ? ' l' : ''}">${t}</div>`).join('');
    const umax = Math.max(...M.map(m => m.share));
    M.forEach((m, i) => {
      const a = ars[m.pt] || {}, col = pitchColor(m.pt);
      const hbArm = m.hb == null ? null : m.hb * 12 * hand;
      h += `<div class="pn"><i style="background:${col}"></i><div>${esc(PITCH_SHORT[m.pt] || m.name)}<small>${m.n.toLocaleString()} PITCHES</small></div></div>` +
        `<div class="use" style="--i:${i}"><em style="width:${(m.share / umax * 100 * .72).toFixed(1)}%;background:${col}"></em><b>${(m.share * 100).toFixed(1)}%</b></div>` +
        `<div>${f1(m.v)}</div>` + (narrow ? '' : `<div>${m.spin == null ? '—' : Math.round(m.spin).toLocaleString()}</div>` +
        `<div>${m.ivb == null ? '—' : (m.ivb * 12).toFixed(1) + '"'}</div><div>${hbArm == null ? '—' : hbArm.toFixed(1) + '"'}</div>`) +
        pill(a.whiff, m.pt, 'whiff', f1) + (narrow ? '' : pill(a.putaway, m.pt, 'putaway', f1) + pill(a.xwoba, m.pt, 'xwoba', f3, true)) +
        pill(a.rv100, m.pt, 'rv100', v => (v > 0 ? '+' : '') + v.toFixed(1));
    });
    return h + '</div>';
  }

  // ── movement chart (pitcher's view: arm side is the side his arm is on) ──
  function vMovement(c) {
    const P = sideFilter(c.P, 'pit', c.o.side).filter(q => q.hb != null && q.ivb != null);
    if (!P.length) return empty('No movement data');
    const M = mix(P, 0.015);
    const lefty = P[0].th === 'L';
    const wide = c.W - c.H > 260;
    const S = Math.min(c.H - (wide ? 30 : 64), c.W - (wide ? 340 : 30));
    const x0 = wide ? 22 : (c.W - S) / 2, y0 = 16;
    let R = 24;
    for (const m of M) R = Math.max(R, Math.abs(m.hb * 12) + 5, Math.abs(m.ivb * 12) + 5);
    R = Math.min(30, Math.ceil(R / 6) * 6);
    const cx = x0 + S / 2, cy = y0 + S / 2, k = S / 2 / R;
    const X = hb => cx - hb * 12 * k, Y = ivb => cy - ivb * 12 * k;   // pitcher's view = mirror of catcher's
    let s = svgOpen(c.W, c.H);
    s += `<clipPath id="mv${++uid}"><rect x="${x0}" y="${y0}" width="${S}" height="${S}"/></clipPath>`;
    for (let r = 6; r <= R; r += 6) s += `<circle class="grid-d" cx="${cx}" cy="${cy}" r="${r * k}"/>` + txt(cx + r * k * (lefty ? 1 : -1), cy + 20, `${r}"`, 't-ax');
    s += `<line class="axis-l" x1="${x0}" y1="${cy}" x2="${x0 + S}" y2="${cy}"/><line class="axis-l" x1="${cx}" y1="${y0}" x2="${cx}" y2="${y0 + S}"/>`;
    // arm angle, drawn from the centre toward his arm side
    const arm = mean(P.map(q => q.arm).filter(v => v != null));
    if (arm != null) {
      const dir = lefty ? -1 : 1, a = arm * Math.PI / 180, L = S / 2 * .96;
      const ex = cx + Math.cos(a) * L * dir, ey = cy - Math.sin(a) * L;
      s += `<line x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}" stroke="var(--ink)" stroke-width="3" stroke-dasharray="10 7" class="fadein"/>`;
      // label sits in the top corner on the glove side, where the line never goes
      s += txt(lefty ? x0 + S - 8 : x0 + 8, y0 + 20, `ARM ANGLE ${arm.toFixed(0)}°`, 't-axb', lefty ? 'end' : 'start', 'style="fill:var(--ink)"');
    }
    s += `<g clip-path="url(#mv${uid})" class="fadein">`;
    for (const q of P) s += `<circle cx="${X(q.hb).toFixed(1)}" cy="${Y(q.ivb).toFixed(1)}" r="3.6" fill="${pitchColor(q.pt)}" fill-opacity=".3"/>`;
    s += '</g>';
    M.forEach((m, i) => {
      const r = clamp(12 + m.share * 40, 15, 26);
      s += `<g class="pop" ${delay(i, 120)}><circle cx="${X(m.hb)}" cy="${Y(m.ivb)}" r="${r}" fill="${pitchColor(m.pt)}" stroke="var(--ink)" stroke-width="3"/>` +
        txt(X(m.hb), Y(m.ivb) + 5, m.pt, 't-code') + '</g>';
    });
    s += txt(x0 + 8, y0 + S - 10, lefty ? 'ARM SIDE ←' : '← GLOVE SIDE', 't-axb', 'start');
    s += txt(x0 + S - 8, y0 + S - 10, lefty ? '→ GLOVE SIDE' : 'ARM SIDE →', 't-axb', 'end');
    s += txt(cx + 8, y0 + 18, 'MORE RISE', 't-axb', 'start') + txt(cx + 8, y0 + S - 34, 'MORE DROP', 't-axb', 'start');
    s += '</svg>';
    if (wide) {
      s += `<div class="side" style="left:${x0 + S + 24}px">` + M.slice(0, 7).map(m => {
        const hbArm = m.hb * 12 * (lefty ? 1 : -1);
        return `<div class="leg"><i style="background:${pitchColor(m.pt)}"></i><b>${esc(PITCH_SHORT[m.pt] || m.name)}</b><span>${(m.share * 100).toFixed(0)}%</span>` +
          `<small>${f1(m.v)} MPH · ${(m.ivb * 12).toFixed(1)}" IVB · ${Math.abs(hbArm).toFixed(1)}" ${hbArm >= 0 ? 'ARM' : 'GLOVE'}</small></div>`;
      }).join('') + '</div>';
    } else s += chipsHTML(M);
    return s;
  }
  const chipsHTML = M => `<div class="chips">${M.slice(0, 6).map(m => `<span><i style="background:${pitchColor(m.pt)}"></i>${m.pt} ${(m.share * 100).toFixed(0)}%</span>`).join('')}</div>`;

  // ── heat map tile (catcher's view), used by Locations ──
  const HEAT = [[0, [63, 116, 181, 0]], [.12, [63, 116, 181, .35]], [.4, [240, 222, 170, .85]], [.7, [240, 138, 75, .92]], [1, [200, 16, 46, 1]]];
  function heatColor(t) {
    let a = HEAT[0], b = HEAT[1];
    for (let i = 0; i < HEAT.length - 1; i++) if (t >= HEAT[i][0]) { a = HEAT[i]; b = HEAT[i + 1]; }
    const u = clamp((t - a[0]) / ((b[0] - a[0]) || 1), 0, 1);
    const c = a[1].map((x, i) => x + (b[1][i] - x) * u);
    return [`rgb(${c.slice(0, 3).map(Math.round).join(',')})`, c[3].toFixed(2)];
  }
  function zoneTile(P, x, y, w, h, opts = {}) {
    // plot window: 2 ft either side of the middle of the plate, ground to 5 ft
    const XR = 2, ZT = 4.6, ZB = 0.4;
    const fx = v => x + (v + XR) / (2 * XR) * w, fz = v => y + (ZT - v) / (ZT - ZB) * h;
    const pts = P.filter(q => q.px != null && q.pz != null);
    const id = ++uid;
    let s = `<clipPath id="zt${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff" stroke="var(--rule)" stroke-width="2"/>`;
    if (pts.length > 40 && !opts.dots) {
      const G = 26, GZ = Math.round(G * (ZT - ZB) / (2 * XR)), grid = new Float32Array(G * GZ), sig = 1.5;
      for (const q of pts) {
        const gx = (q.px + XR) / (2 * XR) * G, gz = (ZT - q.pz) / (ZT - ZB) * GZ, r = Math.ceil(sig * 2.5);
        for (let i = Math.max(0, Math.floor(gx - r)); i < Math.min(G, gx + r); i++)
          for (let j = Math.max(0, Math.floor(gz - r)); j < Math.min(GZ, gz + r); j++)
            grid[j * G + i] += Math.exp(-((i + .5 - gx) ** 2 + (j + .5 - gz) ** 2) / (2 * sig * sig));
      }
      let mx = 0; for (const v of grid) mx = Math.max(mx, v);
      const cw = w / G, ch = h / GZ;
      s += `<filter id="hb${id}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${(cw * .55).toFixed(1)}"/></filter><g clip-path="url(#zt${id})"><g filter="url(#hb${id})" class="fadein">`;
      for (let j = 0; j < GZ; j++) for (let i = 0; i < G; i++) {
        const t = mx ? grid[j * G + i] / mx : 0; if (t < .06) continue;
        const [col, a] = heatColor(t);
        s += `<rect x="${(x + i * cw).toFixed(1)}" y="${(y + j * ch).toFixed(1)}" width="${(cw + .6).toFixed(1)}" height="${(ch + .6).toFixed(1)}" fill="${col}" fill-opacity="${a}"/>`;
      }
      s += '</g></g>';
    } else {
      s += `<g clip-path="url(#zt${id})">` + pts.map((q, i) => `<circle class="pop" ${delay(i, 12)} cx="${fx(q.px).toFixed(1)}" cy="${fz(q.pz).toFixed(1)}" r="${clamp(w / 30, 5, 9).toFixed(1)}" fill="${pitchColor(q.pt)}" stroke="var(--ink)" stroke-width="1.5" fill-opacity=".9"/>`).join('') + '</g>';
    }
    const top = mean(pts.map(q => q.top).filter(Boolean)) || 3.4, bot = mean(pts.map(q => q.bot).filter(Boolean)) || 1.6, HP = 0.708;
    s += `<rect x="${fx(-HP)}" y="${fz(top)}" width="${fx(HP) - fx(-HP)}" height="${fz(bot) - fz(top)}" fill="none" stroke="var(--ink)" stroke-width="3"/>`;
    for (let i = 1; i < 3; i++) {
      const gx = fx(-HP + i * 2 * HP / 3), gz = fz(top - i * (top - bot) / 3);
      s += `<line x1="${gx}" y1="${fz(top)}" x2="${gx}" y2="${fz(bot)}" stroke="rgba(19,41,75,.35)" stroke-width="1.5"/><line x1="${fx(-HP)}" y1="${gz}" x2="${fx(HP)}" y2="${gz}" stroke="rgba(19,41,75,.35)" stroke-width="1.5"/>`;
    }
    const py = fz(0.62);
    s += `<path d="M${fx(-HP)},${py} L${fx(HP)},${py} L${fx(HP)},${py + 7} L${fx(0)},${py + 16} L${fx(-HP)},${py + 7} Z" fill="#fff" stroke="var(--ink)" stroke-width="2"/>`;
    return s;
  }
  const LOC_FILTER = {
    all: { lab: 'ALL PITCHES', f: () => true },
    whiff: { lab: 'SWINGS & MISSES', f: q => WHIFFS.has(q.d) },
    k: { lab: 'STRIKEOUT PITCHES', f: q => /strikeout/.test(q.ev || '') },
    hard: { lab: 'HARD-HIT (95+ MPH)', f: q => (q.ls || 0) >= 95 },
  };
  function vLocations(c) {
    const lf = LOC_FILTER[c.o.loc] || LOC_FILTER.all;
    const base = sideFilter(c.P, 'pit', c.o.side);
    const M = mix(base, 0.03).slice(0, c.W > 900 ? 5 : 4);
    if (!M.length) return empty('No pitch locations');
    const n = M.length, pad = 22, gap = 18;
    let tw = (c.W - pad * 2 - gap * (n - 1)) / n, th = tw * 1.05;
    if (th > c.H - 110) { th = c.H - 110; tw = th / 1.05; }
    const x0 = (c.W - (tw * n + gap * (n - 1))) / 2, y0 = Math.max(64, (c.H - th) / 2 + 6);
    let s = svgOpen(c.W, c.H);
    M.forEach((m, i) => {
      const x = x0 + i * (tw + gap), pts = m.list.filter(lf.f);
      s += `<rect x="${x}" y="${y0 - 46}" width="${tw}" height="8" fill="${pitchColor(m.pt)}"/>` +
        txt(x, y0 - 14, esc(PITCH_SHORT[m.pt] || m.name), 't-head', 'start') + txt(x + tw, y0 - 14, `${(m.share * 100).toFixed(0)}%`, 't-num', 'end');
      s += zoneTile(pts, x, y0, tw, th);
      s += txt(x + tw / 2, y0 + th + 24, `${pts.length.toLocaleString()} ${c.o.loc && c.o.loc !== 'all' ? 'OF ' + m.n.toLocaleString() : 'PITCHES'}`, 't-axb');
    });
    s += txt(c.W - pad, c.H - 12, lf.lab, 't-axb', 'end') + txt(pad, c.H - 12, "CATCHER'S VIEW", 't-axb', 'start');
    return s + '</svg>';
  }

  // ── velocity ridgelines ──
  function vVelo(c) {
    const base = sideFilter(c.P, 'pit', c.o.side).filter(q => q.v != null);
    const M = mix(base, 0.02).filter(m => m.v != null).sort((a, b) => b.v - a.v);
    if (!M.length) return empty('No velocity data');
    const all = base.map(q => q.v).sort((a, b) => a - b);
    const lo = Math.floor(all[Math.floor(all.length * .005)] - 1.5), hi = Math.ceil(all[Math.ceil(all.length * .995) - 1] + 1.5);
    const L = 230, Rm = 210, x0 = L, x1 = c.W - Rm, top = 26, bot = c.H - 52;
    const rh = (bot - top) / M.length, X = v => x0 + (v - lo) / (hi - lo) * (x1 - x0);
    let s = svgOpen(c.W, c.H);
    for (let v = Math.ceil(lo / 2) * 2; v <= hi; v += 2) {
      s += `<line class="grid-l" x1="${X(v)}" y1="${top}" x2="${X(v)}" y2="${bot}"/>` + txt(X(v), bot + 26, v, 't-ax');
    }
    s += txt((x0 + x1) / 2, c.H - 4, 'RELEASE SPEED (MPH)', 't-axb');
    M.forEach((m, i) => {
      const vs = m.list.map(q => q.v).filter(v => v != null), bw = .55, N = 120, pts = [];
      let mx = 0;
      for (let j = 0; j <= N; j++) {
        const v = lo + (hi - lo) * j / N;
        let d = 0; for (const x of vs) d += Math.exp(-((v - x) ** 2) / (2 * bw * bw));
        pts.push([v, d]); mx = Math.max(mx, d);
      }
      const base_y = top + rh * (i + 1) - 6, amp = rh * 1.25;
      const path = `M${X(lo)},${base_y} ` + pts.map(([v, d]) => `L${X(v).toFixed(1)},${(base_y - d / mx * amp).toFixed(1)}`).join(' ') + ` L${X(hi)},${base_y} Z`;
      s += `<g class="wipe" ${delay(i, 140)}><path d="${path}" fill="${pitchColor(m.pt)}" fill-opacity=".8" stroke="var(--ink)" stroke-width="2.5"/></g>`;
      s += `<line x1="${X(m.v)}" y1="${base_y}" x2="${X(m.v)}" y2="${base_y - amp * .95}" stroke="var(--ink)" stroke-width="2" stroke-dasharray="4 4"/>`;
      s += `<rect x="16" y="${base_y - 30}" width="10" height="28" fill="${pitchColor(m.pt)}"/>` + txt(34, base_y - 8, esc(PITCH_SHORT[m.pt] || m.name), 't-head', 'start');
      s += txt(x1 + 18, base_y - 8, `${m.v.toFixed(1)}`, 't-big', 'start', 'style="font-size:36px"') + txt(x1 + 102, base_y - 9, `TOP ${m.vmax.toFixed(1)}`, 't-axb', 'start');
    });
    return s + '</svg>';
  }

  // ── pitch mix by count ──
  function vCounts(c) {
    const P = c.P;
    if (!P.length) return empty('No pitches on record');
    const order = mix(P, 0.015).map(m => m.pt);
    const groups = [
      ['ALL PITCHES', () => true], ['VS LEFTIES', q => q.st === 'L'], ['VS RIGHTIES', q => q.st === 'R'],
      ['FIRST PITCH', q => q.b === 0 && q.s === 0], ['AHEAD', q => q.s > q.b], ['EVEN', q => q.b === q.s && q.b + q.s > 0],
      ['BEHIND', q => q.b > q.s], ['TWO STRIKES', q => q.s === 2],
    ];
    // half width (compare) gets a tighter label column, and the legend wraps instead of running into the other half
    const narrow = c.W < 800, L = narrow ? 150 : 200, x0 = L, x1 = c.W - (narrow ? 64 : 90), gap = narrow ? 8 : 10, lfs = narrow ? 19 : 22;
    let leg = '', lx = narrow ? 18 : x0, ly = 28;
    order.forEach(pt => {
      const name = PITCH_SHORT[pt] || pt, w = 34 + name.length * 9.5;
      if (lx + w > c.W - 14 && lx > (narrow ? 18 : x0)) { lx = narrow ? 18 : x0; ly += 28; }
      leg += `<circle cx="${lx + 8}" cy="${ly}" r="9" fill="${pitchColor(pt)}" stroke="var(--ink)" stroke-width="2"/>` + txt(lx + 24, ly + 7, name, 't-axb', 'start');
      lx += w;
    });
    const top = ly + 34;
    const rh = (c.H - top - 16 - gap * (groups.length - 1)) / groups.length;
    let s = svgOpen(c.W, c.H) + leg;
    groups.forEach(([lab, f], i) => {
      const g = P.filter(f), y = top + i * (rh + gap);
      s += txt(L - 14, y + rh / 2 + 7, lab, 't-head', 'end', `style="font-size:${lfs}px"`);
      if (!g.length) return;
      let x = x0;
      s += `<g class="growx" ${delay(i, 90)}>`;
      for (const pt of order) {
        const share = g.filter(q => q.pt === pt).length / g.length, w = share * (x1 - x0);
        if (w <= 0) continue;
        s += `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${rh}" fill="${pitchColor(pt)}" stroke="var(--card)" stroke-width="2"/>`;
        if (w > (narrow ? 46 : 58)) s += txt(x + w / 2, y + rh / 2 + 9, `${Math.round(share * 100)}%`, 't-num', 'middle', `style="font-size:${clamp(rh * .5, 18, 28)}px;fill:#fff;paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:3px"`);
        x += w;
      }
      s += '</g>' + txt(x1 + 10, y + rh / 2 + 7, g.length.toLocaleString(), 't-axb', 'start');
    });
    return s + '</svg>';
  }

  // ── spray chart ──
  const sprayXY = q => ({ x: (q.hx - 125.42) * 2.5, y: (198.27 - q.hy) * 2.5 });
  const HIT_COLOR = { home_run: '#c8102e', triple: '#e0a100', double: '#e8772e', single: '#1d7f45', out: '#7d8a99' };
  const hitClass = ev => ev === 'home_run' || ev === 'triple' || ev === 'double' || ev === 'single' ? ev : 'out';
  function mark(cls, X, Y, r, i) {
    const col = HIT_COLOR[cls], d = delay(i, 3, 1200);
    if (cls === 'home_run') return `<circle class="pop" ${d} cx="${X}" cy="${Y}" r="${r * 1.35}" fill="${col}" stroke="#fff" stroke-width="2.5"/>`;
    if (cls === 'triple') return `<path class="pop" ${d} d="M${X},${Y - r * 1.3} L${X + r * 1.15},${Y + r * .7} L${X - r * 1.15},${Y + r * .7} Z" fill="${col}" stroke="var(--ink)" stroke-width="1.2"/>`;
    if (cls === 'double') return `<path class="pop" ${d} d="M${X},${Y - r * 1.2} L${X + r * 1.2},${Y} L${X},${Y + r * 1.2} L${X - r * 1.2},${Y} Z" fill="${col}" stroke="var(--ink)" stroke-width="1.2"/>`;
    if (cls === 'single') return `<circle class="pop" ${d} cx="${X}" cy="${Y}" r="${r}" fill="${col}" stroke="var(--ink)" stroke-width="1.2"/>`;
    return `<circle class="pop" ${d} cx="${X}" cy="${Y}" r="${r * .78}" fill="none" stroke="${col}" stroke-width="2" opacity=".75"/>`;
  }
  const SPRAY_FILTER = {
    all: { lab: 'ALL BATTED BALLS', f: () => true }, hits: { lab: 'HITS', f: q => HITS.has(q.ev) },
    xbh: { lab: 'EXTRA-BASE HITS', f: q => ['double', 'triple', 'home_run'].includes(q.ev) }, hr: { lab: 'HOME RUNS', f: q => q.ev === 'home_run' },
  };
  function sprayDir(q) {
    const { x, y } = sprayXY(q), a = Math.atan2(x, y) * 180 / Math.PI;
    if (Math.abs(a) <= 15) return 'c';
    return (q.st === 'R' ? a < 0 : a > 0) ? 'pull' : 'oppo';
  }
  function vSpray(c) {
    const sf = SPRAY_FILTER[c.o.spray] || SPRAY_FILTER.all;
    const bip = sideFilter(c.P, 'bat', c.o.side).filter(q => q.hx != null && q.hy != null && q.bb);
    const pts = bip.filter(sf.f);
    if (!bip.length) return empty(`No ${c.y} batted balls`);
    const wide = c.W - c.H > 300;
    // narrow (overview) puts the numbers in a strip on top and the legend below
    const pw = wide ? c.W - 300 : c.W, top = wide ? 10 : 40, ph = c.H - (wide ? 0 : 76);
    // feet window: ±330 across, 40 behind the plate to 470 out
    const s0 = Math.min((pw - 30) / 660, (ph - 20) / 510), ox = (wide ? 16 : 0) + pw / 2, oy = top + 470 * s0 + (ph - 20 - 510 * s0) / 2;
    const r1 = v => Math.round(v * 10) / 10;
    const P = (x, y) => [r1(ox + x * s0), r1(oy - y * s0)];
    let s = svgOpen(c.W, c.H);
    const fence = []; for (let a = -45; a <= 45; a += 1.5) { const r = 330 + 70 * Math.cos(a * Math.PI / 90), rad = a * Math.PI / 180; fence.push(P(Math.sin(rad) * r, Math.cos(rad) * r)); }
    s += `<path d="M${P(0, 0)} ${fence.map(p => 'L' + p).join(' ')} Z" fill="#dfe6c8" stroke="rgba(19,41,75,.35)" stroke-width="2.5"/>`;
    s += `<path d="M${P(0, 0)} L${P(67, 67)} L${P(0, 134)} L${P(-67, 67)} Z" fill="#ead5ae" stroke="rgba(19,41,75,.3)" stroke-width="2"/>`;
    s += `<line x1="${P(0, 0)[0]}" y1="${P(0, 0)[1]}" x2="${P(-235, 235)[0]}" y2="${P(-235, 235)[1]}" stroke="#fff" stroke-width="2.5"/><line x1="${P(0, 0)[0]}" y1="${P(0, 0)[1]}" x2="${P(235, 235)[0]}" y2="${P(235, 235)[1]}" stroke="#fff" stroke-width="2.5"/>`;
    [[63.6, 63.6], [0, 127.3], [-63.6, 63.6], [0, 0]].forEach(b => { const [bx, by] = P(...b); s += `<rect x="${bx - 5}" y="${by - 5}" width="10" height="10" fill="#fff" stroke="var(--ink)" stroke-width="1.5" transform="rotate(45 ${bx} ${by})"/>`; });
    const order = ['out', 'single', 'double', 'triple', 'home_run'];
    const r = clamp(s0 * 11, 4.5, 8);
    pts.slice().sort((a, b) => order.indexOf(hitClass(a.ev)) - order.indexOf(hitClass(b.ev))).forEach((q, i) => {
      const { x, y } = sprayXY(q), [X, Y] = P(x, y); s += mark(hitClass(q.ev), X, Y, r, i);
    });
    const leg = [['home_run', 'HR'], ['triple', '3B'], ['double', '2B'], ['single', '1B'], ['out', 'OUT']];
    let lx = (wide ? 22 : 12);
    leg.forEach(([cls, lab]) => { s += mark(cls, lx + 8, c.H - (wide ? 20 : 22), 6, 0).replace('class="pop"', '') + txt(lx + 22, c.H - (wide ? 14 : 16), lab, 't-axb', 'start'); lx += 70; });
    s += '</svg>';
    // the numbers
    const dir = { pull: 0, c: 0, oppo: 0 }; bip.forEach(q => dir[sprayDir(q)]++);
    const hr = bip.filter(q => q.ev === 'home_run'), evs = bip.map(q => q.ls).filter(v => v != null);
    const maxEV = evs.length ? Math.max(...evs) : null, longest = hr.length ? Math.max(...hr.map(q => q.dist || 0)) : null;
    const pc = k => bip.length ? Math.round(dir[k] / bip.length * 100) : 0;
    if (wide) {
      s += `<div class="side" style="width:290px">` +
        `<div class="kpi"><span>${esc(sf.lab)}</span><b>${pts.length}</b></div>` +
        `<div class="kpi"><span>Home runs</span><b>${hr.length}</b></div>` +
        `<div class="kpi"><span>Pull / Center / Oppo</span><b style="font-size:30px">${pc('pull')}<small>/</small>${pc('c')}<small>/</small>${pc('oppo')}<small>%</small></b></div>` +
        `<div class="kpi"><span>Max exit velo</span><b>${f1(maxEV)}<small>MPH</small></b></div>` +
        `<div class="kpi"><span>Longest HR</span><b>${longest ? Math.round(longest) : '—'}<small>FT</small></b></div>` +
        `<div class="kpi"><span>Avg exit velo</span><b>${f1(mean(evs))}<small>MPH</small></b></div></div>`;
    } else {
      s += `<div class="chips" style="bottom:auto;top:10px"><span>${hr.length} HR</span><span>PULL ${pc('pull')}%</span><span>CENTER ${pc('c')}%</span><span>OPPO ${pc('oppo')}%</span><span>MAX EV ${f1(maxEV)}</span></div>`;
    }
    return s;
  }

  // ── hot zones (catcher's view, Statcast zones 1–9 + the four chase quadrants) ──
  const ZONE_METRIC = {
    xwoba: { lab: 'xwOBA', fmt: f3, lo: .220, mid: .320, hi: .440, note: 'Expected wOBA on plate appearances ending in that zone' },
    avg: { lab: 'BATTING AVG', fmt: f3, lo: .180, mid: .250, hi: .340, note: 'Hits per at-bat ending in that zone' },
    ev: { lab: 'EXIT VELO', fmt: f1, lo: 84, mid: 89, hi: 95, note: 'Average exit velocity on balls in play' },
    whiff: { lab: 'WHIFF %', fmt: v => Math.round(v) + '%', lo: 40, mid: 24, hi: 10, note: 'Swings and misses per swing — red is good contact' },
    swing: { lab: 'SWING %', fmt: v => Math.round(v) + '%', lo: null, note: 'How often he swings at pitches there' },
  };
  function zoneValue(list, key) {
    if (key === 'xwoba') { const pa = list.filter(q => q.wd === 1); return pa.length ? { v: mean(pa.map(q => (q.bb && q.xw != null) ? q.xw : (q.wv ?? 0))), n: pa.length } : null; }
    if (key === 'avg') { const ab = list.filter(q => q.ev && !NON_AB.has(q.ev)); return ab.length ? { v: ab.filter(q => HITS.has(q.ev)).length / ab.length, n: ab.length } : null; }
    if (key === 'ev') { const b = list.filter(q => q.bb && q.ls != null); return b.length ? { v: mean(b.map(q => q.ls)), n: b.length } : null; }
    const sw = list.filter(q => SWINGS.has(q.d));
    if (key === 'whiff') return sw.length ? { v: sw.filter(q => WHIFFS.has(q.d)).length / sw.length * 100, n: sw.length } : null;
    return list.length ? { v: sw.length / list.length * 100, n: list.length } : null;
  }
  function metricPct(m, v) {
    if (m.lo == null) return clamp(v, 0, 100);
    const t = (m.hi > m.lo) ? (v < m.mid ? (v - m.lo) / (m.mid - m.lo) * 50 : 50 + (v - m.mid) / (m.hi - m.mid) * 50)
      : (v > m.mid ? (m.lo - v) / (m.lo - m.mid) * 50 : 50 + (m.mid - v) / (m.mid - m.hi) * 50);
    return clamp(t, 0, 100);
  }
  function vZones(c) {
    const key = ZONE_METRIC[c.o.zm] ? c.o.zm : 'xwoba', m = ZONE_METRIC[key];
    const P = sideFilter(c.P, 'bat', c.o.side).filter(q => q.z != null);
    if (!P.length) return empty(`No ${c.y} pitches on record`);
    const by = {}; for (const q of P) (by[q.z] = by[q.z] || []).push(q);
    const side = c.W > c.H + 260;
    const total = Math.min(c.H - 36, (side ? c.W - 330 : c.W) - 40);
    const cell = total / 4.5, mg = cell * .75, ox = side ? 40 : (c.W - total) / 2, oy = (c.H - total) / 2;
    const ix = ox + mg, iy = oy + mg, midX = ix + cell * 1.5, midY = iy + cell * 1.5, OX = ox + total, OY = oy + total;
    const color = r => r ? pctColor(metricPct(m, r.v)) : '#e6e1d4';
    const label = (r, X, Y, big) => {
      if (!r) return txt(X, Y + 8, '—', 't-cell', 'middle', 'fill="#a3acb6"');
      const p = metricPct(m, r.v), ink = p > 30 && p < 70 ? 'var(--ink)' : '#fff';
      return txt(X, Y + (big ? 10 : 8), m.fmt(r.v), 't-cell', 'middle', `fill="${ink}" style="font-size:${big ? clamp(cell * .27, 22, 38) : clamp(cell * .22, 18, 30)}px"`) +
        txt(X, Y + (big ? 36 : 30), `${r.n}`, 't-n', 'middle', `fill="${ink}" opacity=".75"`);
    };
    let s = svgOpen(c.W, c.H);
    const quads = { 11: [[ox, oy], [midX, oy], [midX, iy], [ix, iy], [ix, midY], [ox, midY]], 12: [[OX, oy], [midX, oy], [midX, iy], [ix + cell * 3, iy], [ix + cell * 3, midY], [OX, midY]],
      13: [[ox, OY], [midX, OY], [midX, iy + cell * 3], [ix, iy + cell * 3], [ix, midY], [ox, midY]], 14: [[OX, OY], [midX, OY], [midX, iy + cell * 3], [ix + cell * 3, iy + cell * 3], [ix + cell * 3, midY], [OX, midY]] };
    const qlab = { 11: [ox + mg / 2 + 6, oy + mg / 2], 12: [OX - mg / 2 - 6, oy + mg / 2], 13: [ox + mg / 2 + 6, OY - mg / 2 - 8], 14: [OX - mg / 2 - 6, OY - mg / 2 - 8] };
    let i = 0;
    for (const z of [11, 12, 13, 14]) {
      const r = zoneValue(by[z] || [], key);
      s += `<g class="fadein" ${delay(i++, 60)}><path d="M${quads[z].map(p => p.join(',')).join(' L')} Z" fill="${color(r)}" stroke="var(--card)" stroke-width="4"/>${label(r, ...qlab[z], false)}</g>`;
    }
    for (let z = 1; z <= 9; z++) {
      const col = (z - 1) % 3, row = Math.floor((z - 1) / 3), r = zoneValue(by[z] || [], key);
      const X = ix + col * cell, Y = iy + row * cell;
      s += `<g class="pop" ${delay(i++, 60)}><rect x="${X}" y="${Y}" width="${cell}" height="${cell}" fill="${color(r)}" stroke="var(--card)" stroke-width="4"/>${label(r, X + cell / 2, Y + cell / 2 - 10, true)}</g>`;
    }
    s += `<rect x="${ix}" y="${iy}" width="${cell * 3}" height="${cell * 3}" fill="none" stroke="var(--ink)" stroke-width="4"/>`;
    // he stands on the 3B side of the plate (catcher's left) if he bats right-handed
    const bats = c.p.bats === 'S' ? null : (c.p.bats || P[0].st);
    if (bats) s += txt(bats === 'R' ? ox - 14 : OX + 14, midY, `${bats}HB`, 't-axb', 'middle', `transform="rotate(-90 ${bats === 'R' ? ox - 14 : OX + 14} ${midY})"`);
    s += '</svg>';
    if (side) {
      const all = zoneValue(P, key);
      const inner = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(z => [z, zoneValue(by[z] || [], key)]).filter(x => x[1] && x[1].n >= 8);
      const better = key === 'whiff' ? (a, b) => a - b : (a, b) => b - a;
      inner.sort((a, b) => better(a[1].v, b[1].v));
      const where = z => ['UP & IN', 'UP', 'UP & AWAY', 'MIDDLE-IN', 'MIDDLE', 'MIDDLE-AWAY', 'DOWN & IN', 'DOWN', 'DOWN & AWAY'][z - 1];
      // "in" is toward the hitter: zones 1/4/7 are the catcher's left, which is inside to a righty
      const flip = z => bats === 'L' ? where(z).replace('IN', '§').replace('AWAY', 'IN').replace('§', 'AWAY') : where(z);
      s += `<div class="side" style="width:300px">` +
        `<div class="kpi"><span>${esc(m.lab)} · overall</span><b>${all ? m.fmt(all.v) : '—'}</b></div>` +
        (inner.length ? `<div class="kpi"><span>Hot zone</span><b style="font-size:28px">${flip(inner[0][0])}</b></div><div class="kpi"><span>Cold zone</span><b style="font-size:28px">${flip(inner[inner.length - 1][0])}</b></div>` : '') +
        `<div class="note" style="margin-top:auto">${esc(m.note)}. Small number = sample. Catcher's view.</div></div>`;
    }
    return s;
  }

  // ── exit velo × launch angle, Savant's classic batted-ball chart ──
  function barrelBand(ev) {
    if (ev < 98) return null;
    const e = Math.min(ev, 116);
    return [26 - (e - 98), 30 + (e - 98) * 20 / 18];
  }
  const pctOf = (c, k) => { const r = cardRows(c.L, c.role, c.p.id).find(x => x.r.k === k); return r ? r.p : (c.me.pct[k] != null ? Math.round(c.me.pct[k]) : null); };
  function battedSide(c, B) {
    const evs = B.map(q => q.ls), brl = B.filter(q => q.lsa === 6).length, hh = B.filter(q => q.ls >= 95).length, sw = B.filter(q => q.la >= 8 && q.la <= 32).length;
    const chip = k => { const p = pctOf(c, k); return p != null ? `<em style="background:${pctColor(p)}">${p}</em>` : ''; };
    return `<div class="side" style="width:300px">` +
      `<div class="kpi"><span>Avg exit velo</span><b>${f1(mean(evs))}${chip('exit_velocity')}</b></div>` +
      `<div class="kpi"><span>Max exit velo</span><b>${f1(Math.max(...evs))}${chip('max_ev')}</b></div>` +
      `<div class="kpi"><span>Barrel %</span><b>${(brl / B.length * 100).toFixed(1)}${chip('brl_percent')}</b></div>` +
      `<div class="kpi"><span>Hard-hit %</span><b>${(hh / B.length * 100).toFixed(1)}${chip('hard_hit_percent')}</b></div>` +
      `<div class="kpi"><span>Sweet spot % (8–32°)</span><b>${(sw / B.length * 100).toFixed(1)}</b></div>` +
      `<div class="kpi"><span>Avg launch angle</span><b>${f1(mean(B.map(q => q.la)))}°</b></div></div>`;
  }
  const ORDER = ['out', 'single', 'double', 'triple', 'home_run'];
  function vLaunch(c) {
    const B = sideFilter(c.P, 'bat', c.o.side).filter(q => q.bb && q.ls != null && q.la != null);
    if (!B.length) return empty(`No ${c.y} batted balls`);
    const wide = c.W - c.H > 200, pw = wide ? c.W - 310 : c.W;
    const x0 = 70, x1 = pw - 20, y0 = 20, y1 = c.H - 58, E0 = 40, E1 = 120, A0 = -60, A1 = 80;
    const X = ev => x0 + (clamp(ev, E0, E1) - E0) / (E1 - E0) * (x1 - x0), Y = la => y1 - (clamp(la, A0, A1) - A0) / (A1 - A0) * (y1 - y0);
    let s = svgOpen(c.W, c.H);
    s += `<rect x="${x0}" y="${Y(32)}" width="${x1 - x0}" height="${Y(8) - Y(32)}" fill="rgba(29,127,69,.09)"/>` + txt(x0 + 8, Y(32) + 20, 'SWEET SPOT 8–32°', 't-axb', 'start', 'style="fill:var(--green)"');
    const bp = []; for (let e = 98; e <= E1; e++) bp.push([X(e), Y(barrelBand(e)[1])]);
    for (let e = E1; e >= 98; e--) bp.push([X(e), Y(barrelBand(e)[0])]);
    s += `<path d="M${bp.map(p => p.map(v => v.toFixed(1)).join(',')).join(' L')} Z" fill="rgba(233,185,73,.42)" stroke="var(--gold-dk)" stroke-width="2.5"/>`;
    s += txt(X(104), Y(barrelBand(104)[1]) - 10, 'BARREL', 't-axb', 'middle', 'style="fill:var(--gold-dk)"');
    for (let e = 50; e <= E1; e += 10) s += `<line class="grid-l" x1="${X(e)}" y1="${y0}" x2="${X(e)}" y2="${y1}"/>` + txt(X(e), y1 + 24, e, 't-ax');
    for (let la = -60; la <= 80; la += 20) s += `<line class="${la === 0 ? 'axis-l' : 'grid-l'}" x1="${x0}" y1="${Y(la)}" x2="${x1}" y2="${Y(la)}"/>` + txt(x0 - 10, Y(la) + 6, `${la}°`, 't-ax', 'end');
    B.slice().sort((a, b) => ORDER.indexOf(hitClass(a.ev)) - ORDER.indexOf(hitClass(b.ev))).forEach((q, i) => { s += mark(hitClass(q.ev), +X(q.ls).toFixed(1), +Y(q.la).toFixed(1), 5.5, i); });
    s += txt((x0 + x1) / 2, c.H - 8, 'EXIT VELOCITY (MPH)', 't-axb') + txt(18, (y0 + y1) / 2, 'LAUNCH ANGLE', 't-axb', 'middle', `transform="rotate(-90 18 ${(y0 + y1) / 2})"`);
    s += '</svg>';
    return wide ? s + battedSide(c, B) : s;
  }

  // ── flight paths: every ball in the air, side view, drawn out to where Statcast says it landed ──
  function vFlight(c) {
    const sf = SPRAY_FILTER[c.o.spray] || SPRAY_FILTER.all;
    const B = sideFilter(c.P, 'bat', c.o.side).filter(q => q.bb && q.la != null && q.dist != null && q.la > 0 && sf.f(q));
    if (!B.length) return empty(`No ${c.y} balls in the air`);
    const wide = c.W - c.H > 200, pw = wide ? c.W - 310 : c.W;
    const x0 = 60, x1 = pw - 24, gy = c.H - 56, D = Math.max(450, Math.ceil(Math.max(...B.map(q => q.dist)) / 50) * 50);
    // a parabola through contact and the landing point, peaking where the launch angle says it should;
    // real flights are lopsided by drag, so this is the shape of each ball, not its exact path
    const apex = q => Math.min(q.dist * Math.tan(clamp(q.la, 0, 70) * Math.PI / 180) / 4, 230);
    // height gets its own scale (a 400-ft homer only peaks ~100 ft up, which would draw as a flat line)
    const H = Math.max(120, ...B.map(apex)) * 1.06, kx = (x1 - x0) / D, ky = (gy - 64) / H;
    const X = d => x0 + d * kx, Y = h => gy - h * ky;
    let s = svgOpen(c.W, c.H);
    s += `<rect x="0" y="${gy}" width="${pw}" height="${c.H - gy}" fill="#dfe6c8"/><line class="axis-l" x1="0" y1="${gy}" x2="${pw}" y2="${gy}"/>`;
    for (let d = 100; d <= D; d += 100) s += `<line class="grid-d" x1="${X(d)}" y1="${gy}" x2="${X(d)}" y2="48"/>` + txt(X(d), gy + 32, `${d} FT`, 't-ax');
    // the wall, somewhere between the lines and centre
    s += `<rect x="${X(330)}" y="${gy - 34}" width="${X(400) - X(330)}" height="34" fill="rgba(19,41,75,.22)"/>` + txt(X(365), gy - 12, 'WALL 330–400', 't-axb', 'middle', 'style="fill:var(--paper)"');
    B.slice().sort((a, b) => ORDER.indexOf(hitClass(a.ev)) - ORDER.indexOf(hitClass(b.ev))).forEach((q, i) => {
      const cls = hitClass(q.ev), h = apex(q), col = HIT_COLOR[cls], hr = cls === 'home_run';
      s += `<path class="draw" style="animation-delay:${Math.min(1600, i * 6)}ms" pathLength="1" d="M${X(0)},${gy} Q${X(q.dist / 2).toFixed(1)},${Y(h * 2).toFixed(1)} ${X(q.dist).toFixed(1)},${gy}" fill="none" stroke="${col}" ` +
        `stroke-width="${hr ? 3.2 : cls === 'out' ? 1.4 : 2.2}" stroke-opacity="${hr ? .95 : cls === 'out' ? .35 : .75}"/>`;
    });
    const leg = [['home_run', 'HR'], ['triple', '3B'], ['double', '2B'], ['single', '1B'], ['out', 'OUT']];
    let lx = 20; leg.forEach(([cls, lab]) => { s += `<line x1="${lx}" y1="26" x2="${lx + 26}" y2="26" stroke="${HIT_COLOR[cls]}" stroke-width="4"/>` + txt(lx + 32, 32, lab, 't-axb', 'start'); lx += 84; });
    s += txt(pw - 20, 32, `${sf.lab} · HEIGHT NOT TO SCALE`, 't-axb', 'end') + '</svg>';
    if (!wide) return s;
    const hr = B.filter(q => q.ev === 'home_run'), far = B.slice().sort((a, b) => b.dist - a.dist)[0];
    return s + `<div class="side" style="width:300px">` +
      `<div class="kpi"><span>Balls in the air</span><b>${B.length}</b></div>` +
      `<div class="kpi"><span>Home runs</span><b>${hr.length}</b></div>` +
      `<div class="kpi"><span>Longest</span><b>${Math.round(far.dist)}<small>FT</small></b></div>` +
      `<div class="kpi"><span>Avg HR distance</span><b>${hr.length ? Math.round(mean(hr.map(q => q.dist))) : '—'}<small>FT</small></b></div>` +
      `<div class="kpi"><span>Avg HR exit velo</span><b>${hr.length ? f1(mean(hr.map(q => q.ls).filter(v => v != null))) : '—'}<small>MPH</small></b></div>` +
      `<div class="kpi"><span>Avg HR launch angle</span><b>${hr.length ? f1(mean(hr.map(q => q.la))) + '°' : '—'}</b></div></div>`;
  }

  // ── bat tracking ──
  function dial(cx, cy, r, pct, value, unit, label) {
    const a0 = Math.PI, a1 = Math.PI * (1 - clamp(pct ?? 0, 0, 100) / 100), col = pct == null ? '#a3acb6' : pctColor(pct);
    const pt = a => `${(cx + Math.cos(a) * r).toFixed(1)},${(cy - Math.sin(a) * r).toFixed(1)}`;
    let s = `<path d="M${pt(a0)} A${r},${r} 0 0 1 ${pt(0)}" fill="none" stroke="#e3ddcf" stroke-width="${r * .2}"/>`;
    if (pct != null) s += `<path class="fadein" d="M${pt(a0)} A${r},${r} 0 0 1 ${pt(a1)}" fill="none" stroke="${col}" stroke-width="${r * .2}"/>` +
      `<line class="fadein" x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(a1) * r * .78).toFixed(1)}" y2="${(cy - Math.sin(a1) * r * .78).toFixed(1)}" stroke="var(--ink)" stroke-width="5" stroke-linecap="round"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="9" fill="var(--ink)"/>`;
    s += txt(cx, cy + 46, value, 't-big', 'middle', `style="font-size:${clamp(r * .32, 30, 48)}px"`) + txt(cx, cy + 70, unit, 't-axb');
    s += txt(cx, cy - r - r * .2 - 6, label, 't-head', 'middle', 'style="font-size:22px"');
    if (pct != null) s += `<rect x="${cx + r * .55}" y="${cy + 14}" width="52" height="30" fill="${col}"/>` + txt(cx + r * .55 + 26, cy + 37, `${Math.round(pct)}`, 't-num', 'middle', 'style="fill:#fff;font-size:22px"');
    return s;
  }
  function vSwing(c) {
    const v = c.me.val, sw = c.me.swing, sp = c.L.spread;
    if (v.avg_swing_speed == null && !sw) return empty(`No ${c.y} bat tracking`, 'Bat tracking starts in 2024 and needs a swing sample.');
    let s = svgOpen(c.W, c.H);
    const r = Math.min(c.W / 6 - 34, (c.H - 60) * .25);
    const row1 = 46 + r * 1.2;
    [[c.W / 6, pctOf(c, 'bat_speed'), f1(v.avg_swing_speed), 'MPH', 'BAT SPEED'], [c.W / 2, pctOf(c, 'swing_length'), f1(v.avg_swing_length), 'FEET', 'SWING LENGTH'],
      [c.W * 5 / 6, pctOf(c, 'squared_up_rate'), v.squared_up_contact != null ? v.squared_up_contact.toFixed(1) + '%' : '—', 'OF CONTACT', 'SQUARED-UP']]
      .forEach(([x, p, val, u, l]) => { s += dial(x, row1, r, p, val, u, l); });
    // attack angle, side view: the bat path rising through the ideal 5–20° window
    const aa = sw?.aa ?? (typeof v.attack_angle === 'number' ? v.attack_angle : null);
    const y2 = row1 + 96, h2 = c.H - y2 - 16, ax = 30, aw = c.W * .5, gy = y2 + h2 - 12, len = Math.min(aw - 40, (h2 - 50) / Math.sin(26 * Math.PI / 180));
    const at = deg => [ax + Math.cos(deg * Math.PI / 180) * len, gy - Math.sin(deg * Math.PI / 180) * len];
    s += `<line class="axis-l" x1="${ax}" y1="${gy}" x2="${ax + aw}" y2="${gy}"/>`;
    s += `<path d="M${ax},${gy} L${at(5).join(',')} L${at(20).join(',')} Z" fill="rgba(29,127,69,.14)" stroke="rgba(29,127,69,.5)" stroke-width="2"/>`;
    s += txt(at(20)[0] - 6, at(20)[1] - 8, 'IDEAL 5–20°', 't-axb', 'end', 'style="fill:var(--green)"');
    const med = sp.aa.length ? sp.aa.slice().sort((a, b) => a - b)[sp.aa.length >> 1] : null;
    if (med != null) s += `<line x1="${ax}" y1="${gy}" x2="${at(med)[0]}" y2="${at(med)[1]}" stroke="var(--slate)" stroke-width="3" stroke-dasharray="8 6"/>` + txt(at(med)[0] + 8, at(med)[1] + 6, `MLB ${med.toFixed(0)}°`, 't-axb', 'start');
    if (aa != null) {
      s += `<line class="fadein" x1="${ax}" y1="${gy}" x2="${at(aa)[0]}" y2="${at(aa)[1]}" stroke="var(--red)" stroke-width="10" stroke-linecap="round"/>` + `<circle cx="${ax}" cy="${gy}" r="11" fill="#fff" stroke="var(--ink)" stroke-width="3"/>`;
      s += txt(ax, y2 + 14, `ATTACK ANGLE  ${aa.toFixed(1)}°`, 't-head', 'start', 'style="font-size:28px"');
    }
    // the four smaller numbers, 2 × 2
    const tx = ax + aw + 50, tw = (c.W - tx - 26) / 2, th = h2 / 2;
    const tiles = [
      ['BLAST %', v.blasts_contact != null ? v.blasts_contact.toFixed(1) + '%' : '—', rankPct(sp.blasts, v.blasts_contact)],
      ['IDEAL ATTACK ANGLE', sw?.ideal != null ? Math.round(sw.ideal * 100) + '%' : '—', rankPct(sp.ideal, sw?.ideal)],
      ['ATTACK DIRECTION', sw?.dir != null ? `${Math.abs(sw.dir).toFixed(1)}° ${sw.dir < 0 ? 'PULL' : 'OPPO'}` : '—', null],
      ['SWING PATH TILT', sw?.tilt != null ? sw.tilt.toFixed(0) + '°' : '—', null],
    ];
    tiles.forEach(([l, val, p], i) => {
      const x = tx + (i % 2) * tw, y = y2 + Math.floor(i / 2) * th;
      s += `<line class="grid-l" x1="${x}" y1="${y}" x2="${x + tw - 20}" y2="${y}"/>` + txt(x, y + 26, l, 't-axb', 'start') + txt(x, y + 70, val, 't-num', 'start', 'style="font-size:36px"');
      if (p != null) s += `<rect x="${x + tw - 72}" y="${y + 42}" width="52" height="30" fill="${pctColor(p)}"/>` + txt(x + tw - 46, y + 64, p, 't-num', 'middle', 'style="fill:#fff;font-size:22px"');
    });
    return s + '</svg>';
  }

  // ── overview: card on the left, the signature chart on the right ──
  function vOverview(c) {
    const lw = Math.round(c.W * .47);
    const card = vCard(Object.assign({}, c, { W: lw, H: c.H, limit: 11 }));
    const right = c.role === 'pit' ? vMovement(Object.assign({}, c, { W: c.W - lw, H: c.H })) : vSpray(Object.assign({}, c, { W: c.W - lw, H: c.H }));
    return `<div class="sub" style="left:0;width:${lw}px">${card}</div><div class="sub" style="left:${lw}px;width:${c.W - lw}px;border-left:2px solid var(--rule)">${right}</div>`;
  }

  // ── stats: one season, the career, or every season ──
  const STAT_MODES = { season: 'Season', career: 'Career', years: 'Season by season' };
  function rotBar(c) {
    if (!c.rot) return '';
    return `<div class="rotbar"><i style="animation-duration:${c.rot.ms}ms;animation-delay:-${c.rot.at}ms"></i></div>`;
  }
  function statBanner(c, mode, CD) {
    if (mode === 'career') {
      const ys = CD.years.map(r => r.y);
      return `<div class="sbn"><b>CAREER</b><span>${ys.length ? `${ys[0]}–${ys[ys.length - 1]} · ${ys.length} SEASON${ys.length === 1 ? '' : 'S'}` : ''}</span></div>`;
    }
    const r = CD.years.find(x => x.y === c.y);
    return `<div class="sbn"><b>${c.y} SEASON</b><span>${r ? esc(r.tm) : ''}</span></div>`;
  }
  function vStats(c) {
    const CD = c.CD, mode = c.mode || 'season';
    if (!CD || (!CD.years.length && !CD.total)) return empty('No MLB stats on record');
    if (mode === 'years') return yearTable(c, CD) + rotBar(c);
    const row = CD.years.find(x => x.y === c.y);
    const st = mode === 'career' ? CD.total : row?.st, war = mode === 'career' ? CD.war : row?.war;
    if (!st) return empty(`No ${c.y} MLB stats`, 'Pick another season, or switch to career.');
    const keys = TILE_KEYS(c.role, CD), cols = c.W > 800 ? 5 : 3, rows = Math.ceil(keys.length / cols);
    const th = (c.H - 96 - (rows - 1) * 12) / rows, fs = clamp(th * .5, 34, 84);
    return statBanner(c, mode, CD) + `<div class="tiles" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},${th.toFixed(0)}px)">` +
      keys.map((k, i) => {
        const v = statVal(k, st, war), best = mode === 'season' && (!STAT[k].rate || fullSeason(c.role, st)) ? careerBest(c.role, CD, k) : null;
        const top = best != null && v != null && v === best;
        return `<div class="tile${top ? ' top' : ''}" style="--i:${i}"><span>${STAT[k].lab}</span><b style="font-size:${fs.toFixed(0)}px">${statFmt(k, v)}</b>${top ? '<em>CAREER BEST</em>' : ''}</div>`;
      }).join('') + '</div>' + rotBar(c);
  }
  function yearTable(c, CD, narrowKeys) {
    const keys = narrowKeys || (c.W < 800 ? YEAR_KEYS_NARROW : YEAR_KEYS)[c.role];
    // rows draw 40px (38 + rule); keep the header, the career row and the footnote clear of the bottom
    const rh = 40, fit = Math.max(3, Math.floor((c.H - 12 - 32 - rh - 34) / rh));
    const years = CD.years.slice(-fit), cut = CD.years.length - years.length;
    const bests = Object.fromEntries(keys.map(k => [k, careerBest(c.role, CD, k)]));
    const cell = (k, r) => {
      const v = statVal(k, r.st, r.war), b = bests[k], ok = !STAT[k].rate || fullSeason(c.role, r.st);
      return `<td${b != null && ok && v === b ? ' class="best"' : ''}>${statFmt(k, v)}</td>`;
    };
    return `<table class="yrs"><tr><th class="yr">YEAR</th><th class="tm">TEAM</th>${keys.map(k => `<th>${STAT[k].lab}</th>`).join('')}</tr>` +
      years.map((r, i) => `<tr style="--i:${i}"${r.y === c.y ? ' class="cur"' : ''}><td class="yr">${r.y}</td><td class="tm">${esc(r.tm)}</td>${keys.map(k => cell(k, r)).join('')}</tr>`).join('') +
      `<tr class="car"><td class="yr">CAREER</td><td class="tm">${cut ? `+${cut} YRS` : ''}</td>${keys.map(k => `<td>${statFmt(k, statVal(k, CD.total, CD.war))}</td>`).join('')}</tr></table>` +
      `<div class="estnote" style="bottom:8px">Gold = career best${c.role === 'pit' ? ' (rates need 40+ IP)' : ' (rates need 200+ PA)'}</div>`;
  }

  // ── compare: the tale of the tape ──
  function vTape(a, b, mode) {
    const pick = c => mode === 'career' ? [c.CD.total, c.CD.war] : (r => [r?.st, r?.war])(c.CD.years.find(x => x.y === c.y));
    const [sa, wa] = pick(a), [sb, wb] = pick(b);
    if (!sa && !sb) return empty('No stats to compare');
    const keys = TILE_KEYS(a.role, a.CD).map(k => k === 'gs' && closer(b.CD) ? 'sv' : k);
    const lab = c => esc(c.p.name.replace(/ (Jr\.|Sr\.|II|III|IV)$/, '').split(' ').slice(-1)[0].toUpperCase()) + (mode !== 'career' && a.y !== b.y ? ` <small>${c.y}</small>` : '');
    const rh = (a.H - 80) / keys.length, fs = clamp(rh * .62, 22, 40);
    return `<div class="tape-hd"><b>${lab(a)}</b><span>${mode === 'career' ? 'CAREER' : a.y === b.y ? a.y + ' SEASON' : 'SEASON'}</span><b>${lab(b)}</b></div>` +
      `<div class="tape" style="grid-template-rows:repeat(${keys.length},${rh.toFixed(1)}px);--fs:${fs.toFixed(0)}px">` + keys.map((k, i) => {
        const va = statVal(k, sa, wa), vb = statVal(k, sb, wb), d = STAT[k].dir;
        // counting stats only crown a winner when both have a number; equal is a push
        const win = d && va != null && vb != null && va !== vb ? ((va > vb) === (d > 0) ? 'a' : 'b') : '';
        return `<div class="tv${win === 'a' ? ' win' : ''}" style="--i:${i}">${statFmt(k, va)}</div><div class="tl">${STAT[k].lab}</div><div class="tv r${win === 'b' ? ' win' : ''}" style="--i:${i}">${statFmt(k, vb)}</div>`;
      }).join('') + '</div>';
  }
  // ── compare: Savant's card mirrored, one player each way ──
  function vH2H(a, b) {
    const ma = Object.fromEntries(cardRows(a.L, a.role, a.p.id).map(x => [x.r.k, x])), mb = Object.fromEntries(cardRows(b.L, b.role, b.p.id).map(x => [x.r.k, x]));
    const rows = ROWS[a.role].filter(r => ma[r.k] || mb[r.k]);
    if (!rows.length) return empty('No percentile cards to compare');
    const rh = clamp((a.H - 40) / rows.length, 26, 58), fs = clamp(rh * .46, 16, 25), bd = clamp(rh * .74, 26, 44);
    const side = (x, c, r, s, win) => {
      if (!x) return `<div class="ht ${s}"></div>`;
      const w = clamp(x.p, 1, 100), col = pctColor(x.p);
      return `<div class="ht ${s}${win ? ' win' : ''}"><i style="width:${w}%;background:${col}"></i><b style="${s === 'l' ? 'right' : 'left'}:${w}%;background:${col}">${x.p}</b></div>`;
    };
    const val = (x, c, r) => x && r.val ? FMT[r.f](c.me.val[r.val] ?? null) : '';
    return `<div class="h2h" style="grid-template-rows:repeat(${rows.length},${rh.toFixed(1)}px);--fs:${fs.toFixed(1)}px;--bd:${bd.toFixed(0)}px">` + rows.map((r, i) => {
      const A = ma[r.k], B = mb[r.k], wa = A && B && A.p > B.p, wb = A && B && B.p > A.p;
      return `<div class="hv" style="--i:${i}">${esc(val(A, a, r))}</div>${side(A, a, r, 'l', wa)}<div class="hl">${esc(r.lab)}${(A?.est || B?.est) ? '<sup>*</sup>' : ''}</div>${side(B, b, r, 'r', wb)}<div class="hv r">${esc(val(B, b, r))}</div>`;
    }).join('') + '</div>';
  }
  function halves(a, b, fa, fb) {
    const w = Math.floor(a.W / 2);
    return `<div class="sub" style="left:0;width:${w}px">${fa(Object.assign({}, a, { W: w }))}</div>` +
      `<div class="sub" style="left:${w}px;width:${a.W - w}px;border-left:3px solid var(--ink)">${fb(Object.assign({}, b, { W: a.W - w }))}</div>`;
  }

  const VIEWS = {
    pit: [
      { key: 'overview', name: 'Overview', title: 'Savant snapshot', pitches: true, fn: vOverview },
      { key: 'card', name: 'Percentiles', title: 'Percentile rankings', fn: vCard },
      { key: 'arsenal', name: 'Arsenal', title: 'Pitch arsenal', pitches: true, fn: vArsenal },
      { key: 'movement', name: 'Movement', title: 'Pitch movement', pitches: true, fn: vMovement, sub: "Pitcher's view", side: 1 },
      { key: 'locations', name: 'Locations', title: 'Pitch locations', pitches: true, fn: vLocations, side: 1, loc: 1 },
      { key: 'velo', name: 'Velocity', title: 'Velocity by pitch', pitches: true, fn: vVelo, side: 1 },
      { key: 'counts', name: 'Mix by count', title: 'Pitch mix by count', pitches: true, fn: vCounts },
      { key: 'stats', name: 'Stats', title: 'The numbers', career: true, fn: vStats },
    ],
    bat: [
      { key: 'overview', name: 'Overview', title: 'Savant snapshot', pitches: true, fn: vOverview },
      { key: 'card', name: 'Percentiles', title: 'Percentile rankings', fn: vCard },
      { key: 'spray', name: 'Spray chart', title: 'Spray chart', pitches: true, fn: vSpray, side: 1, spray: 1 },
      { key: 'zones', name: 'Hot zones', title: 'Hot zones', pitches: true, fn: vZones, side: 1, zm: 1 },
      { key: 'launch', name: 'EV & launch', title: 'Exit velo & launch angle', pitches: true, fn: vLaunch, side: 1 },
      { key: 'flight', name: 'Flight paths', title: 'Every ball in the air', pitches: true, fn: vFlight, side: 1, spray: 1 },
      { key: 'swing', name: 'Bat tracking', title: 'Bat tracking', fn: vSwing },
      { key: 'stats', name: 'Stats', title: 'The numbers', career: true, fn: vStats },
    ],
  };
  const viewOf = (role, key) => VIEWS[role].find(v => v.key === key) || VIEWS[role][0];

  // auto-cycle: which graphic is up right now, from the shared clock
  function cycleInfo(S, role) {
    const C = S.cycle; if (!C || !C.on) return null;
    const all = VIEWS[role].map(v => v.key), keys = (C.views?.[role] || all).filter(k => all.includes(k));
    if (keys.length < 2) return null;
    const ms = clamp(+C.secs || 10, 3, 300) * 1000, n = keys.length, span = ms * n;
    const t = ((Date.now() - (C.t0 || 0)) % span + span) % span, i = Math.floor(t / ms);
    return { key: keys[i], i, keys, ms, next: ms - (t - i * ms) };
  }

  // ════════════════════════════════════════════════════════════════════
  //  STAGE — header + stat lines + one view, inside the safe area
  // ════════════════════════════════════════════════════════════════════
  function createStage(host) {
    const el = document.createElement('div');
    el.className = 'stage off';
    el.innerHTML = '<div class="backdrop"></div><div class="panel"><div class="hd"></div><div class="lines"></div><div class="vt"></div><div class="body"></div></div>';
    host.appendChild(el);
    const $ = s => el.querySelector(s);
    const panel = $('.panel'), hd = $('.hd'), ln = $('.lines'), vt = $('.vt'), body = $('.body');
    let token = 0, bodyTok = 0, hdKey = '', lnKey = '', bodyKey = '';

    function half(p, role, duo) {
      const t = team(p.teamId), was = p.fa ? team(p.fa.to || p.fa.from) : null;
      const pos = role === 'pit' ? (p.throws ? `${p.throws}HP` : 'P') : (p.pos || '');
      const kick = p.fa ? (p.fa.to ? `<span class="fa">SIGNED</span>${esc(team(p.fa.to)?.name || '')}` : `<span class="fa">FREE AGENT</span>${was ? 'LAST: ' + esc(was.name) : ''}`)
        : esc(t ? t.name : 'MLB');
      const tc = (p.fa ? was : t)?.color || '#2a3b4c';
      const lg = p.fa ? (p.fa.to || p.fa.from) : p.teamId;
      const meta = [pos, p.age ? `AGE ${p.age}` : '', p.bats ? `B/T ${p.bats}/${p.throws}` : '', p.num ? `#${p.num}` : ''].filter(Boolean).join(' · ');
      return `<div class="half" style="--tc:${tc}"><div class="shot"><img src="${headshot(p.id)}" alt=""></div><div class="pid"><div class="kick">${kick}</div>` +
        `<div class="nm${!duo && p.name.length > 19 ? ' long' : ''}"${duo ? ` style="font-size:${Math.min(44, Math.floor(300 / (p.name.length * .55)))}px"` : ''}>${esc(p.name)}</div><div class="meta">${esc(meta)}</div></div>` +
        (lg ? `<img class="logo${p.fa && !p.fa.to ? ' was' : ''}" src="${logo(lg)}" alt="">` : '') + '</div>';
    }
    function header(p, role, p2, role2) {
      hd.classList.toggle('duo', !!p2);
      hd.innerHTML = half(p, role, !!p2) + (p2 ? half(p2, role2, true) + '<div class="vs">VS</div>' : '');
      hd.classList.remove('in'); void hd.offsetWidth; hd.classList.add('in');
    }
    // Auto-cycle walks the chosen graphics on a clock both screens share (S.cycle.t0)
    // Stats can flip between season / career (/ every season) on a clock both screens share (S.rot.t0)
    function statMode(S, view) {
      const R = S.rot, o = S.opts || {};
      if (view.key !== 'stats' || !R || !R.on) return { mode: STAT_MODES[o.stat] ? o.stat : 'season' };
      const modes = R.years ? ['season', 'career', 'years'] : ['season', 'career'], ms = clamp(+R.secs || 12, 5, 60) * 1000;
      const el_ = ((Date.now() - (R.t0 || 0)) % (ms * modes.length) + ms * modes.length) % (ms * modes.length);
      const i = Math.floor(el_ / ms), at = el_ - i * ms;
      return { mode: modes[i], rot: { ms, at, next: ms - at } };
    }
    let last = null, rotT = 0, warmed = '';

    async function render(S) {
      last = S; clearTimeout(rotT);
      el.classList.toggle('off', !S.on);
      el.classList.toggle('clear', S.bg === 'clear');
      el.classList.toggle('nolines', S.lines === false);
      const sf = Object.assign({}, SAFE_DEFAULT, S.safe || {});
      Object.assign(panel.style, { left: sf.l + 'px', top: sf.t + 'px', width: (sf.r - sf.l) + 'px', height: (sf.b - sf.t) + 'px' });
      const my = ++token;
      if (!S.id) {
        hd.innerHTML = ''; ln.innerHTML = ''; vt.innerHTML = ''; hdKey = lnKey = '';
        if (bodyKey !== 'none') { bodyKey = 'none'; body.innerHTML = empty('Pick a player'); }
        return;
      }
      const cmp = !!(S.compare && S.id2 && S.id2 !== S.id);
      const [p, p2] = await Promise.all([ensure(S.id), cmp ? ensure(S.id2) : null]);
      if (my !== token || !p) return;
      const two = !!(cmp && p2);
      const role = S.role || p.role, y = S.year || SEASON, o = S.opts || {};
      const cyc = cycleInfo(S, role), view = viewOf(role, cyc ? cyc.key : S.view);
      const role2 = two ? (S.role2 || p2.role) : null, y2 = two ? (S.year2 || y) : null;
      // the second player shows the same graphic if his role has it, his card if not
      const view2 = two ? (VIEWS[role2].find(v => v.key === view.key) || viewOf(role2, 'card')) : null;
      el.classList.toggle('duo', two);
      const { mode, rot } = statMode(S, view);
      const next = [rot?.next, cyc?.next].filter(v => v != null);
      if (next.length) rotT = setTimeout(() => last && render(last), Math.min(...next) + 40);
      // cycling: pull everything the loop will need now, so each graphic lands without a spinner
      const wk = cyc ? JSON.stringify([p.id, role, y, two ? [p2.id, role2, y2] : 0, cyc.keys]) : '';
      if (cyc && wk !== warmed) {
        warmed = wk;
        const warm = (id, r, yy) => cyc.keys.map(k => VIEWS[r].find(v => v.key === k)).filter(Boolean).forEach(v => {
          (v.career ? careerData(id, r) : league(yy)).catch(() => {});
          if (v.pitches) pitches(id, r, yy).catch(() => {});
        });
        warm(p.id, role, y); if (two) warm(p2.id, role2, y2);
      }
      const hk = `${p.id}|${role}|${p.name}|${p.fa ? 1 : 0}|${two ? `${p2.id}|${role2}|${p2.fa ? 1 : 0}` : ''}`;
      if (hk !== hdKey) { hdKey = hk; header(p, role, two ? p2 : null, role2); }
      const lk = two ? 'duo' : `${p.id}|${role}|${y}`;
      if (lk !== lnKey) {
        lnKey = lk; ln.innerHTML = '';
        if (!two) lines(p.id, role, y).then(L => { if (lnKey === lk) ln.innerHTML = linesHTML(L, role, y); });
      }
      const yrs = two && y2 !== y ? `${y} vs ${y2}` : String(y);
      const extras = view.career ? [STAT_MODES[mode].toUpperCase(), rot ? 'AUTO' : ''].filter(Boolean)
        : [view.side && sideText(role, o.side), view.loc && o.loc && o.loc !== 'all' && LOC_FILTER[o.loc]?.lab,
          view.spray && o.spray && o.spray !== 'all' && SPRAY_FILTER[o.spray]?.lab, view.zm && ZONE_METRIC[o.zm || 'xwoba'].lab, view.sub].filter(Boolean);
      const src = view.career ? 'MLB STATS' : 'BASEBALL SAVANT';
      const yTag = view.career && mode !== 'season' ? '' : (y !== SEASON ? `<i>${yrs} SEASON</i>` : yrs) + ' · ';
      vt.innerHTML = `<b>${esc(two && !view.career && (view.key === 'card' || view.key === 'overview') && role === role2 ? 'Head to head' : view.title)}</b>` +
        `<span>${extras.map(esc).join(' · ')}${extras.length ? ' · ' : ''}${yTag}${src}</span>`;
      const bk = JSON.stringify([p.id, role, y, view.key, mode, view.side ? o.side : 0, view.loc ? o.loc : 0, view.spray ? o.spray : 0, view.zm ? o.zm : 0, sf, S.lines !== false,
        two ? [p2.id, role2, y2] : 0]);
      // the same state can land three times (relay socket, poll, BroadcastChannel); only a change of body redraws
      if (bk === bodyKey) return;
      bodyKey = bk;
      const mb = ++bodyTok;
      const needP = v => v.pitches && !(two && (v.key === 'overview' || v.key === 'card') && role === role2);
      const slow = setTimeout(() => { if (mb === bodyTok) body.innerHTML = `<div class="loading"><i></i>${view.career ? 'LOADING STATS' : needP(view) ? 'PULLING EVERY PITCH FROM STATCAST' : 'LOADING SAVANT'}</div>`; }, 120);
      let L = null, P = null, CD = null, L2 = null, P2 = null, CD2 = null, err = null;
      try {
        [L, P, CD, L2, P2, CD2] = await Promise.all([
          view.career ? null : league(y), !view.career && needP(view) ? pitches(p.id, role, y) : null, view.career ? careerData(p.id, role) : null,
          two && !view2.career ? league(y2) : null, two && !view2.career && needP(view2) ? pitches(p2.id, role2, y2) : null, two && view2.career ? careerData(p2.id, role2) : null,
        ]);
      } catch (e) { err = e; }
      clearTimeout(slow);
      if (mb !== bodyTok) return;
      if (err || (!view.career && !L)) { body.innerHTML = empty(view.career ? 'Stats didn’t load' : 'Savant didn’t answer', 'Pick the view again to retry.'); bodyKey = ''; return; }
      const W = body.clientWidth, H = body.clientHeight;
      const c = { p, role, y, L, me: leagueRec(L, role, p.id), P, CD, o, mode, rot, W, H };
      let html;
      if (!two) html = view.fn(c);
      else {
        const c2 = { p: p2, role: role2, y: y2, L: L2, me: leagueRec(L2, role2, p2.id), P: P2, CD: CD2, o, mode, rot, W, H };
        if (view.career && role === role2 && mode !== 'years') html = vTape(c, c2, mode) + rotBar(c);
        else if (view.career) html = halves(Object.assign({}, c, { rot: null }), Object.assign({}, c2, { rot: null }), x => mode === 'years' ? yearTable(x, x.CD, YEAR_KEYS_NARROW[x.role]) : vStats(x), x => mode === 'years' ? yearTable(x, x.CD, YEAR_KEYS_NARROW[x.role]) : vStats(x)) + rotBar(c);
        else if ((view.key === 'card' || view.key === 'overview') && role === role2) html = vH2H(c, c2);
        else html = halves(c, c2, view.key === 'overview' ? vCard : view.fn, view2.key === 'overview' ? vCard : view2.fn);
      }
      body.innerHTML = `<div class="vw in">${html}</div>`;
    }
    return { el, render };
  }

  // ════════════════════════════════════════════════════════════════════
  //  TRANSPORT
  // ════════════════════════════════════════════════════════════════════
  function hubOf(params) { return (params.get('hub') || HUB_DEFAULT).replace(/\/$/, ''); }
  function publisher(hub, getRoom, onStatus) {
    let bc = null, bcRoom = null, inflight = 0;
    return async payload => {
      const room = getRoom();
      if (bcRoom !== room) { try { bc && bc.close(); bc = new BroadcastChannel('ss-' + room); bcRoom = room; } catch { bc = null; } }
      try { bc && bc.postMessage(payload); } catch {}
      const my = ++inflight;
      onStatus('sending…', '');
      try {
        const r = await fetch(`${hub}/r/${encodeURIComponent(room)}`, { method: 'POST', body: JSON.stringify(payload), signal: AbortSignal.timeout(6000) });
        const j = await r.json().catch(() => ({}));
        if (my !== inflight) return;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        onStatus(`sent · ${j.sent ?? 0} screen${j.sent === 1 ? '' : 's'} connected`, 'ok');
      } catch {
        if (my === inflight) onStatus('relay unreachable — OBS will not update', 'bad');
      }
    };
  }
  function subscribe(hub, room, apply) {
    try { new BroadcastChannel('ss-' + room).onmessage = e => apply(e.data); } catch {}
    const url = `${hub}/r/${encodeURIComponent(room)}`;
    let backoff = 2000;
    const open = () => {
      try {
        const ws = new WebSocket(url.replace(/^http/, 'ws'));
        ws.onopen = () => { backoff = 2000; };
        ws.onmessage = ev => { try { apply(JSON.parse(ev.data)); } catch {} };
        ws.onclose = () => { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); };
      } catch { setTimeout(open, backoff); }
    };
    open();
    // slow safety net for networks that eat the WebSocket upgrade; seq makes repeats harmless
    const poll = async () => {
      try {
        const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        const t = await r.text();
        if (t && t !== 'null') apply(JSON.parse(t));
      } catch {}
    };
    poll();
    setInterval(poll, 30000);
  }

  return { SEASON, FIRST_YEAR, SAFE_DEFAULT, CAMS, DB, TEAMS, team, headshot, logo, load, ensure, search, league, leagueRec, cardCount, lines, pitches,
    VIEWS, viewOf, cycleInfo, LOC_FILTER, SPRAY_FILTER, ZONE_METRIC, createStage, pctColor, esc, hubOf, publisher, subscribe };
})();
