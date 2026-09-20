import { listSessions } from "./session.js";
import { log } from "./logger.js";
import type { Session } from "./session.js";
import { biliEnv } from "./config-env.js";

export interface TimeBucket {
    timestamp: number;
    tokens: number;
    sessions: number;
    requests: number;
}

export interface ProviderMetrics {
    provider: string;
    sessions: number;
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    compressionRatio: number;
}

export interface AggregatedMetrics {
    totalSessions: number;
    totalRequests: number;
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
    totalContextTokens: number;
    overallCacheHitRate: number;
    overallCompressionRatio: number;
    tokensSaved: number;
    estimatedCostSavingsUSD: number;
    avgLatencyMs: number;
    perSession: Array<{
        id: string;
        protocol: string;
        upstreamOrigin: string;
        label: string;
        title: string;
        requests: number;
        contextTokens: number;
        inputTokens: number;
        cachedTokens: number;
        outputTokens: number;
        cacheSamples: number;
        cacheHitRate: number;
        lastSeen: number;
        restored: boolean;
    }>;
    byProvider: ProviderMetrics[];
    history: TimeBucket[];
}

const TOKEN_COST_PER_MILLION = 0.15; // $0.15 per 1M tokens (blended estimate)

// Metrics cache TTL (default 5s)
const METRICS_CACHE_TTL_MS = biliEnv.metricsCacheTtlMs;

// Metrics cache: TTL to avoid blocking event loop on repeated calls
let metricsCache: { data: AggregatedMetrics; timestamp: number } | null = null;

/**
 * Invalidate the metrics cache so the next collectMetrics() call recomputes.
 */
export function invalidateMetricsCache(): void {
    metricsCache = null;
}

/**
 * Calculate metrics from all active sessions.
 */
