module.exports = {
  presets: [
    ["@babel/preset-env", { targets: { node: "current" } }],
    "babel-preset-solid",
    ["@babel/preset-typescript", { allExtensions: true, isTSX: true }],
  ],
};
