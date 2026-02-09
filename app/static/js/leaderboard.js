(function () {
  'use strict';

  const championsBody = document.getElementById('champions-body');
  const prolificBody = document.getElementById('prolific-body');
  const playerNameEl = document.getElementById('player-name');

  const statPlayed = document.getElementById('stat-played');
  const statWon = document.getElementById('stat-won');
  const statWinRate = document.getElementById('stat-win-rate');
  const statAvgGuesses = document.getElementById('stat-avg-guesses');
  const statStreak = document.getElementById('stat-streak');

  async function loadPlayerInfo() {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = await res.json();
        playerNameEl.textContent = data.name || '';
      }
    } catch (e) {
      // ignore
    }
  }

  async function loadLeaderboard() {
    try {
      const res = await fetch('/api/leaderboard');
      if (!res.ok) return;
      const data = await res.json();

      // Champions table
      const champions = data.champions || data.best_average || [];
      if (champions.length === 0) {
        championsBody.innerHTML = '<tr><td colspan="4" class="empty-message">No champions yet. Play at least 5 games!</td></tr>';
      } else {
        championsBody.innerHTML = champions.map(function (p, i) {
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(p.name) + '</td>' +
            '<td>' + (p.avg_guesses_per_win != null ? Number(p.avg_guesses_per_win).toFixed(2) : (p.avg_guesses != null ? Number(p.avg_guesses).toFixed(2) : '-')) + '</td>' +
            '<td>' + (p.games_won != null ? p.games_won : '-') + '</td>' +
            '</tr>';
        }).join('');
      }

      // Most Prolific table
      const prolific = data.prolific || data.most_prolific || [];
      if (prolific.length === 0) {
        prolificBody.innerHTML = '<tr><td colspan="4" class="empty-message">No data yet. Start playing!</td></tr>';
      } else {
        prolificBody.innerHTML = prolific.map(function (p, i) {
          var winRate = '-';
          if (p.games_won != null && p.games_played != null && p.games_played > 0) {
            winRate = Math.round((p.games_won / p.games_played) * 100) + '%';
          }
          return '<tr>' +
            '<td>' + (i + 1) + '</td>' +
            '<td>' + escapeHtml(p.name) + '</td>' +
            '<td>' + (p.games_won != null ? p.games_won : '-') + '</td>' +
            '<td>' + winRate + '</td>' +
            '</tr>';
        }).join('');
      }
    } catch (e) {
      // ignore network errors silently
    }
  }

  async function loadPersonalStats() {
    try {
      const res = await fetch('/api/stats');
      if (!res.ok) {
        setStatsEmpty();
        return;
      }
      const data = await res.json();

      var gamesPlayed = (data.games_won || 0) + (data.games_lost || 0);
      statPlayed.textContent = gamesPlayed;
      statWon.textContent = data.games_won != null ? data.games_won : 0;

      if (gamesPlayed > 0) {
        statWinRate.textContent = Math.round(((data.games_won || 0) / gamesPlayed) * 100) + '%';
      } else {
        statWinRate.textContent = '-';
      }

      statAvgGuesses.textContent = data.avg_guesses != null ? Number(data.avg_guesses).toFixed(1) : '-';
      statStreak.textContent = data.current_streak != null ? data.current_streak : (data.streak != null ? data.streak : '-');
    } catch (e) {
      setStatsEmpty();
    }
  }

  function setStatsEmpty() {
    statPlayed.textContent = '-';
    statWon.textContent = '-';
    statWinRate.textContent = '-';
    statAvgGuesses.textContent = '-';
    statStreak.textContent = '-';
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function refreshAll() {
    await Promise.all([loadLeaderboard(), loadPersonalStats()]);
  }

  // Init
  loadPlayerInfo();
  refreshAll();
  setInterval(refreshAll, 30000);
})();
