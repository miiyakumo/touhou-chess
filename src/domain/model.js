"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuleError = exports.FACTION_NAMES = exports.ROLE_NAMES = exports.YOUKAI = exports.GODS = void 0;
exports.faction = faction;
exports.requireRule = requireRule;
exports.player = player;
exports.aliveSeats = aliveSeats;
exports.hasBallot = hasBallot;
/** These are authoritative host types. Never serialize GameState to a player. */
exports.GODS = ['many-gods', 'curse-god', 'take-god', 'backdoor-god'];
exports.YOUKAI = ['eater', 'vampire', 'tengu', 'tsukumogami', 'oni', 'kappa'];
exports.ROLE_NAMES = {
    'many-gods': '八百万之神', 'curse-god': '贫乏与疫病神', 'take-god': '建御名方神',
    'backdoor-god': '后户秘神', akyuu: '御阿礼之子', reimu: '博丽的巫女', human: '普通人类',
    fairy: '妖精', eater: '食人妖怪', vampire: '吸血鬼', tengu: '天狗', tsukumogami: '付丧神',
    oni: '鬼', kappa: '河童',
};
exports.FACTION_NAMES = { god: '神明', human: '人类', fairy: '妖精', youkai: '妖怪' };
function faction(role) {
    if (exports.GODS.includes(role))
        return 'god';
    if (exports.YOUKAI.includes(role))
        return 'youkai';
    return role === 'fairy' ? 'fairy' : 'human';
}
class RuleError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'RuleError';
    }
}
exports.RuleError = RuleError;
function requireRule(condition, code, message) {
    if (!condition)
        throw new RuleError(code, message);
}
function player(s, seat) {
    const p = s.players.find(p => p.seat === seat);
    requireRule(p, 'UNKNOWN_SEAT', '不存在这个座位。');
    return p;
}
function aliveSeats(s) { return s.players.filter(p => p.alive).map(p => p.seat); }
function hasBallot(v, seat) { return Object.hasOwn(v.ballots, String(seat)); }

