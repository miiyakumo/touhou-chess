"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.App = void 0;
const presets_js_1 = require("../domain/presets.js");
const controller_js_1 = require("./controller.js");
const catalog_js_1 = require("./catalog.js");
const model_js_1 = require("../domain/model.js");
const types_js_1 = require("../room/types.js");
const peer_js_1 = require("../net/peer.js");
// Values received over the network are text even when the schema calls them a
// number or enum. Only markup assembled by the local render helpers is trusted.
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lock = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
const copy = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';
const palettes = [['#f5e9e3', '#965554'], ['#ebeee4', '#6f775b'], ['#e7ecf1', '#637890'], ['#e9e9e2', '#7c806a'], ['#eee9f0', '#846687'], ['#f0eade', '#928166'], ['#e6ebe5', '#62775b'], ['#eee7e0', '#927660'], ['#e8e8ed', '#797387'], ['#eee9df', '#927d5c'], ['#e5eceb', '#68877c'], ['#edebe6', '#858275']];
const $ = (s) => document.querySelector(s);
class App {
    controller = new controller_js_1.Controller();
    size = 12;
    volatile = false;
    chatDraft = '';
    chatDraftRevision = 0;
    selected = [];
    actionKey = '';
    hiddenRole = true;
    journal = 'public';
    entry = 'create';
    nickname = '';
    invitation = '';
    error = '';
    notes = '';
    notesKey = '';
    dialogAction = null;
    toastTimer = null;
    portrait = '';
    portraitObjectURL = '';
    externalArt = false;
    constructor() {
        try {
            this.nickname = localStorage.getItem('rls-nickname') ?? '';
            this.externalArt = localStorage.getItem('rls-external-art') === '1';
        }
        catch { /* offline file */ }
        this.externalArt ||= window.RENLEISHA_CONFIG?.enableExternalArt === true;
        if (location.hash.includes('room=')) {
            this.invitation = location.href;
            this.entry = 'join';
        }
        this.controller.subscribe(() => this.render());
        document.addEventListener('click', e => { const b = e.target.closest('[data-action],[data-seat],[data-journal]'); if (!b || b.disabled)
            return; this.click(b); });
        document.addEventListener('input', e => {
            const t = e.target;
            if (t.id === 'nickname')
                this.nickname = t.value;
            if (t.id === 'invite-input')
                this.invitation = t.value;
            if (t.id === 'notes')
                this.saveNotes(t.value);
            if (t.id === 'chat-input')
                this.setChatDraft(t.value);
            if (t.id === 'voice-volume')
                this.controller.voice.volume(Number(t.value));
        });
        document.addEventListener('change', e => {
            const t = e.target;
            if (t.id === 'temporary-mode')
                this.volatile = t.checked;
            if (t.id === 'game-size')
                this.size = Number(t.value);
            if (t.id === 'lobby-size')
                this.run(() => this.controller.submit({ kind: 'size', size: Number(t.value) }));
            if (t.id === 'mic-device')
                this.run(() => this.controller.voice.mic(t.value));
        });
        document.addEventListener('pointerdown', e => { if (e.target.closest('[data-action=voice-ptt]')) {
            e.preventDefault();
            this.controller.voice.hold(true);
        } });
        for (const ev of ['pointerup', 'pointercancel'])
            document.addEventListener(ev, () => this.controller.voice.hold(false));
        document.addEventListener('keydown', e => {
            const t = e.target;
            if (e.code === 'Space' && !e.repeat && !t.closest('input,textarea,select,[contenteditable=true]') && !$('#modal').open && this.controller.voice.state.mic) {
                e.preventDefault();
                this.controller.voice.hold(true);
            }
        });
        document.addEventListener('keyup', e => { if (e.code === 'Space')
            this.controller.voice.hold(false); });
        $('#modal').addEventListener('click', e => {
            const d = $('#modal');
            if (e.target === d) {
                const r = d.getBoundingClientRect();
                if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
                    d.close();
            }
        });
        document.addEventListener('submit', e => { const id = e.target.id; if (id === 'entry-form') {
            e.preventDefault();
            this.clickAction(this.entry === 'create' ? 'create' : 'join');
        } if (id === 'chat-form') {
            e.preventDefault();
            this.clickAction('chat-send');
        } });
        window.addEventListener('beforeunload', e => { if (this.controller.state.view?.status === 'playing' && this.controller.state.mode !== 'demo') {
            e.preventDefault();
            e.returnValue = '';
        } });
        this.render();
        void this.controller.init();
    }
    setChatDraft(value) { this.chatDraft = value; ++this.chatDraftRevision; }
    run(fn) { this.error = ''; void fn().catch(e => { if (e?.name === 'AbortError')
        return; this.error = (0, controller_js_1.msg)(e); this.render(); this.toast(this.error); }); }
    toast(text) {
        $('#toast').textContent = text;
        $('#toast').classList.add('show');
        if (this.toastTimer)
            clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
    }
    modal(title, body, buttons = '<button class="btn primary" data-action="close-modal">知道了</button>', wide = false) {
        const d = $('#modal');
        d.classList.toggle('wide', wide);
        d.innerHTML = `<div class="dialog-head"><h2 id="modal-title">${esc(title)}</h2><button class="dialog-close" data-action="close-modal" aria-label="关闭对话框">×</button></div><div class="dialog-body">${body}</div><div class="dialog-footer">${buttons}</div>`;
        if (!d.open)
            d.showModal();
        this.bindImages();
    }
    confirm(title, body, action, label = '确认') {
        this.dialogAction = () => { this.closeModal(); this.run(async () => { await action(); }); };
        this.modal(title, body, `<button class="btn" data-action="close-modal">再想想</button><button class="btn primary" data-action="confirm-modal">${esc(label)}</button>`);
    }
    closeModal() { $('#modal').close(); }
    feedback() {
        const s = this.controller.state, v = s.view;
        let html = '';
        const rawError = this.error || s.error;
        const error = /目标数量、去重或存活条件不合法/.test(rawError) ? '目标当前不可选择，请检查目标数量或改选其他在场玩家。此操作尚未提交。' : rawError;
        if (error)
            html += `<div class="feedback" role="alert">${esc(error)}${s.mode === 'guest' ? '<button class="textbtn" data-action="reconnect">重新连接</button><button class="textbtn" data-action="update-invite">房主给了新链接</button>' : ''}</div>`;
        if (this.controller.client?.legacyPending?.length)
            html += '<div class="feedback info" role="status">本机保留了旧版未确认操作。<button class="textbtn" data-action="legacy-pending">查看旧版未确认操作</button></div>';
        if (v && (s.volatile || v.ephemeral))
            html += `<div class="feedback info" role="status">${v.ephemeral ? '临时房间：房主刷新或关闭页面会丢失整局。' : '本机使用临时模式：刷新或关闭页面会丢失你的座位凭证。'}</div>`;
        if (s.signalWarning)
            html += `<div class="feedback" role="status">${esc(s.signalWarning)}</div>`;
        if (v?.paused)
            html += `<div class="feedback info" role="status"><strong>对局已暂停。</strong>${esc(v.pauseReason)} ${v.isHost ? '全员恢复在线后，请点击「继续对局」。' : '等待房主确认继续。'}</div>`;
        else if (v && !s.connected)
            html += '<div class="feedback" role="status">正在恢复与房主的连接。没有把未提交的选票当作弃票。</div>';
        return html;
    }
    legacyPending() {
        const messages = this.controller.client?.legacyPending ?? [];
        if (!messages.length)
            return;
        const labels = { chat: '房间文字', rename: '修改昵称', ready: '准备状态', mute: '发言管理', kick: '移出玩家', size: '房间人数', play: '角色行动', start: '开始对局', advance: '推进阶段', pause: '暂停对局', resume: '继续对局', abort: '结束本局', rematch: '再开一局', leave: '离开房间' };
        const fields = { chat: ['text'], rename: ['name'], ready: ['value'], mute: ['seat', 'value'], kick: ['seat'], size: ['size'], play: ['move', 'serial', 'target', 'targets'] };
        const fieldLabels = { text: '原文', name: '昵称', value: '设置值', seat: '玩家座位', size: '人数', move: '行动', serial: '行动序号', target: '目标', targets: '目标列表' };
        const scalar = value => value === null ? '无' : ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : '（格式无效）';
        const entries = messages.map((message, index) => {
            const intent = message?.intent;
            const kind = typeof intent?.kind === 'string' && Object.hasOwn(labels, intent.kind) ? intent.kind : null;
            const lines = [kind ? `${labels[kind]}（${kind}）` : '记录不完整或操作类型未知。'];
            // Only display operation content. Original envelopes also contain
            // seat credentials and room identifiers and must never be rendered.
            for (const key of fields[kind] ?? []) {
                if (!Object.hasOwn(intent, key))
                    continue;
                const value = intent[key];
                lines.push(`${fieldLabels[key]}：${Array.isArray(value) ? value.map(scalar).join('、') : scalar(value)}`);
            }
            return `<h3>第 ${esc(index + 1)} 条</h3><pre class="settings-code" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(lines.join('\n'))}</pre>`;
        }).join('');
        this.modal('旧版未确认操作', '<p>以下内容已保留在本机，不能自动重发。旧版房主可能已经处理过其中的操作；请先对照最新房间状态和房间记录确认，再决定是否重新输入。查看不会删除归档。</p>' + entries, undefined, true);
    }
    header() {
        const s = this.controller.state, v = s.view;
        $('#status-strip').hidden = !v?.demo;
        $('#status-strip').innerHTML = v?.demo ? `<div class="wrap"><span>离线演示 · 你 + ${esc(v.size - 1)} 个固定策略席位</span><span class="short-hide">使用完整规则引擎，不是在线玩家</span></div>` : '';
        $('#header').innerHTML = `<div class="wrap topinner"><button class="brand" data-action="home" aria-label="人类杀首页"><span class="orb" aria-hidden="true"></span><span><b>人类杀</b><small>RENLEISHA</small></span></button><span class="nav-caption">东方 Project 同人桌游</span><div class="topright">${v ? `<div class="room-tag"><span>房间</span><b>${v.demo ? 'DEMO' : esc(v.id.slice(0, 6).toUpperCase())}</b>${!v.demo ? `<button data-action="invite" aria-label="邀请朋友">${copy}</button>` : ''}</div>` : `<button class="textbtn" data-action="settings">联机设置</button>`}<button class="textbtn header-help" data-action="rules">规则</button><span class="help-badge">v${esc(types_js_1.APP_VERSION)}</span></div></div>`;
    }
    render() {
        const focused = document.activeElement;
        const focusId = focused?.id, selection = focused && ['INPUT', 'TEXTAREA'].includes(focused.tagName) ? [focused.selectionStart, focused.selectionEnd] : null;
        const s = this.controller.state, v = s.view;
        if (v?.game) {
            const key = `${v.matchId}:${v.game.actionStepSerial ?? 'waiting'}`;
            if (this.actionKey !== key) {
                this.selected = [];
                this.actionKey = key;
            }
            const nk = `rls-notes-${v.id}-${v.matchId}-${v.self}`;
            if (nk !== this.notesKey) {
                this.notesKey = nk;
                try {
                    this.notes = localStorage.getItem(nk) ?? '';
                }
                catch {
                    this.notes = '';
                }
            }
        }
        this.header();
        document.body.classList.toggle('night', !!v && v.activity === 'night');
        $('#app').innerHTML = this.feedback() + (v ? this.room(v) : this.home());
        const bar = $('#actionbar');
        bar.hidden = !v;
        $('#action-content').innerHTML = v ? this.actions(v) : '';
        const voice = this.controller.voice.state;
        $('#voice-shortcut').innerHTML = v ? `<span>${esc(voice.reason)}</span><button class="textbtn" data-action="voice-settings">语音设置</button>${voice.mic ? `<button class="btn" data-action="voice-toggle" ${voice.allowed ? '' : 'disabled'}>${voice.openMic ? '关麦' : '常开麦'}</button><button class="btn primary" data-action="voice-ptt" ${voice.allowed ? '' : 'disabled'}>按住说话</button>` : ''}` : '';
        $('#voice-shortcut').hidden = !v;
        $('#app').setAttribute('data-screen', v ? v.status : 'home');
        document.body.setAttribute('data-ready', 'true');
        this.bindImages();
        const next = focusId ? document.getElementById(focusId) : null;
        if (next) {
            next.focus({ preventScroll: true });
            if (selection)
                try {
                    next.setSelectionRange(selection[0] ?? 0, selection[1] ?? 0);
                }
                catch { /* select/range */ }
        }
    }
    home() {
        const s = this.controller.state;
        return `<section class="home-grid"><div class="home-intro"><h1>创建或加入房间</h1><p class="lede">6 / 8 / 10 / 12 人。分发本文件，创建房间，再分享邀请码。</p></div><section class="entry-card" aria-label="房间入口"><nav class="entry-tab" aria-label="进入方式"><button class="${this.entry === 'create' ? 'active' : ''}" data-action="tab-create" ${s.busy ? 'disabled' : ''}>创建房间</button><button class="${this.entry === 'join' ? 'active' : ''}" data-action="tab-join" ${s.busy ? 'disabled' : ''}>加入房间</button></nav><p>${this.entry === 'create' ? '输入昵称，创建房间。' : '输入昵称和房主发来的邀请链接。'}</p><form id="entry-form"><label class="field"><span>昵称</span><input id="nickname" name="nickname" maxlength="16" autocomplete="nickname" placeholder="输入昵称" value="${esc(this.nickname)}" required ${s.busy ? 'disabled' : ''}></label>${this.entry === 'create' ? `<label class="field"><span>对局人数</span><select id="game-size">${presets_js_1.SIZES.map(n => `<option value="${n}" ${n === this.size ? 'selected' : ''}>${n} 人${n === 12 ? ' · 标准' : ' · 小型试行'}</option>`).join('')}</select></label>` : ''}${this.entry === 'join' ? `<label class="field"><span>邀请码或链接</span><textarea id="invite-input" spellcheck="false" placeholder="粘贴 RLS4: 开头的邀请码，或完整邀请链接" required ${s.busy ? 'disabled' : ''}>${esc(this.invitation)}</textarea></label>` : ''}<label class="temporary-mode"><input id="temporary-mode" type="checkbox" ${this.volatile ? 'checked' : ''}> 临时模式（无法存档时使用；刷新会丢失房间或座位）</label><button type="submit" class="btn primary" ${s.busy ? 'disabled' : ''}>${s.busy ? '<span class="busy-dot"></span>' + esc(s.busyText) : this.entry === 'create' ? '创建房间' : '加入房间'}</button></form><p class="hint">${this.entry === 'create' ? '房主需保持页面打开，并避免设备休眠。' : '使用同一浏览器重新加入，可恢复原座位。'}</p><div class="entry-links">${s.hasSave ? `<button data-action="restore" ${s.busy ? 'disabled' : ''}>恢复房主存档 <small>${esc(s.savedSummary)}</small></button>` : '<span class="privacy-hint">无需注册</span>'}<button data-action="settings" ${s.busy ? 'disabled' : ''}>联机设置</button></div></section><div class="home-options"><button class="textbtn landing-demo" data-action="demo" ${s.busy ? 'disabled' : ''}>离线演示</button><p>联机内置语音和文字。离线演示中的其他座位由固定策略控制，不会对话。</p></div></section>${this.footer(true)}`;
    }
    footer(home = false) {
        return `<footer class="footer ${home ? 'home-footer' : 'app-footer'}"><p>东方 Project 二次创作 · 规则 v1.0${home ? '' : ' · 房主出局后也请保持页面打开。'}</p><div class="foot-links"><button data-action="rules">规则速览</button><button data-action="sources">关于与素材</button>${!home ? '<button data-action="exit">离开页面</button>' : ''}</div></footer>`;
    }
    room(v) {
        const game = v.game, lobby = v.status === 'lobby', ended = ['ended', 'aborted'].includes(v.status);
        const phase = game?.phase ?? '';
        const heads = { lobby: ['等待准备', `${v.size} 人全部在线并准备后，房主可以开始游戏。`],
            discussion: ['白天 / 公开讨论', '全员睁眼。请在语音通话中讨论，再由房主开始投票。'],
            vote: ['白天 / 驱逐投票', '选择一名玩家或弃票，确认后不能修改。'],
            night: [`${phase} / 私密行动`, '保持安静。只有轮到你时，页面才会显示相应的行动。'],
            announcement: ['清晨 / 夜间公告', '裁判正在整理需要公开的结果。'], lastWords: ['白天 / 遗言', '请让本次被驱逐的玩家留下遗言，再继续对局。'], ended: ['对局结束', '可查看本局结果、导出公开记录或返回大厅。'] };
        const ready = v.members.filter(m => m.ready).length;
        const caption = lobby ? '房间大厅' : ended ? (v.status === 'aborted' ? '不计胜负' : '终局') : v.activity === 'discussion' ? '讨论时间' : v.activity === 'lastWords' ? '遗言时间' : v.activity === 'vote' ? '驱逐投票' : v.activity === 'announcement' ? '出局公告' : '行动时间';
        return `<section class="mainhead"><div><p class="eyebrow">${esc(heads[v.activity][0])}</p><h1>${lobby ? '房间大厅' : ended ? (v.status === 'aborted' ? '对局已中止' : '对局结束') : `第 ${esc(game.day)} 日 · ${esc(phase)}`}<small>${lobby || ended ? '' : caption}</small></h1><p class="subhead">${esc(heads[v.activity][1])}</p></div>${lobby ? `<span class="status-pill"><i></i>${esc(ready)} / ${esc(v.size)} 已准备</span>` : `<nav class="phase-track" aria-label="每日阶段">${['子夜', '夜间公告', '白天', '日落', '午夜'].map(x => `<span class="${phase === x ? 'current' : ''}"><i></i>${x === '夜间公告' ? '公告' : x}</span>`).join('')}</nav>`}</section>${ended ? this.ending(v) : ''}${game ? `<section class="mini-me"><div><strong>${this.hiddenRole ? '身份已收起' : esc(model_js_1.ROLE_NAMES[game.self.role])}</strong><small>仅自己可见 · ${game.self.alive ? '你仍在场' : '你已出局，请继续保持连接'}</small></div><button data-action="my-role">查看身份 ${arrow}</button></section>` : ''}<div class="body-grid"><section class="table-section" aria-label="村落座位"><div class="section-top"><h2>村落座位 <span class="count">${esc(lobby ? v.members.length + ' 人已加入' : game.seats.filter(p => p.alive).length + ' / ' + v.size + ' 人公开在场')}</span></h2>${lobby ? '<button data-action="rename">修改我的昵称</button>' : `<span class="status-pill"><i></i>${v.paused ? '已暂停' : v.submitted ? '本次已锁定' : game?.action ? '轮到你行动' : '等候中'}</span>`}</div><div class="seat-grid" data-testid="seat-grid">${Array.from({ length: v.size }, (_, i) => this.seat(v, i + 1)).join('')}</div><p class="seat-rule">${lock}<span>${lobby ? (v.demo ? '演示中的其他玩家由固定策略驱动；联机房间不会自动代行动。' : '昵称与头像不代表真实身份。开局才会随机发牌。') : '一般出局不公开身份；夜间结果以正式公告为准。可投自己，确认后锁定。'}</span></p><div class="host-tools">${v.isHost && v.status === 'playing' ? `<button data-action="${v.paused ? 'resume' : 'pause'}">${v.paused ? '继续对局' : '暂停对局'}</button><button data-action="abort">中止本局</button>` : ''}${!v.demo ? '<button data-action="invite">邀请码</button>' : ''}${game ? '<button data-action="public-export">导出公开记录</button>' : ''}<button data-action="diagnostics">连接检查</button>${v.isHost ? '<button data-action="voice-admin">发言管理</button>' : ''}</div></section><aside class="sidebar">${lobby ? this.lobby(v) : this.roleCard(v) + this.records(v)}</aside></div>${this.voicePanel(v)}${this.chatPanel(v)}${this.footer()}`;
    }
    voicePanel(v) {
        const a = this.controller.voice.state;
        return `<section class="voice-panel" aria-label="语音"><div class="section-top"><h2>语音 <span class="count">${a.enabled ? '已启用声音' : '尚未启用'}</span></h2><span id="voice-live">${esc(a.reason)}</span></div>
      ${v.demo ? '<p class="hint">离线演示没有其他真人。这里可以检查麦克风，但不会与虚拟座位通话。</p>' : ''}
      ${v.isHost && !a.enabled && !v.demo ? '<p class="hint">房主需要启用声音，才能向所有玩家转发语音。</p>' : ''}
      ${a.error ? `<p role="alert" class="voice-error">${esc(a.error)}</p>` : ''}
      <div class="voice-controls"><button class="btn" data-action="voice-enable">${a.enabled ? '恢复声音' : '启用声音'}</button>
      ${a.mic ? `<button class="btn" data-action="voice-toggle" ${a.allowed ? '' : 'disabled'}>${a.openMic ? '关闭常开麦' : '常开麦'}</button><button class="btn primary" id="voice-ptt" data-action="voice-ptt" ${a.allowed ? '' : 'disabled'}>按住发言 / 空格</button><button class="textbtn" data-action="voice-stop">断开麦克风</button>` : '<button class="btn" data-action="voice-mic">连接麦克风</button>'}
      <label class="volume">音量 <input id="voice-volume" type="range" min="0" max="1" step="0.05" value="${esc(a.volume)}" aria-label="播放音量"></label>
      <progress id="mic-level" max="1" value="${esc(a.level)}" aria-label="麦克风音量"></progress></div>
      ${a.devices.length ? `<label class="field mic-device">输入设备<select id="mic-device">${a.devices.map(d => `<option value="${esc(d.id)}" ${a.deviceId === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>` : ''}
      <p class="hint">默认不开麦。连接麦克风后按住按钮或空格发言，也可选择常开麦。切换窗口会释放按住状态。建议使用耳机。</p></section>`;
    }
    chatPanel(v) {
        const allowed = this.controller.state.connected && v.voice.speakers.includes(v.self);
        const pending = this.controller.state.pending > 0;
        return `<section class="chat-panel" aria-label="房间文字"><div class="section-top"><h2>房间文字</h2><span class="count">${esc(v.voice.reason)}</span></div><div class="chat-log" aria-live="polite">${v.chat.length ? v.chat.slice(-20).map(m => `<p><b>${esc(m.seat)} 号 · ${esc(m.name)}</b> ${esc(m.text)}</p>`).join('') : '<p class="hint">麦克风不可用时，可在允许发言的阶段用文字讨论。全员可见，不是私聊。</p>'}</div><form id="chat-form"><input id="chat-input" maxlength="400" placeholder="输入公开消息" aria-label="公开消息" value="${esc(this.chatDraft)}" ${allowed ? '' : 'disabled'}><button class="btn" type="submit" ${allowed && !pending ? '' : 'disabled'}>${pending ? '等待确认' : '发送'}</button></form></section>`;
    }
    voiceAdmin() {
        const v = this.controller.state.view;
        if (!v?.isHost)
            return;
        this.modal('发言管理', `<p>手动禁言同时限制网页语音和文字，不改变角色行动。阶段权限仍优先。</p><label class="field">玩家<select id="mute-seat">${v.members.map(m => `<option value="${esc(m.seat)}">${esc(m.seat)} 号 · ${esc(m.name)}${v.voice.muted.includes(m.seat) ? '（已禁言）' : ''}</option>`).join('')}</select></label><label><input type="checkbox" id="mute-value" checked> 禁言此玩家（取消勾选为解除）</label>`, '<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="mute-confirm">应用</button>');
    }
    diagnostics() {
        const s = this.controller.state, voice = this.controller.voice.state;
        this.modal('连接检查', `<p>浏览器安全上下文：${isSecureContext ? '是' : '否（麦克风或存档可能被限制）'}<br>WebRTC：${typeof RTCPeerConnection === 'function' ? '可用' : '不支持'}<br>麦克风接口：${typeof navigator.mediaDevices?.getUserMedia === 'function' ? '可用（需授权）' : '不可用'}<br>本地存档接口：${typeof indexedDB === 'object' ? '可用；实际保存仍可能被拒绝' : '不可用'}<br>数据房间：${s.connected ? '房间握手已完成' : '未完成握手'}<br>音频关联的数据连接：${esc(voice.peers)}<br>本机麦克风：${voice.mic ? '已取得音频轨道' : '未连接'}<br>声音播放：${voice.enabled ? '已启用' : '未启用'}</p><p>${esc(s.signalWarning || s.error || voice.error || '没有当前错误。连接数不等于对方已经启用麦克风。')}</p><p>仅连上信令不算加入成功。直连失败可能需要 TURN；本文件不包含可无限使用的中继账号。</p>`);
    }
    ending(v) {
        const o = v.game?.outcome;
        if (v.status === 'aborted')
            return '<section class="end-banner neutral"><h2>对局已中止</h2><p>这是房主中止，不是规则判定的「无赢家」。本局不计胜负，也不额外揭示底牌。</p></section>';
        const won = !!o?.winners.includes((0, model_js_1.faction)(v.game.self.role));
        return `<section class="end-banner ${o?.winners.length ? '' : 'neutral'}" role="status"><h2>${o?.winners.length ? esc(o.winners.map(f => model_js_1.FACTION_NAMES[f]).join('、')) + '阵营' + (o.winners.length > 1 ? '共同获胜' : '获胜') : '本局没有赢家'}</h2><p>${won ? '你所在的阵营获胜。已出局的同伴同样分享胜利。' : o?.winners.length ? '你的阵营未获胜。所有身份已公开。' : '人类全部出局，且没有阵营达成胜利条件。所有身份现已公开。'}</p></section>`;
    }
    seat(v, n) {
        const m = v.members.find(x => x.seat === n), p = v.game?.seats.find(x => x.seat === n), lobby = v.status === 'lobby';
        const isOut = !!p && !p.alive, selected = this.selected.includes(n), canSelect = !!v.game?.action && v.game.action.targetCount > 0 && v.game.action.candidates.includes(n) && !v.paused && this.controller.state.connected;
        const col = palettes[n - 1];
        const foot = !m ? '等待加入' : lobby ? (m.ready ? '✓ 已准备' : '尚未准备') : selected ? '已选择' : p?.role ? model_js_1.ROLE_NAMES[p.role] : '身份未公开';
        return `<button class="seat ${this.controller.voice.state.speaking.includes(n) ? 'speaking' : ''} ${!m ? 'empty' : ''} ${isOut ? 'out' : ''} ${selected ? 'selected' : ''} ${m && !m.online ? 'offline' : ''}" style="--avatar:${col[0]};--avatar-ink:${col[1]}" data-seat="${esc(n)}" aria-label="${esc(n)}号 ${esc(m?.name ?? '空位')}${isOut ? '，已出局' : ''}" aria-pressed="${selected}" ${!m || (!lobby && !canSelect) ? 'disabled' : ''}><div class="seat-top"><span class="seat-num">${esc(String(n).padStart(2, '0'))}</span>${m?.seat === v.self ? `<span class="me-label">你${m.isHost ? ' · 房主' : ''}</span>` : isOut ? '<span class="out-label">已出局</span>' : m?.isHost ? '<span class="out-label">房主</span>' : m && !m.online ? '<span class="out-label"><i class="offline-dot"></i>离线</span>' : ''}</div><span class="seat-avatar" aria-hidden="true">${esc(m ? Array.from(m.name)[0] : '＋')}</span><span class="seat-name">${esc(m?.name ?? '空位')}${this.controller.voice.state.speaking.includes(n) ? '<span class="speaking-dot" title="正在发言" aria-label="正在发言"></span>' : ''}</span><span class="seat-foot ${lobby && m?.ready ? 'ready' : ''}">${esc(foot)}</span><span class="selected-mark" aria-hidden="true">✓</span></button>`;
    }
    lobby(v) {
        const cfg = (0, presets_js_1.preset)(v.size);
        return `<section class="lobby-info"><h3>本局设定</h3><div class="config-row"><span>房主</span><strong>${esc(v.members.find(m => m.isHost)?.name)}</strong></div><div class="config-row"><span>规则</span><strong>${esc(v.size === 12 ? '标准 v1.0' : v.size + ' 人试行')}</strong></div><div class="config-row"><span>身份分配</span><strong>${v.demo ? '固定策略演示' : '开局随机分配'}</strong></div><div class="config-factions"><span><b>1</b>神明</span><span><b>${cfg.humans}</b>人类</span><span><b>${cfg.fairies}</b>妖精</span><span><b>${cfg.youkai}</b>妖怪</span></div>${v.isHost && !v.demo ? `<label class="field"><span>修改人数（会清除准备）</span><select id="lobby-size">${presets_js_1.SIZES.map(n => `<option value="${n}" ${v.size === n ? 'selected' : ''}>${n} 人</option>`).join('')}</select></label>` : ''}${v.size < 12 ? `<p class="hint">小型配置为试行规则，未做平衡性验证。${v.size === 6 ? '只有一名妖精，首轮最高票也可获胜。' : '御阿礼之子首次查验两人。'}</p>` : ''}</section><section class="role-card"><div class="role-top"><span>${lock} 你的身份</span></div><div class="role-main"><div><h2>尚未分配</h2><div class="role-caption">开始游戏时分配身份。</div></div><div class="empty-identity">?</div></div><div class="role-copy">点击下方“启用声音”加入语音；“连接麦克风”才会请求录音权限。不请求摄像头。</div></section><section class="lobby-note"><h3>房间说明</h3><p>开局后保留座位，不换人、不补位。有人断线时，对局暂停并保留已提交操作。</p></section>`;
    }
    roleContent(v) {
        const g = v.game, r = g.self.role, meta = catalog_js_1.ROLE_META[r];
        const art = this.externalArt && r === 'reimu' ? 'https://touhou-x.jp/resources/img/top/v3_chara_232e68d6945288958e6abb3378ae7dec.png' : '';
        const src = this.portrait || art;
        return `<div class="role-main"><div><h2>${esc(model_js_1.ROLE_NAMES[r])}</h2><span class="faction">${esc(model_js_1.FACTION_NAMES[(0, model_js_1.faction)(r)])}阵营</span><div class="role-caption">${esc(meta.hint)}</div></div><div class="role-art"><span class="role-stamp fallback">${esc(meta.seal)}</span>${src ? `<img src="${esc(src)}" referrerpolicy="no-referrer" alt="私人身份卡角色图">` : ''}</div></div><div class="role-copy"><strong>你的能力</strong>${esc(r === 'akyuu' && v.size < 12 ? '第一天日落，查验两名不同玩家。' : meta.ability)}<div class="win-copy"><strong>胜利条件</strong>${esc(catalog_js_1.WIN[(0, model_js_1.faction)(r)])}</div><p class="role-meta-status ${g.self.alive ? '' : 'out'}">${g.self.alive ? '你仍在场。' : '你已出局。除允许的遗言外，请停止讨论，继续保持连接。'}</p></div>`;
    }
    roleCard(v) {
        return `<section class="role-card" aria-label="我的身份"><div class="role-top"><span>${lock} 仅自己可见</span><button data-action="toggle-role">${this.hiddenRole ? '显示' : '收起'}</button></div>${this.hiddenRole ? '<div class="role-collapsed">身份已收起</div><p class="privacy-hint">点击「显示」查看身份与胜利条件。</p>' : this.roleContent(v)}</section>`;
    }
    records(v) {
        const g = v.game;
        let content = '';
        if (this.journal === 'notes')
            content = `<textarea id="notes" class="notes" maxlength="12000" placeholder="记录发言和投票情况" aria-label="我的私密笔记">${esc(this.notes)}</textarea><p class="notes-status" id="notes-status">只保存在你的浏览器，不发送给房主或其他人。</p>`;
        else {
            const entries = this.journal === 'private' ? g.self.notes : g.publicLog;
            content = entries.length ? `<ul class="log ${this.journal === 'private' ? 'private-log' : ''}">${entries.slice().reverse().map(x => { const parts = x.split(' · '); return parts.length > 1 ? `<li><time>${esc(parts[0])}</time>${esc(parts.slice(1).join(' · '))}</li>` : `<li>${esc(x)}</li>`; }).join('')}</ul>` : `<p class="record-empty">${this.journal === 'private' ? '查验、互认与技能信息会保留在这里。' : '等待第一条公开公告。'}</p>`;
        }
        return `<section class="journal" aria-label="对局记录"><nav class="journal-tabs" aria-label="记录类型"><button data-journal="public" class="${this.journal === 'public' ? 'active' : ''}">公开 <small>${esc(g.publicLog.length)}</small></button><button data-journal="private" class="${this.journal === 'private' ? 'active' : ''}">私密 <small>${esc(g.self.notes.length)}</small></button><button data-journal="notes" class="${this.journal === 'notes' ? 'active' : ''}">笔记 ${lock}</button></nav>${content}</section>`;
    }
    actions(v) {
        const s = this.controller.state, g = v.game, a = g?.action, me = v.members.find(m => m.seat === v.self);
        let title = '', titleHTML = null, desc = '', buttons = '';
        // Button labels below contain only local text and the local SVG icon.
        const button = (name, label, primary = false, disabled = false) => `<button class="btn ${primary ? 'primary' : ''}" data-action="${esc(name)}" ${disabled ? 'disabled' : ''}>${label}</button>`;
        if (v.status === 'lobby') {
            const ready = v.members.filter(m => m.ready).length;
            title = v.members.length < v.size ? `已加入 ${v.members.length} / ${v.size} 人` : ready === v.size ? '所有玩家已准备，可以开始了' : `已准备 ${ready} / ${v.size} 人`;
            desc = '身份只在正式开局时分配。';
            buttons = button('ready', me.ready ? '取消准备' : '我准备好了', !v.isHost, s.pending > 0) +
                (v.isHost ? button('start', '开始游戏 ' + arrow, true, ready !== v.size || v.members.some(m => !m.online) || s.pending > 0) : '');
        }
        else if (['ended', 'aborted'].includes(v.status)) {
            title = v.status === 'ended' ? '本局已结算' : '本局已中止，不计胜负';
            desc = '公开记录可以导出留作复盘。';
            buttons = button('public-export', '导出公开记录') + (v.isHost ? button('rematch', '再开一局 ' + arrow, true, s.pending > 0) : '');
        }
        else if (!s.connected || v.paused) {
            title = !s.connected ? '与房主失去连接，正在等待恢复' : '对局已暂停，已提交操作不会丢失';
            desc = '断线不等于出局，未提交也不等于弃票。';
            buttons = v.isHost ? button('resume', '继续对局', true, v.members.some(m => !m.online) || s.pending > 0) : button('reconnect', '重新连接', true);
        }
        else if (s.pending) {
            title = '操作已发送，等待房主保存确认…';
            desc = '请不要重复提交。重试会沿用原操作编号。';
            buttons = v.isHost ? '' : button('retry', '重试确认');
        }
        else if (v.submitted) {
            title = v.submittedText;
            desc = '已保存到房主端，等待统一结算；本轮不能更改。';
            buttons = '<span class="action-progress">已锁定 · 等待结算</span>';
        }
        else if (a) {
            if (a.kind === 'ack') {
                title = a.title;
                desc = '请先查看自己的身份或私密记录。';
                buttons = button('private-records', '查看私密信息') + button('ack', '确认 ' + arrow, true);
            }
            else {
                title = a.title;
                if (this.selected.length)
                    titleHTML = `已选择 <span class="target">${this.selected.map(n => esc(String(n).padStart(2, '0')) + ' 号').join('、')}</span>${a.targetCount > 1 ? ` <span class="selection-count">${esc(this.selected.length)}/${esc(a.targetCount)}</span>` : ''}`;
                desc = a.kind === 'vote' ? '可以投自己；确认后不能改票。' : a.targetCount > 1 ? `请选择 ${a.targetCount} 名不同玩家，再确认。` : '点击座位选择目标。';
                if (a.kind === 'vote' && a.canAbstain)
                    buttons += button('pass', '弃票');
                if (a.kind === 'skill' && a.canPass)
                    buttons += button('pass', '放弃技能');
                buttons += button('submit', a.kind === 'vote' ? '确认投票 ' + arrow : '确认目标 ' + arrow, true, this.selected.length !== a.targetCount);
            }
        }
        else if (v.canAdvance) {
            title = v.activity === 'discussion' ? '请在公开讨论结束后开始投票' : '请等待遗言结束，再继续流程';
            desc = '这只推进公开阶段，不会代替其他玩家做决定。';
            buttons = button('advance', v.activity === 'discussion' ? '开始驱逐投票 ' + arrow : '遗言结束，继续 ' + arrow, true);
        }
        else {
            title = g?.self.alive ? '暂时没有你的行动，请稍候' : '你已出局。请保持连接，等待这局结束';
            desc = v.activity === 'discussion' ? '等待房主在讨论结束后开启投票。' : '请保持安静，程序会自动提示下一次行动。';
            buttons = '<span class="action-progress"><span class="busy-dot"></span>等待中</span>';
        }
        return `<div><div class="action-title" role="status">${titleHTML ?? esc(title)}</div><p class="action-desc">${esc(desc)}</p></div><div class="actions">${buttons}</div>`;
    }
    click(b) {
        if (b.dataset.journal) {
            this.journal = b.dataset.journal;
            this.render();
            return;
        }
        if (b.dataset.seat) {
            const n = Number(b.dataset.seat), v = this.controller.state.view;
            if (!v)
                return;
            if (v.status === 'lobby') {
                if (n === v.self)
                    this.rename();
                else if (v.isHost && !v.demo) {
                    const m = v.members.find(m => m.seat === n);
                    if (m)
                        this.confirm('移除此座位？', `<p>${esc(n)} 号 · ${esc(m.name)} 将离开大厅。开局后不能移除玩家。</p>`, () => this.controller.submit({ kind: 'kick', seat: n }), '移除');
                }
                return;
            }
            const a = v.game?.action;
            if (!a || !a.candidates.includes(n) || v.paused)
                return;
            this.selected = this.selected.includes(n) ? this.selected.filter(i => i !== n) : a.targetCount === 1 ? [n] : this.selected.length < a.targetCount ? [...this.selected, n] : this.selected;
            this.render();
            $(`[data-seat="${n}"]`).focus({ preventScroll: true });
            return;
        }
        if (b.dataset.action)
            this.clickAction(b.dataset.action);
    }
    clickAction(action) {
        const s = this.controller.state, v = s.view;
        switch (action) {
            case 'legacy-pending':
                this.legacyPending();
                return;
            case 'voice-settings':
                $('.voice-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            case 'voice-enable':
                this.run(() => this.controller.voice.enable());
                return;
            case 'voice-mic':
                this.run(() => this.controller.voice.mic());
                return;
            case 'voice-toggle':
                this.controller.voice.toggleMic();
                return;
            case 'voice-stop':
                this.controller.voice.stopMic();
                return;
            case 'voice-ptt': return;
            case 'chat-send': {
                const draft = this.chatDraft, revision = this.chatDraftRevision, text = draft.trim();
                if (!text)
                    return;
                this.run(async () => {
                    // submit resolves after the room ACK. A rejection leaves the
                    // draft intact, and an ACK cannot clear text edited meanwhile.
                    await this.controller.submit({ kind: 'chat', text });
                    if (this.chatDraftRevision === revision && this.chatDraft === draft)
                        this.setChatDraft('');
                    this.render();
                });
                return;
            }
            case 'voice-admin':
                this.voiceAdmin();
                return;
            case 'mute-confirm': {
                const seat = Number($('#mute-seat').value), value = $('#mute-value').checked;
                this.closeModal();
                this.run(() => this.controller.submit({ kind: 'mute', seat, value }));
                return;
            }
            case 'diagnostics':
                this.diagnostics();
                return;
            case 'close-modal':
                this.closeModal();
                return;
            case 'confirm-modal':
                this.dialogAction?.();
                return;
            case 'tab-create':
                this.entry = 'create';
                this.render();
                return;
            case 'tab-join':
                this.entry = 'join';
                this.render();
                return;
            case 'create': {
                if (!this.nickname.trim()) {
                    this.toast('请输入昵称。');
                    $('#nickname').focus();
                    return;
                }
                this.rememberName();
                if (s.hasSave && !this.volatile)
                    this.confirm('替换原房主存档？', '<p>创建新房间会替换本机的旧房主存档。仍需继续原局时，请取消并选择「恢复房主存档」。</p>', () => this.controller.create(this.nickname, true, this.size, this.volatile), '创建新房间');
                else
                    this.run(() => this.controller.create(this.nickname, false, this.size, this.volatile));
                return;
            }
            case 'restore':
                this.run(() => this.controller.restore());
                return;
            case 'join': {
                if (!this.nickname.trim()) {
                    this.toast('请输入昵称。');
                    return;
                }
                this.rememberName();
                try {
                    (0, peer_js_1.parseInvitation)(this.invitation);
                }
                catch (e) {
                    this.error = (0, controller_js_1.msg)(e);
                    this.render();
                    return;
                }
                this.run(() => this.controller.join(this.invitation, this.nickname, this.volatile));
                return;
            }
            case 'demo':
                this.run(() => this.controller.demo(this.nickname || '你', this.size));
                return;
            case 'ready':
                if (v)
                    this.run(() => this.controller.submit({ kind: 'ready', value: !v.members.find(m => m.seat === v.self).ready }));
                return;
            case 'start':
                this.confirm('准备开始？', `<p>将为 ${esc(v?.size)} 名玩家分配身份。${v?.isHost && !this.controller.voice.state.enabled ? '房主尚未启用声音，语音暂时不能转发；可以取消后先启用，也可以用文字继续。' : '确认大家可以听到彼此，再开始。'}</p>`, () => this.controller.submit({ kind: 'start' }), '发牌并开始');
                return;
            case 'advance':
                this.run(() => this.controller.submit({ kind: 'advance' }));
                return;
            case 'ack':
                if (v?.game?.actionStepSerial)
                    this.run(() => this.controller.submit({ kind: 'play', serial: v.game.actionStepSerial, move: 'ack' }));
                return;
            case 'submit':
                this.askPlay(false);
                return;
            case 'pass':
                this.askPlay(true);
                return;
            case 'pause':
                this.run(() => this.controller.submit({ kind: 'pause' }));
                return;
            case 'resume':
                this.run(() => this.controller.submit({ kind: 'resume' }));
                return;
            case 'abort':
                this.confirm('中止这局游戏？', '<p>这会停止本局，不计胜负。已保存的公开记录仍可导出。需要等待朋友回来时，应当使用「暂停对局」。</p>', () => this.controller.submit({ kind: 'abort' }), '中止本局');
                return;
            case 'rematch':
                this.confirm('回到大厅，再开一局？', '<p>保留座位与连接，清空上一局身份和行动。所有人重新准备后才能发牌。需要复盘时，请先导出公开记录。</p>', async () => { await this.controller.submit({ kind: 'rematch' }); this.hiddenRole = true; this.journal = 'public'; }, '返回大厅');
                return;
            case 'rename':
                this.rename();
                return;
            case 'toggle-role':
                this.hiddenRole = !this.hiddenRole;
                this.render();
                return;
            case 'my-role':
                if (v?.game)
                    this.modal('我的身份', this.roleContent(v));
                return;
            case 'private-records':
                this.journal = 'private';
                this.render();
                $('.journal').scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            case 'invite':
                this.showInvite();
                return;
            case 'copy-invite':
                this.run(async () => { const el = $('#copy-invite'); try {
                    await navigator.clipboard.writeText(el.value);
                    this.toast('邀请码已复制。');
                }
                catch {
                    el.focus();
                    el.select();
                    this.toast('自动复制被浏览器限制，已选中；按 Ctrl+C 或长按复制。');
                } });
                return;
            case 'public-export':
                this.exportPublic();
                return;
            case 'retry':
                this.controller.retry();
                return;
            case 'reconnect':
                this.run(() => this.controller.reconnectGuest());
                return;
            case 'update-invite':
                this.modal('使用房主的新邀请', '<p>房主恢复后若连接标识改变，请粘贴同一房间的新邀请。原座位、身份与已确认操作会保留。</p><textarea id="new-invite" class="copy-field" aria-label="新的邀请链接"></textarea>', '<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="apply-invite">重新连接</button>');
                return;
            case 'apply-invite': {
                const value = $('#new-invite').value;
                this.closeModal();
                this.run(() => this.controller.updateInvitation(value));
                return;
            }
            case 'home':
                if (v)
                    this.clickAction('exit');
                return;
            case 'exit':
                this.confirm(v?.demo ? '离开演示？' : '暂时离开页面？', `<p>${v?.demo ? '这次演示只保存在内存，离开后重新开始。' : v?.isHost ? '房主离开会使朋友们暂停等待。已保存的房间可在首页恢复。' : '开局后离开会暂停这局游戏。回到原邀请链接可以恢复座位。'}</p>`, () => this.controller.close(), '离开');
                return;
            case 'rules':
                this.rules();
                return;
            case 'sources':
                this.sources();
                return;
            case 'settings':
                this.settings();
                return;
            case 'save-settings':
                this.saveSettings();
                return;
            case 'save-name': {
                const name = $('#new-name').value.trim();
                if (!name)
                    return;
                this.closeModal();
                this.run(() => this.controller.submit({ kind: 'rename', name }));
                return;
            }
        }
    }
    askPlay(pass) {
        const v = this.controller.state.view, g = v?.game, a = g?.action;
        if (!a || !g?.actionStepSerial)
            return;
        const serial = g.actionStepSerial, match = v.matchId;
        if (!pass && this.selected.length !== a.targetCount)
            return;
        if (pass && !(a.canPass || a.canAbstain))
            return;
        const targets = [...this.selected];
        const intent = pass ? (a.kind === 'vote' ? { kind: 'play', serial, move: 'vote', target: null } : { kind: 'play', serial, move: 'pass' }) :
            a.kind === 'vote' ? { kind: 'play', serial, move: 'vote', target: targets[0] } : { kind: 'play', serial, move: 'skill', targets };
        this.confirm(pass ? (a.kind === 'vote' ? '确认弃票？' : '放弃本次技能？') : a.kind === 'vote' ? '确认驱逐 / 绑架票' : '确认技能目标', `${pass ? `<p>${a.kind === 'vote' ? '本轮不投给任何玩家。' : '这次不发动技能，不能在稍后补用。'}</p>` : `<div class="confirm-target">${targets.map(n => `${esc(n)} 号 · ${esc(v.members.find(m => m.seat === n)?.name)}`).join('<br>')}</div>`}<p class="confirmation-note">确认后会锁定并保存到房主端，不可修改。完整结算后，程序自动检查胜利条件。</p>`, async () => {
            if (this.controller.state.view?.matchId !== match)
                throw Error('已经进入另一局，未提交旧操作。');
            await this.controller.submit(intent);
        }, '确认提交');
    }
    rename() {
        const v = this.controller.state.view;
        if (!v)
            return;
        this.modal('修改昵称', `<p>昵称对全员公开，与真实身份无关。</p><input id="new-name" maxlength="16" aria-label="新昵称" value="${esc(v.members.find(m => m.seat === v.self)?.name)}">`, '<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="save-name">保存</button>');
    }
    rememberName() { try {
        localStorage.setItem('rls-nickname', this.nickname);
    }
    catch { /* creating/joining performs its own required durable writes */ } }
    saveNotes(value) {
        this.notes = value;
        try {
            localStorage.setItem(this.notesKey, value);
            $('#notes-status').textContent = '已保存在本机，不会发送给任何人。';
        }
        catch {
            $('#notes-status').textContent = '本环境不能持久保存，笔记仅在当前页面有效。';
        }
    }
    showInvite() {
        try {
            const link = this.controller.getInvite();
            this.modal('邀请玩家', `<p>把同一版本的 HTML 文件发给朋友。对方用浏览器打开，选择“加入房间”，粘贴下面的完整邀请码。无需访问你电脑上的文件路径。</p><textarea id="copy-invite" class="copy-field" readonly aria-label="完整邀请码">${esc(link)}</textarea><p class="hintbox">房主保持页面打开。所有人仍需联网；信令或网络穿透失败时，查看“连接检查”。文件名不参与房间识别。</p>`, '<button class="btn" data-action="close-modal">关闭</button><button class="btn primary" data-action="copy-invite">复制邀请 ' + copy + '</button>');
        }
        catch (e) {
            this.toast((0, controller_js_1.msg)(e));
        }
    }
    exportPublic() {
        try {
            const blob = new Blob([this.controller.exportPublic()], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url;
            a.download = '人类杀_公开对局记录.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this.toast('公开记录已导出，不含私密笔记或未公开底牌。');
        }
        catch (e) {
            this.toast((0, controller_js_1.msg)(e));
        }
    }
    rules() {
        this.modal('规则速览', `<p>支持 6、8、10、12 人，四个阵营。12 人遵循规则 v1.0：完整结算一个动作，再立即判胜。同次检查达标的阵营共同获胜，已出局成员也分享本阵营胜利。</p>${Object.entries(catalog_js_1.WIN).map(([f, text]) => `<div class="rule-row"><b>${model_js_1.FACTION_NAMES[f]}</b><span>${esc(text)}</span></div>`).join('')}<h3>每天的流程</h3><p>子夜 → 夜间出局公告 → 白天 → 日落 → 午夜 → 次日子夜。讨论与遗言由房主推进；秘密行动、投票与判胜由程序结算。</p><div class="help-cards"><div><h3>投票</h3><p>可以投自己，也可以弃票，食人妖怪的绑架票除外。平票只重投一次。最后一名妖精在第一次并列最高时也可能直接获胜。</p></div><div><h3>信息</h3><p>一般出局不翻牌；鬼、吸血鬼能力要求的翻牌永久公示。夜间实际出局立即生效，但出局名单等到公告时公开。</p></div></div><h3>小型对局（试行）</h3><p>6 人：1 神明、2 人类（巫女＋普通人类）、1 妖精、2 妖怪。8 人：1／3／2／2；10 人：1／4／2／3。8、10 人的御阿礼之子查验 2 人。吸血鬼左右找到同一普通人类时，只提供该人一个选项。其他胜利与结算规则不变。小型配置尚未经过平衡性验证。</p><h3>全部身份</h3><div class="rules-roles">${Object.keys(model_js_1.ROLE_NAMES).map(r => `<details><summary>${model_js_1.ROLE_NAMES[r]} <span class="badge">${esc(model_js_1.FACTION_NAMES[(0, model_js_1.faction)(r)])}</span></summary><p>${esc(catalog_js_1.ROLE_META[r].ability)}</p></details>`).join('')}</div><h3>断线不是弃票</h3><p>有人离线时全局暂停，包括已经出局的玩家。重连不会重发身份；全员在线后，房主点击继续。房主掉线时，等待其从本地存档恢复。</p><p class="callout">网页提供房主转发语音。大厅和终局自由发言；讨论和投票时在场玩家可发言；遗言仅该玩家；夜间、公告、暂停静音。文字遵循相同发言权限。不录音。</p>`, undefined, true);
    }
    sources() {
        this.modal('关于与素材', `<p>人类杀 · 私人联机试玩版 ${esc(types_js_1.APP_VERSION)}。原生 HTML / CSS + TypeScript 规则引擎；房主裁判，原生 WebRTC 传输；兼容 PeerServer 信令。</p><div class="source-entry"><a href="https://touhougarakuta.com/" target="_blank" rel="noopener noreferrer">東方我楽多叢誌 ↗</a><small>参考内容层级和克制的栏目组织，不搬用整站美术。</small></div><div class="source-entry"><a href="https://touhou-project.news/" target="_blank" rel="noopener noreferrer">東方Project よもやまニュース ↗</a><small>参考信息分类；纸白、墨字、朱红和座位组件沿用已确认的 v0.2 原型。</small></div><div class="source-entry"><a href="https://touhou-x.jp/" target="_blank" rel="noopener noreferrer">東方Project 25年記念サイト ↗</a><small>可选的小幅灵梦图来自该站。©上海アリス幻樂団 ©アンノウンX。图像不打包；加载失败时保留文字印记。</small></div><label class="field"><input type="checkbox" id="external-art" ${this.externalArt ? 'checked' : ''}>允许从纪念站加载身份卡小图</label><p class="source-detail">默认不请求第三方图片。开启外链不等于取得再分发许可；公开发行请使用有明确许可的素材。没有随工程打包字体或外部插画。</p><label class="localfile">使用你有权使用的角色图（仅本机）<input id="portrait-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择自己的角色图"></label><p class="source-detail">图片只保留在当前页面，不发送给房主、其他玩家或服务器。</p><h3>数据与信任边界</h3><p>房主浏览器保存完整底牌与本地存档，熟人局默认信任房主。其他玩家只接收自己的可见状态。清理站点数据可能使存档或座位凭证丢失。</p>`, undefined, true);
        $('#external-art').onchange = e => { this.externalArt = e.target.checked; try {
            localStorage.setItem('rls-external-art', this.externalArt ? '1' : '0');
        }
        catch { /* session only */ } this.render(); };
        $('#portrait-file').onchange = e => {
            const f = e.target.files?.[0];
            if (!f)
                return;
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > 4 * 1024 * 1024) {
                this.toast('请选择 4 MB 内的 PNG、JPEG 或 WebP 图片。');
                return;
            }
            if (this.portraitObjectURL)
                URL.revokeObjectURL(this.portraitObjectURL);
            this.portraitObjectURL = URL.createObjectURL(f);
            this.portrait = this.portraitObjectURL;
            this.render();
            this.toast('角色图已替换，仅当前页面可见。');
        };
    }
    bindImages() {
        document.querySelectorAll('.role-art img').forEach(img => {
            img.onload = () => img.parentElement?.classList.add('loaded');
            img.onerror = () => { img.hidden = true; img.parentElement?.classList.remove('loaded'); };
            if (img.complete && img.naturalWidth > 0)
                img.onload(new Event('load'));
        });
    }
    settings() {
        if (this.controller.state.mode !== 'home') {
            this.toast('请先离开当前房间，再修改联机设置。');
            return;
        }
        const n = this.controller.settings;
        this.modal('联机设置', `<p>留空使用 PeerJS 公共信令。信令只帮助建联，不运行裁判。跨网连接失败时，需要部署者提供可达的信令或 TURN。</p><label class="field"><span>PeerServer 主机（可留空）</span><input id="net-host" placeholder="signal.example.com" value="${esc(n.host ?? '')}"></label><div class="help-cards"><label class="field"><span>端口</span><input id="net-port" type="number" min="1" max="65535" value="${esc(n.port ?? 443)}"></label><label class="field"><span>路径</span><input id="net-path" value="${esc(n.path ?? '/')}"></label></div><label class="field"><span>PeerServer key（通常为 peerjs）</span><input id="net-key" maxlength="100" value="${esc(n.key ?? 'peerjs')}"></label><label class="field"><input id="net-secure" type="checkbox" ${n.secure !== false ? 'checked' : ''}>使用 HTTPS / WSS（公开部署需要）</label><label class="field"><span>ICE servers（JSON；支持 STUN / TURN）</span><textarea id="net-ice" class="settings-code" spellcheck="false">${esc(JSON.stringify(n.iceServers, null, 2))}</textarea></label><p class="source-detail">TURN 凭证本来就会发送给浏览器，请使用有限期凭证。不要把私钥或管理密码填在这里。信令设置随邀请分享，ICE 凭证不会写入邀请。</p>`, '<button class="btn" data-action="close-modal">取消</button><button class="btn primary" data-action="save-settings">保存设置</button>', true);
    }
    saveSettings() {
        try {
            const host = $('#net-host').value.trim(), port = Number($('#net-port').value), path = $('#net-path').value.trim(), secure = $('#net-secure').checked, key = $('#net-key').value.trim() || 'peerjs';
            const ice = JSON.parse($('#net-ice').value);
            if (!Array.isArray(ice) || ice.length > 10 || ice.some(x => !x || typeof x !== 'object' || !('urls' in x) || !(typeof x.urls === 'string' || Array.isArray(x.urls))))
                throw Error('ICE servers 需要是带 urls 字段的数组。');
            if (host && !/^[a-zA-Z0-9.-]+$/.test(host))
                throw Error('主机只填写域名或 IP，不含协议和路径。');
            if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.startsWith('/'))
                throw Error('端口或路径无效。');
            this.controller.setSettings({ ...(host ? { host, port, path, secure, key } : {}), iceServers: ice });
            this.closeModal();
            this.toast('联机设置已保存。');
        }
        catch (e) {
            this.toast((0, controller_js_1.msg)(e));
        }
    }
}
exports.App = App;

