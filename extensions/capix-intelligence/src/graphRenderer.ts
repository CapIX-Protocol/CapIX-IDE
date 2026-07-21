/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/graphRenderer - SVG graph renderer for the Graph tab of
 *  the Intelligence workspace. Produces an inline SVG document plus a small
 *  controller script that runs inside the webview (nonce-gated) and handles
 *  zoom, pan, node click, cluster collapse/expand and search filtering.
 *
 *  Layout is a simple force-directed simulation (O(n^2) Coulomb repulsion +
 *  Hooke spring attraction + gravity) seeded with random positions on a circle.
 *  No external libraries are required — the whole renderer is dependency-free
 *  so it stays inside the strict CSP (script-src 'nonce-<nonce>').
 *
 *  Design tokens (@capix/ui-tokens): dark foundation, cyan/green/amber/blue
 *  node palette keyed by node type. This is an internal module of one CapixIDE
 *  release, not a marketplace extension.
 *-------------------------------------------------------------------------------------------*/

import type { GraphData, GraphEdge, GraphNode } from "./types.js";
import { icon } from "./webviewIcons.js";

// ── Palette ────────────────────────────────────────────────────────────────

export type GraphNodeTypeKey =
	| "decision"
	| "fact"
	| "preference"
	| "instruction"
	| "observation"
	| "pattern"
	| "feedback"
	| "context"
	| "relationship"
	| "anchor"
	| "agent"
	| "plan"
	| "checkpoint"
	| "receipt"
	| "covenant"
	| "skill"
	| "other";

const PALETTE: Record<GraphNodeTypeKey, string> = {
	decision: "#3DCED6", // cyan
	fact: "#14F195", // green
	preference: "#FFAE00", // amber/yellow
	instruction: "#a78bfa", // violet (distinct from yellow)
	observation: "#5B8DEF", // blue
	pattern: "#14F195",
	feedback: "#fbbf24",
	context: "#60a5fa",
	relationship: "#f472b6",
	anchor: "#3DCED6",
	agent: "#22d3ee",
	plan: "#34d399",
	checkpoint: "#facc15",
	receipt: "#a3e635",
	covenant: "#f97316",
	skill: "#e879f9",
	other: "#94a3b8",
};

/** Resolve a node type string to a stable palette color. */
export function colorForType(type: string | undefined): string {
	if (!type) return PALETTE.other;
	const key = type.toLowerCase() as GraphNodeTypeKey;
	if (key in PALETTE) return PALETTE[key as GraphNodeTypeKey];
	// Deterministic fallback for unknown types so legend stays consistent.
	let hash = 0;
	for (let i = 0; i < type.length; i++) {
		hash = ((hash << 5) - hash + type.charCodeAt(i)) | 0;
	}
	const keys = Object.keys(PALETTE) as GraphNodeTypeKey[];
	return PALETTE[keys[Math.abs(hash) % keys.length]];
}

// ── Layout ──────────────────────────────────────────────────────────────────

interface PositionedNode {
	id: string;
	type: string;
	label: string;
	x: number;
	y: number;
	r: number;
}

interface SimEdge {
	source: string;
	target: string;
	type: string;
}

interface LayoutOptions {
	width: number;
	height: number;
	iterations: number;
	/** Coulomb repulsion constant. */
	repulsion: number;
	/** Spring rest length / ideal distance. */
	linkDistance: number;
	/** Spring stiffness. */
	stiffness: number;
	/** Center-gravity strength (0..1). */
	gravity: number;
	/** Velocity damping per tick (0..1). */
	damping: number;
	/** Max velocity per tick to avoid blow-up. */
	maxSpeed: number;
}

const DEFAULT_LAYOUT: LayoutOptions = {
	width: 800,
	height: 560,
	iterations: 320,
	repulsion: 4200,
	linkDistance: 96,
	stiffness: 0.045,
	gravity: 0.06,
	damping: 0.82,
	maxSpeed: 32,
};

