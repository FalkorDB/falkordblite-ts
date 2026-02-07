/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
  // Global signal handlers from cleanup.ts keep workers alive; force-exit is safe here.
  forceExit: true,
  // Strip .js extensions from NodeNext-style imports so ts-jest resolves .ts files.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      diagnostics: { ignoreCodes: [151002] },
    }],
  },
};
