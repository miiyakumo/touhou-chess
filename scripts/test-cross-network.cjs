'use strict';

// Run the two roles on independent machines, with invitation.json transferred
// out of band. This probe uses the deployed page, its public PeerServer and its
// Google STUN configuration unchanged. It does not simulate signaling or NAT.
// Only disposable test-room data and Chromium's synthetic microphone are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash } = require('node:crypto');

const role = process.argv[2];
if (!['host', 'guest'].includes(role)) {
    console.error('Usage: node scripts/test-cross-network.cjs host|guest');
    process.exit(2);
}
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/cross-network');
const target = process.env.RLS_TEST_URL || 'https://miiyakumo.github.io/touhou-chess/hx';
const runId = process.env.RLS_TEST_RUN || 'manual';
const started = Date.now();
const maxDuration = role === 'host' ? 360000 : 140000;
const hash = value => createHash('sha256').update(value).digest('hex');
const markers = Object.fromEntries(['guestHello', 'hostHello', 'guestDone', 'hostDone', 'guestFinal']
    .map(key => [key, `cross-net-${hash(runId).slice(0, 16)}-${key}`]));
const result = {
    ok: false, role, startedAt: new Date(started).toISOString(), runId,
    runner: {
        platform: process.platform, arch: process.arch, node: process.version,
        osRelease: os.release(), hostnameHash: hash(os.hostname()),
        runnerOS: process.env.RUNNER_OS || null, runnerArch: process.env.RUNNER_ARCH || null,
        imageOS: process.env.ImageOS || null, imageVersion: process.env.ImageVersion || null,
        workflowRun: process.env.GITHUB_RUN_ID || null, workflowAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
        workflowJob: process.env.GITHUB_JOB || null, commit: process.env.GITHUB_SHA || null,
    },
    page: { url: target }, checks: [], audio: { attempted: false },
    signaling: [], pageErrors: [], requestFailures: [], transportSamples: [],
};
let browser, page, phase = 'initialization', stopping = false;
const secrets = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeText(value) {
    let text = String(value || '');
    for (const secret of secrets)
        if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/RLS4:[A-Za-z0-9_-]+/g, '[redacted-invitation]')
        .replace(/([?&](?:token|id|key)=)[^&\s)]+/g, '$1[redacted]')
        .replace(/\b[a-f0-9]{32}\b/gi, '[redacted-id]').slice(0, 1800);
}
function safeUrl(value) {
    try { const u = new URL(value); return u.origin + u.pathname; }
    catch { return '[invalid URL]'; }
}
function boundedPush(array, value, max = 300) {
    if (array.length < max) array.push(value);
}
function addressInfo(value) {
    if (!value) return { addressHash: null, addressScope: 'unavailable', addressFamily: 0 };
    const address = String(value).toLowerCase();
    const family = net.isIP(address);
    let scope = 'unknown';
    if (family === 4) {
        const [a, b] = address.split('.').map(Number);
        scope = a === 127 ? 'loopback'
            : a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ? 'private'
            : a === 100 && b >= 64 && b <= 127 ? 'shared-cgnat'
            : a === 169 && b === 254 ? 'link-local'
            : a === 0 ? 'unspecified' : a >= 224 ? 'multicast-or-reserved' : 'public';
    } else if (family === 6) {
        scope = address === '::1' ? 'loopback' : address === '::' ? 'unspecified'
            : /^(fc|fd)/.test(address) ? 'private'
            : /^fe[89ab]/.test(address) ? 'link-local'
            : /^ff/.test(address) ? 'multicast' : 'public';
    } else if (address.endsWith('.local')) scope = 'mdns';
    return { addressHash: hash(address), addressScope: scope, addressFamily: family };
}
function sanitizeCandidate(candidate) {
    if (!candidate) return null;
    const { address, relatedAddress, ...rest } = candidate;
    return { ...rest, ...addressInfo(address), relatedAddress: addressInfo(relatedAddress) };
}
async function writeJson(name, value) {
    await fs.mkdir(output, { recursive: true });
    const temporary = path.join(output, name + '.tmp');
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temporary, path.join(output, name));
}
function checkpoint(name) {
    if (stopping) throw Error('Probe deadline reached');
    phase = name;
    console.log(`CROSS_NETWORK_PROGRESS ${role} ${name}`);
}
async function publicEgress() {
    const errors = [];
    for (const url of ['https://api.ipify.org', 'https://checkip.amazonaws.com']) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
            assert.equal(response.ok, true, 'public IP endpoint returned an error');
            const address = (await response.text()).trim();
            assert.ok(net.isIP(address), 'public IP endpoint did not return an IP');
            return { source: url, ...addressInfo(address), measuredAt: new Date().toISOString(), errors };
        } catch (error) { errors.push({ source: url, error: safeText(error.message) }); }
    }
    return { addressHash: null, addressScope: 'unavailable', errors };
}

