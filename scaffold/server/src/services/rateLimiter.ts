import { getRedis } from '../redis.js';

const BUCKET_CAPACITY = 8;
const REFILL_RATE_PER_SEC = 4;

// Atomic token bucket + 429 Retry-After gate in Redis.
// Returns [allowed (1|0), waitMs].
const ACQUIRE_LUA = `
local bucketKey = KEYS[1]
local blockedKey = KEYS[2]
local nowMs = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerSec = tonumber(ARGV[3])

local blockedUntil = tonumber(redis.call('GET', blockedKey) or '0')
if blockedUntil > nowMs then
  return {0, blockedUntil - nowMs}
end

local data = redis.call('HMGET', bucketKey, 'tokens', 'lastRefillMs')
local tokens = tonumber(data[1])
local lastRefillMs = tonumber(data[2])

if tokens == nil or lastRefillMs == nil then
  tokens = capacity
  lastRefillMs = nowMs
else
  local elapsedMs = math.max(0, nowMs - lastRefillMs)
  tokens = math.min(capacity, tokens + (elapsedMs / 1000.0) * refillPerSec)
  lastRefillMs = nowMs
end

if tokens >= 1.0 then
  tokens = tokens - 1.0
  redis.call('HSET', bucketKey, 'tokens', tostring(tokens), 'lastRefillMs', tostring(lastRefillMs))
  redis.call('PEXPIRE', bucketKey, 60000)
  return {1, 0}
end

redis.call('HSET', bucketKey, 'tokens', tostring(tokens), 'lastRefillMs', tostring(lastRefillMs))
redis.call('PEXPIRE', bucketKey, 60000)
local waitMs = math.ceil(((1.0 - tokens) / refillPerSec) * 1000.0)
return {0, math.max(50, waitMs)}
`;

const BLOCK_LUA = `
local blockedKey = KEYS[1]
local untilMs = tonumber(ARGV[1])
local ttlMs = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', blockedKey) or '0')
if untilMs > current then
  redis.call('SET', blockedKey, tostring(untilMs), 'PX', ttlMs)
end
return 1
`;

export interface RateLimitResult {
  allowed: boolean;
  waitMs: number;
}

export async function acquireWorkspaceSendToken(
  workspace: string,
  nowMs = Date.now()
): Promise<RateLimitResult> {
  const redis = getRedis();
  const bucketKey = `ratelimit:bucket:${workspace}`;
  const blockedKey = `ratelimit:blocked_until:${workspace}`;

  const res = (await redis.eval(
    ACQUIRE_LUA,
    2,
    bucketKey,
    blockedKey,
    String(nowMs),
    String(BUCKET_CAPACITY),
    String(REFILL_RATE_PER_SEC)
  )) as [number, number];

  return {
    allowed: res[0] === 1,
    waitMs: Number(res[1]) || 0,
  };
}

export async function markWorkspaceRateLimited(
  workspace: string,
  retryAfterSeconds: number,
  nowMs = Date.now()
): Promise<void> {
  const redis = getRedis();
  const blockedKey = `ratelimit:blocked_until:${workspace}`;
  const waitMs = Math.max(250, Math.ceil(retryAfterSeconds * 1000) + 50);
  const untilMs = nowMs + waitMs;
  await redis.eval(BLOCK_LUA, 1, blockedKey, String(untilMs), String(waitMs + 5000));
}