/**
 * Run a naive force-directed layout. The result is deterministic for a given
 * graph because the RNG seed is derived from node ids (not Math.random), so a
 * re-render after data refresh keeps the visual layout stable.
 */
export function forceLayout(
	graph: GraphData,
	opts: Partial<LayoutOptions> = {},
): { nodes: PositionedNode[]; edges: SimEdge[] } {
	const o = { ...DEFAULT_LAYOUT, ...opts };
	const cx = o.width / 2;
	const cy = o.height / 2;

	// Deterministic PRNG (mulberry32) seeded from a stable hash of node ids.
	let seed = 0x2f6e3b1a;
	for (const n of graph.nodes) {
		for (let i = 0; i < n.id.length; i++) {
			seed = (Math.imul(seed ^ n.id.charCodeAt(i), 0x85ebca6b) | 0) >>> 0;
		}
	}
	const rand = () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	const byId = new Map<string, PositionedNode>();
	const nodes: PositionedNode[] = graph.nodes.map((n, i) => {
		const angle = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
		const radius = 60 + rand() * Math.min(o.width, o.height) * 0.35;
		const label = n.label || n.id;
		// Larger radius for hub nodes (more edges); capped.
		const r = 6;
		const node: PositionedNode = {
			id: n.id,
			type: n.type || "other",
			label,
			x: cx + Math.cos(angle) * radius,
			y: cy + Math.sin(angle) * radius,
			r,
		};
		byId.set(n.id, node);
		return node;
	});

	const edges: SimEdge[] = graph.edges
		.map((e) => {
			const source = (e as GraphEdge).source ?? (e as { from?: string }).from ?? "";
			const target = (e as GraphEdge).target ?? (e as { to?: string }).to ?? "";
			return { source, target, type: e.type || "related" };
		})
		.filter((e) => byId.has(e.source) && byId.has(e.target));

	// Degree-weighted radius: hub nodes are visibly larger.
	const degree = new Map<string, number>();
	for (const e of edges) {
		degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
		degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
	}
	for (const n of nodes) {
		const d = degree.get(n.id) ?? 0;
		n.r = Math.min(14, 6 + Math.sqrt(d) * 2.2);
	}

	// Simulation step: O(n^2) repulsion + spring attraction + gravity.
	const vx = new Map<string, number>();
	const vy = new Map<string, number>();
	for (const n of nodes) {
		vx.set(n.id, 0);
		vy.set(n.id, 0);
	}

	for (let iter = 0; iter < o.iterations; iter++) {
		// Repulsion (all pairs).
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i];
			let fx = 0;
			let fy = 0;
			for (let j = 0; j < nodes.length; j++) {
				if (i === j) continue;
				const b = nodes[j];
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let dist2 = dx * dx + dy * dy;
				if (dist2 < 0.01) {
					dx = (rand() - 0.5) * 0.5;
					dy = (rand() - 0.5) * 0.5;
					dist2 = 0.01;
				}
				const dist = Math.sqrt(dist2);
				const force = o.repulsion / dist2;
				fx += (dx / dist) * force;
				fy += (dy / dist) * force;
			}
			// Gravity toward center.
			fx += (cx - a.x) * o.gravity;
			fy += (cy - a.y) * o.gravity;

			vx.set(a.id, (vx.get(a.id)! + fx) * o.damping);
			vy.set(a.id, (vy.get(a.id)! + fy) * o.damping);
		}

		// Spring attraction along edges.
		for (const e of edges) {
			const a = byId.get(e.source)!;
			const b = byId.get(e.target)!;
			let dx = b.x - a.x;
			let dy = b.y - a.y;
			const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
			const force = (dist - o.linkDistance) * o.stiffness;
			const ux = (dx / dist) * force;
			const uy = (dy / dist) * force;
			vx.set(a.id, vx.get(a.id)! + ux);
			vy.set(a.id, vy.get(a.id)! + uy);
			vx.set(b.id, vx.get(b.id)! - ux);
			vy.set(b.id, vy.get(b.id)! - uy);
		}

		// Integrate + clamp.
		for (const n of nodes) {
			let nx = vx.get(n.id)!;
			let ny = vy.get(n.id)!;
			const sp = Math.sqrt(nx * nx + ny * ny);
			if (sp > o.maxSpeed) {
				nx = (nx / sp) * o.maxSpeed;
				ny = (ny / sp) * o.maxSpeed;
			}
			n.x += nx;
			n.y += ny;
			// Soft bounds so nodes never disappear off-canvas.
			const pad = n.r + 8;
			if (n.x < pad) n.x = pad;
			if (n.x > o.width - pad) n.x = o.width - pad;
			if (n.y < pad) n.y = pad;
			if (n.y > o.height - pad) n.y = o.height - pad;
		}
	}

	return { nodes, edges };
}

