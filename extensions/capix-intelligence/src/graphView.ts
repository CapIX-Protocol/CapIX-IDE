/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Capix Network. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *
 *  capix-intelligence/graphView - WebviewViewProvider for the Knowledge Graph
 *  view (capix.intelligence.graph). Renders Sigma.js + Graphology inside a
 *  CSP-compliant webview. Data is loaded from POST /api/v1/graph through the
 *  IntelligenceClient. Supports search, node-type/edge-type filters,
 *  expand-neighbourhood, and export to JSON.
 *
 *  The webview script and styles are inlined (nonce-gated). Sigma.js and
 *  Graphology are loaded from a CDN via script-src with the cdnjs origin
 *  whitelisted in the CSP. No other external resources are permitted.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import type { IntelligenceClient } from "./intelligenceClient.js";
import type { GraphData, GraphNode, GraphEdge } from "./types.js";

export class GraphViewProvider implements vscode.WebviewViewProvider {
	public view?: vscode.WebviewView;
	private _cachedGraph: GraphData = { nodes: [], edges: [] };

	constructor(
		private readonly client: IntelligenceClient,
		private readonly extensionUri: vscode.Uri,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
		void this.loadGraph();
	}

	show(): void {
		if (this.view) {
			this.view.show?.(true);
		} else {
			void vscode.commands.executeCommand("capix.intelligence.graph.focus");
		}
	}

	async loadGraph(): Promise<void> {
		try {
			const data = await this.client.queryGraph({});
			this._cachedGraph = data;
			this.notify({ type: "graph", data });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.notify({ type: "error", message: msg });
		}
	}

	async refresh(): Promise<void> {
		await this.loadGraph();
	}

	private async onMessage(msg: unknown): Promise<void> {
		const m = msg as { kind?: string; query?: string; nodeTypes?: string[]; edgeTypes?: string[] };
		if (!m?.kind) return;

		switch (m.kind) {
			case "query": {
				try {
					const data = await this.client.queryGraph({
						query: m.query || undefined,
						nodeTypes: m.nodeTypes,
						edgeTypes: m.edgeTypes,
						limit: 500,
					});
					this._cachedGraph = data;
					this.notify({ type: "graph", data });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.notify({ type: "error", message: msg });
				}
				break;
			}
			case "refresh": {
				await this.loadGraph();
				break;
			}
			case "export": {
				const json = JSON.stringify(this._cachedGraph, null, 2);
				await vscode.env.clipboard.writeText(json);
				vscode.window.showInformationMessage("Capix: graph exported to clipboard as JSON.");
				break;
			}
			case "expand": {
				const nodeId = (msg as { nodeId?: string }).nodeId;
				if (!nodeId) break;
				try {
					const data = await this.client.queryGraph({ query: nodeId, limit: 100 });
					this.notify({ type: "expand", data, sourceNodeId: nodeId });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.notify({ type: "error", message: msg });
				}
				break;
			}
		}
	}

	private notify(msg: unknown): void {
		void this.view?.webview.postMessage(msg);
	}

