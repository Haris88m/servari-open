import { RouterProvider } from "react-router";
import { router } from "./routes";

// Build stamp — gives each rebuild a distinct content hash so browsers can never
// serve a stale, pre-fix bundle from heuristic cache (the shell server sends no
// cache-control headers, so same-named assets would otherwise be reused).
const BUILD_STAMP = "servari-shell";
if (typeof window !== "undefined") {
  (window as unknown as { __SERVARI_BUILD__?: string }).__SERVARI_BUILD__ = BUILD_STAMP;
}

export default function App() {
  return <RouterProvider router={router} />;
}
