export const biliEnv = {
    get maxSessionsPerSnapshot(): number {
        const v = Number(process.env.BILI_MAX_SESSIONS_PER_SNAPSHOT);
        return Number.isFinite(v) && v > 0 ? v : 50;
    },
    get metricsCacheTtlMs(): number {
        const v = Number(process.env.BILI_METRICS_CACHE_TTL_MS);
        return Number.isFinite(v) && v > 0 ? v : 5000;
    },
    get historyMaxHours(): number {
        const v = Number(process.env.BILI_HISTORY_MAX_HOURS);
        return Number.isFinite(v) && v > 0 ? v : 24;
    },
};