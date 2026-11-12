"""SQL for the "what wins games" table: one row per match per game minute,
with every factor as a team0 - team1 difference known at that time.

Leakage rules (see README, Phase 2):
  * snapshot times are strictly before the game ends (the lake's last
    snapshot is the moment the game ends, so it is never used)
  * Patron (Titan) and Core objectives end the game -> not used
  * no match-level outcome fields (duration_s, mvp, accolades, ...) as features;
    duration_s only decides which snapshot times exist for a match
  * rank is the *initial* (pre-match) rank

Time grid: the snapshot minutes for every match, and every full minute from
1:00 to 45:00 for a 1-in-5 sample of matches (enough to train and test a model
at any minute, at half the cost of doing it for all).
The lake snapshots player stats every 3 min to 15:00, then every 5 min, so:
  * at a snapshot minute the stats are exact
  * between snapshots each player's last snapshot is carried forward, so the
    stats are up to 4 minutes old. They are NOT interpolated toward the next
    snapshot: that would leak the future into the present (tested: a model fed
    interpolated stats scores better just after a snapshot than at it).
  * the same holds for a player who abandoned (their snapshots stop), and the
    game-end snapshot is never used.
Objectives, deaths, respawn timers and abandons come from event times, so they
are exact at every minute.
"""

# Snapshot times present in the lake: every 3 min to 15:00, then every 5 min.
SNAPSHOT_S = [180, 360, 540, 720, 900, 1200, 1500, 1800, 2100, 2400, 2700]
STAT_COLS = ["nw", "kills", "lvl", "lh", "dn", "dmg", "bd", "gdl"]


OBJECTIVE_KIND = """
    CASE WHEN o LIKE 'Tier1%' THEN 'guardians'
         WHEN o LIKE 'Tier2%' THEN 'walkers'
         WHEN o LIKE 'BarrackBoss%' THEN 'base_guardians'
         WHEN o LIKE 'TitanShieldGenerator%' THEN 'shrines' END
"""

# +1 for team0, -1 for team1
SGN = "CASE WHEN team = 'Team0' THEN 1 ELSE -1 END"

RAW_SQL = """
    SELECT match_id, hero_id, account_id, player_slot, team::VARCHAR AS team, won, start_time, average_badge,
           match_mode::VARCHAR AS queue, duration_s,
           abandon_match_time_s AS ab, player_rank_initial_display_rank AS dr,
           "stats.time_stamp_s" AS ts, "stats.net_worth" AS nw, "stats.kills" AS kills,
           "stats.level" AS lvl, "stats.creep_kills" AS ck, "stats.neutral_kills" AS nk,
           "stats.denies" AS dn, "stats.player_damage" AS dmg,
           "stats.boss_damage" AS bd, "stats.gold_death_loss" AS gdl,
           "death_details.game_time_s" AS death_t, "death_details.death_duration_s" AS death_len,
           "objectives.team_objective" AS obj, "objectives.team" AS objteam,
           "objectives.destroyed_time_s" AS odt,
           "mid_boss.team_claimed" AS mbc, "mid_boss.destroyed_time_s" AS mbt,
           coalesce(low_pri_pool, false) AS low_pri, coalesce(new_player_pool, false) AS new_player,
           coalesce(is_high_skill_range_parties, false) AS wide_party
    FROM dl.main.match_player
    WHERE start_time >= TIMESTAMPTZ '{day} 00:00:00+00'
      AND start_time <  TIMESTAMPTZ '{next_day} 00:00:00+00'
      AND game_mode = 'Normal'
      AND match_mode IN ('Ranked', 'Unranked')
      AND match_outcome = 'TeamWin'
      AND NOT coalesce(not_scored, false)
      AND duration_s >= {min_duration}
"""

