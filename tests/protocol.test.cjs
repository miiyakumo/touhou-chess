const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomAuthority, MemoryRoomStore } = require('../src/room/authority.js');
const { HostSession } = require('../src/net/host-session.js');
const { ClientSession } = require('../src/net/client-session.js');
const { memoryPair } = require('../src/net/link.js');
const { parseClientMessage, parseServerMessage, parseRoomView } = require('../src/net/protocol.js');
const { validateRoom } = require('../src/room/store.js');
const { createGame } = require('../src/domain/engine.js');
const { PROTOCOL, APP_VERSION } = require('../src/room/types.js');
const ROOM = '11111111111111111111111111111111';
const HOST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const A = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const B = 'cccccccccccccccccccccccccccccccc';
const later = () => new Promise(resolve => setImmediate(resolve));
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
function ids() { let n = 100; return () => (++n).toString(16).padStart(32, '0'); }
class Link {
    constructor(id) { this.id = id; this.open = true; this.out = []; this.messages = new Set(); this.closes = new Set(); }
    send(m) { if (!this.open) throw Error('closed'); this.out.push(structuredClone(m)); }
    onMessage(fn) { this.messages.add(fn); return () => this.messages.delete(fn); }
    onClose(fn) { this.closes.add(fn); return () => this.closes.delete(fn); }
    close() { if (!this.open) return; this.open = false; for (const fn of this.closes) fn(); }
}
function setup(options = {}) {
    const clock = { now: 1000 };
    const store = new MemoryRoomStore();
    const room = new RoomAuthority(RoomAuthority.fresh('HOST', HOST, false, ROOM, clock.now, 6), store,
        { now: () => clock.now, randomId: ids(), seed: () => 7, ...options });
    const host = new HostSession(room, 'epoch-1', () => clock.now);
    return { clock, store, room, host };
}
function hello(token = A, name = 'ALICE') { return { protocol: PROTOCOL, type: 'hello', roomId: ROOM, token, name }; }
async function bind(host, id = 'a', token = A, name = 'ALICE') {
    const link = new Link(id); host.accept(link);
    const c = host.conns.get(link.id);
    await host.receive(c, hello(token, name));
    return { link, c };
}
function command(room, c, id, intent, overrides = {}) {
    const m = room.member(c.seat);
    return { protocol: PROTOCOL, type: 'command', roomId: ROOM, epoch: 'epoch-1', id,
        matchId: room.snapshot().matchId, generation: c.generation, commandSeq: m.commandSeq + 1, intent, ...overrides };
}
function journal() { return { pending: [], save(pending) { this.pending = structuredClone(pending); } }; }
async function guest(env, pending = journal()) {
    const [local, remote] = memoryPair('host-' + Math.random(), 'guest-' + Math.random());
    const client = new ClientSession(ROOM, A, 'ALICE', pending, () => env.clock.now, ids());
    env.host.accept(local); client.attach(remote);
    await later(); await env.room.flush(); await later();
    assert.equal(client.connected, true, client.error);
    return { client, journal: pending, local, remote };
}
async function blockNextSave(store) {
    const original = store.save.bind(store);
    let enter, release;
    const entered = new Promise(resolve => enter = resolve);
    let block = true;
    store.save = async data => {
        if (block) { block = false; enter(); await new Promise(resolve => release = resolve); }
        return original(data);
    };
    return { entered, release: () => release() };
}
function principal(c, commandSeq) { return { token: c.token, generation: c.generation, commandSeq }; }

// The operation identity is (member generation, monotonic sequence). Only the
// latest receipt is retained; stale envelopes must fail even after many saves.
test('v3 receipts remain bounded and old envelopes never replay after compaction or restore', async () => {
    const e = setup(), a = await bind(e.host);
    const initialSize = Buffer.byteLength(JSON.stringify(e.room.snapshot()));
    for (let n = 1; n <= 400; n++)
        await e.room.dispatch(2, 'request-' + n, '', { kind: 'ready', value: false }, principal(a.c, n));
    let snap = e.room.snapshot();
    assert.equal(snap.members.find(m => m.seat === 2).commandSeq, 400);
    assert.equal(snap.members.filter(m => m.lastReceipt).length, 1);
    assert.equal(snap.receipts, undefined);
    assert(Buffer.byteLength(JSON.stringify(snap)) < initialSize + 250);
    await assert.rejects(e.room.dispatch(2, 'request-1', '', { kind: 'ready', value: false }, principal(a.c, 1)), { code: 'STALE_COMMAND' });
    await assert.rejects(e.room.dispatch(2, 'request-400', '', { kind: 'ready', value: true }, principal(a.c, 400)), { code: 'ID_REUSE' });
    await assert.rejects(e.room.dispatch(2, 'skipped', '', { kind: 'ready', value: true }, principal(a.c, 402)), { code: 'BAD_SEQUENCE' });
    assert.deepEqual(await e.room.dispatch(2, 'request-400', '', { kind: 'ready', value: false }, principal(a.c, 400)),
        { id: 'request-400', generation: a.c.generation, commandSeq: 400 });
    validateRoom(snap);
    const restored = new RoomAuthority(await e.store.load(), e.store);
    await assert.rejects(restored.dispatch(2, 'request-1', '', { kind: 'ready', value: false }, principal(a.c, 1)), { code: 'STALE_COMMAND' });
    await restored.dispatch(2, 'request-400', '', { kind: 'ready', value: false }, principal(a.c, 400));
    e.host.close(); await e.room.flush();
});

