/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MATRIX_URL?: string;
  readonly VITE_MATRIX_SERVER_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