# Runs on the downloaded day (temp table wf_raw).
DAY_SQL = """
WITH raw AS (SELECT * FROM wf_raw),
dedup AS (
    SELECT * FROM raw
    QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY player_slot) = 1
),
players AS (        -- complete matches: 12 players, 6 per team, 6 winners
    SELECT * FROM dedup
    QUALIFY count(*) OVER (PARTITION BY match_id) = 12
        AND sum(won::INT) OVER (PARTITION BY match_id) = 6
        AND sum((team = 'Team0')::INT) OVER (PARTITION BY match_id) = 6
        AND bool_and(len(ts) = len(nw)) OVER (PARTITION BY match_id)
),
snap AS (           -- every stats snapshot of every player, except the game-end one,
                    -- plus a zero row at 0:00 for the minutes before the first one
    SELECT * FROM (
        SELECT match_id, hero_id, duration_s,
               unnest(ts)::BIGINT AS t, unnest(nw) AS nw, unnest(kills) AS kills, unnest(lvl) AS lvl,
               unnest(list_transform(list_zip(ck, nk), lambda x: x[1] + x[2])) AS lh,
               unnest(dn) AS dn, unnest(dmg) AS dmg, unnest(bd) AS bd, unnest(gdl) AS gdl
        FROM players)
    WHERE t < duration_s
    UNION ALL
    SELECT match_id, hero_id, duration_s, 0, 0, 0, 0, 0, 0, 0, 0, 0 FROM players
),
seg AS (            -- each snapshot with the time of the same player's next one
    SELECT s.*, lead(t) OVER w AS t1
    FROM snap s WINDOW w AS (PARTITION BY match_id, hero_id ORDER BY t)
),
at_t AS (           -- the snapshot is valid for every kept minute in [its time, next snapshot)
    SELECT * FROM (
        SELECT s.match_id, p.team, s.nw, s.kills, s.lvl, s.lh, s.dn, s.dmg, s.bd, s.gdl,
               unnest(generate_series(((s.t + 59) // 60) * 60,
                                      least(coalesce(s.t1, 2701) - 1, 2700, s.duration_s - 1), 60)) AS t
        FROM seg s JOIN players p USING (match_id, hero_id))
    WHERE t >= 60 AND (match_id % {mod} = {rem} OR t IN ({snapshots}))
),
team_snap AS (
    SELECT match_id, t, team, count(*) AS n,
           coalesce(sum(nw), 0)::DOUBLE AS nw, coalesce(sum(kills), 0)::DOUBLE AS kills,
           coalesce(sum(lvl), 0)::DOUBLE AS lvl, coalesce(sum(lh), 0)::DOUBLE AS lh,
           coalesce(sum(dn), 0)::DOUBLE AS dn, coalesce(sum(dmg), 0)::DOUBLE AS dmg,
           coalesce(sum(bd), 0)::DOUBLE AS bd, coalesce(sum(gdl), 0)::DOUBLE AS gdl,
           -- share of the team's souls held by its richest player
           coalesce(max(nw)::DOUBLE / nullif(sum(nw), 0), 1.0 / 6) AS top_share
    FROM at_t GROUP BY ALL
),
diff AS (
    SELECT match_id, t,
           sum(CASE WHEN team = 'Team0' THEN nw ELSE -nw END)       AS souls,
           sum(nw)                                                  AS total_souls,
           sum(CASE WHEN team = 'Team0' THEN kills ELSE -kills END) AS kills,
           sum(CASE WHEN team = 'Team0' THEN lvl ELSE -lvl END)     AS levels,
           sum(CASE WHEN team = 'Team0' THEN lh ELSE -lh END)       AS last_hits,
           sum(CASE WHEN team = 'Team0' THEN dn ELSE -dn END)       AS denies,
           sum(CASE WHEN team = 'Team0' THEN dmg ELSE -dmg END)     AS hero_damage,
           sum(CASE WHEN team = 'Team0' THEN bd ELSE -bd END)       AS objective_damage,
           sum(CASE WHEN team = 'Team0' THEN -gdl ELSE gdl END)     AS enemy_souls_lost,
           100 * sum(CASE WHEN team = 'Team0' THEN top_share ELSE -top_share END) AS carry_concentration
    FROM team_snap
    GROUP BY ALL
    HAVING count(*) = 2 AND bool_and(n = 6)
),
snap_mom AS (       -- soul-lead change between the two latest snapshots, per 5 minutes
    SELECT match_id, t, coalesce((souls - lag(souls) OVER w) * 300.0 / (t - lag(t) OVER w), 0) AS momentum
    FROM diff WHERE t IN ({snapshots})
    WINDOW w AS (PARTITION BY match_id ORDER BY t)
),
d2 AS (
    SELECT a.*, coalesce(m.momentum, 0) AS momentum
    FROM diff a ASOF LEFT JOIN snap_mom m ON a.match_id = m.match_id AND a.t >= m.t
),
mt AS (SELECT match_id, t FROM d2),
m AS (
    SELECT match_id, any_value(queue) AS queue, any_value(average_badge) AS average_badge,
           bool_or(team = 'Team0' AND won) AS team0_won,
           any_value(obj) AS obj, any_value(objteam) AS objteam, any_value(odt) AS odt,
           any_value(mbc) AS mbc, any_value(mbt) AS mbt,
           bool_or(low_pri) AS low_pri, bool_or(new_player) AS new_player, bool_or(wide_party) AS wide_party,
           list(hero_id::INT ORDER BY hero_id) FILTER (WHERE team = 'Team0')    AS heroes0,
           list(hero_id::INT ORDER BY hero_id) FILTER (WHERE team = 'Team1')    AS heroes1,
           list(account_id::BIGINT ORDER BY hero_id) FILTER (WHERE team = 'Team0') AS accounts0,
           list(account_id::BIGINT ORDER BY hero_id) FILTER (WHERE team = 'Team1') AS accounts1,
           -- pre-match rank as sub-rank steps (badge tier*10 + sub, 0 = not placed)
           coalesce(avg(CASE WHEN dr >= 11 THEN (dr::INT // 10 - 1) * 6 + dr::INT % 10 END) FILTER (WHERE team = 'Team0')
                  - avg(CASE WHEN dr >= 11 THEN (dr::INT // 10 - 1) * 6 + dr::INT % 10 END) FILTER (WHERE team = 'Team1'), 0)
             AS rank_gap
    FROM players GROUP BY 1
),
objs AS (           -- a destroyed objective counts for the team that does NOT own it
    SELECT match_id, {kind} AS kind, CASE WHEN owner = 'Team1' THEN 1 ELSE -1 END AS sgn, d,
           regexp_extract(o, 'Lane([0-9])', 1) AS lane
    FROM (SELECT match_id, unnest(obj)::VARCHAR AS o, unnest(objteam)::VARCHAR AS owner,
                 unnest(odt) AS d FROM m)
    WHERE d > 0
),
boss AS (           -- mid-boss: +1 when team0 claimed the reward
    SELECT match_id, CASE WHEN c = 'Team0' THEN 1 WHEN c = 'Team1' THEN -1 ELSE 0 END AS sgn, d
    FROM (SELECT match_id, unnest(mbc)::VARCHAR AS c, unnest(mbt) AS d FROM m)
    WHERE d > 0
),
deaths AS (
    SELECT match_id, {sgn} AS sgn, d::BIGINT AS d, dur::BIGINT AS dur
    FROM (SELECT match_id, team, unnest(death_t) AS d, unnest(death_len) AS dur FROM players)
),
leavers AS (
    SELECT match_id, {sgn} AS sgn, ab::BIGINT AS ab FROM players WHERE ab > 0
),
obj_diff AS (
    SELECT g.match_id, g.t,
           coalesce(sum(sgn) FILTER (WHERE kind = 'guardians'), 0)      AS guardians,
           coalesce(sum(sgn) FILTER (WHERE kind = 'walkers'), 0)        AS walkers,
           coalesce(sum(sgn) FILTER (WHERE kind = 'base_guardians'), 0) AS base_guardians,
           coalesce(sum(sgn) FILTER (WHERE kind = 'shrines'), 0)        AS shrines
    FROM mt g LEFT JOIN objs o ON o.match_id = g.match_id AND o.d <= g.t AND o.kind IS NOT NULL
    GROUP BY ALL
),
lane_state AS (     -- per lane and side: objectives destroyed so far (Guardian, Walker, Base Guardian)
    SELECT g.match_id, g.t, o.sgn, o.lane, count(*) AS depth,
           count(*) FILTER (WHERE o.kind IN ('guardians', 'walkers')) AS outer_n
    FROM mt g JOIN objs o ON o.match_id = g.match_id AND o.d <= g.t AND o.kind IS NOT NULL AND o.lane <> ''
    GROUP BY ALL
),
lane_diff AS (
    SELECT match_id, t,
           sum(CASE WHEN outer_n >= 2 THEN sgn ELSE 0 END) AS open_lanes,
           coalesce(max(depth) FILTER (WHERE sgn = 1), 0) - coalesce(max(depth) FILTER (WHERE sgn = -1), 0) AS deepest_push
    FROM lane_state GROUP BY ALL
),
boss_diff AS (
    SELECT g.match_id, g.t, coalesce(sum(sgn), 0) AS mid_boss
    FROM mt g LEFT JOIN boss b ON b.match_id = g.match_id AND b.d <= g.t
    GROUP BY ALL
),
death_diff AS (     -- players dead at t, seconds until they respawn, and seconds spent dead up to t
    SELECT g.match_id, g.t,
           coalesce(sum(x.sgn) FILTER (WHERE g.t < x.d + x.dur), 0)     AS dead_now,
           coalesce(sum(x.sgn * (x.d + x.dur - g.t)) FILTER (WHERE g.t < x.d + x.dur), 0) AS respawn_left,
           coalesce(sum(x.sgn * least(x.dur, g.t - x.d)), 0)            AS dead_time
    FROM mt g LEFT JOIN deaths x ON x.match_id = g.match_id AND x.d <= g.t
    GROUP BY ALL
),
leave_diff AS (
    SELECT g.match_id, g.t, coalesce(sum(l.sgn), 0) AS abandons
    FROM mt g LEFT JOIN leavers l ON l.match_id = g.match_id AND l.ab <= g.t
    GROUP BY ALL
)
SELECT g.match_id, (g.t / 60)::INT AS minute, m.queue, {rank} AS rank, m.team0_won,
       g.souls, g.total_souls, g.kills, g.levels, g.last_hits, g.denies, g.hero_damage,
       g.objective_damage, g.enemy_souls_lost, g.carry_concentration, g.momentum,
       o.guardians, o.walkers, o.base_guardians, o.shrines, b.mid_boss,
       coalesce(ld.open_lanes, 0) AS open_lanes, coalesce(ld.deepest_push, 0) AS deepest_push,
       -x.respawn_left AS enemy_respawn,
       m.low_pri, m.new_player, m.wide_party,
       -- sign flipped so that, like every other factor, positive = good for team0
       -x.dead_now AS enemies_dead, -x.dead_time AS enemy_dead_time, -l.abandons AS enemy_abandons,
       m.rank_gap, m.heroes0, m.heroes1, m.accounts0, m.accounts1
FROM d2 g
JOIN m USING (match_id)
JOIN obj_diff o USING (match_id, t)
JOIN boss_diff b USING (match_id, t)
JOIN death_diff x USING (match_id, t)
JOIN leave_diff l USING (match_id, t)
LEFT JOIN lane_diff ld USING (match_id, t)
"""


