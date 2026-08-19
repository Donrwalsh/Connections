import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./benchmark.css";
import "./header.css";
import App from "./App.tsx";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initCalendarRange } from "./data/calendarMock.ts";

void initCalendarRange();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
