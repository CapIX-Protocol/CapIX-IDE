/**
 * capixCodePanelScript — the Capix Code webview client script (streaming
 * renderer, slash commands, @-mention file picker, diff panel, approvals).
 * Template-literal JS: backslashes are doubled intentionally.
 */

import { SLASH_HTML } from "./capixCodePanelStyles";
import { icon } from "./webviewIcons";

export const PANEL_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let streaming = false;
  let currentMode = 'ask';
  let activeAssistant = null;
  let activeTextRaw = '';
  let activeTools = new Map();   // callId -> tool-card element
  let diffExpanded = true;

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  const conversation = $('conversation');
  const emptyState = $('empty-state');
  const input = $('composer-input');

  function clearEmpty() { if (emptyState) emptyState.remove(); }

  function appendTurn(role, content) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'assistant');
    div.innerHTML = '<div class="msg-role">' + (role === 'user' ? 'You' : 'Capix Code') + '</div><div class="msg-body"></div>';
    conversation.appendChild(div);
    conversation.scrollTop = conversation.scrollHeight;
    return div.querySelector('.msg-body');
  }

  function startAssistant(mode) {
    clearEmpty();
    const div = document.createElement('div');
    div.className = 'msg assistant';
    if (mode === 'plan') div.insertAdjacentHTML('afterbegin', '<span class="route-pill">Planning</span>');
    div.innerHTML = '<div class="msg-role"><span class="working-dot"></span> Capix Code · Working…</div><div class="msg-body"></div>';
    conversation.appendChild(div);
    activeAssistant = div.querySelector('.msg-body');
    activeTextRaw = '';
    activeTools = new Map();
    conversation.scrollTop = conversation.scrollHeight;
    return div;
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }

  function setStreaming(v) {
    streaming = v;
    $('send-btn').hidden = v;
    $('stop-btn').hidden = !v;
  }

  function pickMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('chip-mode').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  }

  function showSlashMenu(show) {
    const menu = $('slash-menu');
    menu.hidden = !show;
    if (show && !menu.children.length) menu.innerHTML = ${JSON.stringify(SLASH_HTML)} || '';
  }

  function selectCodeTab(tab) {
    document.querySelectorAll('[data-code-tab]').forEach((el) => el.classList.toggle('active', el.dataset.codeTab === tab));
    document.querySelectorAll('[data-code-pane]').forEach((el) => el.classList.toggle('active', el.dataset.codePane === tab));
    vscode.setState({ ...(vscode.getState() || {}), codeTab: tab });
    vscode.postMessage({ type: 'selectCodeTab', tab });
  }

  function renderSessions(sessions, error) {
    const list = $('sessions-list');
    if (!list) return;
    if (error) {
      list.innerHTML = '<div class="management-empty">' + esc(error) + '</div>';
      return;
    }
    if (!Array.isArray(sessions) || !sessions.length) {
      list.innerHTML = '<div class="management-empty">No sessions yet. Start one here and it will remain available across Capix Code.</div>';
      return;
    }
    list.innerHTML = sessions.map((session) => {
      const count = Array.isArray(session.messages) ? session.messages.length : 0;
      const cost = session.costMinor ? ' · ' + esc(session.costMinor) + ' ' + esc(session.currency || '') : '';
      return '<div class="session-row"><div><strong>' + esc(session.modelId || 'Capix Auto') +
        '</strong><span>' + esc(String(session.id).slice(0, 14)) + ' · ' + count + ' messages' + cost +
        '</span></div><button data-resume-session="' + esc(session.id) + '">Resume</button></div>';
    }).join('');
  }


  // ── @ file mentions ───────────────────────────────────────────────────
  const mentionMenu = $('mention-menu');
  let mentionItems = [];
  let mentionActive = -1;
  const mentionSet = new Set();
  let mentionDebounce = null;

  function mentionQuery() {
    const v = input.value;
    const caret = input.selectionStart === null ? v.length : input.selectionStart;
    const before = v.slice(0, caret);
    const m = before.match(/@([\\w.\\-\\/]*)$/);
    return m ? { query: m[1], start: caret - m[0].length } : null;
  }

  function hideMentionMenu() {
    mentionMenu.hidden = true;
    mentionItems = [];
    mentionActive = -1;
  }

  function renderMentionMenu(files, query) {
    mentionItems = files || [];
    mentionActive = mentionItems.length ? 0 : -1;
    if (!mentionItems.length) {
      mentionMenu.innerHTML = '<div class="mention-hint">No files match "' + (query || '') + '"</div>';
      mentionMenu.hidden = false;
      return;
    }
    mentionMenu.innerHTML = mentionItems.map(function (f, i) {
      const parts = f.split('/');
      const name = parts.pop();
      return '<div class="mention-item' + (i === mentionActive ? ' active' : '') + '" data-mention="' + f + '">' +
        '<span class="mention-name">' + name + '</span>' +
        '<span class="mention-dir">' + (parts.length ? parts.join('/') : '') + '</span></div>';
    }).join('') + '<div class="mention-hint">↑↓ navigate · Enter/Tab attach · Esc dismiss</div>';
    mentionMenu.hidden = false;
  }

  function pickMention(path) {
    const mq = mentionQuery();
    if (!mq) { hideMentionMenu(); return; }
    const v = input.value;
    const caret = input.selectionStart === null ? v.length : input.selectionStart;
    input.value = v.slice(0, mq.start) + '@' + path + ' ' + v.slice(caret);
    mentionSet.add(path);
    hideMentionMenu();
    autoGrow();
    input.focus();
  }

  input.addEventListener('input', () => {
    clearTimeout(mentionDebounce);
    const mq = mentionQuery();
    if (!mq) { hideMentionMenu(); return; }
    mentionDebounce = setTimeout(() => {
      vscode.postMessage({ type: 'listFiles', query: mq.query });
    }, 180);
  });

  // ── Markdown (code fences + inline code/bold + line breaks) ──────────────
  function renderInlineMd(text) {
    let s = esc(text);
    s = s.replace(/\`([^\`]+)\`/g, '<code class="inline">$1</code>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    return s.replace(/\\n/g, '<br>');
  }
  function renderMarkdown(text) {
    let html = '';
    let i = 0;
    while (i < text.length) {
      const fence = text.indexOf('\`\`\`', i);
      if (fence === -1) { html += '<p>' + renderInlineMd(text.slice(i)) + '</p>'; break; }
      if (fence > i) html += '<p>' + renderInlineMd(text.slice(i, fence)) + '</p>';
      const afterFence = text.slice(fence + 3);
      const nl = afterFence.indexOf('\\n');
      const lang = nl >= 0 ? afterFence.slice(0, nl) : afterFence;
      const codeStart = nl >= 0 ? fence + 3 + nl + 1 : fence + 3;
      const close = text.indexOf('\`\`\`', codeStart);
      if (close === -1) {
        const code = text.slice(codeStart);
        html += '<pre class="code-block" data-lang="' + esc(lang || 'code') + '"><code>' + esc(code) + '</code></pre>';
        i = text.length;
      } else {
        const code = text.slice(codeStart, close);
        html += '<pre class="code-block" data-lang="' + esc(lang || 'code') + '"><code>' + esc(code) + '</code></pre>';
        i = close + 3;
      }
    }
    return html;
  }

  function appendText(content) {
    if (!activeAssistant) startAssistant(currentMode);
    activeTextRaw += content;
    let block = activeAssistant.querySelector('.text-block');
    if (!block) {
      block = document.createElement('div');
      block.className = 'text-block cursor';
      activeAssistant.appendChild(block);
    }
    block.innerHTML = renderMarkdown(activeTextRaw);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function toolLabel(tool, args) {
    if (!args || typeof args !== 'object') return tool;
    const a = args;
    const fp = a.file_path || a.path || a.file || a.target;
    const cmd = a.command || a.cmd;
    const pat = a.pattern || a.query || a.glob;
    if (fp) {
      if (/edit|write|str_replace|update|patch|apply/i.test(tool)) return 'Editing ' + fp;
      if (/read|view|cat|open/i.test(tool)) return 'Reading ' + fp;
      if (/delete|remove|rm/i.test(tool)) return 'Deleting ' + fp;
      return (tool + ' · ' + fp);
    }
    if (cmd) return 'Running: ' + cmd;
    if (pat) return 'Searching: ' + pat;
    return tool;
  }

  function appendToolCall(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const label = toolLabel(evt.tool, evt.args);
    const card = document.createElement('div');
    card.className = 'tool-card collapsed';
    card.dataset.callId = evt.callId;
    card.innerHTML = '<div class="tool-head"><span class="tool-glyph">${icon("tool")}</span><span class="tool-label">' + esc(label) + '</span><span class="tool-chev">${icon("chevron-right")}</span></div><div class="tool-out"></div>';
    activeAssistant.appendChild(card);
    activeTools.set(evt.callId, card);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendToolResult(evt) {
    const card = activeTools.get(evt.callId);
    if (!card) return;
    const out = card.querySelector('.tool-out');
    if (out) out.textContent += evt.output + '\\n';
    card.classList.remove('collapsed');
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendFileChanged(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const chip = document.createElement('span');
    chip.className = 'file-chip ' + evt.changeType;
    const glyph = evt.changeType === 'created' ? '${icon("add")}' : evt.changeType === 'deleted' ? '${icon("trash")}' : '${icon("edit")}';
    chip.innerHTML = '<span>' + glyph + '</span>' + esc(evt.filePath);
    activeAssistant.appendChild(chip);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendPlan(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const wrap = document.createElement('div');
    wrap.className = 'plan-wrap';
    const steps = Array.isArray(evt.plan) ? evt.plan
      : (evt.plan && Array.isArray(evt.plan.steps)) ? evt.plan.steps
      : (evt.plan && Array.isArray(evt.plan.items)) ? evt.plan.items : null;
    const items = steps ? steps.map((s) => {
      const isObj = s && typeof s === 'object';
      const text = isObj ? (s.description || s.text || s.summary || JSON.stringify(s)) : String(s);
      const done = isObj ? !!s.done : false;
      return '<li class="plan-item' + (done ? ' done' : '') + '"><span class="plan-check"></span><span class="plan-text">' + esc(text) + '</span></li>';
    }).join('') : '<li class="plan-item"><span class="plan-check"></span><span class="plan-text">' + esc(typeof evt.plan === 'string' ? evt.plan : JSON.stringify(evt.plan)) + '</span></li>';
    wrap.innerHTML = '<ul class="plan-list">' + items + '</ul>';
    activeAssistant.appendChild(wrap);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function showApproval(evt) {
    if (!activeAssistant) startAssistant(currentMode);
    const modal = document.createElement('div');
    modal.className = 'approval';
    modal.dataset.callId = evt.callId;
    modal.innerHTML = '<div class="approval-head">Approval required</div>' +
      '<div class="approval-desc"><b>' + esc(evt.tool) + '</b> — ' + esc(evt.description) + '</div>' +
      '<div class="approval-actions">' +
        '<button class="approval-btn approve" data-approve="1" data-call-id="' + esc(evt.callId) + '">Approve</button>' +
        '<button class="approval-btn deny" data-approve="0" data-call-id="' + esc(evt.callId) + '">Deny</button>' +
      '</div>';
    activeAssistant.appendChild(modal);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function dismissApproval(callId) {
    const m = activeAssistant && activeAssistant.querySelector('.approval[data-call-id="' + cssAttr(callId) + '"]');
    if (m) m.remove();
  }
  function cssAttr(s) { return String(s).replace(/"/g, ''); }

  function finishAssistant(msg) {
    const msgEl = activeAssistant && activeAssistant.closest('.msg');
    if (msgEl) {
      const role = msgEl.querySelector('.msg-role');
      if (role) role.innerHTML = 'Capix Code';
    }
    const tb = activeAssistant && activeAssistant.querySelector('.text-block');
    if (tb) tb.classList.remove('cursor');
    if (msg) appendText('\\n' + msg);
  }

  // ── Diff panel ───────────────────────────────────────────────────────────
  function renderDiffPanel(files) {
    const panel = $('diff-panel');
    const list = $('diff-files');
    if (!files || !files.length) { panel.hidden = true; list.innerHTML = ''; return; }
    panel.hidden = false;
    $('diff-title').textContent = 'Agent changes (' + files.length + ')';
    list.innerHTML = files.map((f) => {
      const tag = f.changeType || 'modified';
      return '<div class="diff-file">' +
        '<div class="diff-file-head">' +
          '<span class="diff-file-path">' + esc(f.filePath) + '</span>' +
          '<span class="diff-file-tag ' + tag + '">' + tag + '</span>' +
          '<span class="diff-file-actions">' +
            '<button class="diff-mini acc" data-accept-file="' + esc(f.filePath) + '">Accept</button>' +
            '<button class="diff-mini rev" data-revert-file="' + esc(f.filePath) + '">Revert</button>' +
          '</span>' +
        '</div>' +
        '<pre>' + esc(f.diff || '') + '</pre>' +
      '</div>';
    }).join('');
  }

  // ── Event delegation (CSP-safe) ───────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;

    // Tool card collapse toggle (header click)
    const head = t && t.closest('.tool-head');
    if (head && !e.target.closest('.tool-out')) {
      head.closest('.tool-card').classList.toggle('collapsed');
      return;
    }

    // Approval buttons
    const appr = t && t.closest('[data-approve]');
    if (appr) {
      const callId = appr.getAttribute('data-call-id');
      const approved = appr.getAttribute('data-approve') === '1';
      dismissApproval(callId);
      vscode.postMessage({ type: 'approve', callId, approved });
      return;
    }

    // Per-file accept/revert in diff panel
    const accFile = t && t.closest('[data-accept-file]');
    if (accFile) {
      vscode.postMessage({ type: 'acceptFile', filePath: accFile.getAttribute('data-accept-file') });
      return;
    }
    const revFile = t && t.closest('[data-revert-file]');
    if (revFile) {
      vscode.postMessage({ type: 'revertFile', filePath: revFile.getAttribute('data-revert-file') });
      return;
    }

    const prompt = t && t.closest('[data-prompt]');
    if (prompt) {
      input.value = prompt.getAttribute('data-prompt') || '';
      autoGrow();
      input.focus();
      return;
    }

    const tab = t && t.closest('[data-code-tab]');
    if (tab) {
      selectCodeTab(tab.getAttribute('data-code-tab') || 'chat');
      return;
    }
    const resume = t && t.closest('[data-resume-session]');
    if (resume) {
      vscode.postMessage({ type: 'resumeAgentSession', id: resume.getAttribute('data-resume-session') });
      return;
    }

    const tgt = t && t.closest('[data-cmd],[data-mode],[data-slash],[data-mention]');
    if (!tgt) return;
    if (t && t.dataset && t.dataset.mode) { pickMode(t.dataset.mode); vscode.postMessage({ type: 'setMode', mode: t.dataset.mode }); return; }

    const el = tgt;
    if (el.dataset.mode) { pickMode(el.dataset.mode); vscode.postMessage({ type: 'setMode', mode: el.dataset.mode }); return; }
    if (el.dataset.slash) { input.value = el.dataset.slash + ' '; showSlashMenu(false); autoGrow(); input.focus(); return; }
    if (el.dataset.mention) { pickMention(el.dataset.mention); return; }
    if (el.dataset.cmd === 'toggleDiff') {
      diffExpanded = !diffExpanded;
      $('diff-panel').classList.toggle('collapsed', !diffExpanded);
      return;
    }
    if (el.dataset.cmd === 'submit') {
      const text = input.value.trim();
      if (!text || streaming) return;
      appendTurn('user', text);
      activeAssistant = null; activeTextRaw = ''; activeTools = new Map();
      input.value = ''; autoGrow();
      const mentions = Array.from(mentionSet);
      mentionSet.clear();
      hideMentionMenu();
      vscode.postMessage({ type: 'submit', text, mode: currentMode, mentions });
      setStreaming(true);
    } else if (el.dataset.cmd === 'stop') {
      vscode.postMessage({ type: 'stop' });
    } else {
      vscode.postMessage({ type: el.dataset.cmd });
    }
  });

  input.addEventListener('input', () => {
    autoGrow();
    const v = input.value;
    showSlashMenu(v.startsWith('/') && !v.includes(' '));
  });
  input.addEventListener('keydown', (e) => {
    if (!mentionMenu.hidden && mentionItems.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActive = (mentionActive + (e.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length;
        mentionMenu.querySelectorAll('.mention-item').forEach(function (el, i) {
          el.classList.toggle('active', i === mentionActive);
        });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mentionItems[mentionActive]);
        return;
      }
      if (e.key === 'Escape') { hideMentionMenu(); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('send-btn').click();
    }
  });
  $('provider-select').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'setProvider', provider: e.target.value });
  });

  // ── Messages from extension host ─────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'fileList': {
          const mqNow = mentionQuery();
          if (mqNow) renderMentionMenu(msg.files || [], mqNow.query);
          break;
        }
      case 'state':
        $('conn-dot').className = 'conn-dot ' + (msg.engineStatus === 'online' ? 'online' : (msg.configured ? 'offline' : 'offline'));
        $('auth-banner').hidden = !!msg.configured;
        $('session-title').textContent = msg.sessionId ? ('Session ' + String(msg.sessionId).slice(0, 8)) : 'Capix Code';
        $('chip-project').textContent = msg.project || '—';
        $('chip-model').textContent = msg.model || 'auto';
        $('provider-select').value = msg.preferredProvider || 'auto';
        if (msg.mode) pickMode(msg.mode);
        if (msg.streaming) setStreaming(true);
        break;
      case 'sessions':
        renderSessions(msg.sessions, msg.error);
        break;
      case 'turn':
        appendTurn(msg.role, msg.content);
        activeAssistant = null; activeTextRaw = ''; activeTools = new Map();
        break;
      case 'streamStart':
        startAssistant(msg.mode);
        break;
      case 'engineEvent': {
        const evt = msg.event;
        if (!evt) break;
        if (evt.type === 'text') appendText(evt.content);
        else if (evt.type === 'tool_call') appendToolCall(evt);
        else if (evt.type === 'tool_result') appendToolResult(evt);
        else if (evt.type === 'file_changed') appendFileChanged(evt);
        else if (evt.type === 'plan') appendPlan(evt);
        else if (evt.type === 'approval_request') showApproval(evt);
        break;
      }
      case 'usage':
        $('cost-estimate').textContent = '$' + Number(msg.costUsd || 0).toFixed(4);
        break;
      case 'streamDone':
        finishAssistant();
        setStreaming(false);
        break;
      case 'streaming':
        setStreaming(msg.value);
        if (!msg.value) finishAssistant();
        break;
      case 'error':
        setStreaming(false);
        appendTurn('assistant', '⚠ ' + esc(msg.message));
        activeAssistant = null;
        break;
      case 'cleared':
        conversation.innerHTML = '';
        activeAssistant = null; activeTextRaw = ''; activeTools = new Map();
        if (!$('empty-state')) {
          const es = document.createElement('div');
          es.className = 'empty-state'; es.id = 'empty-state';
          es.innerHTML = '<div class="empty-glyph">✦</div><span class="empty-kicker">Workspace agent</span><h2>Build from here.</h2><p>Capix Code can understand the project, edit files, run commands and verify the result.</p>';
          conversation.appendChild(es);
        }
        break;
      case 'attached':
        $('attach-bar').hidden = false;
        $('attach-chip').textContent = '📎 ' + msg.name;
        break;
      case 'attachCleared':
        $('attach-bar').hidden = true;
        break;
      case 'compose':
        input.value = msg.text; autoGrow(); input.focus();
        break;
      case 'density':
        document.body.classList.toggle('compact', !!msg.compact);
        break;
      case 'diffPanel':
        renderDiffPanel(msg.files);
        break;
      case 'checkpointCreated':
        appendTurn('assistant', '✓ Checkpoint created: ' + esc(msg.id));
        activeAssistant = null;
        break;
    }
  });

  autoGrow();
  const restored = vscode.getState();
  if (restored && restored.codeTab) selectCodeTab(restored.codeTab);
`;
