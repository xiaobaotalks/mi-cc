/**
 * CLI - REPL 交互界面
 * 处理用户输入、斜杠命令补全、优雅退出
 */

import * as readline from 'readline';
import { appState } from './state';
import { handleSlashCommand, SLASH_COMMANDS, setReplReadline } from '../commands';
import type { SlashContext } from '../commands';
import { renderError, renderCommandHint } from './ui';
import { setCommandAuthorizer } from '../tools';
import type { AuthorizeResult } from '../tools';

export interface CLIOptions {
  onUserInput: (input: string) => Promise<void>;
  slashCtx: SlashContext;
}

/** 启动 CLI REPL 循环 */
export async function startCLI(options: CLIOptions): Promise<void> {
  const { onUserInput, slashCtx } = options;

  /** Readline 补全函数：仅当输入以 / 开头时补全命令；其他情况不补全 */
  const completer = (line: string): [string[], string] => {
    if (!line.startsWith('/')) return [[], line];
    const parts = line.split(/\s+/);
    if (parts.length === 1) {
      // 补全主命令
      const hits = SLASH_COMMANDS
        .filter(c => c.name.startsWith(line))
        .map(c => c.name);
      return [hits, line];
    }
    // 补全子参数
    const cmdName = parts[0];
    const cmd = SLASH_COMMANDS.find(c => c.name === cmdName);
    if (!cmd || !cmd.subArgs) return [[], line];
    const argPrefix = parts[parts.length - 1];
    const hits = cmd.subArgs.filter(s => s.startsWith(argPrefix));
    return [hits, argPrefix];
  };

  /** 渲染斜杠命令提示（用户输入 / 后回车显示） */
  const showSlashHint = (): void => {
    console.log('\n可用斜杠命令:');
    for (const c of SLASH_COMMANDS) {
      const sub = c.subArgs ? ` ${c.subArgs.join(' | ')}` : '';
      console.log(`  ${c.name.padEnd(12)} ${c.description}${sub}`);
    }
    renderCommandHint();
    console.log();
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n> ',
    completer,
  });

  // 将 REPL 的 readline 注册到 commands 模块，供交互式向导复用
  setReplReadline(rl);

  // 设置命令授权器：非白名单命令执行前交互式询问用户
  setCommandAuthorizer(async (command: string, reason: string): Promise<AuthorizeResult> => {
    return new Promise((resolve) => {
      // 暂停 REPL prompt，避免提示符干扰
      rl.setPrompt('');
      rl.prompt();
      rl.setPrompt('\n> ');
      console.log(`\n⚠ ${reason}`);
      console.log(`  命令: ${command}`);
      console.log(`  选项: [y] 本次允许  [a] 永久允许  [n] 拒绝 (默认)`);
      const ask = () => {
        rl.question('授权? (y/a/n): ', (answer) => {
          const a = answer.trim().toLowerCase();
          if (a === 'y' || a === 'yes') resolve('yes');
          else if (a === 'a' || a === 'always') resolve('always');
          else resolve('no');
        });
      };
      ask();
    });
  });

  rl.prompt();

  rl.on('line', async (input) => {
    const trimmed = input.trim();

    if (!trimmed) {
      rl.prompt();
      return;
    }

    if (trimmed === '/') {
      // 只输入 / 时显示可用命令提示
      showSlashHint();
      rl.prompt();
      return;
    }

    if (trimmed.startsWith('/')) {
      // 交互式向导会复用 rl，无需 pause/resume
      await handleSlashCommand(slashCtx, trimmed);
      // 检查是否有斜杠命令设置的待发送消息（如 /image <path> <text>）
      const pendingMsg = appState.get('pendingMessage');
      if (pendingMsg) {
        appState.set('pendingMessage', null);
        try {
          await onUserInput(pendingMsg);
        } catch (error) {
          renderError(String(error));
        }
      }
      rl.prompt();
      return;
    }

    try {
      await onUserInput(trimmed);
    } catch (error) {
      renderError(String(error));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n再见！');
    process.exit(0);
  });

  // Ctrl+C 优雅退出：第一次提示，第二次强制退出
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount >= 2) {
      console.log('\n强制退出');
      process.exit(1);
    }
    console.log('\n按 Ctrl+C 再次退出，或继续输入');
    rl.prompt();
  });
}
