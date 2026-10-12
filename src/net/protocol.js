"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseIntent = parseIntent;
exports.parseClientMessage = parseClientMessage;
exports.parseServerMessage = parseServerMessage;
exports.parseRoomView = parseRoomView;
const types_js_1 = require("../room/types.js");
const model_js_1 = require("../domain/model.js");
const obj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x, max = 128) => typeof x === 'string' && x.length > 0 && x.length <= max;
const seat = (x) => Number.isInteger(x) && Number(x) >= 1 && Number(x) <= 12;
function parseIntent(x) {
    (0, model_js_1.requireRule)(obj(x) && str(x.kind), 'BAD_MESSAGE', '操作格式不正确。');
    switch (x.kind) {
        case 'size':
            (0, model_js_1.requireRule)([6, 8, 10, 12].includes(Number(x.size)) && typeof x.size === 'number', 'BAD_MESSAGE', '人数无效。');
            return { kind: 'size', size: x.size };
        case 'mute':
            (0, model_js_1.requireRule)(seat(x.seat) && typeof x.value === 'boolean', 'BAD_MESSAGE', '禁言参数无效。');
            return { kind: 'mute', seat: x.seat, value: x.value };
        case 'chat':
            (0, model_js_1.requireRule)(str(x.text, 400), 'BAD_MESSAGE', '消息须为 1–400 字。');
            return { kind: 'chat', text: x.text };
        case 'ready':
            (0, model_js_1.requireRule)(typeof x.value === 'boolean', 'BAD_MESSAGE', '准备状态无效。');
            return { kind: 'ready', value: x.value };
        case 'rename':
            (0, model_js_1.requireRule)(str(x.name, 64), 'BAD_MESSAGE', '昵称无效。');
            return { kind: 'rename', name: x.name };
        case 'kick':
            (0, model_js_1.requireRule)(seat(x.seat), 'BAD_MESSAGE', '座位无效。');
            return { kind: 'kick', seat: x.seat };
        case 'start':
        case 'advance':
        case 'pause':
        case 'resume':
        case 'abort':
        case 'rematch':
        case 'leave': return { kind: x.kind };
        case 'play': {
            (0, model_js_1.requireRule)(Number.isInteger(x.serial) && Number(x.serial) > 0, 'BAD_MESSAGE', '行动阶段无效。');
            const base = { kind: 'play', serial: Number(x.serial) };
            if (x.move === 'ack' || x.move === 'pass')
                return { ...base, move: x.move };
            if (x.move === 'vote') {
                (0, model_js_1.requireRule)(x.target === null || seat(x.target), 'BAD_MESSAGE', '投票目标无效。');
                return { ...base, move: 'vote', target: x.target };
            }
            if (x.move === 'skill') {
                (0, model_js_1.requireRule)(Array.isArray(x.targets) && x.targets.length >= 1 && x.targets.length <= 3 && x.targets.every(seat), 'BAD_MESSAGE', '技能目标无效。');
                return { ...base, move: 'skill', targets: [...x.targets] };
            }
        }
    }
    (0, model_js_1.requireRule)(false, 'BAD_MESSAGE', '未知操作。');
}
/** Runtime allow-list. No raw actor, prototype field, rule override or host object crosses this boundary. */
function parseClientMessage(raw) {
    (0, model_js_1.requireRule)(JSON.stringify(raw)?.length <= 16000 && obj(raw), 'BAD_MESSAGE', '消息过大或格式不正确。');
    (0, model_js_1.requireRule)(raw.protocol === types_js_1.PROTOCOL, 'PROTOCOL_VERSION', '联机版本不一致，请双方刷新到同一版本。');
    if (raw.type === 'ping') {
        (0, model_js_1.requireRule)(typeof raw.sent === 'number' && Number.isFinite(raw.sent), 'BAD_MESSAGE', '心跳无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'ping', sent: raw.sent };
    }
    (0, model_js_1.requireRule)(str(raw.roomId, 64), 'BAD_MESSAGE', '房间标识无效。');
    if (raw.type === 'presence') {
        (0, model_js_1.requireRule)(typeof raw.visible === 'boolean', 'BAD_MESSAGE', '在线状态无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'presence', roomId: raw.roomId, visible: raw.visible };
    }
    if (raw.type === 'hello') {
        (0, model_js_1.requireRule)(str(raw.token, 64) && /^[a-f0-9]{32}$/.test(raw.token) && str(raw.name, 64), 'BAD_MESSAGE', '加入凭证或昵称无效。');
        const resumeGeneration = raw.resumeGeneration ?? null;
        (0, model_js_1.requireRule)(resumeGeneration === null || hexId(resumeGeneration), 'BAD_MESSAGE', '恢复座位的凭证无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'hello', roomId: raw.roomId, token: raw.token, name: raw.name, resumeGeneration };
    }
    (0, model_js_1.requireRule)(raw.type === 'command' && str(raw.id, 96) && typeof raw.matchId === 'string' && raw.matchId.length <= 64 && str(raw.epoch, 64)
        && hexId(raw.generation) && positive(raw.commandSeq), 'BAD_MESSAGE', '操作信封无效，请所有玩家刷新到同一版本。');
    return { protocol: types_js_1.PROTOCOL, type: 'command', roomId: raw.roomId, id: raw.id, epoch: raw.epoch, matchId: raw.matchId,
        generation: raw.generation, commandSeq: raw.commandSeq, intent: parseIntent(raw.intent) };
}
function parseServerMessage(raw) {
    (0, model_js_1.requireRule)(obj(raw) && raw.protocol === types_js_1.PROTOCOL && JSON.stringify(raw).length <= 512000, 'BAD_HOST', '房主消息无效或版本不一致，请所有玩家刷新。');
    if (raw.type === 'ack') {
        valid(str(raw.id, 96) && hexId(raw.generation) && positive(raw.commandSeq), '回执无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'ack', id: raw.id, generation: raw.generation, commandSeq: raw.commandSeq };
    }
    if (raw.type === 'pong') {
        valid(Number.isFinite(raw.sent), '心跳无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'pong', sent: raw.sent };
    }
    if (raw.type === 'replaced')
        return { protocol: types_js_1.PROTOCOL, type: 'replaced' };
    if (raw.type === 'kicked') {
        valid(str(raw.message, 1000), '移除通知无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'kicked', message: raw.message };
    }
    if (raw.type === 'error') {
        (0, model_js_1.requireRule)((raw.id === null || str(raw.id, 96)) && str(raw.code) && str(raw.message, 1000), 'BAD_HOST', '错误回执无效。');
        return { protocol: types_js_1.PROTOCOL, type: 'error', id: raw.id, code: raw.code, message: raw.message };
    }
    valid(raw.type === 'view' && str(raw.epoch, 64) && positive(raw.seq), '房间视图不完整。');
    return { protocol: types_js_1.PROTOCOL, type: 'view', epoch: raw.epoch, seq: raw.seq, view: parseRoomView(raw.view) };
}

const hexId = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const positive = x => Number.isSafeInteger(x) && x > 0;
const text = (x, max) => typeof x === 'string' && x.length <= max;
const bool = x => typeof x === 'boolean';
const roles = x => typeof x === 'string' && Object.hasOwn(model_js_1.ROLE_NAMES, x);
function valid(condition, message = '房主视图字段无效。') {
    (0, model_js_1.requireRule)(condition, 'BAD_HOST', message);
}
function stringList(value, maxLength = 4096) {
    valid(Array.isArray(value) && value.length <= maxLength && value.every(x => text(x, 2000)));
    return [...value];
}
function seatList(value, size) {
    valid(Array.isArray(value) && value.length <= size && value.every(n => seat(n) && n <= size) && new Set(value).size === value.length);
    return [...value];
}
/** Reconstruct every nested DTO. A trusted game referee still cannot supply DOM markup as numeric IDs. */
function parseRoomView(v) {
    valid(obj(v) && [6, 8, 10, 12].includes(v.size) && hexId(v.id) && text(v.matchId, 64)
        && str(v.hostPeer, 80) && /^[a-zA-Z0-9_-]+$/.test(v.hostPeer)
        && str(v.appVersion, 32) && v.rules === '1.0' && hexId(v.commandGeneration) && positive(v.nextCommandSeq));
    const size = v.size;
    valid(['lobby', 'playing', 'ended', 'aborted'].includes(v.status) && seat(v.self) && v.self <= size
        && bool(v.isHost) && v.isHost === (v.self === 1) && bool(v.demo) && bool(v.ephemeral)
        && bool(v.paused) && text(v.pauseReason, 1000) && v.releaseAt === null
        && ['lobby', 'ended', 'discussion', 'vote', 'lastWords', 'announcement', 'night'].includes(v.activity)
        && bool(v.submitted) && text(v.submittedText, 1000) && bool(v.canAdvance));
    valid(Array.isArray(v.members) && v.members.length > 0 && v.members.length <= size);
    const members = v.members.map(m => {
        valid(obj(m) && seat(m.seat) && m.seat <= size && str(m.name, 64) && bool(m.ready) && bool(m.online)
            && bool(m.isHost) && m.isHost === (m.seat === 1));
        return { seat: m.seat, name: m.name, ready: m.ready, online: m.online, isHost: m.isHost };
    });
    const memberSeats = seatList(members.map(m => m.seat), size);
    valid(memberSeats.includes(1) && memberSeats.includes(v.self));
    valid(obj(v.voice) && text(v.voice.reason, 1000));
    const speakers = seatList(v.voice.speakers, size), muted = seatList(v.voice.muted, size);
    valid(speakers.every(n => memberSeats.includes(n)) && muted.every(n => memberSeats.includes(n)));
    const voice = { speakers, muted, reason: v.voice.reason };
    valid(Array.isArray(v.chat) && v.chat.length <= 80);
    const chat = v.chat.map(m => {
        // Lobby size can shrink after a speaker leaves; historical chat keeps
        // that speaker's original numeric seat even when it exceeds new size.
        valid(obj(m) && seat(m.seat) && str(m.name, 64) && str(m.text, 400) && Number.isFinite(m.at));
        return { seat: m.seat, name: m.name, text: m.text, at: m.at };
    });
    valid(v.status === 'lobby' ? v.game === null : obj(v.game));
    const game = v.game === null ? null : parseGameView(v.game, v.id, v.self, size);
    return { ephemeral: v.ephemeral, size, voice, chat, appVersion: v.appVersion, rules: v.rules,
        id: v.id, hostPeer: v.hostPeer, matchId: v.matchId, commandGeneration: v.commandGeneration,
        nextCommandSeq: v.nextCommandSeq, self: v.self, isHost: v.isHost, demo: v.demo, status: v.status,
        members, paused: v.paused, pauseReason: v.pauseReason, releaseAt: null, game, activity: v.activity,
        submitted: v.submitted, submittedText: v.submittedText, canAdvance: v.canAdvance };
}
function parseGameView(g, roomId, self, size) {
    valid(obj(g) && g.roomId === roomId && positive(g.day)
        && ['子夜', '夜间公告', '白天', '日落', '午夜', '终局', '已中止'].includes(g.phase)
        && Array.isArray(g.seats) && g.seats.length === size);
    const seats = g.seats.map(p => {
        valid(obj(p) && seat(p.seat) && p.seat <= size && str(p.name, 64) && bool(p.alive) && (p.role === null || roles(p.role)));
        return { seat: p.seat, name: p.name, alive: p.alive, role: p.role };
    });
    seatList(seats.map(p => p.seat), size);
    valid(obj(g.self) && g.self.seat === self && roles(g.self.role) && bool(g.self.alive));
    const own = { seat: self, role: g.self.role, alive: g.self.alive, notes: stringList(g.self.notes) };
    let action = null;
    if (g.action !== null) {
        const a = g.action;
        valid(obj(a) && ['ack', 'skill', 'vote'].includes(a.kind) && str(a.title, 1000)
            && Number.isInteger(a.targetCount) && a.targetCount >= 0 && a.targetCount <= 3 && bool(a.canPass) && bool(a.canAbstain));
        const candidates = seatList(a.candidates, size);
        valid(a.kind === 'ack' ? a.targetCount === 0 && candidates.length === 0 : a.targetCount > 0);
        action = { kind: a.kind, title: a.title, candidates, targetCount: a.targetCount, canPass: a.canPass, canAbstain: a.canAbstain };
    }
    valid(action ? positive(g.actionStepSerial) : g.actionStepSerial === null);
    valid(g.ownVote === null || obj(g.ownVote) && (g.ownVote.target === null || seat(g.ownVote.target) && g.ownVote.target <= size));
    const ownVote = g.ownVote === null ? null : { target: g.ownVote.target };
    let outcome = null;
    if (g.outcome !== null) {
        const o = g.outcome;
        valid(obj(o) && Array.isArray(o.winners) && o.winners.length <= 4
            && new Set(o.winners).size === o.winners.length && o.winners.every(x => ['human', 'fairy', 'god', 'youkai'].includes(x))
            && ['conditions', 'no-winner'].includes(o.reason));
        outcome = { winners: [...o.winners], reason: o.reason };
    }
    return { roomId, day: g.day, phase: g.phase, seats, self: own, action, actionStepSerial: g.actionStepSerial,
        ownVote, publicLog: stringList(g.publicLog, 10000), outcome };
}

