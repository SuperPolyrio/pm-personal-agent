import { execFileSync } from 'node:child_process';

if (process.argv[2] === 'warmup') {
  const { PM_MODEL, PM_MODEL_URL, PM_MODEL_CONTEXT, PM_MODEL_WARMUP_URL, PM_MODEL_WARMUP_NAME,
    PM_MODEL_WARMUP_EXECUTABLE, PM_MODEL_WARMUP_PROFILE } = process.env;
  if (PM_MODEL_WARMUP_EXECUTABLE && PM_MODEL_WARMUP_PROFILE &&
      PM_MODEL_URL === PM_MODEL_WARMUP_URL && PM_MODEL === PM_MODEL_WARMUP_NAME) {
    const response = await fetch(PM_MODEL_URL + '/models', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('Model gateway HTTP ' + response.status);
    const models = await response.json();
    if (!models.data.some(item => item.id === PM_MODEL)) {
      execFileSync(PM_MODEL_WARMUP_EXECUTABLE,
        ['load', PM_MODEL_WARMUP_PROFILE, '--ctx', PM_MODEL_CONTEXT || '32768', '--idle-min', '0', '--wait'],
        { stdio: 'inherit' });
    }
  }
} else {
  const env = { ...process.env };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (env['PM_' + name] !== undefined) env[name] = env['PM_' + name];
  }
  process.execve(process.execPath, [process.execPath, '--use-env-proxy', 'dist/main.js', 'telegram'], env);
}
