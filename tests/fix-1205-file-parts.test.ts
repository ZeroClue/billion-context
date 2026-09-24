import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { REMOTE_IMAGE_TOKENS, imageTokensInParsedBody, imageTokensInRawBody } from "../src/image-tokens.ts";
import { droppedOpenaiParts } from "../src/wire-drop-warn.ts";
import { _resetWireDropWarningsForTest, warnDroppedOpenaiParts } from "../src/server.ts";

// Issue #1205: the openai wire codec silently drops every user content part
// whose type is neither text nor image_url — DeepSeek Files API attachments
// ({type:"file","file_id":"file-api-…"}) vanish before any compression. This
// pins the two in-repo mitigations: (1) token estimation charges file parts
// like remote references so they stop being invisible to fit decisions, and
// (2) the proxy logs a one-time-per-session warn naming the dropped types
// instead of staying silent. The root fix (opaque part carry-through in
// acp-kernel) is tracked separately.

const deepseekFilePart = { type: "file", file_id: "file-api-abc123" };
const openaiInlineDataFilePart = { type: "file", file: { file_data: `data:image/png;base64,${"A".repeat(800)}`, filename: "shot.png" } };
const openaiUrlFilePart = { type: "file", file: { url: "https://files.example.com/x.png" } };
const imagePart = { type: "image_url", image_url: { url: "https://img.example.com/a.png" } };

function openaiBody(messages: unknown[]): Record<string, unknown> {
    return { model: "deepseek-chat", messages };
}

test("openai file part (DeepSeek Files API ref) costs the flat remote price", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "what is in this image?" }, deepseekFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS);
});

test("openai file part with inline file_data is sized from its base64 payload", () => {
    const body = openaiBody([{ role: "user", content: [openaiInlineDataFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), Math.ceil(800 / 4));
});

test("openai file part with a url ref costs the flat remote price", () => {
    const body = openaiBody([{ role: "user", content: [openaiUrlFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS);
});

test("mixed text + file + image_url sums all three", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart, imagePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS * 2);
});

test("file parts outside user role are charged the same way (parity with image_url)", () => {
    const body = openaiBody([{ role: "assistant", content: [deepseekFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS);
});

test("plain-text bodies stay free (no regression)", () => {
    assert.equal(imageTokensInParsedBody("openai", openaiBody([{ role: "user", content: "hello" }])), 0);
    assert.equal(imageTokensInParsedBody("openai", openaiBody([{ role: "user", content: [{ type: "text", text: "hello" }] }])), 0);
});

test("raw-body probe fires on file parts even without any image_url marker", () => {
    const compact = JSON.stringify(openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart] }]));
    assert.ok(!compact.includes("image_url"));
    assert.equal(imageTokensInRawBody("openai", compact), REMOTE_IMAGE_TOKENS);
    const spaced = compact.replace('"type":"file"', '"type": "file"');
    assert.equal(imageTokensInRawBody("openai", spaced), REMOTE_IMAGE_TOKENS);
});

test("droppedOpenaiParts flags DeepSeek-style file refs on user messages", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "what is in this image?" }, deepseekFilePart] }]);
    assert.deepEqual(droppedOpenaiParts(body), { count: 1, types: ["file"], firstIndex: 0 });
});

test("droppedOpenaiParts ignores preserved user parts (text + image_url)", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, imagePart] }]);
    assert.equal(droppedOpenaiParts(body), null);
});

test("droppedOpenaiParts reports the drop even when an image survives alongside", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart, imagePart] }]);
    assert.deepEqual(droppedOpenaiParts(body), { count: 1, types: ["file"], firstIndex: 0 });
});

test("droppedOpenaiParts applies the stricter preserved set to non-user roles", () => {
    const body = openaiBody([
        { role: "user", content: "hi" },
        { role: "assistant", content: [imagePart] },
    ]);
    assert.deepEqual(droppedOpenaiParts(body), { count: 1, types: ["image_url"], firstIndex: 1 });
});

test("droppedOpenaiParts unions types across messages and keeps the earliest index", () => {
    const body = openaiBody([
        { role: "user", content: [{ type: "input_audio", input_audio: {} }] },
        { role: "assistant", content: [{ type: "custom_thing", x: 1 }] },
        { role: "tool", content: [{ type: "file", file_id: "f" }] },
    ]);
    assert.deepEqual(droppedOpenaiParts(body), { count: 3, types: ["custom_thing", "file", "input_audio"], firstIndex: 0 });
});

test("droppedOpenaiParts counts typeless parts and tolerates degenerate shapes", () => {
    assert.deepEqual(droppedOpenaiParts(openaiBody([{ role: "user", content: [{ foo: 1 }] }])), { count: 1, types: ["<no-type>"], firstIndex: 0 });
    assert.equal(droppedOpenaiParts(openaiBody([{ role: "user", content: "plain string" }])), null);
    assert.equal(droppedOpenaiParts({}), null);
    assert.equal(droppedOpenaiParts(null), null);
    assert.equal(droppedOpenaiParts("not an object"), null);
});

test("warnDroppedOpenaiParts logs once per session per distinct type-set", () => {
    _resetWireDropWarningsForTest();
    const lines: string[] = [];
    const log = (level: string, msg: string) => lines.push(`${level}: ${msg}`);
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart] }]);

    warnDroppedOpenaiParts(body, "ses_a", log);
    warnDroppedOpenaiParts(body, "ses_a", log); // same session, same types → deduped
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warn: \[ses_a\] wire codec will drop 1 content part\(s\) with unrecognized type\(s\) \[file\]/);
    assert.match(lines[0], /#1205/);

    const secondType = openaiBody([{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }]);
    warnDroppedOpenaiParts(secondType, "ses_a", log); // new type-set → warns again
    assert.equal(lines.length, 2);

    warnDroppedOpenaiParts(body, "ses_b", log); // new session → warns again
    assert.equal(lines.length, 3);

    warnDroppedOpenaiParts(openaiBody([{ role: "user", content: "clean" }]), "ses_a", log); // nothing dropped → silent
    assert.equal(lines.length, 3);

    _resetWireDropWarningsForTest();
    warnDroppedOpenaiParts(body, "ses_a", log); // after reset → warns again
    assert.equal(lines.length, 4);
});
