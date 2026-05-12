import { useEffect, useState } from 'react';

// Tracks whether the host laptop is currently asleep (PowerNap / lid closed).
// The Swift shell dispatches `verso:system-sleep` and `verso:system-wake`
// custom events into the WKWebView via NSWorkspace's willSleep/didWake
// notifications. Components that own polling/animation intervals subscribe to
// this hook and skip work while asleep so the CPU can actually rest.
//
// Default-off: if the events never fire (browser dev mode, non-native shell),
// behavior is identical to before — the app stays "awake."
export function useIsSystemAsleep(): boolean {
  const [asleep, setAsleep] = useState(false);
  useEffect(() => {
    const onSleep = () => setAsleep(true);
    const onWake = () => setAsleep(false);
    window.addEventListener('verso:system-sleep', onSleep);
    window.addEventListener('verso:system-wake', onWake);
    return () => {
      window.removeEventListener('verso:system-sleep', onSleep);
      window.removeEventListener('verso:system-wake', onWake);
    };
  }, []);
  return asleep;
}
