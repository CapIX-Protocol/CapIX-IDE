"use strict";
/**
 * Cloud Panels — data provider for Capix cloud compute instances.
 *
 * The sidebar tree views that used to render this data (instances, agents,
 * jobs, API keys) were consolidated into the tabbed `capix.cloud.hub`
 * webview. The InstancesTreeProvider stays as a data store: commands
 * (SSH terminal, SSH key download) read its `instances` snapshot.
 *
 * The agents / jobs / api-keys providers were removed — their routes are
 * intentionally unused (agent deployment is disabled for launch; the IDE
 * authenticates with OAuth, not portal API keys) and the cloud hub renders
 * jobs / API keys directly from CapixClient.
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
exports.CloudItem = exports.InstancesTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("./logger");
const moneyUtils_1 = require("./moneyUtils");
// ── Instances tree ──────────────────────────────────────────────────────────
class InstancesTreeProvider {
    client;
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    instances = [];
    loading = null;
    constructor(client) {
        this.client = client;
    }
    refresh() {
        this._onDidChange.fire();
    }
    async load() {
        if (this.loading)
            return this.loading;
        this.loading = (async () => {
            try {
                const res = await this.client.listInstances();
                this.instances = res.instances;
            }
            catch (err) {
                logger_1.logger.error('InstancesTreeProvider.load failed', { error: String(err) });
                this.instances = [];
            }
            this.refresh();
        })().finally(() => {
            this.loading = null;
        });
        return this.loading;
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren() {
        if (!(await this.client.checkConfigured())) {
            return [CloudItem.info('Connect wallet to view instances')];
        }
        if (this.instances.length === 0) {
            return [CloudItem.info('No instances — deploy from the Console')];
        }
        return this.instances.map((inst) => {
            const item = new CloudItem(`${inst.tier}`, `capix-instance-${inst.status}`, vscode.TreeItemCollapsibleState.None);
            item.description = `${inst.status} · $${(0, moneyUtils_1.microToDisplay)((0, moneyUtils_1.dollarsToMicro)(inst.costUsdPerHour), 2)}/hr`;
            item.iconPath = new vscode.ThemeIcon(inst.status === 'running'
                ? '$(vm-active)'
                : inst.status === 'stopped'
                    ? '$(vm-outline)'
                    : '$(vm-connect)');
            item.tooltip = `${inst.tier}\n${inst.nodes.length} node(s) · since ${new Date(inst.startedAt).toLocaleString()}`;
            item.contextValue = `capix-instance-${inst.status}`;
            item.command = { command: 'capix.openInstance', title: 'Open', arguments: [inst.id] };
            item._instanceId = inst.id;
            item._sshAvailable = inst.nodes.some((n) => n.sshAvailable);
            item._sshHost =
                inst.nodes.find((n) => n.sshHost)?.sshHost ?? undefined;
            item._sshPort =
                inst.nodes.find((n) => n.sshPort)?.sshPort ?? undefined;
            return item;
        });
    }
}
exports.InstancesTreeProvider = InstancesTreeProvider;
// ── Shared cloud tree item ───────────────────────────────────────────────────
class CloudItem extends vscode.TreeItem {
    constructor(label, contextValue, collapsible, command) {
        super(label, collapsible);
        this.contextValue = contextValue;
        if (command)
            this.command = command;
    }
    static info(label) {
        const item = new CloudItem(label, 'capix-info', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('$(info)');
        return item;
    }
}
exports.CloudItem = CloudItem;
//# sourceMappingURL=cloudPanels.js.map