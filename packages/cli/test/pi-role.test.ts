import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piArguments, resolvePiArguments } from "../src/pi-role.js";

function fixture(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-role-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "tigerstyle"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "skills", "tigerstyle", "SKILL.md"), "---\nname: tigerstyle\ndescription: Tiger style\n---\nbody\n");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { "dev-model": "openai/gpt-5:high" }, skills: ["!*"] }));
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "developer.md"), "---\nmodel: dev-model\ntools: [\"!*\", read, bash, view_image]\nskills: [tigerstyle]\ncontextFiles: []\n---\nBe a developer.\n");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "plain.md"), "---\noverrideSystemPrompt: true\ncontextFiles: [global]\n---\nOverride.\n");
  return { cwd, agentDir };
}

void test("pi-role translates a resolved role into pi startup arguments", async () => {
  const { cwd, agentDir } = fixture();
  try {
    const args = await resolvePiArguments("developer", ["--continue"], cwd, agentDir);
    assert.deepEqual(args.slice(0, 4), ["--model", "openai/gpt-5:high", "--tools", "read,bash,view_image"]);
    assert.deepEqual(args.slice(4, 7), ["--no-skills", "--skill", join(agentDir, "skills", "tigerstyle", "SKILL.md")]);
    assert.equal(args[7], "--no-extensions");
    assert.deepEqual(args.slice(-4), ["--append-system-prompt", "Be a developer.", "--no-context-files", "--continue"]);
    assert.ok(!args.includes("--extension"), "no extensions discovered in the fixture");
    await assert.rejects(resolvePiArguments("plain", [], cwd, agentDir), /subset of context file scopes/);
    await assert.rejects(resolvePiArguments("missing", [], cwd, agentDir), /Unknown agent role: missing/);
  } finally { rmSync(join(cwd, ".."), { recursive: true, force: true }); }
});

void test("pi-role leaves context files to pi and uses --system-prompt for overriding roles", () => {
  const base = { prompt: "P", overrideSystemPrompt: true, systemPrompt: { mode: "override" as const, text: "P" }, selectorSources: { global: {}, project: {} }, selectorLayers: { skills: [undefined], extensions: [undefined], tools: [undefined] } };
  assert.deepEqual(piArguments(base, new Map(), ["-p", "hi"]), ["--no-skills", "--no-extensions", "--system-prompt", "P", "-p", "hi"]);
  assert.deepEqual(piArguments({ ...base, contextFiles: ["global", "project", "cwd"] }, new Map(), []), ["--no-skills", "--no-extensions", "--system-prompt", "P"]);
});