async function createMicrophoneWave() {
    const sampleRate = 48000, seconds = 8, samples = sampleRate * seconds;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    let phase = 0, squareSum = 0, peak = 0;
    for (let i = 0; i < samples; i++) {
        const t = i / sampleRate;
        // Voiced, syllable-like harmonic bursts vary in pitch and loudness so
        // this is not the stationary pure tone commonly suppressed as noise.
        const frequency = (role === 'host' ? 175 : 213)
            + 34 * Math.sin(2 * Math.PI * 0.73 * t) + 17 * Math.sin(2 * Math.PI * 1.91 * t);
        phase += 2 * Math.PI * frequency / sampleRate;
        const syllable = 0.22 + 0.78 * Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 3.4 * t), 0.7);
        const inflection = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.41 * t) ** 2;
        const fade = Math.min(1, t / 0.04, (seconds - t) / 0.04);
        const carrier = (Math.sin(phase) + 0.55 * Math.sin(2 * phase)
            + 0.3 * Math.sin(3 * phase) + 0.2 * Math.sin(5 * phase)) / 2.05;
        const pcm = Math.round(32767 * 0.42 * syllable * inflection * fade * carrier);
        wav.writeInt16LE(pcm, 44 + i * 2);
        const value = pcm / 32768;
        squareSum += value * value;
        peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(squareSum / samples);
    assert.ok(rms > 0.01 && peak < 0.9, 'microphone fixture must contain moderate nonzero PCM');
    const file = path.join(output, `${role}-tone.wav`);
    await fs.writeFile(file, wav);
    result.audio.input = { kind: 'known-nonzero-file', file: `${role}-tone.wav`,
        format: 'PCM16 little-endian', sampleRate, channels: 1, seconds,
        loop: true, rms, peak, sha256: hash(wav),
        description: 'Time-varying pitch and amplitude with voiced harmonics; read by Chromium fake microphone.' };
    return file;
}

