import { existsSync } from "node:fs";
import { rootCaPath } from "../ca.js";
import { WEB_CLIENT } from "./client.js";
import { WEB_STYLES } from "./styles.js";

function escapeHtml(value: string): string {
    const map: Record<string, string> = {
        "&": "\u0026",
        "<": "\u003C",
        ">": "\u003E",
        '"': "\u0022",
        "'": "\u0027",
    };
    return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
}

export function renderPage(origin: string, version: string): string {
    const caPath = rootCaPath();
    const caPathEsc = escapeHtml(caPath);
    const caReady = existsSync(caPath);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>billion-context</title><style>${WEB_STYLES}</style></head><body>
<div class="app"><aside class="sidebar"><div class="brand"><div class="brand-title">billion<span>-context</span></div><div class="version">v${version}</div></div><a class="fork-ribbon" href="https://github.com/ranxianglei/billion-context" target="_blank" rel="noopener">★ Fork me on GitHub</a><nav class="nav"><button class="active" data-page="overview">Overview</button><button data-page="dashboard">Dashboard</button><button data-page="routing">Routing</button><button data-page="upstream">Upstream</button><button data-page="sessions">Sessions</button><button data-page="settings">Settings</button></nav></aside>
<main class="main"><section id="page-overview" class="page active"><h1>Overview</h1><p class="lead">Local routing and upstream network are independent; ACP compression runs between them.</p><div id="passthrough-banner" class="notice" hidden>⚠️ <strong>Passthrough enabled</strong>: all requests forwarded as-is, compression fully disabled, no token savings. Source: <span id="passthrough-source" class="mono"></span>. <button id="clear-passthrough" class="btn">Restore compression</button></div><div class="grid"><div class="card"><h2>Service Address</h2><p class="mono">${origin}</p></div><div class="card"><h2>Client Access</h2><p class="status">See "Routing" page to route clients (Codex / Claude Code / OpenCode / Pi, etc.) through bili.</p></div></div></section>
<section id="page-dashboard" class="page"><h1>Dashboard</h1><p class="lead">Real-time compression metrics, token savings, and cost estimates.</p><div class="grid" id="dashboard-grid"><div class="card"><h2>Total Sessions</h2><p class="metric" id="stat-sessions">—</p></div><div class="card"><h2>Cache Hit Rate</h2><p class="metric" id="stat-cache-hit">—</p></div><div class="card"><h2>Compression Ratio</h2><p class="metric" id="stat-compress-ratio">—</p></div><div class="card"><h2>Tokens Saved</h2><p class="metric" id="stat-tokens-saved">—</p></div><div class="card"><h2>Est. Cost Savings</h2><p class="metric" id="stat-cost-savings">—</p></div><div class="card"><h2>Avg Latency</h2><p class="metric" id="stat-latency">—</p></div></div><div class="card"><h2>Recent Activity</h2><canvas id="activity-chart" height="200"></canvas></div></section>
<section id="page-routing" class="page"><h1>Client Routing</h1><p class="lead">Two access methods: A. Recommended (/bili/ prefix, zero-config); B. Certificate method (MITM, requires trusting CA certificate).</p>
<h2 class="section-title">A. Recommended Access (/bili/ prefix)</h2>
<div class="card"><p class="mono">${origin}/bili/</p><p class="status">Base URL for /bili/ prefix routing. Append your upstream path, e.g. <span class="mono">${origin}/bili/openrouter.ai/...your/endpoint</span>.</p><p class="status">No certificate required. Works with Codex, OpenCode, Pi, and others that support custom base URLs.</p></div>
<h2 class="section-title">B. MITM Access (Certificate)</h2>
<div class="card"><p class="mono">${origin}</p><p class="status">Full MITM proxy on the service address. Requires installing the CA certificate at <span class="mono">${caPathEsc}</span>.</p><p class="status">${caReady ? "✅ Certificate file exists" : "⚠️ Certificate not yet generated — first MITM request will create it"}</p></div>
<div class="card"><h2>Install CA Certificate</h2><p class="status">Linux: <code>sudo cp ${caPathEsc} /usr/local/share/ca-certificates/billion-context.crt && sudo update-ca-certificates</code></p><p class="status">macOS: <code>sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caPathEsc}</code></p><p class="status">Windows: double-click the .crt file → "Install Certificate" → "Local Machine" → "Trusted Root Certification Authorities"</p></div>
</section>
<section id="page-upstream" class="page"><h1>Upstream Configuration</h1><p class="lead">Upstream providers define which model endpoints bili can reach. Each provider maps a local prefix to an upstream API base URL.</p><div class="card"><h2>Current Upstream</h2><dl class="kv"><dt>Source</dt><dd id="upstream-source" class="mono">—</dd><dt>Effective Proxy</dt><dd id="upstream-effective" class="mono">—</dd><dt>Auto-Config URL</dt><dd id="upstream-pac" class="mono">—</dd><dt>Status</dt><dd id="upstream-state" class="status">—</dd></dl><div class="actions"><button id="test-upstream" class="btn">Test Connection</button></div></div><form id="provider-form" class="card"><h2>Add / Edit Provider</h2><div class="form-row"><label>Prefix (local)</label><input type="text" id="prov-prefix" placeholder="e.g. openrouter" required></div><div class="form-row"><label>Upstream Base URL</label><input type="text" id="prov-upstream" placeholder="https://openrouter.ai/api" required></div><div class="form-row"><label>API Key (optional)</label><input type="password" id="prov-key" placeholder="sk-..."></div><div class="form-row"><label>Protocol</label><select id="prov-protocol"><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></div><div class="form-row"><button type="submit" class="btn">Save Provider</button></div></form>
<div class="card"><h2>Configured Providers</h2><table id="providers-table"><thead><tr><th>Prefix</th><th>Upstream</th><th>Protocol</th><th>API Key</th><th>Actions</th></tr></thead><tbody></tbody></table></div>
</section>
<section id="page-sessions" class="page"><h1>Active Sessions</h1><p class="lead">Compression state for each active conversation. Sessions with context over the budget are folded (compressed).</p><div class="card"><table id="sessions-table"><thead><tr><th>Session</th><th>Upstream</th><th>Protocol</th><th>Context Tokens</th><th>Budget</th><th>State</th><th>Created</th></tr></thead><tbody id="sessions-body"></tbody></table></div>
</section>
<section id="page-settings" class="page"><h1>Settings</h1><p class="lead">Global configuration for the proxy.</p>
<div class="card"><h2>Passthrough Mode</h2><p class="status">When enabled, ALL requests are forwarded without compression. Use for debugging or when upstream requires exact request fidelity.</p><label class="toggle"><input type="checkbox" id="passthrough-toggle"><span class="slider"></span></label><p class="status" id="passthrough-status"></p></div>
<div class="card"><h2>Log Level</h2><select id="log-level"><option value="debug">Debug</option><option value="info" selected>Info</option><option value="warn">Warn</option><option value="error">Error</option></select></div>
<div class="card"><h2>Compression Budget</h2><input type="number" id="compression-budget" min="1000" max="200000" step="1000" placeholder="Default: 48000"></div>
</section>
</main></div>
<div id="toast" class="toast"></div>
<script>${WEB_CLIENT}</script></body></html>`;
}