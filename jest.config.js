/**
 * Unit tests. Hermetic: no network, no API keys, no ffmpeg. Anything that needs
 * those belongs behind a manual command, not in the gate that runs on save.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Transpile only; full type checking is the separate `npm run typecheck` gate.
  transform: { '^.+\.ts$': ['ts-jest', { diagnostics: false }] },
  clearMocks: true,
};