// Installed before the application's scripts. No ICE server, SDP, candidate,
// timer or transport state is changed by this observer.
function installRTCObserver() {
    globalThis.crossNetworkPCs = [];
    globalThis.crossNetworkTrace = [];
    globalThis.crossNetworkHistory = [];
    const Native = globalThis.RTCPeerConnection;
    const emit = value => {
        if (globalThis.crossNetworkTrace.length < 600)
            globalThis.crossNetworkTrace.push({ at: Date.now(), ...value });
    };
    globalThis.RTCPeerConnection = class extends Native {
        constructor(configuration) {
            super(configuration);
            const index = globalThis.crossNetworkPCs.push(this) - 1;
            const states = () => ({ index, gathering: this.iceGatheringState,
                ice: this.iceConnectionState, connection: this.connectionState, signaling: this.signalingState });
            const history = { index, createdAt: Date.now(), closedAt: null, beforeClose: null, snapshots: [] };
            globalThis.crossNetworkHistory[index] = history;
            const aliases = new Map();
            const alias = id => {
                if (!id) return null;
                if (!aliases.has(id)) aliases.set(id, `stat-${aliases.size + 1}`);
                return aliases.get(id);
            };
            const candidate = c => ({ id: alias(c.id), side: c.type,
                candidateType: c.candidateType, address: c.address || c.ip, port: c.port,
                protocol: c.protocol, networkType: c.networkType, tcpType: c.tcpType,
                relayProtocol: c.relayProtocol, url: c.url,
                relatedAddress: c.relatedAddress, relatedPort: c.relatedPort });
            let timer = null, sampling = false;
            const stopSampling = () => { if (timer !== null) clearInterval(timer); timer = null; };
            const sample = async reason => {
                if (history.snapshots.length >= 120) { stopSampling(); return; }
                if (sampling) return;
                if (this.connectionState === 'closed') {
                    history.closedAt ??= Date.now();
                    stopSampling();
                    return;
                }
                sampling = true;
                // Preserve the states at request time: the application may call
                // close synchronously while this read-only getStats is pending.
                const transportState = transport => transport ? {
                    dtls: transport.state,
                    ice: transport.iceTransport?.state,
                    gathering: transport.iceTransport?.gatheringState,
                    role: transport.iceTransport?.role,
                } : null;
                const snapshot = { at: Date.now(), reason, ...states(), pairs: [], candidates: [], transports: [],
                    sctp: this.sctp ? { state: this.sctp.state, transport: transportState(this.sctp.transport) } : null,
                    mediaTransports: this.getTransceivers().map(t => ({ mid: t.mid,
                        sender: transportState(t.sender.transport), receiver: transportState(t.receiver.transport) })),
                };
                history.snapshots.push(snapshot);
                try {
                    const stats = await this.getStats();
                    const all = [...stats.values()];
                    const selected = new Set(all.filter(x => x.type === 'transport' && x.selectedCandidatePairId)
                        .map(x => x.selectedCandidatePairId));
                    snapshot.pairs = all.filter(x => x.type === 'candidate-pair').map(p => ({
                        id: alias(p.id), localCandidateId: alias(p.localCandidateId), remoteCandidateId: alias(p.remoteCandidateId),
                        state: p.state, nominated: p.nominated, selected: !!p.selected || selected.has(p.id),
                        selectedByTransport: selected.has(p.id),
                        requestsSent: p.requestsSent, requestsReceived: p.requestsReceived,
                        responsesSent: p.responsesSent, responsesReceived: p.responsesReceived,
                        bytesSent: p.bytesSent, bytesReceived: p.bytesReceived,
                        currentRoundTripTime: p.currentRoundTripTime, totalRoundTripTime: p.totalRoundTripTime,
                    }));
                    snapshot.candidates = all.filter(x => ['local-candidate', 'remote-candidate'].includes(x.type)).map(candidate);
                    snapshot.transports = all.filter(x => x.type === 'transport').map(t => ({
                        id: alias(t.id), dtlsState: t.dtlsState, iceState: t.iceState, iceRole: t.iceRole,
                        selectedCandidatePairId: alias(t.selectedCandidatePairId),
                        selectedCandidatePairChanges: t.selectedCandidatePairChanges,
                        bytesSent: t.bytesSent, bytesReceived: t.bytesReceived,
                    }));
                } catch (error) { snapshot.error = error.message; }
                finally {
                    snapshot.collectedAt = Date.now();
                    snapshot.connectionAtCollection = this.connectionState;
                    sampling = false;
                    if (history.snapshots.length >= 120 || this.connectionState === 'closed') stopSampling();
                }
            };
            // These are probe-only observation hooks. The native close happens
            // synchronously, without waiting for stats or changing app timers.
            const nativeClose = this.close.bind(this);
            this.close = (...args) => {
                history.beforeClose ??= { at: Date.now(), ...states(),
                    latestSnapshotAt: history.snapshots.at(-1)?.at ?? null };
                void sample('before-close');
                try { return nativeClose(...args); }
                finally {
                    history.closedAt ??= Date.now();
                    stopSampling();
                    emit({ event: 'native-close', ...states() });
                }
            };
            emit({ event: 'created', ...states() });
            for (const event of ['icegatheringstatechange', 'iceconnectionstatechange', 'connectionstatechange', 'signalingstatechange'])
                this.addEventListener(event, () => {
                    emit({ event, ...states() });
                    void sample(event);
                });
            this.addEventListener('icecandidate', event => {
                const c = event.candidate;
                emit({ event: 'icecandidate', index, candidate: c ? {
                    candidateType: c.type, address: c.address, port: c.port,
                    protocol: c.protocol, tcpType: c.tcpType,
                    relatedAddress: c.relatedAddress, relatedPort: c.relatedPort,
                } : null });
            });
            this.addEventListener('icecandidateerror', event => emit({
                event: 'icecandidateerror', index, address: event.address, port: event.port,
                url: event.url, errorCode: event.errorCode, errorText: event.errorText,
            }));
            timer = setInterval(() => { void sample('interval'); }, 750);
            void sample('created');
        }
    };
}

