"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryRoomStore = exports.RoomAuthority = void 0;
exports.cleanName = cleanName;
const presets_js_1 = require("../domain/presets.js");
const engine_js_1 = require("../domain/engine.js");
const view_js_1 = require("../domain/view.js");
const model_js_1 = require("../domain/model.js");
const types_js_1 = require("./types.js");
/** Single writer for BOTH membership and game state. A room transaction is one durable snapshot.
 * Network connections and liveness are deliberately NOT restored from disk.
 * Private actions are queued in a fixed minimum-duration slot; next-role prompts are never sent early.
 */
class RoomAuthority {
    store;
    options;
    data;
    online = new Set();
    queue = Promise.resolve();
    queued = 0;
    listeners = new Set();
    now;
    uid;
    seed;
    constructor(data, store, options = {}) {
        this.store = store;
        this.options = options;
        this.data = structuredClone(data);
        this.now = options.now ?? Date.now;
        this.uid = options.randomId ?? types_js_1.randomId;
        this.seed = options.seed ?? types_js_1.randomSeed;
        this.data.size ??= 12;
        this.data.muted ??= [];
        this.data.chat ??= [];
        // v3 retires the old wire protocol. An old ID can never be relabelled as
        // a new v3 command, so legacy unbounded receipts can be safely dropped.
        if (this.data.schema === 2) {
            for (const member of this.data.members) {
                member.commandGeneration = this.uid();
                member.commandSeq = 0;
                member.lastReceipt = null;
            }
            this.data.schema = 3;
        }
        delete this.data.receipts;
        this.data.muted = this.data.muted.filter(seat => this.data.members.some(m => m.seat === seat));
        this.online.add(1);
    }
    static fresh(name, token, demo = false, id = (0, types_js_1.randomId)(), now = Date.now(), size = 12) {
        (0, presets_js_1.preset)(size);
        return { size, muted: [], chat: [], schema: 3, rules: '1.0', id, hostPeer: 'rls-' + id, matchId: '', createdAt: now,
            updatedAt: now, demo, members: [{ seat: 1, name: cleanName(name), token, ready: false,
                commandGeneration: (0, types_js_1.randomId)(), commandSeq: 0, lastReceipt: null }],
            status: 'lobby', game: null, gate: null, paused: false, pauseReason: '', slotMs: demo ? 900 : 6000 };
    }
    async flush() { await this.queue; }
    snapshot() { return structuredClone(this.data); }
    get roomId() { return this.data.id; }
    member(seat) { return this.data.members.find(m => m.seat === seat); }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    publish() { for (const fn of this.listeners) {
        try {
            fn();
        }
        catch (e) {
            console.error('view listener', e);
        }
    } }
    enqueue(fn) {
        if (this.queued >= (this.options.maxPending ?? 64))
            return Promise.reject(new model_js_1.RuleError('BUSY', '房主正在保存其他操作，请稍后重试原操作。'));
        this.queued++;
        const run = this.queue.then(fn).finally(() => { this.queued--; });
        this.queue = run.then(() => { }, () => { });
        return run;
    }
    async commit(s) {
        s.updatedAt = this.now();
        await this.store.save(s);
        for (const seat of this.online) {
            if (this.member(seat)?.token !== s.members.find(m => m.seat === seat)?.token)
                this.online.delete(seat);
        }
        this.data = s;
        this.publish();
    }
    async setPeerId(peerId) {
        return this.enqueue(async () => { const s = this.snapshot(); s.hostPeer = peerId; await this.commit(s); });
    }
    async restore() {
        return this.enqueue(async () => {
            const s = this.snapshot();
            if (s.status === 'playing')
                this.pauseState(s, '房主已恢复存档。等待所有玩家重新连接，再由房主继续。');
            await this.commit(s);
        });
    }
    pauseState(s, reason) {
        if (!s.paused && s.gate)
            s.gate.remainingMs = Math.max(0, s.gate.releaseAt - this.now());
        s.paused = true;
        s.pauseReason = reason;
    }
    async setOnline(seat, value, expectedToken) {
        const token = expectedToken ?? this.member(seat)?.token;
        // Loss of liveness must block new game actions even if persistence is
        // currently saturated. A later occupant must not inherit this close.
        if (!value && this.member(seat)?.token === token)
            this.online.delete(seat);
        return this.enqueue(async () => {
            if (!token || this.member(seat)?.token !== token)
                return;
            if (value)
                this.online.add(seat);
            else
                this.online.delete(seat);
            if (!value && this.data.status === 'playing') {
                const s = this.snapshot();
                this.pauseState(s, `${seat} 号连接中断。已提交操作保留，请等待重连。`);
                await this.commit(s);
            }
            else
                this.publish();
        });
    }
    async join(name, token, resumeGeneration = null) {
        return this.enqueue(async () => {
            (0, model_js_1.requireRule)(/^[a-f0-9]{32}$/.test(token), 'BAD_TOKEN', '座位凭证无效。');
            const old = this.data.members.find(p => p.token === token);
            // A reconnect must recover the same membership. A missing terminal
            // notice must never turn recovery into an implicit fresh join.
            (0, model_js_1.requireRule)(resumeGeneration === null || old?.commandGeneration === resumeGeneration,
                'KICKED', '原座位已被移除或失效，已停止自动重连。请返回首页后明确重新加入。');
            if (old)
                return old.seat; // hello retry is idempotent, including a lost welcome
            (0, model_js_1.requireRule)(this.data.status === 'lobby', 'MATCH_STARTED', '本局已开始，只允许原座位重连。');
            (0, model_js_1.requireRule)(this.data.members.length < (this.data.size ?? 12), 'ROOM_FULL', '房间座位已满。');
            const s = this.snapshot();
            const seat = Array.from({ length: this.data.size ?? 12 }, (_, i) => i + 1).find(n => !s.members.some(p => p.seat === n));
            s.members.push({ seat, token, name: cleanName(name), ready: false,
                commandGeneration: this.uid(), commandSeq: 0, lastReceipt: null });
            s.members.sort((a, b) => a.seat - b.seat);
            await this.commit(s);
            return seat;
        });
    }
    newGate(s) {
        if (!s.game || s.game.outcome) {
            s.gate = null;
            if (s.game?.outcome)
                s.status = 'ended';
            return;
        }
        const step = s.game.step;
        const privateSlot = !step.startsWith('day.') && step !== 'announce';
        // No secret-dependent omission: absent/dead/exhausted roles occupy the same slot.
        const ms = privateSlot ? s.slotMs : step === 'announce' ? Math.min(2000, s.slotMs) : 0;
        s.gate = { serial: s.game.stepSerial, releaseAt: this.now() + ms, remainingMs: ms, pending: {} };
    }
    markTransition(s, oldSerial) {
        // Domain commands are also fenced by their stepSerial. Receipts from
        // completed steps cannot execute again and need not grow indefinitely.
        if (s.game && s.game.stepSerial !== oldSerial)
            s.game.receipts = {};
        if (s.game?.outcome) {
            s.status = 'ended';
            s.paused = false;
            s.pauseReason = '';
            s.gate = null;
        }
        else if (s.game && s.game.stepSerial !== oldSerial)
            this.newGate(s);
    }
    allConnected(s) { return s.members.length === (s.size ?? 12) && s.members.every(m => this.online.has(m.seat)); }
    /** ACK = durably accepted. Queued night actions/ballots settle together, never on the client. */
    async dispatch(seat, id, matchId, intent, principal) {
        const entryMember = this.member(seat);
        const expected = principal ? { ...principal } : {
            token: entryMember?.token, generation: entryMember?.commandGeneration,
        };
        return this.enqueue(async () => {
            const member = this.data.members.find(p => p.seat === seat);
            (0, model_js_1.requireRule)(member, 'SEAT_LOST', '你的座位已失效，请重新加入。');
            (0, model_js_1.requireRule)(member.token === expected.token && member.commandGeneration === expected.generation
                && (!expected.isCurrent || expected.isCurrent()), 'STALE_SESSION', '这个连接的座位身份已失效，原操作没有执行。');
            (0, model_js_1.requireRule)(typeof id === 'string' && id.length > 0 && id.length <= 96, 'BAD_ID', '操作编号无效。');
            const fingerprint = JSON.stringify([matchId, intent]);
            const receipt = member.lastReceipt;
            const commandSeq = expected.commandSeq ?? (receipt?.id === id ? receipt.commandSeq : member.commandSeq + 1);
            (0, model_js_1.requireRule)(Number.isSafeInteger(commandSeq) && commandSeq > 0 && commandSeq < Number.MAX_SAFE_INTEGER,
                'BAD_SEQUENCE', '操作序号无效。');
            if (receipt && commandSeq === receipt.commandSeq) {
                (0, model_js_1.requireRule)(receipt.id === id && receipt.fingerprint === fingerprint, 'ID_REUSE', '同一操作序号不能对应不同内容。');
                return { id, generation: member.commandGeneration, commandSeq };
            }
            (0, model_js_1.requireRule)(commandSeq > member.commandSeq, 'STALE_COMMAND', '这条操作已经过期，不会重复执行。');
            (0, model_js_1.requireRule)(commandSeq === member.commandSeq + 1, 'BAD_SEQUENCE', '操作序号不连续，请重连后重试原操作。');
            (0, model_js_1.requireRule)(matchId === this.data.matchId, 'STALE_MATCH', '这条操作属于上一局，请使用最新页面。');
            const s = this.snapshot();
            const host = () => (0, model_js_1.requireRule)(seat === 1, 'HOST_ONLY', '只有房主可以执行此操作。');
            const active = () => { (0, model_js_1.requireRule)(s.game && s.status === 'playing', 'NOT_PLAYING', '当前没有进行中的对局。'); return s.game; };
            switch (intent.kind) {
                case 'size': {
                    host();
                    (0, presets_js_1.preset)(intent.size);
                    (0, model_js_1.requireRule)(s.status === 'lobby', 'NOT_LOBBY', '只能在大厅更改人数。');
                    (0, model_js_1.requireRule)(s.members.every(m => m.seat <= intent.size), 'SIZE_OCCUPIED', '请先移除超出新人数的座位。');
                    s.size = intent.size;
                    for (const m of s.members)
                        m.ready = false;
                    break;
                }
                case 'mute': {
                    host();
                    (0, model_js_1.requireRule)(s.members.some(m => m.seat === intent.seat), 'SEAT', '座位不存在。');
                    const muted = new Set(s.muted ?? []);
                    if (intent.value)
                        muted.add(intent.seat);
                    else
                        muted.delete(intent.seat);
                    s.muted = [...muted];
                    break;
                }
                case 'chat': {
                    (0, model_js_1.requireRule)(this.voicePolicy(s).speakers.includes(seat), 'SILENCED', '当前阶段不能发言。');
                    const text = intent.text.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 400);
                    (0, model_js_1.requireRule)(text.length > 0, 'EMPTY', '消息不能为空。');
                    s.chat = [...(s.chat ?? []), { seat, name: member.name, text, at: this.now() }].slice(-80);
                    break;
                }
                case 'ready': {
                    (0, model_js_1.requireRule)(s.status === 'lobby', 'NOT_LOBBY', '只有大厅可以修改准备状态。');
                    s.members.find(m => m.seat === seat).ready = intent.value;
                    break;
                }
                case 'rename': {
                    (0, model_js_1.requireRule)(s.status === 'lobby', 'NOT_LOBBY', '对局中不能改昵称。');
                    s.members.find(m => m.seat === seat).name = cleanName(intent.name);
                    break;
                }
                case 'start': {
                    host();
                    (0, model_js_1.requireRule)(s.status === 'lobby', 'NOT_LOBBY', '已经开始，不能重复发牌。');
                    (0, model_js_1.requireRule)(this.allConnected(s) && s.members.every(m => m.ready), 'NOT_READY', '需要所选人数全部在线并准备。');
                    s.matchId = this.uid();
                    s.status = 'playing';
                    s.paused = false;
                    s.pauseReason = '';
                    s.game = (0, engine_js_1.createGame)({ size: s.size ?? 12, seed: this.seed(), roomId: s.id, names: s.members.map(m => m.name),
                        ...(s.demo && this.options.demoRoles ? { roles: this.options.demoRoles } : {}) });
                    this.newGate(s);
                    break;
                }
                case 'play': {
                    const game = active();
                    (0, model_js_1.requireRule)(!s.paused && this.allConnected(s), 'PAUSED', '对局已暂停，操作尚未提交。');
                    (0, model_js_1.requireRule)(s.gate && s.gate.serial === intent.serial, 'STALE_STEP', '该行动已结束，请查看当前阶段。');
                    (0, model_js_1.requireRule)(!s.gate.pending[String(seat)], 'LOCKED', '本轮操作已经锁定，不能修改。');
                    const base = { actor: seat, id, stepSerial: intent.serial };
                    const command = intent.move === 'skill' ? { ...base, kind: 'skill', targets: [...intent.targets] }
                        : intent.move === 'vote' ? { ...base, kind: 'vote', target: intent.target }
                            : { ...base, kind: intent.move };
                    (0, engine_js_1.applyCommand)(game, command); // validate against authoritative state; no partial commit
                    s.gate.pending[String(seat)] = command;
                    break;
                }
                case 'advance': {
                    host();
                    const game = active();
                    (0, model_js_1.requireRule)(!s.paused && this.allConnected(s), 'PAUSED', '暂停期间不能推进。');
                    (0, model_js_1.requireRule)(['day.discuss', 'day.lastWords'].includes(game.step), 'PRIVATE_SLOT', '秘密行动由程序统一结算，房主不能跳过。');
                    const serial = game.stepSerial;
                    s.game = (0, engine_js_1.applyCommand)(game, { actor: 'host', id, kind: 'advance', stepSerial: serial });
                    this.markTransition(s, serial);
                    break;
                }
                case 'pause':
                    host();
                    active();
                    this.pauseState(s, '房主暂停了对局。操作与选票均已保留。');
                    break;
                case 'resume': {
                    host();
                    active();
                    (0, model_js_1.requireRule)(this.allConnected(s), 'OFFLINE_PLAYERS', '仍有玩家离线，暂不能继续。');
                    if (s.paused && s.gate)
                        s.gate.releaseAt = this.now() + s.gate.remainingMs;
                    s.paused = false;
                    s.pauseReason = '';
                    break;
                }
                case 'abort':
                    host();
                    active();
                    s.status = 'aborted';
                    s.paused = false;
                    s.pauseReason = '';
                    s.gate = null;
                    break;
                case 'rematch': {
                    host();
                    (0, model_js_1.requireRule)(['ended', 'aborted'].includes(s.status), 'NOT_ENDED', '请先结束或中止当前对局。');
                    s.status = 'lobby';
                    s.game = null;
                    s.gate = null;
                    s.matchId = this.uid();
                    s.paused = false;
                    for (const m of s.members)
                        m.ready = false;
                    s.chat = [];
                    s.muted = [];
                    break;
                }
                case 'kick': {
                    host();
                    (0, model_js_1.requireRule)(s.status === 'lobby' && intent.seat !== 1, 'CANNOT_KICK', '只能在大厅移除其他座位。');
                    s.members = s.members.filter(m => m.seat !== intent.seat);
                    s.muted = s.muted.filter(n => n !== intent.seat);
                    break;
                }
                case 'leave': {
                    (0, model_js_1.requireRule)(seat !== 1, 'HOST_LEAVE', '房主离开会关闭房间，请使用关闭房间。');
                    (0, model_js_1.requireRule)(s.status === 'lobby', 'MATCH_STARTED', '对局中退出将暂停游戏，不能转让座位。');
                    s.members = s.members.filter(m => m.seat !== seat);
                    s.muted = s.muted.filter(n => n !== seat);
                    break;
                }
                default:
                    (0, model_js_1.requireRule)(false, 'BAD_MESSAGE', '未知操作。');
            }
            const committingMember = s.members.find(m => m.token === member.token);
            if (committingMember) {
                committingMember.commandSeq = commandSeq;
                committingMember.lastReceipt = { id, commandSeq, fingerprint };
            }
            await this.commit(s);
            return { id, generation: member.commandGeneration, commandSeq };
        });
    }
    /** Called periodically. Safe to call concurrently; failed persistence does not publish results. */
    async tick() {
        return this.enqueue(async () => {
            const current = this.data;
            if (current.status !== 'playing' || current.paused || !current.game || !current.gate
                || !this.allConnected(current) || this.now() < current.gate.releaseAt)
                return;
            const actors = (0, engine_js_1.pendingActors)(current.game);
            if (actors.some(id => !current.gate.pending[String(id)]))
                return;
            const s = this.snapshot(), serial = s.game.stepSerial;
            for (const seat of actors)
                s.game = (0, engine_js_1.applyCommand)(s.game, s.gate.pending[String(seat)]);
            if (s.game.stepSerial === serial) {
                if (s.game.vote)
                    s.game = (0, engine_js_1.applyCommand)(s.game, { id: 'system-' + this.uid(), actor: 'host', kind: 'resolve', stepSerial: serial });
                else if ((0, engine_js_1.canHostAdvance)(s.game) && !['day.discuss', 'day.lastWords'].includes(s.game.step))
                    s.game = (0, engine_js_1.applyCommand)(s.game, { id: 'system-' + this.uid(), actor: 'host', kind: 'advance', stepSerial: serial });
                else
                    return;
            }
            this.markTransition(s, serial);
            await this.commit(s);
        });
    }
    voicePolicy(s = this.data) {
        const muted = s.muted ?? [];
        let speakers = [], reason = '夜间静音';
        if (s.status === 'lobby' || s.status === 'ended' || s.status === 'aborted') {
            speakers = s.members.map(m => m.seat);
            reason = '自由讨论';
        }
        else if (s.paused) {
            reason = '对局已暂停';
        }
        else if (s.game?.step === 'day.discuss' || s.game?.step === 'day.vote') {
            speakers = s.game.players.filter(p => p.publicAlive).map(p => p.seat);
            reason = '在场玩家可发言';
        }
        else if (s.game?.step === 'day.lastWords') {
            speakers = s.game.lastWords === null ? [] : [s.game.lastWords];
            reason = `${s.game.lastWords} 号遗言`;
        }
        return { speakers: speakers.filter(n => !muted.includes(n)), muted, reason };
    }
    view(seat) {
        const member = this.member(seat);
        (0, model_js_1.requireRule)(member, 'SEAT_LOST', '座位已被移除。');
        const s = this.data, game = s.game ? (0, view_js_1.projectView)(s.game, seat) : null;
        const command = s.gate?.pending[String(seat)];
        if (game && command) {
            game.action = null;
            game.actionStepSerial = null;
            if (command.kind === 'vote')
                game.ownVote = { target: command.target };
        }
        if (game && s.status === 'aborted') {
            game.action = null;
            game.actionStepSerial = null;
            game.phase = '已中止';
        }
        const step = s.game?.step;
        const activity = s.status === 'lobby' ? 'lobby' : ['ended', 'aborted'].includes(s.status) ? 'ended'
            : step === 'day.discuss' ? 'discussion' : step === 'day.vote' ? 'vote' : step === 'day.lastWords' ? 'lastWords'
                : step === 'announce' ? 'announcement' : 'night';
        return { ephemeral: !!s.ephemeral, size: s.size ?? 12, voice: this.voicePolicy(s), chat: s.chat ?? [], appVersion: types_js_1.APP_VERSION, rules: '1.0', id: s.id, hostPeer: s.hostPeer, matchId: s.matchId,
            commandGeneration: member.commandGeneration, nextCommandSeq: member.commandSeq + 1,
            self: seat, isHost: seat === 1, demo: s.demo, status: s.status,
            members: s.members.map(m => ({ seat: m.seat, name: m.name, ready: m.ready, online: this.online.has(m.seat), isHost: m.seat === 1 })),
            paused: s.paused, pauseReason: s.pauseReason,
            // No deadline/count/slot identity for uninvolved players: public phase only.
            releaseAt: null, game, activity,
            submitted: Boolean(command), submittedText: command ? command.kind === 'vote'
                ? command.target === null ? '已锁定弃票' : `已锁定：投给 ${command.target} 号`
                : command.kind === 'pass' ? '已放弃本次技能' : command.kind === 'skill' ? `已锁定目标：${command.targets.join('、')} 号` : '已确认'
                : '', canAdvance: seat === 1 && s.status === 'playing' && !s.paused && (activity === 'discussion' || activity === 'lastWords'),
        };
    }
}
exports.RoomAuthority = RoomAuthority;
function cleanName(name) {
    const n = name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 16);
    (0, model_js_1.requireRule)(n.length > 0, 'NAME', '请输入昵称（最多 16 个字符）。');
    return n;
}
class MemoryRoomStore {
    value = null;
    async load() { return this.value ? structuredClone(this.value) : null; }
    async save(data) { this.value = structuredClone(data); }
    async clear() { this.value = null; }
}
exports.MemoryRoomStore = MemoryRoomStore;

