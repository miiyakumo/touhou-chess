'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { App } = require('../src/ui/app.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
const payload = '<img src="data:image/png;base64,broken" onerror="window.auditXss=true">';
const encodedPayload = '&lt;img src=&quot;data:image/png;base64,broken&quot; onerror=&quot;window.auditXss=true&quot;&gt;';

function roomView() {
    return {
        id: 'f'.repeat(32), hostPeer: 'rls-host', matchId: 'match', self: 2,
        isHost: false, size: 6, demo: false, status: 'playing', activity: 'night',
        paused: false, submitted: false, submittedText: '', canAdvance: false,
        members: [
            { seat: 1, name: '房主', ready: false, online: true, isHost: true },
            { seat: 2, name: '客机', ready: false, online: true, isHost: false },
        ],
        voice: { speakers: [1, 2], muted: [], reason: '自由讨论' }, chat: [],
        game: {
            day: 1, phase: '子夜', action: null, outcome: null,
            seats: [{ seat: 1, name: '房主', alive: true, role: null }, { seat: 2, name: '客机', alive: true, role: null }],
            self: { role: 'human', alive: true, notes: [] }, publicLog: [],
        },
    };
}

function appFixture(view = roomView(), submit = async () => {}) {
    const app = Object.create(App.prototype);
    Object.assign(app, {
        chatDraft: '', chatDraftRevision: 0, selected: [], hiddenRole: true,
        journal: 'public', externalArt: false, portrait: '', notes: '',
        renderCount: 0, error: '',
        controller: {
            state: { view, connected: true, pending: 0, mode: 'guest' }, submit,
            voice: { state: { enabled: false, mic: false, openMic: false, allowed: true, speaking: [], devices: [], reason: '自由讨论', volume: 0.8, level: 0 } },
        },
        render() { ++this.renderCount; },
        run(fn) { this.completion = fn(); },
    });
    return app;
}

test('host chat seat, name and text remain text even if a malformed view reaches the renderer', () => {
    const view = roomView(), app = appFixture(view);
    view.chat = [{ seat: payload, name: payload, text: payload }];
    const html = app.chatPanel(view);
    assert.equal(html.includes(payload), false);
    assert.equal(html.split(encodedPayload).length - 1, 3);
    assert.ok(html.includes('房间文字'));
});

test('host action titles, submitted text and lobby counts cannot introduce markup', () => {
    const view = roomView(), app = appFixture(view);
    view.game.action = { kind: 'ack', title: payload };
    assert.ok(app.actions(view).includes(encodedPayload));
    assert.equal(app.actions(view).includes(payload), false);
    view.game.action = null; view.submitted = true; view.submittedText = payload;
    assert.ok(app.actions(view).includes(encodedPayload));
    view.submitted = false; view.status = 'lobby'; view.size = payload;
    assert.ok(app.actions(view).includes(encodedPayload));
    assert.equal(app.actions(view).includes(payload), false);
});

test('host game day and logs are escaped while normal action highlighting stays intact', () => {
    const view = roomView(), app = appFixture(view);
    view.game.day = payload; view.game.publicLog = [payload];
    const html = app.room(view);
    assert.ok(html.includes(encodedPayload));
    assert.equal(html.includes(payload), false);
    view.game.action = { kind: 'skill', title: '选择目标', targetCount: 2, candidates: [1, 2], canPass: true };
    app.selected = [2];
    const action = app.actions(view);
    assert.ok(action.includes('<span class="target">02 号</span>'));
    assert.ok(action.includes('<span class="selection-count">1/2</span>'));
    assert.ok(action.includes('请选择 2 名不同玩家'));
});

test('voice admin seat attributes and voice messages escape network values', () => {
    const view = roomView(), app = appFixture(view);
    view.isHost = true; view.members[1].seat = payload;
    app.modal = (_title, body) => { app.dialogBody = body; };
    app.voiceAdmin();
    assert.ok(app.dialogBody.includes(`value="${encodedPayload}"`));
    assert.equal(app.dialogBody.includes(payload), false);
    app.controller.voice.state.reason = payload;
    assert.ok(app.voicePanel(view).includes(encodedPayload));
});

test('network settings numeric fields cannot break out of their HTML attributes', () => {
    const app = appFixture();
    app.controller.state.mode = 'home';
    app.controller.settings = { port: payload, iceServers: [] };
    app.modal = (_title, body) => { app.dialogBody = body; };
    app.settings();
    assert.ok(app.dialogBody.includes(`value="${encodedPayload}"`));
    assert.equal(app.dialogBody.includes(payload), false);
});

test('chat draft is retained until the host ACK and then only the acknowledged draft clears', async () => {
    const ack = deferred(), intents = [], app = appFixture(roomView(), intent => { intents.push(intent); return ack.promise; });
    app.setChatDraft('  等待确认的文字  ');
    app.clickAction('chat-send');
    assert.equal(app.chatDraft, '  等待确认的文字  ');
    assert.deepEqual(intents, [{ kind: 'chat', text: '等待确认的文字' }]);
    ack.resolve(); await app.completion;
    assert.equal(app.chatDraft, '');
});

test('a definitive chat rejection preserves the draft for correction or resending', async () => {
    const ack = deferred(), app = appFixture(roomView(), () => ack.promise);
    app.setChatDraft('阶段切换时发送的文字'); app.clickAction('chat-send');
    ack.reject(Error('当前阶段不能发言。'));
    await assert.rejects(app.completion, /当前阶段不能发言/);
    assert.equal(app.chatDraft, '阶段切换时发送的文字');
});

test('an ACK never clears new input, including edits that restore the same text', async () => {
    for (const revised of ['下一条消息', '第一条消息']) {
        const ack = deferred(), app = appFixture(roomView(), () => ack.promise);
        app.setChatDraft('第一条消息'); app.clickAction('chat-send');
        app.setChatDraft('编辑中'); app.setChatDraft(revised);
        ack.resolve(); await app.completion;
        assert.equal(app.chatDraft, revised);
    }
});

test('a rejected earlier chat cannot overwrite a new draft', async () => {
    const ack = deferred(), app = appFixture(roomView(), () => ack.promise);
    app.setChatDraft('第一条消息'); app.clickAction('chat-send');
    app.setChatDraft('下一条消息');
    ack.reject(Error('当前阶段不能发言。'));
    await assert.rejects(app.completion, /当前阶段不能发言/);
    assert.equal(app.chatDraft, '下一条消息');
});

test('pending confirmation disables sending while leaving the draft editable', () => {
    const view = roomView(), app = appFixture(view);
    app.controller.state.pending = 1;
    const html = app.chatPanel(view);
    assert.doesNotMatch(html.match(/<input id="chat-input"[^>]*>/)[0], /disabled/);
    assert.match(html, /<button class="btn" type="submit" disabled>等待确认<\/button>/);
});

test('legacy operation archive is discoverable only when this player has saved entries', () => {
    const app = appFixture();
    assert.doesNotMatch(app.feedback(), /legacy-pending/);
    app.controller.client = { legacyPending: [] };
    assert.doesNotMatch(app.feedback(), /legacy-pending/);
    app.controller.client.legacyPending = [{ intent: { kind: 'chat', text: '旧稿' } }];
    assert.match(app.feedback(), /data-action="legacy-pending">查看旧版未确认操作/);
});

test('legacy preview preserves operation text, escapes all content and excludes envelope credentials', () => {
    const archive = [
        { token: 'SECRET_TOKEN', roomId: 'SECRET_ROOM', epoch: 'SECRET_EPOCH', generation: 'SECRET_GENERATION', intent: { kind: 'chat', text: payload, token: 'SECRET_INTENT_TOKEN' } },
        { intent: { kind: 'rename', name: payload } },
        { intent: { kind: 'play', move: payload, serial: payload, targets: [payload, { token: 'SECRET_NESTED' }] } },
        { intent: { kind: 'ready', value: true } },
        { intent: { kind: '__proto__', text: 'SECRET_UNKNOWN' } },
    ];
    const app = appFixture();
    app.controller.client = { get legacyPending() { return structuredClone(archive); } };
    app.modal = (title, body, buttons) => { app.dialog = { title, body, buttons }; };
    app.clickAction('legacy-pending');
    assert.equal(app.dialog.title, '旧版未确认操作');
    assert.equal(app.dialog.buttons, undefined);
    assert.match(app.dialog.body, /不能自动重发/);
    assert.match(app.dialog.body, /查看不会删除归档/);
    assert.match(app.dialog.body, /原文：/);
    assert.match(app.dialog.body, /昵称：/);
    assert.match(app.dialog.body, /设置值：true/);
    assert.equal(app.dialog.body.split(encodedPayload).length - 1, 5);
    assert.equal(app.dialog.body.includes(payload), false);
    assert.doesNotMatch(app.dialog.body, /SECRET_|data-action=/);
    assert.equal(archive[0].intent.text, payload);
    assert.equal(archive.length, 5);
});

test('cancelled old-session work cannot replace feedback for the current room', async () => {
    const app = appFixture(), work = deferred();
    let toasts = 0;
    app.toast = () => { ++toasts; };
    App.prototype.run.call(app, () => work.promise);
    app.error = '当前房间的提示';
    work.reject(Object.assign(Error('旧连接已取消'), { name: 'AbortError' }));
    await tick();
    assert.equal(app.error, '当前房间的提示');
    assert.equal(app.renderCount, 0);
    assert.equal(toasts, 0);
});