# History, one lake query per day (cached). Summed over the days before a match
# day for the player and draft factors; never includes the match day itself.
HISTORY_RAW_SQL = """
SELECT match_id, account_id::BIGINT AS account_id, hero_id::INT AS hero_id, team::VARCHAR AS team, won,
       net_worth, duration_s
FROM dl.main.match_player
WHERE start_time >= TIMESTAMPTZ '{day} 00:00:00+00'
  AND start_time <  TIMESTAMPTZ '{next_day} 00:00:00+00'
  AND game_mode = 'Normal'
  AND match_mode IN ('Ranked', 'Unranked')
  AND match_outcome = 'TeamWin'
  AND duration_s >= {min_duration}
QUALIFY row_number() OVER (PARTITION BY match_id, hero_id ORDER BY player_slot) = 1
"""

# Per player and hero: games, wins, and the sum of souls per minute.
PLAYER_HERO_SQL = """
SELECT account_id, hero_id, count(*)::INT AS n, sum(won::INT)::INT AS wins,
       sum(net_worth * 60.0 / duration_s) AS spm
FROM ph_raw WHERE account_id > 0 GROUP BY ALL
"""

# Per hero pair (h1 < h2), on the same team or on opposite teams: games and wins of h1's side.
HERO_PAIR_SQL = """
SELECT a.hero_id AS h1, b.hero_id AS h2, (a.team = b.team) AS same,
       count(*)::INT AS n, sum(a.won::INT)::INT AS wins
FROM ph_raw a JOIN ph_raw b ON a.match_id = b.match_id AND a.hero_id < b.hero_id
GROUP BY ALL
"""
