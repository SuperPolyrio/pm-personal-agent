import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { marketDataPython } from './market-data.js';

const execute = promisify(execFile);
const runner = `import resource, sys, json
resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
resource.setrlimit(resource.RLIMIT_FSIZE, (1024**2, 1024**2))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
sys.path.insert(0, '/packages')
import pandas as pd
import numpy as np
results = json.load(open('/input/results.json'))
frames = [pd.DataFrame(r['data']['rows']) for r in results]
exec(compile(open('/input/analysis.py').read(), 'analysis.py', 'exec'))
`;

export async function analyzeResults(results: unknown[], code: string, signal?: AbortSignal) {
  const { stdout } = await execute(marketDataPython, ['-I', '-c',
    'import sys,sysconfig,json,importlib.util; print(json.dumps(dict(prefix=sys.base_prefix,version=f"{sys.version_info.major}.{sys.version_info.minor}",packages=str(__import__("pathlib").Path(importlib.util.find_spec("pandas").origin).parent.parent))))'],
  { signal, timeout: 5000 });
  const runtime = JSON.parse(stdout) as { prefix: string; version: string; packages: string };
  const directory = await mkdtemp(join(tmpdir(), 'pm-analysis-'));
  try {
    await writeFile(join(directory, 'results.json'), JSON.stringify(results), { mode: 0o600 });
    await writeFile(join(directory, 'analysis.py'), code, { mode: 0o600 });
    await writeFile(join(directory, 'runner.py'), runner, { mode: 0o600 });
    const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/usr/lib', '/usr/lib', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', join(runtime.prefix, 'bin', `python${runtime.version}`), '/runtime/bin/python',
      '--ro-bind', join(runtime.prefix, 'lib'), '/runtime/lib',
      '--tmpfs', `/runtime/lib/python${runtime.version}/site-packages`,
      '--dir', '/packages'];
    for (const name of ['numpy', 'numpy.libs', 'pandas', 'dateutil', 'pytz', 'six.py']) {
      args.push('--ro-bind', join(runtime.packages, name), `/packages/${name}`);
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', directory, '/input',
      '--chdir', '/tmp', '--clearenv', '--setenv', 'OPENBLAS_NUM_THREADS', '1', '--setenv', 'OMP_NUM_THREADS', '1',
      '--', '/runtime/bin/python', '-I', '/input/runner.py');
    try {
      const output = await execute('bwrap', args, { signal, timeout: 15_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' });
      return { status: 'complete', stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as { stdout?: string; stderr?: string; code?: string | number; killed?: boolean };
      return { status: 'failed', stdout: failure.stdout ?? '', stderr: failure.stderr ?? '',
        error: failure.killed ? 'Analysis exceeded its time/output limit.' : String(failure.code ?? error) };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function resultPreview(data: Record<string, unknown>, previewRows = 20, offset = 0) {
  const { rows, columns, kind, engine, rowCount, truncated, asOf, selection, timeWindows, freshness,
    inputTruncated, metricDefinitions, sourceRelations } = data;
  if (!Array.isArray(rows)) return data;
  const names = (columns as { name: string }[]).map(column => column.name);
  const preview: unknown[] = [];
  let size = 0;
  for (const row of rows.slice(offset, offset + previewRows)) {
    const values = names.map(name => row[name]);
    size += JSON.stringify(values).length;
    if (size > 6000) break;
    preview.push(values);
  }
  return { kind, engine, savedRowCount: rowCount, truncated, columns: names, rows: preview, returnedRows: preview.length, offset,
    nextOffset: preview.length && offset + preview.length < rows.length ? offset + preview.length : null,
    asOf, selection, timeWindows, freshness, inputTruncated, metricDefinitions,
    sourceRelations: (sourceRelations as Record<string, unknown>[] | undefined)?.map(({ name, rowCount, marketKeys, retrievedAt, executionPredicate }) =>
      ({ name, boundRows: rowCount, marketKeys, retrievedAt, scope: executionPredicate ?? 'catalog_sql selection' })),
    format: 'Rows are value arrays in columns order. savedRowCount counts saved SQL rows, not all matching markets; selection.limit may restrict them even when truncated=false. Full saved rows remain objects for SQL/Python. Read nextOffset if needed; metadata view includes full SQL and provenance.' };
}
