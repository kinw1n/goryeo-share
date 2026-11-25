/* ══════════════════════════════════════
   왕건의 통일 배틀 — 캐릭터 스프라이트 정의 및 렌더러
   v2.0.4: Animated WebP (idle / action) 교체 및 자동 복귀 제어
══════════════════════════════════════ */
(function initGameSprites(global) {
  const WG_BASE = './assets/characters/wanggeon';
  const HJ_BASE = './assets/characters/hojok';
  const DEFAULT_ACTION_MS = 850;

  const makeWanggeon = (lv) => ({
    type: 'webp',
    idleSrc: `${WG_BASE}/idle/wang_geon_lv${lv}_idle.webp`,
    actionSrc: `${WG_BASE}/attack/wang_geon_lv${lv}_attack.webp`,
    actionDuration: DEFAULT_ACTION_MS,
  });

  const makeHojok = (fileKey) => ({
    type: 'webp',
    idleSrc: `${HJ_BASE}/idle/${fileKey}_idle.webp`,
    actionSrc: `${HJ_BASE}/action/${fileKey}_action.webp`,
    actionDuration: DEFAULT_ACTION_MS,
  });

  const SPRITE_ASSETS = {
    // ── 왕건 Lv.1 ~ Lv.5
    wanggeon1: makeWanggeon(1),
    wanggeon2: makeWanggeon(2),
    wanggeon3: makeWanggeon(3),
    wanggeon4: makeWanggeon(4),
    wanggeon5: makeWanggeon(5),

    // ── 호족 7종
    hojok_maritime:    makeHojok('02_hojok_maritime'),
    hojok_warlord:     makeHojok('03_hojok_warlord'),
    hojok_aristocrat:  makeHojok('04_hojok_aristocrat'),
    hojok_agriculture: makeHojok('05_hojok_agriculture'),
    hojok_bandit:      makeHojok('06_hojok_bandit'),
    hojok_silla:       makeHojok('07_hojok_gyeongju_silla'),
    hojok_archer:      makeHojok('08_hojok_archer'),
  };

  // 기존 키 하위 호환 및 타이틀/닉네임 전용 별칭
  SPRITE_ASSETS.wanggeon      = SPRITE_ASSETS.wanggeon1;
  SPRITE_ASSETS.titleWanggeon = SPRITE_ASSETS.wanggeon1;
  SPRITE_ASSETS.nickWanggeon  = SPRITE_ASSETS.wanggeon1;
  SPRITE_ASSETS.hojok         = SPRITE_ASSETS.hojok_warlord;
  SPRITE_ASSETS.titleHojok    = SPRITE_ASSETS.hojok_warlord;
  SPRITE_ASSETS.general       = SPRITE_ASSETS.hojok_warlord;
  SPRITE_ASSETS.noble         = SPRITE_ASSETS.hojok_aristocrat;
  SPRITE_ASSETS.merchant      = SPRITE_ASSETS.hojok_maritime;

  const _preloaded = new Set();
  function preloadSrc(src) {
    if (!src || _preloaded.has(src)) return;
    _preloaded.add(src);
    const img = new Image();
    img.src = src;
  }

  function resolveAsset(key, fallbackKey = 'hojok') {
    return (
      SPRITE_ASSETS[key] ||
      SPRITE_ASSETS[fallbackKey] ||
      SPRITE_ASSETS.hojok
    );
  }

  /**
   * 캐릭터를 숨쉬기(idle) 상태로 슬롯에 렌더링
   */
  function renderSprite(el, key, fallbackKey = 'hojok') {
    if (!el) return;
    if (el._actionTimer) {
      clearTimeout(el._actionTimer);
      el._actionTimer = null;
    }

    const asset = resolveAsset(key, fallbackKey);
    const img = document.createElement('img');
    img.className = 'sprite-img sprite-webp';
    img.src = asset.idleSrc;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;

    el.dataset.spriteKey = key || fallbackKey;
    el.dataset.spriteState = 'idle';
    el.classList.add('has-webp');
    el.replaceChildren(img);

    // 답안 선택 시 즉시 재생되도록 action WebP 사전 로드
    preloadSrc(asset.actionSrc);
  }

  /**
   * 대기(idle) → 액션(action/attack) 1회 재생 후 자동으로 대기(idle) 복귀
   */
  function playSpriteAction(el, delayMs = 0) {
    if (!el) return;
    const key = el.dataset.spriteKey;
    const asset = resolveAsset(key);
    const img = el.querySelector('img.sprite-img');
    if (!asset || !asset.actionSrc || !img) return;

    const trigger = () => {
      if (el._actionTimer) {
        clearTimeout(el._actionTimer);
        el._actionTimer = null;
      }
      el.dataset.spriteState = 'action';
      // 쿼리 파라미터로 Animated WebP 프레임 0부터 강제 재생
      img.src = `${asset.actionSrc}?t=${Date.now()}`;

      el._actionTimer = setTimeout(() => {
        el.dataset.spriteState = 'idle';
        img.src = asset.idleSrc;
        el._actionTimer = null;
      }, asset.actionDuration || DEFAULT_ACTION_MS);
    };

    if (delayMs > 0) {
      if (el._actionTimer) clearTimeout(el._actionTimer);
      el._actionTimer = setTimeout(trigger, delayMs);
    } else {
      trigger();
    }
  }

  /**
   * 진행 중인 액션 타이머를 정리하고 즉시 숨쉬기(idle) 상태로 복귀
   */
  function resetSpriteIdle(el) {
    if (!el) return;
    if (el._actionTimer) {
      clearTimeout(el._actionTimer);
      el._actionTimer = null;
    }
    const asset = resolveAsset(el.dataset.spriteKey);
    const img = el.querySelector('img.sprite-img');
    if (asset && img) {
      el.dataset.spriteState = 'idle';
      img.src = asset.idleSrc;
    }
  }

  global.GAME_SPRITES = {
    SPRITE_ASSETS,
    SPRITES: SPRITE_ASSETS,
    renderSprite,
    setSvg: renderSprite,
    playSpriteAction,
    resetSpriteIdle,
  };
})(window);