async function browserEvidence() {
    if (!page || page.isClosed()) return null;
    const raw = await page.evaluate(async () => {
        const candidate = c => c ? {
            candidateType: c.candidateType, address: c.address || c.ip, port: c.port,
            protocol: c.protocol, networkType: c.networkType, tcpType: c.tcpType,
            relayProtocol: c.relayProtocol, url: c.url,
            relatedAddress: c.relatedAddress, relatedPort: c.relatedPort,
        } : null;
        const connections = await Promise.all((globalThis.crossNetworkPCs || []).map(async (pc, index) => {
            try {
                const stats = await pc.getStats();
                const all = [...stats.values()];
                const ids = new Set(all.filter(x => x.type === 'transport' && x.selectedCandidatePairId)
                    .map(x => x.selectedCandidatePairId));
                const pairs = all.filter(x => x.type === 'candidate-pair' &&
                    (ids.has(x.id) || x.selected || x.nominated && x.state === 'succeeded'));
                return {
                    index, connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
                    iceGatheringState: pc.iceGatheringState, signalingState: pc.signalingState,
                    iceServers: (pc.getConfiguration().iceServers || []).map(s => ({ urls: s.urls })),
                    selectedPairs: pairs.map(p => ({ state: p.state, nominated: p.nominated,
                        selectedByTransport: ids.has(p.id), currentRoundTripTime: p.currentRoundTripTime,
                        totalRoundTripTime: p.totalRoundTripTime, bytesSent: p.bytesSent, bytesReceived: p.bytesReceived,
                        requestsSent: p.requestsSent, responsesReceived: p.responsesReceived,
                        local: candidate(stats.get(p.localCandidateId)), remote: candidate(stats.get(p.remoteCandidateId)),
                    })),
                    candidates: all.filter(x => ['local-candidate', 'remote-candidate'].includes(x.type))
                        .map(c => ({ side: c.type, ...candidate(c) })),
                    dataChannels: all.filter(x => x.type === 'data-channel').map(d => ({
                        state: d.state, messagesSent: d.messagesSent, messagesReceived: d.messagesReceived,
                        bytesSent: d.bytesSent, bytesReceived: d.bytesReceived,
                    })),
                    audio: all.filter(x => ['inbound-rtp', 'outbound-rtp', 'remote-inbound-rtp', 'media-source'].includes(x.type)
                        && (x.kind === 'audio' || x.mediaType === 'audio')).map(x => ({
                        direction: x.type, bytesSent: x.bytesSent, bytesReceived: x.bytesReceived,
                        packetsSent: x.packetsSent, packetsReceived: x.packetsReceived, packetsLost: x.packetsLost,
                        jitter: x.jitter, roundTripTime: x.roundTripTime,
                        totalAudioEnergy: x.totalAudioEnergy, audioLevel: x.audioLevel,
                        totalSamplesDuration: x.totalSamplesDuration, totalSamplesReceived: x.totalSamplesReceived,
                        concealedSamples: x.concealedSamples,
                    })),
                };
            } catch (error) { return { index, error: error.message, connectionState: pc.connectionState }; }
        }));
        const c = globalThis.testApp?.controller, s = c?.state;
        const trackState = track => track ? { kind: track.kind, enabled: track.enabled,
            muted: track.muted, readyState: track.readyState } : null;
        const inputAnalysis = c ? [...c.voice.inputs.entries()].map(([seat, input]) => {
            const values = new Float32Array(input.analyser.fftSize);
            input.analyser.getFloatTimeDomainData(values);
            const rms = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);
            const sourceStream = input.source.mediaStream;
            const sourceTracks = sourceStream?.getAudioTracks() || [];
            const endpoint = c.voice.endpoints.get(seat);
            const receiverTracks = (endpoint?.link.rtc?.getReceivers() || [])
                .map(receiver => receiver.track).filter(track => track.kind === 'audio');
            return { seat, self: seat === s.view?.self, rms, gain: input.gain.gain.value,
                sourceIsMicrophoneStream: !!sourceStream && sourceStream === c.voice.microphone,
                sourceMatchesEndpointRemoteStream: !!sourceStream && !!endpoint
                    && sourceStream === endpoint.link.remoteAudio,
                sourceMatchesReceiverTracks: sourceTracks.length > 0
                    && sourceTracks.every(track => receiverTracks.includes(track)),
                sourceTrackCount: sourceTracks.length, receiverTrackCount: receiverTracks.length,
                endpointPeerConnectionIndex: endpoint ? globalThis.crossNetworkPCs.indexOf(endpoint.link.rtc) : null,
            };
        }) : [];
        const boundSenders = c ? [...c.voice.endpoints.entries()].map(([seat, endpoint]) => {
            const pc = endpoint.link.rtc, destinationTracks = endpoint.destination?.stream.getAudioTracks() || [];
            return { seat, peerConnectionIndex: globalThis.crossNetworkPCs.indexOf(pc),
                destinationTracks: destinationTracks.map(trackState),
                transceivers: (pc?.getTransceivers() || []).filter(t =>
                    t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio').map(t => ({
                    direction: t.direction, currentDirection: t.currentDirection,
                    senderTrack: trackState(t.sender.track), receiverTrack: trackState(t.receiver.track),
                    senderIsDestinationTrack: destinationTracks.includes(t.sender.track),
                })),
            };
        }) : [];
        return { at: Date.now(), trace: globalThis.crossNetworkTrace || [], connections,
            history: globalThis.crossNetworkHistory || [],
            app: s ? { mode: s.mode, connected: s.connected, pending: s.pending,
                clientPending: c.client?.pendingCount ?? null, error: s.error,
                signalWarning: s.signalWarning, clientError: c.client?.error || '',
                signalConnected: !!c.peer && !c.peer.disconnected,
                members: s.view?.members.map(m => ({ seat: m.seat, online: m.online })) || [],
                voice: { enabled: c.voice.state.enabled, mic: c.voice.state.mic,
                    openMic: c.voice.state.openMic, allowed: c.voice.state.allowed,
                    peers: c.voice.state.peers, error: c.voice.state.error,
                    audioContext: c.voice.context ? { state: c.voice.context.state, currentTime: c.voice.context.currentTime } : null,
                    microphoneTracks: (c.voice.microphone?.getAudioTracks() || []).map(trackState),
                    inputAnalysis, boundSenders },
            } : null,
        };
    });
    for (const event of raw.trace) {
        if ('candidate' in event) event.candidate = sanitizeCandidate(event.candidate);
        if ('address' in event) {
            Object.assign(event, addressInfo(event.address));
            delete event.address;
        }
        if (event.errorText) event.errorText = safeText(event.errorText);
    }
    for (const connection of raw.connections) {
        if (connection.error) connection.error = safeText(connection.error);
        connection.candidates = connection.candidates?.map(sanitizeCandidate);
        for (const pair of connection.selectedPairs || []) {
            pair.local = sanitizeCandidate(pair.local);
            pair.remote = sanitizeCandidate(pair.remote);
        }
    }
    for (const history of raw.history) {
        for (const snapshot of history.snapshots) {
            snapshot.candidates = snapshot.candidates.map(sanitizeCandidate);
            if (snapshot.error) snapshot.error = safeText(snapshot.error);
        }
    }
    if (raw.app) {
        for (const key of ['error', 'signalWarning', 'clientError']) raw.app[key] = safeText(raw.app[key]);
        raw.app.voice.error = safeText(raw.app.voice.error);
    }
    return raw;
}

