import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactNode
} from "react";

export type ThemeMode = "dark" | "light" | "system";

interface ThemeContextValue {
  readonly mode: ThemeMode;
  readonly setMode: (mode: ThemeMode) => void;
}

interface ThemeProviderProps extends PropsWithChildren {
  readonly initialMode?: ThemeMode;
}

interface AppProvidersProps {
  readonly children: ReactNode;
  readonly queryClient?: QueryClient;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false
      }
    }
  });

const applicationQueryClient = createQueryClient();

export const ThemeProvider = ({ children, initialMode = "dark" }: ThemeProviderProps): React.JSX.Element => {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode }), [mode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = (): ThemeContextValue => {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }
  return value;
};

export const AppProviders = ({
  children,
  queryClient = applicationQueryClient
}: AppProvidersProps): React.JSX.Element => (
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </ThemeProvider>
);
