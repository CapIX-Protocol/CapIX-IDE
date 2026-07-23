/**
 * capixCodePanelStyles — slash-command registry and inline styles for the
 * Capix Code panel, including the Capix polish layer (scrollbars, tabular
 * numerals, hover states, @-mention menu). No vscode imports.
 */

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/explain", desc: "Explain the selected code" },
  { cmd: "/test", desc: "Generate tests" },
  { cmd: "/review", desc: "Review changes" },
  { cmd: "/fix", desc: "Fix the error" },
  { cmd: "/refactor", desc: "Refactor the code" },
];

export const SLASH_HTML = SLASH_COMMANDS.map(
  (s) => `<div class="slash-item" data-slash="${s.cmd}"><span class="slash-cmd">${s.cmd}</span><span class="slash-desc">${s.desc}</span></div>`,
).join("");

// ── Inline styles + script ──────────────────────────────────────────────────
// @capix/ui-tokens: dark foundation, cyan accents, green primary.

export const PANEL_STYLES = `
  :root {
    --capix-bg: var(--vscode-sideBar-background, #14161a);
    --capix-surface: var(--vscode-sideBarSectionHeader-background, rgba(255,255,255,0.03));
    --capix-border: var(--vscode-panel-border, rgba(255,255,255,0.08));
    --capix-fg: var(--vscode-foreground, #d4d4d4);
    --capix-muted: rgba(212,212,212,0.55);
    --capix-cyan: #3DCED6;
    --capix-green: #14F195;
    --capix-amber: #FFAE00;
    --capix-red: #FF6464;
    --capix-blue: #5A9DFF;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    color: var(--capix-fg); background: var(--capix-bg);
    display: flex; flex-direction: column; font-size: 12px;
    overflow: hidden;
  }
  .panel-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; border-bottom: 1px solid var(--capix-border);
  }
  .header-left { display: flex; align-items: center; gap: 8px; }
  .session-title { font-weight: 600; font-size: 12px; }
  .conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--capix-muted); flex: none; }
  .conn-dot.online { background: var(--capix-green); box-shadow: 0 0 6px rgba(20,241,149,0.6); }
  .conn-dot.offline { background: var(--capix-amber); }
  .header-actions { display: flex; gap: 2px; }
  .hdr-btn {
    background: transparent; border: none; cursor: pointer; color: var(--capix-muted);
    font-family: inherit; font-size: 13px; padding: 3px 6px; border-radius: 5px;
  }
  .hdr-btn:hover { background: rgba(255,255,255,0.08); color: var(--capix-fg); }
  .meta-row { display: flex; gap: 4px; padding: 6px 10px; flex-wrap: wrap; }
  .meta-chip {
    font-size: 9px; padding: 2px 8px; border-radius: 999px;
    background: var(--capix-surface); border: 1px solid var(--capix-border);
    color: var(--capix-muted); text-transform: uppercase; letter-spacing: .04em;
  }
  .route-control { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; color: var(--capix-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .04em; }
  .route-control select { max-width: 132px; border: 1px solid var(--capix-border); border-radius: 999px; background: var(--capix-surface); color: var(--capix-fg); font: inherit; padding: 2px 7px; outline: none; }
  .route-control select:focus { border-color: rgba(61,206,214,.55); }
  #chip-mode { color: var(--capix-cyan); }
  .conversation { flex: 1; overflow-y: auto; padding: 10px; }
  .empty-state { text-align: center; color: var(--capix-muted); padding: 40px 16px; }
  .empty-glyph { font-size: 28px; opacity: .4; margin-bottom: 8px; }
  .msg { margin-bottom: 12px; }
  .msg-role {
    font-size: 9px; text-transform: uppercase; letter-spacing: .1em;
    color: var(--capix-muted); margin-bottom: 3px; display: flex; align-items: center; gap: 6px;
  }
  .msg.user .msg-role { color: var(--capix-cyan); }
  .msg.assistant .msg-role { color: var(--capix-green); }
  .msg-role .working-dot {
    width: 6px; height: 6px; border-radius: 50%; background: var(--capix-cyan);
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .3; } 50% { opacity: 1; } }
  .msg-body { line-height: 1.5; word-break: break-word; }
  .msg-body p { margin: 0 0 6px; white-space: pre-wrap; }
  .text-block { white-space: normal; }
  .text-block .cursor::after { content: '▋'; color: var(--capix-cyan); animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .msg-body pre.code-block {
    background: rgba(0,0,0,0.32); border: 1px solid var(--capix-border); border-radius: 6px;
    padding: 8px; overflow-x: auto; margin: 6px 0; position: relative;
  }
  .msg-body pre.code-block::before {
    content: attr(data-lang); position: absolute; top: 4px; right: 8px;
    font-size: 8px; color: var(--capix-muted); text-transform: uppercase; letter-spacing: .08em;
  }
  .msg-body code, .msg-body pre code {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
  }
  .msg-body code.inline {
    background: rgba(61,206,214,0.12); color: var(--capix-cyan);
    padding: 1px 4px; border-radius: 4px; font-size: 11px;
  }
  .msg-body strong { color: var(--capix-fg); font-weight: 700; }

  /* Tool cards */
  .tool-card {
    border: 1px solid var(--capix-border); border-radius: 8px;
    background: var(--capix-surface); margin: 6px 0; overflow: hidden;
  }
  .tool-head {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer;
    font-size: 11px; color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace);
  }
  .tool-head .tool-glyph { font-size: 12px; opacity: .9; }
  .tool-head .tool-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tool-head .tool-chev { color: var(--capix-muted); font-size: 10px; }
  .tool-card.collapsed .tool-out { display: none; }
  .tool-out {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
    white-space: pre-wrap; word-break: break-word; color: var(--capix-muted);
    padding: 8px 10px; border-top: 1px solid var(--capix-border); max-height: 180px; overflow-y: auto;
  }

  /* File change chips */
  .file-chip {
    display: inline-flex; align-items: center; gap: 5px; font-size: 10px;
    background: rgba(20,241,149,0.1); color: var(--capix-green);
    padding: 2px 8px; border-radius: 5px; margin: 3px 4px 0 0;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .file-chip.created { color: var(--capix-green); background: rgba(20,241,149,0.1); }
  .file-chip.modified { color: var(--capix-amber); background: rgba(255,174,0,0.1); }
  .file-chip.deleted { color: var(--capix-red); background: rgba(255,100,100,0.1); }

  /* Plan checklist */
  .plan-list { margin: 6px 0; padding-left: 0; list-style: none; }
  .plan-item {
    display: flex; align-items: flex-start; gap: 6px; padding: 4px 0;
    font-size: 11px; color: var(--capix-fg);
  }
  .plan-item .plan-check {
    width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--capix-border);
    flex: none; margin-top: 2px; display: inline-block; position: relative;
  }
  .plan-item.done .plan-check { background: var(--capix-green); border-color: var(--capix-green); }
  .plan-item.done .plan-check::after {
    content: '✓'; position: absolute; inset: 0; color: #000; font-size: 9px; text-align: center; line-height: 12px;
  }
  .plan-item.done .plan-text { color: var(--capix-muted); text-decoration: line-through; }

  /* Attach + slash */
  .attach-bar { padding: 4px 10px; }
  .attach-chip {
    display: inline-flex; align-items: center; gap: 6px; font-size: 10px;
    background: rgba(61,206,214,0.1); color: var(--capix-cyan);
    padding: 3px 8px; border-radius: 5px;
  }
  .attach-x { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; }
  .slash-menu { margin: 0 10px; border: 1px solid var(--capix-border); border-radius: 6px; background: var(--capix-surface); overflow: hidden; }
  .slash-item { display: flex; justify-content: space-between; padding: 6px 10px; cursor: pointer; font-size: 11px; }
  .slash-item:hover { background: rgba(61,206,214,0.1); }
  .slash-cmd { color: var(--capix-cyan); font-family: var(--vscode-editor-font-family, monospace); }
  .slash-desc { color: var(--capix-muted); }

  /* Diff panel */
  .diff-panel {
    border-top: 1px solid var(--capix-border); background: var(--capix-surface);
    max-height: 40%; display: flex; flex-direction: column;
  }
  .diff-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; border-bottom: 1px solid var(--capix-border);
  }
  .diff-title { font-size: 10px; color: var(--capix-green); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  .diff-actions { display: flex; gap: 4px; align-items: center; }
  .diff-btn {
    background: transparent; border: 1px solid var(--capix-border); cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 10px;
    padding: 3px 8px; border-radius: 5px;
  }
  .diff-btn:hover { color: var(--capix-fg); }
  .diff-btn.accept { color: var(--capix-green); border-color: rgba(20,241,149,0.3); }
  .diff-btn.revert { color: var(--capix-red); border-color: rgba(255,100,100,0.3); }
  .diff-files { overflow-y: auto; }
  .diff-file {
    border-bottom: 1px solid var(--capix-border); padding: 6px 10px;
  }
  .diff-file-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .diff-file-path {
    flex: 1; font-size: 10px; font-family: var(--vscode-editor-font-family, monospace);
    color: var(--capix-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .diff-file-tag { font-size: 8px; padding: 1px 5px; border-radius: 3px; text-transform: uppercase; }
  .diff-file-tag.created { background: rgba(20,241,149,0.15); color: var(--capix-green); }
  .diff-file-tag.modified { background: rgba(255,174,0,0.15); color: var(--capix-amber); }
  .diff-file-tag.deleted { background: rgba(255,100,100,0.15); color: var(--capix-red); }
  .diff-file-actions { display: flex; gap: 4px; }
  .diff-mini {
    background: transparent; border: 1px solid var(--capix-border); cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 9px; padding: 2px 6px; border-radius: 4px;
  }
  .diff-mini.acc { color: var(--capix-green); border-color: rgba(20,241,149,0.3); }
  .diff-mini.rev { color: var(--capix-red); border-color: rgba(255,100,100,0.3); }
  .diff-mini:hover { color: var(--capix-fg); }
  .diff-file pre {
    background: rgba(0,0,0,0.32); border-radius: 4px; padding: 6px; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px; margin: 0;
    max-height: 160px; overflow-y: auto; color: var(--capix-fg);
  }
  .diff-panel.collapsed .diff-files { display: none; }

  /* Composer */
  .composer { border-top: 1px solid var(--capix-border); padding: 8px 10px; flex: none; }
  .mode-row { display: flex; gap: 2px; margin-bottom: 6px; flex-wrap: wrap; }
  .mode-btn {
    background: transparent; border: 1px solid transparent; cursor: pointer;
    color: var(--capix-muted); font-family: inherit; font-size: 10px;
    padding: 3px 8px; border-radius: 999px;
  }
  .mode-btn:hover { color: var(--capix-fg); }
  .mode-btn.active { background: rgba(61,206,214,0.14); color: var(--capix-cyan); border-color: rgba(61,206,214,0.3); }
  .composer-input {
    width: 100%; resize: none; border: 1px solid var(--capix-border); border-radius: 8px;
    background: var(--capix-surface); color: var(--capix-fg);
    font-family: inherit; font-size: 12px; padding: 8px 10px; min-height: 44px; max-height: 160px;
  }
  .composer-input:focus { outline: none; border-color: rgba(61,206,214,0.4); }
  .composer-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
  .foot-left { display: flex; align-items: center; gap: 8px; }
  .foot-btn { background: transparent; border: none; cursor: pointer; color: var(--capix-muted); font-family: inherit; font-size: 13px; padding: 2px 4px; }
  .foot-btn:hover { color: var(--capix-fg); }
  .cost { font-size: 10px; color: var(--capix-muted); font-family: var(--vscode-editor-font-family, monospace); }
  .send-btn {
    background: var(--capix-cyan); border: none; color: #000; border-radius: 6px; cursor: pointer;
    font-family: inherit; font-size: 12px; padding: 5px 10px; display: inline-flex; align-items: center; gap: 6px;
  }
  .send-btn:hover { opacity: .88; }
  .send-btn.working { background: var(--capix-amber); }
  .spinner {
    width: 10px; height: 10px; border: 2px solid rgba(0,0,0,0.3); border-top-color: #000;
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }

  .auth-banner {
    margin: 10px 12px 0;
    padding: 10px 11px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 55%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 8%, var(--vscode-sideBar-background));
  }
  .auth-banner[hidden] { display: none; }
  .auth-banner div { min-width: 0; display: grid; gap: 2px; }
  .auth-banner strong { font-size: 12px; color: var(--vscode-foreground); }
  .auth-banner span { font-size: 11px; line-height: 1.35; color: var(--vscode-descriptionForeground); }
  .auth-banner button {
    flex: 0 0 auto;
    min-height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: 6px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer;
  }
  .auth-banner button:hover { background: var(--vscode-button-hoverBackground); }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Approval modal */
  .modal-layer { position: relative; }
  .approval {
    border: 1px solid var(--capix-amber); border-radius: 8px; background: rgba(255,174,0,0.06);
    padding: 8px 10px; margin: 6px 0;
  }
  .approval-head { font-size: 10px; color: var(--capix-amber); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; margin-bottom: 4px; }
  .approval-desc { font-size: 11px; color: var(--capix-fg); margin-bottom: 8px; }
  .approval-actions { display: flex; gap: 6px; }
  .approval-btn {
    border: 1px solid var(--capix-border); background: var(--capix-surface); color: var(--capix-fg);
    cursor: pointer; font-family: inherit; font-size: 11px; padding: 4px 12px; border-radius: 5px;
  }
  .approval-btn.approve { background: var(--capix-green); color: #000; border-color: var(--capix-green); }
  .approval-btn.deny { background: transparent; color: var(--capix-red); border-color: rgba(255,100,100,0.3); }

  .route-pill {
    display: inline-block; font-size: 9px; padding: 1px 6px; border-radius: 999px;
    background: rgba(61,206,214,0.12); color: var(--capix-cyan); margin-bottom: 4px;
  }

  body.compact .meta-row, body.compact .mode-row { display: none; }
  body.compact .composer-input { min-height: 28px; }

  /* Premium auxiliary rail: conversation first, composer as the anchor. */
  :root {
    --capix-bg: #090d13;
    --capix-surface: rgba(255,255,255,.035);
    --capix-border: rgba(255,255,255,.075);
    --capix-fg: #eef2f3;
    --capix-muted: rgba(226,232,240,.52);
  }
  body { background: var(--capix-bg); }
  .panel-header { min-height: 46px; padding: 10px 14px; border-bottom-color: rgba(255,255,255,.055); }
  .session-title { font-size: 12px; letter-spacing: -.01em; }
  .conn-dot { order: -1; width: 6px; height: 6px; }
  .hdr-btn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border-radius: 7px; }
  .meta-row { padding: 9px 14px; gap: 7px; border-bottom: 1px solid rgba(255,255,255,.04); }
  .meta-chip { padding: 3px 7px; border: 0; border-radius: 5px; background: rgba(255,255,255,.045); font-size: 8px; }
  #chip-model { color: var(--capix-cyan); }
  .conversation { padding: 16px 14px 22px; scrollbar-width: thin; }
  .empty-state { padding: clamp(38px, 12vh, 104px) 4px 24px; text-align: left; max-width: 390px; margin: 0 auto; }
  .empty-glyph { width: 36px; height: 36px; display: grid; place-items: center; margin: 0 0 22px; border-radius: 10px; font-size: 18px; opacity: 1; color: var(--capix-cyan); background: rgba(61,206,214,.09); border: 1px solid rgba(61,206,214,.18); }
  .empty-kicker { color: var(--capix-cyan); font: 500 9px/1 var(--vscode-editor-font-family, monospace); text-transform: uppercase; letter-spacing: .13em; }
  .empty-state h2 { margin: 9px 0 10px; color: var(--capix-fg); font-size: 22px; line-height: 1.1; letter-spacing: -.035em; }
  .empty-state p { margin: 0 0 24px; line-height: 1.6; font-size: 11px; }
  .starter-prompts { border-top: 1px solid var(--capix-border); }
  .starter-prompts button { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; color: rgba(238,242,243,.78); background: transparent; border: 0; border-bottom: 1px solid var(--capix-border); font: 500 11px/1.3 inherit; cursor: pointer; text-align: left; }
  .starter-prompts button span { color: var(--capix-cyan); opacity: .55; transition: transform .15s ease, opacity .15s ease; }
  .starter-prompts button:hover { color: var(--capix-fg); }
  .starter-prompts button:hover span { opacity: 1; transform: translateX(3px); }
  .empty-state small { display: block; margin-top: 18px; color: rgba(226,232,240,.34); font-size: 9px; }
  .empty-state kbd { padding: 1px 4px; color: rgba(226,232,240,.62); background: rgba(255,255,255,.045); border: 1px solid var(--capix-border); border-radius: 4px; font: inherit; }
  .msg { margin-bottom: 20px; }
  .msg-role { margin-bottom: 7px; font-size: 8px; }
  .msg-body { font-size: 12px; line-height: 1.62; }
  .tool-card { border-radius: 7px; background: rgba(255,255,255,.025); }
  .composer { margin: 0 10px 10px; padding: 8px; border: 1px solid rgba(255,255,255,.11); border-radius: 12px; background: #0d121a; box-shadow: 0 12px 34px rgba(0,0,0,.28); transition: border-color .16s ease, box-shadow .16s ease; }
  .composer:focus-within { border-color: rgba(61,206,214,.34); box-shadow: 0 12px 38px rgba(0,0,0,.36), 0 0 0 1px rgba(61,206,214,.05); }
  .mode-row { margin: 0 0 4px; gap: 1px; }
  .mode-btn { padding: 4px 7px; border-radius: 5px; font-size: 9px; }
  .mode-btn.active { border-color: transparent; background: rgba(61,206,214,.09); }
  .composer-input { min-height: 58px; padding: 9px 4px; border: 0; border-radius: 0; background: transparent; font-size: 12px; line-height: 1.5; }
  .composer-input:focus { border: 0; }
  .composer-input::placeholder { color: rgba(226,232,240,.32); }
  .composer-foot { margin-top: 3px; }
  .send-btn { width: 30px; height: 30px; padding: 0; display: grid; place-items: center; border-radius: 8px; background: var(--capix-cyan); }
  .send-btn.working { width: auto; padding: 0 9px; display: inline-flex; }
  .cost { opacity: .62; }
  .diff-panel { margin: 0 10px 8px; border: 1px solid var(--capix-border); border-radius: 9px; overflow: hidden; }
  @media (prefers-reduced-motion: no-preference) {
    .empty-state { animation: code-enter .34s ease-out both; }
    @keyframes code-enter { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
  }

  /* ── Capix polish layer ─────────────────────────────────────────────── */
  ::selection{background:rgba(61,206,214,0.25)}
  .conversation{scroll-behavior:smooth}
  .conversation::-webkit-scrollbar,.diff-list::-webkit-scrollbar{width:8px}
  .conversation::-webkit-scrollbar-thumb,.diff-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.10);border-radius:4px}
  .conversation::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.18)}
  .meta-chip{font-variant-numeric:tabular-nums;letter-spacing:0.01em}
  .hdr-btn{transition:background .12s ease,color .12s ease,transform .06s ease}
  .hdr-btn:active{transform:scale(0.94)}
  .msg-role{font-size:9px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase}
  .code-block{border-radius:8px}
  .code-block pre{font-variant-numeric:tabular-nums}
  .tool-card{transition:border-color .12s ease}
  .tool-card:hover{border-color:rgba(61,206,214,0.25)}
  .send-btn{transition:filter .12s ease,transform .06s ease}
  .send-btn:hover{filter:brightness(1.1)}
  .send-btn:active{transform:scale(0.96)}
  .diff-btn{transition:filter .12s ease}
  .diff-btn.accept:hover{filter:brightness(1.12)}
  .cost,.usage-cost{font-variant-numeric:tabular-nums}
  .mention-menu{position:relative;margin:0 12px 6px;background:var(--capix-panel-2,rgba(255,255,255,0.06));border:1px solid var(--capix-border,rgba(255,255,255,0.08));border-radius:10px;overflow:hidden;box-shadow:0 8px 24px rgba(0,0,0,0.35)}
  .mention-item{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.045)}
  .mention-item:last-child{border-bottom:none}
  .mention-item:hover,.mention-item.active{background:rgba(61,206,214,0.10)}
  .mention-item .mention-name{color:var(--capix-fg,#f1efe9);font-weight:600}
  .mention-item .mention-dir{color:var(--capix-dim,#64748b);font-size:10.5px;font-variant-numeric:tabular-nums}
  .mention-hint{padding:6px 12px;font-size:10px;color:var(--capix-dim,#64748b);border-top:1px solid rgba(255,255,255,0.05)}
  .mention-inline{color:var(--capix-cyan,#3DCED6);font-weight:600}
`;
