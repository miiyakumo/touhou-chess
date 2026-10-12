"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicPhase = publicPhase;
exports.projectView = projectView;
const model_js_1 = require("./model.js");
const engine_js_1 = require("./engine.js");
function publicPhase(s) {
    if (s.step === 'ended')
        return '终局';
    if (s.step === 'announce')
        return '夜间公告';
    if (s.step.startsWith('day.'))
        return '白天';
    if (s.step.startsWith('sunset.'))
        return '日落';
    if (s.step.startsWith('midnight.'))
        return '午夜';
    return '子夜';
}
/** Allow-list projection: do not spread host objects then try deleting secrets. */
function projectView(s, seat) {
    const p = (0, model_js_1.player)(s, seat);
    const raw = (0, engine_js_1.promptFor)(s, seat);
    const action = raw ? structuredClone(raw) : null;
    // Do not publish the exact real-alive set before the public announcement.
    // The host rejects a secretly invalid target privately; see web adaptation note W3.
    if (action && action.targetCount > 0 && s.step !== 'setup.vampire'
        && !(s.vote && s.vote.round === 2)) {
        action.candidates = s.players.filter(q => q.publicAlive).map(q => q.seat);
    }
    const submitted = s.vote && Object.hasOwn(s.vote.ballots, String(seat));
    return {
        roomId: s.roomId, day: s.day, phase: publicPhase(s),
        seats: s.players.map(q => ({ seat: q.seat, name: q.name,
            alive: s.outcome ? q.alive : q.publicAlive, role: s.outcome || q.revealed ? q.role : null })),
        self: { seat, role: p.role, alive: p.alive, notes: [...p.notes] },
        action, actionStepSerial: action ? s.stepSerial : null,
        ownVote: submitted ? { target: s.vote.ballots[String(seat)] } : null,
        publicLog: [...s.publicLog], outcome: s.outcome ? structuredClone(s.outcome) : null,
    };
}

