"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRoom = validateRoom;
exports.openRoomStore = openRoomStore;
exports.acquireHostLock = acquireHostLock;
const model_js_1 = require("../domain/model.js");
const presets_js_1 = require("../domain/presets.js");
/** Only reads snapshots created by this app. No untrusted/imported save can execute code. */
function validateRoom(raw) {
    if (!raw || typeof raw !== 'object')
        throw Error('房间存档无效。');
    const s = raw;
    const size = s.size ?? 12;
    (0, presets_js_1.preset)(size);
    if (![2, 3].includes(s.schema) || s.rules !== '1.0')
        throw Error('存档版本不兼容。旧实验台存档不自动升级。');
    if (!/^[a-f0-9]{32}$/.test(s.id) || !Array.isArray(s.members) || s.members.length < 1 || s.members.length > size
        || !['lobby', 'playing', 'ended', 'aborted'].includes(s.status) || s.schema === 2 && !s.receipts)
        throw Error('存档结构不完整。');
    const seats = s.members.map(m => m.seat), tokens = s.members.map(m => m.token);
    if (new Set(seats).size !== seats.length || new Set(tokens).size !== tokens.length || !seats.includes(1)
        || s.members.some(m => !Number.isInteger(m.seat) || m.seat < 1 || m.seat > size || typeof m.name !== 'string'
            || !/^[a-f0-9]{32}$/.test(m.token) || typeof m.ready !== 'boolean'))
        throw Error('存档座位无效。');
    if (s.schema === 3) {
        if (s.members.some(m => !/^[a-f0-9]{32}$/.test(m.commandGeneration)
            || !Number.isSafeInteger(m.commandSeq) || m.commandSeq < 0 || m.commandSeq >= Number.MAX_SAFE_INTEGER
            || (m.commandSeq === 0 ? m.lastReceipt !== null : !m.lastReceipt
                || m.lastReceipt.commandSeq !== m.commandSeq || typeof m.lastReceipt.id !== 'string'
                || !m.lastReceipt.id.length || m.lastReceipt.id.length > 96
                || typeof m.lastReceipt.fingerprint !== 'string' || m.lastReceipt.fingerprint.length > 16000))
            || new Set(s.members.map(m => m.commandGeneration)).size !== s.members.length)
            throw Error('存档操作序号或成员身份损坏。');
    }
    if (s.status !== 'lobby') {
        const g = s.game;
        if (!g || !Array.isArray(g.players) || g.players.length !== size || !g.players.every(p => Object.hasOwn(model_js_1.ROLE_NAMES, p.role))
            || !Number.isInteger(g.stepSerial) || !g.receipts || !Array.isArray(g.publicLog))
            throw Error('对局存档损坏。');
        (0, presets_js_1.validateDeck)(g.players.map(p => p.role), size);
        if (s.status === 'playing' && (!s.gate || s.gate.serial !== g.stepSerial))
            throw Error('存档行动阶段不一致。');
    }
    return s;
}
async function openRoomStore(key = 'current') {
    if (!globalThis.indexedDB)
        throw Error('此环境无法使用本地存档。本地文件存档被浏览器限制，可尝试其他浏览器或 HTTPS 页面。');
    const db = await new Promise((res, rej) => {
        const req = indexedDB.open('renleisha-rooms-v4', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('rooms');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(Error('存档被另一个窗口占用，请关闭旧页面。'));
    });
    db.onversionchange = () => db.close();
    function write(value) {
        return new Promise((res, rej) => {
            const tx = db.transaction('rooms', 'readwrite');
            if (value)
                tx.objectStore('rooms').put(value, key);
            else
                tx.objectStore('rooms').delete(key);
            tx.oncomplete = () => res();
            tx.onabort = () => rej(tx.error ?? Error('本地保存失败。此操作未确认，请勿刷新。'));
            tx.onerror = () => rej(tx.error ?? Error('本地保存失败。请检查磁盘或隐私模式。'));
        });
    }
    return { save: write, clear: () => write(null), async load() {
            const raw = await new Promise((res, rej) => {
                const tx = db.transaction('rooms', 'readonly'), req = tx.objectStore('rooms').get(key);
                req.onsuccess = () => res(req.result);
                req.onerror = () => rej(req.error);
            });
            return raw === undefined ? null : validateRoom(raw);
        } };
}
/** Lock must outlive async callbacks and cannot be silently bypassed on unsupported browsers. */
async function acquireHostLock(key) {
    if (!navigator.locks)
        throw Error('此浏览器无法取得房主写锁。当前浏览器限制了本地文件写锁，请尝试现代桌面浏览器或 HTTPS 页面。');
    let release;
    const held = new Promise(r => { release = r; });
    await new Promise((res, rej) => {
        void navigator.locks.request('renleisha-v4-host-' + key, { ifAvailable: true }, async (lock) => {
            if (!lock) {
                rej(Error('另一个标签页已在主持此房间，请先关闭它。'));
                return;
            }
            res();
            await held;
        }).catch(rej);
    });
    return release;
}

