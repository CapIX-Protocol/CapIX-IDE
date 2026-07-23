import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapixAgentRuntime,
  type ModelRequest,
} from "../src/shared/agent-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Capix Code workspace-aware runtime", () => {
  it("advertises read tools, inspects the workspace, then answers with tool evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "capix-runtime-workspace-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), '{"name":"workspace-under-test"}');

    const requests: ModelRequest[] = [];
    const runtime = new CapixAgentRuntime({
      dbPath: join(root, "runtime.db"),
      workspaceRoot: root,
      modelInvoker: async function* (request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "tool_call", toolName: "capix_get_orientation", args: {} } as const;
          return;
        }
        yield {
          type: "text",
          delta: "This workspace is workspace-under-test and its manifest is package.json.",
        } as const;
      },
    });

    try {
      const session = await runtime.createSession({
        workspaceRoot: root,
        modelId: "capix/auto",
        mode: "ask",
      });
      const events = [];
      for await (const event of runtime.sendMessage({
        sessionId: session.id,
        content: "Describe this codebase.",
      })) {
        events.push(event);
      }

      expect(requests).toHaveLength(2);
      expect(requests[0].workspaceRoot).toBe(root);
      expect(requests[0].messages[0].content).toContain(
        "Never claim that you cannot access the codebase",
      );
      expect(requests[0].tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          "list_files",
          "read_file",
          "capix_search_codebase",
          "capix_find_references",
          "capix_get_orientation",
        ]),
      );
      expect(requests[1].messages.at(-1)?.content).toContain("package.json");
      expect(events.some((event) => event.type === "tool.output")).toBe(true);
      expect(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.content)
          .join(""),
      ).toContain("workspace-under-test");
    } finally {
      runtime.close();
    }
  });
});
