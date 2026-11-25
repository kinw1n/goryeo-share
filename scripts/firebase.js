/* ══════════════════════════════════════
   왕건의 통일 배틀 — 배포용 Firebase · 수업 코드 통합 모듈
   v2.0.15 (타 학교 배포용 — 파싱 정규식 보강 · URL fb 파라미터 정리):
   - 원작자 개인 Firebase 정보 완전 제거 (기본값 공란)
   - 트랙 A: 교사 본인 Firebase 설정 (파일 수정 / 화면 입력 / 학생 공유 링크)
   - 트랙 B: Firebase 없이 수업 코드 + 결과 코드(WG1) 일괄 집계 지원
══════════════════════════════════════ */
(function initGameFirebase(global) {
  'use strict';

  /* ──────────────────────────────────────
     [선택 1] 직접 수정해서 배포할 경우 아래 7개 항목에
     본인의 Firebase 프로젝트 설정값을 입력하고 저장하세요.
     비워 두면 자동으로 [트랙 B: 오프라인 수업 코드 모드]로 동작합니다.
  ────────────────────────────────────── */
  const DEFAULT_FIREBASE_CONFIG = {
    apiKey:            "",
    authDomain:        "",
    databaseURL:       "",
    projectId:         "",
    storageBucket:     "",
    messagingSenderId: "",
    appId:             ""
  };

  const SDK_VERSION = '10.12.0';
  const STORAGE_KEY_CONFIG = 'wanggeon-custom-fb-config-v1';
  const SESSION_KEY_CONFIG = 'wanggeon-url-fb-config-v1';
  const SESSION_KEY_CLASS  = 'wanggeon-class-code-v1';
  const CONFIG_FIELDS = [
    'apiKey', 'authDomain', 'databaseURL', 'projectId',
    'storageBucket', 'messagingSenderId', 'appId'
  ];

  const state = {
    ready: false,
    config: null,
    source: 'none', // 'url' | 'storage' | 'file' | 'none'
    ignoreUrlFb: false,
    classCode: '',
    db: null,
    ref: null,
    set: null,
    onValue: null,
    remove: null,
    serverTimestamp: null,
    playersUnsub: null,
    sessionEndUnsub: null,
    pollTimer: null
  };

  /* ── 문자열 / Base64URL 유틸 ── */
  function utf8ToBase64Url(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function base64UrlToUtf8(b64u) {
    const padded = String(b64u || '').replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const bin = atob(padded + '='.repeat(padLen));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function checksum4(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
  }

  /* ── 수업 코드 관리 ── */
  function normalizeClassCode(raw) {
    return String(raw || '')
      .trim()
      .replace(/[^가-힣ㄱ-ㅎㅏ-ㅣA-Za-z0-9_-]/g, '')
      .slice(0, 12);
  }

  function sanitizeFirebaseKey(raw) {
    const cleaned = normalizeClassCode(raw);
    if (!cleaned) return '';
    return encodeURIComponent(cleaned).replace(/[.#$\[\]\/%]/g, '_');
  }

  function setClassCode(raw) {
    state.classCode = normalizeClassCode(raw);
    try {
      if (state.classCode) sessionStorage.setItem(SESSION_KEY_CLASS, state.classCode);
      else sessionStorage.removeItem(SESSION_KEY_CLASS);
    } catch (e) {}
    return state.classCode;
  }

  function getClassCode() {
    if (!state.classCode) {
      try {
        const saved = sessionStorage.getItem(SESSION_KEY_CLASS);
        if (saved) state.classCode = normalizeClassCode(saved);
      } catch (e) {}
    }
    return state.classCode;
  }

  /* ── Firebase 설정 정규화·파싱 ── */
  function sanitizeConfig(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const out = {};
    CONFIG_FIELDS.forEach((k) => {
      const v = obj[k];
      if (typeof v === 'string') out[k] = v.trim();
      else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
      else out[k] = '';
    });
    return out;
  }

  function hasValidConfig(cfg) {
    return !!(cfg && cfg.apiKey && cfg.databaseURL && cfg.projectId);
  }

  function stripJsCommentsPreserveStrings(raw) {
    return String(raw || '').replace(
      /("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
      (match, stringLiteral) => (stringLiteral !== undefined ? stringLiteral : ' ')
    );
  }

  function parseConfigInput(rawText) {
    const normalized = String(rawText || '')
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .trim();
    if (!normalized) return { ok: false, error: '설정값을 붙여넣어 주세요.' };

    // 1) 순수 JSON 시도
    try {
      const parsed = JSON.parse(normalized);
      const cfg = sanitizeConfig(parsed);
      if (hasValidConfig(cfg)) {
        if (!/^https:\/\/.+/i.test(cfg.databaseURL)) {
          return { ok: false, error: 'databaseURL은 https://로 시작하는 주소여야 합니다.' };
        }
        return { ok: true, config: cfg };
      }
    } catch (e) {}

    // 2) Firebase Console JS 스니펫 파싱 (주석 안전 제거·키 경계·따옴표 쌍/백틱/숫자 지원)
    const stripped = stripJsCommentsPreserveStrings(normalized);
    const cfg = {};
    CONFIG_FIELDS.forEach((field) => {
      const re = new RegExp(
        `(?:^|[\\s,{;])(?:(["'\`])${field}\\1|${field})\\s*:\\s*(?:(["'\`])((?:\\\\.|(?!\\2)[^\\\\\\r\\n])*)\\2|(\\d+)(?=$|[\\s,};]))`
      );
      const m = stripped.match(re);
      if (m) {
        const rawVal = m[3] !== undefined ? m[3].replace(/\\(["'`\\])/g, '$1') : (m[4] || '');
        cfg[field] = rawVal.trim();
      } else {
        cfg[field] = '';
      }
    });

    if (!cfg.apiKey) return { ok: false, error: 'apiKey 항목을 찾을 수 없습니다.' };
    if (!cfg.projectId) return { ok: false, error: 'projectId 항목을 찾을 수 없습니다.' };
    if (!cfg.databaseURL) {
      return {
        ok: false,
        error: 'databaseURL 항목이 없습니다. Realtime Database 생성 후 databaseURL을 포함해 주세요.'
      };
    }
    if (!/^https:\/\/.+/i.test(cfg.databaseURL)) {
      return { ok: false, error: 'databaseURL은 https://로 시작하는 주소여야 합니다.' };
    }
    return { ok: true, config: cfg };
  }

  function encodeConfigToken(cfg) {
    const clean = sanitizeConfig(cfg);
    if (!hasValidConfig(clean)) return '';
    return utf8ToBase64Url(JSON.stringify(clean));
  }

  function decodeConfigToken(token) {
    try {
      const json = base64UrlToUtf8(token);
      const cfg = sanitizeConfig(JSON.parse(json));
      return hasValidConfig(cfg) ? cfg : null;
    } catch (e) {
      return null;
    }
  }

  function getUrlParams() {
    const res = { mode: '', code: '', fb: '' };
    try {
      const qs = new URLSearchParams(global.location ? global.location.search : '');
      res.mode = qs.get('mode') || '';
      res.code = normalizeClassCode(qs.get('code') || '');
      res.fb = qs.get('fb') || '';
      if (!res.fb && global.location && global.location.hash && global.location.hash.includes('fb=')) {
        const hs = new URLSearchParams(global.location.hash.replace(/^#/, ''));
        res.fb = hs.get('fb') || '';
        if (!res.code) res.code = normalizeClassCode(hs.get('code') || '');
        if (!res.mode) res.mode = hs.get('mode') || '';
      }
    } catch (e) {}
    return res;
  }

  function stripFbParamFromUrl() {
    if (!global.location) return false;
    try {
      const url = new URL(global.location.href);
      let changed = false;

      if (url.searchParams.has('fb')) {
        url.searchParams.delete('fb');
        changed = true;
      }

      if (url.hash && url.hash.includes('fb=')) {
        const rawHash = url.hash.replace(/^#/, '');
        const hashParams = new URLSearchParams(rawHash);
        if (hashParams.has('fb')) {
          hashParams.delete('fb');
          const nextHash = hashParams.toString();
          url.hash = nextHash ? `#${nextHash}` : '';
          changed = true;
        }
      }

      if (changed && global.history && typeof global.history.replaceState === 'function') {
        const nextPath = `${url.pathname}${url.search}${url.hash}`;
        global.history.replaceState(global.history.state, '', nextPath);
      }
      return changed;
    } catch (e) {
      return false;
    }
  }

  function resolveConfig() {
    // 우선순위 1: URL 파라미터 (?fb=...) 또는 해당 탭 세션 저장값
    if (!state.ignoreUrlFb) {
      const params = getUrlParams();
      if (params.fb) {
        const urlCfg = decodeConfigToken(params.fb);
        if (urlCfg) {
          try { sessionStorage.setItem(SESSION_KEY_CONFIG, JSON.stringify(urlCfg)); } catch (e) {}
          return { config: urlCfg, source: 'url' };
        }
      }
    }
    try {
      const sessRaw = sessionStorage.getItem(SESSION_KEY_CONFIG);
      if (sessRaw) {
        const sessCfg = sanitizeConfig(JSON.parse(sessRaw));
        if (hasValidConfig(sessCfg)) return { config: sessCfg, source: 'url' };
      }
    } catch (e) {}

    // 우선순위 2: 교사 브라우저에 저장된 개인 Firebase 설정
    try {
      const savedRaw = localStorage.getItem(STORAGE_KEY_CONFIG);
      if (savedRaw) {
        const savedCfg = sanitizeConfig(JSON.parse(savedRaw));
        if (hasValidConfig(savedCfg)) return { config: savedCfg, source: 'storage' };
      }
    } catch (e) {}

    // 우선순위 3: scripts/firebase.js 파일에 직접 기입된 설정
    const fileCfg = sanitizeConfig(DEFAULT_FIREBASE_CONFIG);
    if (hasValidConfig(fileCfg)) {
      return { config: fileCfg, source: 'file' };
    }

    return { config: null, source: 'none' };
  }

  function refreshResolvedConfig() {
    const resolved = resolveConfig();
    state.config = resolved.config;
    state.source = resolved.source;
    return resolved;
  }

  function isConfigured() {
    if (!state.config) refreshResolvedConfig();
    return hasValidConfig(state.config);
  }

  function getConfigSummary() {
    const resolved = refreshResolvedConfig();
    return {
      configured: hasValidConfig(resolved.config),
      source: resolved.source,
      projectId: resolved.config ? resolved.config.projectId : '',
      databaseURL: resolved.config ? resolved.config.databaseURL : '',
      config: resolved.config ? { ...resolved.config } : null
    };
  }

  function saveCustomConfig(cfg) {
    const clean = sanitizeConfig(cfg);
    if (!hasValidConfig(clean)) return false;
    stopAllSubscriptions();
    state.ready = false;
    state.db = null;
    state.ignoreUrlFb = true;
    global._fbReady = false;
    global._fbDb = null;
    stripFbParamFromUrl();
    try {
      localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(clean));
      sessionStorage.removeItem(SESSION_KEY_CONFIG);
    } catch (e) {}
    state.config = clean;
    state.source = 'storage';
    return true;
  }

  function clearCustomConfig() {
    stopAllSubscriptions();
    state.ready = false;
    state.db = null;
    state.ignoreUrlFb = true;
    global._fbReady = false;
    global._fbDb = null;
    stripFbParamFromUrl();
    try {
      localStorage.removeItem(STORAGE_KEY_CONFIG);
      sessionStorage.removeItem(SESSION_KEY_CONFIG);
    } catch (e) {}
    refreshResolvedConfig();
    return true;
  }

  function buildShareLink(classCodeInput) {
    if (!global.location) return '';
    const base = `${global.location.origin}${global.location.pathname}`;
    const params = new URLSearchParams();
    params.set('mode', 'team');
    const code = normalizeClassCode(classCodeInput || getClassCode());
    if (code) params.set('code', code);
    const resolved = refreshResolvedConfig();
    if (hasValidConfig(resolved.config)) {
      params.set('fb', encodeConfigToken(resolved.config));
    }
    return `${base}?${params.toString()}`;
  }

  /* ── 세션 경로 및 Firebase SDK 초기화 ── */
  function isReady() {
    return !!(state.db && state.ready);
  }

  function getSessionKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getSessionLabel() {
    const dateKey = getSessionKey();
    const code = getClassCode();
    return code ? `${dateKey} / ${code}` : `${dateKey} (기본)`;
  }

  function sessionRef(path) {
    if (!isReady()) return null;
    const dateKey = getSessionKey();
    const roomKey = sanitizeFirebaseKey(getClassCode());
    const fullPath = roomKey
      ? `sessions/${dateKey}/rooms/${roomKey}/${path}`
      : `sessions/${dateKey}/${path}`;
    return state.ref(state.db, fullPath);
  }

  async function init(forceReload = false) {
    const resolved = refreshResolvedConfig();
    if (!hasValidConfig(resolved.config)) {
      state.ready = false;
      global._fbReady = false;
      return false;
    }
    if (!forceReload && isReady()) return true;
    try {
      const [appMod, dbMod] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-database.js`)
      ]);
      const { initializeApp, getApps, getApp } = appMod;
      const { getDatabase, ref, set, onValue, remove, serverTimestamp } = dbMod;

      const appName = `wanggeon-${sanitizeFirebaseKey(resolved.config.projectId) || 'custom'}`;
      const existing = getApps().find((a) => a.name === appName);
      const app = existing ? getApp(appName) : initializeApp(resolved.config, appName);
      const db = getDatabase(app);

      state.db = db;
      state.ref = ref;
      state.set = set;
      state.onValue = onValue;
      state.remove = remove;
      state.serverTimestamp = serverTimestamp;
      state.ready = true;

      global._fbDb = db;
      global._fbRef = ref;
      global._fbSet = set;
      global._fbOnValue = onValue;
      global._fbRemove = remove;
      global._fbServerTs = serverTimestamp;
      global._fbReady = true;

      if (global.document && typeof global.Event === 'function') {
        global.document.dispatchEvent(new Event('fb-ready'));
      }
      return true;
    } catch (e) {
      state.ready = false;
      global._fbReady = false;
      console.warn('Firebase 연결 실패:', e && e.message ? e.message : e);
      return false;
    }
  }

  async function savePlayerScore(playerId, payload) {
    if (!isReady() || !playerId) return false;
    const record = {
      ...payload,
      classCode: getClassCode(),
      updatedAt: state.serverTimestamp()
    };
    await state.set(sessionRef(`players/${playerId}`), record);
    return true;
  }

  async function removePlayers() {
    if (!isReady()) return false;
    await state.remove(sessionRef('players'));
    return true;
  }

  async function resetSession() {
    if (!isReady()) return false;
    await state.remove(sessionRef('players'));
    await state.remove(sessionRef('session_ended'));
    return true;
  }

  async function endSession(endedBy = 'teacher') {
    if (!isReady()) return false;
    await state.set(sessionRef('session_ended'), {
      endedAt: Date.now(),
      endedBy
    });
    return true;
  }

  function subscribePlayers(onChange) {
    unsubscribePlayers();
    if (!isReady()) return null;
    state.playersUnsub = state.onValue(sessionRef('players'), (snapshot) => {
      const data = snapshot && typeof snapshot.val === 'function'
        ? (snapshot.val() || {})
        : {};
      if (typeof onChange === 'function') onChange(data);
    });
    return state.playersUnsub;
  }

  function unsubscribePlayers() {
    if (state.playersUnsub) {
      try { state.playersUnsub(); } catch (e) {}
      state.playersUnsub = null;
    }
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function watchSessionEnd(onEnded) {
    stopSessionEndWatch();
    if (!isReady()) return null;
    try {
      const endRef = sessionRef('session_ended');
      const watchStartTime = Date.now();
      state.sessionEndUnsub = state.onValue(endRef, (snapshot) => {
        const val = snapshot && typeof snapshot.val === 'function' ? snapshot.val() : null;
        if (!val) return;
        const endedAt = val.endedAt || 0;
        const isNewSignal = (typeof endedAt === 'number')
          ? endedAt > watchStartTime - 5000
          : false;
        if (!isNewSignal) return;
        if (typeof onEnded === 'function') onEnded(val);
      });
      return state.sessionEndUnsub;
    } catch (e) {
      console.warn('watchSessionEnd 오류:', e);
      return null;
    }
  }

  function stopSessionEndWatch() {
    if (state.sessionEndUnsub) {
      try { state.sessionEndUnsub(); } catch (e) {}
      state.sessionEndUnsub = null;
    }
  }

  function stopAllSubscriptions() {
    unsubscribePlayers();
    stopSessionEndWatch();
  }

  /* ── [트랙 B] 오프라인 수업 코드 결과 영수증 인코더 / 디코더 ── */
  function encodeResultCode(data) {
    const safeTeam = Number.isInteger(data.team) ? data.team : -1;
    const payload = {
      c: normalizeClassCode(data.classCode || getClassCode()) || '기본수업',
      t: safeTeam,
      n: String(data.nickname || '').trim().slice(0, 8),
      s: Math.max(0, Math.round(Number(data.score) || 0)),
      e: Math.max(0, Math.round(Number(data.exp) || 0)),
      b: Math.max(0, Math.round(Number(data.speedBonus) || 0)),
      l: Math.max(0, Math.min(100, Math.round(Number(data.loyalty) || 0))),
      st: Math.max(0, Math.min(100, Math.round(Number(data.stability) || 0))),
      v: Math.max(0, Math.min(8, Math.round(Number(data.visited) || 0))),
      lv: Math.max(1, Math.min(5, Math.round(Number(data.level) || 1))),
      id: String(data.playerId || '').slice(0, 24)
    };
    const b64 = utf8ToBase64Url(JSON.stringify(payload));
    const chk = checksum4(`WG1:${b64}`);
    return `WG1-${b64}-${chk}`;
  }

  function decodeResultCode(token) {
    const raw = String(token || '').trim();
    const m = raw.match(/^WG1-([A-Za-z0-9_-]+)-([0-9A-Fa-f]{4})$/);
    if (!m) return { ok: false, error: '코드 형식이 올바르지 않습니다.' };
    const b64 = m[1];
    const chk = m[2].toUpperCase();
    if (checksum4(`WG1:${b64}`) !== chk) {
      return { ok: false, error: '검증 코드가 일치하지 않습니다(손상 또는 변조됨).' };
    }
    try {
      const obj = JSON.parse(base64UrlToUtf8(b64));
      const team = Number(obj.t);
      if (!Number.isInteger(team) || team < 0 || team > 3) {
        return { ok: false, error: '모둠 정보가 올바르지 않습니다.' };
      }
      const nickname = String(obj.n || '').trim().slice(0, 8);
      if (!nickname) return { ok: false, error: '닉네임이 비어 있습니다.' };
      return {
        ok: true,
        classCode: normalizeClassCode(obj.c) || '기본수업',
        record: {
          playerId: String(obj.id || `${team}_${nickname}`).slice(0, 24),
          nickname,
          team,
          score: Math.max(0, Math.round(Number(obj.s) || 0)),
          exp: Math.max(0, Math.round(Number(obj.e) || 0)),
          speedBonus: Math.max(0, Math.round(Number(obj.b) || 0)),
          loyalty: Math.max(0, Math.min(100, Math.round(Number(obj.l) || 0))),
          stability: Math.max(0, Math.min(100, Math.round(Number(obj.st) || 0))),
          visited: Math.max(0, Math.min(8, Math.round(Number(obj.v) || 0))),
          level: Math.max(1, Math.min(5, Math.round(Number(obj.lv) || 1)))
        }
      };
    } catch (e) {
      return { ok: false, error: '코드 해석에 실패했습니다.' };
    }
  }

  function parseResultCodesBulk(rawText, filterClassCode = '') {
    const text = String(rawText || '');
    const tokens = [];
    text.split(/(?=WG1-)/).forEach((segment) => {
      const m = segment.match(/^WG1-[A-Za-z0-9_-]+-[0-9A-Fa-f]{4}/);
      if (m) tokens.push(m[0]);
    });
    const targetCode = normalizeClassCode(filterClassCode);
    const records = {};
    const stats = {
      totalFound: tokens.length,
      validCount: 0,
      invalidCount: 0,
      wrongClassCount: 0,
      duplicateCount: 0,
      classCodes: []
    };
    const seenClasses = new Set();

    tokens.forEach((tok) => {
      const res = decodeResultCode(tok);
      if (!res.ok) {
        stats.invalidCount += 1;
        return;
      }
      seenClasses.add(res.classCode);
      if (targetCode && res.classCode !== targetCode) {
        stats.wrongClassCount += 1;
        return;
      }
      const rec = res.record;
      const key = rec.playerId || `${rec.team}_${rec.nickname}`;
      if (records[key]) {
        stats.duplicateCount += 1;
        const prev = records[key];
        if (rec.visited > prev.visited || (rec.visited === prev.visited && rec.score >= prev.score)) {
          records[key] = rec;
        }
      } else {
        records[key] = rec;
        stats.validCount += 1;
      }
    });

    stats.classCodes = Array.from(seenClasses);
    return { records, stats };
  }

  // 초기 URL 파라미터 자동 반영
  (function bootstrapFromUrl() {
    const params = getUrlParams();
    if (params.code) setClassCode(params.code);
    refreshResolvedConfig();
  })();

  global.GAME_FIREBASE = Object.freeze({
    init,
    isReady,
    isConfigured,
    getConfigSummary,
    parseConfigInput,
    saveCustomConfig,
    clearCustomConfig,
    buildShareLink,
    getUrlParams,
    normalizeClassCode,
    setClassCode,
    getClassCode,
    getSessionKey,
    getSessionLabel,
    sessionRef,
    savePlayerScore,
    removePlayers,
    resetSession,
    endSession,
    subscribePlayers,
    unsubscribePlayers,
    watchSessionEnd,
    stopSessionEndWatch,
    stopAllSubscriptions,
    encodeResultCode,
    decodeResultCode,
    parseResultCodesBulk
  });
})(window);
