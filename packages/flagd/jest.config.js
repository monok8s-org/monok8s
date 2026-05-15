// Per-package Jest config for packages/flagd unit tests.
//
// Uses testEnvironment: "node" — same posture as packages/trpc /
// packages/auth / packages/db. The flagd stub has no DOM
// dependencies; node-env sidesteps the jest-runtime resetModules
// path that the frontend-side route tests need.
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
  moduleFileExtensions: ["js", "jsx", "ts", "tsx"],
};
