// Per-package Jest config for apps/api unit tests. Mirrors
// packages/auth/jest.config.js — same testEnvironment fix for the
// jest-runtime + jsdom skew, same moduleNameMapper for `@monok8s/*`
// path aliases, same jose-ESM transformIgnorePatterns, same
// js-first moduleFileExtensions so compiled output resolves before
// raw .ts source in the bazel-bin tree.
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
  moduleNameMapper: {
    "^@monok8s/trpc$": "<rootDir>/../../packages/trpc/src/index.js",
    "^@monok8s/db$": "<rootDir>/../../packages/db/src/index.js",
    "^@monok8s/auth$": "<rootDir>/../../packages/auth/src/index.js",
  },
  transformIgnorePatterns: ["/node_modules/(?!\\.aspect_rules_js/jose)"],
};
