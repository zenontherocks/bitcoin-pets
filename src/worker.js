export default {
  async fetch(request, env, ctx) {
    // Static assets (index.html, etc.) are served automatically by the
    // Workers Assets binding defined in wrangler.toml. Requests that
    // don't match a file fall through here.
    return env.ASSETS.fetch(request);
  },
};
