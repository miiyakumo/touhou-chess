"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoiceRoom = void 0;
/** One RTC peer connection per guest. The host sends a separate mix-minus-self
 * stream to each guest. No room recording and no raw microphone data on signaling.
 * Room-authoritative speaker lists gate both microphone and host forwarding. */
class VoiceRoom {
    changed;
    state = { speaking: [], enabled: false, mic: false, openMic: false, holding: false, allowed: false, reason: '尚未加入房间', error: '', peers: 0, level: 0, volume: 0.8, deviceId: '', devices: [] };
    context = null;
    monitor = null;
    lastSpeak = new Map();
    endpoints = new Map();
    inputs = new Map();
    microphone = null;
    view = null;
    monitorStream = null;
    audio = null;
    meter = null;
    disposed = false;
    starting = false;
    micGeneration = 0;
    closePromise = null;
    offVisibility;
    constructor(changed) {
        this.changed = changed;
        const release = () => this.hold(false);
        const visibility = () => { if (document.hidden)
            release(); };
        window.addEventListener('blur', release);
        document.addEventListener('visibilitychange', visibility);
        this.offVisibility = () => { window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', visibility); };
    }
    update(view, connected = true) {
        this.view = view;
        this.state.speaking = this.state.speaking.filter(n => connected && !!view?.voice.speakers.includes(n));
        this.state.allowed = !!view && connected && view.voice.speakers.includes(view.self);
        this.state.reason = !connected ? '与房主连接中断' : view?.voice.reason ?? '尚未加入房间';
        if (!this.state.allowed)
            this.state.holding = false;
        this.applyGates();
    }
    bind(link, seat) {
        if (this.disposed || !link.rtc)
            return;
        const old = this.endpoints.get(seat);
        if (old?.link === link)
            return;
        if (old)
            this.remove(seat);
        const ep = { link, seat, destination: null, decoder: null, off: () => { } };
        this.endpoints.set(seat, ep);
        const offAudio = link.onAudio?.(() => { if (this.context)
            this.attach(ep); }) ?? (() => { });
        const offClose = link.onClose(() => { if (this.endpoints.get(seat) === ep)
            this.remove(seat); });
        const offSpeaking = link.onSpeaking?.(seats => { const v = this.view; if (!v || v.isHost || seat !== 1)
            return; const list = seats.filter(n => v.voice.speakers.includes(n)); if (JSON.stringify(list) !== JSON.stringify(this.state.speaking)) {
            this.state.speaking = list;
            this.changed();
        } }) ?? (() => { });
        ep.off = () => { offAudio(); offClose(); offSpeaking(); };
        if (this.context)
            this.attach(ep);
        this.state.peers = this.endpoints.size;
        this.changed();
    }
    remove(seat) {
        const ep = this.endpoints.get(seat);
        if (!ep)
            return;
        ep.off();
        ep.destination?.disconnect();
        ep.destination?.stream.getTracks().forEach(t => t.stop());
        if (ep.decoder) {
            ep.decoder.pause();
            ep.decoder.srcObject = null;
        }
        this.endpoints.delete(seat);
        const input = this.inputs.get(seat);
        input?.source.disconnect();
        input?.gain.disconnect();
        this.inputs.delete(seat);
        this.lastSpeak.delete(seat);
        this.rewire();
        this.state.peers = this.endpoints.size;
        this.changed();
    }
    async enable() {
        if (this.disposed)
            return;
        try {
            if (!this.context) {
                this.context = new AudioContext();
                this.monitor = this.context.createGain();
                this.monitor.gain.value = this.state.volume;
                this.monitorStream = this.context.createMediaStreamDestination();
                this.monitor.connect(this.monitorStream);
                // Keep the audio element outside UI rerenders. play() failure is explicit.
                this.audio = new Audio();
                this.audio.autoplay = true;
                this.audio.setAttribute('playsinline', '');
                this.audio.srcObject = this.monitorStream.stream;
                this.meter = setInterval(() => this.measure(), 200);
            }
            const context = this.context, audio = this.audio;
            await context.resume();
            if (this.disposed)
                return;
            await audio.play();
            if (this.disposed)
                return;
            this.state.enabled = true;
            this.state.error = '';
            for (const ep of this.endpoints.values())
                this.attach(ep);
            this.rewire();
        }
        catch (e) {
            if (this.disposed)
                return;
            this.state.error = '声音尚未启用：' + message(e) + '。请点击“启用声音”重试。';
        }
        this.changed();
    }
    async mic(deviceId) {
        if (this.disposed || this.starting)
            return;
        const generation = ++this.micGeneration;
        const current = () => !this.disposed && this.micGeneration === generation;
        this.starting = true;
        try {
            await this.enable();
            if (!current())
                return;
            if (!this.state.enabled)
                throw Error('请先启用声音。');
            if (!navigator.mediaDevices?.getUserMedia)
                throw Error('浏览器未开放麦克风接口。请使用支持本地文件麦克风的桌面浏览器，或在 HTTPS 页面打开。');
            const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
            const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
            if (!current()) {
                stream.getTracks().forEach(t => t.stop());
                return;
            }
            // Acquiring a device does not grant permission to transmit. Apply the
            // current talk policy before any slower device enumeration awaits.
            stream.getAudioTracks().forEach(t => { t.enabled = false; });
            this.microphone?.getTracks().forEach(t => t.stop());
            this.microphone = stream;
            for (const t of stream.getAudioTracks())
                t.onended = () => { if (this.microphone === stream) {
                    this.state.mic = false;
                    this.state.openMic = false;
                    this.state.holding = false;
                    this.applyGates();
                    this.changed();
                } };
            this.addInput(this.view?.self ?? 1, stream);
            this.state.deviceId = stream.getAudioTracks()[0]?.getSettings().deviceId ?? '';
            this.state.mic = true;
            this.state.error = '';
            this.rewire();
            this.changed();
            const devices = await navigator.mediaDevices.enumerateDevices();
            if (!current() || this.microphone !== stream)
                return;
            this.state.devices = devices.filter(d => d.kind === 'audioinput').map(d => ({ id: d.deviceId, label: d.label || '麦克风' }));
        }
        catch (e) {
            if (!current())
                return;
            const name = e instanceof DOMException ? e.name : '';
            this.state.error = name === 'NotAllowedError' ? '麦克风权限未授予。可继续收听或用文字发言；请在浏览器站点权限中允许麦克风后重试。' : name === 'NotFoundError' ? '没有找到麦克风。可继续收听或使用文字。' : message(e);
        }
        finally {
            if (current()) {
                this.starting = false;
                this.changed();
            }
        }
    }
    stopMic() {
        // getUserMedia cannot be aborted reliably. Invalidate its result instead;
        // an older completion must also leave a newer request's starting flag alone.
        ++this.micGeneration;
        this.starting = false;
        this.microphone?.getTracks().forEach(t => t.stop());
        this.microphone = null;
        this.state.mic = false;
        this.state.openMic = false;
        this.state.holding = false;
        this.state.level = 0;
        this.state.deviceId = '';
        const seat = this.view?.self ?? 1, input = this.inputs.get(seat);
        input?.source.disconnect();
        input?.gain.disconnect();
        this.inputs.delete(seat);
        this.lastSpeak.delete(seat);
        this.applyGates();
        if (!this.disposed)
            this.changed();
    }
    toggleMic() { this.state.openMic = !this.state.openMic; this.applyGates(); this.changed(); }
    hold(value) { this.state.holding = value && this.state.allowed && this.state.mic; this.applyGates(); }
    volume(value) { this.state.volume = Math.max(0, Math.min(1, value)); if (this.monitor)
        this.monitor.gain.value = this.state.volume; }
    attach(ep) {
        if (this.disposed || !this.context || this.endpoints.get(ep.seat) !== ep)
            return;
        if (!ep.destination) {
            ep.destination = this.context.createMediaStreamDestination();
            const t = ep.link.rtc?.getTransceivers().find(t => t.receiver.track?.kind === 'audio');
            if (t)
                void t.sender.replaceTrack(ep.destination.stream.getAudioTracks()[0]).catch(e => { this.state.error = '音频通道接入失败：' + message(e); this.changed(); });
        }
        if (ep.link.remoteAudio) {
            // Chromium remote WebRTC decoding may remain idle with only a WebAudio
            // source attached. A muted sink starts decoding; actual playback/routing
            // still goes exclusively through our permission-gated mix.
            if (!ep.decoder) {
                ep.decoder = new Audio();
                ep.decoder.muted = true;
                ep.decoder.autoplay = true;
                ep.decoder.setAttribute('playsinline', '');
            }
            if (ep.decoder.srcObject !== ep.link.remoteAudio)
                ep.decoder.srcObject = ep.link.remoteAudio;
            void ep.decoder.play().catch(e => { this.state.error = '远端声音尚未启用：' + message(e); this.changed(); });
            this.addInput(ep.seat, ep.link.remoteAudio);
        }
        this.rewire();
    }
    addInput(seat, stream) {
        if (!this.context)
            return;
        const old = this.inputs.get(seat);
        old?.source.disconnect();
        old?.gain.disconnect();
        const source = this.context.createMediaStreamSource(stream), gain = this.context.createGain(), analyser = this.context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(gain);
        gain.connect(analyser);
        this.inputs.set(seat, { source, gain, analyser });
    }
    rewire() {
        if (!this.context || !this.monitor || !this.view)
            return;
        const self = this.view.self, host = this.view.isHost;
        for (const [seat, input] of this.inputs) {
            input.gain.disconnect();
            input.gain.connect(input.analyser);
            if (seat !== self)
                input.gain.connect(this.monitor);
            for (const ep of this.endpoints.values()) {
                if (!ep.destination)
                    continue;
                if (host ? seat !== ep.seat : seat === self)
                    input.gain.connect(ep.destination);
            }
        }
        this.applyGates();
    }
    applyGates() {
        const v = this.view;
        const active = !this.disposed && !!v && this.state.mic && this.state.allowed && (this.state.openMic || this.state.holding);
        // Hardware permission remains while muted; disabled track sends silence.
        this.microphone?.getAudioTracks().forEach(t => { t.enabled = active; });
        for (const [seat, input] of this.inputs) {
            const allowed = !!v && (seat === v.self ? active : v.isHost ? v.voice.speakers.includes(seat) : true);
            input.gain.gain.value = !this.disposed && this.state.enabled && allowed ? 1 : 0;
        }
    }
    measure() {
        const input = this.inputs.get(this.view?.self ?? 1);
        let level = 0;
        if (input) {
            const a = new Float32Array(256);
            input.analyser.getFloatTimeDomainData(a);
            level = Math.min(1, Math.sqrt(a.reduce((sum, x) => sum + x * x, 0) / a.length) * 4);
        }
        this.state.level = level;
        if (this.view?.isHost) {
            const now = Date.now();
            const speakers = [];
            for (const [seat, node] of this.inputs) {
                const samples = new Float32Array(256);
                node.analyser.getFloatTimeDomainData(samples);
                if (Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / 256) > .012)
                    this.lastSpeak.set(seat, now);
                if (this.view.voice.speakers.includes(seat) && now - (this.lastSpeak.get(seat) ?? 0) < 450)
                    speakers.push(seat);
            }
            speakers.sort((a, b) => a - b);
            if (JSON.stringify(speakers) !== JSON.stringify(this.state.speaking)) {
                this.state.speaking = speakers;
                for (const ep of this.endpoints.values())
                    if (ep.link.open)
                        ep.link.sendSpeaking?.(speakers);
                this.changed();
            }
        }
        // Meter-only DOM update avoids rebuilding controls during push-to-talk gestures.
        const el = document.querySelector('#mic-level');
        if (el)
            el.value = level;
        const status = document.querySelector('#voice-live');
        if (status)
            status.textContent = this.state.holding ? '正在按住发言' : this.state.openMic && this.state.allowed ? '麦克风已开启' : this.state.reason;
    }
    /** Test source uses a real AudioNode stream, not a mock media channel. */
    attachTestStream(stream) { this.microphone = stream; this.state.mic = true; this.addInput(this.view?.self ?? 1, stream); this.rewire(); }
    async close() {
        if (this.closePromise)
            return this.closePromise;
        this.disposed = true;
        this.stopMic();
        this.offVisibility();
        if (this.meter)
            clearInterval(this.meter);
        this.meter = null;
        for (const n of [...this.endpoints.keys()])
            this.remove(n);
        this.audio?.pause();
        if (this.audio)
            this.audio.srcObject = null;
        this.monitorStream?.stream.getTracks().forEach(t => t.stop());
        const context = this.context;
        this.context = null;
        this.monitor = null;
        this.monitorStream = null;
        this.audio = null;
        this.state.enabled = false;
        this.state.mic = false;
        this.state.allowed = false;
        this.state.speaking = [];
        this.closePromise = Promise.resolve().then(() => context?.close());
        return this.closePromise;
    }
}
exports.VoiceRoom = VoiceRoom;
function message(e) { return e instanceof Error ? e.message : String(e); }