	private html(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
			`style-src 'unsafe-inline'`,
			`img-src ${webview.cspSource} data:`,
			`connect-src 'none'`,
		].join("; ");

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Capix Knowledge Graph</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  .toolbar { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; align-items: center; }
  .toolbar input[type="text"] {
    flex: 1; min-width: 80px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); padding: 3px 6px; font-size: 12px;
  }
  .toolbar select {
    background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border); padding: 2px 4px; font-size: 11px;
  }
  .toolbar button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 3px 8px; cursor: pointer; font-size: 11px; border-radius: 2px;
  }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  .toolbar button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .toolbar button.secondary:hover { opacity: 0.85; }
  #graph-container { flex: 1; position: relative; overflow: hidden; }
  #sigma-container { position: absolute; inset: 0; }
  .legend {
    position: absolute; bottom: 8px; left: 8px; z-index: 10;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
    padding: 6px 8px; border-radius: 4px; font-size: 11px; max-height: 120px; overflow-y: auto;
  }
  .legend-item { display: flex; align-items: center; gap: 4px; margin: 2px 0; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status {
    position: absolute; top: 8px; right: 8px; z-index: 10;
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
    padding: 4px 8px; border-radius: 4px; font-size: 11px; color: var(--vscode-descriptionForeground);
  }
  .error {
    color: var(--vscode-errorForeground); padding: 8px; font-size: 12px;
  }
</style>
</head>
<body>
<div class="toolbar">
  <input type="text" id="search" placeholder="Search graph…" />
  <select id="node-filter" title="Filter node types"><option value="">All nodes</option></select>
  <select id="edge-filter" title="Filter edge types"><option value="">All edges</option></select>
  <button id="btn-query">Query</button>
  <button id="btn-refresh" class="secondary">Refresh</button>
  <button id="btn-export" class="secondary">Export</button>
</div>
<div id="graph-container">
  <div id="sigma-container"></div>
  <div class="status" id="status">Loading…</div>
  <div class="legend" id="legend"></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/sigma/3.0.0/sigma.min.js" nonce="${nonce}"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/graphology/0.25.4/graphology.umd.min.js" nonce="${nonce}"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/graphology-layout-forceatlas2/0.10.1/graphology-layout-forceatlas2.min.js" nonce="${nonce}"></script>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const $search = document.getElementById('search');
  const $nodeFilter = document.getElementById('node-filter');
  const $edgeFilter = document.getElementById('edge-filter');
  const $status = document.getElementById('status');
  const $legend = document.getElementById('legend');
  const $container = document.getElementById('sigma-container');

  let sigmaInstance = null;
  let graph = null;
  let allData = { nodes: [], edges: [] };

  const PALETTE = [
    '#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f',
    '#edc948','#b07aa1','#ff9da7','#9c755f','#bab0ac',
    '#aec7e8','#ffbb78','#98df8a','#c5b0d5','#c49c94'
  ];

  function colorForType(type, index) {
    if (!type) return PALETTE[0];
    let hash = 0;
    for (let i = 0; i < type.length; i++) hash = ((hash << 5) - hash + type.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(hash) % PALETTE.length];
  }

  function buildGraph(data) {
    if (typeof graphology === 'undefined') {
      $status.textContent = 'Graphology library not loaded.';
      return;
    }
    graph = new graphology.DirectedGraph();
    const nodeTypeSet = new Set();
    const edgeTypeSet = new Set();
    let added = 0;

    for (const n of data.nodes) {
      nodeTypeSet.add(n.type || 'default');
      if (graph.hasNode(n.id)) continue;
      graph.addNode(n.id, {
        label: n.label || n.id,
        size: 8,
        color: colorForType(n.type),
        x: Math.random(),
        y: Math.random(),
        nodeType: n.type || 'default',
        data: n
      });
      added++;
    }
    for (const e of data.edges) {
      edgeTypeSet.add(e.type || 'default');
      const key = e.source + '->' + e.target + ':' + (e.type || '');
      if (graph.hasEdge(key)) continue;
      if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
      graph.addEdge(key, {
        source: e.source,
        target: e.target,
        color: 'rgba(150,150,150,0.3)',
        type: e.type || 'default'
      });
    }

    // ForceAtlas2 layout
    if (typeof forceAtlas2 !== 'undefined' && graph.order > 0) {
      forceAtlas2.assign(graph, { settings: { gravity: 1, scalingRatio: 8, barnesHutOptimize: true, slowDown: 4 }, iterations: 100 });
    }

    // Populate filter dropdowns
    populateFilters(nodeTypeSet, edgeTypeSet);

    // Render legend
    renderLegend(nodeTypeSet);

    if (sigmaInstance) sigmaInstance.kill();
    if (typeof sigma === 'undefined') {
      $status.textContent = 'Sigma library not loaded.';
      return;
    }
    sigmaInstance = new sigma({
      container: $container,
      graph: graph,
      settings: {
        renderEdgeLabels: false,
        defaultNodeColor: PALETTE[0],
        labelDensity: 0.4,
        labelGridCellSize: 60,
        labelRenderedSizeThreshold: 8,
        minCameraRatio: 0.05,
        maxCameraRatio: 10
      }
    });

    // Click to expand neighbourhood
    sigmaInstance.on('clickNode', function(e) {
      const nodeId = e.node;
      vscode.postMessage({ kind: 'expand', nodeId: nodeId });
    });

    $status.textContent = added + ' nodes, ' + data.edges.length + ' edges';
  }

  function populateFilters(nodeTypes, edgeTypes) {
    const prevNode = $nodeFilter.value;
    const prevEdge = $edgeFilter.value;
    $nodeFilter.innerHTML = '<option value="">All nodes</option>';
    $edgeFilter.innerHTML = '<option value="">All edges</option>';
    for (const t of nodeTypes) {
      const o = document.createElement('option'); o.value = t; o.textContent = t;
      if (t === prevNode) o.selected = true;
      $nodeFilter.appendChild(o);
    }
    for (const t of edgeTypes) {
      const o = document.createElement('option'); o.value = t; o.textContent = t;
      if (t === prevEdge) o.selected = true;
      $edgeFilter.appendChild(o);
    }
  }

  function renderLegend(nodeTypes) {
    $legend.innerHTML = '';
    let i = 0;
    for (const t of nodeTypes) {
      const item = document.createElement('div'); item.className = 'legend-item';
      const dot = document.createElement('span'); dot.className = 'legend-dot';
      dot.style.background = colorForType(t, i++);
      item.appendChild(dot);
      item.appendChild(document.createTextNode(t));
      $legend.appendChild(item);
    }
  }

  function applyFilters() {
    if (!graph) return;
    const nodeFilter = $nodeFilter.value;
    const edgeFilter = $edgeFilter.value;
    graph.forEachNode(function(nodeId, attrs) {
      const visible = !nodeFilter || attrs.nodeType === nodeFilter;
      graph.setNodeAttribute(nodeId, 'hidden', !visible);
    });
    graph.forEachEdge(function(edgeId, attrs) {
      const visible = !edgeFilter || attrs.type === edgeFilter;
      graph.setEdgeAttribute(edgeId, 'hidden', !visible);
    });
    if (sigmaInstance) sigmaInstance.refresh();
  }

  function sendQuery() {
    vscode.postMessage({
      kind: 'query',
      query: $search.value.trim(),
      nodeTypes: $nodeFilter.value ? [$nodeFilter.value] : undefined,
      edgeTypes: $edgeFilter.value ? [$edgeFilter.value] : undefined
    });
    $status.textContent = 'Querying…';
  }

  // Event listeners
  document.getElementById('btn-query').onclick = sendQuery;
  document.getElementById('btn-refresh').onclick = function() {
    vscode.postMessage({ kind: 'refresh' }); $status.textContent = 'Loading…';
  };
  document.getElementById('btn-export').onclick = function() {
    vscode.postMessage({ kind: 'export' });
  };
  $search.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendQuery(); });
  $nodeFilter.onchange = applyFilters;
  $edgeFilter.onchange = applyFilters;

  // Messages from extension
  window.addEventListener('message', function(e) {
    const m = e.data; if (!m || !m.type) return;
    switch (m.type) {
      case 'graph':
        allData = m.data;
        buildGraph(m.data);
        break;
      case 'expand': {
        // Merge new nodes/edges into existing graph
        for (const n of m.data.nodes) {
          if (graph && !graph.hasNode(n.id)) {
            graph.addNode(n.id, {
              label: n.label || n.id, size: 8,
              color: colorForType(n.type),
              x: Math.random(), y: Math.random(),
              nodeType: n.type || 'default', data: n
            });
          }
        }
        for (const ed of m.data.edges) {
          if (graph && graph.hasNode(ed.source) && graph.hasNode(ed.target)) {
            const k = ed.source + '->' + ed.target + ':' + (ed.type || '');
            if (!graph.hasEdge(k)) {
              graph.addEdge(k, {
                source: ed.source, target: ed.target,
                color: 'rgba(150,150,150,0.3)', type: ed.type || 'default'
              });
            }
          }
        }
        if (typeof forceAtlas2 !== 'undefined' && graph) {
          forceAtlas2.assign(graph, { settings: { gravity: 1, scalingRatio: 8, barnesHutOptimize: true, slowDown: 4 }, iterations: 50 });
        }
        if (sigmaInstance) sigmaInstance.refresh();
        $status.textContent = 'Expanded from ' + (m.sourceNodeId || 'node');
        break;
      }
      case 'error':
        $status.textContent = '';
        const div = document.createElement('div'); div.className = 'error'; div.textContent = m.message;
        $container.appendChild(div);
        break;
    }
  });

  $status.textContent = 'Ready.';
})();
</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = "";
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
