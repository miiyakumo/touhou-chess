"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Controller = void 0;
exports.msg = msg;
const voice_js_1 = require("../net/voice.js");
const authority_js_1 = require("../room/authority.js");
const store_js_1 = require("../room/store.js");
const types_js_1 = require("../room/types.js");
const engine_js_1 = require("../domain/engine.js");
const host_session_js_1 = require("../net/host-session.js");
const client_session_js_1 = require("../net/client-session.js");
const peer_js_1 = require("../net/peer.js");
const catalog_js_1 = require("./catalog.js");
class Controller {
    state = { volatile: false, view: null, mode: 'home', busy: false, busyText: '', error: '', status: '', signalWarning: '', connected: false, hasSave: false, savedSummary: '', pending: 0 };
    settings = (0, peer_js_1.defaultSettings)();
    voice = new voice_js_1.VoiceRoom(() => this.emit());
    listeners = new Set();
    authority = null;
    host = null;
    client = null;
    peer = null;
    store = null;
    release = null;
    interval = null;
    reconnectTimer = null;
    visibilityOff = null;
    peerOff = null;
    peerReconnectTimer = null;
    sessionAbort = new AbortController();
    connectionAttempt = null;
    cleanupTask = null;
    stopSubscription = null;
    invite = null;
    closed = false;
    connecting = false;
    beat = 0;
    demoRunning = false;
    hostPending = false;
    tickRunning = false;
    constructor() {
        try {
            const raw = localStorage.getItem('rls-network-settings');
            if (raw)
                this.settings = { ...this.settings, ...JSON.parse(raw) };
        }
        catch { /* defaults */ }
    }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { for (const fn of this.listeners)
        fn(); }
    patch(x) { Object.assign(this.state, x); this.voice.update(this.state.view, this.state.connected); this.emit(); }
    beginSession() {
        this.sessionAbort.abort();
        this.cancelConnectionAttempt();
        this.sessionAbort = new AbortController();
        this.closed = false;
        return this.sessionAbort.signal;
    }
    current(signal) { return this.sessionAbort.signal === signal && !signal.aborted && !this.closed; }
    requireCurrent(signal) { if (!this.current(signal))
        throw cancelled(); }
    async failSession(signal, error) {
        if (!this.current(signal))
            return false;
        let detail = msg(error);
        try {
            await this.cleanup();
        }
        catch (cleanupError) {
            detail += '；' + msg(cleanupError);
        }
        if (this.sessionAbort.signal !== signal)
            return false;
        this.patch({ mode: 'home', view: null, connected: false, pending: 0, status: '', signalWarning: '', error: detail });
        return true;
    }
    cancelConnectionAttempt() {
        const attempt = this.connectionAttempt;
        this.connectionAttempt = null;
        this.connecting = false;
        attempt?.abort.abort();
        if (this.reconnectTimer)
            clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }
    unwatchPeer() {
        this.visibilityOff?.();
        this.visibilityOff = null;
        this.peerOff?.();
        this.peerOff = null;
        if (this.peerReconnectTimer)
            clearTimeout(this.peerReconnectTimer);
        this.peerReconnectTimer = null;
    }
    async init() {
        const signal = this.sessionAbort.signal;
        try {
            const store = await (0, store_js_1.openRoomStore)();
            const saved = await store.load();
            if (this.sessionAbort.signal === signal && this.state.mode === 'home')
                this.patch({ hasSave: !!saved, savedSummary: saved ? `${saved.members.length} 人 · ${saved.game ? '第 ' + saved.game.day + ' 天' : '房间大厅'}` : '' });
        }
        catch { /* home and offline demonstration still work; hosting shows precise storage errors */ }
    }
    setSettings(settings) {
        if (this.state.mode !== 'home')
            throw Error('请先离开当前房间，再修改联机设置。');
        localStorage.setItem('rls-network-settings', JSON.stringify(settings));
        this.settings = settings;
    }
    startClock() {
        if (this.interval)
            clearInterval(this.interval);
        const signal = this.sessionAbort.signal;
        this.interval = setInterval(() => {
            if (!this.current(signal))
                return;
            if (this.authority && !this.tickRunning) {
                const authority = this.authority;
                this.tickRunning = true;
                void (async () => {
                    try {
                        if (this.state.mode === 'demo')
                            await this.driveDemo();
                        if (this.current(signal) && this.authority === authority)
                            await authority.tick();
                    }
                    catch (e) {
                        if (this.current(signal))
                            this.patch({ error: msg(e) });
                    }
                    finally {
                        if (this.sessionAbort.signal === signal)
                            this.tickRunning = false;
                    }
                })();
            }
            if (++this.beat % 20 === 0) {
                this.host?.sweep();
                try {
                    this.client?.heartbeat();
                }
                catch { /* reconnect callback handles actual channel loss */ }
            }
        }, 250);
    }
    watchPeer(peer) {
        this.unwatchPeer();
        const active = () => !this.closed && this.peer === peer && !peer.destroyed;
        const onVisibility = () => {
            if (document.visibilityState !== 'visible' || !active())
                return;
            if (!peer.destroyed && peer.disconnected) {
                try {
                    peer.reconnect();
                }
                catch { /* the normal retry path will surface the error */ }
            }
            // A mobile browser can suspend the data-channel timer while the
            // signaling socket survives. Re-run the normal guest retry path
            // as soon as the page is visible again.
            if (this.client && !this.client.connected && !this.connecting)
                this.syncGuest();
        };
        document.addEventListener('visibilitychange', onVisibility);
        this.visibilityOff = () => document.removeEventListener('visibilitychange', onVisibility);
        const disconnected = () => {
            if (!active())
                return;
            this.patch({ signalWarning: '信令连接暂时断开。已建立的数据通道可继续，新加入与重连可能受影响。' });
            if (this.peerReconnectTimer)
                clearTimeout(this.peerReconnectTimer);
            const timer = setTimeout(() => { if (this.peerReconnectTimer !== timer)
                return; this.peerReconnectTimer = null; if (active() && peer.disconnected)
                try {
                    peer.reconnect();
                }
                catch { /* status remains */ } }, 2500);
            this.peerReconnectTimer = timer;
        };
        const opened = () => { if (active())
            this.patch({ signalWarning: '' }); };
        const errored = e => {
            if (active())
                this.patch({ signalWarning: '联机提示：' + msg(e) + '。请确认房主在线，或检查信令 / TURN 设置。' });
        };
        peer.on('disconnected', disconnected);
        peer.on('open', opened);
        peer.on('error', errored);
        this.peerOff = () => { peer.off('disconnected', disconnected); peer.off('open', opened); peer.off('error', errored); };
    }
    async create(name, replace = false, size = 12, volatile = false) {
        if (this.state.busy)
            return;
        const signal = this.beginSession();
        this.patch({ volatile, busy: true, busyText: volatile ? '正在创建临时房间…' : '正在准备房主存档…', error: '' });
        try {
            if (volatile)
                this.store = new authority_js_1.MemoryRoomStore();
            else {
                const release = await (0, store_js_1.acquireHostLock)('current');
                if (!this.current(signal)) {
                    release();
                    throw cancelled();
                }
                this.release = release;
                const store = await (0, store_js_1.openRoomStore)();
                this.requireCurrent(signal);
                this.store = store;
            }
            const existing = await this.store.load();
            this.requireCurrent(signal);
            if (existing && !replace)
                throw Error('本机还有房间存档。请恢复，或明确确认替换后再建房。');
            const data = authority_js_1.RoomAuthority.fresh(name, (0, types_js_1.randomId)(), false, (0, types_js_1.randomId)(), Date.now(), size);
            data.ephemeral = volatile;
            await this.store.save(data);
            this.requireCurrent(signal);
            await this.bootHost(data, false, signal);
        }
        catch (e) {
            if (await this.failSession(signal, e))
                await this.init();
        }
        finally {
            if (this.sessionAbort.signal === signal)
                this.patch({ busy: false });
        }
    }
    async restore() {
        if (this.state.busy)
            return;
        const signal = this.beginSession();
        this.patch({ volatile: false, busy: true, busyText: '正在恢复已保存的房间…', error: '' });
        try {
            const release = await (0, store_js_1.acquireHostLock)('current');
            if (!this.current(signal)) {
                release();
                throw cancelled();
            }
            this.release = release;
            const store = await (0, store_js_1.openRoomStore)();
            this.requireCurrent(signal);
            this.store = store;
            const data = await this.store.load();
            this.requireCurrent(signal);
            if (!data)
                throw Error('没有可恢复的房主存档。');
            await this.bootHost(data, true, signal);
        }
        catch (e) {
            await this.failSession(signal, e);
        }
        finally {
            if (this.sessionAbort.signal === signal)
                this.patch({ busy: false });
        }
    }
    async bootHost(data, restoring = false, signal = this.sessionAbort.signal) {
        this.requireCurrent(signal);
        const authority = new authority_js_1.RoomAuthority(data, this.store);
        this.authority = authority;
        if (restoring)
            await authority.restore();
        this.requireCurrent(signal);
        this.patch({ busyText: '正在连接信令服务…' });
        const peer = await (0, peer_js_1.openPeer)(data.hostPeer, this.settings, signal);
        if (!this.current(signal)) {
            peer.destroy();
            throw cancelled();
        }
        this.peer = peer;
        await authority.setPeerId(peer.id);
        this.requireCurrent(signal);
        this.watchPeer(peer);
        const host = new host_session_js_1.HostSession(authority, (0, types_js_1.randomId)(), Date.now, (link, seat) => { if (this.current(signal))
            this.voice.bind(link, seat); });
        this.host = host;
        (0, peer_js_1.acceptPeer)(peer, link => { if (this.current(signal) && this.host === host)
            host.accept(link); else
            link.close(); });
        this.stopSubscription = authority.subscribe(() => { if (this.current(signal))
            this.syncHost(); });
        this.patch({ mode: 'host', connected: true, status: '房主在线', hasSave: true });
        this.syncHost();
        this.startClock();
    }
    syncHost() {
        if (this.authority) {
            const view = this.authority.view(1);
            const pending = this.hostPending ? 1 : 0;
            if (JSON.stringify(view) !== JSON.stringify(this.state.view) || pending !== this.state.pending)
                this.patch({ view, pending });
        }
    }
    async demo(name = '你', size = 12) {
        if (this.state.busy)
            return;
        const signal = this.beginSession();
        this.patch({ busy: true, busyText: '正在启动演示…', error: '' });
        try {
            this.store = new authority_js_1.MemoryRoomStore();
            const data = authority_js_1.RoomAuthority.fresh(name || '你', (0, types_js_1.randomId)(), true, (0, types_js_1.randomId)(), Date.now(), size);
            await this.store.save(data);
            this.requireCurrent(signal);
            const authority = new authority_js_1.RoomAuthority(data, this.store, { seed: () => 83291, ...(size === 12 ? { demoRoles: ['reimu', 'human', 'akyuu', 'human', 'many-gods', 'vampire', 'fairy', 'tengu', 'fairy', 'human', 'oni', 'fairy'] } : {}) });
            this.authority = authority;
            for (let i = 2; i <= size; i++) {
                this.requireCurrent(signal);
                const seat = await authority.join(catalog_js_1.DEMO_NAMES[i - 1], (0, types_js_1.randomId)());
                this.requireCurrent(signal);
                await authority.setOnline(seat, true);
                this.requireCurrent(signal);
                await authority.dispatch(seat, (0, types_js_1.randomId)(), '', { kind: 'ready', value: true });
            }
            this.requireCurrent(signal);
            this.stopSubscription = authority.subscribe(() => { if (this.current(signal) && this.authority === authority)
                this.syncHost(); });
            this.patch({ mode: 'demo', connected: true, status: `离线演示 · ${size - 1} 个固定策略席位`, pending: 0 });
            this.syncHost();
            this.startClock();
        }
        catch (e) {
            await this.failSession(signal, e);
        }
        finally {
            if (this.sessionAbort.signal === signal)
                this.patch({ busy: false });
        }
    }
    async driveDemo() {
        if (this.demoRunning || !this.authority)
            return;
        const authority = this.authority, signal = this.sessionAbort.signal;
        this.demoRunning = true;
        try {
            let s = authority.snapshot();
            if (s.status === 'lobby') {
                for (const m of s.members) {
                    if (!this.current(signal))
                        return;
                    if (m.seat !== 1 && !m.ready)
                        await authority.dispatch(m.seat, (0, types_js_1.randomId)(), s.matchId, { kind: 'ready', value: true });
                }
                return;
            }
            if (s.status !== 'playing' || s.paused || !s.game || !s.gate)
                return;
            for (const seat of (0, engine_js_1.pendingActors)(s.game)) {
                if (!this.current(signal))
                    return;
                const game = s.game, gate = s.gate;
                if (!game || !gate)
                    return;
                if (seat === 1 || gate.pending[String(seat)])
                    continue;
                const a = (0, engine_js_1.promptFor)(game, seat);
                const base = { kind: 'play', serial: game.stepSerial };
                let intent;
                if (a.kind === 'ack')
                    intent = { ...base, move: 'ack' };
                else if (a.kind === 'skill')
                    intent = { ...base, move: 'skill', targets: a.candidates.slice(0, a.targetCount) };
                else {
                    // Fixed, non-strategic seats. They are explicitly NOT real users or strength-tested AI.
                    const target = a.candidates[(game.day + 2) % a.candidates.length] ?? null;
                    intent = { ...base, move: 'vote', target };
                }
                await authority.dispatch(seat, (0, types_js_1.randomId)(), s.matchId, intent);
                s = authority.snapshot();
            }
        }
        finally {
            if (this.sessionAbort.signal === signal)
                this.demoRunning = false;
        }
    }
    profile(inv, name) {
        const key = 'rls-v4-player-' + inv.roomId;
        let profile;
        const raw = this.state.volatile ? null : localStorage.getItem(key);
        if (raw) {
            profile = JSON.parse(raw);
            if (!profile || typeof profile.token !== 'string' || !/^[a-f0-9]{32}$/.test(profile.token) || !Array.isArray(profile.pending)
                || profile.legacyPending !== undefined && !Array.isArray(profile.legacyPending))
                throw Error('本机座位凭证损坏，请勿在进行中的房间清理站点数据。');
        }
        else
            profile = { token: (0, types_js_1.randomId)(), name, hostId: inv.hostId, pending: [] };
        profile.name = name || profile.name;
        profile.hostId = inv.hostId;
        if (!this.state.volatile)
            localStorage.setItem(key, JSON.stringify(profile));
        const volatile = this.state.volatile;
        const journal = {
            get pending() { return profile.pending; },
            get legacyPending() { return profile.legacyPending ?? []; },
            save(pending) {
                if (!volatile)
                    localStorage.setItem(key, JSON.stringify({ ...profile, pending }));
                profile.pending = pending;
            },
            archiveLegacy(messages) {
                const archived = new Set(messages);
                const pending = profile.pending.filter(m => !archived.has(m));
                const legacyPending = [...(profile.legacyPending ?? []), ...messages].slice(-16);
                // Move the original envelopes atomically; a failed write keeps
                // both the old journal and the in-memory profile unchanged.
                if (!volatile)
                    localStorage.setItem(key, JSON.stringify({ ...profile, pending, legacyPending }));
                profile.pending = pending;
                profile.legacyPending = legacyPending;
            },
        };
        return { profile, journal };
    }
    async join(link, name, volatile = false) {
        if (this.state.busy)
            return;
        const signal = this.beginSession();
        let inv = null;
        this.patch({ volatile, busy: true, busyText: '正在读取邀请…', error: '' });
        try {
            inv = (0, peer_js_1.parseInvitation)(link);
            this.invite = inv;
            const { profile, journal } = this.profile(inv, name);
            this.client = new client_session_js_1.ClientSession(inv.roomId, profile.token, profile.name, journal);
            this.stopSubscription = this.client.subscribe(() => this.syncGuest());
            await this.reconnectGuest();
            this.requireCurrent(signal);
            this.rememberInvitationURL();
            this.patch({ mode: 'guest' });
            this.startClock();
        }
        catch (e) {
            // A new invitation can supersede the connection attempt without
            // replacing the player session. Its older startup must not clean it up.
            if (this.invite === inv && e?.name !== 'AbortError')
                await this.failSession(signal, e);
        }
        finally {
            if (this.sessionAbort.signal === signal && (this.invite === inv || this.closed))
                this.patch({ busy: false });
        }
    }
    syncGuest() {
        if (!this.client || this.closed)
            return;
        this.patch({ view: this.client.view, connected: this.client.connected, pending: this.client.pendingCount,
            error: this.client.error || this.client.legacyNotice || '', status: this.client.kicked ? '已被房主移出房间' : this.client.replaced ? '座位已在其他页面连接' : this.client.connected ? '已连接房主' : '等待重新连接' });
        if (this.client.kicked || this.client.replaced) {
            this.cancelConnectionAttempt();
            this.unwatchPeer();
            this.peer?.destroy();
            this.peer = null;
            return;
        }
        if (!this.client.connected && !this.connecting && !this.reconnectTimer) {
            const client = this.client, signal = this.sessionAbort.signal;
            const timer = setTimeout(() => {
                if (this.reconnectTimer !== timer)
                    return;
                this.reconnectTimer = null;
                if (!this.current(signal) || this.client !== client || client.kicked || client.replaced)
                    return;
                void this.reconnectGuest().catch(e => {
                    if (!this.current(signal) || this.client !== client || e?.name === 'AbortError')
                        return;
                    this.patch({ error: msg(e) });
                    this.syncGuest();
                });
            }, 4000);
            this.reconnectTimer = timer;
        }
    }
    async reconnectGuest() {
        if (this.connecting || !this.client || !this.invite || this.closed || this.client.kicked || this.client.replaced)
            return;
        const client = this.client, invite = this.invite, session = this.sessionAbort.signal;
        const attempt = { abort: new AbortController() };
        this.connectionAttempt = attempt;
        const signal = attempt.abort.signal;
        const active = () => this.current(session) && !signal.aborted && this.connectionAttempt === attempt && this.client === client && this.invite === invite && !client.kicked && !client.replaced;
        const requireActive = () => { if (!active())
            throw cancelled(); };
        const onSessionAbort = () => attempt.abort.abort();
        session.addEventListener('abort', onSessionAbort, { once: true });
        this.connecting = true;
        let link = null;
        try {
            // Invitation owns signaling selection; each device keeps its own ICE/TURN credentials.
            const settings = { iceServers: this.settings.iceServers, ...invite.server };
            if (!this.peer || this.peer.destroyed) {
                this.patch({ busyText: '正在连接信令服务…' });
                const peer = await (0, peer_js_1.openPeer)(null, settings, signal);
                if (!active()) {
                    peer.destroy();
                    throw cancelled();
                }
                this.peer = peer;
                this.watchPeer(peer);
            }
            requireActive();
            this.patch({ busyText: '正在与房主建立数据通道…' });
            link = await (0, peer_js_1.connectPeer)(this.peer, invite.hostId, signal);
            requireActive();
            client.attach(link);
            requireActive();
            this.voice.bind(link, 1);
            await new Promise((res, rej) => {
                let off = () => { }, settled = false;
                const finish = error => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(t);
                    off();
                    signal.removeEventListener('abort', abort);
                    if (error)
                        rej(error);
                    else
                        res();
                };
                const abort = () => finish(cancelled());
                const t = setTimeout(() => finish(Error('数据通道已建立，但房间握手未完成。请检查房主是否仍在该房间。')), 12000);
                const check = () => {
                    if (!active())
                        finish(cancelled());
                    else if (client.connected)
                        finish();
                    else if (client.error)
                        finish(Error(client.error));
                };
                off = client.subscribe(check);
                if (settled) {
                    off();
                    return;
                }
                signal.addEventListener('abort', abort, { once: true });
                check();
            });
            requireActive();
        }
        catch (e) {
            // A superseded attempt may resolve despite cancellation (an adapter
            // or browser callback can already be queued). It owns only its link.
            link?.close();
            throw active() ? e : cancelled();
        }
        finally {
            session.removeEventListener('abort', onSessionAbort);
            if (this.connectionAttempt === attempt) {
                this.connectionAttempt = null;
                this.connecting = false;
                if (this.current(session) && this.client === client && this.state.mode === 'guest')
                    this.syncGuest();
            }
        }
    }
    async updateInvitation(text) {
        const inv = (0, peer_js_1.parseInvitation)(text);
        if (inv.roomId !== this.client?.roomId)
            throw Error('新邀请不是原房间。恢复原座位需要同一房间的新链接。');
        if (this.client.kicked || this.client.replaced)
            throw Error(this.client.error || '此连接已结束，请返回首页后重新加入。');
        const client = this.client, session = this.sessionAbort.signal;
        this.requireCurrent(session);
        this.cancelConnectionAttempt();
        this.invite = inv;
        this.client.detach();
        this.unwatchPeer();
        this.peer?.destroy();
        this.peer = null;
        const active = () => this.current(session) && this.client === client && this.invite === inv;
        this.patch({ busy: true, error: '', busyText: '正在使用新邀请重新连接…' });
        try {
            await this.reconnectGuest();
            if (!active())
                return;
            this.rememberInvitationURL();
            this.patch({ mode: 'guest' });
            if (!this.interval)
                this.startClock();
        }
        catch (e) {
            if (active() && e?.name !== 'AbortError')
                throw e;
        }
        finally {
            if (active())
                this.patch({ busy: false });
        }
    }
    rememberInvitationURL() {
        if (!this.invite)
            return;
        try {
            history.replaceState(null, '', (0, peer_js_1.invitationURL)(this.invite.roomId, this.invite.hostId, { iceServers: this.settings.iceServers, ...this.invite.server }));
        }
        catch { /* file/embedded previews can forbid URL changes */ }
    }
    async submit(intent) {
        const signal = this.sessionAbort.signal;
        this.requireCurrent(signal);
        if (this.state.pending)
            throw Error('上一项操作还在等待确认，请勿重复提交。');
        this.patch({ error: '' });
        if (this.authority) {
            const authority = this.authority;
            this.hostPending = true;
            this.patch({ pending: 1 });
            try {
                await authority.dispatch(1, (0, types_js_1.randomId)(), authority.snapshot().matchId, intent);
                this.requireCurrent(signal);
            }
            catch (e) {
                throw this.current(signal) ? e : cancelled();
            }
            finally {
                if (this.sessionAbort.signal === signal) {
                    this.hostPending = false;
                    this.patch({ pending: 0 });
                }
            }
        }
        else if (this.client) {
            const client = this.client;
            try {
                const result = await client.submit(intent);
                this.requireCurrent(signal);
                if (this.client !== client)
                    throw cancelled();
                return result;
            }
            catch (e) {
                throw this.current(signal) && this.client === client ? e : cancelled();
            }
        }
        else
            throw Error('请先进入房间。');
    }
    retry() { this.client?.retry(); }
    getInvite() {
        const v = this.state.view;
        if (!v || v.demo)
            throw Error('演示不创建联机邀请。');
        return (0, peer_js_1.invitationURL)(v.id, v.hostPeer, this.state.mode === 'guest' ? { iceServers: this.settings.iceServers, ...this.invite?.server } : this.settings, 'file:///room');
    }
    exportPublic() {
        const v = this.state.view;
        if (!v?.game)
            throw Error('没有对局记录。');
        return JSON.stringify({ appVersion: types_js_1.APP_VERSION, room: v.id, outcome: v.game.outcome,
            seats: v.game.seats, publicLog: v.game.publicLog }, null, 2);
    }
    async close() {
        const signal = this.sessionAbort.signal;
        let error = '';
        try {
            await this.cleanup();
        }
        catch (e) {
            error = msg(e);
        }
        if (this.sessionAbort.signal !== signal)
            return;
        this.patch({ mode: 'home', view: null, busy: false, busyText: '', error, pending: 0, connected: false, status: '', signalWarning: '' });
        await this.init();
    }
    async cleanup() {
        const signal = this.sessionAbort.signal;
        if (this.cleanupTask?.signal === signal)
            return this.cleanupTask.promise;
        this.closed = true;
        this.sessionAbort.abort();
        this.cancelConnectionAttempt();
        if (this.interval)
            clearInterval(this.interval);
        this.interval = null;
        this.stopSubscription?.();
        this.stopSubscription = null;
        this.unwatchPeer();
        const host = this.host, client = this.client, peer = this.peer;
        const authority = this.authority, release = this.release, voice = this.voice;
        this.host = null;
        this.client = null;
        this.peer = null;
        this.authority = null;
        this.release = null;
        this.store = null;
        this.invite = null;
        this.hostPending = false;
        this.tickRunning = false;
        this.demoRunning = false;
        this.voice = new voice_js_1.VoiceRoom(() => this.emit());
        // Invalidate callbacks and detach network listeners before the first
        // await; late opens can never resurrect a room that the user left.
        const jobs = [];
        const attempt = fn => { try { jobs.push(Promise.resolve(fn())); } catch (error) { jobs.push(Promise.reject(error)); } };
        attempt(() => host?.close());
        attempt(() => client?.close());
        attempt(() => peer?.destroy());
        attempt(() => voice.close());
        attempt(() => authority?.flush());
        // A failed audio close must not release the writer lock while a room
        // transaction is still flushing. Always settle every owned resource.
        const promise = Promise.allSettled(jobs).then(results => {
            release?.();
            const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
            if (failures.length)
                throw new AggregateError(failures, '房间资源清理失败：' + failures.map(msg).join('；'));
        });
        this.cleanupTask = { signal, promise };
        return promise;
    }
}
exports.Controller = Controller;
function msg(e) { return e instanceof Error ? e.message : String(e ?? '未知错误'); }
function cancelled() { return Object.assign(Error('连接操作已取消。'), { name: 'AbortError' }); }

