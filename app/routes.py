import hashlib
import json
import time
from datetime import datetime, timezone

from flask import Blueprint, jsonify, make_response, render_template, request

from .config import Config
from .db import execute_db, query_db

bp = Blueprint('main', __name__)

ROUND_SECONDS = Config.RACE_ROUND_SECONDS
COOKIE_NAME = 'wb_player'
COOKIE_MAX_AGE = 12 * 60 * 60  # 12 hours


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compute_fingerprint() -> str:
    """SHA-256 hash of IP + User-Agent + Accept-Language."""
    ip = request.headers.get('X-Forwarded-For', request.remote_addr or '')
    if ',' in ip:
        ip = ip.split(',')[0].strip()
    raw = (
        ip
        + (request.headers.get('User-Agent', ''))
        + (request.headers.get('Accept-Language', ''))
    )
    return hashlib.sha256(raw.encode()).hexdigest()


def get_fingerprint() -> str:
    """Return player fingerprint from cookie (preferred) or computed hash."""
    cookie_fp = request.cookies.get(COOKIE_NAME)
    if cookie_fp:
        # Verify the cookie maps to a real player
        player = _player_by_fingerprint(cookie_fp)
        if player:
            return cookie_fp
    return _compute_fingerprint()


def _set_player_cookie(response, fingerprint: str):
    """Set a 12-hour cookie with the player fingerprint."""
    response.set_cookie(
        COOKIE_NAME,
        fingerprint,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite='Lax',
    )


def _player_by_fingerprint(fp: str):
    return query_db(
        'SELECT id, name, fingerprint, created_at FROM players WHERE fingerprint = %s',
        (fp,),
        one=True,
    )


def _serialize_player(p: dict) -> dict:
    return {
        'id': p['id'],
        'name': p['name'],
        'fingerprint': p['fingerprint'],
        'created_at': p['created_at'].isoformat(),
    }


def _evaluate_guess(guess: str, target: str):
    """Return a list of {letter, status} dicts for each position.

    Algorithm:
      1. First pass  – mark exact matches as 'correct'.
      2. Second pass – for remaining letters, mark as 'present' (consuming
         one occurrence in the target) or 'absent'.
    """
    result = [None] * 5
    target_remaining = list(target)

    # First pass: correct
    for i in range(5):
        if guess[i] == target[i]:
            result[i] = {'letter': guess[i], 'status': 'correct'}
            target_remaining[i] = None  # consumed

    # Second pass: present / absent
    for i in range(5):
        if result[i] is not None:
            continue
        letter = guess[i]
        if letter in target_remaining:
            result[i] = {'letter': letter, 'status': 'present'}
            target_remaining[target_remaining.index(letter)] = None
        else:
            result[i] = {'letter': letter, 'status': 'absent'}

    return result


# ---------------------------------------------------------------------------
# Race round helpers
# ---------------------------------------------------------------------------

def _current_round_number() -> int:
    """Deterministic round number from epoch time."""
    return int(time.time()) // ROUND_SECONDS


def _round_times(round_number: int):
    """Return (started_at, ends_at) as UTC datetimes for a round number."""
    start_ts = round_number * ROUND_SECONDS
    end_ts = start_ts + ROUND_SECONDS
    return (
        datetime.fromtimestamp(start_ts, tz=timezone.utc),
        datetime.fromtimestamp(end_ts, tz=timezone.utc),
    )


