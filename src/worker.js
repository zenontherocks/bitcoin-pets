export default {
  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);
    if (response.status === 404) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }
    return response;
  },
};