test('a queued old occupant command cannot act as a new occupant', async () => {
    const e = setup(), a = await bind(e.host);
    const oldCommand = command(e.room, a.c, 'stale-rename', { kind: 'rename', name: 'ATTACKER' });
    const gate = await blockNextSave(e.store);
    const kick = e.room.dispatch(1, 'kick', '', { kind: 'kick', seat: 2 });
    await gate.entered;
    const bLink = new Link('b'); e.host.accept(bLink);
    const joining = e.host.receive(e.host.conns.get('b'), hello(B, 'BOB'));
    const queued = e.host.receive(a.c, oldCommand);
    gate.release();
    await Promise.all([kick, joining, queued]); await e.room.flush();
    const b = e.room.member(2);
    assert.equal(b.token, B); assert.equal(b.name, 'BOB'); assert.equal(b.commandSeq, 0);
    assert.equal(b.lastReceipt, null);
    e.host.close(); await e.room.flush();
});

test('removal sends kicked and prevents attaching another link automatically', async () => {
    const e = setup(), g = await guest(e);
    await e.room.dispatch(1, 'kick', '', { kind: 'kick', seat: 2 });
    await tick(); await later();
    assert.equal(g.client.kicked, true);
    assert.equal(g.client.connected, false);
    assert.throws(() => g.client.attach(new Link('automatic-rejoin')), /首页/);
    g.client.close(); e.host.close(); await e.room.flush();
});

test('a lost kicked notice cannot turn automatic recovery into a fresh join', async () => {
    const e = setup(), g = await guest(e);
    const generation = g.client.view.commandGeneration;
    const send = g.local.send.bind(g.local);
    let dropped = 0;
    g.local.send = message => {
        if (message.type === 'kicked') { dropped++; return; }
        send(message);
    };
    await e.room.dispatch(1, 'kick', '', { kind: 'kick', seat: 2 });
    await tick(); await later();
    assert.equal(dropped, 1); assert.equal(g.client.kicked, false);
    g.local.close(); // Emulate the channel closing after its terminal notice was lost.
    assert.equal(g.client.connected, false);
    const [local, remote] = memoryPair('recovery-after-kick');
    const sent = [], errors = [];
    const sendHello = remote.send.bind(remote), sendResponse = local.send.bind(local);
    remote.send = message => { sent.push(structuredClone(message)); sendHello(message); };
    local.send = message => { if (message.type === 'error') errors.push(message); sendResponse(message); };
    e.host.accept(local); g.client.attach(remote);
    await later(); await e.room.flush(); await later();
    assert.equal(sent.find(m => m.type === 'hello').resumeGeneration, generation);
    assert.equal(errors.at(-1).code, 'KICKED');
    assert.equal(g.client.kicked, true); assert.equal(g.client.connected, false);
    assert.equal(e.room.snapshot().members.length, 1); assert.equal(e.host.seats.size, 0);
    assert.throws(() => g.client.attach(new Link('another-auto-retry')), /首页/);
    // A deliberate new join after returning home still uses a fresh ClientSession.
    const manuallyJoined = await guest(e);
    assert.notEqual(manuallyJoined.client.view.commandGeneration, generation);
    g.client.close(); manuallyJoined.client.close(); e.host.close(); await e.room.flush();
});

