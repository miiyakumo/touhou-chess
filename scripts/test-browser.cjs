// Local integration fixture: real Chromium WebRTC/data channels, DOM, IndexedDB
// and microphone tracks. Only the PeerServer signaling envelope is simulated.
// It deliberately retains registrations on socket loss and omits OPEN on resume.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { WebSocketServer, WebSocket } = require('ws');

const root = path.resolve(__dirname, '..');
const clients = new Map();
const pages = [];
const errors = [];
const signaling = [];
const results = [];
let browser;
let scenario = 'browser launch';
const deadline = setTimeout(() => { console.error('Browser integration exceeded 180 seconds'); process.exit(1); }, 180000);

async function step(name, action) {
    scenario = name;
    await action();
    results.push(name);
    console.log(`PASS ${name}`);
}

(async () => {
    const html = await fs.readFile(path.join(root, 'hx.html'), 'utf8');
    const instrumented = html.replace("load('main.js');", `
const OriginalApp=load('ui/app.js').App;
load('ui/app.js').App=class extends OriginalApp {constructor(){super();globalThis.testApp=this;}};
globalThis.testLoad=load;
load('main.js');`);
    assert.notEqual(instrumented, html, 'test instrumentation must find the generated entry point');
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (!['/hx.html', '/instrumented.html'].includes(url.pathname)) {
            res.writeHead(404).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(url.pathname === '/hx.html' ? html : instrumented);
    });
    const wss = new WebSocketServer({ server, path: '/peerjs', maxPayload: 262144 });
    wss.on('connection', (ws, req) => {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const id = query.get('id'), token = query.get('token');
        const previous = clients.get(id);
        if (!id || !token || query.get('key') !== 'peerjs') {
            ws.send(JSON.stringify({ type: 'INVALID-KEY' }));
            ws.close();
            return;
        }
        if (previous && previous.token !== token) {
            ws.send(JSON.stringify({ type: 'ID-TAKEN' }));
            ws.close();
            return;
        }
        const record = previous ?? { token, opens: 0, resumes: 0, heartbeats: 0 };
        record.ws = ws;
        clients.set(id, record);
        if (previous)
            record.resumes++;
        else {
            record.opens++;
            ws.send(JSON.stringify({ type: 'OPEN' }));
        }
        ws.on('message', raw => {
            const message = JSON.parse(raw.toString());
            if (message.type === 'HEARTBEAT') {
                record.heartbeats++;
                return;
            }
            signaling.push({ source: id, destination: message.dst, type: message.type, connectionId: message.payload?.connectionId });
            const destination = clients.get(message.dst)?.ws;
            if (destination?.readyState === WebSocket.OPEN)
                destination.send(JSON.stringify({ ...message, src: id }));
            else
                ws.send(JSON.stringify({ type: 'EXPIRE', src: message.dst }));
        });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const settings = { host: '127.0.0.1', port, path: '/', secure: false, key: 'peerjs', iceServers: [] };
    try {
        browser = await chromium.launch({
            headless: true,
            ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
            args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
        });
        async function newPage(name, instrument = true) {
            const context = await browser.newContext({ permissions: ['microphone'] });
            await context.addInitScript(() => {
                globalThis.rtcTrace = [];
                const Native = globalThis.RTCPeerConnection;
                globalThis.RTCPeerConnection = class extends Native {
                    constructor(settings) {
                        super(settings);
                        for (const event of ['icegatheringstatechange', 'iceconnectionstatechange', 'connectionstatechange'])
                            this.addEventListener(event, () => rtcTrace.push({ event, gathering: this.iceGatheringState, ice: this.iceConnectionState, state: this.connectionState }));
                        this.addEventListener('icecandidate', e => rtcTrace.push({ event: 'candidate', candidate: e.candidate?.candidate ?? null }));
                    }
                };
            });
            // No public signaling, TURN, fonts, art or other external services.
            await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
            const page = await context.newPage();
            page.setDefaultTimeout(20000);
            page.on('pageerror', error => errors.push({ page: name, message: error.message }));
            pages.push({ name, page });
            await page.goto(origin + (instrument ? '/instrumented.html' : '/hx.html'));
            await page.waitForFunction(() => document.body.dataset.ready === 'true');
            if (instrument)
                await page.evaluate(value => testApp.controller.setSettings(value), settings);
            return page;
        }
        async function joined(name, invite) {
            const page = await newPage(name);
            await page.click('[data-action=tab-join]');
            await page.fill('#nickname', name);
            await page.fill('#invite-input', invite);
            await page.click('#entry-form button[type=submit]');
            await page.waitForFunction(() => testApp.controller.state.mode === 'guest' && testApp.controller.client.connected);
            return page;
        }
        let host, guest, observer, invite, hostId, seat;
        await step('generated standalone page boots without test globals', async () => {
            const page = await newPage('standalone', false);
            assert.match(await page.locator('.help-badge').innerText(), /v0\.4\.1/);
            assert.equal(await page.evaluate(() => typeof globalThis.testLoad), 'undefined');
            await page.context().close();
        });
        await step('host and two guests join over real WebRTC using the normal entry form', async () => {
            host = await newPage('host');
            await host.fill('#nickname', '房主');
            await host.selectOption('#game-size', '6');
            await host.click('#entry-form button[type=submit]');
            await host.waitForFunction(() => testApp.controller.state.mode === 'host');
            invite = await host.evaluate(() => testApp.controller.getInvite());
            hostId = await host.evaluate(() => testApp.controller.peer.id);
            guest = await joined('玩家甲', invite);
            observer = await joined('玩家乙', invite);
            seat = await guest.evaluate(() => testApp.controller.state.view.self);
            assert.equal(seat, 2);
            await host.waitForFunction(() => testApp.controller.state.view.members.length === 3 && testApp.controller.state.view.members.every(m => m.online));
            assert.equal(await guest.evaluate(() => testApp.controller.client.link.rtc.connectionState), 'connected');
        });
        await step('malformed host view is rejected and renderer treats injected markup as text', async () => {
            const payload = '<svg onload="document.documentElement.dataset.auditXss=1">';
            await host.evaluate(({ seat, payload }) => {
                const c = testApp.controller, connection = c.host.seats.get(seat);
                const view = c.authority.view(seat);
                view.chat = [{ seat: payload, name: '测试', text: '不应成为元素', at: Date.now() }];
                connection.link.send({ protocol: testLoad('room/types.js').PROTOCOL, type: 'view', epoch: c.host.epoch, seq: connection.seq + 1, view });
            }, { seat, payload });
            await guest.waitForFunction(() => !!testApp.controller.client.error);
            assert.equal(await guest.evaluate(() => testApp.controller.client.view.chat.length), 0);
            await guest.evaluate(payload => {
                const saved = testApp.controller.state.view;
                const malformed = structuredClone(saved);
                malformed.chat = [{ seat: payload, name: payload, text: payload, at: Date.now() }];
                testApp.controller.state.view = malformed;
                testApp.render();
            }, payload);
            assert.equal(await guest.locator('#app svg[onload]').count(), 0);
            assert.equal(await guest.evaluate(() => document.documentElement.dataset.auditXss), undefined);
            await guest.evaluate(() => testApp.controller.syncGuest());
        });
        await step('chat waits for durable ACK and preserves text edited while the host saves', async () => {
            await host.evaluate(() => {
                const store = testApp.controller.store, save = store.save.bind(store);
                let release;
                const gate = new Promise(resolve => { release = resolve; });
                globalThis.releaseSave = release;
                globalThis.saveWaiting = false;
                let held = false;
                store.save = async data => {
                    if (!held && data.chat.at(-1)?.text === '等待确认的消息') {
                        held = true;
                        globalThis.saveWaiting = true;
                        await gate;
                    }
                    return save(data);
                };
            });
            await guest.fill('#chat-input', '等待确认的消息');
            await guest.locator('#chat-form').evaluate(form => form.requestSubmit());
            await host.waitForFunction(() => globalThis.saveWaiting);
            assert.equal(await guest.inputValue('#chat-input'), '等待确认的消息');
            assert.equal(await guest.evaluate(() => testApp.controller.client.pendingCount), 1);
            await guest.fill('#chat-input', '等待期间写的新草稿');
            await host.evaluate(() => globalThis.releaseSave());
            await guest.waitForFunction(() => testApp.controller.client.pendingCount === 0);
            assert.equal(await guest.inputValue('#chat-input'), '等待期间写的新草稿');
            await guest.locator('#chat-form').evaluate(form => form.requestSubmit());
            await guest.waitForFunction(() => testApp.chatDraft === '' && testApp.controller.client.pendingCount === 0);
            assert.equal(await host.evaluate(() => testApp.controller.authority.snapshot().chat.length), 2);
        });
        await step('a host rejection retains the chat draft and a corrected command still succeeds', async () => {
            await host.evaluate(seat => testApp.controller.submit({ kind: 'mute', seat, value: true }), seat);
            await guest.evaluate(() => { testApp.setChatDraft('被拒绝后仍保留'); testApp.clickAction('chat-send'); });
            await guest.waitForFunction(() => testApp.controller.client.pendingCount === 0 && testApp.controller.client.error.includes('不能发言'));
            assert.equal(await guest.inputValue('#chat-input'), '被拒绝后仍保留');
            await host.evaluate(seat => testApp.controller.submit({ kind: 'mute', seat, value: false }), seat);
            await guest.locator('#chat-form').evaluate(form => form.requestSubmit());
            await guest.waitForFunction(() => testApp.chatDraft === '' && testApp.controller.client.pendingCount === 0);
        });
        await step('signaling resume without OPEN preserves the existing data channel and restarts heartbeat', async () => {
            const connection = clients.get(hostId), beats = connection.heartbeats;
            connection.ws.close(1012, 'half-open fixture');
            await host.waitForFunction(() => testApp.controller.peer.disconnected);
            await observer.evaluate(() => testApp.controller.submit({ kind: 'chat', text: '信令断开时数据通道仍然可用' }));
            assert.equal(await host.evaluate(() => testApp.controller.authority.snapshot().chat.at(-1).text), '信令断开时数据通道仍然可用');
            await host.waitForFunction(() => !testApp.controller.peer.disconnected && !testApp.controller.state.signalWarning);
            assert.equal(connection.opens, 1);
            assert.ok(connection.resumes >= 1);
            await host.waitForFunction(() => testApp.controller.peer.heartbeat !== null);
            const limit = Date.now() + 7000;
            while (connection.heartbeats <= beats && Date.now() < limit)
                await new Promise(resolve => setTimeout(resolve, 100));
            assert.ok(connection.heartbeats > beats, 'heartbeat must reach the resumed signaling socket');
            assert.equal(await guest.evaluate(() => testApp.controller.client.connected), true);
        });
        await step('lost ACK survives a data-channel reconnect and is never applied twice', async () => {
            await host.evaluate(seat => {
                const connection = testApp.controller.host.seats.get(seat), send = connection.link.send.bind(connection.link);
                globalThis.ackDropped = false;
                connection.link.send = message => {
                    if (message.type === 'ack' && !globalThis.ackDropped) {
                        globalThis.ackDropped = true;
                        return;
                    }
                    send(message);
                };
            }, seat);
            await guest.fill('#chat-input', '丢失回执后只执行一次');
            await guest.locator('#chat-form').evaluate(form => form.requestSubmit());
            await host.waitForFunction(() => globalThis.ackDropped);
            assert.equal(await guest.evaluate(() => testApp.controller.client.pendingCount), 1);
            const oldLink = await guest.evaluate(() => testApp.controller.client.link.id);
            await guest.evaluate(() => testApp.controller.client.link.close());
            await guest.waitForFunction(id => testApp.controller.client.connected && testApp.controller.client.link.id !== id && testApp.controller.client.pendingCount === 0 && testApp.chatDraft === '', oldLink);
            assert.equal(await guest.evaluate(() => testApp.controller.state.view.self), seat);
            assert.equal(await host.evaluate(() => testApp.controller.authority.snapshot().chat.filter(m => m.text === '丢失回执后只执行一次').length), 1);
        });
        let replacement;
        const activeGuests = [observer];
        await step('kick stops automatic rejoin and a replacement does not inherit a mute', async () => {
            await host.evaluate(async seat => {
                await testApp.controller.submit({ kind: 'mute', seat, value: true });
                await testApp.controller.submit({ kind: 'kick', seat });
            }, seat);
            await guest.waitForFunction(() => testApp.controller.client.kicked && !testApp.controller.client.connected);
            assert.equal(await guest.evaluate(() => testApp.controller.reconnectTimer), null);
            replacement = await joined('新玩家', invite);
            activeGuests.push(replacement);
            assert.equal(await replacement.evaluate(() => testApp.controller.state.view.self), seat);
            assert.equal(await replacement.evaluate(() => testApp.controller.state.view.voice.muted.includes(testApp.controller.state.view.self)), false);
            for (const name of ['玩家丙', '玩家丁', '玩家戊'])
                activeGuests.push(await joined(name, invite));
            assert.equal(await host.evaluate(() => testApp.controller.authority.snapshot().members.length), 6);
            assert.equal(await guest.evaluate(() => testApp.controller.client.kicked && testApp.controller.reconnectTimer === null && !testApp.controller.connecting), true);
        });
        await step('real microphone acquired after stop is ended and cannot reattach', async () => {
            const result = await replacement.evaluate(async () => {
                const voice = testApp.controller.voice;
                await voice.mic();
                if (!voice.state.mic)
                    throw Error(voice.state.error || 'initial microphone did not start');
                const originalStream = voice.microphone;
                const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                let called, release, lateStream;
                const entered = new Promise(resolve => { called = resolve; });
                const gate = new Promise(resolve => { release = resolve; });
                navigator.mediaDevices.getUserMedia = async options => {
                    called();
                    await gate;
                    lateStream = await original(options);
                    return lateStream;
                };
                try {
                    const pending = voice.mic();
                    await entered;
                    voice.stopMic();
                    release();
                    await pending;
                    return { mic: voice.state.mic, starting: voice.starting, attached: !!voice.microphone,
                        oldEnded: originalStream.getTracks().every(t => t.readyState === 'ended'),
                        lateEnded: lateStream.getTracks().every(t => t.readyState === 'ended') };
                } finally {
                    navigator.mediaDevices.getUserMedia = original;
                }
            });
            assert.deepEqual(result, { mic: false, starting: false, attached: false, oldEnded: true, lateEnded: true });
        });
        await step('six players start a game and receive valid private views', async () => {
            for (const page of [host, ...activeGuests])
                await page.evaluate(() => testApp.controller.submit({ kind: 'ready', value: true }));
            await host.evaluate(() => testApp.controller.submit({ kind: 'start' }));
            for (const page of [host, ...activeGuests]) {
                await page.waitForFunction(() => testApp.controller.state.view?.status === 'playing' && !!testApp.controller.state.view.game);
                assert.equal(await page.evaluate(() => testApp.controller.state.view.game.self.seat === testApp.controller.state.view.self), true);
                assert.equal(await page.evaluate(() => Object.hasOwn(testApp.controller.state.view, 'receipts')), false);
            }
        });
        await step('IndexedDB host restore and updated invitations reconnect all original seats', async () => {
            const before = await Promise.all(activeGuests.map(page => page.evaluate(() => ({ seat: testApp.controller.state.view.self, generation: testApp.controller.state.view.commandGeneration }))));
            await host.evaluate(() => testApp.controller.close());
            await host.evaluate(() => testApp.controller.restore());
            await host.waitForFunction(() => testApp.controller.state.mode === 'host');
            const newInvite = await host.evaluate(() => testApp.controller.getInvite());
            assert.notEqual(newInvite, invite, 'retained signaling ID forces the restored host to issue an updated invitation');
            for (const page of activeGuests)
                await page.evaluate(link => testApp.controller.updateInvitation(link), newInvite);
            await host.waitForFunction(() => testApp.controller.state.view.members.every(m => m.online));
            assert.equal(await host.evaluate(() => testApp.controller.state.view.paused), true);
            const after = await Promise.all(activeGuests.map(page => page.evaluate(() => ({ seat: testApp.controller.state.view.self, generation: testApp.controller.state.view.commandGeneration }))));
            assert.deepEqual(after, before);
            await host.evaluate(() => testApp.controller.submit({ kind: 'resume' }));
            for (const page of activeGuests)
                await page.waitForFunction(() => !testApp.controller.state.view.paused && testApp.controller.client.connected);
        });
        await step('room shutdown releases peers, listeners and pending attempts', async () => {
            for (const page of [guest, ...activeGuests, host]) {
                await page.evaluate(() => testApp.controller.close());
                assert.equal(await page.evaluate(() => testApp.controller.peer === null && testApp.controller.connectionAttempt === null && !testApp.controller.connecting && testApp.controller.state.mode === 'home'), true);
            }
        });
        assert.deepEqual(errors, [], 'no uncaught browser errors');
        console.log(`Browser integration: ${results.length} scenarios passed (${await browser.version()})`);
    } catch (error) {
        const output = path.join(root, 'output/browser');
        await fs.mkdir(output, { recursive: true });
        for (const { name, page } of pages) {
            if (!page.isClosed()) {
                const state = await page.evaluate(() => ({ rtcTrace: globalThis.rtcTrace, state: globalThis.testApp?.controller.state })).catch(() => null);
                await fs.writeFile(path.join(output, name + '.json'), JSON.stringify(state, null, 2));
                await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true }).catch(() => {});
                await fs.writeFile(path.join(output, name + '.html'), await page.content()).catch(() => {});
            }
        }
        await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ scenario, passed: results, errors, signaling, error: error.stack }, null, 2));
        throw error;
    } finally {
        await browser?.close();
        for (const ws of wss.clients)
            ws.terminate();
        wss.close();
        await new Promise(resolve => server.close(resolve));
    }
})().then(() => clearTimeout(deadline), error => {
    clearTimeout(deadline);
    console.error(`FAIL ${scenario}:`, error);
    process.exitCode = 1;
});
