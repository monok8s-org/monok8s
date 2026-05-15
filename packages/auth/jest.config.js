// Per-package Jest config for packages/auth unit tests.
//
// Uses testEnvironment: "node" instead of the root config's "jsdom" —
// packages/auth has no DOM dependencies, and jsdom's setup triggers a
// jest-runtime resetModules path with an internal API mismatch with
// jest-mock at the current pin (per the same fix in packages/db).
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
  // js first: Jest prefers the compiled JS adjacent to the .ts source
  // in the bazel bin output dir. Trying .ts first would re-trigger the
  // raw-TS path which requires transforming node_modules deps (jose ESM,
  // etc.) — out of scope.
  moduleFileExtensions: ["js", "jsx", "ts", "tsx"],
  // jose v6 ships ESM; default jest doesn't transform node_modules.
  // The middleware test transitively pulls in zitadel.ts → jose. Allow
  // babel-jest to transform jose's package (path includes
  // `.aspect_rules_js/jose@` under bazel's node_modules layout).
  transformIgnorePatterns: ["/node_modules/(?!\\.aspect_rules_js/jose)"],
  // @monok8s/* path aliases are tsconfig-only (no per-package
  // package.json + npm workspace symlinks). Jest's resolver needs
  // explicit mapping to find workspace package sources at test
  // runtime. babel-jest transpiles .ts files on-the-fly.
  moduleNameMapper: {
    "^@monok8s/trpc$": "<rootDir>/../trpc/src/index.js",
    "^@monok8s/db$": "<rootDir>/../db/src/index.js",
    "^@monok8s/auth$": "<rootDir>/src/index.js",
  },
};
