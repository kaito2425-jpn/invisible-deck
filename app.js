/* Invisible Deck App - Phase 2
 * - SVG sprite (assets/cards-sheet.svg, 52 cards in 13x4 grid) loaded once into memory
 * - 13 hotspots over the standard 4-2-4 ten-card layout
 * - Slide / flip / zoom animations + history-aware random picks
 * - DeviceOrientation still deferred (button + long-press fallback)
 * - ?debug=1 enables debug overlay + state HUD + console logs
 */

(() => {
  'use strict';

  // ====== Config ======
  const DEBUG = new URLSearchParams(location.search).has('debug');
  // Hotspot radius is sized relative to the card's actual width so it tracks
  // viewport changes. ~9% of card width keeps each hotspot tightly on its pip
  // (no overlap with neighbours) while still being large enough for a fingertip.
  const HOTSPOT_RADIUS_PCT = 0.09;
  const SWIPE_MIN_DISTANCE = 50;        // px: below this, treat as tap
  const LONG_SWIPE_DISTANCE = 160;      // px: above this, ignore hotspot — always shuffle

  // ====== Globals ======
  const SUITS = ['spade', 'heart', 'club', 'diamond'];
  const SUIT_GLYPH = { spade: '♠', heart: '♥', club: '♣', diamond: '♦' };
  const SUIT_COLOR = { spade: 'black', heart: 'red', club: 'black', diamond: 'red' };
  const RANK_LABEL = {
    1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7',
    8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K'
  };
  const DIR_TO_SUIT = { up: 'diamond', right: 'heart', down: 'club', left: 'spade' };

  /** @typedef {{rank:number, suit:string}} Card */

  // ====== State ======
  const States = Object.freeze({
    INITIAL_SHUFFLE: 'INITIAL_SHUFFLE',
    BACK_SHUFFLE: 'BACK_SHUFFLE',
    READY_TO_ENCODE: 'READY_TO_ENCODE',
    ENCODED: 'ENCODED',
    AUDIENCE_SWIPING: 'AUDIENCE_SWIPING',
    FINISHED: 'FINISHED',
  });

  let currentState = States.INITIAL_SHUFFLE;
  /** @type {Card|null} */ let currentCard = null;
  /** @type {Card|null} */ let encodedCard = null;
  /** @type {Array<Card|{type:'back'}>|null} */ let audienceShuffleOrder = null;
  /** @type {number|null} */ let backCardPosition = null;
  let currentAudienceIndex = 0;
  let previousSuit = null;
  let previousAnyCard = null;   // last card shown in INITIAL_SHUFFLE for history-avoid
  let isAnimating = false;
  /** @type {number|null} */ let autoResetTimer = null;

  // ====== Card SVG cache ======
  // key = `${suit}_${rankNumber}` → string (full <svg> markup) cropped to the card's viewBox
  const CARD_SVG = new Map();
  let sheetLoaded = false;

  // ====== DOM ======
  const $wrap = document.getElementById('card-wrapper');
  const $card = document.getElementById('card');
  const $front = document.getElementById('card-front');
  const $back = document.getElementById('card-back');
  const $hotspots = document.getElementById('hotspot-layer');
  const $dbg = document.getElementById('debug-panel');
  const $dbgState = document.getElementById('dbg-state');
  const $dbgEncoded = document.getElementById('dbg-encoded');
  const $dbgIdx = document.getElementById('dbg-idx');
  const $dbgSwipe = document.getElementById('dbg-swipe');
  const $flipBtn = document.getElementById('tap-flip');

  // NOTE: DEBUG-mode UI init is deferred to boot(), after HOTSPOTS is defined.

  // ====== Card rendering ======
  // Sheet layout constants — match assets/cards-sheet.svg exactly.
  // Each card group has BBox(0.5, 512.86218, 359, 539) and translate(tx, ty).
  // Rows: 0=spade, 1=heart, 2=diamond, 3=club. Columns: 0=A, ..., 9=10, 10=J, 11=Q, 12=K.
  const SHEET = {
    bboxX: 0.5, bboxY: 512.86218, bboxW: 359, bboxH: 539,
    colStep: 390, rowStep: 570,
    col0Tx: 30, row0Ty: -482.36218,
    suitRow: { spade: 0, heart: 1, diamond: 2, club: 3 },
  };

  async function loadCardSheet() {
    if (sheetLoaded) return;
    const res = await fetch('assets/cards-sheet.svg');
    if (!res.ok) throw new Error('failed to load card sheet: ' + res.status);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const groups = doc.querySelectorAll('svg > g');
    if (groups.length < 52) throw new Error('card sheet has ' + groups.length + ' groups, expected 52');
    const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const suitsByRow = ['spade', 'heart', 'diamond', 'club'];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 13; col++) {
        const g = groups[row * 13 + col];
        const x = SHEET.bboxX + SHEET.col0Tx + col * SHEET.colStep - SHEET.col0Tx; // == bboxX (constant)
        // The bbox is the same for every card — only the transform's translate moves it.
        // After applying translate(tx, ty), the group appears at (bboxX+tx, bboxY+ty).
        const tx = SHEET.col0Tx + col * SHEET.colStep;
        const ty = SHEET.row0Ty + row * SHEET.rowStep;
        const vbX = SHEET.bboxX + tx;
        const vbY = SHEET.bboxY + ty;
        const inner = new XMLSerializer().serializeToString(g);
        const svgStr =
          '<svg xmlns="http://www.w3.org/2000/svg" ' +
          `viewBox="${vbX} ${vbY} ${SHEET.bboxW} ${SHEET.bboxH}" ` +
          'preserveAspectRatio="xMidYMid meet">' + inner + '</svg>';
        CARD_SVG.set(`${suitsByRow[row]}_${ranks[col]}`, svgStr);
      }
    }
    sheetLoaded = true;
    log('card sheet loaded, cards:', CARD_SVG.size);
  }

  function renderCard(card) {
    if (!card) { $front.innerHTML = ''; return; }
    const key = `${card.suit}_${card.rank}`;
    const svg = CARD_SVG.get(key);
    $front.classList.remove('red', 'black', 'simple');
    if (svg) {
      $front.innerHTML = svg;
    } else {
      // Fallback while sheet is still loading
      const glyph = SUIT_GLYPH[card.suit];
      const label = RANK_LABEL[card.rank];
      $front.classList.add(SUIT_COLOR[card.suit], 'simple');
      $front.innerHTML =
        `<div class="idx tl"><span class="rank">${label}</span><span class="suit">${glyph}</span></div>` +
        `<div class="idx br"><span class="rank">${label}</span><span class="suit">${glyph}</span></div>` +
        `<div class="big"><span class="rank">${label}</span><span class="suit">${glyph}</span></div>`;
    }
  }

  function showBackOnly() {
    // Set card to show only the back face by flipping the container
    $card.classList.add('flipped');
  }
  function showFrontOnly() {
    $card.classList.remove('flipped');
  }

  // ====== Hotspots ======
  /**
   * Hotspot layout — matches the standard 10-card pip placement of cards-sheet.svg
   *   J(11) = top-left index, K(13) = bottom-right index, Q(12) = center gap.
   *   Left column (top→bottom): 1, 2, 3, 4
   *   Center column (top, bottom): 5, 6
   *   Right column (top→bottom): 7, 8, 9, 10
   * Coordinates are percentages relative to the card box.
   */
  const HOTSPOTS = [
    { id: 11, xPct: 10, yPct: 11 },   // J - top-left index
    { id: 1,  xPct: 25, yPct: 19 },   // left col top
    { id: 2,  xPct: 25, yPct: 36 },   // left col upper-mid
    { id: 3,  xPct: 25, yPct: 64 },   // left col lower-mid
    { id: 4,  xPct: 25, yPct: 81 },   // left col bottom
    { id: 5,  xPct: 50, yPct: 27 },   // center top
    { id: 6,  xPct: 50, yPct: 73 },   // center bottom
    { id: 7,  xPct: 75, yPct: 19 },   // right col top
    { id: 8,  xPct: 75, yPct: 36 },   // right col upper-mid
    { id: 9,  xPct: 75, yPct: 64 },   // right col lower-mid
    { id: 10, xPct: 75, yPct: 81 },   // right col bottom
    { id: 12, xPct: 50, yPct: 50 },   // Q - center gap
    { id: 13, xPct: 90, yPct: 89 },   // K - bottom-right index
  ];

  function cardRect() {
    return $card.getBoundingClientRect();
  }

  function hotspotCenterPx(h) {
    const r = cardRect();
    return {
      x: r.left + (h.xPct / 100) * r.width,
      y: r.top  + (h.yPct / 100) * r.height,
    };
  }

  function hotspotRadiusPx() {
    return cardRect().width * HOTSPOT_RADIUS_PCT;
  }

  function detectHotspot(clientX, clientY) {
    const radius = hotspotRadiusPx();
    let best = null;
    let bestD2 = radius * radius;
    for (const h of HOTSPOTS) {
      const c = hotspotCenterPx(h);
      const dx = clientX - c.x, dy = clientY - c.y;
      const d2 = dx*dx + dy*dy;
      if (d2 <= bestD2) { best = h.id; bestD2 = d2; }
    }
    return best;
  }

  function buildHotspotOverlay() {
    $hotspots.innerHTML = '';
    for (const h of HOTSPOTS) {
      const el = document.createElement('div');
      el.className = 'hot';
      el.style.left = h.xPct + '%';
      el.style.top  = h.yPct + '%';
      el.textContent = String(h.id);
      $hotspots.appendChild(el);
    }
    positionHotspotLayer();
  }
  function positionHotspotLayer() {
    const r = cardRect();
    $hotspots.style.left = r.left + 'px';
    $hotspots.style.top  = r.top  + 'px';
    $hotspots.style.width = r.width + 'px';
    $hotspots.style.height = r.height + 'px';
    // size the overlay circles to match the actual hit-test radius
    const d = Math.round(hotspotRadiusPx() * 2);
    for (const el of $hotspots.querySelectorAll('.hot')) {
      el.style.width  = d + 'px';
      el.style.height = d + 'px';
      el.style.marginLeft = (-d/2) + 'px';
      el.style.marginTop  = (-d/2) + 'px';
    }
  }
  window.addEventListener('resize', () => { if (DEBUG) positionHotspotLayer(); });

  // ====== RNG helpers ======
  function pickRandomCard({ exclude = null } = {}) {
    while (true) {
      const rank = 1 + Math.floor(Math.random() * 13);
      const suit = SUITS[Math.floor(Math.random() * 4)];
      if (!exclude || exclude.rank !== rank || exclude.suit !== suit) {
        return { rank, suit };
      }
    }
  }
  function pickRandom10Card({ exclude = null, excludeSuit = null } = {}) {
    const pool = SUITS.filter(s => s !== excludeSuit);
    while (true) {
      const suit = pool[Math.floor(Math.random() * pool.length)];
      const card = { rank: 10, suit };
      if (!exclude || exclude.suit !== suit) return card;
    }
  }
  function shuffleAllCardsExcept(except) {
    const all = [];
    for (const s of SUITS) {
      for (let r = 1; r <= 13; r++) {
        if (except && except.rank === r && except.suit === s) continue;
        all.push({ rank: r, suit: s });
      }
    }
    // Fisher-Yates
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all;
  }

  // ====== State transitions ======
  function transitionTo(next) {
    currentState = next;
    log('state ->', next);
    updateDebugHUD();
    if (next === States.FINISHED) {
      clearTimeout(autoResetTimer);
      autoResetTimer = setTimeout(() => {
        if (currentState === States.FINISHED) {
          onFlipToBack();
        }
      }, 30000);
    }
  }

  function resetInternalState() {
    encodedCard = null;
    audienceShuffleOrder = null;
    backCardPosition = null;
    currentAudienceIndex = 0;
    clearTimeout(autoResetTimer);
    autoResetTimer = null;
  }

  function onFlipToBack() {
    if (currentState === States.INITIAL_SHUFFLE) {
      transitionTo(States.BACK_SHUFFLE);
      showBackOnly();
    } else if (
      currentState === States.READY_TO_ENCODE ||
      currentState === States.ENCODED ||
      currentState === States.AUDIENCE_SWIPING ||
      currentState === States.FINISHED
    ) {
      resetInternalState();
      // also clear finish animations
      $card.classList.remove('finish-flip', 'finish-zoom');
      transitionTo(States.BACK_SHUFFLE);
      showBackOnly();
    }
  }

  function onFlipToFront() {
    if (currentState === States.BACK_SHUFFLE) {
      currentCard = pickRandom10Card({ excludeSuit: previousSuit });
      previousSuit = currentCard.suit;
      renderCard(currentCard);
      showFrontOnly();
      transitionTo(States.READY_TO_ENCODE);
    }
  }

  // ====== Swipe handling (finger-tracking drag) ======
  // The card follows the finger in real time. Releasing snaps it back (if the
  // gesture was too short) or flicks it off-screen and brings in the next card
  // from the opposite side (if it crossed the commit threshold).
  let touchStart = null;
  let isDragging = false;
  const COMMIT_DISTANCE = 80;  // px: drag past this to commit (flick out + new card)

  function onPointerDown(clientX, clientY) {
    if (isAnimating) return;
    const hotspot = (currentState === States.READY_TO_ENCODE || currentState === States.ENCODED)
      ? detectHotspot(clientX, clientY)
      : null;
    touchStart = { x: clientX, y: clientY, hotspot, time: Date.now() };
    isDragging = true;
    // Stop any leftover slide animations and clear inline transforms cleanly.
    clearSlideClasses();
    $wrap.style.transition = 'none';
    $wrap.style.transform = '';
  }

  function onPointerMove(clientX, clientY) {
    if (!isDragging || !touchStart || isAnimating) return;
    const dx = clientX - touchStart.x;
    const dy = clientY - touchStart.y;
    // Light rotation tied to horizontal travel — feels card-like, not slab-like.
    const rot = Math.max(-12, Math.min(12, dx / 28));
    $wrap.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
  }

  function onPointerUp(clientX, clientY) {
    if (!touchStart || isAnimating) {
      isDragging = false;
      touchStart = null;
      $wrap.style.transition = '';
      return;
    }
    isDragging = false;
    const dx = clientX - touchStart.x;
    const dy = clientY - touchStart.y;
    const distance = Math.hypot(dx, dy);
    const hotspot = touchStart.hotspot;
    const isTap = distance < SWIPE_MIN_DISTANCE;
    touchStart = null;

    if (isTap) {
      snapBack();
      // Audience back-card reveal also triggers on a tap.
      if (currentState === States.AUDIENCE_SWIPING) {
        const item = audienceShuffleOrder[currentAudienceIndex];
        if (item && item.type === 'back') finishReveal();
      }
      return;
    }

    const direction = detectDirection(dx, dy);
    const isLong = distance >= LONG_SWIPE_DISTANCE;
    log('swipe', direction, 'hotspot=', hotspot, 'dist=', Math.round(distance), isLong ? '(long)' : '');
    if (DEBUG) {
      $dbgSwipe.textContent = `${direction} ${Math.round(distance)}px` + (hotspot ? ` @${hotspot}` : '') + (isLong ? ' (long)' : '');
    }

    // Encode: short, started inside a hotspot, in READY_TO_ENCODE.
    // The card snaps back so the audience sees no change.
    if (hotspot && !isLong && currentState === States.READY_TO_ENCODE) {
      encodedCard = { rank: hotspot, suit: DIR_TO_SUIT[direction] };
      transitionTo(States.ENCODED);
      log('encoded ->', encodedCard);
      updateDebugHUD();
      snapBack();
      if (DEBUG) replayAnim($wrap, 'encode-pulse');
      return;
    }

    // Below the commit threshold → cancel and snap back (gives the user
    // a "decided not to swipe" out, just like dragging a card halfway).
    if (distance < COMMIT_DISTANCE) {
      snapBack();
      return;
    }

    // Commit: continue the motion off-screen and load the next card.
    flickOutAndIn(direction, { dx, dy });
  }

  function detectDirection(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
    return dy > 0 ? 'down' : 'up';
  }

  /** Smoothly return the card to the resting position. */
  function snapBack() {
    $wrap.style.transition = 'transform 0.22s cubic-bezier(.2,.7,.3,1.2)';
    $wrap.style.transform = '';
    setTimeout(() => { $wrap.style.transition = ''; }, 240);
  }

  /**
   * Continue the drag's motion off-screen, update the card content while it's
   * hidden, then animate the new card in from the opposite side. The starting
   * dx/dy let us pick up from wherever the finger left off.
   */
  function flickOutAndIn(direction, { dx, dy }) {
    isAnimating = true;
    const w = window.innerWidth;
    const h = window.innerHeight;
    let tx = dx, ty = dy, rot = Math.max(-12, Math.min(12, dx / 28));
    // Target: well past the screen edge in the swipe direction.
    if (direction === 'right') { tx =  w * 1.2; rot =  14; }
    if (direction === 'left')  { tx = -w * 1.2; rot = -14; }
    if (direction === 'up')    { ty = -h * 1.2; }
    if (direction === 'down')  { ty =  h * 1.2; }
    $wrap.style.transition = 'transform 0.22s ease-in';
    $wrap.style.transform = `translate(${tx}px, ${ty}px) rotate(${rot}deg)`;

    setTimeout(() => {
      // Update DOM while the card is off-screen (no visible jump).
      updateCardForState(direction);
      // Reset transform instantly, then animate slide-in from the opposite side.
      $wrap.style.transition = 'none';
      $wrap.style.transform = '';
      void $wrap.offsetWidth;
      $wrap.style.transition = '';
      const pair = SLIDE_PAIRS[direction] || SLIDE_PAIRS.right;
      $wrap.classList.add(pair.in);
      setTimeout(() => {
        clearSlideClasses();
        isAnimating = false;
      }, 320);
    }, 220);
  }

  function updateCardForState(direction) {
    switch (currentState) {
      case States.INITIAL_SHUFFLE:
        currentCard = pickRandomCard({ exclude: previousAnyCard || currentCard });
        previousAnyCard = currentCard;
        renderCard(currentCard);
        break;
      case States.BACK_SHUFFLE:
        // No card change — still showing back face.
        break;
      case States.READY_TO_ENCODE:
        currentCard = pickRandom10Card({ excludeSuit: currentCard ? currentCard.suit : null });
        renderCard(currentCard);
        break;
      case States.ENCODED:
        startAudienceMode();
        transitionTo(States.AUDIENCE_SWIPING);
        renderAudienceCurrent();
        break;
      case States.AUDIENCE_SWIPING:
        if (currentAudienceIndex < audienceShuffleOrder.length - 1) {
          currentAudienceIndex++;
          renderAudienceCurrent();
        }
        break;
      // FINISHED: no-op
    }
  }

  function startAudienceMode() {
    audienceShuffleOrder = shuffleAllCardsExcept(encodedCard);
    backCardPosition = 7 + Math.floor(Math.random() * 7); // 7..13
    audienceShuffleOrder.splice(backCardPosition - 1, 0, { type: 'back' });
    currentAudienceIndex = 0;
    log('audience start. back at', backCardPosition);
  }

  function renderAudienceCurrent() {
    const item = audienceShuffleOrder[currentAudienceIndex];
    if (!item) return;
    if (item.type === 'back') {
      showBackOnly();
    } else {
      showFrontOnly();
      renderCard(item);
    }
    updateDebugHUD();
  }

  function advanceAudienceCard(direction = 'right') {
    if (currentAudienceIndex < audienceShuffleOrder.length - 1) {
      currentAudienceIndex++;
      animateSwap(() => { renderAudienceCurrent(); }, direction);
    }
  }

  function finishReveal() {
    isAnimating = true;
    // Pre-render the encoded card on the front face while it's hidden behind the back.
    renderCard(encodedCard);
    // Currently .flipped (rotateY 180deg) shows the back. Animate 180 -> 360 to reveal front.
    $card.style.animation = 'finishFlip180to360 1.5s ease-in-out forwards';
    setTimeout(() => {
      $card.style.animation = '';
      $card.classList.remove('flipped');
      // Reveal zoom: scale 1.0 → 1.05 → 1.0
      $card.animate(
        [{ transform: 'scale(1.0)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1.0)' }],
        { duration: 500, easing: 'ease-in-out' }
      );
      isAnimating = false;
      transitionTo(States.FINISHED);
    }, 1500);
  }

  // Inject the 180->360 keyframes once
  (function injectFinishKeyframes() {
    const css = `@keyframes finishFlip180to360 {
      0%   { transform: rotateY(180deg); }
      100% { transform: rotateY(360deg); }
    }`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  })();

  function replayAnim(el, klass) {
    el.classList.remove(klass);
    void el.offsetWidth; // reflow to restart animation
    el.classList.add(klass);
  }

  /**
   * Two-phase directional card swap: current card slides off in `direction`,
   * then the replacement enters from the opposite side. updateFn runs between
   * the two phases — that's when the DOM should mutate (renderCard, etc).
   *
   * direction: 'right' (default) | 'left' | 'up' | 'down'
   */
  const SLIDE_PAIRS = {
    right: { out: 'slide-out-right', in: 'slide-in-from-left' },
    left:  { out: 'slide-out-left',  in: 'slide-in-from-right' },
    up:    { out: 'slide-out-up',    in: 'slide-in-from-bottom' },
    down:  { out: 'slide-out-down',  in: 'slide-in-from-top' },
  };
  function clearSlideClasses() {
    $wrap.classList.remove(
      'slide-out-right', 'slide-out-left', 'slide-out-up', 'slide-out-down',
      'slide-in-from-left', 'slide-in-from-right', 'slide-in-from-top', 'slide-in-from-bottom'
    );
  }
  function animateSwap(updateFn, direction = 'right') {
    isAnimating = true;
    const pair = SLIDE_PAIRS[direction] || SLIDE_PAIRS.right;
    clearSlideClasses();
    void $wrap.offsetWidth;
    $wrap.classList.add(pair.out);
    const SLIDE_OUT_MS = 220;
    const SLIDE_IN_MS = 320;
    setTimeout(() => {
      try { updateFn(); } catch (e) { console.error('[ID] animateSwap update failed', e); }
      clearSlideClasses();
      void $wrap.offsetWidth;
      $wrap.classList.add(pair.in);
      setTimeout(() => {
        clearSlideClasses();
        isAnimating = false;
      }, SLIDE_IN_MS);
    }, SLIDE_OUT_MS);
  }

  // ====== Phase 1 fallback: button flip ======
  $flipBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // toggle physical-flip simulation
    if (currentState === States.INITIAL_SHUFFLE) {
      onFlipToBack();
    } else if (currentState === States.BACK_SHUFFLE) {
      onFlipToFront();
    } else {
      // From any later state, simulate "flip to back" (reset)
      onFlipToBack();
    }
  });

  // Also: when not in debug, allow a 3-finger tap as a hidden flip trigger?
  // Phase 1 spec calls for a tap fallback, so we use a long-press (>=700ms) on the card area.
  let longPressTimer = null;
  function startLongPress(x, y) {
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      // Only treat as flip if no swipe happened (touchStart still has same x,y close)
      if (touchStart && Math.hypot(touchStart.x - x, touchStart.y - y) < 10) {
        // Trigger flip based on current state
        if (currentState === States.BACK_SHUFFLE) onFlipToFront();
        else onFlipToBack();
        touchStart = null; // consume
      }
    }, 700);
  }
  function cancelLongPress() {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  // ====== Input wiring ======
  function attachInput() {
    // Touch events (primary on mobile)
    document.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      onPointerDown(t.clientX, t.clientY);
      startLongPress(t.clientX, t.clientY);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      cancelLongPress();
      const t = e.touches[0];
      if (t) onPointerMove(t.clientX, t.clientY);
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      cancelLongPress();
      const t = e.changedTouches[0];
      onPointerUp(t.clientX, t.clientY);
    }, { passive: true });

    document.addEventListener('touchcancel', (e) => {
      cancelLongPress();
      // Treat cancel like a release without travel: snap back if a drag was in flight.
      if (isDragging && touchStart) {
        isDragging = false; touchStart = null;
        snapBack();
      }
    }, { passive: true });

    // Mouse events (desktop testing)
    document.addEventListener('mousedown', (e) => {
      // Ignore clicks on the flip button itself
      if (e.target === $flipBtn) return;
      onPointerDown(e.clientX, e.clientY);
      startLongPress(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      cancelLongPress();
      onPointerMove(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', (e) => {
      if (e.target === $flipBtn) return;
      cancelLongPress();
      onPointerUp(e.clientX, e.clientY);
    });
  }

  // ====== Debug ======
  function log(...args) { if (DEBUG) console.log('[ID]', ...args); }
  function updateDebugHUD() {
    if (!DEBUG) return;
    $dbgState.textContent = currentState;
    $dbgEncoded.textContent = encodedCard
      ? `${RANK_LABEL[encodedCard.rank]}${SUIT_GLYPH[encodedCard.suit]}`
      : '-';
    $dbgIdx.textContent = audienceShuffleOrder
      ? `${currentAudienceIndex + 1}/${audienceShuffleOrder.length} (back@${backCardPosition})`
      : '-';
  }

  // ====== Boot ======
  async function boot() {
    if (DEBUG) {
      document.body.classList.add('debug');
      $dbg.hidden = false;
      buildHotspotOverlay();
      const ro = new ResizeObserver(() => positionHotspotLayer());
      ro.observe($card);
      positionHotspotLayer();
    }
    attachInput();
    try {
      await loadCardSheet();
    } catch (e) {
      console.error('[ID] sheet load failed, using fallback cards', e);
    }
    currentCard = pickRandomCard();
    previousAnyCard = currentCard;
    renderCard(currentCard);
    showFrontOnly();
    transitionTo(States.INITIAL_SHUFFLE);
  }
  boot();
})();
