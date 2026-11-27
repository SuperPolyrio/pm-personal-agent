import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export const marketDataRoot = resolve(process.env.MARKET_DATA_ROOT || fileURLToPath(new URL('../../market-data', import.meta.url)));
export const marketDataPython = process.env.MARKET_DATA_PYTHON || resolve(marketDataRoot, '.venv/bin/python');
export async function researchEngine(operation: 'discover' | 'describe' | 'query' | 'resolve' | 'trade_projection', args: Record<string, unknown>, signal?: AbortSignal) {
  // No collector credentials: research.py loads its dedicated read-only config.
  const task = execute(marketDataPython, ['-m', 'market_data.research', operation], {
    cwd: marketDataRoot, env: { PATH: process.env.PATH, HOME: homedir(),
      MARKET_DATA_QUERY_CONFIG: process.env.MARKET_DATA_QUERY_CONFIG || resolve(homedir(), '.config/polydata/research-readonly.json') },
    signal, timeout: 45_000, maxBuffer: 12 * 1024 * 1024,
  });
  task.child.stdin!.end(JSON.stringify(args));
  let stdout: string;
  try { ({ stdout } = await task); }
  catch (error) {
    const failure = error as { stdout?: string; killed?: boolean; signal?: string };
    if (failure.killed && failure.signal === 'SIGTERM' && !signal?.aborted) throw new Error('市场数据查询超时');
    const result = failure.stdout;
    if (result) throw new Error(result.trim());
    throw error;
  }
  return JSON.parse(stdout) as { source: string; retrievedAt: string; data: Record<string, unknown> };
}
