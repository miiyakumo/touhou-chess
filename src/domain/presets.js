"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESETS = exports.SIZES = void 0;
exports.preset = preset;
exports.validateDeck = validateDeck;
const model_js_1 = require("./model.js");
exports.SIZES = [6, 8, 10, 12];
exports.PRESETS = {
    6: { size: 6, humans: 2, fairies: 1, youkai: 2, akyuu: false, inspect: 1 },
    8: { size: 8, humans: 3, fairies: 2, youkai: 2, akyuu: true, inspect: 2 },
    10: { size: 10, humans: 4, fairies: 2, youkai: 3, akyuu: true, inspect: 2 },
    12: { size: 12, humans: 5, fairies: 3, youkai: 3, akyuu: true, inspect: 3 },
};
function preset(size = 12) {
    (0, model_js_1.requireRule)(exports.SIZES.includes(size), 'SIZE', '请选择 6、8、10 或 12 人。');
    return exports.PRESETS[size];
}
function validateDeck(deck, size = deck.length) {
    const p = preset(size), count = (r) => deck.filter(x => x === r).length;
    (0, model_js_1.requireRule)(deck.length === size && deck.every(r => Object.hasOwn(model_js_1.ROLE_NAMES, r)), 'DECK', '身份数量或名称无效。');
    (0, model_js_1.requireRule)(deck.filter(r => (0, model_js_1.faction)(r) === 'god').length === 1 && count('reimu') === 1
        && count('akyuu') === (p.akyuu ? 1 : 0) && count('human') === p.humans - 1 - (p.akyuu ? 1 : 0)
        && count('fairy') === p.fairies && deck.filter(r => (0, model_js_1.faction)(r) === 'youkai').length === p.youkai
        && model_js_1.YOUKAI.every(r => count(r) <= 1), 'DECK', '身份配置不符合所选人数。');
}

