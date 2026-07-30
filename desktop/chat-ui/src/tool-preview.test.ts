import { test, expect, describe } from 'bun:test';
import {
  shortenPaths,
  cleanShellCommand,
  summarizeShellCommand,
  shellCommandOf,
  previewInput,
  toolStepPreview,
} from './tool-preview';

describe('shortenPaths', () => {
  test('collapses a deep absolute path to its last two segments', () => {
    expect(shortenPaths('/home/agent/github/HugoSanchez/centaur/tools/productivity/memory')).toBe(
      '…/productivity/memory',
    );
  });

  test('keeps a file name on the tail', () => {
    expect(
      shortenPaths('/home/agent/github/HugoSanchez/centaur/tools/productivity/memory/README.md'),
    ).toBe('…/memory/README.md');
  });

  test('leaves shallow paths (two or fewer segments) untouched', () => {
    expect(shortenPaths('/tmp/foo')).toBe('/tmp/foo');
    expect(shortenPaths('/etc')).toBe('/etc');
  });

  test('shortens ~-rooted paths', () => {
    expect(shortenPaths('~/projects/centaur/tools/memory')).toBe('…/tools/memory');
  });

  test('shortens paths embedded in a larger string', () => {
    expect(shortenPaths('cat /home/agent/github/HugoSanchez/centaur/README.md now')).toBe(
      'cat …/centaur/README.md now',
    );
  });

  test('leaves plain prose without paths unchanged', () => {
    expect(shortenPaths('checking your memory tool')).toBe('checking your memory tool');
  });
});

describe('cleanShellCommand', () => {
  test('unwraps bash -lc', () => {
    expect(cleanShellCommand(`/bin/bash -lc 'ls -la /tmp'`)).toBe('ls -la /tmp');
  });

  test('strips 2>/dev/null noise', () => {
    expect(cleanShellCommand('which memory 2>/dev/null')).toBe('which memory');
  });

  test('strips >/dev/null and 2>&1', () => {
    expect(cleanShellCommand('run thing >/dev/null 2>&1')).toBe('run thing');
  });

  test('collapses whitespace and shortens paths in a compound command', () => {
    expect(
      cleanShellCommand(
        'which memory 2>/dev/null; echo "---"; ls -la /home/agent/github/HugoSanchez/centaur/tools/productivity/memory',
      ),
    ).toBe('which memory; echo "---"; ls -la …/productivity/memory');
  });

  test('truncates very long commands', () => {
    const long = `echo ${'x'.repeat(300)}`;
    const out = cleanShellCommand(long);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('summarizeShellCommand', () => {
  test('friendly phrasing for a simple read', () => {
    expect(summarizeShellCommand('cat /home/agent/github/HugoSanchez/centaur/tools/memory/README.md')).toBe(
      'Reading …/memory/README.md',
    );
  });

  test('friendly phrasing for which', () => {
    expect(summarizeShellCommand('which memory 2>/dev/null')).toBe('Checking memory');
  });

  test('ls with a target', () => {
    expect(summarizeShellCommand('ls -la /tmp/reports')).toBe('Listing /tmp/reports');
  });

  test('bare ls', () => {
    expect(summarizeShellCommand('ls -la')).toBe('Listing files');
  });

  test('find is summarized generically', () => {
    expect(summarizeShellCommand('find . -name "*.py"')).toBe('Searching for files');
  });

  test('compound commands are NOT summarized (falls back to cleaned command)', () => {
    const cmd = 'which memory 2>/dev/null; echo hi';
    expect(summarizeShellCommand(cmd)).toBe('which memory; echo hi');
  });

  test('piped commands are not summarized', () => {
    expect(summarizeShellCommand('cat foo.txt | grep bar')).toBe('cat foo.txt | grep bar');
  });
});

describe('shellCommandOf', () => {
  test('extracts command from an object input', () => {
    expect(shellCommandOf({ name: 'Shell', input: { command: 'ls -la' } })).toBe('ls -la');
  });

  test('joins an argv-array command, unwrapping bash -lc', () => {
    expect(shellCommandOf({ name: 'shell', input: { command: ['bash', '-lc', 'echo hi'] } })).toBe(
      'echo hi',
    );
  });

  test('treats a string input as a command only for shell-named tools', () => {
    expect(shellCommandOf({ name: 'bash', input: 'ls -la' })).toBe('ls -la');
    expect(shellCommandOf({ name: 'search_web', input: 'ls -la' })).toBeNull();
  });

  test('strips namespaced shell tool names', () => {
    expect(shellCommandOf({ name: 'mcp__local__shell', input: 'pwd' })).toBe('pwd');
  });

  test('returns null when there is no command', () => {
    expect(shellCommandOf({ name: 'read_file', input: { path: '/tmp/x' } })).toBeNull();
  });
});

describe('toolStepPreview', () => {
  test('shell step gets a friendly, path-shortened summary', () => {
    const step = {
      name: 'Shell',
      input: { command: 'cat /home/agent/github/HugoSanchez/centaur/tools/memory/README.md' },
    };
    expect(toolStepPreview(step)).toBe('Reading …/memory/README.md');
  });

  test('non-shell step falls back to path-shortened input preview', () => {
    const step = {
      name: 'read_file',
      input: { file_path: '/home/agent/github/HugoSanchez/centaur/tools/memory/cli.py' },
    };
    expect(toolStepPreview(step)).toBe('…/memory/cli.py');
  });

  test('matches the noisy compound command from the screenshot', () => {
    const step = {
      name: 'Shell',
      input: {
        command:
          'which memory 2>/dev/null; echo "---"; ls -la /home/agent/github/HugoSanchez/centaur/tools/productivity/memory',
      },
    };
    expect(toolStepPreview(step)).toBe('which memory; echo "---"; ls -la …/productivity/memory');
  });
});

describe('previewInput (regression — behavior preserved from MessageList)', () => {
  test('string passthrough', () => {
    expect(previewInput('hello')).toBe('hello');
  });

  test('prefers known keys', () => {
    expect(previewInput({ query: 'search me', extra: 'ignored' })).toBe('search me');
  });

  test('array count', () => {
    expect(previewInput([1, 2, 3])).toBe('3 items');
  });

  test('null/undefined', () => {
    expect(previewInput(null)).toBe('');
    expect(previewInput(undefined)).toBe('');
  });
});
