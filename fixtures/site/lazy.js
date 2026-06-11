export const greet = () => {
  document.body.append(" lazily loaded");
};
// padding so the chunk has a measurable compressed size
export const padding = `${"abcdefghij".repeat(2_000)}`;
