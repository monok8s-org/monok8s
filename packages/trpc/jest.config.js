// Per-package Jest config for packages/trpc unit tests.
//
// Uses testEnvironment: "node" — packages/trpc has no DOM dependencies,
// and node-env sidesteps the same jest-runtime resetModules path used
// in packages/{auth,db}.
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
  // in the bazel bin output dir (matches packages/auth + packages/db).
  moduleFileExtensions: ["js", "jsx", "ts", "tsx"],
};
