import axios, { AxiosError } from "axios";
import type { AxiosRequestConfig } from "axios";

export const apiClient = axios.create({
  baseURL: `${import.meta.env.VITE_API_URL || "https://dop-api.pinntag.com"}/api/v1`,
  headers: { "Content-Type": "application/json" },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem("dop_access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise: Promise<string> | null = null;
let redirecting = false;

function clearSessionAndRedirect(): void {
  localStorage.removeItem("dop_access_token");
  localStorage.removeItem("dop_refresh_token");
  localStorage.removeItem("dop_user");
  if (redirecting) return;
  redirecting = true;
  try {
    sessionStorage.setItem("dop_session_expired", "1");
  } catch {
    // ignore storage errors
  }
  if (window.location.pathname !== "/login") {
    window.location.replace("/login");
  }
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = localStorage.getItem("dop_refresh_token");
  if (!refreshToken) throw new Error("No refresh token");
  const res = await axios.post(`${apiClient.defaults.baseURL}/auth/refresh`, {
    refreshToken,
  });
  const { accessToken, refreshToken: newRefresh } = res.data;
  localStorage.setItem("dop_access_token", accessToken);
  localStorage.setItem("dop_refresh_token", newRefresh);
  return accessToken as string;
}

type RetriableConfig = AxiosRequestConfig & { _retry?: boolean };

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as RetriableConfig | undefined;
    const status = error.response?.status;

    const isAuthRefresh = !!original?.url?.includes("/auth/refresh");
    const canRetry = !!original && !original._retry && !isAuthRefresh;

    if (status === 401 && canRetry) {
      original!._retry = true;

      if (!localStorage.getItem("dop_refresh_token")) {
        clearSessionAndRedirect();
        return Promise.reject(error);
      }

      try {
        if (!refreshPromise) {
          refreshPromise = refreshAccessToken().finally(() => {
            refreshPromise = null;
          });
        }
        const newToken = await refreshPromise;
        original!.headers = original!.headers ?? {};
        (original!.headers as Record<string, string>).Authorization =
          `Bearer ${newToken}`;
        return apiClient(original!);
      } catch {
        clearSessionAndRedirect();
        return Promise.reject(error);
      }
    }

    const message =
      (error.response?.data as { message?: string } | undefined)?.message ||
      error.message ||
      "An unexpected error occurred";
    return Promise.reject(new Error(message));
  },
);
