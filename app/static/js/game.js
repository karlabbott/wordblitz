(function () {
  'use strict';

  // --- State ---
  let currentRow = 0;
  let currentCol = 0;
  let gameOver = false;
  let currentGameId = null;
  let playerRegistered = false;
  let isAnimating = false;
  const keyboardState = {};

  // --- DOM refs ---
  const board = document.getElementById('game-board');
  const keyboard = document.getElementById('keyboard');
  const modal = document.getElementById('registration-modal');
  const nameInput = document.getElementById('player-name-input');
  const registerBtn = document.getElementById('register-btn');
  const newWordBtn = document.getElementById('new-word-btn');
  const playerNameEl = document.getElementById('player-name');
  const toastContainer = document.getElementById('toast-container');

  // --- Init ---
  async function init() {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = await res.json();
        playerRegistered = true;
        playerNameEl.textContent = data.name || '';
        await loadCurrentGame();
      } else if (res.status === 404) {
        showModal();
      }
    } catch (e) {
      showModal();
    }
  }

  // --- Modal ---
  function showModal() {
    modal.style.display = 'flex';
    setTimeout(() => nameInput.focus(), 100);
  }

  function hideModal() {
    modal.style.display = 'none';
  }

  registerBtn.addEventListener('click', handleRegister);
  nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleRegister();
  });

  async function handleRegister() {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name })
      });
      if (res.ok) {
        const data = await res.json();
        playerRegistered = true;
        playerNameEl.textContent = data.name || name;
        hideModal();
        await startNewGame();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Registration failed', 3000);
      }
    } catch (e) {
      showToast('Connection error', 3000);
    }
  }

  // --- Game loading ---
  async function loadCurrentGame() {
    try {
      const res = await fetch('/api/game/current');
      if (res.ok) {
        const data = await res.json();
        currentGameId = data.id || data.game_id;
        restoreBoard(data);
      } else {
        await startNewGame();
      }
    } catch (e) {
      await startNewGame();
    }
  }

  async function startNewGame() {
    try {
      const res = await fetch('/api/game/new', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        currentGameId = data.id || data.game_id;
        resetBoard();
      }
    } catch (e) {
      showToast('Failed to start game', 3000);
    }
  }

  function restoreBoard(data) {
    resetBoard();
    const guesses = data.guesses || [];
    for (let r = 0; r < guesses.length; r++) {
      const guess = guesses[r];
      const word = guess.word || guess.guess || '';
      const result = guess.result || guess.letters || [];
      for (let c = 0; c < 5; c++) {
        const tile = getTile(r, c);
        tile.textContent = word[c] ? word[c].toUpperCase() : '';
        if (result[c]) {
          const state = result[c].status || result[c].state || result[c];
          tile.setAttribute('data-state', state);
          updateKeyboardKey(word[c].toUpperCase(), state);
        }
      }
      currentRow = r + 1;
    }
    currentCol = 0;

    if (data.status === 'won') {
      gameOver = true;
      newWordBtn.style.display = 'inline-block';
    } else if (data.status === 'lost') {
      gameOver = true;
      newWordBtn.style.display = 'inline-block';
      if (data.answer) {
        showToast('The word was: ' + data.answer.toUpperCase(), 5000);
      }
    }
  }

  // --- Board helpers ---
  function getTile(row, col) {
    return board.querySelector(`.tile[data-row="${row}"][data-col="${col}"]`);
  }

  function getRow(row) {
    return board.querySelector(`.board-row[data-row="${row}"]`);
  }

  function resetBoard() {
    currentRow = 0;
    currentCol = 0;
    gameOver = false;
    isAnimating = false;
    newWordBtn.style.display = 'none';

    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 5; c++) {
        const tile = getTile(r, c);
        tile.textContent = '';
        tile.removeAttribute('data-state');
        tile.classList.remove('flip', 'bounce');
      }
      const row = getRow(r);
      if (row) row.classList.remove('shake');
    }

    // Reset keyboard
    Object.keys(keyboardState).forEach(k => delete keyboardState[k]);
    keyboard.querySelectorAll('.key').forEach(key => {
      key.removeAttribute('data-state');
    });
  }

  // --- Input handling ---
  function handleKey(key) {
    if (gameOver || isAnimating) return;
    if (modal.style.display === 'flex') return;

    if (key === 'ENTER') {
      submitGuess();
    } else if (key === 'BACKSPACE') {
      deleteLetter();
    } else if (/^[A-Z]$/.test(key)) {
      addLetter(key);
    }
  }

  function addLetter(letter) {
    if (currentCol >= 5) return;
    const tile = getTile(currentRow, currentCol);
    tile.textContent = letter;
    tile.setAttribute('data-state', 'tbd');
    currentCol++;
  }

  function deleteLetter() {
    if (currentCol <= 0) return;
    currentCol--;
    const tile = getTile(currentRow, currentCol);
    tile.textContent = '';
    tile.removeAttribute('data-state');
  }

  async function submitGuess() {
    if (currentCol < 5) {
      shakeRow(currentRow);
      showToast('Not enough letters');
      return;
    }

    let word = '';
    for (let c = 0; c < 5; c++) {
      word += getTile(currentRow, c).textContent;
    }
    word = word.toLowerCase();

    isAnimating = true;
    try {
      const res = await fetch('/api/game/guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guess: word })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        isAnimating = false;
        shakeRow(currentRow);
        showToast(err.error || 'Not in word list');
        return;
      }

      const data = await res.json();
      const guessData = data.guess || {};
      const result = guessData.result || [];

      await revealRow(currentRow, word.toUpperCase(), result);

      if (data.status === 'won') {
        gameOver = true;
        await bounceRow(currentRow);
        const messages = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
        showToast(messages[currentRow] || 'You won!', 3000);
        currentRow++;
        newWordBtn.style.display = 'inline-block';
      } else if (data.status === 'lost') {
        gameOver = true;
        currentRow++;
        const answer = (data.answer || '').toUpperCase();
        showToast('The word was: ' + answer, 5000);
        newWordBtn.style.display = 'inline-block';
      } else {
        currentRow++;
        currentCol = 0;
      }
      isAnimating = false;
    } catch (e) {
      isAnimating = false;
      showToast('Connection error', 3000);
    }
  }

  // --- Animations ---
  function revealRow(row, word, result) {
    return new Promise(resolve => {
      const tiles = [];
      for (let c = 0; c < 5; c++) {
        tiles.push(getTile(row, c));
      }

      let revealed = 0;
      tiles.forEach((tile, i) => {
        setTimeout(() => {
          tile.classList.add('flip');

          // Halfway through flip, change color
          setTimeout(() => {
            const state = result[i].status || result[i].state || result[i];
            tile.removeAttribute('data-state');
            tile.setAttribute('data-state', state);
            updateKeyboardKey(word[i], state);
          }, 250);

          tile.addEventListener('animationend', function handler() {
            tile.classList.remove('flip');
            tile.removeEventListener('animationend', handler);
            revealed++;
            if (revealed === 5) resolve();
          });
        }, i * 300);
      });
    });
  }

  function bounceRow(row) {
    return new Promise(resolve => {
      const tiles = [];
      for (let c = 0; c < 5; c++) tiles.push(getTile(row, c));

      let bounced = 0;
      tiles.forEach((tile, i) => {
        setTimeout(() => {
          tile.classList.add('bounce');
          tile.addEventListener('animationend', function handler() {
            tile.classList.remove('bounce');
            tile.removeEventListener('animationend', handler);
            bounced++;
            if (bounced === 5) resolve();
          });
        }, i * 100);
      });
    });
  }

  function shakeRow(row) {
    const rowEl = getRow(row);
    if (!rowEl) return;
    rowEl.classList.remove('shake');
    void rowEl.offsetWidth; // force reflow
    rowEl.classList.add('shake');
    rowEl.addEventListener('animationend', function handler() {
      rowEl.classList.remove('shake');
      rowEl.removeEventListener('animationend', handler);
    });
  }

  // --- Keyboard color tracking ---
  const stateRank = { absent: 1, present: 2, correct: 3 };

  function updateKeyboardKey(letter, state) {
    letter = letter.toUpperCase();
    const current = keyboardState[letter];
    const currentRank = current ? stateRank[current] || 0 : 0;
    const newRank = stateRank[state] || 0;

    if (newRank > currentRank) {
      keyboardState[letter] = state;
      const keyEl = keyboard.querySelector(`.key[data-key="${letter}"]`);
      if (keyEl) keyEl.setAttribute('data-state', state);
    }
  }

  // --- Toast ---
  function showToast(message, duration) {
    duration = duration || 2000;
    const toast = document.createElement('div');
    toast.classList.add('toast');
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => {
        toast.remove();
      });
    }, duration);
  }

  // --- New Word button ---
  newWordBtn.addEventListener('click', async function () {
    newWordBtn.style.display = 'none';
    await startNewGame();
  });

  // --- Physical keyboard ---
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (modal.style.display === 'flex') return;

    if (e.key === 'Enter') {
      e.preventDefault();
      handleKey('ENTER');
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      handleKey('BACKSPACE');
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      handleKey(e.key.toUpperCase());
    }
  });

  // --- On-screen keyboard (click + touch) ---
  keyboard.addEventListener('click', function (e) {
    const keyEl = e.target.closest('.key');
    if (!keyEl) return;
    handleKey(keyEl.dataset.key);
  });

  // Prevent double-tap zoom and scrolling on mobile keyboard
  keyboard.addEventListener('touchend', function (e) {
    e.preventDefault();
    const keyEl = e.target.closest('.key');
    if (!keyEl) return;
    handleKey(keyEl.dataset.key);
  });

  // --- Start ---
  init();
})();