def _get_or_create_race_round(round_number: int):
    """Get or lazily create the race round row. Returns dict with id, word_id, started_at, ends_at."""
    row = query_db(
        'SELECT id, round_number, word_id, started_at, ends_at '
        'FROM race_rounds WHERE round_number = %s',
        (round_number,),
        one=True,
    )
    if row:
        return row

    started_at, ends_at = _round_times(round_number)
    # Pick a word not used in recent rounds to avoid repeats
    word = query_db(
        'SELECT id, word FROM words '
        'WHERE id NOT IN ('
        '  SELECT word_id FROM race_rounds '
        '  ORDER BY round_number DESC LIMIT 200'
        ') ORDER BY RANDOM() LIMIT 1',
        one=True,
    )
    if not word:
        word = query_db('SELECT id, word FROM words ORDER BY RANDOM() LIMIT 1', one=True)

    # Use ON CONFLICT for race-condition safety
    row = execute_db(
        'INSERT INTO race_rounds (round_number, word_id, started_at, ends_at) '
        'VALUES (%s, %s, %s, %s) '
        'ON CONFLICT (round_number) DO UPDATE SET round_number = race_rounds.round_number '
        'RETURNING id, round_number, word_id, started_at, ends_at',
        (round_number, word['id'], started_at, ends_at),
    )
    return row


def _expire_race_game_if_needed(player_id: int):
    """If the player has an active race game from a past round, auto-lose it."""
    active = query_db(
        'SELECT g.id, g.race_round_id, rr.ends_at '
        'FROM games g '
        'JOIN race_rounds rr ON rr.id = g.race_round_id '
        'WHERE g.player_id = %s AND g.status = %s AND g.mode = %s',
        (player_id, 'active', 'race'),
        one=True,
    )
    if active and active['ends_at'].replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc):
        execute_db(
            'UPDATE games SET status = %s, completed_at = %s '
            'WHERE id = %s RETURNING id',
            ('lost', active['ends_at'], active['id']),
        )


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@bp.route('/')
def index():
    return render_template('index.html')


@bp.route('/leaderboard')
def leaderboard_page():
    return render_template('leaderboard.html')


# ---------------------------------------------------------------------------
# API routes
# ---------------------------------------------------------------------------

@bp.route('/api/register', methods=['POST'])
def register():
    data = request.get_json(silent=True) or {}
    name = data.get('name', '').strip()
    if not name:
        return jsonify({'error': 'Name is required'}), 400

    fp = get_fingerprint()

    existing = _player_by_fingerprint(fp)
    if existing:
        resp = make_response(jsonify({'error': 'Player already registered from this browser'}), 409)
        _set_player_cookie(resp, fp)
        return resp

    player = execute_db(
        'INSERT INTO players (name, fingerprint) VALUES (%s, %s) '
        'RETURNING id, name, fingerprint, created_at',
        (name, fp),
    )
    resp = make_response(jsonify(_serialize_player(player)), 201)
    _set_player_cookie(resp, fp)
    return resp


@bp.route('/api/me')
def me():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not found'}), 404
    resp = make_response(jsonify(_serialize_player(player)))
    _set_player_cookie(resp, fp)
    return resp


