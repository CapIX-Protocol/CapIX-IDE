import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinTools } from "../src/shared/agent-runtime/tools";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "capix-agent-tools-"));
  workspaces.push(root);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "node_modules"));
  await writeFile(join(root, "package.json"), '{"name":"capix-sample"}');
  await writeFile(join(root, "src", "index.ts"), "export const capixRouter = true;\n");
  await writeFile(join(root, "node_modules", "ignored.js"), "capixRouter");
  return root;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function context(root: string) {
  return { sessionId: "session", turnId: "turn", workspaceRoot: root };
}

describe("Capix Code workspace discovery tools", () => {
  it("lists source and manifest files without dependencies", async () => {
    const root = await workspace();
    const tool = createBuiltinTools().find((entry) => entry.name === "list_files")!;
    const result = await tool.execute({}, context(root));

    expect(result.output).toContain("package.json");
    expect(result.output).toContain("src/index.ts");
    expect(result.output).not.toContain("node_modules");
  });

  it("searches the attached workspace with file and line evidence", async () => {
    const root = await workspace();
    const tool = createBuiltinTools().find((entry) => entry.name === "capix_search_codebase")!;
    const result = await tool.execute({ query: "capixRouter" }, context(root));

    expect(result.output).toContain("src/index.ts:1:");
    expect(result.output).not.toContain("ignored.js");
  });

  it("returns an orientation that identifies the workspace manifest", async () => {
    const root = await workspace();
    const tool = createBuiltinTools().find((entry) => entry.name === "capix_get_orientation")!;
    const result = await tool.execute({}, context(root));

    expect(result.output).toContain(`Workspace: ${root}`);
    expect(result.output).toContain("package.json");
  });
});