test('hello accepts initial joins and matching recovery but rejects removed or replaced memberships', async () => {
    const e = setup(), a = await bind(e.host);
    assert.equal(parseClientMessage(hello()).resumeGeneration, null);
    assert.equal(parseClientMessage({ ...hello(), resumeGeneration: null }).resumeGeneration, null);
    assert.equal(parseClientMessage({ ...hello(), resumeGeneration: a.c.generation }).resumeGeneration, a.c.generation);
    assert.throws(() => parseClientMessage({ ...hello(), resumeGeneration: 'invalid' }), { code: 'BAD_MESSAGE' });
    assert.equal(await e.room.join('ALICE', A, a.c.generation), 2);
    await e.room.dispatch(1, 'kick-for-resume', '', { kind: 'kick', seat: 2 });
    await assert.rejects(e.room.join('ALICE', A, a.c.generation), { code: 'KICKED' });
    assert.equal(await e.room.join('ALICE', A), 2);
    const fresh = e.room.member(2).commandGeneration;
    assert.notEqual(fresh, a.c.generation);
    await assert.rejects(e.room.join('ALICE', A, a.c.generation), { code: 'KICKED' });
    assert.equal(await e.room.join('ALICE', A, fresh), 2);
    assert.equal(e.room.snapshot().members.length, 2);
    e.host.close(); await e.room.flush();
});

test('same token explicitly rejoining receives a new generation, and old commands cannot revive', async () => {
    const e = setup(), a = await bind(e.host);
    const old = { ...principal(a.c, 1) };
    await e.room.dispatch(1, 'kick', '', { kind: 'kick', seat: 2 }); await tick();
    const replacement = await bind(e.host, 'rejoin', A, 'ALICE');
    assert.notEqual(replacement.c.generation, old.generation);
    await assert.rejects(e.room.dispatch(2, 'old-request', '', { kind: 'ready', value: true }, old), { code: 'STALE_SESSION' });
    assert.equal(e.room.member(2).ready, false);
    e.host.close(); await e.room.flush();
});

test('kick and leave clear mute and stale online updates cannot affect the replacement', async () => {
    for (const kind of ['kick', 'leave']) {
        const e = setup(), a = await bind(e.host);
        await e.room.dispatch(1, 'mute', '', { kind: 'mute', seat: 2, value: true });
        await e.room.dispatch(kind === 'kick' ? 1 : 2, 'remove', '', kind === 'kick' ? { kind, seat: 2 } : { kind });
        assert.deepEqual(e.room.snapshot().muted, []);
        assert.equal(e.room.online.has(2), false);
        await tick();
        const b = await bind(e.host, 'b', B, 'BOB');
        await e.room.setOnline(2, false, A);
        assert.equal(e.room.online.has(2), true);
        await e.room.dispatch(2, 'hello-b', '', { kind: 'chat', text: 'new member speaks' }, principal(b.c, 1));
        e.host.close(); await e.room.flush();
    }
});

test('hello deadline is absolute even when an unbound connection pings', async () => {
    const e = setup(), link = new Link('unbound'); e.host.accept(link);
    const c = e.host.conns.get('unbound');
    e.clock.now = 26000;
    await e.host.receive(c, { protocol: PROTOCOL, type: 'ping', sent: e.clock.now });
    assert.equal(link.open, true);
    e.clock.now = 30999;
    await e.host.receive(c, { protocol: PROTOCOL, type: 'ping', sent: e.clock.now });
    e.clock.now = 31000; e.host.sweep();
    assert.equal(link.open, false); assert.equal(e.host.conns.size, 0);
    e.host.close(); await e.room.flush();
});

test('per-member rate limiting retains sequence and allows the same request after refill', async () => {
    const e = setup(), a = await bind(e.host);
    for (let n = 1; n <= 6; n++)
        await e.host.receive(a.c, command(e.room, a.c, 'ready-' + n, { kind: 'ready', value: false }));
    const retry = command(e.room, a.c, 'ready-7', { kind: 'ready', value: true });
    await e.host.receive(a.c, retry);
    assert.equal(a.link.out.filter(m => m.type === 'error').at(-1).code, 'RATE_LIMIT');
    assert.equal(e.room.member(2).commandSeq, 6);
    e.clock.now += 1000;
    await e.host.receive(a.c, retry);
    assert.equal(e.room.member(2).commandSeq, 7); assert.equal(e.room.member(2).ready, true);
    e.host.close(); await e.room.flush();
});