// ── SVG generation ──────────────────────────────────────────────────────────

export interface GraphRenderOptions {
	width: number;
	height: number;
}

/**
 * Render a `GraphData` snapshot to an inline SVG string.
 *
 * Nodes are circles color-coded by type; edge relationship types are rendered
 * as small labels near the midpoint. Every node carries `data-node-id` /
 * `data-node-type` attributes so the controller script can wire click handlers
 * via event delegation (CSP-friendly — no inline handlers).
 */
export function renderGraphSvg(
	graph: GraphData,
	opts: Partial<GraphRenderOptions> = {},
): string {
	const o = { width: 800, height: 560, ...opts };
	const { nodes, edges } = forceLayout(graph, {
		width: o.width,
		height: o.height,
	});

	const edgeLines = edges
		.map((e) => {
			const a = nodes.find((n) => n.id === e.source);
			const b = nodes.find((n) => n.id === e.target);
			if (!a || !b) return "";
			const mx = (a.x + b.x) / 2;
			const my = (a.y + b.y) / 2;
			const label = escapeXml(e.type || "");
			return `<line class="edge" x1="${fmt(a.x)}" y1="${fmt(a.y)}" x2="${fmt(b.x)}" y2="${fmt(b.y)}" stroke="rgba(148,163,184,0.22)" stroke-width="1"/>` +
				(label
					? `<text class="edge-label" x="${fmt(mx)}" y="${fmt(my)}">${label}</text>`
					: "");
		})
		.join("");

	const nodeCircles = nodes
		.map((n) => {
			const fill = colorForType(n.type);
			const label = escapeXml(truncate(n.label, 22));
			return `<g class="node" data-node-id="${escapeXml(n.id)}" data-node-type="${escapeXml(n.type)}" transform="translate(${fmt(n.x)},${fmt(n.y)})">` +
				`<circle r="${fmt(n.r)}" fill="${fill}" stroke="rgba(255,255,255,0.18)" stroke-width="1.2"/>` +
				`<text class="node-label" y="${fmt(n.r + 11)}" text-anchor="middle">${label}</text>` +
				`</g>`;
		})
		.join("");

	const legendEntries = collectLegend(nodes).map(
		(t) =>
			`<div class="legend-item"><span class="legend-dot" style="background:${colorForType(t)}"></span>${escapeXml(t)}</div>`,
	);

	return `<div class="graph-stage" id="graph-stage">
  <div class="graph-viewport" id="graph-viewport">
    <svg id="graph-svg" viewBox="0 0 ${o.width} ${o.height}" width="${o.width}" height="${o.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Knowledge graph">
      <g id="graph-zoom">
        <g id="graph-edges">${edgeLines}</g>
        <g id="graph-nodes">${nodeCircles}</g>
      </g>
    </svg>
  </div>
  <div class="graph-detail" id="graph-detail" hidden>
    <button class="icon-btn" data-action="closeDetail" title="Close">${icon("close")}</button>
    <div id="graph-detail-body"></div>
  </div>
  <div class="graph-legend">${legendEntries.join("")}</div>
  <div class="graph-status" id="graph-status">${nodes.length} nodes · ${edges.length} edges</div>
</div>`;
}

