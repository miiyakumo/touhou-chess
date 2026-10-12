'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function assertCancelled(result) { assert.equal(result.error?.name, 'AbortError'); }

// The transport deliberately ignores AbortSignal: already queued browser
// callbacks can still complete, so the controller must check ownership itself.
function fixture() {
    const hooks = {}, opens = [], connects = [], voices = [], clients = [], authorities = [], hosts = [];
    const timeouts = new Map(), intervals = new Map(), timeoutHistory = new Map(), intervalHistory = new Map();
    const events = new Map(), urls = [], writes = [], storage = new Map();
    let timerId = 0, nextId = 0;
    const roomId = 'a'.repeat(32);
    const view = () => ({ id: roomId, hostPeer: 'host-old', self: 2, members: [], size: 6, game: null, voice: { speakers: [], muted: [], reason: '' } });
    class FakeVoice {
        constructor(changed) { this.changed = changed; this.bindings = []; this.closeCount = 0; voices.push(this); }
        update(v, connected) { this.lastView = v; this.connected = connected; }
        bind(link, seat) { this.bindings.push({ link, seat }); }
        close() { ++this.closeCount; return hooks.voiceClose?.(this); }
    }
    class FakePeer extends EventEmitter {
        constructor(id = 'peer-' + ++nextId) { super(); this.id = id; this.destroyed = false; this.disconnected = false; this.destroyCount = 0; this.reconnectCount = 0; }
        destroy() { ++this.destroyCount; this.destroyed = true; }
        reconnect() { ++this.reconnectCount; }
    }
    class FakeLink {
        constructor(ready = true) { this.ready = ready; this.open = true; this.closeCount = 0; this.closes = new Set(); }
        onClose(fn) { this.closes.add(fn); return () => this.closes.delete(fn); }
        close() { ++this.closeCount; if (!this.open) return; this.open = false; for (const fn of [...this.closes]) fn(); }
    }
    class FakeClient {
        constructor(id, token, name, journal) {
            Object.assign(this, { roomId: id, token, name, journal, connected: false, kicked: false, replaced: false, disposed: false,
                error: '', legacyNotice: '', view: view(), listeners: new Set(), waiters: [], attachments: [], detachCount: 0, closeCount: 0 });
            clients.push(this);
        }
        get pendingCount() { return this.journal.pending.length; }
        get legacyPending() { return structuredClone(this.journal.legacyPending ?? []); }
        subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
        publish() { for (const fn of [...this.listeners]) fn(); }
        attach(link) {
            this.detach(); this.link = link; this.attachments.push(link);
            this.connected = link.ready; this.error = '';
            this.offClose = link.onClose(() => { this.connected = false; this.publish(); });
            hooks.clientAttach?.(this, link);
            this.publish();
        }
        detach() { ++this.detachCount; this.offClose?.(); this.offClose = null; this.link?.close(); this.link = null; this.connected = false; }
        close() {
            ++this.closeCount; this.disposed = true; this.detach();
            for (const waiter of this.waiters.splice(0)) waiter.reject(Object.assign(Error('closed'), { name: 'AbortError' }));
        }
        submit(intent) {
            const waiter = deferred(); this.waiters.push(waiter);
            this.journal.save([...this.journal.pending, { intent }]); this.publish(); return waiter.promise;
        }
        ack(value) { const waiter = this.waiters.shift(); this.journal.save(this.journal.pending.slice(1)); waiter.resolve(value); this.publish(); }
        reject(error) { const waiter = this.waiters.shift(); this.journal.save(this.journal.pending.slice(1)); waiter.reject(error); this.publish(); }
        heartbeat() { ++this.heartbeats; }
        retry() {}
    }
    class FakeStore {
        data = null;
        async load() { return hooks.load ? hooks.load(this) : this.data; }
        async save(data) { if (hooks.save) await hooks.save(this, data); this.data = data; }
        async clear() { this.data = null; }
    }
    class FakeAuthority {
        static fresh(name, id, demo, hostPeer, _now, size) {
            return { id, hostPeer, demo, size, members: [{ seat: 1, name, ready: false }], status: 'lobby', game: null, matchId: '' };
        }
        constructor(data, store) { this.data = data; this.store = store; this.dispatches = []; this.listeners = new Set(); this.flushCount = 0; authorities.push(this); }
        async restore() { await hooks.restore?.(this); }
        async setPeerId(id) { await hooks.setPeerId?.(this, id); this.data.hostPeer = id; }
        async join(name, token) {
            if (hooks.join) return hooks.join(this, name, token);
            const seat = this.data.members.length + 1; this.data.members.push({ seat, name, ready: false }); return seat;
        }
        async setOnline(seat, online) { await hooks.setOnline?.(this, seat, online); }
        async dispatch(seat, id, matchId, intent) {
            this.dispatches.push({ seat, id, matchId, intent }); return hooks.dispatch?.(this, seat, intent);
        }
        snapshot() { return this.data; }
        view() { return { ...view(), id: this.data.id, hostPeer: this.data.hostPeer, members: this.data.members }; }
        subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
        async tick() { await hooks.tick?.(this); }
        async flush() { ++this.flushCount; await hooks.flush?.(this); }
    }
    class FakeHost {
        constructor(authority, _id, _now, bind) { this.authority = authority; this.bind = bind; this.closeCount = 0; this.links = []; hosts.push(this); }
        close() { ++this.closeCount; return hooks.hostClose?.(this); }
        accept(link) { this.links.push(link); }
        sweep() {}
    }
    const store = new FakeStore();
    const exports = {};
    const modules = {
        '../net/voice.js': { VoiceRoom: FakeVoice },
        '../room/authority.js': { RoomAuthority: FakeAuthority, MemoryRoomStore: FakeStore },
        '../room/store.js': {
            openRoomStore: () => hooks.openStore ? hooks.openStore() : Promise.resolve(store),
            acquireHostLock: key => hooks.acquireLock ? hooks.acquireLock(key) : Promise.resolve(() => {}),
        },
        '../room/types.js': { randomId: () => (++nextId).toString(16).padStart(32, '0'), APP_VERSION: 'test' },
        '../domain/engine.js': { pendingActors: () => [2, 3], promptFor: () => ({ kind: 'ack' }) },
        '../net/host-session.js': { HostSession: FakeHost },
        '../net/client-session.js': { ClientSession: FakeClient },
        '../net/peer.js': {
            defaultSettings: () => ({ iceServers: [] }),
            openPeer(id, settings, signal) { const request = Object.assign(deferred(), { id, settings, signal }); opens.push(request); return request.promise; },
            connectPeer(peer, hostId, signal) { const request = Object.assign(deferred(), { peer, hostId, signal }); connects.push(request); return request.promise; },
            acceptPeer(peer, accept) { peer.accept = accept; },
            parseInvitation(text) { if (!['old', 'new', 'newer', 'other-room'].includes(text)) throw Error('bad invitation'); return { roomId: text === 'other-room' ? 'b'.repeat(32) : roomId, hostId: 'host-' + text, server: {} }; },
            invitationURL: (id, hostId) => `https://example.invalid/#${id}/${hostId}`,
        },
        './catalog.js': { DEMO_NAMES: Array.from({ length: 12 }, (_, i) => '演示' + (i + 1)) },
    };
    const sandbox = {
        exports, Error, AggregateError, console, AbortController, structuredClone,
        require(name) { if (!(name in modules)) throw Error('Unexpected import: ' + name); return modules[name]; },
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem(key, value) { if (hooks.storageError) throw hooks.storageError; writes.push({ key, value }); storage.set(key, value); },
        },
        document: {
            visibilityState: 'visible',
            addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
            removeEventListener(name, fn) { events.get(name)?.delete(fn); },
        },
        history: { replaceState(_state, _unused, url) { urls.push(url); } },
        setTimeout(fn) { const id = ++timerId; timeouts.set(id, fn); timeoutHistory.set(id, fn); return id; },
        clearTimeout(id) { timeouts.delete(id); },
        setInterval(fn) { const id = ++timerId; intervals.set(id, fn); intervalHistory.set(id, fn); return id; },
        clearInterval(id) { intervals.delete(id); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ui/controller.js'), 'utf8'), sandbox);
    const controller = new exports.Controller();
    return {
        controller, hooks, roomId, store, opens, connects, voices, clients, authorities, hosts, events, urls,
        storage, writes, timeouts, intervals, timeoutHistory, intervalHistory,
        peer: id => new FakePeer(id), link: ready => new FakeLink(ready),
        guest() {
            const signal = controller.beginSession(), inv = modules['../net/peer.js'].parseInvitation('old');
            const journal = { pending: [], legacyPending: [], save(pending) { this.pending = pending; } };
            const client = new FakeClient(inv.roomId, 'c'.repeat(32), '玩家', journal);
            controller.invite = inv; controller.client = client; controller.state.mode = 'guest';
            controller.stopSubscription = client.subscribe(() => controller.syncGuest());
            return { client, signal, inv };
        },
        authority() { return new FakeAuthority(FakeAuthority.fresh('房主', roomId, false, 'host-old', 0, 6), store); },
        host(authority) { return new FakeHost(authority, '', Date.now, () => {}); },
    };
}

test('leaving during openPeer destroys an ignored-cancellation result without reviving the room', async () => {
    const e = fixture(), c = e.controller;
    e.guest();
    const connection = observe(c.reconnectGuest()), pendingOpen = e.opens[0], oldVoice = c.voice;
    await c.close();
    assert.equal(pendingOpen.signal.aborted, true);
    const latePeer = e.peer(); pendingOpen.resolve(latePeer);
    assertCancelled(await connection);
    assert.equal(latePeer.destroyCount, 1);
    assert.equal(c.peer, null);
    assert.equal(e.connects.length, 0);
    assert.equal(oldVoice.bindings.length, 0);
    assert.equal(c.state.mode, 'home');
    assert.equal(c.connecting, false);
});

test('leaving during connectPeer closes a late link before attaching a client or audio', async () => {
    const e = fixture(), c = e.controller, { client } = e.guest();
    c.peer = e.peer();
    const connection = observe(c.reconnectGuest()), request = e.connects[0], oldVoice = c.voice;
    await c.close();
    const lateLink = e.link(); request.resolve(lateLink);
    assertCancelled(await connection);
    assert.equal(request.signal.aborted, true);
    assert.equal(lateLink.closeCount, 1);
    assert.equal(client.attachments.length, 0);
    assert.equal(oldVoice.bindings.length, 0);
    assert.equal(client.closeCount, 1);
});

test('new invitation immediately replaces an in-flight connection and only detaches the existing player session', async () => {
    const e = fixture(), c = e.controller, { client } = e.guest();
    const oldPeer = e.peer(); c.peer = oldPeer;
    const oldWork = observe(c.reconnectGuest()), oldConnect = e.connects[0];
    const nextWork = c.updateInvitation('new');
    assert.equal(oldConnect.signal.aborted, true);
    assert.equal(oldPeer.destroyCount, 1);
    assert.equal(e.opens.length, 1);
    assert.equal(client.closeCount, 0);
    const nextPeer = e.peer(); e.opens[0].resolve(nextPeer); await tick();
    assert.equal(e.connects[1].hostId, 'host-new');
    const lateLink = e.link(); oldConnect.resolve(lateLink); assertCancelled(await oldWork);
    assert.equal(lateLink.closeCount, 1);
    assert.equal(c.connecting, true);
    const nextLink = e.link(); e.connects[1].resolve(nextLink); await nextWork;
    assert.equal(c.peer, nextPeer);
    assert.equal(c.client, client);
    assert.equal(client.link, nextLink);
    assert.equal(c.voice.bindings.length, 1);
    assert.equal(c.voice.bindings[0].link, nextLink);
    assert.equal(c.state.connected, true);
    assert.equal(c.state.busy, false);
    assert.equal(client.closeCount, 0);
});

test('old initial join catch and finally cannot clean up or clear a replacement invitation attempt', async () => {
    const e = fixture(), c = e.controller;
    const initialJoin = c.join('old', '玩家'), oldOpen = e.opens[0];
    const client = c.client, replacement = c.updateInvitation('new');
    assert.equal(oldOpen.signal.aborted, true);
    oldOpen.reject(Error('late signaling failure'));
    await initialJoin;
    assert.equal(c.client, client);
    assert.equal(client.closeCount, 0);
    assert.equal(c.state.busy, true);
    assert.equal(c.state.error, '');
    const peer = e.peer(); e.opens[1].resolve(peer); await tick();
    e.connects[0].resolve(e.link()); await replacement;
    assert.equal(c.state.mode, 'guest');
    assert.equal(c.peer, peer);
    assert.equal(c.state.busy, false);
    assert.match(e.urls.at(-1), /host-new$/);
});

test('kicked and replaced sessions cancel transport work and both reconnect timers', async () => {
    for (const terminal of ['kicked', 'replaced']) {
        const e = fixture(), c = e.controller, { client } = e.guest(), peer = e.peer();
        c.peer = peer; c.watchPeer(peer); peer.disconnected = true; peer.emit('disconnected');
        c.syncGuest();
        const retryId = c.reconnectTimer, peerRetryId = c.peerReconnectTimer;
        const connection = observe(c.reconnectGuest()), pending = e.connects[0];
        client[terminal] = true; client.error = terminal; c.syncGuest();
        assert.equal(pending.signal.aborted, true);
        assert.equal(c.peer, null);
        assert.equal(peer.destroyCount, 1);
        assert.equal(c.reconnectTimer, null);
        assert.equal(c.peerReconnectTimer, null);
        e.timeoutHistory.get(retryId)(); e.timeoutHistory.get(peerRetryId)();
        assert.equal(e.opens.length, 0);
        assert.equal(peer.reconnectCount, 0);
        const lateLink = e.link(); pending.resolve(lateLink); assertCancelled(await connection);
        assert.equal(lateLink.closeCount, 1);
        assert.equal(e.timeouts.size, 0);
    }
});

test('stale retry callbacks cannot clear a new session timer or reconnect its retired peer', async () => {
    const e = fixture(), c = e.controller;
    e.guest(); const oldPeer = e.peer(); c.peer = oldPeer; c.watchPeer(oldPeer);
    oldPeer.disconnected = true; oldPeer.emit('disconnected'); c.syncGuest();
    const oldGuestRetry = e.timeoutHistory.get(c.reconnectTimer), oldPeerRetry = e.timeoutHistory.get(c.peerReconnectTimer);
    await c.close();
    e.guest(); const nextPeer = e.peer(); c.peer = nextPeer; c.watchPeer(nextPeer);
    nextPeer.disconnected = true; nextPeer.emit('disconnected'); c.syncGuest();
    const nextGuestTimer = c.reconnectTimer, nextPeerTimer = c.peerReconnectTimer;
    oldGuestRetry(); oldPeerRetry();
    assert.equal(c.reconnectTimer, nextGuestTimer);
    assert.equal(c.peerReconnectTimer, nextPeerTimer);
    assert.equal(oldPeer.reconnectCount, 0);
    assert.equal(e.opens.length, 0);
    assert.equal(e.connects.length, 0);
});

test('Controller.submit waits for the client ACK and forwards a definitive rejection', async () => {
    const e = fixture(), c = e.controller, { client } = e.guest();
    client.connected = true;
    let settled = false;
    const sent = c.submit({ kind: 'chat', text: '确认后才清稿' }).then(value => { settled = true; return value; });
    await tick(); assert.equal(settled, false);
    client.ack('durable'); assert.equal(await sent, 'durable');
    const refused = observe(c.submit({ kind: 'chat', text: '禁止发言' }));
    const error = Error('SILENCED'); client.reject(error);
    assert.equal((await refused).error, error);
});

test('a pending submit survives invitation rebind, but true leave rejects it and retains its journal', async () => {
    const e = fixture(), c = e.controller, { client } = e.guest();
    client.connected = true; c.peer = e.peer();
    const send = observe(c.submit({ kind: 'chat', text: '保留待确认请求' }));
    const reconnect = c.updateInvitation('new');
    assert.equal(client.closeCount, 0);
    assert.equal(client.waiters.length, 1);
    assert.equal(client.journal.pending.length, 1);
    e.opens[0].resolve(e.peer()); await tick(); e.connects[0].resolve(e.link()); await reconnect;
    client.ack(); assert.equal((await send).error, undefined);
    const leavingSend = observe(c.submit({ kind: 'chat', text: '离房时仍未确认' }));
    await c.close(); assertCancelled(await leavingSend);
    assert.equal(client.closeCount, 1);
    assert.equal(client.journal.pending.length, 1);
});

test('late host submit result cannot reset the next session pending state or report its stale error', async () => {
    for (const rejects of [false, true]) {
        const e = fixture(), c = e.controller, operation = deferred();
        c.beginSession(); c.authority = e.authority(); c.state.mode = 'host';
        e.hooks.dispatch = () => operation.promise;
        const sent = observe(c.submit({ kind: 'chat', text: '旧房间' }));
        await c.close(); e.guest(); c.hostPending = true; c.state.pending = 1; c.state.error = '新房间提示';
        if (rejects) operation.reject(Error('old failure')); else operation.resolve();
        assertCancelled(await sent);
        assert.equal(c.hostPending, true);
        assert.equal(c.state.pending, 1);
        assert.equal(c.state.error, '新房间提示');
    }
});

test('cleanup settles every resource before releasing the writer lock even when another close fails', async () => {
    const e = fixture(), c = e.controller, flush = deferred();
    c.beginSession(); const authority = e.authority(), host = e.host(authority), peer = e.peer(), voice = c.voice;
    Object.assign(c, { authority, host, peer });
    let released = 0; c.release = () => { ++released; };
    e.hooks.hostClose = () => { throw Error('host close failed'); };
    e.hooks.voiceClose = () => Promise.reject(Error('audio close failed'));
    e.hooks.flush = () => flush.promise;
    const first = observe(c.cleanup()), second = observe(c.cleanup());
    await tick();
    assert.equal(released, 0);
    assert.equal(host.closeCount, 1); assert.equal(peer.destroyCount, 1); assert.equal(voice.closeCount, 1); assert.equal(authority.flushCount, 1);
    flush.resolve();
    assert.match((await first).error.message, /host close failed.*audio close failed/);
    assert.match((await second).error.message, /host close failed.*audio close failed/);
    assert.equal(released, 1);
    await c.close();
    assert.equal(c.state.mode, 'home');
    assert.equal(c.state.connected, false);
    assert.match(c.state.error, /房间资源清理失败/);
    assert.equal(released, 1);
});

test('a late acquired host lock is immediately released and cannot start a retired host session', async () => {
    const e = fixture(), c = e.controller, lock = deferred();
    e.hooks.acquireLock = () => lock.promise;
    const startup = c.create('房主');
    await c.close(); e.guest(); c.state.busy = true; c.state.error = '下一次启动';
    let released = 0; lock.resolve(() => { ++released; }); await startup;
    assert.equal(released, 1);
    assert.equal(e.opens.length, 0);
    assert.equal(e.authorities.length, 0);
    assert.equal(c.state.busy, true);
    assert.equal(c.state.error, '下一次启动');
});

test('host startup destroys a late peer and stale host callbacks close incoming links', async () => {
    const e = fixture(), c = e.controller;
    const startup = c.create('房主', false, 6, true); await tick();
    const pendingOpen = e.opens[0]; assert.ok(pendingOpen);
    await c.close(); e.guest(); const newVoice = c.voice;
    const late = e.peer(); pendingOpen.resolve(late); await startup;
    assert.equal(late.destroyCount, 1);
    assert.equal(c.peer, null);
    assert.equal(c.host, null);
    assert.equal(c.voice, newVoice);
    assert.equal(e.hosts.length, 0);

    await c.close();
    const nextStartup = c.create('房主', false, 6, true); await tick();
    const oldHostPeer = e.peer(); e.opens[1].resolve(oldHostPeer); await nextStartup;
    const oldHost = c.host, accept = oldHostPeer.accept, bind = oldHost.bind;
    await c.close(); e.guest();
    const incoming = e.link(); accept(incoming); bind(incoming, 2);
    assert.equal(incoming.closeCount, 1);
    assert.equal(oldHost.links.length, 0);
    assert.equal(c.voice.bindings.length, 0);
});

test('a stale clock tick cannot report an error, clear a new tick or sweep the next room', async () => {
    const e = fixture(), c = e.controller, oldTick = deferred();
    c.beginSession(); c.authority = e.authority(); c.state.mode = 'host';
    e.hooks.tick = () => oldTick.promise;
    c.startClock(); const oldTimer = e.intervalHistory.get(c.interval); oldTimer();
    assert.equal(c.tickRunning, true);
    await c.close(); e.guest(); c.tickRunning = true; c.state.error = '新房间'; const beat = c.beat;
    oldTick.reject(Error('old tick failure')); await tick(); oldTimer();
    assert.equal(c.tickRunning, true);
    assert.equal(c.state.error, '新房间');
    assert.equal(c.beat, beat);
});

test('cancelled demo setup and actions keep their original authority and cannot reset the next session', async () => {
    const e = fixture(), c = e.controller, join = deferred();
    e.hooks.join = () => join.promise;
    const startup = c.demo('演示', 6); await tick();
    const original = c.authority;
    await c.close(); const next = e.authority(); c.beginSession(); c.authority = next; c.state.busy = true;
    join.resolve(2); await startup;
    assert.equal(original.dispatches.length, 0);
    assert.equal(next.dispatches.length, 0);
    assert.equal(c.authority, next);
    assert.equal(c.state.busy, true);

    const action = deferred();
    next.data.members.push({ seat: 2, ready: false }, { seat: 3, ready: false });
    e.hooks.dispatch = () => action.promise;
    const drive = c.driveDemo(); await tick();
    await c.close(); e.guest(); c.demoRunning = true;
    action.resolve(); await drive;
    assert.equal(next.dispatches.length, 1);
    assert.equal(c.demoRunning, true);
});

test('profile migration archives original legacy envelopes and new journal in one durable write', () => {
    const e = fixture(), c = e.controller, key = 'rls-v4-player-' + e.roomId;
    const older = Array.from({ length: 16 }, (_, id) => ({ id: 'old-' + id, intent: { kind: 'chat', text: '归档' + id } }));
    const legacy = { protocol: 2, id: 'legacy', token: 'seat-secret', intent: { kind: 'chat', text: '必须保留的原文' } };
    const current = { protocol: 3, id: 'current', intent: { kind: 'ready', value: true } };
    e.storage.set(key, JSON.stringify({ token: 'c'.repeat(32), pending: [legacy, current], legacyPending: older }));
    const { profile, journal } = c.profile({ roomId: e.roomId, hostId: 'new-host' }, '新昵称');
    const original = profile.pending[0]; e.writes.length = 0;
    journal.archiveLegacy([original]);
    assert.equal(e.writes.length, 1);
    assert.equal(profile.pending.length, 1);
    assert.equal(profile.pending[0].id, 'current');
    assert.equal(profile.legacyPending.length, 16);
    assert.equal(profile.legacyPending.at(-1), original);
    const saved = JSON.parse(e.storage.get(key));
    assert.deepEqual(saved.pending, [current]);
    assert.deepEqual(saved.legacyPending.at(-1), legacy);
    assert.equal(saved.legacyPending[0].id, 'old-1');
    assert.equal(saved.token, 'c'.repeat(32));
    assert.equal(saved.name, '新昵称');
});

test('failed profile writes preserve both the durable journal and the in-memory migration source', () => {
    const e = fixture(), c = e.controller, key = 'rls-v4-player-' + e.roomId;
    e.storage.set(key, JSON.stringify({ token: 'c'.repeat(32), pending: [{ protocol: 2, id: 'legacy', intent: { kind: 'chat', text: '保留原稿' } }], legacyPending: [] }));
    const { profile, journal } = c.profile({ roomId: e.roomId, hostId: 'host' }, '玩家');
    const disk = e.storage.get(key), pending = profile.pending, archive = profile.legacyPending;
    e.hooks.storageError = Error('QuotaExceeded');
    assert.throws(() => journal.archiveLegacy([pending[0]]), /QuotaExceeded/);
    assert.equal(e.storage.get(key), disk);
    assert.equal(profile.pending, pending);
    assert.equal(profile.legacyPending, archive);
    assert.throws(() => journal.save([]), /QuotaExceeded/);
    assert.equal(e.storage.get(key), disk);
    assert.equal(profile.pending, pending);
});

test('volatile profiles migrate without local storage and malformed credential archives are rejected', () => {
    const e = fixture(), c = e.controller, key = 'rls-v4-player-' + e.roomId;
    c.state.volatile = true;
    const { profile, journal } = c.profile({ roomId: e.roomId, hostId: 'host' }, '玩家');
    const legacy = { intent: { kind: 'chat', text: '临时原稿' } };
    journal.save([legacy]); journal.archiveLegacy([legacy]);
    assert.equal(profile.pending.length, 0); assert.equal(profile.legacyPending[0], legacy);
    assert.equal(e.writes.length, 0);
    c.state.volatile = false;
    for (const malformed of [{ token: 'c'.repeat(32), pending: [], legacyPending: {} }, { token: 123, pending: [] }]) {
        e.storage.set(key, JSON.stringify(malformed));
        assert.throws(() => c.profile({ roomId: e.roomId, hostId: 'host' }, '玩家'), /座位凭证损坏/);
    }
});

test('guest feedback retains the legacy migration notice when no current error replaces it', () => {
    const e = fixture(), c = e.controller, { client } = e.guest();
    client.connected = true; client.legacyNotice = '已保留旧版原稿，未自动重发'; c.syncGuest();
    assert.equal(c.state.error, client.legacyNotice);
    client.error = '当前连接错误'; c.syncGuest();
    assert.equal(c.state.error, client.error);
});
