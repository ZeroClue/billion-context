import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { collectMetrics, type AggregatedMetrics, type TimeBucket } from "./metrics.js";
import { log } from "./logger.js";
import { biliEnv } from "./config-env.js";

/**
 * SQLite-based analytics persistence for historical metrics.
 * Stores aggregated metrics snapshots for trend analysis and dashboard history.
 */

const DB_NAME = "bili-analytics.db";
const MAX_SESSIONS_PER_SNAPSHOT = biliEnv.maxSessionsPerSnapshot;
let db: any = null;
let dbPath: string = "";
let initialized = false;

/**
 * Initialize the SQLite database connection and schema.
 */
export async function initAnalytics(): Promise<void> {
    if (initialized) return;

    try {
        // Dynamic import to avoid bundling issues if better-sqlite3 not installed
        const Database = (await import("better-sqlite3")).default;
        
        // Default to bili data directory
        const dataDir = join(homedir(), ".billi", "data");
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }
        dbPath = join(dataDir, DB_NAME);

        db = new Database(dbPath);
        
        // Enable WAL mode for better concurrent access
        db.pragma("journal_mode = WAL");
        
        // Create tables
        createSchema();
        
        initialized = true;
        log("info", `[analytics] initialized at ${dbPath}`);
    } catch (error) {
        log("warn", `[analytics] failed to initialize: ${String(error)} (better-sqlite3 not installed?)`);
        // Don't throw - analytics is optional
    }
}

/**
 * Create database schema if not exists.
 */
function createSchema(): void {
    if (!db) return;

    // Snapshots table - periodic aggregated metrics
    db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            total_sessions INTEGER NOT NULL,
            total_requests INTEGER NOT NULL,
            total_input_tokens INTEGER NOT NULL,
            total_cached_tokens INTEGER NOT NULL,
            total_output_tokens INTEGER NOT NULL,
            total_context_tokens INTEGER NOT NULL,
            cache_hit_rate REAL NOT NULL,
            compression_ratio REAL NOT NULL,
            tokens_saved INTEGER NOT NULL,
            cost_savings_usd REAL NOT NULL,
            avg_latency_ms INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        
        CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
    `);

    // Session history table - individual session records over time
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL,
            session_id TEXT NOT NULL,
            protocol TEXT,
            upstream_origin TEXT,
            label TEXT,
            title TEXT,
            requests INTEGER NOT NULL,
            context_tokens INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            cached_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_samples INTEGER NOT NULL,
            cache_hit_rate REAL NOT NULL,
            last_seen INTEGER NOT NULL,
            restored INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_session_history_snapshot ON session_history(snapshot_id);
        CREATE INDEX IF NOT EXISTS idx_session_history_session ON session_history(session_id);
    `);

    // Provider metrics table - per-provider aggregates
    db.exec(`
        CREATE TABLE IF NOT EXISTS provider_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER NOT NULL,
            provider TEXT NOT NULL,
            sessions INTEGER NOT NULL,
            requests INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            cached_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            cache_hit_rate REAL NOT NULL,
            compression_ratio REAL NOT NULL,
            FOREIGN KEY (snapshot_id) REFERENCES snapshots(id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_provider_metrics_snapshot ON provider_metrics(snapshot_id);
        CREATE INDEX IF NOT EXISTS idx_provider_metrics_provider ON provider_metrics(provider);
    `);

    // Hourly activity table - time-series data for charts
    db.exec(`
        CREATE TABLE IF NOT EXISTS hourly_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bucket_timestamp INTEGER NOT NULL UNIQUE,
            total_tokens INTEGER NOT NULL,
            total_sessions INTEGER NOT NULL,
            total_requests INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
        );
        
        CREATE INDEX IF NOT EXISTS idx_hourly_activity_timestamp ON hourly_activity(bucket_timestamp);
    `);
}

/**
 * Reservoir sampling - returns k random items from a stream with equal probability.
 * Each item has exactly k/n chance of being in the final sample.
 */
function reservoirSample<T>(items: T[], k: number): T[] {
    if (items.length <= k) return [...items];
    
    const reservoir = items.slice(0, k);
    
    for (let i = k; i < items.length; i++) {
        const j = Math.floor(Math.random() * (i + 1));
        if (j < k) {
            reservoir[j] = items[i];
        }
    }
    
    return reservoir;
}

/**
 * Record a metrics snapshot to the database.
 */
