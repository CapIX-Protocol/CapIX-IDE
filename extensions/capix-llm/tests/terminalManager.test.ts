import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockCreateTerminal, mockShowWarningMessage, mockOnDidCloseTerminal,
  mockWriteFileSync, mockExistsSync, mockMkdirSync, mockUnlinkSync, mockExecFile } = vi.hoisted(() => ({
  mockCreateTerminal: vi.fn(), mockShowWarningMessage: vi.fn(), mockOnDidCloseTerminal: vi.fn(),
  mockWriteFileSync: vi.fn(), mockExistsSync: vi.fn(() => false), mockMkdirSync: vi.fn(),
  mockUnlinkSync: vi.fn(), mockExecFile: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: {
    createTerminal: mockCreateTerminal,
    showWarningMessage: mockShowWarningMessage,
    onDidCloseTerminal: mockOnDidCloseTerminal,
    showErrorMessage: vi.fn(),
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })),
  },
  ThemeIcon: vi.fn().mockImplementation((icon: string) => ({ id: icon })),
  Terminal: vi.fn(),
}));

vi.mock("fs", () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  unlinkSync: mockUnlinkSync,
}));

vi.mock("child_process", () => ({
  execFile: mockExecFile,
}));

vi.mock("crypto", () => ({
  default: { randomBytes: vi.fn(() => Buffer.from("aabbccdd", "hex")) },
  randomBytes: vi.fn(() => Buffer.from("aabbccdd", "hex")),
}));

vi.mock("os", () => ({
  default: { tmpdir: vi.fn(() => "/tmp") },
  tmpdir: vi.fn(() => "/tmp"),
}));

vi.mock("path", () => ({
  default: {
    join: vi.fn((...args: string[]) => args.join("/")),
    dirname: vi.fn((p: string) => p.split("/").slice(0, -1).join("/")),
  },
  join: vi.fn((...args: string[]) => args.join("/")),
  dirname: vi.fn((p: string) => p.split("/").slice(0, -1).join("/")),
}));

import { TerminalManager } from "../src/terminalManager";

function createMockTerminal() {
  return {
    show: vi.fn(),
    sendText: vi.fn(),
    dispose: vi.fn(),
    exitStatus: undefined as undefined | { code: number },
  };
}

