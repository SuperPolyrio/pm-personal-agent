import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const defaults = parseEnv(readFileSync(new URL('../.env.example', import.meta.url), 'utf8'));

export function sourceSetting(name: string) {
  const value = process.env[name] ?? defaults[name];
  if (value === undefined) throw Error(`缺少数据源配置 ${name}。`);
  return value;
}
