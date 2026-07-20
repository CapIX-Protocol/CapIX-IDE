"use strict";
/**
 * Tree views — deploys data provider.
 *
 * The "My Deploys" / "Model Catalog" / "Ready Now (Hosted)" sidebar tree
 * views were consolidated into the tabbed `capix.cloud.hub` webview
 * (Deployments + Models tabs). DeploysTreeProvider stays as a data store:
 * the deploy lifecycle commands (stop / start / destroy / logs / copy
 * endpoint / copy API key) read its `deploys` snapshot when invoked
 * without a tree item.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeployItem = exports.DeploysTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("./logger");
// ── My Deploys tree ───────────────────────────────────────────────────────
class DeploysTreeProvider {
    client;
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    deploys = [];
    constructor(client) {
        this.client = client;
    }
    refresh() {
        this._onDidChange.fire();
    }
    async load() {
        try {
            const res = await this.client.listDeploys();
            if (!res.ok) {
                this.deploys = [];
                this.refresh();
                return;
            }
            this.deploys = res.deploys
                .filter((d) => d.live)
                .map((d) => {
                const instance = d.instance;
                const live = d.live;
                const state = live.ready
                    ? 'running'
                    : live.state === 'running'
                        ? 'loading'
                        : live.state === 'stopped'
                            ? 'stopped'
                            : 'unknown';
                return {
                    instanceId: live.instanceId,
                    modelLabel: live.modelLabel,
                    state,
                    endpoint: live.endpoint,
                    ready: live.ready,
                    gpu: live.gpu,
                    location: live.location,
                    pricePerHr: live.pricePerHr,
                    apiKey: live.apiKey,
                    // Canonical GPU/LLM deployments are saga resources, not SSH-capable
                    // VMs. Keep their opaque owner-scoped ID so multiple provisioning
                    // sagas never collapse into the old numeric `instanceId = 0` row.
                    instanceRecordId: instance.id || `llm-${live.instanceId}`,
                    canonical: Boolean(instance.id?.startsWith('gpu_')),
                };
            }).concat(res.deploys
                .filter((d) => !d.live)
                .map((d) => {
                const inst = d.instance;
                return {
                    instanceId: 0,
                    modelLabel: inst.tier?.replace(/^LLM · /, '') || 'Unknown',
                    state: 'destroyed',
                    endpoint: null,
                    ready: false,
                    gpu: '',
                    location: '',
                    pricePerHr: 0,
                    apiKey: null,
                    instanceRecordId: inst.id || '',
                    canonical: Boolean(inst.id?.startsWith('gpu_')),
                };
            }));
            this.refresh();
        }
        catch (err) {
            const status = err.status;
            if (status === 401)
                logger_1.logger.info('Deploys are waiting for a refreshed Capix session');
            else if (status === 503)
                logger_1.logger.info('Deploys are temporarily unavailable');
            else
                logger_1.logger.error('DeploysTreeProvider.load failed', { error: String(err) });
            this.deploys = [];
            this.refresh();
        }
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren() {
        if (!(await this.client.checkConfigured())) {
            return [
                new DeployItem('Connect wallet to view deploys', 'capix-info', vscode.TreeItemCollapsibleState.None, {
                    command: 'capix.connectWallet',
                    title: 'Connect',
                }),
            ];
        }
        if (this.deploys.length === 0) {
            return [
                new DeployItem('No deploys yet — deploy a model below', 'capix-info', vscode.TreeItemCollapsibleState.None),
            ];
        }
        return this.deploys.map((d) => {
            const icon = d.state === 'running'
                ? '$(check)'
                : d.state === 'loading'
                    ? '$(loading~spin)'
                    : d.state === 'stopped'
                        ? '$(debug-stop)'
                        : d.state === 'destroyed'
                            ? '$(trash)'
                            : '$(circle)';
            const ctxValue = d.canonical
                ? 'capix-canonical-deploy'
                : d.state === 'running'
                    ? 'capix-deploy-running'
                    : d.state === 'stopped'
                        ? 'capix-deploy-stopped'
                        : d.state === 'destroyed'
                            ? 'capix-deploy-destroyed'
                            : 'capix-deploy';
            const label = `${d.modelLabel} · ${d.state === 'loading' ? 'provisioning' : d.state}`;
            const desc = d.ready && d.endpoint
                ? `${d.gpu} · ${d.location} · $${d.pricePerHr.toFixed(2)}/hr`
                : d.gpu
                    ? `${d.gpu} · ${d.location}`
                    : '';
            const item = new DeployItem(label, ctxValue, vscode.TreeItemCollapsibleState.None);
            item.description = desc;
            item.iconPath = new vscode.ThemeIcon(icon);
            item.tooltip = d.ready
                ? `Endpoint: ${d.endpoint}/v1\nEndpoint ready — copy the base URL + API key to start using it.`
                : d.state === 'loading'
                    ? `Provisioning on ${d.gpu} in ${d.location}\nModel download takes 2–10 min.`
                    : `${d.state} deploy`;
            item.contextValue = ctxValue;
            item._deploy = d;
            return item;
        });
    }
}
exports.DeploysTreeProvider = DeploysTreeProvider;
// ── Tree item subclasses ──────────────────────────────────────────────────
class DeployItem extends vscode.TreeItem {
    constructor(label, contextValue, collapsible, command) {
        super(label, collapsible);
        this.contextValue = contextValue;
        if (command)
            this.command = command;
    }
}
exports.DeployItem = DeployItem;
//# sourceMappingURL=treeViews.js.map