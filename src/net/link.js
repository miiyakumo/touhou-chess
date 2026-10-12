"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryLink = void 0;
exports.memoryPair = memoryPair;
class MemoryLink {
    id;
    open = true;
    peer = null;
    messages = new Set();
    closes = new Set();
    constructor(id) {
        this.id = id;
    }
    send(x) {
        if (!this.open || !this.peer?.open)
            throw Error('Channel closed');
        const target = this.peer, data = structuredClone(x);
        queueMicrotask(() => { if (target.open)
            for (const fn of target.messages)
                fn(data); });
    }
    close() {
        if (!this.open)
            return;
        this.open = false;
        for (const fn of this.closes)
            fn();
        if (this.peer?.open)
            this.peer.close();
    }
    onMessage(fn) { this.messages.add(fn); return () => this.messages.delete(fn); }
    onClose(fn) { this.closes.add(fn); return () => this.closes.delete(fn); }
}
exports.MemoryLink = MemoryLink;
function memoryPair(id) {
    const a = new MemoryLink(id + '-a'), b = new MemoryLink(id + '-b');
    a.peer = b;
    b.peer = a;
    return [a, b];
}