test('a connection has at most one in-flight command and the authority queue is bounded', async () => {
    const e = setup(), a = await bind(e.host), gate = await blockNextSave(e.store);
    const first = command(e.room, a.c, 'first', { kind: 'ready', value: true });
    const inflight = e.host.receive(a.c, first); await gate.entered;
    await e.host.receive(a.c, first);
    for (let n = 0; n < 10; n++)
        await e.host.receive(a.c, { ...first, id: 'extra-' + n });
    assert.equal(e.room.queued, 1);
    assert(a.link.out.some(m => m.type === 'error' && m.code === 'BUSY'));
    gate.release(); await inflight;
    assert.equal(e.room.member(2).commandSeq, 1);
    const bounded = setup({ maxPending: 2 });
    let release;
    const one = bounded.room.enqueue(() => new Promise(resolve => release = resolve));
    const two = bounded.room.enqueue(() => 2);
    await assert.rejects(bounded.room.enqueue(() => 3), { code: 'BUSY' });
    assert.equal(bounded.room.queued, 2);
    release(); await Promise.all([one, two]); assert.equal(bounded.room.queued, 0);
    e.host.close(); bounded.host.close(); await e.room.flush();
});

test('SAVE_ERROR does not mutate state, ACK or resolve the client promise; same envelope succeeds later', async () => {
    const e = setup(), g = await guest(e), save = e.store.save.bind(e.store);
    e.store.save = async () => { throw Error('simulated disk failure'); };
    let settled = false;
    const promise = g.client.submit({ kind: 'ready', value: true });
    const result = promise.then(() => { settled = true; return true; }, error => { settled = true; throw error; });
    await later(); await e.room.flush(); await later();
    assert.equal(settled, false); assert.equal(g.client.pendingCount, 1);
    const original = structuredClone(g.journal.pending[0]);
    assert.equal(e.room.member(2).commandSeq, 0); assert.equal(e.room.member(2).ready, false);
    e.store.save = save; e.clock.now += 1000; g.client.retry();
    assert.equal(await result, true); assert.equal(g.client.pendingCount, 0);
    assert.equal(e.room.member(2).lastReceipt.id, original.id);
    assert.equal(e.room.member(2).lastReceipt.commandSeq, original.commandSeq);
    g.client.close(); e.host.close(); await e.room.flush();
});

test('ordinary rule rejection rejects the UI promise and clears only that pending action', async () => {
    const e = setup(), g = await guest(e);
    await e.room.dispatch(1, 'mute', '', { kind: 'mute', seat: 2, value: true }); await later();
    await assert.rejects(g.client.submit({ kind: 'chat', text: 'keep this draft in the UI' }), { code: 'SILENCED' });
    assert.equal(g.client.pendingCount, 0); assert.equal(e.room.member(2).commandSeq, 0);
    g.client.close(); e.host.close(); await e.room.flush();
});

test('detach preserves a pending waiter across reconnect while close rejects it as AbortError', async () => {
    const e = setup(), g = await guest(e), gate = await blockNextSave(e.store);
    const pending = g.client.submit({ kind: 'ready', value: true });
    const observed = pending.then(() => 'acked', error => error);
    await gate.entered;
    g.client.detach();
    assert.equal(g.client.waiters.size, 1); assert.equal(g.client.pendingCount, 1);
    gate.release(); await e.room.flush(); await later();
    const [local, remote] = memoryPair('host-new', 'guest-new');
    e.host.accept(local); g.client.attach(remote); await later();
    assert.equal(await observed, 'acked'); assert.equal(g.client.pendingCount, 0);
    const secondGate = await blockNextSave(e.store);
    const second = g.client.submit({ kind: 'ready', value: false });
    const cancelled = assert.rejects(second, { name: 'AbortError', code: 'CANCELLED' });
    await secondGate.entered; g.client.close(); secondGate.release(); await cancelled;
    assert.equal(g.client.pendingCount, 1);
    e.host.close(); await e.room.flush();
});

test('lost ACK after a match changes still confirms the last pending receipt', async () => {
    const e = setup(), a = await bind(e.host);
    await e.room.dispatch(2, 'last-in-lobby', '', { kind: 'ready', value: true }, principal(a.c, 1));
    const changed = e.room.snapshot(); changed.matchId = '22222222222222222222222222222222';
    await e.room.commit(changed);
    const receipt = await e.room.dispatch(2, 'last-in-lobby', '', { kind: 'ready', value: true }, principal(a.c, 1));
    assert.equal(receipt.commandSeq, 1); assert.equal(e.room.member(2).commandSeq, 1);
    e.host.close(); await e.room.flush();
});

