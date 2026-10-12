"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_VERSION = exports.PROTOCOL = void 0;
exports.randomId = randomId;
exports.randomSeed = randomSeed;
exports.PROTOCOL = 'renleisha/3';
exports.APP_VERSION = '0.4.1';
function randomId() {
    if (!globalThis.crypto?.getRandomValues)
        throw new Error('当前浏览器不支持安全随机数，请使用现代浏览器。');
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}
function randomSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }

