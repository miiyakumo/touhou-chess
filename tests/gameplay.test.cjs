const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomAuthority, MemoryRoomStore } = require('../src/room/authority.js');
const { validateRoom } = require('../src/room/store.js');
const { pendingActors, promptFor } = require('../src/domain/engine.js');
const { faction } = require('../src/domain/model.js');
const { parseClientMessage, parseServerMessage } = require('../src/net/protocol.js');
const { PROTOCOL } = require('../src/room/types.js');

const hex = n => Number(n).toString(16).padStart(32, '0');
const copy = x => JSON.parse(JSON.stringify(x));

async function room(size, seed) {
    let now = 1000, uid = size * 10000, command = 0, viewSeq = 0;
    const options = { now: () => now, randomId: () => hex(++uid), seed: () => seed };
    const store = new MemoryRoomStore();
    const fresh = RoomAuthority.fresh('房主', hex(100), false, hex(size), now, size);
    await store.save(fresh);
    let authority = new RoomAuthority(validateRoom(copy(await store.load())), store, options);
    const seen = new Set(), phases = new Set(), actions = new Set();
    const verify = async () => {
        const state = authority.snapshot();
        assert.deepEqual(validateRoom(copy(state)), state, 'current state must remain a valid persisted snapshot');
        assert.deepEqual(await store.load(), state, 'published state must agree with the durable store');
        for (const member of state.members) {
            const view = authority.view(member.seat);
            const parsed = parseServerMessage({ protocol: PROTOCOL, type: 'view', epoch: 'test-host-epoch', seq: ++viewSeq, view: copy(view) });
            assert.deepEqual(parsed.view, view, `v3 must accept the complete ${size}-seat view at ${state.game?.step ?? 'lobby'} for seat ${member.seat}`);
            assert(!Object.hasOwn(parsed.view, 'token'));
            if (view.game) phases.add(view.game.phase);
        }
        if (state.game) seen.add(state.game.step);
    };
    const submit = async (seat, intent) => {
        const view = authority.view(seat);
        const wire = parseClientMessage({ protocol: PROTOCOL, type: 'command', roomId: view.id, id: 'command-' + ++command,
            epoch: 'test-host-epoch', matchId: view.matchId, generation: view.commandGeneration, commandSeq: view.nextCommandSeq, intent });
        const member = authority.member(seat);
        const receipt = await authority.dispatch(seat, wire.id, wire.matchId, wire.intent,
            { token: member.token, generation: wire.generation, commandSeq: wire.commandSeq });
        assert.deepEqual(parseServerMessage({ protocol: PROTOCOL, type: 'ack', ...receipt }),
            { protocol: PROTOCOL, type: 'ack', id: wire.id, generation: wire.generation, commandSeq: wire.commandSeq });
        await verify();
        return receipt;
    };
    const restore = async (legacy = false) => {
        const before = authority.snapshot();
        const saved = copy(await store.load());
        if (legacy) {
            saved.schema = 2;
            saved.receipts = { oldReceipt: { fingerprint: 'old wire protocol' } };
            for (const member of saved.members) {
                delete member.commandGeneration;
                delete member.commandSeq;
                delete member.lastReceipt;
            }
        }
        authority = new RoomAuthority(validateRoom(saved), store, options);
        await authority.restore();
        const restored = authority.snapshot();
        assert.equal(restored.schema, 3);
        assert.equal(restored.id, before.id);
        assert.equal(restored.matchId, before.matchId);
        assert.deepEqual(restored.game, before.game, 'restore must not redraw roles, lose ballots, or rerun game actions');
        assert.deepEqual(restored.gate?.pending, before.gate?.pending);
        assert.deepEqual(restored.members.map(x => [x.seat, x.token, x.name]), before.members.map(x => [x.seat, x.token, x.name]));
        assert(!Object.hasOwn(restored, 'receipts'));
        if (legacy) {
            assert(restored.members.every(m => m.commandSeq === 0 && m.lastReceipt === null));
            assert(restored.members.every(m => m.commandGeneration !== before.members.find(x => x.seat === m.seat).commandGeneration));
        }
        else {
            assert.deepEqual(restored.members, before.members, 'v3 member generations and receipts must survive a restore');
        }
        await verify();
        assert(authority.view(1).members.filter(m => m.online).every(m => m.seat === 1), 'connections must not be restored from disk');
        for (const m of restored.members) if (m.seat !== 1) await authority.setOnline(m.seat, true, m.token);
        if (restored.status === 'playing') {
            assert(restored.paused);
            await submit(1, { kind: 'resume' });
        }
        await verify();
    };
    const tick = async () => {
        now = Math.max(now, authority.snapshot().gate?.releaseAt ?? now);
        await authority.tick();
        await verify();
    };
    await verify();
    for (let seat = 2; seat <= size; seat++) {
        assert.equal(await authority.join(`玩家${seat}·<>&`, hex(100 + seat)), seat);
        await authority.setOnline(seat, true);
        await verify();
    }
    for (let seat = 1; seat <= size; seat++) await submit(seat, { kind: 'ready', value: true });
    await submit(1, { kind: 'chat', text: '准备完成。<标签>只是一段文字。' });
    await submit(1, { kind: 'mute', seat: size, value: true });
    await submit(1, { kind: 'mute', seat: size, value: false });
    await restore();
    await submit(1, { kind: 'start' });
    return { get authority() { return authority; }, verify, submit, restore, tick, seen, phases, actions };
}

function choice(state, actor, prompt) {
    const base = { kind: 'play', serial: state.game.stepSerial };
    if (prompt.kind === 'ack') return { ...base, move: 'ack' };
    if (prompt.kind === 'skill') return { ...base, move: 'skill', targets: prompt.candidates.slice(0, prompt.targetCount) };
    // Keep the first day peaceful so every public phase and its private slots
    // are exercised before deliberately choosing legal eliminations later.
    if (state.game.day === 1 && prompt.canAbstain) return { ...base, move: 'vote', target: null };
    const livingYoukai = prompt.candidates.find(n => {
        const p = state.game.players.find(x => x.seat === n);
        return faction(p.role) === 'youkai' && p.role !== 'oni';
    });
    return { ...base, move: 'vote', target: livingYoukai ?? prompt.candidates[0] };
}

async function step(r, choose = choice) {
    const state = r.authority.snapshot();
    assert.equal(state.status, 'playing');
    if (['day.discuss', 'day.lastWords'].includes(state.game.step)) {
        await r.submit(1, { kind: 'advance' });
    }
    else {
        for (const actor of pendingActors(state.game)) {
            if (r.authority.snapshot().gate.pending[String(actor)]) continue;
            const prompt = promptFor(state.game, actor);
            r.actions.add(prompt.kind);
            await r.submit(actor, choose(state, actor, prompt));
        }
        await r.tick();
    }
    const after = r.authority.snapshot();
    assert(after.status !== 'playing' || after.game.stepSerial > state.game.stepSerial,
        `legal actions should progress ${state.game.step} serial ${state.game.stepSerial}`);
}

for (const size of [6, 8, 10, 12]) {
    test(`${size}-player game: lobby, all phases, durable restore, terminal views and rematch accept v3 DTOs`, async () => {
        const r = await room(size, 83291 + size);
        let transitions = 0, migrated = false;
        while (r.authority.snapshot().status === 'playing' && transitions < 160) {
            const state = r.authority.snapshot();
            // Persist a submitted action as well as the phase boundary. It must
            // still be submitted after restoring either save schema.
            if (!migrated && state.game.step === 'setup.fairies') {
                const actor = pendingActors(state.game)[0];
                await r.submit(actor, choice(state, actor, promptFor(state.game, actor)));
                await r.restore(true);
                migrated = true;
            }
            else if (transitions % 7 === 0) await r.restore();
            await step(r); transitions++;
        }
        assert.equal(r.authority.snapshot().status, 'ended', 'the deterministic legal game must reach a result');
        assert(migrated);
        assert(r.authority.snapshot().game.outcome);
        for (const name of ['setup.god', 'setup.fairies', 'setup.vampire', 'announce', 'day.discuss', 'day.vote', 'sunset.human', 'sunset.tengu', 'midnight.vote', 'dawn.kappa', 'ended'])
            assert(r.seen.has(name), `must visit ${name}`);
        for (const phase of ['子夜', '夜间公告', '白天', '日落', '午夜', '终局']) assert(r.phases.has(phase));
        assert(r.actions.has('ack') && r.actions.has('vote'));
        await r.restore();
        await r.submit(1, { kind: 'rematch' });
        assert.equal(r.authority.snapshot().status, 'lobby');
        for (let seat = 1; seat <= size; seat++) await r.submit(seat, { kind: 'ready', value: true });
        await r.submit(1, { kind: 'start' });
        await r.submit(1, { kind: 'abort' });
        assert.equal(r.authority.snapshot().status, 'aborted');
        assert(r.phases.has('已中止'));
        await r.restore();
    });
}

test('a tied public ballot exposes valid restricted round-two prompts and remains valid after restore', async () => {
    const r = await room(12, 921);
    while (r.authority.snapshot().game.step !== 'day.vote') await step(r);
    const first = r.authority.snapshot();
    const targets = first.game.vote.candidates.slice(0, 2);
    const actors = pendingActors(first.game);
    for (const [index, actor] of actors.entries()) await r.submit(actor, { kind: 'play', serial: first.game.stepSerial, move: 'vote', target: targets[index % 2] });
    await r.restore();
    await r.tick();
    const second = r.authority.snapshot();
    assert.equal(second.game.vote.round, 2);
    assert(second.game.stepSerial > first.game.stepSerial);
    for (const actor of pendingActors(second.game)) assert.deepEqual(r.authority.view(actor).game.action.candidates, targets);
    await r.restore();
    await step(r, (state, actor, prompt) => ({ kind: 'play', serial: state.game.stepSerial, move: 'vote', target: prompt.candidates[0] }));
    assert.equal(r.authority.snapshot().game.step, 'day.lastWords');
    await step(r);
    assert.equal(r.authority.snapshot().game.step, 'sunset.human');
});