test('legacy pending is archived without changing generation or resending', async () => {
    const old = { protocol: 'renleisha/2', type: 'command', roomId: ROOM, id: 'legacy', epoch: 'old', matchId: '', intent: { kind: 'chat', text: 'original text' } };
    const j = { pending: [old], legacyPending: [], save(x) { this.pending = x; }, archiveLegacy(messages) {
        this.legacyPending.push(...structuredClone(messages)); this.pending = this.pending.filter(p => !messages.includes(p));
    } };
    const client = new ClientSession(ROOM, A, 'ALICE', j);
    assert.equal(j.pending.length, 0); assert.deepEqual(client.legacyPending, [old]);
    assert.match(client.legacyNotice, /没有自动重发/);
    assert.equal(j.legacyPending[0].generation, undefined); assert.equal(j.legacyPending[0].protocol, 'renleisha/2');
    const fallback = { pending: [old], save(x) { this.pending = x; } };
    const withoutArchive = new ClientSession(ROOM, A, 'ALICE', fallback);
    const link = new Link('legacy'); withoutArchive.link = link; withoutArchive.connected = true; withoutArchive.retry();
    assert.equal(link.out.length, 0); assert.equal(fallback.pending.length, 1);
    client.close(); withoutArchive.close();
});

test('schema 2 room migration preserves membership and game, starts fresh generations, and rejects old wire', () => {
    const e = setup();
    const legacy = e.room.snapshot(); legacy.schema = 2; legacy.receipts = { 'old-id': { fingerprint: 'old' } };
    for (const m of legacy.members) { delete m.commandGeneration; delete m.commandSeq; delete m.lastReceipt; }
    validateRoom(legacy);
    const migrated = new RoomAuthority(legacy, new MemoryRoomStore());
    const snap = migrated.snapshot(); validateRoom(snap);
    assert.equal(snap.schema, 3); assert.equal(snap.members[0].token, HOST); assert.equal(snap.receipts, undefined);
    assert.match(snap.members[0].commandGeneration, /^[a-f0-9]{32}$/); assert.equal(snap.members[0].commandSeq, 0);
    assert.throws(() => parseClientMessage({ ...hello(), protocol: 'renleisha/2' }), { code: 'PROTOCOL_VERSION' });
    e.host.close();
});

test('strict view schema rejects network HTML IDs and malformed nested DTO fields', () => {
    const e = setup(), base = e.room.view(1);
    assert.deepEqual(parseRoomView(base), base);
    const mutations = [
        v => { v.chat = [{ seat: '<img src=x onerror=alert(1)>', name: 'host', text: 'x', at: 1 }]; },
        v => { v.members[0].seat = '1 onclick=alert(1)'; },
        v => { v.members.push({ ...v.members[0] }); },
        v => { v.voice.speakers = ['<svg/onload=alert(1)>']; },
        v => { v.voice.reason = {}; },
        v => { v.activity = '__proto__'; },
        v => { v.nextCommandSeq = Infinity; },
        v => { v.submittedText = {}; },
        v => { v.isHost = false; },
        v => { v.game = {}; },
        v => { v.releaseAt = 123; },
    ];
    for (const mutate of mutations) {
        const invalid = structuredClone(base); mutate(invalid);
        assert.throws(() => parseRoomView(invalid), { code: 'BAD_HOST' });
    }
    const extras = structuredClone(base); extras.privateToken = HOST; extras.members[0].token = HOST;
    const clean = parseRoomView(extras);
    assert.equal(clean.privateToken, undefined); assert.equal(clean.members[0].token, undefined);
    assert.throws(() => parseServerMessage({ protocol: PROTOCOL, type: 'pong', sent: NaN }), { code: 'BAD_HOST' });
    e.host.close();
});

test('strict schema accepts real game projection and rejects malformed action/role/outcome values', async () => {
    const e = setup();
    for (let seat = 2; seat <= 6; seat++) {
        await e.room.join('P' + seat, seat.toString(16).repeat(32));
        await e.room.setOnline(seat, true);
    }
    const snap = e.room.snapshot(); snap.status = 'playing'; snap.matchId = '22222222222222222222222222222222';
    snap.game = createGame({ size: 6, seed: 7, roomId: ROOM }); e.room.newGate(snap); await e.room.commit(snap);
    for (let seat = 1; seat <= 6; seat++)
        assert.deepEqual(parseRoomView(e.room.view(seat)), e.room.view(seat));
    const base = e.room.view(5);
    for (const mutate of [
        v => { v.game.day = '1 <img src=x>'; },
        v => { v.game.self.role = 'constructor'; },
        v => { v.game.action.title = {}; },
        v => { v.game.action.candidates = [1, 1]; },
        v => { v.game.actionStepSerial = 0; },
        v => { v.game.outcome = { winners: ['<img>'], reason: 'conditions' }; },
        v => { v.game.seats[0].name = {}; },
        v => { v.game.self.notes = [null]; },
        v => { v.game.ownVote = { target: '2' }; },
    ]) { const invalid = structuredClone(base); mutate(invalid); assert.throws(() => parseRoomView(invalid), { code: 'BAD_HOST' }); }
    e.host.close(); await e.room.flush();
});