async function waitForChat(marker, timeout) {
    await page.waitForFunction(text => globalThis.testApp?.controller.state.view?.chat.some(x => x.text === text),
        marker, { timeout });
}
async function waitForGuestHello(marker, timeout) {
    const handle = await page.waitForFunction(text => {
        const s = globalThis.testApp?.controller.state;
        if (s?.view?.chat.some(x => x.text === text)) return { ok: true };
        const pcs = globalThis.crossNetworkPCs || [];
        // No candidate has arrived yet: keep the original host waiting budget.
        // Once this probe's sole incoming connection is terminal and nobody has
        // joined, waiting five minutes cannot add useful transport evidence.
        if (pcs.length === 1 && !s?.view?.members.some(m => m.seat !== 1)
            && ['failed', 'closed'].includes(pcs[0].connectionState)) {
            return { ok: false, error: `Incoming peer ended before room handshake (${pcs[0].connectionState})` };
        }
        return false;
    }, marker, { timeout, polling: 250 });
    const state = await handle.jsonValue();
    await handle.dispose();
    if (!state.ok) throw Error(state.error);
}
async function waitForGuestJoin(timeout) {
    const handle = await page.waitForFunction(() => {
        const c = globalThis.testApp?.controller, s = c?.state;
        if (s?.mode === 'guest' && c.client?.connected) return { ok: true };
        if (s?.mode === 'home' && !s.busy && s.error)
            return { ok: false, error: s.error };
        return false;
    }, null, { timeout, polling: 250 });
    const state = await handle.jsonValue();
    await handle.dispose();
    if (!state.ok) throw Error(`Room join failed: ${safeText(state.error)}`);
}
async function sendChat(marker) {
    checkpoint('send ' + marker.split('-').at(-1));
    await page.fill('#chat-input', marker);
    await page.locator('#chat-form button[type=submit]').click();
    await page.waitForFunction(text => {
        const c = testApp.controller;
        return c.state.connected && c.state.pending === 0 && (c.client?.pendingCount ?? 0) === 0
            && testApp.chatDraft === '' && c.state.view?.chat.some(x => x.text === text);
    }, marker, { timeout: 15000 });
    result.checks.push({ check: 'chat persisted and acknowledged', marker: marker.split('-').at(-1), ok: true });
}
async function enableSyntheticAudio() {
    result.audio.attempted = true;
    checkpoint('enable synthetic microphone through UI');
    try {
        await page.locator('.voice-panel [data-action=voice-enable]').click({ timeout: 5000 });
        await page.waitForFunction(() => testApp.controller.voice.state.enabled, null, { timeout: 5000 });
        await page.locator('.voice-panel [data-action=voice-mic]').click({ timeout: 5000 });
        await page.waitForFunction(() => testApp.controller.voice.state.mic || !!testApp.controller.voice.state.error,
            null, { timeout: 7000 });
        const mic = await page.evaluate(() => testApp.controller.voice.state.mic);
        if (mic) await page.locator('.voice-panel [data-action=voice-toggle]').click({ timeout: 5000 });
        result.audio.setup = await page.evaluate(() => {
            const s = testApp.controller.voice.state;
            return { enabled: s.enabled, mic: s.mic, openMic: s.openMic, allowed: s.allowed, error: s.error };
        });
        result.audio.setup.error = safeText(result.audio.setup.error);
    } catch (error) { result.audio.setupError = safeText(error.message); }
}
function summarizeAudio(before, after) {
    const total = (sample, direction, key) => (sample?.connections || []).reduce((sum, c) => sum +
        (c.audio || []).filter(x => x.direction === direction).reduce((n, x) => n + (x[key] || 0), 0), 0);
    const sent = total(after, 'outbound-rtp', 'bytesSent') - total(before, 'outbound-rtp', 'bytesSent');
    const received = total(after, 'inbound-rtp', 'bytesReceived') - total(before, 'inbound-rtp', 'bytesReceived');
    const energy = total(after, 'inbound-rtp', 'totalAudioEnergy') - total(before, 'inbound-rtp', 'totalAudioEnergy');
    const hasEnergy = sample => sample?.connections.some(c => c.audio?.some(x =>
        x.direction === 'inbound-rtp' && typeof x.totalAudioEnergy === 'number'));
    const energyMeasured = !!hasEnergy(before) && !!hasEnergy(after);
    const selfRms = sample => sample.app?.voice.inputAnalysis.find(x => x.self)?.rms ?? null;
    const inputObservedNonZero = [selfRms(before), selfRms(after)].some(rms => rms !== null && rms > 0.00001);
    const firstContext = before.app?.voice.audioContext, lastContext = after.app?.voice.audioContext;
    const contextClockAdvanced = !!firstContext && !!lastContext && lastContext.currentTime > firstContext.currentTime;
    const remoteInputs = sample => sample.app?.voice.inputAnalysis.filter(x => !x.self) || [];
    const sourceVerified = input => !!input && input.sourceMatchesEndpointRemoteStream === true
        && input.sourceMatchesReceiverTracks === true && input.sourceIsMicrophoneStream === false;
    const remoteBefore = remoteInputs(before), remoteAfter = remoteInputs(after);
    const receiverSamples = [...new Set([...remoteBefore, ...remoteAfter].map(x => x.seat))].map(seat => {
        const first = remoteBefore.find(x => x.seat === seat), last = remoteAfter.find(x => x.seat === seat);
        const verifiedRms = [first, last].filter(sourceVerified).map(x => x.rms);
        const maxVerifiedRms = verifiedRms.length ? Math.max(...verifiedRms) : null;
        return { seat, rmsBefore: first?.rms ?? null, rmsAfter: last?.rms ?? null,
            sourceVerifiedBefore: sourceVerified(first), sourceVerifiedAfter: sourceVerified(last),
            maxVerifiedRms, observedNonZero: maxVerifiedRms !== null && maxVerifiedRms > 0.00001 };
    });
    const receiverSamplesObservedNonZero = receiverSamples.length > 0 && receiverSamples.every(x => x.observedNonZero);
    const energyBefore = hasEnergy(before) ? total(before, 'inbound-rtp', 'totalAudioEnergy') : null;
    const energyAfter = hasEnergy(after) ? total(after, 'inbound-rtp', 'totalAudioEnergy') : null;
    Object.assign(result.audio, { sampleDurationMs: after.at - before.at, sentBytesDelta: sent,
        receivedBytesDelta: received, receivedAudioEnergyDelta: energy,
        receivedAudioEnergyMeasured: energyMeasured, receivedAudioEnergyBefore: energyBefore,
        receivedAudioEnergyAfter: energyAfter,
        inputRmsBefore: selfRms(before), inputRmsAfter: selfRms(after), inputObservedNonZero,
        contextClockAdvanced, bidirectionalRtp: sent > 0 && received > 0,
        decodedEnergyIncreased: energyMeasured && energy > 0,
        receiverSamples, receiverSamplesObservedNonZero,
        energyMetricZeroDespiteReceiverSamples: receiverSamplesObservedNonZero && energyAfter === 0,
        ok: inputObservedNonZero && contextClockAdvanced && sent > 0 && received > 0 && receiverSamplesObservedNonZero,
        scope: 'Known nonzero WAV through normal microphone/UI. Nonzero received WebAudio samples must belong to the remote endpoint stream and its RTCRtpReceiver tracks, not the local microphone. Inbound RTP totalAudioEnergy remains an independent diagnostic, including zero or missing values. Human audibility is not measured.' });
}