@bp.route('/api/game/new', methods=['POST'])
def new_game():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not registered'}), 401

    pid = player['id']
    data = request.get_json(silent=True) or {}
    mode = data.get('mode', 'race')
    if mode not in ('race', 'random'):
        mode = 'race'

    # Auto-expire any past-round race games
    _expire_race_game_if_needed(pid)

    if mode == 'race':
        rnd = _get_or_create_race_round(_current_round_number())

        # Check for existing active race game in this round
        active = query_db(
            'SELECT id, status, num_guesses, created_at FROM games '
            'WHERE player_id = %s AND race_round_id = %s AND status = %s',
            (pid, rnd['id'], 'active'),
            one=True,
        )
        if active:
            guesses = query_db(
                'SELECT guess_word, guess_number, result FROM guesses '
                'WHERE game_id = %s ORDER BY guess_number',
                (active['id'],),
            )
            return jsonify({
                'game_id': active['id'],
                'mode': 'race',
                'round_ends_at': rnd['ends_at'].isoformat() + 'Z'
                    if rnd['ends_at'].tzinfo is None else rnd['ends_at'].isoformat(),
                'guesses': [
                    {'guess': g['guess_word'], 'guess_number': g['guess_number'], 'result': g['result']}
                    for g in guesses
                ],
            })

        # Check if player already completed this round
        completed = query_db(
            'SELECT id FROM games WHERE player_id = %s AND race_round_id = %s AND status IN (%s, %s)',
            (pid, rnd['id'], 'won', 'lost'),
            one=True,
        )
        if completed:
            return jsonify({
                'error': 'Already played this round',
                'round_ends_at': rnd['ends_at'].isoformat() + 'Z'
                    if rnd['ends_at'].tzinfo is None else rnd['ends_at'].isoformat(),
            }), 409

        game = execute_db(
            'INSERT INTO games (player_id, word_id, race_round_id, mode) VALUES (%s, %s, %s, %s) '
            'RETURNING id, status, num_guesses, created_at',
            (pid, rnd['word_id'], rnd['id'], 'race'),
        )
        return jsonify({
            'game_id': game['id'],
            'mode': 'race',
            'round_ends_at': rnd['ends_at'].isoformat() + 'Z'
                if rnd['ends_at'].tzinfo is None else rnd['ends_at'].isoformat(),
            'guesses': [],
        }), 201

    else:
        # Random mode — original behavior
        # Cancel any active random game first
        execute_db(
            'UPDATE games SET status = %s, completed_at = NOW() '
            'WHERE player_id = %s AND mode = %s AND status = %s RETURNING id',
            ('lost', pid, 'random', 'active'),
        )

        word = query_db(
            'SELECT id, word FROM words '
            'WHERE id NOT IN (SELECT word_id FROM games WHERE player_id = %s) '
            'ORDER BY RANDOM() LIMIT 1',
            (pid,),
            one=True,
        )
        if not word:
            word = query_db('SELECT id, word FROM words ORDER BY RANDOM() LIMIT 1', one=True)
        if not word:
            return jsonify({'error': 'No words available'}), 500

        game = execute_db(
            'INSERT INTO games (player_id, word_id, mode) VALUES (%s, %s, %s) '
            'RETURNING id, status, num_guesses, created_at',
            (pid, word['id'], 'random'),
        )
        return jsonify({'game_id': game['id'], 'mode': 'random', 'guesses': []}), 201


@bp.route('/api/game/current')
def current_game():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not registered'}), 401

    pid = player['id']
    _expire_race_game_if_needed(pid)

    game = query_db(
        'SELECT g.id, g.status, g.num_guesses, g.created_at, g.mode, g.race_round_id '
        'FROM games g WHERE g.player_id = %s AND g.status = %s '
        'ORDER BY g.created_at DESC LIMIT 1',
        (pid, 'active'),
        one=True,
    )
    if not game:
        return jsonify({'error': 'No active game'}), 404

    guesses = query_db(
        'SELECT guess_word, guess_number, result FROM guesses '
        'WHERE game_id = %s ORDER BY guess_number',
        (game['id'],),
    )

    resp_data = {
        'game_id': game['id'],
        'status': game['status'],
        'mode': game['mode'],
        'num_guesses': game['num_guesses'],
        'guesses': [
            {'guess': g['guess_word'], 'guess_number': g['guess_number'], 'result': g['result']}
            for g in guesses
        ],
    }

    if game['race_round_id']:
        rnd = query_db(
            'SELECT ends_at FROM race_rounds WHERE id = %s',
            (game['race_round_id'],),
            one=True,
        )
        if rnd:
            ends = rnd['ends_at']
            resp_data['round_ends_at'] = ends.isoformat() + 'Z' if ends.tzinfo is None else ends.isoformat()

    return jsonify(resp_data)