// ── Controller script ────────────────────────────────────────────────────────

/**
 * The webview controller script. It expects a single `#graph-svg` element with
 * a `#graph-zoom` group to transform, plus `#graph-detail` / `#graph-status`
 * panels. Interactions:
 *   - wheel: zoom around cursor
 *   - drag on background: pan
 *   - drag on node: reposition (sticky during drag)
 *   - click node: postMessage `graph:selectNode` + populate detail panel
 *   - double-click node: postMessage `graph:expand` (neighbourhood fetch)
 *   - search input: filter by label/type (toggles `hidden` class)
 *   - collapse/expand clusters
 *
 * The function returns a string ready to drop into a `<script nonce=…>` tag.
 */
export function graphControllerScript(): string {
	return `(function(){
  const vscode = acquireVsCodeApi();
  const svg = document.getElementById('graph-svg');
  const zoom = document.getElementById('graph-zoom');
  const viewport = document.getElementById('graph-viewport');
  const detail = document.getElementById('graph-detail');
  const detailBody = document.getElementById('graph-detail-body');
  const status = document.getElementById('graph-status');
  if (!svg || !zoom) return;

  let scale = 1, panX = 0, panY = 0;
  let dragging = false, dragNode = null, moved = false;
  let startX = 0, startY = 0, startPanX = 0, startPanY = 0;

  const pts = svg.createSVGPoint();

  function screenToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    pts.x = clientX; pts.y = clientY;
    const loc = pts.matrixTransform(svg.getScreenCTM().inverse());
    return { x: loc.x, y: loc.y };
  }

  function applyTransform() {
    zoom.setAttribute('transform',
      'translate(' + panX.toFixed(2) + ',' + panY.toFixed(2) + ') scale(' + scale.toFixed(4) + ')');
  }

  function clampScale(s) { return Math.max(0.2, Math.min(4, s)); }

  svg.addEventListener('wheel', function(e) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = clampScale(scale * delta);
    const before = screenToSvg(e.clientX, e.clientY);
    scale = newScale;
    const after = screenToSvg(e.clientX, e.clientY);
    panX += (after.x - before.x) * scale;
    panY += (after.y - before.y) * scale;
    applyTransform();
  }, { passive: false });

  svg.addEventListener('mousedown', function(e) {
    const nodeG = e.target instanceof Element ? e.target.closest('.node') : null;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY;
    startPanX = panX; startPanY = panY;
    if (nodeG) dragNode = nodeG;
    else dragNode = null;
  });

  window.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (dragNode) {
      const g = dragNode;
      const t = g.getAttribute('transform') || '';
      const m = t.match(/translate\\(([-0-9.]+),([-0-9.]+)\\)/);
      const baseX = m ? parseFloat(m[1]) : 0;
      const baseY = m ? parseFloat(m[2]) : 0;
      const nx = baseX + dx / scale;
      const ny = baseY + dy / scale;
      g.setAttribute('transform', 'translate(' + nx.toFixed(2) + ',' + ny.toFixed(2) + ')');
      const circle = g.querySelector('circle');
      const text = g.querySelector('.node-label');
      if (circle && text) {
        const r = parseFloat(circle.getAttribute('r') || '6');
        text.setAttribute('y', String(r + 11));
      }
      const id = g.getAttribute('data-node-id');
      const edges = zoom.querySelectorAll('.edge');
      edges.forEach(function(ep) {});
    } else {
      panX = startPanX + dx;
      panY = startPanY + dy;
      applyTransform();
    }
  });

  window.addEventListener('mouseup', function(e) {
    if (!dragging) return;
    const nodeG = dragNode;
    dragging = false; dragNode = null;
    if (!moved && nodeG) {
      selectNode(nodeG);
    } else if (!moved && !nodeG) {
      // background click clears selection
      hideDetail();
    }
    moved = false;
  });

  svg.addEventListener('dblclick', function(e) {
    const nodeG = e.target instanceof Element ? e.target.closest('.node') : null;
    if (!nodeG) return;
    const id = nodeG.getAttribute('data-node-id');
    vscode.postMessage({ kind: 'graph:expand', nodeId: id });
    if (status) status.textContent = 'Expanding ' + id + '…';
  });

  function selectNode(nodeG) {
    const id = nodeG.getAttribute('data-node-id');
    const type = nodeG.getAttribute('data-node-type') || 'other';
    const label = nodeG.querySelector('.node-label')
      ? nodeG.querySelector('.node-label').textContent : id;
    zoom.querySelectorAll('.node').forEach(function(n) { n.classList.remove('selected'); });
    nodeG.classList.add('selected');
    showDetail(id, type, label);
    vscode.postMessage({ kind: 'graph:selectNode', nodeId: id, nodeType: type });
  }

  function showDetail(id, type, label) {
    if (!detail || !detailBody) return;
    detail.hidden = false;
    detailBody.innerHTML =
      '<div class="detail-title">' + escHtml(label || id) + '</div>' +
      '<div class="detail-meta"><span class="legend-dot" style="background:' + colorFn(type) + '"></span>' +
      '<span class="detail-type">' + escHtml(type) + '</span>' +
      '<code class="detail-id">' + escHtml(id) + '</code></div>' +
      '<div class="detail-actions">' +
        '<button class="btn btn-mini" data-action="expandNode" data-id="' + escHtml(id) + '">Expand</button>' +
        '<button class="btn btn-mini" data-action="copyNode" data-id="' + escHtml(id) + '">Copy ID</button>' +
      '</div>';
  }

  function hideDetail() { if (detail) detail.hidden = true; }

  function colorFn(type) {
    const map = {
      decision:'#3DCED6', fact:'#14F195', preference:'#FFAE00',
      instruction:'#a78bfa', observation:'#5B8DEF', pattern:'#14F195',
      feedback:'#fbbf24', context:'#60a5fa', relationship:'#f472b6',
      anchor:'#3DCED6', agent:'#22d3ee', plan:'#34d399', checkpoint:'#facc15',
      receipt:'#a3e635', covenant:'#f97316', skill:'#e879f9'
    };
    const k = (type || '').toLowerCase();
    if (k in map) return map[k];
    let h = 0; for (let i=0;i<(type||'').length;i++){h=((h<<5)-h+(type||'').charCodeAt(i))|0;}
    const ks = Object.keys(map); return map[ks[Math.abs(h)%ks.length]];
  }

  function escHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // event delegation for detail-panel buttons + legend toggles
  document.addEventListener('click', function(e) {
    const t = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!t) return;
    const a = t.dataset.action;
    const id = t.dataset.id;
    if (a === 'closeDetail') hideDetail();
    else if (a === 'expandNode' && id) {
      vscode.postMessage({ kind: 'graph:expand', nodeId: id });
    } else if (a === 'copyNode' && id) {
      vscode.postMessage({ kind: 'graph:copyNode', nodeId: id });
    } else if (a === 'collapseCluster') {
      const type = t.dataset.type;
      zoom.querySelectorAll('.node').forEach(function(n) {
        if (n.getAttribute('data-node-type') === type) n.classList.toggle('collapsed');
      });
    }
  });

  // search filtering
  window.__capixGraphFilter = function(query) {
    const q = (query || '').toLowerCase();
    zoom.querySelectorAll('.node').forEach(function(n) {
      const lbl = (n.textContent || '').toLowerCase();
      const tp = (n.getAttribute('data-node-type') || '').toLowerCase();
      n.classList.toggle('hidden', Boolean(q) && !lbl.includes(q) && !tp.includes(q));
    });
  };

  window.__capixGraphLoad = function(data) {
    // Full re-render is delegated to the host (postMessage graph:render).
    vscode.postMessage({ kind: 'graph:render', data: data });
  };

  applyTransform();
  if (status) status.textContent = status.textContent || 'Ready';
})();`;
}

