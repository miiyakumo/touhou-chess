"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGame = createGame;
exports.nearestHumans = nearestHumans;
exports.kidnapVoters = kidnapVoters;
exports.promptFor = promptFor;
exports.pendingActors = pendingActors;
exports.evaluateOutcome = evaluateOutcome;
exports.canHostAdvance = canHostAdvance;
exports.applyCommand = applyCommand;
const presets_js_1 = require("./presets.js");
const model_js_1 = require("./model.js");
/** RNG is used only at creation. Replays apply recorded commands to the saved initial state. */
function random(seed) {
    let n = seed >>> 0 || 0x9e3779b9;
    return () => { n ^= n << 13; n ^= n >>> 17; n ^= n << 5; return (n >>> 0) / 4294967296; };
}
function shuffled(items, rng) {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function createGame(options) {
    (0, model_js_1.requireRule)(Number.isInteger(options.seed), 'SEED', '种子须为整数。');
    const rng = random(options.seed), p = (0, presets_js_1.preset)(options.size ?? options.roles?.length ?? 12);
    const deck = options.roles ? [...options.roles] : shuffled([
        shuffled(model_js_1.GODS, rng)[0], 'reimu', ...(p.akyuu ? ['akyuu'] : []),
        ...Array(p.humans - 1 - (p.akyuu ? 1 : 0)).fill('human'),
        ...Array(p.fairies).fill('fairy'), ...shuffled(model_js_1.YOUKAI, rng).slice(0, p.youkai),
    ], rng);
    (0, presets_js_1.validateDeck)(deck, p.size);
    const s = {
        schemaVersion: 1, rulesVersion: '1.0', roomId: options.roomId ?? `lab-${options.seed >>> 0}`, seed: options.seed,
        version: 0, day: 1, step: 'setup.god', stepSerial: 1,
        players: deck.map((role, i) => ({ seat: i + 1, name: options.names?.[i]?.trim().slice(0, 24) || `${i + 1} 号`,
            role, alive: true, publicAlive: true, revealed: false, oniSpent: false, vampireSpent: false,
            kappaSpent: false, substitute: null, notes: [] })),
        acknowledgements: [], vote: null, protection: null, pendingDeaths: [], lastWords: null,
        publicLog: ['对局开始。身份已秘密分配。'], audit: [], outcome: null, receipts: {},
    };
    s.audit.push('按固定配置生成身份；神明随机结果已提交，不因恢复重新抽取。');
    return s;
}
function log(s, text) { s.publicLog.push(`第 ${s.day} 天 · ${text}`); }
function note(s, seat, text) { (0, model_js_1.player)(s, seat).notes.push(`第 ${s.day} 天 · ${text}`); }
function livingRole(s, role) { return s.players.find(p => p.alive && p.role === role); }
function nearestHumans(s, seat) {
    const n = s.players.length;
    const scan = (delta) => {
        for (let d = 1; d < n; d++) {
            const x = ((seat - 1 + delta * d) % n + n) % n + 1;
            if ((0, model_js_1.player)(s, x).alive && (0, model_js_1.player)(s, x).role === 'human')
                return x;
        }
        throw new Error('Invalid setup: no ordinary human.');
    };
    return [...new Set([scan(-1), scan(1)])];
}
function kidnapVoters(s) {
    return s.players.filter(p => p.alive && (p.role === 'take-god'
        || ((0, model_js_1.faction)(p.role) === 'youkai' && (p.role !== 'tsukumogami'
            || s.players.some(q => q.seat !== p.seat && (0, model_js_1.faction)(q.role) === 'youkai' && !q.alive))))).map(p => p.seat);
}
function enter(s, step) {
    s.step = step;
    s.stepSerial++;
    s.acknowledgements = [];
    s.vote = null;
    s.lastWords = null;
    if (step === 'setup.fairies') {
        const fairies = s.players.filter(p => p.role === 'fairy');
        for (const p of fairies)
            note(s, p.seat, `妖精互认：${fairies.map(q => q.seat + ' 号').join('、')}。`);
    }
    if (step === 'setup.vampire') {
        const p = livingRole(s, 'vampire');
        if (p)
            note(s, p.seat, `左、右最近的普通人类分别为 ${nearestHumans(s, p.seat).join('、')} 号。`);
    }
    if (step === 'day.discuss')
        log(s, '进入白天讨论。');
    if (step === 'day.vote' || step === 'midnight.vote') {
        const kind = step === 'day.vote' ? 'exile' : 'kidnap';
        s.vote = { kind, round: 1, eligible: kind === 'exile' ? (0, model_js_1.aliveSeats)(s) : kidnapVoters(s), candidates: (0, model_js_1.aliveSeats)(s), ballots: {} };
        if (kind === 'kidnap')
            for (const seat of s.vote.eligible)
                note(s, seat, `本次共同睁眼的绑架参与者：${s.vote.eligible.map(x => x + ' 号').join('、')}。不代表全部都是妖怪。`);
    }
}
function promptFor(s, seat) {
    const p = (0, model_js_1.player)(s, seat);
    if (!p.alive || s.outcome)
        return null;
    const ack = (title) => ({ kind: 'ack', title, candidates: [], targetCount: 0, canPass: false, canAbstain: false });
    const skill = (title, count, canPass, candidates = (0, model_js_1.aliveSeats)(s)) => ({ kind: 'skill', title, candidates, targetCount: count, canPass, canAbstain: false });
    switch (s.step) {
        case 'setup.god': return (0, model_js_1.faction)(p.role) === 'god' ? ack('确认抽取的神明身份') : null;
        case 'setup.fairies': return p.role === 'fairy' && !s.acknowledgements.includes(seat) ? ack('确认妖精同伴') : null;
        case 'setup.vampire': return p.role === 'vampire' ? skill('指定固定替身（必须选择）', 1, false, nearestHumans(s, seat)) : null;
        case 'dawn.kappa': return p.role === 'kappa' && !p.kappaSpent ? skill('选择当日保护目标', 1, true) : null;
        case 'sunset.human':
            if (s.day === 1 && p.role === 'akyuu')
                return skill(`查验 ${(0, presets_js_1.preset)(s.players.length).inspect} 名不同玩家`, (0, presets_js_1.preset)(s.players.length).inspect, true);
            if (s.day >= 2 && p.role === 'reimu')
                return skill('选择退治目标', 1, true);
            return null;
        case 'sunset.tengu': return p.role === 'tengu' ? skill('查验一名玩家', 1, true) : null;
        case 'day.vote':
        case 'midnight.vote': {
            const v = s.vote;
            if (!v.eligible.includes(seat) || (0, model_js_1.hasBallot)(v, seat))
                return null;
            return { kind: 'vote', title: `${v.kind === 'exile' ? '驱逐' : '绑架'}投票 · 第 ${v.round} 轮`,
                candidates: [...v.candidates], targetCount: 1, canPass: false, canAbstain: !(v.kind === 'kidnap' && p.role === 'eater') };
        }
        default: return null;
    }
}
function pendingActors(s) { return s.players.filter(p => promptFor(s, p.seat)).map(p => p.seat); }
/** Public outcomes are checked only after an entire action, never inside an exit chain. */
function evaluateOutcome(s, fairyVoteAchieved = false) {
    const c = { human: 0, fairy: 0, god: 0, youkai: 0 };
    for (const p of s.players)
        if (p.alive)
            c[(0, model_js_1.faction)(p.role)]++;
    const winners = [];
    if (c.god > 0 && c.human > c.god + c.fairy + c.youkai)
        winners.push('god');
    if (c.human > 0 && c.youkai === 0)
        winners.push('human');
    if (fairyVoteAchieved || (c.human === 0 && c.fairy > c.god + c.youkai))
        winners.push('fairy');
    if (c.human > 0 && c.youkai > 0 && c.god === 0 && c.fairy === 0)
        winners.push('youkai');
    if (winners.length)
        return { winners, reason: 'conditions' };
    return c.human === 0 ? { winners: [], reason: 'no-winner' } : null;
}
function finishIfWon(s, fairyVote = false) {
    const outcome = evaluateOutcome(s, fairyVote);
    if (!outcome)
        return false;
    s.outcome = outcome;
    enter(s, 'ended');
    for (const p of s.players)
        p.publicAlive = p.alive;
    s.pendingDeaths = [];
    log(s, outcome.winners.length ? `${outcome.winners.map(f => model_js_1.FACTION_NAMES[f]).join('、')}阵营共同获胜。` : '本局无赢家。');
    return true;
}
function reflected(s, actor, target) {
    return actor !== target && (0, model_js_1.player)(s, target).role === 'curse-god' ? actor : target;
}
function inspectedRole(p) {
    return p.role === 'many-gods' ? 'human' : p.role === 'tsukumogami' ? 'fairy' : p.role;
}
function protectedFrom(s, target, cause) {
    const pr = s.protection;
    if (cause === 'exile' || !pr || pr.target !== target || s.day >= pr.expiresDay)
        return false;
    (0, model_js_1.player)(s, pr.source).kappaSpent = true;
    s.audit.push(`保护阻止 ${target} 号的 ${cause}；河童后续施法资格消耗，当日保护保留。`);
    return true;
}
function reveal(s, p) {
    if (!p.revealed) {
        p.revealed = true;
        log(s, `${p.seat} 号翻牌：${model_js_1.ROLE_NAMES[p.role]}。`);
    }
}
function eliminate(s, p, cause) {
    p.alive = false;
    note(s, p.seat, '你已实际出局。公告尚未发布也不得再行动；请勿泄露夜间信息。');
    if (cause === 'exile') {
        p.publicAlive = false;
        log(s, `${p.seat} 号被驱逐出局。`);
    }
    else
        s.pendingDeaths.push(p.seat);
    s.audit.push(`${p.seat} 号实际出局，方式=${cause}。`);
    return p.seat;
}
function attemptExit(s, target, cause) {
    const p = (0, model_js_1.player)(s, target);
    (0, model_js_1.requireRule)(p.alive, 'DEAD_TARGET', '目标已经实际出局。');
    if (protectedFrom(s, target, cause))
        return null;
    if (p.role === 'oni' && cause === 'exile' && !p.oniSpent) {
        p.oniSpent = true;
        reveal(s, p);
        log(s, `${p.seat} 号免除本次驱逐。`);
        return null;
    }
    if (p.role === 'vampire' && !p.vampireSpent && p.substitute !== null) {
        const sub = (0, model_js_1.player)(s, p.substitute);
        if (sub.alive && !protectedFrom(s, sub.seat, cause)) {
            const eliminated = eliminate(s, sub, cause);
            p.vampireSpent = true;
            reveal(s, p);
            return eliminated;
        }
    }
    return eliminate(s, p, cause);
}
function afterSkill(s) {
    switch (s.step) {
        case 'setup.god':
            enter(s, 'setup.fairies');
            break;
        case 'setup.fairies':
            enter(s, 'setup.vampire');
            break;
        case 'setup.vampire':
        case 'dawn.kappa':
            enter(s, 'announce');
            break;
        case 'sunset.human':
            enter(s, 'sunset.tengu');
            break;
        case 'sunset.tengu':
            enter(s, 'midnight.vote');
            break;
        default: throw new Error('Not a skill step.');
    }
}
function afterVote(s, kind, eliminated) {
    if (kind === 'exile') {
        if (eliminated !== null) {
            enter(s, 'day.lastWords');
            s.lastWords = eliminated;
            log(s, `${eliminated} 号可作一次遗言。`);
        }
        else
            enter(s, 'sunset.human');
    }
    else {
        s.day++;
        s.protection = null;
        enter(s, 'dawn.kappa');
    }
}
function resolveVote(s) {
    const v = s.vote;
    (0, model_js_1.requireRule)(v && v.eligible.every(id => (0, model_js_1.hasBallot)(v, id)), 'MISSING_BALLOTS', '仍有玩家未提交选票；不能默认为弃票。');
    // Integer half-vote units: ordinary=2, Take god's kidnap vote=1.
    const votes = new Map();
    const fairies = s.players.filter(p => p.alive && p.role === 'fairy');
    const god = livingRole(s, 'backdoor-god');
    for (const seat of v.eligible) {
        let target = v.ballots[String(seat)];
        if (v.kind === 'exile' && fairies.length === 1 && fairies[0].seat === seat && god)
            target = v.ballots[String(god.seat)];
        if (target !== null)
            votes.set(target, (votes.get(target) ?? 0) + (v.kind === 'kidnap' && (0, model_js_1.player)(s, seat).role === 'take-god' ? 1 : 2));
    }
    const max = Math.max(0, ...votes.values());
    const top = [...votes].filter(([, n]) => n === max && n > 0).map(([seat]) => seat).sort((a, b) => a - b);
    const fairyWin = v.kind === 'exile' && fairies.length === 1 && top.includes(fairies[0].seat);
    if (v.kind === 'exile') {
        log(s, `第 ${v.round} 轮原始选票：${v.eligible.map(id => `${id}→${v.ballots[String(id)] ?? '弃票'}`).join('，')}。`);
        log(s, `有效票：${[...votes].sort(([a], [b]) => a - b).map(([id, n]) => `${id} 号 ${n / 2} 票`).join('，') || '全体为零'}。`);
    }
    const eliminated = top.length === 1 ? attemptExit(s, top[0], v.kind) : null;
    if (finishIfWon(s, fairyWin))
        return;
    if (top.length > 1 && v.round === 1) {
        const kind = v.kind;
        const eligible = [...v.eligible];
        // Same step kind, NEW token: late submissions from round 1 cannot enter round 2.
        s.stepSerial++;
        s.vote = { kind, round: 2, eligible, candidates: top, ballots: {} };
        const text = `平票，仅在 ${top.join('、')} 号中重投一次。`;
        if (kind === 'exile')
            log(s, text);
        else
            for (const seat of eligible)
                note(s, seat, text);
        return;
    }
    if (top.length !== 1 && v.kind === 'exile')
        log(s, '本日不执行驱逐。');
    afterVote(s, v.kind, eliminated);
}
function canHostAdvance(s) {
    if (s.outcome || s.vote)
        return false;
    return ['announce', 'day.discuss', 'day.lastWords'].includes(s.step) || pendingActors(s).length === 0;
}
function advance(s) {
    (0, model_js_1.requireRule)(canHostAdvance(s), 'PENDING_ACTION', '还有必须处理的行动，不能跳过。');
    if (s.step === 'announce') {
        const seats = [...s.pendingDeaths].sort((a, b) => a - b);
        for (const id of seats)
            (0, model_js_1.player)(s, id).publicAlive = false;
        log(s, seats.length ? `夜间出局名单：${seats.join('、')} 号。` : '夜间没有需要公布的出局。');
        s.pendingDeaths = [];
        enter(s, 'day.discuss');
    }
    else if (s.step === 'day.discuss')
        enter(s, 'day.vote');
    else if (s.step === 'day.lastWords')
        enter(s, 'sunset.human');
    else
        afterSkill(s);
}
function validateShape(raw) {
    (0, model_js_1.requireRule)(raw !== null && typeof raw === 'object', 'BAD_COMMAND', '指令必须为对象。');
    const x = raw;
    (0, model_js_1.requireRule)(typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 128
        && Number.isInteger(x.stepSerial) && (x.actor === 'host' || (Number.isInteger(x.actor) && Number(x.actor) >= 1 && Number(x.actor) <= 12))
        && typeof x.kind === 'string' && ['ack', 'pass', 'advance', 'resolve', 'skill', 'vote'].includes(x.kind), 'BAD_COMMAND', '指令字段无效。');
    if (x.kind === 'skill')
        (0, model_js_1.requireRule)(Array.isArray(x.targets) && x.targets.length <= 3 && x.targets.every(Number.isInteger), 'BAD_COMMAND', '技能目标无效。');
    if (x.kind === 'vote')
        (0, model_js_1.requireRule)(x.target === null || Number.isInteger(x.target), 'BAD_COMMAND', '选票目标无效。');
}
function fingerprint(c) {
    return JSON.stringify([c.actor, c.kind, c.stepSerial, c.kind === 'skill' ? c.targets : c.kind === 'vote' ? c.target : null]);
}
/** Pure, deterministic transition. Throws RuleError without mutating the input. */
function applyCommand(input, raw) {
    validateShape(raw);
    const c = raw;
    const key = `${c.actor}:${c.id}`, fp = fingerprint(c), old = input.receipts[key];
    if (old) {
        (0, model_js_1.requireRule)(old.fingerprint === fp, 'ID_REUSE', '同一操作编号不能对应不同内容。');
        return input;
    }
    (0, model_js_1.requireRule)(!input.outcome, 'GAME_ENDED', '对局已经结束。');
    (0, model_js_1.requireRule)(c.stepSerial === input.stepSerial, 'STALE_STEP', '操作属于旧阶段，请刷新当前视图。');
    const s = structuredClone(input);
    if (c.actor === 'host') {
        if (c.kind === 'advance')
            advance(s);
        else if (c.kind === 'resolve')
            resolveVote(s);
        else
            (0, model_js_1.requireRule)(false, 'HOST_COMMAND', '裁判只能推进流程或结算投票，不能代替玩家选择技能。');
    }
    else {
        const action = promptFor(s, c.actor);
        (0, model_js_1.requireRule)(action, 'NO_ACTION', '你当前没有可执行的行动。');
        if (c.kind === 'pass') {
            (0, model_js_1.requireRule)(action.canPass, 'CANNOT_PASS', '此行动不能放弃。');
            afterSkill(s);
        }
        else if (c.kind === 'ack') {
            (0, model_js_1.requireRule)(action.kind === 'ack', 'WRONG_ACTION', '当前不能执行确认。');
            s.acknowledgements.push(c.actor);
            if (s.step !== 'setup.fairies' || pendingActors(s).length === 0)
                afterSkill(s);
        }
        else if (c.kind === 'vote') {
            (0, model_js_1.requireRule)(action.kind === 'vote', 'WRONG_ACTION', '当前不能投票。');
            (0, model_js_1.requireRule)(c.target === null ? action.canAbstain : action.candidates.includes(c.target), 'ILLEGAL_VOTE', '不能弃票或目标不属于本轮候选者。');
            s.vote.ballots[String(c.actor)] = c.target;
        }
        else if (c.kind === 'skill') {
            (0, model_js_1.requireRule)(action.kind === 'skill' && c.targets.length === action.targetCount && new Set(c.targets).size === c.targets.length
                && c.targets.every(id => action.candidates.includes(id)), 'ILLEGAL_TARGET', '目标数量、去重或存活条件不合法。');
            const p = (0, model_js_1.player)(s, c.actor);
            if (s.step === 'setup.vampire') {
                p.substitute = c.targets[0];
                note(s, p.seat, `固定替身已指定为 ${p.substitute} 号。`);
            }
            else if (s.step === 'dawn.kappa') {
                const target = reflected(s, p.seat, c.targets[0]);
                s.protection = { source: p.seat, target, expiresDay: s.day + 1 };
                note(s, p.seat, '保护技能已结算。');
            }
            else if (p.role === 'reimu')
                attemptExit(s, reflected(s, p.seat, c.targets[0]), 'exorcism');
            else
                for (const target of c.targets) {
                    const actual = reflected(s, p.seat, target);
                    note(s, p.seat, `查验 ${target} 号：${model_js_1.ROLE_NAMES[inspectedRole((0, model_js_1.player)(s, actual))]}。`);
                }
            if (!finishIfWon(s))
                afterSkill(s);
        }
        else
            (0, model_js_1.requireRule)(false, 'PLAYER_COMMAND', '玩家不能发送裁判指令。');
    }
    s.version = input.version + 1;
    s.receipts[key] = { fingerprint: fp, committedVersion: s.version };
    return s;
}

