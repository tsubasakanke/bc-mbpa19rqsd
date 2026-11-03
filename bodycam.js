'use strict';
/* BODYCAM BREACH のページ側。
   - メニュー / ロビー(HTML)
   - 部屋の通信: 公開MQTTブローカーをリレーにして、全員が約0.115秒ごとに自分の状態(presence)を配る
     (localhost で ?mock を付けると BroadcastChannel で同じブラウザ内だけで通信 = テスト用)
   - Unity とのやりとり: JS→C# は unityInstance.SendMessage、C#→JS は window.EchoNet / window.EchoUI */
(function () {
  const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
  const TOPIC = 'bodycam-nhs/v1/';
  const MAXP = 8;
  const PUB_GAP = 115;   // 公開ブローカーは1人あたり毎秒約10回まで。これを超えると捨てられる
  const EV_KEEP = 2400;  // イベントは送ったあとこの時間(ms)だけ重ねて送る(取りこぼし対策。受け側が番号で重複を捨てる)

  // C# の Data.cs と同じ順番
  const MODES = [
    { key: 'coop', n: '協力(Co-op)', d: '全員が味方。ステルスで基地の敵をすべて倒して制圧しよう。仲間が倒れたら、残りで続行。全員倒れたら失敗。' },
    { key: 'tdm', n: 'チーム戦', d: '赤チーム vs 青チーム。先に20キルしたチームの勝ち(10分で時間切れ)。倒されても4秒で復活。味方は撃てない。' },
    { key: 'ffa', n: '個人戦', d: '全員が敵。先に15キルした人の勝ち(10分で時間切れ)。倒されても4秒で復活。' }
  ];
  const MISSIONS = ['NIGHT HARBOR(夜・港)', 'DUST STORM(昼・砂漠)', 'IRON JUNGLE(夕・密林)'];
  const WEAPONS = ['M4A1 カービン', 'MP5SD', 'USP .45', 'M870 ショットガン', 'SR-25 DMR', 'VSS 消音スナイパー'];

  window.addEventListener('unhandledrejection', e => {
    const r = e.reason, msg = String((r && (r.message || r.name)) || r);
    if (/pointer ?lock/i.test(msg) || (r && /^(NotAllowedError|WrongDocumentError|SecurityError)$/.test(r.name) && /lock/i.test(msg))) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  });

  const Q = new URLSearchParams(location.search);
  const $ = s => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function loadLoadout() {
    let lo = null;
    try { lo = JSON.parse(store.get('bodycam-lo') || 'null'); } catch (e) { }
    if (!lo || typeof lo !== 'object') lo = { p: 0, s: 2, sp: 1 };
    if (Q.has('p')) lo.p = +Q.get('p') | 0; // テスト用
    if (Q.has('s')) lo.s = +Q.get('s') | 0;
    lo.p = Math.min(5, Math.max(0, lo.p | 0)); lo.s = Math.min(5, Math.max(0, lo.s | 0)); lo.sp = lo.sp ? 1 : 0;
    return lo;
  }

  const S = {
    unity: null, api: null, room: null, code: '', me: null, jt: 0,
    name: (Q.get('name') || store.get('bodycam-name') || ('Operator' + Math.floor(Math.random() * 900 + 100))).slice(0, 12),
    mode: 0, ms: 1, view: 'loading', inGame: false, lastGo: 0, go: null, roster: [],
    game: null, evq: [], lo: loadLoadout(),
    autostart: Q.get('autostart'), minp: +(Q.get('minp') || 2), autoStarted: false
  };
  if (Q.has('ms')) S.ms = +Q.get('ms') | 0;

  // ================= 部屋の通信 =================
  async function getRoomApi() {
    if (S.api) return S.api;
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && Q.has('mock') && 'BroadcastChannel' in window) return (S.api = { join: async n => mockRoom(n) });
    if (window.mqtt) return (S.api = mqttRoomApi());
    return null;
  }

  function mqttRoomApi() {
    let client = null, connecting = null;
    async function getClient() {
      if (client) return client;
      if (connecting) return connecting;
      connecting = (async () => {
        for (const url of BROKERS) {
          status('リレーサーバーに接続中…(' + url.split('/')[2].split(':')[0] + ')');
          const c = await new Promise(res => {
            let cl;
            try { cl = mqtt.connect(url, { clientId: 'bc_' + Math.random().toString(36).slice(2, 12), keepalive: 30, clean: true, reconnectPeriod: 2000, connectTimeout: 6000 }); }
            catch (e) { res(null); return; }
            const to = setTimeout(() => { try { cl.end(true); } catch (e) { } res(null); }, 7000);
            cl.once('connect', () => { clearTimeout(to); res(cl); });
            cl.on('error', () => { });
          });
          if (c) { client = c; return c; }
        }
        throw new Error('net');
      })();
      try { return await connecting; } finally { connecting = null; }
    }
    return { join: async name => mqttRoom(await getClient(), name) };
  }

  function newId() { return 'm' + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7); }

  function mqttRoom(cl, name) {
    const base = TOPIC + name + '/p/', myId = newId();
    let mine = {}, closed = false, snap = [];
    const table = new Map();
    const rebuild = () => {
      const arr = [{ peer: myId, isMe: true, presence: mine, at: Date.now() }];
      for (const [id, o] of table) arr.push({ peer: id, isMe: false, presence: o.presence, at: o.at });
      snap = arr;
    };
    const onMsg = (topic, payload) => {
      if (closed || !topic.startsWith(base)) return;
      const id = topic.slice(base.length);
      if (!id || id === myId || id.length > 24) return;
      if (!payload || payload.length === 0) { table.delete(id); rebuild(); return; }
      if (payload.length > 40000) return;
      let pr; try { pr = JSON.parse(payload.toString()); } catch (e) { return; }
      if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return;
      table.set(id, { presence: pr, at: Date.now() }); rebuild();
      if (room.onUpdate) room.onUpdate();
    };
    cl.on('message', onMsg);
    cl.subscribe(base + '+', { qos: 0 });
    let lastPub = 0, pending = null;
    const doPublish = () => {
      pending = null;
      if (closed || !cl.connected) return;
      lastPub = Date.now();
      try { cl.publish(base + myId, JSON.stringify(mine), { qos: 0, retain: false }); } catch (e) { }
    };
    const publish = () => {
      const wait = lastPub + PUB_GAP - Date.now();
      if (wait <= 0) doPublish();
      else if (!pending) pending = setTimeout(doPublish, wait);
    };
    const loop = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastPub > 100) publish();
      const now = Date.now(); let ch = false;
      for (const [id, o] of table) if (now - o.at > 6000) { table.delete(id); ch = true; }
      if (ch) { rebuild(); if (room.onUpdate) room.onUpdate(); }
    }, 100);
    rebuild();
    const room = {
      me: myId, set: p => { mine = p; rebuild(); }, flush: () => { if (!closed) publish(); }, peers: () => snap, connected: () => cl.connected, onUpdate: null,
      leave: () => {
        if (closed) return; closed = true; clearInterval(loop);
        try { cl.publish(base + myId, '', { qos: 0 }); cl.unsubscribe(base + '+'); } catch (e) { }
        cl.removeListener('message', onMsg);
      }
    };
    return room;
  }

  function mockRoom(name) {
    const ch = new BroadcastChannel('bodycam-' + name), myId = newId();
    let mine = {}, snap = [], closed = false;
    const table = new Map();
    const rebuild = () => {
      const arr = [{ peer: myId, isMe: true, presence: mine, at: Date.now() }];
      for (const [id, o] of table) arr.push({ peer: id, isMe: false, presence: o.presence, at: o.at });
      snap = arr;
    };
    ch.onmessage = e => {
      const { id, p } = e.data || {}; if (!id || id === myId) return;
      if (!p) table.delete(id); else table.set(id, { presence: p, at: Date.now() });
      rebuild(); if (room.onUpdate) room.onUpdate();
    };
    let lastPub = 0;
    const publish = () => { lastPub = Date.now(); ch.postMessage({ id: myId, p: mine }); };
    const loop = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastPub > 90) publish();
      const now = Date.now(); let chg = false;
      for (const [id, o] of table) if (now - o.at > 4000) { table.delete(id); chg = true; }
      rebuild(); if (chg && room.onUpdate) room.onUpdate();
    }, 100);
    rebuild();
    const room = {
      me: myId, set: p => { mine = p; rebuild(); }, flush: () => { if (!closed) publish(); }, peers: () => snap, connected: () => true, onUpdate: null,
      leave: () => { closed = true; clearInterval(loop); ch.postMessage({ id: myId, p: null }); ch.close(); }
    };
    return room;
  }

  // 部屋のメンバー(入った順に最大8人)
  function members() {
    if (!S.room) return [];
    return S.room.peers()
      .filter(p => p.isMe || (p.presence && p.presence.v === 1 && p.presence.rm === S.code))
      .map(p => p.isMe ? Object.assign({}, p, { presence: Object.assign({}, p.presence, { jt: S.jt, n: S.name }) }) : p)
      .sort((a, b) => ((a.presence.jt | 0) - (b.presence.jt | 0)) || (a.peer < b.peer ? -1 : 1))
      .slice(0, MAXP);
  }
  function lobbyLeaderId() { const ids = members().map(p => p.peer).sort(); return ids[0] || S.me; }
  function isLobbyLeader() { return lobbyLeaderId() === S.me; }

  async function joinRoom(code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!code) { status('部屋コードを入れてね'); return; }
    status('接続中…');
    let api;
    try { api = await getRoomApi(); } catch (e) { api = null; }
    if (!api) { status('通信ライブラリを読み込めなかった。ページを再読み込みしてね'); return; }
    try { S.room = await api.join(code); }
    catch (e) { status('リレーサーバーに接続できなかった。少し待ってもう一度試してね'); return; }
    S.room.onUpdate = scheduleForward;
    S.code = code; S.me = S.room.me; S.jt = Date.now(); S.lastGo = 0; S.go = null; S.autoStarted = false;
    const url = new URL(location.href); url.searchParams.set('room', code); history.replaceState(null, '', url);
    show('lobby');
    setTimeout(() => {
      if (S.room && !members().some(p => p.isMe)) { leaveRoom(); status('部屋が満員(8人)だった'); }
    }, 1500);
  }

  function leaveRoom() {
    if (S.room) S.room.leave();
    S.room = null; S.code = ''; S.inGame = false;
    const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
    show('menu');
  }

  function buildPresence() {
    const pres = { v: 1, rm: S.code, n: S.name, jt: S.jt, st: S.inGame ? 'g' : 'l', lo: S.lo };
    if (isLobbyLeader()) { pres.md = S.mode; pres.ms = S.ms; if (S.go) pres.go = S.go; }
    if (S.inGame) {
      if (S.game) pres.g = S.game;
      const now = Date.now();
      S.evq = S.evq.filter(e => now - e.t < EV_KEEP);
      if (S.evq.length) pres.ev = S.evq.map(e => e.e);
    }
    return pres;
  }

  // 試合中: 誰かの状態が届いたら、次の描画フレームで Unity に渡す(0.1秒待たない)
  let forwardQueued = false;
  function scheduleForward() {
    if (!S.inGame || forwardQueued) return;
    forwardQueued = true;
    requestAnimationFrame(() => { forwardQueued = false; forwardToUnity(); });
  }

  function forwardToUnity() {
    if (!S.room || !S.inGame) return;
    const inRoster = new Set(S.roster.map(r => r.id));
    const list = members()
      .filter(p => !p.isMe && inRoster.has(p.peer) && p.presence.st === 'g' && p.presence.g)
      .map(p => ({ id: p.peer, n: p.presence.n, g: p.presence.g, ev: p.presence.ev || [] }));
    const present = members().filter(p => inRoster.has(p.peer) && (p.isMe || p.presence.st === 'g')).map(p => p.peer).sort();
    sendUnity('Net', 'OnPeers', JSON.stringify({ me: S.me, leader: present[0] || S.me, peers: list }));
  }

  // 0.1秒ごと: ロビーの状態を配る。試合中は Unity から届いた時点ですぐ送るので、ここは予備
  setInterval(() => {
    if (!S.room) return;
    S.room.set(buildPresence());
    const peers = members();
    if (!S.inGame) {
      const L = peers.find(p => p.peer === lobbyLeaderId());
      if (L && !L.isMe) {
        S.mode = L.presence.md | 0; S.ms = L.presence.ms | 0;
        const go = L.presence.go;
        if (go && go.t !== S.lastGo && Array.isArray(go.roster) && go.roster.some(r => r.id === S.me)) startGame(go);
      }
      if (isLobbyLeader() && S.autostart && !S.autoStarted && peers.length >= S.minp) {
        S.autoStarted = true;
        S.mode = Math.max(0, MODES.findIndex(m => m.key === S.autostart));
        leaderStart();
      }
      renderLobby();
      return;
    }
    forwardToUnity();
  }, 100);

  function leaderStart() {
    const ms = members();
    const sorted = ms.slice();
    const roster = sorted.map((p, i) => {
      const lo = p.isMe ? S.lo : (p.presence.lo || {});
      return { id: p.peer, n: p.isMe ? S.name : String(p.presence.n || '?').slice(0, 12), p: lo.p | 0, s: lo.s | 0, sp: lo.sp ? 1 : 0, tm: i % 2 };   // tm: 入った順に赤(0)/青(1)
    });
    S.go = { t: Date.now(), mode: S.mode, ms: S.ms, roster: roster, seed: Math.floor(Math.random() * 1e6) + 1 };
    startGame(S.go);
  }

  function startGame(go) {
    S.lastGo = go.t; S.inGame = true; S.roster = go.roster; S.game = null; S.evq = [];
    show('game');
    sendUnity('Net', 'OnGo', JSON.stringify(Object.assign({}, go, { me: S.me })));
    setTimeout(() => { try { if (S.unity && S.unity.Module && S.unity.Module.canvas) S.unity.Module.canvas.focus(); } catch (e) { } }, 100);
  }

  function endGame() {
    S.inGame = false; S.game = null; S.evq = []; S.go = null;
    if (S.room) { show('lobby'); } else show('menu');
  }

  // ================= Unity とのやりとり =================
  function sendUnity(obj, fn, arg) {
    if (!S.unity) return;
    try { S.unity.SendMessage(obj, fn, arg == null ? '' : arg); } catch (e) { }
  }

  // C# → JS(WebBridge.cs → BodycamBridge.jslib から呼ばれる)
  window.EchoNet = {
    fromUnity(json) {
      let o; try { o = JSON.parse(json); } catch (e) { return; }
      if (!o) return;
      if (o.s) S.game = o.s;
      if (Array.isArray(o.ev)) { const now = Date.now(); for (const e of o.ev) S.evq.push({ t: now, e: e }); }
      if (S.room) { S.room.set(buildPresence()); S.room.flush(); }
    }
  };
  window.EchoUI = {
    progress(p) { $('#fill').style.width = Math.round(p * 100) + '%'; },
    ready(inst) {
      S.unity = inst; window.__u = inst; window.__S = S;
      $('#loading').classList.add('hidden');
      const code = Q.get('room');
      if (Q.get('solo') != null) { startSolo(+Q.get('solo') | 0); return; }
      if (code) { show('menu'); joinRoom(code); } else show('menu');
    },
    fail(e) { $('#ltext').textContent = '読み込みに失敗しました: ' + (e && e.message || e); },
    event(ev) { if (ev === 'over') endGame(); }
  };

  function startSolo(ms) {
    S.inGame = true; S.roster = []; show('game');
    sendUnity('Game', 'OnSolo', JSON.stringify({ ms: ms, p: S.lo.p, s: S.lo.s, sp: S.lo.sp }));
  }

  // ================= 画面 =================
  function show(v) {
    S.view = v;
    for (const id of ['menu', 'lobby']) $('#' + id).classList.toggle('hidden', v !== id);
    if (v === 'menu') renderMenu(); else if (v === 'lobby') renderLobby(true);
  }
  function status(t) { const a = $('#menuStat'), b = $('#lobbyStat'); if (a) a.textContent = t; if (b && S.view === 'lobby') b.textContent = t; }

  function loadoutHtml(id) {
    const opt = (list, sel) => list.map((n, i) => '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    return '<div class="lo"><label>主武器 <select data-k="p">' + opt(WEAPONS, S.lo.p) + '</select></label>' +
      '<label>副武器 <select data-k="s">' + opt(WEAPONS, S.lo.s) + '</select></label>' +
      '<label><input type="checkbox" data-k="sp"' + (S.lo.sp ? ' checked' : '') + '> サプレッサー</label></div>';
  }
  function bindLoadout(root) {
    root.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
      const k = el.dataset.k;
      S.lo[k] = k === 'sp' ? (el.checked ? 1 : 0) : (+el.value | 0);
      store.set('bodycam-lo', JSON.stringify(S.lo));
    }));
  }

  function renderMenu() {
    $('#name').value = S.name;
    $('#loadoutMenu').innerHTML = '<h3>装備</h3>' + loadoutHtml();
    bindLoadout($('#loadoutMenu'));
    $('#soloMissions').innerHTML = MISSIONS.map((m, i) => '<button class="btn" data-ms="' + i + '">' + esc(m) + '</button>').join('');
    $('#soloMissions').querySelectorAll('[data-ms]').forEach(b => b.addEventListener('click', () => startSolo(+b.dataset.ms)));
  }

  let lobbyKey = '';
  function renderLobby(force) {
    if (S.view !== 'lobby' || !S.room) return;
    const peers = members(), leader = lobbyLeaderId(), me = isLobbyLeader();
    const key = JSON.stringify([peers.map(p => [p.peer, p.presence.n, p.presence.lo]), S.mode, S.ms, me, S.name]);
    $('#lcode').textContent = S.code;
    if (!force && key === lobbyKey) return;
    lobbyKey = key;
    $('#invite').value = location.origin + location.pathname + '?room=' + S.code;
    $('#players').innerHTML = peers.map((p, i) => '<div class="pl' + (p.isMe ? ' me' : '') + '"><span>' + esc(p.isMe ? S.name : p.presence.n) + (p.peer === leader ? ' ★' : '') +
      '</span><span class="tag2">' + esc(WEAPONS[(p.isMe ? S.lo.p : (p.presence.lo || {}).p) | 0] || '') + ' / チーム' + (i % 2 === 0 ? '赤' : '青') + '</span></div>').join('');
    $('#loadoutLobby').innerHTML = loadoutHtml(); bindLoadout($('#loadoutLobby'));
    $('#modes').innerHTML = MODES.map((m, i) => '<button class="btn' + (i === S.mode ? ' on' : '') + '" data-mode="' + i + '"' + (me ? '' : ' disabled') + '>' + esc(m.n) + '</button>').join('');
    $('#modeDesc').textContent = MODES[S.mode].d;
    $('#missions').innerHTML = MISSIONS.map((m, i) => '<button class="btn' + (i === S.ms ? ' on' : '') + '" data-ms="' + i + '"' + (me ? '' : ' disabled') + '>' + esc(m) + '</button>').join('');
    $('#modes').querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { S.mode = +b.dataset.mode; lobbyKey = ''; renderLobby(true); }));
    $('#missions').querySelectorAll('[data-ms]').forEach(b => b.addEventListener('click', () => { S.ms = +b.dataset.ms; lobbyKey = ''; renderLobby(true); }));
    const start = $('#start');
    const prob = startProblem(peers.length);
    start.disabled = !me || !!prob;
    start.textContent = me ? 'スタート' : 'リーダー(★)がスタートするのを待っています';
    $('#lobbyStat').textContent = me ? prob : '';
  }

  function startProblem(n) {
    if (S.mode === 1 && n < 2) return 'チーム戦は2人以上で遊べます';
    if (S.mode === 2 && n < 2) return '個人戦は2人以上で遊べます';
    return '';
  }

  // ================= 起動 =================
  $('#name').addEventListener('input', e => { S.name = e.target.value.slice(0, 12) || S.name; store.set('bodycam-name', S.name); });
  $('#create').addEventListener('click', () => joinRoom(Math.random().toString(36).slice(2, 7).toUpperCase()));
  $('#join').addEventListener('click', () => joinRoom($('#joinCode').value));
  $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('#joinCode').value); });
  $('#leave').addEventListener('click', leaveRoom);
  $('#start').addEventListener('click', () => { if (isLobbyLeader() && !startProblem(members().length)) leaderStart(); });
  $('#copy').addEventListener('click', () => { const i = $('#invite'); i.select(); try { document.execCommand('copy'); } catch (e) { } $('#lobbyStat').textContent = 'コピーしました'; });
  show('menu');
})();