function voiceFixture() {
    const requests = [], contexts = [], timers = new Set();
    let enumerate = async () => [], play = async () => {}, resume = async () => {};
    class Track {
        constructor(id = 'track') { this.kind = 'audio'; this.id = id; this.enabled = true; this.readyState = 'live'; }
        stop() { this.readyState = 'ended'; }
        getSettings() { return { deviceId: this.id }; }
    }
    class Stream {
        constructor(id) { this.tracks = [new Track(id)]; }
        getTracks() { return this.tracks; }
        getAudioTracks() { return this.tracks; }
    }
    class AudioNode {
        constructor(kind) { this.kind = kind; this.connections = new Set(); this.gain = { value: 1 }; }
        connect(node) { this.connections.add(node); return node; }
        disconnect() { this.connections.clear(); }
        getFloatTimeDomainData(samples) { samples.fill(0); }
    }
    class AudioContext {
        constructor() { this.closeCount = 0; contexts.push(this); }
        createGain() { return new AudioNode('gain'); }
        createMediaStreamDestination() { const node = new AudioNode('destination'); node.stream = new Stream('destination'); return node; }
        createMediaStreamSource(stream) { const node = new AudioNode('source'); node.stream = stream; return node; }
        createAnalyser() { return new AudioNode('analyser'); }
        async resume() { await resume(); }
        async close() { ++this.closeCount; }
    }
    class Audio {
        setAttribute() {}
        async play() { await play(); }
        pause() {}
    }
    const document = { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };
    const exports = {};
    const sandbox = {
        exports, console, AudioContext, Audio, DOMException, document,
        window: { addEventListener() {}, removeEventListener() {} },
        navigator: { mediaDevices: {
            getUserMedia(options) { const request = deferred(); request.options = options; requests.push(request); return request.promise; },
            enumerateDevices() { return enumerate(); },
        } },
        setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/net/voice.js'), 'utf8'), sandbox);
    const voice = new exports.VoiceRoom(() => {});
    voice.update({ self: 1, isHost: true, voice: { speakers: [1, 2, 3], muted: [], reason: '自由讨论' } });
    return {
        voice, requests, contexts, timers, stream: id => new Stream(id),
        enumerateWith(fn) { enumerate = fn; }, playWith(fn) { play = fn; }, resumeWith(fn) { resume = fn; },
        async connect(id = 'initial') {
            const promise = voice.mic(id); await tick();
            const stream = new Stream(id); requests.shift().resolve(stream); await promise; return stream;
        },
    };
}

test('stopMic invalidates late getUserMedia and cannot overwrite a newer microphone request', async t => {
    const env = voiceFixture(), voice = env.voice; t.after(() => voice.close());
    const first = await env.connect('first');
    const oldRequest = voice.mic('old'); await tick();
    const oldCapture = env.requests.shift();
    voice.stopMic();
    assert.equal(first.getTracks()[0].readyState, 'ended');
    assert.equal(voice.state.mic, false);
    const nextRequest = voice.mic('next'); await tick();
    const nextCapture = env.requests.shift(), stale = env.stream('old');
    oldCapture.resolve(stale); await oldRequest;
    assert.equal(stale.getTracks()[0].readyState, 'ended');
    assert.equal(voice.microphone, null);
    assert.equal(voice.starting, true);
    const current = env.stream('next'); nextCapture.resolve(current); await nextRequest;
    assert.equal(voice.microphone, current);
    assert.equal(voice.state.mic, true);
    assert.equal(current.getTracks()[0].enabled, false);
});

test('stopMic before audio activation prevents requesting a microphone afterward', async t => {
    const env = voiceFixture(), voice = env.voice, playback = deferred(); t.after(() => voice.close());
    env.playWith(() => playback.promise);
    const request = voice.mic(); await tick();
    voice.stopMic(); playback.resolve(); await request;
    assert.equal(env.requests.length, 0);
    assert.equal(voice.state.mic, false);
});

test('microphone gates apply before enumeration and stopped requests cannot publish stale devices', async t => {
    const env = voiceFixture(), voice = env.voice, devices = deferred(); t.after(() => voice.close());
    env.enumerateWith(() => devices.promise);
    const request = voice.mic(); await tick();
    const stream = env.stream('late-enumeration'); env.requests.shift().resolve(stream); await tick();
    assert.equal(voice.state.mic, true);
    assert.equal(stream.getTracks()[0].enabled, false);
    voice.stopMic(); devices.resolve([{ kind: 'audioinput', deviceId: 'stale', label: 'stale' }]); await request;
    assert.equal(stream.getTracks()[0].readyState, 'ended');
    assert.equal(voice.state.mic, false);
    assert.equal(voice.state.devices.length, 0);
});

test('close stops late microphone results and idempotently releases audio resources', async () => {
    const env = voiceFixture(), voice = env.voice;
    const request = voice.mic(); await tick();
    const capture = env.requests.shift();
    await Promise.all([voice.close(), voice.close()]);
    const late = env.stream('after-close'); capture.resolve(late); await request;
    assert.equal(late.getTracks()[0].readyState, 'ended');
    assert.equal(voice.microphone, null);
    assert.equal(voice.state.mic, false);
    assert.equal(voice.state.enabled, false);
    assert.equal(env.contexts[0].closeCount, 1);
    assert.equal(env.timers.size, 0);
    await voice.mic(); assert.equal(env.requests.length, 0);
});

test('late audio.play cannot re-enable a closed VoiceRoom', async () => {
    const env = voiceFixture(), voice = env.voice, playback = deferred();
    env.playWith(() => playback.promise);
    const enabling = voice.enable(); await tick(); await voice.close();
    playback.resolve(); await enabling;
    assert.equal(voice.state.enabled, false);
    assert.equal(voice.context, null);
});

function audioLink(env, id, replace = async () => {}) {
    const closes = new Set(), audio = new Set();
    const sender = { track: null, async replaceTrack(track) { await replace(track); this.track = track; } };
    return {
        id, open: true, remoteAudio: env.stream(id), sender,
        rtc: { getTransceivers() { return [{ receiver: { track: { kind: 'audio' } }, sender }]; } },
        onAudio(fn) { audio.add(fn); return () => audio.delete(fn); },
        onSpeaking() { return () => {}; },
        onClose(fn) { closes.add(fn); return () => closes.delete(fn); },
        captureCallbacks() { return { closes: [...closes], audio: [...audio] }; },
    };
}

test('restoring sound retries a rejected sender binding using the existing live mix', async t => {
    const env = voiceFixture(), voice = env.voice, rejected = deferred(), attempts = [];
    t.after(() => voice.close());
    await voice.enable();
    const link = audioLink(env, 'retry', track => {
        attempts.push(track);
        return attempts.length === 1 ? rejected.promise : Promise.resolve();
    });
    voice.bind(link, 2);
    const destination = voice.endpoints.get(2).destination;
    rejected.reject(Error('temporary sender failure'));
    await tick();
    assert.match(voice.state.error, /temporary sender failure/);
    assert.equal(link.sender.track, null);

    await voice.enable();
    await tick();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1], attempts[0], 'retry keeps the existing mixed audio track');
    assert.equal(voice.endpoints.get(2).destination, destination);
    assert.equal(link.sender.track, destination.stream.getAudioTracks()[0]);
    assert.equal(link.sender.track.readyState, 'live');
    assert.equal(voice.state.error, '');
});

