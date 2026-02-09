-- WordBlitz Database Schema
-- A Wordle-style 5-letter word guessing game

BEGIN;

-- Dictionary of valid 5-letter words that can be used as target or guess words.
CREATE TABLE IF NOT EXISTS words (
    id    SERIAL PRIMARY KEY,
    word  VARCHAR(5) NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_words_word ON words (word);

-- Players identified by a browser fingerprint derived from
-- SHA-256(IP + User-Agent + Accept-Language).
CREATE TABLE IF NOT EXISTS players (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    fingerprint VARCHAR(64) NOT NULL UNIQUE,
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_players_fingerprint ON players (fingerprint);

-- Each game assigns one target word to a player.
-- Status tracks whether the game is still in progress, won, or lost.
CREATE TABLE IF NOT EXISTS games (
    id           SERIAL PRIMARY KEY,
    player_id    INTEGER     NOT NULL REFERENCES players(id),
    word_id      INTEGER     NOT NULL REFERENCES words(id),
    status       VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'won', 'lost')),
    num_guesses  INTEGER     NOT NULL DEFAULT 0,
    created_at   TIMESTAMP   NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_games_player_id ON games (player_id);
CREATE INDEX IF NOT EXISTS idx_games_status    ON games (status);

-- Individual guesses within a game (max 6 per game).
-- result is a JSONB array of objects: [{letter, status}]
-- where status is one of 'correct', 'present', 'absent'.
CREATE TABLE IF NOT EXISTS guesses (
    id           SERIAL PRIMARY KEY,
    game_id      INTEGER    NOT NULL REFERENCES games(id),
    guess_word   VARCHAR(5) NOT NULL,
    guess_number INTEGER    NOT NULL CHECK (guess_number BETWEEN 1 AND 6),
    result       JSONB      NOT NULL,
    created_at   TIMESTAMP  NOT NULL DEFAULT NOW(),
    UNIQUE (game_id, guess_number)
);

-- Leaderboard view providing aggregated player statistics.
-- current_streak: number of consecutive wins ending at the most recent game.
-- best_streak:    longest consecutive-win run across all completed games.
CREATE OR REPLACE VIEW leaderboard_stats AS
WITH completed_games AS (
    -- All finished games ordered chronologically per player
    SELECT
        g.player_id,
        g.id AS game_id,
        g.status,
        g.num_guesses,
        g.completed_at,
        ROW_NUMBER() OVER (PARTITION BY g.player_id ORDER BY g.completed_at) AS rn
    FROM games g
    WHERE g.status IN ('won', 'lost')
),
streak_groups AS (
    -- Assign a group id that increments each time a player loses,
    -- so consecutive wins share the same group.
    SELECT
        *,
        rn - ROW_NUMBER() OVER (
            PARTITION BY player_id, status ORDER BY completed_at
        ) AS streak_grp
    FROM completed_games
),
streaks AS (
    SELECT
        player_id,
        streak_grp,
        COUNT(*)           AS streak_len,
        MAX(completed_at)  AS streak_end
    FROM streak_groups
    WHERE status = 'won'
    GROUP BY player_id, streak_grp
),
best AS (
    SELECT
        player_id,
        MAX(streak_len) AS best_streak
    FROM streaks
    GROUP BY player_id
),
current AS (
    -- Current streak: the streak that includes the very last completed game,
    -- but only if that last game was a win; otherwise 0.
    SELECT
        cg.player_id,
        COALESCE(s.streak_len, 0) AS current_streak
    FROM (
        SELECT DISTINCT ON (player_id)
            player_id, game_id, status
        FROM completed_games
        ORDER BY player_id, rn DESC
    ) cg
    LEFT JOIN streak_groups sg
        ON sg.player_id = cg.player_id AND sg.game_id = cg.game_id
    LEFT JOIN streaks s
        ON s.player_id = sg.player_id AND s.streak_grp = sg.streak_grp
            AND cg.status = 'won'
)
SELECT
    p.id AS player_id,
    p.name,
    COUNT(*) FILTER (WHERE cg.status = 'won')  AS games_won,
    COUNT(*)                                     AS games_played,
    ROUND(AVG(cg.num_guesses) FILTER (WHERE cg.status = 'won'), 2)
                                                 AS avg_guesses_per_win,
    COALESCE(cur.current_streak, 0)              AS current_streak,
    COALESCE(b.best_streak, 0)                   AS best_streak
FROM players p
JOIN completed_games cg ON cg.player_id = p.id
LEFT JOIN current cur   ON cur.player_id = p.id
LEFT JOIN best b        ON b.player_id   = p.id
GROUP BY p.id, p.name, cur.current_streak, b.best_streak
ORDER BY games_won DESC, avg_guesses_per_win ASC;

COMMIT;