export async function recordSnapshot(metrics: AggregatedMetrics): Promise<void> {
    if (!db || !initialized) return;

    try {
        const timestamp = Date.now();
        
        // Insert main snapshot
        const insertSnapshot = db.prepare(`
            INSERT INTO snapshots (
                timestamp, total_sessions, total_requests, total_input_tokens,
                total_cached_tokens, total_output_tokens, total_context_tokens,
                cache_hit_rate, compression_ratio, tokens_saved, cost_savings_usd, avg_latency_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        const result = insertSnapshot.run(
            timestamp,
            metrics.totalSessions,
            metrics.totalRequests,
            metrics.totalInputTokens,
            metrics.totalCachedTokens,
            metrics.totalOutputTokens,
            metrics.totalContextTokens,
            metrics.overallCacheHitRate,
            metrics.overallCompressionRatio,
            metrics.tokensSaved,
            metrics.estimatedCostSavingsUSD,
            metrics.avgLatencyMs
        );
        
        const snapshotId = result.lastInsertRowid;

        // Insert per-session details (reservoir sample for fair representation)
        if (metrics.perSession.length > 0) {
            const insertSession = db.prepare(`
                INSERT INTO session_history (
                    snapshot_id, session_id, protocol, upstream_origin, label, title,
                    requests, context_tokens, input_tokens, cached_tokens, output_tokens,
                    cache_samples, cache_hit_rate, last_seen, restored
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            // Reservoir sample: each session has equal chance regardless of activity
            const sampledSessions = reservoirSample(metrics.perSession, MAX_SESSIONS_PER_SNAPSHOT);
            
            const insertMany = db.transaction((sessions: typeof sampledSessions) => {
                for (const s of sessions) {
                    insertSession.run(
                        snapshotId,
                        s.id,
                        s.protocol,
                        s.upstreamOrigin,
                        s.label,
                        s.title,
                        s.requests,
                        s.contextTokens,
                        s.inputTokens,
                        s.cachedTokens,
                        s.outputTokens,
                        s.cacheSamples,
                        s.cacheHitRate,
                        s.lastSeen,
                        s.restored ? 1 : 0
                    );
                }
            });
            
            insertMany(sampledSessions);
        }

        // Insert provider metrics
        const byProvider = aggregateByProviderForStorage(metrics);
        if (byProvider.length > 0) {
            const insertProvider = db.prepare(`
                INSERT INTO provider_metrics (
                    snapshot_id, provider, sessions, requests, input_tokens,
                    cached_tokens, output_tokens, cache_hit_rate, compression_ratio
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            const insertMany = db.transaction((providers: typeof byProvider) => {
                for (const p of providers) {
                    insertProvider.run(
                        snapshotId,
                        p.provider,
                        p.sessions,
                        p.requests,
                        p.inputTokens,
                        p.cachedTokens,
                        p.outputTokens,
                        p.cacheHitRate,
                        p.compressionRatio
                    );
                }
            });
            
            insertMany(byProvider);
        }

        // Insert hourly activity buckets
        if (metrics.history.length > 0) {
            const insertHourly = db.prepare(`
                INSERT OR REPLACE INTO hourly_activity (
                    bucket_timestamp, total_tokens, total_sessions, total_requests
                ) VALUES (?, ?, ?, ?)
            `);
            
            const insertMany = db.transaction((buckets: typeof metrics.history) => {
                for (const b of buckets) {
                    insertHourly.run(
                        b.timestamp,
                        b.tokens,
                        b.sessions,
                        b.requests
                    );
                }
            });
            
            insertMany(metrics.history);
        }

        // Cleanup old data (keep 90 days)
        cleanupOldData(timestamp);
        
    } catch (error) {
        log("error", `[analytics] failed to record snapshot: ${String(error)}`);
    }
}

/**
 * Aggregate metrics by provider for storage.
 */
function aggregateByProviderForStorage(metrics: AggregatedMetrics): Array<{
    provider: string;
    sessions: number;
    requests: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheHitRate: number;
    compressionRatio: number;
}> {
    const byProvider = new Map<string, {
        provider: string;
        sessions: number;
        requests: number;
        inputTokens: number;
        cachedTokens: number;
        outputTokens: number;
        cacheHitRate: number;
        compressionRatio: number;
    }>();

    for (const s of metrics.perSession) {
        const key = s.upstreamOrigin;
        const existing = byProvider.get(key) || {
            provider: key,
            sessions: 0,
            requests: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheHitRate: 0,
            compressionRatio: 0,
        };

        existing.sessions += 1;
        existing.requests += s.requests;
        existing.inputTokens += s.inputTokens;
        existing.cachedTokens += s.cachedTokens;
        existing.outputTokens += s.outputTokens;
        existing.cacheHitRate = existing.inputTokens > 0
            ? existing.cachedTokens / existing.inputTokens
            : 0;
        existing.compressionRatio = existing.inputTokens > 0
            ? 1 - existing.outputTokens / existing.inputTokens
            : 0;

        byProvider.set(key, existing);
    }

    return [...byProvider.values()].sort((a, b) => b.requests - a.requests);
}

/**
 * Clean up data older than retention period.
 */
function cleanupOldData(currentTimestamp: number): void {
    if (!db) return;
    
    const retentionMs = 90 * 24 * 60 * 60 * 1000; // 90 days
    const cutoff = currentTimestamp - retentionMs;
    
    try {
        db.prepare("DELETE FROM snapshots WHERE timestamp < ?").run(cutoff);
        // session_history and provider_metrics cascade via foreign key if ON DELETE CASCADE,
        // but SQLite doesn't enforce by default, so clean explicitly:
        db.prepare(`
            DELETE FROM session_history 
            WHERE snapshot_id IN (SELECT id FROM snapshots WHERE timestamp < ?)
        `).run(cutoff);
        db.prepare(`
            DELETE FROM provider_metrics 
            WHERE snapshot_id IN (SELECT id FROM snapshots WHERE timestamp < ?)
        `).run(cutoff);
        db.prepare("DELETE FROM hourly_activity WHERE bucket_timestamp < ?").run(cutoff);
    } catch (error) {
        log("warn", `[analytics] cleanup failed: ${String(error)}`);
    }
}

/**
 * Get historical snapshots for a time range.
 */
export function getSnapshots(since: number, until: number = Date.now(), limit: number = 1000): any[] {
    if (!db || !initialized) return [];
    
    try {
        return db.prepare(`
            SELECT * FROM snapshots 
            WHERE timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC
            LIMIT ?
        `).all(since, until, limit);
    } catch (error) {
        log("error", `[analytics] getSnapshots failed: ${String(error)}`);
        return [];
    }
}

/**
 * Get hourly activity for charting.
 */
export function getHourlyActivity(since: number, until: number = Date.now()): TimeBucket[] {
    if (!db || !initialized) return [];
    
    try {
        return db.prepare(`
            SELECT bucket_timestamp as timestamp, total_tokens as tokens, 
                   total_sessions as sessions, total_requests as requests
            FROM hourly_activity 
            WHERE bucket_timestamp BETWEEN ? AND ?
            ORDER BY bucket_timestamp ASC
        `).all(since, until);
    } catch (error) {
        log("error", `[analytics] getHourlyActivity failed: ${String(error)}`);
        return [];
    }
}

/**
 * Get provider comparison over time.
 */
export function getProviderTrends(provider: string, since: number, until: number = Date.now()): any[] {
    if (!db || !initialized) return [];
    
    try {
        return db.prepare(`
            SELECT s.timestamp, pm.requests, pm.input_tokens, pm.cached_tokens,
                   pm.output_tokens, pm.cache_hit_rate, pm.compression_ratio
            FROM provider_metrics pm
            JOIN snapshots s ON pm.snapshot_id = s.id
            WHERE pm.provider = ? AND s.timestamp BETWEEN ? AND ?
            ORDER BY s.timestamp ASC
        `).all(provider, since, until);
    } catch (error) {
        log("error", `[analytics] getProviderTrends failed: ${String(error)}`);
        return [];
    }
}

/**
 * Close the database connection.
 */
export function closeAnalytics(): void {
    if (db) {
        try {
            db.close();
            initialized = false;
            log("info", `[analytics] closed`);
        } catch (error) {
            log("error", `[analytics] close failed: ${String(error)}`);
        }
    }
}

/**
 * Check if analytics is available (better-sqlite3 installed and initialized).
 */
export function isAnalyticsEnabled(): boolean {
    return initialized && db !== null;
}

/**
 * Periodic snapshot task - call this from a timer to record metrics regularly.
 */
export async function snapshotTask(): Promise<void> {
    if (!isAnalyticsEnabled()) return;
    
    try {
        const metrics = await collectMetrics();
        await recordSnapshot(metrics);
    } catch (error) {
        log("error", `[analytics] snapshot task failed: ${String(error)}`);
    }
}