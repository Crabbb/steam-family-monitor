import { createDefaultPreset } from "ts-jest";

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} */
const config = {
  testEnvironment: "node",
  transform: {
    ...tsJestTransformCfg,
  },
  globalSetup: "<rootDir>/jest.global-setup.mjs",
  setupFiles: ["<rootDir>/jest.setup.mjs"],
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
};

export default config;
