/** Reviewed 20 Nov 2026 sources. Observations only: these are never fill prices. */
export const AVT_V2 = 'adaptive-volatility-trend-v2-native';
export const KALMAN_V1 = 'kalman-supertrend-sentinel-v1-native';
export const BAR_BALANCE_V1 = 'bar-size-balance-exit-v1-native';
export const upstreamLifecycle = (id: string | undefined) =>
  id === AVT_V2 || id === KALMAN_V1 || id === BAR_BALANCE_V1;

const plot = (name: string, expression: string) =>
  `plot(${expression}, title="VNEDGE lifecycle v1 ${name}", display=display.none)`;
const willyExports = (trail = false) => [
  plot('entry', 'evLongEntry ? 1 : evShortEntry ? -1 : 0'),
  plot('stop', 'nz(activeSL, 0)'),
  ...[1, 2, 3].map(n => plot(`tp${n}`, `nz(activeTP${n}, 0)`)),
  plot('exitSide', 'evReversal ? revDir : exitDir'),
  plot('close', 'evSlHit ? (exitBeActive ? 2 : 1) : evTp3Hit ? 3 : evReversal ? 4 : 0'),
  plot('hit1', 'evTp1Hit ? 1 : 0'),
  plot('hit2', 'evTp2Hit ? 1 : 0'),
  plot('amend', trail ? 'evTrailMove ? nz(activeSL, 0) : beJustActivated ? nz(exitEntry, 0) : 0' : 'beJustActivated ? nz(exitEntry, 0) : 0'),
];
export const upstreamSources: Record<string, {hash: string; exports: string[]}> = {
  [AVT_V2]: {
    hash: 'd7364c057ff6af3ed078bcc9af5074513fd33d708613d0b169acd6f7f71109de',
    exports: willyExports(),
  },
  [KALMAN_V1]: {
    hash: '29529c621a46d50bea65ff167dbe621cda150b9f9bba2ec4749815fe88fe0394',
    exports: willyExports(true),
  },
  [BAR_BALANCE_V1]: {
    hash: '1322681bf7d6e469a90c8e8777dea063c894f620a0638a976a67aae896e316d3',
    exports: [
      plot('entry', '_newLong ? 1 : _newShort ? -1 : 0'),
      plot('stop', 'nz(slPrice, 0)'),
      ...[1, 2, 3].map(n => plot(`tp${n}`, `nz(tp${n}Price, 0)`)),
      plot('exitSide', '_hasTrade ? (_isLong ? 1 : -1) : 0'),
      plot('close', '_slEvt ? 1 : _tp3Evt ? 3 : _revClose ? 4 : _exitEvt ? 5 : 0'),
      plot('hit1', '_tp1Evt ? 1 : 0'),
      plot('hit2', '_tp2Evt ? 1 : 0'),
      plot('amend', '0'),
    ],
  },
};
