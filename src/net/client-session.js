"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientSession = void 0;
const { PROTOCOL, randomId } = require("../room/types.js");
const { parseClientMessage, parseServerMessage } = require("./protocol.js");
const RETRYABLE = new Set(['SAVE_ERROR', 'HOST_CHANGED', 'RATE_LIMIT', 'BUSY']);
function failure(message, code, id) { return Object.assign(new Error(message), { code, requestId: id }); }
class ClientSession {
    view = null;
    epoch = '';
    connected = false;
    replaced = false;
    kicked = false;
    disposed = false;
    error = '';
    seq = -1;
    link = null;
    listeners = new Set();
    waiters = new Map();
    offs = [];
    lastPong = 0;
    legacyArchive = [];
    legacyNotice = '';
    constructor(roomId, token, name, journal, now = Date.now, uid = randomId) {
        this.roomId = roomId;
        this.token = token;
        this.name = name;
        this.journal = journal;
        this.now = now;
        this.uid = uid;
        if (!Array.isArray(journal.pending))
            throw Error('本机待确认操作记录损坏，请保留站点数据以便检查。');
        const legacy = journal.pending.filter(m => !this.currentCommand(m));
        if (legacy.length && journal.archiveLegacy)
            journal.archiveLegacy(legacy);
        this.legacyArchive = structuredClone([...(journal.legacyPending ?? []), ...journal.pending.filter(m => !this.currentCommand(m))]);
        if (this.legacyPending.length)
            this.legacyNotice = `已保留 ${this.legacyPending.length} 条旧版或不完整的待确认操作，没有自动重发。请检查当前锁定状态和房间记录后再操作，原文保存在待确认归档。`;
    }
    currentCommand(m) {
        try { return parseClientMessage(m).type === 'command' && m.roomId === this.roomId; }
        catch { return false; }
    }
    get pendingCount() { return this.journal.pending.length; }
    get legacyPending() { return structuredClone(this.legacyArchive); }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    publish() {
        for (const fn of this.listeners) {
            try { fn(); }
            catch (e) { console.error('client listener', e); }
        }
    }
    attach(link) {
        if (this.disposed || this.kicked)
            throw Error('这个房间连接已结束，请返回首页后明确重新加入。');
        this.detach();
        this.link = link;
        this.connected = false;
        this.error = '';
        this.replaced = false;
        this.seq = -1;
        const sendPresence = () => {
            if (this.link !== link || !link.open)
                return;
            try {
                link.send({ protocol: PROTOCOL, type: 'presence', roomId: this.roomId,
                    visible: typeof document === 'undefined' || document.visibilityState === 'visible' });
            }
            catch { /* normal channel-close path handles failure */ }
        };
        const onVisibility = () => sendPresence();
        this.offs = [link.onMessage(raw => { if (this.link === link) this.receive(raw); }), link.onClose(() => {
            if (this.link !== link)
                return;
            this.connected = false;
            if (!this.kicked && !this.replaced && !this.disposed)
                this.error = '与房主的数据通道已断开。操作会在恢复后重新确认。';
            this.publish();
        }), () => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility); }];
        if (typeof document !== 'undefined')
            document.addEventListener('visibilitychange', onVisibility);
        link.send({ protocol: PROTOCOL, type: 'hello', roomId: this.roomId, token: this.token, name: this.name,
            resumeGeneration: this.view?.commandGeneration ?? null });
        this.lastPong = this.now();
        sendPresence();
    }
    finish(id, error) {
        const waiter = this.waiters.get(id);
        if (!waiter)
            return;
        this.waiters.delete(id);
        if (error) waiter.reject(error);
        else waiter.resolve();
    }
    terminal(kind, message) {
        this.kicked = kind === 'kicked';
        this.replaced = kind === 'replaced';
        this.connected = false;
        this.error = message;
        for (const id of [...this.waiters.keys()])
            this.finish(id, failure(message, kind.toUpperCase(), id));
        this.link?.close();
        this.publish();
    }
    receive(raw) {
        if (this.disposed || this.kicked || this.replaced)
            return;
        try {
            const m = parseServerMessage(raw);
            if (m.type === 'pong') {
                this.lastPong = this.now();
                return;
            }
            if (m.type === 'replaced') {
                this.terminal('replaced', '这个座位已在另一个标签页连接，请只保留一个页面。');
                return;
            }
            if (m.type === 'kicked') {
                this.terminal('kicked', m.message);
                return;
            }
            if (m.type === 'error') {
                if (m.code === 'KICKED') {
                    this.terminal('kicked', m.message);
                    return;
                }
                this.error = m.message;
                if (m.id && !RETRYABLE.has(m.code)) {
                    this.journal.save(this.journal.pending.filter(p => p.id !== m.id));
                    this.finish(m.id, failure(m.message, m.code, m.id));
                }
                if (m.code === 'HOST_CHANGED')
                    this.connected = false;
                this.publish();
                return;
            }
            if (m.type === 'ack') {
                const pending = this.journal.pending.find(p => p.id === m.id);
                if (!pending)
                    return;
                if (pending.generation !== m.generation || pending.commandSeq !== m.commandSeq)
                    throw Error('回执与待确认操作的身份或序号不一致。');
                // A failed local journal write is still retryable. Do not resolve
                // the UI promise until both the host ACK and local update succeed.
                this.journal.save(this.journal.pending.filter(p => p.id !== m.id));
                if (this.view?.commandGeneration === m.generation)
                    this.view = { ...this.view, nextCommandSeq: Math.max(this.view.nextCommandSeq, m.commandSeq + 1) };
                this.error = '';
                this.finish(m.id);
                this.publish();
                return;
            }
            if (m.view.id !== this.roomId)
                throw Error('收到另一房间的视图。');
            if (m.epoch !== this.epoch) {
                this.seq = -1;
                this.epoch = m.epoch;
            }
            if (m.seq <= this.seq)
                return;
            this.seq = m.seq;
            this.view = m.view;
            const first = !this.connected;
            this.connected = true;
            this.lastPong = this.now();
            if (first) {
                this.error = '';
                this.retry();
            }
            this.publish();
        }
        catch (e) {
            this.error = e instanceof Error ? e.message : '无效的房主消息';
            this.publish();
        }
    }
    submit(intent) {
        if (this.disposed || this.kicked || this.replaced || !this.connected || !this.view || !this.link?.open)
            throw Error('尚未与房主建立连接，请先重连。');
        if (this.journal.pending.length)
            throw Error('上一项操作尚未确认，请等待或重试原操作。');
        const m = { protocol: PROTOCOL, type: 'command', id: this.uid(), roomId: this.roomId,
            matchId: this.view.matchId, epoch: this.epoch, generation: this.view.commandGeneration,
            commandSeq: this.view.nextCommandSeq, intent };
        parseClientMessage(m);
        this.journal.save([m]); // Never send an input that was not journaled.
        const result = new Promise((resolve, reject) => this.waiters.set(m.id, { resolve, reject }));
        this.error = '';
        try { this.link.send(m); }
        catch (e) {
            this.error = e instanceof Error ? e.message : '发送失败，原操作会在重连后重试。';
            this.connected = false;
            this.link?.close();
        }
        this.publish();
        return result;
    }
    retry() {
        if (!this.connected || !this.link?.open)
            return;
        for (const m of this.journal.pending) {
            if (this.currentCommand(m))
                this.link.send({ ...m, epoch: this.epoch });
        }
    }
    heartbeat() {
        if (!this.link?.open || this.kicked || this.replaced || this.disposed)
            return;
        const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
        if (this.now() - this.lastPong > (hidden ? 120000 : 35000)) {
            this.link.close();
            return;
        }
        this.link.send({ protocol: PROTOCOL, type: 'ping', sent: this.now() });
        if (this.journal.pending.length)
            this.retry();
    }
    detach() {
        for (const off of this.offs) off();
        this.offs = [];
        this.link?.close();
        this.link = null;
        this.connected = false;
    }
    close() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const id of [...this.waiters.keys()])
            this.finish(id, Object.assign(failure('已离开房间。未确认操作仍保存在本机，请重连原房间后核对。', 'CANCELLED', id), { name: 'AbortError' }));
        this.detach();
    }
}
exports.ClientSession = ClientSession;
