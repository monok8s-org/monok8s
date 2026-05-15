// Per-package Jest config for packages/db unit tests.
//
// Uses testEnvironment: "node" instead of the root config's "jsdom" —
// packages/db has no DOM dependencies, and jsdom's setup triggers a
// jest-runtime resetModules path that has an internal API mismatch
// with jest-mock at the current pin (`_moduleMocker.clearMocksOnScope
// is not a function`). Switching to node env bypasses that codepath.
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.[jt]sx?$": [
      "babel-jest",
      {
        configFile: false,
        babelrc: false,
        presets: [
          ["@babel/preset-env", { targets: { node: "current" } }],
          "@babel/preset-typescript",
        ],
      },
    ],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
};