test('repeated audio events and sound activation share one pending replacement and keep success bound', async t => {
    const env = voiceFixture(), voice = env.voice, pending = deferred(), attempts = [];
    t.after(() => voice.close());
    await voice.enable();
    const link = audioLink(env, 'pending', track => { attempts.push(track); return pending.promise; });
    voice.bind(link, 2);
    const callbacks = link.captureCallbacks();
    for (let i = 0; i < 3; i++)
        for (const audio of callbacks.audio) audio();
    await Promise.all([voice.enable(), voice.enable()]);
    assert.equal(attempts.length, 1, 'pending replacement must not run concurrently');

    pending.resolve();
    await tick();
    assert.equal(link.sender.track, attempts[0]);
    await voice.enable();
    for (const audio of callbacks.audio) audio();
    await tick();
    assert.equal(attempts.length, 1, 'successful binding remains idempotent');
});

for (const action of ['remove', 'replace', 'close']) {
    test(`late sender failure after ${action} cannot replace current voice feedback`, async t => {
        const env = voiceFixture(), voice = env.voice, pending = deferred();
        t.after(() => voice.close());
        let notifications = 0;
        voice.changed = () => { ++notifications; };
        await voice.enable();
        const old = audioLink(env, 'old', () => pending.promise);
        voice.bind(old, 2);
        const oldTrack = voice.endpoints.get(2).destination.stream.getAudioTracks()[0];
        const replacement = audioLink(env, 'replacement');
        if (action === 'replace') voice.bind(replacement, 2);
        else if (action === 'remove') voice.remove(2);
        else await voice.close();
        await tick();
        voice.state.error = 'current feedback';
        const before = notifications;

        pending.reject(Error('late old sender failure'));
        await tick();
        assert.equal(voice.state.error, 'current feedback');
        assert.equal(notifications, before, 'stale rejection must not publish a change');
        assert.equal(oldTrack.readyState, 'ended');
        if (action === 'replace') {
            assert.equal(voice.endpoints.get(2).link, replacement);
            assert.equal(replacement.sender.track, voice.endpoints.get(2).destination.stream.getAudioTracks()[0]);
            assert.equal(replacement.sender.track.readyState, 'live');
        } else assert.equal(voice.endpoints.size, 0);
    });
}

