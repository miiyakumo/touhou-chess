const test = require('node:test');
const assert = require('node:assert/strict');
const { NativePeer } = require('../src/net/native-peer.js');
const { openPeer, connectPeer, acceptPeer } = require('../src/net/peer.js');
const { PROTOCOL } = require('../src/room/types.js');

const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const sdp = (type, id = 0) => ({ type, sdp: `v=0\r\ns=transport-${id}\r\n` });
const ice = () => ({ candidate: 'candidate:1 1 UDP 1 192.0.2.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 });
const offer = (src, id, value = sdp('offer')) => ({ type: 'OFFER', src, payload: { type: 'data', connectionId: id, metadata: { app: PROTOCOL }, sdp: value } });

// Only browser and time boundaries are substituted. These tests import the
// actual source modules; normal OFFER/ANSWER/data exchanges run through them.
function browser(t) {
    const saved = [];
    const install = (object, key, value) => {
        saved.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
        Object.defineProperty(object, key, { configurable: true, writable: true, value });
    };
    const env = { peers: [], sockets: [], pcs: [], timers: new Map(), now: 1000, nextTimer: 0, autoRoute: true, autoOpen: true, offerGate: null };
    const schedule = (fn, delay, repeat) => {
        const id = ++env.nextTimer;
        env.timers.set(id, { fn, at: env.now + delay, repeat: repeat ? delay : 0 });
        return id;
    };
    env.advance = async ms => {
        const target = env.now + ms;
        for (;;) {
            const next = [...env.timers].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) break;
            const [id, timer] = next;
            env.now = timer.at;
            if (timer.repeat) timer.at += timer.repeat;
            else env.timers.delete(id);
            timer.fn();
            await drain();
        }
        env.now = target;
        await drain();
    };
    class DataChannel {
        readyState = 'connecting'; bufferedAmount = 0; sent = []; autoBuffer = false; peer = null;
        open() { this.readyState = 'open'; this.onopen?.(); }
        send(data) {
            assert.equal(this.readyState, 'open');
            this.sent.push(data);
            if (this.autoBuffer) this.bufferedAmount += Buffer.byteLength(data);
            queueMicrotask(() => { if (this.peer?.readyState === 'open') this.peer.onmessage?.({ data }); });
        }
        drain() { this.bufferedAmount = 0; this.onbufferedamountlow?.(); }
        close() {
            if (this.readyState === 'closed') return;
            this.readyState = 'closed';
            this.onclose?.();
            this.peer?.close();
        }
    }
    class PC {
        connectionState = 'new'; iceConnectionState = 'new'; remoteDescription = null; localDescription = null;
        transceivers = []; addedCandidates = []; localWrites = 0; dc = null;
        constructor(config) { this.config = config; this.id = env.pcs.length + 1; env.pcs.push(this); }
        addTransceiver(kind) { const x = { receiver: { track: { kind } }, direction: 'sendrecv' }; this.transceivers.push(x); return x; }
        getTransceivers() { return this.transceivers; }
        createDataChannel() { this.dc = new DataChannel(); return this.dc; }
        createOffer() { return env.offerGate ? env.offerGate : Promise.resolve(sdp('offer', this.id)); }
        createAnswer() { return Promise.resolve(sdp('answer', this.id)); }
        setLocalDescription(x) { this.localWrites++; this.localDescription = x; return Promise.resolve(); }
        setRemoteDescription(x) {
            this.remoteDescription = x;
            const other = env.pcs.find(pc => pc.id === Number(x.sdp.match(/s=transport-(\d+)/)?.[1]));
            if (other) { this.other = other; other.other = this; }
            if (x.type === 'offer' && !this.transceivers.length) this.addTransceiver('audio');
            if (x.type === 'answer' && other && env.autoOpen) queueMicrotask(() => {
                if (this.connectionState === 'closed' || other.connectionState === 'closed') return;
                const remote = new DataChannel();
                other.dc = remote;
                this.dc.peer = remote; remote.peer = this.dc;
                other.ondatachannel?.({ channel: remote });
                this.connectionState = other.connectionState = 'connected';
                this.iceConnectionState = other.iceConnectionState = 'connected';
                remote.open(); this.dc.open();
            });
            return Promise.resolve();
        }
        addIceCandidate(x) { this.addedCandidates.push(x); return Promise.resolve(); }
        close() { this.connectionState = 'closed'; this.iceConnectionState = 'closed'; }
    }
    class Socket {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0; sent = [];
        constructor(url) { this.url = url; this.id = new URL(url).searchParams.get('id'); env.sockets.push(this); }
        open() { this.readyState = 1; this.onopen?.(); }
        receive(x) { this.onmessage?.({ data: JSON.stringify(x) }); }
        send(text) {
            assert.equal(this.readyState, 1);
            const m = JSON.parse(text); this.sent.push(m);
            if (env.autoRoute && m.dst) {
                const target = [...env.sockets].reverse().find(ws => ws.id === m.dst && ws.readyState === 1);
                if (target) queueMicrotask(() => { if (target.readyState === 1) target.receive({ ...m, src: this.id }); });
            }
        }
        close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
    }
    class RecordedPeer extends NativePeer {
        constructor(...args) { super(...args); env.peers.push(this); }
    }
    install(globalThis, 'WebSocket', Socket);
    install(globalThis, 'RTCPeerConnection', PC);
    install(globalThis, 'MediaStream', class { constructor(tracks) { this.tracks = tracks; } });
    install(globalThis, 'window', { Peer: RecordedPeer });
    install(globalThis, 'setTimeout', (fn, ms) => schedule(fn, ms, false));
    install(globalThis, 'clearTimeout', id => env.timers.delete(id));
    install(globalThis, 'setInterval', (fn, ms) => schedule(fn, ms, true));
    install(globalThis, 'clearInterval', id => env.timers.delete(id));
    install(Date, 'now', () => env.now);
    env.peer = async (id, register = true) => {
        const p = new RecordedPeer(id, { config: { iceServers: [] } }); await drain();
        if (register) { p.ws.open(); p.ws.receive({ type: 'OPEN' }); }
        return p;
    };
    env.pair = async () => {
        const host = await env.peer('host'); const guest = await env.peer('guest');
        let incoming;
        acceptPeer(host, link => { incoming = link; });
        const link = await connectPeer(guest, host.id);
        assert(incoming, 'host must accept the channel before application messages');
        return { host, guest, incoming, link };
    };
    t.after(() => {
        for (const p of env.peers) p.destroy();
        for (const [object, key, desc] of saved.reverse()) {
            if (desc) Object.defineProperty(object, key, desc);
            else delete object[key];
        }
    });
    return env;
}

test('normal registration, OFFER/ANSWER and application messages work in both directions', async t => {
    const env = browser(t);
    const { host, guest, incoming, link } = await env.pair();
    const hostMessages = [], guestMessages = [];
    incoming.onMessage(x => hostMessages.push(x)); link.onMessage(x => guestMessages.push(x));
    link.send({ type: 'hello', room: 'test' }); incoming.send({ type: 'view', seq: 1 });
    await drain();
    assert.deepEqual(hostMessages, [{ type: 'hello', room: 'test' }]);
    assert.deepEqual(guestMessages, [{ type: 'view', seq: 1 }]);
    assert.equal(guest.ws.sent.find(x => x.type === 'OFFER').payload.metadata.app, PROTOCOL);
    assert(host.ws.sent.some(x => x.type === 'ANSWER'));
    assert.equal(link.conn.negotiationTimer, null);
    assert.equal(incoming.conn.negotiationTimer, null);
    await env.advance(21000);
    assert(link.open && incoming.open, 'negotiation expiry must not close established channels');
});

test('malformed OFFERs cannot allocate PCs; valid negotiations have an absolute deadline', async t => {
    const env = browser(t); env.autoOpen = false;
    const p = await env.peer('host'); let accepted = 0; acceptPeer(p, () => accepted++);
    for (let i = 0; i < 25; i++) {
        const m = offer('sender-' + i, 'bad-' + i); delete m.payload.sdp; p.ws.receive(m);
    }
    p.ws.receive(offer('sender', 'wrong-sdp-type', sdp('answer')));
    p.ws.receive(offer('sender', 'huge', { type: 'offer', sdp: 'x'.repeat(65537) }));
    const old = offer('sender', 'old-version'); old.payload.metadata.app = 'renleisha/2'; p.ws.receive(old);
    assert.equal(env.pcs.length, 0);
    for (let i = 0; i < 20; i++) p.ws.receive(offer('sender-' + i, 'pending-' + i));
    await drain(); assert.equal(p.connections.size, 20);
    await env.advance(15000);
    p.ws.receive({ type: 'CANDIDATE', src: 'sender-0', payload: { type: 'data', connectionId: 'pending-0', candidate: ice() } });
    await drain();
    await env.advance(5000);
    assert.equal(p.connections.size, 0);
    assert.equal(accepted, 0);
    assert(env.pcs.every(pc => pc.connectionState === 'closed'));
    p.ws.receive(offer('new-player', 'new-attempt')); await drain();
    assert.equal(p.connections.size, 1, 'capacity must recover after the original deadline');
});

test('one remote peer cannot accumulate pending negotiations and early ICE candidates expire', async t => {
    const env = browser(t); env.autoOpen = false;
    const p = await env.peer('host');
    for (let i = 0; i < 3; i++) p.ws.receive(offer('same-player', 'pending-' + i));
    assert.equal(p.connections.size, 2);
    p.ws.receive({ type: 'CANDIDATE', src: 'other-player', payload: { type: 'data', connectionId: 'early', candidate: ice() } });
    assert.equal(p.early.size, 1);
    await env.advance(20000);
    assert.equal(p.early.size, 0);
    assert.equal(p.connections.size, 0);
});

test('ICE which precedes an OFFER is replayed after the remote description', async t => {
    const env = browser(t); env.autoOpen = false;
    const p = await env.peer('host');
    p.ws.receive({ type: 'CANDIDATE', src: 'player', payload: { type: 'data', connectionId: 'early', candidate: ice() } });
    p.ws.receive(offer('player', 'early')); await drain();
    const c = p.connections.get('player:early');
    assert.deepEqual(c.pc.addedCandidates, [ice()]);
    assert.equal(c.pc.remoteDescription.type, 'offer');
    assert.equal(p.early.size, 0);
});

test('same ID/token WS resume needs no second OPEN; heartbeat and live signals resume while DCs survive', async t => {
    const env = browser(t);
    const { host, guest, incoming, link } = await env.pair();
    const received = []; incoming.onMessage(x => received.push(x));
    let opens = 0; guest.on('open', () => opens++);
    guest.ws.close();
    assert(guest.disconnected && link.open && incoming.open);
    link.send({ whileSignalOffline: true }); await drain();
    assert.deepEqual(received, [{ whileSignalOffline: true }]);
    const pending = guest.connect('another-host'); await drain();
    assert.equal(guest.signalQueue.length, 1);
    guest.reconnect(); const resumed = guest.ws; resumed.open();
    assert.equal(guest.disconnected, false);
    assert.equal(guest.signalQueue.length, 0);
    assert(resumed.sent.some(x => x.type === 'OFFER' && x.payload.connectionId === pending.connectionId));
    resumed.receive({ type: 'OPEN' });
    assert.equal(opens, 1, 'a server that also sends OPEN must not complete resume twice');
    await env.advance(5000);
    assert.equal(resumed.sent.filter(x => x.type === 'HEARTBEAT').length, 1);
    assert(link.open && incoming.open && !host.destroyed);
});

test('initial registration waits for OPEN and server rejection remains fatal only to that signaling attempt', async t => {
    const env = browser(t);
    const opening = openPeer(null, { iceServers: [] }); let settled = false;
    opening.then(() => { settled = true; }, () => { settled = true; });
    await drain(); const p = env.peers[0]; p.ws.open(); await drain();
    assert.equal(settled, false);
    const rejected = assert.rejects(opening, /信令服务器拒绝/);
    p.ws.receive({ type: 'ERROR' }); await rejected;
    assert(p.destroyed); assert.equal(env.timers.size, 0);
});

test('rejected WS resume retains established data channels and exposes the rejection', async t => {
    const env = browser(t); const { guest, link, incoming } = await env.pair();
    const errors = []; guest.on('error', e => errors.push(e));
    guest.ws.close(); guest.reconnect(); guest.ws.open(); guest.ws.receive({ type: 'ID-TAKEN' });
    assert.equal(errors[0].type, 'unavailable-id');
    assert(guest.disconnected && !guest.destroyed && link.open && incoming.open);
});

test('closing or expiring a connection removes queued signaling; late offers cannot revive it', async t => {
    const env = browser(t); const p = await env.peer('guest'); p.ws.close();
    const c = p.connect('host'); await drain(); assert.equal(p.signalQueue.length, 1);
    c.close(); assert.equal(p.signalQueue.length, 0);
    let complete; env.offerGate = new Promise(resolve => { complete = resolve; });
    const delayed = p.connect('host'); delayed.close();
    complete(sdp('offer', delayed.pc.id)); await drain();
    assert.equal(delayed.pc.localWrites, 0);
    p.reconnect(); p.ws.open();
    assert.equal(p.ws.sent.filter(x => x.type === 'OFFER').length, 0);
    assert.equal(p.connections.size, 0);
});

test('old queued candidates are discarded by TTL without closing an established channel', async t => {
    const env = browser(t); const { guest, link } = await env.pair();
    guest.ws.close();
    guest.signal({ type: 'CANDIDATE', dst: 'host', payload: { type: 'data', connectionId: link.conn.connectionId, candidate: ice() } }, link.conn);
    assert.equal(guest.signalQueue.length, 1);
    await env.advance(21000);
    guest.reconnect(); guest.ws.open();
    assert.equal(guest.signalQueue.length, 0);
    assert.equal(guest.ws.sent.filter(x => x.type === 'CANDIDATE').length, 0);
    assert(link.open);
});

test('openPeer cancellation releases pending peers and settles without a timeout or fallback', async t => {
    const env = browser(t); const already = new AbortController(); already.abort();
    await assert.rejects(openPeer('preferred', { iceServers: [] }, already.signal), { name: 'AbortError' });
    assert.equal(env.peers.length, 0);
    const abort = new AbortController(); const opening = openPeer('preferred', { iceServers: [] }, abort.signal);
    await drain(); const p = env.peers[0];
    const rejected = assert.rejects(opening, { name: 'AbortError' }); abort.abort(); await rejected;
    assert(p.destroyed); assert.equal(env.peers.length, 1); assert.equal(env.timers.size, 0);
    for (const name of ['open', 'close', 'error', 'disconnected']) assert.equal(p.listeners.get(name)?.size ?? 0, 0);
});

test('openPeer succeeds, cleans up temporary listeners, and preserves a claimed peer after later abort', async t => {
    const env = browser(t); const abort = new AbortController();
    const opening = openPeer('preferred', { iceServers: [] }, abort.signal); await drain();
    const first = env.peers[0]; first.ws.open(); first.ws.receive({ type: 'ID-TAKEN' }); await drain();
    assert(first.destroyed); assert.equal(env.peers.length, 2);
    const replacement = env.peers[1]; replacement.ws.open(); replacement.ws.receive({ type: 'OPEN' });
    assert.equal(await opening, replacement);
    abort.abort(); assert.equal(replacement.destroyed, false);
    for (const name of ['open', 'close', 'error', 'disconnected']) assert.equal(replacement.listeners.get(name)?.size ?? 0, 0);
});

test('connectPeer cancellation and close settle immediately, release listeners, and keep other links alive', async t => {
    const env = browser(t); const { guest, link } = await env.pair();
    const already = new AbortController(); already.abort();
    await assert.rejects(connectPeer(guest, 'host', already.signal), { name: 'AbortError' });
    assert.equal(guest.connections.size, 1);
    const abort = new AbortController(); const pending = connectPeer(guest, 'absent-host', abort.signal); await drain();
    const c = [...guest.connections.values()].find(x => x !== link.conn);
    const rejected = assert.rejects(pending, { name: 'AbortError' }); abort.abort(); await rejected;
    assert(c.stopped && link.open && !guest.destroyed);
    for (const name of ['open', 'error', 'close', 'icefailed']) assert.equal(c.listeners.get(name)?.size ?? 0, 0);
    const closed = connectPeer(guest, 'absent-host'); await drain();
    const closing = [...guest.connections.values()].find(x => x !== link.conn);
    const immediate = assert.rejects(closed, /已关闭/); closing.close(); await immediate;
    assert.equal(guest.connections.size, 1);
    assert.equal([...env.timers.values()].filter(x => !x.repeat).length, 0);
});

test('PeerLink emits one terminal notification when error is followed by close', async t => {
    const env = browser(t); const { link } = await env.pair(); let calls = 0;
    link.onClose(() => calls++); link.conn.fail(Error('test failure'));
    assert.equal(calls, 1); assert.equal(link.open, false);
});

test('fragmented JSON retains order across backpressure and bufferedamountlow resumes the queue', async t => {
    const env = browser(t); const { link, incoming } = await env.pair();
    const messages = []; incoming.onMessage(x => messages.push(x));
    const large = { text: '东方✨'.repeat(30000), seq: 1 }; const next = { seq: 2 };
    const dc = link.conn.dc; dc.autoBuffer = true; dc.bufferedAmount = 200000;
    link.send(large); link.send(next);
    assert.equal(dc.sent.length, 0); assert(link.conn.outgoing.length > 1);
    dc.drain(); await drain();
    assert(dc.sent.length > 0 && link.conn.outgoing.length > 0, 'large payload must pause when the buffer fills');
    while (link.conn.outgoing.length) { dc.drain(); await drain(); }
    assert.deepEqual(messages, [large, next]);
    assert.equal(incoming.conn.incomingBytes, 0);
    assert.equal(incoming.conn.incomingId, '');
    assert.equal(incoming.conn.incoming.length, 0);
    assert.equal(dc.bufferedAmountLowThreshold, 65536);
    assert(link.open && incoming.open);
});

test('unfinished fragments close immediately when the aggregate message budget is exceeded', async t => {
    const env = browser(t); const { link, incoming, host } = await env.pair();
    const messages = [], errors = [];
    incoming.onMessage(x => messages.push(x)); incoming.conn.on('error', e => errors.push(e));
    const part = 'x'.repeat(59000);
    for (let index = 0; index < 8; index++) {
        const frame = JSON.stringify({ _rlsChunk: 1, id: 'unfinished', index, part, end: false });
        assert(frame.length < 60000, 'each frame is individually within the packet limit');
        link.conn.dc.send(frame); await drain();
        assert(incoming.open);
        assert.equal(incoming.conn.incomingBytes, (index + 1) * part.length);
    }
    link.conn.dc.send(JSON.stringify({ _rlsChunk: 1, id: 'unfinished', index: 8, part, end: false }));
    await drain();
    assert(incoming.conn.stopped && link.conn.stopped, 'no end frame is needed to reject an oversized message');
    assert.match(errors[0].message, /消息过大/);
    assert.deepEqual(messages, []);
    assert.equal(incoming.conn.incomingBytes, 0);
    assert.equal(incoming.conn.incomingId, '');
    assert.deepEqual(incoming.conn.incoming, []);
    assert.equal(host.connections.size, 0);
});

test('a new fragmented message resets the budget and an exact-limit message still completes', async t => {
    const env = browser(t); const { link, incoming } = await env.pair();
    const messages = []; incoming.onMessage(x => messages.push(x));
    for (let index = 0; index < 8; index++)
        link.conn.dc.send(JSON.stringify({ _rlsChunk: 1, id: 'abandoned', index, part: 'x'.repeat(59000), end: false }));
    await drain();
    assert.equal(incoming.conn.incomingBytes, 472000);
    const value = { text: '界'.repeat(512000 - JSON.stringify({ text: '' }).length) };
    assert.equal(JSON.stringify(value).length, 512000);
    link.send(value); await drain();
    assert.deepEqual(messages, [value]);
    assert.equal(incoming.conn.incomingBytes, 0);
    assert.equal(incoming.conn.incomingId, '');
    assert.deepEqual(incoming.conn.incoming, []);
    link.conn.dc.send(JSON.stringify({ _rlsChunk: 1, id: 'x'.repeat(96), index: 0, part: '{"next":true}', end: true }));
    await drain();
    assert.deepEqual(messages, [value, { next: true }]);
    assert(incoming.open && link.open);
});

test('fragment IDs are bounded and end must be an explicit boolean', async t => {
    const env = browser(t);
    for (const invalid of [{ id: '' }, { id: 'x'.repeat(97) }, { end: 1 }, { end: undefined }]) {
        const { link, incoming } = await env.pair(); const errors = [], messages = [];
        incoming.conn.on('error', e => errors.push(e)); incoming.onMessage(x => messages.push(x));
        link.conn.dc.send(JSON.stringify({ _rlsChunk: 1, id: 'valid', index: 0, part: '{}', end: true, ...invalid }));
        await drain();
        assert(incoming.conn.stopped);
        assert.match(errors[0].message, /无效分片/);
        assert.deepEqual(messages, []);
        assert.equal(incoming.conn.incomingBytes, 0);
    }
});