export async function collectMetrics(fresh = false): Promise<AggregatedMetrics> {
    // Return cached metrics if still fresh (unless fresh=true bypasses cache)
    if (!fresh && metricsCache && Date.now() - metricsCache.timestamp < METRICS_CACHE_TTL_MS) {
        return metricsCache.data;
    }
    const sessions = listSessions();
    
    let totalSessions = 0;
    let totalRequests = 0;
    let totalInputTokens = 0;
    let totalCachedTokens = 0;
    let totalOutputTokens = 0;
    const perSessionMetrics = [];
    const byProviderMap = new Map<string, {
        sessions: number;
        requests: number;
        inputTokens: number;
        cachedTokens: number;
        outputTokens: number;
    }>();

    for (const session of sessions) {
        const stats = session.stats || { requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0 };
        const meta = session.meta || {};
        
        totalSessions += 1;
        totalRequests += stats.requests;
        totalInputTokens += stats.inputTokens;
        totalCachedTokens += stats.cachedTokens;
        totalOutputTokens += stats.outputTokens;
        // totalContextTokens: upstream doesn't track this separately
        
        // No lastSeen in upstream stats, skip history bucketing for now
        
        // Latency tracking not available in upstream Session type
        // if (session.avgLatencyMs && session.avgLatencyMs > 0) { ... }
        
        perSessionMetrics.push({
            id: session.id,
            protocol: meta.protocol || "unknown",
            upstreamOrigin: meta.upstreamOrigin || "unknown",
            label: meta.label || "",
            title: meta.title || "",
            requests: stats.requests,
            contextTokens: 0, // not tracked in upstream
            inputTokens: stats.inputTokens,
            cachedTokens: stats.cachedTokens,
            outputTokens: stats.outputTokens,
            cacheSamples: stats.cacheSamples,
            cacheHitRate: stats.inputTokens > 0 ? stats.cachedTokens / stats.inputTokens : 0,
            lastSeen: 0, // not tracked in upstream
            restored: false, // not tracked in upstream
        });
        
        // Aggregate by provider
        const provider = meta.upstreamOrigin || "unknown";
        const providerStats = byProviderMap.get(provider) || { sessions: 0, requests: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
        providerStats.sessions += 1;
        providerStats.requests += stats.requests;
        providerStats.inputTokens += stats.inputTokens;
        providerStats.cachedTokens += stats.cachedTokens;
        providerStats.outputTokens += stats.outputTokens;
        byProviderMap.set(provider, providerStats);
    }
    
    const overallCacheHitRate = totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0;
    const overallCompressionRatio = totalInputTokens > 0 ? 1 - totalOutputTokens / totalInputTokens : 0;
    const tokensSaved = totalInputTokens - totalOutputTokens;
    const estimatedCostSavingsUSD = (tokensSaved / 1_000_000) * TOKEN_COST_PER_MILLION;
    const avgLatencyMs = 0; // not tracked in upstream Session type
    
    const byProvider = Array.from(byProviderMap.entries()).map(([provider, stats]) => ({
        provider,
        sessions: stats.sessions,
        requests: stats.requests,
        inputTokens: stats.inputTokens,
        cachedTokens: stats.cachedTokens,
        outputTokens: stats.outputTokens,
        cacheHitRate: stats.inputTokens > 0 ? stats.cachedTokens / stats.inputTokens : 0,
        compressionRatio: stats.inputTokens > 0 ? 1 - stats.outputTokens / stats.inputTokens : 0,
    })).sort((a, b) => b.requests - a.requests);
    
    const history: TimeBucket[] = []; // not tracked in upstream Session type
    
    const result = {
        totalSessions,
        totalRequests,
        totalInputTokens,
        totalCachedTokens,
        totalOutputTokens,
        totalContextTokens: 0, // not tracked in upstream
        overallCacheHitRate,
        overallCompressionRatio,
        tokensSaved,
        estimatedCostSavingsUSD,
        avgLatencyMs,
        perSession: perSessionMetrics,
        byProvider,
        history,
    };
    
    // Cache the result
    metricsCache = { data: result, timestamp: Date.now() };
    return result;
}

/**
 * Get historical hourly activity for charts.
 */
export function getHourlyActivity(since: number): TimeBucket[] {
    // For real-time metrics, we don't have historical data in-memory
    // The analytics module provides this via SQLite if enabled
    return [];
}

/**
 * Generate Prometheus-formatted metrics.
 */
export async function collectPrometheusMetrics(): Promise<string> {
    const metrics = await collectMetrics();
    
    const lines = [
        `# HELP bili_sessions_total Total number of active sessions`,
        `# TYPE bili_sessions_total gauge`,
        `bili_sessions_total ${metrics.totalSessions}`,
        ``,
        `# HELP bili_requests_total Total requests processed`,
        `# TYPE bili_requests_total counter`,
        `bili_requests_total ${metrics.totalRequests}`,
        ``,
        `# HELP bili_tokens_input_total Total input tokens`,
        `# TYPE bili_tokens_input_total counter`,
        `bili_tokens_input_total ${metrics.totalInputTokens}`,
        ``,
        `# HELP bili_tokens_cached_total Total cached tokens`,
        `# TYPE bili_tokens_cached_total counter`,
        `bili_tokens_cached_total ${metrics.totalCachedTokens}`,
        ``,
        `# HELP bili_tokens_output_total Total output tokens`,
        `# TYPE bili_tokens_output_total counter`,
        `bili_tokens_output_total ${metrics.totalOutputTokens}`,
        ``,
        `# HELP bili_cache_hit_rate Overall cache hit rate`,
        `# TYPE bili_cache_hit_rate gauge`,
        `bili_cache_hit_rate ${metrics.overallCacheHitRate}`,
        ``,
        `# HELP bili_compression_ratio Overall compression ratio`,
        `# TYPE bili_compression_ratio gauge`,
        `bili_compression_ratio ${metrics.overallCompressionRatio}`,
        ``,
        `# HELP bili_tokens_saved_total Total tokens saved`,
        `# TYPE bili_tokens_saved_total counter`,
        `bili_tokens_saved_total ${metrics.tokensSaved}`,
        ``,
        `# HELP bili_cost_savings_usd_total Estimated cost savings in USD`,
        `# TYPE bili_cost_savings_usd_total counter`,
        `bili_cost_savings_usd_total ${metrics.estimatedCostSavingsUSD}`,
        ``,
        `# HELP bili_avg_latency_ms Average latency in milliseconds`,
        `# TYPE bili_avg_latency_ms gauge`,
        `bili_avg_latency_ms ${metrics.avgLatencyMs}`,
    ];
    
    for (const p of metrics.byProvider) {
        lines.push(``);
        lines.push(`# HELP bili_provider_requests_total Requests per provider`);
        lines.push(`# TYPE bili_provider_requests_total counter`);
        lines.push(`bili_provider_requests_total{provider="${p.provider}"} ${p.requests}`);
        lines.push(``);
        lines.push(`# HELP bili_provider_cache_hit_rate Cache hit rate per provider`);
        lines.push(`# TYPE bili_provider_cache_hit_rate gauge`);
        lines.push(`bili_provider_cache_hit_rate{provider="${p.provider}"} ${p.cacheHitRate}`);
    }
    
    return lines.join("\n");
}