@bp.route('/api/game/guess', methods=['POST'])
def guess():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not registered'}), 401

    game = query_db(
        'SELECT g.id, g.status, g.num_guesses, g.mode, g.race_round_id, w.word '
        'FROM games g JOIN words w ON w.id = g.word_id '
        'WHERE g.player_id = %s AND g.status = %s '
        'ORDER BY g.created_at DESC LIMIT 1',
        (player['id'], 'active'),
        one=True,
    )
    if not game:
        return jsonify({'error': 'No active game'}), 404

    # Enforce race timer
    if game['mode'] == 'race' and game['race_round_id']:
        rnd = query_db(
            'SELECT ends_at FROM race_rounds WHERE id = %s',
            (game['race_round_id'],),
            one=True,
        )
        if rnd:
            ends_at = rnd['ends_at']
            if ends_at.tzinfo is None:
                ends_at = ends_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) >= ends_at:
                execute_db(
                    'UPDATE games SET status = %s, completed_at = %s WHERE id = %s RETURNING id',
                    ('lost', rnd['ends_at'], game['id']),
                )
                return jsonify({
                    'error': 'Round expired',
                    'status': 'lost',
                    'answer': game['word'].upper(),
                    'game_id': game['id'],
                }), 410

    data = request.get_json(silent=True) or {}
    guess_word = data.get('guess', '').strip().lower()

    if len(guess_word) != 5 or not guess_word.isalpha():
        return jsonify({'error': 'Guess must be exactly 5 letters'}), 400

    # Validate against dictionary
    valid = query_db(
        'SELECT 1 FROM words WHERE word = %s',
        (guess_word,),
        one=True,
    )
    if not valid:
        return jsonify({'error': 'Not a valid word'}), 400

    target = game['word']
    guess_number = game['num_guesses'] + 1
    result = _evaluate_guess(guess_word, target)

    won = guess_word == target
    lost = guess_number == 6 and not won

    if won:
        new_status = 'won'
    elif lost:
        new_status = 'lost'
    else:
        new_status = 'active'

    # Insert guess row
    execute_db(
        'INSERT INTO guesses (game_id, guess_word, guess_number, result) '
        'VALUES (%s, %s, %s, %s)',
        (game['id'], guess_word, guess_number, json.dumps(result)),
    )

    # Update game
    if new_status in ('won', 'lost'):
        execute_db(
            'UPDATE games SET num_guesses = %s, status = %s, completed_at = NOW() '
            'WHERE id = %s RETURNING id',
            (guess_number, new_status, game['id']),
        )
    else:
        execute_db(
            'UPDATE games SET num_guesses = %s WHERE id = %s RETURNING id',
            (guess_number, game['id']),
        )

    # Build response
    all_guesses = query_db(
        'SELECT guess_word, guess_number, result FROM guesses '
        'WHERE game_id = %s ORDER BY guess_number',
        (game['id'],),
    )

    resp = {
        'game_id': game['id'],
        'status': new_status,
        'mode': game['mode'],
        'num_guesses': guess_number,
        'guess': {
            'guess': guess_word,
            'guess_number': guess_number,
            'result': result,
        },
        'guesses': [
            {'guess': g['guess_word'], 'guess_number': g['guess_number'], 'result': g['result']}
            for g in all_guesses
        ],
    }

    if lost:
        resp['answer'] = target

    return jsonify(resp)


@bp.route('/api/leaderboard')
def leaderboard():
    champions = query_db(
        'SELECT name, games_won, games_played, avg_guesses_per_win, '
        '       current_streak, best_streak '
        'FROM leaderboard_stats '
        'WHERE games_won >= 5 '
        'ORDER BY avg_guesses_per_win ASC '
        'LIMIT 20',
    )
    prolific = query_db(
        'SELECT name, games_won, games_played, avg_guesses_per_win, '
        '       current_streak, best_streak '
        'FROM leaderboard_stats '
        'ORDER BY games_won DESC '
        'LIMIT 20',
    )

    def _serialize(rows):
        return [
            {
                'name': r['name'],
                'games_won': r['games_won'],
                'games_played': r['games_played'],
                'avg_guesses_per_win': float(r['avg_guesses_per_win'])
                if r['avg_guesses_per_win'] is not None
                else None,
                'current_streak': r['current_streak'],
                'best_streak': r['best_streak'],
            }
            for r in rows
        ]

    return jsonify({
        'champions': _serialize(champions),
        'prolific': _serialize(prolific),
    })


