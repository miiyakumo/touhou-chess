"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostSession = void 0;
const { RuleError } = require("../domain/model.js");
const { PROTOCOL, randomId } = require("../room/types.js");
const { parseClientMessage } = require("./protocol.js");

const HANDSHAKE_MS = 30000;
const MAX_CONNECTIONS = 20;
/** Connection ownership is checked again inside the room transaction. */
class HostSession {
    conns = new Map();
    seats = new Map();
    commandRates = new Map();
    constructor(authority, epoch = randomId(), now = Date.now, onBound) {
        this.authority = authority;
        this.epoch = epoch;
        this.now = now;
        this.onBound = onBound;
        this.workRate = { tokens: 40, at: now() };
        this.off = authority.subscribe(() => this.broadcast());
    }
    accept(link) {
        if (this.conns.size >= MAX_CONNECTIONS || this.conns.has(link.id)) {
            link.close();
            return;
        }
        const c = { link, seat: null, token: null, generation: null, acceptedAt: this.now(), lastSeen: this.now(),
            visible: true, seq: 0, lastView: '', busy: false, pending: null, closed: false, revoked: false,
            messageRate: { tokens: 30, at: this.now() }, terminalTimer: null, abuse: 0 };
        this.conns.set(link.id, c);
        link.onMessage(raw => { void this.receive(c, raw); });
        link.onClose(() => this.closed(c));
    }
    take(bucket, capacity, perSecond) {
        const now = this.now();
        bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * perSecond / 1000);
        bucket.at = now;
        if (bucket.tokens < 1)
            return false;
        bucket.tokens--;
        return true;
    }
    send(c, message) {
        if (!c.link.open || c.closed)
            return;
        try { c.link.send(message); }
        catch { this.closed(c); }
    }
    error(c, id, code, message) {
        this.send(c, { protocol: PROTOCOL, type: 'error', id, code, message: String(message).slice(0, 1000) || '操作失败。' });
    }
    current(c) {
        return !c.closed && !c.revoked && this.seats.get(c.seat) === c;
    }
    async receive(c, raw) {
        if (c.closed || c.revoked)
            return;
        if (c.seat === null && this.now() - c.acceptedAt >= HANDSHAKE_MS) {
            this.error(c, null, 'HELLO_TIMEOUT', '房间握手超时，请重新连接。');
            this.closed(c);
            return;
        }
        let requestId = raw && raw.type === 'command' && typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 96 ? raw.id : null;
        if (!this.take(c.messageRate, 30, 10)) {
            this.error(c, requestId, 'RATE_LIMIT', '消息发送过快，请稍后重试原操作。');
            if (++c.abuse >= 3)
                this.closed(c);
            return;
        }
        try {
            const m = parseClientMessage(raw);
            c.lastSeen = this.now();
            if (m.type === 'ping') {
                this.send(c, { protocol: PROTOCOL, type: 'pong', sent: m.sent });
                return;
            }
            if (m.roomId !== this.authority.roomId)
                throw new RuleError('WRONG_ROOM', '邀请链接属于其他房间。');
            if (m.type === 'presence') {
                c.visible = m.visible;
                return;
            }
            if (m.type === 'hello') {
                if (c.busy)
                    return;
                if (!this.take(this.workRate, 40, 10))
                    throw new RuleError('RATE_LIMIT', '加入请求过多，请稍后重连。');
                c.busy = true;
                try {
                    if (c.seat !== null && c.token !== m.token)
                        throw new RuleError('BOUND', '连接已绑定，不可更换身份。');
                    const seat = await this.authority.join(m.name, m.token, m.resumeGeneration);
                    if (seat === 1)
                        throw new RuleError('HOST_TOKEN', '房主座位不能通过远端连接接管。');
                    if (c.closed || c.revoked)
                        return;
                    if (this.now() - c.acceptedAt >= HANDSHAKE_MS && c.seat === null) {
                        this.closed(c);
                        return;
                    }
                    const member = this.authority.member(seat);
                    if (!member || member.token !== m.token)
                        throw new RuleError('SEAT_LOST', '加入时座位已被移除，请重新加入。');
                    if (m.resumeGeneration !== null && member.commandGeneration !== m.resumeGeneration)
                        throw new RuleError('KICKED', '原座位已被移除或失效，已停止自动重连。请返回首页后明确重新加入。');
                    const old = this.seats.get(seat);
                    if (old && old !== c)
                        this.retire(old, 'replaced');
                    c.seat = seat;
                    c.token = m.token;
                    c.generation = member.commandGeneration;
                    this.seats.set(seat, c);
                    await this.authority.setOnline(seat, true, c.token);
                    if (!this.current(c))
                        return;
                    this.sendView(c, true);
                    if (this.current(c))
                        this.onBound?.(c.link, seat);
                }
                finally { c.busy = false; }
                return;
            }
            requestId = m.id;
            if (c.seat === null)
                throw new RuleError('HELLO_REQUIRED', '请先完成房间握手。');
            if (!this.current(c))
                throw new RuleError('REPLACED', '该座位已在另一个页面连接。');
            if (m.epoch !== this.epoch)
                throw new RuleError('HOST_CHANGED', '房主已经恢复，请重新连接后重试原操作。');
            const fingerprint = JSON.stringify([m.id, m.generation, m.commandSeq, m.matchId, m.intent]);
            if (c.pending) {
                if (c.pending.fingerprint === fingerprint)
                    return; // The in-flight original will return the durable receipt.
                throw new RuleError('BUSY', '上一项操作正在保存，请稍后重试原操作。');
            }
            let rate = this.commandRates.get(c.generation);
            if (!rate) {
                rate = { tokens: 6, at: this.now(), seat: c.seat, token: c.token };
                this.commandRates.set(c.generation, rate);
            }
            if (!this.take(rate, 6, 2) || !this.take(this.workRate, 40, 10))
                throw new RuleError('RATE_LIMIT', '操作发送过快，请稍后重试原操作。');
            c.pending = { fingerprint };
            try {
                const receipt = await this.authority.dispatch(c.seat, m.id, m.matchId, m.intent, {
                    token: c.token, generation: m.generation, commandSeq: m.commandSeq,
                    isCurrent: () => this.current(c),
                });
                this.send(c, { protocol: PROTOCOL, type: 'ack', ...receipt });
                this.sendView(c, true);
            }
            finally { c.pending = null; }
        }
        catch (e) {
            this.error(c, requestId, e instanceof RuleError ? e.code : 'SAVE_ERROR', e instanceof Error ? e.message : '操作失败，未确认。');
        }
    }
    sendView(c, force = false) {
        if (c.seat === null || c.closed || c.revoked)
            return;
        const member = this.authority.member(c.seat);
        if (!member || member.token !== c.token || member.commandGeneration !== c.generation) {
            c.revoked = true;
            // Commit broadcasts run before dispatch resolves. Let a successful
            // leave receive its ACK in this microtask turn, then send a terminal
            // notice rather than turning removal into an auto-reconnect loop.
            c.terminalTimer = setTimeout(() => this.retire(c, 'kicked'), 0);
            return;
        }
        try {
            const view = this.authority.view(c.seat), fingerprint = JSON.stringify(view);
            if (!force && fingerprint === c.lastView)
                return;
            c.lastView = fingerprint;
            this.send(c, { protocol: PROTOCOL, type: 'view', epoch: this.epoch, seq: ++c.seq, view });
        }
        catch { this.closed(c); }
    }
    broadcast() {
        for (const c of this.seats.values())
            this.sendView(c);
        for (const [generation, rate] of this.commandRates) {
            const member = this.authority.member(rate.seat);
            if (!member || member.token !== rate.token || member.commandGeneration !== generation)
                this.commandRates.delete(generation);
        }
    }
    retire(c, type) {
        if (c.closed)
            return;
        if (c.terminalTimer)
            clearTimeout(c.terminalTimer);
        this.send(c, type === 'kicked'
            ? { protocol: PROTOCOL, type, message: '你已离开或被移出这个房间，已停止自动重连。' }
            : { protocol: PROTOCOL, type });
        c.closed = true;
        c.revoked = true;
        if (this.conns.get(c.link.id) === c)
            this.conns.delete(c.link.id);
        if (this.seats.get(c.seat) === c)
            this.seats.delete(c.seat);
        // Keep the reliable data channel open just long enough to flush the notice.
        setTimeout(() => c.link.close(), 250);
    }
    closed(c) {
        if (c.closed)
            return;
        c.closed = true;
        if (c.terminalTimer)
            clearTimeout(c.terminalTimer);
        if (this.conns.get(c.link.id) === c)
            this.conns.delete(c.link.id);
        if (c.seat !== null && this.seats.get(c.seat) === c) {
            this.seats.delete(c.seat);
            void this.authority.setOnline(c.seat, false, c.token).catch(console.error);
        }
        try { c.link.close(); } catch { /* already closed */ }
    }
    sweep() {
        for (const c of this.conns.values()) {
            const expired = c.seat === null ? this.now() - c.acceptedAt >= HANDSHAKE_MS
                : this.now() - c.lastSeen > (c.visible ? 45000 : 120000);
            if (expired)
                this.closed(c);
        }
    }
    close() {
        this.off();
        for (const c of [...this.conns.values()])
            this.closed(c);
        this.commandRates.clear();
    }
}
exports.HostSession = HostSession;
