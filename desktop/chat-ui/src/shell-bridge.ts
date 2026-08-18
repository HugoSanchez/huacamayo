import type { ShellAction, ShellCommand } from './shell-protocol';

export function hasNativeShell(): boolean {
  return window.__versoShellMode === 'native'
    || typeof window.webkit?.messageHandlers?.chatBridge?.postMessage === 'function';
}

/** Send every product-level UI action through the same host boundary. */
export function postShellAction(action: ShellAction): void {
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  if (bridge) {
    bridge.postMessage({ type: 'action', action });
    return;
  }
  window.dispatchEvent(new CustomEvent<ShellAction>('verso:shell-action', { detail: action }));
}

export function dispatchShellCommand(command: ShellCommand): void {
  window.dispatchEvent(new CustomEvent<ShellCommand>('verso:shell-command', { detail: command }));
}
