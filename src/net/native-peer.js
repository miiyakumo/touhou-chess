"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativePeer = exports.NativeConnection = void 0;
/** Native WebRTC transport. Speaks the PeerServer OFFER/ANSWER/CANDIDATE signaling
 * envelope; this is our code, not a vendored or renamed PeerJS library. Game data
 * and audio travel over WebRTC, never through the WebSocket signal service. */
const types_js_1 = require("../room/types.js");
const NEGOTIATION_TIMEOUT = 20000;
const SIGNAL_TIMEOUT = 18000;
const MAX_CONNECTIONS = 20;
const MAX_CANDIDATES = 64;
const signalId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
const description = (s, type) => s !== null && typeof s === 'object' && !Array.isArray(s)
    && s.type === type && typeof s.sdp === 'string' && s.sdp.length > 0 && s.sdp.length <= 65536;
const candidate = c => c !== null && typeof c === 'object' && !Array.isArray(c)
    && typeof c.candidate === 'string' && c.candidate.length <= 8192
    && (c.sdpMid == null || typeof c.sdpMid === 'string' && c.sdpMid.length <= 256)
    && (c.sdpMLineIndex == null || Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex <= 65535)
    && (c.usernameFragment == null || typeof c.usernameFragment === 'string' && c.usernameFragment.length <= 256);
