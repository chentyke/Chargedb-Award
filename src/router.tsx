import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import Home from "./routes/Home";
import ThankYou from "./routes/ThankYou";

export type RouterContext = {
  queryClient: QueryClient;
};

function RootLayout() {
  return (
    <div className="app">
      <main>
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const thankYouRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/thank-you",
  component: ThankYou,
});

const routeTree = rootRoute.addChildren([indexRoute, thankYouRoute]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
  });
}