describe("TerminalManager", () => {
  let manager: TerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockExistsSync.mockReturnValue(false);
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(null, "", "");
    });
    mockCreateTerminal.mockReturnValue(createMockTerminal());
    manager = new TerminalManager("/global/storage");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor / known_hosts", () => {
    it("should create the known_hosts file in global storage on init", () => {
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        "/global/storage/known_hosts",
        "",
        { mode: 0o600 },
      );
    });

    it("should create the global storage directory if it does not exist", () => {
      mockExistsSync.mockReturnValue(false);
      new TerminalManager("/another/path");
      expect(mockMkdirSync).toHaveBeenCalledWith("/another/path", { recursive: true });
    });

    it("should not recreate known_hosts if it already exists", () => {
      mockExistsSync.mockReturnValue(true);
      vi.clearAllMocks();
      new TerminalManager("/global/storage");
      expect(mockWriteFileSync).not.toHaveBeenCalledWith(
        "/global/storage/known_hosts",
        "",
        expect.anything(),
      );
    });
  });

  describe("host-key verification (TOFU)", () => {
    it("should use accept-new (TOFU) for unknown hosts", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      mockExecFile.mockImplementation((cmd: string, _args: string[], cb: Function) => {
        if (cmd === "ssh-keygen") {
          cb(null, "", "");
        } else {
          cb(null, "", "");
        }
      });

      await manager.openSshSession({ host: "newhost.com", port: 22, label: "New Host" });

      expect(mockCreateTerminal).toHaveBeenCalled();
      const call = mockCreateTerminal.mock.calls[0][0];
      expect(call.shellPath).toBe("ssh");
      const sshArgs = call.shellArgs;
      const strictIdx = sshArgs.indexOf("-o");
      expect(sshArgs[strictIdx + 1]).toContain("StrictHostKeyChecking=accept-new");
    });

    it("should use strict (yes) for known hosts", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      mockExecFile.mockImplementation((cmd: string, _args: string[], cb: Function) => {
        if (cmd === "ssh-keygen") {
          cb(null, "# Host knownhost found\nknownhost ssh-rsa AAAA", "");
        } else {
          cb(null, "", "");
        }
      });

      await manager.openSshSession({ host: "knownhost.com", port: 22, label: "Known Host" });

      const call = mockCreateTerminal.mock.calls[0][0];
      const sshArgs = call.shellArgs;
      const strictIdx = sshArgs.indexOf("-o");
      expect(sshArgs[strictIdx + 1]).toContain("StrictHostKeyChecking=yes");
    });

    it("should abort and warn when host key has changed", async () => {
      mockExecFile.mockImplementation((cmd: string, _args: string[], cb: Function) => {
        if (cmd === "ssh-keygen") {
          cb(null, "# Host changedhost found\nchangedhost ssh-rsa AAAA", "");
        } else {
          cb(
            new Error("REMOTE HOST IDENTIFICATION HAS CHANGED"),
            "",
            "REMOTE HOST IDENTIFICATION HAS CHANGED",
          );
        }
      });

      await manager.openSshSession({ host: "changedhost.com", port: 22, label: "Changed Host" });

      expect(mockCreateTerminal).not.toHaveBeenCalled();
      expect(mockShowWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining("Host key changed for changedhost.com"),
      );
    });

    it("should use UserKnownHostsFile pointing to persistent known_hosts", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(null, "", "");
      });

      await manager.openSshSession({ host: "anyhost.com", port: 2222, label: "Custom Port" });

      const call = mockCreateTerminal.mock.calls[0][0];
      const sshArgs = call.shellArgs;
      expect(sshArgs).toContain("UserKnownHostsFile=/global/storage/known_hosts");
    });
  });

  describe("API-key temp-file flow", () => {
    it("should write the API key to a temp file with 0600 mode", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-secret-key", "test-model");

      const writeCall = mockWriteFileSync.mock.calls.find(
        (c) => typeof c[1] === "string" && c[1] === "sk-secret-key",
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![2]).toEqual({ mode: 0o600 });
    });

    it("should not pass the API key as an env var to the terminal", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-secret-key");

      const terminalOpts = mockCreateTerminal.mock.calls[0][0];
      expect(terminalOpts.env.CAPIX_API_KEY).toBeUndefined();
      expect(terminalOpts.env.CAPIX_API_KEY_FILE).toBeDefined();
      expect(terminalOpts.env.CAPIX_BASE_URL).toBe("https://capix.network");
    });

    it("should include the model env var when provided", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-key", "gpt-4");

      const terminalOpts = mockCreateTerminal.mock.calls[0][0];
      expect(terminalOpts.env.CAPIX_MODEL).toBe("gpt-4");
    });

    it("should omit the model env var when not provided", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-key");

      const terminalOpts = mockCreateTerminal.mock.calls[0][0];
      expect(terminalOpts.env.CAPIX_MODEL).toBeUndefined();
    });

    it("should send the inline command reading from the key file after a delay", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-key");

      expect(mockTerminal.sendText).not.toHaveBeenCalled();

      vi.advanceTimersByTime(600);

      expect(mockTerminal.sendText).toHaveBeenCalledWith(
        expect.stringContaining('CAPIX_API_KEY="$(cat "$CAPIX_API_KEY_FILE")" capix-code'),
      );
    });

    it("should sweep the temp key file after 30 seconds", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-key");

      vi.advanceTimersByTime(600);
      expect(mockTerminal.sendText).toHaveBeenCalled();

      vi.advanceTimersByTime(31_000);
      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it("should not crash if the temp file is already deleted during sweep", async () => {
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-key");
      vi.advanceTimersByTime(31_000);

      expect(mockUnlinkSync).toHaveBeenCalled();
    });
  });

  describe("terminal reuse", () => {
    it("should reuse an existing terminal for the same host", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(null, "", "");
      });

      await manager.openSshSession({ host: "host.com", port: 22, label: "Host" });
      await manager.openSshSession({ host: "host.com", port: 22, label: "Host" });

      expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
      expect(mockTerminal.show).toHaveBeenCalledTimes(2);
    });
  });

  describe("runRemoteCommand", () => {
    it("should open a terminal running a remote command via SSH", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(null, "", "");
      });

      await manager.runRemoteCommand(
        { host: "remote.com", port: 22, label: "Remote" },
        "nvidia-smi",
      );

      expect(mockCreateTerminal).toHaveBeenCalled();
      const call = mockCreateTerminal.mock.calls[0][0];
      expect(call.shellPath).toBe("ssh");
      const sshArgs = call.shellArgs;
      expect(sshArgs).toContain("nvidia-smi");
    });
  });

  describe("disposeAll", () => {
    it("should dispose all terminals", async () => {
      const mockTerminal1 = createMockTerminal();
      const mockTerminal2 = createMockTerminal();
      mockCreateTerminal.mockReturnValueOnce(mockTerminal1).mockReturnValueOnce(mockTerminal2);

      mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
        cb(null, "", "");
      });

      await manager.openSshSession({ host: "host1.com", port: 22, label: "H1" });
      await manager.openSshSession({ host: "host2.com", port: 22, label: "H2" });

      manager.disposeAll();

      expect(mockTerminal1.dispose).toHaveBeenCalled();
      expect(mockTerminal2.dispose).toHaveBeenCalled();
    });

    it("should delete pending key files on dispose", async () => {
      const mockTerminal = createMockTerminal();
      mockCreateTerminal.mockReturnValue(mockTerminal);

      await manager.openCapixCode("https://capix.network", "sk-key");
      
      manager.disposeAll();

      expect(mockUnlinkSync).toHaveBeenCalled();
    });
  });
});