class Events {
    listeners = new Map();
    on(event, fn) { if (!this.listeners.has(event))
        this.listeners.set(event, new Set()); this.listeners.get(event).add(fn); }
    off(event, fn) { this.listeners.get(event)?.delete(fn); }
    emit(event, x) { for (const fn of this.listeners.get(event) ?? [])
        fn(x); }
}
class NativeConnection extends Events {
    peer;
    connectionId;
    owner;
    pc;
    remoteAudio = null;
    open = false;
    stopped = false;
    dc = null;
    candidates = [];
    serial = Promise.resolve();
    outgoing = [];
    incoming = [];
    incomingId = '';
    // Match the JSON string-length limit in send(), including UTF-16 payloads.
    incomingBytes = 0;
    negotiationDeadline;
    negotiationTimer = null;
    receivedCandidates = 0;
    descriptionReceived = false;
    initiate;
    constructor(peer, connectionId, owner, initiate) {
        super();
        this.peer = peer;
        this.connectionId = connectionId;
        this.owner = owner;
        this.initiate = initiate;
        this.pc = new RTCPeerConnection(owner.config);
        // This deadline starts before any remote traffic and cannot be kept alive
        // by candidates. It also covers offers which never open a data channel.
        this.negotiationDeadline = Date.now() + NEGOTIATION_TIMEOUT;
        this.negotiationTimer = setTimeout(() => this.fail(Error('数据通道协商超时。请确认房主在线，或检查 ICE / TURN 设置。')), NEGOTIATION_TIMEOUT);
        this.pc.onicecandidate = e => { if (!this.stopped && e.candidate)
            owner.signal({ type: 'CANDIDATE', dst: peer, payload: { type: 'data', connectionId, candidate: e.candidate.toJSON() } }, this); };
        this.pc.ontrack = e => { if (!this.stopped) { this.remoteAudio = new MediaStream([e.track]); this.emit('audio', this.remoteAudio); } };
        this.pc.onconnectionstatechange = () => { if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed')
            this.close(); };
        // Keep the ICE state available to the caller.  In particular, a data
        // channel can remain closed while the peer connection is still
        // checking candidates; closing it on `disconnected` makes LAN joins
        // fail during a short Wi-Fi handover.
        this.pc.oniceconnectionstatechange = () => {
            if (!this.stopped && (this.pc.iceConnectionState === 'failed' || this.pc.iceConnectionState === 'closed')) {
                this.emit('icefailed', this.pc.iceConnectionState);
                this.close();
            }
        };
        this.pc.ondatachannel = e => this.bind(e.channel);
        if (initiate)
            void this.offer().catch(e => this.fail(e));
    }
    active() {
        if (this.stopped)
            return false;
        if (!this.open && Date.now() >= this.negotiationDeadline) {
            this.fail(Error('数据通道协商超时。请重试连接。'));
            return false;
        }
        return true;
    }
    async offer() {
        if (this.active()) {
            this.pc.addTransceiver('audio', { direction: 'sendrecv' });
            this.bind(this.pc.createDataChannel('renleisha', { ordered: true }));
            const offer = await this.pc.createOffer();
            if (!this.active())
                return;
            await this.pc.setLocalDescription(offer);
            if (!this.active())
                return;
            this.owner.signal({ type: 'OFFER', dst: this.peer, payload: {
                connectionId: this.connectionId, type: 'data', sdp: this.pc.localDescription ?? offer,
                label: 'renleisha', reliable: true, serialization: 'json',
                metadata: { app: types_js_1.PROTOCOL }
            } }, this);
        }
    }
    bind(dc) {
        if (this.stopped || this.dc && this.dc !== dc) {
            dc.close();
            return;
        }
        this.dc = dc;
        dc.bufferedAmountLowThreshold = 65536;
        dc.onopen = () => {
            if (!this.active())
                return;
            this.open = true;
            clearTimeout(this.negotiationTimer);
            this.negotiationTimer = null;
            this.emit('open');
            this.flush();
        };
        dc.onclose = () => this.close();
        dc.onerror = () => this.fail(Error('数据通道发生错误。'));
        dc.onbufferedamountlow = () => this.flush();
        dc.onmessage = e => {
            try {
                if (typeof e.data !== 'string' || e.data.length > 60000)
                    throw Error('无效的数据包。');
                const x = JSON.parse(e.data);
                if (x && x._rlsChunk === 1) {
                    if (typeof x.id !== 'string' || x.id.length < 1 || x.id.length > 96 || typeof x.part !== 'string' || !Number.isInteger(x.index) || typeof x.end !== 'boolean')
                        throw Error('无效分片');
                    if (x.index === 0) {
                        this.incoming = [];
                        this.incomingId = x.id;
                        this.incomingBytes = 0;
                    }
                    if (x.id !== this.incomingId || x.index !== this.incoming.length || x.index >= 128)
                        throw Error('分片顺序错误');
                    if (this.incomingBytes + x.part.length > 512000)
                        throw Error('消息过大');
                    this.incomingBytes += x.part.length;
                    this.incoming.push(x.part);
                    if (x.end) {
                        const text = this.incoming.join('');
                        this.incoming = [];
                        this.incomingId = '';
                        this.incomingBytes = 0;
                        this.emit('data', JSON.parse(text));
                    }
                }
                else
                    this.emit('data', x);
            }
            catch (e) {
                this.fail(e);
            }
        };
    }
    send(data) {
        if (!this.open)
            throw Error('数据通道尚未连接。');
        const text = JSON.stringify(data);
        if (text.length > 512000)
            throw Error('消息超过传输上限。');
        if (text.length < 12000)
            this.outgoing.push(text);
        else {
            const id = (0, types_js_1.randomId)();
            for (let i = 0; i < text.length; i += 12000)
                this.outgoing.push(JSON.stringify({ _rlsChunk: 1, id, index: i / 12000, part: text.slice(i, i + 12000), end: i + 12000 >= text.length }));
        }
        if (this.outgoing.length > 256) {
            this.close();
            throw Error('连接积压过多，请重连。');
        }
        this.flush();
    }
    flush() { while (this.dc?.readyState === 'open' && this.dc.bufferedAmount < 131072 && this.outgoing.length)
        this.dc.send(this.outgoing.shift()); }
    handle(m) {
        if (!this.active())
            return;
        if (m.type === 'CANDIDATE') {
            if (!candidate(m.payload?.candidate) || ++this.receivedCandidates > MAX_CANDIDATES) {
                this.fail(Error('无效或过多的 ICE 候选地址。'));
                return;
            }
        }
        else if (m.type === 'OFFER' || m.type === 'ANSWER') {
            if (!description(m.payload?.sdp, this.initiate ? 'answer' : 'offer') || m.type !== (this.initiate ? 'ANSWER' : 'OFFER')) {
                this.fail(Error('无效的会话描述。'));
                return;
            }
            if (this.descriptionReceived)
                return;
            this.descriptionReceived = true;
        }
        else
            return;
        this.serial = this.serial.then(async () => {
            if (!this.active())
                return;
            if (m.type === 'CANDIDATE' && m.payload?.candidate) {
                if (this.pc.remoteDescription)
                    await this.pc.addIceCandidate(m.payload.candidate);
                else
                    this.candidates.push(m.payload.candidate);
            }
            else if ((m.type === 'OFFER' || m.type === 'ANSWER') && m.payload?.sdp) {
                await this.pc.setRemoteDescription(m.payload.sdp);
                if (!this.active())
                    return;
                if (m.type === 'OFFER') {
                    for (const t of this.pc.getTransceivers())
                        if (t.receiver.track?.kind === 'audio')
                            t.direction = 'sendrecv';
                    const answer = await this.pc.createAnswer();
                    if (!this.active())
                        return;
                    await this.pc.setLocalDescription(answer);
                    if (!this.active())
                        return;
                    this.owner.signal({ type: 'ANSWER', dst: this.peer, payload: {
                        connectionId: this.connectionId, type: 'data', sdp: this.pc.localDescription ?? answer
                    } }, this);
                }
                for (const c of this.candidates.splice(0)) {
                    if (!this.active())
                        return;
                    await this.pc.addIceCandidate(c);
                }
            }
        }).catch(e => this.fail(e));
    }
    fail(e) {
        if (this.stopped)
            return;
        try { this.emit('error', e); }
        finally { this.close(); }
    }
    close() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.open = false;
        clearTimeout(this.negotiationTimer);
        this.negotiationTimer = null;
        this.candidates = [];
        this.outgoing = [];
        this.incoming = [];
        this.incomingId = '';
        this.incomingBytes = 0;
        if (this.dc)
            this.dc.onopen = this.dc.onclose = this.dc.onerror = this.dc.onmessage = this.dc.onbufferedamountlow = null;
        this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = this.pc.oniceconnectionstatechange = this.pc.ondatachannel = null;
        this.dc?.close();
        this.pc.close();
        this.owner.forget(this);
        this.emit('close');
    }
}
exports.NativeConnection = NativeConnection;
class NativePeer extends Events {
    id;
    destroyed = false;
    disconnected = true;
    config;
    ws = null;
    heartbeat = null;
    socketTimer = null;
    registered = false;
    early = new Map();
    signalQueue = [];
    connections = new Map();
    token = (0, types_js_1.randomId)();
    options;
    constructor(id, options = {}) {
        super();
        this.id = typeof id === 'string' ? id : 'rls-client-' + (0, types_js_1.randomId)();
        this.options = id !== null && typeof id === 'object' ? id : options;
        this.config = (this.options.config ?? {});
        // Defer so consumers can install open/error listeners before connection starts.
        queueMicrotask(() => this.reconnect());
    }
    reconnect() {
        if (this.destroyed || this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
            return;
        const host = String(this.options.host ?? '0.peerjs.com'), secure = this.options.secure !== false;
        const path = String(this.options.path ?? '/').replace(/\/?$/, '/');
        const query = new URLSearchParams({ key: String(this.options.key ?? 'peerjs'), id: this.id, token: this.token, version: '1.5.5' });
        const url = `${secure ? 'wss' : 'ws'}://${host}:${this.options.port ?? (secure ? 443 : 80)}${path}peerjs?${query}`;
        try {
            const ws = new WebSocket(url);
            this.ws = ws;
            this.disconnected = true;
            let ready = false;
            const current = () => !this.destroyed && this.ws === ws;
            const startHeartbeat = () => {
                if (this.heartbeat !== null)
                    clearInterval(this.heartbeat);
                this.heartbeat = setInterval(() => {
                    if (current() && ws.readyState === WebSocket.OPEN) {
                        this.pruneSignals();
                        this.pruneEarly();
                        try { ws.send(JSON.stringify({ type: 'HEARTBEAT' })); }
                        catch { ws.close(); }
                    }
                }, 5000);
            };
            const opened = () => {
                if (!current() || ready || ws.readyState !== WebSocket.OPEN)
                    return;
                ready = true;
                clearTimeout(this.socketTimer);
                this.socketTimer = null;
                this.disconnected = false;
                this.emit('open', this.id);
                this.flushSignals(ws);
            };
            this.socketTimer = setTimeout(() => {
                if (current() && !ready) {
                    this.emit('error', Error('信令服务连接超时。'));
                    ws.close();
                }
            }, SIGNAL_TIMEOUT);
            ws.onopen = () => {
                if (!current())
                    return;
                startHeartbeat();
                // PeerServer sends OPEN for a new registration, but does not
                // repeat it when the same ID/token replaces a half-open socket.
                // A fresh registration must still wait for OPEN or a rejection.
                if (this.registered)
                    opened();
            };
            ws.onmessage = e => {
                if (!current() || ws.readyState !== WebSocket.OPEN)
                    return;
                try {
                    if (typeof e.data !== 'string' || e.data.length > 131072)
                        return;
                    const m = JSON.parse(e.data);
                    if (!m || typeof m !== 'object' || Array.isArray(m))
                        return;
                    if (m.type === 'OPEN') {
                        this.registered = true;
                        opened();
                        return;
                    }
                    if (m.type === 'ID-TAKEN') {
                        this.emit('error', Object.assign(Error('房主连接标识仍被占用。'), { type: 'unavailable-id' }));
                        ws.close();
                        return;
                    }
                    if (m.type === 'ERROR' || m.type === 'INVALID-KEY') {
                        this.emit('error', Error('信令服务器拒绝连接。'));
                        ws.close();
                        return;
                    }
                    if (m.type === 'EXPIRE') {
                        this.emit('error', Error('房主的信令连接暂时不可达，可能正在重连。请等待几秒后再试；持续失败时检查房主页面、信令和 TURN 设置。'));
                        return;
                    }
                    if (!signalId(m.src) || !signalId(m.payload?.connectionId) || m.payload.type !== 'data')
                        return;
                    if (m.type === 'OFFER' || m.type === 'ANSWER') {
                        if (!description(m.payload.sdp, m.type === 'OFFER' ? 'offer' : 'answer'))
                            return;
                    }
                    else if (m.type !== 'CANDIDATE' || !candidate(m.payload.candidate))
                        return;
                    this.pruneEarly();
                    const key = m.src + ':' + m.payload.connectionId;
                    let c = this.connections.get(key);
                    if (m.type === 'OFFER' && !c) {
                        const pending = [...this.connections.values()].filter(x => x.peer === m.src && !x.open).length;
                        if (m.payload.metadata?.app !== types_js_1.PROTOCOL || this.connections.size >= MAX_CONNECTIONS || pending >= 2)
                            return;
                        c = new NativeConnection(m.src, m.payload.connectionId, this, false);
                        this.connections.set(key, c);
                        this.emit('connection', c);
                    }
                    if (!c && m.type === 'CANDIDATE') {
                        if (this.early.has(key) || this.early.size < 24) {
                            const entry = this.early.get(key) ?? { messages: [], expiresAt: Date.now() + NEGOTIATION_TIMEOUT };
                            if (entry.messages.length < MAX_CANDIDATES)
                                entry.messages.push(m);
                            this.early.set(key, entry);
                        }
                        return;
                    }
                    c?.handle(m);
                    if (c && m.type === 'OFFER') {
                        for (const pending of this.early.get(key)?.messages ?? [])
                            c.handle(pending);
                        this.early.delete(key);
                    }
                }
                catch (e) {
                    this.emit('error', e);
                }
            };
            ws.onerror = () => { if (current())
                this.emit('error', Error('无法连接信令服务。检查网络或设置中的信令地址。')); };
            ws.onclose = () => {
                if (!current())
                    return;
                this.disconnected = true;
                clearInterval(this.heartbeat);
                clearTimeout(this.socketTimer);
                this.heartbeat = null;
                this.socketTimer = null;
                this.emit('disconnected');
            };
        }
        catch (e) {
            this.emit('error', e);
        }
    }
    activeSignal(entry, now = Date.now()) {
        const c = entry.connection;
        return entry.expiresAt > now && !c.stopped && this.connections.get(c.peer + ':' + c.connectionId) === c
            && (c.open || c.negotiationDeadline > now);
    }
    pruneSignals() { this.signalQueue = this.signalQueue.filter(x => this.activeSignal(x)); }
    pruneEarly() {
        const now = Date.now();
        for (const [key, entry] of this.early)
            if (entry.expiresAt <= now)
                this.early.delete(key);
    }
    flushSignals(ws = this.ws) {
        this.pruneSignals();
        if (this.destroyed || this.disconnected || this.ws !== ws || ws?.readyState !== WebSocket.OPEN)
            return;
        while (this.signalQueue.length) {
            try {
                ws.send(JSON.stringify(this.signalQueue[0].message));
                this.signalQueue.shift();
            }
            catch (e) {
                this.emit('error', e);
                ws.close();
                return;
            }
        }
    }
    signal(m, connection = this.connections.get(m.dst + ':' + m.payload?.connectionId)) {
        if (this.destroyed)
            return;
        const entry = { message: m, connection, expiresAt: Date.now() + NEGOTIATION_TIMEOUT };
        if (!connection || !this.activeSignal(entry))
            return;
        // ICE trickle can race a reconnecting signaling socket. Keep a
        // bounded queue tied to each live connection, never replay old offers.
        this.pruneSignals();
        if (this.signalQueue.length < 128)
            this.signalQueue.push(entry);
        else
            this.emit('error', Error('信令暂时断开，候选地址队列已满。'));
        this.flushSignals();
    }
    connect(id, _options) {
        if (this.destroyed)
            throw Error('信令会话已关闭。');
        if (!signalId(id) || this.connections.size >= MAX_CONNECTIONS)
            throw Error('连接目标无效或连接数过多。');
        const c = new NativeConnection(id, 'rls-dc-' + (0, types_js_1.randomId)(), this, true);
        this.connections.set(id + ':' + c.connectionId, c);
        return c;
    }
    forget(c) {
        const key = c.peer + ':' + c.connectionId;
        if (this.connections.get(key) === c)
            this.connections.delete(key);
        this.early.delete(key);
        this.signalQueue = this.signalQueue.filter(x => x.connection !== c);
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        this.disconnected = true;
        clearInterval(this.heartbeat);
        clearTimeout(this.socketTimer);
        this.heartbeat = null;
        this.socketTimer = null;
        for (const c of [...this.connections.values()])
            c.close();
        if (this.ws) {
            this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
            this.ws.close();
        }
        this.ws = null;
        this.early.clear();
        this.signalQueue = [];
        this.emit('close');
    }
}
exports.NativePeer = NativePeer;

