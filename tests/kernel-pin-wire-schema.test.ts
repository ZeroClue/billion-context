import { test } from "node:test";
import assert from "node:assert/strict";
import * as kernel from "acp-kernel";

/**
 * Pin gate (#1299): the PINNED acp-kernel must emit wire-legal tool schemas.
 * Anthropic 400s any tool input_schema carrying top-level oneOf/allOf/anyOf
 * — kernel 0.0.87–0.0.88 shipped a top-level anyOf on COMPRESS_PARAMETERS
 * and hard-downed the Claude lane of 0.1.148. This walks the pinned kernel's
 * own exports (every tool, every wire shape) so a future pin bump to a bad
 * kernel fails THIS suite at the pin PR, never production traffic.
 */

const COMBINATORS = ["oneOf", "allOf", "anyOf", "not"] as const;

type ToolLike = Record<string, unknown> & { name?: string };

function schemaOf(tool: ToolLike, shape: string): Record<string, unknown> {
  if (shape === "anthropic") return tool.input_schema as Record<string, unknown>;
  if (shape === "google") return tool.parameters as Record<string, unknown>;
  const fn = tool.function as { parameters?: Record<string, unknown> } | undefined;
  return (tool.parameters as Record<string, unknown> | undefined) ?? fn?.parameters ?? {};
}

function assertPlainTopLevel(tool: ToolLike, shape: string): void {
  const schema = schemaOf(tool, shape);
  assert.ok(schema && typeof schema === "object", `${tool.name}: ${shape} schema missing`);
  for (const key of COMBINATORS) {
    assert.ok(
      schema[key] === undefined,
      `${tool.name}: pinned acp-kernel emits top-level "${key}" in ${shape} schema — Anthropic 400 (bili #1299). Do NOT pin this kernel version.`,
    );
  }
}

function collectTools(): { list: ToolLike[]; shape: string }[] {
  const shapes: { list: ToolLike[]; shape: string }[] = [];
  if (kernel.ACP_TOOLS_ANTHROPIC) shapes.push({ list: [...kernel.ACP_TOOLS_ANTHROPIC], shape: "anthropic" });
  if (kernel.ACP_TOOLS_OPENAI) shapes.push({ list: [...kernel.ACP_TOOLS_OPENAI], shape: "openai" });
  if (kernel.ACP_TOOLS_RESPONSES) shapes.push({ list: [...kernel.ACP_TOOLS_RESPONSES], shape: "responses" });
  if (kernel.ACP_READONLY_TOOLS_RESPONSES) shapes.push({ list: [...kernel.ACP_READONLY_TOOLS_RESPONSES], shape: "responses" });
  if (kernel.ACP_TOOLS_GOOGLE) shapes.push({ list: [...kernel.ACP_TOOLS_GOOGLE], shape: "google" });
  return shapes;
}

test("pinned kernel: every tool schema on every wire shape is top-level combinator-free", () => {
  const shapes = collectTools();
  assert.ok(shapes.length > 0, "no tool exports found on pinned acp-kernel");
  for (const { list, shape } of shapes) for (const tool of list) assertPlainTopLevel(tool, shape);
});

test("pinned kernel: optional tools (absorb / image_full / acp_retrieve) stay clean too", () => {
  const optional = [
    [kernel.ABSORB_TOOL, "anthropic"],
    [kernel.ABSORB_TOOL_OPENAI, "openai"],
    [kernel.ABSORB_TOOL_GOOGLE, "google"],
    [kernel.IMAGE_FULL_TOOL, "anthropic"],
    [kernel.IMAGE_FULL_TOOL_OPENAI, "openai"],
    [kernel.IMAGE_FULL_TOOL_RESPONSES, "responses"],
    [kernel.RETRIEVE_TOOL, "anthropic"],
    [kernel.RETRIEVE_TOOL_OPENAI, "openai"],
    [kernel.RETRIEVE_TOOL_RESPONSES, "responses"],
  ] as const;
  for (const [tool, shape] of optional) {
    if (tool === undefined) continue;
    assertPlainTopLevel(tool as ToolLike, shape);
  }
});

test("manifest tools inherit the same guarantee (input_schema path)", () => {
  const manifestFn =
    kernel.pluginManifest ??
    (kernel as unknown as { buildPluginManifest?: (cfg: unknown) => { tools?: ToolLike[] } }).buildPluginManifest;
  if (typeof manifestFn !== "function") return;
  const manifest = manifestFn({}) as { tools?: ToolLike[] };
  for (const tool of manifest.tools ?? []) {
    assertPlainTopLevel(tool, "anthropic");
    const openai = (tool as { openai?: ToolLike }).openai;
    if (openai) assertPlainTopLevel(openai, "openai");
  }
});
