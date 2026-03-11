import { exec } from "child_process";
import os from "os";

/**
 * PM2 오토스케일러
 *
 * 동작 원리:
 * 1. /api/metrics + pm2 jlist를 주기적으로 폴링
 * 2. 크래시된 인스턴스가 있으면 즉시 개별 restart (쿨다운 무시)
 * 3. CPU 부하, RPM, 응답시간을 기반으로 인스턴스 수를 MIN~MAX 범위에서 증감
 *
 * 스케일 업 (하나라도 해당): loadAvg > 70%, RPM/inst > 200, avgRt > 2000ms
 * 스케일 다운 (모두 해당):   loadAvg < 30%, RPM/inst < 50,  avgRt < 500ms
 */

const APP_NAME = process.env.PM2_APP_NAME || "toeic-api";
const API_URL = process.env.METRICS_URL || "http://127.0.0.1:4000/api/metrics";
const POLL_INTERVAL = Number(process.env.SCALE_POLL_MS) || 15_000;
const COOLDOWN_MS = Number(process.env.SCALE_COOLDOWN_MS) || 60_000;

const CPU_COUNT = os.cpus().length;
const MIN_INSTANCES = Math.max(Number(process.env.SCALE_MIN) || 2, 1);
const MAX_INSTANCES = Math.min(Number(process.env.SCALE_MAX) || CPU_COUNT, CPU_COUNT);

const SCALE_UP_LOAD_FACTOR = 0.7;
const SCALE_DOWN_LOAD_FACTOR = 0.3;
const RPM_PER_INSTANCE_UP = 200;
const RPM_PER_INSTANCE_DOWN = 50;
const RESPONSE_TIME_UP_MS = 2000;
const RESPONSE_TIME_DOWN_MS = 500;

let lastScaleTime = 0;

interface InstanceInfo {
  total: number;
  online: number;
  stoppedIds: number[];
}

interface MetricsResponse {
  cpuCount: number;
  loadAvg: { "1m": number; "5m": number };
  memory: { totalMB: number; freeMB: number; processRSS_MB: number };
  requests: {
    rpm: number;
    activeConnections: number;
    avgResponseTimeMs: number;
  };
  ai: { pendingQueue: number };
}

function execCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

async function pm2GetInstanceInfo(): Promise<InstanceInfo> {
  try {
    const stdout = await execCmd("pm2 jlist");
    const list = JSON.parse(stdout) as any[];
    const procs = list.filter((p) => p.name === APP_NAME);
    const online = procs.filter((p) => p.pm2_env?.status === "online");
    const stopped = procs.filter((p) => p.pm2_env?.status !== "online");
    return {
      total: procs.length,
      online: online.length,
      stoppedIds: stopped.map((p) => p.pm_id),
    };
  } catch {
    return { total: 0, online: 0, stoppedIds: [] };
  }
}

async function pm2Scale(count: number): Promise<boolean> {
  try {
    const stdout = await execCmd(`pm2 scale ${APP_NAME} ${count}`);
    console.log(`[autoscaler] pm2 scale → ${count}:`, stdout.trim());
    return true;
  } catch (err: any) {
    const msg = err.message || "";
    if (msg.includes("Nothing to do")) return true;
    console.error("[autoscaler] pm2 scale failed:", msg);
    return false;
  }
}

async function pm2RestartById(id: number): Promise<boolean> {
  try {
    await execCmd(`pm2 restart ${id}`);
    return true;
  } catch (err: any) {
    console.warn(`[autoscaler] restart #${id} failed:`, err.message?.trim());
    return false;
  }
}

async function fetchMetrics(): Promise<MetricsResponse | null> {
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(API_URL, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as MetricsResponse;
  } catch {
    return null;
  }
}

function decideTarget(m: MetricsResponse, onlineCount: number): number {
  const loadPerCore = m.loadAvg["1m"] / CPU_COUNT;
  const rpmPerInstance = onlineCount > 0 ? m.requests.rpm / onlineCount : m.requests.rpm;
  const avgRt = m.requests.avgResponseTimeMs;

  const shouldScaleUp =
    loadPerCore > SCALE_UP_LOAD_FACTOR ||
    rpmPerInstance > RPM_PER_INSTANCE_UP ||
    avgRt > RESPONSE_TIME_UP_MS;

  const shouldScaleDown =
    loadPerCore < SCALE_DOWN_LOAD_FACTOR &&
    rpmPerInstance < RPM_PER_INSTANCE_DOWN &&
    avgRt < RESPONSE_TIME_DOWN_MS;

  let target = onlineCount;

  if (shouldScaleUp) {
    const byLoad = Math.ceil(m.loadAvg["1m"] / SCALE_UP_LOAD_FACTOR);
    const byRpm = Math.ceil(m.requests.rpm / RPM_PER_INSTANCE_UP);
    target = Math.max(byLoad, byRpm, onlineCount + 1);
  } else if (shouldScaleDown && onlineCount > MIN_INSTANCES) {
    target = onlineCount - 1;
  }

  return Math.max(MIN_INSTANCES, Math.min(MAX_INSTANCES, target));
}

async function tick() {
  const now = Date.now();
  const info = await pm2GetInstanceInfo();

  // ── 1단계: 크래시된 인스턴스 복구 (쿨다운 무시) ──
  if (info.stoppedIds.length > 0) {
    console.log(
      `[autoscaler] ${info.stoppedIds.length} stopped (online ${info.online}/${info.total}), restarting...`
    );
    let revived = 0;
    for (const id of info.stoppedIds) {
      if (await pm2RestartById(id)) revived++;
    }
    if (revived > 0) {
      console.log(`[autoscaler] revived ${revived} instances, waiting for next tick`);
    }
    return;
  }

  // ── 2단계: 스케일링 판단 (쿨다운 적용) ──
  if (now - lastScaleTime < COOLDOWN_MS) return;

  const metrics = await fetchMetrics();
  if (!metrics) {
    console.warn("[autoscaler] metrics unavailable, skipping");
    return;
  }

  const target = decideTarget(metrics, info.online);

  const loadPct = ((metrics.loadAvg["1m"] / CPU_COUNT) * 100).toFixed(1);
  console.log(
    `[autoscaler] online=${info.online}/${info.total} target=${target} ` +
    `load=${loadPct}% rpm=${metrics.requests.rpm} ` +
    `avgRt=${metrics.requests.avgResponseTimeMs}ms ` +
    `active=${metrics.requests.activeConnections} aiQueue=${metrics.ai.pendingQueue}`
  );

  if (target !== info.total) {
    const dir = target > info.total ? "UP" : "DOWN";
    console.log(`[autoscaler] SCALE ${dir}: ${info.total} → ${target}`);
    if (await pm2Scale(target)) {
      lastScaleTime = now;
    }
  }
}

console.log(
  `[autoscaler] started — app=${APP_NAME} min=${MIN_INSTANCES} max=${MAX_INSTANCES} ` +
  `cpus=${CPU_COUNT} poll=${POLL_INTERVAL}ms cooldown=${COOLDOWN_MS}ms`
);
console.log(`[autoscaler] metrics endpoint: ${API_URL}`);

setInterval(tick, POLL_INTERVAL);
tick();
