import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

// ========== Schema 定义 ==========

/** 已知的 API Key 占位符（不应被当作有效 Key） */
export const API_KEY_PLACEHOLDERS = new Set([
  'your_api_key_here', 'xxx', 'test', 'demo', 'placeholder',
  'lp', 'key', 'api_key', 'sk-xxx', 'sk-test',
]);

/** 检查 API Key 是否为占位符或过短 */
export function isPlaceholderApiKey(key: string): boolean {
  if (!key) return true;
  if (key.length < 16) return true;
  if (API_KEY_PLACEHOLDERS.has(key.toLowerCase())) return true;
  return false;
}

const ProviderSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().url().or(z.literal('')),
  model: z.string().min(1),
  name: z.string().optional(),
});

const ConfigSchema = z.object({
  apiKey: z.string().min(1, 'API Key 不能为空'),
  baseUrl: z.string().default('https://token-plan-cn.xiaomimimo.com/v1'),
  model: z.string().default('mimo-v2.5-pro'),
  maxTokens: z.coerce.number().int().positive().default(8000),
  // 多 Provider 配置（从 API_KEY_N 等读取）
  providers: z.array(ProviderSchema).optional(),
});

// ========== 从 .env 读取配置 ==========

function loadEnvFile(): Record<string, string | undefined> {
  const envPath = findEnvPath(process.cwd());
  if (envPath) {
    dotenv.config({ path: envPath });
    console.log(`[配置] 加载 ${envPath}`);
  }
  return process.env as Record<string, string | undefined>;
}

function findEnvPath(startDir: string): string | null {
  let envPath = startDir;
  for (let i = 0; i < 5; i++) {
    const testPath = path.join(envPath, '.env');
    if (fs.existsSync(testPath)) return testPath;
    const parent = path.dirname(envPath);
    if (parent === envPath) break;
    envPath = parent;
  }
  return null;
}

// ========== 四层配置合并 ==========

export interface ConfigResult {
  config: z.infer<typeof ConfigSchema>;
  warnings: string[];
}

/**
 * 加载并校验配置
 * 优先级：默认值 < .env < 环境变量 < CLI 参数（通过 options 传入）
 */
export function loadConfig(options?: Partial<{
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}>): ConfigResult {
  const warnings: string[] = [];
  const env = loadEnvFile();

  // 1. 默认值
  let apiKey = '';
  let baseUrl = 'https://token-plan-cn.xiaomimimo.com/v1';
  let model = 'mimo-v2.5-pro';
  let maxTokens: number | undefined;

  // 2. .env 文件（如果存在）
  if (env.API_KEY) apiKey = env.API_KEY;
  if (env.BASE_URL) baseUrl = env.BASE_URL;
  if (env.MODEL) model = env.MODEL;
  if (env.MAX_TOKEN) maxTokens = parseInt(env.MAX_TOKEN, 10);

  // 3. 环境变量（覆盖 .env）
  if (process.env.API_KEY) apiKey = process.env.API_KEY;
  if (process.env.BASE_URL) baseUrl = process.env.BASE_URL;
  if (process.env.MODEL) model = process.env.MODEL;

  // 4. CLI 参数（最高优先级）
  if (options?.apiKey) apiKey = options.apiKey;
  if (options?.baseUrl) baseUrl = options.baseUrl;
  if (options?.model) model = options.model;
  if (options?.maxTokens) maxTokens = options.maxTokens;

  // 5. 读取备用 Provider
  const providers: z.infer<typeof ProviderSchema>[] = [];
  for (let i = 1; i <= 5; i++) {
    const key = process.env[`API_KEY_${i}`];
    if (key) {
      providers.push({
        apiKey: key,
        baseUrl: process.env[`BASE_URL_${i}`] || '',
        model: process.env[`MODEL_${i}`] || '',
        name: process.env[`PROVIDER_NAME_${i}`],
      });
    }
  }

  // 6. Zod 校验
  const result = ConfigSchema.safeParse({
    apiKey,
    baseUrl,
    model,
    maxTokens,
    providers: providers.length > 0 ? providers : undefined,
  });

  if (!result.success) {
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`配置校验失败: ${errors}`);
  }

  // 7. 检查未知配置项
  const knownKeys = ['API_KEY', 'BASE_URL', 'MODEL', 'MAX_TOKEN',
    ...Array.from({ length: 5 }, (_, i) => `API_KEY_${i+1}`),
    ...Array.from({ length: 5 }, (_, i) => `BASE_URL_${i+1}`),
    ...Array.from({ length: 5 }, (_, i) => `MODEL_${i+1}`),
    ...Array.from({ length: 5 }, (_, i) => `PROVIDER_NAME_${i+1}`),
  ];
  for (const key of Object.keys(env)) {
    if (key.startsWith('MI_CC_') && !knownKeys.includes(key)) {
      warnings.push(`未知配置项: ${key}，将被忽略`);
    }
  }

  return { config: result.data, warnings };
}
