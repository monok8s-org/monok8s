module.exports = {
  testEnvironment: "jsdom",
  transform: {
    "^.+\\.[jt]sx?$": [
      "babel-jest",
      {
        configFile: false,
        babelrc: false,
        presets: [
          ["@babel/preset-env", { targets: { node: "current" } }],
          "@babel/preset-typescript",
          // babel-preset-solid handles the SolidJS JSX transform for
          // frontend/ tests (#91). No-op for files without JSX, so
          // safe at the root level. Without it, SolidJS .test.tsx
          // files emit React.createElement under preset-typescript's
          // default JSX runtime + SolidJS rejects the tree at runtime.
          "babel-preset-solid",
        ],
      },
    ],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "jsx"],
};