@bp.route('/api/stats')
def stats():
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if not player:
        return jsonify({'error': 'Player not found'}), 404

    row = query_db(
        'SELECT games_won, games_played, avg_guesses_per_win, '
        '       current_streak, best_streak '
        'FROM leaderboard_stats '
        'WHERE player_id = %s',
        (player['id'],),
        one=True,
    )

    if not row:
        return jsonify({
            'games_won': 0,
            'games_lost': 0,
            'avg_guesses': None,
            'current_streak': 0,
            'best_streak': 0,
        })

    return jsonify({
        'games_won': row['games_won'],
        'games_lost': row['games_played'] - row['games_won'],
        'avg_guesses': float(row['avg_guesses_per_win'])
        if row['avg_guesses_per_win'] is not None
        else None,
        'current_streak': row['current_streak'],
        'best_streak': row['best_streak'],
    })


# ---------------------------------------------------------------------------
# Race endpoints
# ---------------------------------------------------------------------------

@bp.route('/api/race/status')
def race_status():
    """Return current race round info and seconds remaining."""
    rn = _current_round_number()
    rnd = _get_or_create_race_round(rn)
    ends_at = rnd['ends_at']
    if ends_at.tzinfo is None:
        ends_at = ends_at.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    remaining = max(0, int((ends_at - now).total_seconds()))

    # Check if current player already played this round
    played = False
    player_result = None
    fp = get_fingerprint()
    player = _player_by_fingerprint(fp)
    if player:
        game = query_db(
            'SELECT id, status, num_guesses FROM games '
            'WHERE player_id = %s AND race_round_id = %s',
            (player['id'], rnd['id']),
            one=True,
        )
        if game:
            played = True
            player_result = game['status']

    return jsonify({
        'round_number': rnd['round_number'],
        'round_id': rnd['id'],
        'round_ends_at': rnd['ends_at'].isoformat() + 'Z'
            if rnd['ends_at'].tzinfo is None else rnd['ends_at'].isoformat(),
        'seconds_remaining': remaining,
        'round_seconds': ROUND_SECONDS,
        'played': played,
        'player_result': player_result,
    })


@bp.route('/api/race/leaderboard')
def race_leaderboard():
    """Return race results for current and recent rounds."""
    rn = _current_round_number()

    # Get last N rounds of results
    rounds_back = request.args.get('rounds', '5', type=str)
    try:
        limit = min(int(rounds_back), 20)
    except ValueError:
        limit = 5

    rows = query_db(
        'SELECT round_id, round_number, round_word, started_at, ends_at, '
        '       player_name, status, num_guesses, solve_duration '
        'FROM race_round_results '
        'WHERE round_number >= %s '
        'ORDER BY round_number DESC, status ASC, num_guesses ASC, solve_duration ASC',
        (rn - limit,),
    )

    # Group by round
    rounds = {}
    for r in rows:
        rn_key = r['round_number']
        if rn_key not in rounds:
            rounds[rn_key] = {
                'round_number': rn_key,
                'round_id': r['round_id'],
                'word': r['round_word'],
                'started_at': r['started_at'].isoformat() + 'Z'
                    if r['started_at'].tzinfo is None else r['started_at'].isoformat(),
                'players': [],
            }
        duration = None
        if r['solve_duration'] is not None:
            duration = r['solve_duration'].total_seconds()
        rounds[rn_key]['players'].append({
            'name': r['player_name'],
            'status': r['status'],
            'num_guesses': r['num_guesses'],
            'solve_seconds': duration,
        })

    # Sort rounds descending
    sorted_rounds = sorted(rounds.values(), key=lambda x: x['round_number'], reverse=True)
    return jsonify({'rounds': sorted_rounds})
