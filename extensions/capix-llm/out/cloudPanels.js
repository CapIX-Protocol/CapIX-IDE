"use strict";
/**
 * Cloud Panels — tree views for all Capix cloud resources:
 * 1. Instances (VPS + GPU + LLM deploys) with start/stop/destroy/SSH controls
 * 2. Agents (GitHub repo deploys) with view logs / SSH
 * 3. Serverless Jobs with trigger / view logs
 * 4. API Keys with create / revoke / copy
 *
 * Each panel maps directly to the web console's /cloud/* routes
 * and shares the same session token — so a deploy created on the web
 * shows up in the IDE instantly (and vice versa).
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
exports.CloudItem = exports.ApiKeysTreeProvider = exports.JobsTreeProvider = exports.AgentsTreeProvider = exports.InstancesTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
const logger_1 = require("./logger");
// ── Instances tree ──────────────────────────────────────────────────────────
class InstancesTreeProvider {
    client;
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    instances = [];
    constructor(client) {
        this.client = client;
    }
    refresh() { this._onDidChange.fire(); }
    async load() {
        try {
            const res = await this.client.getBalance();
            if (res.ok) {
                this.instances = res.instances || [];
            }
        }
        catch (err) {
            logger_1.logger.error("InstancesTreeProvider.load failed", { error: String(err) });
            this.instances = [];
        }
        this.refresh();
    }
    getTreeItem(element) { return element; }
    async getChildren() {
        if (!await this.client.checkConfigured()) {
            return [CloudItem.info("Connect wallet to view instances")];
        }
        if (this.instances.length === 0) {
            return [CloudItem.info("No instances — deploy from the Console")];
        }
        return this.instances.map((inst) => {
            const item = new CloudItem(`${inst.tier}`, `capix-instance-${inst.status}`, vscode.TreeItemCollapsibleState.None);
            item.description = `${inst.status} · $${inst.costUsdPerHour.toFixed(2)}/hr`;
            item.iconPath = new vscode.ThemeIcon(inst.status === "running" ? "$(vm-active)" :
                inst.status === "stopped" ? "$(vm-outline)" : "$(vm-connect)");
            item.tooltip = `${inst.tier}\n${inst.nodes.length} node(s) · since ${new Date(inst.startedAt).toLocaleString()}`;
            item.contextValue = `capix-instance-${inst.status}`;
            item.command = { command: "capix.openInstance", title: "Open", arguments: [inst.id] };
            item._instanceId = inst.id;
            item._sshHost = inst.nodes.find((n) => n.sshHost)?.sshHost ?? undefined;
            item._sshPort = inst.nodes.find((n) => n.sshPort)?.sshPort ?? undefined;
            return item;
        });
    }
}
exports.InstancesTreeProvider = InstancesTreeProvider;
// ── Agents tree ─────────────────────────────────────────────────────────────
class AgentsTreeProvider {
    client;
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    agents = [];
    constructor(client) {
        this.client = client;
    }
    refresh() { this._onDidChange.fire(); }
    async load() {
        // Customer launch: agent deployment is intentionally disabled. Do not hit
        // a disabled production route and misreport that expected state as a fault.
        this.agents = [];
        this.refresh();
    }
    getTreeItem(element) { return element; }
    async getChildren() {
        if (!await this.client.checkConfigured()) {
            return [CloudItem.info("Connect wallet to view agents")];
        }
        if (this.agents.length === 0)
            return [CloudItem.info("Agent deployment — coming later")];
        return this.agents.map((a) => {
            const item = new CloudItem(a.repoName, "capix-agent", vscode.TreeItemCollapsibleState.None);
            item.description = `${a.status} · ${a.nodeGpu} · ${a.nodeLocation}`;
            item.iconPath = new vscode.ThemeIcon("$(github)");
            item.tooltip = `${a.repoName}\nNode: ${a.nodeName} (${a.nodeGpu})\nSSH: ${a.sshCommand}`;
            item.contextValue = "capix-agent";
            item._sshCommand = a.sshCommand;
            return item;
        });
    }
}
exports.AgentsTreeProvider = AgentsTreeProvider;
// ── Serverless Jobs tree ─────────────────────────────────────────────────────
class JobsTreeProvider {
    client;
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    jobs = [];
    constructor(client) {
        this.client = client;
    }
    refresh() { this._onDidChange.fire(); }
    async load() {
        this.jobs = [];
        this.refresh();
    }
    getTreeItem(element) { return element; }
    async getChildren() {
        if (!await this.client.checkConfigured())
            return [CloudItem.info("Connect wallet to view jobs")];
        if (this.jobs.length === 0)
            return [CloudItem.info("Serverless jobs — coming later")];
        return this.jobs.map((j) => {
            const item = new CloudItem(j.name, "capix-job", vscode.TreeItemCollapsibleState.None);
            item.description = `${j.status} · ${j.nodeGpu}`;
            item.iconPath = new vscode.ThemeIcon("$(server-process)");
            item.tooltip = `${j.name}\nSSH: ${j.sshCommand}`;
            item.contextValue = "capix-job";
            item._sshCommand = j.sshCommand;
            return item;
        });
    }
}
exports.JobsTreeProvider = JobsTreeProvider;
// ── API Keys tree ─────────────────────────────────────────────────────────────
class ApiKeysTreeProvider {
    client;
    _onDidChange = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChange.event;
    keys = [];
    constructor(client) {
        this.client = client;
    }
    refresh() { this._onDidChange.fire(); }
    async load() {
        // Desktop chat uses the short-lived OAuth session; customers do not need
        // to create or paste a portal API key.
        this.keys = [];
        this.refresh();
    }
    getTreeItem(element) { return element; }
    async getChildren() {
        if (!await this.client.checkConfigured())
            return [CloudItem.info("Connect wallet to view API keys")];
        if (this.keys.length === 0)
            return [CloudItem.info("OAuth connected · no API key required")];
        return this.keys.map((k) => {
            const item = new CloudItem(k.name, "capix-apikey", vscode.TreeItemCollapsibleState.None);
            item.description = `${k.keyPrefix} · ${k.status} · ${k.totalRequests} reqs`;
            item.iconPath = new vscode.ThemeIcon("$(key)");
            item.tooltip = `${k.name}\nKey: ${k.keyPrefix}\nStatus: ${k.status}\nRequests: ${k.totalRequests}${k.lastUsedAt ? `\nLast used: ${k.lastUsedAt}` : ""}`;
            item.contextValue = `capix-apikey-${k.status}`;
            return item;
        });
    }
}
exports.ApiKeysTreeProvider = ApiKeysTreeProvider;
// ── Shared cloud tree item ───────────────────────────────────────────────────
class CloudItem extends vscode.TreeItem {
    constructor(label, contextValue, collapsible, command) {
        super(label, collapsible);
        this.contextValue = contextValue;
        if (command)
            this.command = command;
    }
    static info(label) {
        const item = new CloudItem(label, "capix-info", vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("$(info)");
        return item;
    }
}
exports.CloudItem = CloudItem;
//# sourceMappingURL=cloudPanels.js.map