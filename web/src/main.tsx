import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto-mono/400.css";
import { Button, CssBaseline, Stack, Typography } from "@mui/material";
import { ThemeProvider } from "@mui/material/styles";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, Outlet, Link as RouterLink, createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { ApiError } from "./api/client";
import { AuthProvider, useAuth } from "./auth";
import { AppLayout } from "./components/AppLayout";
import { Loading } from "./components/common";
import { LoginPage } from "./pages/LoginPage";
import { theme } from "./theme";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status < 500),
      refetchOnWindowFocus: true,
    },
  },
});

function RequireUser({ children, admin }: { children?: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== "admin") return <Navigate to="/devices" replace />;
  return children ?? <Outlet />;
}

function NotFound() {
  return (
    <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
      <Typography variant="h5">Page not found</Typography>
      <Button component={RouterLink} to="/devices" variant="outlined">
        Go to devices
      </Button>
    </Stack>
  );
}

// Pages load on demand so the data grid and charts only download when needed.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => async () => ({ Component: (await load())[name] });

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: (
      <RequireUser>
        <AppLayout />
      </RequireUser>
    ),
    children: [
      { index: true, element: <Navigate to="/devices" replace /> },
      { path: "devices", lazy: page(() => import("./pages/DevicesPage"), "DevicesPage") },
      { path: "devices/:id/:tab?", lazy: page(() => import("./pages/device/DevicePage"), "DevicePage") },
      { path: "firmware", lazy: page(() => import("./pages/FirmwarePage"), "FirmwarePage") },
      { path: "ota", lazy: page(() => import("./pages/OtaPages"), "OtaJobsPage") },
      { path: "ota/:id", lazy: page(() => import("./pages/OtaPages"), "OtaJobPage") },
      { path: "enrollments", lazy: page(() => import("./pages/EnrollmentsPage"), "EnrollmentsPage") },
      {
        path: "users",
        element: <RequireUser admin />,
        children: [{ index: true, lazy: page(() => import("./pages/UsersPage"), "UsersPage") }],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
