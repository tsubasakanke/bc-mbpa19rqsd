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
  const MISSIONS = ['NIGHT HARBOR(夜・港・殲滅)', 'ARMS DEAL(昼・砂漠・戦車爆破)', 'SKY TOWER(早朝・ビル制圧・ボス)', 'IRON JUNGLE(夕・密林・殲滅)', 'BLACK REFINERY(夜・製油所爆破)'];
  const WEAPONS = ['M4A1 カービン', 'MP5SD', 'USP .45', 'M870 ショットガン', 'SR-25 DMR', 'VSS 消音スナイパー'];

  // ---- ガンスミス: C# の Gunsmith.cs と同じ詰め方(一の位=光学 十=銃口 百=グリップ 千=弾倉 万=レーザー) ----
  const KINDS = ['AR', 'SMG', 'PISTOL', 'SG', 'DMR', 'DMR'];
  const ATT = {
    o: ['標準アイアン', 'ドットサイト', 'ホロサイト', '4倍スコープ'],
    m: ['なし', 'サプレッサー', 'コンペンセイター', 'ロングバレル'],
    g: ['なし', 'バーティカルグリップ', 'アングルグリップ'],
    a: ['標準マガジン', '拡張マガジン', '速射マガジン'],
    l: ['なし', 'レーザーサイト']
  };
  const ATT_LABEL = { o: '光学', m: '銃口', g: 'グリップ', a: 'マガジン', l: 'レーザー' };
  const DEC = at => ({ o: at % 10, m: Math.floor(at / 10) % 10, g: Math.floor(at / 100) % 10, a: Math.floor(at / 1000) % 10, l: Math.floor(at / 10000) % 10 });
  const ENC = d => d.o + d.m * 10 + d.g * 100 + d.a * 1000 + d.l * 10000;
  function fixAt(w, at) {
    const d = DEC(at | 0), k = KINDS[w] || 'AR';
    d.o = Math.min(3, d.o); d.m = Math.min(3, d.m); d.g = Math.min(2, d.g); d.a = Math.min(2, d.a); d.l = Math.min(1, d.l);
    if (k === 'DMR') d.o = 0;
    if (k === 'PISTOL') { d.g = 0; if (d.o === 3) d.o = 0; }
    if (k === 'SG') d.g = 0;
    return ENC(d);
  }
  function attOptions(w, key) {
    const k = KINDS[w] || 'AR';
    if (key === 'o' && k === 'DMR') return [0];
    if (key === 'o' && k === 'PISTOL') return [0, 1, 2];
    if (key === 'g' && (k === 'PISTOL' || k === 'SG')) return [0];
    return ATT[key].map((_, i) => i);
  }
  function attNote(at) {
    const d = DEC(at), n = [];
    if (d.o === 1) n.push('照準: ドット'); if (d.o === 2) n.push('照準: ホロ(拡大少し)'); if (d.o === 3) n.push('4倍ズーム');
    if (d.m === 1) n.push('発砲音を消す(威力 -10%)'); if (d.m === 2) n.push('反動 -22%'); if (d.m === 3) n.push('射程 +30% 威力 +6%');
    if (d.g === 1) n.push('反動 -18%'); if (d.g === 2) n.push('ブレ -12%');
    if (d.a === 1) n.push('弾数 +50% / リロード遅い'); if (d.a === 2) n.push('リロード -28%');
    if (d.l === 1) n.push('腰だめのブレ -30%');
    return n.length ? n.join(' / ') : 'ノーマル';
  }

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

  // ---- 見た目: 9桁(迷彩 肌 ヘルメット マスク ゴーグル ベスト バックパック ひげ 髪)に 1e9 を足した整数。C# の HumanoidSpec.FromLook と同じ ----
  const LOOK = [
    { k: 'camo', n: '迷彩', o: ['フォレスト', 'デザート', 'オリーブ', 'アーバン', 'ブラック', 'マルチ'] },
    { k: 'skin', n: '肌', o: ['色白', '標準', '褐色'] },
    { k: 'helmet', n: 'ヘルメット', o: ['なし', 'タイプA', 'タイプB', 'タイプC', 'タイプD'] },
    { k: 'mask', n: 'マスク', o: ['なし', 'バラクラバ', 'ネックゲイター'] },
    { k: 'goggles', n: 'ゴーグル', o: ['なし', 'あり'] },
    { k: 'vest', n: 'ベスト', o: ['なし', 'プレート', 'チェストリグ'] },
    { k: 'pack', n: 'バックパック', o: ['なし', 'あり'] },
    { k: 'beard', n: 'ひげ', o: ['なし', 'あり'] },
    { k: 'hair', n: '髪', o: ['なし', 'あり'] }
  ];
  const lookDec = lk => { let v = lk - 1e9; const d = []; for (let i = 8; i >= 0; i--) { d[i] = v % 10; v = Math.floor(v / 10); } return d; };
  const lookEnc = d => 1e9 + d.reduce((a, x) => a * 10 + x, 0);
  function defaultLook() { return lookEnc([4, 1, 1, 0, 0, 1, 0, 0, 0]); }

  function loadLoadout() {
    let lo = null;
    try { lo = JSON.parse(store.get('bodycam-lo') || 'null'); } catch (e) { }
    if (!lo || typeof lo !== 'object') lo = { p: 0, s: 2, sp: 1, at: 10, at2: 0 };
    lo.at = lo.at | 0; lo.at2 = lo.at2 | 0; lo.lk = (lo.lk | 0) >= 1e9 ? lo.lk | 0 : defaultLook();
    if (Q.has('p')) lo.p = +Q.get('p') | 0; // テスト用
    if (Q.has('s')) lo.s = +Q.get('s') | 0;
    lo.p = Math.min(5, Math.max(0, lo.p | 0)); lo.s = Math.min(5, Math.max(0, lo.s | 0)); lo.sp = lo.sp ? 1 : 0;
    lo.at = fixAt(lo.p, lo.at); lo.at2 = fixAt(lo.s, lo.at2); lo.sp = DEC(lo.at).m === 1 ? 1 : 0;
    return lo;
  }

  const S = {
    unity: null, api: null, room: null, code: '', me: null, jt: 0,
    name: (Q.get('name') || store.get('bodycam-name') || ('Operator' + Math.floor(Math.random() * 900 + 100))).slice(0, 12),
    mode: 0, ms: 1, view: 'loading', inGame: false, lastGo: 0, go: null, roster: [],
    game: null, evq: [], lo: loadLoadout(),
    hard: store.get('bodycam-hard') === '1' || Q.has('hard'), ff: store.get('bodycam-ff') === '1', tab: Q.get('tab') || 'home', slot: 0, autostart: Q.get('autostart'), minp: +(Q.get('minp') || 2), autoStarted: false
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
      return { id: p.peer, n: p.isMe ? S.name : String(p.presence.n || '?').slice(0, 12), p: lo.p | 0, s: lo.s | 0, sp: lo.sp ? 1 : 0, at: lo.at | 0, at2: lo.at2 | 0, tm: i % 2, lk: lo.lk | 0 };   // tm: 入った順に赤(0)/青(1)
    });
    S.go = { t: Date.now(), mode: S.mode, ms: S.ms, roster: roster, seed: Math.floor(Math.random() * 1e6) + 1, hd: S.hard ? 1 : 0, ff: S.ff ? 1 : 0 };
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
    sendUnity('Game', 'OnSolo', JSON.stringify({ ms: ms, p: S.lo.p, s: S.lo.s, sp: S.lo.sp, at: S.lo.at | 0, at2: S.lo.at2 | 0, hd: S.hard ? 1 : 0, lk: S.lo.lk | 0 }));
  }

  // ================= 画面 =================
  function show(v) {
    S.view = v;
    for (const id of ['menu', 'lobby']) $('#' + id).classList.toggle('hidden', v !== id);
    if (v === 'menu') renderMenu(); else if (v === 'lobby') { S.ltab = 'room'; renderLobby(true); } else sr({ v: 'off' });
  }
  function status(t) { const a = $('#menuStat'), b = $('#lobbyStat'); if (a) a.textContent = t; if (b && S.view === 'lobby') b.textContent = t; }

  function smithHtml(slot) {
    const key = slot === 0 ? 'at' : 'at2', w = slot === 0 ? S.lo.p : S.lo.s, d = DEC(S.lo[key]);
    let h = '<div class="smith"><b>' + (slot === 0 ? '主武器' : '副武器') + ' ' + esc(WEAPONS[w]) + ' のカスタム</b><div class="lo">';
    for (const k of ['o', 'm', 'g', 'a', 'l']) {
      const opts = attOptions(w, k);
      h += '<label>' + ATT_LABEL[k] + ' <select data-at="' + key + ':' + k + '"' + (opts.length < 2 ? ' disabled' : '') + '>' +
        opts.map(i => '<option value="' + i + '"' + (i === d[k] ? ' selected' : '') + '>' + esc(ATT[k][i]) + '</option>').join('') + '</select></label>';
    }
    return h + '</div><div class="note">' + esc(attNote(S.lo[key])) + '</div></div>';
  }

  function loadoutHtml(id) {
    const opt = (list, sel) => list.map((n, i) => '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    return '<div class="lo"><label>主武器 <select data-k="p">' + opt(WEAPONS, S.lo.p) + '</select></label>' +
      '<label>副武器 <select data-k="s">' + opt(WEAPONS, S.lo.s) + '</select></label>' +
      '<label><input type="checkbox" data-k="hard"' + (S.hard ? ' checked' : '') + '> ハードモード(敵4倍・被弾2発で死亡)</label></div>' +
      '<details class="gs" open><summary>ガンスミス(銃のカスタム)</summary>' + smithHtml(0) + smithHtml(1) + '</details>';
  }
  function bindLoadout(root) {
    const redraw = () => { const sc = root.id; root.innerHTML = loadoutHtml(); bindLoadout(root); };
    root.querySelectorAll('[data-k]').forEach(el => el.addEventListener('change', () => {
      const k = el.dataset.k;
      if (k === 'hard') { S.hard = el.checked; store.set('bodycam-hard', S.hard ? '1' : '0'); return; }
      S.lo[k] = k === 'sp' ? (el.checked ? 1 : 0) : (+el.value | 0);
      S.lo.at = fixAt(S.lo.p, S.lo.at); S.lo.at2 = fixAt(S.lo.s, S.lo.at2); S.lo.sp = DEC(S.lo.at).m === 1 ? 1 : 0;
      store.set('bodycam-lo', JSON.stringify(S.lo));
      redraw();
    }));
    root.querySelectorAll('[data-at]').forEach(el => el.addEventListener('change', () => {
      const [key, k] = el.dataset.at.split(':'), d = DEC(S.lo[key]);
      d[k] = +el.value | 0; S.lo[key] = fixAt(key === 'at' ? S.lo.p : S.lo.s, ENC(d));
      S.lo.sp = DEC(S.lo.at).m === 1 ? 1 : 0;
      store.set('bodycam-lo', JSON.stringify(S.lo));
      redraw();
    }));
  }

  // ---- ショールーム(Unity 側の3D表示)へ今の内容を送る ----
  function sr(o) {
    if (!S.unity) return;
    if (o.v !== 'off') { const W = innerWidth, pw = Math.min(520, W); o.sx = W < 760 ? 0 : -((pw + (W - pw) / 2) / W - 0.5); }
    sendUnity('Showroom', 'Show', JSON.stringify(o));
  }
  function srUpdate() {
    if (S.view !== 'menu') return;
    if (S.tab === 'armory') { const w = S.slot ? S.lo.s : S.lo.p; sr({ v: 'gun', w: w, at: S.slot ? S.lo.at2 : S.lo.at }); }
    else if (S.tab === 'operator') sr({ v: 'body', lk: S.lo.lk });
    else sr({ v: 'off' });
  }
  const saveLo = () => { S.lo.sp = DEC(S.lo.at).m === 1 ? 1 : 0; store.set('bodycam-lo', JSON.stringify(S.lo)); };
  const segHtml = (opts, sel, attr) => '<div class="seg">' + opts.map(([i, n]) => '<button class="sg' + (i === sel ? ' on' : '') + '" ' + attr + ' data-v="' + i + '">' + esc(n) + '</button>').join('') + '</div>';

  const TABS = [['home', 'HOME'], ['solo', 'SOLO OPS'], ['online', 'ONLINE'], ['armory', 'ARMORY'], ['operator', 'OPERATOR']];
  function tabHtml(t) {
    t = t || S.tab;
    if (t === 'solo') {
      return '<div class="sec">MISSION SELECT</div><div class="cards mgrid">' + MISSIONS.map((m, i) => {
        const [a, b] = m.split('('); return '<button class="card" data-ms="' + i + '"><span class="tagc">0' + (i + 1) + '</span><b>' + esc(a) + '</b><small>' + esc((b || '').replace(')', '')) + '</small></button>';
      }).join('') + '</div>' +
        '<div class="toggle' + (S.hard ? ' on' : '') + '" data-hard><i></i><span><b>HARD MODE</b>　敵が4倍・被弾1〜2発で死亡</span></div>';
    }
    if (t === 'online') {
      return '<div class="sec">MULTIPLAYER</div><div class="cards"><button class="card big" id="create"><b>部屋を作る</b><small>協力 / チーム戦 / 個人戦 · 最大8人 · 招待URLで友達を呼ぶ</small></button></div>' +
        '<div class="sec">JOIN</div><div class="row"><input id="joinCode" placeholder="CODE" maxlength="8"><button id="join" class="btn primary">参加する</button></div>';
    }
    if (t === 'armory') {
      const w = S.slot ? S.lo.s : S.lo.p, key = S.slot ? 'at2' : 'at', d = DEC(S.lo[key]);
      let h = '<div class="sec">LOADOUT</div><div class="slotbar">' +
        '<button class="slot' + (!S.slot ? ' on' : '') + '" data-slot="0"><small>PRIMARY</small><b>' + esc(WEAPONS[S.lo.p]) + '</b></button>' +
        '<button class="slot' + (S.slot ? ' on' : '') + '" data-slot="1"><small>SECONDARY</small><b>' + esc(WEAPONS[S.lo.s]) + '</b></button></div>' +
        '<div class="sec">WEAPON</div>' + segHtml(WEAPONS.map((n, i) => [i, n]), w, 'data-w="1"') +
        '<div class="sec">GUNSMITH</div>';
      for (const k of ['o', 'm', 'g', 'a', 'l']) {
        const opts = attOptions(w, k);
        h += '<div class="arow"><span>' + ATT_LABEL[k] + '</span>' + segHtml(opts.map(i => [i, ATT[k][i]]), d[k], 'data-att="' + k + '"') + '</div>';
      }
      return h + '<div class="note2">' + esc(attNote(S.lo[key])) + '</div><div class="hint3d">DRAG TO ROTATE</div>';
    }
    if (t === 'operator') {
      const d = lookDec(S.lo.lk);
      let h = '<div class="sec">OPERATOR APPEARANCE</div>';
      LOOK.forEach((g, gi) => { h += '<div class="arow"><span>' + g.n + '</span>' + segHtml(g.o.map((n, i) => [i, n]), d[gi], 'data-look="' + gi + '"') + '</div>'; });
      return h + '<div class="row"><button class="btn small" id="rndLook">ランダム</button></div><div class="note2">チーム戦では迷彩がチームカラーに固定されます。自分の腕の袖にも迷彩が反映されます。</div><div class="hint3d">DRAG TO ROTATE</div>';
    }
    // home
    return '<div class="sec">DEPLOY</div><div class="cards">' +
      '<button class="card big" data-go="solo"><span class="tagc">SOLO</span><b>ソロ任務</b><small>5つの作戦を一人で。ハードモードもあり</small></button>' +
      '<button class="card big" data-go="online"><span class="tagc">ONLINE</span><b>オンライン</b><small>協力・チーム戦・個人戦。フレンドリーファイアの切替も</small></button>' +
      '<button class="card" data-go="armory"><span class="tagc">ARMORY</span><b>ガンスミス</b><small>' + esc(WEAPONS[S.lo.p]) + ' / ' + esc(WEAPONS[S.lo.s]) + ' · 銃を見ながらカスタム</small></button>' +
      '<button class="card" data-go="operator"><span class="tagc">OPERATOR</span><b>見た目を選ぶ</b><small>迷彩・ヘルメット・マスク・ベスト…</small></button></div>';
  }

  function bindTab(T, rerender, go) {
    T.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    T.querySelectorAll('[data-ms]').forEach(b => b.addEventListener('click', () => startSolo(+b.dataset.ms)));
    T.querySelectorAll('[data-hard]').forEach(b => b.addEventListener('click', () => { S.hard = !S.hard; store.set('bodycam-hard', S.hard ? '1' : '0'); rerender(); }));
    T.querySelectorAll('[data-slot]').forEach(b => b.addEventListener('click', () => { S.slot = +b.dataset.slot; rerender(); }));
    T.querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', () => {
      const k = S.slot ? 's' : 'p'; S.lo[k] = +b.dataset.v;
      S.lo.at = fixAt(S.lo.p, S.lo.at); S.lo.at2 = fixAt(S.lo.s, S.lo.at2); saveLo(); rerender();
    }));
    T.querySelectorAll('[data-att]').forEach(b => b.addEventListener('click', () => {
      const key = S.slot ? 'at2' : 'at', d = DEC(S.lo[key]); d[b.dataset.att] = +b.dataset.v;
      S.lo[key] = fixAt(S.slot ? S.lo.s : S.lo.p, ENC(d)); saveLo(); rerender();
    }));
    T.querySelectorAll('[data-look]').forEach(b => b.addEventListener('click', () => {
      const d = lookDec(S.lo.lk); d[+b.dataset.look] = +b.dataset.v; S.lo.lk = lookEnc(d); saveLo(); rerender();
    }));
    const rl = T.querySelector('#rndLook'); if (rl) rl.addEventListener('click', () => { S.lo.lk = lookEnc(LOOK.map(g => Math.floor(Math.random() * g.o.length))); saveLo(); rerender(); });
    const cr = T.querySelector('#create'); if (cr) cr.addEventListener('click', () => joinRoom(Math.random().toString(36).slice(2, 7).toUpperCase()));
    const jn = T.querySelector('#join'); if (jn) jn.addEventListener('click', () => joinRoom(T.querySelector('#joinCode').value));
    const jc = T.querySelector('#joinCode'); if (jc) jc.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(jc.value); });
  }

  function renderMenu() {
    $('#name').value = S.name; $('#menu').dataset.tab = S.tab;
    $('#nav').innerHTML = TABS.map(([k, n]) => '<button class="nv' + (S.tab === k ? ' on' : '') + '" data-tab="' + k + '">' + n + '</button>').join('');
    $('#tab').innerHTML = tabHtml();
    const go = k => { S.tab = k; renderMenu(); };
    $('#nav').querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
    bindTab($('#tab'), renderMenu, go);
    srUpdate();
  }

  let lobbyKey = '';
  S.ltab = 'room';
  function lobbySr() {
    if (S.view !== 'lobby') return;
    if (S.ltab === 'armory') { const w = S.slot ? S.lo.s : S.lo.p; sr({ v: 'gun', w: w, at: S.slot ? S.lo.at2 : S.lo.at }); }
    else if (S.ltab === 'operator') sr({ v: 'body', lk: S.lo.lk });
    else sr({ v: 'lobby', ps: members().map(p => { const lo = p.isMe ? S.lo : (p.presence.lo || {}); return { lk: lo.lk | 0, w: lo.p | 0, at: lo.at | 0, tm: 0 }; }) });
  }
  function renderLobby(force) {
    if (S.view !== 'lobby' || !S.room) return;
    const peers = members(), leader = lobbyLeaderId(), me = isLobbyLeader();
    const key = JSON.stringify([peers.map(p => [p.peer, p.presence.n, p.presence.lo]), S.mode, S.ms, me, S.name, S.ltab, S.ff]);
    $('#lcode').textContent = S.code;
    if (!force && key === lobbyKey) return;
    lobbyKey = key;
    const goL = k => { S.ltab = k; lobbyKey = ''; renderLobby(true); };
    $('#lnav').innerHTML = [['room', 'ROOM'], ['armory', 'ARMORY'], ['operator', 'OPERATOR']].map(([k, n]) => '<button class="nv' + (S.ltab === k ? ' on' : '') + '" data-lt="' + k + '">' + n + '</button>').join('');
    $('#lnav').querySelectorAll('[data-lt]').forEach(b => b.addEventListener('click', () => goL(b.dataset.lt)));
    $('#roomBody').classList.toggle('hidden', S.ltab !== 'room'); $('#ltab').classList.toggle('hidden', S.ltab === 'room');
    if (S.ltab !== 'room') {
      $('#ltab').innerHTML = tabHtml(S.ltab);
      bindTab($('#ltab'), () => { lobbyKey = ''; renderLobby(true); }, goL);
      lobbySr(); return;
    }
    $('#invite').value = location.origin + location.pathname + '?room=' + S.code;
    $('#players').innerHTML = peers.map((p, i) => '<div class="pl' + (p.isMe ? ' me' : '') + '"><span>' + esc(p.isMe ? S.name : p.presence.n) + (p.peer === leader ? ' ★' : '') +
      '</span><span class="tag2">' + esc(WEAPONS[(p.isMe ? S.lo.p : (p.presence.lo || {}).p) | 0] || '') + ' / チーム' + (i % 2 === 0 ? '赤' : '青') + '</span></div>').join('');
    $('#modes').innerHTML = MODES.map((m, i) => '<button class="btn' + (i === S.mode ? ' on' : '') + '" data-mode="' + i + '"' + (me ? '' : ' disabled') + '>' + esc(m.n) + '</button>').join('');
    $('#modeDesc').textContent = MODES[S.mode].d;
    $('#ffRow').innerHTML = '<label class="toggle' + (S.ff ? ' on' : '') + '" id="ffBtn" style="' + (me ? '' : 'pointer-events:none;opacity:.7') + '"><i></i><span><b>フレンドリーファイア</b>　味方の弾・手榴弾でもダメージ(チーム戦では味方撃ち -1キル)</span></label>';
    $('#ffBtn').addEventListener('click', () => { S.ff = !S.ff; store.set('bodycam-ff', S.ff ? '1' : '0'); lobbyKey = ''; renderLobby(true); });
    $('#missions').innerHTML = MISSIONS.map((m, i) => '<button class="btn' + (i === S.ms ? ' on' : '') + '" data-ms="' + i + '"' + (me ? '' : ' disabled') + '>' + esc(m) + '</button>').join('');
    $('#modes').querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { S.mode = +b.dataset.mode; lobbyKey = ''; renderLobby(true); }));
    $('#missions').querySelectorAll('[data-ms]').forEach(b => b.addEventListener('click', () => { S.ms = +b.dataset.ms; lobbyKey = ''; renderLobby(true); }));
    const start = $('#start');
    const prob = startProblem(peers.length);
    start.disabled = !me || !!prob;
    start.textContent = me ? 'START' : 'リーダー(★)がスタートするのを待っています';
    $('#lobbyStat').textContent = me ? prob : '';
    lobbySr();
  }

  function startProblem(n) {
    if (S.mode === 1 && n < 2) return 'チーム戦は2人以上で遊べます';
    if (S.mode === 2 && n < 2) return '個人戦は2人以上で遊べます';
    return '';
  }

  // ================= 起動 =================
  $('#name').addEventListener('input', e => { S.name = e.target.value.slice(0, 12) || S.name; store.set('bodycam-name', S.name); });
  $('#leave').addEventListener('click', leaveRoom);
  $('#start').addEventListener('click', () => { if (isLobbyLeader() && !startProblem(members().length)) leaderStart(); });
  $('#copy').addEventListener('click', () => { const i = $('#invite'); i.select(); try { document.execCommand('copy'); } catch (e) { } $('#lobbyStat').textContent = 'コピーしました'; });
  addEventListener('resize', () => srUpdate());
  show('menu');
})();
