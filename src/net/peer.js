"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PeerLink = void 0;
exports.defaultSettings = defaultSettings;
exports.loadPeerJS = loadPeerJS;
exports.openPeer = openPeer;
exports.acceptPeer = acceptPeer;
exports.connectPeer = connectPeer;
exports.invitationURL = invitationURL;
exports.parseInvitation = parseInvitation;
const native_peer_js_1 = require("./native-peer.js");
const types_js_1 = require("../room/types.js");
function defaultSettings() {
    return { ...window.RENLEISHA_CONFIG?.peer, iceServers: window.RENLEISHA_CONFIG?.peer?.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }] };
}
async function loadPeerJS() {
    // Function name retained for old adapter tests. Production has no external script dependency.
    return window.Peer ?? native_peer_js_1.NativePeer;
}
function aborted() { return Object.assign(Error('连接已取消。'), { name: 'AbortError' }); }
async function openPeer(preferred, settings, signal) {
    if (signal?.aborted)
        throw aborted();
    const Peer = await loadPeerJS();
    const options = { debug: 0, config: { iceServers: settings.iceServers } };
    for (const k of ['host', 'port', 'path', 'secure', 'key'])
        if (settings[k] !== undefined)
            options[k] = settings[k];
    function attempt(id) {
        return new Promise((res, rej) => {
            if (signal?.aborted) {
                rej(aborted());
                return;
            }
            const peer = id ? new Peer(id, options) : new Peer(options);
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                peer.off('error', onerror);
                peer.off('open', onopen);
                peer.off('close', onclose);
                peer.off('disconnected', onclose);
                signal?.removeEventListener('abort', onabort);
            };
            const fail = error => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                peer.destroy();
                rej(error);
            };
            const onerror = raw => fail(raw instanceof Error ? raw : Object.assign(Error('信令服务连接失败'), raw));
            const onopen = () => {
                if (settled)
                    return;
                if (signal?.aborted) {
                    fail(aborted());
                    return;
                }
                settled = true;
                cleanup();
                res(peer);
            };
            const onclose = () => fail(Error('信令连接在初始化时中断。'));
            const onabort = () => fail(aborted());
            const timer = setTimeout(() => fail(Error('信令服务连接超时。请检查网络设置或换用可达的 PeerServer。')), 18000);
            peer.on('error', onerror);
            peer.on('open', onopen);
            peer.on('close', onclose);
            peer.on('disconnected', onclose);
            signal?.addEventListener('abort', onabort, { once: true });
            if (signal?.aborted)
                onabort();
        });
    }
    try {
        return await attempt(preferred);
    }
    catch (e) {
        if (!signal?.aborted && preferred && typeof e === 'object' && e !== null && 'type' in e && e.type === 'unavailable-id')
            return attempt('rls-' + (0, types_js_1.randomId)());
        throw e;
    }
}
class PeerLink {
    conn;
    id;
    constructor(conn) {
        this.conn = conn;
        this.id = conn.connectionId || (0, types_js_1.randomId)();
    }
    get open() { return this.conn.open; }
    get rtc() { return this.conn.pc; }
    get remoteAudio() { return this.conn.remoteAudio ?? null; }
    onAudio(fn) { const listener = (x) => fn(x); this.conn.on('audio', listener); return () => this.conn.off('audio', listener); }
    sendSpeaking(seats) { this.conn.send({ _rlsVoice: 1, speakers: seats }); }
    onSpeaking(fn) { const wrapped = (x) => { const m = x; if (m?._rlsVoice === 1 && Array.isArray(m.speakers) && m.speakers.length <= 12 && m.speakers.every(n => Number.isInteger(n) && n >= 1 && n <= 12))
        fn(m.speakers); }; this.conn.on('data', wrapped); return () => this.conn.off('data', wrapped); }
    send(x) { this.conn.send(x); }
    close() { this.conn.close(); }
    onMessage(fn) { const wrapped = (x) => { if (x?._rlsVoice !== 1)
        fn(x); }; this.conn.on('data', wrapped); return () => this.conn.off('data', wrapped); }
    onClose(fn) {
        const off = () => { this.conn.off('close', closed); this.conn.off('error', closed); };
        const closed = () => { off(); fn(); };
        this.conn.on('close', closed);
        this.conn.on('error', closed);
        return off;
    }
}
exports.PeerLink = PeerLink;
function acceptPeer(peer, fn) {
    const incoming = c => {
        const cleanup = () => { c.off('open', opened); c.off('close', cleanup); c.off('error', cleanup); };
        const opened = () => { cleanup(); fn(new PeerLink(c)); };
        if (c.open)
            opened();
        else {
            c.on('open', opened);
            c.on('close', cleanup);
            c.on('error', cleanup);
        }
    };
    peer.on('connection', incoming);
    return () => peer.off('connection', incoming);
}
function connectPeer(peer, hostId, signal) {
    return new Promise((res, rej) => {
        if (signal?.aborted) {
            rej(aborted());
            return;
        }
        const c = peer.connect(hostId, { reliable: true, serialization: 'json', metadata: { app: types_js_1.PROTOCOL } });
        if (!c) {
            rej(Error('信令会话暂时不可用。'));
            return;
        }
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            c.off('open', onopen);
            c.off('error', onerror);
            c.off('icefailed', onicefailed);
            c.off('close', onclose);
            signal?.removeEventListener('abort', onabort);
        };
        const finishError = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            c.close();
            rej(error);
        };
        const onopen = () => {
            if (settled)
                return;
            if (signal?.aborted) {
                finishError(aborted());
                return;
            }
            settled = true;
            cleanup();
            res(new PeerLink(c));
        };
        const onerror = e => finishError(e instanceof Error ? e : Error('与房主建联失败。'));
        const onicefailed = () => finishError(Error('ICE 协商失败，请在联机设置中加入可用的 TURN 服务。'));
        const onclose = () => finishError(Error('数据通道在建联完成前已关闭。'));
        const onabort = () => finishError(aborted());
        const timer = setTimeout(() => {
            const state = c.pc?.iceConnectionState;
            const detail = state === 'failed'
                ? 'ICE 协商失败，请在联机设置中加入可用的 TURN 服务。'
                : '已连接信令，但未能连上房主的数据通道。请确认房主在线；受限网络可能需要 TURN。';
            finishError(Error(detail));
        }, 20000);
        c.on('open', onopen);
        c.on('error', onerror);
        c.on('icefailed', onicefailed);
        c.on('close', onclose);
        signal?.addEventListener('abort', onabort, { once: true });
        if (signal?.aborted)
            onabort();
        else if (c.open)
            onopen();
        else if (c.stopped)
            onclose();
    });
}
function invitationURL(roomId, hostId, settings, base = location.href) {
    const u = new URL(base);
    u.hash = '';
    u.search = '';
    const p = new URLSearchParams({ room: roomId, host: hostId });
    if (settings.host) {
        const { iceServers: _, ...server } = settings;
        p.set('server', btoa(JSON.stringify(server)));
    }
    if (u.protocol === 'https:' || u.protocol === 'http:') {
        u.hash = p.toString();
        return u.href;
    }
    return 'RLS4:' + p.toString();
}
function parseInvitation(text) {
    let hash = text.trim().replace(/^RLS4:/i, '');
    if (hash.length > 4096)
        throw Error('邀请码过长。');
    if (hash.includes('#'))
        hash = hash.slice(hash.indexOf('#') + 1);
    const p = new URLSearchParams(hash);
    const roomId = p.get('room') ?? '', hostId = p.get('host') ?? '';
    if (!/^[a-f0-9]{32}$/.test(roomId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(hostId))
        throw Error('请粘贴完整的 RLS4 邀请码或邀请链接。');
    const result = { roomId, hostId };
    if (p.has('server')) {
        const s = JSON.parse(atob(p.get('server')));
        if (typeof s.host !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(s.host))
            throw Error('邀请中的信令服务器无效。');
        const port = typeof s.port === 'number' ? s.port : 443, path = typeof s.path === 'string' ? s.path : '/';
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith('/') || path.length > 256)
            throw Error('邀请中的信令端口或路径无效。');
        result.server = { host: s.host, port, path, secure: s.secure !== false };
        if (typeof s.key === 'string' && s.key.length < 128)
            result.server.key = s.key;
    }
    return result;
}

