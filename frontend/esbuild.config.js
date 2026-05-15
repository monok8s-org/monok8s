import babel from "esbuild-plugin-babel";

export default {
  plugins: [
    babel({
      filter: /\.[jt]sx$/,
      config: {
        presets: [
          ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
          "babel-preset-solid",
        ],
      },
    }),
  ],
  jsx: "preserve",    // babel handles JSX transform, not esbuild
  splitting: true,    // code splitting for lazy routes
  format: "esm",
  minify: true,
  sourcemap: true,
};
