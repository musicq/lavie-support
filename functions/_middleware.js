// www.lifebar.app and the pages.dev address both send visitors to lifebar.app.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "www.lifebar.app" || url.hostname === "lavie-site-80c.pages.dev") {
    url.hostname = "lifebar.app";
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