test('late remote playback failure cannot overwrite feedback after endpoint replacement or disposal', async t => {
    for (const action of ['replace', 'close']) {
        const env = voiceFixture(), voice = env.voice, playback = deferred();
        t.after(() => voice.close());
        await voice.enable();
        env.playWith(() => playback.promise);
        voice.bind(audioLink(env, 'old-playback'), 2);
        if (action === 'replace') {
            env.playWith(async () => {});
            voice.bind(audioLink(env, 'new-playback'), 2);
        } else await voice.close();
        await tick();
        voice.state.error = 'current playback feedback';
        playback.reject(Error('late decoder failure'));
        await tick();
        assert.equal(voice.state.error, 'current playback feedback', action);
    }
});

test('host voice policy gates both monitoring and forwarding with mix-minus-self routing', async t => {
    const env = voiceFixture(), voice = env.voice; t.after(() => voice.close());
    await voice.enable();
    voice.bind(audioLink(env, 'guest-2'), 2); voice.bind(audioLink(env, 'guest-3'), 3);
    const microphone = await env.connect('host');
    voice.hold(true);
    assert.equal(microphone.getTracks()[0].enabled, true);
    const input = voice.inputs.get(2);
    assert.equal(input.gain.connections.has(voice.monitor), true);
    assert.equal(input.gain.connections.has(voice.endpoints.get(3).destination), true);
    assert.equal(input.gain.connections.has(voice.endpoints.get(2).destination), false);
    voice.update({ self: 1, isHost: true, voice: { speakers: [1, 3], muted: [2], reason: '自由讨论' } });
    assert.equal(input.gain.gain.value, 0);
    voice.hold(false); assert.equal(microphone.getTracks()[0].enabled, false);
    voice.toggleMic(); assert.equal(microphone.getTracks()[0].enabled, true);
    voice.update({ self: 1, isHost: true, voice: { speakers: [], muted: [], reason: '夜间静音' } });
    assert.equal(microphone.getTracks()[0].enabled, false);
    assert.equal(voice.inputs.get(3).gain.gain.value, 0);
});

test('guest sends only its own microphone and never loops the host mix back', async t => {
    const env = voiceFixture(), voice = env.voice; t.after(() => voice.close());
    voice.update({ self: 2, isHost: false, voice: { speakers: [1, 2], muted: [], reason: '自由讨论' } });
    await voice.enable(); voice.bind(audioLink(env, 'host'), 1);
    const microphone = await env.connect('guest'), outgoing = voice.endpoints.get(1).destination;
    voice.hold(true);
    assert.equal(microphone.getTracks()[0].enabled, true);
    assert.equal(voice.inputs.get(2).gain.connections.has(outgoing), true);
    assert.equal(voice.inputs.get(2).gain.connections.has(voice.monitor), false);
    assert.equal(voice.inputs.get(1).gain.connections.has(voice.monitor), true);
    assert.equal(voice.inputs.get(1).gain.connections.has(outgoing), false);
    voice.update({ self: 2, isHost: false, voice: { speakers: [1], muted: [2], reason: '禁言' } });
    assert.equal(microphone.getTracks()[0].enabled, false);
    assert.equal(voice.inputs.get(2).gain.gain.value, 0);
});

test('old close and audio callbacks cannot remove or replace a new voice binding', async t => {
    const env = voiceFixture(), voice = env.voice; t.after(() => voice.close());
    await voice.enable();
    const old = audioLink(env, 'old'), replacement = audioLink(env, 'replacement');
    voice.bind(old, 2); const callbacks = old.captureCallbacks();
    const oldDestination = voice.endpoints.get(2).destination;
    voice.bind(replacement, 2);
    for (const fn of callbacks.closes) fn();
    for (const fn of callbacks.audio) fn();
    assert.equal(voice.endpoints.get(2).link, replacement);
    assert.equal(voice.inputs.get(2).source.stream, replacement.remoteAudio);
    assert.equal(oldDestination.stream.getTracks()[0].readyState, 'ended');
});