/** CSS for the graph SVG + chrome. Sourced from @capix/ui-tokens dark theme. */
export function graphStyles(): string {
	return `
	.graph-stage { position: relative; height: 100%; min-height: 380px; display: flex; flex-direction: column; }
	.graph-viewport { flex: 1; overflow: hidden; position: relative; background: #070b10; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; }
	#graph-svg { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
	#graph-svg:active { cursor: grabbing; }
	.graph-viewport.dragging #graph-svg { cursor: grabbing; }
	.edge { transition: stroke 0.15s; }
	.edge-label, .node-label { font-family: var(--capix-font-mono, 'JetBrains Mono', monospace); font-size: 9px; fill: rgba(148,163,184,0.85); pointer-events: none; user-select: none; }
	.edge-label { fill: rgba(148,163,184,0.55); font-size: 8px; }
	.node { cursor: pointer; transition: opacity 0.15s; }
	.node circle { transition: stroke 0.15s, r 0.1s; }
	.node:hover circle { stroke: #fff; stroke-width: 2; }
	.node.selected circle { stroke: var(--capix-cyan, #3DCED6); stroke-width: 3; filter: drop-shadow(0 0 6px rgba(61,206,214,0.7)); }
	.node.hidden, .edge.hidden { display: none; }
	.node.collapsed circle { opacity: 0.25; }
	.graph-detail {
	  position: absolute; top: 10px; right: 10px; z-index: 5;
	  background: rgba(10,14,20,0.96); border: 1px solid rgba(61,206,214,0.30);
	  border-radius: 8px; padding: 10px 12px; min-width: 180px; max-width: 260px;
	  box-shadow: 0 12px 32px rgba(0,0,0,0.50);
	}
	.detail-title { font-weight: 600; font-size: 12px; color: #f1efe9; margin-bottom: 6px; word-break: break-word; }
	.detail-meta { display: flex; align-items: center; gap: 6px; font-size: 10px; color: #94a3b8; margin-bottom: 8px; flex-wrap: wrap; }
	.detail-type { text-transform: uppercase; letter-spacing: 0.06em; }
	.detail-id { font-family: var(--capix-font-mono, 'JetBrains Mono', monospace); font-size: 9px; color: #64748b; }
	.detail-actions { display: flex; gap: 6px; }
	.legend-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
	.graph-legend {
	  position: absolute; bottom: 10px; left: 10px; z-index: 4;
	  background: rgba(10,14,20,0.92); border: 1px solid rgba(255,255,255,0.08);
	  border-radius: 6px; padding: 6px 8px; font-size: 10px; color: #94a3b8;
	  max-height: 140px; overflow-y: auto; max-width: 180px;
	}
	.graph-legend .legend-item { display: flex; align-items: center; gap: 6px; margin: 2px 0; cursor: pointer; }
	.graph-status {
	  position: absolute; bottom: 10px; right: 10px; z-index: 4;
	  background: rgba(10,14,20,0.92); border: 1px solid rgba(255,255,255,0.08);
	  border-radius: 6px; padding: 3px 8px; font-size: 10px; color: #94a3b8;
	  font-family: var(--capix-font-mono, 'JetBrains Mono', monospace);
	}`;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
	return Number(n.toFixed(2)).toString();
}

function truncate(s: string, n: number): string {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function collectLegend(nodes: PositionedNode[]): string[] {
	const seen = new Set<string>();
	const order: string[] = [];
	for (const n of nodes) {
		if (!seen.has(n.type)) {
			seen.add(n.type);
			order.push(n.type);
		}
	}
	return order;
}

/** Convenience: full graph module (styles + svg + script) as a single block. */
export function renderGraphModule(graph: GraphData, opts?: Partial<GraphRenderOptions>): string {
	return `${graphStyles()}\n${renderGraphSvg(graph, opts)}\n<script>${graphControllerScript()}</script>`;
}

export type { GraphNode, GraphEdge, GraphData };