test('authority host permissions, command allow-list, and ACK envelope binding remain enforced', async () => {
    const e = setup(), a = await bind(e.host);
    await e.host.receive(a.c, command(e.room, a.c, 'not-host', { kind: 'size', size: 8, actor: 'host' }));
    assert.equal(a.link.out.filter(m => m.type === 'error').at(-1).code, 'HOST_ONLY');
    await e.host.receive(a.c, command(e.room, a.c, 'stale-host', { kind: 'ready', value: true }, { epoch: 'old' }));
    assert.equal(a.link.out.filter(m => m.type === 'error').at(-1).code, 'HOST_CHANGED');
    const intruder = await bind(e.host, 'intruder', HOST, 'HOST');
    assert.equal(intruder.c.seat, null); assert.equal(intruder.link.out.at(-1).code, 'HOST_TOKEN');
    assert.equal(PROTOCOL, 'renleisha/3'); assert.equal(APP_VERSION, '0.4.2');
    const j = journal(), c = new ClientSession(ROOM, A, 'ALICE', j), link = new Link('fake-host');
    c.link = link; c.connected = true; c.epoch = 'epoch-1'; c.view = e.room.view(2);
    const result = c.submit({ kind: 'ready', value: true }); const cancelled = result.catch(error => error);
    const pending = j.pending[0];
    c.receive({ protocol: PROTOCOL, type: 'ack', id: pending.id, generation: pending.generation, commandSeq: pending.commandSeq + 1 });
    assert.equal(c.pendingCount, 1); assert.equal(c.waiters.size, 1);
    c.close(); assert.equal((await cancelled).name, 'AbortError');
    e.host.close(); await e.room.flush();
});


test('a local journal failure after durable ACK retains the waiter and original identity until retry', async () => {
    const e = setup(), j = journal(), g = await guest(e, j), originalSave = j.save.bind(j);
    const pending = g.client.submit({ kind: 'ready', value: true });
    const observed = pending.then(() => 'acked', error => error);
    const original = structuredClone(j.pending[0]);
    j.save = next => { if (!next.length) throw Error('local quota'); originalSave(next); };
    await later(); await e.room.flush(); await later();
    assert.equal(g.client.pendingCount, 1); assert.equal(g.client.waiters.size, 1);
    assert.equal(e.room.member(2).commandSeq, 1); assert.match(g.client.error, /local quota/);
    j.save = originalSave; e.clock.now += 1000; g.client.retry();
    assert.equal(await observed, 'acked'); assert.equal(g.client.pendingCount, 0);
    assert.equal(e.room.member(2).lastReceipt.id, original.id); assert.equal(e.room.member(2).commandSeq, 1);
    g.client.close(); e.host.close(); await e.room.flush();
});

test('a successful leave is ACKed before the terminal removal notice', async () => {
    const e = setup(), g = await guest(e);
    await g.client.submit({ kind: 'leave' });
    assert.equal(g.client.pendingCount, 0); assert.equal(e.room.member(2), undefined);
    await tick(); await later(); assert.equal(g.client.kicked, true);
    g.client.close(); e.host.close(); await e.room.flush();
});

test('historical numeric chat seats remain valid when the lobby shrinks', async () => {
    const room = new RoomAuthority(RoomAuthority.fresh('HOST', HOST, false, ROOM, 1, 12), new MemoryRoomStore());
    for (let n = 2; n <= 7; n++) await room.join('P' + n, String(n).repeat(32));
    await room.dispatch(7, 'old-chat', '', { kind: 'chat', text: 'before the room shrinks' });
    await room.dispatch(1, 'remove-7', '', { kind: 'kick', seat: 7 });
    await room.dispatch(1, 'smaller', '', { kind: 'size', size: 6 });
    const view = room.view(1);
    assert.equal(view.size, 6); assert.equal(view.chat[0].seat, 7);
    assert.deepEqual(parseRoomView(view), view);
});