async function run() {
    await fs.mkdir(output, { recursive: true });
    checkpoint('fetch deployed page and public egress evidence');
    const [deployed, local, egress] = await Promise.all([
        fetch(target, { signal: AbortSignal.timeout(20000), cache: 'no-store' }).then(async response => ({
            status: response.status, url: response.url, bytes: Buffer.from(await response.arrayBuffer()),
        })),
        fs.readFile(path.join(root, 'hx.html')),
        publicEgress(),
    ]);
    result.egress = egress;
    Object.assign(result.page, { status: deployed.status, finalUrl: safeUrl(deployed.url),
        bytes: deployed.bytes.length, sha256: hash(deployed.bytes), repositorySha256: hash(local),
        matchesRepository: deployed.bytes.equals(local) });
    assert.equal(deployed.status, 200, 'deployed page must return HTTP 200');
    assert.equal(result.page.matchesRepository, true, 'deployed page differs from checked-out hx.html');
    const html = deployed.bytes.toString('utf8');
    const entry = "load('main.js');";
    assert.equal(html.split(entry).length, 2, 'exactly one application entry point is required');
    const instrumented = html.replace(entry, `
const OriginalApp=load('ui/app.js').App;
load('ui/app.js').App=class extends OriginalApp {constructor(){super();globalThis.testApp=this;}};
globalThis.testLoad=load;
load('main.js');`);
    checkpoint('launch deployed application with transport observer');
    const { chromium } = require('playwright');
    const microphoneWave = await createMicrophoneWave();
    browser = await chromium.launch({ headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${microphoneWave}`, '--autoplay-policy=no-user-gesture-required'],
    });
    result.browser = browser.version();
    const context = await browser.newContext({ permissions: ['microphone'] });
    await context.addInitScript(installRTCObserver);
    // Keep the actual HTTPS origin. Only the previously verified main document
    // is instrumented; every other URL, including signaling, goes to the network.
    await context.route(url => url.href === target || url.href === deployed.url, route =>
        route.request().isNavigationRequest()
            ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: instrumented })
            : route.continue());
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => boundedPush(result.pageErrors, safeText(error.message)));
    page.on('requestfailed', request => boundedPush(result.requestFailures, {
        url: safeUrl(request.url()), error: safeText(request.failure()?.errorText),
    }));
    page.on('websocket', ws => {
        const url = safeUrl(ws.url());
        boundedPush(result.signaling, { at: Date.now(), event: 'socket-created', url });
        for (const event of ['framesent', 'framereceived']) ws.on(event, frame => {
            let message;
            try { message = JSON.parse(String(frame.payload)); } catch { return; }
            boundedPush(result.signaling, { at: Date.now(), event, url,
                type: typeof message.type === 'string' ? safeText(message.type) : 'unknown',
                payloadType: typeof message.payload?.type === 'string' ? safeText(message.payload.type) : undefined });
        });
        ws.on('socketerror', error => boundedPush(result.signaling, { at: Date.now(), event: 'socket-error', url, error: safeText(error) }));
        ws.on('close', () => boundedPush(result.signaling, { at: Date.now(), event: 'socket-closed', url }));
    });
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    result.configuration = await page.evaluate(() => {
        const s = testApp.controller.settings, types = testLoad('room/types.js');
        return { version: types.APP_VERSION, protocol: types.PROTOCOL,
            signal: { host: s.host ?? '0.peerjs.com', port: s.port ?? 443, path: s.path ?? '/',
                secure: s.secure !== false, key: s.key ?? 'peerjs' },
            iceServers: s.iceServers.map(x => ({ urls: x.urls })),
        };
    });
    assert.deepEqual(result.configuration.signal, { host: '0.peerjs.com', port: 443, path: '/', secure: true, key: 'peerjs' });
    assert.deepEqual(result.configuration.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
    result.checks.push({ check: 'deployed bytes and unchanged public network defaults', ok: true });

    if (role === 'host') {
        checkpoint('create room through normal entry form');
        await page.fill('#nickname', '跨网测试房主');
        await page.selectOption('#game-size', '6');
        await page.click('#entry-form button[type=submit]');
        await page.waitForFunction(() => testApp.controller.state.mode === 'host' && testApp.controller.state.connected,
            null, { timeout: 30000 });
        const invite = await page.evaluate(() => testApp.controller.getInvite());
        secrets.push(invite);
        await enableSyntheticAudio();
        await writeJson('invitation.json', { runId, invite, createdAt: new Date().toISOString(),
            pageSha256: result.page.sha256, markers });
        await writeJson('host-ready.json', { ok: true, role, runId, readyAt: new Date().toISOString(),
            page: result.page, runner: result.runner, egress: result.egress, configuration: result.configuration });
        checkpoint('host ready; waiting for independently hosted guest');
        await waitForGuestHello(markers.guestHello, Math.max(1000, started + maxDuration - Date.now() - 35000));
        result.checks.push({ check: 'guest joined and its first chat reached host view', ok: true });
        await sendChat(markers.hostHello);
        const before = await browserEvidence();
        result.transportSamples.push(before);
        await waitForChat(markers.guestDone, 45000);
        const after = await browserEvidence();
        result.transportSamples.push(after);
        summarizeAudio(before, after);
        await sendChat(markers.hostDone);
        await waitForChat(markers.guestFinal, 20000);
        result.checks.push({ check: 'guest confirmed both host messages and completed its ACK checks', ok: true });
        // Allow the final durable ACK to reach the guest before ending the host.
        await delay(1500);
    } else {
        const invitation = JSON.parse(await fs.readFile(path.join(output, 'invitation.json'), 'utf8'));
        assert.equal(invitation.runId, runId, 'invitation belongs to a different probe run');
        assert.equal(invitation.pageSha256, result.page.sha256, 'host and guest deployed page hashes differ');
        assert.deepEqual(invitation.markers, markers, 'host and guest marker sets differ');
        assert.equal(typeof invitation.invite, 'string');
        secrets.push(invitation.invite);
        checkpoint('join remote host through normal entry form');
        await page.click('[data-action=tab-join]');
        await page.fill('#nickname', '跨网测试玩家');
        await page.fill('#invite-input', invitation.invite);
        await page.click('#entry-form button[type=submit]');
        await waitForGuestJoin(90000);
        result.checks.push({ check: 'room handshake completed on remote host', ok: true });
        await sendChat(markers.guestHello);
        await waitForChat(markers.hostHello, 20000);
        result.checks.push({ check: 'host chat synchronized to guest view', ok: true });
        await enableSyntheticAudio();
        const before = await browserEvidence();
        result.transportSamples.push(before);
        await delay(3500);
        const after = await browserEvidence();
        result.transportSamples.push(after);
        summarizeAudio(before, after);
        await sendChat(markers.guestDone);
        await waitForChat(markers.hostDone, 20000);
        await sendChat(markers.guestFinal);
        result.checks.push({ check: 'both directions synchronized and final guest command durably acknowledged', ok: true });
    }
    assert.ok(result.transportSamples.some(s => s?.connections.some(c => c.selectedPairs?.some(p =>
        p.state === 'succeeded' && p.bytesSent > 0 && p.bytesReceived > 0))), 'no successful selected ICE pair with bidirectional traffic');
    assert.equal(result.pageErrors.length, 0, 'uncaught page errors occurred');
    result.ok = true;
    checkpoint('data and application ACK verification complete');
}

(async () => {
    let timer;
    try {
        await Promise.race([run(), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error(`Probe exceeded ${maxDuration / 1000 - 12} seconds before cleanup`)), maxDuration - 12000);
        })]);
    } catch (error) {
        stopping = true;
        result.failure = { phase, error: safeText(error.message) };
        console.error(`CROSS_NETWORK_FAILURE ${role} ${phase}: ${safeText(error.message)}`);
    } finally {
        clearTimeout(timer);
        stopping = true;
        try {
            result.finalEvidence = await Promise.race([browserEvidence(), delay(5000).then(() => ({ error: 'diagnostics timeout' }))]);
        } catch (error) { result.diagnosticsError = safeText(error.message); }
        if (browser) {
            try { await Promise.race([browser.close(), delay(5000)]); }
            catch (error) { result.closeError = safeText(error.message); }
        }
        result.finishedAt = new Date().toISOString();
        result.durationMs = Date.now() - started;
        await writeJson(`${role}-result.json`, result);
        // One machine-readable result line. No invitation, room identity, token,
        // full SDP or raw candidate IP is included in logs or result JSON.
        console.log('CROSS_NETWORK_RESULT ' + JSON.stringify(result));
        process.exitCode = result.ok ? 0 : 1;
    }
})().catch(async error => {
    result.ok = false;
    result.failure = { phase: 'result finalization', error: safeText(error.message) };
    try { await writeJson(`${role}-result.json`, result); } catch { /* stdout is the fallback artifact */ }
    console.log('CROSS_NETWORK_RESULT ' + JSON.stringify(result));
    process.exitCode = 1;
});
